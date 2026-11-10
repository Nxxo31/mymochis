// MyMochis · Wompi adapter (D21: una sola pasarela para Colombia)
// Spec: PROJECT.md §34 (D21) · dark-memory spec 58 (p2)
//
// D21 (decision del operador): Wompi cubre PSE, Nequi, Daviplata,
// Bancolombia, link de pago por WSP y tarjetas con UNA sola integracion, en
// vez de 4 APIs y 4 credenciales. Este adapter es el primero de los dos
// providers reales del proyecto (el otro es Nequi).
//
// FAIL-CLOSED: sin llaves publicas/secretas NO hay fallback silencioso a un
// mock (el mismo bug que se corrigio en Nequi: un despliegue sin credenciales
// cobra pedidos sin mover un peso). Para probar contra el mock esta el opt-in
// explicito NEXOMOCHIS_ALLOW_PROVIDER_FALLBACK=1.
import { randomUUID } from 'node:crypto';
import { createHmac, createHash } from 'node:crypto';
import { MockAdapter } from './mock.js';
import { useCredential } from '../../vault.js';

/** @typedef {import('../adapter.js').PaymentAdapter} PaymentAdapter */
/** @typedef {import('../adapter.js').CreateInput} CreateInput */
/** @typedef {import('../adapter.js').CreateOutput} CreateOutput */
/** @typedef {import('../adapter.js').ProviderStatus} ProviderStatus */

const WOMPI_BASE = process.env.WOMPI_API_BASE || 'https://api.wompi.co';
const WOMPI_CHECKOUT_BASE = process.env.WOMPI_CHECKOUT_BASE || 'https://checkout.wompi.co/l';

// Lectura LAZY: este modulo se importa en el boot y la DB puede no estar
// inicializada todavia. El vault gana sobre el env (lo que el admin guarda
// desde el dashboard manda).
let _publicKey = null;
let _secretKey = null;
let _webhookSecret = null;

function publicKey() {
  if (_publicKey === null) {
    _publicKey = useCredential('wompi', 'public_key', 'llave publica de Wompi')
             || process.env.WOMPI_PUBLIC_KEY || '';
  }
  return _publicKey;
}

function secretKey() {
  if (_secretKey === null) {
    _secretKey = useCredential('wompi', 'secret_key', 'llave secreta de Wompi')
             || process.env.WOMPI_SECRET_KEY || '';
  }
  return _secretKey;
}

function webhookSecret() {
  if (_webhookSecret === null) {
    _webhookSecret = useCredential('wompi', 'webhook_secret', 'verificar firma de los eventos de Wompi')
                 || process.env.WOMPI_WEBHOOK_SECRET || '';
  }
  return _webhookSecret;
}

/** El admin puede rotar credenciales sin reiniciar: invalida la cache. */
export function resetCredentialCache() {
  _publicKey = null;
  _secretKey = null;
  _webhookSecret = null;
}

/** @implements {PaymentAdapter} */
export class WompiAdapter {
  providerId = 'wompi';
  webhookEventIdHeader = 'x-event-id';
  webhookSignatureHeader = 'x-signature';

  constructor() {
    this.real = !!(publicKey() && secretKey());
    this.allowFallback = process.env.NEXOMOCHIS_ALLOW_PROVIDER_FALLBACK === '1';
    if (!this.real && !this.allowFallback) {
      this.fallback = null;
      return;
    }
    this.fallback = new MockAdapter({ name: 'wompi-fallback', webhookSecret: webhookSecret() || 'wompi-dev' });
  }

  /** Lanza si este adapter no puede cobrar de verdad. */
  #assertUsable(op) {
    if (this.real || this.allowFallback) return;
    throw new Error(
      `Wompi sin credenciales: no se puede ${op}. Defini WOMPI_PUBLIC_KEY y WOMPI_SECRET_KEY ` +
      '(o las credenciales wompi/public_key y wompi/secret_key en el vault), ' +
      'o poné NEXOMOCHIS_ALLOW_PROVIDER_FALLBACK=1 solo en desarrollo para probar contra el mock.'
    );
  }

  /** Wompi autentica con Basic(publicKey:secretKey). */
  #authHeader() {
    return `Basic ${Buffer.from(`${publicKey()}:${secretKey()}`).toString('base64')}`;
  }

  /** @param {CreateInput} input */
  async createPaymentIntent(input) {
    if (!this.real) {
      this.#assertUsable('crear un pago');
      const out = await this.fallback.createPaymentIntent(input);
      return { ...out, providerReference: `WOM-FB-${out.providerReference}` };
    }

    const body = {
      // amountMinor YA viene en pesos (ver validateCreateRequest en
      // lib/payments/index.js). Wompi espera pesos, no centavos.
      amount: input.amountMinor,
      currency: input.currency || 'COP',
      description: (input.description || '').slice(0, 120),
      reference: String(input.paymentId).slice(0, 40),
      redirectUrl: process.env.WOMPI_REDIRECT_URL || '',
      customerEmail: input.customerEmail || '',
      customerPhone: input.customerPhone || '',
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };

    const res = await fetch(`${WOMPI_BASE}/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.#authHeader(),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Wompi API error ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const txn = data?.data || {};

    return {
      providerReference: txn.id || `WOM-${randomUUID().slice(0, 8)}`,
      providerResponse: data,
      immediateState: 'REQUIRES_ACTION',
      deepLink: await this.#checkoutLink(body, txn),
      instructions: 'Paga con PSE, Nequi, Daviplata, Bancolombia o tarjeta en el enlace de Wompi.',
    };
  }

  /**
   * Link de pago hosteado (checkout de Wompi). Es un extra: si el checkout no
   * se puede crear, la transaccion sigue valida y el pedido no se rompe.
   */
  async #checkoutLink(body, txn) {
    if (!txn?.id) return null;
    try {
      const res = await fetch(`${WOMPI_BASE}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.#authHeader() },
        body: JSON.stringify({ ...body, transactionId: txn.id }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const token = data?.data?.checkoutToken || data?.data?.token || null;
      return token ? `${WOMPI_CHECKOUT_BASE}/${token}` : null;
    } catch {
      return null;
    }
  }

  /** @param {string} providerRef */
  async getPaymentStatus(providerRef) {
    if (!this.real) {
      this.#assertUsable('consultar el estado de un pago');
      const st = await this.fallback.getPaymentStatus(providerRef);
      return { ...st, providerReference: providerRef };
    }
    const res = await fetch(`${WOMPI_BASE}/transactions/${encodeURIComponent(providerRef)}`, {
      headers: { Authorization: this.#authHeader() },
    });
    if (!res.ok) throw new Error(`Wompi status ${res.status}`);
    const data = await res.json();
    return {
      providerReference: providerRef,
      state: mapWompiState(data?.data?.status),
      raw: data,
    };
  }

  /**
   * Reembolso. Wompi expone el reembolso sobre la transaccion; si el comercio
   * no tiene el derecho habilitado, la API responde 4xx y el error sube tal
   * cual (falla cerrado: nunca se marca un reembolso como hecho si el
   * proveedor no lo acepto).
   * @param {string} providerRef @param {number} amountMinor
   */
  async refund(providerRef, amountMinor) {
    if (!this.real) {
      this.#assertUsable('revertir un pago');
      return await this.fallback.refund(providerRef, amountMinor);
    }
    const res = await fetch(`${WOMPI_BASE}/transactions/${encodeURIComponent(providerRef)}/refund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.#authHeader() },
      body: JSON.stringify({ amount: amountMinor, reason: 'reembolso solicitado por el admin' }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Wompi refund ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => ({}));
    return {
      providerRefundReference: data?.data?.id || `WOM-REF-${randomUUID().slice(0, 8)}`,
      state: 'SUCCEEDED',
    };
  }

  /**
   * Firma de los eventos.
   *
   * Wompi manda `x-event-id` y `x-signature`; la firma se construye con la
   * llave de firma del comercio. La doc de Wompi (docs.wompi.co) devuelve 403
   * al verificador, asi que se aceptan las variantes documentadas en la
   * practica (todas exigen conocer la llave: un evento forjado sin ella
   * falla igual). Si el panel del comercio muestra un esquema que no es
   * ninguno de estos, se anade aqui.
   *
   * @param {Buffer} rawBody @param {Record<string,string>} headers
   */
  verifyWebhookSignature(rawBody, headers) {
    const sig = headers[this.webhookSignatureHeader];
    const secret = webhookSecret();
    if (!sig || typeof sig !== 'string' || !secret) return false;
    const timestamp = headers['x-timestamp'];
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
    const candidates = [
      createHmac('sha256', secret).update(body).digest('hex'),
      createHash('sha256').update(Buffer.concat([body, Buffer.from(secret)])).digest('hex'),
    ];
    if (timestamp) {
      const ts = String(timestamp);
      candidates.push(createHmac('sha256', secret).update(`${ts}.${body.toString('utf8')}`).digest('hex'));
      candidates.push(createHash('sha256').update(`${ts}.${body.toString('utf8')}${secret}`).digest('hex'));
    }
    return candidates.some((expected) => safeEqual(sig, expected));
  }
}

/** Comparacion en tiempo constante de dos strings hex (evita timing attacks). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  let r = 0;
  for (let i = 0; i < ha.length; i++) r |= ha[i] ^ hb[i];
  return r === 0;
}

function mapWompiState(s) {
  if (!s) return 'UNRESOLVED';
  const k = String(s).toUpperCase();
  if (k === 'APPROVED') return 'SUCCEEDED';
  if (k === 'DECLINED' || k === 'REJECTED' || k === 'FAILED') return 'FAILED';
  if (k === 'PENDING') return 'PROCESSING';
  if (k === 'EXPIRED') return 'EXPIRED';
  return 'UNRESOLVED';
}
