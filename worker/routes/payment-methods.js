import { Router } from '../router.js';
import { authMiddleware, requireRole } from '../auth.js';

const router = new Router();

async function rowToPaymentMethod(db, r) {
  if (!r) return null;
  const accounts = await db.prepare('SELECT * FROM payout_accounts WHERE method_id = ? ORDER BY is_default DESC, id').all(r.id);
  return { ...r, payout_accounts: accounts };
}

router.get('/', async (req, res) => {
  const includeInactive = req.query.include_inactive === '1' && req.user;
  const sql = includeInactive
    ? 'SELECT * FROM payment_methods ORDER BY sort_order, label'
    : 'SELECT * FROM payment_methods WHERE active = 1 ORDER BY sort_order, label';
  const rows = await req.db.prepare(sql).all();
  const out = [];
  for (const r of rows) out.push(await rowToPaymentMethod(req.db, r));
  res.json(out);
});

router.get('/:id', async (req, res) => {
  const row = await rowToPaymentMethod(req.db, await req.db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(req.params.id));
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
});

router.post('/', [authMiddleware, requireRole('admin')], async (req, res) => {
  const { code, label, instructions, qr_url, sort_order = 0, active = 1 } = req.body || {};
  if (!code || !label) return res.status(400).json({ error: 'bad_request', message: 'code y label son obligatorios' });
  try {
    const info = await req.db.prepare('INSERT INTO payment_methods (code, label, instructions, qr_url, sort_order, active) VALUES (?, ?, ?, ?, ?, ?)')
      .run(code, label, instructions || null, qr_url || null, sort_order, active ? 1 : 0);
    res.status(201).json(await rowToPaymentMethod(req.db, await req.db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(info.lastInsertRowid)));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate', message: 'code ya existe' });
    throw e;
  }
});

router.put('/:id', [authMiddleware, requireRole('admin')], async (req, res) => {
  const existing = await req.db.prepare('SELECT id FROM payment_methods WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['code', 'label', 'instructions', 'qr_url', 'sort_order', 'active'];
  const updates = {};
  for (const k of allowed) if (k in (req.body || {})) updates[k] = req.body[k];
  if ('active' in updates) updates.active = updates.active ? 1 : 0;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await req.db.prepare(`UPDATE payment_methods SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(await rowToPaymentMethod(req.db, await req.db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', [authMiddleware, requireRole('admin')], async (req, res) => {
  const result = await req.db.prepare('DELETE FROM payment_methods WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;
