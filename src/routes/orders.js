import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../auth.js';

const router = Router();

const VALID_STATUS = ['pending', 'confirmed', 'ready', 'delivered', 'cancelled'];
const VALID_PAYMENT = ['pending', 'paid'];

function rowToOrder(r) {
  if (!r) return null;
  let items = {};
  let combos = [];
  try { items = JSON.parse(r.items_json || '{}'); } catch {}
  try { combos = JSON.parse(r.combos_json || '[]'); } catch {}
  return {
    id: r.id,
    created_at: r.created_at,
    customer_name: r.customer_name,
    customer_phone: r.customer_phone,
    pickup_day: r.pickup_day,
    items,
    combos,
    total: r.total,
    notes: r.notes,
    status: r.status,
    source: r.source,
    payment_status: r.payment_status,
    payment_method: r.payment_method
  };
}

router.get('/', authMiddleware, (req, res) => {
  const { status, day, week, q, limit = 100 } = req.query;
  const wheres = [];
  const params = [];
  if (status) { wheres.push('status = ?'); params.push(status); }
  if (day) { wheres.push('pickup_day = ?'); params.push(day); }
  if (q) { wheres.push('(customer_name LIKE ? OR customer_phone LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (week) {
    const yr = String(week).match(/^(\d{4})-W(\d{2})$/);
    if (yr) {
      wheres.push("strftime('%Y-W%W', created_at) = ?");
      params.push(week);
    }
  }
  const whereSql = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
  const sql = `SELECT * FROM orders ${whereSql} ORDER BY created_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, Number(limit) || 100);
  res.json(rows.map(rowToOrder));
});

router.get('/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(rowToOrder(row));
});

router.post('/', (req, res) => {
  const { id, customer_name, customer_phone, pickup_day, items, combos, total, notes, source } = req.body || {};
  if (!id || !customer_name || !customer_phone || !pickup_day || total == null) {
    return res.status(400).json({ error: 'bad_request', message: 'id, customer_name, customer_phone, pickup_day, total son obligatorios' });
  }
  try {
    db.prepare(
      `INSERT INTO orders (id, customer_name, customer_phone, pickup_day, items_json, combos_json, total, notes, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, customer_name, customer_phone, pickup_day,
          JSON.stringify(items || {}), JSON.stringify(combos || []),
          total, notes || null, source || 'web');
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate', message: 'Ya existe un pedido con ese id' });
    throw e;
  }
  res.status(201).json(rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id)));
});

router.patch('/:id', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['status', 'payment_status', 'payment_method', 'notes'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  if ('status' in updates && !VALID_STATUS.includes(updates.status)) {
    return res.status(400).json({ error: 'bad_request', message: `status inválido. Valores: ${VALID_STATUS.join(',')}` });
  }
  if ('payment_status' in updates && !VALID_PAYMENT.includes(updates.payment_status)) {
    return res.status(400).json({ error: 'bad_request', message: `payment_status inválido. Valores: ${VALID_PAYMENT.join(',')}` });
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE orders SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', authMiddleware, (req, res) => {
  const result = db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;