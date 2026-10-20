// MyMochis · Idempotency model
// Spec: PROJECT.md §22.6
// - UNIQUE por (merchant_id, operation, idempotency_key)
// - Request fingerprint (sha256) para detectar conflictos
// - 202 in-progress si el original está corriendo
// - Cachea response cuando completa

import { createHash, randomUUID } from 'node:crypto';
import { db } from '../../db.js';

const MERCHANT = 'mymochis';

function fingerprintOf(body) {
  return createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
}

/**
 * Busca un record existente. Devuelve:
 * - { state: 'new' } si no existe
 * - { state: 'mismatch' } si existe con fingerprint distinto
 * - { state: 'in_progress', paymentId } si existe sin completed_at
 * - { state: 'cached', status, body, paymentId } si está completo
 */
export function lookupIdempotency({ operation, idempotencyKey, requestBody }) {
  if (!idempotencyKey) return { state: 'new' };
  const fp = fingerprintOf(requestBody);
  const row = db.prepare(`
    SELECT * FROM idempotency_records
    WHERE merchant_id = ? AND operation = ? AND idempotency_key = ?
  `).get(MERCHANT, operation, idempotencyKey);

  if (!row) return { state: 'new', fingerprint: fp };
  if (row.request_fingerprint !== fp) return { state: 'mismatch' };
  if (!row.completed_at) return { state: 'in_progress', paymentId: row.payment_id };
  return {
    state: 'cached',
    status: row.response_status,
    body: row.response_body_json ? JSON.parse(row.response_body_json) : null,
    paymentId: row.payment_id,
  };
}

export function createIdempotencyRecord({ operation, idempotencyKey, requestBody, paymentId }) {
  const fp = fingerprintOf(requestBody);
  const id = `idem_${randomUUID()}`;
  try {
    db.prepare(`
      INSERT INTO idempotency_records
        (merchant_id, operation, idempotency_key, request_fingerprint, payment_id, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(MERCHANT, operation, idempotencyKey, fp, paymentId);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return { ok: false, reason: 'race' };
    }
    throw e;
  }
  return { ok: true, id };
}

export function completeIdempotency({ operation, idempotencyKey, responseStatus, responseBody, paymentId }) {
  db.prepare(`
    UPDATE idempotency_records
    SET completed_at = datetime('now'),
        response_status = ?,
        response_body_json = ?,
        payment_id = COALESCE(?, payment_id)
    WHERE merchant_id = ? AND operation = ? AND idempotency_key = ?
  `).run(
    responseStatus,
    JSON.stringify(responseBody || {}),
    paymentId || null,
    MERCHANT,
    operation,
    idempotencyKey,
  );
}
