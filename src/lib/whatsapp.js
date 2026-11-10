// WhatsApp dispatch multi-destinatario:
//   1. Deep-link wa.me (canal principal, $0): el cliente abre su WhatsApp con el
//      mensaje listo, dirigido al destinatario que el server eligió (round-robin
//      sobre los números activos de order_recipients).
//   2. Meta Cloud API (opcional): si WHATSAPP_CLOUD_* está configurado, el
//      server además envía el pedido a TODOS los números activos.
//
// Unidad de dinero: TODA la app (DB + catálogo + orders.total) maneja pesos COP
// (flavor.price 8000 = $8.000). Los nombres históricos "*_cents" son engañosos;
// NUNCA dividir entre 100 (bug corregido 2026-10-17).
//
// Env vars (todas opcionales):
//   WHATSAPP_CLOUD_TOKEN         – Meta WhatsApp Business API token
//   WHATSAPP_CLOUD_PHONE_ID      – sender phone id (numeric)
//   WHATSAPP_CLOUD_TEMPLATE      – approved template name (default: 'new_order_admin')
//   WHATSAPP_CLOUD_TEMPLATE_COURIER – plantilla para el domiciliario (default: 'new_delivery_courier')
//   WHATSAPP_CLOUD_LANG          – template language code (default: 'es_CO')

const CLOUD_BASE = 'https://graph.facebook.com/v20.0';

function fmtMoney(n) {
  const v = Number(n) || 0;
  return '$' + Math.round(v).toLocaleString('es-CO');
}

function fmtDay(yyyyMmDd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd || '')) return String(yyyyMmDd || '');
  const [y, m, d] = yyyyMmDd.split('-');
  return `${d}/${m}/${y}`;
}

function fmtWindow(start, end) {
  const f = (hhmm) => {
    if (!/^\d{2}:\d{2}$/.test(hhmm || '')) return '';
    const [h, m] = hhmm.split(':').map(Number);
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const ampm = h < 12 ? 'am' : 'pm';
    return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
  };
  const s = f(start);
  const e = f(end);
  if (!s && !e) return '';
  return `${s}–${e}`;
}

function customerName(s) { return (s || 'cliente').toString().slice(0, 60); }
function customerPhone(s) { return (s || '').toString().replace(/[^\d]/g, ''); }

function itemsList(items, flavors) {
  const lookup = new Map();
  for (const f of flavors || []) lookup.set(String(f.id), f);
  const lines = [];
  if (items && typeof items === 'object') {
    for (const [fid, qty] of Object.entries(items)) {
      const q = Number(qty);
      if (!(q > 0)) continue;
      const f = lookup.get(String(fid));
      const name = f ? f.name : `sabor ${fid}`;
      const unit = f ? Number(f.price) : null;
      const price = unit != null ? ` — ${fmtMoney(unit * q)}` : '';
      lines.push(`  • ${name} ×${q}${price}`);
    }
  }
  return lines.join('\n');
}

function combosList(combos, comboDefs) {
  const lookup = new Map();
  for (const c of comboDefs || []) lookup.set(String(c.id), c);
  const lines = [];
  for (const c of combos || []) {
    const id = String(c.id ?? c.combo_id ?? '');
    const def = lookup.get(id);
    const name = c.name || (def ? def.name : `combo ${id}`);
    const q = Number(c.qty || c.units || 1);
    const unit = def ? Number(def.price) : null;
    const price = unit != null ? ` — ${fmtMoney(unit * q)}` : '';
    lines.push(`  • ${name} ×${q}${price}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// MENSAJE DE PEDIDO (texto que abre el WhatsApp del cliente — 2026-10-17)
// Cambios vs versión anterior: incluye # de pedido (cruce con el dashboard),
// ventana de horario real del día (desde delivery_schedule), notas, y avisa
// que el pedido ya quedó registrado en el panel del negocio.
// ---------------------------------------------------------------------------
export function buildOrderMessage(order, ctx = {}) {
  const business = ctx.business_name || 'MyMochis';
  const lines = [];

  lines.push(`🍡 ¡Hola, ${business}! Me antojo de un pedido 🙌`);
  lines.push('');
  lines.push(`🧾 Pedido *#${order.id || ''}* · hecho en la web`);
  lines.push(`👤 Soy *${customerName(order.customer_name)}*`);
  const phone = customerPhone(order.customer_phone);
  if (phone) lines.push(`📞 Mi WhatsApp: ${phone}`);
  const window = fmtWindow(ctx.pickup_window_start, ctx.pickup_window_end);
  lines.push(`📅 Quiero recogerlo el *${fmtDay(order.pickup_day)}*${window ? ` (${window})` : ''}`);
  lines.push('');

  const itemsMd = itemsList(order.items, ctx.flavors);
  if (itemsMd) { lines.push('🍦 Sabores:'); lines.push(itemsMd); }
  const combosMd = combosList(order.combos, ctx.combos);
  if (combosMd) { lines.push('🍱 Combos:'); lines.push(combosMd); }

  lines.push('');
  lines.push(`💵 *Total: ${fmtMoney(order.total)} COP*`);
  if (order.notes) { lines.push(`📝 Notas: ${order.notes.toString().slice(0, 200)}`); }
  lines.push('');
  lines.push('_Este pedido ya quedó registrado en tu panel MyMochis 📋_');
  lines.push('¿Me confirmás disponibilidad? ¡Gracias! 🏮');
  return lines.join('\n');
}

export function buildDeepLink(phone, message) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  // 2026-10-17: api.whatsapp.com en vez de wa.me — el redirect de wa.me corrompe
  // los emojis 4-byte (🍡→U+FFFD). api.whatsapp.com/send preserva el texto tal cual.
  return `https://api.whatsapp.com/send/?phone=${digits}&text=${encodeURIComponent(message)}`;
}

async function cloudSendOne(meta, recipientPhone, opts = {}) {
  const token = process.env.WHATSAPP_CLOUD_TOKEN;
  const phoneId = process.env.WHATSAPP_CLOUD_PHONE_ID;
  const templateName = opts.template || process.env.WHATSAPP_CLOUD_TEMPLATE || 'new_order_admin';
  const lang = process.env.WHATSAPP_CLOUD_LANG || 'es_CO';
  if (!token || !phoneId) {
    return { status: 'skipped', error: null };
  }

  const url = `${CLOUD_BASE}/${phoneId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: recipientPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: lang },
      components: [
        { type: 'body', parameters: [
          { type: 'text', text: meta.short_message },
          { type: 'text', text: meta.full_message }
        ]}
      ]
    }
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const txt = await r.text();
    if (!r.ok) {
      return { status: 'failed', error: `cloud ${r.status}: ${txt.slice(0, 200)}` };
    }
    let payload = null;
    try { payload = JSON.parse(txt); } catch {}
    return { status: 'sent', error: null, message_id: payload?.messages?.[0]?.id || null };
  } catch (e) {
    return { status: 'failed', error: String(e?.message || e).slice(0, 200) };
  }
}

// ctx:
//   primaryPhone        – número elegido para el deep-link (round-robin en orders.js)
//   primary_label       – nombre del destinatario elegido
//   recipients          – [{ label, phone }] todos los activos (broadcast cloud)
//   business_name, flavors, combos, pickup_window_start, pickup_window_end
// Compat: ctx.adminPhone (un solo número) se acepta como fallback legacy.
export async function buildDispatch(order, ctx = {}) {
  const recipients = Array.isArray(ctx.recipients) && ctx.recipients.length
    ? ctx.recipients.map(r => ({ label: r.label || 'Admin', phone: String(r.phone || '').replace(/[^\d]/g, '') })).filter(r => r.phone)
    : [];

  let primary = null;
  if (ctx.primaryPhone) {
    primary = recipients.find(r => r.phone === String(ctx.primaryPhone).replace(/[^\d]/g, ''))
      || { label: ctx.primary_label || 'Admin', phone: String(ctx.primaryPhone).replace(/[^\d]/g, '') };
  } else if (recipients.length) {
    primary = recipients[0];
  } else if (ctx.adminPhone) {
    const legacy = String(ctx.adminPhone).replace(/[^\d]/g, '');
    if (legacy) { primary = { label: 'Admin', phone: legacy }; recipients.push(primary); }
  }

  const message = buildOrderMessage(order, ctx);
  const deepLink = primary ? buildDeepLink(primary.phone, message) : null;
  const shortMessage = `Pedido #${order.id} · ${customerName(order.customer_name)} · ${fmtMoney(order.total)}`;

  const cloudResults = [];
  for (const r of recipients) {
    const out = await cloudSendOne({ short_message: shortMessage, full_message: message }, r.phone);
    cloudResults.push({ label: r.label, phone: r.phone, cloud_status: out.status, cloud_error: out.error || null });
  }

  const statuses = new Set(cloudResults.map(r => r.cloud_status));
  let cloud_status;
  if (statuses.size === 0 || (statuses.size === 1 && statuses.has('skipped'))) cloud_status = 'skipped';
  else if (statuses.size === 1 && statuses.has('sent')) cloud_status = 'sent';
  else if (statuses.has('sent')) cloud_status = 'partial';
  else cloud_status = 'failed';
  const firstError = cloudResults.find(r => r.cloud_error)?.cloud_error || null;

  return {
    deep_link: deepLink,
    primary_phone: primary?.phone || null,
    primary_label: primary?.label || null,
    recipients_count: recipients.length,
    cloud_status,
    cloud_error: firstError,
    cloud_results: cloudResults
  };
}

// ---------------------------------------------------------------------------
// MENSAJE AL DOMICILIARIO (spec 57, r6 — 2026-11-05)
// Segunda plantilla WSP: cuando se asigna un reparto (automático o manual),
// el pedido llega al WhatsApp del domiciliario con la dirección, lo que debe
// cobrar y el deep link de respaldo a api.whatsapp.com. En la nube se envía
// con la plantilla new_delivery_courier (env WHATSAPP_CLOUD_TEMPLATE_COURIER).
// ---------------------------------------------------------------------------
export function buildCourierMessage(order, ctx = {}) {
  const lines = [];

  lines.push(`🛵 ¡Hola, ${customerName(ctx.courier_name)}! Te asignamos un domicilio`);
  lines.push('');
  lines.push(`🧾 Pedido *#${order.id || ''}*`);
  lines.push(`👤 Cliente: *${customerName(order.customer_name)}*`);
  const phone = customerPhone(order.customer_phone);
  if (phone) lines.push(`📞 WhatsApp del cliente: ${phone}`);
  const address = String(order.delivery_address || order.address || '').trim();
  if (address) lines.push(`📍 Dirección: ${address.slice(0, 200)}`);
  const window = fmtWindow(ctx.pickup_window_start, ctx.pickup_window_end);
  lines.push(`📅 Entrega: *${fmtDay(order.pickup_day)}*${window ? ` (${window})` : ''}`);
  lines.push('');

  const itemsMd = itemsList(order.items, ctx.flavors);
  if (itemsMd) { lines.push('🍦 Productos:'); lines.push(itemsMd); }
  const combosMd = combosList(order.combos, ctx.combos);
  if (combosMd) { lines.push('🍱 Combos:'); lines.push(combosMd); }

  lines.push('');
  if (String(order.payment_status) === 'paid') {
    lines.push('✅ El pedido ya está pagado. No cobres nada al entregar.');
  } else {
    lines.push(`💵 *Total a cobrar al entregar: ${fmtMoney(order.total)} COP*`);
  }
  if (order.notes) { lines.push(`📝 Notas: ${order.notes.toString().slice(0, 200)}`); }
  lines.push('');
  lines.push('_Gestiona el reparto desde tu portal MyMochis 🛵_');
  return lines.join('\n');
}

// ctx: flavors, combos, pickup_window_start, pickup_window_end
// (mismo formato que buildDispatch). courier: { id, name, phone }.
export async function buildCourierDispatch(order, courier, ctx = {}) {
  const courierPhone = String(courier?.phone || '').replace(/\D/g, '');
  const templateName = process.env.WHATSAPP_CLOUD_TEMPLATE_COURIER || 'new_delivery_courier';
  const message = buildCourierMessage(order, { ...ctx, courier_name: courier?.name });
  const deepLink = courierPhone ? buildDeepLink(courierPhone, message) : null;
  const shortMessage = `Domicilio #${order.id} · ${customerName(order.customer_name)} · ${fmtMoney(order.total)}`;

  let cloud = { status: 'skipped', error: null };
  if (courierPhone) {
    cloud = await cloudSendOne({ short_message: shortMessage, full_message: message }, courierPhone, {
      template: templateName,
    });
  }

  return {
    deep_link: deepLink,
    courier_phone: courierPhone || null,
    template: templateName,
    cloud_status: cloud.status,
    cloud_error: cloud.error,
    message
  };
}

export const _internal = { fmtMoney, fmtDay, fmtWindow, itemsList, combosList };
