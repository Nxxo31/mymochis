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
  auditLog, readiness, useCredential, PROVIDERS,
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

/**
 * Configuración del mapa para el panel (admin-only).
 *
 * ÚNICA excepción controlada al diseño write-only del vault, y es deliberada:
 * la API key de Google Maps para navegador tiene que viajar al cliente para
 * que el mapa cargue. No es un secreto de servidor: Google la publica en el
 * HTML de la página que la usa, y se protege restringiéndola por referente
 * HTTP y por API. Por eso aquí NO se expone ningún otro secreto: solo el
 * browser_key y el map_id del proveedor google_maps, y nada más.
 *
 * Si el vault no está configurado o no hay key, responde 200 con la razón
 * explicita — nunca 500 — para que el panel muestre el estado y deje el
 * formulario manual como única via.
 */
router.get('/maps-config', adminOnly, (req, res) => {
  const payload = {
    configured: false,
    ready: false,
    browser_key: null,
    map_id: null,
    reason: null,
  };
  if (!vaultConfigured()) {
    payload.reason = 'El almacén de credenciales no está configurado. Define NEXOMOCHIS_VAULT_KEY en el servidor y reinicia.';
    return res.json(payload);
  }
  let browserKey = null;
  let mapId = null;
  try {
    browserKey = useCredential('google_maps', 'browser_key', 'panel: mapa de la zona de domicilio');
    mapId = useCredential('google_maps', 'map_id', 'panel: mapa de la zona de domicilio');
  } catch {
    payload.reason = 'No pudimos leer el almacén de credenciales en este momento.';
    return res.json(payload);
  }
  payload.configured = true;
  payload.browser_key = browserKey || null;
  payload.map_id = mapId || null;
  payload.ready = Boolean(browserKey);
  if (!browserKey) {
    payload.reason = 'Todavía no hay una API key de Google Maps guardada. Agrégala en Credenciales > Google Maps.';
  }
  return res.json(payload);
});

export default router;
