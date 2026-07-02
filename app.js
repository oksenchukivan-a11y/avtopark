'use strict';

// ===== Налаштування =====
const FLESPI = 'https://flespi.io';
const APP_VERSION = 'v45';          // показуємо в шапці — щоб видно було, що отримав свіже
const REFRESH_MS = 15000;          // авто-оновлення кожні 15 с (норма)
const FAST_REFRESH_MS = 5000;       // прискорений поллінг у вікні щойно-виявленого глушіння
const FAST_WINDOW_MS = 3 * 60000;   // швидкий режим тримаємо лише перші 3 хв глушіння — довше не варте зайвих запитів (регіональне глушіння в Сумах триває годинами)
const SIM_SUSPECT_MS = 4 * 3600000; // авто мовчить 4+ год, коли інші на звʼязку → підозра на баланс SIM/покриття
const ONLINE_SEC = 600;            // онлайн, якщо дані свіжіші за 10 хв
const FILL_PCT = 5;                // стрибок рівня вгору > 5% = заправка
const DRAIN_PCT = 4;               // падіння > 4% при зупинці = підозра на злив
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
async function api(path, method, body) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const opt = { method: method || 'GET', headers: { Authorization: 'FlespiToken ' + token() } };
      if (body != null) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
      const r = await fetch(FLESPI + path, opt);
      if (r.status === 401 || r.status === 403) throw new Error('AUTH');
      const txt = await r.text();
      if (!txt) { last = 'empty'; await new Promise(res=>setTimeout(res, 800*(i+1))); continue; }
      const j = JSON.parse(txt);
      if (j.errors) {
        const reason = (j.errors[0] && j.errors[0].reason) || 'api';
        // ліміт REST-запитів/хв — миттєвий ретрай лише погіршує ситуацію, чекаємо з нарощуванням паузи
        if (/limit/i.test(reason)) { last = reason; await new Promise(res=>setTimeout(res, 1500*(i+1))); continue; }
        throw new Error(reason);
      }
      return j.result;
    } catch (e) {
      if (e.message === 'AUTH') { alert('Токен недійсний'); logout(); throw e; }
      last = e.message;
    }
  }
  throw new Error(last || 'api');
}

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
function gnssJamState(tel){ const s = tv(tel,'gnss.state.enum'); return (s === 1 || s === 2) ? s : 0; }
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
    range: rangeKm(tel),                            // запас ходу, км (без глюків)
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
  mk.bindTooltip(short, { permanent:true, direction:'right', offset:[16,0], className:'veh-label' });
  return mk;
}

// ===== Список + головна мапа =====
let map, layersCtl, markers = {}, devCache = [];
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

async function loadDevices() {
  const devs = await api('/gw/devices/all?fields=id,name,telemetry,metadata');
  devCache = devs;
  // знімок останнього успішного стану — щоб при наступному відкритті одразу бачити авто (без спінера й без помилки)
  try { localStorage.setItem('devSnapshot', JSON.stringify({ ts: Date.now(), devs })); } catch(e){}
  renderCards(devs);
  renderMap(devs);
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
    if (active) { nActive++; delete standingCache[d.id]; }   // поки в роботі — скидаємо кеш простою
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
    const diagHtml = diag.length
      ? `<div style="display:flex;gap:14px;margin-top:8px;font-size:11px;color:var(--dim);flex-wrap:wrap">${diag.map(x=>`<span>${x}</span>`).join('')}</div>`
      : '';
    // де стоїть (адреса) — лише для незадіяних на звʼязку
    const posValid = tv(tel,'position.valid') !== false;     // валідний GPS-фікс (не дефолтна точка Перу)
    const showLoc = !active && lat != null && lon != null && posValid;
    // GPS втрачено надовго — розрізняємо ПРИЧИНУ: офіційний індикатор глушіння (РЕБ) з трекера, або справді апаратна проблема
    const gpsLostMsC = lastValidPosTs[d.id] ? (Date.now() - lastValidPosTs[d.id]) : null;
    const gpsLostLong = !posValid && gpsLostMsC != null && gpsLostMsC > GPS_LOST_MS;
    const jam = gnssJamState(tel);
    const jamMs = jamDuration(d.id, jam);
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
    if (et != null && et >= 110) alerts.push(`🌡️ перегрів ${Math.round(et)}°C`);
    const alertHtml = alerts.length ? `<div style="margin-top:6px;font-size:12px;color:#e74c3c;font-weight:700">${alerts.join(' · ')}</div>` : '';
    // SIM-підозра: авто довго мовчить, тоді як ІНШІ на звʼязку (отже не РЕБ і не збій flespi, а саме ця сімка/покриття).
    // Баланс НАШИХ сімок дистанційно не читається (FMB003 не вміє USSD) — тому ловимо САМ ФАКТ смерті звʼязку і даємо поповнити в 1 тик.
    const md_ = d.metadata || {};
    const offMs = (!online && lastTs) ? (Date.now() - lastTs*1000) : null;
    const othersOnline = devs.some(o => o.id !== d.id && statusOnline(o.telemetry || {}));
    const simHtml = (offMs != null && offMs > SIM_SUSPECT_MS && othersOnline)
      ? `<div style="margin-top:6px;font-size:12px;color:#e67e22;font-weight:700">📵 Звʼязку нема ${fmtDur(offMs/1000)} — перевір баланс SIM${md_.simPhone ? ` ${md_.simPhone} · <a href="https://oplata.lifecell.ua" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:#3aa0ff">поповнити</a>` : ''}</div>`
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
        <span class="name">${d.name}</span>
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
    layersCtl = L.control.layers(bl, {}, { position:'topright' }).addTo(map);
  }
  const pts = [];
  for (const d of devs) {
    const tel = d.telemetry || {};
    let lat = tv(tel,'position.latitude'), lon = tv(tel,'position.longitude');
    const valid = tv(tel,'position.valid');
    if (lat != null && lon != null && valid !== false) {
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
    const html = `<b>${d.name}</b><br>${status}${liters!=null?' · '+liters+' л':''}${gpsWarn}`;
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
      mileageFieldCache[id] = field;
      try { localStorage.setItem('mileageFieldCache', JSON.stringify(mileageFieldCache)); } catch(e){}
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
const DAY_MILEAGE_TTL = 180000;   // 3 хв
let dayMileageCache = {};
try { dayMileageCache = JSON.parse(localStorage.getItem('dayMileageCache') || '{}'); } catch(e) { dayMileageCache = {}; }
const dayMileageInflight = {};   // дедуп одночасних запитів (рендер при відкритті йде двічі: знімок + живі дані)
async function dayMileage(id, from, to) {
  const today = startOfDay();
  const c = dayMileageCache[id];
  if (c && c.day === today && (Date.now() - c.at) < DAY_MILEAGE_TTL) return c.km;
  if (dayMileageInflight[id]) return dayMileageInflight[id];   // вже летить — чекаємо той самий, не дублюємо запит
  dayMileageInflight[id] = (async () => {
    const t = to || Math.floor(Date.now()/1000);
    let km = null;
    const field = await mileageField(id, from, t);
    if (field) {
      const [first, last] = await Promise.all([ odoAt(id, from, t, false, field), odoAt(id, from, t, true, field) ]);
      if (first != null && last != null) {
        const d = Math.round(last - first);
        if (d >= 0 && d <= 3000) km = d;   // негатив/абсурд — краще нічого, ніж дурне число
      }
    }
    dayMileageCache[id] = { km, day: today, at: Date.now() };
    try { localStorage.setItem('dayMileageCache', JSON.stringify(dayMileageCache)); } catch(e){}
    return km;
  })();
  try { return await dayMileageInflight[id]; }
  finally { delete dayMileageInflight[id]; }
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
    standingCache[id] = { ts, at: Date.now(), atLeast };
    try { localStorage.setItem('standingCache', JSON.stringify(standingCache)); } catch(e){}
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

  // 2) усі повідомлення періоду — лише потрібні поля (при 2-сек піллінгу за день це тисячі рядків; вузький fields = легший і швидший запит)
  const data = encodeURIComponent(JSON.stringify({ from, to, count:40000,
    fields:'timestamp,position.latitude,position.longitude,position.speed,position.valid,position.satellites,position.hdop,can.vehicle.mileage,can.vehicle.speed,can.fuel.volume,can.fuel.level' }));
  let msgs = [];
  try { msgs = await api(`/gw/devices/${id}/messages?data=${data}`) || []; } catch(e) { msgs = []; }
  msgs.sort((a,b)=> (a.timestamp||0)-(b.timestamp||0));

  const tank = tankFor(id);
  const track = [];
  let gpsM = 0, prevPt = null, prevTs = null, lastTrackPt = null;
  let firstFuel = null, lastFuel = null, prevFuel = null;
  const fills = [], drains = [];
  const stops = [];
  let stopStart = null, stopPt = null, stopOdo = null, curOdo = null;

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
    const lat = m['position.latitude'], lon = m['position.longitude'];
    let sp = m['position.speed'];
    if (sp == null) sp = m['can.vehicle.speed'];
    const od = m['can.vehicle.mileage'];
    if (od != null && od > 0) { curOdo = od; if (stopStart != null && stopOdo == null) stopOdo = od; }  // od>0: ігнор глюків-нулів

    // валідність GPS-фіксу — відсікаємо «стрибки» (дефолтна/застаріла позиція без супутників)
    const valid = m['position.valid'];
    const sats = m['position.satellites'];
    let goodFix;
    if (valid !== undefined && valid !== null) goodFix = (valid === true);
    else if (sats !== undefined && sats !== null) goodFix = (sats >= 3);
    else goodFix = true;

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
        teleport = (dm > JITTER_M && kmh >= 200);        // фізично неможлива швидкість — глюк/стрибок, не рух
        if (dm > JITTER_M && !teleport) gpsM += dm;      // реальний рух; телепорти й дрижання — мимо
      }
      prevPt = pt; prevTs = ts;
      // МАЛЮЄМО трек рідше за сирі фікси: при пілінгу 2с GPS-шум (±3-8м) дає зубчасту «розмазану» лінію.
      // Пушимо нову точку лише коли відійшли достатньо від ОСТАННЬОЇ НАМАЛЬОВАНОЇ (не від кожного сирого фіксу),
      // і не телепорт (інакше на карті буде кривий стрибок-лінія через увесь маршрут).
      if (goodPrecision && !teleport && (!lastTrackPt || haversine(lastTrackPt, pt) > TRACK_MIN_M)) {
        track.push(pt); lastTrackPt = pt;
      }
    }

    // зупинки (швидкість ~0 І одометр не росте)
    if (sp != null && ts != null) {
      if (sp < STOP_SPEED) {
        if (stopStart == null) { stopStart = ts; stopPt = (lat!=null && lon!=null) ? [lat,lon] : prevPt; stopOdo = curOdo; }
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
        if (d >= FILL_L) fills.push({ ts, l: d });
        else if (-d >= DRAIN_L && (sp==null || sp<3)) drains.push({ ts, l: -d });
      }
      prevFuel = flv;
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
  return { odoKm, gpsKm, filledL, spentL, drainedL,
           fills: fills.map(f=>({ts:f.ts,l:Math.round(f.l)})),
           drains: drains.map(f=>({ts:f.ts,l:Math.round(f.l)})),
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
  const obdBlock = obdRows.length ? `<div class="section"><h3>Двигун / OBD</h3>${obdRows.join('')}</div>` : '';

  document.getElementById('dBody').innerHTML = `
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
    ${obdBlock}
    <div class="tabs">
      <div class="tab active" data-p="today" onclick="loadPeriod(this)">Сьогодні</div>
      <div class="tab" data-p="yest" onclick="loadPeriod(this)">Вчора</div>
      <div class="tab" data-p="week" onclick="loadPeriod(this)">Тиждень</div>
      <div class="tab" data-p="month" onclick="loadPeriod(this)">Місяць</div>
    </div>

    <div id="periodOut"><div class="spinner">…</div></div>`;

  // простій у деталях (асинхронно)
  const dOnline = statusOnline(tel), dActive = isActive(d, tel, dOnline);
  const dstEl = document.getElementById('dst');
  if (dstEl) {
    if (dActive) dstEl.textContent = 'в роботі';
    else if (!dOnline) dstEl.textContent = '—';
    else standingText(d).then(txt => { if (dstEl) dstEl.textContent = txt; }).catch(()=>{ if (dstEl) dstEl.textContent='—'; });
  }

  // деталеву мапу перестворюємо
  if (dMap) { dMap.remove(); dMap = null; }
  loadPeriod(document.querySelector('#detail .tab.active'));
}

function periodRange(p){
  const now = Math.floor(Date.now()/1000);
  if (p === 'today') return [startOfDay(), now];
  if (p === 'yest') { const t = startOfDay(); return [t-86400, t]; }
  if (p === 'week') return [now - 7*86400, now];
  const d = new Date(); d.setDate(1); d.setHours(0,0,0,0);
  return [Math.floor(d/1000), now];
}

async function loadPeriod(el) {
  document.querySelectorAll('#detail .tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  const p = el.dataset.p;
  const [from, to] = periodRange(p);
  const out = document.getElementById('periodOut');
  out.innerHTML = '<div class="spinner">рахую…</div>';
  if (dMap) { dMap.remove(); dMap = null; }

  let r;
  try { r = await periodReport(curDetail.id, from, to); }
  catch(e){ out.innerHTML = '<div class="muted">помилка: '+e.message+'</div>'; return; }

  const f = (v,u)=> v!=null ? v.toLocaleString('uk-UA')+' '+u : '—';
  const jammed = (r.odoKm != null && r.odoKm > 2 && r.gpsKm < r.odoKm*0.5);
  out.innerHTML = `
    <div class="section">
      <h3>Зведення</h3>
      <div class="row"><span class="k">📏 Пробіг з одометра</span><span class="val" style="color:var(--accent)">${f(r.odoKm,'км')}</span></div>
      <div class="row"><span class="k">🛰️ Пробіг по GPS (трек)</span><span class="val">${f(r.gpsKm,'км')}${jammed?' <span style="color:var(--yellow);font-size:11px">⚠ РЕБ</span>':''}</span></div>
      ${jammed?`<div class="muted" style="text-align:left;color:var(--yellow);font-size:12px;padding:4px 0">⚠ GPS глушився (РЕБ) — орієнтуйся на одометр</div>`:''}
      <div class="row"><span class="k">⛽ Залито палива</span><span class="val" style="color:var(--green)">${r.filledL!=null?'+'+r.filledL+' л':'—'}</span></div>
      <div class="row"><span class="k">🔥 Витрачено палива</span><span class="val">${f(r.spentL,'л')}</span></div>
      <div class="row"><span class="k">🔴 Злито палива</span><span class="val" style="color:${r.drainedL?'var(--red)':'inherit'}">${r.drainedL!=null?(r.drainedL?'−'+r.drainedL+' л':'0 л'):'—'}</span></div>
    </div>

    <div class="section">
      <h3>Трек і зупинки (≥3 хв)</h3>
      <div id="dMap" class="dmap"></div>
      <div id="stopsOut" style="margin-top:10px"></div>
    </div>

    ${(r.fills.length||r.drains.length) ? `<div class="section"><h3>Події палива</h3><div id="evOut"></div></div>` : ''}`;

  // мапа треку
  drawTrack(r.track, r.stops);

  // список зупинок
  const so = document.getElementById('stopsOut');
  if (r.stops.length) {
    so.innerHTML = r.stops.map((s,i)=>`<div class="ev"><span><b>№${i+1}</b> &nbsp;${fmtDur(s.dur)}</span><span class="when">${fmtDateTime(s.ts)}</span></div>`).join('');
  } else {
    so.innerHTML = '<div class="muted">зупинок ≥3 хв не знайдено</div>';
  }

  // події палива
  const ev = document.getElementById('evOut');
  if (ev) {
    let h='';
    r.fills.forEach(x=> h+=`<div class="ev"><span class="amt up">🟢 +${x.l} л</span><span class="when">${fmtDateTime(x.ts)}</span></div>`);
    r.drains.forEach(x=> h+=`<div class="ev"><span class="amt down">🔴 −${x.l} л злив?</span><span class="when">${fmtDateTime(x.ts)}</span></div>`);
    ev.innerHTML = h;
  }
}

function drawTrack(track, stops) {
  const el = document.getElementById('dMap');
  if (!el) return;
  dMap = L.map(el, { zoomControl:true, attributionControl:false });
  const bl = baseLayers();
  bl['Карта'].addTo(dMap);
  L.control.layers(bl, {}, { position:'topright' }).addTo(dMap);

  if (!track.length) {
    dMap.setView([50.9,34.8], 9);
    el.insertAdjacentHTML('afterend','<div class="muted" style="margin-top:8px">за період треку немає</div>');
    return;
  }
  const line = L.polyline(track, { color:'#3aa0ff', weight:4, opacity:.85 }).addTo(dMap);
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
  if (dMap) { dMap.remove(); dMap = null; }
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
