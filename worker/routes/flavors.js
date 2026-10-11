import { Router } from '../router.js';
import { authMiddleware, requireRole } from '../auth.js';

const router = new Router();

router.get('/', async (req, res) => {
  const rows = await req.db.prepare(`
    SELECT f.*, c.name AS category_name, c.slug AS category_slug
    FROM flavors f
    LEFT JOIN categories c ON c.id = f.category_id
    ORDER BY c.sort_order, f.sort_order, f.name
  `).all();
  res.json(rows.map(r => ({ ...r, available: !!r.available })));
});

router.get('/:id', async (req, res) => {
  const row = await req.db.prepare('SELECT * FROM flavors WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json({ ...row, available: !!row.available });
});

router.post('/', [authMiddleware, requireRole('admin')], async (req, res) => {
  const { id, name, description, price, available, image_url, color, sort_order, category_id } = req.body || {};
  if (!id || !name || price == null) return res.status(400).json({ error: 'bad_request', message: 'id, name, price son obligatorios' });
  try {
    await req.db.prepare(
      'INSERT INTO flavors (id, name, description, price, available, image_url, color, sort_order, category_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, description || null, price, available ? 1 : 0, image_url || null, color || null, sort_order || 0, category_id || null);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate', message: 'Ya existe un sabor con ese id' });
    throw e;
  }
  res.status(201).json(await req.db.prepare('SELECT * FROM flavors WHERE id = ?').get(id));
});

router.put('/:id', [authMiddleware, requireRole('admin')], async (req, res) => {
  const existing = await req.db.prepare('SELECT * FROM flavors WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['name', 'description', 'price', 'available', 'image_url', 'color', 'sort_order', 'category_id'];
  const updates = {};
  for (const k of allowed) if (k in (req.body || {})) updates[k] = req.body[k];
  if ('available' in updates) updates.available = updates.available ? 1 : 0;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await req.db.prepare(`UPDATE flavors SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(await req.db.prepare('SELECT * FROM flavors WHERE id = ?').get(req.params.id));
});

router.delete('/:id', [authMiddleware, requireRole('admin')], async (req, res) => {
  const result = await req.db.prepare('DELETE FROM flavors WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;
