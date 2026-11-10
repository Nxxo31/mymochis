// MyMochis · Verificacion de telefono por codigo de un solo uso (spec 58, p5)
//
// P0: POST /api/orders es PUBLICO y dispara un push de pago a cualquier
// telefono que alguien escriba. Eso es phishing (cobrar a la victima desde su
// propio telefono) y quema de cuota del proveedor.
//
// La salida: antes de generar el intent de un proveedor que empuja al
// telefono (Nequi), el cliente tiene que demostrar que ese telefono es suyo.
// El codigo se guarda hasheado, expira y tiene un numero maximo de intentos.
//
// El codigo NUNCA sale del servidor a un tercero: la respuesta publica dice
// como recibirlo (deep link de WhatsApp al mismo numero). En desarrollo y
// tests se puede devolver en la respuesta (NEXOMOCHIS_OTP_DEV=1).
import { randomUUID, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { db } from '../db.js';

const TTL_MINUTES = Number(process.env.NEXOMOCHIS_OTP_TTL_MINUTES || 10);
const MAX_ATTEMPTS = 5;
const CODE_LENGTH = 6;

function normalizarPhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function hashCode(code, salt) {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

/** El hash se guarda con su sal: `sal:hash`. Sin la sal no se puede verificar. */
function packHash(code, salt) {
  return `${salt}:${hashCode(code, salt)}`;
}

function esDev() {
  return process.env.NEXOMOCHIS_OTP_DEV === '1' || process.env.NODE_ENV === 'test';
}

/** Crea el reto y devuelve el codigo SOLO para el canal de entrega. */
export function createChallenge({ phone, purpose = 'order', orderId = null }) {
  const tel = normalizarPhone(phone);
  if (!/^\d{8,15}$/.test(tel)) {
    const err = new Error('El telefono no tiene un formato valido');
    err.code = 'bad_phone';
    throw err;
  }

  const codigo = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
  const salt = randomUUID();
  const verificationId = `pv_${randomUUID()}`;
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO phone_verifications
      (verification_id, phone, purpose, code_hash, max_attempts, expires_at, order_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(verificationId, tel, purpose, packHash(codigo, salt), MAX_ATTEMPTS, expiresAt, orderId);

  return { verification_id: verificationId, phone: tel, code: codigo, expires_at: expiresAt };
}

/**
 * Verifica el codigo. Devuelve {ok:true} o lanza con un codigo de error
 * (bad_code / too_many_attempts / expired).
 */
export function verifyCode({ phone, code, purpose = 'order' }) {
  const tel = normalizarPhone(phone);
  const row = db.prepare(`
    SELECT * FROM phone_verifications
    WHERE phone = ? AND purpose = ? AND verified_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(tel, purpose);
  if (!row) {
    const err = new Error('No hay ningun codigo pendiente para ese telefono');
    err.code = 'no_challenge';
    throw err;
  }
  if (row.attempts >= row.max_attempts) {
    const err = new Error('Se agotaron los intentos de este codigo');
    err.code = 'too_many_attempts';
    throw err;
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    const err = new Error('El codigo expiro');
    err.code = 'expired';
    throw err;
  }

  const [salt, esperadoHex] = String(row.code_hash).split(':');
  const esperado = Buffer.from(esperadoHex || '', 'hex');
  const recibido = Buffer.from(hashCode(String(code || '').trim(), salt || ''), 'hex');
  const ok = esperado.length > 0 && esperado.length === recibido.length && timingSafeEqual(esperado, recibido);

  db.prepare('UPDATE phone_verifications SET attempts = attempts + 1 WHERE verification_id = ?').run(row.verification_id);
  if (!ok) {
    const err = new Error('El codigo no coincide');
    err.code = 'bad_code';
    throw err;
  }

  db.prepare("UPDATE phone_verifications SET verified_at = datetime('now') WHERE verification_id = ?").run(row.verification_id);
  return { ok: true, verification_id: row.verification_id };
}

/** El telefono esta verificado hace menos de `minutos`? */
export function isPhoneVerified(phone, minutes = 30) {
  const tel = normalizarPhone(phone);
  if (!tel) return false;
  const row = db.prepare(`
    SELECT verified_at FROM phone_verifications
    WHERE phone = ? AND verified_at IS NOT NULL
      AND datetime(verified_at) >= datetime('now', ?)
    ORDER BY verified_at DESC LIMIT 1
  `).get(tel, `-${Number(minutes || 30)} minutes`);
  return Boolean(row);
}

/** Deep link de WhatsApp con el codigo: el cliente lo abre en SU telefono. */
export function whatsappCodeLink(phone, code, text = 'Tu codigo de verificacion de MyMochis') {
  const tel = normalizarPhone(phone);
  const mensaje = `${text}: ${code}`;
  return `https://api.whatsapp.com/send/?phone=${tel}&text=${encodeURIComponent(mensaje)}`;
}

export { esDev, normalizarPhone, TTL_MINUTES };
