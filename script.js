// ─── DATA ───────────────────────────────────────────────
const devices = [
  { id:'D1', name:'iPhone 15 Pro', mac:'A4:C3:F0:1B:2E:8D', rssi:-42, zone:'Zona A' },
  { id:'D2', name:'Samsung Galaxy S24', mac:'B2:7E:4A:9C:3F:11', rssi:-55, zone:'Zona A' },
  { id:'D3', name:'MacBook Air M3', mac:'F8:1E:DF:A2:0C:5B', rssi:-48, zone:'Zona B' },
  { id:'D4', name:'Xiaomi 13T', mac:'3C:94:D5:6E:BB:40', rssi:-61, zone:'Zona B' },
  { id:'D5', name:'OnePlus 12', mac:'DC:2C:6E:0A:47:73', rssi:-78, zone:'Zona C' },
  { id:'D6', name:'iPad Pro', mac:'70:3E:AC:B5:29:1F', rssi:-53, zone:'Zona D' },
  { id:'D7', name:'Pixel 8', mac:'4A:B1:78:DD:33:C9', rssi:-67, zone:'Zona D' },
];

const energyData = [
  { zone:'Zona A', pct:82, color:'#ff6b35' },
  { zone:'Zona B', pct:65, color:'#fbbf24' },
  { zone:'Zona C', pct:12, color:'#00ff9d' },
  { zone:'Zona D', pct:44, color:'#00d4ff' },
];

const logMessages = [
  { type:'ok',    msg:'D3 detectado · Zona B · -48dBm' },
  { type:'info',  msg:'Ciclo de escaneo completado · 7 dispositivos' },
  { type:'alert', msg:'RSSI bajo en Zona C · D5 @ -78dBm' },
  { type:'ok',    msg:'Ahorro energético activado · Zona C vacía' },
  { type:'info',  msg:'D1 transición A→B · tracking activo' },
  { type:'ok',    msg:'ESP32 heartbeat · uptime 4h 32m' },
  { type:'info',  msg:'Beacon sniff · 12 redes detectadas' },
];

const biMetrics = [
  { label:'Peak Hour', value:'10:00–11:00', icon:'📊' },
  { label:'Zona más activa', value:'Zona B', icon:'📍' },
  { label:'Tiempo medio estancia', value:'34 min', icon:'⏱' },
  { label:'Ocupación máxima hoy', value:'9 dev · 14:22', icon:'🔢' },
];

// ─── RENDER SIGNAL BARS ─────────────────────────────────
function renderSignalBars() {
  const el = document.getElementById('signalChart');
  el.innerHTML = devices.map(d => {
    const norm = Math.max(0, Math.min(100, (d.rssi + 90) / 50 * 100));
    const h = Math.round(norm * 0.7 + 10);
    const isActive = d.rssi > -60;
    return `<div class="signal-bar-wrap">
      <div class="signal-bar ${isActive ? 'active' : ''}" style="height:${h}px"></div>
      <div class="signal-label">${d.id}</div>
    </div>`;
  }).join('');
}

// ─── RENDER DEVICE LIST ──────────────────────────────────
function renderDevices() {
  const el = document.getElementById('deviceList');
  const rssiClass = r => r > -60 ? 'rssi-strong' : r > -70 ? 'rssi-mid' : 'rssi-weak';
  el.innerHTML = devices.map(d => `
    <div class="device-row">
      <div class="device-icon">📱</div>
      <div class="device-info">
        <div class="device-name">${d.name}</div>
        <div class="device-mac">${d.mac}</div>
      </div>
      <div class="device-rssi ${rssiClass(d.rssi)}">${d.rssi} dBm</div>
      <div class="device-zone">${d.zone}</div>
    </div>
  `).join('');
}

// ─── RENDER ENERGY ───────────────────────────────────────
function renderEnergy() {
  const el = document.getElementById('energyBars');
  el.innerHTML = energyData.map(e => `
    <div class="energy-row">
      <div class="energy-zone-label">${e.zone}</div>
      <div class="energy-track">
        <div class="energy-fill" style="width:${e.pct}%;background:${e.color};opacity:0.8"></div>
      </div>
      <div class="energy-pct">${e.pct}%</div>
    </div>
  `).join('');
}

// ─── RENDER LOG ──────────────────────────────────────────
function renderLog() {
  const el = document.getElementById('eventLog');
  const now = new Date();
  el.innerHTML = logMessages.map((l, i) => {
    const t = new Date(now - i * 47000);
    const ts = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
    return `<div class="log-entry">
      <span class="log-time">${ts}</span>
      <span class="log-type ${l.type}">[${l.type.toUpperCase()}]</span>
      <span class="log-msg">${l.msg}</span>
    </div>`;
  }).join('');
}

// ─── RENDER BI ───────────────────────────────────────────
function renderBI() {
  const el = document.getElementById('biPanel');
  el.innerHTML = biMetrics.map(b => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--deep);border:1px solid var(--dim);border-radius:1px;">
      <span style="font-size:16px;">${b.icon}</span>
      <div>
        <div style="font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--muted);letter-spacing:1px;">${b.label}</div>
        <div style="font-family:'Rajdhani',sans-serif;font-weight:600;font-size:14px;color:var(--accent2);">${b.value}</div>
      </div>
    </div>
  `).join('');
}

// ─── UPTIME COUNTER ──────────────────────────────────────
let seconds = 4*3600 + 32*60 + 11;
function updateUptime() {
  seconds++;
  const h = String(Math.floor(seconds/3600)).padStart(2,'0');
  const m = String(Math.floor((seconds%3600)/60)).padStart(2,'0');
  const s = String(seconds%60).padStart(2,'0');
  const el = document.getElementById('uptimeDisplay');
  if(el) el.textContent = `${h}:${m}:${s}`;
}

// ─── RSSI JITTER ─────────────────────────────────────────
function jitterRSSI() {
  devices.forEach(d => {
    d.rssi += Math.round((Math.random()-0.5)*4);
    d.rssi = Math.max(-90, Math.min(-35, d.rssi));
  });
  renderSignalBars();
  renderDevices();
}

// ─── INIT ────────────────────────────────────────────────
renderSignalBars();
renderDevices();
renderEnergy();
renderLog();
renderBI();

setInterval(updateUptime, 1000);
setInterval(jitterRSSI, 2500);
setInterval(renderLog, 10000);
