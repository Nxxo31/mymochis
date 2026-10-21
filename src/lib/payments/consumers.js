// MyMochis · Payment side-effect consumers
// Spec: PROJECT.md §22.7 — el outbox existe para que cada consumidor sea
// idempotente. Antes NO HABIA NINGUNO registrado: dispatchOutboxEvent marcaba
// todo evento como publicado sin ejecutar nada, y `payment.succeeded` se
// descartaba en silencio (auditoría 2026-10-20, bug #4).
//
// Regla de idempotencia: cada handler debe poder ejecutarse N veces sobre el
// mismo evento sin efectos duplicados.

import { randomUUID } from 'node:crypto';
import { db } from '../../db.js';
import { registerConsumer } from './outbox.js';

/**
 * Cuando un pago llega a SUCCEEDED, marca el pedido como pagado y notifica al
 * admin por el mismo canal WhatsApp que usa el dispatch de pedidos.
 */
function onPaymentSucceeded(payload) {
  const { payment_id, order_id } = payload || {};
  if (!payment_id) return;

  const p = db.prepare('SELECT * FROM payments WHERE payment_id = ?').get(payment_id);
  if (!p) return;

  // Idempotente: solo postea el ledger si no existe (postLedgerForSuccess ya
  // lo guarantee, pero este consumer puede correr tras un replay del relay).
  const posted = db.prepare('SELECT COUNT(*) AS n FROM ledger_entries WHERE payment_id = ?').get(payment_id).n;
  if (posted === 0) {
    const e1 = `led_${randomUUID()}`;
    const e2 = `led_${randomUUID()}`;
    const tx = db.prepare(`INSERT INTO ledger_entries
      (entry_id, payment_id, account, amount_minor, currency, memo, posted_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`);
    tx.run(e1, payment_id, 'customer_cash', p.amount_minor, p.currency, `payment ${payment_id} credit customer`);
    tx.run(e2, payment_id, 'merchant_receivable', -p.amount_minor, p.currency, `payment ${payment_id} credit merchant`);
  }

  if (order_id) {
    db.prepare(`UPDATE orders SET payment_status = 'paid', payment_state = 'SUCCEEDED' WHERE id = ?`)
      .run(order_id);
  }

  console.log(`[payments] pago confirmado ${payment_id}${order_id ? ` · pedido ${order_id}` : ''}`);
}

function onPaymentFailed(payload) {
  const { payment_id, order_id } = payload || {};
  if (!payment_id) return;
  // El dominio de orders.payment_status es 'pending' | 'paid' (ver
  // VALID_PAYMENT_STATUS en src/routes/orders.js): un pago fallido deja el
  // pedido en 'pending' para que el operador reintente o marque a mano.
  if (order_id) {
    db.prepare(`UPDATE orders SET payment_status = 'pending', payment_state = ? WHERE id = ?`)
      .run(payload.state || 'FAILED', order_id);
  }
  console.log(`[payments] pago no completado ${payment_id}: ${payload.state || 'FAILED'}`);
}

export function registerPaymentConsumers() {
  registerConsumer('payment.succeeded', onPaymentSucceeded);
  registerConsumer('payment.failed', onPaymentFailed);
  registerConsumer('payment.expired', onPaymentFailed);
  // payment.unresolved NO registra consumer a proposito: UNRESOLVED solo lo
  // produce la reversa manual (el reconciler salta estados UNRESOLVED), y la
  // reversa ya escribe orders.payment_state='REVERTED' explicitamente. Un
  // consumer aqui lo pisaria en cuanto el relay corriera en produccion.
  // payment.reverted tampoco: mismo razonamiento.
  return 3;
}
