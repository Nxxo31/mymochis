import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../auth.js';

const router = Router();

router.get('/', (req, res) => {
  const rows = db.prepare(
    'SELECT id, name, description, price, available, image_url, color, sort_order FROM flavors ORDER BY sort_order, name'
  ).all();
  res.json(rows.map(r => ({ ...r, available: !!r.available })));
});

router.post('/', authMiddleware, (req, res) => {
  const { id, name, description, price, available, image_url, color, sort_order } = req.body || {};
  if (!id || !name || price == null) return res.status(400).json({ error: 'bad_request', message: 'id, name, price son obligatorios' });
  try {
    db.prepare(
      'INSERT INTO flavors (id, name, description, price, available, image_url, color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, description || null, price, available ? 1 : 0, image_url || null, color || null, sort_order || 0);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate', message: 'Ya existe un sabor con ese id' });
    throw e;
  }
  res.status(201).json(db.prepare('SELECT * FROM flavors WHERE id = ?').get(id));
});

router.put('/:id', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT * FROM flavors WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['name', 'description', 'price', 'available', 'image_url', 'color', 'sort_order'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  if ('available' in updates) updates.available = updates.available ? 1 : 0;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE flavors SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(db.prepare('SELECT * FROM flavors WHERE id = ?').get(req.params.id));
});

router.delete('/:id', authMiddleware, (req, res) => {
  const result = db.prepare('DELETE FROM flavors WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;