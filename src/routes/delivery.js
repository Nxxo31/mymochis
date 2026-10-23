// MyMochis · Cotización de domicilio
// POST /api/delivery/quote — calcula el precio del domicilio ANTES de crear
// el pedido: geocodifica la dirección, mide la distancia al centro de la zona
// y aplica la MISMA fórmula de tarifas que usa POST /api/orders (lib/delivery-fee.js).
// Público como el flujo de pedidos (el cliente no tiene cuenta).
import { Router } from 'express';
import { db } from '../db.js';
import { geocode, haversineKm } from '../lib/geocode.js';
import { computeDeliveryFeeCents } from '../lib/delivery-fee.js';

const router = Router();

router.post('/quote', async (req, res) => {
  const address = String(req.body?.address || '').trim();
  if (!address || address.length < 5) {
    return res.status(400).json({ error: 'bad_request', message: 'Escribí la dirección completa para cotizar el domicilio.' });
  }
  const config = db.prepare('SELECT * FROM config WHERE id = 1').get();
  if (!config || !config.delivery_immediate_enabled) {
    return res.status(503).json({ error: 'delivery_disabled', message: 'El domicilio no está disponible en este momento.' });
  }

  const geo = await geocode(address).catch(() => null);
  if (!geo) {
    return res.status(422).json({ error: 'geocode_failed', message: 'No encontramos esa dirección. Probá con barrio + calle o una referencia cercana.' });
  }

  let distanceKm = null;
  if (config.delivery_zone_center_lat != null && config.delivery_zone_center_lng != null) {
    distanceKm = haversineKm(config.delivery_zone_center_lat, config.delivery_zone_center_lng, geo.lat, geo.lng);
  }
  const km = distanceKm == null ? null : Math.round(distanceKm * 10) / 10;
  const radius = Number(config.delivery_immediate_radius_km) || 0;
  const withinZone = distanceKm == null ? true : (radius <= 0 || distanceKm <= radius);

  res.json({
    ok: withinZone,
    address: geo.display_name || address,
    lat: geo.lat,
    lng: geo.lng,
    distance_km: km,
    fee_cents: withinZone ? computeDeliveryFeeCents(config, distanceKm) : null,
    eta_minutes: Number(config.delivery_immediate_eta_minutes) || 45,
    min_order_cents: Number(config.delivery_immediate_min_order_cents) || 0,
    within_zone: withinZone,
    message: withinZone
      ? null
      : `Estás a ${km} km de la cocina y solo entregamos dentro de ${radius} km.`,
  });
});

export default router;
