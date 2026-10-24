// MyMochis · Almacén de credenciales cifradas
//
// POR QUÉ EXISTE Y POR QUÉ ES SEGURO
// -------------------------------------
// El operador pidió "que el admin ponga sus credenciales sin generar riesgos".
// El riesgo real no es guardarlas: es que app SEPARADAS (el sitio público, un
// backup, un dump de la DB, un log) puedan leerlas. Esto lo resuelve:
//
// 1. CIFRADO EN REPOSO — AES-256-GCM. El texto plano nunca toca la DB ni un log.
// 2. WRITE-ONLY POR DISEÑO — la API NUNCA devuelve el secreto. GET devuelve
//    metadata + `secret_set`. No existe endpoint de lectura del valor. Ni para
//    el admin. Eso elimina de raiz la exfiltracion por API.
// 3. SEPARACION DE CLAVES — la master key NO esta en la DB. Vive en
//    NEXOMOCHIS_VAULT_KEY (env). Quien tenga la DB sin la env no descifra nada.
//    Se deriva por HKDF con un salt de la propia DB, para que dos vaults con
//    la misma key no produzcan el mismo cifrado.
// 4. MASCARADO — ni siquiera dentro de la app se ve mas que los ultimos 4.
// 5. AUDITORIA — todo uso queda en credential_audit con el proposito.
// 6. FALLA CERRADA — sin NEXOMOCHIS_VAULT_KEY, guardar credenciales devuelve
//    error explicito. El vault no se degrada a "guardar en claro".
//
// LO QUE NO SE PUEDE HACER (y por que este modulo no lo intenta)
// --------------------------------------------------------------
// MyMochis no puede autenticar a un humano contra su banco: ningun banco
// colombiano ofrece API de login de retail, y el Open Finance sigue en
// construccion (Decreto 0368 de abril 2026: 12 meses por estandar habilitado).
// Lo que SI existe — y es lo que se guarda aqui — son credenciales de
// COMERCIO: Client Id/Secret de API Market, API keys de Nequi/DaviPlata,
// tokens de Meta, webhooks. Eso si es legal, soportado y seguro de guardar.

import { createCipheriv, createDecipheriv, randomBytes, hkdfSync, timingSafeEqual } from 'node:crypto';
import { db } from '../db.js';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Metadata de los proveedores soportados. Guía al admin: esto es lo que existe. */
export const PROVIDERS = {
  bancolombia: {
    label: 'Bancolombia API Market',
    hint: 'Client Id + Client Secret de https://api-portal-external.apps.bancolombia.com (QR y Botón de pago).',
    fields: ['client_id', 'client_secret'],
    docs: 'https://api-portal-external.apps.bancolombia.com/documentacion',
  },
  nequi: {
    label: 'Nequi API',
    hint: 'API Key del negocio. Solo sirve con onboarding aprobado (RUT/NIT).',
    fields: ['api_key', 'webhook_secret'],
    docs: 'https://www.nequi.com.co/negocios/apis',
  },
  daviplata: {
    label: 'Daviplata Botón',
    hint: 'API key + secret del Botón DaviPlata.',
    fields: ['api_key', 'secret'],
    docs: 'https://conectesunegocio.daviplata.com/',
  },
  mercadopago: {
    label: 'Mercado Pago',
    hint: 'Access Token de producción. Checkout Pro keeps las tarjetas fuera de tu servidor.',
    fields: ['access_token', 'webhook_secret'],
    docs: 'https://www.mercadopago.com.co/developers/es/reference',
  },
  meta_whatsapp: {
    label: 'Meta WhatsApp Cloud API',
    hint: 'Token permanente + Phone ID. Solo para difusión a TODOS los admins.',
    fields: ['token', 'phone_id', 'webhook_verify_token'],
    docs: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
  },
  instagram: {
    label: 'Instagram',
    hint: 'Token de tu cuenta profesional de Instagram. Al conectarlo, la galería de la página se lene sola con lo que publiques (sincroniza cada 30 minutos).',
    fields: ['access_token'],
    docs: 'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api',
  },
};

/** Clave maestra derivada. Lanza si falta: el vault falla cerrado, nunca abierto. */
let cachedKey = null;
let cachedSalt = null;

function vaultSalt() {
  const row = db.prepare("SELECT value FROM app_secrets WHERE key = 'vault_salt'").get();
  if (row?.value) return row.value;
  const salt = randomBytes(16).toString('hex');
  db.prepare("INSERT OR REPLACE INTO app_secrets (key, value) VALUES ('vault_salt', ?)").run(salt);
  return salt;
}

function masterKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.NEXOMOCHIS_VAULT_KEY;
  if (!raw) {
    const err = new Error(
      'NEXOMOCHIS_VAULT_KEY no esta definida. Genera una con `openssl rand -hex 32` ' +
      'y guardala FUERA del repo (env del servidor). Sin esta variable el vault ' +
      'rechaza credenciales en vez de guardarlas en claro.'
    );
    err.code = 'VAULT_KEY_MISSING';
    throw err;
  }
  const salt = vaultSalt();
  cachedSalt = salt;
  cachedKey = Buffer.from(hkdfSync('sha256', Buffer.from(raw, 'utf8'), Buffer.from(salt, 'hex'), Buffer.from('mymochis-vault-v1'), 32));
  return cachedKey;
}

export function vaultConfigured() {
  return !!process.env.NEXOMOCHIS_VAULT_KEY;
}

/** Cifra un string. Devuelve iv/tag/cipher en hex. */
export function encryptSecret(plain) {
  const key = masterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ct.toString('hex'),
  };
}

/** Descifra. Lanza si el tag no valida (clave rotada o dato manipulado). */
export function decryptSecret({ iv, tag, ciphertext }) {
  const key = masterKey();
  const d = createDecipheriv(ALGO, key, Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(ciphertext, 'hex')), d.final()]).toString('utf8');
}

/** Enmascara para mostrar: deja los ultimos 4. "sk_live_...9f2a" */
export function maskSecret(value) {
  const s = String(value || '');
  if (s.length <= 4) return '•'.repeat(Math.max(4, s.length));
  return '•'.repeat(Math.min(16, s.length - 4)) + s.slice(-4);
}

/** Verifica que un valor descifrado sea el esperado, en tiempo constante. */
export function secretMatches(provided, expected) {
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function audit(action, provider, field, actor, ok, detail) {
  db.prepare(`
    INSERT INTO credential_audit (action, provider, field, actor, ok, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(action, provider, field || null, actor || null, ok ? 1 : 0, detail ? String(detail).slice(0, 200) : null);
}

/** Metadatos de un proveedor: NUNCA incluye el valor del secreto. */
export function listCredentials() {
  const rows = db.prepare(`
    SELECT id, provider, field, masked, created_at, updated_at, last_used_at, is_active
    FROM merchant_credentials ORDER BY provider, field
  `).all();
  return rows.map(r => ({
    ...r,
    secret_set: true,
    value: null,               // por diseño: la API no entrega el secreto
    provider_label: PROVIDERS[r.provider]?.label || r.provider,
  }));
}

export function saveCredential({ provider, field, value, actor }) {
  const spec = PROVIDERS[provider];
  if (!spec) throw Object.assign(new Error(`provider desconocido: ${provider}`), { code: 'UNKNOWN_PROVIDER' });
  if (!spec.fields.includes(field)) {
    throw Object.assign(new Error(`campo "${field}" no aplica a ${provider}. Validos: ${spec.fields.join(', ')}`), { code: 'UNKNOWN_FIELD' });
  }
  if (!value || String(value).trim().length < 8) {
    throw Object.assign(new Error('el secreto debe tener al menos 8 caracteres'), { code: 'WEAK_SECRET' });
  }

  let enc;
  try {
    enc = encryptSecret(String(value).trim());
  } catch (e) {
    audit('save', provider, field, actor, false, e.code || e.message);
    throw e;
  }
  const masked = maskSecret(value);

  db.prepare(`
    INSERT INTO merchant_credentials (provider, field, iv, tag, ciphertext, masked, created_at, updated_at, is_active)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 1)
    ON CONFLICT(provider, field) DO UPDATE SET
      iv = excluded.iv, tag = excluded.tag, ciphertext = excluded.ciphertext,
      masked = excluded.masked, updated_at = datetime('now'), is_active = 1
  `).run(provider, field, enc.iv, enc.tag, enc.ciphertext, masked);

  audit('save', provider, field, actor, true, `actualizado (${masked})`);
  return { provider, field, masked, secret_set: true };
}

/**
 * Usa un secreto. `purpose` queda en la auditoria para que puedas responder
 * "¿para que se uso esta credencial?" sin revisar logs.
 */
export function useCredential(provider, field, purpose) {
  const row = db.prepare(
    'SELECT iv, tag, ciphertext, masked FROM merchant_credentials WHERE provider = ? AND field = ? AND is_active = 1'
  ).get(provider, field);
  if (!row) {
    audit('use', provider, field, null, false, 'no encontrado');
    return null;
  }
  try {
    const value = decryptSecret(row);
    db.prepare("UPDATE merchant_credentials SET last_used_at = datetime('now') WHERE provider = ? AND field = ?").run(provider, field);
    audit('use', provider, field, null, true, purpose || 'sin propósito declarado');
    return value;
  } catch (e) {
    audit('use', provider, field, null, false, 'fallo de descifrado (clave rotada?)');
    return null;
  }
}

export function deleteCredential({ provider, field, actor }) {
  const info = db.prepare('DELETE FROM merchant_credentials WHERE provider = ? AND field = ?').run(provider, field);
  audit('delete', provider, field, actor, info.changes > 0, `${info.changes} fila(s)`);
  return { deleted: info.changes > 0 };
}

export function auditLog(limit = 50) {
  return db.prepare('SELECT * FROM credential_audit ORDER BY id DESC LIMIT ?').all(Math.min(Number(limit) || 50, 200));
}

/** Que proveedores de PROVIDERS aun no tienen completo todos sus campos. */
export function readiness() {
  const have = new Set(db.prepare('SELECT provider, field FROM merchant_credentials WHERE is_active = 1').all().map(r => `${r.provider}.${r.field}`));
  return Object.entries(PROVIDERS).map(([id, spec]) => {
    const missing = spec.fields.filter(f => !have.has(`${id}.${f}`));
    return {
      provider: id, label: spec.label, hint: spec.hint, docs: spec.docs,
      fields: spec.fields, configured: have.size ? missing.length === 0 : false,
      missing,
    };
  });
}
