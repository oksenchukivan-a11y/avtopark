'use strict';
// ВИХІД: відповіді fetch, що долетіли між confirm() і reload, встигали знову записати в щойно очищений
// localStorage знімок авто, позиції й адреси — і наступний вхід малював попередній автопарк. Тому logout()
// лишає мітку, а чистка повторюється ТУТ — раніше за будь-яке читання localStorage нижче.
try { if (sessionStorage.getItem('wipe')) { localStorage.clear(); sessionStorage.removeItem('wipe'); } } catch(e) {}

// ===== Налаштування =====
const FLESPI = 'https://flespi.io';
const APP_VERSION = 'v97';          // показуємо в шапці — щоб видно було, що отримав свіже
const REFRESH_MS = 15000;          // авто-оновлення кожні 15 с: реакцію на кінець глушіння забезпечує fast-poll, а 10-с базовий темп зʼїдав запас ліміту flespi (ревʼю v74)
const FAST_REFRESH_MS = 5000;       // прискорений поллінг у вікні щойно-виявленого глушіння
const FAST_WINDOW_MS = 3 * 60000;   // швидкий режим тримаємо лише перші 3 хв глушіння — довше не варте зайвих запитів (регіональне глушіння в Сумах триває годинами)
// Фізична стеля правдоподібності: стрибок позиції, що вимагає БІЛЬШОЇ швидкості між оновленнями, — це спуф/сміття РЕБ, а не реальний рух. Такі точки на карту не наносимо.
const MAX_JUMP_KMH = 150;
const MAX_HDOP = 12;               // геометрія супутників гірша за це — фікс ненадійний (норма 0.5–3; спуф інколи дає абсурдний HDOP)
const SIM_SUSPECT_MS = 4 * 3600000; // авто мовчить 4+ год, коли інші на звʼязку → підозра на баланс SIM/покриття
const ONLINE_SEC = 600;            // онлайн, якщо дані свіжіші за 10 хв
const FILL_L = 5;                  // або стрибок > 5 л = заправка (для авто, що дають літри)
const DRAIN_L = 4;                 // падіння > 4 л при зупинці = злив
const STOP_SPEED = 3;              // км/год: нижче — машина стоїть
const STOP_MIN = 180;              // сек: зупинка від 3 хв
const SEG_GAP = 600;               // 10 хв без жодного заміру руху = машина стояла (це рівно період «на стоянці» трекера)
const HEATER_LPH = 0.6;            // л/год: автономний обігрівач на стоянці — стільки може «зникнути» з бака без зливу (див. parkDrainMin)
const PARK_DRAIN_TOP_L = 8;        // поріг «зливу на сліпій стоянці» росте з тривалістю, але не вище 8 л (ніч з обігрівачем)
const CHG_MIN_PCT = 4;             // % SoC: менший приріст на стоянці — відскік BMS після вимкнення (+2–3 %), а не зарядка
const JITTER_M = 15;               // ігнор GPS-дрижання менше 15 м
const TRACK_MIN_M = 8;              // мін. відстань між точками МАЛЬОВАНОГО треку (при 2с-пілінгу без цього лінія «зубчаста»)
const TRACK_SIMPLIFY_M = 6;         // допуск згладжування треку (алгоритм Дугласа-Пекера), метри

// Запасні ємності баків (літри) по device_id — лише якщо в метаданих пристрою бака нема.
// Зараз усі авто мають бак у метаданих flespi, тож тут порожньо.
const TANKS = {};

// ===== Токен =====
function token() { return localStorage.getItem('flespi_token') || ''; }
function saveToken() {
  const t = document.getElementById('tokenInput').value.trim();
  if (!t) return alert('Встав токен');
  localStorage.setItem('flespi_token', t);
  init();
}
function logout() {
  if (!confirm('Вийти і забути токен?')) return;
  _loggingOut = true; clearTimeout(timer);   // нових запитів і авто-розлогіну поверх виходу не треба
  try { sessionStorage.setItem('wipe', '1'); } catch(e) {}   // запити в польоті ще можуть дописати localStorage — старт почистить
  try { localStorage.clear(); } catch(e) {}   // не лише токен: історія, адреси, позиції — усе
  location.reload();
}

// ===== API (з ретраями — flespi інколи віддає порожнє) =====
// 401/403 НЕ означає одразу мертвий токен: flespi зрідка відповідає так і на живий ключ (перехідні
// блокування/ліміти). Раніше рахувалась КОЖНА спроба, а картки шлють до 15 запитів разом — «6 відмов»
// набирались за долю секунди, і живий ключ стирався з телефона. Тепер рахуємо ВИКЛИКИ, що впали після
// всіх спроб, і лише 401 (відкликаний/хибний ключ flespi дає саме 401; 403 — «доступ заборонено»,
// його показуємо в шапці, але не розлогінюємо). Розлогін — коли серія без жодного успіху триває ≥90 с
// (довше за 1-хв призупинення токена flespi) І контрольний /auth/info теж відповів 401. Без confirm
// (інакше «Скасувати» лишало лічильник на порозі → шторм alert-ів), і лише один alert (_loggingOut).
let _authFails = 0, _authFirstAt = 0, _authLastAt = 0, _authProbing = false, _loggingOut = false;
let _limitUntil = 0;   // 429 від flespi: токен призупинено ~на хвилину — повтори в цей час лише продовжують відмови
const _sleep = ms => new Promise(res => setTimeout(res, ms));
function _noteAuthFail(status){
  if (status !== 401 || _loggingOut) return;
  const n = Date.now();
  if (!_authFirstAt || n - _authLastAt > 120000) { _authFirstAt = n; _authFails = 0; }   // пауза >2 хв = нова серія (iOS приспав застосунок)
  _authLastAt = n;
  if (++_authFails < 3 || n - _authFirstAt < 90000 || _authProbing) return;
  _authProbing = true;   // один контрольний запит, а не хвиля
  const ac = new AbortController(), tmr = setTimeout(() => ac.abort(), 10000);   // завислий запит не блокує перевірку назавжди
  fetch(FLESPI + '/auth/info', { headers: { Authorization: 'FlespiToken ' + token() }, signal: ac.signal })
    .then(r => {
      if (r.status !== 401) { _authFails = 0; _authFirstAt = 0; return; }   // ключ живий — це був збій
      if (_loggingOut) return;
      _loggingOut = true;
      alert('Токен недійсний — введи ключ заново');
      try { localStorage.removeItem('flespi_token'); } catch(e){}
      location.reload();
    })
    .catch(() => {})
    .finally(() => { clearTimeout(tmr); _authProbing = false; });
}
async function api(path, method, body) {
  if (Date.now() < _limitUntil) throw new Error('ліміт запитів flespi — зачекай хвилину');
  let last, authSt = 0;
  // POST НЕ повторюємо: повторений /commands-queue ставив 2-3 однакові cpureset,
  // і трекер міг піти в цикл перезавантажень просто через повільну мережу
  const attempts = (!method || method === 'GET') ? 3 : 1;
  for (let i = 0; i < attempts; i++) {
    const more = i < attempts - 1;   // після ОСТАННЬОЇ спроби не спимо в жодній гілці — це лише затримувало помилку
    try {
      const opt = { method: method || 'GET', headers: { Authorization: 'FlespiToken ' + token() } };
      if (body != null) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
      // таймаут 15 с: підвислий fetch (зміна мережі на iOS) інакше тримає _refreshing=true вічно —
      // застосунок застигав на «оновлюю…» без наступного тика
      const ac = new AbortController();
      const tmr = setTimeout(() => ac.abort(), 15000);
      opt.signal = ac.signal;
      let r;
      try { r = await fetch(FLESPI + path, opt); } finally { clearTimeout(tmr); }
      if (r.status === 401 || r.status === 403) { authSt = r.status; last = 'auth'; if (more) await _sleep(1200*(i+1)); continue; }
      const txt = await r.text();
      let j = null;
      if (txt) { try { j = JSON.parse(txt); } catch(_) { j = null; } }   // HTML-сторінка 502/504 від проксі — не JSON
      const reason = (j && j.errors && j.errors[0] && j.errors[0].reason) || '';
      // ЛІМІТ REST-запитів: повтор через 1–3 с гарантовано відбивається (токен призупинено на хвилину),
      // тож не повторюємо. 429 — ще й вимикач на хвилину для всіх запитів. «limit» у тексті 400-ї НЕ ліміт:
      // так flespi лає хибний параметр запиту (урок: `limit` замість `count`).
      if (r.status === 429 || (r.status !== 400 && /limit/i.test(reason))) {
        if (r.status === 429) _limitUntil = Date.now() + 60000;
        const er = new Error('ліміт запитів flespi — зачекай хвилину'); er.fatal = true; throw er;
      }
      if (!j) { last = txt ? 'HTTP ' + r.status : 'empty'; if (more) await _sleep(800*(i+1)); continue; }   // порожньо / не JSON — повтор із паузою
      if (j.errors) {
        if (r.status >= 500) { last = reason || 'HTTP ' + r.status; if (more) await _sleep(1000*(i+1)); continue; }   // збій сервера — мине
        const er = new Error(reason || 'api'); er.fatal = true; throw er;   // хибний запит (4xx) — повтор дасть те саме, не палимо ліміт
      }
      _authFails = 0; _authFirstAt = 0;   // успішна відповідь = токен живий
      return j.result;
    } catch (e) {
      if (e.fatal) throw e;
      last = (e.name === 'AbortError') ? 'timeout' : e.message;
      if (more) await _sleep(800*(i+1));   // мережа (iOS «Load failed» після зміни мережі) / таймаут — пауза перед повтором
    }
  }
  if (last === 'auth') {
    _noteAuthFail(authSt);
    throw new Error(authSt === 403 ? 'flespi: доступ заборонено (403)' : 'flespi: ключ не приймається (401)');
  }
  throw new Error(last || 'api');
}

// екранування для будь-якого рядка, що йде в innerHTML/тултіпи: назви пристроїв і метадані приходять
// з flespi і можуть містити HTML — а в localStorage лежить токен, тож XSS тут = крадіжка токена
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function tv(tel, key) {
  const x = tel && tel[key];
  if (x == null) return null;
  return (typeof x === 'object' && 'value' in x) ? x.value : x;
}
function tts(tel, key) {
  const x = tel && tel[key];
  return (x && typeof x === 'object' && x.ts) ? x.ts : null;
}

// ===== Час =====
function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0,0,0,0); return Math.floor(x/1000); }
// початок дня «i днів тому» ЧЕРЕЗ setDate, а не -i*86400: у ніч переводу годинника доба = 23/25 год,
// і арифметика секундами зсувала всі вкладки минулих днів на годину
function dayStartTs(i){ const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - i); return Math.floor(d.getTime()/1000); }
function fmtTime(sec){ return new Date(sec*1000).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'}); }
function fmtDateTime(sec){ return new Date(sec*1000).toLocaleString('uk-UA',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); }
// час, а для НЕ сьогоднішнього — ще й дата: голе «21:40» учорашнього знімка читалось як сьогоднішнє
function fmtWhen(sec){ return new Date(sec*1000).toDateString() === new Date().toDateString() ? fmtTime(sec) : fmtDateTime(sec); }
const WEEKDAYS = ['нд','пн','вт','ср','чт','пт','сб'];   // Date.getDay() → підпис дня (вкладки, роздільники стрічки)
function fmtDur(sec){
  sec = Math.round(sec);
  // коротше хвилини — секундами: перевищення рахуються від 5 с і тривають 10–50 с, а «0 хв» читалось як «не було»
  if (sec < 60) return Math.max(0, sec) + ' с';
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60);
  if (h) return h+' год '+m+' хв';
  return m+' хв';
}
function ago(sec){
  const s = Math.floor(Date.now()/1000) - sec;
  if (s < 60) return 'щойно';
  if (s < 3600) return Math.floor(s/60)+' хв тому';
  if (s < 86400) return Math.floor(s/3600)+' год тому';
  return Math.floor(s/86400)+' дн тому';
}

// ===== Геометрія =====
function haversine(a, b){ // [lat,lon] → метри
  const R = 6371000, rad = Math.PI/180;
  const dLat=(b[0]-a[0])*rad, dLon=(b[1]-a[1])*rad;
  const la1=a[0]*rad, la2=b[0]*rad;
  const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
// «Розумний регіон»: парк працює в Україні. Після холодного старту GPS/глушіння трекер інколи шле
// свою ДЕФОЛТНУ точку (Ліма, Перу) — і зрідка навіть із valid=true, тому сама лише перевірка валідності
// не рятує (машина «летіла» через Атлантику на треку). Відсікаємо все за межами України+сусідів.
function saneRegion(lat, lon){ return lat >= 40 && lat <= 62 && lon >= 15 && lon <= 45; }
// локальна пласка проєкція (метри) відносно точки ref — досить точно на масштабі міста, для згладжування треку
function toLocalXY(pt, ref){
  const R = 6371000, rad = Math.PI/180;
  const x = (pt[1]-ref[1]) * rad * R * Math.cos(ref[0]*rad);
  const y = (pt[0]-ref[0]) * rad * R;
  return [x, y];
}
// перпендикулярна відстань точки p до відрізка a-b, метри
function perpDistM(p, a, b){
  const P = toLocalXY(p, a), A = [0,0], B = toLocalXY(b, a);
  const dx = B[0]-A[0], dy = B[1]-A[1];
  const len2 = dx*dx + dy*dy;
  if (len2 === 0) return Math.hypot(P[0]-A[0], P[1]-A[1]);
  let t = ((P[0]-A[0])*dx + (P[1]-A[1])*dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(P[0]-(A[0]+t*dx), P[1]-(A[1]+t*dy));
}
// згладжування треку (Дуглас-Пекер): прибирає зубчастість GPS-шуму, зберігаючи форму реального маршруту
// Перед спрощенням прорідити: місячний трек — це сотні тисяч точок, і рекурсивний
// Дуглас-Пекер морозив головний потік на кілька секунд. 8000 точок цілком вистачає для карти.
function thinTrack(pts){
  const MAXP = 8000;
  if (pts.length <= MAXP) return pts;
  const step = Math.ceil(pts.length / MAXP);
  const out = [];
  for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
  if (out[out.length-1] !== pts[pts.length-1]) out.push(pts[pts.length-1]);
  return out;
}
function simplifyTrack(pts, tolM){
  if (pts.length < 3) return pts;
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length-1; i++) {
    const d = perpDistM(pts[i], pts[0], pts[pts.length-1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > tolM) {
    const left = simplifyTrack(pts.slice(0, idx+1), tolM);
    const right = simplifyTrack(pts.slice(idx), tolM);
    return left.slice(0, -1).concat(right);
  }
  return [pts[0], pts[pts.length-1]];
}

// ===== Бак: з метаданих flespi (device.metadata.tank), запасний — TANKS =====
function tankFor(x) {
  const id = (x && typeof x === 'object') ? x.id : x;
  const dev = (x && typeof x === 'object') ? x : devCache.find(d => d.id === id);
  if (dev && dev.metadata && dev.metadata.tank) return dev.metadata.tank;
  return null;
}
// Фізична стеля палива: у баку НЕ може бути більше за його ємність. Спільний хелпер для картки,
// історії й детекції заправок — щоб правило було ОДНАКОВЕ для всіх авто (вимога власника).
// Причина: OEM-датчик Renault Master над-читає (~97 л сирих при баку 80) → картка показувала 105 л,
// а фільтр глюків «>бак» нулив КОЖЕН замір, і заправка не детектувалась. Тепер: явне сміття (>бак×1.6)
// відкидаємо, помірний перебір м'яко обрізаємо до ємності — і показ правдивий, і детекція заправки жива.
// КАЛІБРУВАННЯ ПАЛИВА: реальні_літри = показ × fuelFactor + fuelOffset.
// Один лише множник не рятує, коли датчик СТИСКАЄ шкалу: на зеленому Master він показував
// 22 л при реальних 16.75 і 100 л при реальних 105 (заправка 88.25 л у 105-літровий бак).
// Два коефіцієнти рахуються по двох точках однієї заправки — і сходяться на обох кінцях.
function calFuel(raw, md) {
  if (raw == null || !(raw > 0)) return null;
  // ЖОДНИХ «стель» і порогів: поріг створює ОБРИВ на межі — 19.08 датчик Master перейшов через
  // такий поріг, і застосунок нарахував 26 л замість 7 (розхід 36 л/100 на рівному місці).
  // Крива ГЛАДКА: quad×raw² + factor×raw + offset. Квадратичний член потрібен тому, що поплавок
  // у баку нелінійний (бак не прямокутний): у Master одна одиниця датчика — це 0.9 л на порожньому
  // баку і 1.25 л на повному. Коефіцієнти підбираються по ЧЕКАХ заправок + ємності бака з VIN.
  // Авто без fuelQuad працюють як раніше — просто лінійно.
  const q = (md && md.fuelQuad) || 0;
  const L = q * raw * raw + raw * ((md && md.fuelFactor) || 1) + ((md && md.fuelOffset) || 0);
  return L > 0 ? L : null;   // від'ємне після зсуву = бак практично порожній / сміття
}
function capFuel(liters, tank) {
  if (liters == null || !tank) return liters;
  if (liters > tank * 1.6) return null;   // сенсорне сміття — не віримо
  return liters > tank ? tank : liters;   // повний бак = ємність, не більше
}

// ===== Паливо у літрах =====
// памʼять останнього відомого палива (деякі авто, як Ducato, перестають слати рівень коли заглушені → 0/нема)
let lastFuel = {};
try { lastFuel = JSON.parse(localStorage.getItem('lastFuel') || '{}'); } catch(e) { lastFuel = {}; }
let lastFuelTs = {};
try { lastFuelTs = JSON.parse(localStorage.getItem('lastFuelTs') || '{}'); } catch(e) { lastFuelTs = {}; }   // коли «останнє паливо» востаннє освіжали з історії (throttle, щоб не спамити flespi)
// Паливо з ПОТОЧНОЇ телеметрії (без кешу). null = заглушене авто рівень не шле.
function fuelCurrent(dev, tel) {
  const md = (dev && typeof dev === 'object' && dev.metadata) || {};
  const pct = tv(tel, 'can.fuel.level');       // рівень палива, %
  const tank = tankFor(dev);
  // КАЛІБРУВАННЯ: якщо OEM-літри ненадійні (metadata.fuelByPct) — рахуємо % × реальний бак.
  // fuelFactor застосовується до БУДЬ-ЯКОГО джерела (звірка по чеку заправки: реальні літри ÷ показані)
  if (md.fuelByPct && pct != null && pct > 0 && tank) { const L = calFuel(pct / 100 * tank, md); return L == null ? null : capFuel(Math.round(L), tank); }
  // ПРИМІТКА: раніше тут був пріоритет для 'fuel.liters' (серверний плагін flespi msg-expression) —
  // прибрано назавжди: на Kangoo 8440 висів застарілий плагін з часів тестування Audi (формула %×0.7,
  // під 70-літровий бак), і мовчки перебивав правильний клієнтський розрахунок місяцями (показував 25 л
  // замість реальних ~21 л). Калібрування тепер ЛИШЕ клієнтське (metadata.fuelFactor/fuelByPct/tank),
  // без залежності від серверних плагінів, які легко забути відв'язати при зміні авто на пристрої.
  const vol = tv(tel, 'can.fuel.volume');      // реальні літри напряму (Master/Kangoo при русі)
  if (vol != null && vol > 0) { const L = calFuel(vol, md); return L == null ? null : capFuel(Math.round(L), tank); }   // калібрування + стеля бака
  if (pct != null && pct > 0 && tank) { const L = calFuel(pct / 100 * tank, md); return L == null ? null : capFuel(Math.round(L), tank); }
  return null;
}
// Для відображення: поточне значення, інакше останнє відоме (кеш освіжається з історії в renderCards).
// НА ХОДУ сирий % канал (Volvo) стрибав на десятки відсотків (у can.fuel.volume від ЕБУ такого нема), тому
// їдучи показуємо не сирий замір, а медіану кількох. АЛЕ раніше на ходу кеш НЕ оновлювався взагалі — заправку було видно лише
// після зупинки із заведеним двигуном, тобто через години (Іван: «Master зелений 27 л, а у вкладці
// залито 78»). Тепер на ходу тримаємо коротку медіану живих замірів: плескання вона гасить, а стійкий
// стрибок на ≥FUEL_ADOPT_L (заправка) пропускає за ~1–2 хв їзди.
// ПАДІННЯ на ходу — звичайна витрата, тому приймається вже від FUEL_DROP_L: раніше обидва напрямки чекали
// 15 л, і картка спускалась сходинками (Master 01.10: 46 л на картці при 32 у баку, «запас» +135 км).
// can.fuel.volume від ЕБУ гладкий — медіана 5 замірів розходиться з 5-хв медіаною звіту ≤1–2 л. «Плескання
// ±10 л» стосується % каналу (fuelByPct, Volvo) — для нього обидва пороги 15, інакше вийде «храповик» униз.
const FUEL_ROLL_N = 5, FUEL_ADOPT_L = 15, FUEL_DROP_L = 2;   // 15 л: ріст на ходу буває лише від заправки
let _fuelRoll = {};
function fuelLiters(dev, tel) {
  const id = dev && dev.id;
  const md = (dev && typeof dev === 'object' && dev.metadata) || {};
  const live = fuelCurrent(dev, tel);
  const spNow = tv(tel,'position.speed'), mvNow = tv(tel,'movement.status');
  const moving = (spNow != null && spNow >= 3) || mvNow === true;
  if (moving && id && lastFuel[id] != null) {
    if (live != null && live > 0) {
      const roll = (_fuelRoll[id] = _fuelRoll[id] || []);
      const stamp = tv(tel,'server.timestamp') || 0;   // той самий пакет телеметрії не рахуємо двічі (рендер частіший за пакети на стоянці)
      if (!roll.length || roll[roll.length-1][0] !== stamp) { roll.push([stamp, live]); if (roll.length > FUEL_ROLL_N) roll.shift(); }
      if (roll.length >= 3) {
        const med = roll.map(x => x[1]).sort((a,b) => a-b)[Math.floor(roll.length/2)];
        const dl = med - lastFuel[id], dropL = md.fuelByPct ? FUEL_ADOPT_L : FUEL_DROP_L;
        if (dl <= -dropL || dl >= FUEL_ADOPT_L) { lastFuel[id] = med; try { localStorage.setItem('lastFuel', JSON.stringify(lastFuel)); } catch(e){} }
      }
    }
    return lastFuel[id];
  }
  if (live != null && live > 0) {
    if (id) _fuelRoll[id] = [];   // стоїмо — далі віримо датчику напряму, медіану починаємо заново
    if (id && lastFuel[id] !== live) { lastFuel[id] = live; try { localStorage.setItem('lastFuel', JSON.stringify(lastFuel)); } catch(e){} }   // пишемо лише зміну
    return live;
  }
  if (id && lastFuel[id] != null) return lastFuel[id];   // заглушене — останнє відоме
  return null;
}
// останнє осмислене паливо з ІСТОРІЇ (коли авто заглушене й шле 0/нема — як Ducato).
// Шукаємо останнє >0 серед can.fuel.volume (літри) АБО can.fuel.level (% × бак), пропускаючи нулі-глюки.
async function lastValidFuel(dev){
  const md = dev.metadata || {};
  const tank = md.tank || null;
  const now = Math.floor(Date.now()/1000);
  // fuelByPct = OEM-літри цього авто ненадійні → в історії теж питаємо СПОЧАТКУ відсотки
  // (інакше кеш отруювався некаліброваним volume — та сама регресія, що з плагіном Audi)
  const fieldsOrder = md.fuelByPct ? ['can.fuel.level','can.fuel.volume'] : ['can.fuel.volume','can.fuel.level'];
  for (const field of fieldsOrder) {
    const data = encodeURIComponent(JSON.stringify({ from: now-30*86400, to: now, count:50, reverse:true, filter:field, fields:'timestamp,'+field }));
    try {
      const res = await api(`/gw/devices/${dev.id}/messages?data=${data}`);
      if (res) for (const m of res) {
        const v = m[field];
        if (v != null && v > 0) {
          const rawL = (field === 'can.fuel.level') ? (tank ? v/100*tank : null) : v;
          const calL = calFuel(rawL, md);
          const l = calL == null ? null : capFuel(Math.round(calL), tank);
          if (l != null) { lastFuel[dev.id] = l; lastFuelTs[dev.id] = Date.now(); try { localStorage.setItem('lastFuel', JSON.stringify(lastFuel)); localStorage.setItem('lastFuelTs', JSON.stringify(lastFuelTs)); } catch(e){} return l; }
        }
      }
    } catch(e){}
  }
  return null;
}

// ===== ЖИВЕ опитування помилок авто (OBD faultcodes через flespi) =====
// Працює на БУДЬ-ЯКОМУ з наших авто (перевірено на всіх 5): трекер сам питає блок авто і повертає
// реальні DTC-коди (P0301 тощо) або "No fault codes detected". Потрібен трекер онлайн і ввімкнене запалювання.
const _faultsInflight = {};
async function checkFaults(devId) {
  // елемент шукаємо ЩОРАЗУ заново: openDetail перетирає dBody, і захоплений один раз вузол ставав
  // «відірваним» — результат писався в нікуди, а кнопка в новій панелі мовчала до кінця циклу
  const getEl = () => document.getElementById('faults_' + devId);
  let el = getEl();
  if (!el) return;
  if (_faultsInflight[devId]) return;   // вже питаємо — другий тап не шле другу команду
  _faultsInflight[devId] = true;
  el.style.display = 'block';
  el.textContent = '⏳ Питаю авто (до 60 сек — трекер має бути на звʼязку)…';
  try {
    const posted = await api(`/gw/devices/${devId}/commands-queue`, 'POST', [{ name:'custom', properties:{ text:'faultcodes' } }]);
    const cmdId = posted && posted[0] && posted[0].id;
    if (!cmdId) throw new Error('не вдалось надіслати');
    let fails = 0;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      el = getEl();
      if (!el) return;                                   // панель закрили/перебудували — далі мовчки не полимо
      let res;
      // кожен невдалий пол = до 3 HTTP-спроб усередині api() (під лімітом — 1 і одразу помилка); 2 фейли поспіль — стоп
      try { res = await api(`/gw/devices/${devId}/commands-result/${cmdId}`); fails = 0; }
      catch(e) { if (++fails >= 2) { el.textContent = '⚠️ flespi не відповідає — спробуй за хвилину.'; return; } continue; }
      const c = res && res[0];
      if (c && c.executed) {
        const txt = c.response || '';
        if (txt) {
          const c0 = faultsCache(devId) || {};
          delete c0.pendingCmd; delete c0.postedAt;      // жива відповідь закриває і авто-команду
          try { localStorage.setItem('faults:' + devId, JSON.stringify({ ...c0, ts: Date.now(), txt: String(txt).slice(0, 500) })); } catch(e){}
        }
        if (/no fault codes/i.test(txt)) {
          el.innerHTML = '<span style="color:#2ecc71">✅ Помилок не виявлено (блок авто відповів напряму)</span>';
        } else {
          // показуємо сирі коди — їх можна прогуглити (P/C/B/U-код) або показати мені
          el.innerHTML = '<span style="color:#e74c3c">🛑 Авто повідомило: ' + esc(txt) + '</span>';
        }
        return;
      }
    }
    el.textContent = '⌛ Авто не відповіло за 60 сек — найчастіше заглушене запалювання. Спробуй, коли машина заведена.';
  } catch(e) {
    el = getEl();
    if (el) el.textContent = '⚠️ Не вийшло: ' + e.message + ' — спробуй ще раз.';
  } finally {
    delete _faultsInflight[devId];
  }
}

// ===== АВТО-опитування помилок: 2 рази на добу, поки застосунок відкритий =====
// Помилки двигуна не зникають самі (лампа горить, поки не полагодиш) — тому частіше питати нема сенсу,
// а трафік команди копійчаний (~0.5 КБ). Команда лежить у черзі до 6 год і виконується, щойно трекер
// виходить на звʼязок (вранці із запуском двигуна). Результат кешується локально й видно в детальці.
const FAULTS_STALE_MS = 12 * 3600 * 1000;
function faultsCache(devId){ try { return JSON.parse(localStorage.getItem('faults:' + devId)) || null; } catch(e){ return null; } }
function faultsBad(txt){ return /[PBCU][0-9]{3,4}/i.test(txt || ''); }   // у відповіді є реальний DTC-код
const _appOpenedAt = Date.now();
const _autoPolling = {};
async function autoFaultsSweep(devs){
  // гейт «раз на годину» — у localStorage: кожне відкриття PWA = новий JS-контекст, і лічильник у
  // памʼяті означав би sweep на КОЖНОМУ відкритті (внесок у сплеск запитів → «забагато запитів»)
  const lastAt = +localStorage.getItem('autoFaultsAt') || 0;
  if (Date.now() - lastAt < 3600 * 1000) return;
  if (Date.now() - _appOpenedAt < 90 * 1000) return;      // перші 90 с після відкриття кеші й так холодні — не додаємо навантаження
  try { localStorage.setItem('autoFaultsAt', String(Date.now())); } catch(e){}
  let slot = 0;
  for (const d of devs) {
    const c = faultsCache(d.id);
    if (c && c.ts && Date.now() - c.ts < FAULTS_STALE_MS) continue;                       // свіже — пропускаємо
    if (c && c.pendingCmd && Date.now() - (c.postedAt || 0) < 6 * 3600 * 1000) {          // команда ще в черзі — дочекаємось її
      const cmd = c.pendingCmd;
      setTimeout(() => pollAutoFaults(d.id, cmd), slot++ * 5000);                          // розносимо старти, щоб пулери не били залпом
      continue;
    }
    try {
      const posted = await api(`/gw/devices/${d.id}/commands-queue`, 'POST',
        [{ name:'custom', properties:{ text:'faultcodes' }, max_attempts: 20, ttl: 21600 }]);
      const cmdId = posted && posted[0] && posted[0].id;
      if (cmdId) {
        try { localStorage.setItem('faults:' + d.id, JSON.stringify({ ts: (c && c.ts) || 0, txt: (c && c.txt) || '', pendingCmd: cmdId, postedAt: Date.now() })); } catch(e){}
        setTimeout(() => pollAutoFaults(d.id, cmdId), slot++ * 5000);
      }
    } catch(e){ /* тихо: наступний цикл повторить */ }
  }
}
async function pollAutoFaults(devId, cmdId){
  if (_autoPolling[devId]) return;
  _autoPolling[devId] = true;
  try {
    for (let i = 0; i < 4; i++) {                     // 4 спроби по 3 хв: команда й так лежить у черзі 6 год, часто питати нема сенсу
      let res;
      try { res = await api(`/gw/devices/${devId}/commands-result/${cmdId}`); } catch(e){ return; }
      const c = res && res[0];
      if (c && c.executed && c.response) {
        try { localStorage.setItem('faults:' + devId, JSON.stringify({ ts: Date.now(), txt: String(c.response).slice(0, 500) })); } catch(e){}
        return;
      }
      if (c && c.executed === false) return;          // команда протухла невиконаною — новий цикл поставить свіжу
      await new Promise(r => setTimeout(r, 180000));
    }
  } finally { delete _autoPolling[devId]; }
}

// ===== Розрахунковий баланс SIM (заліза для USSD у FMB003 нема — ведемо чесну бухгалтерію) =====
// metadata: simBalance (грн на дату simBalanceDate) − simFee (грн/міс, списується 1-го числа).
// Після кожного поповнення користувач каже суму — оновлюємо simBalance/simBalanceDate у метаданих.
function simEstimate(md){
  if (!md || md.simBalance == null || !md.simBalanceDate || !md.simFee) return null;
  const start = new Date(md.simBalanceDate + 'T00:00:00');
  const now = new Date();
  if (isNaN(start) || now < start) return null;
  // скільки списань 1-го числа минуло ПІСЛЯ дати відліку
  const crossings = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  const est = Math.round((md.simBalance - crossings * md.simFee) * 100) / 100;
  return { est, low: est < md.simFee + 2 };   // «мало» = не вистачить на наступне списання (+2 грн запасу)
}

// ===== Стан акумулятора / звʼязку / супутників (діагностика) =====
function vehVolt(tel){ return tv(tel, 'external.powersource.voltage'); }   // бортова напруга (12В акумулятор авто)
function trkBatt(tel){ return tv(tel, 'battery.level'); }                  // батарея самого трекера, %
function satCount(tel){ return tv(tel, 'position.satellites'); }          // супутники GPS
function gsmInfo(tel){
  let g = tv(tel, 'gsm.signal.level');
  if (g == null) return null;
  const pct = g <= 5 ? Math.round(g/5*100) : Math.round(g);   // Teltonika: шкала 0-5 або 0-100 → у %
  const label = pct>=80?'відмінний' : pct>=50?'добрий' : pct>=25?'слабкий' : 'поганий';
  return { pct, label };
}
function voltHealth(v){   // оцінка стану 12В акумулятора
  if (v == null) return '';
  if (v >= 13.0) return 'заряджається';   // двигун працює (генератор дає 13.5-14.5В)
  if (v >= 12.4) return 'норма';          // повний у спокої
  if (v >= 12.0) return 'низький';
  return 'слабкий';                        // < 12В — сідає
}
// запас ходу з відсіканням глюків (датчик інколи віддає абсурд типу 47722 км)
function rangeKm(tel){ const r = tv(tel,'can.vehicle.remaining.range'); return (r != null && r > 0 && r <= 1500) ? Math.round(r) : null; }
// gnss.state.enum — це Teltonika AVL 69 «GNSS Status», а НЕ датчик глушіння (AVL 318 у flespi = gnss.jamming.state,
// на наших FMB003 не увімкнений): 0 = GNSS вимкнений, 1 = є фікс, 2 = увімкнений, але фіксу нема, 3 = сон, 4 = фікс
// з невалідними даними. Перевірено на 36,8 тис. живих записів (29.09–05.10): стан 1 ⇔ valid=true, стан 2 ⇔ valid=false
// у 100% випадків. Тобто «2» каже лише «фіксу нема» — РЕБ, дах/гараж чи завислий модуль, трекер не розрізняє.
// Раніше це читалось як «критичне глушіння»: стоянка без неба виглядала як «РЕБ», а сон GNSS (0) — як «перевір антену».
// ===== Якість GPS-фікса (єдине джерело правди про «чи можна вірити координатам») =====
// Під час РЕБ трекер часто шле СФАБРИКОВАНИЙ фікс: position.valid=true, але 0 супутників і координати
// зсунуті на десятки км (лишаючись у межах України, тому geo-щит saneRegion сам це не ловить).
// Тому «твердим» вважаємо фікс лише коли: явно валідний + супутників ≥4 + у нашому регіоні + HDOP притомний.
function fixQuality(tel){
  const valid = tv(tel,'position.valid');
  const sats  = tv(tel,'position.satellites');
  const hdop  = tv(tel,'position.hdop');
  const lat = tv(tel,'position.latitude'), lon = tv(tel,'position.longitude');
  const inRegion = lat != null && lon != null && saneRegion(lat, lon);
  const solid = valid === true && sats != null && sats >= 4 && inRegion && (hdop == null || hdop <= MAX_HDOP);
  return { valid, sats, hdop, lat, lon, inRegion, solid };
}
function gnssJamState(tel){
  const s = tv(tel,'gnss.state.enum');
  if (s !== 1 && s !== 2) return 0;   // 0/3 — GNSS вимкнений/спить (штатне енергозбереження на стоянці), 4/нема — не тривога
  // Повертаємо: 2 = GNSS увімкнений, а фіксу НЕМА; 1 = трекер каже «фікс є», але він НЕ твердий
  // (мало супутників / поза регіоном / поганий HDOP) — це підпис спуфу №1 під РЕБ. Твердий фікс = 0.
  // ВАЖЛИВО: перевіряємо саме fixQuality.solid, а НЕ голий position.valid — під час спуфінгу valid=true
  // приходить із 0 супутників (брехня), і раніше це хибно гасило індикатор → лічильник стрибав на «0 хв».
  if (fixQuality(tel).solid) return 0;
  return s;
}
// Скільки часу поспіль трекер НЕ бачить супутників, попри те що авто ЇДЕ (акселерометр).
// Це найчесніший сигнал «ми не знаємо, де авто»: під РЕБ трекер шле останню відому точку,
// і один випадковий «чистий» запис (17 супутників) миттєво гасив тривогу — 30.07 Ducato
// 99% записів мав jam=2 і 0 супутників, їхав, а застосунок показував базу без жодного попередження.
let blindSince = {}, blindSeenAt = {}, _blindMoveTs = {}, posSeen = {};
try { blindSince = JSON.parse(localStorage.getItem('blindSince') || '{}'); } catch(e) { blindSince = {}; }
try { blindSeenAt = JSON.parse(localStorage.getItem('blindSeenAt') || '{}'); } catch(e) { blindSeenAt = {}; }
try { posSeen = JSON.parse(localStorage.getItem('posSeen') || '{}'); } catch(e) { posSeen = {}; }
// Рендер ЗНІМКА при відкритті (init) — це минуле: детектори нижче його лише ЧИТАЮТЬ. Інакше вчорашній
// movement=true зі знімка «підживлював» епізод «їде наосліп», а стара точка — лічильник застиглої позиції.
let _snapRender = false;
// Скільки часу координати НЕ змінюються. Ключ до діагностики ЗАВИСАННЯ GNSS-модуля: після довгого
// глушіння FMB003 починає рапортувати «17 супутників, valid=true», але видає ОДНУ Й ТУ САМУ точку
// (30.07 Ducato: 120 хв поспіль байт-у-байт ті самі 50.895157/34.808488, поки MegaGPS на тому ж авто
// показував правду). Справжній фікс ніколи не повторюється до 6-го знака — тому це надійна ознака.
// Міряємо СЕРВЕРНИМ часом пакетів (server.timestamp), а не годинником телефона: у трекера без звʼязку
// телеметрія просто застигла, і «точка стоїть 20 хв» було б неправдою (DEEP-HANG = час росте, значення ті самі).
// posSeen.mv — ДОКАЗ, що авто справді їхало, поки точка стояла: CAN-одометр зріс ≥2 км. Без доказу застигла
// точка — це static navigation на зупинці (координати застигають, а акселерометр ще ~2 хв каже «рух»), і
// картка після кожної зупинки блимала «Завис GPS-модуль»; при довгому розвантаженні з мотором — і cpureset.
function posFrozenMs(devId, tel){
  const la = tv(tel,'position.latitude'), lo = tv(tel,'position.longitude');
  if (la == null || lo == null) return 0;
  const p = posSeen[devId];
  const same = !!(p && p.st != null && Math.abs(p.la - la) <= 1e-5 && Math.abs(p.lo - lo) <= 1e-5);
  const st = tv(tel,'server.timestamp') || Date.now()/1000;
  if (_snapRender) return same ? Math.max(0, (st - p.st) * 1000) : 0;
  const odC = tv(tel,'can.vehicle.mileage'), od = (odC != null && odC > 0) ? odC : null;   // od>0: Leaf шле глюк-нулі
  if (!same) {   // нова точка (або старий запис без st — міряємо заново)
    posSeen[devId] = { la, lo, ts: Date.now(), st, od };
    try { localStorage.setItem('posSeen', JSON.stringify(posSeen)); } catch(e){}
    return 0;
  }
  if (!p.mv) {
    let dirty = false;
    if (p.od == null && od != null) { p.od = od; dirty = true; }   // одометр зʼявився пізніше за точку — відлік від нього
    // лише свіжий пакет із movement=true; де є CAN-спідометр, він теж має показувати рух — так глюк-стрибок
    // одометра на місці (Master 0516 10.09: 294505↔294501) не стає «доказом». Електрички без CAN-швидкості — по одометру.
    const canSp = tv(tel,'can.vehicle.speed');
    if (od != null && p.od != null && od - p.od >= 2 && statusOnline(tel) && tv(tel,'movement.status') === true && (canSp == null || canSp > 10)) { p.mv = true; dirty = true; }
    if (dirty) { try { localStorage.setItem('posSeen', JSON.stringify(posSeen)); } catch(e){} }
  }
  return Math.max(0, (st - p.st) * 1000);
}
// «Їде наосліп»: авто рухається (акселерометр), а позиції ми фактично не знаємо — або нема твердого
// фікса (глушіння), або координати заморожені (завис GNSS-модуль).
function blindDrivingMs(devId, tel){
  const now = Date.now();
  if (_snapRender) return blindSince[devId] ? now - blindSince[devId] : 0;
  // «рух» — лише зі СВІЖОЇ телеметрії: у трекера без звʼязку movement=true застигає з останнього пакета,
  // і застигла картинка давала «їде наосліп» → «Завис GPS-модуль» → cpureset у чергу (ребут одразу після реконекту)
  const moving = statusOnline(tel) && tv(tel,'movement.status') === true;
  const solid  = fixQuality(tel).solid;
  const frozen = posFrozenMs(devId, tel) > 120000 && !!(posSeen[devId] && posSeen[devId].mv);   // 2 хв без зміни координат, хоча авто доведено їде
  if (moving) _blindMoveTs[devId] = now;
  const movedRecently = _blindMoveTs[devId] && (now - _blindMoveTs[devId] < 300000);
  const save = () => { try { localStorage.setItem('blindSince', JSON.stringify(blindSince)); localStorage.setItem('blindSeenAt', JSON.stringify(blindSeenAt)); } catch(e){} };
  if ((solid && !frozen) || !movedRecently) {
    if (blindSince[devId]) { delete blindSince[devId]; delete blindSeenAt[devId]; save(); }
    return 0;
  }
  // Епізод «без фіксу», якого застосунок не бачив >5 хв (закритий / iOS у фоні), НЕ продовжуємо: твердий фікс міг
  // бути й минути непомітно, а вчорашній незакритий blindSince + перший нетвердий пакет уранці давали «їде наосліп
  // 14 год» і миттєвий cpureset. Довге «без фіксу на ходу» між сеансами ловить jam-гілка (6 год, зі звіркою flespi).
  // Застиглу точку з доказом руху (posSeen.mv) продовжуємо: її безперервність підтверджують самі дані — та сама
  // точка байт-у-байт із тим самим записом posSeen, тобто справний GNSS за перерву точку не зрушив.
  const seen = blindSeenAt[devId] || 0;
  if (!blindSince[devId] || (now - seen > 300000 && !(solid && frozen))) { blindSince[devId] = now; blindSeenAt[devId] = now; save(); }
  else if (now - seen > 60000) { blindSeenAt[devId] = now; save(); }   // «бачив» пишемо не частіше разу на хвилину
  return now - blindSince[devId];
}
// відколи авто без фіксу (щоб показувати «вже Х хв», а не просто статичний прапорець).
// ГІСТЕРЕЗИС (v74): епізод закривається лише після 3 хв БЕЗПЕРЕРВНО чистого стану. Без цього
// мерехтіння супутників 3↔5 на межі порогу обнуляло лічильник щоцикла → fast-poll перевзводився
// нескінченно (навантаження на ліміт flespi), а 6-год поріг авто-перезавантаження ніколи не накопичувався.
const JAM_CLEAR_MS = 3 * 60000;
let jamStartTs = {}, _jamCleanSince = {}, jamSeenAt = {}, _jamVerAt = {}, _jamVerP = {};
try { jamStartTs = JSON.parse(localStorage.getItem('jamStartTs') || '{}'); } catch(e) { jamStartTs = {}; }
try { jamSeenAt = JSON.parse(localStorage.getItem('jamSeenAt') || '{}'); } catch(e) { jamSeenAt = {}; }
// Епізод живе в localStorage між сеансами, а закривається, лише коли застосунок САМ бачить 3 хв чистого стану.
// Коли застосунок не дивився (закритий / iOS у фоні), фікс міг бути й минути непомітно: відкрив на хвилину зранку,
// удень фікс був — о 15:00 картка писала «вже 6 год 44 хв», і йшов cpureset. Тому після перерви в спостереженні
// звіряємо початок з історією flespi: ОДИН запит — останній твердий фікс (valid + ≥4 супутники) після початку
// епізоду; знайшовся — епізод рахуємо від нього. Перед авто-ребутом звірка обовʼязкова (autoReboot).
// Епізод, що почався ДО відкриття застосунку, показувався як «нема GPS-фіксу вже 11 с» (Kangoo 8440 09.10:
// глушіння під Борисполем тривало ~40 хв, авто їхало). jamVerify уміє лише посунути початок ПІЗНІШЕ, тому при
// першому помічанні епізоду беремо з flespi останній твердий фікс: епізод почався одразу після нього (1 запит).
const _jamBackP = {};
function jamBackfill(devId){
  const st0 = jamStartTs[devId];
  if (!st0 || _jamBackP[devId]) return;
  const toS = Math.floor(st0 / 1000);
  const data = encodeURIComponent(JSON.stringify({ from: toS - 24*3600, to: toS, reverse: true, count: 1,
    filter: 'position.valid=true&&position.satellites>=4', fields: 'timestamp' }));
  _jamBackP[devId] = api(`/gw/devices/${devId}/messages?data=${data}`).then(res => {
    const fx = res && res[0] && res[0].timestamp;
    const t = fx ? fx * 1000 : (toS - 24*3600) * 1000;   // за добу жодного твердого фікса — щонайменше доба
    if (jamStartTs[devId] === st0 && t < st0) {           // епізод не закрили й не переставили, поки йшов запит
      jamStartTs[devId] = t;
      try { localStorage.setItem('jamStartTs', JSON.stringify(jamStartTs)); } catch(e){}
    }
  }).catch(()=>{}).finally(() => { delete _jamBackP[devId]; });
}
function jamVerify(devId){
  if (_jamVerP[devId]) return _jamVerP[devId];
  const st0 = jamStartTs[devId];
  if (!st0) return Promise.resolve();
  _jamVerAt[devId] = Date.now();
  const data = encodeURIComponent(JSON.stringify({ from: Math.floor(st0/1000), to: Math.floor(Date.now()/1000), reverse: true, count: 1,
    filter: 'position.valid=true&&position.satellites>=4', fields: 'timestamp' }));
  _jamVerP[devId] = api(`/gw/devices/${devId}/messages?data=${data}`).then(res => {
    const fx = res && res[0] && res[0].timestamp;
    if (fx && fx * 1000 > st0 && jamStartTs[devId] === st0) {   // епізод не закрили/не переставили, поки йшов запит
      jamStartTs[devId] = fx * 1000;
      try { localStorage.setItem('jamStartTs', JSON.stringify(jamStartTs)); } catch(e){}
    }
  }).finally(() => { delete _jamVerP[devId]; });
  return _jamVerP[devId];
}
function jamDuration(devId, jamState){
  const now = Date.now();
  if (_snapRender) return jamStartTs[devId] ? now - jamStartTs[devId] : 0;   // знімок лише читаємо
  if (jamState > 0) {
    delete _jamCleanSince[devId];
    if (!jamStartTs[devId]) { jamStartTs[devId] = now; try { localStorage.setItem('jamStartTs', JSON.stringify(jamStartTs)); } catch(e){} jamBackfill(devId); }
    else if (now - (jamSeenAt[devId] || 0) > JAM_CLEAR_MS && now - (_jamVerAt[devId] || 0) > 300000) jamVerify(devId).catch(()=>{});   // була перерва — звіряємо (≤1 запит на 5 хв)
    if (now - (jamSeenAt[devId] || 0) > 60000) { jamSeenAt[devId] = now; try { localStorage.setItem('jamSeenAt', JSON.stringify(jamSeenAt)); } catch(e){} }
    return now - jamStartTs[devId];
  }
  if (jamStartTs[devId]) {
    if (!_jamCleanSince[devId]) _jamCleanSince[devId] = now;
    if (now - _jamCleanSince[devId] < JAM_CLEAR_MS) return now - jamStartTs[devId];   // ще не віримо, що скінчилось
    delete jamStartTs[devId]; delete _jamCleanSince[devId]; delete jamSeenAt[devId];
    try { localStorage.setItem('jamStartTs', JSON.stringify(jamStartTs)); localStorage.setItem('jamSeenAt', JSON.stringify(jamSeenAt)); } catch(e){}
  }
  return 0;
}
// ===== АВТОЛІКУВАННЯ зависання GPS-модуля =====
// Доведено перехресною перевіркою з MegaGPS (05.07.2026): після ДОВГОГО глушіння GPS-модуль FMB003
// зависає і НЕ відновлюється сам, навіть коли РЕБ вимкнувся (MegaGPS на тих самих авто вже чистий,
// а FMB003 далі рапортує «фіксу нема», стан 2). Ліки — cpureset. Робимо це автоматично, але ЛИШЕ НА ХОДУ:
// «фіксу нема» на стоянці — це найчастіше дах / гараж / місце без неба, і ребут там нічого не лікує
// (Master Зелений за місяць отримав 18 cpureset, стоячи на одному місці). Команда йде в чергу flespi.
// Кулдаун 12 год: якщо РЕБ реально ще давить, дарма не смикаємо (ребут під час справжнього глушіння нешкідливий, але й безглуздий).
const AUTO_REBOOT_AFTER_MS = 6 * 3600000, AUTO_REBOOT_COOLDOWN_MS = 12 * 3600000;
let autoRebootAt = {};
try { autoRebootAt = JSON.parse(localStorage.getItem('autoRebootAt') || '{}'); } catch(e) { autoRebootAt = {}; }
const _rbBusy = {};   // перевірка/постановка вже йде — паралельні refresh її не дублюють
// cpureset уже чекає в черзі flespi (ручна кнопка, автоматика або ІНШИЙ телефон/Mac — кулдаун у кожного свій) —
// другий не ставимо: 2–3 cpureset поспіль дають трекеру цикл перезавантажень
async function cpuresetQueued(id){
  const q = await api(`/gw/devices/${id}/commands-queue/all`);
  return (q || []).some(c => /cpureset/i.test(JSON.stringify(c || {})));
}
function maybeAutoReboot(d, tel){
  // ДВІ причини перезавантажити: (1) авто ЇДЕ, а фіксу нема >6 год (звірено з історією flespi);
  // (2) авто ЇДЕ, а позиції нема/вона заморожена >20 хв — типове зависання GNSS-модуля, яке саме не минає (Ducato 30.07).
  const blind = blindDrivingMs(d.id, tel);
  // трекер без звʼязку: телеметрія застигла, «їде наосліп» тут — артефакт, а cpureset ліг би в чергу й перезавантажив
  // трекер одразу після реконекту. На ходу трекер шле пакети щокілька секунд, тож справжній випадок це не відсікає.
  if (!statusOnline(tel)) return;
  const jamLong = tv(tel,'movement.status') === true && gnssJamState(tel) === 2 && jamDuration(d.id, 2) >= AUTO_REBOOT_AFTER_MS;
  if (!jamLong && blind < 20*60000) return;
  if (Date.now() - (autoRebootAt[d.id] || 0) < AUTO_REBOOT_COOLDOWN_MS || _rbBusy[d.id]) return;
  _rbBusy[d.id] = true;
  autoReboot(d.id, blind < 20*60000).finally(() => { delete _rbBusy[d.id]; });
}
async function autoReboot(id, byJam){
  try {
    if (byJam) {
      // епізод міг тягнутись із попереднього сеансу, коли застосунок не бачив фіксів — перед ребутом правда від сервера
      await jamVerify(id);
      if (!jamStartTs[id] || Date.now() - jamStartTs[id] < AUTO_REBOOT_AFTER_MS) return;   // твердий фікс був — модуль живий
    }
    if (!(await cpuresetQueued(id))) {
      await api(`/gw/devices/${id}/commands-queue`, 'POST', [{ name:'custom', properties:{ text:'cpureset' } }]);
    }
    autoRebootAt[id] = Date.now();
    try { localStorage.setItem('autoRebootAt', JSON.stringify(autoRebootAt)); } catch(e){}
  } catch(e) {
    // фейл (типово — вибитий ліміт, і в регіональне глушіння це 5 авто РАЗОМ) → повтор не раніше ніж за 10 хв,
    // а не на кожному рендері: раніше знімали кулдаун повністю — ще +15 HTTP на рендер
    autoRebootAt[id] = Date.now() - AUTO_REBOOT_COOLDOWN_MS + 10*60000;
  }
}
// що писати на картці про ребут — лише правду: раніше «перезавантажую трекер» висіло з 2-ї хвилини,
// хоча автоматика ставить cpureset лише через 20 хв і поза 12-год кулдауном
// ===== ЗАВИСЛИЙ ФІКС після глушіння (07.10.2026, Master 9216) =====
// 14:51–15:02 РЕБ під Сумами, авто проїхало ще 14 км, а з 15:14 трекер рапортує valid=true і 13 супутників
// з БАЙТ-У-БАЙТ тією самою точкою, що перед глушінням. «Їде наосліп» цього не бачить (фікс же «є»), а на
// стоянці й поготів — тому точка висіла на трасі, хоча авто було в Сумах. Доказ зависання: точка та сама,
// а CAN-одометр за цей час виріс на ≥STUCK_FIX_KM, причому ПОСТУПОВО і з запалюванням/рухом (не одним
// стрибком на стоянці — так «розмерзається» CAN-одометр Leaf, і це не зависання GPS).
const STUCK_FIX_KM = 2, STUCK_CHECK_MS = 15 * 60000;
const stuckFix = {}, _stuckAt = {};   // stuckFix[id] = { km, k } — поточний вердикт; _stuckAt — коли востаннє перевіряли
function stuckFromHistory(msgs){   // msgs — від НОВІШОГО до старішого (reverse:true)
  const key = m => (m['position.latitude'] == null || m['position.longitude'] == null) ? null
    : m['position.latitude'].toFixed(6) + ',' + m['position.longitude'].toFixed(6);
  const k0 = msgs.length ? key(msgs[0]) : null;
  if (!k0) return null;
  let odoNow = null, odoStart = null, live = 0;
  const odos = new Set();
  for (const m of msgs) {
    const od = m['can.vehicle.mileage'];
    if (key(m) !== k0) { if (od > 0 && odoStart == null) odoStart = od; break; }   // перший запис ДО появи точки
    if (od > 0) { if (odoNow == null) odoNow = od; odoStart = od; odos.add(od); }
    if (m['engine.ignition.status'] === true || m['movement.status'] === true) live++;
  }
  if (odoNow == null || odoStart == null) return null;
  const km = odoNow - odoStart;
  return (km >= STUCK_FIX_KM && km < 1500 && odos.size >= 3 && live >= 3) ? { km: Math.round(km), k: k0 } : null;
}
async function checkStuckFix(d){
  const tel = d.telemetry || {};
  if (!fixQuality(tel).solid || !(tv(tel,'can.vehicle.mileage') > 0)) { delete stuckFix[d.id]; return; }   // нема «твердого» фікса — інші тривоги
  const k = tv(tel,'position.latitude').toFixed(6) + ',' + tv(tel,'position.longitude').toFixed(6);
  if (stuckFix[d.id] && stuckFix[d.id].k !== k) delete stuckFix[d.id];   // точка зрушила — модуль ожив
  if (Date.now() - (_stuckAt[d.id] || 0) < STUCK_CHECK_MS) return;
  _stuckAt[d.id] = Date.now();
  try {
    const now = Math.floor(Date.now() / 1000);
    const q = encodeURIComponent(JSON.stringify({ from: now - 12 * 3600, to: now, count: 400, reverse: true,
      fields: 'timestamp,position.latitude,position.longitude,can.vehicle.mileage,engine.ignition.status,movement.status' }));
    const v = stuckFromHistory((await api(`/gw/devices/${d.id}/messages?data=${q}`)) || []);
    if (v && v.k === k) {
      stuckFix[d.id] = v;
      // лікування — те саме перезавантаження, що й для «наосліп», з тим самим 12-год кулдауном і перевіркою черги.
      // Трекер може спати (авто заглушене) — команда чекає в черзі й виконається при пробудженні (07.10: за ~4 хв).
      if (Date.now() - (autoRebootAt[d.id] || 0) >= AUTO_REBOOT_COOLDOWN_MS && !_rbBusy[d.id]) {
        _rbBusy[d.id] = true;
        autoReboot(d.id, false).finally(() => { delete _rbBusy[d.id]; });
      }
    } else delete stuckFix[d.id];
  } catch(e) { _stuckAt[d.id] = Date.now() - STUCK_CHECK_MS + 2 * 60000; }   // збій — повтор за 2 хв, не на кожному рендері
}
function rebootNote(id, blindMs){
  const at = autoRebootAt[id] || 0, ago = Date.now() - at;
  if (ago < 30*60000) return 'перезавантаження надіслано о ' + fmtTime(at/1000);
  if (ago >= AUTO_REBOOT_COOLDOWN_MS && blindMs < 20*60000) return 'якщо не мине — перезавантажу трекер за ' + fmtDur(Math.max(60, (20*60000 - blindMs)/1000));
  return 'перевір трекер (кнопка перезавантаження — у деталях)';
}
// запас з адаптацією під ЗАРЯД для електричок (датчик авто застрягає на постійному значенні — як Kangoo Z.E. = 185 при будь-якому %)
function vehicleRange(dev, tel){
  const md = (dev && typeof dev === 'object' && dev.metadata) || {};
  const soc = socOf(dev, tel);
  if (soc != null && md.evRangeFull) return Math.round(soc / 100 * md.evRangeFull);   // електро: заряд% × повний запас
  const r = rangeKm(tel);
  if (r != null) return r;                                                            // CAN-запас авто (де віддає, без глюків)
  const liters = fuelLiters(dev, tel);                                               // ДВЗ без CAN-запасу: оцінка літри × км/л
  if (liters != null) return Math.round(liters * (md.kmPerLiter || 10));
  return null;
}
// електричка? Одна ознака для всіх місць (палива в неї нема — історію палива не тягнемо, підписи «заряд», не «паливо»)
function isEVdev(dev){ return !!(dev && dev.metadata && (dev.metadata.ev || dev.metadata.evRangeFull)); }
// SoC тягової батареї. 0 / >100 — глюк телеметрії: Kangoo Z.E. 05.10 двадцять хвилин тримав SoC=0 на стоянці
// при реальних 76 %, і картка писала «0 % · 0 км запас» (звіт ці нулі вже відсіював — живі екрани ні).
// Справжня батарея до 0 не сідає (BMS вимикає авто раніше) → показуємо останнє валідне значення.
let lastSoc = {};
try { lastSoc = JSON.parse(localStorage.getItem('lastSoc') || '{}'); } catch(e) { lastSoc = {}; }
function socOf(dev, tel){
  const s = tv(tel,'can.vehicle.battery.level'), id = dev && dev.id;
  if (s != null && s > 0 && s <= 100) {
    if (id && lastSoc[id] !== s) { lastSoc[id] = s; try { localStorage.setItem('lastSoc', JSON.stringify(lastSoc)); } catch(e){} }   // пишемо лише зміну
    return s;
  }
  return (s != null && id && lastSoc[id] != null) ? lastSoc[id] : null;
}
// EV-батарея (тягова) — для електричок
function evBatt(tel, dev){
  return {
    soc: socOf(dev, tel),                           // заряд, % (без глюків-нулів)
    soh: tv(tel,'can.vehicle.battery.health'),      // здоровʼя (знос), %
  };
}
// OBD-стан двигуна (з CAN авто)
function engineTemp(tel){ return tv(tel,'can.engine.coolant.temperature'); }   // °C
function dtcCount(tel){ return tv(tel,'can.dtc.number'); }                      // к-сть помилок (check engine)
function serviceKm(tel){ return tv(tel,'can.service.mileage'); }               // пробіг до ТО
function adblueLevel(tel){ return tv(tel,'can.adblue.level'); }                // AdBlue % (дизелі)

// ===== Перезавантаження трекера (для зависань) =====
async function rebootTracker(id) {
  const dev = devCache.find(d => d.id === id);
  const name = dev ? dev.name : '';
  if (!confirm('Надіслати трекеру «' + name + '» команду перезавантаження?\n\nКорисно коли трекер завис. Виконається одразу (якщо на зв\'язку) або щойно відновить зв\'язок.')) return;
  try {
    // уже в черзі (автоматика чи інший телефон) — другий cpureset поспіль дає цикл перезавантажень.
    // Не змогли перевірити — не блокуємо: це ручна дія, людина її підтвердила
    let queued = false;
    try { queued = await cpuresetQueued(id); } catch(e) {}
    if (queued) { alert('⏳ Команда перезавантаження вже в черзі.\nТрекер виконає її, щойно вийде на звʼязок.'); return; }
    await api('/gw/devices/' + id + '/commands-queue', 'POST', [{ name:'custom', properties:{ text:'cpureset' } }]);
    // ручний ребут теж запускає кулдаун автоматики — інакше вона за хвилину-дві ставила другий cpureset
    autoRebootAt[id] = Date.now();
    try { localStorage.setItem('autoRebootAt', JSON.stringify(autoRebootAt)); } catch(e){}
    alert('✅ Команду надіслано.\nТрекер перезавантажиться, щойно її отримає.');
  } catch (e) { alert('Помилка: ' + e.message); }
}

// ===== Іконка машини на карті (з метаданих) =====
// active = двигун у роботі → зелений світний обідок (колір машини для впізнавання лишається)
// ===== Малюнки авто для маркерів (безпечно: метадані містять лише КЛЮЧ зі списку, не сам HTML) =====
// Емодзі на карті дрібне й невиразне; для машин, де хочеться нормальний вигляд, ставимо metadata.iconSvg.
const VEH_SVG = {
  // ФУРГОН високий (Renault Master): короткий капот, високий дах, довгий вантажний відсік
  van: c => '<svg viewBox="0 0 64 34" width="32" height="32">'
    + '<path d="M4.5 25.5V10.5c0-1.7 1.3-3 3-3h25.6c1.3 0 2.5.6 3.3 1.6l6.2 7.9h11c2.5 0 4.6 2 4.6 4.6v4z"'
    + ' fill="'+c+'" stroke="#0d141c" stroke-width="1.6" stroke-linejoin="round"/>'
    + '<path d="M36.4 9.6l5.4 6.9h-5.4z" fill="#8fc0e8"/>'
    + '<rect x="8.5" y="10.8" width="9" height="5.4" rx=".8" fill="#8fc0e8"/>'
    + '<circle cx="16" cy="25.5" r="5.8" fill="#10161f"/><circle cx="48" cy="25.5" r="5.8" fill="#10161f"/>'
    + '<circle cx="16" cy="25.5" r="2.3" fill="#dbe4ee"/><circle cx="48" cy="25.5" r="2.3" fill="#dbe4ee"/></svg>',
  // КАНГУ / малий фургон: короткий, з вираженим капотом
  kangoo: c => '<svg viewBox="0 0 64 34" width="32" height="32">'
    + '<path d="M6 25.5V13.5c0-1.5 1.2-2.7 2.7-2.7h17.6c1.2 0 2.3.5 3 1.4l4.4 5.3h11.6c3.4 0 6.4 2 7.7 5.1l1.3 3z"'
    + ' fill="'+c+'" stroke="#0d141c" stroke-width="1.6" stroke-linejoin="round"/>'
    + '<path d="M27.4 12.6l3.9 4.9h-3.9z" fill="#8fc0e8"/>'
    + '<rect x="9.6" y="13.6" width="7.6" height="4.4" rx=".7" fill="#8fc0e8"/>'
    + '<circle cx="17" cy="25.5" r="5.6" fill="#10161f"/><circle cx="45" cy="25.5" r="5.6" fill="#10161f"/>'
    + '<circle cx="17" cy="25.5" r="2.2" fill="#dbe4ee"/><circle cx="45" cy="25.5" r="2.2" fill="#dbe4ee"/></svg>',
  // ЛЕГКОВИЙ хетчбек (Nissan Leaf): низький, обтічний
  hatch: c => '<svg viewBox="0 0 64 34" width="32" height="32">'
    + '<path d="M4 25.5l1.4-6.2c.4-1.8 1.7-3.2 3.4-3.8l7.4-2.6 5.6-3.4c1.2-.7 2.6-1.1 4-1.1h9.4c1.7 0 3.3.6 4.5 1.7l5.6 5 8.8 1.8c2.7.6 4.7 2.9 4.9 5.6l.3 3z"'
    + ' fill="'+c+'" stroke="#0d141c" stroke-width="1.6" stroke-linejoin="round"/>'
    + '<path d="M23 9.8h9.6c1.2 0 2.4.4 3.3 1.2l4.3 3.9-19.7-1.4z" fill="#8fc0e8"/>'
    + '<circle cx="17" cy="25.5" r="5.6" fill="#10161f"/><circle cx="46" cy="25.5" r="5.6" fill="#10161f"/>'
    + '<circle cx="17" cy="25.5" r="2.2" fill="#dbe4ee"/><circle cx="46" cy="25.5" r="2.2" fill="#dbe4ee"/></svg>',
  // КРОСОВЕР
  suv: c => '<svg viewBox="0 0 64 34" width="32" height="32">'
    + '<path d="M4.5 25c0-3.4.7-6.4 2.2-8.4l1.8-1.9c1.1-1.1 3-1.9 5-1.9h4.9l6.1-4.9c1.2-1 2.9-1.6 4.6-1.6h8.2c1.9 0 3.7.7 4.8 1.9l4.7 4.6h5.3c3 0 5.8 1.9 6.8 4.7l1.1 3.9c.4 1.6.4 2.7 0 3.6z"'
    + ' fill="'+c+'" stroke="#0d141c" stroke-width="1.6" stroke-linejoin="round"/>'
    + '<path d="M23.5 12.6l4.6-3.9c.7-.6 1.7-1 2.7-1h5.6c1.2 0 2.3.4 3 1.1l4.1 3.8z" fill="#8fc0e8"/>'
    + '<circle cx="17.5" cy="25.5" r="6" fill="#10161f"/><circle cx="46.5" cy="25.5" r="6" fill="#10161f"/>'
    + '<circle cx="17.5" cy="25.5" r="2.4" fill="#dbe4ee"/><circle cx="46.5" cy="25.5" r="2.4" fill="#dbe4ee"/></svg>'
};
// колір кузова беремо з метаданих, але ЛИШЕ якщо це справжній hex — інакше чужі метадані могли б
// підсунути довільний код усередину SVG
function safeColor(c, fallback) { return (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)) ? c : fallback; }
function vehIcon(dev, online, active, gpsLost) {
  const m = dev.metadata || {};
  const icon = m.icon || '🚗';
  const dim = online ? 1 : 0.55;
  // кантик навколо машинки: БІЛИЙ коли стоїть, ЗЕЛЕНИЙ коли в роботі, ЖОВТИЙ пунктир — GPS втрачено надовго (точка застаріла)
  const border = gpsLost ? '3px dashed #f39c12' : (active ? '3px solid #2ecc71' : '2px solid #fff');
  const glow = gpsLost ? ',0 0 8px 2px rgba(243,156,18,.85)' : (active ? ',0 0 8px 2px rgba(46,204,113,.85)' : '');
  const badge = gpsLost ? '<div style="position:absolute;top:-4px;right:-4px;font-size:12px">⚠️</div>' : '';
  // color/icon — з метаданих flespi → esc обовʼязково (та сама модель загрози, що для імен: XSS = крадіжка токена)
  // metadata.iconSvg — КЛЮЧ зі списку VEH_SVG (не HTML!), тому XSS неможливий навіть з чужих метаданих
  const drawer = Object.prototype.hasOwnProperty.call(VEH_SVG, m.iconSvg) ? VEH_SVG[m.iconSvg] : null;
  const svg = drawer ? drawer(safeColor(m.color, '#dfe8f2')) : null;
  const sz = svg ? 42 : 32;
  const inner = svg
    ? '<div style="background:#1c2735;border:'+border+';border-radius:50%;width:42px;height:42px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.6)'+glow+'">'+svg+'</div>'
    : '<div style="background:'+safeColor(m.color,'#3aa0ff')+';border:'+border+';border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 2px 6px rgba(0,0,0,.5)'+glow+'">'+esc(icon)+'</div>';
  const html = '<div style="position:relative;opacity:'+dim+'">'+inner+badge+'</div>';
  return L.divIcon({ className:'', html, iconSize:[sz,sz], iconAnchor:[sz/2,sz/2] });
}
function markerFor(dev, latlon, online, active, gpsLost) {
  const m = dev.metadata || {};
  const short = m.short || dev.name || '';
  const mk = L.marker(latlon, { icon: vehIcon(dev, online, active, gpsLost) });
  mk.bindTooltip(esc(short), { permanent:true, direction:'right', offset:[16,0], className:'veh-label' });
  return mk;
}

// ===== Список + головна мапа =====
let map, markers = {}, devCache = [];
let lastValidPos = {};   // остання ВАЛІДНА позиція кожного авто — щоб не зникали з карти й не стрибали в Перу
try { lastValidPos = JSON.parse(localStorage.getItem('lastValidPos') || '{}'); } catch(e) { lastValidPos = {}; }
let lastValidPosTs = {};   // коли саме був той останній валідний фікс — щоб бачити "GPS втрачено Х год тому"
try { lastValidPosTs = JSON.parse(localStorage.getItem('lastValidPosTs') || '{}'); } catch(e) { lastValidPosTs = {}; }
// чистка «зомбі»-позицій: якщо валідного фіксу не було 30+ днів — забуваємо (нема сенсу показувати місяцями стару точку)
{
  const cutoff = Date.now() - 30*86400000;
  for (const id of Object.keys(lastValidPosTs)) {
    if (lastValidPosTs[id] < cutoff) { delete lastValidPosTs[id]; delete lastValidPos[id]; }
  }
  try {
    localStorage.setItem('lastValidPos', JSON.stringify(lastValidPos));
    localStorage.setItem('lastValidPosTs', JSON.stringify(lastValidPosTs));
  } catch(e){}
}
const GPS_LOST_MS = 20 * 60 * 1000;   // якщо валідного фіксу нема довше 20 хв — це вже не «дрижання», а реальна проблема (антена/апаратура)

// ===== Чи можна ДОВІРЯТИ поточним координатам як новій позиції на карті =====
// Це і є захист від «стрибків»: приймаємо точку ЛИШЕ якщо (1) фікс твердий (є супутники, не спуф),
// (2) немає активного глушіння і (3) стрибок від останньої відомої точки фізично правдоподібний.
// Інакше тримаємо last-known-good — рівно як референсний трекер: маркер стоїть, а не телепортується.
// Повертає ҐРАДАЦІЮ довіри (v74, за код-ревʼю): 'solid' — твердий фікс, оновлює ЯКІР last-known-good;
// 'tentative' — показати можна (жовтий прапорець глушіння висить), але якір НЕ чіпати; false — не показувати.
// Ключові принципи після ревʼю:
//  1. Твердий фікс перевіряється ПЕРШИМ і приймається завжди — інакше чесний фікс після РЕБ
//     блокувався телепорт-фільтром на dist/150 годин (якір застарів, швидкість «астрономічна»).
//  2. Якір оновлюють ЛИШЕ solid-фікси — інакше повзучий спуф крок за кроком перетягував еталон,
//     а детектори «мертва антена / точка застаріла» ніколи не спрацьовували (Ts освіжався щоцикла).
//  3. Телепорт-фільтр застосовується лише до НЕтвердих точок, відносно останнього solid-якоря.
function trustPosition(devId, tel){
  const fq = fixQuality(tel);
  if (fq.lat == null || fq.lon == null || !fq.inRegion) return false;   // сміття/Ліма — ні
  if (fq.solid) return 'solid';
  const prev = lastValidPos[devId], prevTs = lastValidPosTs[devId];
  if (prev && prevTs){
    const dt = (Date.now() - prevTs) / 1000;
    if (dt <= 0) return false;                                          // сміттєвий час — не віримо нетвердій точці
    const distKm = haversine(prev, [fq.lat, fq.lon]) / 1000;
    const kmh = distKm / (dt / 3600);
    // дрібний дрейф (<0.5 км) і далекі переїзди після довгої паузи проходять — швидкість тоді низька
    if (distKm > 0.5 && kmh > MAX_JUMP_KMH) return false;
  }
  // нетверда, але в регіоні й правдоподібна відносно якоря — показуємо як приблизну
  // (це і є «РЕБ днями»: краще свіжа приблизна точка з прапорцем, ніж позиція тижневої давнини)
  return 'tentative';
}

let _renderFp = '', _renderSkips = 0;
async function loadDevices() {
  const devs = await api('/gw/devices/all?fields=id,name,telemetry,metadata');
  devCache = devs;
  for (const d of devs) maybeAutoReboot(d, d.telemetry || {});
  for (const d of devs) checkStuckFix(d);   // завислий «твердий» фікс — раз на 15 хв на авто, 1 легкий запит   // лише на СВІЖИХ даних (не з рендера і не зі знімка)
  // знімок останнього успішного стану — щоб при наступному відкритті одразу бачити авто (без спінера й без помилки)
  try { localStorage.setItem('devSnapshot', JSON.stringify({ ts: Date.now(), devs })); } catch(e){}
  // НЕ перемальовуємо, якщо нічого суттєвого не змінилось (стоянка вночі): менше миготіння/зайвого DOM,
  // менше жере батарею iPhone. server.timestamp огрублюємо до хвилини, напругу — до 0.1В.
  // Кожен 5-й пропуск малюємо примусово (щоб «липке» зелене встигало згасати за таймером).
  const fp = devs.map(d => {
    const t = d.telemetry || {};
    return [d.id, Math.floor((tv(t,'server.timestamp')||0)/60), tv(t,'position.speed'), tv(t,'position.valid'),
            tv(t,'position.satellites'), Math.round((tv(t,'position.latitude')||0)*1000), Math.round((tv(t,'position.longitude')||0)*1000),
            Math.round((tv(t,'external.powersource.voltage')||0)*10), tv(t,'engine.ignition.status'),
            tv(t,'movement.status'), tv(t,'gnss.state.enum'), tv(t,'can.fuel.volume'), tv(t,'can.fuel.level'),
            tv(t,'can.vehicle.mileage')].join(',');
  }).join('|');
  if (fp === _renderFp && _renderSkips < 5 && document.querySelectorAll('#list .card').length) {
    _renderSkips++;
  } else {
    _renderFp = fp; _renderSkips = 0;
    renderCards(devs);
    renderMap(devs);
  }
  document.getElementById('updated').textContent = 'оновлено ' + new Date().toLocaleTimeString('uk-UA') + ' · ' + APP_VERSION + _verNote;   // _verNote — оновлення коду не доїхало (checkVersion)
  // відкриті деталі: «Зараз» — зі СВІЖИХ даних. Поза fingerprint-скіпом («дані від» і заряд EV мають іти щоцикла),
  // без мережі (простій — з кешу standingText). Раніше там лишався знімок моменту відкриття, часто — вчорашній з localStorage
  if (curDetail) {
    const f = devs.find(x => x.id === curDetail.id);
    if (f) { curDetail = f; try { renderNow(f); } catch(e){} }   // збій рендера деталей не має зривати оновлення списку
  }
}

function statusOnline(tel) {
  // ВАЖЛИВО: у масовому запиті /devices/all параметри — ПЛОСКІ значення без часових міток (ts).
  // Тому беремо server.timestamp як ЗНАЧЕННЯ (tv), а не через tts. Інакше всі авто хибно «offline».
  const st = tv(tel, 'server.timestamp');
  if (st != null) return (Date.now()/1000 - st) < ONLINE_SEC;
  const ts = tts(tel, 'position') || tts(tel, 'can.vehicle.mileage') || tts(tel, 'can.fuel.level');
  return ts ? (Date.now()/1000 - ts) < ONLINE_SEC : false;
}
// авто ЗАДІЯНЕ = свіжі дані + двигун/авто УВІМКНЕНЕ.
// Сигнали беремо з електрики/CAN авто (РЕБ-стійкі, бо НЕ залежать від GPS):
//   1) бортова напруга ≥13В — генератор/DC-DC заряджає → заведено (універсально, всі авто й електрички)
//   2) оберти двигуна >0 (ДВЗ)   3) запалювання=true (резерв, де дріт підключено)
// Рух/швидкість НЕ використовуємо — РЕБ створює фейковий рух і телепорт.
function isActive(dev, tel, online) {
  // Авто ЗАДІЯНЕ, якщо є хоч один надійний (РЕБ-стійкий) сигнал:
  //   1) бортова напруга ≥13В — генератор заряджає (лише ДВЗ! для електрички НЕ беремо — див. нижче)
  //   2) запалювання=true (де OBD його віддає)
  //   3) ПІДТВЕРДЖЕНИЙ реальний рух — для авто, що не дають сигналів двигуна (як Renault Kangoo 8440,
  //      який віддає лише VIN+одометр). Рух «підтверджений» = швидкість + ВАЛІДНИЙ GPS-фікс + багато
  //      супутників → це НЕ РЕБ-телепорт (той дає невалідний фікс / мало супутників / стрибок).
  // RPM не беремо — у телеметрії «застрягає» на старому значенні.
  if (!online) return false;
  // ЕЛЕКТРИЧКА: її 12В-шину DC-DC перетворювач тримає на 13В навіть ЗАГЛУШЕНОЮ → напруга НЕ ознака роботи.
  // Для електрички задіяність = лише запалювання або реальний рух.
  const isEV = !!(dev && dev.metadata && (dev.metadata.ev || dev.metadata.evRangeFull));
  const volt = tv(tel,'external.powersource.voltage');
  if (!isEV && volt != null && volt >= 13.0) return true;
  if (tv(tel,'engine.ignition.status') === true) return true;
  // РУХ ПО АКСЕЛЕРОМЕТРУ — не залежить ні від GPS, ні від РЕБ (виявлено 05.07: Leaf їхав із зависшим
  // GPS-модулем, і жоден GPS-сигнал руху не працював; акселерометр — останній надійний свідок).
  if (tv(tel,'movement.status') === true) return true;
  const spd = tv(tel,'position.speed');
  // підтверджений рух: швидкість у фізичних межах + ТВЕРДИЙ фікс (fixQuality — єдине джерело правди:
  // valid, ≥4 супутники, наш регіон, HDOP). Власна копія перевірки не дивилась на HDOP — і спуф Kangoo Z.E.
  // (143 км/г, 4 супутники, HDOP 37) робив запарковане авто «в роботі» ще на 4 хв липкості.
  if (spd != null && spd >= 3 && spd < MAX_JUMP_KMH && fixQuality(tel).solid) return true;
  return false;
}
// ЛИПКІСТЬ: раз авто було активне — лишається «в роботі» ще 4 хв (зглажує світлофори, короткі
// зупинки й паузи між пакетами даних). Стан у localStorage — переживає авто-перезавантаження.
const ACTIVE_STICK_MS = 240000;
let activeSeen = {}, _actSaveAt = 0;
try { activeSeen = JSON.parse(localStorage.getItem('activeSeen') || '{}'); } catch(e) { activeSeen = {}; }
function displayActive(dev, tel, online) {
  if (isActive(dev, tel, online)) {
    activeSeen[dev.id] = Date.now();
    if (!_actSaveAt || Date.now() - _actSaveAt > 60000) { _actSaveAt = Date.now(); try { localStorage.setItem('activeSeen', JSON.stringify(activeSeen)); } catch(e){} }   // раз на хвилину, а не 10 разів на цикл
    return true;
  }
  return !!(activeSeen[dev.id] && (Date.now() - activeSeen[dev.id] < ACTIVE_STICK_MS));
}

function renderCards(devs, enrich) {
  const doEnrich = enrich !== false;   // рендер зі знімка (при відкритті) НЕ тягне історію — інакше 20+ зайвих запитів у першу секунду
  const list = document.getElementById('list');
  const _st = list.scrollTop;   // перебудова обнуляє прокрутку — повертаємо, щоб список не «стрибав» під пальцем
  list.innerHTML = '';
  let nActive = 0, nStopped = 0;
  for (const d of devs) {
    const tel = d.telemetry || {};
    const liters = fuelLiters(d, tel);
    const odo = tv(tel, 'can.vehicle.mileage');
    const spd = tv(tel, 'position.speed');
    const online = statusOnline(tel);
    const lastTs = tv(tel,'server.timestamp') || tts(tel, 'position') || tts(tel, 'can.vehicle.mileage');
    const lat = tv(tel,'position.latitude'), lon = tv(tel,'position.longitude');

    const ev = evBatt(tel, d);
    const isEVc = isEVdev(d);
    // ЗАВЖДИ через fuelLiters() (кеш+історія) — сирий can.fuel.level в обхід кешу міг «залипати» на застарілому значенні
    // електричка без SoC (Leaf батарею не віддає) — не «— паливо», ніби зламався датчик бака, а чесне «заряд не читається»
    const fuelTxt = ev.soc != null ? Math.round(ev.soc) + ' %' : (isEVc ? '⚡ —' : (liters != null ? liters + ' л' : '—'));
    const fuelLabel = ev.soc != null ? 'заряд батареї' : (isEVc ? 'заряд не читається' : 'паливо');
    const odoTxt = odo != null ? Math.round(odo).toLocaleString('uk-UA') + ' км' : '—';
    const active = displayActive(d, tel, online);
    if (active && standingCache[d.id]) { delete standingCache[d.id]; try { localStorage.setItem('standingCache', JSON.stringify(standingCache)); } catch(e){} }   // скидаємо кеш простою (і в localStorage!)
    if (active) { nActive++; }
    else nStopped++;                                         // усе інше (зокрема офлайн) — «стоять»
    // GPS-швидкість — лише з ТВЕРДОГО фікса і у фізичних межах: спуф під РЕБ давав на головному екрані
    // «202 км/г» у запаркованого Leaf (Ліма, valid=true) і «143 км/г» у Kangoo Z.E. (HDOP 37).
    // CAN-швидкість тут НЕ беремо: масовий /devices/all віддає її без часу, і після обриву OBD-лінку на ходу
    // запарковане авто вічно «їхало б» зі старою цифрою.
    const fqC = fixQuality(tel);
    const spdTxt = (spd != null && spd >= 3 && spd < MAX_JUMP_KMH && fqC.solid) ? Math.round(spd) + ' км/г'
                 : (active ? 'працює' : (online ? 'стоїть' : '—'));

    // діагностика: акумулятор · звʼязок · супутники · простій
    const volt = vehVolt(tel), gsm = gsmInfo(tel), sats = satCount(tel);
    const diag = [];
    if (volt != null) diag.push(`🔋 ${volt.toFixed(1)} В`);
    else { const tb = trkBatt(tel); if (tb != null) diag.push(`🔋 ${Math.round(tb)}% (трекер)`); }
    if (gsm) diag.push(`📶 ${gsm.label}`);
    if (sats != null) diag.push(`🛰️ ${esc(sats)}`);
    if (!active) diag.push(`🅿️ <span id="st_${d.id}">…</span>`);   // скільки стоїть (простій) — і для офлайн
    // розрахунковий баланс SIM: постійно у діагностиці, а коли не вистачає на наступне списання — червона тривога
    const se = simEstimate(d.metadata);
    if (se) diag.push(se.low
      ? `<span style="color:var(--red);font-weight:700">💳 SIM ≈${se.est} грн — поповни до 1-го числа!</span>`
      : `💳 SIM ≈${se.est} грн`);
    const diagHtml = diag.length
      ? `<div style="display:flex;gap:14px;margin-top:8px;font-size:11px;color:var(--dim);flex-wrap:wrap">${diag.map(x=>`<span>${x}</span>`).join('')}</div>`
      : '';
    // де стоїть (адреса) — лише для незадіяних на звʼязку і лише за ТВЕРДИМ фіксом (не спуф, не 0 супутників)
    const showLoc = !active && fqC.solid;
    // GPS втрачено надовго. Трекер НЕ розрізняє «РЕБ» і «нема неба» (gnss.state.enum = AVL 69, див. gnssJamState),
    // тож «РЕБ» не пишемо: на ходу без фіксу — червона тривога, на стоянці — спокійний сірий рядок.
    const gpsLostMsC = lastValidPosTs[d.id] ? (Date.now() - lastValidPosTs[d.id]) : null;
    const gpsLostLong = !fqC.solid && gpsLostMsC != null && gpsLostMsC > GPS_LOST_MS;
    const jam = gnssJamState(tel);
    const gnssSt = tv(tel,'gnss.state.enum');
    const gnssSleep = gnssSt === 0 || gnssSt === 3;   // GNSS вимкнений/спить — штатно на стоянці, «перевір антену» тут хибне
    const movingC = online && tv(tel,'movement.status') === true;
    const blindMs = blindDrivingMs(d.id, tel);   // їде наосліп: акселерометр рухається, твердого фікса нема
    const jamMs = jamDuration(d.id, jam);
    // НАЙВАЖЛИВІШЕ попередження: авто ЇДЕ (акселерометр), а твердого фікса нема довше 3 хв —
    // отже точка на карті застаріла і НЕ показує, де авто насправді. Має пріоритет над усім іншим.
    // Лише для трекера НА ЗВʼЯЗКУ: у офлайн-трекера «рух» — застиглий останній пакет, а не правда.
    const frozenMs = posFrozenMs(d.id, tel);
    const frozenC = frozenMs > 120000 && !!(posSeen[d.id] && posSeen[d.id].mv);   // той самий предикат, що в blindDrivingMs
    const sf = stuckFix[d.id];
    const locHtml = sf
      ? `<div style="margin-top:5px;font-size:11.5px;color:#e74c3c;font-weight:700">🧊 Завис GPS-модуль: авто проїхало ${sf.km} км, а точка стоїть на місці — ${(Date.now() - (autoRebootAt[d.id] || 0) < 30*60000) ? 'перезавантаження надіслано о ' + fmtTime((autoRebootAt[d.id] || 0)/1000) : (Date.now() - (autoRebootAt[d.id] || 0) < AUTO_REBOOT_COOLDOWN_MS ? 'перевір трекер (кнопка — у деталях)' : 'перезавантажую трекер')}</div>`
      : (online && blindMs > 180000)
      ? `<div style="margin-top:5px;font-size:11.5px;color:#e74c3c;font-weight:700">${
          (fqC.solid && frozenC)
            ? `🧊 Завис GPS-модуль: авто ЇДЕ, а точка стоїть ${fmtDur(frozenMs/1000)} — ${rebootNote(d.id, blindMs)}`
            : `🚫 Авто ЇДЕ без GPS-фіксу вже ${fmtDur(Math.max(blindMs, jamMs)/1000)} — точка на карті застаріла`}</div>`
      : showLoc
      ? `<div style="margin-top:5px;font-size:11.5px;color:var(--dim)">📍 <span id="loc_${d.id}">…</span></div>`
      : (jam === 2 ? (movingC
          ? `<div style="margin-top:5px;font-size:11.5px;color:#e74c3c;font-weight:600">🚫 Нема GPS-фіксу вже ${fmtDur(jamMs/1000)} — авто їде, точка на карті застаріла</div>`
          : `<div style="margin-top:5px;font-size:11.5px;color:var(--dim)">📍 нема GPS-фіксу вже ${fmtDur(jamMs/1000)} (стоянка без неба / антена?)</div>`)
      : (jam === 1 ? `<div style="margin-top:5px;font-size:11.5px;color:#f39c12;font-weight:600">⚠️ Сумнівний GPS-фікс вже ${fmtDur(jamMs/1000)} (точка може бути хибна — можливий спуф)</div>`
      : ((gpsLostLong && !gnssSleep) ? `<div style="margin-top:5px;font-size:11.5px;color:#f39c12;font-weight:600">⚠️ GPS втрачено ${fmtDur(gpsLostMsC/1000)} тому — перевір антену</div>`
      : ((!active && lat != null && lon != null && !fqC.solid) ? `<div style="margin-top:5px;font-size:11.5px;color:var(--dim)">📍 нема GPS-фіксу${gnssSleep ? ' (GPS спить)' : ''}</div>` : ''))));
    // тривога: помилки двигуна / перегрів — щоб проблемне авто було видно одразу
    const et = engineTemp(tel), dtc = dtcCount(tel);
    const alerts = [];
    if (dtc != null && dtc > 0) alerts.push(`🛑 ${dtc} ${dtc===1?'помилка':'помилки'} двигуна`);
    // авто-перевірка faultcodes знайшла коди (для авто без пасивного лічильника; без дубля з рядком вище)
    const fcA = faultsCache(d.id);
    if (!(dtc != null && dtc > 0) && fcA && fcA.ts && faultsBad(fcA.txt)) alerts.push('🛑 помилки двигуна (OBD)');
    if (et != null && et >= 110) alerts.push(`🌡️ перегрів ${Math.round(et)}°C`);
    const alertHtml = alerts.length ? `<div style="margin-top:6px;font-size:12px;color:#e74c3c;font-weight:700">${alerts.join(' · ')}</div>` : '';
    // SIM-підозра: авто довго мовчить, тоді як ІНШІ на звʼязку (отже не РЕБ і не збій flespi, а саме ця сімка/покриття).
    // Баланс НАШИХ сімок дистанційно не читається (FMB003 не вміє USSD) — тому ловимо САМ ФАКТ смерті звʼязку і даємо поповнити в 1 тик.
    const md_ = d.metadata || {};
    const offMs = (!online && lastTs) ? (Date.now() - lastTs*1000) : null;
    const othersOnline = devs.some(o => o.id !== d.id && statusOnline(o.telemetry || {}));
    const simHtml = (offMs != null && offMs > SIM_SUSPECT_MS && othersOnline)
      ? `<div style="margin-top:6px;font-size:12px;color:#e67e22;font-weight:700">📵 Звʼязку нема ${fmtDur(offMs/1000)} — перевір баланс SIM${md_.simPhone ? ` ${esc(md_.simPhone)} · <a href="https://oplata.lifecell.ua" target="_blank" rel="noopener" style="color:#3aa0ff">поповнити</a>` : ''}</div>`
      : '';
    // до ТО + запас ходу (цінне для користувача — на видноті в картці)
    const sk = serviceKm(tel), rng = vehicleRange(d, tel);
    const infoArr = [];
    if (sk != null) infoArr.push(`🔧 ${Math.round(sk).toLocaleString('uk-UA')} км до ТО`);
    if (rng != null) infoArr.push(`🛣️ ${rng.toLocaleString('uk-UA')} км запас`);
    const infoHtml = infoArr.length ? `<div style="margin-top:6px;font-size:12.5px;color:#c9d1d9">${infoArr.join('  ·  ')}</div>` : '';

    const card = document.createElement('div');
    card.className = 'card' + (active ? ' active' : '');
    // зелена підсвітка збоку, коли авто задіяне (двигун заведений)
    card.style.borderLeft = active ? '4px solid #2ecc71' : '4px solid transparent';
    card.style.boxShadow = active ? '0 0 0 1px rgba(46,204,113,.35), 0 0 14px rgba(46,204,113,.18)' : '';
    card.onclick = (e) => { if (e.target.closest && e.target.closest('a')) return; openDetail(d); };   // тап по «поповнити» — лише посилання, без деталей
    const dotColor = active ? '#2ecc71' : (online ? '#8a929c' : '#454b54');
    card.innerHTML = `
      <div class="top">
        <span class="dot" style="background:${dotColor};${active?'box-shadow:0 0 7px #2ecc71':''}"></span>
        <span class="name">${esc(d.name)}</span>
        <span class="badge" style="margin:0;${active?'color:#2ecc71':''}">${active?'🟢 в роботі':(lastTs?ago(lastTs):'')}</span>
      </div>
      <div class="grid">
        <div class="cell"><div class="v fuel" id="fuel_${d.id}">${fuelTxt}</div><div class="l">${fuelLabel}</div></div>
        <div class="cell"><div class="v" id="dm_${d.id}">…</div><div class="l">за сьогодні</div></div>
        <div class="cell"><div class="v">${spdTxt}</div><div class="l">${odoTxt}</div></div>
      </div>${infoHtml}${diagHtml}${locHtml}${alertHtml}${simHtml}`;
    list.appendChild(card);

    if (!doEnrich) continue;   // знімок при відкритті: малюємо миттєво, історію тягнемо вже зі свіжими даними
    cardDayKm(d.id, startOfDay()).then(km => {
      const el = document.getElementById('dm_' + d.id);
      if (el) el.textContent = (km != null ? km + ' км' : '—');
    }).catch(()=>{ const el=document.getElementById('dm_'+d.id); if(el) el.textContent='—'; });

    // Якщо ПОТОЧНОГО рівня нема (авто заглушене) — освіжаємо «останнє паливо» з ІСТОРІЇ flespi (там правда),
    // бо клієнтський кеш міг застаріти (вранці показував учорашнє). Throttle 3 хв, щоб не спамити.
    // Електричку пропускаємо: бака нема, і 30-денний скан історії палива для неї завжди порожній — Leaf
    // (SoC не віддає) інакше давав 2 марні запити кожні 3 хв + 2 на кожне відкриття (урок v44 про per-card запити).
    if (!isEVc && ev.soc == null && fuelCurrent(d, tel) == null) {
      const fresh = lastFuelTs[d.id] && (Date.now() - lastFuelTs[d.id] < 180000);
      if (!fresh) {
        lastFuelTs[d.id] = Date.now();   // позначаємо ДО запиту, щоб не дублювати
        try { localStorage.setItem('lastFuelTs', JSON.stringify(lastFuelTs)); } catch(e){}   // і throttle переживає перезапуск PWA
        lastValidFuel(d).then(l => {
          const el = document.getElementById('fuel_' + d.id);
          if (el && l != null) el.textContent = l + ' л';
        }).catch(()=>{});
      }
    }

    if (!active) {
      standingText(d).then(txt => {
        const el = document.getElementById('st_' + d.id);
        if (el) el.textContent = txt;
      }).catch(()=>{ const el=document.getElementById('st_'+d.id); if(el) el.textContent='—'; });
    }
    if (showLoc) {
      geocode(lat, lon).then(addr => {
        const el = document.getElementById('loc_' + d.id);
        if (el) el.textContent = addr || (lat.toFixed(4) + ', ' + lon.toFixed(4));
      }).catch(()=>{ const el=document.getElementById('loc_'+d.id); if(el) el.textContent = lat.toFixed(4)+', '+lon.toFixed(4); });
    }
  }

  // підсумок зверху: скільки в роботі / стоять / офлайн
  const sum = document.createElement('div');
  sum.style.cssText = 'display:flex;gap:18px;justify-content:center;align-items:center;padding:9px 10px;margin-bottom:10px;font-size:13px;font-weight:600;background:rgba(255,255,255,.04);border-radius:10px';
  sum.innerHTML = `<span style="color:#2ecc71">🟢 ${nActive} в роботі</span><span style="color:#a0a8b4">🅿️ ${nStopped} стоять</span>`;
  list.insertBefore(sum, list.firstChild);
  list.scrollTop = _st;   // повертаємо прокрутку — список не стрибає вгору при кожному оновленні
}

// шари карти — Google (дорожня/супутник/гібрид), з укр. підписами
function baseLayers(){
  const g = (lyrs)=> L.tileLayer('https://mt{s}.google.com/vt/lyrs='+lyrs+'&hl=uk&x={x}&y={y}&z={z}',
                     { subdomains:['0','1','2','3'], maxZoom:21, attribution:'' });
  return {
    'Карта': g('m'),      // Google дорожня
    'Супутник': g('s'),   // Google супутник
    'Гібрид': g('y'),     // супутник + підписи
    'OSM': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 }),
  };
}

function renderMap(devs) {
  if (!map) {
    map = L.map('map', { zoomControl:true, attributionControl:false }).setView([50.9,34.8], 9);
    const bl = baseLayers();
    bl['Карта'].addTo(map);
    L.control.layers(bl, {}, { position:'topright' }).addTo(map);
  }
  const pts = [];
  let posDirty = false;   // localStorage пишемо ОДИН раз після циклу і лише якщо щось змінилось (було до 120 записів/хв)
  for (const d of devs) {
    const tel = d.telemetry || {};
    let lat = tv(tel,'position.latitude'), lon = tv(tel,'position.longitude');
    const trusted = trustPosition(d.id, tel);   // 'solid' | 'tentative' | false
    // ЯКІР оновлюють лише solid-фікси зі СВІЖОЮ телеметрією: рендер зі снапшота (init) чи заснулого
    // трекера інакше штампував Ts=now зі старими координатами і потім блокував чесний новий фікс
    const telAge = Date.now()/1000 - (tv(tel,'server.timestamp') || 0);
    if (trusted === 'solid' && telAge < 600) {
      const old = lastValidPos[d.id];
      if (!old || old[0] !== lat || old[1] !== lon || Date.now() - (lastValidPosTs[d.id]||0) > 60000) {
        lastValidPos[d.id] = [lat, lon];
        lastValidPosTs[d.id] = Date.now();
        posDirty = true;
      }
    } else if (!trusted) {
      if (lastValidPos[d.id]) {
        lat = lastValidPos[d.id][0]; lon = lastValidPos[d.id][1];   // спуф/сміття → тримаємо ОСТАННЮ ДОБРУ (маркер не стрибає)
      } else if (lat == null || lon == null || !saneRegion(lat, lon)) {
        continue;   // свіжа інсталяція + сміття (Ліма) — краще без маркера, ніж карта зумиться на Перу
      }
      // свіжа інсталяція, точка в регіоні, але недовірена: показуємо як є — прапорці глушіння скажуть, що вона приблизна
    }
    // 'tentative' → малюємо координати трекера, якір не чіпаємо
    if (lat == null || lon == null) continue;                       // позиції ще ніколи не було
    const online = statusOnline(tel);
    const active = displayActive(d, tel, online);
    const liters = fuelLiters(d, tel);
    // GPS втрачено надовго — стан GNSS із трекера (AVL 69: «фіксу нема» / «фікс сумнівний») має пріоритет над здогадом.
    // «РЕБ» не пишемо: трекер не відрізняє глушіння від стоянки без неба (див. gnssJamState)
    const gpsLostMs = lastValidPosTs[d.id] ? (Date.now() - lastValidPosTs[d.id]) : null;
    const jamState = gnssJamState(tel);
    const jamMs2 = jamDuration(d.id, jamState);
    // «точка застаріла» тепер = не довіряємо позиції довше GPS_LOST_MS (ловить і спуф із valid=true, не лише valid=false)
    const gpsLost = jamState > 0 || !!stuckFix[d.id] || (trusted !== 'solid' && gpsLostMs != null && gpsLostMs > GPS_LOST_MS);   // і tentative-точки старіють: мертва антена → жовтий пунктир
    pts.push([lat,lon]);
    const status = active ? '🟢 в роботі' : (online ? '⚪ на звʼязку' : '⚫ офлайн');
    const movingM = online && tv(tel,'movement.status') === true;
    const gpsWarn = jamState === 2 ? `<br>${movingM ? '🚫 їде без GPS-фіксу' : '📍 нема GPS-фіксу'} вже ${fmtDur(jamMs2/1000)}`
      : jamState === 1 ? `<br>⚠️ сумнівний GPS-фікс вже ${fmtDur(jamMs2/1000)}`
      : (gpsLost ? `<br>⚠️ GPS втрачено ${fmtDur(gpsLostMs/1000)} тому — точка застаріла` : '');
    const html = `<b>${esc(d.name)}</b><br>${status}${liters!=null?' · '+liters+' л':''}${gpsWarn}`;
    if (markers[d.id]) {
      markers[d.id].setLatLng([lat,lon]);
      // іконку перемальовуємо ЛИШЕ коли справді змінився стан: setIcon щоразу знищував і
      // відтворював DOM маркера (5 авто × кожні 15 с) — помітне гальмо на телефоні
      const iconKey = online+'|'+active+'|'+gpsLost+'|'+((d.metadata||{}).iconSvg||'')+'|'+((d.metadata||{}).color||'');
      if (markers[d.id]._iconKey !== iconKey) { markers[d.id].setIcon(vehIcon(d, online, active, gpsLost)); markers[d.id]._iconKey = iconKey; }
      const pp = markers[d.id].getPopup(); if (pp) pp.setContent(html);
    } else {
      markers[d.id] = markerFor(d, [lat,lon], online, active, gpsLost).addTo(map).bindPopup(html);
    }
  }
  if (posDirty) {
    try {
      localStorage.setItem('lastValidPos', JSON.stringify(lastValidPos));
      localStorage.setItem('lastValidPosTs', JSON.stringify(lastValidPosTs));
    } catch(e){}
  }
  // маркери-привиди: пристрій зник з flespi (видалили/перенесли) — прибираємо з карти, інакше висить зі старою позицією
  for (const mid of Object.keys(markers)) {
    if (!devs.some(d => String(d.id) === mid)) { try { map.removeLayer(markers[mid]); } catch(e){} delete markers[mid]; }
  }
  if (pts.length && !map._fitted) { map.fitBounds(pts, { padding:[40,40], maxZoom:13 }); map._fitted = true; }
}

// ===== Пробіг з ОДОМЕТРА (точно, дешево) =====
// Пріоритет: OBD-одометр авто (can.vehicle.mileage — стійкий до РЕБ).
// Запасний: GNSS-одометр трекера (vehicle.mileage) — для авто БЕЗ OBD-одометра (Ducato 2008, частина електричок).
// Поле одометра пристрою НЕ змінюється — кешуємо назавжди (економить 1-2 запити на кожен виклик пробігу)
let mileageFieldCache = {};
try { mileageFieldCache = JSON.parse(localStorage.getItem('mileageFieldCache') || '{}'); } catch(e) { mileageFieldCache = {}; }
async function mileageField(id, from, to) {
  // запис живе 7 днів: якщо трекер переставили на авто БЕЗ CAN-одометра, вічний кеш давав вічне «—»
  const mc = mileageFieldCache[id];
  if (mc) {
    const f = (typeof mc === 'string') ? mc : mc.f;
    const at = (typeof mc === 'string') ? 0 : (mc.at || 0);
    if (Date.now() - at < 7*86400000) return f;
  }
  for (const field of ['can.vehicle.mileage', 'vehicle.mileage']) {
    const data = encodeURIComponent(JSON.stringify({ from, to, count:1, reverse:true, filter:field }));
    const res = await api(`/gw/devices/${id}/messages?data=${data}`);
    if (res && res.length && res[0][field] != null) {
      // НАЗАВЖДИ кешуємо лише справжній CAN-одометр. Якщо у пробитому вікні CAN випадково мовчав
      // (авто спало), раніше назавжди фіксувався GNSS-фолбек — а він отруєний телепортом «у Ліму»
      // (+12600 км) і дає нулі/сміття. Тепер фолбек діє лише для цього виклику, CAN пробуємо знову.
      if (field === 'can.vehicle.mileage') {
        mileageFieldCache[id] = { f: field, at: Date.now() };
        try { localStorage.setItem('mileageFieldCache', JSON.stringify(mileageFieldCache)); } catch(e){}
      }
      return field;
    }
  }
  return null;   // авто ще не надіслало одометр — не кешуємо, спробуємо ще
}
async function odoAt(id, from, to, reverse, field) {
  // беремо до 10 з краю і пропускаємо глюки-нулі (деякі авто, як Kangoo 8440, віддають одометр=0)
  const data = encodeURIComponent(JSON.stringify({ from, to, count:10, reverse:!!reverse, filter:field, fields:'timestamp,'+field }));
  const res = await api(`/gw/devices/${id}/messages?data=${data}`);
  if (!res || !res.length) return null;
  for (const m of res) { const v = m[field]; if (v != null && v > 0) return v; }
  return null;
}
// КЕШ пробігу за день — головний фікс перевантаження flespi: без нього dayMileage бив ~3.5 запити × 5 авто
// КОЖНІ 15с (renderCards) = ~70 запитів/хв → впирались у ліміт Free-тарифу щоразу. Пробіг за день не міняється
// щосекунди, тому кеш 3 хв цілком достатньо. Кеш переживає перезавантаження (localStorage) → відкриття теж тихе.
const DAY_MILEAGE_TTL = 180000;   // 3 хв (для «живого» вікна, що росте)
let dayMileageCache = {};
try { dayMileageCache = JSON.parse(localStorage.getItem('dayMileageCache2') || '{}'); } catch(e) { dayMileageCache = {}; }
// чистка при завантаженні: записи, старші за 7 днів, більше не потрібні (інакше кеш росте вічно)
{
  const cutoff = Date.now() - 7*86400000;
  let dirty = false;
  for (const k of Object.keys(dayMileageCache)) if ((dayMileageCache[k].at || 0) < cutoff) { delete dayMileageCache[k]; dirty = true; }
  if (dirty) try { localStorage.setItem('dayMileageCache2', JSON.stringify(dayMileageCache)); } catch(e){}
}
const dayMileageInflight = {};   // дедуп одночасних запитів (рендер при відкритті йде двічі: знімок + живі дані)
// КРАЙОВИЙ пробіг: last − first, де first — останній одометр ДО періоду («стик» із попередньою добою),
// якщо він не більший за перший у періоді. Одна функція для dayMileageEx і periodReport — щоб не розійшлись.
// kmIn — те саме БЕЗ стику, jump — скільки додав стик (картка вирішує, чи він чесний; див. parkedAcrossBoundary)
function edgeKm(before, firstIn, last, from, t) {
  // межа глюків МАСШТАБУЄТЬСЯ періодом: фіксовані 3000 км обрізали чесний МІСЯЧНИЙ пробіг (>3000 за місяць — норма)
  const maxPlausible = Math.max(1, Math.ceil((t - from) / 86400)) * 1500;   // ≤1500 км/добу
  const ok = d => (d >= 0 && d <= maxPlausible) ? d : null;   // негатив/абсурд (телепорт одометра) — краще нічого, ніж дурне число
  const first = (before != null && (firstIn == null || before <= firstIn)) ? before : firstIn;
  return {
    km: (first != null && last != null) ? ok(Math.round(last - first)) : null,
    kmIn: (firstIn != null && last != null) ? ok(Math.round(last - firstIn)) : null,
    jump: (before != null && firstIn != null && before <= firstIn) ? firstIn - before : 0
  };
}
// повертає { km, kmIn, jump, fail }: fail = запит упав (а не «даних нема») — звіт тоді не кешуємо надовго
async function dayMileageEx(id, from, to) {
  // КЛЮЧ кешу ВКЛЮЧАЄ період! Без цього «Вчора/Тиждень/Місяць» повертали закешоване «за сьогодні»
  // (у звіті виходило одометр=36 км при GPS-треку 457 км).
  // «Живий» період = to не задано АБО to ≈ зараз (вкладки передають to=now, і без нормалізації ключ був
  // унікальний на кожен тап → нуль влучень у кеш і вічний ріст localStorage).
  const now = Math.floor(Date.now()/1000);
  const live = !to || to >= now - 90;
  const key = id + ':' + from + ':' + (live ? 'live' : to);
  const c = dayMileageCache[key];
  // закритий період кешуємо 2 год (НЕ добу: трекер після відновлення звʼязку докидає буферизовані записи
  // заднім числом, і «вчора», пораховане о 00:05, було б занижене цілу добу).
  // Фейл кешуємо на 90 с (негативний кеш): інакше під вибитим лімітом кожен рендер повторював
  // увесь ланцюг запитів ×3 ретраї — лавина саме тоді, коли flespi і так відбивається.
  // негативний кеш теж віддає fail — інакше повторний тап у ці 90 с закешував би хибну цифру як чесну
  if (c && (Date.now() - c.at) < (c.fail ? 90000 : (live ? DAY_MILEAGE_TTL : 2*3600000)))
    return { km: c.km, kmIn: (c.kmIn != null ? c.kmIn : null), jump: c.jump || 0, fail: !!c.fail };
  if (dayMileageInflight[key]) return dayMileageInflight[key];   // вже летить — чекаємо той самий, не дублюємо запит
  dayMileageInflight[key] = (async () => {
    let km = null, kmIn = null, jump = 0;
    try {
      const t = to || Math.floor(Date.now()/1000);
      const field = await mileageField(id, from, t);
      if (field) {
        // БАЗОВА ТОЧКА — останній одометр ДО початку періоду (заглядаємо на 4 доби: покриває вихідні).
        // Без цього доба починалась з ПЕРШОГО повідомлення дня: якщо трекер прокидався вже в дорозі
        // (сон/офлайн/РЕБ), перший відрізок шляху просто зникав з пробігу. Тепер доба «стикується»
        // з попередньою: кінець учора = початок сьогодні, жодного кілометра не губиться.
        const [firstIn, last, before] = await Promise.all([
          odoAt(id, from, t, false, field),
          odoAt(id, from, t, true, field),
          odoAt(id, Math.max(0, from - 96*3600), from, true, field)
        ]);
        ({ km, kmIn, jump } = edgeKm(before, firstIn, last, from, t));
      }
    } catch(e) {
      dayMileageCache[key] = { km: null, at: Date.now(), fail: true };   // короткий негативний кеш — див. вище
      try { localStorage.setItem('dayMileageCache2', JSON.stringify(dayMileageCache)); } catch(e2){}
      return { km: null, kmIn: null, jump: 0, fail: true };
    }
    dayMileageCache[key] = { km, kmIn, jump, at: Date.now() };
    try { localStorage.setItem('dayMileageCache2', JSON.stringify(dayMileageCache)); } catch(e){}
    return { km, kmIn, jump, fail: false };
  })();
  try { return await dayMileageInflight[key]; }
  finally { delete dayMileageInflight[key]; }
}

// РІШЕННЯ ПРО СТИК ДЛЯ КАРТКИ «за сьогодні» — те саме правило, що stitchOk у periodReport (і ті самі
// критерії фікса, що в якорі звіту): якщо доба почалась ТАМ, де вчора закінчилась (останній фікс до
// опівночі й перший фікс доби — <1 км і ≤6 год), авто нікуди не їздило, і стрибок одометра між добами —
// це замерзлий CAN, а не рух (Leaf 03.10: картка 96 км при чесних 19; 22–23.08: 72 замість 30).
// Якір до опівночі незмінний, перший фікс доби — теж, тож рішення кешуємо на всю добу:
// +2 запити на авто на ДОБУ і лише в дні, коли стик справді щось додає (урок v44 — жодних запитів на кожен рендер).
const parkedCache = {}, _parkedInflight = {};
function firstSaneFix(res, maxHdop){   // перший фікс, якому звіт довіряє (valid, ≥3 супутники, не Ліма; для треку ще hdop)
  for (const m of (res || [])) {
    const la = m['position.latitude'], lo = m['position.longitude'], sa = m['position.satellites'], hd = m['position.hdop'];
    if (la != null && lo != null && saneRegion(la, lo) && m['position.valid'] !== false && (sa == null || sa >= 3)
        && (maxHdop == null || hd == null || hd <= maxHdop)) return [la, lo, m.timestamp];
  }
  return null;
}
async function parkedAcrossBoundary(id, from) {
  const key = id + ':' + from, c = parkedCache[key];
  if (c && (c.fin || Date.now() - c.at < 600000)) return c.v;
  // уже летить — чекаємо той самий: на повільній мережі рендер кожні 15 с інакше ставив ще пару запитів
  // на кожне авто (картки чекають спільний dayMileageEx і потім рушають сюди всі разом) — урок v44
  if (_parkedInflight[key]) return _parkedInflight[key];
  _parkedInflight[key] = (async () => {
    let v = false, fin = false;
    try {
      const q = o => api(`/gw/devices/${id}/messages?data=${encodeURIComponent(JSON.stringify(Object.assign({ count: 20,
        filter: 'position.valid=true', fields: 'timestamp,position.latitude,position.longitude,position.valid,position.satellites,position.hdop' }, o)))}`);
      const [resA, resF] = await Promise.all([
        q({ from: Math.max(0, from - 96*3600), to: from, reverse: true }),
        q({ from, to: Math.floor(Date.now()/1000) })
      ]);
      const a = firstSaneFix(resA), f0 = firstSaneFix(resF, 4);   // hdop ≤4 — як перша точка треку звіту
      if (f0) {
        fin = true;   // перший фікс доби знайдено — рішення вже не зміниться
        v = !!(a && f0[2] - a[2] <= 6*3600 && haversine([a[0], a[1]], [f0[0], f0[1]]) < 1000);
      }
    } catch(e) { /* мережа/ліміт — стик лишаємо, як було, повторимо через 10 хв */ }
    parkedCache[key] = { v, fin, at: Date.now() };
    return v;
  })();
  try { return await _parkedInflight[key]; }
  finally { delete _parkedInflight[key]; }
}
// пробіг «за сьогодні» на картці: краї одометра, а стик із учора — лише якщо авто справді їхало у сліпому проміжку
async function cardDayKm(id, from) {
  const r = await dayMileageEx(id, from);
  if (r.km != null && r.kmIn != null && r.jump >= 0.5 && await parkedAcrossBoundary(id, from)) return r.kmIn;
  return r.km;
}

// ===== Скільки авто СТОЇТЬ (простій) — від останньої активності двигуна/руху =====
// кеш переживає перезавантаження (localStorage) → відкриття не перезапитує простій для всіх авто (менше запитів)
let standingCache = {};   // id -> { ts:<останній активний момент, сек>, at:<коли запитали, мс> }
try { standingCache = JSON.parse(localStorage.getItem('standingCache') || '{}'); } catch(e) { standingCache = {}; }
function fmtStanding(sec){
  if (sec == null) return null;
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec/86400), h = Math.floor((sec%86400)/3600), m = Math.floor((sec%3600)/60);
  if (d > 0) return `${d} дн ${h} год`;
  if (h > 0) return `${h} год ${m} хв`;
  return `${m} хв`;
}
async function lastActiveInfo(id, isEV){
  const now = Math.floor(Date.now()/1000);
  // активність = двигун/авто було увімкнене: напруга ≥13В (НЕ для електро — DC-DC тримає 13В і заглушеною)
  // АБО запалювання=true АБО ПІДТВЕРДЖЕНИЙ рух (швидкість + валідний фікс + достатньо супутників, не РЕБ-телепорт).
  // тир 1 — недавні повідомлення (для щоденних авто знайде швидко й дешево); тир 2 — глибше, якщо стоїть давно
  for (const pair of [[400,3],[3000,45]]) {
    const cnt = pair[0], days = pair[1];
    const data = encodeURIComponent(JSON.stringify({ from: now-days*86400, to: now, count: cnt, reverse: true, fields:'timestamp,external.powersource.voltage,engine.ignition.status,position.speed,position.valid,position.satellites,position.hdop' }));
    let msgs;
    try { msgs = await api(`/gw/devices/${id}/messages?data=${data}`) || []; } catch(e){ return null; }
    for (const m of msgs) {
      const v = m['external.powersource.voltage'], ig = m['engine.ignition.status'];
      const sp = m['position.speed'], vd = m['position.valid'], sa = m['position.satellites'], hd = m['position.hdop'];
      // GPS-рух — з тими ж межами, що в isActive: спуф під РЕБ (Kangoo Z.E. 143 км/г при HDOP 37, Leaf/Master 150–200 км/г)
      // інакше ставав «останньою активністю», і авто, що стоїть добу, показувало «🅿️ 5 хв»
      if ((!isEV && v != null && v >= 13.0) || ig === true || (sp != null && sp >= 5 && sp < MAX_JUMP_KMH && vd !== false && sa != null && sa >= 4 && (hd == null || hd <= MAX_HDOP))) return { ts: m.timestamp, found: true };
    }
    if (cnt > 1000 && msgs.length) return { ts: msgs[msgs.length-1].timestamp, found: false };  // увімкнення у вікні нема → «принаймні стільки»
  }
  return null;
}
// повертає готовий текст: «2 год 15 хв» або «≥ 1 год» (коли немає давнішої історії)
const _standingInflight = {};
async function standingText(dev){
  const id = dev.id, isEV = !!(dev.metadata && (dev.metadata.ev || dev.metadata.evRangeFull));
  const now = Math.floor(Date.now()/1000);
  let ts, atLeast;
  let c = standingCache[id];
  // Поїздка, якої застосунок не бачив (iOS тримав PWA у фоні — рендерів не було, і кеш «в роботі» не скинувся):
  // одометр виріс після кешування → кеш застарів, інакше «🅿️ 20 хв» замість 5 до кінця 30-хв TTL. Без запитів:
  // кожне джерело порівнюємо лише з САМИМ СОБОЮ (CAN Leaf шле 0 упереміш зі справжніми — змішування CAN||GNSS
  // скидало б кеш щоцикла), лише РІСТ >0,2 км і не частіше разу на 2 хв. Старі записи без oC/oG — як раніше.
  const tNow = dev.telemetry || {};
  const oC = tv(tNow,'can.vehicle.mileage'), oG = tv(tNow,'vehicle.mileage');
  const grew = (a, b) => a > 0 && b > 0 && a - b > 0.2;
  if (c && !c.fail && Date.now() - c.at > 120000 && (grew(oC, c.oC) || grew(oG, c.oG))) c = null;
  // фейл кешуємо на 90 с (не 30 хв — щоб «—» не залипало, і не 0 с — щоб не бомбити flespi ретраями)
  if (c && (Date.now()-c.at) < (c.fail ? 90000 : 1800000)) { ts = c.ts; atLeast = c.atLeast; }
  else {
    if (!_standingInflight[id]) {   // подвійний рендер при відкритті (знімок + живі дані) — один запит на обох
      _standingInflight[id] = lastActiveInfo(id, isEV).finally(() => { delete _standingInflight[id]; });
    }
    const info = await _standingInflight[id];
    ts = info ? info.ts : null;
    atLeast = info ? !info.found : false;
    standingCache[id] = info ? { ts, at: Date.now(), atLeast, oC, oG } : { ts: null, at: Date.now(), fail: true };   // одометри — на момент запиту
    try { localStorage.setItem('standingCache', JSON.stringify(standingCache)); } catch(e){}
  }
  if (ts == null) return '—';
  return (atLeast ? '≥ ' : '') + fmtStanding(now - ts);
}

// ===== Адреса за координатами (зворотне геокодування OSM) =====
// Кеш у localStorage (між сесіями) + СЕРІЙНА черга (по одному запиту — щоб не ловити ліміт Nominatim і не гальмувати).
let geoCache = {};
try { geoCache = JSON.parse(localStorage.getItem('geoCache') || '{}'); } catch(e) { geoCache = {}; }
{ // єдиний кеш без обмеження: за рік роботи впирався б у квоту, і тоді ТИХО ламалось би все інше
  const keys = Object.keys(geoCache);
  if (keys.length > 3000) { for (const k of keys.slice(0, keys.length - 3000)) delete geoCache[k];
    try { localStorage.setItem('geoCache', JSON.stringify(geoCache)); } catch(e){} }
}
let geoQueue = Promise.resolve();
// ПОШУК «ПОРУЧ»: ключ кешу — 4 знаки (≈11 м), тому та сама стоянка біля дому щодня давала НОВИЙ ключ
// і новий запит. А черга серійна з паузою під ліміт Nominatim — день із 10 зупинками = 10+ секунд,
// поки адреси доповзуть. Тепер спершу шукаємо вже відому адресу в радіусі 150 м: для стоянки це та сама
// вулиця й будинок, а промахів кешу стає в рази менше.
const GEO_NEAR_M = 150;
let _geoIdx = null;
function geoNear(lat, lon){
  const keys = Object.keys(geoCache);
  if (!_geoIdx || _geoIdx.n !== keys.length) {
    _geoIdx = { n: keys.length, arr: keys.map(k => { const q = k.split(','); return [+q[0], +q[1], k]; }) };
  }
  let best = null, bd = GEO_NEAR_M;
  for (const e of _geoIdx.arr) {
    if (Math.abs(e[0] - lat) > 0.0025 || Math.abs(e[1] - lon) > 0.004) continue;   // дешевий відсів по рамці
    const d = haversine([lat, lon], [e[0], e[1]]);
    if (d < bd) { bd = d; best = geoCache[e[2]]; }
  }
  return best;
}
function geocode(lat, lon){
  if (lat == null || lon == null) return Promise.resolve('');
  const key = lat.toFixed(4) + ',' + lon.toFixed(4);
  if (geoCache[key] !== undefined) return Promise.resolve(geoCache[key]);
  const near = geoNear(lat, lon);
  if (near) return Promise.resolve(near);
  geoQueue = geoQueue.then(async () => {
    if (geoCache[key] !== undefined) return;   // могли закешувати, поки стояли в черзі
    // ТАЙМАУТ обовʼязковий: черга серійна, і одна зависла відповідь Nominatim блокувала
    // ВСІ наступні адреси до перезавантаження застосунку (адреси просто «не приходили»).
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&accept-language=uk&lat=${lat}&lon=${lon}`, { signal: ctl.signal });
      const j = await r.json();
      const a = j.address || {};
      const road = a.road || a.pedestrian || a.residential || a.suburb || a.neighbourhood || '';
      const num = a.house_number ? (' ' + a.house_number) : '';
      const place = a.city || a.town || a.village || a.hamlet || a.municipality || '';
      let txt = road ? (road + num) : place;
      if (road && place && place !== road) txt = road + num + ', ' + place;
      if (!txt) txt = (j.display_name || '').split(',').slice(0,2).join(',').trim();
      // кешуємо ЛИШЕ вдалий результат — порожнє/помилку не запамʼятовуємо назавжди, спробуємо ще раз наступного разу
      if (txt) { geoCache[key] = txt; _geoIdx = null; try { localStorage.setItem('geoCache', JSON.stringify(geoCache)); } catch(e){} }
    } catch(e) { /* помилку не кешуємо — спробуємо іншим разом */ }
    finally { clearTimeout(tid); }
    await new Promise(res => setTimeout(res, 1000));   // пауза під ліміт Nominatim (1/сек)
  });
  return geoQueue.then(() => geoCache[key] || '');
}

// ===== КЕШ ГОТОВИХ ЗВІТІВ =====
// Закритий період (вчора, субота, минулий тиждень) уже НІКОЛИ не зміниться — але кожен тап по вкладці
// качав усі повідомлення заново: доба Leaf = 405 КБ, тиждень = 4.2 МБ, місяць ≈ 18 МБ (заміряно 01.09).
// Саме це Іван відчував як «підтормажує». Тепер рахуємо один раз за сеанс.
// Живий період (сьогодні / ковзний тиждень) НЕ кешуємо — він росте з кожним пакетом.
// 40 = 5 авто × (7 діб + тиждень). При 14 тиждень другого авто витісняв доби першого, і повторний
// «Тиждень» знову коштував ~38 запитів. Кешовані звіти — уже проріджені обʼєкти, памʼяті це не важить.
const REP_CACHE_MAX = 40;
const REP_SETTLE_SEC = 6 * 3600;   // доба «застигла»: трекер уже дослав усе, що буферизував офлайн
let repCache = new Map();          // порядок вставки = LRU
function repKey(id, from, to){ return id + ':' + from + ':' + to; }
function repAge(to){
  const now = Math.floor(Date.now()/1000);
  if (to >= now - 300) return 60000;                    // ЖИВИЙ період (сьогодні/тиждень): 1 хв — рівно щоб
                                                        // «туди-сюди по вкладках» не качало 4 МБ повторно
  if (now - to > REP_SETTLE_SEC) return Infinity;       // доба застигла: трекер дослав усе, перерахунок не змінить нічого
  return 600000;                                        // щойно закрита доба: 10 хв (можуть долетіти буферизовані записи)
}
function repGet(id, from, to){
  const k = repKey(id, from, to), v = repCache.get(k);
  if (!v) return null;
  // термін — той, що був НА МОМЕНТ запису: доба, порахована о 00:30 (TTL 10 хв), не стає «вічною» о 08:00 —
  // інакше буфер, досланий трекером уранці, у цьому сеансі вже не зʼявився б ніколи
  if (Date.now() - v.at > (v.ttl != null ? v.ttl : repAge(to))) { repCache.delete(k); return null; }
  repCache.delete(k); repCache.set(k, v);   // освіжаємо позицію в LRU
  return v.rep;
}
function repPut(id, from, to, rep){
  if (!rep || rep.truncated) return;        // обрізаний звіт кешувати не можна — покаже неповні цифри
  const k = repKey(id, from, to);
  // partial = упав допоміжний запит (одометр/якір): цифра може бути хибна → лише 90 с, а не до кінця сеансу.
  // Не «не кешувати зовсім»: під стійким лімітом кожен тап знову тягнув би сотні КБ і сам підливав масла.
  const ttl = rep.partial ? Math.min(90000, repAge(to)) : repAge(to);
  repCache.delete(k); repCache.set(k, { rep, at: Date.now(), ttl });
  while (repCache.size > REP_CACHE_MAX) repCache.delete(repCache.keys().next().value);
}

// ПРИРОСТИ одометра [[ts, км], …]: лише рух уперед від ОПОРНОГО значення. Малий спад опору НЕ опускає —
// CAN Master 0516 10.09 за хвилину 12 разів стрибав 294505↔294501, і кожен відскок назад рахувався як рух
// (+30 фантомних км за добу). Великий спад (≤−50, скид лічильника) чи стрибок ≥300 км (телепорт) лише переносять опору.
// Спільне для пробігу (sumOf) і стрічки дня (заміри руху з одометра) — щоб вони не розходились.
function odoUps(arr){
  const out = [];
  if (!arr || !arr.length) return out;
  let ref = arr[0][1];
  for (let k = 1; k < arr.length; k++) {
    const v = arr[k][1], d = v - ref;
    if (d > 0 && d < 300) { out.push([arr[k][0], d]); ref = v; }
    else if (d <= -50 || d >= 300) ref = v;
  }
  return out;
}

// «СЛІПА» СТОЯНКА між двома замірами палива: >SEG_GAP без жодного заміру (із заглушеним двигуном CAN мовчить
// годинами) і CAN-одометр не зріс → двигун не працював, витрата там 0. Падіння рівня через таку дірку — злив
// БЕЗ перевірки темпу: темп «л/хв», поділений на години стоянки, завжди малий (злив 15 л за 2-год обід давав
// 0,11 л/хв < 0,35 → «Злито 0», а 15 л ішли водію у «Витрачено» з червоним ⚠). Одометр беремо з КРАЙНІХ
// замірів дірки, не з середини вікна (під'їзд/від'їзд у вікні дають «рух» і злив губився).
// ОДНЕ правило і всередині доби (periodReport), і на стику діб (mergeReports) — інакше тиждень ≠ місяць.
function parkedHole(holeSec, odA, odB){
  return holeSec > SEG_GAP && odA != null && odB != null && odB - odA < 0.3;
}
// Поріг такого зливу росте з тривалістю стоянки: автономний обігрівач палить до ~0,6 л/год, і за ніч
// «зникає» кілька літрів без жодного зливу. Обід — DRAIN_L, ніч 13+ год — PARK_DRAIN_TOP_L.
function parkDrainMin(holeSec){
  return Math.max(DRAIN_L, Math.min(PARK_DRAIN_TOP_L, holeSec / 3600 * HEATER_LPH));
}

// ===== ЗВЕДЕННЯ ЗА ПЕРІОД (все одним проходом по повідомленнях) =====
// isStale (опційно) — колбек «результат уже нікому не потрібен»: рве пагінацію, коли користувач
// перемкнув вкладку/закрив панель, інакше покинутий «Місяць» тягнув до 10×40к запитів у фоні
async function periodReport(id, from, to, isStale) {
  const hit = repGet(id, from, to);
  if (hit) return hit;                       // закритий період уже пораховано — нуль запитів, миттєво
  // збій ДОПОМІЖНОГО запиту (одометр/якір) ≠ «даних нема»: такий звіт позначаємо partial і не кешуємо надовго,
  // інакше «8 км замість 15» лежало в repCache до кінця сеансу без жодного натяку
  let auxFail = false;
  // 1) одометр — точно і дешево. Живий період — через dayMileageEx: спільний кеш із карткою «за сьогодні»
  // (часто 0 запитів). Закрита доба — краї беремо з повідомлень, які й так качаємо; окремо лише «до опівночі»
  // (раніше 3 запити одометра на кожну добу тижня — це половина сплеску «Тиждень = 38 запитів»).
  const liveP = !to || to >= Math.floor(Date.now()/1000) - 90;   // те саме «живе» вікно, що в dayMileageEx
  const odoKmP = liveP ? dayMileageEx(id, from, to) : null;
  const odoBaseP = liveP ? null : (async () => {
    try {
      const field = await mileageField(id, from, to);
      return { field, before: field ? await odoAt(id, Math.max(0, from - 96*3600), from, true, field) : null };
    } catch(e) { auxFail = true; return null; }
  })();

  // 2) усі повідомлення періоду — лише потрібні поля, З ПАГІНАЦІЄЮ: при 2-сек піллінгу тиждень/місяць — це
  // СОТНІ тисяч рядків, а один запит віддає перші 40к → місячний звіт мовчки покривав лише перші дні
  // (і odoKm за весь місяць проти gpsKm за огризок давав фальшивий «⚠ РЕБ»)
  const FIELDS = 'timestamp,position.latitude,position.longitude,position.speed,position.valid,position.satellites,position.hdop,can.vehicle.mileage,vehicle.mileage,can.vehicle.speed,can.fuel.volume,can.fuel.level,can.vehicle.battery.level,gnss.state.enum,movement.status';   // movement.status — щоб «без фіксу» рахувати лише в русі
  let msgs = [], pageFrom = from, truncated = false;
  for (let page = 0; page < 10; page++) {                       // до 400к повідомлень; далі чесно позначаємо обрізання
    if (isStale && isStale()) { truncated = true; break; }
    const data = encodeURIComponent(JSON.stringify({ from: pageFrom, to, count:40000, fields: FIELDS }));
    let batch = [];
    // мережевий фейл посеред пагінації = зібрано ЛИШЕ шматок → обовʼязково truncated, інакше
    // odoKm за весь період проти огризка gpsKm давав фальшивий «⚠ РЕБ» і занижені цифри без попередження
    // Якщо ж упала ПЕРША сторінка — даних нема зовсім, і «0 км, стояв 24 год, подій нема» виглядало б
    // як справжній день. Кидаємо помилку: вкладка дня покаже її, а тиждень позначить добу як невантажену.
    try { batch = await api(`/gw/devices/${id}/messages?data=${data}`) || []; }
    catch(e) {
      if (page === 0 && !(isStale && isStale())) throw new Error('flespi не віддав повідомлення (ліміт запитів або мережа) — тапни вкладку ще раз');
      truncated = true; break;
    }
    msgs = msgs.concat(batch);
    if (batch.length < 40000) break;                            // остання (неповна) пачка — все зібрано
    pageFrom = (batch[batch.length-1].timestamp || pageFrom) + 0.001;
    if (page === 9) truncated = true;
  }
  msgs.sort((a,b)=> (a.timestamp||0)-(b.timestamp||0));
  const mdR = ((devCache || []).find(x => x.id === id) || {}).metadata || {};   // калібрування палива — як у fuelCurrent
  // ПАЛИВО ДО ПОЧАТКУ ДОБИ. Заправка, після якої трекер мовчав (вихідні, ніч, заглушене авто), падала в «дірку»
  // між днями: вкладка дня починала вже з повним баком і писала «Залито —» (Іван 07.10: обидва Master заправлені
  // між пт 15:30 і вт 09:10 — 26→64 і 34→87 сирих, а «вівторок» заправки не показував). Беремо медіану останніх
  // замірів до from; той самий канал і калібрування, що й у циклі нижче. +1 запит лише для дизелів.
  const tankS = tankFor(id);   // `tank` оголошено нижче — тут власна копія (інакше TDZ)
  const fuelSeedP = (!mdR.ev && tankS) ? (async () => {
    try {
      const fld = mdR.fuelByPct ? 'can.fuel.level' : 'can.fuel.volume';
      const dS = encodeURIComponent(JSON.stringify({ from: Math.max(0, from - 7*86400), to: from, count: 5, reverse: true,
        filter: fld, fields: 'timestamp,can.fuel.volume,can.fuel.level' }));
      const rs = (await api(`/gw/devices/${id}/messages?data=${dS}`)) || [];
      const Ls = rs.map(m => { const v = m[fld]; if (!(v > 0)) return null;
        return fld === 'can.fuel.level' ? calFuel(v / 100 * tankS, mdR) : calFuel(v, mdR); })
        .filter(L => L != null && L <= tankS * 1.6).sort((a, b) => a - b);
      return Ls.length ? { L: Ls[Math.floor(Ls.length / 2)] } : null;
    } catch(e) { return null; }   // без «до» — просто не бачимо заправку на стику, решта звіту чинна
  })() : Promise.resolve(null);

  // ЯКІР ПОЧАТКУ ПЕРІОДУ: остання ВІДОМА позиція до `from` (заглядаємо на 4 доби назад —
  // щоб понеділок стикувався з пʼятницею, а не починався «з нізвідки» після вихідних).
  // Інакше трек починався там, де GPS уперше зловив фікс після ночі/глушіння — часто за десятки км
  // від реального місця стоянки (Іван: «машина стояла в Сумах, а трек піймав її під Конотопом»).
  let anchor = null;
  const anchorP = (async () => {
  try {
    const dA = encodeURIComponent(JSON.stringify({ from: Math.max(0, from - 96*3600), to: from, count: 20, reverse: true,
      filter: 'position.valid=true', fields: 'timestamp,position.latitude,position.longitude,position.valid,position.satellites' }));
    anchor = firstSaneFix(await api(`/gw/devices/${id}/messages?data=${dA}`));
  } catch(e) { auxFail = true; /* якір вирішує stitchOk (стик одометра) — без нього цифра може бути неточна */ }
  })();

  // ЯКІР КІНЦЯ: якщо маршрут завершився під глушінням, справжня кінцева точка зʼявляється пізніше —
  // коли авто стало і GPS ожив (припаркований приймач ловить супутники значно краще за рухомий).
  // Для «живого» періоду (сьогодні) не шукаємо — там кінець ще попереду.
  let anchorEnd = null;
  const anchorEndP = (async () => {
  if (to < Math.floor(Date.now()/1000) - 300) {
    try {
      const dE = encodeURIComponent(JSON.stringify({ from: to, to: to + 96*3600, count: 20,
        filter: 'position.valid=true', fields: 'timestamp,position.latitude,position.longitude,position.valid,position.satellites' }));
      anchorEnd = firstSaneFix(await api(`/gw/devices/${id}/messages?data=${dE}`));
    } catch(e) { auxFail = true; }
  }
  })();

  const tank = tankFor(id);
  const track = [];
  let gpsM = 0, prevPt = null, prevTs = null, lastTrackPt = null;
  let firstFuel = null, lastFuel = null;
  const fuelPts = [];   // сирі заміри палива; згладжуються після циклу
  let jamSec = 0, prevJamTs = null;   // скільки часу авто ЇХАЛО без GPS-фіксу (РЕБ / тунель / завислий модуль): GNSS-одометр і трек у цей час СТОЯТЬ
  const spdLimit = (mdR.speedLimit || 110);   // ліміт цього авто (metadata.speedLimit)
  const overs = []; let curOver = null;       // епізоди перевищення швидкості
  const OVER_GAP = 60;                        // пауза між замірами, після якої епізод перевищення вважаємо закінченим
  let prevSoc = null, prevSocTs = null; const charges = [];   // ⚡ сесії зарядки електрички: зростання SoC на стоянці
  let socFirst = null, socLast = null, fuelFirstE = null, fuelLastE = null;   // краї доби — для стику діб у mergeReports
  const fills = [], drains = [];
  const stops = [];
  let stopStart = null, stopPt = null, stopOdo = null, curOdo = null;
  // семпли для СТРІЧКИ ДНЯ: [ts, одометр] і [ts, швидкість>0] — щоб порахувати км і макс. швидкість кожного відрізка руху.
  // Одометри двох джерел НЕ змішуємо (can=пробіг авто, gnss=лічильник трекера — різні шкали!): наприкінці беремо одне.
  const odoCan = [], odoGnss = [], spdS = [];
  let lastMsgTs = null;

  // справжня зупинка = швидкість ~0 І одометр НЕ зріс (інакше це рух під РЕБ-глушінням)
  // odoEnd — одометр ДО повідомлення від'їзду: цілочисельний CAN Renault часто тікає саме на ньому,
  // і цей 1 км — уже рух після стоянки, а не рух під час неї (Master 01.10 09:33 — зупинка зникала).
  // Стрибок >1 км (дірка даних / DEEP-HANG) — справжній рух, його не прощаємо.
  function closeStop(endTs, odoEnd){
    if (stopStart == null) return;
    const dur = endTs - stopStart;
    let oE = (odoEnd != null) ? odoEnd : curOdo;
    if (curOdo != null && oE != null && curOdo - oE > 1) oE = curOdo;
    const moved = (oE != null && stopOdo != null) ? (oE - stopOdo) : 0;
    if (dur >= STOP_MIN && moved < 0.3) stops.push({ ts:stopStart, dur, pt:stopPt });
    stopStart = null; stopOdo = null;
  }

  for (const m of msgs) {
    const ts = m.timestamp;
    if (ts != null) lastMsgTs = ts;
    const lat = m['position.latitude'], lon = m['position.longitude'];
    const odoBefore = curOdo;   // одометр до цього повідомлення — для closeStop на від'їзді
    const od = m['can.vehicle.mileage'];
    if (od != null && od > 0) { curOdo = od; if (stopStart != null && stopOdo == null) stopOdo = od; }  // od>0: ігнор глюків-нулів
    // семпли для відрізків руху (пушимо лише зміни — щоб масиви лишались маленькими).
    // Третій елемент — до якого моменту значення ще ПІДТВЕРДЖУВАЛОСЬ: odoNear відрізняє «одометр стояв»
    // від «одометр мовчав» (дірка CAN у Leaf), sumOf його не читає.
    if (od != null && od > 0) { const L = odoCan[odoCan.length-1]; if (L && L[1] === od) L[2] = ts; else odoCan.push([ts, od, ts]); }
    const odG = m['vehicle.mileage'];
    if (odG != null && odG > 0) { const L = odoGnss[odoGnss.length-1]; if (L && !(odG - L[1] > 0.05)) L[2] = ts; else odoGnss.push([ts, odG, ts]); }

    // валідність GPS-фіксу — відсікаємо «стрибки» (дефолтна/застаріла позиція без супутників)
    const valid = m['position.valid'];
    const sats = m['position.satellites'];
    let goodFix;
    if (valid !== undefined && valid !== null) goodFix = (valid === true) && (sats == null || sats >= 3);   // valid=true з 0 супутників = спуф (ревʼю v74)
    else if (sats !== undefined && sats !== null) goodFix = (sats >= 3);
    else goodFix = true;
    // дефолтна точка трекера (Ліма) зрідка приходить НАВІТЬ з valid=true — географічний щит обовʼязковий
    if (lat != null && lon != null && !saneRegion(lat, lon)) goodFix = false;

    // ШВИДКІСТЬ: пріоритет — спідометр авто по CAN (РЕБ-стійкий, не бреше). GPS-швидкість беремо ЛИШЕ
    // з валідним фіксом: під глушінням телепорти давали фантомні «199 км/г» у макс. швидкість дня.
    // Зверху фізична межа 170 (фургон швидше не їде — усе вище це глюк, навіть із «валідним» фіксом).
    const spCan = m['can.vehicle.speed'], spGps = m['position.speed'];
    let sp = null;
    // ДОВІРА ДО GPS-ШВИДКОСТІ. Спуф під РЕБ віддає «швидкість» при нерухомій або стрибучій точці:
    // 31.08 Kangoo Z.E. 36 секунд рапортував 180→143 км/г, маючи координати БАЙТ-У-БАЙТ ті самі,
    // hdop 37 і 3 супутники. Через це в дні з'являлось фальшиве перевищення і «макс. 143 км/г»
    // у електрички, яка стільки не їздить. CAN-швидкість (з шини авто) поза підозрою — бреше саме GPS.
    // Умови: досить супутників, притомний hdop, і точка УЗГОДЖУЄТЬСЯ зі швидкістю — не телепорт і не завмерла.
    const hdopM = m['position.hdop'];
    let spdTrust = (sats == null || sats >= 4) && (hdopM == null || hdopM <= MAX_HDOP);
    if (spdTrust && lat != null && lon != null && prevPt && prevTs != null) {
      const dmS = haversine(prevPt, [lat, lon]), dtS = ts - prevTs;
      const impl = dtS > 0 ? dmS / dtS * 3.6 : 0;   // скільки авто НАСПРАВДІ проїхало між фіксами
      if (dtS > 0 && dtS <= 120 && impl > MAX_JUMP_KMH) spdTrust = false;   // точка телепортувалась — це не рух
      // Головна перевірка: заявлена швидкість має підтверджуватись переміщенням точки. Спуф 31.08
      // рапортував 143 км/г, зсуваючи точку лише на 40 м за 5 с (≈29 км/г). Вікно коротке (≤20 с),
      // бо на довгому проміжку «середня по прямій» законно менша за миттєву (стоянка → розгін).
      else if (dtS > 0 && dtS <= 20 && (spGps || 0) > 25 && spGps > impl * 2.5 + 15) spdTrust = false;
    }
    // CAN-нуль при напівживому OBD-лінку раніше перебивав валідну GPS-швидкість: трек рвався
    // на фальшиві «зупинки», і відрізки руху зникали зі стрічки
    if (spCan != null && spCan > 0 && spCan < 170) sp = spCan;
    else if (spGps != null && goodFix && spdTrust && spGps < 170) sp = spGps;
    else if (spCan === 0) sp = 0;
    if (sp != null && sp >= 3) spdS.push([ts, sp]);

    // облік «без фіксу в русі»: gnss.state.enum=2 (AVL 69: GNSS увімкнений, фіксу нема) — трек і GNSS-одометр
    // у цей час стоять, кілометри «зникають». Лише В РУСІ (акселерометр або підтверджена швидкість): на стоянці
    // без неба кілометрів не губиться, а раніше 3 год у гаражі давали «GPS глушився — частина пробігу НЕ порахована».
    const jamE = m['gnss.state.enum'];
    if (jamE === 2 && ts != null && (m['movement.status'] === true || (sp != null && sp >= STOP_SPEED))) {
      if (prevJamTs != null) jamSec += Math.min(ts - prevJamTs, 300);   // дірки >5 хв не роздувають лічильник
      prevJamTs = ts;
    } else if (jamE != null) prevJamTs = null;

    // ⚠ ПЕРЕВИЩЕННЯ: епізод = безперервний відрізок, де швидкість трималась вище ліміту авто.
    // Точки беремо лише з ТВЕРДИХ фіксів — інакше під РЕБ намалюємо «гонки» там, де їх не було.
    // Невідома швидкість (РЕБ без CAN-спідометра, дірка в даних) — НЕ «далі гнав»: розриваємо епізод,
    // інакше два короткі епізоди через 20 хв без фіксу ставали одним «20 хв понад ліміт»
    if (curOver && ts != null && ts - curOver.endTs > OVER_GAP) {
      if (curOver.endTs - curOver.ts >= 5) overs.push(curOver);
      curOver = null;
    }
    if (sp != null && ts != null) {
      if (sp > spdLimit) {
        if (!curOver) curOver = { ts, endTs: ts, maxSpd: sp, pts: [] };
        curOver.endTs = ts;
        if (sp > curOver.maxSpd) curOver.maxSpd = sp;
        if (goodFix && lat != null && lon != null && saneRegion(lat, lon) &&
            (!curOver.pts.length || haversine(curOver.pts[curOver.pts.length-1], [lat,lon]) > 40)) curOver.pts.push([lat, lon, Math.round(sp)]);
      } else if (curOver) {
        if (curOver.endTs - curOver.ts >= 5) overs.push(curOver);   // <5 с — викид датчика, не гонка
        curOver = null;
      }
    }

    // трек + GPS-відстань (тільки валідні точки, без телепортів)
    const hdop = m['position.hdop'];
    const goodPrecision = (hdop == null || hdop <= 4);   // hdop>4 — неточний фікс (відбиття/міське каньйонування), не малюємо ним трек
    if (lat != null && lon != null && goodFix) {
      const pt = [lat, lon];
      let teleport = false;
      if (prevPt) {
        const dm = haversine(prevPt, pt);
        const dt = (prevTs != null) ? (ts - prevTs) : 0;
        const kmh = (dt > 0) ? (dm / dt * 3.6) : 0;
        // dt<=0 (буферизовані пачки з однаковим часом) обходив фільтр: стрибок з kmh=0 проходив як «рух»
        teleport = (dt <= 0) ? (dm > JITTER_M * 30) : (dm > JITTER_M && kmh >= 200);
        if (dm > JITTER_M && !teleport && goodPrecision) gpsM += dm;
      }
      // ЯКІР рухаємо лише коли крок ЗАРАХОВАНО. Раніше він переставлявся завжди, тому дрібні
      // кроки (<15 м) не накопичувались, а СТИРАЛИСЬ — і місто на 20 км/г давало 0 км пробігу.
      if (!prevPt || haversine(prevPt, pt) > JITTER_M) { prevPt = pt; prevTs = ts; }
      // МАЛЮЄМО трек рідше за сирі фікси: при пілінгу 2с GPS-шум (±3-8м) дає зубчасту «розмазану» лінію.
      // Пушимо нову точку лише коли відійшли достатньо від ОСТАННЬОЇ НАМАЛЬОВАНОЇ (не від кожного сирого фіксу),
      // і не телепорт (інакше на карті буде кривий стрибок-лінія через увесь маршрут).
      if (goodPrecision && !teleport && (!lastTrackPt || haversine(lastTrackPt, pt) > TRACK_MIN_M)) {
        track.push([pt[0], pt[1], ts]); lastTrackPt = pt;   // третій елемент — час: щоб тап по «Їхав» вирізав шматок треку
      }
    }

    // зупинки (швидкість ~0 І одометр не росте); точка стоянки — ЛИШЕ з валідного фіксу (не Ліма!)
    if (sp != null && ts != null) {
      if (sp < STOP_SPEED) {
        if (stopStart == null) { stopStart = ts; stopPt = (goodFix && lat!=null && lon!=null) ? [lat,lon] : prevPt; stopOdo = curOdo; }
      } else {
        closeStop(ts, odoBefore);
      }
    }

    // паливо: збираємо СИРІ семпли, а заправки/зливи шукаємо ПІСЛЯ циклу по ЗГЛАДЖЕНІЙ кривій.
    // Причина: поплавок у баку плескається на ходу. Volvo XC40 віддає сире положення — розкид
    // 8..97% за добу, і посемпльна детекція нарахувала 661 «заправку» і 939 «зливів» за один день.
    // Калібрування — те саме, що на картці (fuelCurrent), інакше звіт і картка розходяться.
    const fpct = m['can.fuel.level'];
    let flv = null;
    if (mdR.fuelByPct) {
      if (fpct != null && fpct > 0 && tank) flv = calFuel(fpct/100*tank, mdR);
    } else {
      const rawVol = m['can.fuel.volume'];
      flv = (rawVol != null && rawVol > 0) ? calFuel(rawVol, mdR) : null;
      if (flv == null && fpct != null && fpct > 0 && tank) flv = calFuel(fpct/100*tank, mdR);
    }
    // СТЕЛЮ БАКА тут НЕ застосовуємо — лише відсів явного сміття. Обрізання кожного заміру до
    // ємності вбивало верхівку заправки: 105−57=48 л замість реальних 54.34 (чек 17.08).
    if (flv != null && tank && flv > tank * 1.6) flv = null;
    // швидкість: null (нема ні CAN, ні валідного GPS) — це НЕ нуль, інакше під РЕБ будь-яке
    // вікно вважалось «машина стояла», і плескіт палива йшов у звіт як заправка
    // od — CAN-одометр на момент заміру: чи рухалось авто через «сліпу» дірку без замірів (див. parkedHole)
    if (flv != null && flv > 0 && ts != null) fuelPts.push({ ts, L: flv, sp: (sp == null ? null : sp), pt: prevPt, od: curOdo });

    // ⚡ ЗАРЯДКА електрички: SoC росте на стоянці. Сесії ближче 30 хв зливаємо в одну (нічна зарядка = одна подія).
    const soc = m['can.vehicle.battery.level'];
    if (soc != null && soc > 0 && soc <= 100) {
      // «стоїть з»: остання ЗМІНА CAN-одометра в періоді; не мінявся — стоїть щонайменше з початку періоду.
      // Без CAN-одометра — як раніше, від попереднього заміру SoC.
      const standSince = curOdo == null ? prevSocTs : (odoCan.length > 1 ? odoCan[odoCan.length-1][0] : from);
      // стоянка: швидкість відома → за нею; невідома (фікса нема, а CAN-швидкості Kangoo Z.E. не шле взагалі) →
      // одометр не мінявся ≥SEG_GAP. Сам «той самий одометр» не годиться: крок 1 км, на ходу сусідні заміри теж рівні.
      const parkedNow = sp != null ? sp < 3 : (curOdo != null && standSince != null && ts - standSince >= SEG_GAP);
      // <CHG_MIN_PCT = дрижання датчика / відскік BMS після вимкнення (Z.E. 29.09: 73→75 за 5 хв без кабелю)
      if (prevSoc != null && soc - prevSoc >= CHG_MIN_PCT && parkedNow) {
        const dpct = soc - prevSoc;
        // допустимий приріст МАСШТАБУЄТЬСЯ часом СТОЯНКИ: вночі трекер спить, і зарядка +50%
        // приходить одним стрибком уранці — це не глюк. 40%/год покриває і 7кВт wallbox для Z.E.
        // (22 кВт·год ÷ 7 кВт ≈ 32%/год) — стара ставка 25%/год мовчки викидала реальні сесії.
        // Час — від початку стоянки, а не від попереднього заміру: уранці трекер спершу шле застарілий
        // вечірній SoC (29.09: 27 % о 08:21:43), а через 5 с справжній 100 % — «+73 % за 5 с» відкидалось як глюк.
        const t0 = Math.min(standSince != null ? standSince : ts, prevSocTs != null ? prevSocTs : ts);
        const hrs = Math.max(0, (ts - t0) / 3600);
        const maxRise = Math.min(100, hrs * 40 + 8);
        if (dpct <= maxRise) {
          const lastC = charges[charges.length-1];
          if (lastC && ts - lastC.endTs < 1800) { lastC.pct += dpct; lastC.endTs = ts; }
          else charges.push({ ts, endTs: ts, pct: dpct, pt: prevPt });
        }
      }
      prevSoc = soc; prevSocTs = ts;
      if (!socFirst) socFirst = { ts, soc, od: curOdo, pt: prevPt };
      socLast = { ts, soc, od: curOdo, pt: prevPt };
    }
  }
  // ===== ПАЛИВО: згладжування медіаною по 5-хвилинних вікнах =====
  // Медіана стійка до плескання (на відміну від середнього, її не тягне пара викидів).
  // Заправкою/зливом вважаємо ЗМІНУ МІЖ СУСІДНІМИ ВІКНАМИ, яка ще й ТРИМАЄТЬСЯ наступне вікно —
  // разова «гірка» від нахилу дороги так відсіюється.
  {
    const FUEL_WIN = 300;
    const bmap = new Map();
    for (const f of fuelPts) {
      const k = Math.floor(f.ts / FUEL_WIN);
      if (!bmap.has(k)) bmap.set(k, []);
      bmap.get(k).push(f);
    }
    const median = arr => { const a = arr.slice().sort((x,y)=>x-y); return a[Math.floor(a.length/2)]; };
    const seq = Array.from(bmap.keys()).sort((a,b)=>a-b).map(k => {
      const arr = bmap.get(k), mid = arr[Math.floor(arr.length/2)];
      // «стояла» = БІЛЬШІСТЬ семплів мають ЯВНУ швидкість <1. Раніше досить було одного семпла
      // без даних про швидкість (sp=null під РЕБ) — і будь-яке вікно ставало «стоянкою».
      const known = arr.filter(x => x.sp != null);
      const ods = arr.filter(x => x.od != null);
      return { ts: mid.ts, L: median(arr.map(x=>x.L)), pt: mid.pt,
               // КРАЇ вікна (перший/останній замір) — для «сліпої стоянки»: дірка і одометр через неї
               tsF: arr[0].ts, tsL: arr[arr.length-1].ts, ptL: arr[arr.length-1].pt,
               odF: ods.length ? ods[0].od : null, odL: ods.length ? ods[ods.length-1].od : null,
               stoodAny: known.some(x => x.sp < 1) };   // чи була бодай коротка зупинка у вікні
    });
    if (seq.length) {
      const s0 = seq[0], s1 = seq[seq.length-1];
      firstFuel = s0.L; lastFuel = s1.L;
      fuelFirstE = { ts: s0.tsF, L: s0.L, od: s0.odF, pt: s0.pt };   // для стику діб (mergeReports)
      fuelLastE = { ts: s1.tsL, L: s1.L, od: s1.odL, pt: s1.ptL };
    }
    // Заправка/злив = СУЦІЛЬНИЙ рух рівня від локального мінімуму до максимуму, а не крок між
    // двома сусідніми вікнами. Заливання 54 л триває ~10 хв і розтягується на 3 вікна — раніше
    // у звіт потрапляв лише останній крок (+18 л замість 54).
    let i = 1;
    while (i < seq.length) {
      const dir = Math.sign(seq[i].L - seq[i-1].L);
      if (dir === 0) { i++; continue; }
      let j = i;
      while (j + 1 < seq.length && Math.sign(seq[j+1].L - seq[j].L) === dir) j++;
      const total = seq[j].L - seq[i-1].L;
      // ЗАПРАВКА: умови «машина стояла» тут НЕ треба — пальне в баку саме не зʼявляється, а вікно
      // із заправкою майже завжди містить і відʼїзд від колонки (саме через це заправка на 54 л
      // раніше не детектувалась зовсім).
      if (dir > 0 && total >= FILL_L) fills.push({ ts: seq[i].ts, l: total, pt: seq[i].pt });
      // ЗЛИВ: навпаки, потрібна зупинка — інакше звичайна витрата на ходу рахувалась би як крадіжка.
      // Плюс перевірка темпу: за час руху стільки просто не згоріло б.
      else if (dir < 0 && -total >= DRAIN_L) {
        // спершу «сліпі» стоянки всередині цього спуску (див. parkedHole): падіння через них — злив без темпу.
        // Решта спуску (їзда) лишається у витраті. Старе правило темпу нижче — без змін.
        let parkDrop = 0, parkK = -1, parkHole = 0;
        for (let k = i; k <= j; k++) {
          const a = seq[k-1], b = seq[k], hole = b.tsF - a.tsL;
          if (parkedHole(hole, a.odL, b.odF)) { parkDrop += a.L - b.L; parkHole = Math.max(parkHole, hole); if (parkK < 0) parkK = k; }
        }
        if (parkK >= 0 && parkDrop >= parkDrainMin(parkHole)) {
          drains.push({ ts: seq[parkK-1].tsL, l: parkDrop, pt: seq[parkK-1].ptL || seq[parkK].pt });   // час/місце — початок стоянки, поруч із «P» у стрічці
        } else {
          const mins = Math.max(1, (seq[j].ts - seq[i-1].ts) / 60);
          const stood = seq.slice(i-1, j+1).some(w => w.stoodAny);
          if (stood && (-total) / mins > 0.35) drains.push({ ts: seq[i].ts, l: -total, pt: seq[i].pt });   // >21 л/год = не витрата, а злив
        }
      }
      i = j + 1;
    }
  }

  if (curOver && curOver.endTs - curOver.ts >= 5) overs.push(curOver);   // епізод, що тривав до кінця періоду
  // зливаємо епізоди з паузою <60 с — інакше одна довга «гонка» дробиться на десяток записів у стрічці
  const speedings = [];
  for (const e of overs) {
    const last = speedings[speedings.length-1];
    if (last && e.ts - last.endTs < OVER_GAP) {
      last.endTs = e.endTs; last.maxSpd = Math.max(last.maxSpd, e.maxSpd); last.pts = last.pts.concat(e.pts);
    } else speedings.push(e);
  }
  for (const e of speedings) e.maxSpd = Math.round(e.maxSpd);

  closeStop(to); // зупинка, що триває досі

  await Promise.all([anchorP, anchorEndP]);   // обидва тягнулись паралельно з розбором повідомлень
  // ділянка від місця стоянки до першого фікса — GPS її не бачив (сон/РЕБ), але авто там реально їхало.
  // Додаємо ПРЯМУ відстань (це нижня оцінка) — лише коли вона фізично правдоподібна.
  // Ділянка через опівніч — ОДНА на дві доби: якір кінця доби N і якір початку доби N+1 бачать ту саму пряму.
  // Тому кожна доба бере лише свою частку за часом (до/після межі) — інакше «Тиждень» (сума діб) брав її двічі.
  // Частку рахуємо із сирих секунд (без підлоги dtH) і обрізаємо в [0,1]: однакові мітки не дадуть NaN.
  if (anchor && track.length) {
    const f0 = track[0];
    const legKm = haversine([anchor[0], anchor[1]], [f0[0], f0[1]]) / 1000;
    const dtH = Math.max(0.02, ((f0[2] || from) - anchor[2]) / 3600);
    const den = (f0[2] || from) - anchor[2];
    const share = den > 0 ? Math.min(1, Math.max(0, ((f0[2] || from) - from) / den)) : 0;
    if (legKm > 0.2 && dtH <= 6 && legKm / dtH <= 150) gpsM += legKm * 1000 * share;   // ≤6 год: старіший якір дав би сотні фантомних км
    else if (legKm / dtH > 150) anchor = null;
  }
  if (anchorEnd && track.length) {
    const lp = track[track.length-1];
    const legKm = haversine([lp[0], lp[1]], [anchorEnd[0], anchorEnd[1]]) / 1000;
    const dtH = Math.max(0.02, (anchorEnd[2] - (lp[2] || to)) / 3600);
    const den = anchorEnd[2] - (lp[2] || to);
    const share = den > 0 ? Math.min(1, Math.max(0, (to - (lp[2] || to)) / den)) : 1;
    if (legKm > 0.2 && dtH <= 6 && legKm / dtH <= 150) gpsM += legKm * 1000 * share;
    else if (legKm / dtH > 150) anchorEnd = null;
  }
  // перша зупинка періоду без координат (стояв ще з учора, під РЕБ фікса нема) — беремо місце з якоря
  if (anchor && stops.length && !stops[0].pt && stops[0].ts - anchor[2] < 1800) stops[0].pt = [anchor[0], anchor[1]];   // інакше зупинка в клієнта підписувалась адресою бази

  // ПРОБІГ. Раніше бралася різниця «останній мінус перший» — і будь-який скид лічильника
  // або нульові краї обвалювали добу до останнього шматка (Kangoo: 7 км замість реальних).
  // Тепер сумуємо ДОДАТНІ прирости вже зібраного масиву — це імунно і до скидів, і до нулів.
  // odoSrc каже, ЗВІДКИ цифра: CAN-одометр авто (стійкий до РЕБ) чи GNSS трекера (під РЕБ замерзає).
  let odoEdge = null;
  if (odoKmP) { const r = await odoKmP; if (r.fail) auxFail = true; odoEdge = r.km; }
  else if (truncated) {   // повідомлення обрізані — їхні краї неповні; беремо запитами, як раніше (рятує odoKm «Місяця»)
    // покинутий звіт (перемкнули вкладку / закрили панель) нікому не потрібен — ще 3–4 запити одометра не палимо
    if (!(isStale && isStale())) { const r = await dayMileageEx(id, from, to); if (r.fail) auxFail = true; odoEdge = r.km; }
  } else {
    const b = await odoBaseP;
    if (b && b.field) {   // ті самі краї, що дав би dayMileage (перше/останнє значення >0), але з уже завантажених повідомлень
      let firstIn = null, last = null;
      for (const m of msgs) { const v = m[b.field]; if (v != null && v > 0) { if (firstIn == null) firstIn = v; last = v; } }
      odoEdge = edgeKm(b.before, firstIn, last, from, to).km;
    }
  }
  let odoKm = odoEdge, odoSrc = null, odoSrcArr = null;
  {
    // «СТИК» ІЗ ПОПЕРЕДНЬОЮ ДОБОЮ (odoEdge = останній одометр періоду мінус останній ДО періоду)
    // чесний лише тоді, коли авто справді їхало у «сліпому» проміжку між добами.
    // CAN-одометр уміє ЗАМЕРЗАТИ: у Leaf 22.08 за цілу добу прийшло ОДНЕ значення, і стик приписав
    // неділі 27 фантомних км — 57 замість реальних 30 (баг, який зловив Іван).
    // Перевірка чесна й дешева: якщо доба почалась ТАМ, де вчора закінчилась, і якір свіжий —
    // машина нікуди не їздила, отже стикувати нічого.
    const stitchOk = !(anchor && track.length && (track[0][2] || from) - anchor[2] <= 6*3600
      && haversine([anchor[0], anchor[1]], [track[0][0], track[0][1]]) < 1000);
    // ДЖЕРЕЛО ПРОБІГУ: не «CAN завжди головний», а те, що бачило БІЛЬШЕ.
    // Обидва вміють лише НЕДОРАХОВУВАТИ: CAN випадає, коли OBD не відповідає (у Leaf 21.08 —
    // 16 значень за добу, частина взагалі 0, дірка 09:28–11:33 з’їла цілу поїздку → 14 км замість 20);
    // GNSS-одометр трекера замерзає під РЕБ. Тому беремо більший — і жодне джерело не «краде» км.
    const sumOf = arr => (!arr || arr.length < 2) ? null : Math.round(odoUps(arr).reduce((s, u) => s + u[1], 0));
    const sCan = sumOf(odoCan), sGnss = sumOf(odoGnss);
    // Але GNSS-одометр уміє й ПЕРЕрахувати: стрибки позиції під РЕБ він лічить як рух (Master 0516 22.09:
    // CAN увесь день 295346, GNSS +5 км на стоянці). Тому: живий CAN без змін за добу = 0 км (стояв), а не
    // «даних нема»; GNSS перемагає лише тоді, коли його підтверджує GPS-трек (Leaf 01.10: CAN замерз, GNSS 37, трек 36).
    const sCanE = (sCan == null && odoCan.length) ? 0 : sCan;
    const gK = gpsM / 1000;
    let sum = null, src = null;
    // ...АЛЕ під РЕБ трек глушать, і «≥70% треку» не досягається навіть на чесній поїздці: Leaf із замерзлим CAN
    // показав би 0 км замість реальних. Тому другий свідок — довірені заміри швидкості (spdS: CAN-швидкість або
    // GPS-швидкість, підтверджена переміщенням точки). На стоянці їх нема, тож «повзучий» GNSS там і далі не пройде.
    const drove = spdS.length >= 10;
    if (sCanE != null && (sGnss == null || sCanE >= sGnss || (gK < sGnss * 0.7 && !drove))) { sum = sCanE; src = odoCan; odoSrc = 'can'; }
    else if (sGnss != null) { sum = sGnss; src = odoGnss; odoSrc = 'gnss'; }
    odoSrcArr = src;
    if (!stitchOk) odoKm = (sum != null) ? sum : 0;                    // тільки те, що бачили В МЕЖАХ доби;
                                                                      // авто стояло там само, де вчора → чесний 0, а не «—»
    else if (sum != null && (odoEdge == null || sum > odoEdge)) odoKm = sum;   // частина записів не долетіла — беремо більше
    if (odoKm != null && odoKm <= 0 && stitchOk) odoKm = odoEdge;
  }
  const gpsKm = Math.round(gpsM/1000);
  let filledL = null, drainedL = null, spentL = null, spentRaw = null;
  if (firstFuel != null && lastFuel != null) {   // firstFuel/lastFuel уже в літрах
    const fillsRaw = fills.reduce((s,f)=>s+f.l,0), drainsRaw = drains.reduce((s,f)=>s+f.l,0);
    filledL = Math.round(fillsRaw);
    drainedL = Math.round(drainsRaw);
    spentL = Math.max(0, Math.round((firstFuel - lastFuel) + filledL - drainedL));
    // НЕокруглене — лише для л/100: ціле spentL на 20-км добі давало ±30% (Kangoo 1,3 л → «1 л» → 4,8 замість 6,2)
    spentRaw = Math.max(0, (firstFuel - lastFuel) + fillsRaw - drainsRaw);
  }
  const fuelSeed = await fuelSeedP;
  let fuelSeeded = false;
  if (fuelSeed && firstFuel != null && fuelFirstE && !truncated && firstFuel - fuelSeed.L >= FILL_L) {
    // ПІСЛЯ розрахунку spentL: доба почалась уже з повним баком, тож ця заправка в денну витрату не входить
    fills.push({ ts: fuelFirstE.ts, l: firstFuel - fuelSeed.L, pt: fuelFirstE.pt, after: true });
    filledL = (filledL || 0) + Math.round(firstFuel - fuelSeed.L);
    fuelSeeded = true;
  }

  // ===== ВІДРІЗКИ РУХУ (для стрічки дня): проміжки між зупинками =====
  const odoS = odoSrcArr || odoGnss;   // ТЕ САМЕ джерело, що й пробіг (шкали різні — не мішати!)
  // ПОКАЗ одометра НА момент t: останнє значення ≤ t (масив зберігає лише ЗМІНИ). Раніше брався найближчий
  // семпл з обох боків — старт відрізка чіплявся за перший тік ПІСЛЯ рушання, і кілометр до нього губився
  // (Kangoo 8440 02.10: стрічка 26 км при пробігу 35). Якщо ж одометр мовчав >30 хв до t (дірка CAN у Leaf),
  // старе значення — не показ, а пропуск: тоді, як і раніше, найближчий семпл після (або null → GPS-фолбек).
  function odoNear(t){
    if (!odoS.length) return null;
    let lo = 0, hi = odoS.length;
    while (lo < hi) { const mid = (lo+hi)>>1; (odoS[mid][0] <= t) ? lo = mid+1 : hi = mid; }
    const prev = lo > 0 ? odoS[lo-1] : null, next = lo < odoS.length ? odoS[lo] : null;
    if (prev && t - (prev[2] != null ? prev[2] : prev[0]) <= 1800) return prev[1];
    return (next && next[0] - t <= 1800) ? next[1] : null;
  }
  // ЗАМІРИ РУХУ = швидкість ≥3 АБО приріст CAN-одометра. У Leaf і Kangoo Z.E. нема CAN-швидкості, а під РЕБ
  // GPS-швидкість невалідна → sp=null, і вся їзда під глушінням зникала зі стрічки й «У русі», хоча одометр
  // рахував км (Z.E. 02.10: пробіг 51 км, у стрічці 17). Лише CAN: GNSS-одометр під РЕБ стоїть, а під спуфом
  // може «їхати» на місці. Синтетичний замір має швидкість 0 — макс. швидкість і перевищення його не бачать.
  const movS = spdS.slice();
  if (odoSrc === 'can') { for (const u of odoUps(odoCan)) movS.push([u[0], 0]); movS.sort((x,y)=>x[0]-y[0]); }
  const segments = [];
  const sortedStops = stops.slice().sort((a,b)=>a.ts-b.ts);
  function addSeg(a0, b0){
    if (b0 - a0 < 120) return;                   // <2 хв — шумовий проміжок
    // РІЖЕМО вікно на РЕАЛЬНІ поїздки. Раніше було одне звуження «перший…останній замір швидкості»,
    // і якщо між ними зяяла ніч без даних (зупинку не розпізнало), уся ніч ішла в «У русі»:
    // тиждень Leaf показував 3695 хв руху = 61 година за 7 діб (фізично неможливо). Тепер кожна
    // пауза довша за SEG_GAP розриває відрізок, і в «У русі» лишається тільки справжня їзда.
    const win = [];
    for (const s of movS) if (s[0] >= a0 && s[0] <= b0) win.push(s);
    if (!win.length) return;                     // жодного заміру руху — це не поїздка
    let i0 = 0;
    for (let i = 1; i <= win.length; i++) {
      if (i < win.length && win[i][0] - win[i-1][0] <= SEG_GAP) continue;
      pushSeg(win[i0][0], Math.min(b0, win[i-1][0] + 60), win.slice(i0, i));
      i0 = i;
    }
  }
  function pushSeg(a, b, win){
    if (b - a < 120) return;
    let mx = 0;
    for (const s of win) if (s[1] > mx) mx = s[1];
    const o1 = odoNear(a), o2 = odoNear(b);
    let km = (o1 != null && o2 != null) ? Math.round((o2-o1)*10)/10 : null;
    if (km != null && km > 3000) km = null;      // глюк одометра
    // >150 км/г у середньому за відрізок — фізично неможливо для фургона: це дірка одометра, яку приписали
    // одному рядку («відмерзлий» CAN), а не їзда → рахуємо по GPS-треку
    if (km != null && km / Math.max(b - a, 60) * 3600 > 150) km = null;
    // Одометр по CAN може «спати» (Leaf шле пробіг рідко): обидва кінці короткої поїздки чіпляються
    // за той самий семпл → km=0 → відрізок зникав, і авто «телепортувалось» між зупинками (баг, який
    // зловив Іван). Якщо одометр не бачить руху, а швидкості є — міряємо відстань по GPS-треку.
    if (km == null || km < 0.3) {
      let g = 0, pv = null;
      for (const p of track) if (p[2] != null && p[2] >= a && p[2] <= b) { if (pv) g += haversine(pv, p); pv = p; }
      g = Math.round(g/100)/10;                  // метри → км, 1 знак
      if (g >= 0.3) km = g;
      else if (km != null) return;               // і одометр, і GPS кажуть «не рухались» — шум
    }
    segments.push({ ts:a, dur:b-a, km, maxSpd:Math.round(mx) });
  }
  let cursor = from;
  for (const s of sortedStops) { addSeg(cursor, s.ts); cursor = Math.max(cursor, s.ts + s.dur); }
  if (lastMsgTs != null) addSeg(cursor, Math.min(to, lastMsgTs));
  const driveSec = segments.reduce((s,x)=>s+x.dur, 0);
  // «Стояв» = увесь період мінус рух (просто і чесно: ніч/паузи без даних — це теж стоянка)
  const periodEnd = Math.min(to, Math.floor(Date.now()/1000));
  const standSec = Math.max(0, (periodEnd - from) - driveSec);
  // максимальна швидкість періоду — для контролю водіїв (як ліміт швидкості у Wialon/MegaGPS)
  let maxSpd = 0;
  for (const s of spdS) if (s[1] > maxSpd) maxSpd = s[1];
  maxSpd = Math.round(maxSpd);

  // ⚡ електрика: кВт·год і грн по реальному зростанню SoC (×1.12 — втрати зарядки з розетки)
  const devMd = (devCache.find(x => x.id === id) || {}).metadata || {};
  let evKwh = null, evCost = null;
  const chargedPct = charges.reduce((a,c) => a + c.pct, 0);
  if (chargedPct >= 2 && devMd.batteryKwh) {
    evKwh = Math.round(chargedPct / 100 * devMd.batteryKwh * 1.12 * 10) / 10;
    if (devMd.elPrice) evCost = Math.round(evKwh * devMd.elPrice);
  }
  charges.forEach(c => {   // готуємо цифри для стрічки
    c.kwh = devMd.batteryKwh ? Math.round(c.pct / 100 * devMd.batteryKwh * 1.12 * 10) / 10 : null;
    c.uah = (c.kwh != null && devMd.elPrice) ? Math.round(c.kwh * devMd.elPrice) : null;
    c.pct = Math.round(c.pct);
  });

  const rep = { odoKm, odoSrc, gpsKm, filledL, spentL, spentRaw, drainedL, fuelFirst: fuelFirstE, fuelLast: fuelLastE, socFirst, socLast, driveSec, standSec, segments, maxSpd, truncated, partial: auxFail, charges, evKwh, evCost, jamSec, anchor, anchorEnd, spdLimit,
           spdCount: speedings.length, spdSec: speedings.reduce((a,e)=>a+(e.endTs-e.ts),0), speedings: speedings.slice(0, 100),
           fills: fills.map(f=>({ts:f.ts,l:Math.round(f.l),pt:f.pt,after:!!f.after})), fuelSeeded,
           drains: drains.map(f=>({ts:f.ts,l:Math.round(f.l),pt:f.pt})),
           track: simplifyTrack(thinTrack(track), TRACK_SIMPLIFY_M), stops };
  repPut(id, from, to, rep);
  return rep;
}

// ===== ДОВГІ ПЕРІОДИ = СУМА ДІБ =====
// Один запит на тиждень — 20.5 тис. повідомлень і 4.2 МБ, на місяць ≈ 18 МБ: телефон чекав десятки
// секунд і з'їдав мобільний трафік. Але доба вже рахується окремо для вкладок днів, і межі збігаються
// ОДИН-В-ОДИН. Тому «Тиждень»/«Місяць» складаємо з ДОБОВИХ звітів: кожна доба тягнеться один раз
// і лягає в той самий repCache, що й вкладка дня. Переглянув дні — тиждень відкривається миттєво.
// Бонус: пробіг стає точнішим — доба рахується у своїх межах, без «стику» через опівніч (див. v90).
function daySpans(from, to){
  const out = [];
  let a = from;
  while (a < to && out.length < 40) {                 // 40 — стеля на випадок дивних меж, місяць ≤ 31
    const d = new Date(a * 1000);
    d.setHours(24, 0, 0, 0);                          // наступна МІСЦЕВА опівніч (сам обробляє перехід на літній час)
    const b = Math.min(Math.floor(d.getTime() / 1000), to);
    if (b <= a) break;
    out.push([a, b]);
    a = b;
  }
  return out;
}
// Подія, розрізана опівніччю (стоянка з вечора до ранку, поїздка через 00:00), приходить двома
// шматками — зшиваємо назад, інакше тиждень показував 45 «зупинок» замість 38.
// bounds/segs — лише для СТОЯНОК: доба N закриває нічну стоянку рівно опівночі (closeStop(to)), а доба N+1
// відкриває її лише на першому пакеті з відомою швидкістю — на стоянці трекер шле раз на 10 хв, а Master
// мовчить годинами. «Впритул» (120 с) ловив лише ~20% ночей. Тому на межі ЗАВАНТАЖЕНИХ сусідніх діб
// зшиваємо, якщо між ними не було відрізка руху і це те саме місце (<300 м — захист від переїзду під РЕБ
// без даних швидкості); якщо місце невідоме — лише в межах двох періодів «на стоянці».
function joinAtBoundary(arr, bounds, segs){
  const out = [];
  for (const x of arr) {
    const prev = out[out.length - 1];
    let join = false;
    if (prev) {
      const pe = prev.ts + prev.dur, gap = x.ts - pe;
      join = gap <= 120;   // впритул — це одна подія
      if (!join && bounds && bounds.some(b => Math.abs(b - pe) < 1)          // стояв до самої опівночі
          && !(segs || []).some(s => s.ts >= pe - 1 && s.ts < x.ts))         // і після неї не їхав
        join = (prev.pt && x.pt) ? haversine(prev.pt, x.pt) < 300 : gap <= 2 * SEG_GAP;
    }
    if (join) {
      prev.dur = (x.ts + x.dur) - prev.ts;
      if (x.km != null) prev.km = Math.round(((prev.km || 0) + x.km) * 10) / 10;
      if (x.maxSpd) prev.maxSpd = Math.max(prev.maxSpd || 0, x.maxSpd);
    } else out.push(Object.assign({}, x));
  }
  return out;
}
function mergeReports(parts, incomplete, spans, id){
  const ok = parts.filter(Boolean);
  if (!ok.length) throw new Error('дані за період не завантажились');
  const sum = f => { let s = null; for (const p of ok) if (p[f] != null) s = (s == null ? 0 : s) + p[f]; return s; };
  const cat = f => { const a = []; for (const p of ok) if (p[f]) a.push(...p[f]); return a; };
  const byTs = (a,b) => a.ts - b.ts;
  // межі діб, по обидва боки яких доби ЗАВАНТАЖЕНІ — через невантажену добу стоянки не зшиваємо
  const bounds = [];
  let missDays = 0;
  if (spans) for (let k = 0; k < spans.length; k++) {
    if (!parts[k] || parts[k].truncated) missDays++;      // parts може мати «дірки» — рахуємо по spans, не filter
    if (k > 0 && parts[k-1] && parts[k]) bounds.push(spans[k][0]);
  }
  const segs = cat('segments').sort(byTs);
  // джерело пробігу: те, яким намічено БІЛЬШЕ кілометрів за період (від нього залежить прапорець «⚠ РЕБ»)
  let canKm = 0, gnssKm = 0;
  for (const p of ok) if (p.odoKm) { if (p.odoSrc === 'can') canKm += p.odoKm; else if (p.odoSrc === 'gnss') gnssKm += p.odoKm; }
  const speedings = cat('speedings').sort(byTs);
  const first = ok[0], last = ok[ok.length - 1];
  // СТИК ДІБ ПО ПАЛИВУ Й ЗАРЯДУ. Уночі CAN спить: зміна між останнім заміром доби N і першим доби N+1 не
  // потрапляла в жодну добу — нічний злив (найтиповіша крадіжка) тиждень не бачив зовсім, а «Місяць» одним
  // запитом писав ці літри водію у «Витрачено»; нічна зарядка електрички теж зникала (тиждень Z.E. 1,8 кВт·год
  // замість ~82). Правило ТЕ САМЕ, що всередині доби (parkedHole / заправка ≥FILL_L / сесія зарядки).
  // spentL НЕ чіпаємо: злите й залите на стику в баланс «Витрачено» не входить — він і далі = сума діб.
  // Денна вкладка нічну подію не бачить (їй потрібен був би +1 запит на добу — заміру до опівночі в ній нема).
  const nFills = [], nDrains = [], nCharges = [];
  const evMd = ((devCache || []).find(x => x.id === id) || {}).metadata || {};
  let pF = null, pS = null;
  for (const p of parts) {                        // саме parts по порядку діб, не ok
    if (!p) { pF = null; pS = null; continue; }   // через невантажену добу не стикуємо: її витрата стала б «зливом»
    const f0 = p.fuelFirst, s0 = p.socFirst;
    if (f0 && pF) {
      const g = f0.L - pF.L, hole = f0.ts - pF.ts;
      if (g >= FILL_L && !p.fuelSeeded) nFills.push({ ts: f0.ts, l: Math.round(g), pt: f0.pt || pF.pt });   // заправка із заглушеним двигуном через опівніч
      else if (-g >= parkDrainMin(hole) && parkedHole(hole, pF.od, f0.od)) nDrains.push({ ts: pF.ts, l: Math.round(-g), pt: pF.pt });
    }
    if (s0 && pS && s0.od != null && pS.od != null && s0.od - pS.od < 0.5) {   // стояв (одометр той самий)
      const dp = s0.soc - pS.soc, hrs = (s0.ts - pS.ts) / 3600;
      if (dp >= CHG_MIN_PCT && dp <= Math.min(100, hrs * 40 + 8)) {
        const kwh = evMd.batteryKwh ? Math.round(dp / 100 * evMd.batteryKwh * 1.12 * 10) / 10 : null;   // ×1.12 — як у periodReport
        nCharges.push({ ts: s0.ts, endTs: s0.ts, pct: Math.round(dp), kwh, uah: (kwh != null && evMd.elPrice) ? Math.round(kwh * evMd.elPrice) : null, pt: pS.pt || s0.pt });
      }
    }
    if (p.truncated) { pF = null; pS = null; continue; }   // кінець обрізаної доби — не справжній кінець
    if (p.fuelLast) pF = p.fuelLast;              // доба без замірів (вихідні) — несемо попередній рівень далі
    if (p.socLast) pS = p.socLast;
  }
  const addUp = (base, arr, f) => arr.length ? (base || 0) + arr.reduce((s,x) => s + (x[f] || 0), 0) : base;
  const evK = addUp(sum('evKwh'), nCharges.filter(c => c.kwh != null), 'kwh');
  return {
    odoKm: sum('odoKm'),
    odoSrc: (canKm > 0 && canKm >= gnssKm) ? 'can' : (gnssKm > 0 ? 'gnss' : null),
    gpsKm: sum('gpsKm'), filledL: addUp(sum('filledL'), nFills, 'l'), spentL: sum('spentL'), drainedL: addUp(sum('drainedL'), nDrains, 'l'),
    spentRaw: sum('spentRaw'),
    driveSec: sum('driveSec') || 0, standSec: sum('standSec') || 0,
    segments: joinAtBoundary(segs),
    maxSpd: ok.reduce((m,p) => Math.max(m, p.maxSpd || 0), 0),
    truncated: !!incomplete || ok.some(p => p.truncated),
    partial: ok.some(p => p.partial),                     // у якоїсь доби впав допоміжний запит — тиждень кешуємо коротко
    missDays, allDays: spans ? spans.length : 0,          // для банера «не завантажилось діб: N з M»
    charges: cat('charges').concat(nCharges).sort(byTs),
    evKwh: evK == null ? null : Math.round(evK * 10) / 10, evCost: addUp(sum('evCost'), nCharges.filter(c => c.uah != null), 'uah'), jamSec: sum('jamSec') || 0,
    anchor: first.anchor, anchorEnd: last.anchorEnd, spdLimit: first.spdLimit,
    spdCount: speedings.length,
    spdSec: speedings.reduce((a,e) => a + (e.endTs - e.ts), 0),
    speedings: speedings.slice(0, 100),
    fills: cat('fills').concat(nFills).sort(byTs), drains: cat('drains').concat(nDrains).sort(byTs),
    // добові треки вже проріджені; після склеювання згладжуємо ще раз, інакше місяць — це десятки тисяч
    // точок в одній полілінії (телефон помітно задумується при кожному зумі карти)
    track: simplifyTrack(cat('track'), TRACK_SIMPLIFY_M),
    stops: joinAtBoundary(cat('stops').sort(byTs), bounds, segs)
  };
}
const RANGE_MAX_DAYS = 8;   // тиждень складаємо з діб; місяць — ні: ~6 запитів × 31 доба = вірний ліміт flespi
async function periodReportRange(id, from, to, isStale){
  const spans = daySpans(from, to);
  if (spans.length <= 1 || spans.length > RANGE_MAX_DAYS) return periodReport(id, from, to, isStale);
  const hit = repGet(id, from, to);
  if (hit) return hit;
  const parts = new Array(spans.length);
  let next = 0, POOL = Math.min(3, spans.length);   // 3 паралельні доби: швидше за чергу і не б'є в ліміт flespi
  await Promise.all(Array.from({ length: POOL }, async () => {
    for (;;) {
      const k = next++;
      if (k >= spans.length) return;
      if (isStale && isStale()) return;             // користувач перемкнув вкладку — решту діб не тягнемо
      try { parts[k] = await periodReport(id, spans[k][0], spans[k][1], isStale); } catch(e) { parts[k] = null; }
    }
  }));
  const merged = mergeReports(parts, parts.some(p => !p) || (isStale && isStale()), spans, id);
  repPut(id, from, to, merged);
  return merged;
}

// ===== Деталі машини =====
let curDetail = null, dMap = null, dLayers = {};

function openDetail(d) {
  d = (devCache || []).find(x => x.id === d.id) || d;   // картка могла тримати об'єкт кількох циклів тому (fingerprint-скіп)
  curDetail = d;
  document.getElementById('dName').textContent = d.name;
  document.getElementById('detail').classList.add('show');
  const tel = d.telemetry || {};

  // ===== Двигун / OBD (з CAN авто) =====
  const et = engineTemp(tel), dtc = dtcCount(tel), sk = serviceKm(tel), ab = adblueLevel(tel);
  const obdRows = [];
  if (et != null) obdRows.push(`<div class="row"><span class="k">🌡️ Температура двигуна</span><span class="val" style="${et>=110?'color:#e74c3c':''}">${Math.round(et)} °C${et>=110?' ⚠ перегрів':''}</span></div>`);
  if (dtc != null) obdRows.push(`<div class="row"><span class="k">🛑 Помилки двигуна</span><span class="val" style="color:${dtc>0?'#e74c3c':'#2ecc71'}">${dtc>0?dtc+' — перевір!':'нема (0) ✅'}</span></div>`);
  if (sk != null) obdRows.push(`<div class="row"><span class="k">🔧 До ТО</span><span class="val">${Math.round(sk).toLocaleString('uk-UA')} км</span></div>`);
  if (ab != null) obdRows.push(`<div class="row"><span class="k">💧 AdBlue</span><span class="val">${Math.round(ab)} %</span></div>`);
  // ЖИВА перевірка помилок для БУДЬ-ЯКОГО авто: OBD-команда faultcodes через flespi (працює на всіх 5, перевірено).
  // Пасивний can.dtc.number шле лише Kangoo 8440 — а кнопка опитує сам блок авто напряму, будь-коли.
  // кешований результат авто-перевірки (2 рази/добу) — з часом, коли авто востаннє відповіло
  (() => { const fc = faultsCache(d.id); if (!fc || !fc.ts) return;
    const bad = faultsBad(fc.txt), clean = /no fault codes/i.test(fc.txt || '');
    const dt = new Date(fc.ts);
    const when = dt.getDate() + '.' + String(dt.getMonth()+1).padStart(2,'0') + ' ' + dt.toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'});
    const body = bad ? `<span style="color:#e74c3c">🛑 ${esc(fc.txt)}</span>`
      : clean ? `<span style="color:#2ecc71">чисто ✅</span>`
      : `<span style="color:var(--dim)">${esc(fc.txt)}</span>`;
    obdRows.push(`<div class="row"><span class="k">🛠️ Авто-перевірка помилок</span><span class="val">${body} <span style="color:var(--dim);font-size:11px">· ${when}</span></span></div>`); })();
  obdRows.push(`<div class="row"><span class="k">🔍 Живе опитування помилок</span><span class="val"><button class="btn-sm btn" style="padding:7px 12px" data-act="faults" data-id="${Number(d.id)}">Перевірити</button></span></div>`);
  obdRows.push(`<div id="faults_${d.id}" class="muted" style="display:none"></div>`);
  const obdBlock = `<div class="section"><h3>Двигун / OBD</h3>${obdRows.join('')}</div>`;

  // карта — ЗВЕРХУ і «липка» (як у Wialon/MegaGPS): відкрив авто → одразу бачиш, де воно і маршрут;
  // стрічка й цифри прокручуються ПІД картою, карта лишається на екрані
  document.getElementById('dBody').innerHTML = `
    <div class="mapwrap"><div id="dMap" class="dmap"></div><button class="mapfull" id="mapFullBtn" data-act="mapfull" title="Карта на весь екран">⛶</button></div>
    <div class="tabs">${dayTabsHtml()}</div>
    <div id="periodOut"><div class="spinner">…</div></div>
    <div class="section" id="dNow"></div>
    ${obdBlock}`;
  renderNow(d);

  // деталеву мапу перестворюємо
  if (dMap) { dMap.remove(); dMap = null; } _segHl = null;
  loadPeriod(document.querySelector('#detail .tab.active'));
}

// «Зараз» у деталях — окремою функцією, бо loadDevices перемальовує його щоцикла (раніше — застиглий знімок
// моменту відкриття, а відкрите зі знімка localStorage показувало вчорашні цифри без жодного натяку).
// Лише цей блок: карту, вкладки, #periodOut і OBD з #faults_ (живе опитування чекає до 60 с) не чіпаємо.
function renderNow(d) {
  const box = document.getElementById('dNow');
  if (!box) return;
  const tel = d.telemetry || {};
  const liters = fuelLiters(d, tel);
  const odo = tv(tel,'can.vehicle.mileage');
  const range = vehicleRange(d, tel);   // ДВЗ: очищено від глюків; електро: заряд% × повний запас
  const tank = tankFor(d);
  const ev = evBatt(tel, d);
  const volt = vehVolt(tel), tb = trkBatt(tel), gsm = gsmInfo(tel), sats = satCount(tel);
  const lastTs = tv(tel,'server.timestamp') || tts(tel,'position') || tts(tel,'can.vehicle.mileage');   // як на картці
  const dOnline = statusOnline(tel), dActive = displayActive(d, tel, dOnline);

  // головна цифра: для електрички — заряд+SoH, для решти — паливо
  const firstBig = ev.soc != null
    ? `<div><div class="big" style="color:var(--green)">${Math.round(ev.soc)} %</div><div class="l" style="color:var(--dim);font-size:12px">заряд батареї${ev.soh!=null?` · SoH ${Math.round(ev.soh)}%`:''}</div></div>`
    : isEVdev(d)   // електричка без SoC (Leaf) — не «— в баку»
    ? `<div><div class="big" style="color:var(--green)">⚡ —</div><div class="l" style="color:var(--dim);font-size:12px">електро · авто не віддає % батареї</div></div>`
    : `<div><div class="big" style="color:var(--accent)">${liters!=null?liters+' л':'—'}</div><div class="l" style="color:var(--dim);font-size:12px">в баку${tank?` (бак ${esc(tank)} л)`:''}</div></div>`;

  const diagBlock = `
    <div style="margin-top:14px;border-top:1px solid rgba(255,255,255,.08);padding-top:10px">
      <div class="row"><span class="k">🔋 Бортовий акумулятор</span><span class="val">${volt!=null?volt.toFixed(1)+' В'+(voltHealth(volt)?' · '+voltHealth(volt):''):'—'}</span></div>
      <div class="row"><span class="k">🔋 Батарея трекера</span><span class="val">${tb!=null?Math.round(tb)+' %':'—'}</span></div>
      <div class="row"><span class="k">📶 GSM сигнал</span><span class="val">${gsm?gsm.pct+'% · '+gsm.label:'—'}</span></div>
      <div class="row"><span class="k">🛰️ Супутники (GPS)</span><span class="val">${sats!=null?esc(sats):'—'}</span></div>
      <div class="row"><span class="k">🅿️ Стоїть (простій)</span><span class="val" id="dst">…</span></div>
    </div>`;

  // «дані від …»: коли саме трекер це прислав; не на звʼязку — помаранчевим і «скільки тому»
  box.innerHTML = `
      <h3>Зараз${lastTs ? ` <span style="font-weight:400;text-transform:none;letter-spacing:0${dOnline ? '' : ';color:#e67e22'}">· дані від ${fmtWhen(lastTs)}${dOnline ? '' : ' (' + ago(lastTs) + ')'}</span>` : ''}</h3>
      <div style="display:flex; gap:24px; align-items:baseline">
        ${firstBig}
        ${range!=null?`<div><div class="big">${Math.round(range)}</div><div class="l" style="color:var(--dim);font-size:12px">запас ходу, км</div></div>`:''}
        <div><div class="big">${odo!=null?Math.round(odo).toLocaleString('uk-UA'):'—'}</div><div class="l" style="color:var(--dim);font-size:12px">одометр, км</div></div>
      </div>
      ${diagBlock}
      <button class="reboot" data-act="reboot" data-id="${Number(d.id)}">🔄 Перезавантажити трекер</button>`;

  // простій — ТАК САМО, як на картці (renderCards): з 4-хв липкістю displayActive і для офлайн-авто теж.
  // Раніше тут був голий isActive і «—» для офлайну, а трекер на довгій стоянці якраз засинає (офлайн):
  // картка писала «🅿️ 14 год 20 хв», деталі — «—». Запитів не додає: standingCache/_standingInflight спільні з карткою.
  const dstEl = document.getElementById('dst');
  if (dstEl) {
    if (dActive) dstEl.textContent = 'в роботі';
    else standingText(d).then(txt => { dstEl.textContent = txt; }).catch(() => { dstEl.textContent = '—'; });   // захоплений вузол: швидке A→B не запише простій A в деталі B
  }
}

// вкладки: останні 7 днів по ДАТАХ (як у Wialon/OVERSEER — «пт 3.07») + Тиждень + Місяць
let _tabsDay0 = 0;   // «сьогодні» на момент побудови вкладок — щоб помітити нову добу (syncDayTabs)
function dayTabsHtml(){
  _tabsDay0 = dayStartTs(0);
  let h = '';
  for (let i = 0; i < 7; i++) {
    const t0 = dayStartTs(i), dt = new Date(t0*1000);
    const label = i === 0 ? 'Сьогодні' : `${WEEKDAYS[dt.getDay()]} ${dt.getDate()}.${String(dt.getMonth()+1).padStart(2,'0')}`;
    // data-t0 — АБСОЛЮТНА дата минулого дня: за нею syncDayTabs знаходить ту саму добу, коли настала нова
    h += `<div class="tab${i===0?' active':''}" data-p="d${i}"${i ? ` data-t0="${t0}"` : ''} data-act="period">${label}</div>`;
  }
  h += `<div class="tab" data-p="week" data-act="period">Тиждень</div>`;
  h += `<div class="tab" data-p="month" data-act="period">Місяць</div>`;
  return h;
}
// Підписи вкладок будуються раз — при відкритті авто, а data-p="dN" periodRange рахує від «сьогодні» в момент тапу.
// Після опівночі (iOS тримав PWA у фоні до ранку) тап «пт 2.10» показував суботу 3.10, а 29.09 ставав недосяжним.
// На новій добі перебудовуємо вкладки і повертаємо відповідник тапнутої: минулий день — за датою (data-t0),
// «Сьогодні»/Тиждень/Місяць — за змістом (data-p); дата випала з 7 днів → «Сьогодні». periodRange і ключі
// repCache не змінюються (тиждень = сума діб працює як було).
function syncDayTabs(el){
  const box = document.querySelector('#detail .tabs');
  if (!box || _tabsDay0 === dayStartTs(0)) return el;
  const t0 = el && el.dataset.t0, p = el && el.dataset.p;
  box.innerHTML = dayTabsHtml();
  const tabs = [...box.querySelectorAll('.tab')];
  return tabs.find(t => t0 ? t.dataset.t0 === t0 : t.dataset.p === p) || tabs.find(t => t.dataset.p === 'd0');
}
// Нова доба при ВІДКРИТИХ деталях (повернулись із фону зранку / північ при ввімкненому екрані) — з refresh().
// Підписи — без жодного запиту; «Сьогодні» з учорашнім змістом перезавантажуємо (одна доба). Тиждень і Місяць
// самі не перетягуємо (місяць — важкий запит до flespi), їхні дати й так підписані в «Зведення · …».
function syncDetailDay(){
  if (!curDetail || !_tabsDay0 || _tabsDay0 === dayStartTs(0)) return;
  if (Date.now()/1000 - dayStartTs(0) < 60) return;   // перша хвилина доби: «Сьогодні» = [00:00, 00:00] — порожній інтервал
  const el = syncDayTabs(document.querySelector('#detail .tab.active'));
  if (!el) return;
  if (el.dataset.p === 'd0') { loadPeriod(el); return; }
  document.querySelectorAll('#detail .tab').forEach(t => t.classList.toggle('active', t === el));   // той самий день/період — зміст лишається вірним
}
function periodRange(p){
  const now = Math.floor(Date.now()/1000);
  // Правий край ЖИВОГО періоду округлюємо до хвилини. Інакше «Сьогодні»/«Тиждень»/«Місяць» щоразу
  // мали НОВИЙ ключ і не потрапляли в кеш узагалі — тиждень (4.2 МБ) качався заново на кожен тап.
  const nowQ = now - (now % 60);
  const dm = /^d(\d+)$/.exec(p);
  if (dm) { const i = +dm[1]; const t0 = dayStartTs(i); return [t0, i === 0 ? nowQ : dayStartTs(i-1)]; }
  if (p === 'week') return [dayStartTs(6), nowQ];   // рівно 7 вкладок днів; межа доби = стабільний ключ кешу
  const d = new Date(); d.setDate(1); d.setHours(0,0,0,0);
  return [Math.floor(d/1000), nowQ];
}
// ⛶ карта на весь екран і назад (як у Wialon): перемикаємо клас, Leaflet перераховує розмір
function toggleMapFull(){
  const w = document.querySelector('#detail .mapwrap');
  if (!w) return;
  const fs = w.classList.toggle('mapfs');
  const btn = document.getElementById('mapFullBtn');
  if (btn) { btn.textContent = fs ? '✕' : '⛶'; btn.title = fs ? 'Згорнути карту' : 'Карта на весь екран'; }
  setTimeout(()=>{ if (dMap) dMap.invalidateSize(); }, 60);
}
// прокрутити до карти: після v67 вона не липка, і без цього тап по стрічці «спрацьовує невидимо»
function scrollToMap(){
  const b = document.querySelector('#detail .body');
  if (b) b.scrollTo({ top: 0, behavior: 'smooth' });
}
// тап по події стрічки → показати місце на карті
function focusEvt(lat, lon, label){
  if (!dMap || lat == null) return;
  if (_segHl) { dMap.removeLayer(_segHl); _segHl = null; }
  dMap.setView([lat, lon], 16);
  L.popup({ closeButton:true }).setLatLng([lat, lon]).setContent(label).openOn(dMap);
  scrollToMap();
  setTimeout(()=>{ if (dMap) dMap.invalidateSize(); }, 350);
}
// тап по відрізку «Їхав» → підсвітити САМЕ ЦЕЙ шматок маршруту (фішка з MegaGPS, яку вибрав Іван)
let _dRep = null, _segHl = null, _spdLayers = [];
// тап по перевищенню в стрічці → показати саме цей відрізок на карті
function focusSpeed(i){
  if (!dMap || !_dRep || !_dRep.speedings || !_dRep.speedings[i]) return;
  const e = _dRep.speedings[i];
  if (_segHl) { dMap.removeLayer(_segHl); _segHl = null; }
  scrollToMap();
  const ln = _spdLayers[i];
  setTimeout(()=>{
    if (!dMap) return;
    dMap.invalidateSize();
    if (ln) { dMap.fitBounds(ln.getBounds(), { padding:[60,60], maxZoom:15 }); ln.openPopup(); }
    else if (e.pts && e.pts.length) dMap.setView(e.pts[0], 14);
  }, 350);
}
function focusSeg(si){
  if (!dMap || !_dRep || !_dRep.segments || !_dRep.segments[si]) return;
  const s = _dRep.segments[si];
  const t0 = s.ts - 60, t1 = s.ts + s.dur + 60;   // ±хвилина запасу: трек проріджений, краї можуть не збігатись
  const pts = (_dRep.track || []).filter(p => p[2] != null && p[2] >= t0 && p[2] <= t1);
  if (pts.length < 2) return;                      // під РЕБ шматка треку може не бути — тоді нічого не міняємо
  if (_segHl) { dMap.removeLayer(_segHl); _segHl = null; }
  _segHl = L.polyline(pts.map(p=>[p[0],p[1]]), { color:'#f39c12', weight:6, opacity:.95 }).addTo(dMap._ov || dMap);
  _segHl.bindPopup(`${s.km != null ? s.km + ' км · ' : ''}${fmtDur(s.dur)}${s.maxSpd ? ' · до ' + s.maxSpd + ' км/г' : ''}`);
  scrollToMap();
  // maxZoom: маневр у дворі (2 точки за 10–20 м) інакше давав z20–21 — один дах або сірі плитки
  setTimeout(()=>{ if (dMap && _segHl) { dMap.invalidateSize(); dMap.fitBounds(_segHl.getBounds(), { padding:[30,30], maxZoom:17 }); } }, 350);   // _segHl міг зникнути (тап по зупинці за ці 350 мс)
}

let _loadSeq = 0;   // токен покоління: швидке перемикання вкладок не дає «повільному місяцю» перетерти свіжу вкладку
async function loadPeriod(el) {
  el = syncDayTabs(el);   // настала нова доба після відкриття панелі → вкладки перебудовано, el — відповідник тапнутої
  const seq = ++_loadSeq;
  document.querySelectorAll('#detail .tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  const p = el.dataset.p;
  const [from, to] = periodRange(p);
  const out = document.getElementById('periodOut');
  out.innerHTML = '<div class="spinner">рахую…</div>';
  _segHl = null;   // карту НЕ руйнуємо — вона живе між вкладками, drawTrack сам перемалює вміст
  if (dMap) dMap.closePopup();   // popup події старої вкладки не висить над «рахую…» (тиждень/місяць без кешу — секунди)

  let r;
  try { r = await periodReportRange(curDetail.id, from, to, () => seq !== _loadSeq); }
  catch(e){
    if (seq === _loadSeq && document.getElementById('periodOut')) {
      document.getElementById('periodOut').innerHTML = '<div class="muted">помилка: ' + esc(e.message) + '</div>';
      _spdLayers = [];   // скидаємо ДО можливого раннього виходу, інакше тап показував відрізок з ІНШОГО дня
  const oldMsg = document.getElementById('dMapMsg'); if (oldMsg) oldMsg.remove();   // не лишати підпис від старої вкладки
      drawTrack([], []);                                                                 // і не лишати мертвий сірий прямокутник замість карти
    }
    return;
  }
  // перемкнули вкладку АБО закрили панель (closeDetail занулює curDetail) — результат нікому не потрібен
  if (seq !== _loadSeq || !curDetail) return;

  const f = (v,u)=> v!=null ? v.toLocaleString('uk-UA')+' '+u : '—';
  const canOdo = (r.odoSrc === 'can');   // CAN-одометр авто — РЕБ-стійкий; GNSS-одометр трекера під глушінням стоїть
  const jammed = !r.truncated && canOdo && (r.odoKm != null && r.odoKm > 2 && r.gpsKm < r.odoKm*0.5);   // при обрізаних даних порівняння некоректне
  // показуємо, ЯКІ дати реально покриває звіт — інакше «Місяць» (з 1-го числа, на початку місяця
  // коротший за ковзний «Тиждень») збиває з пантелику: тиждень виходив «більший за місяць»
  const perEnd = Math.min(to, Math.floor(Date.now()/1000));
  const perEndLbl = (to < Math.floor(Date.now()/1000)) ? perEnd - 1 : perEnd;   // закритий період: підпис по ОСТАННІЙ добі, а не по опівночі наступної
  const dstr = ts => { const d = new Date(ts*1000); return d.getDate() + '.' + String(d.getMonth()+1).padStart(2,'0'); };
  // кілька діб (Тиждень, Місяць з 2-го числа) — за ДАТАМИ, а не (perEnd-from)>86400: доба переводу годинника має 25 год
  const multiDay = dstr(from) !== dstr(perEndLbl);
  const perDays = Math.max(1, Math.round((perEnd - from) / 86400 * 10) / 10);
  // ===== Зведення «плитками»: 6 головних цифр великими, дрібниці — списком нижче (вибір Івана, v63) =====
  const md = curDetail.metadata || {};
  const spdLim = md.speedLimit || 110;
  // середній розхід л/100км (дизель): витрачені літри ÷ пробіг; одометр надійніший за GPS під РЕБ
  let per100 = null, normL = null, hotFuel = false;
  if (!md.ev) {
    const jamHole = (r.jamSec || 0) > 300;   // >5 хв їзди без GPS-фіксу за період — GPS-пробіг неповний
    const kmC = (canOdo && r.odoKm != null && r.odoKm >= 10) ? r.odoKm : ((r.gpsKm != null && r.gpsKm >= 10 && !jammed && !r.truncated && !jamHole) ? r.gpsKm : null);
    // обрізані дані: літри — з огризка, а км (CAN) — часто за весь період → розхід занижений; не показуємо
    if (kmC != null && r.spentL && !r.truncated) {
      // ділимо НЕокруглені літри (spentRaw): ціле spentL на коротких днях давало похибку до ±30%
      per100 = Math.round((r.spentRaw != null ? r.spentRaw : r.spentL) / kmC * 1000) / 10;
      normL = md.kmPerLiter ? Math.round(1000 / md.kmPerLiter) / 10 : null;
      hotFuel = normL != null && per100 > normL * 1.2;   // >120% норми — червоним
    }
  }
  const fmtHM = s => { let h = Math.floor(s/3600), m = Math.round((s%3600)/60); if (m === 60) { h++; m = 0; } return h + ':' + String(m).padStart(2,'0'); };
  const tiles = [];
  const tile = (v, k, color) => tiles.push(`<div class="tile"><div class="tv"${color?` style="color:${color}"`:''}>${v}</div><div class="tk">${k}</div></div>`);
  if (r.odoKm != null) tile(`${r.odoKm.toLocaleString('uk-UA')} <small>км</small>`, 'Пробіг', 'var(--accent)');
  else if (r.gpsKm != null) tile(`${r.gpsKm.toLocaleString('uk-UA')} <small>км</small>`, 'Пробіг (GPS)', 'var(--accent)');
  if (per100 != null) tile(`${per100.toLocaleString('uk-UA')} <small>л/100</small>${hotFuel?' ⚠':''}`, normL != null ? `Розхід · норма ${normL.toLocaleString('uk-UA')}` : 'Розхід', hotFuel ? 'var(--red)' : null);
  if (!md.ev && r.spentL != null) tile(`${r.spentL.toLocaleString('uk-UA')} <small>л</small>`, 'Витрачено');
  if (r.driveSec) tile(fmtHM(r.driveSec), 'У русі', 'var(--green)');
  if (r.maxSpd) tile(`${r.maxSpd} <small>км/г</small>${r.maxSpd > spdLim ? ' ⚠' : ''}`, r.maxSpd > spdLim ? 'Макс · перевищення' : 'Макс. швидкість', r.maxSpd > spdLim ? 'var(--red)' : null);
  if (!md.ev && r.spentL != null && md.fuelPrice) tile(`${Math.round(r.spentL * md.fuelPrice).toLocaleString('uk-UA')} <small>₴</small>`, 'Пальне');
  if (r.evKwh != null) tile(`${r.evKwh.toLocaleString('uk-UA')} <small>кВт·год</small>`, 'Заряджено', 'var(--green)');
  if (r.evCost != null) tile(`${r.evCost.toLocaleString('uk-UA')} <small>₴</small>`, 'Зарядка');
  if (md.ev && md.kwhPerKm && md.elPrice && r.odoKm != null && r.odoKm >= 1) {
    const kwh = Math.round(r.odoKm * md.kwhPerKm * 10)/10, uah = Math.round(kwh * md.elPrice);
    tile(`${uah.toLocaleString('uk-UA')} <small>₴</small>`, `Е/е по пробігу · ${kwh.toLocaleString('uk-UA')} кВт·год`);
  }
  out.innerHTML = `
    <div class="section">
      <h3>Зведення · ${dstr(from)}–${dstr(perEndLbl)} (${perDays} дн)</h3>
      <div class="tiles">${tiles.join('')}</div>
      ${r.truncated ? `<div class="muted" style="text-align:left;color:var(--yellow);font-size:12px;padding:0 0 6px">⚠ Дані неповні${r.missDays ? ` за ${r.missDays} з ${r.allDays} дн.` : ''} (ліміт flespi або мережа): км, час у русі й пальне занижені, розхід не рахуємо. Тапни вкладку ще раз</div>`
        : (r.partial ? `<div class="muted" style="text-align:left;color:var(--yellow);font-size:12px;padding:0 0 6px">⚠ Частина допоміжних даних (одометр / місце стоянки) не завантажилась — пробіг може уточнитись. Тапни вкладку ще раз за хвилину</div>` : '')}
      ${jammed?`<div class="muted" style="text-align:left;color:var(--yellow);font-size:12px;padding:0 0 6px">⚠ GPS глушився (РЕБ) — орієнтуйся на одометр</div>`:''}
      ${(() => { const js = r.jamSec || 0; if (js <= 300 || jammed) return '';
        // пробіг рахував GNSS-одометр трекера — без фіксу він стоїть, і кілометри ЗНИКАЮТЬ. Лише тоді, а не «коли
        // нема CAN» загалом: при odoSrc=null (одометра в період нема зовсім) це твердження було б вигадкою
        const noCan = (r.odoSrc === 'gnss');
        return `<div class="muted" style="text-align:left;color:var(--yellow);font-size:12px;padding:0 0 6px">📡 Їхав без GPS-фіксу ${fmtDur(js)}${noCan ? ' — частина пробігу могла не порахуватись (CAN-одометр за період не відповідав), розхід не показуємо' : ''}</div>`; })()}
      ${(() => { const sp = r.speedings || []; if (!sp.length) return '';
        const tot = r.spdSec || sp.reduce((a,e)=>a+(e.endTs-e.ts),0), mx = Math.max(...sp.map(e=>e.maxSpd));
        return `<div class="row"><span class="k">🚀 Перевищень ліміту ${r.spdLimit || 110}</span><span class="val" style="color:var(--red)">${r.spdCount || sp.length} · разом ${fmtDur(tot)} · до ${mx} км/г</span></div>`; })()}
      ${!md.ev ? `<div class="row"><span class="k">⛽ Залито</span><span class="val" style="color:var(--green)">${r.filledL!=null?'+'+r.filledL+' л':'—'}</span></div>
      <div class="row"><span class="k">🔴 Злито</span><span class="val" style="color:${r.drainedL?'var(--red)':'inherit'}">${r.drainedL!=null?(r.drainedL?'−'+r.drainedL+' л':'0 л'):'—'}</span></div>` : ''}
      <div class="row"><span class="k">🅿️ Стояв</span><span class="val">${r.standSec ? fmtDur(r.standSec) : '—'}</span></div>
      <div class="row"><span class="k">🛰️ Пробіг по GPS (трек)</span><span class="val">${f(r.gpsKm,'км')}${jammed?' <span style="color:var(--yellow);font-size:11px">⚠ РЕБ</span>':''}</span></div>
      ${(md.ev && !md.batteryKwh && r.evKwh == null) ? `<div class="row"><span class="k">⚡ Заряджено</span><span class="val" style="color:var(--dim);font-size:12px">авто не віддає % батареї — оцінка по пробігу в плитках ↑</span></div>` : ''}
    </div>

    <div class="section">
      <h3>${multiDay ? 'Стрічка періоду' : 'Стрічка дня'} <span style="font-weight:400;text-transform:none;letter-spacing:0">· тап по «Їхав» — відрізок на карті</span></h3>
      <div id="tlOut"><div class="muted">…</div></div>
    </div>`;

  // мапа треку. У try — бо збій ТУТ мовчки лишав панель напівживою: зведення на екрані є,
  // а стрічка порожня і тапи не працюють (саме так виглядав баг, який я сам і зробив у v91).
  try {
  drawTrack(r.track, r.stops, r.anchor, r.speedings, r.anchorEnd, multiDay);

  // ===== СТРІЧКА ДНЯ: зупинки + відрізки руху + заправки/зливи, хронологічно, тап → місце на карті =====
  const items = [];
  _dRep = r;   // для focusSeg (тап по відрізку «Їхав»)
  r.stops.forEach((s,i)=> items.push({ ts:s.ts, type:'stop', n:i+1, dur:s.dur, pt:s.pt }));
  (r.segments||[]).forEach((s,si)=> items.push({ ts:s.ts, type:'drive', dur:s.dur, km:s.km, maxSpd:s.maxSpd, si }));
  r.fills.forEach(x=> items.push({ ts:x.ts, type:'fill', l:x.l, pt:x.pt, after:x.after }));
  r.drains.forEach(x=> items.push({ ts:x.ts, type:'drain', l:x.l, pt:x.pt }));
  (r.charges||[]).forEach(c=> { if (c.pct >= 2) items.push({ ts:c.ts, type:'charge', pct:c.pct, kwh:c.kwh, uah:c.uah, pt:c.pt }); });
  (r.speedings||[]).forEach((e,si)=> items.push({ ts:e.ts, type:'speed', dur:e.endTs-e.ts, maxSpd:e.maxSpd, pt:(e.pts&&e.pts[0])||null, si }));
  items.sort((a,b)=> a.ts - b.ts);

  const tl = document.getElementById('tlOut');
  if (!items.length) {
    tl.innerHTML = '<div class="muted">подій за період нема</div>';
  } else {
    // вертикальна шкала часу (стиль, який вибрав Іван зі скріншота): час зліва, кружечок-іконка, справа підпис
    const badge = { drive:['#2ecc71','↗'], stop:['#2e6bd8','P'], fill:['#f39c12','⛽'], drain:['#e74c3c','💧'], charge:['#27ae60','⚡'], speed:['#e74c3c','🚀'] };
    // Тиждень/Місяць: десятки рядків лише «ГГ:ХХ» — не видно ні межі діб, ні дня заправки → роздільник «пт 2.10».
    // Він лише в рядку виводу, НЕ в items: індекс k = id tla_${seq}_${k}, куди асинхронно лягають адреси
    let prevDay = '';
    tl.innerHTML = '<div class="tl">' + items.map((it,k)=>{
      const t = fmtTime(it.ts);
      const ds = dstr(it.ts);
      let sep = '';
      if (multiDay && ds !== prevDay) { prevDay = ds; sep = `<div class="muted" style="text-align:left;font-weight:700;padding:2px 0 8px">${WEEKDAYS[new Date(it.ts*1000).getDay()]} ${ds}</div>`; }
      const lbl = multiDay ? ds + ' ' + t : t;   // підпис popup на карті — теж із датою, коли діб кілька
      const b = badge[it.type] || ['#7d8b99','•'];
      // тап по події — через data-act (делегований обробник), а не inline onclick: див. CSP в index.html
      const tap = it.type === 'drive' ? ` data-act="seg" data-si="${Number(it.si)}" style="cursor:pointer"`
        : it.type === 'speed' ? ` data-act="speed" data-si="${Number(it.si)}" style="cursor:pointer"`
        : (it.pt ? ` data-act="evt" data-lat="${Number(it.pt[0])}" data-lon="${Number(it.pt[1])}" data-t="${esc(lbl)}" style="cursor:pointer"` : '');
      let t1 = '', t2 = it.pt ? '…' : '', pre = '';
      if (it.type === 'speed') { pre = `${fmtDur(it.dur)} понад ${r.spdLimit || 110} км/г`; t2 = pre + (it.pt ? ' · …' : ''); }
      if (it.type === 'stop')   t1 = `№${it.n} стояв ${fmtDur(it.dur)}`;
      if (it.type === 'drive') { t1 = `Їхав ${fmtDur(it.dur)}`; t2 = [it.km!=null?`${it.km} км`:null, it.maxSpd?`до ${it.maxSpd} км/г`:null].filter(Boolean).join(' · '); }
      if (it.type === 'fill')   t1 = `<span style="color:var(--green)">Заправка +${it.l} л</span>${it.after ? ' <span style="color:var(--dim);font-size:11px">· після стоянки</span>' : ''}`;
      if (it.type === 'drain')  t1 = `<span style="color:var(--red)">Злив? −${it.l} л</span>`;
      if (it.type === 'speed')  t1 = `<span style="color:var(--red)">🚀 Перевищення до ${it.maxSpd} км/г</span>`;
      if (it.type === 'charge') t1 = `<span style="color:var(--green)">Зарядка +${it.pct}%${it.kwh!=null?` · ≈${it.kwh} кВт·год${it.uah!=null?` · ${it.uah} грн`:''}`:''}</span>`;
      return sep + `<div class="tli"${tap}><div class="tlt">${t}</div><div class="tlb"><div class="ic" style="background:${b[0]}">${b[1]}</div></div><div class="tlx"><div class="t1">${t1}</div><div class="t2" id="tla_${seq}_${k}"${pre ? ` data-pre="${esc(pre)}"` : ''}>${t2}</div></div></div>`;
    }).join('') + '</div>';
    // адреси подій — асинхронно (кеш + серійна черга, Nominatim не перевантажуємо)
    items.forEach((it,k)=>{
      if (!it.pt) return;
      geocode(it.pt[0], it.pt[1]).then(addr=>{
        const el = document.getElementById('tla_'+seq+'_'+k);
        if (!el) return;
        const pre = el.getAttribute('data-pre');   // «3 хв понад 120 км/г» не затираємо адресою — дописуємо
        el.textContent = (pre ? pre + ' · ' : '') + (addr || (it.pt[0].toFixed(4)+', '+it.pt[1].toFixed(4)));
      }).catch(()=>{});
    });
  }
  } catch(e) {
    const tl = document.getElementById('tlOut');
    if (tl) tl.innerHTML = '<div class="muted">стрічку побудувати не вдалося: ' + esc(e.message) + '</div>';
  }
}

function drawTrack(track, stops, anchor, speedings, anchorEnd, multiDay) {
  const el = document.getElementById('dMap');
  if (!el) return;
  // КАРТУ НЕ ПЕРЕСТВОРЮЄМО на кожній вкладці: L.map() щоразу піднімав новий інстанс, новий шар тайлів
  // і новий контрол шарів — тобто повторне завантаження плиток і помітний ривок на телефоні.
  // Тримаємо ОДИН інстанс на весь час, поки відкрите авто, і чистимо лише накладені шари.
  if (dMap && dMap._container !== el) { try { dMap.remove(); } catch(e){} dMap = null; }
  if (!dMap) {
    dMap = L.map(el, { zoomControl:true, attributionControl:false });
    const bl = baseLayers();
    bl['Карта'].addTo(dMap);
    L.control.layers(bl, {}, { position:'topright' }).addTo(dMap);
    dMap._ov = L.layerGroup().addTo(dMap);   // сюди кладемо ВСЕ змінне: трек, зупинки, перевищення
  }
  const ov = dMap._ov;
  dMap.closePopup();   // popup тапу по події (focusEvt, openOn) живе на самій карті, не в ov — clearLayers його не прибирає,
                       // і «14:05» сьогоднішньої стоянки висів над треком іншого дня
  ov.clearLayers();
  _segHl = null;   // підсвітку відрізка теж змело clearLayers — не тримаємо мертве посилання

  _spdLayers = [];   // скидаємо ДО можливого раннього виходу, інакше тап показував відрізок з ІНШОГО дня
  const oldMsg = document.getElementById('dMapMsg');   // карта тепер поза periodOut і живе між вкладками — старе повідомлення прибираємо самі
  if (oldMsg) oldMsg.remove();
  if (!track.length) {
    dMap.setView([50.9,34.8], 9);
    el.insertAdjacentHTML('afterend','<div class="muted" id="dMapMsg" style="margin-top:8px">за період треку немає</div>');
    return;
  }
  L.polyline(track.map(p=>[p[0],p[1]]), { color:'#3aa0ff', weight:4, opacity:.85 }).addTo(ov);
  const fitPts = track.map(p=>[p[0],p[1]]);
  // ЯКІР: де авто стояло на початок періоду + пунктир до першого фікса (ділянка, яку GPS не бачив)
  if (anchor) {
    const a = [anchor[0], anchor[1]];
    L.polyline([a, [track[0][0], track[0][1]]], { color:'#f39c12', weight:3, opacity:.85, dashArray:'9,7' })
      .addTo(ov).bindPopup('GPS не писав цю ділянку (сон трекера / РЕБ) — показано напрямок від місця стоянки');
    L.circleMarker(a, { radius:7, color:'#f39c12', fillColor:'#f39c12', fillOpacity:1 })
      .addTo(ov).bindPopup('🅿️ Тут стояла на початок періоду');
    fitPts.push(a);
  }
  // ЯКІР КІНЦЯ: куди авто доїхало насправді (перший фікс після завершення періоду)
  if (anchorEnd) {
    const e = [anchorEnd[0], anchorEnd[1]];
    L.polyline([[track[track.length-1][0], track[track.length-1][1]], e], { color:'#f39c12', weight:3, opacity:.85, dashArray:'9,7' })
      .addTo(ov).bindPopup('GPS не писав цю ділянку — точка, де авто знайшлося після зупинки');
    L.circleMarker(e, { radius:7, color:'#f39c12', fillColor:'#f39c12', fillOpacity:1 })
      .addTo(ov).bindPopup('🏁 Тут авто знайшлося після завершення маршруту');
    fitPts.push(e);
  }
  // старт / фініш
  L.circleMarker(track[0], { radius:6, color:'#2ecc71', fillColor:'#2ecc71', fillOpacity:1 }).addTo(ov).bindPopup(anchor ? 'Перший GPS-фікс періоду' : 'Старт');
  L.circleMarker(track[track.length-1], { radius:6, color:'#e74c3c', fillColor:'#e74c3c', fillOpacity:1 }).addTo(ov).bindPopup('Кінець');
  // ⚠ ВІДРІЗКИ ПЕРЕВИЩЕННЯ — червоним поверх синього треку (видно, ДЕ саме водій топив)
  (speedings||[]).forEach((e,i)=>{
    if (!e.pts || e.pts.length < 2) return;
    const ln = L.polyline(e.pts.map(p=>[p[0],p[1]]), { color:'#e74c3c', weight:7, opacity:.95 }).addTo(ov);
    ln.bindPopup(`🚀 <b>до ${e.maxSpd} км/г</b><br>${multiDay ? fmtDateTime(e.ts) : fmtTime(e.ts)}–${fmtTime(e.endTs)} · ${fmtDur(e.endTs - e.ts)}`);   // Тиждень/Місяць — з датою
    _spdLayers[i] = ln;
    // ПІДПИСИ ШВИДКОСТІ прямо на лінії: завжди в точці максимуму, а на довгих відрізках — ще дві
    // проміжні, щоб було видно, з якою швидкістю авто йшло по всій ділянці (а не лише пік).
    const withSp = e.pts.filter(p => p[2] != null);
    if (withSp.length) {
      let mi = 0;
      for (let k = 1; k < withSp.length; k++) if (withSp[k][2] > withSp[mi][2]) mi = k;
      const idx = new Set([mi]);
      if (withSp.length >= 20) { idx.add(Math.floor(withSp.length * 0.25)); idx.add(Math.floor(withSp.length * 0.75)); }
      for (const k of idx) {
        const pt = withSp[k];
        if (!pt) continue;
        L.marker([pt[0], pt[1]], { icon: L.divIcon({ className:'', iconSize:[0,0],
          html:`<div class="spd-lbl${k===mi?' mx':''}">${pt[2]}</div>` }), interactive:false, zIndexOffset:900 }).addTo(ov);
      }
    }
  });
  // зупинки — пронумеровані
  stops.forEach((s,i)=>{
    if (!s.pt) return;
    const icon = L.divIcon({ className:'', html:`<div style="background:#f1c40f;color:#000;border:2px solid #fff;border-radius:50%;width:24px;height:24px;line-height:20px;text-align:center;font-weight:700;font-size:12px;box-shadow:0 1px 4px rgba(0,0,0,.5)">${i+1}</div>`, iconSize:[24,24], iconAnchor:[12,12] });
    L.marker(s.pt, { icon }).addTo(ov).bindPopup(`Зупинка №${i+1}<br>${fmtDur(s.dur)}<br>${fmtDateTime(s.ts)}`);
  });
  // maxZoom 16 (як focusEvt): авто стояло → трек з 1 точки, рамка 0 м, і без стелі Leaflet брав максимум шару — z21
  // (один дах / сірі плитки, старт і фініш одне на одному). Ручний зум до 21 лишається. dMap міг зникнути за ці 100 мс («‹»)
  setTimeout(()=>{ if (!dMap) return; dMap.invalidateSize(); dMap.fitBounds(L.latLngBounds(fitPts), { padding:[30,30], maxZoom:16 }); }, 100);
}

function closeDetail(){
  _loadSeq++;   // рве пагінацію покинутого звіту (periodReport перевіряє isStale) — інакше «Місяць» тягнув 10×40к у фоні
  document.getElementById('detail').classList.remove('show');
  curDetail = null;
  if (dMap) { dMap.remove(); dMap = null; } _segHl = null;
}

// ===== Оновлення =====
// Адаптивний інтервал: поки хоч одне авто під РЕБ-глушінням — оновлюємось частіше (FAST_REFRESH_MS),
// щоб миттєво зловити момент, коли глушіння скінчиться, а не чекати до 15 секунд.
let timer, _refreshing = false;
async function refresh() {
  // нова доба при відкритих деталях (повернулись із фону / північ при ввімкненому екрані) — ДО гейта _refreshing,
  // бо підписи вкладок не чекають мережі; у try — збій тут не має зупинити цикл оновлення (таймер нижче)
  try { syncDetailDay(); } catch(e){}
  if (_refreshing) return;   // не запускаємо другий запит поверх активного — прибирає сплеск при відкритті (кілька тригерів разом)
  _refreshing = true;
  try {
    await loadDevices();
    autoFaultsSweep(devCache).catch(()=>{});   // фонове авто-опитування помилок (сам гейтить частоту)
  } catch(e) {
    // М'ЯКО: якщо на екрані вже є дані — просто тиха «оновлюю…», без червоної помилки.
    // api() сам повторює мережеві збої з паузою, і наступний цикл майже завжди вдалий — користувачу не треба це бачити.
    // Виняток — відмова ключа (401/403): вона сама не мине, а автологауту для 403 нема — пишемо прямо в шапці.
    const upd = document.getElementById('updated');
    const authMsg = (e && /^flespi: /.test(e.message || '')) ? e.message : '';
    if (upd) upd.textContent = (authMsg || ((devCache && devCache.length) ? 'оновлюю…' : 'підключаюсь…')) + ' · ' + APP_VERSION;
  } finally {
    _refreshing = false;
  }
  // швидкий поллінг лише перші кілька хвилин без фіксу (зловити швидке відновлення). Регіональне глушіння в Сумах
  // триває годинами — тоді 3x частіші запити самі забивають ліміт flespi, тому далі повертаємось на норму.
  // І лише НА ХОДУ: на стоянці трекер шле пакет раз на 10–30 хв, а GNSS там часто «прокидається» без фіксу
  // (стан 0→2) — кожне таке пробудження давало 3 хв опитування кожні 5 с без жодного сенсу.
  const jamSoon = devCache.some(d => {
    const t = d.telemetry || {}, js = gnssJamState(t);
    return js > 0 && jamDuration(d.id, js) < FAST_WINDOW_MS && statusOnline(t) && tv(t,'movement.status') === true;
  });
  clearTimeout(timer);
  timer = setTimeout(refresh, jamSoon ? FAST_REFRESH_MS : REFRESH_MS);
}

// ===== Старт =====
function init() {
  if (!window._actHooked) { window._actHooked = true; document.addEventListener('click', onAct); }   // кнопки (data-act) — до екрана логіну
  if (!token()) {
    document.getElementById('login').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
    return;
  }
  document.getElementById('login').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  // перевірка свіжості коду — САМЕ ТУТ, а не у saveToken: інакше для вже залогіненого
  // телефона вона не запускалась ніколи, і він міг місяцями крутити старий код
  checkVersion(true);
  if (!window._verTimer) window._verTimer = setInterval(() => checkVersion(), 600000);
  // МИТТЄВО показуємо останній збережений стан (без спінера, без помилки), поки тягнемо свіжі дані
  try {
    const snap = JSON.parse(localStorage.getItem('devSnapshot') || 'null');
    if (snap && snap.devs && snap.devs.length) {
      devCache = snap.devs;
      _snapRender = true;   // знімок — минуле: детектори «без фіксу / наосліп / застигла точка» його лише читають
      try { renderCards(snap.devs, false); renderMap(snap.devs); } finally { _snapRender = false; }
      const upd = document.getElementById('updated');
      if (upd) upd.textContent = 'дані від ' + fmtWhen(snap.ts / 1000) + ' · оновлюю…';   // знімок не сьогоднішній — з датою
    }
  } catch(e){}
  setTimeout(() => { if (map) map.invalidateSize(); }, 200);
  clearTimeout(timer);
  refresh();
  // iOS-PWA: таймер оновлення «засинає» у фоні. Оновлюємо, коли застосунок знову на екрані/у фокусі.
  // КОАЛЕСУЄМО кілька тригерів відкриття (pageshow+focus+visibilitychange разом) в ОДНЕ оновлення (не сплеск).
  if (!window._visHooked) {
    window._visHooked = true;
    const softRefresh = () => { clearTimeout(window._softT); window._softT = setTimeout(refresh, 500); };
    // повернувся в застосунок після паузи >2 хв → карта знову центрується на всіх авто
    // (інакше вона лишалась там, де її востаннє посунули, і машин на екрані не було видно)
    let _hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { _hiddenAt = Date.now(); return; }
      if (_hiddenAt && Date.now() - _hiddenAt > 120000 && map) { map._fitted = false; _renderFp = ''; }   // і форсуємо рендер, інакше fingerprint-скіп відкладав рецентрування
      checkVersion();      // повернулись у застосунок — переконуємось, що код свіжий
      softRefresh();
    });
    window.addEventListener('focus', softRefresh);
    window.addEventListener('pageshow', softRefresh);
  }
}

// АВТО-ОНОВЛЕННЯ: завжди тягнемо свіжий sw.js (без кешу браузера), і коли нова версія
// бере контроль — застосунок сам перезавантажується зі свіжим кодом. Кінець «застряглому кешу».
// ===== ЖОРСТКА перевірка версії (v75) =====
// Симптом, який ловив Іван: телефон тримав СТАРИЙ код (напр. v72, де маркери під глушінням не рухались
// узагалі) — виглядало як «машини підвисли», хоча flespi і прод давно віддавали свіжі координати.
// Оновлення через service worker на iOS-PWA іноді не доїжджає (застосунок місяцями «живе» у фоні),
// тому додатково питаємо крихітний version.txt повз усі кеші й самі перезавантажуємось при розбіжності.
let _verChecking = false, _verLastCheck = 0, _verNote = '';
async function checkVersion(force){
  // страховка: «завислий» попередній запит (iOS заморозив таймер у фоні) блокує перевірку не довше 20 с
  if (_verChecking && Date.now() - _verLastCheck < 20000) return;
  if (!force && Date.now() - _verLastCheck < 300000) return;   // не частіше разу на 5 хв
  _verChecking = true; _verLastCheck = Date.now();
  // таймаут, як в api()/geocode: fetch, що завис при зміні мережі (Wi-Fi → LTE), тримав _verChecking=true
  // назавжди — і застосунок більше НІКОЛИ не перевіряв версію, доки iOS не вивантажить процес
  const ac = new AbortController(), tmr = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch('./version.txt?nc=' + Date.now(), { cache: 'no-store', signal: ac.signal });
    if (!r.ok) return;
    const live = (await r.text()).trim();   // таймер ще активний — покриває й читання тіла
    if (live === APP_VERSION) _verNote = '';
    if (live && /^v\d+$/.test(live) && live !== APP_VERSION) {
      // ЗАПОБІЖНИК ВІД ЦИКЛУ: GitHub Pages віддає app.js з max-age=600, і reload міг брати СТАРИЙ код із
      // HTTP-кешу знову й знову (стенд: 2175 перезавантажень за 17 с, кожне — запит до flespi), а якщо при
      // деплої забули підняти APP_VERSION чи version.txt — без кінця. Тепер не більше 2 спроб на версію
      // за 10 хв (= max-age), далі тихо працюємо на поточному коді й пробуємо знову пізніше.
      const gk = 'verReload:' + live; let st = { n: 0, t: 0 };
      try { st = JSON.parse(sessionStorage.getItem(gk) || 'null') || st; } catch(e){}
      if (Date.now() - st.t >= 600000) st.n = 0;
      if (st.n >= 2) { _verNote = ' (оновлення ' + live + ' ще не доїхало)'; return; }
      try { sessionStorage.setItem(gk, JSON.stringify({ n: st.n + 1, t: Date.now() })); } catch(e){}
      // спершу чистимо кеш SW, потім тягнемо код повз HTTP-кеш (cache:'reload' — ще й оновлює HTTP-кеш),
      // і лише тоді reload: так перезавантаження бере свіже, а не той самий старий app.js
      try { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); } catch(e){}
      try { await Promise.all(['./', './index.html', './app.js'].map(u => fetch(u, { cache: 'reload' }))); } catch(e){}
      location.reload();
    }
  } catch(e){ /* офлайн / таймаут — не заважаємо */ }
  finally { clearTimeout(tmr); _verChecking = false; }
}

// ===== Кнопки: ОДИН делегований обробник за data-act замість inline-обробників (атрибутів onclick) =====
// Inline-обробники вимагали 'unsafe-inline' у CSP — а з ним будь-який пропущений esc() в innerHTML
// (як position.satellites до v87) виконував чужий код і крав токен. Тепер CSP inline-скрипти забороняє.
// Вішається в init() (раз на сторінку) — і для екрана логіну теж.
function onAct(e){
  const el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
  if (!el) return;
  const a = el.dataset.act, id = Number(el.dataset.id);
  if (a === 'login') saveToken();
  else if (a === 'refresh') refresh();
  else if (a === 'logout') logout();
  else if (a === 'close') closeDetail();
  else if (a === 'mapfull') toggleMapFull();
  else if (a === 'faults') checkFaults(id);
  else if (a === 'reboot') rebootTracker(id);
  else if (a === 'period') loadPeriod(el);
  else if (a === 'seg') focusSeg(Number(el.dataset.si));
  else if (a === 'speed') focusSpeed(Number(el.dataset.si));
  else if (a === 'evt') focusEvt(Number(el.dataset.lat), Number(el.dataset.lon), el.dataset.t || '');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    reg.update();
    setInterval(() => reg.update(), 300000);   // перевірка оновлень раз на 5 хв
  }).catch(()=>{});
  // новий SW узяв контроль — НЕ перезавантажуємось наосліп, а звіряємо версію: на першому запуску (контролера
  // ще не було) сліпий reload стирав щойно вставлений токен із поля логіну, а після деплою давав ДРУГЕ
  // перезавантаження поверх того, що вже зробив checkVersion. Якщо код справді старий — checkVersion перезавантажить.
  navigator.serviceWorker.addEventListener('controllerchange', () => checkVersion(true));
}

init();
