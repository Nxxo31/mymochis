// MyMochis · Webhook event processor
// Spec: PROJECT.md §22.8
// Aplica eventos de provider a payments con state-version guard.
import { db } from '../src/db.js';
import { transitionState } from '../src/lib/payments/index.js';

const BATCH = 50;
const MAX_ATTEMPTS = 5;

let timer = null;
let running = false;

export function startEventProcessor(intervalMs = 10000) {
  if (timer) return;
  timer = setInterval(runOnce, intervalMs);
  console.log(`[event-processor] started, interval=${intervalMs}ms`);
}

export function stopEventProcessor() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function runOnce() {
  if (running) return;
  running = true;
  try {
    const events = db.prepare(`
      SELECT * FROM provider_events
      WHERE process_status = 'pending'
      ORDER BY received_at ASC
      LIMIT ?
    `).all(BATCH);

    for (const evt of events) {
      try {
        await applyEvent(evt);
        db.prepare(`UPDATE provider_events SET process_status = 'processed', processed_at = datetime('now'), process_attempts = process_attempts + 1 WHERE event_id = ?`)
          .run(evt.event_id);
      } catch (e) {
        const retriable = e.retriable !== false && (db.prepare(`SELECT process_attempts FROM provider_events WHERE event_id = ?`).get(evt.event_id)?.process_attempts || 0) < MAX_ATTEMPTS;
        db.prepare(`
          UPDATE provider_events
          SET process_status = ?, process_attempts = process_attempts + 1, last_error = ?
          WHERE event_id = ?
        `).run(retriable ? 'pending' : 'quarantined', String(e?.message || e).slice(0, 500), evt.event_id);
        console.error(`[event-processor] ${retriable ? 'retry' : 'quarantine'} ${evt.event_id}:`, e?.message || e);
      }
    }
  } catch (e) {
    console.error('[event-processor] error', e);
  } finally {
    running = false;
  }
}

async function applyEvent(evt) {
  const payload = JSON.parse(evt.payload_json);
  const providerRef = payload.transactionId || payload.paymentId || payload.reference || payload.provider_reference;
  if (!providerRef) {
    throw new Error('no provider reference in event');
  }

  // Buscar attempt por provider_reference
  const attempt = db.prepare(`SELECT * FROM payment_attempts WHERE provider_reference = ? AND provider = ? ORDER BY created_at DESC LIMIT 1`)
    .get(String(providerRef), evt.provider);
  if (!attempt) {
    throw new Error(`no attempt found for provider_ref=${providerRef}`);
  }

  // Mapear estado del provider → estado nuestro
  const state = mapProviderState(evt.provider, payload);
  if (!state) {
    throw new Error('cannot map provider state');
  }

  // Aplicar con guard de state_version
  const payment = db.prepare(`SELECT * FROM payments WHERE payment_id = ?`).get(attempt.payment_id);
  if (!payment) throw new Error('payment not found');

  // Permitir SUCCEEDED desde PROCESSING/REQUIRES_ACTION/UNRESOLVED/INITIATED
  if (state === payment.state) {
    return; // No-op idempotente
  }
  const ok = transitionState(payment.payment_id, payment.state, state, { provider_event_id: evt.provider_event_id, source: 'webhook' });
  if (!ok.ok) {
    throw new Error('state transition rejected (race)');
  }
}

function mapProviderState(provider, payload) {
  // Sub-adapters pueden sobreescribir. Por ahora mapeo genérico.
  if (payload.status) {
    const s = String(payload.status).toUpperCase();
    if (s.includes('SUCCESS') || s === 'APPROVED' || s === 'PAID' || s === '35') return 'SUCCEEDED';
    if (s.includes('FAIL') || s === 'REJECTED' || s === 'DECLINED') return 'FAILED';
    if (s.includes('PENDING') || s === '32' || s === 'PROCESSING') return 'PROCESSING';
    if (s.includes('EXPIRED') || s === 'CANCELLED' || s === 'CANCELED') return 'EXPIRED';
  }
  return null;
}

// Allow running standalone
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  startEventProcessor(3000);
}
