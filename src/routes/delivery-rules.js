import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, requireRole, verifyJwt } from '../auth.js';
import { normalizeDeliveryFreeRule, validateDeliveryFreeRule } from '../lib/delivery-rules.js';

const router = Router();
const adminOnly = [authMiddleware, requireRole('admin')];
const allowedFields = [
  'day_of_week',
  'free_delivery',
  'label',
  'min_order_cents',
  'starts_at',
  'ends_at',
  'active',
  'notes',
];

function optionalAuth(req, res, next) {
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
  req.user = token ? (verifyJwt(token) || null) : null;
  next();
}

function normalizeRequest(body = {}) {
  return normalizeDeliveryFreeRule({
    day_of_week: body.day_of_week,
    free_delivery: body.free_delivery,
    label: body.label,
    min_order_cents: body.min_order_cents,
    starts_at: body.starts_at,
    ends_at: body.ends_at,
    active: body.active,
    notes: body.notes,
  });
}

router.get('/', optionalAuth, (req, res) => {
  const includeInactive = req.query.include_inactive === '1' && req.user?.role === 'admin';
  const sql = includeInactive
    ? 'SELECT * FROM delivery_free_rules ORDER BY day_of_week, id'
    : 'SELECT * FROM delivery_free_rules WHERE active = 1 ORDER BY day_of_week, id';
  res.json(db.prepare(sql).all());
});

router.get('/:id', optionalAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM delivery_free_rules WHERE id = ?').get(Number(req.params.id));
  if (!row || (Number(row.active) !== 1 && req.user?.role !== 'admin')) {
    return res.status(404).json({ error: 'not_found' });
  }
  res.json(row);
});

router.post('/', adminOnly, (req, res) => {
  const rule = normalizeRequest({
    day_of_week: req.body?.day_of_week,
    free_delivery: req.body?.free_delivery ?? 1,
    label: req.body?.label,
    min_order_cents: req.body?.min_order_cents ?? 0,
    starts_at: req.body?.starts_at,
    ends_at: req.body?.ends_at,
    active: req.body?.active ?? 1,
    notes: req.body?.notes,
  });
  const error = validateDeliveryFreeRule(rule);
  if (error) return res.status(400).json({ error: 'bad_request', message: error });
  const info = db.prepare(`
    INSERT INTO delivery_free_rules (
      day_of_week, free_delivery, label, min_order_cents, starts_at, ends_at, active, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rule.day_of_week,
    rule.free_delivery,
    rule.label,
    rule.min_order_cents,
    rule.starts_at,
    rule.ends_at,
    rule.active,
    rule.notes,
  );
  res.status(201).json(db.prepare('SELECT * FROM delivery_free_rules WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/:id', adminOnly, (req, res) => {
  const existing = db.prepare('SELECT * FROM delivery_free_rules WHERE id = ?').get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const updates = {};
  for (const field of allowedFields) if (field in (req.body || {})) updates[field] = req.body[field];
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const rule = normalizeRequest({ ...existing, ...updates });
  const error = validateDeliveryFreeRule(rule);
  if (error) return res.status(400).json({ error: 'bad_request', message: error });
  db.prepare(`
    UPDATE delivery_free_rules
    SET day_of_week = ?, free_delivery = ?, label = ?, min_order_cents = ?,
        starts_at = ?, ends_at = ?, active = ?, notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    rule.day_of_week,
    rule.free_delivery,
    rule.label,
    rule.min_order_cents,
    rule.starts_at,
    rule.ends_at,
    rule.active,
    rule.notes,
    existing.id,
  );
  res.json(db.prepare('SELECT * FROM delivery_free_rules WHERE id = ?').get(existing.id));
});

router.delete('/:id', adminOnly, (req, res) => {
  const result = db.prepare('DELETE FROM delivery_free_rules WHERE id = ?').run(Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;
