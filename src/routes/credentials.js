// MyMochis · API del vault de credenciales (admin-only)
//
// DISEÑO WRITE-ONLY: no existe ningún endpoint que devuelva el valor de un
// secreto. Ni siquiera para el admin. GET devuelve metadata + `secret_set`.
// Esto elimina de raíz la exfiltración por API (XSS, token filtrado, logs).
//
// Lo que el admin puede hacer: guardar, ver qué hay, borrar, ver el audit.
// Lo que NO puede hacer: leer de vuelta un secreto ya guardado.
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth.js';
import {
  vaultConfigured, listCredentials, saveCredential, deleteCredential,
  auditLog, readiness, PROVIDERS,
} from '../lib/vault.js';

const router = Router();
const adminOnly = [authMiddleware, requireRole('admin')];

/** Estado del vault: ¿tiene clave? ¿qué proveedores soporta? */
router.get('/status', adminOnly, (req, res) => {
  res.json({
    configured: vaultConfigured(),
    // Nunca digas DÓNDE está la clave ni su valor — solo si existe.
    key_hint: 'NEXOMOCHIS_VAULT_KEY (env del servidor)',
    providers: Object.entries(PROVIDERS).map(([id, s]) => ({ id, ...s })),
    guarantees: [
      'AES-256-GCM en reposo',
      'La API nunca devuelve el secreto (write-only)',
      'La clave maestra no está en la base de datos',
      'Todo uso queda en auditoría',
    ],
  });
});

/** Readiness: qué proveedores están completos y qué falta. */
router.get('/readiness', adminOnly, (req, res) => {
  res.json({ configured: vaultConfigured(), providers: readiness() });
});

/** Metadata de credenciales guardadas — sin los valores. */
router.get('/', adminOnly, (req, res) => {
  res.json({ configured: vaultConfigured(), credentials: listCredentials() });
});

/** Guardar o sobrescribir una credencial. */
router.post('/', adminOnly, (req, res) => {
  const { provider, field, value } = req.body || {};
  if (!provider || !field || !value) {
    return res.status(400).json({ error: 'bad_request', message: 'provider, field y value son obligatorios' });
  }
  try {
    const out = saveCredential({ provider, field, value, actor: req.user?.email });
    // 201 en create, 200 en update — el frontend no lo necesita pero el log sí.
    res.status(200).json({ ok: true, ...out });
  } catch (e) {
    const code = e.code || 'INTERNAL';
    const status = code === 'VAULT_KEY_MISSING' ? 503 : 400;
    res.status(status).json({ error: code, message: e.message });
  }
});

/** Borrar una credencial. */
router.delete('/', adminOnly, (req, res) => {
  const { provider, field } = req.body || {};
  if (!provider || !field) {
    return res.status(400).json({ error: 'bad_request', message: 'provider y field son obligatorios' });
  }
  try {
    res.json(deleteCredential({ provider, field, actor: req.user?.email }));
  } catch (e) {
    res.status(400).json({ error: e.code || 'INTERNAL', message: e.message });
  }
});

/** Auditoría: qué se guardó,qué se usó y para qué. */
router.get('/audit', adminOnly, (req, res) => {
  res.json({ entries: auditLog(req.query.limit) });
});

export default router;
