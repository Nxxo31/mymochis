// MyMochis · Tarifa de domicilio por distancia
//
// Modelo estilo apps de transporte de Colombia (DiDi/Rappi): tarifa base +
// precio por kilómetro, redondeado a $50 para que el número se lea bien.
//
// UNIDAD: como TODA la app, los *_cents son PESOS COP (ver PROJECT.md §20 —
// flavor.price 8000 = $8.000). base_fare_cents 3500 = $3.500.
//
// Si price_per_km es 0 (default), se cae a la tarifa plana histórica
// (delivery_immediate_fee_cents): los despliegues que ya la usaban no cambian
// de precio hasta que el admin configure la tarifa por distancia.
export function computeDeliveryFeeCents(config, distanceKm, options = {}) {
  if (options?.freeDelivery === true) return 0;
  const perKm = Number(config?.delivery_immediate_price_per_km_cents) || 0;
  const base = Number(config?.delivery_immediate_base_fare_cents) || 0;
  if (perKm > 0) {
    const km = Math.max(0, Number(distanceKm) || 0);
    const raw = base + perKm * km;
    return Math.max(0, Math.round(raw / 50) * 50);
  }
  return Number(config?.delivery_immediate_fee_cents) || 0;
}
