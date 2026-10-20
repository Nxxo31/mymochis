// MyMochis · Mock provider adapter (para local dev / tests / sandbox Nequi sin creds)
// Spec: PROJECT.md §22 — funciona como "nequi" con respuestas deterministas.
import { randomUUID, createHmac } from 'node:crypto';

/**
 * @typedef {import('../adapter.js').PaymentAdapter} PaymentAdapter
 * @typedef {import('../adapter.js').CreateInput} CreateInput
 * @typedef {import('../adapter.js').CreateOutput} CreateOutput
 * @typedef {import('../adapter.js').ProviderStatus} ProviderStatus
 */

/** @implements {PaymentAdapter} */
export class MockAdapter {
  providerId = 'mock';
  webhookEventIdHeader = 'x-mock-event-id';
  webhookSignatureHeader = 'x-mock-signature';
  webhookSecret;

  /** @param {{ webhookSecret?: string, name?: string }} [opts] */
  constructor(opts = {}) {
    this.webhookSecret = opts.webhookSecret || process.env.PAYMENT_MOCK_WEBHOOK_SECRET || 'mock-secret';
    this.name = opts.name || 'mock';
  }

  /** @param {CreateInput} input */
  async createPaymentIntent(input) {
    const ref = `MOCK-${randomUUID().slice(0, 8).toUpperCase()}`;
    const isPhonePresent = !!input.customerPhone;
    return {
      providerReference: ref,
      providerResponse: { ref, input, mode: this.name, createdAt: new Date().toISOString() },
      immediateState: isPhonePresent ? 'REQUIRES_ACTION' : 'PROCESSING',
      deepLink: isPhonePresent ? `mock://pay?ref=${ref}` : undefined,
      qrCode: isPhonePresent ? undefined : 'data:image/png;base64,iVBORw0KGgo=',
      instructions: isPhonePresent
        ? 'Aprobá el pago en tu app.'
        : 'Escaneá el QR para pagar.',
    };
  }

  /** @param {string} providerRef */
  async getPaymentStatus(providerRef) {
    return {
      providerReference: providerRef,
      state: 'SUCCEEDED',
      raw: { providerRef, mode: this.name },
    };
  }

  /** @param {string} providerRef */
  async refund(providerRef, amountMinor) {
    return {
      providerRefundReference: `REFUND-${randomUUID().slice(0, 8).toUpperCase()}`,
      state: 'SUCCEEDED',
    };
  }

  /** Firma determinista para que el webhook se pueda verificar en tests. */
  signBody(body) {
    return createHmac('sha256', this.webhookSecret).update(body).digest('hex');
  }

  /** @param {Buffer} rawBody @param {Record<string,any>} headers */
  verifyWebhookSignature(rawBody, headers) {
    const sig = headers[this.webhookSignatureHeader];
    if (!sig || typeof sig !== 'string') return false;
    const expected = this.signBody(rawBody);
    return safeEqual(sig, expected);
  }
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
