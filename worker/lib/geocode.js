const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'MochisLand/2.0 (Neiva-Huila-CO; contact via WhatsApp)';
const MIN_INTERVAL_MS = 1100;

let lastRequestAt = 0;
let inFlight = null;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function throttle() {
  const now = Date.now();
  const waitMs = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - now);
  if (waitMs > 0) await wait(waitMs);
  lastRequestAt = Date.now();
}

async function getCached(db, rawAddress) {
  const row = await db.prepare(`
    SELECT lat, lng, display_name FROM geocoded_addresses WHERE raw_address = ?
  `).get(rawAddress);
  if (!row) return null;
  await db.prepare(`UPDATE geocoded_addresses SET lookup_count = lookup_count + 1, last_used_at = datetime('now') WHERE raw_address = ?`).run(rawAddress);
  return { lat: row.lat, lng: row.lng, display_name: row.display_name, cached: true };
}

async function setCached(db, rawAddress, lat, lng, displayName) {
  await db.prepare(`
    INSERT INTO geocoded_addresses (raw_address, lat, lng, display_name, lookup_count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(raw_address) DO UPDATE SET
      lat = excluded.lat,
      lng = excluded.lng,
      display_name = excluded.display_name,
      last_used_at = datetime('now')
  `).run(rawAddress, lat, lng, displayName || null);
}

async function fetchFromNominatim(rawAddress) {
  if (inFlight) await inFlight;
  inFlight = (async () => {
    await throttle();
    const url = `${NOMINATIM_URL}?q=${encodeURIComponent(rawAddress)}&format=json&limit=1&countrycodes=co`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'es' },
        signal: ctrl.signal
      });
      if (!r.ok) throw new Error(`nominatim_${r.status}`);
      const arr = await r.json();
      if (!Array.isArray(arr) || arr.length === 0) return null;
      const hit = arr[0];
      return {
        lat: Number(hit.lat),
        lng: Number(hit.lon),
        display_name: hit.display_name || null
      };
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('nominatim_timeout');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

export async function geocode(db, rawAddress) {
  const addr = String(rawAddress || '').trim();
  if (!addr) return null;
  const cached = await getCached(db, addr);
  if (cached) return cached;
  let fresh;
  try {
    fresh = await fetchFromNominatim(addr);
  } catch {
    return null;
  }
  if (!fresh) return null;
  await setCached(db, addr, fresh.lat, fresh.lng, fresh.display_name);
  return { ...fresh, cached: false };
}

export { haversineDistanceKm as haversineKm } from '../../src/lib/delivery-rules.js';
