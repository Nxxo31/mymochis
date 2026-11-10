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
import { requestRefund, listRefunds, RefundError } from '../lib/payments/refunds.js';

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

/** Los reembolsos (admin): con su estado, su motivo y quien los pidio. */
router.get('/refunds', [authMiddleware, requireRole('admin')], (req, res) => {
  res.json({ refunds: listRefunds({ limit: req.query.limit }) });
});

/**
 * Cierre de caja del dia (spec 58, p6): cuanto efectivo se recogio, por quien
 * y por que pedido. El efectivo (pago contra entrega) va separado de las
 * transferencias.
 */
router.get('/cash-close', [authMiddleware, requireRole('admin')], (req, res) => {
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
    ? String(req.query.date)
    : new Date().toISOString().slice(0, 10);

  const filas = db.prepare(`
    SELECT o.id, o.total, o.cod_collected_by, o.cod_collected_at, o.courier_id, o.payment_method_id,
           c.name AS courier_name, c.phone AS courier_phone,
           pm.label AS method_label, pm.settlement
    FROM orders o
    LEFT JOIN couriers c ON c.id = o.courier_id
    LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
    WHERE o.cod_state = 'collected' AND date(o.cod_collected_at) = ?
    ORDER BY o.cod_collected_at ASC
  `).all(fecha);

  const porDomiciliario = new Map();
  let totalEfectivo = 0;
  for (const f of filas) {
    const key = f.cod_collected_by || `desconocido:${f.courier_id || '-'}`;
    const prev = porDomiciliario.get(key) || { actor: key, courier_name: f.courier_name, orders: 0, total: 0 };
    prev.orders += 1;
    prev.total += Number(f.total || 0);
    porDomiciliario.set(key, prev);
    totalEfectivo += Number(f.total || 0);
  }

  // Las transferencias del dia (lo que entro por pasarela o por cuenta).
  const electrnico = db.prepare(`
    SELECT COALESCE(SUM(p.amount_minor), 0) AS total, COUNT(*) AS n
    FROM payments p JOIN orders o ON o.id = p.order_id
    LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
    WHERE p.state = 'SUCCEEDED' AND date(p.updated_at) = ?
      AND COALESCE(pm.settlement, 'prepaid') <> 'cash_on_delivery'
  `).get(fecha);

  res.json({
    date: fecha,
    cash: {
      total: totalEfectivo,
      orders: filas.length,
      by_courier: [...porDomicillero.values()].sort((a, b) => b.total - a.total),
    },
    electronic: { total: Number(electrónico?.total || 0), payments: Number(electrónico?.n || 0) },
    movements: filas.map((f) => ({
      order_id: f.id,
      total: Number(f.total || 0),
      collected_at: f.cod_collected_at,
      collected_by: f.cod_collected_by,
      courier_name: f.courier_name,
      method: f.method_label,
    })),
  });
});

/**
 * Metricas de pagos (spec 58, p9): por metodo, por proveedor y por estado,
 * cuanto se tarda de la creacion al cobro, cuanto lleva pendiente cada pago
 * vivo y el mixto efectivo/electronico.
 */
router.get('/metrics', [authMiddleware, requireRole('admin')], (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}/.test(String(req.query.from || '')) ? String(req.query.from) : null;
  const to = /^\d{4}-\d{2}-\d{2}/.test(String(req.query.to || '')) ? String(req.query.to) : null;
  const rango = (col) => {
    const cond = [];
    const params = [];
    if (from) { cond.push(`date(${col}) >= date(?)`); params.push(from); }
    if (to) { cond.push(`date(${col}) <= date(?)`); params.push(to); }
    return { where: cond.length ? `AND ${cond.join(' AND ')}` : '', params };
  };

  const pRango = rango('p.created_at');
  const byState = db.prepare(`
    SELECT p.state, COUNT(*) AS n, COALESCE(SUM(p.amount_minor), 0) AS total
    FROM payments p WHERE 1=1 ${pRango.where}
    GROUP BY p.state ORDER BY n DESC
  `).all(...pRango.params);

  const byProvider = db.prepare(`
    SELECT COALESCE(p.provider, 'sin_proveedor') AS provider, COUNT(*) AS n,
           COALESCE(SUM(p.amount_minor), 0) AS total,
           SUM(CASE WHEN p.state = 'SUCCEEDED' THEN 1 ELSE 0 END) AS succeeded
    FROM payments p WHERE 1=1 ${pRango.where}
    GROUP BY provider ORDER BY n DESC
  `).all(...pRango.params);

  const byMethod = db.prepare(`
    SELECT COALESCE(pm.label, pm.code, 'sin metodo') AS method,
           COALESCE(pm.settlement, 'prepaid') AS settlement,
           COUNT(*) AS n, COALESCE(SUM(p.amount_minor), 0) AS total
    FROM payments p
    LEFT JOIN orders o ON o.id = p.order_id
    LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
    WHERE 1=1 ${pRango.where}
    GROUP BY method, settlement ORDER BY n DESC
  `).all(...pRango.params);

  // Tiempo desde la creacion hasta el cobro (solo los cobrados).
  const t = db.prepare(`
    SELECT AVG((julianday(p.updated_at) - julianday(p.created_at)) * 24 * 60) AS avg_minutes,
           MAX((julianday(p.updated_at) - julianday(p.created_at)) * 24 * 60) AS max_minutes,
           COUNT(*) AS n
    FROM payments p WHERE p.state = 'SUCCEEDED' ${pRango.where}
  `).get(...pRango.params);

  // Aging de lo que sigue pendiente: quantos lleva mas de 1h, 6h y 24h.
  const aging = db.prepare(`
    SELECT
      SUM(CASE WHEN (julianday('now') - julianday(p.created_at)) * 24 < 1 THEN 1 ELSE 0 END) AS under_1h,
      SUM(CASE WHEN (julianday('now') - julianday(p.created_at)) * 24 >= 1
                AND (julianday('now') - julianday(p.created_at)) * 24 < 6 THEN 1 ELSE 0 END) AS h1_6,
      SUM(CASE WHEN (julianday('now') - julianday(p.created_at)) * 24 >= 6
                AND (julianday('now') - julianday(p.created_at)) * 24 < 24 THEN 1 ELSE 0 END) AS h6_24,
      SUM(CASE WHEN (julianday('now') - julianday(p.created_at)) * 24 >= 24 THEN 1 ELSE 0 END) AS over_24h
    FROM payments p
    WHERE p.state IN ('INITIATED','REQUIRES_ACTION','REQUIRES_PAYMENT_METHOD','PROCESSING')
  `).get();

  const mix = db.prepare(`
    SELECT COALESCE(pm.settlement, 'prepaid') AS settlement, COUNT(*) AS n,
           COALESCE(SUM(p.amount_minor), 0) AS total
    FROM payments p
    LEFT JOIN orders o ON o.id = p.order_id
    LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
    WHERE p.state = 'SUCCEEDED' ${pRango.where}
    GROUP BY settlement
  `).all(...pRango.params);

  res.json({
    range: { from, to },
    by_state: byState,
    by_provider: byProvider,
    by_method: byMethod,
    time_to_success_minutes: {
      avg: t?.avg_minutes != null ? Math.round(t.avg_minutes * 10) / 10 : null,
      max: t?.max_minutes != null ? Math.round(t.max_minutes * 10) / 10 : null,
      payments: Number(t?.n || 0),
    },
    pending_aging: {
      under_1h: Number(aging?.under_1h || 0),
      h1_6: Number(aging?.h1_6 || 0),
      h6_24: Number(aging?.h6_24 || 0),
      over_24h: Number(aging?.over_24h || 0),
    },
    mix: mix.map((m) => ({
      settlement: m.settlement,
      payments: Number(m.n || 0),
      total: Number(m.total || 0),
    })),
  });
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
 * Reembolso (spec §22.10 POST /api/payments/:id/refund · spec 58, p8).
 *
 * Antes solo se aceptaban pagos manuales (provider='manual'); un pago de
 * proveedor se rechazaba porque "el refund del proveedor no estaba
 * implementado". Ahora el pago manual sigue por su camino contable y el de
 * proveedor se devuelve LLAMANDO al adapter: solo se marca REFUNDED si el
 * proveedor acepto el reembolso.
 *
 * Idempotencia: se acepta la cabecera Idempotency-Key. Repetir la misma
 * peticion devuelve el reembolso ya creado (no devuelve el dinero dos veces).
 */
router.post('/:id/refund', [authMiddleware, requireRole('admin')], async (req, res) => {
  const { reason } = req.body || {};
  if (!reason || String(reason).trim().length < 5) {
    return res.status(400).json({ error: 'reason_required', message: 'Explica el motivo de la reversa (mínimo 5 caracteres)' });
  }
  try {
    const out = await requestRefund({
      paymentId: req.params.id,
      reason,
      actor: req.user?.email || 'admin',
      idempotencyKey: req.headers['idempotency-key'] || null,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof RefundError) {
      return res.status(e.status).json({ error: e.code, message: e.message });
    }
    if (e instanceof ManualPaymentError) {
      const status = e.code === 'payment_not_found' ? 404 : 409;
      return res.status(status).json({ error: e.code, message: e.message, details: e.details });
    }
    throw e;
  }
});

export default router;

