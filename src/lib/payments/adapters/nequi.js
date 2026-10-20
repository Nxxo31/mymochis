// MyMochis · Nequi adapter (push payment API)
// Spec: PROJECT.md §22.12
// En sandbox/cred-missing cae a modo mock con providerReference identificable.
import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { MockAdapter } from './mock.js';

/** @typedef {import('../adapter.js').PaymentAdapter} PaymentAdapter */
/** @typedef {import('../adapter.js').CreateInput} CreateInput */
/** @typedef {import('../adapter.js').CreateOutput} CreateOutput */
/** @typedef {import('../adapter.js').ProviderStatus} ProviderStatus */

const NEQUI_BASE = process.env.NEQUI_API_BASE || 'https://api.nequi.com';
const NEQUI_API_KEY = process.env.NEQUI_API_KEY || '';
const NEQUI_WEBHOOK_SECRET = process.env.NEQUI_WEBHOOK_SECRET || '';

/** @implements {PaymentAdapter} */
export class NequiAdapter {
  providerId = 'nequi';
  webhookEventIdHeader = 'x-nequi-event-id';
  webhookSignatureHeader = 'x-nequi-signature';

  /** Si no hay creds, cae a un mock que firma con Nequi (para dev) */
  constructor() {
    this.real = !!NEQUI_API_KEY;
    this.fallback = new MockAdapter({ name: 'nequi-fallback', webhookSecret: NEQUI_WEBHOOK_SECRET || 'nequi-dev' });
  }

  /** @param {CreateInput} input */
  async createPaymentIntent(input) {
    if (!this.real) {
      // Dev/fallback: delega al mock con el naming de Nequi
      const out = await this.fallback.createPaymentIntent(input);
      return { ...out, providerReference: `NEQ-FB-${out.providerReference}` };
    }

    if (!input.customerPhone) {
      throw new Error('Nequi requires customerPhone');
    }

    const body = {
      phoneNumber: input.customerPhone,
      value: input.amountMinor / 100,         // Nequi espera pesos, NO centavos
      reference1: input.paymentId,
      reference2: (input.description || '').slice(0, 40),
    };

    const res = await fetch(`${NEQUI_BASE}/payments/v2/-services-paymentservice-generatecodeqr`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': NEQUI_API_KEY,
        'X-Request-Id': input.paymentId, // provider idempotency-key
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Nequi API error ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return {
      providerReference: data.transactionId || data.paymentId || `NEQ-${randomUUID().slice(0, 8)}`,
      providerResponse: data,
      immediateState: 'REQUIRES_ACTION',
      deepLink: data.deepLink || `nequi://payment?token=${data.paymentId}`,
      qrCode: data.qrImage,
      instructions: 'Abrí tu app Nequi y aprobá el pago.',
    };
  }

  /** @param {string} providerRef */
  async getPaymentStatus(providerRef) {
    if (!this.real) {
      const st = await this.fallback.getPaymentStatus(providerRef);
      return { ...st, providerReference: providerRef };
    }
    const res = await fetch(`${NEQUI_BASE}/payments/v2/-services-paymentservice-getstatus?code=${encodeURIComponent(providerRef)}`, {
      headers: { 'X-Api-Key': NEQUI_API_KEY },
    });
    if (!res.ok) throw new Error(`Nequi status ${res.status}`);
    const data = await res.json();
    return {
      providerReference: providerRef,
      state: mapNequiState(data.status),
      raw: data,
    };
  }

  /** @param {string} providerRef @param {number} amountMinor */
  async refund(providerRef, amountMinor) {
    if (!this.real) {
      const r = await this.fallback.refund(providerRef, amountMinor);
      return r;
    }
    // Nequi no expone refund unificado en push; depende de contrato.
    // Implementar cuando el operador confirme el endpoint específico.
    throw new Error('Nequi refund: implementar contra endpoint del contrato (no documentado públicamente)');
  }

  /** @param {Buffer} rawBody @param {Record<string,any>} headers */
  verifyWebhookSignature(rawBody, headers) {
    const sig = headers[this.webhookSignatureHeader];
    if (!sig || typeof sig !== 'string' || !NEQUI_WEBHOOK_SECRET) return false;
    const expected = createHmac('sha256', NEQUI_WEBHOOK_SECRET).update(rawBody).digest('hex');
    return sig === expected;
  }
}

function mapNequiState(s) {
  if (!s) return 'UNRESOLVED';
  const k = String(s).toUpperCase();
  if (k.includes('SUCCESS') || k === '35' || k === 'APPROVED') return 'SUCCEEDED';
  if (k.includes('FAIL') || k === 'REJECTED') return 'FAILED';
  if (k.includes('PENDING') || k === '32') return 'PROCESSING';
  if (k.includes('EXPIRED')) return 'EXPIRED';
  return 'UNRESOLVED';
}
