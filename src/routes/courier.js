import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../db.js';
import { authMiddleware, requireRole, signJwt, verifyPassword } from '../auth.js';
import { courierForUser, getDispatch, transitionDispatch, DispatchError } from '../lib/dispatch.js';
import { confirmManualPayment, ManualPaymentError } from '../lib/payments/manual.js';
import { commitReservedStock } from '../lib/stock.js';
import { priceOrder } from '../lib/pricing.js';
import { evaluateDelivery } from '../lib/delivery-rules.js';
import { computeCourierPickup, parsePickupSnapshot } from '../lib/courier-pricing.js';
import { publish } from '../lib/events.js';
import { weekdayForDate } from '../lib/business-time.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Demasiados intentos, espera 15 minutos' },
});

function courierOut(c) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    base_fare_cents: c.base_fare_cents,
    price_per_km_cents: c.price_per_km_cents,
    lat: c.lat,
    lng: c.lng,
    address: c.address,
    vehicle: c.vehicle,
    max_radius_km: c.max_radius_km,
    active: c.active,
  };
}

function dispatchOut(d) {
  if (!d) return null;
  return {
    ...d,
    cod_collected: Boolean(d.cod_collected),
  };
}

function orderSummary(order, flavors, combos) {
  let items = [];
  let comboLines = [];
  try {
    items = Object.entries(JSON.parse(order.items_json || '{}'))
      .filter(([, qty]) => Number(qty) > 0)
      .map(([flavor_id, qty]) => ({
        flavor_id,
        qty: Number(qty),
        name: flavors.get(flavor_id) || flavor_id,
      }));
  } catch {}
  try {
    comboLines = (JSON.parse(order.combos_json || '[]') || [])
      .filter(c => Number(c?.qty ?? c?.units ?? 1) > 0)
      .map(c => {
        const id = String(c.id ?? c.combo_id);
        return {
          id,
          qty: Number(c.qty ?? c.units ?? 1),
          name: combos.get(id) || id,
        };
      });
  } catch {}
  return { items, combos: comboLines };
}

/**
 * Costo del pedido, con las MISMAS reglas que usa la landing.
 *
 * La landing cotiza el domicilio con POST /api/delivery/quote, que termina en
 * evaluateDelivery() (distancia desde la zona del negocio + tarifa base + por
 * km + reglas de domicilio gratis). El domiciliario tiene que ver ese mismo
 * numero: si el panel le muestra otra cosa, el que cobra no coincide con lo
 * que el cliente pago.
 *
 * Si el pedido no tiene coordenadas (o el domicilio esta apagado en la config)
 * se cae al valor que quedo guardado cuando el cliente lo hizo: el numero que
 * el cliente vio, no uno recalculado.
 */
function quoteForOrder(order, config, rules) {
  let items = {};
  let combos = [];
  try { items = JSON.parse(order.items_json || '{}'); } catch {}
  try { combos = JSON.parse(order.combos_json || '[]') || []; } catch {}

  const priced = priceOrder({ items, combos, deliveryFee: 0 });
  const subtotalCents = priced.lines.reduce((acc, l) => acc + l.subtotal, 0);

  const hasGeo = order.delivery_lat != null && order.delivery_lng != null;
  let evaluation = null;
  if (hasGeo) {
    try {
      evaluation = evaluateDelivery({
        config,
        geo: { lat: Number(order.delivery_lat), lng: Number(order.delivery_lng) },
        address: order.delivery_address || '',
        rules,
        subtotalCents,
      });
    } catch {
      evaluation = null;
    }
  }

  const live = evaluation && evaluation.ok;
  const deliveryFeeCents = live ? evaluation.fee_cents : (order.delivery_fee_cents ?? null);
  const distanceKm = live ? evaluation.distance_km : (order.delivery_distance_km ?? null);

  return {
    lines: priced.lines,
    subtotal_cents: subtotalCents,
    delivery_fee_cents: deliveryFeeCents,
    distance_km: distanceKm,
    total_cents: Number(order.total) || 0,
    free_delivery: live ? Boolean(evaluation.free_delivery) : Boolean(order.delivery_free_applied),
    source: live ? 'landing' : 'pedido',
    error: live ? null : (evaluation ? evaluation.error : 'sin_geocodificacion'),
  };
}

/**
 * Lo que el domiciliario gana por ir a buscar el pedido (D17).
 *
 * El costo sale de la tarifa PROPIA del domiciliario (base + por km) aplicada a
 * la distancia entre el negocio (la zona del admin, que es donde esta la
 * landing) y la ultima ubicacion que reporta el domiciliario.
 *
 * Piso de margen (D18): el domiciliario nunca gana menos de lo que el
 * domicilio le cuesta al negocio (delivery_fee_cents) MAS un margen minimo (un
 * % sobre el costo y/o un minimo por pedido).
 *
 * Inmutable: el reparto guarda el snapshot con el que se asigno, asi que el
 * numero que ve el domicillero no cambia aunque se mueva o el admin cambie las
 * reglas. Los repartos viejos (sin snapshot) se estiman en vivo y se marcan
 * como tales.
 */
function courierPickupCost(courier, config, { costCents = 0, distanceKm = null } = {}, dispatch = null) {
  const frozen = parsePickupSnapshot(dispatch?.pickup_snapshot_json);
  if (frozen) return { ...frozen, frozen: true };

  const live = computeCourierPickup({
    courier,
    order: { delivery_fee_cents: costCents, delivery_distance_km: distanceKm },
    config,
  });
  return { ...live, frozen: false };
}

function pickupWindow(pickupDay) {
  const dow = weekdayForDate(pickupDay);
  const row = db
    .prepare(
      "SELECT start_time, end_time FROM delivery_schedule WHERE day_of_week = ? AND active = 1 AND mode IN ('pickup','both') ORDER BY id LIMIT 1",
    )
    .get(dow);
  return {
    day: pickupDay,
    weekday: dow,
    start: row?.start_time || null,
    end: row?.end_time || null,
  };
}

router.post('/login', loginLimiter, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'bad_request', message: 'email y password son obligatorios' });
  }

  const user = db
    .prepare('SELECT id, email, password_hash, password_salt, name, role, phone FROM users WHERE email = ?')
    .get(email);
  const fakeHash = '0'.repeat(64);
  const fakeSalt = '0'.repeat(32);
  const valid = verifyPassword(password, user?.password_salt || fakeSalt, user?.password_hash || fakeHash);

  if (!user || !valid) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Email o clave incorrectos' });
  }
  if (user.role !== 'courier') {
    return res.status(403).json({ error: 'forbidden', message: 'Esta cuenta no es de domiciliario' });
  }

  const courier = courierForUser(user.id);
  if (!courier) {
    return res.status(403).json({ error: 'courier_profile_missing', message: 'La cuenta no tiene perfil de domiciliario' });
  }
  if (!courier.active) {
    return res.status(403).json({ error: 'courier_inactive', message: 'El domiciliario está desactivado' });
  }

  const token = signJwt({ sub: user.id, email: user.email, role: 'courier', phone: user.phone || null });
  res.json({
    token,
    courier: courierOut(courier),
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

function courierResolver(req, res, next) {
  const courier = courierForUser(req.user.sub);
  if (!courier) {
    return res.status(403).json({
      error: 'courier_profile_missing',
      message: 'La cuenta no tiene perfil de domiciliario',
    });
  }
  req.courier = courier;
  next();
}

const courierAuth = [authMiddleware, requireRole('courier'), courierResolver];

router.get('/me', ...courierAuth, (req, res) => {
  const stats = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('assigned','picked_up','on_way') THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM dispatches WHERE courier_id = ?`,
    )
    .get(req.courier.id);
  res.json({ courier: courierOut(req.courier), stats });
});

router.get('/queue', ...courierAuth, (req, res) => {
  const flavors = new Map(db.prepare('SELECT id, name FROM flavors').all().map(f => [f.id, f.name]));
  const combos = new Map(db.prepare('SELECT id, name FROM combos').all().map(c => [String(c.id), c.name]));
  const config = db.prepare('SELECT * FROM config WHERE id = 1').get() || {};
  let rules = [];
  try {
    rules = db.prepare('SELECT * FROM delivery_free_rules WHERE active = 1 ORDER BY id').all();
  } catch {}

  const rows = db
    .prepare(
      `SELECT d.*, o.customer_name, o.customer_phone, o.delivery_address, o.delivery_lat, o.delivery_lng,
              o.delivery_distance_km, o.delivery_fee_cents, o.delivery_free_applied, o.pickup_day, o.total,
              o.payment_status, o.payment_method, o.payment_method_id, o.items_json, o.combos_json, o.notes,
              o.release_window_id, o.created_at AS order_created_at
       FROM dispatches d JOIN orders o ON o.id = d.order_id
       WHERE d.courier_id = ?
       ORDER BY CASE d.status WHEN 'assigned' THEN 0 WHEN 'picked_up' THEN 1 WHEN 'on_way' THEN 2 ELSE 3 END,
                d.assigned_at ASC
       LIMIT 200`,
    )
    .all(req.courier.id);

  const methodLabel = (r) => {
    if (r.payment_method_id) {
      const m = db.prepare('SELECT label FROM payment_methods WHERE id = ?').get(r.payment_method_id);
      if (m?.label) return m.label;
    }
    return r.payment_method || null;
  };

  const dispatches = rows.map(r => {
    const summary = orderSummary(r, flavors, combos);
    const quote = quoteForOrder(r, config, rules);
    const priced = new Map(quote.lines.map(l => [`${l.type}:${l.id}`, l]));
    const window = pickupWindow(r.pickup_day);

    return {
      id: r.id,
      order_id: r.order_id,
      status: r.status,
      assigned_by: r.assigned_by,
      assigned_at: r.assigned_at,
      picked_up_at: r.picked_up_at,
      on_way_at: r.on_way_at,
      delivered_at: r.delivered_at,
      failed_at: r.failed_at,
      cod_collected: Boolean(r.cod_collected),
      cod_collected_at: r.cod_collected_at,
      failure_reason: r.failure_reason,
      distance_km: r.distance_km,
      fee_cents: r.fee_cents,
      customer_name: r.customer_name,
      customer_phone: r.customer_phone,
      delivery_address: r.delivery_address,
      delivery_lat: r.delivery_lat,
      delivery_lng: r.delivery_lng,
      delivery_distance_km: r.delivery_distance_km,
      delivery_fee_cents: r.delivery_fee_cents,
      pickup_day: r.pickup_day,
      total: r.total,
      payment_status: r.payment_status,
      notes: r.notes,
      items: summary.items.map(i => {
        const line = priced.get(`flavor:${i.flavor_id}`);
        return {
          ...i,
          unit_price_cents: line?.unitPrice ?? null,
          subtotal_cents: line?.subtotal ?? null,
        };
      }),
      combos: summary.combos.map(c => {
        const line = priced.get(`combo:${c.id}`);
        return {
          ...c,
          unit_price_cents: line?.unitPrice ?? null,
          subtotal_cents: line?.subtotal ?? null,
        };
      }),
      window,
      payment: {
        status: r.payment_status,
        method: methodLabel(r),
        collected: Boolean(r.cod_collected),
      },
      cost: {
        subtotal_cents: quote.subtotal_cents,
        delivery_fee_cents: quote.delivery_fee_cents,
        distance_km: quote.distance_km,
        total_cents: quote.total_cents,
        free_delivery: quote.free_delivery,
        source: quote.source,
        error: quote.error,
        courier_pickup: courierPickupCost(
          req.courier,
          config,
          { costCents: quote.delivery_fee_cents, distanceKm: r.delivery_distance_km },
          r,
        ),
      },
    };
  });

  res.json({ dispatches, courier: courierOut(req.courier) });
});

router.post('/dispatch/:id/status', ...courierAuth, (req, res) => {
  const dispatch = getDispatch(req.params.id);
  if (!dispatch) return res.status(404).json({ error: 'not_found', message: 'El reparto no existe' });
  if (Number(dispatch.courier_id) !== Number(req.courier.id)) {
    return res.status(403).json({ error: 'forbidden', message: 'Ese reparto es de otro domiciliario' });
  }
  const status = String(req.body?.status || '');
  try {
    const out = transitionDispatch({
      dispatchId: dispatch.id,
      toStatus: status,
      actor: `courier:${req.courier.id}`,
      note: req.body?.note ? String(req.body.note).slice(0, 400) : null,
      failureReason: req.body?.failure_reason ? String(req.body.failure_reason).slice(0, 400) : null,
    });
    res.json({ ok: true, changed: out.changed, dispatch: dispatchOut(out.dispatch) });
  } catch (e) {
    if (e instanceof DispatchError) {
      return res.status(e.status).json({ error: e.code, message: e.message, details: e.details });
    }
    throw e;
  }
});

router.post('/dispatch/:id/collect-cash', ...courierAuth, (req, res) => {
  const dispatch = getDispatch(req.params.id);
  if (!dispatch) return res.status(404).json({ error: 'not_found', message: 'El reparto no existe' });
  if (Number(dispatch.courier_id) !== Number(req.courier.id)) {
    return res.status(403).json({ error: 'forbidden', message: 'Ese reparto es de otro domiciliario' });
  }
  if (!['picked_up', 'on_way', 'delivered'].includes(dispatch.status)) {
    return res.status(409).json({
      error: 'invalid_status',
      message: 'No se puede cobrar un reparto que todavía no fue recogido',
    });
  }
  if (dispatch.cod_collected) {
    return res.json({ ok: true, already: true, dispatch: dispatchOut(dispatch) });
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(dispatch.order_id);
  if (!order) return res.status(404).json({ error: 'order_not_found', message: 'El pedido no existe' });

  let alreadyConfirmed = false;
  if (order.payment_status !== 'paid') {
    try {
      const out = confirmManualPayment({
        orderId: order.id,
        actor: `courier:${req.courier.id}`,
        reference: `COD-${dispatch.id}`,
        note: 'Pago contra entrega confirmado por el domiciliario',
        amount: null,
      });
      alreadyConfirmed = Boolean(out.already_confirmed);
      if (!out.already_confirmed) {
        commitReservedStock(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
      }
    } catch (e) {
      if (e instanceof ManualPaymentError) {
        const status = e.code === 'order_not_found' ? 404 : e.code === 'amount_mismatch' ? 409 : 400;
        return res.status(status).json({ error: e.code, message: e.message, details: e.details });
      }
      throw e;
    }
  } else {
    alreadyConfirmed = true;
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE dispatches SET cod_collected = 1, cod_collected_at = ?, updated_at = ? WHERE id = ?').run(
    now,
    now,
    dispatch.id,
  );
  // El pago contra entrega es estado de dominio del PEDIDO (spec 58, p6): el
  // pedido sabe si el efectivo ya se cobro, quien lo cobro y cuando. Antes
  // solo existia el flag del reparto y el pedido no lo sabia.
  db.prepare(`
    UPDATE orders
    SET cod_state = 'collected', cod_collected_by = ?, cod_collected_at = ?, cod_method = 'cash'
    WHERE id = ?
  `).run(`courier:${req.courier.id}`, now, dispatch.order_id);
  db.prepare(
    'INSERT INTO dispatch_log (dispatch_id, from_status, to_status, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    dispatch.id,
    dispatch.status,
    dispatch.status,
    `courier:${req.courier.id}`,
    'cobro contra entrega confirmado',
    now,
  );

  publish('dispatch.cod', {
    dispatch_id: Number(dispatch.id),
    order_id: dispatch.order_id,
    courier_id: dispatch.courier_id,
    status: dispatch.status,
  });
  publish('payment.cod_collected', {
    dispatch_id: Number(dispatch.id),
    order_id: dispatch.order_id,
    courier_id: dispatch.courier_id,
    collected_at: now,
  });

  res.json({
    ok: true,
    already: false,
    payment_already_confirmed: alreadyConfirmed,
    dispatch: dispatchOut(getDispatch(dispatch.id)),
  });
});

router.post('/dispatch/:id/incident', ...courierAuth, (req, res) => {
  const dispatch = getDispatch(req.params.id);
  if (!dispatch) return res.status(404).json({ error: 'not_found', message: 'El reparto no existe' });
  if (Number(dispatch.courier_id) !== Number(req.courier.id)) {
    return res.status(403).json({ error: 'forbidden', message: 'Ese reparto es de otro domiciliario' });
  }
  const note = String(req.body?.note || '').trim().slice(0, 500);
  if (!note) {
    return res.status(400).json({ error: 'bad_request', message: 'Describe la incidencia' });
  }
  const markFailed = req.body?.status === 'failed';
  try {
    const out = markFailed
      ? transitionDispatch({
          dispatchId: dispatch.id,
          toStatus: 'failed',
          actor: `courier:${req.courier.id}`,
          note,
          failureReason: note,
        })
      : { changed: false, dispatch };
    if (!markFailed) {
      const now = new Date().toISOString();
      db.prepare('UPDATE dispatches SET notes = ?, updated_at = ? WHERE id = ?').run(note, now, dispatch.id);
      db.prepare(
        'INSERT INTO dispatch_log (dispatch_id, from_status, to_status, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(dispatch.id, dispatch.status, dispatch.status, `courier:${req.courier.id}`, note, now);
    }
    res.json({ ok: true, changed: out.changed, dispatch: dispatchOut(markFailed ? out.dispatch : getDispatch(dispatch.id)) });
  } catch (e) {
    if (e instanceof DispatchError) {
      return res.status(e.status).json({ error: e.code, message: e.message, details: e.details });
    }
    throw e;
  }
});

router.post('/location', ...courierAuth, (req, res) => {
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const accuracy = req.body?.accuracy === undefined || req.body?.accuracy === null ? null : Number(req.body.accuracy);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'bad_coords', message: 'Coordenadas inválidas' });
  }
  const now = new Date().toISOString();
  db.prepare('INSERT INTO courier_locations (courier_id, lat, lng, accuracy, recorded_at) VALUES (?, ?, ?, ?, ?)').run(
    req.courier.id,
    lat,
    lng,
    Number.isFinite(accuracy) ? accuracy : null,
    now,
  );
  db.prepare('UPDATE couriers SET lat = ?, lng = ?, updated_at = ? WHERE id = ?').run(lat, lng, now, req.courier.id);
  db.prepare(
    `DELETE FROM courier_locations WHERE courier_id = ? AND id NOT IN (
       SELECT id FROM courier_locations WHERE courier_id = ? ORDER BY recorded_at DESC LIMIT 200
     )`,
  ).run(req.courier.id, req.courier.id);

  res.json({ ok: true, lat, lng, recorded_at: now });
});

export default router;
