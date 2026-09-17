import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../auth.js';
import { geocode, haversineKm } from '../lib/geocode.js';

const router = Router();

const VALID_STATUS = ['pending', 'confirmed', 'ready', 'delivered', 'cancelled'];
const VALID_PAYMENT_STATUS = ['pending', 'paid'];
const VALID_DELIVERY_MODE = ['scheduled', 'immediate'];
const VALID_DELIVERY_PROVIDER = ['own', 'rappi', 'pickapp', 'ivoy'];

function rowToOrder(r) {
  if (!r) return null;
  let items = {};
  let combos = [];
  try { items = JSON.parse(r.items_json || '{}'); } catch {}
  try { combos = JSON.parse(r.combos_json || '[]'); } catch {}
  return {
    id: r.id,
    created_at: r.created_at,
    customer_name: r.customer_name,
    customer_phone: r.customer_phone,
    pickup_day: r.pickup_day,
    items,
    combos,
    total: r.total,
    notes: r.notes,
    status: r.status,
    source: r.source,
    payment_status: r.payment_status,
    payment_method: r.payment_method,
    payment_method_id: r.payment_method_id,
    delivery_mode: r.delivery_mode,
    delivery_provider: r.delivery_provider,
    delivery_address: r.delivery_address,
    delivery_lat: r.delivery_lat,
    delivery_lng: r.delivery_lng,
    delivery_distance_km: r.delivery_distance_km,
    delivery_fee_cents: r.delivery_fee_cents
  };
}

function dayOfWeek(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function combineDateAndTime(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0)).getTime();
}

function getConfig() {
  return db.prepare('SELECT * FROM config WHERE id = 1').get();
}

function validateScheduled(opts) {
  const { pickup_day, items, nowMs, schedule, config } = opts;
  const dow = dayOfWeek(pickup_day);

  const matchingSchedule = schedule.filter(s =>
    s.day_of_week === dow && (s.mode === 'pickup' || s.mode === 'both') && s.active === 1
  );
  if (matchingSchedule.length === 0) {
    return { ok: false, code: 'no_pickup_schedule', message: `No hay horario de pickup para ${pickup_day}` };
  }

  const orderEntry = matchingSchedule[0];
  const pickupStartMs = combineDateAndTime(pickup_day, orderEntry.start_time);
  const cutoffMs = pickupStartMs - (Number(orderEntry.cutoff_offset_hours) || 0) * 3600 * 1000;
  if (nowMs > cutoffMs) {
    return {
      ok: false, code: 'past_cutoff',
      message: `Cutoff ya pasó: el pedido debe hacerse antes de ${orderEntry.start_time} - ${orderEntry.cutoff_offset_hours}h`
    };
  }

  const windows = db.prepare(`
    SELECT rw.id, rw.release_date, rw.status, rw.cutoff_at,
           ri.id AS item_id, ri.flavor_id, ri.units_sold, ri.units_available
    FROM release_windows rw
    LEFT JOIN release_items ri ON ri.window_id = rw.id
    WHERE rw.release_date = ?
  `).all(pickup_day);

  const openWindow = windows.find(w => w.status === 'open');
  if (!openWindow) {
    return { ok: false, code: 'no_release_window', message: `No hay release_window 'open' para ${pickup_day}` };
  }

  const requestedFlavors = Object.entries(items || {})
    .filter(([, qty]) => Number(qty) > 0)
    .map(([flavor_id, qty]) => ({ flavor_id, qty: Number(qty) }));

  if (requestedFlavors.length === 0) {
    return { ok: false, code: 'no_items', message: 'El pedido no tiene sabores' };
  }

  const itemsByFlavor = new Map();
  for (const w of windows) {
    if (w.item_id != null) itemsByFlavor.set(w.flavor_id, w);
  }

  for (const req of requestedFlavors) {
    const w = itemsByFlavor.get(req.flavor_id);
    if (!w) {
      return { ok: false, code: 'flavor_not_in_window', message: `El sabor ${req.flavor_id} no está disponible para ${pickup_day}` };
    }
    const remaining = w.units_available - w.units_sold;
    if (req.qty > remaining) {
      return {
        ok: false, code: 'insufficient_stock',
        message: `Stock insuficiente para ${req.flavor_id}: pedido ${req.qty}, disponibles ${remaining}`
      };
    }
  }

  return { ok: true, pickup_day, window_id: openWindow.id, requestedFlavors, itemsByFlavor: Object.fromEntries(itemsByFlavor) };
}

function validateImmediate(opts) {
  const { total, delivery_address, delivery_lat, delivery_lng, distance_km, config } = opts;
  if (!config.delivery_immediate_enabled) {
    return { ok: false, code: 'immediate_disabled', message: 'La entrega inmediata está desactivada' };
  }
  if (total < config.delivery_immediate_min_order_cents) {
    return {
      ok: false, code: 'below_minimum',
      message: `Pedido mínimo para entrega inmediata: $${(config.delivery_immediate_min_order_cents / 100).toFixed(0)}`
    };
  }
  if (!delivery_address || delivery_lat == null || delivery_lng == null) {
    return { ok: false, code: 'address_required', message: 'La dirección y coordenadas son obligatorias para entrega inmediata' };
  }
  if (distance_km == null || distance_km > config.delivery_immediate_radius_km) {
    return {
      ok: false, code: 'out_of_zone',
      message: `Fuera de zona: distancia ${distance_km ? distance_km.toFixed(1) : '?'} km, radio máximo ${config.delivery_immediate_radius_km} km`
    };
  }
  return { ok: true };
}

router.get('/', authMiddleware, (req, res) => {
  const { status, day, week, q, limit = 100 } = req.query;
  const wheres = [];
  const params = [];
  if (status) { wheres.push('status = ?'); params.push(status); }
  if (day) { wheres.push('pickup_day = ?'); params.push(day); }
  if (q) { wheres.push('(customer_name LIKE ? OR customer_phone LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (week) {
    const yr = String(week).match(/^(\d{4})-W(\d{2})$/);
    if (yr) {
      wheres.push("strftime('%Y-W%W', created_at) = ?");
      params.push(week);
    }
  }
  const whereSql = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
  const sql = `SELECT * FROM orders ${whereSql} ORDER BY created_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, Number(limit) || 100);
  res.json(rows.map(rowToOrder));
});

router.get('/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(rowToOrder(row));
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  const {
    id, customer_name, customer_phone, pickup_day,
    items, combos, total, notes, source,
    delivery_mode = 'scheduled', delivery_provider = 'own',
    delivery_address, payment_method_id
  } = body;

  if (!id || !customer_name || !customer_phone || !pickup_day || total == null) {
    return res.status(400).json({ error: 'bad_request', message: 'id, customer_name, customer_phone, pickup_day, total son obligatorios' });
  }
  if (!VALID_DELIVERY_MODE.includes(delivery_mode)) {
    return res.status(400).json({ error: 'bad_request', message: `delivery_mode debe ser uno de: ${VALID_DELIVERY_MODE.join(',')}` });
  }
  if (!VALID_DELIVERY_PROVIDER.includes(delivery_provider)) {
    return res.status(400).json({ error: 'bad_request', message: `delivery_provider debe ser uno de: ${VALID_DELIVERY_PROVIDER.join(',')}` });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pickup_day)) {
    return res.status(400).json({ error: 'bad_request', message: 'pickup_day debe ser YYYY-MM-DD' });
  }

  const config = getConfig();
  const schedule = db.prepare(`
    SELECT * FROM delivery_schedule WHERE active = 1 ORDER BY day_of_week, sort_order, start_time
  `).all();
  const nowMs = Date.now();

  let validated = { ok: false };
  let computedDeliveryFee = 0;
  let computedDistanceKm = null;
  let finalLat = null;
  let finalLng = null;

  if (delivery_mode === 'scheduled') {
    const r = validateScheduled({ pickup_day, items, nowMs, schedule, config });
    if (!r.ok) return res.status(400).json({ error: r.code, message: r.message });
    validated = r;
  } else {
    let lat = body.delivery_lat;
    let lng = body.delivery_lng;
    let distanceKm = null;
    if ((lat == null || lng == null) && delivery_address) {
      const geo = await geocode(delivery_address);
      if (!geo) {
        return res.status(400).json({ error: 'geocode_failed', message: 'No pudimos geocodificar la dirección. Probá con otra referencia (barrio + calle).' });
      }
      lat = geo.lat; lng = geo.lng;
    }
    if (lat != null && lng != null && config.delivery_zone_center_lat != null && config.delivery_zone_center_lng != null) {
      distanceKm = haversineKm(config.delivery_zone_center_lat, config.delivery_zone_center_lng, lat, lng);
    }
    const feeCents = Number(config.delivery_immediate_fee_cents) || 0;
    const r = validateImmediate({
      total: Number(total) + feeCents,
      delivery_address,
      delivery_lat: lat,
      delivery_lng: lng,
      distance_km: distanceKm,
      config
    });
    if (!r.ok) return res.status(400).json({ error: r.code, message: r.message });
    validated = r;
    computedDeliveryFee = feeCents;
    computedDistanceKm = distanceKm;
    finalLat = lat;
    finalLng = lng;
  }

  const insertOrderStmt = db.prepare(`
    INSERT INTO orders (
      id, customer_name, customer_phone, pickup_day,
      items_json, combos_json, total, notes, source,
      delivery_mode, delivery_provider, delivery_address,
      delivery_lat, delivery_lng, delivery_distance_km, delivery_fee_cents,
      payment_method_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updStockStmt = db.prepare(`
    UPDATE release_items
    SET units_sold = units_sold + ?
    WHERE window_id = ? AND flavor_id = ?
  `);

  db.exec('BEGIN');
  try {
    insertOrderStmt.run(
      id, customer_name, customer_phone, pickup_day,
      JSON.stringify(items || {}), JSON.stringify(combos || []),
      total, notes || null, source || 'web',
      delivery_mode, delivery_provider, delivery_address || null,
      finalLat, finalLng, computedDistanceKm, computedDeliveryFee,
      payment_method_id || null
    );

    if (delivery_mode === 'scheduled' && validated.requestedFlavors) {
      for (const req of validated.requestedFlavors) {
        const res = updStockStmt.run(req.qty, validated.window_id, req.flavor_id);
        if (res.changes !== 1) {
          throw new Error(`No se pudo actualizar stock de ${req.flavor_id}`);
        }
      }
    }

    if (computedDeliveryFee > 0) {
      db.prepare('UPDATE orders SET total = ? WHERE id = ?').run(Number(total) + computedDeliveryFee, id);
    }

    db.exec('COMMIT');
    res.status(201).json(rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id)));
  } catch (e) {
    db.exec('ROLLBACK');
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate', message: 'Ya existe un pedido con ese id' });
    throw e;
  }
});

router.patch('/:id', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['status', 'payment_status', 'payment_method', 'payment_method_id', 'notes', 'delivery_provider'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  if ('status' in updates && !VALID_STATUS.includes(updates.status)) {
    return res.status(400).json({ error: 'bad_request', message: `status inválido. Valores: ${VALID_STATUS.join(',')}` });
  }
  if ('payment_status' in updates && !VALID_PAYMENT_STATUS.includes(updates.payment_status)) {
    return res.status(400).json({ error: 'bad_request', message: `payment_status inválido. Valores: ${VALID_PAYMENT_STATUS.join(',')}` });
  }
  if ('delivery_provider' in updates && !VALID_DELIVERY_PROVIDER.includes(updates.delivery_provider)) {
    return res.status(400).json({ error: 'bad_request', message: `delivery_provider inválido` });
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE orders SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', authMiddleware, (req, res) => {
  const result = db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;