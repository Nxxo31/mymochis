import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, requireRole , verifyJwt } from '../auth.js';

const router = Router();

function rowToPaymentMethod(r) {
  if (!r) return null;
  const accounts = db.prepare('SELECT * FROM payout_accounts WHERE method_id = ? ORDER BY is_default DESC, id').all(r.id);
  return { ...r, payout_accounts: accounts };
}

// Middleware OPCIONAL: puebla req.user si hay un Bearer valido y, si no, deja
// pasar la request sin el. Es lo que necesitan los GET publicos que ofrecen un
// extra al admin (include_inactive=1) sin cerrar la lectura al visitante.
// NO usar authMiddleware: ese devuelve 401 sin token y dejaria la tienda sin
// catalogo. Mismo fix que release-windows (2026-10-21): sin este middleware
// req.user nunca se pobla y `include_inactive === '1' && req.user` es siempre
// falso — el admin no puede ver ni reactivar lo que el mismo desactivo.
function optionalAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  req.user = token ? (verifyJwt(token) || null) : null;
  next();
}

router.get('/', optionalAuth, (req, res) => {
  const includeInactive = req.query.include_inactive === '1' && req.user;
  const sql = includeInactive
    ? 'SELECT * FROM payment_methods ORDER BY sort_order, label'
    : 'SELECT * FROM payment_methods WHERE active = 1 ORDER BY sort_order, label';
  const rows = db.prepare(sql).all().map(rowToPaymentMethod);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const row = rowToPaymentMethod(db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(req.params.id));
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
});

router.post('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const { code, label, instructions, qr_url, sort_order = 0, active = 1 } = req.body || {};
  if (!code || !label) return res.status(400).json({ error: 'bad_request', message: 'code y label son obligatorios' });
  try {
    const info = db.prepare('INSERT INTO payment_methods (code, label, instructions, qr_url, sort_order, active) VALUES (?, ?, ?, ?, ?, ?)')
      .run(code, label, instructions || null, qr_url || null, sort_order, active ? 1 : 0);
    res.status(201).json(rowToPaymentMethod(db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(info.lastInsertRowid)));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate', message: 'code ya existe' });
    throw e;
  }
});

router.put('/:id', [authMiddleware, requireRole('admin')], (req, res) => {
  const existing = db.prepare('SELECT id FROM payment_methods WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['code', 'label', 'instructions', 'qr_url', 'sort_order', 'active'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  if ('active' in updates) updates.active = updates.active ? 1 : 0;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE payment_methods SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(rowToPaymentMethod(db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', [authMiddleware, requireRole('admin')], (req, res) => {
  const result = db.prepare('DELETE FROM payment_methods WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;

