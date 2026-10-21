import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, requireRole, verifyJwt } from '../auth.js';

const router = Router();

const VALID_STATUS = ['draft', 'open', 'closed', 'completed'];

function rowToWindow(r) {
  if (!r) return null;
  const items = db.prepare(`
    SELECT ri.*, f.name as flavor_name, f.price as flavor_price, f.color as flavor_color
    FROM release_items ri
    JOIN flavors f ON ri.flavor_id = f.id
    WHERE ri.window_id = ?
    ORDER BY f.sort_order
  `).all(r.id);
  return { ...r, items };
}

// Middleware OPCIONAL: puebla req.user si hay un Bearer valido y, si no hay
// ninguno, deja pasar la request con req.user = undefined. Es lo que necesitan
// las rutas publicas que ofrecen un extra a los admins (include_all=1) sin
// cerrar la lectura para el visitante.
// NO usar authMiddleware aqui: ese devuelve 401 sin token y dejaria la tienda
// sin catalogo.
function optionalAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  req.user = token ? (verifyJwt(token) || null) : null;
  next();
}

// `optionalAuth` puebla req.user cuando hay un Bearer valido. Sin el,
// `req.user` es undefined y `include_all=1` queda muerto para TODOS, incluido
// el admin: verificado 2026-10-21 con un draft real en la DB, el admin recibia
// 0 drafts y el anonimo tambien. Falla cerrado (no habia fuga), pero el panel
// no podia revisar borradores antes de abrirlos.
router.get('/', optionalAuth, (req, res) => {
  const includeAll = req.query.include_all === '1' && req.user?.role === 'admin';
  const sql = includeAll
    ? 'SELECT * FROM release_windows ORDER BY release_date DESC, id DESC'
    : `SELECT * FROM release_windows WHERE status IN ('open','closed','completed') ORDER BY release_date DESC, id DESC`;
  const rows = db.prepare(sql).all().map(rowToWindow);
  res.json(rows);
});

router.get('/:id', optionalAuth, (req, res) => {
  const row = rowToWindow(db.prepare('SELECT * FROM release_windows WHERE id = ?').get(req.params.id));
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
});

router.post('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const { release_date, cutoff_at, status = 'draft', notes = null, items = [] } = req.body || {};
  if (!release_date || !cutoff_at) return res.status(400).json({ error: 'bad_request', message: 'release_date y cutoff_at son obligatorios' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(release_date)) return res.status(400).json({ error: 'bad_request', message: 'release_date debe ser YYYY-MM-DD' });
  if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: 'bad_request', message: `status debe ser uno de: ${VALID_STATUS.join(',')}` });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'bad_request', message: 'items debe ser un array no vacÃ­o' });

  const windowStmt = db.prepare('INSERT INTO release_windows (release_date, cutoff_at, status, notes) VALUES (?, ?, ?, ?)');
  const itemStmt = db.prepare('INSERT INTO release_items (window_id, flavor_id, units_available) VALUES (?, ?, ?)');
  const flavorExistsStmt = db.prepare('SELECT id FROM flavors WHERE id = ?');
  let windowId;
  db.exec('BEGIN');
  try {
    const info = windowStmt.run(release_date, cutoff_at, status, notes);
    windowId = info.lastInsertRowid;
    for (const it of items) {
      if (!it.flavor_id || it.units_available == null) throw new Error('items[].flavor_id y units_available son obligatorios');
      const f = flavorExistsStmt.get(it.flavor_id);
      if (!f) throw new Error(`flavor_id ${it.flavor_id} no existe`);
      itemStmt.run(windowId, it.flavor_id, it.units_available);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(400).json({ error: 'bad_request', message: e.message });
  }
  res.status(201).json(rowToWindow(db.prepare('SELECT * FROM release_windows WHERE id = ?').get(windowId)));
});

router.put('/:id', [authMiddleware, requireRole('admin')], (req, res) => {
  const existing = db.prepare('SELECT id FROM release_windows WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['release_date', 'cutoff_at', 'status', 'notes'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  if ('status' in updates && !VALID_STATUS.includes(updates.status)) {
    return res.status(400).json({ error: 'bad_request', message: `status invÃ¡lido` });
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE release_windows SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(rowToWindow(db.prepare('SELECT * FROM release_windows WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', [authMiddleware, requireRole('admin')], (req, res) => {
  const result = db.prepare('DELETE FROM release_windows WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;

