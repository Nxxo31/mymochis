import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../auth.js';

const router = Router();

router.get('/', authMiddleware, (req, res) => {
  const all = db.prepare(`SELECT id, created_at, total, status, payment_status, customer_name, items_json, combos_json FROM orders`).all();

  const byDay = {};
  const byStatus = { pending: 0, confirmed: 0, ready: 0, delivered: 0, cancelled: 0 };
  const byPayment = { pending: 0, paid: 0 };
  let gross = 0, paid = 0, count = 0;
  const today = new Date().toISOString().slice(0, 10);
  let todayCount = 0, todayGross = 0;
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  let last7 = 0, last7Gross = 0;

  const flavorTotals = {};
  const dayTotals = {};
  const dailySeries = {};
  const tickets = [];

  for (const o of all) {
    gross += o.total;
    count++;
    tickets.push(o.total);
    if (o.payment_status === 'paid') paid += o.total;
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    byPayment[o.payment_status] = (byPayment[o.payment_status] || 0) + 1;
    byDay[o.pickup_day] = (byDay[o.pickup_day] || 0) + 1;

    if (o.created_at.slice(0, 10) === today) { todayCount++; todayGross += o.total; }
    if (o.created_at >= sevenDaysAgo) { last7++; last7Gross += o.total; }

    const dayKey = o.created_at.slice(0, 10);
    dailySeries[dayKey] = (dailySeries[dayKey] || 0) + o.total;

    let items = {};
    try { items = JSON.parse(o.items_json || '{}'); } catch {}
    for (const [fid, qty] of Object.entries(items)) {
      flavorTotals[fid] = (flavorTotals[fid] || 0) + qty;
    }

    const dow = new Date(o.created_at).toLocaleDateString('es-CO', { weekday: 'long' });
    dayTotals[dow] = (dayTotals[dow] || 0) + 1;
  }

  const avgTicket = count ? Math.round(gross / count) : 0;
  const topFlavors = Object.entries(flavorTotals).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const series = Object.entries(dailySeries).sort().slice(-14).map(([date, total]) => ({ date, total }));

  res.json({
    totals: { count, gross, paid, pending: gross - paid, avg_ticket: avgTicket },
    today: { count: todayCount, gross: todayGross },
    last_7_days: { count: last7, gross: last7Gross },
    by_status: byStatus,
    by_payment: byPayment,
    by_pickup_day: byDay,
    by_created_weekday: dayTotals,
    top_flavors: topFlavors,
    daily_series: series
  });
});

export default router;