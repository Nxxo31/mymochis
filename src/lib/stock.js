// MyMochis · Reservas de stock por pedido
// Vive en lib/ y no en routes/orders.js porque lo necesitan dos:call sites.
// El consumer de `payment.succeeded` (src/lib/payments/consumers.js) tiene que
// comprometer la reserva cuando el pago se verifica por webhook, y un import
// desde lib hacia routes cerraría un ciclo (orders.js -> lib/payments/manual.js
// -> lib/payments/index.js) y arrastraría el router entero al Worker.

import { db } from '../db.js';

/** JSON.parse que no revienta la transaccion si la columna esta corrupta. */
export function safeParse(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

/**
 * Convierte la RESERVA de un pedido en VENTA.
 *
 * Se llama cuando el pago queda confirmado. Ese es el unico momento en que las
 * unidades pasan de `reserved` a `sold`: antes de confirmar no sabemos si el
 * cliente va a pagar, y despues ya no hay duda.
 *
 * Idempotente por diseno: si el pedido no tiene reserva (p.ej. uno antiguo,
 * creado antes de este modelo), no toca nada en vez de descontar stock que
 * nunca se reservo.
 */
export function commitReservedStock(orderRow) {
  const result = { flavors: 0, combos: 0 };
  if (!orderRow) return result;
  if (orderRow.release_window_id == null) return result;

  const flavors = safeParse(orderRow.items_json, {});
  const commitItem = db.prepare(`
    UPDATE release_items
    SET units_reserved = MAX(0, units_reserved - ?), units_sold = units_sold + ?
    WHERE window_id = ? AND flavor_id = ? AND units_reserved >= ?
  `);
  for (const [flavorId, qtyRaw] of Object.entries(flavors || {})) {
    const qty = Number(qtyRaw);
    if (!(qty > 0)) continue;
    const r = commitItem.run(qty, qty, orderRow.release_window_id, String(flavorId), qty);
    if (r.changes === 1) result.flavors += qty;
  }

  const commitCombo = db.prepare(`
    UPDATE combos
    SET units_reserved = MAX(0, units_reserved - ?), units_sold = units_sold + ?
    WHERE id = ? AND units_reserved >= ?
  `);
  for (const c of (safeParse(orderRow.combos_json, []) || [])) {
    const qty = Number(c?.qty ?? c?.units ?? 0);
    const comboId = Number(c?.id ?? c?.combo_id);
    if (!(qty > 0) || !comboId) continue;
    const r = commitCombo.run(qty, qty, comboId, qty);
    if (r.changes === 1) result.combos += qty;
  }
  return result;
}

/**
 * LIBERA la reserva de un pedido que se borra o cancela sin haberse pagado.
 *
 * Con el modelo de reserva, cancelar NO devuelve unidades: libera unidades
 * que nunca se vendieron. Solo el camino reservado→vendido mueve `units_sold`.
 *
 * Es idempotente por construccion: cada sentencia lleva `units_reserved >= ?`,
 * asi que liberar dos veces no puede sobre-devolver. Y si el pedido ya estaba
 * pagado (units_reserved = 0 porque ya se convirtio en venta), no toca
 * `units_sold`: esa unidad ya se vendio de verdad.
 *
 * Esto reemplaza la logica previa que sumaba/resta `units_sold`, que era
 * correcta con dos contadores y equivocada con tres.
 */
export function releaseReservedStock(orderRow) {
  const result = { flavors: 0, combos: 0 };
  if (!orderRow) return result;
  if (orderRow.release_window_id == null && !orderRow.items_json) return result;

  const flavors = safeParse(orderRow.items_json, {});
  const releaseItem = orderRow.release_window_id != null
    ? db.prepare(`
        UPDATE release_items
        SET units_reserved = MAX(0, units_reserved - ?)
        WHERE window_id = ? AND flavor_id = ? AND units_reserved >= ?
      `)
    : null;

  for (const [flavorId, qtyRaw] of Object.entries(flavors || {})) {
    const qty = Number(qtyRaw);
    if (!(qty > 0) || !releaseItem || orderRow.release_window_id == null) continue;
    const r = releaseItem.run(qty, orderRow.release_window_id, String(flavorId), qty);
    if (r.changes === 1) result.flavors += qty;
  }

  const releaseCombo = db.prepare(`
    UPDATE combos
    SET units_reserved = MAX(0, units_reserved - ?)
    WHERE id = ? AND units_reserved >= ?
  `);
  for (const c of (safeParse(orderRow.combos_json, []) || [])) {
    const qty = Number(c?.qty ?? c?.units ?? 0);
    const comboId = Number(c?.id ?? c?.combo_id);
    if (!(qty > 0) || !comboId) continue;
    const r = releaseCombo.run(qty, comboId, qty);
    if (r.changes === 1) result.combos += qty;
  }
  return result;
}