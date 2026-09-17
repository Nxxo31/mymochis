import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../auth.js';

const router = Router();

router.get('/', authMiddleware, (req, res) => {
  const { method_id } = req.query;
  let rows;
  if (method_id) {
    rows = db.prepare('SELECT * FROM payout_accounts WHERE method_id = ? ORDER BY is_default DESC, id').all(method_id);
  } else {
    rows = db.prepare(`
      SELECT pa.*, pm.code as method_code, pm.label as method_label
      FROM payout_accounts pa
      JOIN payment_methods pm ON pa.method_id = pm.id
      ORDER BY pm.sort_order, pa.is_default DESC, pa.id
    `).all();
  }
  res.json(rows);
});

router.get('/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM payout_accounts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
});

router.post('/', authMiddleware, (req, res) => {
  const { method_id, holder_name, account_ref, is_default = 0 } = req.body || {};
  if (!method_id || !holder_name || !account_ref) {
    return res.status(400).json({ error: 'bad_request', message: 'method_id, holder_name, account_ref son obligatorios' });
  }
  const method = db.prepare('SELECT id FROM payment_methods WHERE id = ?').get(method_id);
  if (!method) return res.status(400).json({ error: 'bad_request', message: 'method_id no existe' });

  if (is_default) {
    db.prepare('UPDATE payout_accounts SET is_default = 0 WHERE method_id = ?').run(method_id);
  }
  const info = db.prepare('INSERT INTO payout_accounts (method_id, holder_name, account_ref, is_default) VALUES (?, ?, ?, ?)')
    .run(method_id, holder_name, account_ref, is_default ? 1 : 0);
  res.status(201).json(db.prepare('SELECT * FROM payout_accounts WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/:id', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT * FROM payout_accounts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['holder_name', 'account_ref', 'is_default'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  if ('is_default' in updates) updates.is_default = updates.is_default ? 1 : 0;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  if (updates.is_default) {
    db.prepare('UPDATE payout_accounts SET is_default = 0 WHERE method_id = ?').run(existing.method_id);
  }
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE payout_accounts SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(db.prepare('SELECT * FROM payout_accounts WHERE id = ?').get(req.params.id));
});

router.delete('/:id', authMiddleware, (req, res) => {
  const result = db.prepare('DELETE FROM payout_accounts WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;