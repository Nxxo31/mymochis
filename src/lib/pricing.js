// MyMochis · Pricing server-side (single source of truth del dinero)
// Regla dura: el `total` que llega del cliente NUNCA se persiste tal cual.
// El server recalcula desde flavors.price / combos.price y devuelve el desglose.
//
// UNIDAD DE DINERO — pesos COP enteros en TODA la app.
// Los nombres historicos `*_cents` (orders.total, flavors.price, combos.price,
// delivery_immediate_fee_cents) son PESOS, no centavos. NUNCA dividir entre 100.
// (bug corregido 2026-10-17, re-verificado en auditoria 2026-10-20: un cliente
//  podia pedir un combo de $25.000 por $1 porque el server no recalculaba.)

import { db } from '../db.js';

/** Precio unitario en pesos de un sabor, o null si no existe. */
export function flavorUnitPrice(flavorId) {
  const row = db.prepare('SELECT price FROM flavors WHERE id = ?').get(String(flavorId));
  return row ? Number(row.price) : null;
}

/** Precio unitario en pesos de un combo, o null si no existe. */
export function comboUnitPrice(comboId) {
  const row = db.prepare('SELECT price FROM combos WHERE id = ?').get(String(comboId));
  return row ? Number(row.price) : null;
}

/**
 * Recalcula el total de un pedido a partir del catalogo.
 *
 * @param {{items?: Record<string, number>, combos?: Array<{id:any, qty?:number}>, deliveryFee?: number}} input
 * @returns {{ok: boolean, total: number, lines: Array<{type:'flavor'|'combo', id:string, name:string, qty:number, unitPrice:number, subtotal:number}>, errors: string[]}}
 */
export function priceOrder({ items, combos, deliveryFee = 0 }) {
  const lines = [];
  const errors = [];

  // Sabores: { flavor_id: qty }
  if (items && typeof items === 'object') {
    for (const [fid, qtyRaw] of Object.entries(items)) {
      const qty = Number(qtyRaw);
      if (!(qty > 0)) continue;
      if (!Number.isInteger(qty)) {
        errors.push(`qty_invalida:${fid}`);
        continue;
      }
      const unit = flavorUnitPrice(fid);
      if (unit == null) {
        errors.push(`sabor_inexistente:${fid}`);
        continue;
      }
      const f = db.prepare('SELECT name FROM flavors WHERE id = ?').get(String(fid));
      lines.push({
        type: 'flavor', id: String(fid), name: f?.name || fid,
        qty, unitPrice: unit, subtotal: unit * qty,
      });
    }
  }

  // Combos: [{ id, qty }]
  if (Array.isArray(combos)) {
    for (const c of combos) {
      const id = String(c?.id ?? c?.combo_id ?? '');
      if (!id) { errors.push('combo_sin_id'); continue; }
      const qty = Number(c.qty ?? c.units ?? 1);
      if (!(qty > 0)) continue;
      if (!Number.isInteger(qty)) { errors.push(`qty_invalida:${id}`); continue; }
      const unit = comboUnitPrice(id);
      if (unit == null) { errors.push(`combo_inexistente:${id}`); continue; }
      const def = db.prepare('SELECT name FROM combos WHERE id = ?').get(Number(id));
      lines.push({
        type: 'combo', id, name: c.name || def?.name || `combo ${id}`,
        qty, unitPrice: unit, subtotal: unit * qty,
      });
    }
  }

  const subtotal = lines.reduce((acc, l) => acc + l.subtotal, 0);
  return { ok: errors.length === 0, total: subtotal + Number(deliveryFee || 0), lines, errors };
}

/** Formatea pesos COP para copy (WSP, UI). Sin decimales — COP no tiene sub-centavo. */
export function fmtCOP(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');
}
