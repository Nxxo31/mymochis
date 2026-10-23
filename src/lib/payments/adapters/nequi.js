// MyMochis · Nequi adapter (push payment API)
// Spec: PROJECT.md §22.12
// En sandbox/cred-missing cae a modo mock con providerReference identificable.
import { randomUUID } from 'node:crypto';
import { createHmac, createHash } from 'node:crypto';
import { MockAdapter } from './mock.js';
import { useCredential } from '../../vault.js';

/** @typedef {import('../adapter.js').PaymentAdapter} PaymentAdapter */
/** @typedef {import('../adapter.js').CreateInput} CreateInput */
/** @typedef {import('../adapter.js').CreateOutput} CreateOutput */
/** @typedef {import('../adapter.js').ProviderStatus} ProviderStatus */

const NEQUI_BASE = process.env.NEQUI_API_BASE || 'https://api.nequi.com';

// Orden de resolucion: vault (lo que el admin guarda desde el dashboard) y
// luego env (deploy). El vault gana. LA LECTURA ES LAZY a proposito: este
// modulo se importa durante el boot y la DB puede no estar inicializada aun;
// resolver en tiempo de import lanzaria. useCredential() ya devuelve null si
// no encuentra la fila, asi que la ausencia de vault no rompe nada.
let _apiKey = null;
let _webhookSecret = null;

function apiKey() {
  if (_apiKey === null) {
    _apiKey = useCredential('nequi', 'api_key', 'autenticacion contra la API de Nequi')
           || process.env.NEQUI_API_KEY || '';
  }
  return _apiKey;
}

function webhookSecret() {
  if (_webhookSecret === null) {
    _webhookSecret = useCredential('nequi', 'webhook_secret', 'verificar firma de webhooks de Nequi')
                || process.env.NEQUI_WEBHOOK_SECRET || '';
  }
  return _webhookSecret;
}

/** El admin puede rotar credenciales sin reiniciar: invalida la cache. */
export function resetCredentialCache() {
  _apiKey = null;
  _webhookSecret = null;
}

/** @implements {PaymentAdapter} */
export class NequiAdapter {
  providerId = 'nequi';
  webhookEventIdHeader = 'x-nequi-event-id';
  webhookSignatureHeader = 'x-nequi-signature';

  /**
   * Sin credenciales, el adapter NO puede fallsilencioso a un mock.
   *
   * Antes: `this.real = !!apiKey()` y todo intention se delegaba a un
   * MockAdapter con prefijo NEQ-FB-. El mock responde SUCCEEDED, o sea que un
   * despliegue sin NEQUI_API_KEY cobraba pedidos sin mover un peso — y nada en
   * la UI lo delataba, porque el flujo se veía igual.
   *
   * Ahora el fallback a mock existe solo con un opt-in explicito
   * (NEXOMOCHIS_ALLOW_PROVIDER_FALLBACK=1), para que el caso "quiero probar el
   * checkout sin credenciales" sea una decision del despliegue y no un default.
   */
  constructor() {
    this.real = !!apiKey();
    this.allowFallback = process.env.NEXOMOCHIS_ALLOW_PROVIDER_FALLBACK === '1';
    if (!this.real && !this.allowFallback) {
      this.fallback = null;
      return;
    }
    this.fallback = new MockAdapter({ name: 'nequi-fallback', webhookSecret: webhookSecret() || 'nequi-dev' });
  }

  /** Lanza si este adapter no puede cobrar de verdad. */
  #assertUsable(op) {
    if (this.real || this.allowFallback) return;
    throw new Error(
      `Nequi sin credenciales: no se puede ${op}. Defini NEQUI_API_KEY (o la credencial 'nequi/api_key' en el vault), ` +
      'o poné NEXOMOCHIS_ALLOW_PROVIDER_FALLBACK=1 solo en desarrollo para probar contra el mock.'
    );
  }

  /** @param {CreateInput} input */
  async createPaymentIntent(input) {
    if (!this.real) {
      this.#assertUsable('crear un pago');
      const out = await this.fallback.createPaymentIntent(input);
      return { ...out, providerReference: `NEQ-FB-${out.providerReference}` };
    }

    if (!input.customerPhone) {
      throw new Error('Nequi requires customerPhone');
    }

    const body = {
      phoneNumber: input.customerPhone,
      // UNIDAD (auditoria 2026-10-20, bug #2): amountMinor YA viene en pesos
      // (ver validateCreateRequest en lib/payments/index.js). Nequi espera pesos.
      // El `/100` de antes cobraba 100x menos: un pedido de $41.000 => $410.
      value: input.amountMinor,
      reference1: input.paymentId,
      reference2: (input.description || '').slice(0, 40),
    };

    const res = await fetch(`${NEQUI_BASE}/payments/v2/-services-paymentservice-generatecodeqr`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey(),
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
      this.#assertUsable('consultar el estado de un pago');
      const st = await this.fallback.getPaymentStatus(providerRef);
      return { ...st, providerReference: providerRef };
    }
    const res = await fetch(`${NEQUI_BASE}/payments/v2/-services-paymentservice-getstatus?code=${encodeURIComponent(providerRef)}`, {
      headers: { 'X-Api-Key': apiKey() },
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
      this.#assertUsable('revertir un pago');
      return await this.fallback.refund(providerRef, amountMinor);
    }
    // Nequi no expone refund unificado en push; depende de contrato.
    // Implementar cuando el operador confirme el endpoint específico.
    throw new Error('Nequi refund: implementar contra endpoint del contrato (no documentado públicamente)');
  }

  /** @param {Buffer} rawBody @param {Record<string,string>} headers */
  verifyWebhookSignature(rawBody, headers) {
    const sig = headers[this.webhookSignatureHeader];
    const secret = webhookSecret();
    if (!sig || typeof sig !== 'string' || !secret) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    // Comparacion timing-safe (auditoria 2026-10-20, bug #8): el `===` anterior
    // filtra informacion byte a byte por timing y era inconsistente con el
    // safeEqual que si usaba MockAdapter.
    return safeEqual(sig, expected);
  }
}

/** Comparacion en tiempo constante de dos strings hex (evita timing attacks). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Compara sobre el hash del string para igualar longitud sin ramificar en el input.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  let r = 0;
  for (let i = 0; i < ha.length; i++) r |= ha[i] ^ hb[i];
  return r === 0;
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
