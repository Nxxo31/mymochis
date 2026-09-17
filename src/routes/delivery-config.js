import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../auth.js';

const router = Router();

const VALID_FIELDS = [
  'delivery_immediate_enabled',
  'delivery_immediate_fee_cents',
  'delivery_immediate_radius_km',
  'delivery_immediate_min_order_cents',
  'delivery_immediate_eta_minutes',
  'delivery_zone_label',
  'delivery_zone_center_lat',
  'delivery_zone_center_lng',
  'delivery_default_cutoff_hours'
];

router.get('/', (req, res) => {
  const cfg = db.prepare('SELECT * FROM config WHERE id = 1').get();
  const deliveryConfig = {};
  for (const f of VALID_FIELDS) deliveryConfig[f] = cfg[f];
  res.json(deliveryConfig);
});

router.put('/', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT id FROM config WHERE id = 1').get();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const updates = {};
  for (const k of VALID_FIELDS) if (k in req.body) updates[k] = req.body[k];
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  if ('delivery_immediate_enabled' in updates) updates.delivery_immediate_enabled = updates.delivery_immediate_enabled ? 1 : 0;
  updates.updated_at = new Date().toISOString();
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE config SET ${setSql} WHERE id = 1`).run(...Object.values(updates));
  const cfg = db.prepare('SELECT * FROM config WHERE id = 1').get();
  const deliveryConfig = {};
  for (const f of VALID_FIELDS) deliveryConfig[f] = cfg[f];
  res.json(deliveryConfig);
});

export default router;