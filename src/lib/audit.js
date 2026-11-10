// MyMochis · Auditoria de acciones del admin (spec 58, p10)
//
// Quien, cuando, desde donde y que. Solo la accion y el id del objetivo:
// NUNCA un secreto, una clave ni el cuerpo entero de la peticion.
import { db } from '../db.js';

/**
 * Registra una accion del admin.
 * @param {string} action      p.ej. 'payment.refund', 'courier.create'
 * @param {import('express').Request} req
 * @param {{target_type?:string, target_id?:string|number|null, details?:object}} opts
 */
export function audit(action, req, opts = {}) {
  try {
    const actor = req?.user?.email || req?.user?.sub || 'desconocido';
    const ip = req?.ip || req?.headers?.['x-forwarded-for'] || null;
    const ua = String(req?.headers?.['user-agent'] || '').slice(0, 200) || null;
    const details = opts.details ? JSON.stringify(opts.details).slice(0, 1000) : null;
    db.prepare(`
      INSERT INTO audit_log (actor, action, target_type, target_id, ip, user_agent, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(actor),
      String(action),
      opts.target_type || null,
      opts.target_id != null ? String(opts.target_id) : null,
      ip ? String(ip) : null,
      ua,
      details,
    );
  } catch (e) {
    // La auditoria NUNCA puede tumbar la operacion que audita.
    console.error('[audit] no se pudo registrar', action, e?.message || e);
  }
}

/** Listado de la auditoria (admin). */
export function listAudit({ limit = 100, action = null } = {}) {
  const n = Math.min(Number(limit) || 100, 500);
  if (action) {
    return db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY created_at DESC LIMIT ?').all(String(action), n);
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(n);
}
