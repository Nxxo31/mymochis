// MyMochis · Outbox relay
// Spec: PROJECT.md §22.7
// Lee eventos pending, los dispatch-ea, marca como published.
// At-least-once: el consumer DEBE ser idempotente.
import { db } from '../../src/db.js';
import { fetchPendingOutbox, markOutboxPublished, incrementOutboxAttempts, dispatchOutboxEvent } from '../../src/lib/payments/outbox.js';

const BATCH = 50;
const MAX_ATTEMPTS = 5;

let timer = null;
let running = false;

export function startOutboxRelay(intervalMs = 30000) {
  if (timer) return;
  timer = setInterval(runOnce, intervalMs);
  console.log(`[outbox-relay] started, interval=${intervalMs}ms`);
}

export function stopOutboxRelay() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function runOnce() {
  if (running) return;
  running = true;
  try {
    const events = fetchPendingOutbox(BATCH);
    for (const evt of events) {
      if (evt.publish_attempts >= MAX_ATTEMPTS) {
        // Dead-letter: marcar como published (consumidor perdido) + log
        console.error('[outbox-relay] dead-letter', evt.event_id, evt.event_type);
        markOutboxPublished(evt.event_id);
        continue;
      }
      const ok = await dispatchOutboxEvent(evt);
      if (ok) {
        markOutboxPublished(evt.event_id);
      } else {
        incrementOutboxAttempts(evt.event_id);
      }
    }
  } catch (e) {
    console.error('[outbox-relay] error', e);
  } finally {
    running = false;
  }
}

// Allow running standalone: `node worker/payments/outbox-relay.mjs`
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  startOutboxRelay(5000);
}
