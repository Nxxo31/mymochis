import { Router } from '../router.js';
import { authMiddleware, requireRole, verifyJwt } from '../auth.js';

const router = new Router();

const VALID_STATUS = ['draft', 'open', 'closed', 'completed'];

function rowToWindow(w, items = []) {
  return { ...w, items };
}

async function windowWithItems(db, id) {
  const w = await db.prepare('SELECT * FROM release_windows WHERE id = ?').get(id);
  if (!w) return null;
  const items = await db.prepare(`
    SELECT ri.*, f.name AS flavor_name, f.price AS flavor_price, f.color AS flavor_color
    FROM release_items ri
    LEFT JOIN flavors f ON f.id = ri.flavor_id
    WHERE ri.window_id = ?
    ORDER BY f.sort_order, ri.id
  `).all(id);
  return rowToWindow(w, items);
}

async function optionalUser(req) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return token ? verifyJwt(token, req.env) : null;
}

router.get('/', async (req, res) => {
  const user = await optionalUser(req);
  const isAdmin = user?.role === 'admin';
  const includeAll = isAdmin && req.query.include_all === '1';
  const status = req.query.status && VALID_STATUS.includes(req.query.status) ? req.query.status : null;

  let rows;
  if (status) {
    if (status === 'draft' && !includeAll) return res.json([]);
    rows = await req.db.prepare('SELECT * FROM release_windows WHERE status = ? ORDER BY release_date DESC, id DESC').all(status);
  } else if (includeAll) {
    rows = await req.db.prepare('SELECT * FROM release_windows ORDER BY release_date DESC, id DESC').all();
  } else {
    rows = await req.db.prepare("SELECT * FROM release_windows WHERE status IN ('open','closed','completed') ORDER BY release_date DESC, id DESC").all();
  }

  if (rows.length === 0) return res.json([]);

  const items = await req.db.prepare(`
    SELECT ri.*, f.name AS flavor_name, f.price AS flavor_price, f.color AS flavor_color
    FROM release_items ri
    LEFT JOIN flavors f ON f.id = ri.flavor_id
    WHERE ri.window_id IN (${rows.map(() => '?').join(',')})
    ORDER BY f.sort_order, ri.id
  `).all(...rows.map((r) => r.id));
  const byWindow = new Map();
  for (const it of items) {
    if (!byWindow.has(it.window_id)) byWindow.set(it.window_id, []);
    byWindow.get(it.window_id).push(it);
  }
  res.json(rows.map((w) => rowToWindow(w, byWindow.get(w.id) || [])));
});

router.get('/:id', async (req, res) => {
  const full = await windowWithItems(req.db, req.params.id);
  if (!full) return res.status(404).json({ error: 'not_found' });
  res.json(full);
});

router.post('/', [authMiddleware, requireRole('admin')], async (req, res) => {
  const { release_date, cutoff_at, status = 'draft', notes = null, items = [] } = req.body || {};
  if (!release_date || !cutoff_at) return res.status(400).json({ error: 'bad_request', message: 'release_date y cutoff_at son obligatorios' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(release_date)) return res.status(400).json({ error: 'bad_request', message: 'release_date debe ser YYYY-MM-DD' });
  if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: 'bad_request', message: `status debe ser uno de: ${VALID_STATUS.join(',')}` });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'bad_request', message: 'items debe ser un array no vacio' });

  for (const it of items) {
    if (!it.flavor_id || it.units_available == null) {
      return res.status(400).json({ error: 'bad_request', message: 'items[].flavor_id y units_available son obligatorios' });
    }
    const f = await req.db.prepare('SELECT id FROM flavors WHERE id = ?').get(it.flavor_id);
    if (!f) return res.status(400).json({ error: 'bad_request', message: `flavor_id ${it.flavor_id} no existe` });
  }

  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.flavor_id)) return res.status(400).json({ error: 'bad_request', message: `flavor_id ${it.flavor_id} duplicado en items` });
    seen.add(it.flavor_id);
  }

  const info = await req.db.prepare('INSERT INTO release_windows (release_date, cutoff_at, status, notes) VALUES (?, ?, ?, ?)')
    .run(release_date, cutoff_at, status, notes);
  const windowId = info.lastInsertRowid;

  try {
    const stmts = items.map(it =>
      req.dbD1.prepare('INSERT INTO release_items (window_id, flavor_id, units_available) VALUES (?, ?, ?)')
        .bind(windowId, it.flavor_id, it.units_available)
    );
    await req.db.batch(stmts);
  } catch (e) {
    await req.db.prepare('DELETE FROM release_windows WHERE id = ?').run(windowId);
    return res.status(400).json({ error: 'bad_request', message: String(e.message) });
  }

  res.status(201).json(await windowWithItems(req.db, windowId));
});

router.put('/:id', [authMiddleware, requireRole('admin')], async (req, res) => {
  const existing = await req.db.prepare('SELECT id FROM release_windows WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['release_date', 'cutoff_at', 'status', 'notes'];
  const updates = {};
  for (const k of allowed) if (k in (req.body || {})) updates[k] = req.body[k];
  if ('status' in updates && !VALID_STATUS.includes(updates.status)) {
    return res.status(400).json({ error: 'bad_request', message: 'status invalido' });
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await req.db.prepare(`UPDATE release_windows SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(await windowWithItems(req.db, req.params.id));
});

router.delete('/:id', [authMiddleware, requireRole('admin')], async (req, res) => {
  const result = await req.db.prepare('DELETE FROM release_windows WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;
