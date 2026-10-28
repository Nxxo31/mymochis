import { Router } from '../router.js';
import { geocode } from '../lib/geocode.js';
import { deliveryZoneRequirement, evaluateDelivery } from '../lib/delivery-rules.js';

const router = new Router();

router.post('/quote', async (req, res) => {
  const address = String(req.body?.address || '').trim();
  if (!address || address.length < 5) {
    return res.status(400).json({ error: 'bad_request', message: 'Escribí la dirección completa para cotizar el domicilio.' });
  }
  const config = await req.db.prepare('SELECT * FROM config WHERE id = 1').get();
  if (!config || !config.delivery_immediate_enabled) {
    return res.status(503).json({ error: 'delivery_disabled', message: 'El domicilio no está disponible en este momento.' });
  }
  const zone = deliveryZoneRequirement(config);
  if (!zone.ok) {
    return res.status(503).json({ error: 'zone_not_configured', message: 'La zona de domicilio no está configurada.' });
  }
  const rawSubtotal = req.body?.subtotal_cents;
  if (rawSubtotal != null && (!Number.isFinite(Number(rawSubtotal)) || Number(rawSubtotal) < 0)) {
    return res.status(400).json({ error: 'bad_request', message: 'subtotal_cents debe ser un número mayor o igual a cero.' });
  }
  let geo = null;
  try {
    geo = await geocode(req.db, address);
  } catch {
    geo = null;
  }
  if (!geo) {
    return res.status(422).json({ error: 'geocode_failed', message: 'No encontramos esa dirección. Probá con barrio + calle o una referencia cercana.' });
  }
  let rules = [];
  try {
    rules = await req.db.prepare('SELECT * FROM delivery_free_rules WHERE active = 1 ORDER BY id').all();
  } catch {}
  const evaluation = evaluateDelivery({
    config,
    geo,
    address,
    rules,
    subtotalCents: rawSubtotal == null ? 0 : Number(rawSubtotal),
  });
  if (evaluation.error === 'out_of_zone') {
    const distanceKm = Math.round(evaluation.distance_km * 10) / 10;
    return res.json({
      ok: false,
      address: geo.display_name || address,
      lat: geo.lat,
      lng: geo.lng,
      distance_km: distanceKm,
      fee_cents: null,
      free_delivery: false,
      delivery_free_applied: 0,
      delivery_free_rule_id: null,
      eta_minutes: Number(config.delivery_immediate_eta_minutes) || 45,
      min_order_cents: Number(config.delivery_immediate_min_order_cents) || 0,
      within_zone: false,
      business_date: evaluation.business_date,
      business_tz: evaluation.business_tz,
      message: `Estás a ${distanceKm} km de la cocina y solo entregamos dentro de ${zone.radius} km.`,
    });
  }
  if (!evaluation.ok) {
    const status = evaluation.error === 'zone_not_configured' ? 503 : 422;
    return res.status(status).json({ error: evaluation.error, message: 'No pudimos calcular el domicilio con la configuración actual.' });
  }
  const distanceKm = evaluation.distance_km == null ? null : Math.round(evaluation.distance_km * 10) / 10;
  res.json({
    ok: true,
    address: geo.display_name || address,
    lat: geo.lat,
    lng: geo.lng,
    distance_km: distanceKm,
    fee_cents: evaluation.fee_cents,
    free_delivery: evaluation.free_delivery,
    delivery_free_applied: evaluation.delivery_free_applied,
    delivery_free_rule_id: evaluation.delivery_free_rule_id,
    delivery_free_min_order_cents: evaluation.min_order_cents,
    delivery_free_rule: evaluation.delivery_free_rule,
    eta_minutes: Number(config.delivery_immediate_eta_minutes) || 45,
    min_order_cents: Number(config.delivery_immediate_min_order_cents) || 0,
    within_zone: true,
    business_date: evaluation.business_date,
    business_tz: evaluation.business_tz,
    message: null,
  });
});

export default router;
