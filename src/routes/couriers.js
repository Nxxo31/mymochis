import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, requireRole, hashPassword } from '../auth.js';
import { assignCourierManually, DispatchError } from '../lib/dispatch.js';
import { buildCourierDispatch } from '../lib/whatsapp.js';
import { weekdayForDate } from '../lib/business-time.js';
import { audit } from '../lib/audit.js';

const router = Router();

function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toFloat(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toStr(value, max = 120) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function rowOut(r) {
  const load = db
    .prepare(
      `SELECT COUNT(*) AS n FROM dispatches
       WHERE courier_id = ? AND status IN ('assigned','picked_up','on_way')`,
    )
    .get(r.id).n;
  const delivered = db
    .prepare("SELECT COUNT(*) AS n FROM dispatches WHERE courier_id = ? AND status = 'delivered'")
    .get(r.id).n;
  return {
    ...r,
    phone_display: r.phone ? `+${r.phone}` : '',
    active_load: load,
    delivered_count: delivered,
    has_account: Boolean(r.user_id),
  };
}

router.get('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const rows = db.prepare('SELECT * FROM couriers ORDER BY active DESC, name ASC').all();
  res.json({ couriers: rows.map(rowOut) });
});

router.get('/:id', [authMiddleware, requireRole('admin')], (req, res) => {
  const row = db.prepare('SELECT * FROM couriers WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Domiciliario no encontrado' });
  res.json({ courier: rowOut(row) });
});

router.post('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const body = req.body || {};
  const name = toStr(body.name, 80);
  const phone = normalizePhone(body.phone);
  const email = toStr(body.email, 160)?.toLowerCase() || null;
  const password = body.password ? String(body.password) : null;
  const lat = toFloat(body.lat);
  const lng = toFloat(body.lng);
  const max_radius_km = toFloat(body.max_radius_km);
  const base_fare_cents = Math.max(0, toInt(body.base_fare_cents, 0));
  const price_per_km_cents = Math.max(0, toInt(body.price_per_km_cents, 0));

  if (!name) {
    return res.status(400).json({ error: 'bad_name', message: 'El nombre del domiciliario es obligatorio' });
  }
  if (!/^\d{8,15}$/.test(phone)) {
    return res.status(400).json({
      error: 'bad_phone',
      message: 'Número inválido: formato internacional sin espacios (ej: 573001234567)',
    });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'bad_email', message: 'Email inválido' });
  }
  if (email && (!password || password.length < 8)) {
    return res.status(400).json({
      error: 'weak_password',
      message: 'Para crear el acceso al portal del domiciliario la clave debe tener al menos 8 caracteres',
    });
  }
  if ((lat === null) !== (lng === null)) {
    return res.status(400).json({ error: 'bad_coords', message: 'La ubicación necesita lat y lng juntos' });
  }
  if (email) {
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (exists) {
      return res.status(409).json({ error: 'email_taken', message: 'Ya existe una cuenta con ese email' });
    }
  }

  let userId = null;
  if (email) {
    const { salt, hash } = hashPassword(password);
    const u = db
      .prepare('INSERT INTO users (email, password_hash, password_salt, name, role, phone) VALUES (?, ?, ?, ?, ?, ?)')
      .run(email, hash, salt, name, 'courier', phone);
    userId = Number(u.lastInsertRowid);
  }

  const r = db
    .prepare(
      `INSERT INTO couriers
        (name, phone, email, user_id, base_fare_cents, price_per_km_cents, lat, lng, address, vehicle, max_radius_km, active, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(
      name,
      phone,
      email,
      userId,
      base_fare_cents,
      price_per_km_cents,
      lat,
      lng,
      toStr(body.address, 240),
      toStr(body.vehicle, 40),
      max_radius_km,
      body.active === false ? 0 : 1,
      toStr(body.notes, 500),
    );

  res.status(201).json(rowOut(db.prepare('SELECT * FROM couriers WHERE id = ?').get(r.lastInsertRowid)));
  audit('courier.create', req, { target_type: 'courier', target_id: r.lastInsertRowid, details: { name: body.name, phone: body.phone } });
});

router.patch('/:id', [authMiddleware, requireRole('admin')], (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM couriers WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Domiciliario no encontrado' });

  const body = req.body || {};
  const updates = {};

  if ('name' in body) {
    const name = toStr(body.name, 80);
    if (!name) return res.status(400).json({ error: 'bad_name', message: 'El nombre no puede quedar vacío' });
    updates.name = name;
  }
  if ('phone' in body) {
    const phone = normalizePhone(body.phone);
    if (!/^\d{8,15}$/.test(phone)) {
      return res.status(400).json({ error: 'bad_phone', message: 'Número inválido' });
    }
    updates.phone = phone;
  }
  if ('base_fare_cents' in body) updates.base_fare_cents = Math.max(0, toInt(body.base_fare_cents, 0));
  if ('price_per_km_cents' in body) updates.price_per_km_cents = Math.max(0, toInt(body.price_per_km_cents, 0));
  if ('address' in body) updates.address = toStr(body.address, 240);
  if ('vehicle' in body) updates.vehicle = toStr(body.vehicle, 40);
  if ('notes' in body) updates.notes = toStr(body.notes, 500);
  if ('max_radius_km' in body) updates.max_radius_km = toFloat(body.max_radius_km);
  if ('active' in body) updates.active = body.active ? 1 : 0;
  if ('lat' in body || 'lng' in body) {
    const lat = 'lat' in body ? toFloat(body.lat) : row.lat;
    const lng = 'lng' in body ? toFloat(body.lng) : row.lng;
    if ((lat === null) !== (lng === null)) {
      return res.status(400).json({ error: 'bad_coords', message: 'La ubicación necesita lat y lng juntos' });
    }
    updates.lat = lat;
    updates.lng = lng;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'no_fields', message: 'Nada que actualizar' });
  }

  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE couriers SET ${setSql}, updated_at = datetime('now') WHERE id = ?`).run(
    ...Object.values(updates),
    id,
  );
  res.json(rowOut(db.prepare('SELECT * FROM couriers WHERE id = ?').get(id)));
});

router.delete('/:id', [authMiddleware, requireRole('admin')], (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM couriers WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Domiciliario no encontrado' });

  const history = db.prepare('SELECT COUNT(*) AS n FROM dispatches WHERE courier_id = ?').get(id).n;
  if (history > 0) {
    return res.status(409).json({
      error: 'courier_has_dispatches',
      message: 'El domiciliario tiene repartos: desactívalo en vez de borrarlo para no perder el historial',
    });
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM couriers WHERE id = ?').run(id);
    if (row.user_id) {
      db.prepare("DELETE FROM users WHERE id = ? AND role = 'courier'").run(row.user_id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, deleted: { id, name: row.name } });
});

router.post('/:id/dispatch', [authMiddleware, requireRole('admin')], async (req, res) => {
  const courierId = Number(req.params.id);
  const orderId = toStr(req.body?.order_id, 80);
  if (!orderId) {
    return res.status(400).json({ error: 'bad_request', message: 'order_id es obligatorio' });
  }
  try {
    const out = assignCourierManually({
      orderId,
      courierId,
      actor: req.user?.email || 'admin',
      note: toStr(req.body?.note, 240),
    });

    // WSP al domiciliario (spec 57, r6): el reparto asignado a mano también
    // llega al WhatsApp del repartidor. Nunca rompe la respuesta del admin.
    try {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      const courier = db.prepare('SELECT id, name, phone FROM couriers WHERE id = ?').get(courierId);
      if (order && courier) {
        try { order.items = JSON.parse(order.items_json || '{}'); } catch { order.items = {}; }
        try { order.combos = JSON.parse(order.combos_json || '[]'); } catch { order.combos = []; }
        const flavorList = db.prepare('SELECT id, name, price FROM flavors').all();
        const comboList = db.prepare('SELECT id, name, price FROM combos').all();
        const sched = db.prepare(
          "SELECT start_time, end_time FROM delivery_schedule WHERE day_of_week = ? AND active = 1 AND mode IN ('delivery','both') ORDER BY id LIMIT 1"
        ).get(weekdayForDate(order.pickup_day));
        out.whatsapp = await buildCourierDispatch(order, courier, {
          flavors: flavorList,
          combos: comboList,
          pickup_window_start: sched?.start_time || null,
          pickup_window_end: sched?.end_time || null
        });
      }
    } catch (e) {
      console.error('[couriers] wsp courier failed', orderId, e?.message || e);
    }

    res.json({ ok: true, dispatch: out.dispatch, courier_id: out.courier_id, whatsapp: out.whatsapp || null });
  } catch (e) {
    if (e instanceof DispatchError) {
      return res.status(e.status).json({ error: e.code, message: e.message, details: e.details });
    }
    throw e;
  }
});

export default router;
