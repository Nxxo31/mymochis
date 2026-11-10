// MyMochis · Motor de reparto (spec 57, r1/r3)
//
// QUE RESUELVE
// El pedido de domicilio necesita saber QUIEN lo lleva y en QUE estado esta.
// Este modulo es el unico que:
//
//   1. Elige el domiciliario (menos carga activa, desempate por distancia).
//   2. Crea el reparto (dispatches) y lo deja en cola.
//   3. Mueve el reparto por la maquina de estados y deja rastro (dispatch_log).
//
// DECISIONES DEL OPERADOR (PROJECT.md 34.1)
//   D16: la asignacion es AUTOMATICA. Si hay uno disponible se asigna y el
//         pedido entra en cola; el admin puede reasignar a mano.
//   D17: cada domiciliario tiene su propia tarifa segun su ubicacion (la
//         aplica el admin en el mapa). Sin domiciliario asignado se usa la
//         tarifa por distancia ya existente (r4/r10).
//
// FAIL-CLOSED
// Si no hay ningun domiciliario elegible NO se asigna a nadie: el pedido queda
// sin reparto y el admin lo ve en la cola. Prefiere fallar cerrado (nadie
// lleva el pedido) a fallar abierto (un domiciliario fuera de radio lo lleva).
import { db } from '../db.js';
import { haversineDistanceKm } from './delivery-rules.js';
import { buildPickupSnapshot } from './courier-pricing.js';
import { publish } from './events.js';

export const DISPATCH_STATUSES = [
  'assigned',
  'picked_up',
  'on_way',
  'delivered',
  'failed',
  'cancelled',
];

export const ACTIVE_DISPATCH_STATUSES = ['assigned', 'picked_up', 'on_way'];

export const DISPATCH_TRANSITIONS = {
  assigned: ['picked_up', 'failed', 'cancelled'],
  picked_up: ['on_way', 'failed'],
  on_way: ['delivered', 'failed'],
  failed: ['assigned', 'cancelled'],
  delivered: [],
  cancelled: [],
};

const TIMESTAMP_COLUMN = {
  picked_up: 'picked_up_at',
  on_way: 'on_way_at',
  delivered: 'delivered_at',
  failed: 'failed_at',
};

export class DispatchError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function getDispatch(dispatchId) {
  const id = Number(dispatchId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.prepare('SELECT * FROM dispatches WHERE id = ?').get(id) || null;
}

export function courierForUser(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.prepare('SELECT * FROM couriers WHERE user_id = ? LIMIT 1').get(id) || null;
}

export function activeLoadByCourier() {
  const rows = db
    .prepare(
      `SELECT courier_id, COUNT(*) AS n FROM dispatches
       WHERE status IN ('assigned','picked_up','on_way') GROUP BY courier_id`,
    )
    .all();
  const map = new Map();
  for (const r of rows) map.set(Number(r.courier_id), Number(r.n));
  return map;
}

/**
 * Elige el domiciliario para un destino.
 *
 * Criterios, en orden:
 *   1. Solo domiciliario activo.
 *   2. Radio maximo: si el domiciliario tiene max_radius_km y la distancia
 *      desde su ultima ubicacion conocida al destino lo supera, queda fuera.
 *      Sin ubicacion conocida NO se puede verificar el radio -> fuera
 *      (fail-closed).
 *   3. Menos carga activa (pedidos assigned+picked_up+on_way).
 *   4. Desempate por distancia al destino.
 *   5. Desempate final por id (determinista).
 *
 * @returns {{courier: object|null, load: number, distance: number|null, reason: string|null}}
 */
export function pickCourier({ lat = null, lng = null } = {}) {
  const couriers = db.prepare('SELECT * FROM couriers WHERE active = 1 ORDER BY id ASC').all();
  if (couriers.length === 0) return { courier: null, load: 0, distance: null, reason: 'no_active_couriers' };

  const loads = activeLoadByCourier();
  const hasDestination = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));

  const scored = [];
  for (const c of couriers) {
    let distance = null;
    if (hasDestination && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng))) {
      distance = haversineDistanceKm(Number(c.lat), Number(c.lng), Number(lat), Number(lng));
    }
    const maxRadius = Number(c.max_radius_km);
    if (Number.isFinite(maxRadius) && maxRadius > 0) {
      if (distance === null) continue;
      if (distance > maxRadius) continue;
    }
    scored.push({ courier: c, load: loads.get(Number(c.id)) || 0, distance });
  }

  if (scored.length === 0) {
    return { courier: null, load: 0, distance: null, reason: 'no_courier_in_radius' };
  }

  scored.sort((a, b) => {
    if (a.load !== b.load) return a.load - b.load;
    const ad = a.distance ?? Number.POSITIVE_INFINITY;
    const bd = b.distance ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return Number(a.courier.id) - Number(b.courier.id);
  });

  return { courier: scored[0].courier, load: scored[0].load, distance: scored[0].distance, reason: null };
}

export function logTransition({ dispatchId, fromStatus = null, toStatus, actor, note = null }) {
  db.prepare(
    'INSERT INTO dispatch_log (dispatch_id, from_status, to_status, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(Number(dispatchId), fromStatus, toStatus, String(actor), note, nowIso());
}

/**
 * Congela el precio de recogida del reparto (spec 57, r4/r10).
 *
 * Se calcula UNA vez, en el momento de asignar. El domicillero ve ese numero
 * aunque se mueva o el admin cambie las reglas despues: lo que se cobra no
 * cambia bajo los pies de quien cobra.
 *
 * El snapshot guarda ademas las reglas con las que se calculo (tarifa propia,
 * distancia, piso, margen) para poder auditar por que quedo asi.
 */
function freezePickupSnapshot({ dispatchId, order, courier }) {
  const config = db.prepare('SELECT * FROM config WHERE id = 1').get() || {};
  const snapshot = buildPickupSnapshot({ courier, order, config });
  db.prepare(
    'UPDATE dispatches SET pickup_cost_cents = ?, pickup_distance_km = ?, pickup_snapshot_json = ?, updated_at = ? WHERE id = ?',
  ).run(snapshot.cents, snapshot.distance_km, JSON.stringify(snapshot), nowIso(), Number(dispatchId));
  db.prepare('UPDATE orders SET pickup_cost_cents = ? WHERE id = ?').run(
    snapshot.cents,
    String(order.id),
  );
  return snapshot;
}

/**
 * Asigna un domiciliario a un pedido (automatico).
 *
 * Idempotente por pedido: si ya hay un reparto, lo devuelve sin tocar nada.
 * Si no hay ningun domiciliario elegible NO crea reparto y devuelve
 * { assigned: false, reason } — el pedido queda en la cola para que el admin
 * lo asigne a mano.
 */
export function assignCourier({ orderId, lat = null, lng = null, actor = 'system:auto-assign' } = {}) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(String(orderId));
  if (!order) throw new DispatchError('order_not_found', `No existe el pedido ${orderId}`, 404);

  const existing = db
    .prepare('SELECT * FROM dispatches WHERE order_id = ? ORDER BY id DESC LIMIT 1')
    .get(String(orderId));
  if (existing) {
    return { assigned: true, changed: false, dispatch: existing, courier_id: existing.courier_id, reason: 'already_assigned' };
  }

  const pick = pickCourier({ lat, lng });
  if (!pick.courier) {
    return { assigned: false, changed: false, dispatch: null, courier_id: null, reason: pick.reason };
  }

  const now = nowIso();
  db.exec('BEGIN');
  try {
    const r = db
      .prepare(
        `INSERT INTO dispatches (order_id, courier_id, status, assigned_by, assigned_at, distance_km, created_at, updated_at)
         VALUES (?, ?, 'assigned', 'auto', ?, ?, ?, ?)`,
      )
      .run(String(orderId), pick.courier.id, now, pick.distance, now, now);
    const dispatchId = Number(r.lastInsertRowid);
    db.prepare('UPDATE orders SET courier_id = ?, dispatch_id = ? WHERE id = ?').run(
      pick.courier.id,
      dispatchId,
      String(orderId),
    );
    freezePickupSnapshot({ dispatchId, order, courier: pick.courier });
    logTransition({
      dispatchId,
      toStatus: 'assigned',
      actor,
      note: `auto · ${pick.courier.name} · carga ${pick.load}`,
    });
    db.exec('COMMIT');
    // El evento sale DESPUES del commit: si el cliente reacciona y pide la
    // cola, tiene que ver el reparto ya guardado.
    publish('dispatch.assigned', {
      dispatch_id: dispatchId,
      order_id: String(orderId),
      courier_id: pick.courier.id,
      assigned_by: 'auto',
    });
    return {
      assigned: true,
      changed: true,
      dispatch: getDispatch(dispatchId),
      courier_id: pick.courier.id,
      reason: null,
    };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Asigna un domiciliario a mano (admin). Si el pedido ya tiene reparto, lo
 * reasigna: cierra el anterior como 'cancelled' y crea uno nuevo.
 */
export function assignCourierManually({ orderId, courierId, actor = 'admin', note = null }) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(String(orderId));
  if (!order) throw new DispatchError('order_not_found', `No existe el pedido ${orderId}`, 404);

  const courier = db.prepare('SELECT * FROM couriers WHERE id = ?').get(Number(courierId));
  if (!courier) throw new DispatchError('courier_not_found', 'El domiciliario no existe', 404);
  if (!courier.active) {
    throw new DispatchError('courier_inactive', 'El domiciliario está inactivo', 409);
  }

  const now = nowIso();
  db.exec('BEGIN');
  try {
    const previous = db
      .prepare('SELECT * FROM dispatches WHERE order_id = ? ORDER BY id DESC LIMIT 1')
      .get(String(orderId));
    if (previous && Number(previous.courier_id) !== Number(courierId)) {
      db.prepare(
        "UPDATE dispatches SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('assigned','picked_up','on_way')",
      ).run(now, previous.id);
      logTransition({
        dispatchId: previous.id,
        fromStatus: previous.status,
        toStatus: 'cancelled',
        actor,
        note: 'reasignado a mano',
      });
    }

    const r = db
      .prepare(
        `INSERT INTO dispatches (order_id, courier_id, status, assigned_by, assigned_at, created_at, updated_at)
         VALUES (?, ?, 'assigned', 'manual', ?, ?, ?)`,
      )
      .run(String(orderId), courier.id, now, now, now);
    const dispatchId = Number(r.lastInsertRowid);
    db.prepare('UPDATE orders SET courier_id = ?, dispatch_id = ? WHERE id = ?').run(
      courier.id,
      dispatchId,
      String(orderId),
    );
    freezePickupSnapshot({ dispatchId, order, courier });
    logTransition({ dispatchId, toStatus: 'assigned', actor, note: note || `manual · ${courier.name}` });
    db.exec('COMMIT');
    publish('dispatch.assigned', {
      dispatch_id: dispatchId,
      order_id: String(orderId),
      courier_id: courier.id,
      assigned_by: 'manual',
    });
    return { assigned: true, changed: true, dispatch: getDispatch(dispatchId), courier_id: courier.id };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Deja rastro en dispatch_log del envio WSP al domiciliario (spec 57, r6).
 * fromStatus = toStatus = 'assigned': el reparto no cambia de estado, solo
 * queda la evidencia del canal (sent | skipped | failed).
 */
export function logWspOutcome({ dispatchId, status, error = null, template = null }) {
  const note = `wsp:${status}${template ? ` (${template})` : ''}${error ? ` · ${String(error).slice(0, 120)}` : ''}`;
  logTransition({ dispatchId, fromStatus: 'assigned', toStatus: 'assigned', actor: 'system:wsp', note });
}

/**
 * Mueve el reparto por la maquina de estados.
 *
 * Idempotente: repetir la misma transicion (el domiciliario toco dos veces, o
 * la red reintenta) devuelve changed:false en vez de fallar.
 */
export function transitionDispatch({ dispatchId, toStatus, actor = 'system', note = null, failureReason = null }) {
  const dispatch = getDispatch(dispatchId);
  if (!dispatch) throw new DispatchError('dispatch_not_found', 'El reparto no existe', 404);
  if (!DISPATCH_STATUSES.includes(toStatus)) {
    throw new DispatchError('bad_status', `Estado inválido: ${toStatus}. Valores: ${DISPATCH_STATUSES.join(', ')}`);
  }
  if (dispatch.status === toStatus) {
    return { changed: false, dispatch, reason: 'already_in_status' };
  }
  const allowed = DISPATCH_TRANSITIONS[dispatch.status] || [];
  if (!allowed.includes(toStatus)) {
    throw new DispatchError(
      'invalid_transition',
      `No se puede pasar de ${dispatch.status} a ${toStatus}`,
      409,
      { from: dispatch.status, to: toStatus, allowed },
    );
  }

  const now = nowIso();
  const stampColumn = TIMESTAMP_COLUMN[toStatus];
  const sets = ['status = ?', 'updated_at = ?'];
  const params = [toStatus, now];
  if (stampColumn) {
    sets.push(`${stampColumn} = ?`);
    params.push(now);
  }
  if (toStatus === 'failed' && failureReason) {
    sets.push('failure_reason = ?');
    params.push(String(failureReason).slice(0, 400));
  }
  params.push(Number(dispatch.id));

  db.prepare(`UPDATE dispatches SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  logTransition({ dispatchId: dispatch.id, fromStatus: dispatch.status, toStatus, actor, note });

  const updated = getDispatch(dispatch.id);
  if (toStatus === 'delivered') {
    db.prepare("UPDATE orders SET status = 'delivered' WHERE id = ? AND status NOT IN ('delivered','cancelled')").run(
      dispatch.order_id,
    );
  }
  publish('dispatch.status', {
    dispatch_id: Number(dispatch.id),
    order_id: dispatch.order_id,
    courier_id: dispatch.courier_id,
    status: toStatus,
  });
  return { changed: true, dispatch: updated };
}
