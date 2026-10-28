import { Router } from '../router.js';
import { authMiddleware , requireRole } from '../auth.js';
import { geocode } from '../lib/geocode.js';
import { BUSINESS_TZ_OFFSET_MINUTES, weekdayForDate } from '../lib/business-time.js';
import { deliveryZoneRequirement, evaluateDelivery } from '../lib/delivery-rules.js';
import { buildDispatch } from '../lib/whatsapp.js';
import { priceOrder } from '../lib/pricing.js';

const router = new Router();

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
    delivery_fee_cents: r.delivery_fee_cents,
    delivery_free_applied: r.delivery_free_applied,
    delivery_free_rule_id: r.delivery_free_rule_id
  };
}

function combineDateAndTime(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0)).getTime()
    - BUSINESS_TZ_OFFSET_MINUTES * 60 * 1000;
}

async function getConfig(db) {
  return db.prepare('SELECT * FROM config WHERE id = 1').get();
}

async function validateScheduled(db, { pickup_day, items, nowMs, schedule }) {
  const dow = weekdayForDate(pickup_day);

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
      message: `Cutoff ya paso: el pedido debe hacerse antes de ${orderEntry.start_time} - ${orderEntry.cutoff_offset_hours}h`
    };
  }

  const windows = await db.prepare(`
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
      return { ok: false, code: 'flavor_not_in_window', message: `El sabor ${req.flavor_id} no esta disponible para ${pickup_day}` };
    }
    const remaining = w.units_available - w.units_sold;
    if (req.qty > remaining) {
      return {
        ok: false, code: 'insufficient_stock',
        message: `Stock insuficiente para ${req.flavor_id}: pedido ${req.qty}, disponibles ${remaining}`
      };
    }
  }

  return { ok: true, pickup_day, window_id: openWindow.id, requestedFlavors };
}

function validateImmediate({ total, evaluation, config }) {
  if (!evaluation.ok) {
    const messages = {
      immediate_disabled: 'La entrega inmediata esta desactivada',
      address_required: 'La direccion es obligatoria para entrega inmediata',
      geocode_failed: 'No pudimos geocodificar la direccion',
      zone_not_configured: 'La zona de domicilio no esta configurada',
      out_of_zone: `Fuera de zona: distancia ${evaluation.distance_km ? evaluation.distance_km.toFixed(1) : '?'} km`,
    };
    return { ok: false, code: evaluation.error, message: messages[evaluation.error] || 'No pudimos validar la entrega inmediata' };
  }
  if (total < Number(config.delivery_immediate_min_order_cents || 0)) {
    return {
      ok: false, code: 'below_minimum',
      message: `Pedido minimo para entrega inmediata: $${Number(config.delivery_immediate_min_order_cents || 0).toLocaleString('es-CO')}`
    };
  }
  return { ok: true };
}

// Solo admin ve el libro completo de pedidos (PII). Mismo fix que
// src/routes/orders.js — un customer solo ve los suyos, por telefono. Si solo se
// arregla el runtime de Node, el Worker reintroduce la fuga.
function ordersVisibleTo(req) {
  return req.user?.role === 'admin' ? null : req.user?.phone || null;
}

router.get('/', authMiddleware, async (req, res) => {
  const { status, day, week, q, limit = 100 } = req.query;
  const wheres = [];
  const params = [];

  const onlyPhone = ordersVisibleTo(req);
  if (onlyPhone != null) {
    wheres.push('customer_phone = ?');
    params.push(String(onlyPhone).replace(/\D/g, ''));
  }

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
  const rows = await req.db.prepare(sql).all(...params, Number(limit) || 100);
  res.json(rows.map(rowToOrder));
});

router.get('/:id', authMiddleware, async (req, res) => {
  const row = await req.db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  // Customer: 404 en pedidos ajenos, para no confirmar que existen.
  const onlyPhone = ordersVisibleTo(req);
  if (onlyPhone != null && String(row.customer_phone).replace(/\D/g, '') !== String(onlyPhone).replace(/\D/g, '')) {
    return res.status(404).json({ error: 'not_found' });
  }
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

  const db = req.db;
  const config = await getConfig(db);
  const schedule = await db.prepare(`
    SELECT * FROM delivery_schedule WHERE active = 1 ORDER BY day_of_week, sort_order, start_time
  `).all();
  const nowMs = Date.now();

  let validated = { ok: false };
  let computedDeliveryFee = 0;
  let computedDistanceKm = null;
  let finalLat = null;
  let finalLng = null;
  let deliveryFreeApplied = 0;
  let deliveryFreeRuleId = null;

  if (delivery_mode === 'scheduled') {
    const r = await validateScheduled(db, { pickup_day, items, nowMs, schedule });
    if (!r.ok) return res.status(400).json({ error: r.code, message: r.message });
    validated = r;
  }

  const clientTotal = Number(total);
  const priced = await priceOrder({ db, items, combos, deliveryFee: 0 });
  if (!priced.ok) {
    return res.status(400).json({
      error: 'invalid_catalog_items',
      message: 'El pedido referencia productos que no existen en el catálogo',
      details: priced.errors,
    });
  }
  if (priced.lines.length === 0) {
    return res.status(400).json({ error: 'empty_order', message: 'El pedido no tiene productos' });
  }
  const authoritativeSubtotal = priced.total;
  let authoritativeTotal = authoritativeSubtotal;

  if (delivery_mode === 'immediate') {
    if (!config.delivery_immediate_enabled) {
      return res.status(400).json({ error: 'immediate_disabled', message: 'La entrega inmediata esta desactivada' });
    }
    if (!String(delivery_address || '').trim()) {
      return res.status(400).json({ error: 'address_required', message: 'La direccion es obligatoria para entrega inmediata' });
    }
    const zone = deliveryZoneRequirement(config);
    if (!zone.ok) {
      return res.status(400).json({ error: 'zone_not_configured', message: 'La zona de domicilio no esta configurada' });
    }
    let geo = null;
    try {
      geo = await geocode(db, delivery_address);
    } catch {
      geo = null;
    }
    if (!geo) {
      return res.status(400).json({ error: 'geocode_failed', message: 'No pudimos geocodificar la direccion. Proba con otra referencia (barrio + calle).' });
    }
    let rules = [];
    try {
      rules = await db.prepare('SELECT * FROM delivery_free_rules WHERE active = 1 ORDER BY id').all();
    } catch {}
    const evaluation = evaluateDelivery({
      config,
      geo,
      address: delivery_address,
      rules,
      subtotalCents: authoritativeSubtotal,
      nowMs,
    });
    authoritativeTotal = authoritativeSubtotal + Number(evaluation.fee_cents || 0);
    const r = validateImmediate({ total: authoritativeTotal, evaluation, config });
    if (!r.ok) return res.status(400).json({ error: r.code, message: r.message });
    validated = r;
    computedDeliveryFee = Number(evaluation.fee_cents || 0);
    computedDistanceKm = evaluation.distance_km;
    finalLat = geo.lat;
    finalLng = geo.lng;
    deliveryFreeApplied = evaluation.delivery_free_applied;
    deliveryFreeRuleId = evaluation.delivery_free_rule_id;
  }

  const totalDrift = Number.isFinite(clientTotal) && clientTotal !== authoritativeTotal
    ? { client_sent: clientTotal, server_computed: authoritativeTotal }
    : null;

  const existing = await db.prepare('SELECT id FROM orders WHERE id = ?').get(id);
  if (existing) return res.status(409).json({ error: 'duplicate', message: 'Ya existe un pedido con ese id' });

  const statements = [
    req.dbD1.prepare(`
      INSERT INTO orders (
        id, customer_name, customer_phone, pickup_day,
        items_json, combos_json, total, notes, source,
        delivery_mode, delivery_provider, delivery_address,
        delivery_lat, delivery_lng, delivery_distance_km, delivery_fee_cents,
        delivery_free_applied, delivery_free_rule_id,
        payment_method_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, customer_name, customer_phone, pickup_day,
      JSON.stringify(items || {}), JSON.stringify(combos || []),
      authoritativeTotal, notes || null, source || 'web',
      delivery_mode, delivery_provider, delivery_address || null,
      finalLat, finalLng, computedDistanceKm, computedDeliveryFee,
      deliveryFreeApplied, deliveryFreeRuleId,
      payment_method_id || null
    )
  ];

  if (delivery_mode === 'scheduled' && validated.requestedFlavors) {
    for (const rq of validated.requestedFlavors) {
      statements.push(
        req.dbD1.prepare(`
          UPDATE release_items
          SET units_sold = units_sold + ?
          WHERE window_id = ? AND flavor_id = ? AND units_sold + ? <= units_available
        `).bind(rq.qty, validated.window_id, rq.flavor_id, rq.qty)
      );
    }
  }

  let results;
  try {
    results = await db.batch(statements);
  } catch (e) {
    if (String(e?.message || e).includes('UNIQUE')) {
      return res.status(409).json({ error: 'duplicate', message: 'Ya existe un pedido con ese id' });
    }
    throw e;
  }

  if (delivery_mode === 'scheduled' && validated.requestedFlavors) {
    const stockResults = results.slice(1);
    const failedIdx = stockResults.findIndex((r) => (r.meta?.changes ?? 0) !== 1);
    if (failedIdx !== -1) {
      const flavor = validated.requestedFlavors[failedIdx];
      const compensate = [req.dbD1.prepare('DELETE FROM orders WHERE id = ?').bind(id)];
      for (let i = 0; i < failedIdx; i++) {
        const rq = validated.requestedFlavors[i];
        compensate.push(
          req.dbD1.prepare('UPDATE release_items SET units_sold = MAX(0, units_sold - ?) WHERE window_id = ? AND flavor_id = ?')
            .bind(rq.qty, validated.window_id, rq.flavor_id)
        );
      }
      await db.batch(compensate);
      return res.status(400).json({
        error: 'insufficient_stock',
        message: `Stock insuficiente para ${flavor.flavor_id} (cambio concurrente). Intenta de nuevo.`
      });
    }
  }

  const created = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  const full = rowToOrder(created);

  // ---- Dispatch WhatsApp multi-destinatario (2026-10-17) ----
  try {
    const flavorList = await db.prepare('SELECT id, name, price FROM flavors').all();
    const comboList = await db.prepare('SELECT id, name, price FROM combos').all();

    const recipients = (await db.prepare('SELECT label, phone FROM order_recipients WHERE active = 1 ORDER BY sort_order ASC, id ASC').all())
      .map(r => ({ label: r.label, phone: String(r.phone).replace(/\D/g, '') }))
      .filter(r => r.phone);

    if (recipients.length === 0) {
      const fallback = String(config.whatsapp_number || '').replace(/\D/g, '');
      if (fallback && fallback !== '573000000000') {
        recipients.push({ label: 'Admin principal', phone: fallback });
      }
    }

    let primary = null;
    if (recipients.length) {
      const orderCount = (await db.prepare('SELECT COUNT(*) AS n FROM orders').get()).n;
      primary = recipients[orderCount % recipients.length];
    }

    const pickupDow = weekdayForDate(pickup_day);
    const sched = await db.prepare(
      "SELECT start_time, end_time FROM delivery_schedule WHERE day_of_week = ? AND active = 1 AND mode IN ('pickup','both') ORDER BY id LIMIT 1"
    ).get(pickupDow);

    const wsp = await buildDispatch(req.env, full, {
      primaryPhone: primary?.phone || null,
      primary_label: primary?.label || null,
      recipients,
      business_name: config.business_name,
      flavors: flavorList,
      combos: comboList,
      pickup_window_start: sched?.start_time || null,
      pickup_window_end: sched?.end_time || null
    });
    // Desglose que el server computo (paridad con src/routes/orders.js): el
    // cliente recibe el recibo y, si mando un total distinto, queda visible el
    // drift en la respuesta en vez de esconderse en un reporte aparte.
    full.pricing = { lines: priced.lines, total: authoritativeTotal };
    if (totalDrift) full.pricing.client_drift = totalDrift;

    res.status(201).json({ ...full, whatsapp: wsp });
  } catch (e) {
    console.warn('[orders] dispatch failed:', e?.message || e);
    res.status(201).json({ ...full, whatsapp: { deep_link: null, cloud_status: 'failed', cloud_error: String(e?.message || e).slice(0, 200) } });
  }
});

// requireRole('admin'): sin esto, un token role:'customer' (que /api/auth/register
// emite sin coste) puede marcar pedidos ajenos como pagados o borrarlos.
router.patch('/:id', [authMiddleware, requireRole('admin')], async (req, res) => {
  const existing = await req.db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['status', 'payment_status', 'payment_method', 'payment_method_id', 'notes', 'delivery_provider'];
  const updates = {};
  for (const k of allowed) if (k in (req.body || {})) updates[k] = req.body[k];
  if ('status' in updates && !VALID_STATUS.includes(updates.status)) {
    return res.status(400).json({ error: 'bad_request', message: `status invalido. Valores: ${VALID_STATUS.join(',')}` });
  }
  if ('payment_status' in updates && !VALID_PAYMENT_STATUS.includes(updates.payment_status)) {
    return res.status(400).json({ error: 'bad_request', message: `payment_status invalido. Valores: ${VALID_PAYMENT_STATUS.join(',')}` });
  }
  if ('delivery_provider' in updates && !VALID_DELIVERY_PROVIDER.includes(updates.delivery_provider)) {
    return res.status(400).json({ error: 'bad_request', message: 'delivery_provider invalido' });
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await req.db.prepare(`UPDATE orders SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(rowToOrder(await req.db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', [authMiddleware, requireRole('admin')], async (req, res) => {
  const result = await req.db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;
