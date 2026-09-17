import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../auth.js';

const router = Router();

const VALID_TYPES = ['percent', 'fixed', 'bxgy'];

router.get('/', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM promos ORDER BY active DESC, created_at DESC').all();
  res.json(rows.map(r => ({ ...r, active: !!r.active })));
});

router.post('/', authMiddleware, (req, res) => {
  const { code, name, type, value, active, starts_at, ends_at, min_purchase } = req.body || {};
  if (!name || !type || value == null) return res.status(400).json({ error: 'bad_request', message: 'name, type, value son obligatorios' });
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'bad_request', message: `type inválido. Valores: ${VALID_TYPES.join(',')}` });
  try {
    const result = db.prepare(
      'INSERT INTO promos (code, name, type, value, active, starts_at, ends_at, min_purchase) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(code || null, name, type, value, active === false ? 0 : 1, starts_at || null, ends_at || null, min_purchase || null);
    res.status(201).json(db.prepare('SELECT * FROM promos WHERE id = ?').get(result.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate_code', message: 'Ya existe un promo con ese código' });
    throw e;
  }
});

router.put('/:id', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT * FROM promos WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['code', 'name', 'type', 'value', 'active', 'starts_at', 'ends_at', 'min_purchase'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  if ('active' in updates) updates.active = updates.active ? 1 : 0;
  if ('type' in updates && !VALID_TYPES.includes(updates.type)) {
    return res.status(400).json({ error: 'bad_request', message: `type inválido` });
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  try {
    db.prepare(`UPDATE promos SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate_code' });
    throw e;
  }
  res.json(db.prepare('SELECT * FROM promos WHERE id = ?').get(req.params.id));
});

router.delete('/:id', authMiddleware, (req, res) => {
  const result = db.prepare('DELETE FROM promos WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;