'use strict';

// ===== Налаштування =====
const FLESPI = 'https://flespi.io';
const REFRESH_MS = 30000;          // авто-оновлення кожні 30 с
const ONLINE_SEC = 600;            // онлайн, якщо дані свіжіші за 10 хв
const FILL_PCT = 5;                // стрибок рівня вгору > 5% = заправка
const DRAIN_PCT = 4;               // падіння > 4% при зупинці = підозра на злив

// Ємності баків (літри) по device_id. Додаватимемо машини сюди.
const TANKS = {
  8436812: { name: 'Audi Q5', tank: 70 },
};

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
async function api(path) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(FLESPI + path, { headers: { Authorization: 'FlespiToken ' + token() } });
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

function tv(tel, key) { // дістати значення параметра з telemetry
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
function ago(sec){
  const s = Math.floor(Date.now()/1000) - sec;
  if (s < 60) return 'щойно';
  if (s < 3600) return Math.floor(s/60)+' хв тому';
  if (s < 86400) return Math.floor(s/3600)+' год тому';
  return Math.floor(s/86400)+' дн тому';
}

// ===== Паливо у літрах =====
function fuelLiters(dev, tel) {
  const direct = tv(tel, 'fuel.liters');      // якщо плагін flespi порахував
  if (direct != null) return Math.round(direct);
  const pct = tv(tel, 'can.fuel.level');
  const cfg = TANKS[dev.id];
  if (pct != null && cfg && cfg.tank) return Math.round(pct / 100 * cfg.tank);
  return null;
}

// ===== Рендер списку + мапа =====
let map, markers = {};
let devCache = [];

async function loadDevices() {
  const devs = await api('/gw/devices/all?fields=id,name,telemetry');
  devCache = devs;
  renderCards(devs);
  renderMap(devs);
  document.getElementById('updated').textContent = 'оновлено ' + new Date().toLocaleTimeString('uk-UA');
}

function statusOnline(tel) {
  const ts = tts(tel, 'position') || tts(tel, 'can.vehicle.mileage') || tts(tel, 'can.fuel.level');
  if (!ts) return false;
  return (Date.now()/1000 - ts) < ONLINE_SEC;
}

async function renderCards(devs) {
  const list = document.getElementById('list');
  list.innerHTML = '';
  for (const d of devs) {
    const tel = d.telemetry || {};
    const liters = fuelLiters(d, tel);
    const cfg = TANKS[d.id];
    const odo = tv(tel, 'can.vehicle.mileage');
    const spd = tv(tel, 'position.speed');
    const online = statusOnline(tel);
    const lastTs = tts(tel, 'position') || tts(tel, 'can.vehicle.mileage');

    const fuelTxt = liters != null ? liters + ' л'
                   : (tv(tel,'can.fuel.level') != null ? tv(tel,'can.fuel.level')+' %' : '—');
    const odoTxt = odo != null ? Math.round(odo).toLocaleString('uk-UA') + ' км' : '—';
    const spdTxt = spd != null ? Math.round(spd) + ' км/г' : (online ? 'стоїть' : '—');

    const card = document.createElement('div');
    card.className = 'card';
    card.onclick = () => openDetail(d);
    card.innerHTML = `
      <div class="top">
        <span class="dot ${online?'on':'off'}"></span>
        <span class="name">${d.name}</span>
        <span class="badge" style="margin:0">${lastTs?ago(lastTs):''}</span>
      </div>
      <div class="grid">
        <div class="cell"><div class="v fuel">${fuelTxt}</div><div class="l">паливо</div></div>
        <div class="cell"><div class="v" id="dm_${d.id}">…</div><div class="l">за сьогодні</div></div>
        <div class="cell"><div class="v">${spdTxt}</div><div class="l">${odoTxt}</div></div>
      </div>`;
    list.appendChild(card);

    // пробіг за сьогодні (з одометра) — асинхронно
    dayMileage(d.id, startOfDay()).then(km => {
      const el = document.getElementById('dm_' + d.id);
      if (el) el.textContent = (km != null ? km + ' км' : '—');
    }).catch(()=>{ const el=document.getElementById('dm_'+d.id); if(el) el.textContent='—'; });
  }
}

function renderMap(devs) {
  if (!map) {
    map = L.map('map', { zoomControl:true, attributionControl:false }).setView([50.9,34.8], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 }).addTo(map);
  }
  const pts = [];
  for (const d of devs) {
    const tel = d.telemetry || {};
    const lat = tv(tel,'position.latitude'), lon = tv(tel,'position.longitude');
    if (lat == null || lon == null) continue;
    const online = statusOnline(tel);
    const liters = fuelLiters(d, tel);
    pts.push([lat,lon]);
    const html = `<b>${d.name}</b><br>${liters!=null?liters+' л':''} ${online?'🟢':'⚪'}`;
    if (markers[d.id]) {
      markers[d.id].setLatLng([lat,lon]).getPopup().setContent(html);
    } else {
      markers[d.id] = L.marker([lat,lon]).addTo(map).bindPopup(html);
    }
  }
  if (pts.length && !map._fitted) { map.fitBounds(pts, { padding:[40,40], maxZoom:13 }); map._fitted = true; }
}

// ===== Пробіг з ОДОМЕТРА (не GPS) =====
// Перше і останнє показання can.vehicle.mileage у вікні → різниця.
async function odoAt(id, from, to, reverse) {
  // filter — flespi поверне лише повідомлення, де є одометр (точно і легко)
  const data = encodeURIComponent(JSON.stringify({ from, to, count:1, reverse:!!reverse, filter:'can.vehicle.mileage' }));
  const res = await api(`/gw/devices/${id}/messages?data=${data}`);
  if (!res || !res.length) return null;
  const m = res[0];
  return (m['can.vehicle.mileage'] != null) ? m['can.vehicle.mileage'] : null;
}
async function dayMileage(id, from, to) {
  to = to || Math.floor(Date.now()/1000);
  const [first, last] = await Promise.all([ odoAt(id, from, to, false), odoAt(id, from, to, true) ]);
  if (first == null || last == null) return null;
  const km = Math.round(last - first);
  return km >= 0 ? km : null;
}

// ===== Заправки / зливи (останні 48 год) =====
async function fuelEvents(id) {
  const now = Math.floor(Date.now()/1000), from = now - 48*3600;
  // filter — лише повідомлення з рівнем палива (легко й швидко)
  const data = encodeURIComponent(JSON.stringify({ from, to:now, count:8000, filter:'can.fuel.level' }));
  let msgs;
  try { msgs = await api(`/gw/devices/${id}/messages?data=${data}`); } catch(e){ return null; }
  if (!msgs) return null;
  const cfg = TANKS[id]; const tank = cfg && cfg.tank;
  const fills = [], drains = [];
  let prev = null;
  for (const m of msgs) {
    const fl = m['can.fuel.level']; if (fl == null) continue;
    const sp = m['position.speed'] != null ? m['position.speed'] : m['can.vehicle.speed'];
    const ts = m['timestamp'];
    if (prev != null) {
      const d = fl - prev;
      if (d >= FILL_PCT && tank) fills.push({ ts, l: Math.round(d/100*tank) });
      else if (-d >= DRAIN_PCT && (sp == null || sp < 2) && tank) drains.push({ ts, l: Math.round(-d/100*tank) });
    }
    prev = fl;
  }
  return { fills, drains };
}

// ===== Деталі машини =====
let curDetail = null;
async function openDetail(d) {
  curDetail = d;
  document.getElementById('dName').textContent = d.name;
  document.getElementById('detail').classList.add('show');
  const tel = d.telemetry || {};
  const liters = fuelLiters(d, tel);
  const odo = tv(tel,'can.vehicle.mileage');
  const range = tv(tel,'can.vehicle.remaining.range');
  const cfg = TANKS[d.id];

  const b = document.getElementById('dBody');
  b.innerHTML = `
    <div class="section">
      <h3>Зараз</h3>
      <div style="display:flex; gap:20px; align-items:baseline">
        <div><div class="big" style="color:var(--accent)">${liters!=null?liters+' л':(tv(tel,'can.fuel.level')!=null?tv(tel,'can.fuel.level')+' %':'—')}</div><div class="l" style="color:var(--dim);font-size:12px">паливо в баку${cfg?` (бак ${cfg.tank} л)`:''}</div></div>
        ${range!=null?`<div><div class="big">${Math.round(range)}</div><div class="l" style="color:var(--dim);font-size:12px">запас ходу, км</div></div>`:''}
      </div>
      <div class="row" style="margin-top:10px"><span class="k">Одометр</span><span class="val">${odo!=null?Math.round(odo).toLocaleString('uk-UA')+' км':'—'}</span></div>
    </div>

    <div class="section">
      <h3>Пробіг (з одометра)</h3>
      <div class="tabs">
        <div class="tab active" onclick="mileTab(this,'today')">Сьогодні</div>
        <div class="tab" onclick="mileTab(this,'yest')">Вчора</div>
        <div class="tab" onclick="mileTab(this,'month')">Місяць</div>
      </div>
      <div id="mileOut" class="spinner">…</div>
    </div>

    <div class="section">
      <h3>Паливо — заправки і зливи (48 год)</h3>
      <div id="fuelOut" class="spinner">…</div>
    </div>`;

  mileTab(document.querySelector('#detail .tab'), 'today');

  // паливні події
  const fe = await fuelEvents(d.id);
  const out = document.getElementById('fuelOut');
  if (!fe) { out.innerHTML = '<div class="muted">немає даних</div>'; return; }
  let html = '';
  fe.fills.forEach(f => html += `<div class="ev"><span class="amt up">🟢 +${f.l} л</span><span class="when">${fmtDateTime(f.ts)}</span></div>`);
  fe.drains.forEach(f => html += `<div class="ev"><span class="amt down">🔴 −${f.l} л злив?</span><span class="when">${fmtDateTime(f.ts)}</span></div>`);
  out.innerHTML = html || '<div class="muted">за 48 год заправок і зливів не виявлено</div>';
}

async function mileTab(el, period) {
  document.querySelectorAll('#detail .tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  const out = document.getElementById('mileOut');
  out.className = 'spinner'; out.textContent = '…';
  const now = Math.floor(Date.now()/1000);
  let from, to;
  if (period === 'today') { from = startOfDay(); to = now; }
  else if (period === 'yest') { to = startOfDay(); from = to - 86400; }
  else { const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); from = Math.floor(d/1000); to = now; }
  try {
    const km = await dayMileage(curDetail.id, from, to);
    out.className = '';
    out.innerHTML = `<div class="big">${km!=null?km.toLocaleString('uk-UA')+' км':'—'}</div>`;
  } catch(e) { out.className=''; out.innerHTML = '<div class="muted">—</div>'; }
}

function closeDetail(){ document.getElementById('detail').classList.remove('show'); curDetail=null; }

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
}

// service worker (для встановлення як додаток)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(()=>{});
}

init();
