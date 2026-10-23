// MyMochis · Notificación de pago confirmado al admin por WhatsApp
//
// Cuando un pago llega a SUCCEEDED (webhook automático de provider o confirmación
// manual del operador) el pedido debe llegar al dashboard y al WSP del admin
// junto con la información del cliente. Este módulo lo centraliza para que ambos
// caminos lo disparen sin duplicar lógica.
import { db } from '../../db.js';
import { buildDispatch } from '../whatsapp.js';

function dayOfWeekIso(yyyyMmDd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd || '')) return null;
  return new Date(`${yyyyMmDd}T00:00:00`).getUTCDay();
}

/**
 * Envía el pedido confirmado al WSP del admin (deep-link + broadcast cloud si
 * hay credenciales Meta). Devuelve el resultado de buildDispatch.
 */
export async function notifyOrderConfirmed(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { error: 'order_not_found' };

  const flavorList = db.prepare('SELECT id, name, price FROM flavors').all();
  const comboList = db.prepare('SELECT id, name, price FROM combos').all();
  const recipients = db.prepare('SELECT label, phone FROM order_recipients WHERE active = 1 ORDER BY sort_order ASC, id ASC')
    .all()
    .map((r) => ({ label: r.label, phone: String(r.phone || '').replace(/\D/g, '') }))
    .filter((r) => r.phone);

  let primary = null;
  if (recipients.length) {
    const orderCount = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    primary = recipients[orderCount % recipients.length];
  }

  const pickupDow = dayOfWeekIso(order.pickup_day);
  let sched = null;
  if (pickupDow != null) {
    sched = db.prepare(
      "SELECT start_time, end_time FROM delivery_schedule WHERE day_of_week = ? AND active = 1 AND mode IN ('pickup','both') ORDER BY id LIMIT 1"
    ).get(pickupDow);
  }

  return buildDispatch(order, {
    primaryPhone: primary?.phone || null,
    primary_label: primary?.label || null,
    recipients,
    business_name: null,
    flavors: flavorList,
    combos: comboList,
    pickup_window_start: sched?.start_time || null,
    pickup_window_end: sched?.end_time || null,
  });
}
