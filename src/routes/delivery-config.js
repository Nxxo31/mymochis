import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../auth.js';
import { validateDeliveryCoordinates } from '../lib/delivery-rules.js';

const router = Router();

const VALID_FIELDS = [
  'delivery_immediate_enabled',
  'delivery_immediate_fee_cents',
  'delivery_immediate_base_fare_cents',
  'delivery_immediate_price_per_km_cents',
  'delivery_immediate_radius_km',
  'delivery_immediate_min_order_cents',
  'delivery_immediate_eta_minutes',
  'delivery_zone_label',
  'delivery_zone_center_lat',
  'delivery_zone_center_lng',
  'delivery_zone_address',
  'delivery_zone_place_id',
  'delivery_default_cutoff_hours',
];

function nullableText(value, maxLength) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

router.get('/', (req, res) => {
  const config = db.prepare('SELECT * FROM config WHERE id = 1').get();
  const deliveryConfig = {};
  for (const field of VALID_FIELDS) deliveryConfig[field] = config[field];
  res.json(deliveryConfig);
});

router.put('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const existing = db.prepare('SELECT * FROM config WHERE id = 1').get();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const updates = {};
  for (const field of VALID_FIELDS) if (field in (req.body || {})) updates[field] = req.body[field];
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  if ('delivery_immediate_enabled' in updates) updates.delivery_immediate_enabled = updates.delivery_immediate_enabled ? 1 : 0;
  if ('delivery_zone_address' in updates) updates.delivery_zone_address = nullableText(updates.delivery_zone_address, 300);
  if ('delivery_zone_place_id' in updates) updates.delivery_zone_place_id = nullableText(updates.delivery_zone_place_id, 200);
  const candidateLat = 'delivery_zone_center_lat' in updates ? updates.delivery_zone_center_lat : existing.delivery_zone_center_lat;
  const candidateLng = 'delivery_zone_center_lng' in updates ? updates.delivery_zone_center_lng : existing.delivery_zone_center_lng;
  const coordinates = validateDeliveryCoordinates(candidateLat, candidateLng);
  if (coordinates.error) {
    return res.status(400).json({ error: 'bad_request', message: coordinates.error });
  }
  updates.delivery_zone_center_lat = coordinates.lat;
  updates.delivery_zone_center_lng = coordinates.lng;
  updates.updated_at = new Date().toISOString();
  const setSql = Object.keys(updates).map(field => `${field} = ?`).join(', ');
  db.prepare(`UPDATE config SET ${setSql} WHERE id = 1`).run(...Object.values(updates));
  const config = db.prepare('SELECT * FROM config WHERE id = 1').get();
  const deliveryConfig = {};
  for (const field of VALID_FIELDS) deliveryConfig[field] = config[field];
  res.json(deliveryConfig);
});

export default router;
