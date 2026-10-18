// WhatsApp dispatch multi-destinatario (versión Cloudflare Workers).
// Espejo de src/lib/whatsapp.js con dos diferencias de runtime:
//   - env (req.env) en lugar de process.env
//   - fetch nativo de Workers
// Unidad de dinero: pesos COP (nunca dividir entre 100).

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

async function cloudSendOne(env, meta, recipientPhone) {
  const token = env.WHATSAPP_CLOUD_TOKEN;
  const phoneId = env.WHATSAPP_CLOUD_PHONE_ID;
  const templateName = env.WHATSAPP_CLOUD_TEMPLATE || 'new_order_admin';
  const lang = env.WHATSAPP_CLOUD_LANG || 'es_CO';
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

export async function buildDispatch(env, order, ctx = {}) {
  const recipients = Array.isArray(ctx.recipients) && ctx.recipients.length
    ? ctx.recipients.map(r => ({ label: r.label || 'Admin', phone: String(r.phone || '').replace(/[^\d]/g, '') })).filter(r => r.phone)
    : [];

  let primary = null;
  if (ctx.primaryPhone) {
    primary = recipients.find(r => r.phone === String(ctx.primaryPhone).replace(/[^\d]/g, ''))
      || { label: ctx.primary_label || 'Admin', phone: String(ctx.primaryPhone).replace(/[^\d]/g, '') };
  } else if (recipients.length) {
    primary = recipients[0];
  }

  const message = buildOrderMessage(order, ctx);
  const deepLink = primary ? buildDeepLink(primary.phone, message) : null;
  const shortMessage = `Pedido #${order.id} · ${customerName(order.customer_name)} · ${fmtMoney(order.total)}`;

  const cloudResults = [];
  for (const r of recipients) {
    const out = await cloudSendOne(env, { short_message: shortMessage, full_message: message }, r.phone);
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

export const _internal = { fmtMoney, fmtDay, fmtWindow, itemsList, combosList };
