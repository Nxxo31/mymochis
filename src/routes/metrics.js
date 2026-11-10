// MyMochis · Métricas del panel (spec 59, d3)
// GET /api/metrics?days=7      (legacy, compatible con tests existentes)
// GET /api/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD  (rango libre)
// Devuelve la forma legacy `analysis` (daily_series, by_weekday, product_demand,
// plan_vs_sold, from_date, to_date, range_days) más los nuevos desgloses de nivel
// superior: by_status, by_payment_method, by_delivery_mode, by_courier,
// by_dispatch_status, by_pickup_day y los totales del rango.
import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../auth.js';
import { businessDate, weekdayForDate } from '../lib/business-time.js';

const router = Router();
const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function parseDays(value) {
  const n = Math.round(Number(value));
  if (![7, 30, 90].includes(n)) return 14;
  return n;
}

function parseItems(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}
function parseCombos(json) {
  try { return JSON.parse(json || '[]'); } catch { return []; }
}

function emptyDay(date) {
  return { date, orders: 0, total: 0, paid: 0, units: 0 };
}

function rangeDates(days) {
  const out = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) out.push(businessDate(now - i * 86400000));
  return out;
}

function rangeClause(from, to) {
  const cond = [];
  const params = [];
  if (from) { cond.push('date(created_at) >= date(?)'); params.push(from); }
  if (to) { cond.push('date(created_at) <= date(?)'); params.push(to); }
  return { where: cond.length ? 'WHERE ' + cond.join(' AND ') : '', params };
}

router.get('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const { from, to } = req.query;
  const days = parseDays(req.query.days);
  const { where, params: p } = rangeClause(from, to);
  console.log('DEBUG metrics where:', where, 'params:', p, 'from:', from, 'to:', to);

  const all = db.prepare(`SELECT id, created_at, total, status, payment_status, customer_name, items_json, combos_json, pickup_day, delivery_mode, payment_method, courier_id, dispatch_id FROM orders ${where}`).all(...p);
  const flavorRows = db.prepare('SELECT id, name, price, color FROM flavors').all();
  const flavorMap = new Map(flavorRows.map(f => [f.id, f]));
  const comboRows = db.prepare('SELECT id, name, price FROM combos').all();
  const comboMap = new Map(comboRows.map(f => [f.id, f]));
  const today = businessDate();
  const toDate = to || today;
  const fromDate = from || rangeDates(days)[0];
  const rangeDaysList = rangeDates(days);
  const rangeDays = rangeDaysList.length;

  const byStatus = {};
  const byPaymentMethod = {};
  const byDeliveryMode = {};
  const byCourier = {};
  const byDispatchStatus = {};
  const byPickupDay = {};
  const dailySeries = {};
  const weekdayTotals = Array.from({ length: 7 }, () => ({ orders: 0, gross: 0 }));
  const productDemand = new Map();
  const comboDemand = new Map();
  const planVsSold = {};

  let gross = 0;
  let paid = 0;
  let count = 0;

  for (const o of all) {
    const active = o.status !== 'cancelled';
    const paidOrder = o.payment_status === 'paid';
    const createdDate = businessDate(o.created_at);

    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    byPaymentMethod[o.payment_method || 'sin_metodo'] = (byPaymentMethod[o.payment_method || 'sin_metodo'] || 0) + 1;
    byDeliveryMode[o.delivery_mode || 'scheduled'] = (byDeliveryMode[o.delivery_mode || 'scheduled'] || 0) + 1;
    byPickupDay[o.pickup_day] = (byPickupDay[o.pickup_day] || 0) + 1;
    if (o.dispatch_id) {
      const disp = db.prepare('SELECT status FROM dispatches WHERE id = ?').get(o.dispatch_id);
      byDispatchStatus[disp ? disp.status : 'sin_despacho'] = (byDispatchStatus[disp ? disp.status : 'sin_despacho'] || 0) + 1;
    }

    if (active) {
      gross += o.total;
      count++;
      dailySeries[createdDate] = (dailySeries[createdDate] || 0) + o.total;
      const dow = weekdayForDate(createdDate);
      if (dow != null) {
        weekdayTotals[dow].orders++;
        weekdayTotals[dow].gross += o.total;
      }
    }
    if (paidOrder) paid += o.total;

    const items = parseItems(o.items_json);
    for (const [fid, qtyRaw] of Object.entries(items)) {
      const qty = Number(qtyRaw) || 0;
      const flavor = flavorMap.get(fid);
      const cur = productDemand.get(fid) || { id: fid, name: flavor ? flavor.name : fid, units: 0, gross: 0 };
      cur.units += qty;
      cur.gross += qty * (flavor ? flavor.price : 0);
      productDemand.set(fid, cur);
    }
    for (const [cid, qtyRaw] of Object.entries(parseCombos(o.combos_json))) {
      const qty = Number(qtyRaw) || 0;
      const combo = comboMap.get(cid);
      const cur = comboDemand.get(cid) || { id: cid, name: combo ? combo.name : cid, units: 0, gross: 0 };
      cur.units += qty;
      cur.gross += qty * (combo ? combo.price : 0);
      comboDemand.set(cid, cur);
    }
  }

  const inRange = (createdDate) => createdDate >= fromDate && createdDate <= toDate;
  const inRangeOrders = all.filter(o => o.status !== 'cancelled' && inRange(o.created_at));
  const rangeOrders = inRangeOrders.length;
  const rangeGross = inRangeOrders.reduce((s, o) => s + o.total, 0);
  const rangePaidOrders = inRangeOrders.filter(o => o.payment_status === 'paid').length;
  const rangePaidGross = inRangeOrders.filter(o => o.payment_status === 'paid').reduce((s, o) => s + o.total, 0);

  // plan_vs_sold por ventana de liberación (solo ventanas futuras con plan)
  const planRows = db.prepare(`SELECT rw.id AS window_id, rw.release_date, ri.flavor_id, ri.units_available, ri.units_sold, ri.units_reserved, f.name AS flavor_name FROM release_windows rw JOIN release_items ri ON ri.window_id = rw.id JOIN flavors f ON f.id = ri.flavor_id WHERE rw.release_date >= ? ORDER BY rw.release_date, ri.flavor_id`).all(toDate);

  const courierRows = db.prepare('SELECT id, name FROM couriers WHERE active = 1').all();
  for (const c of courierRows) {
    const rows = all.filter(o => o.courier_id === c.id && o.status !== 'cancelled');
    if (rows.length) byCourier[c.name] = { n: rows.length, total: rows.reduce((s, o) => s + o.total, 0) };
  }

  res.json({
    range: { from: fromDate, to: toDate, range_days: rangeDays },
    totals: { count, gross: Math.round(gross * 100) / 100, paid: Math.round(paid * 100) / 100, cancelled: (byStatus.cancelled || 0) },
    by_status: Object.entries(byStatus).map(([status, n]) => ({ status, n })),
    by_payment_method: Object.entries(byPaymentMethod).map(([method, n]) => ({ method, n })),
    by_delivery_mode: Object.entries(byDeliveryMode).map(([mode, n]) => ({ mode, n })),
    by_courier: Object.entries(byCourier).map(([courier, v]) => ({ courier, n: v.n, total: v.total })),
    by_dispatch_status: Object.entries(byDispatchStatus).map(([status, n]) => ({ status, n })),
    by_pickup_day: Object.entries(byPickupDay).map(([day, n]) => ({ day, n })),
    analysis: {
      range_days: rangeDays,
      from_date: fromDate,
      to_date: toDate,
      daily_series: rangeDaysList.map(date => ({ date, orders: (dailySeries[date] || 0), paid: 0 })),
      by_weekday: weekdayTotals.map((w, i) => ({ weekday: WEEKDAYS[i], orders: w.orders, gross: w.gross })),
      product_demand: Object.values(productDemand),
      plan_vs_sold: planRows.map(r => ({ release_date: r.release_date, flavor_name: r.flavor_name, planned: r.units_available, sold: r.units_sold, reserved: r.units_reserved })),
    },
  });
});

export default router;
