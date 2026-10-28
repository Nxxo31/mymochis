// Service worker de Mochi's Land.
// Politica: red-primero para lo que puede quedar desfasado (HTML, JS, CSS)
// y stale-while-revalidate para lo que no cambia (imagenes, fuentes, iconos).
// Asi un HTML nuevo nunca se sirve junto a un JS/CSS viejo.
const VERSION = 'v10'; // v10 2026-10-25: precache de las fotos que usa el catalogo (hero, sabores, galeria) + config de sabores
const CACHE = `mochis-land-${VERSION}`;
const OFFLINE_DOC = 'index.html';

const PRECACHE = [
  './',
  'index.html',
  'manage.html',
  'manifest.json',
  'favicon.svg',
  'logo-mochis-land.svg',
  'og-image.png',
  'icon-192.png',
  'icon-512.png',
  'img/mochis/mochis.config.json',
  // Fotos que el sitio usa hoy: hero (09), sabores (11/10/12/13/08), galeria (02/05/09/10/11/12/13).
  'img/instagram/mochi-02.jpg',
  'img/instagram/mochi-05.jpg',
  'img/instagram/mochi-08.jpg',
  'img/instagram/mochi-09.jpg',
  'img/instagram/mochi-10.jpg',
  'img/instagram/mochi-11.jpg',
  'img/instagram/mochi-12.jpg',
  'img/instagram/mochi-13.jpg',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll es atomico: un 404 (imagen que todavia no existe) tumbaba TODA la
    // instalacion y el SW nunca activaba. Cada entrada se cachea por separado.
    await Promise.allSettled(
      PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' }))),
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/sw.js') return;

  const isDoc = req.mode === 'navigate'
    || url.pathname === '/'
    || url.pathname.endsWith('.html');
  // El bundle se sirve con nombre estable (landing.js, assets/islands.css) y
  // los chunks con hash: cualquier CSS/JS va red-primero. Con
  // stale-while-revalidate un HTML recien desplegado se combaba con el bundle
  // de la version anterior.
  const isCode = /\.(?:js|mjs|css)$/i.test(url.pathname);

  if (isDoc || isCode) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone());
        }
        return res;
      } catch (err) {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(req)
          || (isDoc ? await cache.match(OFFLINE_DOC) : null);
        return cached || Response.error();
      }
    })());
    return;
  }

  // Imagenes, fuentes y estaticos: cache primero con revalidacion en segundo
  // plano. Si la red falla, se sirve la copia cacheada.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const network = fetch(req)
      .then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);
    if (cached) return cached;
    const res = await network;
    return res || Response.error();
  })());
});
