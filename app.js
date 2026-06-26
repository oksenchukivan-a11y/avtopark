'use strict';

// ===== Налаштування =====
const FLESPI = 'https://flespi.io';
const REFRESH_MS = 30000;          // авто-оновлення кожні 30 с
const ONLINE_SEC = 600;            // онлайн, якщо дані свіжіші за 10 хв
const FILL_PCT = 5;                // стрибок рівня вгору > 5% = заправка
const DRAIN_PCT = 4;               // падіння > 4% при зупинці = підозра на злив
const STOP_SPEED = 3;              // км/год: нижче — машина стоїть
const STOP_MIN = 180;              // сек: зупинка від 3 хв
const JITTER_M = 15;               // ігнор GPS-дрижання менше 15 м

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
  const direct = tv(tel, 'fuel.liters');
  if (direct != null) return Math.round(direct);
  const pct = tv(tel, 'can.fuel.level');
  const tank = tankFor(dev);
  if (pct != null && tank) return Math.round(pct / 100 * tank);
  return null;
}

// ===== Список + головна мапа =====
let map, layersCtl, markers = {}, devCache = [];

async function loadDevices() {
  const devs = await api('/gw/devices/all?fields=id,name,telemetry,metadata');
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

function renderCards(devs) {
  const list = document.getElementById('list');
  list.innerHTML = '';
  for (const d of devs) {
    const tel = d.telemetry || {};
    const liters = fuelLiters(d, tel);
    const odo = tv(tel, 'can.vehicle.mileage');
    const spd = tv(tel, 'position.speed');
    const online = statusOnline(tel);
    const lastTs = tts(tel, 'position') || tts(tel, 'can.vehicle.mileage');

    const fuelTxt = liters != null ? liters + ' л'
                   : (tv(tel,'can.fuel.level') != null ? tv(tel,'can.fuel.level')+' %' : '—');
    const odoTxt = odo != null ? Math.round(odo).toLocaleString('uk-UA') + ' км' : '—';
    const spdTxt = spd != null && spd >= 3 ? Math.round(spd) + ' км/г' : (online ? 'стоїть' : '—');

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

    dayMileage(d.id, startOfDay()).then(km => {
      const el = document.getElementById('dm_' + d.id);
      if (el) el.textContent = (km != null ? km + ' км' : '—');
    }).catch(()=>{ const el=document.getElementById('dm_'+d.id); if(el) el.textContent='—'; });
  }
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

// ===== Пробіг з ОДОМЕТРА (точно, дешево) =====
async function odoAt(id, from, to, reverse) {
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
  let gpsM = 0, prevPt = null;
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
    if (od != null) { curOdo = od; if (stopStart != null && stopOdo == null) stopOdo = od; }

    // трек + GPS-відстань
    if (lat != null && lon != null) {
      const pt = [lat, lon];
      if (prevPt) { const dm = haversine(prevPt, pt); if (dm > JITTER_M) gpsM += dm; }
      track.push(pt); prevPt = pt;
    }

    // зупинки (швидкість ~0 І одометр не росте)
    if (sp != null && ts != null) {
      if (sp < STOP_SPEED) {
        if (stopStart == null) { stopStart = ts; stopPt = (lat!=null && lon!=null) ? [lat,lon] : prevPt; stopOdo = curOdo; }
      } else {
        closeStop(ts);
      }
    }

    // паливо
    const fl = m['can.fuel.level'];
    if (fl != null) {
      if (firstFuel == null) firstFuel = fl;
      lastFuel = fl;
      if (prevFuel != null) {
        const d = fl - prevFuel;
        if (d >= FILL_PCT && tank) fills.push({ ts, l: d/100*tank });
        else if (-d >= DRAIN_PCT && (sp==null || sp<3) && tank) drains.push({ ts, l: -d/100*tank });
      }
      prevFuel = fl;
    }
  }
  closeStop(to); // зупинка, що триває досі

  const odoKm = await odoKmP;
  const gpsKm = Math.round(gpsM/1000);
  let filledL = null, drainedL = null, spentL = null;
  if (tank) {
    filledL = Math.round(fills.reduce((s,f)=>s+f.l,0));
    drainedL = Math.round(drains.reduce((s,f)=>s+f.l,0));
    if (firstFuel != null && lastFuel != null) {
      const balance = (firstFuel - lastFuel)/100*tank + filledL - drainedL;
      spentL = Math.max(0, Math.round(balance));
    }
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
  const range = tv(tel,'can.vehicle.remaining.range');
  const tank = tankFor(d);

  document.getElementById('dBody').innerHTML = `
    <div class="section">
      <h3>Зараз</h3>
      <div style="display:flex; gap:24px; align-items:baseline">
        <div><div class="big" style="color:var(--accent)">${liters!=null?liters+' л':(tv(tel,'can.fuel.level')!=null?tv(tel,'can.fuel.level')+' %':'—')}</div><div class="l" style="color:var(--dim);font-size:12px">в баку${tank?` (бак ${tank} л)`:''}</div></div>
        ${range!=null?`<div><div class="big">${Math.round(range)}</div><div class="l" style="color:var(--dim);font-size:12px">запас ходу, км</div></div>`:''}
        <div><div class="big">${odo!=null?Math.round(odo).toLocaleString('uk-UA'):'—'}</div><div class="l" style="color:var(--dim);font-size:12px">одометр, км</div></div>
      </div>
    </div>

    <div class="tabs">
      <div class="tab active" data-p="today" onclick="loadPeriod(this)">Сьогодні</div>
      <div class="tab" data-p="yest" onclick="loadPeriod(this)">Вчора</div>
      <div class="tab" data-p="week" onclick="loadPeriod(this)">Тиждень</div>
      <div class="tab" data-p="month" onclick="loadPeriod(this)">Місяць</div>
    </div>

    <div id="periodOut"><div class="spinner">…</div></div>`;

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
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(()=>{});
}

init();
