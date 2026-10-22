// MyMochis · Payment routes
// Spec: PROJECT.md §22.10
// POST   /api/payments                 — crear intent (idempotency)
// GET    /api/payments                 — lista (admin)
// GET    /api/payments/summary         — estado de caja + ledger + pendientes
// GET    /api/payments/:id             — estado
// GET    /api/payments/:id/attempts    — historial de attempts
// POST   /api/payments/:id/cancel      — cancela pre-SUCCEEDED
// POST   /api/payments/:id/refund      — reversa (spec §22.10)
// POST   /api/orders/:id/confirm-payment — pago manual (el caso real del negocio)
// GET    /api/payments/mismatches      — discrepancias detectadas
// GET    /api/payments/reconcile/runs  — historial del reconciler
//
// NOTA DE MONEDA: amount_minor, pese al nombre, es PESOS COP (misma unidad que
// orders.total). Ver lib/payments/index.js → validateCreateRequest.
import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../auth.js';
import { createPaymentIntent, getPayment, transitionState } from '../lib/payments/index.js';
import { confirmManualPayment, revertManualPayment, ManualPaymentError } from '../lib/payments/manual.js';

const router = Router();

router.post('/', authMiddleware, async (req, res) => {
  const idempotencyKey = req.header('idempotency-key');
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }

  // Un customer solo puede crear pagos para SU pedido. Antes no se validaba,
  // asi que cualquiera con el order_id de otro (que ya se puede obtener, ver el
  // fix de PII en orders.js) le adjuntaba su propio intent de pago y le
  // ensuciaba el ciclo de vida y el panel de cobros al operador.
  // Mismo criterio que GET /:id usa abajo: el telefono del JWT contra el del
  // pedido.
  const targetOrder = db.prepare('SELECT customer_phone FROM orders WHERE id = ?')
    .get(String(req.body?.order_id || ''));
  if (req.user?.role !== 'admin' && targetOrder) {
    const pedido = String(targetOrder.customer_phone || '').replace(/\D/g, '');
    const cliente = String(req.user?.phone || '').replace(/\D/g, '');
    if (!cliente || pedido !== cliente) {
      return res.status(404).json({ error: 'not_found' });
    }
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

// ============ RESUMEN FINANCIERO (admin) ============
// Lo que el operador mira primero: cuánto entró, qué sigue sin pagar y si el
// ledger cuadra. Todo en pesos COP.
router.get('/summary', [authMiddleware, requireRole('admin')], (req, res) => {
  const byState = db.prepare(`
    SELECT state, COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS total
    FROM payments GROUP BY state
  `).all();

  const today = new Date().toISOString().slice(0, 10);
  const todayCollected = db.prepare(`
    SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payments
    WHERE state = 'SUCCEEDED' AND date(created_at) = ?
  `).get(today).total;

  const month = today.slice(0, 7);
  const monthCollected = db.prepare(`
    SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payments
    WHERE state = 'SUCCEEDED' AND substr(created_at, 1, 7) = ?
  `).get(month).total;

  // Pedidos sin confirmar: el caso real del negocio (transferencia recibida,
  // el admin todavía no la marcó).
  const unconfirmed = db.prepare(`
    SELECT o.id, o.customer_name, o.customer_phone, o.total, o.pickup_day,
           o.payment_method_id, o.payment_status, o.created_at
    FROM orders o
    WHERE (o.payment_status IS NULL OR o.payment_status != 'paid')
      AND NOT EXISTS (
        SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.state = 'SUCCEEDED'
      )
    ORDER BY o.created_at DESC LIMIT 50
  `).all();

  // El ledger es la verdad contable: debe sumar cero por pago (debe+haber).
  const balances = db.prepare(`
    SELECT account, currency, COALESCE(SUM(amount_minor), 0) AS balance
    FROM ledger_entries GROUP BY account, currency
  `).all();

  const unbalanced = db.prepare(`
    SELECT p.payment_id, p.order_id, p.amount_minor, p.state,
           COALESCE(SUM(l.amount_minor), 0) AS ledger_sum
    FROM payments p
    LEFT JOIN ledger_entries l ON l.payment_id = p.payment_id
    WHERE p.state = 'SUCCEEDED'
    GROUP BY p.payment_id
    HAVING ledger_sum != 0
  `).all();

  const lastRun = db.prepare(`
    SELECT run_id, finished_at, status, checks_total, mismatches
    FROM reconciliation_runs ORDER BY started_at DESC LIMIT 1
  `).get();

  res.json({
    currency: 'COP',
    unit: 'pesos',
    by_state: byState,
    collected_today: todayCollected,
    collected_month: monthCollected,
    unconfirmed_count: unconfirmed.length,
    unconfirmed_total: unconfirmed.reduce((a, o) => a + Number(o.total), 0),
    unconfirmed,
    ledger_balances: balances,
    ledger_unbalanced: unbalanced,
    last_reconcile: lastRun || null,
  });
});

/** Discrepancias: pagos SUCCEEDED cuyo ledger no cuadra a cero. */
router.get('/mismatches', [authMiddleware, requireRole('admin')], (req, res) => {
  const rows = db.prepare(`
    SELECT p.payment_id, p.order_id, p.amount_minor, p.state, p.provider, p.created_at,
           COALESCE(SUM(l.amount_minor), 0) AS ledger_sum
    FROM payments p
    LEFT JOIN ledger_entries l ON l.payment_id = p.payment_id
    WHERE p.state IN ('SUCCEEDED','UNRESOLVED')
    GROUP BY p.payment_id
    HAVING ledger_sum != 0
    ORDER BY p.created_at DESC LIMIT 100
  `).all();
  res.json({ mismatches: rows, count: rows.length });
});

/** Historial del reconciler (spec §22.11). */
router.get('/reconcile/runs', [authMiddleware, requireRole('admin')], (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const runs = db.prepare(`
    SELECT run_id, started_at, finished_at, provider, status, checks_total, mismatches, details_json
    FROM reconciliation_runs ORDER BY started_at DESC LIMIT ?
  `).all(limit);
  res.json({ runs });
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

/**
 * Reversa (spec §22.10 POST /api/payments/:id/refund).
 * Solo pagos manuales se revierten aquí: los de proveedor requieren llamar al
 * API del proveedor, que todavía no está implementado (Nequi no expone refund
 * unificado; ver NequiAdapter.refund).
 */
router.post('/:id/refund', [authMiddleware, requireRole('admin')], (req, res) => {
  const { reason } = req.body || {};
  if (!reason || String(reason).trim().length < 5) {
    return res.status(400).json({ error: 'reason_required', message: 'Explica el motivo de la reversa (mínimo 5 caracteres)' });
  }
  try {
    res.json(revertManualPayment({ paymentId: req.params.id, actor: req.user?.email || 'admin', reason }));
  } catch (e) {
    if (e instanceof ManualPaymentError) {
      const status = e.code === 'payment_not_found' ? 404 : 409;
      return res.status(status).json({ error: e.code, message: e.message, details: e.details });
    }
    throw e;
  }
});

export default router;

