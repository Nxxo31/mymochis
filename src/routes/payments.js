// MyMochis · Payment routes
// Spec: PROJECT.md §22.10
// POST /api/payments — crear intent (idempotency)
// GET  /api/payments/:id — estado
// GET  /api/payments — lista (admin)
// POST /api/payments/:id/cancel — cancela pre-SUCCEEDED
// GET  /api/payments/:id/attempts — historial de attempts
import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../auth.js';
import { createPaymentIntent, getPayment, transitionState } from '../lib/payments/index.js';

const router = Router();

router.post('/', authMiddleware, async (req, res) => {
  const idempotencyKey = req.header('idempotency-key');
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }
  try {
    const out = await createPaymentIntent({ idempotencyKey, request: req.body });
    res.status(out.status).json(out.body);
  } catch (e) {
    console.error('[payments] create error', e);
    res.status(500).json({ error: 'internal', message: e.message });
  }
});

router.get('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const { state, order_id, from, to, limit } = req.query;
  const lim = Math.min(Number(limit) || 50, 200);
  const where = [];
  const params = [];
  if (state) { where.push('state = ?'); params.push(String(state)); }
  if (order_id) { where.push('order_id = ?'); params.push(String(order_id)); }
  if (from) { where.push('created_at >= ?'); params.push(String(from)); }
  if (to) { where.push('created_at <= ?'); params.push(String(to)); }
  const sql = `SELECT payment_id, order_id, amount_minor, currency, state, provider, created_at, updated_at
               FROM payments
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at DESC
               LIMIT ?`;
  params.push(lim);
  const rows = db.prepare(sql).all(...params);
  res.json({ payments: rows, count: rows.length });
});

router.get('/:id', authMiddleware, (req, res) => {
  const out = getPayment(req.params.id);
  if (!out) return res.status(404).json({ error: 'not_found' });
  if (req.user.role !== 'admin') {
    const order = db.prepare(`SELECT customer_phone FROM orders WHERE id = ?`).get(out.payment.order_id);
    if (!order || order.customer_phone !== req.user.phone) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }
  res.json(out);
});

router.get('/:id/attempts', [authMiddleware, requireRole('admin')], (req, res) => {
  const attempts = db.prepare(`SELECT * FROM payment_attempts WHERE payment_id = ? ORDER BY created_at ASC`).all(req.params.id);
  res.json({ attempts });
});

router.post('/:id/cancel', [authMiddleware, requireRole('admin')], (req, res) => {
  const p = db.prepare(`SELECT * FROM payments WHERE payment_id = ?`).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  if (p.state === 'SUCCEEDED' || p.state === 'FAILED' || p.state === 'EXPIRED') {
    return res.status(409).json({ error: 'cannot_cancel_terminal_state', current_state: p.state });
  }
  const out = transitionState(p.payment_id, p.state, 'EXPIRED', { reason: 'manual_cancel' });
  if (!out.ok) return res.status(409).json({ error: 'state_changed_by_other' });
  res.json({ ok: true, payment_id: p.payment_id, state: 'EXPIRED' });
});

export default router;

