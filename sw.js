// Service worker — кешує оболонку застосунку (щоб ставився як додаток і швидко відкривався).
// API flespi НЕ кешуємо — дані завжди свіжі з мережі.
const CACHE = 'avtopark-v1';
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
  // дані flespi та тайли мапи — завжди з мережі
  if (url.includes('flespi.io') || url.includes('tile.openstreetmap')) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }
  // оболонка — спершу кеш, потім мережа
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
