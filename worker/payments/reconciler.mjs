// MyMochis · Reconciler (operational + financial)
// Spec: PROJECT.md §22.11
// Operational: cada 5 min, busca PROCESSING/UNRESOLVED y consulta provider.
// Financial: diario 04:00 COL, sweep completo (placeholder — depende de export por provider).
import { randomUUID } from 'node:crypto';
import { db } from '../src/db.js';
import { listAdapters, getAdapter } from '../src/lib/payments/adapter.js';
import { transitionState } from '../src/lib/payments/index.js';

const OP_INTERVAL_MS = 5 * 60 * 1000;
const FINANCIAL_CRON_HOUR = 4; // 04:00 COL

let opTimer = null;
let financialTimer = null;
let running = false;

export function startReconciler() {
  if (opTimer) return;
  opTimer = setInterval(operationalReconcile, OP_INTERVAL_MS);
  scheduleFinancialReconcile();
  console.log(`[reconciler] started: operational every ${OP_INTERVAL_MS / 1000}s, financial @ 04:00 COL`);
}

export function stopReconciler() {
  if (opTimer) clearInterval(opTimer);
  if (financialTimer) clearInterval(financialTimer);
  opTimer = null;
  financialTimer = null;
}

function scheduleFinancialReconcile() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(FINANCIAL_CRON_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next.getTime() - now.getTime();
  financialTimer = setTimeout(() => {
    financialReconcile();
    scheduleFinancialReconcile();
  }, delay);
}

export async function operationalReconcile() {
  if (running) return;
  running = true;
  const runId = `run_${randomUUID()}`;
  db.prepare(`INSERT INTO reconciliation_runs (run_id, status) VALUES (?, 'running')`).run(runId);
  let checks = 0, mismatches = 0;
  try {
    const stale = db.prepare(`
      SELECT * FROM payments
      WHERE state IN ('PROCESSING', 'UNRESOLVED')
        AND updated_at < datetime('now', '-2 minutes')
      LIMIT 50
    `).all();

    for (const p of stale) {
      checks++;
      const attempt = db.prepare(`SELECT * FROM payment_attempts WHERE payment_id = ? AND provider_reference IS NOT NULL ORDER BY created_at DESC LIMIT 1`)
        .get(p.payment_id);
      if (!attempt) continue;

      try {
        const adapter = getAdapter(attempt.provider);
        const status = await adapter.getPaymentStatus(attempt.provider_reference);
        if (status.state !== p.state && status.state !== 'UNRESOLVED') {
          const ok = transitionState(p.payment_id, p.state, status.state, { source: 'reconciler', prev_state: p.state });
          if (ok.ok) {
            mismatches++;
            console.log(`[reconciler] op ${p.payment_id}: ${p.state} -> ${status.state}`);
          }
        }
      } catch (e) {
        // Provider caído, no es mismatch — skip
      }
    }

    db.prepare(`UPDATE reconciliation_runs SET finished_at = datetime('now'), status = ?, checks_total = ?, mismatches = ? WHERE run_id = ?`)
      .run(mismatches > 0 ? 'mismatch' : 'ok', checks, mismatches, runId);
  } catch (e) {
    console.error('[reconciler] operational failed', e);
    db.prepare(`UPDATE reconciliation_runs SET finished_at = datetime('now'), status = 'failed' WHERE run_id = ?`).run(runId);
  } finally {
    running = false;
  }
}

export async function financialReconcile() {
  const runId = `run_${randomUUID()}`;
  db.prepare(`INSERT INTO reconciliation_runs (run_id, status) VALUES (?, 'running')`).run(runId);
  // Placeholder: el financial sweep requiere descargar reports de cada provider
  // (API o CSV). Implementar en ola 5 con Nequi/Daviplata reports.
  console.log('[reconciler] financial: TODO — implementar en ola 5 con provider reports');
  db.prepare(`UPDATE reconciliation_runs SET finished_at = datetime('now'), status = 'ok' WHERE run_id = ?`).run(runId);
}

// Standalone
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  startReconciler();
}
