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

router.get('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const days = parseDays(req.query.days);
  const all = db.prepare(`SELECT id, created_at, total, status, payment_status, customer_name, items_json, combos_json, pickup_day FROM orders`).all();
  const flavorRows = db.prepare('SELECT id, name, price, color FROM flavors').all();
  const flavorMap = new Map(flavorRows.map(f => [f.id, f]));
  const today = businessDate();
  const toDate = today;
  const rangeDatesList = rangeDates(days);
  const rangeStart = rangeDatesList[0];
  const sevenDaysAgoIso = new Date(Date.now() - 7 * 86400000).toISOString();

  const byStatus = { pending: 0, confirmed: 0, ready: 0, delivered: 0, cancelled: 0 };
  const byPayment = { pending: 0, paid: 0 };
  const byDay = {};
  const dayTotals = {};
  const dailySeries = {};
  const rangeDaily = new Map(rangeDatesList.map(date => [date, emptyDay(date)]));
  const weekdayTotals = Array.from({ length: 7 }, () => ({ orders: 0, gross: 0 }));
  const productDemand = new Map();
  const comboDemand = new Map();

  let gross = 0;
  let paid = 0;
  let count = 0;
  let todayCount = 0;
  let todayGross = 0;
  let last7 = 0;
  let last7Gross = 0;
  let cancelled = 0;
  let rangeOrders = 0;
  let rangeGross = 0;
  let rangePaidOrders = 0;
  let rangePaidGross = 0;

  for (const o of all) {
    const active = o.status !== 'cancelled';
    const paidOrder = o.payment_status === 'paid';
    const createdDate = businessDate(o.created_at);
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    byPayment[o.payment_status] = (byPayment[o.payment_status] || 0) + 1;
    byDay[o.pickup_day] = (byDay[o.pickup_day] || 0) + 1;
    if (!active) cancelled++;

    if (active) {
      gross += o.total;
      count++;
      if (createdDate === today) { todayCount++; todayGross += o.total; }
      if (o.created_at >= sevenDaysAgoIso) { last7++; last7Gross += o.total; }
      dailySeries[createdDate] = (dailySeries[createdDate] || 0) + o.total;
      const dow = weekdayForDate(createdDate);
      if (dow != null) {
        weekdayTotals[dow].orders++;
        weekdayTotals[dow].gross += o.total;
      }
    }

    if (paidOrder) paid += o.total;
    const inRange = active && createdDate >= rangeStart && createdDate <= toDate;
    if (inRange) {
      rangeOrders++;
      rangeGross += o.total;
      if (paidOrder) {
        rangePaidOrders++;
        rangePaidGross += o.total;
      }
      const day = rangeDaily.get(createdDate);
      if (day) {
        day.orders++;
        day.total += o.total;
        if (paidOrder) day.paid += o.total;
      }
    }

    const items = parseItems(o.items_json);
    for (const [fid, qtyRaw] of Object.entries(items)) {
      const qty = Number(qtyRaw) || 0;
      const flavor = flavorMap.get(fid);
      const current = productDemand.get(fid) || {
        id: fid,
        name: flavor?.name || fid,
        color: flavor?.color || null,
        units: 0,
        gross: 0,
      };
      current.units += qty;
      current.gross += qty * Number(flavor?.price || 0);
      productDemand.set(fid, current);
      if (inRange && rangeDaily.get(createdDate)) rangeDaily.get(createdDate).units += qty;
    }

    for (const combo of parseCombos(o.combos_json)) {
      const id = String(combo.id ?? combo.combo_id ?? '');
      if (!id) continue;
      const qty = Number(combo.qty ?? combo.units ?? 0) || 0;
      const current = comboDemand.get(id) || { id, name: combo.name || id, orders: qty };
      current.orders += qty;
      comboDemand.set(id, current);
    }

    const dowName = new Date(o.created_at).toLocaleDateString('es-CO', { weekday: 'long' });
    dayTotals[dowName] = (dayTotals[dowName] || 0) + 1;
  }

  const avgTicket = count ? Math.round(gross / count) : 0;
  const topFlavors = [...productDemand.values()].sort((a, b) => b.units - a.units).slice(0, 10).map(p => [p.id, p.units]);
  const series = Object.entries(dailySeries).sort().slice(-14).map(([date, total]) => ({ date, total }));
  const analysisSeries = rangeDatesList.map(date => ({ ...(rangeDaily.get(date) || emptyDay(date)) }));

  const heldOrders = all.filter(o => o.status !== 'cancelled' && o.payment_status !== 'paid');
  let heldFlavors = 0;
  let heldCombos = 0;
  const heldByDay = {};
  for (const o of heldOrders) {
    for (const qty of Object.values(parseItems(o.items_json))) heldFlavors += Number(qty) || 0;
    for (const c of parseCombos(o.combos_json)) heldCombos += Number(c?.qty ?? c?.units ?? 0) || 0;
    heldByDay[o.pickup_day] = (heldByDay[o.pickup_day] || 0) + 1;
  }

  const planRows = db.prepare(`
    SELECT rw.release_date, rw.status AS window_status, ri.flavor_id,
           ri.units_available, ri.units_reserved, ri.units_sold
    FROM release_items ri
    JOIN release_windows rw ON rw.id = ri.window_id
    WHERE rw.release_date >= ?
    ORDER BY rw.release_date, ri.flavor_id
  `).all(today);
  const planMap = new Map();
  for (const row of planRows) {
    const key = row.release_date + ':' + row.flavor_id;
    const current = planMap.get(key) || {
      release_date: row.release_date,
      flavor_id: row.flavor_id,
      flavor_name: flavorMap.get(row.flavor_id)?.name || row.flavor_id,
      planned: 0,
      reserved: 0,
      sold: 0,
      windows: 0,
    };
    current.planned += Number(row.units_available || 0);
    current.reserved += Number(row.units_reserved || 0);
    current.sold += Number(row.units_sold || 0);
    current.windows++;
    planMap.set(key, current);
  }

  const byWeekday = weekdayTotals.map((totals, index) => ({
    day_of_week: index,
    weekday: WEEKDAYS[index],
    orders: totals.orders,
    gross: totals.gross,
    avg_ticket: totals.orders ? Math.round(totals.gross / totals.orders) : 0,
  })).sort((a, b) => (a.day_of_week + 6) % 7 - (b.day_of_week + 6) % 7);

  res.json({
    totals: { count, gross, paid, pending: gross - paid, avg_ticket: avgTicket },
    today: { count: todayCount, gross: todayGross },
    last_7_days: { count: last7, gross: last7Gross },
    by_status: byStatus,
    by_payment: byPayment,
    by_pickup_day: byDay,
    by_created_weekday: dayTotals,
    top_flavors: topFlavors,
    daily_series: series,
    held_stock: {
      orders: heldOrders.length,
      units: heldFlavors + heldCombos,
      flavor_units: heldFlavors,
      combo_units: heldCombos,
      by_pickup_day: heldByDay,
      note: 'Unidades retenidas por pedidos sin confirmar el pago. No se liberan solas: cancela el pedido para devolverlas.'
    },
    analysis: {
      range_days: days,
      from_date: rangeStart,
      to_date: toDate,
      orders: rangeOrders,
      gross: rangeGross,
      paid_orders: rangePaidOrders,
      paid_gross: rangePaidGross,
      cancelled_orders: cancelled,
      avg_ticket: rangeOrders ? Math.round(rangeGross / rangeOrders) : 0,
      daily_series: analysisSeries,
      by_weekday: byWeekday,
      product_demand: [...productDemand.values()].sort((a, b) => b.units - a.units),
      combo_demand: [...comboDemand.values()].sort((a, b) => b.orders - a.orders),
      plan_vs_sold: [...planMap.values()].sort((a, b) => a.release_date.localeCompare(b.release_date) || a.flavor_name.localeCompare(b.flavor_name)),
    }
  });
});

export default router;
