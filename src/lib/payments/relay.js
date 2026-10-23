// MyMochis · Relay del outbox
// Spec: PROJECT.md §22.7, spec_id=25 (P0-1)
//
// Por que vive en lib/ y no se reinventa: la logica ya existia en
// worker/payments/outbox-relay.mjs, pero ese Worker es de Cloudflare y el
// deploy real es el server Express (PROJECT.md §5). El server registraba los
// consumers (server.js llama registerPaymentConsumers) y NUNCA drenaba el
// outbox: no habia ninguna llamada a fetchPendingOutbox ni dispatchOutboxEvent.
// Cada `payment.succeeded` se encolaba y se quedaba ahi para siempre, asi que el
// consumer nunca corria y el stock de un pedido pagado nunca se comprometia.
//
// At-least-once: cada consumer DEBE ser idempotente, porque un evento puede
// procesarse mas de una vez (relay que muere a mitad, replay, evento que
// dispatch-ea bien pero no se marco como publicado).

import { fetchPendingOutbox, markOutboxPublished, incrementOutboxAttempts, dispatchOutboxEvent } from './outbox.js';

const BATCH = 50;
const MAX_ATTEMPTS = 5;

let timer = null;
let running = false;

export function startOutboxRelay({ intervalMs = 30000, runAtBoot = true } = {}) {
  if (timer) return;
  timer = setInterval(() => { runOnce(); }, intervalMs);
  timer.unref?.();
  console.log(`[outbox-relay] started, interval=${intervalMs}ms`);
  if (runAtBoot) {
    setImmediate(() => { runOnce(); });
  }
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