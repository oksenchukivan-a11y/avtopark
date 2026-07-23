// Service worker — застосунок ставиться як додаток і працює офлайн.
// Стратегія: код (html/js) — мережа-перша (оновлення видно одразу), статика — кеш-перша.
// API flespi НЕ кешуємо — дані завжди свіжі.
const CACHE = 'avtopark-v72';
const SHELL_LOCAL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
const SHELL_CDN = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', e => {
  // addAll атомарний: недоступний unpkg раніше валив УСТАНОВКУ ЦІЛКОМ (новий SW не активувався,
  // старий код жив у кеші далі). Локальна оболонка — обовʼязкова, CDN — як вийде.
  e.waitUntil(
    caches.open(CACHE).then(c =>
      c.addAll(SHELL_LOCAL).then(() =>
        Promise.allSettled(SHELL_CDN.map(u => c.add(u)))
      )
    ).then(() => self.skipWaiting())
  );
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
  if (url.includes('tile') || url.includes('google.com/vt')) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }
  // наш код (index.html, app.js, sw, manifest) — мережа-перша, кеш як запас офлайн.
  // Прив'язка до origin, а не до шляху '/avtopark/' — інакше на іншому хостингу код «залипав» би в кеші.
  if (url.startsWith(self.location.origin) && (url.endsWith('.html') || url.endsWith('.js') || url.endsWith('/') || url.endsWith('.json'))) {
    e.respondWith(
      fetch(e.request).then(r => {
        // кешуємо ЛИШЕ вдалу відповідь: 404/500 у вікні деплою GitHub Pages інакше перетирали
        // робочий app.js у кеші → офлайн-відкриття давало білий екран
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{}); }
        return r;
      }).catch(() =>
        // ignoreSearch: start_url PWA може мати query (./?...) — без цього офлайн-промах на рівному місці
        caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))
      )
    );
    return;
  }
  // решта (leaflet cdn, іконки) — кеш-перша, і докладаємо в кеш при першому вдалому фетчі
  // (якщо install не зміг покласти CDN-файли, вони закешуються тут при першому онлайн-використанні)
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      if (resp && resp.ok) { const copy = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{}); }
      return resp;
    }))
  );
});
