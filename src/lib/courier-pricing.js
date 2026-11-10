// MyMochis · Precio de recogida del domiciliario (spec 57, r4/r10).
//
// QUE RESUELVE
// Al asignar un reparto hay que saber cuanto le cuesta al negocio que el
// domiciliario vaya a buscar el pedido, y ese numero tiene que quedar
// CONGELADO:
//
//   1. base: la tarifa PROPIA del domiciliario (base + por km) aplicada a la
//      distancia entre el negocio (la zona del admin) y el domiciliario.
//   2. piso: nunca por debajo de lo que el domicilio le cuesta al negocio
//      (delivery_fee_cents) MAS un margen minimo (un % sobre ese costo y/o un
//      minimo por pedido). Es la regla de D18: "el costo reduce y se busca la
//      mayor rentabilidad con el modelo de negocio".
//   3. snapshot: el resultado se guarda en el pedido y en el reparto. El portal
//      muestra ESE numero, aunque el domicillero se mueva o el admin cambie
//      las reglas despues: lo que se cobra no cambia bajo los pies de quien
//      cobra.
//
// FALLBACK (r4/r10)
// Sin ubicacion conocida del domicillero, la distancia del negocio se toma de
// la del pedido (admin -> cliente). Si tampoco hay esa, no hay precio: se
// devuelve null con el motivo, nunca un numero inventado.
import { haversineDistanceKm } from './delivery-rules.js';

export const PICKUP_SOURCE = {
  TARIFF: 'tarifa_propia',
  FALLBACK: 'fallback_cliente',
  NONE: 'sin_ubicacion',
};

/**
 * El piso de margen: minimo por pedido y % sobre el costo (el mayor de los dos).
 *
 * @returns {{cost_cents:number, margin_pct:number, min_margin_cents:number,
 *            required_margin_cents:number, floor_cents:number}}
 */
export function courierMarginFloor({ costCents = 0, marginPct = 0, minMarginCents = 0 } = {}) {
  const cost = Math.max(0, Math.round(Number(costCents) || 0));
  const pct = Math.max(0, Number(marginPct) || 0);
  const minMargin = Math.max(0, Math.round(Number(minMarginCents) || 0));
  const required = Math.max(minMargin, Math.round((cost * pct) / 100));
  return {
    cost_cents: cost,
    margin_pct: pct,
    min_margin_cents: minMargin,
    required_margin_cents: required,
    floor_cents: cost + required,
  };
}

/**
 * Precio de recogida del domiciliario, con la tarifa propia + piso de margen.
 *
 * @param {object} courier  fila de couriers
 * @param {object} order    fila de orders (delivery_fee_cents, delivery_distance_km)
 * @param {object} config   fila de config (zona del negocio + reglas de margen)
 */
export function computeCourierPickup({ courier = {}, order = {}, config = {} } = {}) {
  const margin = courierMarginFloor({
    costCents: order?.delivery_fee_cents,
    marginPct: config?.courier_margin_pct,
    minMarginCents: config?.courier_min_margin_cents,
  });

  const adminLat = config?.delivery_zone_center_lat;
  const adminLng = config?.delivery_zone_center_lng;
  const hasAdmin = adminLat != null && adminLng != null;
  const hasCourier = courier?.lat != null && courier?.lng != null;

  let distanceKm = null;
  let source = PICKUP_SOURCE.NONE;
  let reason = null;

  if (hasAdmin && hasCourier) {
    distanceKm = haversineDistanceKm(
      Number(adminLat),
      Number(adminLng),
      Number(courier.lat),
      Number(courier.lng),
    );
    source = PICKUP_SOURCE.TARIFF;
  } else {
    reason = !hasAdmin ? 'negocio_sin_ubicacion' : 'domiciliario_sin_ubicacion';
    const fallback = Number(order?.delivery_distance_km);
    if (Number.isFinite(fallback)) {
      distanceKm = fallback;
      source = PICKUP_SOURCE.FALLBACK;
    }
  }

  const base = Number(courier?.base_fare_cents) || 0;
  const perKm = Number(courier?.price_per_km_cents) || 0;
  const raw = perKm > 0 ? base + perKm * (distanceKm ?? 0) : base;
  const own = distanceKm == null ? null : Math.max(0, Math.round(raw / 50) * 50);
  const cents = own == null ? null : Math.max(own, margin.floor_cents);

  return {
    distance_km: distanceKm,
    cents,
    base_cents: own,
    floor_cents: margin.floor_cents,
    cost_cents: margin.cost_cents,
    margin_cents: cents == null ? null : Math.max(0, cents - margin.cost_cents),
    margin_required_cents: margin.required_margin_cents,
    margin_pct: margin.margin_pct,
    min_margin_cents: margin.min_margin_cents,
    source,
    reason,
  };
}

/**
 * El snapshot congelado: el precio de recogida mas las reglas con las que se
 * calculo. Se guarda entero en el reparto para que el portal lo muestre tal
 * cual (y para poder auditar por que quedo asi).
 */
export function buildPickupSnapshot({ courier = {}, order = {}, config = {}, nowMs = Date.now() } = {}) {
  const pickup = computeCourierPickup({ courier, order, config });
  return {
    version: 1,
    computed_at: new Date(nowMs).toISOString(),
    courier_id: courier?.id ?? null,
    courier_name: courier?.name ?? null,
    base_fare_cents: Number(courier?.base_fare_cents) || 0,
    price_per_km_cents: Number(courier?.price_per_km_cents) || 0,
    courier_lat: courier?.lat ?? null,
    courier_lng: courier?.lng ?? null,
    admin_lat: config?.delivery_zone_center_lat ?? null,
    admin_lng: config?.delivery_zone_center_lng ?? null,
    ...pickup,
  };
}

export function parsePickupSnapshot(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
