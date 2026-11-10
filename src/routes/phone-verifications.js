// MyMochis · Rutas de verificacion de telefono (spec 58, p5)
//
// POST /api/phone-verifications        -> pide un codigo para un telefono
// POST /api/phone-verifications/verify -> lo verifica
//
// El codigo se entrega al PROPIO telefono (deep link de WhatsApp al numero
// verificado), nunca a un tercero. En dev/test (NEXOMOCHIS_OTP_DEV=1) el
// codigo vuelve en la respuesta para poder automatizar las pruebas.
import { Router } from 'express';
import { db } from '../db.js';
import { createChallenge, verifyCode, whatsappCodeLink, esDev, normalizarPhone } from '../lib/phone-verification.js';

const router = Router();

// Un telefono no puede pedir codigos sin limite: si no, el endpoint se
// convierte en una herramienta de spam de WhatsApp.
const MAX_CHALLENGES_PER_HOUR = 5;

router.post('/', (req, res) => {
  const { phone, purpose = 'order' } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'bad_request', message: 'Falta el telefono' });

  // Un telefono no puede pedir codigos sin limite: si no, el endpoint se
  // convierte en una herramienta de spam de WhatsApp.
  const pedidos = db.prepare(
    "SELECT COUNT(*) AS n FROM phone_verifications WHERE phone = ? AND created_at >= datetime('now', '-1 hour')"
  ).get(normalizarPhone(phone));
  if (Number(pedidos?.n || 0) >= MAX_CHALLENGES_PER_HOUR) {
    return res.status(429).json({
      error: 'too_many_challenges',
      message: 'Ya pediste varios codigos. Espera un rato antes de pedir otro.',
    });
  }

  let challenge;
  try {
    challenge = createChallenge({ phone, purpose });
  } catch (e) {
    if (e.code === 'bad_phone') {
      return res.status(400).json({ error: 'bad_phone', message: 'El telefono no tiene un formato valido' });
    }
    throw e;
  }

  res.status(201).json({
    ok: true,
    verification_id: challenge.verification_id,
    expires_at: challenge.expires_at,
    // El canal de entrega: el cliente abre el enlace en SU telefono.
    whatsapp_link: whatsappCodeLink(challenge.phone, challenge.code),
    ...(esDev() ? { code: challenge.code, dev: true } : {}),
  });
});

router.post('/verify', (req, res) => {
  const { phone, code, purpose = 'order' } = req.body || {};
  if (!phone || !code) {
    return res.status(400).json({ error: 'bad_request', message: 'Falta el telefono o el codigo' });
  }
  try {
    const out = verifyCode({ phone, code, purpose });
    res.json({ ok: true, verification_id: out.verification_id });
  } catch (e) {
    const status = e.code === 'expired' ? 410 : e.code === 'no_challenge' ? 404 : 400;
    res.status(status).json({ error: e.code || 'bad_code', message: e.message });
  }
});

export default router;
