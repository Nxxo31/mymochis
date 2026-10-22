// MyMochis · Mock provider adapter (para local dev / tests / sandbox Nequi sin creds)
// Spec: PROJECT.md §22 — funciona como "nequi" con respuestas deterministas.
import { randomUUID, createHmac, randomBytes } from 'node:crypto';

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
    // El default anterior era el string literal 'mock-secret', publicado en el
    // repo. Con el adapter registrado, ese string basta para firmar un "pago
    // aprobado" y que el sistema lo acepte (verificado 2026-10-21). Un default
    // inseguro que nunca falla es peor que ningun default.
    //
    // Ahora: sin secreto explicito genera uno aleatorio por proceso. El mock
    // sigue siendo utilizable en dev y en tests (quien manda el webhook
    // necesita conocer el secreto, y en dev se lee del log), pero deja de ser
    // adivinable. server.js además NO registra este adapter en produccion sin
    // PAYMENT_MOCK_WEBHOOK_SECRET.
    const explicit = opts.webhookSecret || process.env.PAYMENT_MOCK_WEBHOOK_SECRET;
    this.webhookSecret = explicit || randomBytes(32).toString('hex');
    if (!explicit) {
      console.warn(
        `[mock-adapter] sin PAYMENT_MOCK_WEBHOOK_SECRET: se genero un secreto aleatorio para esta instancia ` +
        `(${this.webhookSecret.slice(0, 8)}...). Los webhooks de test hay que firmarlos con el valor completo.`
      );
    }
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
