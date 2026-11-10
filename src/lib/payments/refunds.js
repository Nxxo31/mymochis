// MyMochis · Reembolsos (spec 58, p8)
// Spec: PROJECT.md §22 · dark-memory spec 58 (p8)
//
// Antes el unico refund era `revertManualPayment`, que solo aceptaba pagos
// con provider='manual' y hacia una reversa contable en el ledger. Un pago de
// proveedor (Nequi, Wompi) NO se podia devolver: el endpoint respondia
// "solo se revierten pagos manuales".
//
// Aqui:
//   - hay una tabla `refunds` con su PROPIA idempotencia (la misma
//     idempotency-key devuelve el mismo reembolso, no devuelve el dinero dos
//     veces),
//   - un pago de proveedor se devuelve llamando al adapter (que habla con el
//     proveedor de verdad) y solo se marca REFUNDED si el proveedor acepto,
//   - el manual sigue por su camino, pero tambien queda registrado.
import { randomUUID } from 'node:crypto';
import { db } from '../../db.js';
import { getAdapter } from './adapter.js';
import { transitionState } from './index.js';
import { revertManualPayment } from './manual.js';

export class RefundError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function insertRefund(row) {
  db.prepare(`
    INSERT INTO refunds
      (refund_id, payment_id, order_id, provider, provider_reference, provider_refund_reference,
       amount_minor, currency, reason, state, idempotency_key, requested_by, created_at, completed_at, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
  `).run(
    row.refund_id, row.payment_id, row.order_id, row.provider, row.provider_reference,
    row.provider_refund_reference, row.amount_minor, row.currency, row.reason, row.state,
    row.idempotency_key, row.requested_by, row.completed_at || null,
    row.details_json ? JSON.stringify(row.details_json) : null,
  );
}

/** Entradas de ledger contrarias a las del cobro (spec 58, p8). */
function postLedgerReversal(payment, memo) {
  const posted = db.prepare('SELECT COUNT(*) AS n FROM ledger_entries WHERE payment_id = ?').get(payment.payment_id).n;
  if (posted === 0) return { posted: 0 };
  const mk = () => `led_${randomUUID()}`;
  const tx = db.prepare(`
    INSERT INTO ledger_entries (entry_id, payment_id, account, amount_minor, currency, memo, posted_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  tx.run(mk(), payment.payment_id, 'customer_cash', -payment.amount_minor, payment.currency, memo);
  tx.run(mk(), payment.payment_id, 'merchant_receivable', payment.amount_minor, payment.currency, memo);
  return { posted: 2 };
}

/**
 * Devuelve un pago.
 * @param {{paymentId:string, reason:string, actor:string, idempotencyKey?:string|null}} args
 */
export async function requestRefund({ paymentId, reason, actor, idempotencyKey = null }) {
  const motivo = String(reason || '').trim();
  if (motivo.length < 5) {
    throw new RefundError('reason_required', 'El motivo del reembolso debe tener al menos 5 caracteres');
  }

  const p = db.prepare('SELECT * FROM payments WHERE payment_id = ?').get(String(paymentId));
  if (!p) throw new RefundError('payment_not_found', `No existe el pago ${paymentId}`);

  // 1. Idempotencia: la misma llave devuelve el MISMO reembolso.
  if (idempotencyKey) {
    const prev = db.prepare('SELECT * FROM refunds WHERE idempotency_key = ?').get(String(idempotencyKey));
    if (prev) return { ...prev, idempotent_replay: true };
  }
  if (p.state === 'REFUNDED') {
    const prev = db.prepare('SELECT * FROM refunds WHERE payment_id = ? ORDER BY created_at DESC LIMIT 1').get(p.payment_id);
    if (prev) return { ...prev, idempotent_replay: true };
    throw new RefundError('already_refunded', 'El pago ya fue reembolsado');
  }
  if (p.state !== 'SUCCEEDED') {
    throw new RefundError('not_refundable', `El pago está en ${p.state}, no se puede reembolsar`, 409);
  }

  const attempt = db.prepare(
    'SELECT provider_reference FROM payment_attempts WHERE payment_id = ? ORDER BY attempt_id DESC LIMIT 1'
  ).get(p.payment_id);

  // 2. Pago manual: la reversa contable de siempre, pero tambien queda fila.
  if (!p.provider || p.provider === 'manual' || !attempt?.provider_reference) {
    const out = revertManualPayment({ paymentId: p.payment_id, actor, reason: motivo });
    const refundId = `ref_${randomUUID()}`;
    insertRefund({
      refund_id: refundId,
      payment_id: p.payment_id,
      order_id: p.order_id,
      provider: p.provider || 'manual',
      provider_reference: attempt?.provider_reference || null,
      provider_refund_reference: null,
      amount_minor: p.amount_minor,
      currency: p.currency,
      reason: motivo,
      state: 'SUCCEEDED',
      idempotency_key: idempotencyKey ? String(idempotencyKey) : null,
      requested_by: actor,
      completed_at: new Date().toISOString(),
    });
    return { refund_id: refundId, payment_id: p.payment_id, order_id: p.order_id, state: 'SUCCEEDED', provider: 'manual', reverted: out };
  }

  // 3. Pago de proveedor: se le pide el reembolso AL proveedor. Si el
  // proveedor no acepta, el reembolso queda FAILED y el pago NO se toca: no
  // se marca devuelto un dinero que el proveedor no devolvio.
  let adapter = null;
  try {
    adapter = getAdapter(p.provider);
  } catch {
    throw new RefundError('provider_not_supported', `El proveedor ${p.provider} no tiene adapter registrado`);
  }

  const refundId = `ref_${randomUUID()}`;
  let result;
  try {
    // La llamada al proveedor es de red: va FUERA de la transaccion de
    // SQLite para no tener la DB bloqueada mientras el proveedor contesta.
    result = await adapter.refund(attempt.provider_reference, p.amount_minor);
  } catch (e) {
    insertRefund({
      refund_id: refundId,
      payment_id: p.payment_id,
      order_id: p.order_id,
      provider: p.provider,
      provider_reference: attempt.provider_reference,
      provider_refund_reference: null,
      amount_minor: p.amount_minor,
      currency: p.currency,
      reason: motivo,
      state: 'FAILED',
      idempotency_key: idempotencyKey ? String(idempotencyKey) : null,
      requested_by: actor,
      details_json: { error: String(e?.message || e).slice(0, 300) },
    });
    throw new RefundError('provider_error', `El proveedor no acepto el reembolso: ${String(e?.message || e).slice(0, 160)}`, 502);
  }

  const state = result?.state === 'SUCCEEDED' ? 'SUCCEEDED' : 'PROCESSING';
  insertRefund({
    refund_id: refundId,
    payment_id: p.payment_id,
    order_id: p.order_id,
    provider: p.provider,
    provider_reference: attempt.provider_reference,
    provider_refund_reference: result?.providerRefundReference || null,
    amount_minor: p.amount_minor,
    currency: p.currency,
    reason: motivo,
    state,
    idempotency_key: idempotencyKey ? String(idempotencyKey) : null,
    requested_by: actor,
    completed_at: state === 'SUCCEEDED' ? new Date().toISOString() : null,
  });

  if (state !== 'SUCCEEDED') {
    return { refund_id: refundId, payment_id: p.payment_id, order_id: p.order_id, state, provider: p.provider };
  }

  postLedgerReversal(p, `REVERSA pago ${p.payment_id} por ${actor}: ${motivo}`);
  transitionState(p.payment_id, 'SUCCEEDED', 'REFUNDED', { reason: 'refund', actor, note: motivo });
  db.prepare(`
    UPDATE orders SET payment_state = 'REFUNDED', payment_status = 'pending' WHERE id = ?
  `).run(p.order_id);

  return {
    refund_id: refundId,
    payment_id: p.payment_id,
    order_id: p.order_id,
    state,
    provider: p.provider,
    provider_refund_reference: result?.providerRefundReference || null,
  };
}

/** Lista los reembolsos (admin). */
export function listRefunds({ limit = 50 } = {}) {
  return db.prepare('SELECT * FROM refunds ORDER BY created_at DESC LIMIT ?').all(Math.min(Number(limit) || 50, 200));
}
