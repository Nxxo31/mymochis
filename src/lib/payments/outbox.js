// MyMochis · Transactional outbox
// Spec: PROJECT.md §22.7
// El relay publica eventos a los consumers; cada consumer debe ser idempotente.

import { randomUUID } from 'node:crypto';
import { db } from '../../db.js';

export function enqueueOutbox({ aggregateType, aggregateId, eventType, payload }) {
  const eventId = `out_${randomUUID()}`;
  db.prepare(`
    INSERT INTO outbox_events
      (event_id, aggregate_type, aggregate_id, event_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(eventId, aggregateType, aggregateId, eventType, JSON.stringify(payload || {}));
  return eventId;
}

/** Lee hasta N eventos pendientes, oldest-first. */
export function fetchPendingOutbox(limit = 50) {
  return db.prepare(`
    SELECT * FROM outbox_events
    WHERE published_at IS NULL
    ORDER BY created_at ASC
    LIMIT ?
  `).all(limit);
}

export function markOutboxPublished(eventId) {
  db.prepare(`
    UPDATE outbox_events
    SET published_at = datetime('now'),
        publish_attempts = publish_attempts + 1
    WHERE event_id = ?
  `).run(eventId);
}

export function incrementOutboxAttempts(eventId) {
  db.prepare(`
    UPDATE outbox_events
    SET publish_attempts = publish_attempts + 1
    WHERE event_id = ?
  `).run(eventId);
}

/** Consumer handlers registrados in-process. Map<eventType, async fn(evt)>. */
const consumers = new Map();

export function registerConsumer(eventType, handler) {
  consumers.set(eventType, handler);
}

/** Procesa un evento a través del consumer. Devuelve true si OK, false si error retriable. */
export async function dispatchOutboxEvent(evt) {
  const handler = consumers.get(evt.event_type);
  if (!handler) {
    // No consumer registrado = auto-mark como publicado (evento ignorado)
    return true;
  }
  try {
    await handler(JSON.parse(evt.payload_json));
    return true;
  } catch (e) {
    console.error('[outbox] consumer failed', evt.event_type, e?.message || e);
    return false;
  }
}
