// MyMochis · Webhook handlers
// Spec: PROJECT.md §22.8, §22.9 · dark-memory spec 58 (p5)
//
// POST /api/webhooks/:provider — verifica la firma → inbox durable →
// aplica el evento → ack.
//
// P0 (spec 58, p5). Antes este endpoint guardaba el evento y devolvia 200:
//   1. NO validaba el monto. Un evento firmado con un monto menor marcaba el
//      pedido como pagado por el total.
//   2. NO cruzaba el provider_reference con payment_attempts: el evento
//      solo se asociaba al pago si el payload traia el payment_id, y los
//      providers reales lo mandan con otro nombre (reference1, data.reference).
//   3. La transicion de estado solo se aplicaba si el adapter tenia
//      markPaid, y solo el mock lo tenia: con Nequi o Wompi el webhook NUNCA
//      movia el pago a SUCCEEDED.
//   4. Sin anti-replay: un evento viejo reenviado se aceptaba cada vez.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { transitionState } from '../lib/payments/index.js';
import { getAdapter } from '../lib/payments/adapter.js';

const router = Router();

// Un evento mas viejo que esto se considera un reenvio (replay). El dedupe
// por provider_event_id ya evita repetir el MISMO evento; esto corta el
// reenvio de un evento viejo con un id nuevo.
const MAX_EVENT_AGE_MS = 5 * 60 * 1000;

/** Extrae del payload los campos que dependen de la forma de cada provider. */
function extractEvent(payload, headers) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};

  // El tipo del evento: 'transaction.approved' (Wompi), 'succeeded'
  // (mock), 'payment.succeeded' (generico).
  const eventType = String(
    payload?.type || payload?.event || payload?.event_type || data?.status || ''
  ).toLowerCase();

  // Nuestro payment_id. Cada provider lo manda con un nombre distinto:
  // mock/generico -> payment_id, Wompi -> data.reference (nosotros lo
  // ponemos como reference al crear la transaccion), Nequi -> reference1.
  const paymentId =
    payload?.payment_id || payload?.paymentId || data?.payment_id ||
    data?.reference || payload?.reference1 || null;

  // La referencia del provider (su id de transaccion).
  const providerRef =
    payload?.provider_reference || payload?.providerReference || payload?.transactionId ||
    data?.id || payload?.id || null;

  const amount = payload?.amount ?? data?.amount ?? null;
  const currency = payload?.currency ?? data?.currency ?? null;

  const timestamp = headers['x-timestamp'] || payload?.created_at || data?.created_at ||
    payload?.event_date || data?.sent_at || null;

  return { eventType, paymentId, providerRef, amount, currency, timestamp };
}

/** Convierte el timestamp del provider a milisegundos, o null si no se puede. */
function parseTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value);
    // 10 digitos = segundos; 13 = milisegundos.
    return String(value).length <= 10 ? n * 1000 : n;
  }
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

router.post('/:provider', (req, res) => {
  // Un webhook raro (un payload que rompa una consulta) NO puede tumbar el
  // server: en Node una promesa rechazada sin capturar mata el proceso.
  handleWebhook(req, res).catch((e) => {
    console.error('[webhook] error no controlado', req.params.provider, e);
    if (!res.headersSent) res.status(500).json({ error: 'webhook_failed' });
  });
});

async function handleWebhook(req, res) {
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

  const ev = extractEvent(payload, req.headers);

  // 3. Anti-replay: un evento con fecha vieja (mas de 5 min) se rechaza.
  // El dedupe por provider_event_id evita repetir el mismo evento; esto corta
  // el reenvio de un evento viejo con un id nuevo.
  const ts = parseTimestamp(ev.timestamp);
  if (ts != null && Date.now() - ts > MAX_EVENT_AGE_MS) {
    return res.status(401).json({ error: 'stale_event' });
  }

  // 4. Durable inbox (dedupe via UNIQUE)
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

  // 5. Localizar el pago: por payment_id o cruzando el provider_reference con
  // payment_attempts (que es donde queda la referencia que nos dio el
  // provider al crear el pago).
  let payment = null;
  if (ev.paymentId) {
    payment = db.prepare('SELECT * FROM payments WHERE payment_id = ?').get(String(ev.paymentId));
  }
  if (!payment && ev.providerRef) {
    const attempt = db.prepare(
      'SELECT payment_id FROM payment_attempts WHERE provider = ? AND provider_reference = ? ORDER BY attempt_id DESC LIMIT 1'
    ).get(provider, String(ev.providerRef));
    if (attempt) {
      payment = db.prepare('SELECT * FROM payments WHERE payment_id = ?').get(attempt.payment_id);
    }
  }

  // 6. Validar monto y moneda contra lo que el servidor cobro. Si no
  // coinciden, el evento se pone en cuarentena y NO se aplica: un evento
  // firmado con un monto menor no puede marcar un pedido como pagado.
  if (payment) {
    db.prepare('UPDATE provider_events SET payment_id = ? WHERE event_id = ?').run(String(payment.payment_id), eventId);
    const problems = [];
    if (ev.amount != null) {
      const amount = Number(ev.amount);
      if (!Number.isFinite(amount) || amount !== Number(payment.amount_minor)) {
        problems.push('amount_mismatch');
      }
    }
    if (ev.currency != null && String(ev.currency).toUpperCase() !== String(payment.currency || '').toUpperCase()) {
      problems.push('currency_mismatch');
    }
    if (problems.length) {
      db.prepare(
        "UPDATE provider_events SET process_status = 'quarantined', last_error = ? WHERE event_id = ?"
      ).run(problems.join(','), eventId);
      console.error('[webhook] evento en cuarentena', eventId, problems.join(','), {
        payment_id: payment.payment_id,
        esperado: payment.amount_minor,
        recibido: ev.amount,
      });
      return res.status(200).json({ ok: true, quarantined: true, reasons: problems });
    }
  }

  // 7. Aplicar el evento al pago.
  //
  // La transicion NO depende de que el adapter tenga markPaid: el que sabe
  // que el evento es un cobro es el TIPO del evento. Antes solo el mock
  // (el unico con markPaid) movia el estado, asi que con un provider real el
  // webhook nunca cobraba y solo el reconciler lo accomplishes.
  let applied = null;
  if (payment) {
    const from = payment.state;
    if (/approved|succeeded|success|paid|confirmed|complet/.test(ev.eventType)) {
      applied = transitionState(String(payment.payment_id), from, 'SUCCEEDED', { source: 'webhook', event: ev.eventType });
    } else if (/rejected|failed|declin|cancel|expired/.test(ev.eventType)) {
      applied = transitionState(String(payment.payment_id), from, 'FAILED', { source: 'webhook', event: ev.eventType });
    }
    if (applied) {
      db.prepare("UPDATE provider_events SET process_status = 'processed', processed_at = datetime('now') WHERE event_id = ?").run(eventId);
    }
  }

  // 8. Ack inmediato. Un evento duplicado o ya aplicado responde 200 igual: el
  // proveedor debe poder reintentar sin romper. La diferencia va en el body.
  res.status(200).json({
    ok: true,
    event_id: eventId,
    applied: applied ? (applied.ok ? applied.next_state || 'SUCCEEDED' : `rechazado:${applied.reason}`) : 'no_op',
  });
}

export default router;
