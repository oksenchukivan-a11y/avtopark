'use strict';

// ===== Налаштування =====
const FLESPI = 'https://flespi.io';
const APP_VERSION = 'v30';          // показуємо в шапці — щоб видно було, що отримав свіже
const REFRESH_MS = 15000;          // авто-оновлення кожні 30 с
const ONLINE_SEC = 600;            // онлайн, якщо дані свіжіші за 10 хв
const FILL_PCT = 5;                // стрибок рівня вгору > 5% = заправка
const DRAIN_PCT = 4;               // падіння > 4% при зупинці = підозра на злив
const FILL_L = 5;                  // або стрибок > 5 л = заправка (для авто, що дають літри)
const DRAIN_L = 4;                 // падіння > 4 л при зупинці = злив
const STOP_SPEED = 3;              // км/год: нижче — машина стоїть
const STOP_MIN = 180;              // сек: зупинка від 3 хв
const JITTER_M = 15;               // ігнор GPS-дрижання менше 15 м

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
      if (!txt) { last = 'empty'; continue; }
      const j = JSON.parse(txt);
      if (j.errors) throw new Error(j.errors[0] && j.errors[0].reason || 'api');
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

// ===== Бак: з метаданих flespi (device.metadata.tank), запасний — TANKS =====
function tankFor(x) {
  const id = (x && typeof x === 'object') ? x.id : x;
  const dev = (x && typeof x === 'object') ? x : devCache.find(d => d.id === id);
  if (dev && dev.metadata && dev.metadata.tank) return dev.metadata.tank;
  if (TANKS[id] && TANKS[id].tank) return TANKS[id].tank;
  return null;
}

// ===== Паливо у літрах =====
function fuelLiters(dev, tel) {
  const md = (dev && typeof dev === 'object' && dev.metadata) || {};
  const pct = tv(tel, 'can.fuel.level');       // рівень палива, %
  const tank = tankFor(dev);
  // КАЛІБРУВАННЯ: якщо OEM-літри для цього авто ненадійні (metadata.fuelByPct=true) —
  // рахуємо точно: % × реальний бак (для Renault Kangoo 8440, де can.fuel.volume бреше)
  if (md.fuelByPct && pct != null && tank) return Math.round(pct / 100 * tank);
  const direct = tv(tel, 'fuel.liters');       // плагін (літри)
  if (direct != null) return Math.round(direct);
  const vol = tv(tel, 'can.fuel.volume');      // деякі авто (Master) дають реальні літри напряму
  // КАЛІБРУВАННЯ: множник з реального експерименту заправки (metadata.fuelFactor), якщо датчик недо/перераховує
  if (vol != null && vol > 0) return Math.round(vol * (md.fuelFactor || 1));
  if (pct != null && tank) return Math.round(pct / 100 * tank);   // решта: % × бак
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
// запас з адаптацією під ЗАРЯД для електричок (датчик авто застрягає на постійному значенні — як Kangoo Z.E. = 185 при будь-якому %)
function vehicleRange(dev, tel){
  const md = (dev && typeof dev === 'object' && dev.metadata) || {};
  const soc = tv(tel,'can.vehicle.battery.level');
  if (soc != null && md.evRangeFull) return Math.round(soc / 100 * md.evRangeFull);   // електро: заряд% × повний запас
  return rangeKm(tel);   // ДВЗ: сирий запас (без глюків)
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
function vehIcon(dev, online, active) {
  const m = dev.metadata || {};
  const color = m.color || '#3aa0ff';
  const icon = m.icon || '🚗';
  const dim = online ? 1 : 0.55;
  const inner = '<div style="opacity:'+dim+';background:'+color+';border:2px solid #fff;border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 2px 6px rgba(0,0,0,.55)">'+icon+'</div>';
  if (active) {
    // помітне зелене кільце-ореол навколо машини, що в роботі
    const html = '<div style="position:relative;width:46px;height:46px;display:flex;align-items:center;justify-content:center">'
      + '<div style="position:absolute;inset:0;border-radius:50%;border:3px solid #2ecc71;box-shadow:0 0 12px 4px rgba(46,204,113,.95),inset 0 0 6px rgba(46,204,113,.6)"></div>'
      + inner + '</div>';
    return L.divIcon({ className:'', html, iconSize:[46,46], iconAnchor:[23,23] });
  }
  return L.divIcon({ className:'', html: inner, iconSize:[30,30], iconAnchor:[15,15] });
}
function markerFor(dev, latlon, online, active) {
  const m = dev.metadata || {};
  const short = m.short || dev.name || '';
  const mk = L.marker(latlon, { icon: vehIcon(dev, online, active) });
  mk.bindTooltip(short, { permanent:true, direction:'right', offset:[16,0], className:'veh-label' });
  return mk;
}

// ===== Список + головна мапа =====
let map, layersCtl, markers = {}, devCache = [];
let lastValidPos = {};   // остання ВАЛІДНА позиція кожного авто — щоб не зникали з карти й не стрибали в Перу
try { lastValidPos = JSON.parse(localStorage.getItem('lastValidPos') || '{}'); } catch(e) { lastValidPos = {}; }

async function loadDevices() {
  const devs = await api('/gw/devices/all?fields=id,name,telemetry,metadata');
  devCache = devs;
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
function isActive(tel, online) {
  // Авто ЗАДІЯНЕ, якщо є хоч один надійний (РЕБ-стійкий) сигнал:
  //   1) бортова напруга ≥13В — генератор/DC-DC заряджає (оновлюється щомиті)
  //   2) запалювання=true (де OBD його віддає)
  //   3) ПІДТВЕРДЖЕНИЙ реальний рух — для авто, що не дають сигналів двигуна (як Renault Kangoo 8440,
  //      який віддає лише VIN+одометр). Рух «підтверджений» = швидкість + ВАЛІДНИЙ GPS-фікс + багато
  //      супутників → це НЕ РЕБ-телепорт (той дає невалідний фікс / мало супутників / стрибок).
  // RPM не беремо — у телеметрії «застрягає» на старому значенні.
  if (!online) return false;
  const volt = tv(tel,'external.powersource.voltage');
  if (volt != null && volt >= 13.0) return true;
  if (tv(tel,'engine.ignition.status') === true) return true;
  const spd = tv(tel,'position.speed'), valid = tv(tel,'position.valid'), sats = tv(tel,'position.satellites');
  // підтверджений рух: швидкість + фікс не «невалідний» + достатньо супутників (не РЕБ-телепорт)
  if (spd != null && spd >= 3 && spd < 150 && valid !== false && (sats == null || sats >= 4)) return true;
  return false;
}
// ЛИПКІСТЬ: раз авто було активне — лишається «в роботі» ще 4 хв (зглажує світлофори, короткі
// зупинки й паузи між пакетами даних). Стан у localStorage — переживає авто-перезавантаження.
const ACTIVE_STICK_MS = 240000;
let activeSeen = {};
try { activeSeen = JSON.parse(localStorage.getItem('activeSeen') || '{}'); } catch(e) { activeSeen = {}; }
function displayActive(dev, tel, online) {
  if (isActive(tel, online)) {
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
    const fuelTxt = ev.soc != null ? Math.round(ev.soc) + ' %'
                   : (liters != null ? liters + ' л'
                   : (tv(tel,'can.fuel.level') != null ? tv(tel,'can.fuel.level')+' %' : '—'));
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
    const locHtml = showLoc
      ? `<div style="margin-top:5px;font-size:11.5px;color:var(--dim)">📍 <span id="loc_${d.id}">…</span></div>`
      : ((!active && lat != null && lon != null && !posValid) ? `<div style="margin-top:5px;font-size:11.5px;color:var(--dim)">📍 нема GPS-фіксу</div>` : '');
    // тривога: помилки двигуна / перегрів — щоб проблемне авто було видно одразу
    const et = engineTemp(tel), dtc = dtcCount(tel);
    const alerts = [];
    if (dtc != null && dtc > 0) alerts.push(`🛑 ${dtc} ${dtc===1?'помилка':'помилки'} двигуна`);
    if (et != null && et >= 110) alerts.push(`🌡️ перегрів ${Math.round(et)}°C`);
    const alertHtml = alerts.length ? `<div style="margin-top:6px;font-size:12px;color:#e74c3c;font-weight:700">${alerts.join(' · ')}</div>` : '';
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
        <div class="cell"><div class="v fuel">${fuelTxt}</div><div class="l">${fuelLabel}</div></div>
        <div class="cell"><div class="v" id="dm_${d.id}">…</div><div class="l">за сьогодні</div></div>
        <div class="cell"><div class="v">${spdTxt}</div><div class="l">${odoTxt}</div></div>
      </div>${infoHtml}${diagHtml}${locHtml}${alertHtml}`;
    list.appendChild(card);

    dayMileage(d.id, startOfDay()).then(km => {
      const el = document.getElementById('dm_' + d.id);
      if (el) el.textContent = (km != null ? km + ' км' : '—');
    }).catch(()=>{ const el=document.getElementById('dm_'+d.id); if(el) el.textContent='—'; });

    if (!active) {
      standingText(d.id).then(txt => {
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
      try { localStorage.setItem('lastValidPos', JSON.stringify(lastValidPos)); } catch(e){}
    } else if (lastValidPos[d.id]) {
      lat = lastValidPos[d.id][0]; lon = lastValidPos[d.id][1];     // нема фіксу → показуємо ОСТАННЮ ВІДОМУ (не Перу, не зникає)
    }
    if (lat == null || lon == null) continue;                       // позиції ще ніколи не було
    const online = statusOnline(tel);
    const active = displayActive(d, tel, online);
    const liters = fuelLiters(d, tel);
    pts.push([lat,lon]);
    const status = active ? '🟢 в роботі' : (online ? '⚪ на звʼязку' : '⚫ офлайн');
    const html = `<b>${d.name}</b><br>${status}${liters!=null?' · '+liters+' л':''}`;
    if (markers[d.id]) {
      markers[d.id].setLatLng([lat,lon]);
      markers[d.id].setIcon(vehIcon(d, online, active));   // оновлюємо обідок (завівся / заглушив)
      const pp = markers[d.id].getPopup(); if (pp) pp.setContent(html);
    } else {
      markers[d.id] = markerFor(d, [lat,lon], online, active).addTo(map).bindPopup(html);
    }
  }
  if (pts.length && !map._fitted) { map.fitBounds(pts, { padding:[40,40], maxZoom:13 }); map._fitted = true; }
}

// ===== Пробіг з ОДОМЕТРА (точно, дешево) =====
// Пріоритет: OBD-одометр авто (can.vehicle.mileage — стійкий до РЕБ).
// Запасний: GNSS-одометр трекера (vehicle.mileage) — для авто БЕЗ OBD-одометра (Ducato 2008, частина електричок).
async function mileageField(id, from, to) {
  for (const field of ['can.vehicle.mileage', 'vehicle.mileage']) {
    const data = encodeURIComponent(JSON.stringify({ from, to, count:1, reverse:true, filter:field }));
    const res = await api(`/gw/devices/${id}/messages?data=${data}`);
    if (res && res.length && res[0][field] != null) return field;
  }
  return null;
}
async function odoAt(id, from, to, reverse, field) {
  // беремо до 10 з краю і пропускаємо глюки-нулі (деякі авто, як Kangoo 8440, віддають одометр=0)
  const data = encodeURIComponent(JSON.stringify({ from, to, count:10, reverse:!!reverse, filter:field, fields:'timestamp,'+field }));
  const res = await api(`/gw/devices/${id}/messages?data=${data}`);
  if (!res || !res.length) return null;
  for (const m of res) { const v = m[field]; if (v != null && v > 0) return v; }
  return null;
}
async function dayMileage(id, from, to) {
  to = to || Math.floor(Date.now()/1000);
  const field = await mileageField(id, from, to);
  if (!field) return null;
  const [first, last] = await Promise.all([ odoAt(id, from, to, false, field), odoAt(id, from, to, true, field) ]);
  if (first == null || last == null) return null;
  const km = Math.round(last - first);
  if (km < 0 || km > 3000) return null;   // негатив або абсурд (глюк одометра) — краще нічого, ніж дурне число
  return km;
}

// ===== Скільки авто СТОЇТЬ (простій) — від останньої активності двигуна/руху =====
const standingCache = {};   // id -> { ts:<останній активний момент, сек>, at:<коли запитали, мс> }
function fmtStanding(sec){
  if (sec == null) return null;
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec/86400), h = Math.floor((sec%86400)/3600), m = Math.floor((sec%3600)/60);
  if (d > 0) return `${d} дн ${h} год`;
  if (h > 0) return `${h} год ${m} хв`;
  return `${m} хв`;
}
async function lastActiveInfo(id){
  const now = Math.floor(Date.now()/1000);
  // активність = двигун/авто було увімкнене: напруга ≥13В АБО оберти>0 АБО запалювання=true (РЕБ-стійко, без руху).
  // тир 1 — недавні повідомлення (для щоденних авто знайде швидко й дешево); тир 2 — глибше, якщо стоїть давно
  for (const pair of [[400,3],[3000,45]]) {
    const cnt = pair[0], days = pair[1];
    const data = encodeURIComponent(JSON.stringify({ from: now-days*86400, to: now, count: cnt, reverse: true, fields:'timestamp,external.powersource.voltage,engine.ignition.status,position.speed,position.valid' }));
    let msgs;
    try { msgs = await api(`/gw/devices/${id}/messages?data=${data}`) || []; } catch(e){ return null; }
    for (const m of msgs) {
      const v = m['external.powersource.voltage'], ig = m['engine.ignition.status'];
      const sp = m['position.speed'], vd = m['position.valid'];
      if ((v != null && v >= 13.0) || ig === true || (sp != null && sp >= 5 && vd !== false)) return { ts: m.timestamp, found: true };
    }
    if (cnt > 1000 && msgs.length) return { ts: msgs[msgs.length-1].timestamp, found: false };  // увімкнення у вікні нема → «принаймні стільки»
  }
  return null;
}
// повертає готовий текст: «2 год 15 хв» або «≥ 1 год» (коли немає давнішої історії)
async function standingText(id){
  const now = Math.floor(Date.now()/1000);
  let ts, atLeast;
  const c = standingCache[id];
  if (c && (Date.now()-c.at) < 1800000) { ts = c.ts; atLeast = c.atLeast; }   // кеш 30 хв (момент простою фіксований)
  else {
    const info = await lastActiveInfo(id);
    ts = info ? info.ts : null;
    atLeast = info ? !info.found : false;
    standingCache[id] = { ts, at: Date.now(), atLeast };
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
      geoCache[key] = txt || '';
      try { localStorage.setItem('geoCache', JSON.stringify(geoCache)); } catch(e){}
    } catch(e) { /* помилку не кешуємо — спробуємо іншим разом */ }
    await new Promise(res => setTimeout(res, 1100));   // пауза під ліміт Nominatim (1/сек)
  });
  return geoQueue.then(() => geoCache[key] || '');
}

// ===== ЗВЕДЕННЯ ЗА ПЕРІОД (все одним проходом по повідомленнях) =====
async function periodReport(id, from, to) {
  // 1) одометр — точно і дешево
  const odoKmP = dayMileage(id, from, to);

  // 2) усі повідомлення періоду
  const data = encodeURIComponent(JSON.stringify({ from, to, count:40000 }));
  let msgs = [];
  try { msgs = await api(`/gw/devices/${id}/messages?data=${data}`) || []; } catch(e) { msgs = []; }
  msgs.sort((a,b)=> (a.timestamp||0)-(b.timestamp||0));

  const tank = tankFor(id);
  const track = [];
  let gpsM = 0, prevPt = null, prevTs = null;
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
    if (lat != null && lon != null && goodFix) {
      const pt = [lat, lon];
      if (prevPt) {
        const dm = haversine(prevPt, pt);
        const dt = (prevTs != null) ? (ts - prevTs) : 0;
        const kmh = (dt > 0) ? (dm / dt * 3.6) : 0;
        if (dm > JITTER_M && kmh < 200) gpsM += dm;   // реальний рух; телепорти й дрижання — мимо
      }
      track.push(pt); prevPt = pt; prevTs = ts;
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
           track, stops };
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
    : `<div><div class="big" style="color:var(--accent)">${liters!=null?liters+' л':(tv(tel,'can.fuel.level')!=null?tv(tel,'can.fuel.level')+' %':'—')}</div><div class="l" style="color:var(--dim);font-size:12px">в баку${tank?` (бак ${tank} л)`:''}</div></div>`;

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
  const dOnline = statusOnline(tel), dActive = isActive(tel, dOnline);
  const dstEl = document.getElementById('dst');
  if (dstEl) {
    if (dActive) dstEl.textContent = 'в роботі';
    else if (!dOnline) dstEl.textContent = '—';
    else standingText(d.id).then(txt => { if (dstEl) dstEl.textContent = txt; }).catch(()=>{ if (dstEl) dstEl.textContent='—'; });
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
let timer;
async function refresh() {
  try { await loadDevices(); }
  catch(e){ document.getElementById('updated').textContent = 'помилка: ' + e.message; }
}
function startLoop(){ clearInterval(timer); timer = setInterval(refresh, REFRESH_MS); }

// ===== Старт =====
function init() {
  if (!token()) {
    document.getElementById('login').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
    return;
  }
  document.getElementById('login').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  setTimeout(() => { if (map) map.invalidateSize(); }, 200);
  refresh();
  startLoop();
  // iOS-PWA: таймер оновлення «засинає» у фоні/при бездіяльності. Оновлюємо щоразу, коли
  // застосунок знову зʼявляється на екрані або отримує фокус — щоб дані завжди свіжі коли дивишся.
  if (!window._visHooked) {
    window._visHooked = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
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
