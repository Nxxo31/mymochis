const CACHE = 'mochis-land-v8'; // v8 2026-10-17: multi-número pedido + fix precios pesos + fix tienda init + api.whatsapp.com
const PRECACHE = [
  './',
  'index.html',
  'manage.html',
  'sw.js',
  'manifest.json',
  'favicon.svg',
  'logo-mochis-land.svg',
  'og-image.png',
  'icon-192.png',
  'icon-512.png',
  'img/instagram/mochi-06.jpg',
  'img/instagram/mochi-01.jpg',
  'img/instagram/mochi-02.jpg',
  'img/instagram/mochi-03.jpg'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  const isHtml = e.request.mode === 'navigate' || url.pathname === '/' ||
                 url.pathname.endsWith('.html') || url.pathname === './';

  if (isHtml) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request).then(c => c || Response.error()))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(res => {
        if (res.ok && (url.pathname.endsWith('.svg') ||
                        url.pathname.endsWith('.css') || url.pathname.endsWith('.js') ||
                        url.pathname.endsWith('.jpg') || url.pathname.endsWith('.png') ||
                        url.pathname.endsWith('.webp') || url.pathname.endsWith('.mp4') ||
                        url.pathname === '/manifest.json')) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});