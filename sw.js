const CACHE = 'mochis-land-v3';
const PRECACHE = [
  './',
  'index.html',
  'admin.html',
  'site-config.js',
  'favicon.svg',
  'logo-mochis-land.svg',
  'manifest.json',
  'og-image.png',
  'icon-192.png',
  'icon-512.png',
  'img/hero-1.jpg',
  'img/hero-2.jpg',
  'img/combo-colorful.jpg',
  'img/combo-white.jpg',
  'img/cut-open.jpg'
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

  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(res => {
        if (res.ok && (url.pathname.endsWith('.html') || url.pathname.endsWith('.svg') ||
                        url.pathname.endsWith('.css') || url.pathname.endsWith('.js') ||
                        url.pathname.endsWith('.jpg') || url.pathname.endsWith('.png') ||
                        url.pathname.endsWith('.webp') || url.pathname.endsWith('.mp4') ||
                        url.pathname === '/' || url.pathname === '/manifest.json')) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
