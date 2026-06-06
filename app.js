// ===== Constants =====
const ANNUAL_LIMIT = 1729;
const BASE_DAILY = 0.5;
const GAS_YEAR_MONTH = 5;
const GAS_YEAR_DAY = 1;
const SHEET_NAME = 'Leolvasások';
const TEMP_SHEET_NAME = 'Hőmérséklet';
const SHEET_HEADER = ['Dátum', 'Állás (m³)', 'Megjegyzés'];
const API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const WEATHER_LAT = 46.788;
const WEATHER_LON = 17.193;

// ===== State =====
let accessToken = null;
let tokenClient = null;
let spreadsheetId = localStorage.getItem('gazora_sheet_id') || null;
let tempSpreadsheetId = localStorage.getItem('gazora_temp_sheet_id') || null;
let clientId = localStorage.getItem('gazora_client_id') || null;
let readings = [];   // [{date, value, notes}] sorted ascending
let temperatures = {};  // date string → °C
let charts = {};
let selectedYear = null;
let tokenRefreshTimer = null;

// ===== Gas year helpers =====

function gasYearStart(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getMonth() >= 5 ? d.getFullYear() : d.getFullYear() - 1;
  return new Date(y, 5, 1);   // June 1
}

function gasYearEnd(date) {
  const start = gasYearStart(date);
  return new Date(start.getFullYear() + 1, 4, 31, 23, 59, 59);  // May 31 next year
}

function gasYearLabel(date) {
  const start = gasYearStart(date);
  return `${start.getFullYear()}/${start.getFullYear() + 1}`;
}

function allGasYears() {
  if (!readings.length) return [];
  const first = gasYearStart(readings[0].date);
  const last = gasYearStart(new Date());
  const years = [];
  let cur = new Date(first);
  while (cur <= last) {
    years.push(new Date(cur));
    cur = new Date(cur.getFullYear() + 1, 5, 1);
  }
  return years;
}

function toISODate(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

function parseDate(s) {
  // Handle DD.MM.YYYY, DD/MM/YYYY, YYYY-MM-DD
  s = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s);
  const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`);
  return new Date(s);
}

function daysBetween(a, b) {
  return (new Date(b) - new Date(a)) / 86400000;
}

function fmt(n, decimals = 1) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toFixed(decimals).replace('.', ',');
}

// ===== Sheets API =====

async function sheetsRequest(path, opts = {}, sid) {
  if (!accessToken) await ensureToken();
  const sheetId = sid || spreadsheetId;
  const url = path.startsWith('http') ? path : `${API_BASE}/${sheetId}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...opts.headers }
  });
  if (res.status === 401) {
    accessToken = null;
    await ensureToken();
    return sheetsRequest(path, opts, sid);
  }
  if (!res.ok) throw new Error(`Sheets API hiba: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sheetsRead(range) {
  const r = await sheetsRequest(`/values/${encodeURIComponent(range)}`);
  return r.values || [];
}

async function sheetsAppend(range, values) {
  return sheetsRequest(
    `/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values }) }
  );
}

async function sheetsBatchUpdate(requests) {
  return sheetsRequest('/batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
}

async function createSpreadsheet() {
  const body = {
    properties: { title: 'Gázóra leolvasások', locale: 'hu_HU' },
    sheets: [{
      properties: { title: SHEET_NAME, sheetId: 0 },
      data: [{ rowData: [{ values: SHEET_HEADER.map(v => ({ userEnteredValue: { stringValue: v } })) }] }]
    }]
  };
  const r = await sheetsRequest('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST', body: JSON.stringify(body)
  });
  return r.spreadsheetId;
}

async function ensureSpreadsheet() {
  if (!spreadsheetId) {
    spreadsheetId = await createSpreadsheet();
    localStorage.setItem('gazora_sheet_id', spreadsheetId);
    showToast('Új Google Sheets táblázat létrehozva');
  }
  return spreadsheetId;
}

async function loadReadings() {
  await ensureSpreadsheet();
  const rows = await sheetsRead(`${SHEET_NAME}!A:C`);
  if (rows.length < 2) return;
  readings = rows.slice(1)
    .filter(r => r[0] && r[1])
    .map(r => ({ date: toISODate(parseDate(r[0])), value: parseFloat(r[1]), notes: r[2] || '' }))
    .filter(r => !isNaN(r.value) && r.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  // Remove duplicates (same date → keep last)
  const seen = {};
  readings.forEach(r => { seen[r.date] = r; });
  readings = Object.values(seen).sort((a, b) => a.date.localeCompare(b.date));
  computeCumulative();
}

function computeCumulative() {
  if (!readings.length) return;
  readings[0].cumulative = 0;
  readings[0].meterReplacement = false;
  for (let i = 1; i < readings.length; i++) {
    const delta = readings[i].value - readings[i - 1].value;
    if (delta < 0) {
      // Meter replacement: estimate gap consumption from previous daily rate
      const gapDays = daysBetween(readings[i - 1].date, readings[i].date);
      let prevRate = BASE_DAILY;
      if (i >= 2) {
        const prevDays = daysBetween(readings[i - 2].date, readings[i - 1].date);
        if (prevDays > 0) prevRate = (readings[i - 1].value - readings[i - 2].value) / prevDays;
      }
      readings[i].cumulative = readings[i - 1].cumulative + Math.max(0, prevRate * gapDays);
      readings[i].meterReplacement = true;
    } else {
      readings[i].cumulative = readings[i - 1].cumulative + delta;
      readings[i].meterReplacement = false;
    }
  }
}

async function saveReading(date, value, notes) {
  await ensureSpreadsheet();
  const isoDate = toISODate(parseDate(date));
  // Check if date already exists → update instead of append
  const rows = await sheetsRead(`${SHEET_NAME}!A:A`);
  const rowIdx = rows.findIndex((r, i) => i > 0 && r[0] && toISODate(parseDate(r[0])) === isoDate);
  if (rowIdx > 0) {
    const range = `${SHEET_NAME}!A${rowIdx + 1}:C${rowIdx + 1}`;
    await sheetsRequest(`/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
      method: 'PUT', body: JSON.stringify({ values: [[isoDate, value, notes || '']] })
    });
  } else {
    await sheetsAppend(`${SHEET_NAME}!A:C`, [[isoDate, value, notes || '']]);
  }
  await loadReadings();
  notifyServiceWorker();
}

async function batchImport(rows) {
  await ensureSpreadsheet();
  await sheetsAppend(`${SHEET_NAME}!A:C`, rows);
  await loadReadings();
}

// ===== Statistics =====

function getReadingsInPeriod(start, end) {
  const s = toISODate(start), e = toISODate(end);
  return readings.filter(r => r.date >= s && r.date <= e);
}

function interpolateValue(date) {
  const d = toISODate(date);
  const before = [...readings].reverse().find(r => r.date <= d);
  const after = readings.find(r => r.date >= d);
  if (!before && !after) return null;
  if (!before) return after.cumulative;
  if (!after) return before.cumulative;
  if (before.date === after.date) return before.cumulative;
  // Don't interpolate across a meter replacement — hold previous cumulative until new meter's first reading
  if (after.meterReplacement) return before.cumulative;
  const total = daysBetween(before.date, after.date);
  const elapsed = daysBetween(before.date, d);
  return before.cumulative + (after.cumulative - before.cumulative) * (elapsed / total);
}

function gasYearStats(yearStart) {
  const yearEnd = new Date(yearStart.getFullYear() + 1, 4, 31);
  const now = new Date();
  const effectiveEnd = now < yearEnd ? now : yearEnd;

  const startVal = interpolateValue(yearStart);
  const endVal = interpolateValue(effectiveEnd);
  if (startVal == null || endVal == null) return null;
  const total = endVal - startVal;
  const daysElapsed = daysBetween(yearStart, effectiveEnd);
  const dailyAvg = daysElapsed > 0 ? total / daysElapsed : 0;

  // Heating season: Oct 1 – Apr 30
  const heatingStart = new Date(yearStart.getFullYear(), 9, 1);
  const heatingEnd = new Date(yearStart.getFullYear() + 1, 3, 30);
  const hsStart = heatingStart < yearStart ? yearStart : heatingStart;
  const hsEnd = heatingEnd > effectiveEnd ? effectiveEnd : heatingEnd;
  let heatingTotal = 0;
  if (hsEnd > hsStart) {
    const hsStartVal = interpolateValue(hsStart);
    const hsEndVal = interpolateValue(hsEnd);
    if (hsStartVal != null && hsEndVal != null) heatingTotal = hsEndVal - hsStartVal;
  }

  return {
    label: gasYearLabel(yearStart),
    yearStart,
    total: Math.max(0, total),
    dailyAvg,
    heatingTotal: Math.max(0, heatingTotal),
    hotWaterTotal: Math.max(0, total - heatingTotal),
    daysElapsed,
    isCurrentYear: now <= yearEnd && now >= yearStart
  };
}

function computeMonthlySeasonalAvg() {
  // Average daily consumption per calendar month, across all recorded years
  const buckets = Array.from({ length: 12 }, () => []);
  for (let i = 1; i < readings.length; i++) {
    if (readings[i].meterReplacement) continue;
    const days = daysBetween(readings[i - 1].date, readings[i].date);
    if (days <= 0 || days > 14) continue;
    const perDay = (readings[i].value - readings[i - 1].value) / days;
    if (perDay < 0) continue;
    const mid = new Date((new Date(readings[i - 1].date).getTime() + new Date(readings[i].date).getTime()) / 2);
    buckets[mid.getMonth()].push(perDay);
  }
  return buckets.map(vals => vals.length ? vals.reduce((a, b) => a + b) / vals.length : BASE_DAILY);
}

function projectWithSeasonalPattern(usedSoFar) {
  const monthly = computeMonthlySeasonalAvg();
  const today = new Date();
  const yearEnd = new Date(gasYearStart(today).getFullYear() + 1, 4, 31);
  let projected = usedSoFar;
  // Step through remaining days, using the historical monthly average for each
  const cur = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  while (cur <= yearEnd) {
    projected += monthly[cur.getMonth()];
    cur.setDate(cur.getDate() + 1);
  }
  return projected;
}

function currentYearProgress() {
  const start = gasYearStart(new Date());
  const stats = gasYearStats(start);
  if (!stats) return null;
  const used = stats.total;
  const pct = Math.min(100, (used / ANNUAL_LIMIT) * 100);
  const projected = projectWithSeasonalPattern(used);
  return { used, pct, projected, stats };
}

function dailyConsumptions() {
  const result = [];
  for (let i = 1; i < readings.length; i++) {
    if (readings[i].meterReplacement) continue;
    const days = daysBetween(readings[i - 1].date, readings[i].date);
    if (days > 0 && days <= 30) {
      result.push({ date: readings[i].date, perDay: (readings[i].value - readings[i - 1].value) / days });
    }
  }
  return result;
}

function rollingAvg(days) {
  if (!readings.length) return null;
  const cutoff = toISODate(new Date(Date.now() - days * 86400000));
  const last = readings[readings.length - 1];
  const first = readings.find(r => r.date >= cutoff);
  if (!first || first.date === last.date) return null;
  const d = daysBetween(first.date, last.date);
  return d > 0 ? (last.cumulative - first.cumulative) / d : null;
}

// ===== UI helpers =====

function showScreen(id) {
  ['setup-screen', 'auth-screen', 'loading-screen'].forEach(s => {
    const el = document.getElementById(s);
    el.classList.toggle('active', s === id);
  });
  document.getElementById('app').style.display = id ? 'none' : 'flex';
  if (!id) document.getElementById('app').style.display = 'flex';
}

function showApp() {
  ['setup-screen', 'auth-screen', 'loading-screen'].forEach(s => {
    document.getElementById(s).classList.remove('active');
  });
  document.getElementById('app').style.display = 'flex';
}

function showToast(msg, dur = 3000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), dur);
}

function setTab(tab) {
  document.querySelectorAll('#content section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${tab}`)?.classList.add('active');
  document.querySelector(`.nav-btn[data-tab="${tab}"]`)?.classList.add('active');
  if (tab === 'stats') renderStats();
  if (tab === 'history') renderHistory();
}

// ===== Dashboard rendering =====

function updateDashboard() {
  if (!readings.length) return;

  const last = readings[readings.length - 1];
  document.getElementById('last-reading-value').textContent = `${fmt(last.value, 3)} m³`;
  const daysAgo = Math.floor(daysBetween(last.date, new Date()));
  document.getElementById('last-reading-date').textContent =
    `${last.date.replace(/-/g, '.')} — ${daysAgo === 0 ? 'ma' : daysAgo + ' napja'}`;

  const statusCard = document.getElementById('status-card');
  statusCard.className = 'status-card';
  if (daysAgo > 14) statusCard.classList.add('danger');
  else if (daysAgo > 7) statusCard.classList.add('warning');
  else statusCard.classList.add('success');

  // Annual progress
  const progress = currentYearProgress();
  if (progress) {
    const { used, pct, projected } = progress;
    document.getElementById('used-label').textContent = `${fmt(used, 0)} m³ felhasználva`;
    document.getElementById('remaining-label').textContent = `${fmt(ANNUAL_LIMIT - used, 0)} m³ marad`;
    const fill = document.getElementById('annual-progress');
    fill.style.width = `${pct}%`;
    fill.className = 'progress-fill' + (pct > 90 ? ' danger' : pct > 75 ? ' warning' : '');

    const projText = projected > ANNUAL_LIMIT
      ? `⚠️ Szezonális minta alapján várható éves fogyasztás: ${fmt(projected, 0)} m³ — TÚLLÉPI a ${ANNUAL_LIMIT} m³-es keretet!`
      : `Szezonális minta alapján várható éves fogyasztás: ${fmt(projected, 0)} m³ (keret: ${ANNUAL_LIMIT} m³)`;
    document.getElementById('projection-text').textContent = projText;
  }

  // Daily stats
  const avg7 = rollingAvg(7);
  const avg30 = rollingAvg(30);
  const yearStart = gasYearStart(new Date());
  const yearStartReading = interpolateValue(yearStart);
  const yearStartStr = yearStartReading != null ? fmt(yearStartReading, 0) : '—';

  document.getElementById('avg-7').textContent = avg7 != null ? fmt(avg7, 2) : '—';
  document.getElementById('avg-30').textContent = avg30 != null ? fmt(avg30, 2) : '—';
  document.getElementById('today-est').textContent = avg7 != null ? fmt(avg7, 2) : '—';
  document.getElementById('year-start-val').textContent = yearStartStr;
}

// ===== History rendering =====

function renderHistory() {
  const filter = document.getElementById('history-search')?.value?.trim().toLowerCase() || '';
  const container = document.getElementById('readings-list');
  const sorted = [...readings].reverse();
  const filtered = filter ? sorted.filter(r => r.date.includes(filter) || r.notes.toLowerCase().includes(filter)) : sorted;

  if (!filtered.length) {
    container.innerHTML = '<div class="empty"><div class="icon">📋</div><p>Nincs találat</p></div>';
    return;
  }

  const readingMap = {};
  readings.forEach(r => { readingMap[r.date] = r.value; });

  container.innerHTML = filtered.map((r) => {
    const origIdx = readings.indexOf(r);
    let delta = '—';
    let deltaClass = '';
    if (r.meterReplacement) {
      delta = '🔄 ÓRACSERE';
      deltaClass = ' high';
    } else if (origIdx > 0) {
      const prev = readings[origIdx - 1];
      const days = daysBetween(prev.date, r.date);
      if (days > 0) {
        const perDay = (r.value - prev.value) / days;
        delta = `${fmt(r.value - prev.value, 2)} m³ (${fmt(perDay, 2)} m³/nap, ${days} nap)`;
        if (perDay > 15) deltaClass = ' high';
      }
    }
    return `<div class="reading-item">
      <div class="reading-date">${r.date.replace(/-/g, '.')}</div>
      <div class="reading-value">${fmt(r.value, 3)}</div>
      <div class="reading-delta${deltaClass}">${delta}${r.notes ? '<br><i style="font-weight:400;font-size:11px">' + r.notes + '</i>' : ''}</div>
    </div>`;
  }).join('');
}

// ===== Stats rendering =====

function renderStats() {
  const years = allGasYears();
  if (!years.length) return;

  // Year tabs
  const tabsEl = document.getElementById('year-tabs');
  tabsEl.innerHTML = years.map(y => {
    const lbl = gasYearLabel(y);
    return `<button class="year-tab${lbl === selectedYear ? ' active' : ''}" data-year="${y.toISOString()}">${lbl}</button>`;
  }).join('');
  tabsEl.querySelectorAll('.year-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedYear = gasYearLabel(new Date(btn.dataset.year));
      renderStats();
    });
  });
  if (!selectedYear) selectedYear = gasYearLabel(new Date());

  const activeYear = years.find(y => gasYearLabel(y) === selectedYear) || years[years.length - 1];
  renderYearDetail(activeYear);
  renderCumulativeChart(years);
  renderMonthlyChart(years);
  renderCorrelationChart();
}

function renderYearDetail(yearStart) {
  const stats = gasYearStats(yearStart);
  if (!stats) return;
  document.getElementById('selected-year-label').textContent = `${stats.label} részletei`;
  document.getElementById('year-total').textContent = fmt(stats.total, 0);
  document.getElementById('year-daily-avg').textContent = fmt(stats.dailyAvg, 2);
  document.getElementById('year-heating').textContent = fmt(stats.heatingTotal, 0);
  document.getElementById('year-hot-water').textContent = fmt(stats.hotWaterTotal, 0);
}

const YEAR_COLORS = ['#1565C0', '#E65100', '#2E7D32', '#6A1B9A', '#00838F', '#AD1457', '#37474F'];

function renderCumulativeChart(years) {
  const ctx = document.getElementById('chart-cumulative');
  if (charts.cumulative) charts.cumulative.destroy();

  const datasets = years.map((yearStart, i) => {
    const yEnd = new Date(yearStart.getFullYear() + 1, 4, 31);
    const now = new Date();
    const effectiveEnd = now < yEnd ? now : yEnd;
    const startVal = interpolateValue(yearStart);
    const data = [];

    // Monthly data points
    let cur = new Date(yearStart);
    while (cur <= effectiveEnd) {
      const v = interpolateValue(cur);
      if (v != null && startVal != null) {
        const monthIdx = ((cur.getMonth() - 5 + 12) % 12);
        data.push({ x: monthIdx, y: Math.max(0, v - startVal) });
      }
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }

    const color = YEAR_COLORS[i % YEAR_COLORS.length];
    return {
      label: gasYearLabel(yearStart),
      data,
      borderColor: color,
      backgroundColor: color + '22',
      tension: 0.3,
      fill: false,
      pointRadius: 3
    };
  });

  const monthLabels = ['jún', 'júl', 'aug', 'szep', 'okt', 'nov', 'dec', 'jan', 'feb', 'már', 'ápr', 'máj'];
  charts.cumulative = new Chart(ctx, {
    type: 'line',
    data: { labels: monthLabels, datasets },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12 } },
        annotation: {
          annotations: {
            limit: { type: 'line', yMin: ANNUAL_LIMIT, yMax: ANNUAL_LIMIT, borderColor: '#C62828', borderWidth: 2, borderDash: [6, 3], label: { content: '1729 m³', enabled: true, position: 'end' } }
          }
        }
      },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: 'm³' } },
        x: { title: { display: true, text: 'Hónap' } }
      }
    }
  });
}

function renderMonthlyChart(years) {
  const ctx = document.getElementById('chart-monthly');
  if (charts.monthly) charts.monthly.destroy();

  const monthLabels = ['jan', 'feb', 'már', 'ápr', 'máj', 'jún', 'júl', 'aug', 'szep', 'okt', 'nov', 'dec'];
  const consumptionDatasets = years.slice(-3).map((yearStart, i) => {
    const data = Array(12).fill(null);
    for (let m = 0; m < 12; m++) {
      const mStart = new Date(yearStart.getFullYear() + (m >= 6 ? 1 : 0), m < 6 ? m + 6 : m - 6, 1);
      const mEnd = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0);
      const sVal = interpolateValue(mStart);
      const eVal = interpolateValue(mEnd);
      if (sVal != null && eVal != null) data[mStart.getMonth()] = Math.max(0, eVal - sVal);
    }
    return { label: gasYearLabel(yearStart), data, backgroundColor: YEAR_COLORS[i % YEAR_COLORS.length] + 'BB', yAxisID: 'y' };
  });

  // Monthly average temperature across all available data
  const tempData = Array(12).fill(null).map((_, m) => {
    const vals = Object.entries(temperatures)
      .filter(([d]) => new Date(d).getMonth() === m)
      .map(([, t]) => t);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b) / vals.length * 10) / 10 : null;
  });

  const hasTempData = tempData.some(v => v !== null);
  if (hasTempData) {
    consumptionDatasets.push({
      label: 'Átlaghőmérséklet (°C)',
      data: tempData,
      type: 'line',
      yAxisID: 'y2',
      borderColor: '#E65100',
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 4,
      tension: 0.3,
      order: 0
    });
  }

  charts.monthly = new Chart(ctx, {
    type: 'bar',
    data: { labels: monthLabels, datasets: consumptionDatasets },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: 'm³' } },
        y2: {
          position: 'right',
          title: { display: true, text: '°C' },
          grid: { drawOnChartArea: false },
          ticks: { color: '#E65100' }
        }
      }
    }
  });
}

function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const num = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
  const den = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  if (den === 0) return null;
  const slope = num / den;
  const intercept = my - slope * mx;
  const ssRes = points.reduce((s, p) => s + (p.y - (slope * p.x + intercept)) ** 2, 0);
  const ssTot = points.reduce((s, p) => s + (p.y - my) ** 2, 0);
  return { slope, intercept, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

function renderCorrelationChart() {
  const ctx = document.getElementById('chart-correlation');
  if (!ctx) return;
  if (charts.correlation) charts.correlation.destroy();

  // Collect (avgTemp, m³/day) pairs per reading interval
  const rawPoints = [];
  for (let i = 1; i < readings.length; i++) {
    if (readings[i].meterReplacement) continue;
    const days = daysBetween(readings[i - 1].date, readings[i].date);
    if (days <= 0 || days > 14) continue;
    const perDay = (readings[i].value - readings[i - 1].value) / days;
    if (perDay < 0) continue;

    const temps = [];
    let cur = new Date(readings[i - 1].date);
    const end = new Date(readings[i].date);
    while (cur < end) {
      const t = temperatures[toISODate(cur)];
      if (t !== undefined) temps.push(t);
      cur = new Date(cur.getTime() + 86400000);
    }
    if (temps.length >= Math.ceil(days * 0.5)) {
      rawPoints.push({
        x: Math.round(temps.reduce((a, b) => a + b) / temps.length * 10) / 10,
        y: Math.round(perDay * 100) / 100
      });
    }
  }

  if (!rawPoints.length) {
    ctx.closest('.card').style.display = 'none';
    return;
  }
  ctx.closest('.card').style.display = '';

  // Bin by 2°C
  const BIN = 2;
  const binMap = {};
  rawPoints.forEach(p => {
    const k = Math.floor(p.x / BIN) * BIN;
    if (!binMap[k]) binMap[k] = [];
    binMap[k].push(p.y);
  });
  const bins = Object.entries(binMap)
    .filter(([, v]) => v.length >= 2)
    .map(([t, v]) => {
      const mean = v.reduce((a, b) => a + b) / v.length;
      const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length);
      return { x: +t + BIN / 2, y: Math.round(mean * 100) / 100, n: v.length, sd };
    })
    .sort((a, b) => a.x - b.x);

  // Regression on raw points
  const reg = linearRegression(rawPoints);
  const tMin = Math.min(...rawPoints.map(p => p.x));
  const tMax = Math.max(...rawPoints.map(p => p.x));
  const regLine = reg ? Array.from({ length: Math.round((tMax - tMin) * 2 + 1) }, (_, i) => {
    const t = tMin + i * 0.5;
    return { x: Math.round(t * 10) / 10, y: Math.max(0, Math.round((reg.slope * t + reg.intercept) * 100) / 100) };
  }) : [];

  // Heating threshold: T where regression = BASE_DAILY
  const threshold = reg && reg.slope < 0 ? (BASE_DAILY - reg.intercept) / reg.slope : null;

  charts.correlation = new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'Nyers mérési pontok',
          data: rawPoints,
          backgroundColor: '#1565C018',
          borderColor: '#1565C033',
          borderWidth: 1,
          pointRadius: 3,
          order: 3
        },
        {
          label: '2°C-os átlagok',
          data: bins.map(b => ({ x: b.x, y: b.y })),
          backgroundColor: bins.map(b => `rgba(21,101,192,${Math.min(1, 0.4 + b.n * 0.05)})`),
          borderColor: '#0D47A1',
          borderWidth: 1.5,
          pointRadius: bins.map(b => Math.max(6, Math.min(18, 4 + Math.sqrt(b.n) * 2.5))),
          order: 1
        },
        ...(regLine.length > 1 ? [{
          label: `Trend (R²=${fmt(reg.r2, 3)}, ${fmt(reg.slope, 3)} m³/°C/nap)`,
          data: regLine,
          type: 'line',
          borderColor: '#E65100',
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderDash: [6, 3],
          pointRadius: 0,
          order: 2
        }] : [])
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: c => {
              if (c.datasetIndex === 1) {
                const b = bins[c.dataIndex];
                return `${c.parsed.x}°C → ${c.parsed.y} m³/nap  (n=${b?.n}, σ=±${fmt(b?.sd, 2)})`;
              }
              return `${c.parsed.x}°C → ${c.parsed.y} m³/nap`;
            }
          }
        }
      },
      scales: {
        x: { title: { display: true, text: 'Átlaghőmérséklet (°C)' } },
        y: { beginAtZero: true, title: { display: true, text: 'Fogyasztás (m³/nap)' } }
      }
    }
  });

  // Characteristic summary below chart
  const info = document.getElementById('correlation-info');
  if (info && reg) {
    const threshStr = threshold != null ? `${fmt(threshold, 1)}°C` : '—';
    const heatCoeff = reg.slope < 0 ? fmt(-reg.slope * 1000, 1) : '—';
    info.innerHTML =
      `<b>Ház fűtési karakterisztika:</b> &nbsp;` +
      `Fűtési küszöb: <b>${threshStr}</b> &nbsp;|&nbsp; ` +
      `Melegvíz alap: <b>~${fmt(Math.max(0, reg.intercept + reg.slope * (threshold || 18)), 2)} m³/nap</b> &nbsp;|&nbsp; ` +
      `Fűtési együttható: <b>${heatCoeff} l/°C/nap</b> &nbsp;|&nbsp; ` +
      `R²: <b>${fmt(reg.r2, 3)}</b> (${rawPoints.length} mérési pont)`;
  }
}

// ===== CSV Export =====

function exportCSV() {
  const lines = ['Dátum;Állás (m³);Megjegyzés', ...readings.map(r => `${r.date};${r.value};${r.notes}`)];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gazora_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

// ===== Temperature =====

async function ensureTemperatureSpreadsheet() {
  if (tempSpreadsheetId) return tempSpreadsheetId;
  // Create a separate spreadsheet for temperatures (avoids batchUpdate CORS issue)
  const r = await sheetsRequest('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: 'Gázóra – Hőmérséklet (Hévíz)', locale: 'hu_HU' },
      sheets: [{
        properties: { title: TEMP_SHEET_NAME, sheetId: 0 },
        data: [{ rowData: [{ values: [
          { userEnteredValue: { stringValue: 'Dátum' } },
          { userEnteredValue: { stringValue: 'Átlaghőmérséklet (°C)' } }
        ]}] }]
      }]
    })
  });
  tempSpreadsheetId = r.spreadsheetId;
  localStorage.setItem('gazora_temp_sheet_id', tempSpreadsheetId);
  return tempSpreadsheetId;
}

async function loadTemperatures() {
  if (!tempSpreadsheetId) { temperatures = {}; return; }
  try {
    const rows = await sheetsRequest(`/values/${encodeURIComponent(TEMP_SHEET_NAME + '!A:B')}`, {}, tempSpreadsheetId);
    temperatures = {};
    (rows.values || []).slice(1).forEach(r => {
      if (r[0] && r[1] !== undefined && r[1] !== '') {
        temperatures[r[0]] = parseFloat(String(r[1]).replace(',', '.'));
      }
    });
  } catch { temperatures = {}; }
}

async function fetchWeatherFromAPI(startDate, endDate) {
  // Try archive API first, fall back to historical forecast API
  const endpoints = [
    `https://archive-api.open-meteo.com/v1/archive?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_mean&timezone=Europe%2FBudapest`,
    `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_mean&timezone=Europe%2FBudapest`
  ];

  let lastErr;
  for (const url of endpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${body.slice(0, 120)}`);
      }
      const data = await resp.json();
      const result = {};
      if (data.daily?.time) {
        data.daily.time.forEach((date, i) => {
          const t = data.daily.temperature_2m_mean?.[i];
          if (t !== null && t !== undefined) result[date] = Math.round(t * 10) / 10;
        });
      }
      return result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Időjárás API nem elérhető (${lastErr?.message || 'ismeretlen hiba'}). Ellenőrizze az internetkapcsolatot vagy próbálja később.`);
}

async function syncTemperatures(onProgress) {
  onProgress?.('Hőmérséklet táblázat előkészítése…');
  const sid = await ensureTemperatureSpreadsheet();
  await loadTemperatures();
  if (!readings.length) throw new Error('Nincs leolvasási adat');

  const firstDate = readings[0].date;
  // Archive API lags ~5 days
  const safeEnd = toISODate(new Date(Date.now() - 5 * 86400000));

  const existingDates = Object.keys(temperatures).sort();
  const lastExisting = existingDates.length ? existingDates[existingDates.length - 1] : null;
  const fetchStart = lastExisting
    ? toISODate(new Date(new Date(lastExisting).getTime() + 86400000))
    : firstDate;

  if (fetchStart > safeEnd) return { added: 0, total: existingDates.length };

  onProgress?.(`Letöltés: ${fetchStart} → ${safeEnd}…`);
  const newTemps = await fetchWeatherFromAPI(fetchStart, safeEnd);

  const newRows = Object.entries(newTemps)
    .filter(([d]) => !temperatures[d])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([d, t]) => [d, t]);

  if (newRows.length) {
    onProgress?.(`${newRows.length} nap mentése Sheets-be…`);
    for (let i = 0; i < newRows.length; i += 500) {
      await sheetsRequest(
        `/values/${encodeURIComponent(TEMP_SHEET_NAME + '!A:B')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { method: 'POST', body: JSON.stringify({ values: newRows.slice(i, i + 500) }) },
        sid
      );
    }
    newRows.forEach(([d, t]) => { temperatures[d] = t; });
  }

  return { added: newRows.length, total: Object.keys(temperatures).length };
}

// ===== CSV Import =====

async function importCSV(file) {
  const sep = document.getElementById('csv-separator').value;
  const status = document.getElementById('import-status');
  status.textContent = 'Feldolgozás...';
  try {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) throw new Error('Üres fájl');

    // Detect header
    const headerLine = lines[0].toLowerCase();
    const cols = headerLine.split(sep === '\t' ? '\t' : sep);
    let dateIdx = -1, valueIdx = -1, notesIdx = -1;

    cols.forEach((c, i) => {
      const t = c.trim().replace(/"/g, '');
      if (/d[áa]tum|date|nap/.test(t)) dateIdx = i;
      else if (/[áa]ll[áa]s|[eé]rt[eé]k|value|m3|m³|fogyaszt/.test(t)) valueIdx = i;
      else if (/megjegyz|note|comment/.test(t)) notesIdx = i;
    });

    // Fallback: assume col 0 = date, col 1 = value
    if (dateIdx < 0) dateIdx = 0;
    if (valueIdx < 0) valueIdx = 1;

    const startLine = /^\d/.test(lines[0].split(sep)[dateIdx]?.trim()) ? 0 : 1;
    const rows = [];
    for (let i = startLine; i < lines.length; i++) {
      const parts = lines[i].split(sep === '\t' ? '\t' : sep).map(p => p.trim().replace(/^"|"$/g, ''));
      const dateRaw = parts[dateIdx];
      const valRaw = parts[valueIdx]?.replace(',', '.');
      if (!dateRaw || !valRaw) continue;
      const d = parseDate(dateRaw);
      const v = parseFloat(valRaw);
      if (isNaN(d.getTime()) || isNaN(v)) continue;
      const notes = notesIdx >= 0 ? parts[notesIdx] || '' : '';
      rows.push([toISODate(d), v, notes]);
    }

    if (!rows.length) throw new Error('Nem sikerült adatot beolvasni. Ellenőrizze az elválasztó karaktert.');
    status.textContent = `${rows.length} sor importálása...`;
    await batchImport(rows);
    status.textContent = `✅ ${rows.length} leolvasás sikeresen importálva.`;
    updateDashboard();
    showToast(`${rows.length} leolvasás importálva`);
  } catch (err) {
    status.textContent = `❌ Hiba: ${err.message}`;
    console.error(err);
  }
}

// ===== Notifications =====

function notifyServiceWorker() {
  const last = readings.length ? readings[readings.length - 1].date : null;
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'LAST_READING', date: last });
  }
}

async function requestNotificationPermission() {
  const perm = await Notification.requestPermission();
  updateNotifUI();
  if (perm === 'granted') {
    showToast('Értesítések engedélyezve');
    schedulePeriodicSync();
  } else {
    showToast('Értesítés engedély megtagadva');
  }
}

async function schedulePeriodicSync() {
  const reg = await navigator.serviceWorker.ready;
  // Register periodic sync (Chrome Android, PWA installed)
  if ('periodicSync' in reg) {
    try {
      await reg.periodicSync.register('check-reading', { minInterval: 12 * 3600 * 1000 });
    } catch (e) { console.log('Periodic sync not available:', e.message); }
  }
  // Schedule TimestampTrigger for next Saturday 8am (more reliable, Chrome 80+)
  if (reg.active) {
    reg.active.postMessage({ type: 'SCHEDULE_WEEKLY' });
  }
}

function updateNotifUI() {
  const perm = Notification.permission;
  const wrap = document.getElementById('notif-perm-wrap');
  const status = document.getElementById('notif-status');
  if (perm === 'default') {
    wrap.style.display = 'block';
    status.textContent = 'Az értesítések engedélyezéséhez kattintson a gombra.';
  } else if (perm === 'granted') {
    wrap.style.display = 'none';
    status.textContent = '✅ Értesítések engedélyezve';
  } else {
    wrap.style.display = 'none';
    status.textContent = '❌ Értesítések letiltva a böngészőben. Kézileg engedélyezze az oldal beállításaiban.';
  }

  const satCheck = localStorage.getItem('notif_saturday') === '1';
  const odCheck = localStorage.getItem('notif_overdue') === '1';
  document.getElementById('notif-saturday').checked = satCheck;
  document.getElementById('notif-overdue').checked = odCheck;
}

function checkOnOpen() {
  if (Notification.permission !== 'granted') return;
  const today = new Date();
  const lastKey = 'notif_last_shown';
  const todayStr = toISODate(today);
  if (localStorage.getItem(lastKey) === todayStr) return;
  localStorage.setItem(lastKey, todayStr);

  const dayOfWeek = today.getDay();
  const satEnabled = localStorage.getItem('notif_saturday') === '1';
  const odEnabled = localStorage.getItem('notif_overdue') === '1';
  const last = readings.length ? readings[readings.length - 1] : null;
  const daysAgo = last ? Math.floor(daysBetween(last.date, today)) : 999;

  if (dayOfWeek === 6 && satEnabled) {
    new Notification('Gázóra – heti leolvasás', { body: 'Szombat van – ideje leolvasni a gázórát!', icon: '/icon-192.svg', tag: 'weekly' });
  } else if (odEnabled && daysAgo > 7) {
    new Notification('Gázóra – késedelmes leolvasás', { body: `Utolsó leolvasás ${daysAgo} napja volt!`, icon: '/icon-192.svg', tag: 'overdue' });
  }
}

// ===== Google Auth =====

function ensureToken() {
  return new Promise((resolve, reject) => {
    if (accessToken) { resolve(); return; }
    tokenClient.callback = resp => {
      if (resp.error) { reject(resp); return; }
      accessToken = resp.access_token;
      scheduleTokenRefresh(resp.expires_in || 3600);
      resolve();
    };
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

function scheduleTokenRefresh(expiresIn) {
  clearTimeout(tokenRefreshTimer);
  tokenRefreshTimer = setTimeout(() => { accessToken = null; }, (expiresIn - 120) * 1000);
}

function initGoogleAuth() {
  if (!clientId) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    callback: () => {}
  });
}

// ===== Service Worker =====

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('sw.js');
  } catch (e) { console.log('SW registration failed', e); }
}

// ===== Settings UI =====

function updateSettingsUI() {
  const sheetIdDisplay = document.getElementById('sheet-id-display');
  sheetIdDisplay.textContent = spreadsheetId ? spreadsheetId.slice(0, 20) + '…' : 'Még nincs táblázat';
}

// ===== Init =====

async function init() {
  await registerSW();
  document.getElementById('origin-hint').textContent = window.location.origin;

  // Setup screen: no client ID yet
  if (!clientId) {
    showScreen('setup-screen');
    document.getElementById('setup-save-btn').addEventListener('click', () => {
      const id = document.getElementById('client-id-input').value.trim();
      if (!id || !id.includes('.apps.googleusercontent.com')) {
        showToast('Érvénytelen Client ID formátum');
        return;
      }
      localStorage.setItem('gazora_client_id', id);
      location.reload();
    });
    return;
  }

  // Wait for GIS library (max 15s)
  const gisReady = await Promise.race([
    new Promise(resolve => {
      const check = () => { if (window.google?.accounts?.oauth2) resolve(true); else setTimeout(check, 150); };
      check();
    }),
    new Promise(resolve => setTimeout(() => resolve(false), 15000))
  ]);

  if (!gisReady) {
    showScreen('auth-screen');
    showToast('Google könyvtár nem töltött be. Ellenőrizze az internetkapcsolatot.');
    return;
  }

  initGoogleAuth();

  // Always show auth screen — no silent token attempt (unreliable with GIS token model)
  showScreen('auth-screen');

  document.getElementById('signin-btn').addEventListener('click', async () => {
    showScreen('loading-screen');
    try {
      await ensureToken();
      startApp();
    } catch (err) {
      showScreen('auth-screen');
      showToast('Bejelentkezés sikertelen: ' + (err.error || err.message || err));
    }
  });

  document.getElementById('change-client-btn').addEventListener('click', () => {
    localStorage.removeItem('gazora_client_id');
    location.reload();
  });
}

async function startApp() {
  showScreen('loading-screen');
  try {
    await loadReadings();
    await loadTemperatures();
    showApp();
    updateDashboard();
    updateNotifUI();
    updateSettingsUI();
    checkOnOpen();
    notifyServiceWorker();
    if (Notification.permission === 'granted') schedulePeriodicSync();

    // Sheet ID display
    if (spreadsheetId) {
      document.getElementById('sheet-id-display').textContent = spreadsheetId.slice(0, 24) + '…';
    }

    // Get user info from token
    try {
      const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const user = await resp.json();
      document.getElementById('user-avatar').textContent = (user.name || '?')[0].toUpperCase();
      document.getElementById('user-avatar').title = user.name || user.email;
      document.getElementById('user-name-display').textContent = user.name || '—';
      document.getElementById('user-email-display').textContent = user.email || '—';
    } catch {}

    // Prefill today's date
    document.getElementById('reading-date').value = toISODate(new Date());

  } catch (err) {
    showToast('Hiba az adatok betöltésekor: ' + err.message);
    console.error(err);
    showScreen('auth-screen');
  }
}

// ===== Event listeners =====

document.addEventListener('DOMContentLoaded', () => {
  // Navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });

  // Reading form
  document.getElementById('reading-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('save-btn');
    btn.disabled = true;
    btn.textContent = 'Mentés...';
    try {
      const date = document.getElementById('reading-date').value;
      const value = parseFloat(document.getElementById('reading-value').value);
      const notes = document.getElementById('reading-notes').value.trim();
      if (!date || isNaN(value)) { showToast('Adja meg a dátumot és az óraállást!'); return; }
      await saveReading(date, value, notes);
      updateDashboard();
      document.getElementById('reading-value').value = '';
      document.getElementById('reading-notes').value = '';
      showToast('✅ Leolvasás mentve');
    } catch (err) {
      showToast('Hiba: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '💾 Mentés';
    }
  });

  // History search
  document.getElementById('history-search').addEventListener('input', renderHistory);

  // CSV export
  document.getElementById('export-csv-btn').addEventListener('click', exportCSV);

  // CSV import
  document.getElementById('import-csv-btn').addEventListener('click', () => {
    const file = document.getElementById('csv-file').files[0];
    if (!file) { showToast('Válasszon ki egy CSV fájlt!'); return; }
    importCSV(file);
  });

  // Notification toggles
  document.getElementById('notif-saturday').addEventListener('change', e => {
    localStorage.setItem('notif_saturday', e.target.checked ? '1' : '0');
    if (e.target.checked && Notification.permission === 'default') requestNotificationPermission();
  });
  document.getElementById('notif-overdue').addEventListener('change', e => {
    localStorage.setItem('notif_overdue', e.target.checked ? '1' : '0');
    if (e.target.checked && Notification.permission === 'default') requestNotificationPermission();
  });
  document.getElementById('request-notif-btn').addEventListener('click', requestNotificationPermission);

  // Open sheet
  document.getElementById('open-sheet-btn').addEventListener('click', () => {
    if (spreadsheetId) window.open(`https://docs.google.com/spreadsheets/d/${spreadsheetId}`, '_blank');
    else showToast('Még nincs csatolt táblázat');
  });

  // Connect existing sheet
  document.getElementById('connect-sheet-btn').addEventListener('click', async () => {
    const id = document.getElementById('sheet-id-input').value.trim();
    if (!id) { showToast('Adja meg a táblázat ID-t!'); return; }
    // Extract ID if full URL pasted
    const m = id.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    const sheetId = m ? m[1] : id;
    spreadsheetId = sheetId;
    localStorage.setItem('gazora_sheet_id', sheetId);
    showToast('Csatlakozás...');
    await loadReadings();
    updateDashboard();
    updateSettingsUI();
    showToast(`✅ Csatlakozva (${readings.length} leolvasás betöltve)`);
  });

  document.getElementById('open-temp-sheet-btn').addEventListener('click', () => {
    if (tempSpreadsheetId) window.open(`https://docs.google.com/spreadsheets/d/${tempSpreadsheetId}`, '_blank');
    else showToast('Még nincs hőmérséklet táblázat – szinkronizáljon először');
  });

  // Temperature sync
  document.getElementById('sync-temp-btn').addEventListener('click', async () => {
    const btn = document.getElementById('sync-temp-btn');
    const status = document.getElementById('sync-temp-status');
    btn.disabled = true;
    status.textContent = 'Szinkronizálás...';
    try {
      const result = await syncTemperatures(msg => { status.textContent = msg; });
      status.textContent = result.added > 0
        ? `✅ ${result.added} új nap hozzáadva (összesen: ${result.total} nap)`
        : `✅ Naprakész (${result.total} nap tárolva)`;
      if (result.added > 0) renderStats();
    } catch (err) {
      status.textContent = `❌ Hiba: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  // Sign out
  document.getElementById('signout-btn').addEventListener('click', () => {
    if (!confirm('Biztosan kilép?')) return;
    accessToken = null;
    google.accounts.oauth2.revoke(accessToken, () => {});
    showScreen('auth-screen');
  });

  // Year tabs delegation (rendered dynamically)
  document.getElementById('year-tabs').addEventListener('click', e => {
    if (e.target.classList.contains('year-tab')) {
      selectedYear = gasYearLabel(new Date(e.target.dataset.year));
      renderStats();
    }
  });

  init();
});
