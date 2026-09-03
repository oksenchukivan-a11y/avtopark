// ESLint для застосунку автопарку: ловить те, що не ловить синтаксична перевірка jsc —
// невідомі змінні, використання до оголошення (саме так у v91 зламався drawTrack),
// повторні оголошення, недосяжний код. Запуск: eslint app.js sw.js
const browser = Object.fromEntries([
  'window','document','localStorage','sessionStorage','fetch','navigator','location','history',
  'setTimeout','clearTimeout','setInterval','clearInterval','requestAnimationFrame','console','alert','confirm',
  'AbortController','Response','Request','Headers','URL','URLSearchParams','performance','Intl',
  'encodeURIComponent','decodeURIComponent','PerformanceObserver','Event','CustomEvent',
  'self','caches','L'   // self/caches — service worker; L — Leaflet
].map(g => [g, 'readonly']));
module.exports = [{
  files: ['app.js', 'sw.js'],
  languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: browser },
  rules: {
    'no-undef': 'error',
    'no-use-before-define': ['error', { functions: false, classes: true, variables: false }],
    'no-redeclare': 'error',
    'no-dupe-keys': 'error',
    'no-dupe-else-if': 'error',
    'no-unreachable': 'error',
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-self-assign': 'error',
    'no-unused-vars': ['warn', { vars: 'local', args: 'none', caughtErrors: 'none' }],
    'no-empty': ['warn', { allowEmptyCatch: true }]
  }
}];
