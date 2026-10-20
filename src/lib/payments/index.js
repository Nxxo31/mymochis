// MyMochis · Payment orchestrator
// Spec: PROJECT.md §22.3, §22.4
import { randomUUID } from 'node:crypto';
import { db } from '../../db.js';
import { getAdapter } from './adapter.js';
import { lookupIdempotency, createIdempotencyRecord, completeIdempotency } from './idempotency.js';
import { enqueueOutbox } from './outbox.js';

const STATE = {
  INITIATED: 'INITIATED',
  PROCESSING: 'PROCESSING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  REQUIRES_ACTION: 'REQUIRES_ACTION',
  UNRESOLVED: 'UNRESOLVED',
  EXPIRED: 'EXPIRED',
};

const VALID_STATES = new Set(Object.values(STATE));

/**
 * Crea un payment intent con idempotency.
 * Devuelve { status, body, paymentId } donde status es uno de:
 *   201 (created), 200 (cached), 202 (in-progress), 409 (conflict)
 */
export async function createPaymentIntent({ idempotencyKey, request }) {
  const operation = 'create_payment';

  // 1. Idempotency lookup
  const look = lookupIdempotency({ operation, idempotencyKey, requestBody: request });
  if (look.state === 'mismatch') {
    return { status: 409, body: { error: 'idempotency_mismatch' } };
  }
  if (look.state === 'in_progress') {
    return { status: 202, body: { payment_id: look.paymentId, state: 'PROCESSING' }, paymentId: look.paymentId };
  }
  if (look.state === 'cached') {
    // Cached: HTTP convention is 200 (no new resource). If the original was
    // 201/202 we still return 200 to signal "this is a replay, not a create".
    return { status: 200, body: look.body, paymentId: look.paymentId, cached: true };
  }

  // 2. Validate request
  const v = validateCreateRequest(request);
  if (!v.ok) return { status: 400, body: { error: 'validation', details: v.errors } };

  // 3. Crear payment (state=INITIATED)
  const paymentId = `pay_${randomUUID()}`;
  const now = new Date().toISOString();
  const expiresAt = request.expires_at || new Date(Date.now() + 45 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO payments
      (payment_id, merchant_id, order_id, amount_minor, currency, state, state_version,
       provider, customer_phone, customer_email, description, metadata_json,
       created_at, updated_at, expires_at)
    VALUES (?, 'mymochis', ?, ?, ?, 'INITIATED', 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    paymentId,
    request.order_id,
    request.amount_minor,
    request.currency || 'COP',
    request.provider || null,
    request.customer_phone || null,
    request.customer_email || null,
    request.description || null,
    request.metadata ? JSON.stringify(request.metadata) : null,
    now, now, expiresAt,
  );

  // 4. Reservar idempotency record (race-safe: si falla, alguien ganó)
  const idem = createIdempotencyRecord({
    operation, idempotencyKey, requestBody: request, paymentId,
  });
  if (!idem.ok) {
    // Re-lookup and return cached/in-progress
    const look2 = lookupIdempotency({ operation, idempotencyKey, requestBody: request });
    if (look2.state === 'cached') {
      return { status: look2.status, body: look2.body, paymentId: look2.paymentId, cached: true };
    }
    return { status: 202, body: { payment_id: look2.paymentId, state: 'PROCESSING' }, paymentId: look2.paymentId };
  }

  // 5. Llamar provider adapter
  let attempt, responseBody, responseStatus = 201;
  try {
    const adapter = request.provider ? getAdapter(request.provider) : null;
    if (!adapter) {
      // No provider specified: error
      responseStatus = 400;
      responseBody = { error: 'provider_required', supported: supportedProviders() };
      transitionState(paymentId, 'INITIATED', 'FAILED', { reason: 'no_provider' });
    } else {
      const out = await adapter.createPaymentIntent({
        paymentId,
        amountMinor: request.amount_minor,
        currency: 'COP',
        description: request.description || '',
        customerPhone: request.customer_phone,
        customerEmail: request.customer_email,
        metadata: request.metadata,
        expiresAt,
      });
      const attemptId = `att_${randomUUID()}`;
      db.prepare(`
        INSERT INTO payment_attempts
          (attempt_id, payment_id, provider, provider_idempotency_key, provider_reference,
           attempt_state, provider_response_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        attemptId, paymentId, adapter.providerId, paymentId, out.providerReference,
        out.immediateState || 'PROCESSING', JSON.stringify(out.providerResponse || {}),
      );
      const nextState = out.immediateState || 'PROCESSING';
      transitionState(paymentId, 'INITIATED', nextState, { provider: adapter.providerId, ref: out.providerReference });

      // Update orders.payment_id + payment_state (denormalized for fast queries)
      updateOrderPaymentLink(request.order_id, paymentId, mapStateToPaymentStatus(nextState));

      // Outbox event
      enqueueOutbox({
        aggregateType: 'payment',
        aggregateId: paymentId,
        eventType: `payment.${nextState.toLowerCase()}`,
        payload: { payment_id: paymentId, order_id: request.order_id, state: nextState, provider: adapter.providerId, provider_reference: out.providerReference },
      });

      responseBody = {
        payment_id: paymentId,
        state: nextState,
        provider: adapter.providerId,
        provider_reference: out.providerReference,
        whatsapp: out.deepLink ? { deep_link: out.deepLink } : undefined,
        qr_code: out.qrCode,
        instructions: out.instructions,
        expires_at: expiresAt,
      };
    }
  } catch (e) {
    responseStatus = 502;
    responseBody = { error: 'provider_error', message: e.message };
    transitionState(paymentId, 'INITIATED', 'FAILED', { reason: 'provider_error', message: e.message });
  }

  completeIdempotency({ operation, idempotencyKey, responseStatus, responseBody, paymentId });
  return { status: responseStatus, body: responseBody, paymentId };
}

export function getPayment(paymentId) {
  const p = db.prepare(`SELECT * FROM payments WHERE payment_id = ?`).get(paymentId);
  if (!p) return null;
  const attempts = db.prepare(`SELECT * FROM payment_attempts WHERE payment_id = ? ORDER BY created_at ASC`).all(paymentId);
  const events = db.prepare(`SELECT * FROM provider_events WHERE JSON_EXTRACT(provider_event_id, '$') IS NOT NULL AND event_id IN (SELECT event_id FROM provider_events WHERE process_status = 'processed') ORDER BY received_at DESC LIMIT 20`).all();
  return { payment: p, attempts };
}

/** Transición de estado con optimistic lock */
export function transitionState(paymentId, expectedState, nextState, meta = {}) {
  if (!VALID_STATES.has(nextState)) {
    throw new Error(`Invalid next state: ${nextState}`);
  }
  const res = db.prepare(`
    UPDATE payments
    SET state = ?, state_version = state_version + 1, updated_at = datetime('now')
    WHERE payment_id = ? AND state = ?
  `).run(nextState, paymentId, expectedState);
  if (res.changes === 0) {
    return { ok: false, reason: 'state_changed_by_other' };
  }
  // Update denormalized order payment_state
  const orderId = db.prepare(`SELECT order_id FROM payments WHERE payment_id = ?`).get(paymentId)?.order_id;
  if (orderId) {
    updateOrderPaymentLink(orderId, paymentId, mapStateToPaymentStatus(nextState));
  }
  // Ledger entry: balanced double-entry
  if (nextState === 'SUCCEEDED') {
    postLedgerForSuccess(paymentId);
  }
  // Outbox
  enqueueOutbox({
    aggregateType: 'payment',
    aggregateId: paymentId,
    eventType: `payment.${nextState.toLowerCase()}`,
    payload: { payment_id: paymentId, order_id: orderId, state: nextState, ...meta },
  });
  return { ok: true };
}

function postLedgerForSuccess(paymentId) {
  const p = db.prepare(`SELECT * FROM payments WHERE payment_id = ?`).get(paymentId);
  if (!p) return;
  // Evitar doble post
  const existing = db.prepare(`SELECT COUNT(*) as n FROM ledger_entries WHERE payment_id = ?`).get(paymentId);
  if (existing.n > 0) return;

  const e1 = `led_${randomUUID()}`;
  const e2 = `led_${randomUUID()}`;
  const now = new Date().toISOString();
  // Convención: debit customer_cash, credit merchant_receivable (mismo monto, signos opuestos)
  db.prepare(`INSERT INTO ledger_entries (entry_id, payment_id, account, amount_minor, currency, memo, posted_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(e1, paymentId, 'customer_cash', p.amount_minor, p.currency, `payment ${paymentId} credit customer`);
  db.prepare(`INSERT INTO ledger_entries (entry_id, payment_id, account, amount_minor, currency, memo, posted_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(e2, paymentId, 'merchant_receivable', -p.amount_minor, p.currency, `payment ${paymentId} credit merchant`);
}

function updateOrderPaymentLink(orderId, paymentId, paymentState) {
  db.prepare(`UPDATE orders SET payment_id = ?, payment_state = ?, payment_status = ? WHERE id = ?`)
    .run(paymentId, paymentState, paymentState, orderId);
}

function mapStateToPaymentStatus(s) {
  if (s === 'SUCCEEDED') return 'paid';
  if (s === 'FAILED' || s === 'EXPIRED') return 'failed';
  if (s === 'REQUIRES_ACTION' || s === 'PROCESSING' || s === 'INITIATED') return 'pending';
  return 'pending';
}

function supportedProviders() {
  try {
    const { listAdapters } = require('./adapter.js');
    return listAdapters();
  } catch {
    return [];
  }
}

function validateCreateRequest(req) {
  const errors = [];
  if (!req || typeof req !== 'object') {
    return { ok: false, errors: ['body_required'] };
  }
  if (!req.order_id || typeof req.order_id !== 'string') errors.push('order_id required');
  if (typeof req.amount_minor !== 'number' || req.amount_minor <= 0 || !Number.isInteger(req.amount_minor)) {
    errors.push('amount_minor must be positive integer');
  }
  if (req.amount_minor > 5_000_000 * 100) errors.push('amount_minor exceeds per-payment cap (5M COP)');
  if (req.currency && req.currency !== 'COP') errors.push('only COP supported');
  if (req.provider && typeof req.provider !== 'string') errors.push('provider must be string');
  if (req.customer_phone && !/^\+?\d{8,15}$/.test(String(req.customer_phone).replace(/\s/g, ''))) {
    errors.push('customer_phone format');
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export { STATE };
