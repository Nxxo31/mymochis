// MyMochis · Confirmación manual de pago (el caso real del negocio)
//
// POR QUÉ ESTO EXISTE
// El modelo de MyMochis es CONFIRMACION MANUAL: el cliente transfiere a la
// cuenta del negocio y el operador marca que llegó. Antes no había forma de
// cerrar ese ciclo por el backend — el admin solo podía poner
// orders.payment_status='paid' a mano, sin payment_id, sin ledger, sin
// evento de outbox, sin rastro de quién lo hizo.
//
// Qué aporta esto:
//  1. Crea un payment con provider='manual' (mismo flujo exacto que uno automático).
//  2. Valida que el monto coincida con orders.total (misma regla que POST /api/payments).
//  3. Requiere evidencia opcional (nota de referencia de la transferencia).
//  4. Pasa por transitionState → postea ledger + outbox + marca el pedido pagado.
//  5. Es idempotente por (order_id): dos clics no duplican el pago.
//
// No es un atajo: es el mismo state machine con un adapter distinto. Si el
// admin se equivoca al confirmar, el pago queda SUCCEEDED y para revertir hay
// que usar el flujo de reversa, no editar la fila.
import { randomUUID } from 'node:crypto';
import { db } from '../../db.js';
import { rememberOrderTotal, transitionState } from './index.js';
import { enqueueOutbox } from './outbox.js';

/** Errores de dominio, para que la ruta pueda mapearlos a HTTP. */
export class ManualPaymentError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details || null;
  }
}

/**
 * Confirma un pago recibido por canal manual.
 *
 * @param {{orderId: string, actor: string, reference?: string, note?: string, amount?: number}} input
 * @returns {{payment: object, already_confirmed: boolean}}
 */
export function confirmManualPayment({ orderId, actor, reference = null, note = null, amount = null }) {
  if (!orderId) throw new ManualPaymentError('order_id_required', 'Falta el pedido');

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(String(orderId));
  if (!order) throw new ManualPaymentError('order_not_found', `No existe el pedido ${orderId}`);

  // Idempotencia por pedido: si ya hay un pago confirmado, lo devolvemos tal cual.
  const existing = db.prepare(
    "SELECT * FROM payments WHERE order_id = ? AND state = 'SUCCEEDED' ORDER BY created_at DESC LIMIT 1"
  ).get(String(orderId));
  if (existing) {
    return { payment: existing, already_confirmed: true };
  }

  // El monto SIEMPRE sale de orders.total (pesos). El admin puede intentar
  // confirmar un pago parcial, pero no uno de un monto distinto al pedido:
  // si pagó menos, la diferencia se gestiona como nota, no como otro pago.
  const orderTotal = Number(order.total);
  if (amount != null && Number(amount) !== orderTotal) {
    throw new ManualPaymentError(
      'amount_mismatch',
      `El monto (${amount}) no coincide con el total del pedido (${orderTotal})`,
      { sent: Number(amount), expected: orderTotal },
    );
  }
  rememberOrderTotal(orderId, orderTotal);

  const paymentId = `pay_${randomUUID()}`;
  const now = new Date().toISOString();
  const providerRef = reference || `MAN-${randomUUID().slice(0, 8).toUpperCase()}`;

  db.prepare(`
    INSERT INTO payments
      (payment_id, merchant_id, order_id, amount_minor, currency, state, state_version,
       provider, customer_phone, customer_email, description, metadata_json,
       created_at, updated_at, expires_at)
    VALUES (?, 'mymochis', ?, ?, 'COP', 'INITIATED', 0,
            'manual', ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    paymentId, String(orderId), orderTotal,
    order.customer_phone || null, null,
    `Confirmación manual · pedido ${orderId}`,
    JSON.stringify({ actor, reference: providerRef, note: note || null }),
    now, now,
  );

  const attemptId = `att_${randomUUID()}`;
  db.prepare(`
    INSERT INTO payment_attempts
      (attempt_id, payment_id, provider, provider_idempotency_key, provider_reference,
       attempt_state, provider_response_json, created_at, updated_at)
    VALUES (?, ?, 'manual', ?, ?, 'SUCCEEDED', ?, datetime('now'), datetime('now'))
  `).run(
    attemptId, paymentId, paymentId, providerRef,
    JSON.stringify({ actor, note: note || null, confirmed_at: now }),
  );

  // Pasa por la state machine real: postea ledger, escribe outbox y marca
  // orders.payment_status='paid' via el consumer registrado en server.js.
  const out = transitionState(paymentId, 'INITIATED', 'SUCCEEDED', {
    provider: 'manual',
    actor,
    reference: providerRef,
  });
  if (!out.ok) {
    throw new ManualPaymentError('state_changed_by_other', 'El pago cambió de estado durante la confirmación');
  }

  // El consumer del outbox corre async; para que el pedido quede pagado de
  // inmediato al confirmar a mano, lo sincronizamos aquí también. Es
  // idempotente: postLedgerForSuccess y el UPDATE del pedido son no-ops si
  // el consumer ya pasó.
  applyManualPaymentToOrder(paymentId);

  const payment = db.prepare('SELECT * FROM payments WHERE payment_id = ?').get(paymentId);
  return { payment, already_confirmed: false };
}

/** Refleja el pago manual sobre el pedido (idempotente). */
function applyManualPaymentToOrder(paymentId) {
  const p = db.prepare('SELECT * FROM payments WHERE payment_id = ?').get(paymentId);
  if (!p) return;
  db.prepare(`
    UPDATE orders SET payment_id = ?, payment_state = 'SUCCEEDED', payment_status = 'paid'
    WHERE id = ?
  `).run(paymentId, p.order_id);
}

/**
 * Revierte un pago confirmado por error del operador.
 * NO borra el rastro: postea las entradas de ledger contrarias y deja el
 * payment en un estado terminal visible.
 */
export function revertManualPayment({ paymentId, actor, reason }) {
  const p = db.prepare('SELECT * FROM payments WHERE payment_id = ?').get(paymentId);
  if (!p) throw new ManualPaymentError('payment_not_found', `No existe el pago ${paymentId}`);
  if (p.provider !== 'manual') {
    throw new ManualPaymentError('not_manual', 'Solo se revierten pagos manuales aquí. Un pago de proveedor se revierte con el flujo del proveedor.');
  }
  if (p.state !== 'SUCCEEDED') {
    throw new ManualPaymentError('not_revertible', `El pago está en ${p.state}, no en SUCCEEDED`);
  }

  const posted = db.prepare('SELECT COUNT(*) AS n FROM ledger_entries WHERE payment_id = ?').get(paymentId).n;
  if (posted === 0) {
    throw new ManualPaymentError('no_ledger', 'Este pago no tiene entradas de ledger que revertir');
  }

  // Entradas contrarias: mismo patrón que postLedgerForSuccess pero al revés.
  const now = new Date().toISOString();
  const meta = { payment_id: paymentId, amount_minor: p.amount_minor };
  const mk = () => `led_${randomUUID()}`;
  const tx = db.prepare(`
    INSERT INTO ledger_entries (entry_id, payment_id, account, amount_minor, currency, memo, posted_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const memo = `REVERSA pago ${paymentId} por ${actor}: ${reason}`;
  tx.run(mk(), paymentId, 'customer_cash', -p.amount_minor, p.currency, memo);
  tx.run(mk(), paymentId, 'merchant_receivable', p.amount_minor, p.currency, memo);

  // Queda marcado como UNRESOLVED, no FAILED: fue un error operativo, no un rechazo.
  // OJO con el orden: transitionState escribe orders.payment_state via
  // updateOrderPaymentLink, asi que el UPDATE explicito de la reversa tiene que
  // ir DESPUES o lo pisa.
  transitionState(paymentId, 'SUCCEEDED', 'UNRESOLVED', { reason: 'reverted', actor, note: reason });

  // El pedido vuelve a pendiente (dominio pending|paid) y se desvincula del
  // pago revertido. payment_state queda 'REVERTED' como rastro visible.
  db.prepare(`
    UPDATE orders SET payment_id = NULL, payment_state = 'REVERTED', payment_status = 'pending'
    WHERE id = ?
  `).run(p.order_id);

  enqueueOutbox({
    aggregateType: 'payment',
    aggregateId: paymentId,
    eventType: 'payment.reverted',
    payload: { payment_id: paymentId, order_id: p.order_id, actor, reason },
  });

  return { ok: true, payment_id: paymentId, order_id: p.order_id, reverted_at: now };
}