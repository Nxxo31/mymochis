import { Router } from 'express';
// Pricing server-side: el total SIEMPRE se recalcula desde el catalogo.
// El `total` que manda el cliente se usa solo como drifted de comparacion.
import { db } from '../db.js';
import { priceOrder } from '../lib/pricing.js';
import { rememberOrderTotal } from '../lib/payments/index.js';
import { confirmManualPayment, ManualPaymentError } from '../lib/payments/manual.js';
import { authMiddleware, requireRole } from '../auth.js';
import { geocode, haversineKm } from '../lib/geocode.js';
import { computeDeliveryFeeCents } from '../lib/delivery-fee.js';
import { buildDispatch } from '../lib/whatsapp.js';
import { commitReservedStock, releaseReservedStock } from '../lib/stock.js';
import { notifyOrderConfirmed } from '../lib/payments/order-notify.js';

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
    delivery_fee_cents: r.delivery_fee_cents,
    payment_id: r.payment_id,
    payment_state: r.payment_state,
    release_window_id: r.release_window_id
  };
}

function dayOfWeek(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Offset horario del negocio, convención getTimezoneOffset(): America/Bogota
 * es UTC-5 fijo (sin DST desde 1992). Las horas que el dueño ingresa
 * ("15:00" de pickup) son horas LOCALES de Colombia, no horas UTC.
 * Bug 2026-10-21 (kanban t_f6d7dd48): interpretarlas como UTC adelantaba el
 * cutoff 5 horas — un pickup de 15:00 con cutoff de 8h cerraba los pedidos a
 * las 02:00 local en vez de 07:00. Constante extruida a propósito: si el
 * negocio algún día opera en otra zona, es EL único punto de cambio.
 */
const BUSINESS_TZ_OFFSET_MINUTES = -300; // UTC-5, America/Bogota

function combineDateAndTime(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  // Date.UTC interpreta los componentes como si fueran UTC; restamos el
  // offset (negativo) para obtener el epoch del MISMO instante en Colombia:
  // "15:00" local == 20:00Z. Nota: rw.cutoff_at (release_windows) es solo
  // informativo — el cutoff que ENFORZA pedidos es este cálculo desde
  // delivery_schedule (decisión t_f6d7dd48, 2026-10-22).
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0)).getTime()
    - BUSINESS_TZ_OFFSET_MINUTES * 60 * 1000;
}

function getConfig() {
  return db.prepare('SELECT * FROM config WHERE id = 1').get();
}

/**
 * Cuanto le queda a una fecha de recogida para aceptar pedidos, en ms.
 *
 * Extraido de validateScheduled() porque el calculo del cutoff es la regla de
 * negocio que el cliente NECESITA conocer para no ofrecer una fecha que el
 * backend va a rechazar. Si esta logica se duplica en el front, las dos copias
 * divergen: el cliente ofrece un dia, el cliente llena el formulario entero y
 * solo al enviar recibe un 400 `past_cutoff` sin explicacion util.
 *
 * Se exporta para que /api/public/ marque cada ventana con `orderable`.
 *
 * @returns {{orderable: boolean, cutoffAt: string|null, reason: string|null}}
 */
export function pickupCutoffFor(pickup_day, schedule, nowMs = Date.now()) {
  const dow = dayOfWeek(pickup_day);
  const matching = schedule.filter(s =>
    s.day_of_week === dow && (s.mode === 'pickup' || s.mode === 'both') && s.active === 1
  );
  if (matching.length === 0) {
    return { orderable: false, cutoffAt: null, reason: 'no_pickup_schedule' };
  }
  const entry = matching[0];
  const pickupStartMs = combineDateAndTime(pickup_day, entry.start_time);
  const offset = Number(entry.cutoff_offset_hours) || 0;
  const cutoffMs = pickupStartMs - offset * 3600 * 1000;
  return {
    orderable: nowMs <= cutoffMs,
    cutoffAt: new Date(cutoffMs).toISOString(),
    reason: nowMs <= cutoffMs ? null : 'past_cutoff'
  };
}

function validateScheduled(opts) {
  const { pickup_day, items, combos, nowMs, schedule, config } = opts;
  const dow = dayOfWeek(pickup_day);

  const matchingSchedule = schedule.filter(s =>
    s.day_of_week === dow && (s.mode === 'pickup' || s.mode === 'both') && s.active === 1
  );
  if (matchingSchedule.length === 0) {
    return { ok: false, code: 'no_pickup_schedule', message: `No hay horario de pickup para ${pickup_day}` };
  }

  const orderEntry = matchingSchedule[0];
  // Misma regla que /api/public/ publica como `orderable` (una sola copia).
  const cutoff = pickupCutoffFor(pickup_day, schedule, nowMs);
  if (!cutoff.orderable) {
    return {
      ok: false, code: 'past_cutoff',
      message: `Cutoff ya pasó: el pedido debe hacerse antes de ${orderEntry.start_time} - ${orderEntry.cutoff_offset_hours}h`
    };
  }

  const windows = db.prepare(`
    SELECT rw.id, rw.release_date, rw.status, rw.cutoff_at,
           ri.id AS item_id, ri.flavor_id, ri.units_sold, ri.units_available, ri.units_reserved
    FROM release_windows rw
    LEFT JOIN release_items ri ON ri.window_id = rw.id
    WHERE rw.release_date = ?
  `).all(pickup_day);

  const openWindow = windows.find(w => w.status === 'open');
  if (!openWindow) {
    return { ok: false, code: 'no_release_window', message: `No hay release_window 'open' para ${pickup_day}` };
  }

  // El pedido puede traer SOLO sabores, SOLO combos, o ambos. Antes esto exigia
  // `items` no vacio, lo que hacia imposible comprar un combo suelto.
  const requestedFlavors = Object.entries(items || {})
    .filter(([, qty]) => Number(qty) > 0)
    .map(([flavor_id, qty]) => ({ flavor_id, qty: Number(qty) }));

  const requestedCombos = (Array.isArray(combos) ? combos : [])
    .filter(c => Number(c?.qty ?? c?.units ?? 1) > 0)
    .map(c => ({ id: String(c.id ?? c.combo_id), qty: Number(c.qty ?? c.units ?? 1) }));

  if (requestedFlavors.length === 0 && requestedCombos.length === 0) {
    return { ok: false, code: 'no_items', message: 'El pedido no tiene sabores ni combos' };
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
    // El saldo que se puede prometer descuenta tambien lo reservado por pedidos
    // sin pagar: si no, el cliente ve disponible algo que otro ya tiene retenido.
    const remaining = w.units_available - (w.units_sold || 0) - (w.units_reserved || 0);
    if (req.qty > remaining) {
      return {
        ok: false, code: 'insufficient_stock',
        message: `Stock insuficiente para ${req.flavor_id}: pedido ${req.qty}, disponibles ${remaining}`
      };
    }
  }

  return { ok: true, pickup_day, window_id: openWindow.id, requestedFlavors, requestedCombos, itemsByFlavor: Object.fromEntries(itemsByFlavor) };
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

// Solo admin ve el libro completo de pedidos (PII: nombre, telefono, direccion,
// notas). `PATCH`, `DELETE` y `confirm-payment` ya exigian requireRole('admin');
// estos dos GET solo exigian autenticacion, asi que cualquier cuenta creada con
// POST /api/auth/register —que es publico y emite role:'customer' sin coste—
// podia leer los pedidos de todos los clientes y filtrarlos por ?q= para
// buscar a una persona concreta. Verificado 2026-10-21: un customer recien
// registrado leyo los 2 pedidos con telefono y total.
//
// Un customer solo puede ver SUS propios pedidos, y se filtran por telefono:
// no se acepta un ?customer_phone= del cliente para leer los ajenos.
function ordersVisibleTo(req) {
  return req.user?.role === 'admin' ? null : req.user?.phone || null;
}

router.get('/', authMiddleware, (req, res) => {
  const { status, day, week, q, limit = 100 } = req.query;
  const wheres = [];
  const params = [];

  // Customer: forzado a su propio telefono, sin importar lo que mande.
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
  const rows = db.prepare(sql).all(...params, Number(limit) || 100);
  res.json(rows.map(rowToOrder));
});

router.get('/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  // Customer: 404 (no 403) para no confirmar que el pedido ajeno existe.
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
    const r = validateScheduled({ pickup_day, items, combos, nowMs, schedule, config });
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
    // Tarifa por distancia (estilo DiDi/Rappi): la MISMA fórmula que usa la
    // cotización del carrito (POST /api/delivery/quote) — vive en
    // lib/delivery-fee.js para que las dos no puedan divergir.
    const feeCents = computeDeliveryFeeCents(config, distanceKm);
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

  // ---- Pricing server-side (auditoria 2026-10-20, bug #1) ----
  // El `total` que manda el cliente es solo una declaracion: el server lo
  // recalcula desde flavors.price / combos.price. Antes se persistia tal cual
  // y un POST con total=1DCS compraba 2 mochi + 1 combo por un peso.
  const clientTotal = Number(total);
  const priced = priceOrder({ items, combos, deliveryFee: computedDeliveryFee });
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
  const authoritativeTotal = priced.total;
  const totalDrift = Number.isFinite(clientTotal) && clientTotal !== authoritativeTotal
    ? { client_sent: clientTotal, server_computed: authoritativeTotal }
    : null;

  const insertOrderStmt = db.prepare(`
    INSERT INTO orders (
      id, customer_name, customer_phone, pickup_day,
      items_json, combos_json, total, notes, source,
      delivery_mode, delivery_provider, delivery_address,
      delivery_lat, delivery_lng, delivery_distance_km, delivery_fee_cents,
      payment_method_id, release_window_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // === Reserva (no venta) ===
  //
  // Al crear el pedido se RESERVA, no se vende: la venta ocurre al confirmar el
  // pago (commitReservedStock). Con el modelo anterior units_sold subia aqui,
  // asi que un pedido que el cliente nunca pagaba bloqueaba stock igual que uno
  // pagado y el operador producia para pedidos fantasma.
  //
  // El WHERE hace la operacion atomica: si dos pedidos compiten por la ultima
  // unidad, solo uno gana (el otro recibe changes=0 y la transaccion revierte).
  const resvItemStmt = db.prepare(`
    UPDATE release_items
    SET units_reserved = units_reserved + ?
    WHERE window_id = ? AND flavor_id = ?
      AND (units_available - units_reserved - units_sold) >= ?
  `);
  // units_available = -1 significa stock ilimitado (el default). El WHERE con
  // el saldo disponible hace la comprobacion y la reserva en una sola sentencia.
  const resvComboStmt = db.prepare(`
    UPDATE combos
    SET units_reserved = units_reserved + ?
    WHERE id = ?
      AND (units_available < 0 OR (units_available - units_reserved - units_sold) >= ?)
  `);

  db.exec('BEGIN');
  try {
    insertOrderStmt.run(
      id, customer_name, customer_phone, pickup_day,
      JSON.stringify(items || {}), JSON.stringify(combos || []),
      authoritativeTotal, notes || null, source || 'web',
      delivery_mode, delivery_provider, delivery_address || null,
      finalLat, finalLng, computedDistanceKm, computedDeliveryFee,
      payment_method_id || null,
      // La ventana de la que salio el stock. validateScheduled ya la resolvio
      // (window_id); sin guardarla el pedido solo conservaba la fecha como
      // texto y no habia forma de reconciliar pedido -> ventana -> stock.
      validated.window_id ?? null
    );

    if (delivery_mode === 'scheduled' && validated.requestedFlavors) {
      for (const req of validated.requestedFlavors) {
        const res = resvItemStmt.run(req.qty, validated.window_id, req.flavor_id, req.qty);
        if (res.changes !== 1) {
          const falta = db.prepare(
            'SELECT units_available, units_reserved, units_sold FROM release_items WHERE window_id = ? AND flavor_id = ?'
          ).get(validated.window_id, req.flavor_id);
          const detalle = falta
            ? ` (disponible ${falta.units_available - falta.units_reserved - falta.units_sold})`
            : '';
          throw Object.assign(
            new Error(`No hay stock de ${req.flavor_id}${detalle}`),
            { code: 'flavor_out_of_stock' }
          );
        }
      }
    }

    // Stock de combos (auditoria 2026-10-20, bug #6). `available` es un
    // contador, no un booleano: se descuenta y si no alcanza se revierte todo.
    if (delivery_mode === 'scheduled' && validated.requestedCombos) {
      for (const req of validated.requestedCombos) {
        const r = resvComboStmt.run(req.qty, Number(req.id), req.qty);
        if (r.changes !== 1) {
          const def = db.prepare('SELECT name FROM combos WHERE id = ?').get(Number(req.id));
          throw Object.assign(
            new Error(`Stock insuficiente del combo ${def?.name || req.id}`),
            { code: 'combo_out_of_stock' },
          );
        }
      }
    }

    db.exec('COMMIT');
    // Mantiene el indice de totales que usa POST /api/payments al dia, sin
    // esperar un reinicio del server.
    rememberOrderTotal(id, authoritativeTotal);
    const full = rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
    full.pricing = { lines: priced.lines, total: authoritativeTotal };
    if (totalDrift) full.pricing.client_drift = totalDrift;

    // ---- Dispatch WhatsApp multi-destinatario (2026-10-17) ----
    const flavorList = db.prepare('SELECT id, name, price FROM flavors').all();
    const comboList = db.prepare('SELECT id, name, price FROM combos').all();

    const recipients = db.prepare('SELECT label, phone FROM order_recipients WHERE active = 1 ORDER BY sort_order ASC, id ASC').all()
      .map(r => ({ label: r.label, phone: String(r.phone).replace(/\D/g, '') }))
      .filter(r => r.phone);

    // Fallback legacy: config.whatsapp_number cuando no hay destinatarios activos
    if (recipients.length === 0) {
      const fallback = String(config.whatsapp_number || '').replace(/\D/g, '');
      if (fallback && fallback !== '573000000000') {
        recipients.push({ label: 'Admin principal', phone: fallback });
      }
    }

    // Round-robin: reparte los pedidos entre los números activos
    let primary = null;
    if (recipients.length) {
      const orderCount = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
      primary = recipients[orderCount % recipients.length];
    }

    // Ventana de horario real del día de recogida (para el mensaje WSP)
    const pickupDow = dayOfWeek(pickup_day);
    const sched = db.prepare(
      "SELECT start_time, end_time FROM delivery_schedule WHERE day_of_week = ? AND active = 1 AND mode IN ('pickup','both') ORDER BY id LIMIT 1"
    ).get(pickupDow);

    const wsp = await buildDispatch(full, {
      primaryPhone: primary?.phone || null,
      primary_label: primary?.label || null,
      recipients,
      business_name: config.business_name,
      flavors: flavorList,
      combos: comboList,
      pickup_window_start: sched?.start_time || null,
      pickup_window_end: sched?.end_time || null
    }).catch((e) => ({ deep_link: null, cloud_status: 'failed', cloud_error: String(e?.message || e).slice(0, 200) }));
    res.status(201).json({ ...full, whatsapp: wsp });
  } catch (e) {
    db.exec('ROLLBACK');
    const msg = String(e.message || '');
    if (msg.includes('UNIQUE')) return res.status(409).json({ error: 'duplicate', message: 'Ya existe un pedido con ese id' });
    if (e.code === 'combo_out_of_stock') {
      return res.status(409).json({ error: 'combo_out_of_stock', message: msg });
    }
    throw e;
  }
});

// ============ CONFIRMACIÓN DE PAGO MANUAL (admin) ============
// El caso real del negocio: el cliente transfiere a la cuenta, el operador
// confirma que llegó. Cierra el ciclo por el MISMO state machine que un pago
// automático (ledger + outbox + pedido marcado pagado), no editando la fila a
// mano como se hacía antes.
router.post('/:id/confirm-payment', [authMiddleware, requireRole('admin')], (req, res) => {
  const { reference, note, amount } = req.body || {};
  try {
    const out = confirmManualPayment({
      orderId: req.params.id,
      actor: req.user?.email || 'admin',
      reference: reference ? String(reference).trim() : null,
      note: note ? String(note).trim() : null,
      amount: amount != null && amount !== '' ? Number(amount) : null,
    });

    // Confirmar el pago es el momento en que la RESERVA pasa a ser VENTA.
    // Hasta aqui las unidades estaban retenidas (units_reserved) para este
    // pedido pero no contaban como vendidas. Solo cuando el dinero entra se
    // mueven a units_sold: antes, un pedido que nunca se pagaba bloqueaba
    // stock real y el operador producia para pedidos fantasma.
    //
    // No se hace si ya estaba confirmado: confirmManualPayment es idempotente y
    // en ese caso ya se comprovisiono en su primera llamada.
    let committed = null;
    if (!out.already_confirmed) {
      committed = commitReservedStock(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id));
    }

    // Notificar al admin por WSP que el pedido quedó pagado, con la info del usuario.
    notifyOrderConfirmed(req.params.id).catch((e) =>
      console.error(`[orders] wsp notify failed ${req.params.id}:`, e?.message || e)
    );

    res.status(out.already_confirmed ? 200 : 201).json({
      ok: true,
      already_confirmed: out.already_confirmed,
      payment_id: out.payment.payment_id,
      state: out.payment.state,
      amount: out.payment.amount_minor,
      order_id: out.payment.order_id,
      stock_committed: committed,
      message: out.already_confirmed
        ? 'Este pedido ya tenía un pago confirmado'
        : 'Pago confirmado y registrado en el ledger',
    });
  } catch (e) {
    if (e instanceof ManualPaymentError) {
      const status = e.code === 'order_not_found' ? 404
                   : e.code === 'amount_mismatch' ? 409
                   : 400;
      return res.status(status).json({ error: e.code, message: e.message, details: e.details });
    }
    console.error('[orders] confirm-payment error', e);
    res.status(500).json({ error: 'internal', message: e.message });
  }
});

// requireRole('admin'): /api/auth/register es PUBLICO y emite un token con
// role:'customer'. Con solo authMiddleware cualquier visitante registrado
// podia marcar pedidos ajenos como pagados, cambiar su estado o BORRARLOS
// (verificado: 200 OK en los tres casos con un token de customer).
router.patch('/:id', [authMiddleware, requireRole('admin')], (req, res) => {
  const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
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

  // Cancelar devuelve el stock. Solo en la TRANSICION a cancelled: repetir el
  // PATCH con el mismo status no debe restituir dos veces.
  const wasCancelled = existing.status === 'cancelled';
  const nowCancelled = updates.status === 'cancelled';

  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE orders SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
    let restored = null;
    if (nowCancelled && !wasCancelled) {
      restored = releaseReservedStock(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id));
    }
    db.exec('COMMIT');
    if (restored) {
      res.json({ ...rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)),
                 stock_restored: restored });
      return;
    }
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'internal', message: e.message });
  }
  res.json(rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', [authMiddleware, requireRole('admin')], (req, res) => {
  // Se lee la fila ANTES de borrar: es la que dice cuantas unidades devolver.
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  let restored = null;
  db.exec('BEGIN');
  try {
    const result = db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      db.exec('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }
    // Un pedido ya cancelado devuelve su stock dos veces si se borra después.
    restored = row.status === 'cancelled'
      ? { flavors: 0, combos: 0 }
      : releaseReservedStock(row);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'internal', message: e.message });
  }
  res.json({ ok: true, stock_restored: restored });
});

export default router;