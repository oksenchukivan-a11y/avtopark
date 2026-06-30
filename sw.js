// Service worker — застосунок ставиться як додаток і працює офлайн.
// Стратегія: код (html/js) — мережа-перша (оновлення видно одразу), статика — кеш-перша.
// API flespi НЕ кешуємо — дані завжди свіжі.
const CACHE = 'avtopark-v33';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // дані flespi та геокодування — завжди з мережі, без кешу
  if (url.includes('flespi.io') || url.includes('nominatim')) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }
  // тайли карт — мережа, без кешу
  if (url.includes('tile') || url.includes('google.com/vt') || url.includes('arcgisonline') || url.includes('basemaps.cartocdn')) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }
  // наш код (index.html, app.js, sw, manifest) — мережа-перша, кеш як запас офлайн
  if (url.includes('/avtopark/') && (url.endsWith('.html') || url.endsWith('.js') || url.endsWith('/') || url.endsWith('.json'))) {
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // решта (leaflet cdn, іконки) — кеш-перша
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
