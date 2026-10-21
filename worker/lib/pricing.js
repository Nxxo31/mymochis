// MyMochis · Pricing para el runtime de Cloudflare Workers (D1).
//
// POR QUE ESTE ARCHIVO EXISTE Y NO SE REUSA src/lib/pricing.js:
// pricing.js consulta el catalogo con `db.prepare(...).get()` sobre better-sqlite3,
// que es SINCRONO. El Worker corre sobre D1, cuya API es async (`.first()` /
// `.all()`). Importar pricing.js aqui no funciona y, peor, hace que el bug que
// este archivo corrige parezca resuelto cuando no lo esta: si el Worker dejara
// de confiar en el total del cliente SIN recalcular, un cliente podria pedir un
// combo de $25.000 por $1 y las pruebas no lo detectarian (las pruebas manejan
// el mismo cliente).
//
// REGLA DURA: el `total` que llega del cliente NUNCA se persiste tal cual.
// Se recalcula desde flavors.price / combos.price y se devuelve el desglose.
//
// UNIDAD DE DINERO — pesos COP enteros en TODA la app. Los nombres historicos
// `*_cents` son PESOS, no centavos. NUNCA dividir entre 100.

/** Precio unitario en pesos de un sabor, o null si no existe. */
export async function flavorUnitPrice(db, flavorId) {
  const row = await db.prepare('SELECT price FROM flavors WHERE id = ?').bind(String(flavorId)).first();
  return row ? Number(row.price) : null;
}

/** Precio unitario en pesos de un combo, o null si no existe. */
export async function comboUnitPrice(db, comboId) {
  const row = await db.prepare('SELECT price FROM combos WHERE id = ?').bind(Number(comboId)).first();
  return row ? Number(row.price) : null;
}

/**
 * Recalcula el total de un pedido a partir del catalogo (version D1/async).
 *
 * Espejo de priceOrder() en src/lib/pricing.js. Si cambias una, cambia la otra:
 * las dos deben producir el mismo `total` para el mismo carrito, o el mismo
 * pedido cuesta cosas distintas segun por donde entre.
 *
 * @param {{db: object, items?: Record<string, number>, combos?: Array<{id:any, qty?:number}>, deliveryFee?: number}} input
 * @returns {Promise<{ok: boolean, total: number, lines: Array<object>, errors: string[]}>}
 */
export async function priceOrder({ db, items, combos, deliveryFee = 0 }) {
  const lines = [];
  const errors = [];

  // Sabores: { flavor_id: qty }
  if (items && typeof items === 'object') {
    const entries = Object.entries(items);
    if (entries.length) {
      // Una sola ida a D1 para todos los sabores del carrito en vez de N.
      const ids = entries.map(([fid]) => String(fid));
      const rows = await db.prepare(
        `SELECT id, name, price FROM flavors WHERE id IN (${ids.map(() => '?').join(',')})`
      ).bind(...ids).all();
      const byId = new Map((rows.results || []).map(r => [String(r.id), r]));

      for (const [fid, qtyRaw] of entries) {
        const qty = Number(qtyRaw);
        if (!(qty > 0)) continue;
        if (!Number.isInteger(qty)) {
          errors.push(`qty_invalida:${fid}`);
          continue;
        }
        const row = byId.get(String(fid));
        if (!row) {
          errors.push(`sabor_inexistente:${fid}`);
          continue;
        }
        const unit = Number(row.price);
        lines.push({
          type: 'flavor', id: String(fid), name: row.name || String(fid),
          qty, unitPrice: unit, subtotal: unit * qty
        });
      }
    }
  }

  // Combos: [{ id, qty }]
  if (Array.isArray(combos)) {
    const wanted = combos
      .map(c => ({ id: String(c?.id ?? c?.combo_id ?? ''), raw: c }))
      .filter(c => c.id);
    const missing = wanted.filter(c => !String(c.id));

    if (missing.length) errors.push('combo_sin_id');

    const ids = [...new Set(wanted.map(c => c.id))];
    if (ids.length) {
      const rows = await db.prepare(
        `SELECT id, name, price FROM combos WHERE id IN (${ids.map(() => '?').join(',')})`
      ).bind(...ids.map(Number)).all();
      const byId = new Map((rows.results || []).map(r => [String(r.id), r]));

      for (const { id, raw } of wanted) {
        const qty = Number(raw.qty ?? raw.units ?? 1);
        if (!(qty > 0)) continue;
        if (!Number.isInteger(qty)) { errors.push(`qty_invalida:${id}`); continue; }
        const row = byId.get(id);
        if (!row) { errors.push(`combo_inexistente:${id}`); continue; }
        const unit = Number(row.price);
        lines.push({
          type: 'combo', id, name: raw.name || row.name || `combo ${id}`,
          qty, unitPrice: unit, subtotal: unit * qty
        });
      }
    }
  }

  const subtotal = lines.reduce((acc, l) => acc + l.subtotal, 0);
  return { ok: errors.length === 0, total: subtotal + Number(deliveryFee || 0), lines, errors };
}

/** Formatea pesos COP para copy (WSP, UI). Sin decimales — COP no tiene sub-centavo. */
export function fmtCOP(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');
}