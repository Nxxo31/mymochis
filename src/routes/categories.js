import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../auth.js';

const router = Router();

const SLUG_RE = /^[a-z0-9-]+$/;

router.get('/', (req, res) => {
  const includeInactive = req.query.include_inactive === '1' && req.user;
  const sql = includeInactive
    ? 'SELECT * FROM categories ORDER BY sort_order, name'
    : 'SELECT * FROM categories WHERE active = 1 ORDER BY sort_order, name';
  const rows = db.prepare(sql).all();
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
});

router.post('/', authMiddleware, (req, res) => {
  const { name, slug, sort_order = 0, active = 1 } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: 'bad_request', message: 'name y slug son obligatorios' });
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'bad_request', message: 'slug debe ser kebab-case (a-z, 0-9, -)' });
  try {
    const info = db.prepare('INSERT INTO categories (name, slug, sort_order, active) VALUES (?, ?, ?, ?)').run(name, slug, sort_order, active ? 1 : 0);
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate', message: 'name o slug ya existe' });
    throw e;
  }
});

router.put('/:id', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT id FROM categories WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['name', 'slug', 'sort_order', 'active'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  if ('slug' in updates && !SLUG_RE.test(updates.slug)) return res.status(400).json({ error: 'bad_request', message: 'slug inválido' });
  if ('active' in updates) updates.active = updates.active ? 1 : 0;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE categories SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id));
});

router.delete('/:id', authMiddleware, (req, res) => {
  const result = db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;