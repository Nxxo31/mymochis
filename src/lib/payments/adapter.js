// MyMochis · Payment adapter interface (JSDoc; el proyecto es JS, no TS)
// Spec: PROJECT.md §22.9
// Cada provider implementa este contrato. La fábrica `getAdapter(providerId)`
// devuelve la instancia registrada.

/**
 * @typedef {Object} CreateInput
 * @property {string} paymentId          - ID nuestro (pay_<uuidv7>)
 * @property {number} amountMinor        - COP × 100
 * @property {'COP'} currency
 * @property {string} description
 * @property {string} [customerPhone]
 * @property {string} [customerEmail]
 * @property {Object<string,string>} [metadata]
 * @property {string} [expiresAt]        - ISO8601
 */

/**
 * @typedef {Object} CreateOutput
 * @property {string} providerReference  - txn_id del provider
 * @property {Object} providerResponse
 * @property {'PROCESSING'|'REQUIRES_ACTION'|'SUCCEEDED'|'FAILED'} [immediateState]
 * @property {string} [deepLink]
 * @property {string} [qrCode]           - base64 PNG
 * @property {string} [instructions]
 */

/**
 * @typedef {Object} ProviderStatus
 * @property {string} providerReference
 * @property {'PROCESSING'|'SUCCEEDED'|'FAILED'|'REQUIRES_ACTION'|'UNRESOLVED'|'EXPIRED'} state
 * @property {string} [errorCode]
 * @property {string} [errorMessage]
 * @property {Object} [raw]
 */

/**
 * @typedef {Object} RefundOutput
 * @property {string} providerRefundReference
 * @property {'PROCESSING'|'SUCCEEDED'|'FAILED'} state
 */

/**
 * @typedef {Object} PaymentAdapter
 * @property {string} providerId
 * @property {(input: CreateInput) => Promise<CreateOutput>} createPaymentIntent
 * @property {(providerRef: string) => Promise<ProviderStatus>} getPaymentStatus
 * @property {(providerRef: string, amountMinor: number) => Promise<RefundOutput>} refund
 * @property {(rawBody: Buffer, headers: Record<string,string|string[]|undefined>) => boolean} verifyWebhookSignature
 * @property {string} [webhookEventIdHeader] - ej. 'x-event-id' o null
 * @property {string} [webhookSignatureHeader] - ej. 'x-signature' o 'x-hub-signature-256'
 */

const adapters = new Map();

/**
 * Registra un adapter (lo llama cada modulo de provider al boot).
 * @param {PaymentAdapter} adapter
 */
export function registerAdapter(adapter) {
  if (adapters.has(adapter.providerId)) {
    throw new Error(`Payment adapter ya registrado: ${adapter.providerId}`);
  }
  adapters.set(adapter.providerId, adapter);
}

/**
 * Devuelve el adapter para un providerId. Lanza si no existe.
 * @param {string} providerId
 * @returns {PaymentAdapter}
 */
export function getAdapter(providerId) {
  const a = adapters.get(providerId);
  if (!a) {
    const known = Array.from(adapters.keys()).join(', ') || '(ninguno)';
    throw new Error(`Payment adapter no soportado: ${providerId}. Soportados: ${known}`);
  }
  return a;
}

export function listAdapters() {
  return Array.from(adapters.keys());
}
