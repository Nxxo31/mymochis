import { computeDeliveryFeeCents } from './delivery-fee.js';
import { businessClock } from './business-time.js';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function normalizedTime(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function timeMinutes(value) {
  const text = normalizedTime(value);
  if (!text || !TIME_PATTERN.test(text)) return null;
  const [hours, minutes] = text.split(':').map(Number);
  return hours * 60 + minutes;
}

export function validateDeliveryFreeRule(rule = {}) {
  const day = Number(rule.day_of_week);
  if (!Number.isInteger(day) || day < 0 || day > 6) return 'day_of_week debe ser un entero entre 0 y 6';
  const freeDelivery = Number(rule.free_delivery);
  if (!Number.isInteger(freeDelivery) || (freeDelivery !== 0 && freeDelivery !== 1)) return 'free_delivery debe ser 0 o 1';
  if (!String(rule.label || '').trim()) return 'label es obligatorio';
  const minOrder = Number(rule.min_order_cents);
  if (!Number.isInteger(minOrder) || minOrder < 0) return 'min_order_cents debe ser un entero mayor o igual a cero';
  for (const field of ['starts_at', 'ends_at']) {
    const value = normalizedTime(rule[field]);
    if (value && !TIME_PATTERN.test(value)) return `${field} debe ser HH:MM`;
  }
  const active = Number(rule.active);
  if (!Number.isInteger(active) || (active !== 0 && active !== 1)) return 'active debe ser 0 o 1';
  return null;
}

export function normalizeDeliveryFreeRule(rule = {}) {
  return {
    day_of_week: Number(rule.day_of_week),
    free_delivery: Number(rule.free_delivery),
    label: String(rule.label || '').trim().slice(0, 120),
    min_order_cents: Math.max(0, Math.round(Number(rule.min_order_cents) || 0)),
    starts_at: normalizedTime(rule.starts_at),
    ends_at: normalizedTime(rule.ends_at),
    active: Number(rule.active),
    notes: normalizedTime(rule.notes),
  };
}

export function deliveryRuleMatchesClock(rule, clock) {
  if (!rule || Number(rule.active) !== 1) return false;
  if (Number(rule.day_of_week) !== Number(clock.day_of_week)) return false;
  const starts = timeMinutes(rule.starts_at);
  const ends = timeMinutes(rule.ends_at);
  const current = Number(clock.minutes_of_day);
  if (starts == null && ends == null) return true;
  if (starts == null) return current <= ends;
  if (ends == null) return current >= starts;
  if (starts === ends) return true;
  if (starts < ends) return current >= starts && current <= ends;
  return current >= starts || current <= ends;
}

export function deliveryRuleSpecificity(rule) {
  const starts = normalizedTime(rule?.starts_at) ? 4 : 0;
  const ends = normalizedTime(rule?.ends_at) ? 4 : 0;
  const minimum = Number(rule?.min_order_cents) > 0 ? 1 : 0;
  return starts + ends + minimum;
}

export function selectDeliveryFreeRule(rules = [], clock = businessClock()) {
  const resolvedClock = clock?.business_date ? clock : businessClock(clock);
  const candidates = (Array.isArray(rules) ? rules : [])
    .filter(rule => deliveryRuleMatchesClock(rule, resolvedClock))
    .sort((a, b) => {
      const specificity = deliveryRuleSpecificity(b) - deliveryRuleSpecificity(a);
      if (specificity !== 0) return specificity;
      return Number(b.id || 0) - Number(a.id || 0);
    });
  return candidates[0] || null;
}

export function deliveryFreeDecision({ rules = [], subtotalCents = 0, nowMs = Date.now() } = {}) {
  const clock = businessClock(nowMs);
  let rule = null;
  try {
    rule = selectDeliveryFreeRule(rules, clock);
  } catch {}
  const rawSubtotal = Number(subtotalCents);
  const subtotal = Number.isFinite(rawSubtotal) ? Math.max(0, rawSubtotal) : 0;
  const minOrder = Math.max(0, Math.round(Number(rule?.min_order_cents) || 0));
  const freeDelivery = Boolean(rule) && Number(rule.free_delivery) === 1 && subtotal >= minOrder;
  return {
    rule,
    free_delivery: freeDelivery,
    min_order_cents: minOrder,
    subtotal_cents: subtotal,
    business_date: clock.business_date,
    business_tz: clock.business_tz,
    day_of_week: clock.day_of_week,
  };
}

export function validateDeliveryCoordinates(lat, lng) {
  const latEmpty = lat == null || String(lat).trim() === '';
  const lngEmpty = lng == null || String(lng).trim() === '';
  if (latEmpty && lngEmpty) return { lat: null, lng: null };
  if (latEmpty !== lngEmpty) return { error: 'coordinates_required_together' };
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return { error: 'lat_out_of_range' };
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return { error: 'lng_out_of_range' };
  return { lat: latitude, lng: longitude };
}

export function deliveryZoneRequirement(config = {}) {
  const radius = Math.max(0, Number(config.delivery_immediate_radius_km) || 0);
  const perKm = Math.max(0, Number(config.delivery_immediate_price_per_km_cents) || 0);
  const hasCenter = config.delivery_zone_center_lat != null && config.delivery_zone_center_lng != null;
  if ((radius > 0 || perKm > 0) && !hasCenter) return { ok: false, error: 'zone_not_configured' };
  return { ok: true, radius, perKm, hasCenter };
}

export function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const toRad = degrees => degrees * Math.PI / 180;
  const radiusKm = 6371;
  const deltaLat = toRad(lat2 - lat1);
  const deltaLng = toRad(lng2 - lng1);
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(deltaLng / 2) ** 2;
  return 2 * radiusKm * Math.asin(Math.sqrt(a));
}

export function evaluateDelivery({ config = {}, geo, address = '', rules = [], subtotalCents = 0, nowMs = Date.now() } = {}) {
  const decision = deliveryFreeDecision({ rules, subtotalCents, nowMs });
  const base = {
    business_date: decision.business_date,
    business_tz: decision.business_tz,
    delivery_free_rule: decision.rule,
    min_order_cents: decision.min_order_cents,
    distance_km: null,
    within_zone: false,
    fee_cents: null,
    free_delivery: false,
    delivery_free_applied: 0,
    delivery_free_rule_id: null,
  };
  if (!config.delivery_immediate_enabled) return { ...base, ok: false, error: 'immediate_disabled' };
  if (!String(address || '').trim()) return { ...base, ok: false, error: 'address_required' };
  const zone = deliveryZoneRequirement(config);
  if (!zone.ok) return { ...base, ok: false, error: zone.error };
  if (!geo || !Number.isFinite(Number(geo.lat)) || !Number.isFinite(Number(geo.lng))) {
    return { ...base, ok: false, error: 'geocode_failed' };
  }
  let distanceKm = null;
  if (zone.hasCenter) {
    distanceKm = haversineDistanceKm(
      Number(config.delivery_zone_center_lat),
      Number(config.delivery_zone_center_lng),
      Number(geo.lat),
      Number(geo.lng),
    );
  }
  const withinZone = distanceKm == null || zone.radius <= 0 || distanceKm <= zone.radius;
  const freeDelivery = withinZone && decision.free_delivery;
  const feeCents = withinZone
    ? computeDeliveryFeeCents(config, distanceKm, { freeDelivery })
    : null;
  return {
    ...base,
    ok: withinZone,
    error: withinZone ? null : 'out_of_zone',
    distance_km: distanceKm,
    within_zone: withinZone,
    fee_cents: feeCents,
    free_delivery: freeDelivery,
    delivery_free_applied: freeDelivery ? 1 : 0,
    delivery_free_rule_id: freeDelivery ? decision.rule?.id ?? null : null,
  };
}
