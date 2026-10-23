// MyMochis · Producción — insumos, costeo por lote y rentabilidad (spec_id=30 G3)
//
// Modelo de los software de costeo food (meez/ChefMargin/Supy):
//   insumo × cantidad por lote  →  costo del lote
//   costo del lote / unidades  →  costo por unidad (porción)
//   margen objetivo            →  precio de venta sugerido
// Y el contraste con la realidad: unidades vendidas, ticket promedio y margen
// real sobre las ventas del negocio (lo que el operador pidió: análisis de
// datos de producción CONTRA las estadísticas del panel).
import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../auth.js';

const router = Router();
const adminOnly = [authMiddleware, requireRole('admin')];

router.get('/', adminOnly, (req, res) => {
  const items = db.prepare('SELECT * FROM production_items ORDER BY created_at DESC').all();
  const cfg = db.prepare('SELECT production_units_per_batch, production_target_margin_pct FROM config WHERE id = 1').get();
  res.json({ items, units_per_batch: cfg?.production_units_per_batch ?? 50, target_margin_pct: cfg?.production_target_margin_pct ?? 70 });
});

router.post('/', adminOnly, (req, res) => {
  const { name, unit, unit_cost_cents, qty_per_batch } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'bad_request', message: 'El insumo necesita un nombre.' });
  }
  const cost = Math.max(0, Number(unit_cost_cents) || 0);
  const qty = Math.max(0, Number(qty_per_batch) || 0);
  if (cost <= 0 || qty <= 0) {
    return res.status(400).json({ error: 'bad_request', message: 'El costo y la cantidad por lote deben ser mayores que cero.' });
  }
  const info = db.prepare('INSERT INTO production_items (name, unit, unit_cost_cents, qty_per_batch) VALUES (?, ?, ?, ?)')
    .run(String(name).trim().slice(0, 80), String(unit || 'unidad').slice(0, 24), Math.round(cost), qty);
  res.status(201).json(db.prepare('SELECT * FROM production_items WHERE id = ?').get(info.lastInsertRowid));
});

router.delete('/:id', adminOnly, (req, res) => {
  const r = db.prepare('DELETE FROM production_items WHERE id = ?').run(Number(req.params.id));
  if (r.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

router.put('/settings', adminOnly, (req, res) => {
  const { units_per_batch, target_margin_pct } = req.body || {};
  const updates = {};
  if (units_per_batch != null) {
    const u = Math.max(1, Math.round(Number(units_per_batch) || 1));
    updates.production_units_per_batch = u;
  }
  if (target_margin_pct != null) {
    const m = Math.min(99, Math.max(1, Math.round(Number(target_margin_pct) || 1)));
    updates.production_target_margin_pct = m;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE config SET ${setSql} WHERE id = 1`).run(...Object.values(updates));
  const cfg = db.prepare('SELECT production_units_per_batch, production_target_margin_pct FROM config WHERE id = 1').get();
  res.json(cfg);
});

// El resumen que contrasta la producción con las ventas reales.
router.get('/summary', adminOnly, (req, res) => {
  const cfg = db.prepare('SELECT production_units_per_batch, production_target_margin_pct FROM config WHERE id = 1').get();
  const units = Math.max(1, Number(cfg?.production_units_per_batch) || 50);
  const targetPct = Math.min(99, Math.max(0, Number(cfg?.production_target_margin_pct) || 0));

  const items = db.prepare('SELECT unit_cost_cents, qty_per_batch FROM production_items').all();
  const batchCost = items.reduce((a, it) => a + Math.round(Number(it.unit_cost_cents) * Number(it.qty_per_batch)), 0);
  const unitCost = batchCost > 0 ? Math.round(batchCost / units) : 0;

  // Precio sugerido: cubrir el costo + el margen objetivo, redondeado a $50.
  let suggested = null;
  if (unitCost > 0 && targetPct > 0) {
    suggested = Math.ceil((unitCost / (1 - targetPct / 100)) / 50) * 50;
  }

  // Contraste con las ventas reales del negocio.
  const soldFlavors = db.prepare('SELECT COALESCE(SUM(units_sold), 0) AS n FROM release_items').get().n;
  const soldCombos = db.prepare('SELECT COALESCE(SUM(units_sold), 0) AS n FROM combos').get().n;
  const sales = db.prepare(`SELECT COUNT(*) AS orders_n, COALESCE(SUM(total), 0) AS gross FROM orders WHERE status != 'cancelled'`).get();

  const avgTicket = sales.orders_n > 0 ? Math.round(sales.gross / sales.orders_n) : null;
  const marginVsAvg = avgTicket && unitCost > 0 ? Math.round((1 - unitCost / avgTicket) * 100) : null;

  res.json({
    items_count: items.length,
    units_per_batch: units,
    target_margin_pct: targetPct,
    batch_cost_cents: batchCost,
    unit_cost_cents: unitCost,
    suggested_price_cents: suggested,
    sold_units_total: soldFlavors + soldCombos,
    paid_orders: sales.orders_n,
    gross_revenue_cents: sales.gross,
    avg_ticket_cents: avgTicket,
    margin_vs_avg_ticket_pct: marginVsAvg,
  });
});

export default router;
