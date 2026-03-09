// ── MAPEO DE FIELDS THINGSPEAK ────────────────────────────
const FIELD_MAP = {
  field1: { label: 'RSSI Promedio',        kpi: 'kpiRssi',      unit: ' dBm' },
  field2: { label: 'Dispositivos',         kpi: 'kpiDevices',   unit: '' },
  field3: { label: 'Ocupación',            kpi: 'kpiOccupancy', unit: '%' },
  field4: { label: 'RSSI Mínimo',          kpi: null,           unit: ' dBm' },
  field5: { label: 'RSSI Máximo',          kpi: null,           unit: ' dBm' },
  field6: { label: 'Índice Energético',    kpi: 'kpiEnergy',    unit: '' },
  field7: { label: 'Zonas Activas',        kpi: 'kpiZones',     unit: '' },
  field8: { label: 'Alertas Activas',      kpi: 'kpiAlerts',    unit: '' },
};

// Colores para las 4 zonas de señal (A más cercana, D más lejana)
const ZONE_COLORS = {
  'Zona A': '#00e5ff',
  'Zona B': '#10b981',
  'Zona C': '#f59e0b',
  'Zona D': '#ef4444',
};

// ── ESTADO GLOBAL ─────────────────────────────────────────
// Todas estas variables se alimentan de la Raspberry Pi y ThingSpeak.
// No hay ningún dato hardcodeado.
let devices     = [];   // ← Raspberry → .devices[]
let zones       = [];   // ← Raspberry → .zones[]
let logMessages = [];   // ← Raspberry → .log[]
let biData      = null; // ← Raspberry → .bi{}

let pollingTimer  = null;
let uptimeTimer   = null;
let uptimeSeconds = 0;
let prevValues    = {};
let historyRssi   = [];
let historyDevs   = [];
let historyTimes  = [];


// ═══════════════════════════════════════════════════════════
// LOG Y ERRORES
// ═══════════════════════════════════════════════════════════

function addLog(level, msg) {
  const el  = document.getElementById('logEntries');
  const now = new Date().toLocaleTimeString('es-ES');
  const cls = level === 'WARN' ? 'log-level-warn'
            : level === 'ERR'  ? 'log-level-err'
            : 'log-level-info';
  el.insertAdjacentHTML('afterbegin',
    `<div class="log-line">
       <span class="log-time">${now}</span>
       <span class="${cls}">${level}</span>
       <span>${msg}</span>
     </div>`
  );
  if (el.children.length > 60) el.lastChild.remove();
}

function clearLog() { document.getElementById('logEntries').innerHTML = ''; }

function showError(msg) {
  const b = document.getElementById('errorBanner');
  b.textContent = '⚠ ' + msg;
  b.classList.add('show');
  addLog('ERR', msg);
}

function hideError() {
  document.getElementById('errorBanner').classList.remove('show');
}


// ═══════════════════════════════════════════════════════════
// FETCH RASPBERRY PI  (fuente primaria — datos en vivo)
// ═══════════════════════════════════════════════════════════

async function fetchRaspi() {
  const url = document.getElementById('raspiUrl').value.trim();
  if (!url) return false;

  try {
    const resp = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    applyRaspiData(data);
    addLog('INFO', `Raspberry OK · ${data.device_count} dispositivos · RSSI avg ${data.rssi_avg} dBm`);
    return true;
  } catch (err) {
    addLog('WARN', `Raspberry no disponible: ${err.message}`);
    return false;
  }
}

function applyRaspiData(data) {
  // KPIs directos desde WiFi sniffing
  setKPI('kpiDevices',   data.device_count,  'field2');
  setKPI('kpiRssi',      data.rssi_avg,       'field1');
  setKPI('kpiOccupancy', data.occupancy_pct,  'field3');
  setKPI('kpiEnergy',    data.energy_index,   'field6');
  setKPI('kpiZones',     data.zone_count,     'field7');
  setKPI('kpiAlerts',    data.alert_count,    'field8');

  // Lista de dispositivos detectados (MAC + RSSI + zona)
  if (Array.isArray(data.devices) && data.devices.length > 0) {
    devices = data.devices;
    renderDevices();
  }

  // Distribución por zona de señal
  if (Array.isArray(data.zones) && data.zones.length > 0) {
    zones = data.zones;
    renderZoneBars();
  }

  // Log de eventos del nodo
  if (Array.isArray(data.log) && data.log.length > 0) {
    logMessages = data.log;
    renderRaspiLog();
  }

  // Business Intelligence
  if (data.bi) {
    biData = data.bi;
    renderBI();
  }

  // Uptime del nodo
  if (typeof data.uptime_seconds === 'number') {
    uptimeSeconds = data.uptime_seconds;
    startUptime();
  }

  setOnline();
  document.getElementById('lastUpdate').textContent =
    'ACTUALIZADO: ' + new Date().toLocaleTimeString('es-ES');
  document.getElementById('devListBadge').textContent =
    `${data.device_count || 0} activos`;
}


// ═══════════════════════════════════════════════════════════
// FETCH THINGSPEAK  (historial + fallback si no hay Raspberry)
// ═══════════════════════════════════════════════════════════

async function fetchThingSpeak() {
  const channelId = document.getElementById('channelId').value.trim();
  const apiKey    = document.getElementById('apiKey').value.trim();
  if (!channelId) return;

  const url = `https://api.thingspeak.com/channels/${channelId}/feeds.json?results=30${apiKey ? '&api_key=' + apiKey : ''}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    hideError();
    applyThingSpeakData(data);
    addLog('INFO', `ThingSpeak OK · ${data.feeds.length} registros históricos`);
  } catch (err) {
    showError(`ThingSpeak: ${err.message}`);
    setOffline();
  }
}

function applyThingSpeakData(data) {
  const feeds   = data.feeds;
  const channel = data.channel;

  document.getElementById('footerChannel').textContent =
    `CANAL THINGSPEAK: ${channel.name || channel.id}`;

  if (!feeds || feeds.length === 0) {
    addLog('WARN', 'ThingSpeak: sin feeds en el canal.');
    return;
  }

  const latest = feeds[feeds.length - 1];

  // Si no hay Raspberry configurada, ThingSpeak actúa como fuente de KPIs
  const raspiUrl = document.getElementById('raspiUrl').value.trim();
  if (!raspiUrl) {
    Object.entries(FIELD_MAP).forEach(([field, cfg]) => {
      const raw = latest[field];
      if (raw !== undefined && raw !== null && cfg.kpi) {
        const val = parseFloat(raw);
        const el  = document.getElementById(cfg.kpi);
        if (el) {
          el.innerHTML = isNaN(val) ? raw : (Number.isInteger(val) ? val : val.toFixed(1));
          updateTrend(field, val, prevValues[field]);
          prevValues[field] = val;
        }
      }
    });
    setOnline();
    document.getElementById('lastUpdate').textContent =
      'ACTUALIZADO (ThingSpeak): ' + new Date().toLocaleTimeString('es-ES');
  }

  // Tabla de fields (siempre visible)
  renderFieldsTable(latest);

  // Gráficas históricas (siempre desde ThingSpeak)
  historyTimes = feeds.map(f => {
    const d = new Date(f.created_at);
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  });
  historyRssi = feeds.map(f => parseFloat(f.field1) || 0);
  historyDevs = feeds.map(f => parseFloat(f.field2) || 0);

  drawLineChart('rssiChart', historyRssi, historyTimes, '#00e5ff', 'gradRssi', [-100, -20]);
  drawBarChart ('devChart',  historyDevs, historyTimes, '#7c3aed');

  document.getElementById('chartPoints').textContent   = `${feeds.length} puntos`;
  document.getElementById('devChartBadge').textContent = `MAX: ${Math.max(...historyDevs)}`;
}


// ═══════════════════════════════════════════════════════════
// RENDERS
// ═══════════════════════════════════════════════════════════

// Lista de dispositivos detectados
// Campos: MAC anonimizada · RSSI · Zona (basada en intensidad de señal)
function renderDevices() {
  const el = document.getElementById('deviceList');
  if (!el || devices.length === 0) {
    el.innerHTML = '<div class="empty-msg">Sin dispositivos detectados.</div>';
    return;
  }

  el.innerHTML = devices.map(d => {
    // Número de barras de señal según RSSI
    const bars = d.rssi >= -50 ? 4 : d.rssi >= -65 ? 3 : d.rssi >= -75 ? 2 : 1;
    const sigHtml = [5, 9, 13, 17].map((h, i) =>
      `<div class="sig-bar${i < bars ? ' on' : ''}" style="height:${h}px"></div>`
    ).join('');

    return `<div class="device-item">
      <div class="sig-bars">${sigHtml}</div>
      <div class="dev-mac">${d.mac || d.id || '—'}</div>
      <div class="dev-rssi">${d.rssi} dBm</div>
      <div class="dev-zone">${d.zone || '—'}</div>
    </div>`;
  }).join('');
}

// Barras de ocupación por zona de señal (A/B/C/D)
// Zona A = más cerca (RSSI ≥ −50), Zona D = más lejos (RSSI < −75)
function renderZoneBars() {
  const el = document.getElementById('zoneBars');
  if (!el || zones.length === 0) {
    el.innerHTML = '<div class="empty-msg">Sin datos de zona.</div>';
    return;
  }

  const maxPct = Math.max(...zones.map(z => z.pct), 1);

  el.innerHTML = zones.map(z => {
    const color = ZONE_COLORS[z.zone] || '#4a6580';
    const width = Math.round((z.pct / 100) * 100);
    return `<div class="zone-bar-row">
      <div class="zone-bar-label">${z.zone}</div>
      <div class="zone-bar-track">
        <div class="zone-bar-fill" style="width:${width}%;background:${color};"></div>
      </div>
      <div class="zone-bar-count" style="color:${color}">${z.pct}%</div>
    </div>`;
  }).join('');
}

// Log de eventos recibido de la Raspberry Pi
function renderRaspiLog() {
  const el  = document.getElementById('logEntries');
  if (!el || logMessages.length === 0) return;
  const now = new Date();
  const cls = t => t === 'alert' ? 'log-level-err'
                 : t === 'warn'  ? 'log-level-warn'
                 : 'log-level-info';
  el.innerHTML = logMessages.map((l, i) => {
    const t  = new Date(now - i * 15000);
    const ts = String(t.getHours()).padStart(2,'0') + ':' +
               String(t.getMinutes()).padStart(2,'0') + ':' +
               String(t.getSeconds()).padStart(2,'0');
    return `<div class="log-line">
      <span class="log-time">${ts}</span>
      <span class="${cls(l.type)}">[${(l.type||'info').toUpperCase()}]</span>
      <span>${l.msg}</span>
    </div>`;
  }).join('');
}

// Business Intelligence calculado desde el sniffing WiFi
function renderBI() {
  const el = document.getElementById('biPanel');
  if (!el || !biData) return;

  const items = [
    { icon: '📊', label: 'Hora pico',             value: biData.peak_hour     || '—' },
    { icon: '📍', label: 'Zona más activa',        value: biData.top_zone      || '—' },
    { icon: '⏱',  label: 'Estancia media',         value: `${biData.avg_stay_min || '—'} min` },
    { icon: '🔢', label: 'Pico máximo hoy',        value: `${biData.peak_count || '—'} dev · ${biData.peak_time || '—'}` },
  ];

  el.innerHTML = `<div class="bi-grid">${
    items.map(b => `
      <div class="bi-item">
        <span class="bi-icon">${b.icon}</span>
        <div>
          <div class="bi-label">${b.label}</div>
          <div class="bi-value">${b.value}</div>
        </div>
      </div>`).join('')
  }</div>`;
}

// Tabla con el último valor de cada field de ThingSpeak
function renderFieldsTable(latest) {
  const tbody = document.getElementById('fieldsTableBody');
  if (!tbody) return;

  tbody.innerHTML = Object.entries(FIELD_MAP).map(([field, cfg]) => {
    const raw = latest[field];
    const val = (raw !== null && raw !== undefined && raw !== '')
      ? (isNaN(parseFloat(raw)) ? raw : parseFloat(raw).toFixed(2))
      : '—';
    return `<tr>
      <td><span class="field-tag">${field.toUpperCase()}</span></td>
      <td style="color:var(--muted)">${cfg.label}</td>
      <td class="field-val">${val}${raw ? cfg.unit : ''}</td>
    </tr>`;
  }).join('');
}


// ═══════════════════════════════════════════════════════════
// HELPERS — KPI + TENDENCIA
// ═══════════════════════════════════════════════════════════

function setKPI(kpiId, rawVal, fieldKey) {
  const el = document.getElementById(kpiId);
  if (!el || rawVal === undefined || rawVal === null) return;
  const val = parseFloat(rawVal);
  el.innerHTML = isNaN(val) ? rawVal : (Number.isInteger(val) ? val : val.toFixed(1));
  updateTrend(fieldKey, val, prevValues[fieldKey]);
  prevValues[fieldKey] = val;
}

function updateTrend(field, current, prev) {
  const map = {
    field1: 'trendRssi', field2: 'trendDevices',
    field3: 'trendOcc',  field6: 'trendEnergy',
    field7: 'trendZones',field8: 'trendAlerts',
  };
  const el = document.getElementById(map[field]);
  if (!el || prev === undefined) return;
  const diff = (current - prev).toFixed(1);
  if (diff > 0)      { el.textContent = `▲ +${diff}`; el.className = 'kpi-trend trend-up'; }
  else if (diff < 0) { el.textContent = `▼ ${diff}`;  el.className = 'kpi-trend trend-down'; }
  else               { el.textContent = '— 0';         el.className = 'kpi-trend trend-neutral'; }
}


// ═══════════════════════════════════════════════════════════
// UPTIME
// ═══════════════════════════════════════════════════════════

function startUptime() {
  if (uptimeTimer) clearInterval(uptimeTimer);
  uptimeTimer = setInterval(() => {
    uptimeSeconds++;
    const h = String(Math.floor(uptimeSeconds / 3600)).padStart(2,'0');
    const m = String(Math.floor((uptimeSeconds % 3600) / 60)).padStart(2,'0');
    const s = String(uptimeSeconds % 60).padStart(2,'0');
    const el = document.getElementById('uptimeDisplay');
    if (el) el.textContent = `${h}:${m}:${s}`;
  }, 1000);
}


// ═══════════════════════════════════════════════════════════
// GRÁFICAS SVG
// ═══════════════════════════════════════════════════════════

function drawLineChart(svgId, values, labels, color, gradId, yRange) {
  const svg = document.getElementById(svgId);
  if (!svg || values.length < 2) return;

  const W = 600, H = 180, p = { t:10, b:30, l:10, r:10 };
  const min    = yRange ? yRange[0] : Math.min(...values) - 5;
  const max    = yRange ? yRange[1] : Math.max(...values) + 5;
  const xStep  = (W - p.l - p.r) / (values.length - 1);
  const yScale = v => p.t + (H - p.t - p.b) * (1 - (v - min) / (max - min));
  const pts    = values.map((v, i) => `${p.l + i * xStep},${yScale(v)}`).join(' ');
  const area   = `${p.l + (values.length-1)*xStep},${H-p.b} ${p.l},${H-p.b}`;

  let ticks = '';
  values.forEach((v, i) => {
    if (i % 5 === 0)
      ticks += `<text x="${p.l + i*xStep}" y="${H-8}" text-anchor="middle" fill="#4a6580" font-family="Space Mono" font-size="8">${labels[i]||''}</text>`;
  });

  svg.innerHTML = `
    <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="${color}" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    ${[0.25,0.5,0.75].map(f=>`<line x1="${p.l}" y1="${p.t+(H-p.t-p.b)*f}" x2="${W-p.r}" y2="${p.t+(H-p.t-p.b)*f}" stroke="#1a2e42" stroke-width="1" stroke-dasharray="4,4"/>`).join('')}
    <polygon points="${pts} ${area}" fill="url(#${gradId})"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    ${values.map((v,i)=>`<circle cx="${p.l+i*xStep}" cy="${yScale(v)}" r="2.5" fill="${color}" opacity="0.7"/>`).join('')}
    ${ticks}
    <text x="${W-p.r-4}" y="${yScale(values[values.length-1])-8}" text-anchor="end" fill="${color}" font-family="Space Mono" font-size="10" font-weight="bold">${values[values.length-1].toFixed(1)}</text>
  `;
}

function drawBarChart(svgId, values, labels, color) {
  const svg = document.getElementById(svgId);
  if (!svg || values.length < 1) return;

  const W = 600, H = 180, p = { t:10, b:30, l:10, r:10 };
  const max  = Math.max(...values, 1);
  const barW = (W - p.l - p.r) / values.length * 0.7;
  const gap  = (W - p.l - p.r) / values.length;
  let bars = '';

  values.forEach((v, i) => {
    const bH = (v / max) * (H - p.t - p.b);
    const x  = p.l + i * gap + (gap - barW) / 2;
    bars += `<rect x="${x}" y="${H-p.b-bH}" width="${barW}" height="${bH}" fill="${color}" opacity="${0.4+(v/max)*0.6}" rx="2"/>`;
    if (i % 5 === 0)
      bars += `<text x="${x+barW/2}" y="${H-8}" text-anchor="middle" fill="#4a6580" font-family="Space Mono" font-size="8">${labels[i]||''}</text>`;
  });

  svg.innerHTML = `
    ${[0.25,0.5,0.75,1].map(f=>{
      const y = p.t+(H-p.t-p.b)*(1-f);
      return `<line x1="${p.l}" y1="${y}" x2="${W-p.r}" y2="${y}" stroke="#1a2e42" stroke-width="1" stroke-dasharray="4,4"/>
              <text x="${p.l+2}" y="${y-3}" fill="#4a6580" font-family="Space Mono" font-size="8">${Math.round(max*f)}</text>`;
    }).join('')}
    ${bars}
  `;
}


// ═══════════════════════════════════════════════════════════
// ESTADO DE CONEXIÓN
// ═══════════════════════════════════════════════════════════

function setOnline() {
  document.getElementById('statusDot').className    = 'status-dot';
  document.getElementById('statusText').textContent = 'EN LÍNEA';
}

function setOffline() {
  document.getElementById('statusDot').className    = 'status-dot offline';
  document.getElementById('statusText').textContent = 'SIN CONEXIÓN';
}


// ═══════════════════════════════════════════════════════════
// POLLING
// ═══════════════════════════════════════════════════════════

async function fetchAll() {
  const raspiOk = await fetchRaspi();
  await fetchThingSpeak();
  if (!raspiOk && !document.getElementById('raspiUrl').value.trim()) setOffline();
}

function startPolling() {
  stopPolling();
  addLog('INFO', 'Conectando con Raspberry Pi y ThingSpeak...');
  fetchAll();
  const ms = parseInt(document.getElementById('intervalSel').value);
  if (ms > 0) {
    pollingTimer = setInterval(fetchAll, ms);
    addLog('INFO', `Polling cada ${ms / 1000}s`);
  }
}

function stopPolling() {
  if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; addLog('INFO', 'Polling detenido.'); }
  if (uptimeTimer)  { clearInterval(uptimeTimer);  uptimeTimer  = null; }
}


// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════

addLog('INFO', 'NAYAR listo. Introduce las credenciales y pulsa CONECTAR.');

// Restaurar config guardada
try {
  const saved = localStorage.getItem('nayar_cfg');
  if (saved) {
    const cfg = JSON.parse(saved);
    if (cfg.channelId) document.getElementById('channelId').value = cfg.channelId;
    if (cfg.apiKey)    document.getElementById('apiKey').value    = cfg.apiKey;
    if (cfg.raspiUrl)  document.getElementById('raspiUrl').value  = cfg.raspiUrl;
    addLog('INFO', 'Configuración restaurada.');
  }
} catch(e) {}

// Guardar config al cambiar cualquier input
['channelId','apiKey','raspiUrl'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    try {
      localStorage.setItem('nayar_cfg', JSON.stringify({
        channelId: document.getElementById('channelId').value,
        apiKey:    document.getElementById('apiKey').value,
        raspiUrl:  document.getElementById('raspiUrl').value,
      }));
    } catch(e) {}
  });
});