import { Router } from 'express';
import { db } from '../db.js';
import { pickupCutoffFor } from './orders.js';
import { businessClock } from '../lib/business-time.js';
import { selectDeliveryFreeRule } from '../lib/delivery-rules.js';

const router = Router();

router.get('/', (req, res) => {
  const config = db.prepare('SELECT * FROM config WHERE id = 1').get();
  const flavors = db.prepare(`
    SELECT f.id, f.name, f.description, f.price, f.available, f.image_url, f.color, f.sort_order,
           f.category_id, c.name AS category_name, c.slug AS category_slug
    FROM flavors f
    LEFT JOIN categories c ON c.id = f.category_id
    WHERE f.available = 1
    ORDER BY c.sort_order, f.sort_order, f.name
  `).all();
  const combos = db.prepare(`
    SELECT id, name, units, price, description, compare_at_price, available, featured, image_url, sort_order
    FROM combos WHERE available = 1 ORDER BY sort_order, id
  `).all();
  const promos = db.prepare(`
    SELECT * FROM promos
    WHERE active = 1
      AND (starts_at IS NULL OR starts_at <= datetime('now'))
      AND (ends_at IS NULL OR ends_at >= datetime('now'))
  `).all();
  const categories = db.prepare('SELECT id, name, slug, sort_order FROM categories WHERE active = 1 ORDER BY sort_order, name').all();
  const paymentMethods = db.prepare(`
    SELECT pm.id, pm.code, pm.label, pm.instructions, pm.qr_url, pm.sort_order,
           pa.id AS payout_id, pa.holder_name, pa.account_ref, pa.is_default
    FROM payment_methods pm
    LEFT JOIN payout_accounts pa ON pa.method_id = pm.id
    WHERE pm.active = 1
    ORDER BY pm.sort_order, pa.is_default DESC, pa.id
  `).all();
  const paymentMethodsById = {};
  for (const r of paymentMethods) {
    if (!paymentMethodsById[r.id]) {
      paymentMethodsById[r.id] = {
        id: r.id, code: r.code, label: r.label, instructions: r.instructions,
        qr_url: r.qr_url, sort_order: r.sort_order, payout_accounts: []
      };
    }
    if (r.payout_id != null) {
      paymentMethodsById[r.id].payout_accounts.push({
        id: r.payout_id, holder_name: r.holder_name, account_ref: r.account_ref, is_default: r.is_default
      });
    }
  }
  const deliverySchedule = db.prepare(`
    SELECT * FROM delivery_schedule WHERE active = 1 ORDER BY day_of_week, sort_order, start_time
  `).all();
  let deliveryFreeRules = [];
  try {
    deliveryFreeRules = db.prepare(`
      SELECT * FROM delivery_free_rules WHERE active = 1 ORDER BY day_of_week, id
    `).all();
  } catch {}
  const clock = businessClock();
  const currentDeliveryFreeRule = selectDeliveryFreeRule(deliveryFreeRules, clock);
  const deliveryConfig = {
    delivery_immediate_enabled: config.delivery_immediate_enabled,
    delivery_immediate_fee_cents: config.delivery_immediate_fee_cents,
    delivery_immediate_base_fare_cents: config.delivery_immediate_base_fare_cents,
    delivery_immediate_price_per_km_cents: config.delivery_immediate_price_per_km_cents,
    delivery_immediate_radius_km: config.delivery_immediate_radius_km,
    delivery_immediate_min_order_cents: config.delivery_immediate_min_order_cents,
    delivery_immediate_eta_minutes: config.delivery_immediate_eta_minutes,
    delivery_zone_label: config.delivery_zone_label,
    delivery_zone_center_lat: config.delivery_zone_center_lat,
    delivery_zone_center_lng: config.delivery_zone_center_lng,
    delivery_zone_address: config.delivery_zone_address,
    delivery_zone_place_id: config.delivery_zone_place_id,
    delivery_default_cutoff_hours: config.delivery_default_cutoff_hours
  };
  const releaseWindows = db.prepare(`
    SELECT rw.id, rw.release_date, rw.cutoff_at, rw.status, rw.notes,
           ri.id AS item_id, ri.flavor_id, ri.units_available, ri.units_sold,
           ri.units_reserved,
           f.name AS flavor_name, f.price AS flavor_price, f.color AS flavor_color
    FROM release_windows rw
    LEFT JOIN release_items ri ON ri.window_id = rw.id
    LEFT JOIN flavors f ON f.id = ri.flavor_id
    WHERE rw.status IN ('open','closed','completed')
    ORDER BY rw.release_date DESC, rw.id DESC, f.sort_order
  `).all();
  const releaseWindowsById = {};
  // El cutoff es la regla que decide si una ventana ACEPTARA un pedido. El
  // cliente la necesita para no ofrecer una fecha que POST /api/orders va a
  // rechazar con un 400 `past_cutoff` despues de que el usuario lleno todo el
  // formulario. Se calcula aqui con la MISMA funcion que usa la validacion, de
  // modo que no haya dos copias de la regla que puedan divergir.
  // Se cachea por fecha: varias ventanas comparten fecha y la regla no depende
  // de la ventana, solo del dia de la semana y su horario.
  const activeSchedule = deliverySchedule.filter(s => s.active === 1);
  const cutoffCache = new Map();
  const cutoffFor = (releaseDate) => {
    if (!cutoffCache.has(releaseDate)) {
      cutoffCache.set(releaseDate, pickupCutoffFor(releaseDate, activeSchedule));
    }
    return cutoffCache.get(releaseDate);
  };
  for (const r of releaseWindows) {
    if (!releaseWindowsById[r.id]) {
      const cutoff = cutoffFor(r.release_date);
      releaseWindowsById[r.id] = {
        id: r.id, release_date: r.release_date, cutoff_at: r.cutoff_at,
        status: r.status, notes: r.notes,
        orderable: r.status === 'open' && cutoff.orderable,
        cutoff_computed_at: cutoff.cutoffAt,
        not_orderable_reason: r.status !== 'open' ? 'window_not_open' : cutoff.reason,
        items: []
      };
    }
    if (r.item_id != null) {
      releaseWindowsById[r.id].items.push({
        id: r.item_id, flavor_id: r.flavor_id, flavor_name: r.flavor_name,
        flavor_price: r.flavor_price, flavor_color: r.flavor_color,
        units_available: r.units_available,
        units_sold: r.units_sold,
        units_reserved: r.units_reserved,
        // Lo que de verdad se puede prometer: lo disponible menos lo ya
        // reservado por pedidos sin pagar y lo ya vendido. Con el modelo
        // anterior (available - sold) una reserva invisible contaba como
        // disponible y el cliente podia pedir algo que ya no habia.
        units_remaining: Math.max(0, r.units_available - (r.units_sold || 0) - (r.units_reserved || 0))
      });
    }
  }

  const igPosts = db.prepare(`
    SELECT ig_id, caption, media_url, permalink, media_type, posted_at
    FROM ig_posts
    WHERE media_url IS NOT NULL AND media_type != 'VIDEO'
    ORDER BY posted_at DESC
    LIMIT 8
  `).all();

  res.json({
    config,
    categories,
    flavors,
    combos,
    promos,
    payment_methods: Object.values(paymentMethodsById),
    delivery_schedule: deliverySchedule,
    delivery_config: deliveryConfig,
    delivery_free_rules: deliveryFreeRules,
    delivery_free_rule: currentDeliveryFreeRule,
    today_free_delivery: Boolean(currentDeliveryFreeRule && Number(currentDeliveryFreeRule.free_delivery) === 1),
    business_date: clock.business_date,
    business_tz: clock.business_tz,
    release_windows: Object.values(releaseWindowsById),
    ig_posts: igPosts
  });
});

export default router;