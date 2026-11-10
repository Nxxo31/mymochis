import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../auth.js';

const router = Router();

const COLS = 'f.id, f.name, description, price, available, image_url, color, f.sort_order, category_id, tags, status, focal_point_x, focal_point_y, f.created_at';

function shape(r) {
  return {
    ...r,
    available: !!r.available,
    tags: r.tags ? r.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    status: r.status || 'published',
    focal_point_x: r.focal_point_x,
    focal_point_y: r.focal_point_y,
  };
}

router.get('/', (req, res) => {
  try {
    let sql = `SELECT ${COLS}, c.name AS category_name, c.slug AS category_slug FROM flavors AS f LEFT JOIN categories c ON c.id = f.category_id WHERE 1=1`;
    const params = [];

    if (req.query.status) {
      sql += ` AND f.status = ?`;
      params.push(String(req.query.status));
    }
    if (req.query.category_id) {
      sql += ` AND f.category_id = ?`;
      params.push(req.query.category_id);
    }
    if (req.query.tag) {
      sql += ` AND f.tags IS NOT NULL AND (',' || f.tags || ',') LIKE ?`;
      params.push(`%,${req.query.tag},%`);
    }
    if (req.query.q) {
      sql += ` AND (f.name LIKE ? OR f.description LIKE ?)`;
      params.push(`%${req.query.q}%`, `%${req.query.q}%`);
    }

    const rows = db.prepare(sql).all(...params);
    res.json(rows.map(shape));
  } catch (err) {
    console.error('GET /api/products error:', err.message);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

router.get('/:id', (req, res) => {
  const row = db.prepare(`SELECT ${COLS} FROM flavors AS f WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(shape(row));
});

router.post('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const { id, name, description, price, available, image_url, color, sort_order, category_id, tags, status, focal_point_x, focal_point_y } = req.body || {};
  if (!id || !name || price == null) return res.status(400).json({ error: 'bad_request', message: 'id, name, price son obligatorios' });
  const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || null);
  try {
    db.prepare(
      'INSERT INTO flavors (id, name, description, price, available, image_url, color, sort_order, category_id, tags, status, focal_point_x, focal_point_y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, description || null, price, available ? 1 : 0, image_url || null, color || null, sort_order || 0, category_id || null, tagsStr, status || 'published', focal_point_x || null, focal_point_y || null);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate', message: 'Ya existe un producto con ese id' });
    throw e;
  }
  res.status(201).json(shape(db.prepare(`SELECT ${COLS} FROM flavors AS f WHERE id = ?`).get(id)));
});

router.put('/:id', [authMiddleware, requireRole('admin')], (req, res) => {
  const existing = db.prepare('SELECT * FROM flavors WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['name', 'description', 'price', 'available', 'image_url', 'color', 'sort_order', 'category_id', 'tags', 'status', 'focal_point_x', 'focal_point_y'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  if ('available' in updates) updates.available = updates.available ? 1 : 0;
  if ('tags' in updates) updates.tags = Array.isArray(updates.tags) ? updates.tags.join(',') : updates.tags;
  if ('status' in updates && !['draft', 'published'].includes(updates.status)) {
    return res.status(400).json({ error: 'bad_request', message: 'status debe ser draft o published' });
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE flavors SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(shape(db.prepare(`SELECT ${COLS} FROM flavors AS f WHERE id = ?`).get(req.params.id)));
});

router.delete('/:id', [authMiddleware, requireRole('admin')], (req, res) => {
  const result = db.prepare('DELETE FROM flavors WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

router.get('/:id/preview', (req, res) => {
  const row = db.prepare(`SELECT ${COLS} FROM flavors AS f WHERE id = ? AND status = 'draft'`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found_or_not_draft' });
  res.json({ ...shape(row), preview: true });
});

export default router;
