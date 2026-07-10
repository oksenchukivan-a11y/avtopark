'use strict';

// ===== Налаштування =====
const FLESPI = 'https://flespi.io';
const APP_VERSION = 'v66';          // показуємо в шапці — щоб видно було, що отримав свіже
const REFRESH_MS = 15000;          // авто-оновлення кожні 15 с (норма)
const FAST_REFRESH_MS = 5000;       // прискорений поллінг у вікні щойно-виявленого глушіння
const FAST_WINDOW_MS = 3 * 60000;   // швидкий режим тримаємо лише перші 3 хв глушіння — довше не варте зайвих запитів (регіональне глушіння в Сумах триває годинами)
const SIM_SUSPECT_MS = 4 * 3600000; // авто мовчить 4+ год, коли інші на звʼязку → підозра на баланс SIM/покриття
const ONLINE_SEC = 600;            // онлайн, якщо дані свіжіші за 10 хв
const FILL_L = 5;                  // або стрибок > 5 л = заправка (для авто, що дають літри)
const DRAIN_L = 4;                 // падіння > 4 л при зупинці = злив
const STOP_SPEED = 3;              // км/год: нижче — машина стоїть
const STOP_MIN = 180;              // сек: зупинка від 3 хв
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
  localStorage.removeItem('flespi_token');
  location.reload();
}

// ===== API (з ретраями — flespi інколи віддає порожнє) =====
// 401/403 НЕ означає одразу мертвий токен: flespi зрідка відповідає так і на живий ключ
// (перехідні блокування/ліміти). Розлогінюємось лише після 3 таких відповідей ПОСПІЛЬ,
// без жодного успішного запиту між ними (v66: раніше викидало з першої — Іван ловив
// «Токен недійсний» на робочому токені).
let _authFails = 0;
async function api(path, method, body) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const opt = { method: method || 'GET', headers: { Authorization: 'FlespiToken ' + token() } };
      if (body != null) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
      const r = await fetch(FLESPI + path, opt);
      if (r.status === 401 || r.status === 403) {
        if (++_authFails >= 3) { alert('Токен недійсний — введи ключ заново'); logout(); throw new Error('AUTH'); }
        last = 'auth'; await new Promise(res=>setTimeout(res, 1200*(i+1))); continue;
      }
      const txt = await r.text();
      if (!txt) { last = 'empty'; await new Promise(res=>setTimeout(res, 800*(i+1))); continue; }
      const j = JSON.parse(txt);
      if (j.errors) {
        const reason = (j.errors[0] && j.errors[0].reason) || 'api';
        // ліміт REST-запитів/хв — миттєвий ретрай лише погіршує ситуацію, чекаємо з нарощуванням паузи
        if (/limit/i.test(reason)) { last = reason; await new Promise(res=>setTimeout(res, 1500*(i+1))); continue; }
        throw new Error(reason);
      }
      _authFails = 0;   // успішна відповідь = токен живий
      return j.result;
    } catch (e) {
      if (e.message === 'AUTH') throw e;
      last = e.message;
    }
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
function fmtTime(sec){ return new Date(sec*1000).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'}); }
function fmtDateTime(sec){ return new Date(sec*1000).toLocaleString('uk-UA',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function fmtDur(sec){
  sec = Math.round(sec);
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
  if (TANKS[id] && TANKS[id].tank) return TANKS[id].tank;
  return null;
}

// ===== Паливо у літрах =====
// памʼять останнього відомого палива (деякі авто, як Ducato, перестають слати рівень коли заглушені → 0/нема)
let lastFuel = {};
try { lastFuel = JSON.parse(localStorage.getItem('lastFuel') || '{}'); } catch(e) { lastFuel = {}; }
let lastFuelTs = {};   // коли «останнє паливо» востаннє освіжали з історії (throttle, щоб не спамити flespi)
// Паливо з ПОТОЧНОЇ телеметрії (без кешу). null = заглушене авто рівень не шле.
function fuelCurrent(dev, tel) {
  const md = (dev && typeof dev === 'object' && dev.metadata) || {};
  const pct = tv(tel, 'can.fuel.level');       // рівень палива, %
  const tank = tankFor(dev);
  // КАЛІБРУВАННЯ: якщо OEM-літри ненадійні (metadata.fuelByPct) — рахуємо % × реальний бак
  if (md.fuelByPct && pct != null && pct > 0 && tank) return Math.round(pct / 100 * tank);
  // ПРИМІТКА: раніше тут був пріоритет для 'fuel.liters' (серверний плагін flespi msg-expression) —
  // прибрано назавжди: на Kangoo 8440 висів застарілий плагін з часів тестування Audi (формула %×0.7,
  // під 70-літровий бак), і мовчки перебивав правильний клієнтський розрахунок місяцями (показував 25 л
  // замість реальних ~21 л). Калібрування тепер ЛИШЕ клієнтське (metadata.fuelFactor/fuelByPct/tank),
  // без залежності від серверних плагінів, які легко забути відв'язати при зміні авто на пристрої.
  const vol = tv(tel, 'can.fuel.volume');      // реальні літри напряму (Master/Kangoo при русі)
  if (vol != null && vol > 0) return Math.round(vol * (md.fuelFactor || 1));   // множник калібрування
  if (pct != null && pct > 0 && tank) return Math.round(pct / 100 * tank);
  return null;
}
// Для відображення: поточне значення, інакше останнє відоме (кеш освіжається з історії в renderCards).
function fuelLiters(dev, tel) {
  const id = dev && dev.id;
  const live = fuelCurrent(dev, tel);
  if (live != null && live > 0) {
    if (id) { lastFuel[id] = live; try { localStorage.setItem('lastFuel', JSON.stringify(lastFuel)); } catch(e){} }
    return live;
  }
  if (id && lastFuel[id] != null) return lastFuel[id];   // заглушене — останнє відоме
  return null;
}
// останнє осмислене паливо з ІСТОРІЇ (коли авто заглушене й шле 0/нема — як Ducato).
// Шукаємо останнє >0 серед can.fuel.volume (літри) АБО can.fuel.level (% × бак), пропускаючи нулі-глюки.
async function lastValidFuel(dev){
  const md = dev.metadata || {};
  const tank = md.tank || (TANKS[dev.id] && TANKS[dev.id].tank) || null;
  const now = Math.floor(Date.now()/1000);
  for (const field of ['can.fuel.volume','can.fuel.level']) {
    const data = encodeURIComponent(JSON.stringify({ from: now-30*86400, to: now, count:50, reverse:true, filter:field, fields:'timestamp,'+field }));
    try {
      const res = await api(`/gw/devices/${dev.id}/messages?data=${data}`);
      if (res) for (const m of res) {
        const v = m[field];
        if (v != null && v > 0) {
          const l = (field === 'can.fuel.level') ? (tank ? Math.round(v/100*tank) : null) : Math.round(v * (md.fuelFactor || 1));
          if (l != null) { lastFuel[dev.id] = l; lastFuelTs[dev.id] = Date.now(); try { localStorage.setItem('lastFuel', JSON.stringify(lastFuel)); } catch(e){} return l; }
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
  const el = document.getElementById('faults_' + devId);
  if (!el) return;
  if (_faultsInflight[devId]) return;   // вже питаємо — другий тап не шле другу команду
  _faultsInflight[devId] = true;
  el.style.display = 'block';
  el.textContent = '⏳ Питаю авто (до 60 сек — трекер має бути на звʼязку)…';
  try {
    const posted = await api(`/gw/devices/${devId}/commands-queue`, 'POST', [{ name:'custom', properties:{ text:'faultcodes' } }]);
    const cmdId = posted && posted[0] && posted[0].id;
    if (!cmdId) throw new Error('не вдалось надіслати');
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      let res;
      try { res = await api(`/gw/devices/${devId}/commands-result/${cmdId}`); } catch(e) { continue; }
      const c = res && res[0];
      if (c && c.executed) {
        const txt = c.response || '';
        if (txt) localStorage.setItem('faults:' + devId, JSON.stringify({ ts: Date.now(), txt: String(txt).slice(0, 500) }));   // ручна перевірка теж оновлює кеш авто-перевірки
        if (/no fault codes/i.test(txt)) {
          el.innerHTML = '<span style="color:#2ecc71">✅ Помилок не виявлено (блок авто відповів напряму)</span>';
        } else {
          // показуємо сирі коди — їх можна прогуглити (P/C/B/U-код) або показати мені
          el.innerHTML = '<span style="color:#e74c3c">🛑 Авто повідомило: ' + txt.replace(/</g,'&lt;') + '</span>';
        }
        return;
      }
    }
    el.textContent = '⌛ Авто не відповіло за 60 сек — найчастіше заглушене запалювання. Спробуй, коли машина заведена.';
  } catch(e) {
    el.textContent = '⚠️ Не вийшло: ' + e.message + ' — спробуй ще раз.';
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
let _autoFaultsAt = 0;
const _autoPolling = {};
async function autoFaultsSweep(devs){
  if (Date.now() - _autoFaultsAt < 3600 * 1000) return;   // легкий на запити: цикл не частіше 1 разу/год
  _autoFaultsAt = Date.now();
  for (const d of devs) {
    const c = faultsCache(d.id);
    if (c && c.ts && Date.now() - c.ts < FAULTS_STALE_MS) continue;                       // свіже — пропускаємо
    if (c && c.pendingCmd && Date.now() - (c.postedAt || 0) < 6 * 3600 * 1000) {          // команда ще в черзі — дочекаємось її
      pollAutoFaults(d.id, c.pendingCmd); continue;
    }
    try {
      const posted = await api(`/gw/devices/${d.id}/commands-queue`, 'POST',
        [{ name:'custom', properties:{ text:'faultcodes' }, max_attempts: 20, ttl: 21600 }]);
      const cmdId = posted && posted[0] && posted[0].id;
      if (cmdId) {
        localStorage.setItem('faults:' + d.id, JSON.stringify({ ts: (c && c.ts) || 0, txt: (c && c.txt) || '', pendingCmd: cmdId, postedAt: Date.now() }));
        pollAutoFaults(d.id, cmdId);
      }
    } catch(e){ /* тихо: наступний цикл повторить */ }
  }
}
async function pollAutoFaults(devId, cmdId){
  if (_autoPolling[devId]) return;
  _autoPolling[devId] = true;
  try {
    for (let i = 0; i < 16; i++) {                    // ~12 хв по 45 с — не тисне на ліміт flespi
      let res;
      try { res = await api(`/gw/devices/${devId}/commands-result/${cmdId}`); } catch(e){ return; }
      const c = res && res[0];
      if (c && c.executed && c.response) {
        localStorage.setItem('faults:' + devId, JSON.stringify({ ts: Date.now(), txt: String(c.response).slice(0, 500) }));
        return;
      }
      if (c && c.executed === false) return;          // команда протухла невиконаною — новий цикл поставить свіжу
      await new Promise(r => setTimeout(r, 45000));
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
// РЕБ-глушіння GPS (Teltonika AVL ID 318 «GNSS Jamming»): 0=нема, 1=попередження (сигнал ослаблений, фікс ще тримається), 2=критично (фікс неможливий).
// Це офіційний індикатор глушіння з трекера — набагато точніший за здогад «просто нема фіксу довго» (могло виглядати як несправна антена).
function gnssJamState(tel){
  const s = tv(tel,'gnss.state.enum');
  if (s !== 1 && s !== 2) return 0;
  // Глушіння показуємо ЛИШЕ коли воно реально відбирає позицію (нема валідного фікса).
  // Рівень 1 = «сигнал ослаблений, але фікс тримається» — якщо фікс валідний, GPS фактично працює,
  // і жовта тривога «під РЕБ» лише лякає даремно (авто на карті живе й точне). Те саме після кінця
  // глушіння: прапорець може ще висіти в телеметрії, а фікс уже валідний.
  if (tv(tel,'position.valid') === true) return 0;
  return s;
}
// відколи авто під глушінням (щоб показувати «глушиться вже Х хв», а не просто статичний прапорець)
let jamStartTs = {};
try { jamStartTs = JSON.parse(localStorage.getItem('jamStartTs') || '{}'); } catch(e) { jamStartTs = {}; }
function jamDuration(devId, jamState){
  if (jamState > 0) {
    if (!jamStartTs[devId]) { jamStartTs[devId] = Date.now(); try { localStorage.setItem('jamStartTs', JSON.stringify(jamStartTs)); } catch(e){} }
    return Date.now() - jamStartTs[devId];
  }
  if (jamStartTs[devId]) { delete jamStartTs[devId]; try { localStorage.setItem('jamStartTs', JSON.stringify(jamStartTs)); } catch(e){} }
  return 0;
}
// ===== АВТОЛІКУВАННЯ зависання GPS-модуля =====
// Доведено перехресною перевіркою з MegaGPS (05.07.2026): після ДОВГОГО глушіння GPS-модуль FMB003
// зависає і НЕ відновлюється сам, навіть коли РЕБ вимкнувся (MegaGPS на тих самих авто вже чистий,
// а FMB003 далі рапортує jam=2). Ліки — cpureset. Робимо це автоматично: якщо критичне глушіння
// тримається > 6 год — ставимо перезавантаження в чергу (виконається при наступному виході на звʼязок).
// Кулдаун 12 год: якщо РЕБ реально ще давить, дарма не смикаємо (ребут під час справжнього глушіння нешкідливий, але й безглуздий).
const AUTO_REBOOT_AFTER_MS = 6 * 3600000, AUTO_REBOOT_COOLDOWN_MS = 12 * 3600000;
let autoRebootAt = {};
try { autoRebootAt = JSON.parse(localStorage.getItem('autoRebootAt') || '{}'); } catch(e) { autoRebootAt = {}; }
function maybeAutoReboot(d, tel){
  if (gnssJamState(tel) !== 2) return;
  if (jamDuration(d.id, 2) < AUTO_REBOOT_AFTER_MS) return;
  if (Date.now() - (autoRebootAt[d.id] || 0) < AUTO_REBOOT_COOLDOWN_MS) return;
  autoRebootAt[d.id] = Date.now();   // ставимо одразу (проти гонки паралельних refresh)...
  api(`/gw/devices/${d.id}/commands-queue`, 'POST', [{ name:'custom', properties:{ text:'cpureset' } }])
    .then(()=>{ try { localStorage.setItem('autoRebootAt', JSON.stringify(autoRebootAt)); } catch(e){} })
    .catch(()=>{ delete autoRebootAt[d.id]; });   // ...але фейл POST знімає кулдаун — спробуємо наступного циклу
}
// запас з адаптацією під ЗАРЯД для електричок (датчик авто застрягає на постійному значенні — як Kangoo Z.E. = 185 при будь-якому %)
function vehicleRange(dev, tel){
  const md = (dev && typeof dev === 'object' && dev.metadata) || {};
  const soc = tv(tel,'can.vehicle.battery.level');
  if (soc != null && md.evRangeFull) return Math.round(soc / 100 * md.evRangeFull);   // електро: заряд% × повний запас
  const r = rangeKm(tel);
  if (r != null) return r;                                                            // CAN-запас авто (де віддає, без глюків)
  const liters = fuelLiters(dev, tel);                                               // ДВЗ без CAN-запасу: оцінка літри × км/л
  if (liters != null) return Math.round(liters * (md.kmPerLiter || 10));
  return null;
}
// EV-батарея (тягова) — для електричок
function evBatt(tel){
  return {
    soc: tv(tel,'can.vehicle.battery.level'),       // заряд, %
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
    await api('/gw/devices/' + id + '/commands-queue', 'POST', [{ name:'custom', properties:{ text:'cpureset' } }]);
    alert('✅ Команду надіслано.\nТрекер перезавантажиться, щойно її отримає.');
  } catch (e) { alert('Помилка: ' + e.message); }
}

// ===== Іконка машини на карті (з метаданих) =====
// active = двигун у роботі → зелений світний обідок (колір машини для впізнавання лишається)
function vehIcon(dev, online, active, gpsLost) {
  const m = dev.metadata || {};
  const color = m.color || '#3aa0ff';
  const icon = m.icon || '🚗';
  const dim = online ? 1 : 0.55;
  // кантик навколо машинки: БІЛИЙ коли стоїть, ЗЕЛЕНИЙ коли в роботі, ЖОВТИЙ пунктир — GPS втрачено надовго (точка застаріла)
  const border = gpsLost ? '3px dashed #f39c12' : (active ? '3px solid #2ecc71' : '2px solid #fff');
  const glow = gpsLost ? ',0 0 8px 2px rgba(243,156,18,.85)' : (active ? ',0 0 8px 2px rgba(46,204,113,.85)' : '');
  const badge = gpsLost ? '<div style="position:absolute;top:-4px;right:-4px;font-size:12px">⚠️</div>' : '';
  const html = '<div style="position:relative;opacity:'+dim+'"><div style="background:'+color+';border:'+border+';border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 2px 6px rgba(0,0,0,.5)'+glow+'">'+icon+'</div>'+badge+'</div>';
  return L.divIcon({ className:'', html, iconSize:[32,32], iconAnchor:[16,16] });
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

let _renderFp = '', _renderSkips = 0;
async function loadDevices() {
  const devs = await api('/gw/devices/all?fields=id,name,telemetry,metadata');
  devCache = devs;
  // знімок останнього успішного стану — щоб при наступному відкритті одразу бачити авто (без спінера й без помилки)
  try { localStorage.setItem('devSnapshot', JSON.stringify({ ts: Date.now(), devs })); } catch(e){}
  // НЕ перемальовуємо, якщо нічого суттєвого не змінилось (стоянка вночі): менше миготіння/зайвого DOM,
  // менше жере батарею iPhone. server.timestamp огрублюємо до хвилини, напругу — до 0.1В.
  // Кожен 5-й пропуск малюємо примусово (щоб «липке» зелене встигало згасати за таймером).
  const fp = devs.map(d => {
    const t = d.telemetry || {};
    return [d.id, Math.floor((tv(t,'server.timestamp')||0)/60), tv(t,'position.speed'), tv(t,'position.valid'),
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
  document.getElementById('updated').textContent = 'оновлено ' + new Date().toLocaleTimeString('uk-UA') + ' · ' + APP_VERSION;
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
  const spd = tv(tel,'position.speed'), valid = tv(tel,'position.valid'), sats = tv(tel,'position.satellites');
  // підтверджений рух: швидкість + фікс не «невалідний» + ЯВНО достатньо супутників (не РЕБ-телепорт).
  // sats обовʼязково число ≥4 — GPS-елемент AVL завжди його шле, тому null тут теж підозріло (не довіряємо).
  if (spd != null && spd >= 3 && spd < 150 && valid !== false && sats != null && sats >= 4) return true;
  return false;
}
// ЛИПКІСТЬ: раз авто було активне — лишається «в роботі» ще 4 хв (зглажує світлофори, короткі
// зупинки й паузи між пакетами даних). Стан у localStorage — переживає авто-перезавантаження.
const ACTIVE_STICK_MS = 240000;
let activeSeen = {};
try { activeSeen = JSON.parse(localStorage.getItem('activeSeen') || '{}'); } catch(e) { activeSeen = {}; }
function displayActive(dev, tel, online) {
  if (isActive(dev, tel, online)) {
    activeSeen[dev.id] = Date.now();
    try { localStorage.setItem('activeSeen', JSON.stringify(activeSeen)); } catch(e){}
    return true;
  }
  return !!(activeSeen[dev.id] && (Date.now() - activeSeen[dev.id] < ACTIVE_STICK_MS));
}

function renderCards(devs) {
  const list = document.getElementById('list');
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

    const ev = evBatt(tel);
    // ЗАВЖДИ через fuelLiters() (кеш+історія) — сирий can.fuel.level в обхід кешу міг «залипати» на застарілому значенні
    const fuelTxt = ev.soc != null ? Math.round(ev.soc) + ' %' : (liters != null ? liters + ' л' : '—');
    const fuelLabel = ev.soc != null ? 'заряд батареї' : 'паливо';
    const odoTxt = odo != null ? Math.round(odo).toLocaleString('uk-UA') + ' км' : '—';
    const active = displayActive(d, tel, online);
    if (active && standingCache[d.id]) { delete standingCache[d.id]; try { localStorage.setItem('standingCache', JSON.stringify(standingCache)); } catch(e){} }   // скидаємо кеш простою (і в localStorage!)
    if (active) { nActive++; }
    else nStopped++;                                         // усе інше (зокрема офлайн) — «стоять»
    const spdTxt = (spd != null && spd >= 3) ? Math.round(spd) + ' км/г'
                 : (active ? 'працює' : (online ? 'стоїть' : '—'));

    // діагностика: акумулятор · звʼязок · супутники · простій
    const volt = vehVolt(tel), gsm = gsmInfo(tel), sats = satCount(tel);
    const diag = [];
    if (volt != null) diag.push(`🔋 ${volt.toFixed(1)} В`);
    else { const tb = trkBatt(tel); if (tb != null) diag.push(`🔋 ${Math.round(tb)}% (трекер)`); }
    if (gsm) diag.push(`📶 ${gsm.label}`);
    if (sats != null) diag.push(`🛰️ ${sats}`);
    if (!active) diag.push(`🅿️ <span id="st_${d.id}">…</span>`);   // скільки стоїть (простій) — і для офлайн
    // розрахунковий баланс SIM: постійно у діагностиці, а коли не вистачає на наступне списання — червона тривога
    const se = simEstimate(d.metadata);
    if (se) diag.push(se.low
      ? `<span style="color:var(--red);font-weight:700">💳 SIM ≈${se.est} грн — поповни до 1-го числа!</span>`
      : `💳 SIM ≈${se.est} грн`);
    const diagHtml = diag.length
      ? `<div style="display:flex;gap:14px;margin-top:8px;font-size:11px;color:var(--dim);flex-wrap:wrap">${diag.map(x=>`<span>${x}</span>`).join('')}</div>`
      : '';
    // де стоїть (адреса) — лише для незадіяних на звʼязку
    const posValid = tv(tel,'position.valid') !== false;     // валідний GPS-фікс (не дефолтна точка Перу)
    const showLoc = !active && lat != null && lon != null && posValid && saneRegion(lat, lon);   // геощит і тут (Ліма буває з valid=true)
    // GPS втрачено надовго — розрізняємо ПРИЧИНУ: офіційний індикатор глушіння (РЕБ) з трекера, або справді апаратна проблема
    const gpsLostMsC = lastValidPosTs[d.id] ? (Date.now() - lastValidPosTs[d.id]) : null;
    const gpsLostLong = !posValid && gpsLostMsC != null && gpsLostMsC > GPS_LOST_MS;
    const jam = gnssJamState(tel);
    const jamMs = jamDuration(d.id, jam);
    maybeAutoReboot(d, tel);   // GPS-модуль завис після довгого глушіння → авто-cpureset (див. комент функції)
    const locHtml = showLoc
      ? `<div style="margin-top:5px;font-size:11.5px;color:var(--dim)">📍 <span id="loc_${d.id}">…</span></div>`
      : (jam === 2 ? `<div style="margin-top:5px;font-size:11.5px;color:#e74c3c;font-weight:600">🚫 GPS глушать (РЕБ) вже ${fmtDur(jamMs/1000)} — сигнал відсутній</div>`
      : (jam === 1 ? `<div style="margin-top:5px;font-size:11.5px;color:#f39c12;font-weight:600">⚠️ GPS ослаблений вже ${fmtDur(jamMs/1000)} (можливе глушіння)</div>`
      : (gpsLostLong ? `<div style="margin-top:5px;font-size:11.5px;color:#f39c12;font-weight:600">⚠️ GPS втрачено ${fmtDur(gpsLostMsC/1000)} тому — перевір антену</div>`
      : ((!active && lat != null && lon != null && !posValid) ? `<div style="margin-top:5px;font-size:11.5px;color:var(--dim)">📍 нема GPS-фіксу</div>` : ''))));
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
      ? `<div style="margin-top:6px;font-size:12px;color:#e67e22;font-weight:700">📵 Звʼязку нема ${fmtDur(offMs/1000)} — перевір баланс SIM${md_.simPhone ? ` ${esc(md_.simPhone)} · <a href="https://oplata.lifecell.ua" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:#3aa0ff">поповнити</a>` : ''}</div>`
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
    card.onclick = () => openDetail(d);
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

    dayMileage(d.id, startOfDay()).then(km => {
      const el = document.getElementById('dm_' + d.id);
      if (el) el.textContent = (km != null ? km + ' км' : '—');
    }).catch(()=>{ const el=document.getElementById('dm_'+d.id); if(el) el.textContent='—'; });

    // Якщо ПОТОЧНОГО рівня нема (авто заглушене) — освіжаємо «останнє паливо» з ІСТОРІЇ flespi (там правда),
    // бо клієнтський кеш міг застаріти (вранці показував учорашнє). Throttle 3 хв, щоб не спамити.
    if (ev.soc == null && fuelCurrent(d, tel) == null) {
      const fresh = lastFuelTs[d.id] && (Date.now() - lastFuelTs[d.id] < 180000);
      if (!fresh) {
        lastFuelTs[d.id] = Date.now();   // позначаємо ДО запиту, щоб не дублювати
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
  for (const d of devs) {
    const tel = d.telemetry || {};
    let lat = tv(tel,'position.latitude'), lon = tv(tel,'position.longitude');
    const valid = tv(tel,'position.valid');
    if (lat != null && lon != null && valid !== false && saneRegion(lat, lon)) {
      lastValidPos[d.id] = [lat, lon];                              // свіжа валідна точка — запамʼятовуємо
      lastValidPosTs[d.id] = Date.now();
      try {
        localStorage.setItem('lastValidPos', JSON.stringify(lastValidPos));
        localStorage.setItem('lastValidPosTs', JSON.stringify(lastValidPosTs));
      } catch(e){}
    } else if (lastValidPos[d.id]) {
      lat = lastValidPos[d.id][0]; lon = lastValidPos[d.id][1];     // нема фіксу → показуємо ОСТАННЮ ВІДОМУ (не Перу, не зникає)
    }
    if (lat == null || lon == null) continue;                       // позиції ще ніколи не було
    const online = statusOnline(tel);
    const active = displayActive(d, tel, online);
    const liters = fuelLiters(d, tel);
    // GPS втрачено надовго — офіційний індикатор глушіння (РЕБ) з трекера має пріоритет над здогадом
    const gpsLostMs = lastValidPosTs[d.id] ? (Date.now() - lastValidPosTs[d.id]) : null;
    const jamState = gnssJamState(tel);
    const jamMs2 = jamDuration(d.id, jamState);
    const gpsLost = jamState > 0 || (valid === false && gpsLostMs != null && gpsLostMs > GPS_LOST_MS);
    pts.push([lat,lon]);
    const status = active ? '🟢 в роботі' : (online ? '⚪ на звʼязку' : '⚫ офлайн');
    const gpsWarn = jamState === 2 ? `<br>🚫 GPS глушать (РЕБ) вже ${fmtDur(jamMs2/1000)}`
      : jamState === 1 ? `<br>⚠️ GPS ослаблений вже ${fmtDur(jamMs2/1000)}`
      : (gpsLost ? `<br>⚠️ GPS втрачено ${fmtDur(gpsLostMs/1000)} тому — точка застаріла` : '');
    const html = `<b>${esc(d.name)}</b><br>${status}${liters!=null?' · '+liters+' л':''}${gpsWarn}`;
    if (markers[d.id]) {
      markers[d.id].setLatLng([lat,lon]);
      markers[d.id].setIcon(vehIcon(d, online, active, gpsLost));   // оновлюємо обідок (завівся / заглушив / GPS втрачено)
      const pp = markers[d.id].getPopup(); if (pp) pp.setContent(html);
    } else {
      markers[d.id] = markerFor(d, [lat,lon], online, active, gpsLost).addTo(map).bindPopup(html);
    }
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
  if (mileageFieldCache[id]) return mileageFieldCache[id];
  for (const field of ['can.vehicle.mileage', 'vehicle.mileage']) {
    const data = encodeURIComponent(JSON.stringify({ from, to, count:1, reverse:true, filter:field }));
    const res = await api(`/gw/devices/${id}/messages?data=${data}`);
    if (res && res.length && res[0][field] != null) {
      // НАЗАВЖДИ кешуємо лише справжній CAN-одометр. Якщо у пробитому вікні CAN випадково мовчав
      // (авто спало), раніше назавжди фіксувався GNSS-фолбек — а він отруєний телепортом «у Ліму»
      // (+12600 км) і дає нулі/сміття. Тепер фолбек діє лише для цього виклику, CAN пробуємо знову.
      if (field === 'can.vehicle.mileage') {
        mileageFieldCache[id] = field;
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
async function dayMileage(id, from, to) {
  // КЛЮЧ кешу ВКЛЮЧАЄ період! Без цього «Вчора/Тиждень/Місяць» повертали закешоване «за сьогодні»
  // (у звіті виходило одометр=36 км при GPS-треку 457 км).
  // «Живий» період = to не задано АБО to ≈ зараз (вкладки передають to=now, і без нормалізації ключ був
  // унікальний на кожен тап → нуль влучень у кеш і вічний ріст localStorage).
  const now = Math.floor(Date.now()/1000);
  const live = !to || to >= now - 90;
  const key = id + ':' + from + ':' + (live ? 'live' : to);
  const c = dayMileageCache[key];
  // закритий період кешуємо 2 год (НЕ добу: трекер після відновлення звʼязку докидає буферизовані записи
  // заднім числом, і «вчора», пораховане о 00:05, було б занижене цілу добу)
  if (c && (Date.now() - c.at) < (live ? DAY_MILEAGE_TTL : 2*3600000)) return c.km;
  if (dayMileageInflight[key]) return dayMileageInflight[key];   // вже летить — чекаємо той самий, не дублюємо запит
  dayMileageInflight[key] = (async () => {
    const t = to || Math.floor(Date.now()/1000);
    let km = null;
    const field = await mileageField(id, from, t);
    if (field) {
      const [first, last] = await Promise.all([ odoAt(id, from, t, false, field), odoAt(id, from, t, true, field) ]);
      if (first != null && last != null) {
        const d = Math.round(last - first);
        // межа глюків МАСШТАБУЄТЬСЯ періодом: фіксовані 3000 км обрізали чесний МІСЯЧНИЙ пробіг (>3000 за місяць — норма)
        const maxPlausible = Math.max(1, Math.ceil((t - from) / 86400)) * 1500;   // ≤1500 км/добу
        if (d >= 0 && d <= maxPlausible) km = d;   // негатив/абсурд (телепорт одометра) — краще нічого, ніж дурне число
      }
    }
    dayMileageCache[key] = { km, at: Date.now() };
    try { localStorage.setItem('dayMileageCache2', JSON.stringify(dayMileageCache)); } catch(e){}
    return km;
  })();
  try { return await dayMileageInflight[key]; }
  finally { delete dayMileageInflight[key]; }
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
    const data = encodeURIComponent(JSON.stringify({ from: now-days*86400, to: now, count: cnt, reverse: true, fields:'timestamp,external.powersource.voltage,engine.ignition.status,position.speed,position.valid,position.satellites' }));
    let msgs;
    try { msgs = await api(`/gw/devices/${id}/messages?data=${data}`) || []; } catch(e){ return null; }
    for (const m of msgs) {
      const v = m['external.powersource.voltage'], ig = m['engine.ignition.status'];
      const sp = m['position.speed'], vd = m['position.valid'], sa = m['position.satellites'];
      if ((!isEV && v != null && v >= 13.0) || ig === true || (sp != null && sp >= 5 && vd !== false && sa != null && sa >= 4)) return { ts: m.timestamp, found: true };
    }
    if (cnt > 1000 && msgs.length) return { ts: msgs[msgs.length-1].timestamp, found: false };  // увімкнення у вікні нема → «принаймні стільки»
  }
  return null;
}
// повертає готовий текст: «2 год 15 хв» або «≥ 1 год» (коли немає давнішої історії)
async function standingText(dev){
  const id = dev.id, isEV = !!(dev.metadata && (dev.metadata.ev || dev.metadata.evRangeFull));
  const now = Math.floor(Date.now()/1000);
  let ts, atLeast;
  const c = standingCache[id];
  if (c && (Date.now()-c.at) < 1800000) { ts = c.ts; atLeast = c.atLeast; }   // кеш 30 хв (момент простою фіксований)
  else {
    const info = await lastActiveInfo(id, isEV);
    ts = info ? info.ts : null;
    atLeast = info ? !info.found : false;
    if (info) {   // невдачу НЕ кешуємо — інакше «—» залипає на 30 хв після одного мережевого фейлу
      standingCache[id] = { ts, at: Date.now(), atLeast };
      try { localStorage.setItem('standingCache', JSON.stringify(standingCache)); } catch(e){}
    }
  }
  if (ts == null) return '—';
  return (atLeast ? '≥ ' : '') + fmtStanding(now - ts);
}

// ===== Адреса за координатами (зворотне геокодування OSM) =====
// Кеш у localStorage (між сесіями) + СЕРІЙНА черга (по одному запиту — щоб не ловити ліміт Nominatim і не гальмувати).
let geoCache = {};
try { geoCache = JSON.parse(localStorage.getItem('geoCache') || '{}'); } catch(e) { geoCache = {}; }
let geoQueue = Promise.resolve();
function geocode(lat, lon){
  if (lat == null || lon == null) return Promise.resolve('');
  const key = lat.toFixed(4) + ',' + lon.toFixed(4);
  if (geoCache[key] !== undefined) return Promise.resolve(geoCache[key]);
  geoQueue = geoQueue.then(async () => {
    if (geoCache[key] !== undefined) return;   // могли закешувати, поки стояли в черзі
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&accept-language=uk&lat=${lat}&lon=${lon}`);
      const j = await r.json();
      const a = j.address || {};
      const road = a.road || a.pedestrian || a.residential || a.suburb || a.neighbourhood || '';
      const num = a.house_number ? (' ' + a.house_number) : '';
      const place = a.city || a.town || a.village || a.hamlet || a.municipality || '';
      let txt = road ? (road + num) : place;
      if (road && place && place !== road) txt = road + num + ', ' + place;
      if (!txt) txt = (j.display_name || '').split(',').slice(0,2).join(',').trim();
      // кешуємо ЛИШЕ вдалий результат — порожнє/помилку не запамʼятовуємо назавжди, спробуємо ще раз наступного разу
      if (txt) { geoCache[key] = txt; try { localStorage.setItem('geoCache', JSON.stringify(geoCache)); } catch(e){} }
    } catch(e) { /* помилку не кешуємо — спробуємо іншим разом */ }
    await new Promise(res => setTimeout(res, 1100));   // пауза під ліміт Nominatim (1/сек)
  });
  return geoQueue.then(() => geoCache[key] || '');
}

// ===== ЗВЕДЕННЯ ЗА ПЕРІОД (все одним проходом по повідомленнях) =====
async function periodReport(id, from, to) {
  // 1) одометр — точно і дешево
  const odoKmP = dayMileage(id, from, to);

  // 2) усі повідомлення періоду — лише потрібні поля, З ПАГІНАЦІЄЮ: при 2-сек піллінгу тиждень/місяць — це
  // СОТНІ тисяч рядків, а один запит віддає перші 40к → місячний звіт мовчки покривав лише перші дні
  // (і odoKm за весь місяць проти gpsKm за огризок давав фальшивий «⚠ РЕБ»)
  const FIELDS = 'timestamp,position.latitude,position.longitude,position.speed,position.valid,position.satellites,position.hdop,can.vehicle.mileage,vehicle.mileage,can.vehicle.speed,can.fuel.volume,can.fuel.level,can.vehicle.battery.level';
  let msgs = [], pageFrom = from, truncated = false;
  for (let page = 0; page < 10; page++) {                       // до 400к повідомлень; далі чесно позначаємо обрізання
    const data = encodeURIComponent(JSON.stringify({ from: pageFrom, to, count:40000, fields: FIELDS }));
    let batch = [];
    try { batch = await api(`/gw/devices/${id}/messages?data=${data}`) || []; } catch(e) { break; }
    msgs = msgs.concat(batch);
    if (batch.length < 40000) break;                            // остання (неповна) пачка — все зібрано
    pageFrom = (batch[batch.length-1].timestamp || pageFrom) + 0.001;
    if (page === 9) truncated = true;
  }
  msgs.sort((a,b)=> (a.timestamp||0)-(b.timestamp||0));

  const tank = tankFor(id);
  const track = [];
  let gpsM = 0, prevPt = null, prevTs = null, lastTrackPt = null;
  let firstFuel = null, lastFuel = null, prevFuel = null;
  let prevSoc = null, prevSocTs = null; const charges = [];   // ⚡ сесії зарядки електрички: зростання SoC на стоянці
  const fills = [], drains = [];
  const stops = [];
  let stopStart = null, stopPt = null, stopOdo = null, curOdo = null;
  // семпли для СТРІЧКИ ДНЯ: [ts, одометр] і [ts, швидкість>0] — щоб порахувати км і макс. швидкість кожного відрізка руху.
  // Одометри двох джерел НЕ змішуємо (can=пробіг авто, gnss=лічильник трекера — різні шкали!): наприкінці беремо одне.
  const odoCan = [], odoGnss = [], spdS = [];
  let lastMsgTs = null;

  // справжня зупинка = швидкість ~0 І одометр НЕ зріс (інакше це рух під РЕБ-глушінням)
  function closeStop(endTs){
    if (stopStart == null) return;
    const dur = endTs - stopStart;
    const moved = (curOdo != null && stopOdo != null) ? (curOdo - stopOdo) : 0;
    if (dur >= STOP_MIN && moved < 0.3) stops.push({ ts:stopStart, dur, pt:stopPt });
    stopStart = null; stopOdo = null;
  }

  for (const m of msgs) {
    const ts = m.timestamp;
    if (ts != null) lastMsgTs = ts;
    const lat = m['position.latitude'], lon = m['position.longitude'];
    const od = m['can.vehicle.mileage'];
    if (od != null && od > 0) { curOdo = od; if (stopStart != null && stopOdo == null) stopOdo = od; }  // od>0: ігнор глюків-нулів
    // семпли для відрізків руху (пушимо лише зміни — щоб масиви лишались маленькими)
    if (od != null && od > 0 && (!odoCan.length || odoCan[odoCan.length-1][1] !== od)) odoCan.push([ts, od]);
    const odG = m['vehicle.mileage'];
    if (odG != null && odG > 0 && (!odoGnss.length || odG - odoGnss[odoGnss.length-1][1] > 0.05)) odoGnss.push([ts, odG]);

    // валідність GPS-фіксу — відсікаємо «стрибки» (дефолтна/застаріла позиція без супутників)
    const valid = m['position.valid'];
    const sats = m['position.satellites'];
    let goodFix;
    if (valid !== undefined && valid !== null) goodFix = (valid === true);
    else if (sats !== undefined && sats !== null) goodFix = (sats >= 3);
    else goodFix = true;
    // дефолтна точка трекера (Ліма) зрідка приходить НАВІТЬ з valid=true — географічний щит обовʼязковий
    if (lat != null && lon != null && !saneRegion(lat, lon)) goodFix = false;

    // ШВИДКІСТЬ: пріоритет — спідометр авто по CAN (РЕБ-стійкий, не бреше). GPS-швидкість беремо ЛИШЕ
    // з валідним фіксом: під глушінням телепорти давали фантомні «199 км/г» у макс. швидкість дня.
    // Зверху фізична межа 170 (фургон швидше не їде — усе вище це глюк, навіть із «валідним» фіксом).
    const spCan = m['can.vehicle.speed'], spGps = m['position.speed'];
    let sp = null;
    if (spCan != null && spCan >= 0 && spCan < 170) sp = spCan;
    else if (spGps != null && goodFix && spGps < 170) sp = spGps;
    if (sp != null && sp >= 3) spdS.push([ts, sp]);

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
        teleport = (dt <= 0) ? (dm > JITTER_M) : (dm > JITTER_M && kmh >= 200);
        if (dm > JITTER_M && !teleport) gpsM += dm;      // реальний рух; телепорти й дрижання — мимо
      }
      prevPt = pt; prevTs = ts;
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
        closeStop(ts);
      }
    }

    // паливо в літрах: з can.fuel.volume напряму (Master), або can.fuel.level% × бак (Audi)
    let flv = m['can.fuel.volume'];
    if ((flv == null || flv <= 0) && m['can.fuel.level'] != null && tank) flv = m['can.fuel.level']/100*tank;
    // глюк-фільтр: паливо не може бути більшим за бак (запас ходу теж «бреше» — той самий клас сенсорного сміття)
    if (flv != null && tank && flv > tank * 1.15) flv = null;
    if (flv != null && flv > 0) {
      if (firstFuel == null) firstFuel = flv;
      lastFuel = flv;
      if (prevFuel != null) {
        const d = flv - prevFuel;
        if (d >= FILL_L) fills.push({ ts, l: d, pt: prevPt });                        // pt — де сталась заправка
        else if (-d >= DRAIN_L && (sp==null || sp<3)) drains.push({ ts, l: -d, pt: prevPt });
      }
      prevFuel = flv;
    }

    // ⚡ ЗАРЯДКА електрички: SoC росте на стоянці. Сесії ближче 30 хв зливаємо в одну (нічна зарядка = одна подія).
    const soc = m['can.vehicle.battery.level'];
    if (soc != null && soc > 0 && soc <= 100) {
      if (prevSoc != null && soc > prevSoc && (sp == null || sp < 3)) {
        const dpct = soc - prevSoc;
        // допустимий приріст МАСШТАБУЄТЬСЯ часом між замірами: вночі трекер спить, і зарядка +50%
        // приходить одним стрибком уранці — це не глюк. Повільна зарядка ≈25%/год (+5% запас).
        const hrs = prevSocTs != null ? Math.max(0, (ts - prevSocTs) / 3600) : 0;
        const maxRise = Math.min(100, hrs * 25 + 5);
        if (dpct <= maxRise) {
          const lastC = charges[charges.length-1];
          if (lastC && ts - lastC.endTs < 1800) { lastC.pct += dpct; lastC.endTs = ts; }
          else charges.push({ ts, endTs: ts, pct: dpct, pt: prevPt });
        }
      }
      prevSoc = soc; prevSocTs = ts;
    }
  }
  closeStop(to); // зупинка, що триває досі

  const odoKm = await odoKmP;
  const gpsKm = Math.round(gpsM/1000);
  let filledL = null, drainedL = null, spentL = null;
  if (firstFuel != null && lastFuel != null) {   // firstFuel/lastFuel уже в літрах
    filledL = Math.round(fills.reduce((s,f)=>s+f.l,0));
    drainedL = Math.round(drains.reduce((s,f)=>s+f.l,0));
    spentL = Math.max(0, Math.round((firstFuel - lastFuel) + filledL - drainedL));
  }

  // ===== ВІДРІЗКИ РУХУ (для стрічки дня): проміжки між зупинками =====
  const odoS = odoCan.length >= 2 ? odoCan : odoGnss;   // одне джерело на весь період (шкали різні — не мішати!)
  function odoNear(t){   // найближчий семпл одометра до моменту t (в межах 30 хв)
    if (!odoS.length) return null;
    let best = null, bd = 1800;
    let lo = 0, hi = odoS.length-1;
    while (lo < hi) { const mid = (lo+hi)>>1; (odoS[mid][0] < t) ? lo = mid+1 : hi = mid; }
    for (const i of [lo-1, lo, lo+1]) {
      if (i >= 0 && i < odoS.length) { const dd = Math.abs(odoS[i][0]-t); if (dd < bd) { bd = dd; best = odoS[i][1]; } }
    }
    return best;
  }
  const segments = [];
  const sortedStops = stops.slice().sort((a,b)=>a.ts-b.ts);
  function addSeg(a, b){
    if (b - a < 120) return;                     // <2 хв — шумовий проміжок
    // ЗВУЖУЄМО вікно до реальних свідчень руху (перший/останній замір швидкості ≥3 у вікні) —
    // інакше ніч без даних між "кінцем доби" і першою зупинкою рахувалась як "їхав 9 годин".
    let first = null, last = null, mx = 0;
    for (const s of spdS) {
      if (s[0] >= a && s[0] <= b) { if (first == null) first = s[0]; last = s[0]; if (s[1] > mx) mx = s[1]; }
    }
    if (first == null) return;                   // жодного заміру руху — це не поїздка
    a = first; b = Math.min(b, last + 60);
    if (b - a < 120) return;
    const o1 = odoNear(a), o2 = odoNear(b);
    let km = (o1 != null && o2 != null) ? Math.round((o2-o1)*10)/10 : null;
    if (km != null && km < 0.3) return;          // фактично не рухались
    if (km != null && km > 3000) km = null;      // глюк одометра
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

  return { odoKm, gpsKm, filledL, spentL, drainedL, driveSec, standSec, segments, maxSpd, truncated, charges, evKwh, evCost,
           fills: fills.map(f=>({ts:f.ts,l:Math.round(f.l),pt:f.pt})),
           drains: drains.map(f=>({ts:f.ts,l:Math.round(f.l),pt:f.pt})),
           track: simplifyTrack(track, TRACK_SIMPLIFY_M), stops };
}

// ===== Деталі машини =====
let curDetail = null, dMap = null, dLayers = {};

function openDetail(d) {
  curDetail = d;
  document.getElementById('dName').textContent = d.name;
  document.getElementById('detail').classList.add('show');
  const tel = d.telemetry || {};
  const liters = fuelLiters(d, tel);
  const odo = tv(tel,'can.vehicle.mileage');
  const range = vehicleRange(d, tel);   // ДВЗ: очищено від глюків; електро: заряд% × повний запас
  const tank = tankFor(d);
  const ev = evBatt(tel);
  const volt = vehVolt(tel), tb = trkBatt(tel), gsm = gsmInfo(tel), sats = satCount(tel);

  // головна цифра: для електрички — заряд+SoH, для решти — паливо
  const firstBig = ev.soc != null
    ? `<div><div class="big" style="color:var(--green)">${Math.round(ev.soc)} %</div><div class="l" style="color:var(--dim);font-size:12px">заряд батареї${ev.soh!=null?` · SoH ${Math.round(ev.soh)}%`:''}</div></div>`
    : `<div><div class="big" style="color:var(--accent)">${liters!=null?liters+' л':'—'}</div><div class="l" style="color:var(--dim);font-size:12px">в баку${tank?` (бак ${tank} л)`:''}</div></div>`;

  const diagBlock = `
    <div style="margin-top:14px;border-top:1px solid rgba(255,255,255,.08);padding-top:10px">
      <div class="row"><span class="k">🔋 Бортовий акумулятор</span><span class="val">${volt!=null?volt.toFixed(1)+' В'+(voltHealth(volt)?' · '+voltHealth(volt):''):'—'}</span></div>
      <div class="row"><span class="k">🔋 Батарея трекера</span><span class="val">${tb!=null?Math.round(tb)+' %':'—'}</span></div>
      <div class="row"><span class="k">📶 GSM сигнал</span><span class="val">${gsm?gsm.pct+'% · '+gsm.label:'—'}</span></div>
      <div class="row"><span class="k">🛰️ Супутники (GPS)</span><span class="val">${sats!=null?sats:'—'}</span></div>
      <div class="row"><span class="k">🅿️ Стоїть (простій)</span><span class="val" id="dst">…</span></div>
    </div>`;

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
  obdRows.push(`<div class="row"><span class="k">🔍 Живе опитування помилок</span><span class="val"><button class="btn-sm btn" style="padding:7px 12px" onclick="event.stopPropagation();checkFaults(${d.id})">Перевірити</button></span></div>`);
  obdRows.push(`<div id="faults_${d.id}" class="muted" style="display:none"></div>`);
  const obdBlock = `<div class="section"><h3>Двигун / OBD</h3>${obdRows.join('')}</div>`;

  // карта — ЗВЕРХУ і «липка» (як у Wialon/MegaGPS): відкрив авто → одразу бачиш, де воно і маршрут;
  // стрічка й цифри прокручуються ПІД картою, карта лишається на екрані
  document.getElementById('dBody').innerHTML = `
    <div class="mapwrap"><div id="dMap" class="dmap"></div></div>
    <div class="tabs">${dayTabsHtml()}</div>
    <div id="periodOut"><div class="spinner">…</div></div>
    <div class="section">
      <h3>Зараз</h3>
      <div style="display:flex; gap:24px; align-items:baseline">
        ${firstBig}
        ${range!=null?`<div><div class="big">${Math.round(range)}</div><div class="l" style="color:var(--dim);font-size:12px">запас ходу, км</div></div>`:''}
        <div><div class="big">${odo!=null?Math.round(odo).toLocaleString('uk-UA'):'—'}</div><div class="l" style="color:var(--dim);font-size:12px">одометр, км</div></div>
      </div>
      ${diagBlock}
      <button class="reboot" onclick="rebootTracker(${d.id})">🔄 Перезавантажити трекер</button>
    </div>
    ${obdBlock}`;

  // простій у деталях (асинхронно)
  const dOnline = statusOnline(tel), dActive = isActive(d, tel, dOnline);
  const dstEl = document.getElementById('dst');
  if (dstEl) {
    if (dActive) dstEl.textContent = 'в роботі';
    else if (!dOnline) dstEl.textContent = '—';
    else standingText(d).then(txt => { if (dstEl) dstEl.textContent = txt; }).catch(()=>{ if (dstEl) dstEl.textContent='—'; });
  }

  // деталеву мапу перестворюємо
  if (dMap) { dMap.remove(); dMap = null; } _segHl = null;
  loadPeriod(document.querySelector('#detail .tab.active'));
}

// вкладки: останні 7 днів по ДАТАХ (як у Wialon/OVERSEER — «пт 3.07») + Тиждень + Місяць
function dayTabsHtml(){
  const wd = ['нд','пн','вт','ср','чт','пт','сб'];
  let h = '';
  for (let i = 0; i < 7; i++) {
    const dt = new Date(startOfDay()*1000 - i*86400000);
    const label = i === 0 ? 'Сьогодні' : `${wd[dt.getDay()]} ${dt.getDate()}.${String(dt.getMonth()+1).padStart(2,'0')}`;
    h += `<div class="tab${i===0?' active':''}" data-p="d${i}" onclick="loadPeriod(this)">${label}</div>`;
  }
  h += `<div class="tab" data-p="week" onclick="loadPeriod(this)">Тиждень</div>`;
  h += `<div class="tab" data-p="month" onclick="loadPeriod(this)">Місяць</div>`;
  return h;
}
function periodRange(p){
  const now = Math.floor(Date.now()/1000);
  const dm = /^d(\d+)$/.exec(p);
  if (dm) { const i = +dm[1]; const t0 = startOfDay() - i*86400; return [t0, i === 0 ? now : t0 + 86400]; }
  if (p === 'week') return [now - 7*86400, now];
  const d = new Date(); d.setDate(1); d.setHours(0,0,0,0);
  return [Math.floor(d/1000), now];
}
// тап по події стрічки → показати місце на карті (карта липка зверху — скролити не треба)
function focusEvt(lat, lon, label){
  if (!dMap || lat == null) return;
  if (_segHl) { dMap.removeLayer(_segHl); _segHl = null; }
  dMap.setView([lat, lon], 16);
  L.popup({ closeButton:true }).setLatLng([lat, lon]).setContent(label).openOn(dMap);
}
// тап по відрізку «Їхав» → підсвітити САМЕ ЦЕЙ шматок маршруту (фішка з MegaGPS, яку вибрав Іван)
let _dRep = null, _segHl = null;
function focusSeg(si){
  if (!dMap || !_dRep || !_dRep.segments || !_dRep.segments[si]) return;
  const s = _dRep.segments[si];
  const t0 = s.ts - 60, t1 = s.ts + s.dur + 60;   // ±хвилина запасу: трек проріджений, краї можуть не збігатись
  const pts = (_dRep.track || []).filter(p => p[2] != null && p[2] >= t0 && p[2] <= t1);
  if (pts.length < 2) return;                      // під РЕБ шматка треку може не бути — тоді нічого не міняємо
  if (_segHl) { dMap.removeLayer(_segHl); _segHl = null; }
  _segHl = L.polyline(pts.map(p=>[p[0],p[1]]), { color:'#f39c12', weight:6, opacity:.95 }).addTo(dMap);
  _segHl.bindPopup(`${s.km != null ? s.km + ' км · ' : ''}${fmtDur(s.dur)}${s.maxSpd ? ' · до ' + s.maxSpd + ' км/г' : ''}`);
  dMap.fitBounds(_segHl.getBounds(), { padding:[30,30] });
}

let _loadSeq = 0;   // токен покоління: швидке перемикання вкладок не дає «повільному місяцю» перетерти свіжу вкладку
async function loadPeriod(el) {
  const seq = ++_loadSeq;
  document.querySelectorAll('#detail .tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  const p = el.dataset.p;
  const [from, to] = periodRange(p);
  const out = document.getElementById('periodOut');
  out.innerHTML = '<div class="spinner">рахую…</div>';
  if (dMap) { dMap.remove(); dMap = null; } _segHl = null;

  let r;
  try { r = await periodReport(curDetail.id, from, to); }
  catch(e){ if (seq === _loadSeq) out.innerHTML = '<div class="muted">помилка: '+e.message+'</div>'; return; }
  if (seq !== _loadSeq) return;   // поки рахували, користувач уже перемкнувся на іншу вкладку

  const f = (v,u)=> v!=null ? v.toLocaleString('uk-UA')+' '+u : '—';
  const jammed = !r.truncated && (r.odoKm != null && r.odoKm > 2 && r.gpsKm < r.odoKm*0.5);   // при обрізаних даних порівняння некоректне
  // показуємо, ЯКІ дати реально покриває звіт — інакше «Місяць» (з 1-го числа, на початку місяця
  // коротший за ковзний «Тиждень») збиває з пантелику: тиждень виходив «більший за місяць»
  const perEnd = Math.min(to, Math.floor(Date.now()/1000));
  const dstr = ts => { const d = new Date(ts*1000); return d.getDate() + '.' + String(d.getMonth()+1).padStart(2,'0'); };
  const perDays = Math.max(1, Math.round((perEnd - from) / 86400 * 10) / 10);
  // ===== Зведення «плитками»: 6 головних цифр великими, дрібниці — списком нижче (вибір Івана, v63) =====
  const md = curDetail.metadata || {};
  const spdLim = md.speedLimit || 110;
  // середній розхід л/100км (дизель): витрачені літри ÷ пробіг; одометр надійніший за GPS під РЕБ
  let per100 = null, normL = null, hotFuel = false;
  if (!md.ev) {
    const kmC = (r.odoKm != null && r.odoKm >= 10) ? r.odoKm : ((r.gpsKm != null && r.gpsKm >= 10 && !jammed) ? r.gpsKm : null);
    if (kmC != null && r.spentL) {
      per100 = Math.round(r.spentL / kmC * 1000) / 10;
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
      <h3>Зведення · ${dstr(from)}–${dstr(perEnd)} (${perDays} дн)</h3>
      <div class="tiles">${tiles.join('')}</div>
      ${jammed?`<div class="muted" style="text-align:left;color:var(--yellow);font-size:12px;padding:0 0 6px">⚠ GPS глушився (РЕБ) — орієнтуйся на одометр</div>`:''}
      ${!md.ev ? `<div class="row"><span class="k">⛽ Залито</span><span class="val" style="color:var(--green)">${r.filledL!=null?'+'+r.filledL+' л':'—'}</span></div>
      <div class="row"><span class="k">🔴 Злито</span><span class="val" style="color:${r.drainedL?'var(--red)':'inherit'}">${r.drainedL!=null?(r.drainedL?'−'+r.drainedL+' л':'0 л'):'—'}</span></div>` : ''}
      <div class="row"><span class="k">🅿️ Стояв</span><span class="val">${r.standSec ? fmtDur(r.standSec) : '—'}</span></div>
      <div class="row"><span class="k">🛰️ Пробіг по GPS (трек)</span><span class="val">${f(r.gpsKm,'км')}${jammed?' <span style="color:var(--yellow);font-size:11px">⚠ РЕБ</span>':''}</span></div>
      ${(md.ev && !md.batteryKwh && r.evKwh == null) ? `<div class="row"><span class="k">⚡ Заряджено</span><span class="val" style="color:var(--dim);font-size:12px">авто не віддає % батареї — оцінка по пробігу в плитках ↑</span></div>` : ''}
    </div>

    <div class="section">
      <h3>Стрічка дня <span style="font-weight:400;text-transform:none;letter-spacing:0">· тап по «Їхав» — відрізок на карті</span></h3>
      <div id="tlOut"><div class="muted">…</div></div>
    </div>`;

  // мапа треку
  drawTrack(r.track, r.stops);

  // ===== СТРІЧКА ДНЯ: зупинки + відрізки руху + заправки/зливи, хронологічно, тап → місце на карті =====
  const items = [];
  _dRep = r;   // для focusSeg (тап по відрізку «Їхав»)
  r.stops.forEach((s,i)=> items.push({ ts:s.ts, type:'stop', n:i+1, dur:s.dur, pt:s.pt }));
  (r.segments||[]).forEach((s,si)=> items.push({ ts:s.ts, type:'drive', dur:s.dur, km:s.km, maxSpd:s.maxSpd, si }));
  r.fills.forEach(x=> items.push({ ts:x.ts, type:'fill', l:x.l, pt:x.pt }));
  r.drains.forEach(x=> items.push({ ts:x.ts, type:'drain', l:x.l, pt:x.pt }));
  (r.charges||[]).forEach(c=> { if (c.pct >= 2) items.push({ ts:c.ts, type:'charge', pct:c.pct, kwh:c.kwh, uah:c.uah, pt:c.pt }); });
  items.sort((a,b)=> a.ts - b.ts);

  const tl = document.getElementById('tlOut');
  if (!items.length) {
    tl.innerHTML = '<div class="muted">подій за період нема</div>';
  } else {
    // вертикальна шкала часу (стиль, який вибрав Іван зі скріншота): час зліва, кружечок-іконка, справа підпис
    const badge = { drive:['#2ecc71','↗'], stop:['#2e6bd8','P'], fill:['#f39c12','⛽'], drain:['#e74c3c','💧'], charge:['#27ae60','⚡'] };
    tl.innerHTML = '<div class="tl">' + items.map((it,k)=>{
      const t = fmtTime(it.ts);
      const b = badge[it.type] || ['#7d8b99','•'];
      const tap = it.type === 'drive'
        ? ` onclick="focusSeg(${it.si})" style="cursor:pointer"`
        : (it.pt ? ` onclick="focusEvt(${it.pt[0]},${it.pt[1]},'${t}')" style="cursor:pointer"` : '');
      let t1 = '', t2 = it.pt ? '…' : '';
      if (it.type === 'stop')   t1 = `№${it.n} стояв ${fmtDur(it.dur)}`;
      if (it.type === 'drive') { t1 = `Їхав ${fmtDur(it.dur)}`; t2 = [it.km!=null?`${it.km} км`:null, it.maxSpd?`до ${it.maxSpd} км/г`:null].filter(Boolean).join(' · '); }
      if (it.type === 'fill')   t1 = `<span style="color:var(--green)">Заправка +${it.l} л</span>`;
      if (it.type === 'drain')  t1 = `<span style="color:var(--red)">Злив? −${it.l} л</span>`;
      if (it.type === 'charge') t1 = `<span style="color:var(--green)">Зарядка +${it.pct}%${it.kwh!=null?` · ≈${it.kwh} кВт·год${it.uah!=null?` · ${it.uah} грн`:''}`:''}</span>`;
      return `<div class="tli"${tap}><div class="tlt">${t}</div><div class="tlb"><div class="ic" style="background:${b[0]}">${b[1]}</div></div><div class="tlx"><div class="t1">${t1}</div><div class="t2" id="tla_${k}">${t2}</div></div></div>`;
    }).join('') + '</div>';
    // адреси подій — асинхронно (кеш + серійна черга, Nominatim не перевантажуємо)
    items.forEach((it,k)=>{
      if (!it.pt) return;
      geocode(it.pt[0], it.pt[1]).then(addr=>{
        const el = document.getElementById('tla_'+k);
        if (el) el.textContent = addr || (it.pt[0].toFixed(4)+', '+it.pt[1].toFixed(4));
      }).catch(()=>{});
    });
  }
}

function drawTrack(track, stops) {
  const el = document.getElementById('dMap');
  if (!el) return;
  dMap = L.map(el, { zoomControl:true, attributionControl:false });
  const bl = baseLayers();
  bl['Карта'].addTo(dMap);
  L.control.layers(bl, {}, { position:'topright' }).addTo(dMap);

  const oldMsg = document.getElementById('dMapMsg');   // карта тепер поза periodOut і живе між вкладками — старе повідомлення прибираємо самі
  if (oldMsg) oldMsg.remove();
  if (!track.length) {
    dMap.setView([50.9,34.8], 9);
    el.insertAdjacentHTML('afterend','<div class="muted" id="dMapMsg" style="margin-top:8px">за період треку немає</div>');
    return;
  }
  const line = L.polyline(track.map(p=>[p[0],p[1]]), { color:'#3aa0ff', weight:4, opacity:.85 }).addTo(dMap);
  // старт / фініш
  L.circleMarker(track[0], { radius:6, color:'#2ecc71', fillColor:'#2ecc71', fillOpacity:1 }).addTo(dMap).bindPopup('Старт');
  L.circleMarker(track[track.length-1], { radius:6, color:'#e74c3c', fillColor:'#e74c3c', fillOpacity:1 }).addTo(dMap).bindPopup('Кінець');
  // зупинки — пронумеровані
  stops.forEach((s,i)=>{
    if (!s.pt) return;
    const icon = L.divIcon({ className:'', html:`<div style="background:#f1c40f;color:#000;border:2px solid #fff;border-radius:50%;width:24px;height:24px;line-height:20px;text-align:center;font-weight:700;font-size:12px;box-shadow:0 1px 4px rgba(0,0,0,.5)">${i+1}</div>`, iconSize:[24,24], iconAnchor:[12,12] });
    L.marker(s.pt, { icon }).addTo(dMap).bindPopup(`Зупинка №${i+1}<br>${fmtDur(s.dur)}<br>${fmtDateTime(s.ts)}`);
  });
  setTimeout(()=>{ dMap.invalidateSize(); dMap.fitBounds(line.getBounds(), { padding:[30,30] }); }, 100);
}

function closeDetail(){
  document.getElementById('detail').classList.remove('show');
  curDetail = null;
  if (dMap) { dMap.remove(); dMap = null; } _segHl = null;
}

// ===== Оновлення =====
// Адаптивний інтервал: поки хоч одне авто під РЕБ-глушінням — оновлюємось частіше (FAST_REFRESH_MS),
// щоб миттєво зловити момент, коли глушіння скінчиться, а не чекати до 15 секунд.
let timer, _refreshing = false;
async function refresh() {
  if (_refreshing) return;   // не запускаємо другий запит поверх активного — прибирає сплеск при відкритті (кілька тригерів разом)
  _refreshing = true;
  try {
    await loadDevices();
    autoFaultsSweep(devCache).catch(()=>{});   // фонове авто-опитування помилок (сам гейтить частоту)
  } catch(e) {
    // М'ЯКО: якщо на екрані вже є дані — просто тиха «оновлюю…», без червоної помилки.
    // api() і так робить 3 ретраї з паузою, і наступний цикл майже завжди вдалий — користувачу не треба це бачити.
    const upd = document.getElementById('updated');
    if (upd) upd.textContent = ((devCache && devCache.length) ? 'оновлюю…' : 'підключаюсь…') + ' · ' + APP_VERSION;
  } finally {
    _refreshing = false;
  }
  // швидкий поллінг лише перші кілька хвилин глушіння (зловити швидке відновлення). Регіональне глушіння в Сумах
  // триває годинами — тоді 3x частіші запити самі забивають ліміт flespi, тому далі повертаємось на норму.
  const jamSoon = devCache.some(d => {
    const js = gnssJamState(d.telemetry || {});
    return js > 0 && jamDuration(d.id, js) < FAST_WINDOW_MS;
  });
  clearTimeout(timer);
  timer = setTimeout(refresh, jamSoon ? FAST_REFRESH_MS : REFRESH_MS);
}

// ===== Старт =====
function init() {
  if (!token()) {
    document.getElementById('login').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
    return;
  }
  document.getElementById('login').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  // МИТТЄВО показуємо останній збережений стан (без спінера, без помилки), поки тягнемо свіжі дані
  try {
    const snap = JSON.parse(localStorage.getItem('devSnapshot') || 'null');
    if (snap && snap.devs && snap.devs.length) {
      devCache = snap.devs;
      renderCards(snap.devs);
      renderMap(snap.devs);
      const upd = document.getElementById('updated');
      if (upd) upd.textContent = 'дані від ' + new Date(snap.ts).toLocaleTimeString('uk-UA') + ' · оновлюю…';
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
    document.addEventListener('visibilitychange', () => { if (!document.hidden) softRefresh(); });
    window.addEventListener('focus', softRefresh);
    window.addEventListener('pageshow', softRefresh);
  }
}

// АВТО-ОНОВЛЕННЯ: завжди тягнемо свіжий sw.js (без кешу браузера), і коли нова версія
// бере контроль — застосунок сам перезавантажується зі свіжим кодом. Кінець «застряглому кешу».
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    reg.update();
    setInterval(() => reg.update(), 60000);   // перевірка оновлень щохвилини
  }).catch(()=>{});
  let swReloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swReloading) return; swReloading = true; location.reload();
  });
}

init();
