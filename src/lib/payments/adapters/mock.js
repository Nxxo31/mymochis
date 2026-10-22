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

    // Estado real por referencia, en memoria. Es lo que hace que
    // getPaymentStatus() responda algo distinto de "siempre cobrado": sin esto
    // el reconciler promote cualquier pago simulado a SUCCEEDED.
    // En memoria a proposito: si el proceso se reinicia, se pierde y
    // getPaymentStatus devuelve UNRESOLVED, que es "no se" en vez de inventar.
    this._statuses = new Map();
  }

  /** @param {CreateInput} input */
  async createPaymentIntent(input) {
    const ref = `MOCK-${randomUUID().slice(0, 8).toUpperCase()}`;
    const isPhonePresent = !!input.customerPhone;
    // Un intent recien creado NUNCA esta cobrado. El unico camino a SUCCEEDED
    // es que el proveedor (aqui, el mock) confirme que el dinero entro.
    this._statuses.set(ref, 'PROCESSING');
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
    // Antes devolvia SIEMPRE 'SUCCEEDED', asi que el reconciler autopromovia
    // cualquier pago simulado a cobrado sin que nadie pagara nada:
    //   [reconciler] op pay_5c08...: PROCESSING -> SUCCEEDED
    // El reconciler pregunta al proveedor "como va este pago?" y un proveedor
    // que siempre responde "cobrado" no es un proveedor: es una mentira que
    // escribe en el ledger.
    //
    // Ahora refleja el estado REAL que el mock lleva en su propia memoria:
    // createPaymentIntent registra PROCESSING y approvePayment lo pasa a
    // SUCCEEDED. Si el proceso se reinicio, la memoria se perdio y no hay forma
    // de saber: se devuelve UNRESOLVED, que el reconciler trata como "no se"
    // en vez de inventar un resultado.
    const ref = String(providerRef);
    const st = this._statuses?.get(ref);
    if (!st) {
      return {
        providerReference: ref,
        state: 'UNRESOLVED',
        raw: { providerRef, mode: this.name, note: 'sin estado en memoria: no se puede afirmar nada' },
      };
    }
    return { providerReference: ref, state: st, raw: { providerRef, mode: this.name } };
  }

  /** @param {string} providerRef */
  /**
   * Confirma que el dinero entro. Es el unico camino a SUCCEEDED.
   *
   * Lo invoca el consumidor del webhook cuando el proveedor confirma el pago.
   * Sin este metodo el mock no tendria forma de pasar de PROCESSING a cobrado,
   * y getPaymentStatus se quedaria en PROCESSING para siempre.
   */
  async markPaid(providerRef) {
    const ref = String(providerRef);
    const prev = this._statuses.get(ref);
    if (prev && prev === 'SUCCEEDED') {
      return { providerReference: ref, state: 'SUCCEEDED', alreadyPaid: true };
    }
    this._statuses.set(ref, 'SUCCEEDED');
    return { providerReference: ref, state: 'SUCCEEDED', alreadyPaid: false };
  }

  /** Marca el pago como fallido/vencido (webhook de rechazo, expiracion). */
  async markFailed(providerRef, state = 'FAILED') {
    const ref = String(providerRef);
    this._statuses.set(ref, state);
    return { providerReference: ref, state };
  }

  async refund(providerRef, amountMinor) {
    const ref = String(providerRef);
    // Refund no resucita el pago: tras un refund el estado del pago sigue
    // siendo SUCCEEDED (el dinero SI entro y se devolvio). Marcarlo como otro
    // estado perderia el hecho de que hubo un cobro, que es justo lo que el
    // ledger tiene que seguir reflejando.
    this._statuses.set(ref, 'SUCCEEDED');
    return {
      providerRefundReference: `REFUND-${randomUUID().slice(0, 8).toUpperCase()}`,
      state: 'SUCCEEDED',
      providerReference: ref,
      amountMinor: amountMinor ?? null,
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
