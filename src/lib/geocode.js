import { db } from '../db.js';

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

function getCached(rawAddress) {
  const row = db.prepare(`
    SELECT lat, lng, display_name FROM geocoded_addresses WHERE raw_address = ?
  `).get(rawAddress);
  if (!row) return null;
  db.prepare(`UPDATE geocoded_addresses SET lookup_count = lookup_count + 1, last_used_at = datetime('now') WHERE raw_address = ?`).run(rawAddress);
  return { lat: row.lat, lng: row.lng, display_name: row.display_name, cached: true };
}

function setCached(rawAddress, lat, lng, displayName) {
  db.prepare(`
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

export async function geocode(rawAddress) {
  const addr = String(rawAddress || '').trim();
  if (!addr) return null;
  const cached = getCached(addr);
  if (cached) return cached;
  const fresh = await fetchFromNominatim(addr);
  if (!fresh) return null;
  setCached(addr, fresh.lat, fresh.lng, fresh.display_name);
  return { ...fresh, cached: false };
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}