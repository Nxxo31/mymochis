// MyMochis · Sincronización del feed de Instagram (spec_id=30 G4-01)
//
// El admin conecta el token de su cuenta profesional en Credenciales (cifrado
// en el vault, write-only); este worker sincroniza automáticamente lo que
// publica — la galería de la landing se actualiza sola. Sin token: silencioso
// (nada que sincronizar, nada que romper). Con token inválido: queda en los
// logs, el sitio público nunca se entera.
import { db } from '../../src/db.js';
import { useCredential } from '../../src/lib/vault.js';

const INTERVAL_MS = 30 * 60 * 1000;
const LIMIT = 12;

let timer = null;

export function startIgSync(intervalMs = INTERVAL_MS) {
  if (timer) return;
  timer = setInterval(() => { runOnce(); }, intervalMs);
  timer.unref?.();
  console.log(`[ig-sync] started, cada ${Math.round(intervalMs / 60000)} min`);
  setImmediate(() => { runOnce(); });
}

export async function runOnce() {
  let token = null;
  try {
    token = useCredential('instagram', 'access_token', 'sincronizar galeria');
  } catch {
    return { ok: false, reason: 'vault_locked' };
  }
  if (!token) return { ok: true, synced: 0, reason: 'not_connected' };

  try {
    const url = `https://graph.instagram.com/me/media?fields=id,caption,media_url,permalink,media_type,timestamp&limit=${LIMIT}&access_token=${encodeURIComponent(token)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) {
      console.error(`[ig-sync] graph respondio ${r.status}`);
      return { ok: false, reason: `graph_${r.status}` };
    }
    const data = await r.json();
    const upsert = db.prepare(`
      INSERT INTO ig_posts (ig_id, caption, media_url, permalink, media_type, posted_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(ig_id) DO UPDATE SET
        caption = excluded.caption, media_url = excluded.media_url,
        permalink = excluded.permalink, media_type = excluded.media_type,
        posted_at = excluded.posted_at, synced_at = datetime('now')
    `);
    let n = 0;
    for (const m of data.data || []) {
      if (!m.media_url || m.media_type === 'VIDEO') continue;
      upsert.run(m.id, String(m.caption || '').slice(0, 500), m.media_url, m.permalink || null, m.media_type, m.timestamp || null);
      n++;
    }
    console.log(`[ig-sync] ${n} publicacion(es) sincronizada(s)`);
    return { ok: true, synced: n };
  } catch (e) {
    console.error('[ig-sync] error', e?.message || e);
    return { ok: false, reason: 'network' };
  }
}
