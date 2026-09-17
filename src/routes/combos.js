import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../auth.js';

const router = Router();

router.get('/', (req, res) => {
  const rows = db.prepare(
    'SELECT id, name, units, price, description, compare_at_price, available, featured, image_url, sort_order FROM combos ORDER BY sort_order, id'
  ).all();
  res.json(rows.map(r => ({ ...r, available: !!r.available, featured: !!r.featured })));
});

router.post('/', authMiddleware, (req, res) => {
  const { name, units, price, description, compare_at_price, available, featured, image_url, sort_order } = req.body || {};
  if (!name || units == null || price == null) return res.status(400).json({ error: 'bad_request', message: 'name, units, price son obligatorios' });
  const result = db.prepare(
    'INSERT INTO combos (name, units, price, description, compare_at_price, available, featured, image_url, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name, units, price, description || null, compare_at_price || null, available ? 1 : 0, featured ? 1 : 0, image_url || null, sort_order || 0);
  res.status(201).json(db.prepare('SELECT * FROM combos WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/:id', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT * FROM combos WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['name', 'units', 'price', 'description', 'compare_at_price', 'available', 'featured', 'image_url', 'sort_order'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  if ('available' in updates) updates.available = updates.available ? 1 : 0;
  if ('featured' in updates) updates.featured = updates.featured ? 1 : 0;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE combos SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(db.prepare('SELECT * FROM combos WHERE id = ?').get(req.params.id));
});

router.delete('/:id', authMiddleware, (req, res) => {
  const result = db.prepare('DELETE FROM combos WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;