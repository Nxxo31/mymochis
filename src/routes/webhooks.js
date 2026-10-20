// MyMochis · Webhook handlers
// Spec: PROJECT.md §22.8, §22.9
// POST /api/webhooks/:provider — verify signature → durable inbox → ack
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { getAdapter } from '../lib/payments/adapter.js';

const router = Router();

router.post('/:provider', (req, res) => {
  const provider = req.params.provider;
  let adapter;
  try {
    adapter = getAdapter(provider);
  } catch (e) {
    return res.status(404).json({ error: 'unknown_provider' });
  }

  // rawBody viene del verify callback de express.json (server.js).
  // Si el content-type no es JSON, rawBody puede ser undefined — para esos
  // casos (firmas HMAC sobre bytes arbitrarios) usaríamos express.raw()
  // en una ruta dedicada. Por ahora asumimos JSON.
  const rawBody = req.rawBody;
  if (!rawBody) {
    return res.status(400).json({ error: 'no_raw_body' });
  }

  // 1. Verify signature
  if (!adapter.verifyWebhookSignature(rawBody, req.headers)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  // 2. Parse + extract event id
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'invalid_json' });
  }

  const eventIdHeader = adapter.webhookEventIdHeader;
  const providerEventId = (eventIdHeader && req.headers[eventIdHeader]) || payload.id || payload.event_id || null;
  if (!providerEventId) {
    return res.status(400).json({ error: 'missing_event_id' });
  }

  // 3. Durable inbox (dedupe via UNIQUE)
  const eventId = `evt_${randomUUID()}`;
  try {
    db.prepare(`
      INSERT INTO provider_events
        (event_id, provider, provider_event_id, payload_json, signature, received_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(eventId, provider, String(providerEventId), JSON.stringify(payload), String(req.headers[adapter.webhookSignatureHeader] || ''));
  } catch (e) {
    // node:sqlite lanza errores con code 'SQLITE_CONSTRAINT_UNIQUE' o errcode 2067
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.errcode === 2067 || /UNIQUE constraint failed/.test(String(e?.message || ''))) {
      return res.status(200).json({ ok: true, deduped: true });
    }
    console.error('[webhook] inbox insert failed', e);
    return res.status(500).json({ error: 'inbox_failed' });
  }

  // 4. Ack inmediato
  res.status(200).json({ ok: true, event_id: eventId });
});

export default router;
