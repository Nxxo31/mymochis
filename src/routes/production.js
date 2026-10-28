import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../auth.js';

const router = Router();
const adminOnly = [authMiddleware, requireRole('admin')];

function roundCop(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function productionSettings() {
  return db.prepare(`
    SELECT production_units_per_batch, production_target_margin_pct,
           production_market_reference_cents, production_market_reference_date
    FROM config WHERE id = 1
  `).get();
}

router.get('/', adminOnly, (_req, res) => {
  const items = db.prepare('SELECT * FROM production_items ORDER BY created_at DESC').all();
  const cfg = productionSettings();
  res.json({
    items,
    units_per_batch: cfg?.production_units_per_batch ?? 50,
    target_margin_pct: cfg?.production_target_margin_pct ?? 70,
    market_reference_cents: cfg?.production_market_reference_cents ?? 0,
    market_reference_date: cfg?.production_market_reference_date ?? null,
  });
});

router.post('/', adminOnly, (req, res) => {
  const { name, unit, unit_cost_cents, qty_per_batch } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'bad_request', message: 'El insumo necesita un nombre.' });
  }
  const cost = roundCop(unit_cost_cents);
  const qty = Number(qty_per_batch);
  if (cost <= 0 || !Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: 'bad_request', message: 'El costo y la cantidad por lote deben ser mayores que cero.' });
  }
  const info = db.prepare('INSERT INTO production_items (name, unit, unit_cost_cents, qty_per_batch) VALUES (?, ?, ?, ?)')
    .run(String(name).trim().slice(0, 80), String(unit || 'unidad').slice(0, 24), cost, qty);
  res.status(201).json(db.prepare('SELECT * FROM production_items WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/settings', adminOnly, (req, res) => {
  const { units_per_batch, target_margin_pct, market_reference_cents, market_reference_date } = req.body || {};
  const updates = {};
  if (units_per_batch != null) updates.production_units_per_batch = clampInt(units_per_batch, 1, 10000);
  if (target_margin_pct != null) updates.production_target_margin_pct = clampInt(target_margin_pct, 1, 99);
  if (market_reference_cents != null) updates.production_market_reference_cents = roundCop(market_reference_cents);
  if (market_reference_date !== undefined) updates.production_market_reference_date = normalizeDate(market_reference_date);
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE config SET ${setSql} WHERE id = 1`).run(...Object.values(updates));
  res.json(productionSettings());
});

router.put('/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM production_items WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not_found', message: 'El insumo no existe.' });
  const body = req.body || {};
  const name = body.name === undefined ? existing.name : String(body.name).trim().slice(0, 80);
  const unit = body.unit === undefined ? existing.unit : String(body.unit || 'unidad').slice(0, 24);
  const cost = body.unit_cost_cents === undefined ? Number(existing.unit_cost_cents) : roundCop(body.unit_cost_cents);
  const qty = body.qty_per_batch === undefined ? Number(existing.qty_per_batch) : Number(body.qty_per_batch);
  if (!name) return res.status(400).json({ error: 'bad_request', message: 'El insumo necesita un nombre.' });
  if (cost <= 0 || !Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: 'bad_request', message: 'El costo y la cantidad por lote deben ser mayores que cero.' });
  }
  db.prepare('UPDATE production_items SET name = ?, unit = ?, unit_cost_cents = ?, qty_per_batch = ? WHERE id = ?')
    .run(name, unit, cost, qty, id);
  res.json(db.prepare('SELECT * FROM production_items WHERE id = ?').get(id));
});

router.delete('/:id', adminOnly, (req, res) => {
  const r = db.prepare('DELETE FROM production_items WHERE id = ?').run(Number(req.params.id));
  if (r.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

router.post('/apply-suggested', adminOnly, (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'confirmation_required', message: 'Confirma que querés actualizar los precios.' });
  }
  const cfg = productionSettings();
  const units = Math.max(1, Number(cfg?.production_units_per_batch) || 50);
  const targetPct = Math.min(99, Math.max(1, Number(cfg?.production_target_margin_pct) || 1));
  const items = db.prepare('SELECT unit_cost_cents, qty_per_batch FROM production_items').all();
  const batchCost = items.reduce((acc, it) => acc + Math.round(Number(it.unit_cost_cents) * Number(it.qty_per_batch)), 0);
  const unitCost = batchCost > 0 ? Math.round(batchCost / units) : 0;
  if (unitCost <= 0) return res.status(400).json({ error: 'no_cost', message: 'Primero agregá insumos para calcular el precio sugerido.' });
  const suggested = Math.ceil((unitCost / (1 - targetPct / 100)) / 50) * 50;
  const info = db.prepare('UPDATE flavors SET price = ? WHERE price IS NOT NULL').run(suggested);
  res.json({ ok: true, updated: info.changes, price_cents: suggested });
});

router.get('/summary', adminOnly, (_req, res) => {
  const cfg = productionSettings();
  const units = Math.max(1, Number(cfg?.production_units_per_batch) || 50);
  const targetPct = Math.min(99, Math.max(0, Number(cfg?.production_target_margin_pct) || 0));
  const marketReference = Math.max(0, Number(cfg?.production_market_reference_cents) || 0);
  const marketDate = cfg?.production_market_reference_date || null;

  const items = db.prepare('SELECT unit_cost_cents, qty_per_batch FROM production_items').all();
  const batchCost = items.reduce((acc, it) => acc + Math.round(Number(it.unit_cost_cents) * Number(it.qty_per_batch)), 0);
  const unitCost = batchCost > 0 ? Math.round(batchCost / units) : 0;
  let suggested = null;
  if (unitCost > 0 && targetPct > 0) suggested = Math.ceil((unitCost / (1 - targetPct / 100)) / 50) * 50;

  const flavors = db.prepare('SELECT id, name, price, color, available FROM flavors ORDER BY name').all();
  const soldByFlavor = db.prepare(`
    SELECT flavor_id,
           COALESCE(SUM(units_sold), 0) AS sold,
           COALESCE(SUM(units_reserved), 0) AS reserved,
           COALESCE(SUM(units_available), 0) AS planned
    FROM release_items GROUP BY flavor_id
  `).all();
  const soldMap = new Map(soldByFlavor.map(r => [r.flavor_id, r]));
  const combos = db.prepare('SELECT id, name, units, price, units_sold, units_reserved, units_available FROM combos ORDER BY name').all();

  const soldFlavorUnits = soldByFlavor.reduce((acc, r) => acc + Number(r.sold || 0), 0);
  const soldComboOrders = combos.reduce((acc, c) => acc + Number(c.units_sold || 0), 0);
  const soldComboUnits = combos.reduce((acc, c) => acc + Number(c.units_sold || 0) * Math.max(1, Number(c.units) || 1), 0);

  const sales = db.prepare(`
    SELECT COUNT(*) AS orders_n, COALESCE(SUM(total), 0) AS gross
    FROM orders
    WHERE status != 'cancelled' AND payment_status = 'paid'
  `).get();
  const avgTicket = sales.orders_n > 0 ? Math.round(sales.gross / sales.orders_n) : null;

  const pricedFlavors = flavors.filter(f => Number(f.price) > 0);
  const catalogAvgPrice = pricedFlavors.length
    ? Math.round(pricedFlavors.reduce((acc, f) => acc + Number(f.price), 0) / pricedFlavors.length)
    : 0;
  const marginVsCatalog = unitCost > 0 && catalogAvgPrice > 0
    ? Math.round((1 - unitCost / catalogAvgPrice) * 100)
    : null;
  const marketPosition = marketReference > 0 && catalogAvgPrice > 0
    ? Math.round(((catalogAvgPrice - marketReference) / marketReference) * 100)
    : null;

  const catalogProducts = flavors.map(f => {
    const price = Number(f.price) || 0;
    const sold = Number(soldMap.get(f.id)?.sold || 0);
    const reserved = Number(soldMap.get(f.id)?.reserved || 0);
    const planned = Number(soldMap.get(f.id)?.planned || 0);
    const margin = price > 0 && unitCost > 0 ? Math.round((1 - unitCost / price) * 100) : null;
    const delta = margin != null ? margin - targetPct : null;
    return {
      id: f.id,
      name: f.name,
      color: f.color,
      available: f.available,
      price_cents: price,
      suggested_price_cents: suggested,
      units_sold: sold,
      units_reserved: reserved,
      units_planned: planned,
      margin_pct: margin,
      target_margin_pct: targetPct,
      delta_margin_pct: delta,
      action: delta == null ? 'configure' : delta < -5 ? 'increase_price' : delta > 15 ? 'review_price' : 'ok',
    };
  });

  res.json({
    items_count: items.length,
    units_per_batch: units,
    target_margin_pct: targetPct,
    batch_cost_cents: batchCost,
    unit_cost_cents: unitCost,
    suggested_price_cents: suggested,
    sold_flavor_units: soldFlavorUnits,
    sold_combo_orders: soldComboOrders,
    sold_combo_units: soldComboUnits,
    sold_units_total: soldFlavorUnits + soldComboUnits,
    paid_orders: sales.orders_n,
    gross_revenue_cents: sales.gross,
    avg_ticket_cents: avgTicket,
    catalog_avg_price_cents: catalogAvgPrice,
    margin_vs_catalog_pct: marginVsCatalog,
    market_reference_cents: marketReference,
    market_reference_date: marketDate,
    market_position_pct: marketPosition,
    catalog_products: catalogProducts,
  });
});

export default router;
