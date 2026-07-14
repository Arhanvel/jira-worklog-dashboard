'use strict';

/* ================================================================== */
/* State                                                              */
/* ================================================================== */

const state = {
  instances: [],
  activeInstanceId: null,
  range: { from: null, to: null }, // 'YYYY-MM-DD'
  preset: 'thisMonth',
  viewMode: 'calendar', // 'calendar' | 'table'
  data: null,
  selectedDate: null,
  hiddenProjects: new Set(), // project keys toggled off via the legend
  rates: { currency: 'USD', defaultRate: 0, projects: {} },
  worklogModal: null, // { instanceId, issueKey, date } while the add/view modal is open
  newWorklog: null, // { instanceId, issueKey, summary, tz } after a ticket check
};

const $ = (id) => document.getElementById(id);

/* ================================================================== */
/* Persisted preferences (survive reloads)                            */
/* ================================================================== */

const LS_RANGE = 'jwd_range'; // { from, to, preset }
const LS_VIEW = 'jwd_view'; // 'calendar' | 'table'

function persistRange() {
  try {
    localStorage.setItem(
      LS_RANGE,
      JSON.stringify({ from: state.range.from, to: state.range.to, preset: state.preset })
    );
  } catch {
    /* ignore */
  }
}
function persistView() {
  try {
    localStorage.setItem(LS_VIEW, state.viewMode);
  } catch {
    /* ignore */
  }
}

// Restore the last view mode into state (before the first render).
function restoreViewMode() {
  let v = null;
  try {
    v = localStorage.getItem(LS_VIEW);
  } catch {
    /* ignore */
  }
  if (v === 'calendar' || v === 'table') state.viewMode = v;
}

// Restore the last date range without loading. A named preset is re-evaluated
// (so "This month" tracks the calendar), while a custom range is restored
// verbatim. Falls back to the default preset when nothing valid is stored.
function restoreRange() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(LS_RANGE) || 'null');
  } catch {
    /* ignore */
  }
  const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
  if (saved && saved.preset && saved.preset !== 'custom') {
    applyPreset(saved.preset, false);
  } else if (saved && ymdRe.test(saved.from || '') && ymdRe.test(saved.to || '')) {
    setRange(saved.from, saved.to, 'custom', false);
  } else {
    applyPreset('thisMonth', false);
  }
}

/* ================================================================== */
/* Project colour-coding                                              */
/* ================================================================== */

const _colorCache = {};
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function projectColor(key) {
  if (_colorCache[key]) return _colorCache[key];
  const hue = hashStr(key || '?') % 360;
  const c = `hsl(${hue}, 62%, 58%)`;
  _colorCache[key] = c;
  return c;
}
function isHidden(projectKey) {
  return state.hiddenProjects.has(projectKey);
}
function visibleEntries(entries) {
  return (entries || []).filter((e) => !isHidden(e.projectKey));
}
function sumSeconds(entries) {
  return entries.reduce((s, e) => s + e.timeSpentSeconds, 0);
}
// [{key, color, seconds}] for a set of entries, largest first.
function projectBreakdown(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.projectKey, (m.get(e.projectKey) || 0) + e.timeSpentSeconds);
  return [...m.entries()]
    .map(([key, seconds]) => ({ key, seconds, color: projectColor(key) }))
    .sort((a, b) => b.seconds - a.seconds);
}

/* ================================================================== */
/* Hourly rates → money                                               */
/* ================================================================== */

// Rate for a project: its override if set, else the global default.
function rateFor(projectKey) {
  const override = state.rates.projects && state.rates.projects[projectKey];
  return Number.isFinite(override) && override > 0 ? override : state.rates.defaultRate || 0;
}
// Any rate configured at all? When false we hide money everywhere.
function hasRates() {
  if (state.rates.defaultRate > 0) return true;
  return Object.values(state.rates.projects || {}).some((v) => v > 0);
}
// Money for a set of entries, each priced at its own project's rate.
function moneyForEntries(entries) {
  return entries.reduce((s, e) => s + (e.timeSpentSeconds / 3600) * rateFor(e.projectKey), 0);
}
// Money for a lump of seconds all in one project.
function moneyForSeconds(seconds, projectKey) {
  return (seconds / 3600) * rateFor(projectKey);
}
function fmtMoney(amount) {
  const cur = state.rates.currency || 'USD';
  const n = amount || 0;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n);
  } catch {
    return `${n.toFixed(2)} ${cur}`;
  }
}

/* ================================================================== */
/* Date helpers (local calendar dates)                                */
/* ================================================================== */

function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayYmd() {
  return ymd(new Date());
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function mondayOf(d) {
  return addDays(d, -((d.getDay() + 6) % 7));
}
function daysInclusive(from, to) {
  return Math.round((parseYmd(to) - parseYmd(from)) / 86400000) + 1;
}
function enumerateDates(from, to) {
  const out = [];
  let d = parseYmd(from);
  const end = parseYmd(to);
  while (d <= end) {
    out.push(ymd(d));
    d = addDays(d, 1);
  }
  return out;
}

function fmtTime(seconds) {
  if (!seconds) return '0h';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
function fmtClock(iso, tz) {
  const opt = { hour: '2-digit', minute: '2-digit' };
  if (tz) {
    try {
      return new Date(iso).toLocaleTimeString(undefined, { ...opt, timeZone: tz });
    } catch {
      /* unknown tz in this browser — fall back to local */
    }
  }
  return new Date(iso).toLocaleTimeString(undefined, opt);
}

// "09:00 – 10:30": the worklog's start clock through start + duration, both in tz.
function fmtTimeRange(iso, seconds, tz) {
  const start = fmtClock(iso, tz);
  const endMs = new Date(iso).getTime() + (seconds || 0) * 1000;
  const end = fmtClock(new Date(endMs).toISOString(), tz);
  return `${start} – ${end}`;
}

// An ISO instant as a datetime-local value ("YYYY-MM-DDTHH:mm") in zone `tz`,
// so editing shows the same wall-clock the worklog is displayed at.
function isoToLocalInput(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || undefined,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(d);
    const g = (t) => parts.find((p) => p.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
  } catch {
    return '';
  }
}

/* ---------- Custom date pickers ---------- */

// Every custom date picker on the page, keyed by a short name.
const datePickers = {};

// "9" -> "09:00", "9:5" -> "09:05", "1430" -> "14:30". null if unparseable.
function normalizeTimeOfDay(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  let h, m;
  const colon = t.match(/^(\d{1,2}):(\d{1,2})$/);
  if (colon) {
    h = +colon[1];
    m = +colon[2];
  } else if (/^\d{1,2}$/.test(t)) {
    h = +t;
    m = 0;
  } else if (/^\d{3,4}$/.test(t)) {
    h = Math.floor(+t / 100);
    m = +t % 100;
  } else {
    return null;
  }
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Combine a date picker's date with a time-of-day field into "YYYY-MM-DDTHH:mm".
// Returns '' when either part is missing/invalid — callers treat that as "no value".
function composeStarted(dateKey, timeInputId) {
  const dp = datePickers[dateKey];
  const date = dp ? dp.getValue() : '';
  const time = normalizeTimeOfDay($(timeInputId).value);
  if (!date || !time) return '';
  return `${date}T${time}`;
}

// Split a "YYYY-MM-DDTHH:mm" value across a date picker + time field.
function setStartedControls(dateKey, timeInputId, value) {
  const [date, time] = String(value || '').split('T');
  if (datePickers[dateKey]) datePickers[dateKey].setValue(date || '');
  $(timeInputId).value = time || '';
}

// Reformat a time field to canonical HH:mm on blur, when it parses.
function wireTimeField(id) {
  $(id).addEventListener('blur', (e) => {
    const t = normalizeTimeOfDay(e.target.value);
    if (t) e.target.value = t;
  });
}

// Create every date picker once the DOM is ready. Must run before any setRange.
function setupDatePickers() {
  const onRangeChange = () => {
    const from = datePickers.fromDate.getValue();
    const to = datePickers.toDate.getValue();
    if (!from || !to) return;
    if (from > to) setRange(to, from, 'custom');
    else setRange(from, to, 'custom');
  };
  datePickers.fromDate = createDatePicker($('fromDate'), {
    placeholder: 'From',
    onChange: onRangeChange,
  });
  datePickers.toDate = createDatePicker($('toDate'), {
    placeholder: 'To',
    onChange: onRangeChange,
  });
  datePickers.wl_date = createDatePicker($('wl_date'), { placeholder: 'Pick a date' });
  datePickers.nw_date = createDatePicker($('nw_date'), { placeholder: 'Pick a date' });
  wireTimeField('wl_time_of_day');
  wireTimeField('nw_time_of_day');
}

/* ---------- Time-zone offsets ---------- */

// Format offset minutes as "+HH:MM" / "-HH:MM".
function fmtOffset(min) {
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
// This computer's current UTC offset as "+HH:MM" (getTimezoneOffset is inverted).
function localOffset() {
  return fmtOffset(-new Date().getTimezoneOffset());
}
// Whole-hour offsets from UTC-12 to UTC+14, plus the common fractional zones.
function tzOffsetMinutes() {
  const set = new Set();
  for (let h = -12; h <= 14; h++) set.add(h * 60);
  [-570, -210, 210, 270, 330, 345, 390, 525, 570, 630, 765].forEach((m) => set.add(m));
  return [...set].sort((a, b) => a - b);
}
// Friendly label for a stored value ("+03:00" -> "UTC+03:00"; IANA names as-is).
function tzLabel(tz) {
  return /^[+-]\d\d:\d\d$/.test(tz) ? 'UTC' + tz : tz;
}
function fmtDayHeading(s) {
  return parseYmd(s).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
function fmtRangeLabel(from, to) {
  const a = parseYmd(from);
  const b = parseYmd(to);
  const sameYear = a.getFullYear() === b.getFullYear();
  const optA = { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' };
  const optB = { day: 'numeric', month: 'short', year: 'numeric' };
  return `${a.toLocaleDateString(undefined, optA)} – ${b.toLocaleDateString(undefined, optB)}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/* ================================================================== */
/* Range presets                                                      */
/* ================================================================== */

function presetRange(name) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (name) {
    case 'lastMonth': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: ymd(first), to: ymd(last) };
    }
    case 'thisWeek': {
      const mon = mondayOf(today);
      return { from: ymd(mon), to: ymd(addDays(mon, 6)) };
    }
    case 'last7':
      return { from: ymd(addDays(today, -6)), to: ymd(today) };
    case 'last14':
      return { from: ymd(addDays(today, -13)), to: ymd(today) };
    case 'last30':
      return { from: ymd(addDays(today, -29)), to: ymd(today) };
    case 'thisMonth':
    default: {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { from: ymd(first), to: ymd(last) };
    }
  }
}

/* ================================================================== */
/* API                                                                */
/* ================================================================== */

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { body });
  return body;
}
function showLoading(on) {
  $('loading').hidden = !on;
}
function setStatus(msg, isError = false) {
  const el = $('statusMsg');
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
}

/* ================================================================== */
/* Loading data                                                       */
/* ================================================================== */

function setRange(from, to, preset, load = true) {
  state.range = { from, to };
  state.preset = preset || 'custom';
  state.selectedDate = null;
  datePickers.fromDate.setValue(from);
  datePickers.toDate.setValue(to);
  $('presetSelect').value = state.preset;
  $('rangeLabel').textContent = fmtRangeLabel(from, to);
  persistRange();
  if (load) loadData();
}

function applyPreset(name, load = true) {
  const r = presetRange(name);
  setRange(r.from, r.to, name, load);
}

function shiftRange(dir) {
  const len = daysInclusive(state.range.from, state.range.to);
  let from, to;
  if (dir > 0) {
    from = ymd(addDays(parseYmd(state.range.to), 1));
    to = ymd(addDays(parseYmd(from), len - 1));
  } else {
    to = ymd(addDays(parseYmd(state.range.from), -1));
    from = ymd(addDays(parseYmd(to), -(len - 1)));
  }
  setRange(from, to, 'custom');
}

async function loadData() {
  if (!state.activeInstanceId) {
    state.data = null;
    setStatus('Add a Jira instance to get started.');
    render();
    return;
  }
  const { from, to } = state.range;
  showLoading(true);
  setStatus('Loading worklogs from Jira…');
  try {
    state.data = await api(
      `/api/worklogs?instance=${encodeURIComponent(state.activeInstanceId)}&from=${from}&to=${to}`
    );
    $('userBadge').textContent = state.data.user.displayName || '';
    if (state.activeInstanceId === 'all') {
      const errs = state.data.errors || [];
      const okCount = (state.data.instances || []).length - errs.length;
      let msg = `All instances · ${okCount} connected`;
      if (errs.length) msg += ` · ${errs.length} failed: ${errs.map((e) => e.name).join(', ')}`;
      setStatus(msg, errs.length > 0);
    } else {
      const tz = state.data.timeZone ? ` · ${state.data.timeZone}` : '';
      setStatus(`${state.data.instance.name} (${state.data.instance.type})${tz}`);
    }
    render();
  } catch (err) {
    state.data = null;
    setStatus(err.message || 'Failed to load worklogs.', true);
    render();
    if (err.body && /auth/i.test(err.body.error || '')) openSettings();
  } finally {
    showLoading(false);
  }
}

/* ================================================================== */
/* Rendering — shared                                                 */
/* ================================================================== */

function render() {
  $('calendarView').hidden = state.viewMode !== 'calendar';
  $('tableView').hidden = state.viewMode !== 'table';
  $('calBtn').classList.toggle('active', state.viewMode === 'calendar');
  $('tableBtn').classList.toggle('active', state.viewMode === 'table');
  document.body.classList.toggle('table-mode', state.viewMode === 'table');
  renderLegend();
  renderSummary();
  if (state.viewMode === 'calendar') {
    renderCalendar();
    renderDetail();
  } else {
    renderTable();
  }
}

// Projects present across the loaded data, largest total first.
function gatherProjects(data) {
  const m = new Map();
  for (const day of Object.values(data.days)) {
    for (const e of day.entries) {
      let p = m.get(e.projectKey);
      if (!p) {
        p = { key: e.projectKey, total: 0, color: projectColor(e.projectKey) };
        m.set(e.projectKey, p);
      }
      p.total += e.timeSpentSeconds;
    }
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

function renderLegend() {
  const el = $('legend');
  if (!state.data) {
    el.hidden = true;
    return;
  }
  const projects = gatherProjects(state.data);
  if (projects.length <= 1) {
    el.hidden = true;
    return;
  }
  const showMoney = hasRates();
  el.hidden = false;
  el.innerHTML =
    '<span class="legend-title">Projects</span>' +
    projects
      .map((p) => {
        const muted = isHidden(p.key) ? ' muted' : '';
        const money = showMoney
          ? `<span class="legend-money">${fmtMoney(moneyForSeconds(p.total, p.key))}</span>`
          : '';
        return (
          `<span class="legend-item${muted}" data-project="${escapeHtml(p.key)}" title="Click to show/hide">` +
          `<span class="swatch" style="background:${p.color}"></span>` +
          `<span class="legend-key">${escapeHtml(p.key)}</span>` +
          `<span class="legend-total">${fmtTime(p.total)}</span>${money}</span>`
        );
      })
      .join('');
}

function renderSummary() {
  const data = state.data;
  const moneyItem = $('moneyItem');
  if (!data) {
    $('rangeTotal').textContent = '—';
    $('daysLogged').textContent = '—';
    $('avgPerDay').textContent = '—';
    moneyItem.hidden = true;
    return;
  }
  let total = 0;
  let loggedDays = 0;
  let money = 0;
  for (const d of Object.values(data.days)) {
    const visible = visibleEntries(d.entries);
    const t = sumSeconds(visible);
    if (t > 0) {
      total += t;
      loggedDays += 1;
      money += moneyForEntries(visible);
    }
  }
  $('rangeTotal').textContent = fmtTime(total);
  $('daysLogged').textContent = String(loggedDays);
  $('avgPerDay').textContent = loggedDays ? fmtTime(Math.round(total / loggedDays)) : '0h';
  if (hasRates()) {
    $('rangeMoney').textContent = fmtMoney(money);
    moneyItem.hidden = false;
  } else {
    moneyItem.hidden = true;
  }
}

/* ================================================================== */
/* Rendering — calendar                                               */
/* ================================================================== */

function renderWeekdayRow() {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  $('weekdayRow').innerHTML = names.map((n) => `<div class="weekday">${n}</div>`).join('');
}

function renderCalendar() {
  const cal = $('calendar');
  cal.innerHTML = '';
  const { from, to } = state.range;
  const days = (state.data && state.data.days) || {};

  const start = mondayOf(parseYmd(from));
  const end = addDays(mondayOf(parseYmd(to)), 6);

  // Precompute per-day visible entries / totals so bar widths are relative.
  const view = {};
  let maxSeconds = 0;
  for (const key of enumerateDates(from, to)) {
    const entries = visibleEntries(days[key] ? days[key].entries : []);
    const total = sumSeconds(entries);
    view[key] = { entries, total, breakdown: projectBreakdown(entries) };
    if (total > maxSeconds) maxSeconds = total;
  }

  let d = start;
  while (d <= end) {
    const key = ymd(d);
    const inRange = key >= from && key <= to;
    const v = view[key];
    const total = (v && v.total) || 0;

    const cell = document.createElement('div');
    cell.className = 'day';
    if (!inRange) cell.classList.add('out-range');
    if (key === todayYmd()) cell.classList.add('today');
    if (key === state.selectedDate) cell.classList.add('selected');
    if (total > 0) cell.classList.add('has-work');

    let inner = `<div class="day-num">${d.getDate()}</div>`;
    if (inRange && total > 0) {
      const pct = maxSeconds ? Math.max(12, (total / maxSeconds) * 100) : 0;
      const segs = v.breakdown
        .map(
          (b) =>
            `<span class="day-seg" style="width:${(b.seconds / total) * 100}%;background:${
              b.color
            }" title="${escapeHtml(b.key)} · ${fmtTime(b.seconds)}"></span>`
        )
        .join('');
      inner += `<div class="day-bar" style="width:${pct}%">${segs}</div>`;
      inner += `<div class="day-total">${fmtTime(total)}</div>`;
      if (hasRates()) {
        inner += `<div class="day-money">${fmtMoney(moneyForEntries(v.entries))}</div>`;
      }
      inner += `<div class="day-count">${v.entries.length} ${
        v.entries.length === 1 ? 'entry' : 'entries'
      }</div>`;
    }
    cell.innerHTML = inner;
    if (inRange) cell.addEventListener('click', () => selectDay(key));
    cal.appendChild(cell);
    d = addDays(d, 1);
  }
}

function selectDay(key) {
  state.selectedDate = state.selectedDate === key ? null : key;
  renderCalendar();
  renderDetail();
}

function renderDetail() {
  const key = state.selectedDate;
  const info = key && state.data && state.data.days[key];

  if (!key) {
    $('detailEmpty').hidden = false;
    $('detailBody').hidden = true;
    return;
  }
  const entries = info ? visibleEntries(info.entries) : [];
  const showMoney = hasRates();
  $('detailEmpty').hidden = true;
  $('detailBody').hidden = false;
  $('detailDate').textContent = fmtDayHeading(key);
  $('detailTotal').innerHTML =
    fmtTime(sumSeconds(entries)) +
    (showMoney ? ` <span class="detail-money">${fmtMoney(moneyForEntries(entries))}</span>` : '');

  const allMode = state.activeInstanceId === 'all';
  const list = $('entries');
  if (!entries.length) {
    list.innerHTML = '<li class="detail-empty">No worklogs on this day.</li>';
    return;
  }
  list.innerHTML = entries
    .map((e) => {
      const issueUrl = e.link.split('?')[0];
      const color = projectColor(e.projectKey);
      const meta = [
        `<span class="chip project" style="background:${color}">${escapeHtml(e.projectKey)}</span>`,
        allMode && e.instanceName
          ? `<span class="chip instance">${escapeHtml(e.instanceName)}</span>`
          : '',
        e.issueType ? `<span class="chip">${escapeHtml(e.issueType)}</span>` : '',
        e.statusName ? `<span class="chip">${escapeHtml(e.statusName)}</span>` : '',
      ]
        .filter(Boolean)
        .join('');
      const comment = e.comment
        ? `<div class="entry-comment">${escapeHtml(e.comment)}</div>`
        : '';
      const money = showMoney
        ? `<span class="entry-money">${fmtMoney(
            moneyForSeconds(e.timeSpentSeconds, e.projectKey)
          )}</span>`
        : '';
      return `
        <li class="entry" style="border-left-color:${color}">
          <div class="entry-top">
            <a class="entry-key" href="${issueUrl}" target="_blank" rel="noopener">${escapeHtml(
        e.issueKey
      )}</a>
            <span class="entry-amounts">
              <span class="entry-time">${escapeHtml(e.timeSpent || fmtTime(e.timeSpentSeconds))}</span>
              ${money}
            </span>
          </div>
          <p class="entry-summary">${escapeHtml(e.issueSummary)}</p>
          <div class="entry-timerange">${fmtTimeRange(e.started, e.timeSpentSeconds, e.tz)}</div>
          <div class="entry-meta">${meta}</div>
          ${comment}
          <a class="entry-open" href="${e.link}" target="_blank" rel="noopener">Open worklog in Jira ↗</a>
        </li>`;
    })
    .join('');
}

/* ================================================================== */
/* Rendering — table (tasks × dates)                                  */
/* ================================================================== */

function buildPivot(data, dates) {
  const map = new Map();
  for (const date of dates) {
    const day = data.days[date];
    if (!day) continue;
    for (const e of visibleEntries(day.entries)) {
      const id = `${e.instanceId}::${e.issueKey}`;
      let t = map.get(id);
      if (!t) {
        t = {
          key: e.issueKey,
          projectKey: e.projectKey,
          color: projectColor(e.projectKey),
          instanceId: e.instanceId,
          instanceName: e.instanceName,
          tz: e.tz,
          summary: e.issueSummary,
          base: e.link.split('/browse/')[0],
          perDate: {},
          total: 0,
        };
        map.set(id, t);
      }
      if (!t.perDate[date]) t.perDate[date] = { seconds: 0, entries: [] };
      t.perDate[date].seconds += e.timeSpentSeconds;
      t.perDate[date].entries.push(e);
      t.total += e.timeSpentSeconds;
    }
  }
  // Group by project (so colours cluster), then by time within a project.
  return [...map.values()].sort(
    (a, b) => a.projectKey.localeCompare(b.projectKey) || b.total - a.total
  );
}

function renderTable() {
  const table = $('worklogTable');
  const data = state.data;
  if (!data) {
    table.innerHTML = '';
    $('tableHint').textContent = '';
    return;
  }

  const dates = enumerateDates(state.range.from, state.range.to);
  const tasks = buildPivot(data, dates);
  const todayStr = todayYmd();
  const showMoney = hasRates();

  const colTotals = {};
  const colMoney = {};
  dates.forEach((d) => ((colTotals[d] = 0), (colMoney[d] = 0)));
  for (const t of tasks) {
    for (const d of dates) {
      if (!t.perDate[d]) continue;
      colTotals[d] += t.perDate[d].seconds;
      colMoney[d] += moneyForSeconds(t.perDate[d].seconds, t.projectKey);
    }
  }

  const isWeekend = (d) => {
    const wd = parseYmd(d).getDay();
    return wd === 0 || wd === 6;
  };

  // Header
  let html = '<thead><tr><th class="col-task">Task</th>';
  for (const d of dates) {
    const dd = parseYmd(d);
    const cls = `col-day ${isWeekend(d) ? 'weekend' : ''} ${d === todayStr ? 'today' : ''}`;
    html += `<th class="${cls}">${dd.getDate()}<small>${dd.toLocaleDateString(undefined, {
      weekday: 'short',
    })}</small></th>`;
  }
  html += '<th class="col-total">Total</th></tr></thead>';

  // Body
  html += '<tbody>';
  if (!tasks.length) {
    html += `<tr><td class="col-task">No worklogs in this range.</td>${dates
      .map(() => '<td class="cell cell-empty">·</td>')
      .join('')}<td class="col-total">0h</td></tr>`;
  } else {
    const allMode = state.activeInstanceId === 'all';
    for (const t of tasks) {
      const issueUrl = `${t.base}/browse/${t.key}`;
      const instLine = allMode && t.instanceName
        ? `<span class="task-instance">${escapeHtml(t.instanceName)}</span>`
        : '';
      html += `<tr><td class="col-task" style="border-left-color:${t.color}"><span class="task-head"><span class="swatch" style="background:${t.color}"></span><a class="task-key" href="${issueUrl}" target="_blank" rel="noopener">${escapeHtml(
        t.key
      )}</a></span><span class="task-summary" title="${escapeHtml(t.summary)}">${escapeHtml(
        t.summary
      )}</span>${instLine}</td>`;
      const cellData = `data-instance="${escapeHtml(t.instanceId)}" data-issue="${escapeHtml(
        t.key
      )}"`;
      for (const d of dates) {
        const c = t.perDate[d];
        const wcls = isWeekend(d) ? 'weekend' : '';
        if (c) {
          const n = c.entries.length;
          html += `<td class="cell cell-clickable ${wcls}" ${cellData} data-date="${d}" title="${n} worklog${
            n === 1 ? '' : 's'
          } — click to view or add"><span class="cell-link">${fmtTime(c.seconds)}</span></td>`;
        } else {
          html += `<td class="cell cell-empty cell-clickable ${wcls}" ${cellData} data-date="${d}" title="Click to log work on this day">·</td>`;
        }
      }
      const tMoney = showMoney
        ? `<small class="cell-money">${fmtMoney(moneyForSeconds(t.total, t.projectKey))}</small>`
        : '';
      html += `<td class="col-total">${fmtTime(t.total)}${tMoney}</td></tr>`;
    }
  }
  html += '</tbody>';

  // Totals row
  const grand = tasks.reduce((s, t) => s + t.total, 0);
  const grandMoney = tasks.reduce((s, t) => s + moneyForSeconds(t.total, t.projectKey), 0);
  html += '<tbody><tr class="total-row"><td class="col-task">Total</td>';
  for (const d of dates) {
    const v = colTotals[d];
    const dMoney = showMoney && v ? `<small class="cell-money">${fmtMoney(colMoney[d])}</small>` : '';
    html += `<td class="${isWeekend(d) ? 'weekend' : ''}">${v ? fmtTime(v) : '·'}${dMoney}</td>`;
  }
  const grandMoneyHtml = showMoney
    ? `<small class="cell-money">${fmtMoney(grandMoney)}</small>`
    : '';
  html += `<td class="col-total grand">${fmtTime(grand)}${grandMoneyHtml}</td></tr></tbody>`;

  table.innerHTML = html;
  $('tableHint').textContent = `${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${
    dates.length
  } day${dates.length === 1 ? '' : 's'} · click a cell to view or add worklogs`;
}

/* ================================================================== */
/* Instances                                                          */
/* ================================================================== */

function populateInstanceSelect() {
  const sel = $('instanceSelect');
  if (!state.instances.length) {
    sel.innerHTML = '<option>No instances</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const allOpt =
    state.instances.length > 1
      ? `<option value="all" ${state.activeInstanceId === 'all' ? 'selected' : ''}>★ All instances</option>`
      : '';
  sel.innerHTML =
    allOpt +
    state.instances
      .map(
        (i) =>
          `<option value="${i.id}" ${
            i.id === state.activeInstanceId ? 'selected' : ''
          }>${escapeHtml(i.name)}</option>`
      )
      .join('');
}

async function refreshInstances(makeActiveId) {
  const data = await api('/api/instances');
  state.instances = data.instances;
  let active =
    makeActiveId ||
    (data.instances.some((i) => i.id === state.activeInstanceId) && state.activeInstanceId) ||
    data.activeInstanceId ||
    (data.instances[0] && data.instances[0].id) ||
    null;

  if (makeActiveId && makeActiveId !== data.activeInstanceId) {
    try {
      await api('/api/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: makeActiveId }),
      });
    } catch {
      /* ignore */
    }
  }
  state.activeInstanceId = active;
  populateInstanceSelect();
}

async function switchInstance(id) {
  state.activeInstanceId = id;
  state.selectedDate = null;
  try {
    localStorage.setItem('jwd_selection', id);
  } catch {
    /* ignore */
  }
  // 'all' is a client-side view; only persist a real instance as server-active.
  if (id !== 'all') {
    try {
      await api('/api/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch {
      /* ignore */
    }
  }
  loadData();
}

/* ---------- Settings modal ---------- */

function openSettings() {
  renderInstanceList();
  $('listView').hidden = false;
  $('formView').hidden = true;
  $('modalTitle').textContent = 'Jira instances';
  $('settingsModal').hidden = false;
}
function closeSettings() {
  $('settingsModal').hidden = true;
}

function renderInstanceList() {
  const ul = $('instanceList');
  ul.innerHTML = state.instances
    .map((i) => {
      const method =
        i.type === 'cloud'
          ? 'API token'
          : i.authMethod === 'basic'
          ? 'Basic auth'
          : 'Access token';
      const gw = i.gatewayEnabled ? '<span class="badge proxy">Proxy</span>' : '';
      return `
        <li class="instance-row" data-id="${i.id}">
          <span class="badge ${i.type}">${i.type === 'cloud' ? 'Cloud' : 'Server'}</span>
          ${gw}
          <div class="meta">
            <div class="name">${escapeHtml(i.name)}</div>
            <div class="sub">${escapeHtml(i.baseUrl)} · ${method}${
        i.timeZone ? ' · ' + escapeHtml(tzLabel(i.timeZone)) : ''
      }</div>
          </div>
          <div class="row-actions">
            <button class="pill ghost" data-act="edit" data-id="${i.id}">Edit</button>
            <button class="pill danger" data-act="del" data-id="${i.id}">Delete</button>
          </div>
        </li>`;
    })
    .join('');
}

function setType(type) {
  document.querySelector(`input[name="jtype"][value="${type}"]`).checked = true;
  $('cloudAuth').hidden = type !== 'cloud';
  $('serverAuth').hidden = type !== 'server';
}
function setMethod(method) {
  const el = document.querySelector(`input[name="smethod"][value="${method}"]`);
  if (el) el.checked = true;
  const usesUserPass = method === 'basic' || method === 'session';
  $('patField').hidden = method !== 'pat';
  $('basicFields').hidden = !usesUserPass;
  const notes = {
    session:
      'Logs in via /rest/auth/1/session (like a browser). Best for older Jira where Basic auth is disabled on the REST API.',
    basic: 'Sends an Authorization: Basic header. Use only if your instance accepts Basic auth on the REST API.',
    pat: 'Bearer token from your Jira profile → Personal Access Tokens (Jira 8.14+ / Data Center).',
  };
  $('methodNote').textContent = notes[method] || '';
}

function setGateway(enabled) {
  $('f_gwEnabled').checked = enabled;
  $('gatewayFields').hidden = !enabled;
}

// Fill the day-grouping time-zone dropdown: "Automatic" plus a list of UTC
// offsets, with the one matching this computer flagged.
function populateTzOptions() {
  const sel = $('f_tz');
  const local = localOffset();
  let html = '<option value="">Automatic — use Jira’s time zone</option>';
  for (const m of tzOffsetMinutes()) {
    const off = fmtOffset(m);
    const mine = off === local ? ' — your computer' : '';
    html += `<option value="${off}">UTC${off}${mine}</option>`;
  }
  sel.innerHTML = html;
  $('tzNote').textContent =
    `If morning worklogs land on the previous day, Jira’s time zone is behind yours — ` +
    `pick your offset (this computer is currently UTC${local}).`;
}

// Select a stored value, adding an option for it first if it isn't a listed
// offset (e.g. a hand-edited IANA name in config.json).
function setTzValue(tz) {
  const sel = $('f_tz');
  if (tz && ![...sel.options].some((o) => o.value === tz)) {
    const opt = document.createElement('option');
    opt.value = tz;
    opt.textContent = tzLabel(tz);
    sel.appendChild(opt);
  }
  sel.value = tz || '';
}

function resetForm() {
  $('editId').value = '';
  [
    'f_name',
    'f_baseUrl',
    'f_email',
    'f_apiToken',
    'f_token',
    'f_username',
    'f_password',
    'f_gwUser',
    'f_gwPass',
  ].forEach((id) => ($(id).value = ''));
  ['cloudSecretOpt', 'patSecretOpt', 'basicSecretOpt', 'gwSecretOpt'].forEach(
    (id) => ($(id).textContent = '')
  );
  setType('cloud');
  setMethod('session');
  setGateway(false);
  setTzValue('');
  $('modalError').hidden = true;
  $('diagResult').hidden = true;
}

function renderDiag(r) {
  const box = $('diagResult');
  box.hidden = false;
  if (r.ok && r.user) {
    const u = r.user;
    const who = escapeHtml(u.displayName || u.name || u.key || 'connected');
    box.className = 'diag ok';
    box.innerHTML =
      `<div class="diag-title">✓ Connected as ${who}</div>` +
      `<div class="diag-hint">${escapeHtml(r.type)} · timezone ${escapeHtml(
        u.timeZone || '?'
      )}${r.gateway ? ' · via proxy' : ''}. You can save now.</div>`;
    return;
  }
  const p = r.probe || {};
  const status = p.networkError ? 'network error' : 'HTTP ' + (p.status != null ? p.status : '?');
  const parts = [`URL: ${p.url || ''}`, `Status: ${status}`];
  if (p.networkError) parts.push(`Network: ${p.networkError}`);
  const hdrs = Object.entries(p.headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  if (hdrs) parts.push(`Headers:\n${hdrs}`);
  if (p.bodySnippet) parts.push(`Body (first 500 chars):\n${p.bodySnippet}`);
  box.className = 'diag bad';
  box.innerHTML =
    `<div class="diag-title">✗ Couldn’t connect</div>` +
    `<div class="diag-hint">${escapeHtml(r.hint || 'Unknown error.')}</div>` +
    `<details><summary>Technical details</summary><pre>${escapeHtml(
      parts.join('\n\n')
    )}</pre></details>`;
}

async function testConnection() {
  const payload = gatherForm();
  const id = $('editId').value;
  if (id) payload.id = id;
  $('modalError').hidden = true;
  const box = $('diagResult');
  box.hidden = false;
  box.className = 'diag';
  box.innerHTML = 'Testing…';
  showLoading(true);
  try {
    const r = await api('/api/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    renderDiag(r);
  } catch (err) {
    box.className = 'diag bad';
    box.innerHTML = `<div class="diag-title">✗ Test failed</div><div class="diag-hint">${escapeHtml(
      err.message || 'Request failed'
    )}</div>`;
  } finally {
    showLoading(false);
  }
}

function openForm(inst) {
  resetForm();
  if (inst) {
    $('editId').value = inst.id;
    $('f_name').value = inst.name;
    $('f_baseUrl').value = inst.baseUrl;
    setType(inst.type);
    if (inst.type === 'cloud') {
      $('f_email').value = inst.email || '';
      if (inst.hasSecret) $('cloudSecretOpt').textContent = '(leave blank to keep current)';
    } else {
      const method = inst.authMethod || 'pat';
      setMethod(method);
      if (method === 'basic' || method === 'session') {
        $('f_username').value = inst.username || '';
        if (inst.hasSecret) $('basicSecretOpt').textContent = '(leave blank to keep)';
      } else if (inst.hasSecret) {
        $('patSecretOpt').textContent = '(leave blank to keep)';
      }
    }
    if (inst.gatewayEnabled) {
      setGateway(true);
      $('f_gwUser').value = inst.gatewayUsername || '';
      if (inst.hasGatewaySecret) $('gwSecretOpt').textContent = '(leave blank to keep)';
    }
    setTzValue(inst.timeZone || '');
  }
  $('modalTitle').textContent = inst ? 'Edit instance' : 'Add instance';
  $('listView').hidden = true;
  $('formView').hidden = false;
}

function gatherForm() {
  const type = document.querySelector('input[name="jtype"]:checked').value;
  const payload = { name: $('f_name').value, baseUrl: $('f_baseUrl').value, type };
  if (type === 'cloud') {
    payload.email = $('f_email').value;
    payload.apiToken = $('f_apiToken').value;
  } else {
    const method = document.querySelector('input[name="smethod"]:checked').value;
    payload.authMethod = method;
    if (method === 'basic' || method === 'session') {
      payload.username = $('f_username').value;
      payload.password = $('f_password').value;
    } else {
      payload.token = $('f_token').value;
    }
  }
  payload.gatewayEnabled = $('f_gwEnabled').checked;
  if (payload.gatewayEnabled) {
    payload.gatewayUsername = $('f_gwUser').value;
    payload.gatewayPassword = $('f_gwPass').value;
  }
  payload.timeZone = $('f_tz').value;
  return payload;
}

async function saveForm() {
  const payload = gatherForm();
  const id = $('editId').value;
  $('modalError').hidden = true;
  showLoading(true);
  try {
    const res = await api(id ? `/api/instances/${id}` : '/api/instances', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await refreshInstances(res.instance.id);
    closeSettings();
    await loadData();
  } catch (err) {
    $('modalError').textContent = err.message || 'Could not save instance.';
    $('modalError').hidden = false;
  } finally {
    showLoading(false);
  }
}

async function deleteInstance(id) {
  const inst = state.instances.find((i) => i.id === id);
  if (!inst) return;
  if (!window.confirm(`Remove "${inst.name}"? This only deletes the local connection.`)) return;
  showLoading(true);
  try {
    await api(`/api/instances/${id}`, { method: 'DELETE' });
    const wasActive = state.activeInstanceId === id;
    await refreshInstances();
    renderInstanceList();
    if (wasActive) await loadData();
  } catch (err) {
    setStatus(err.message || 'Could not delete instance.', true);
  } finally {
    showLoading(false);
  }
}

/* ================================================================== */
/* Rates modal                                                        */
/* ================================================================== */

async function refreshRates() {
  try {
    const r = await api('/api/rates');
    state.rates = {
      currency: r.currency || 'USD',
      defaultRate: r.defaultRate || 0,
      projects: r.projects || {},
    };
  } catch {
    /* keep defaults */
  }
}

function openRates() {
  $('r_currency').value = state.rates.currency || 'USD';
  $('r_default').value = state.rates.defaultRate ? String(state.rates.defaultRate) : '';
  renderRateList();
  $('ratesError').hidden = true;
  $('ratesModal').hidden = false;
}
function closeRates() {
  $('ratesModal').hidden = true;
}

// Projects to offer overrides for: those already overridden, plus any seen in
// the currently loaded worklogs.
function renderRateList() {
  const ul = $('rateList');
  const keys = new Set(Object.keys(state.rates.projects || {}));
  if (state.data) for (const p of gatherProjects(state.data)) keys.add(p.key);
  const sorted = [...keys].sort();
  const placeholder = state.rates.defaultRate ? String(state.rates.defaultRate) : 'default';

  if (!sorted.length) {
    ul.innerHTML =
      '<li class="rate-empty">Projects appear here once worklogs are loaded.</li>';
    return;
  }
  ul.innerHTML = sorted
    .map((k) => {
      const val = state.rates.projects[k];
      const color = projectColor(k);
      return (
        `<li class="rate-row">` +
        `<span class="swatch" style="background:${color}"></span>` +
        `<span class="rate-key">${escapeHtml(k)}</span>` +
        `<input type="number" class="rate-input" data-project="${escapeHtml(k)}" min="0" step="0.01" ` +
        `value="${val != null ? val : ''}" placeholder="${escapeHtml(placeholder)}" />` +
        `</li>`
      );
    })
    .join('');
}

async function saveRates() {
  const currency = $('r_currency').value || 'USD';
  const defaultRate = Number($('r_default').value) || 0;
  const projects = {};
  document.querySelectorAll('#rateList .rate-input').forEach((inp) => {
    const key = inp.dataset.project;
    const num = Number(inp.value);
    if (key && Number.isFinite(num) && num > 0) projects[key] = num;
  });
  $('ratesError').hidden = true;
  showLoading(true);
  try {
    const res = await api('/api/rates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency, defaultRate, projects }),
    });
    state.rates = res.rates;
    closeRates();
    render();
  } catch (err) {
    $('ratesError').textContent = err.message || 'Could not save rates.';
    $('ratesError').hidden = false;
  } finally {
    showLoading(false);
  }
}

/* ================================================================== */
/* Worklog modal — view a cell's worklogs and add a new one           */
/* ================================================================== */

// Default "date & time" for a new worklog on `date`. The working day starts at
// 09:00; every hour already logged that day pushes the next entry later, so the
// field pre-fills with the moment the day's logged time currently runs out.
// (Empty day → 09:00; a single 1h entry → 10:00; 1h30m + 3h + 2h15m → 15:45.)
function defaultStartFor(date) {
  const day = state.data && state.data.days[date];
  const loggedSec = day ? day.entries.reduce((s, e) => s + (e.timeSpentSeconds || 0), 0) : 0;
  const startMin = Math.min(9 * 60 + Math.round(loggedSec / 60), 23 * 60 + 59); // stay on the day
  const hh = String(Math.floor(startMin / 60)).padStart(2, '0');
  const mm = String(startMin % 60).padStart(2, '0');
  return `${date}T${hh}:${mm}`;
}

// Entries for one task on one day, earliest first.
function cellEntriesFor(instanceId, issueKey, date) {
  const day = state.data && state.data.days[date];
  if (!day) return [];
  return day.entries
    .filter((e) => e.instanceId === instanceId && e.issueKey === issueKey)
    .sort((a, b) => new Date(a.started) - new Date(b.started));
}

// Any entry for the task in the loaded range — gives summary, base URL, tz, etc.
function taskMetaFor(instanceId, issueKey) {
  if (!state.data) return null;
  for (const day of Object.values(state.data.days)) {
    for (const e of day.entries) {
      if (e.instanceId === instanceId && e.issueKey === issueKey) return e;
    }
  }
  return null;
}

function openWorklogModal(instanceId, issueKey, date) {
  state.worklogModal = { instanceId, issueKey, date, editId: null };
  $('wlError').hidden = true;
  $('wlOk').hidden = true;
  $('wl_time').value = '';
  $('wl_comment').value = '';
  setStartedControls('wl_date', 'wl_time_of_day', defaultStartFor(date));
  renderWorklogModalBody();
  $('worklogModal').hidden = false;
  $('wl_time').focus();
}

function closeWorklog() {
  $('worklogModal').hidden = true;
  state.worklogModal = null;
}

function renderWorklogModalBody() {
  const m = state.worklogModal;
  if (!m) return;
  const meta = taskMetaFor(m.instanceId, m.issueKey);
  const entries = cellEntriesFor(m.instanceId, m.issueKey, m.date);
  const projectKey = meta ? meta.projectKey : (m.issueKey.split('-')[0] || '').toUpperCase();
  const color = projectColor(projectKey);
  const base = meta ? meta.link.split('/browse/')[0] : '';
  const issueUrl = base ? `${base}/browse/${m.issueKey}` : '#';
  const tz = (meta && meta.tz) || (state.data && state.data.timeZone) || '';
  const allMode = state.activeInstanceId === 'all';

  $('wlTitle').textContent = `${m.issueKey} · ${fmtDayHeading(m.date)}`;

  const ctx = $('wlContext');
  ctx.style.borderLeftColor = color;
  ctx.innerHTML =
    `<a class="wl-key" href="${issueUrl}" target="_blank" rel="noopener">${escapeHtml(m.issueKey)}</a>` +
    (meta && meta.issueSummary
      ? `<div class="wl-summary">${escapeHtml(meta.issueSummary)}</div>`
      : '') +
    `<div class="wl-sub">` +
    `<span class="chip project" style="background:${color}">${escapeHtml(projectKey)}</span>` +
    (allMode && meta && meta.instanceName
      ? `<span class="chip instance">${escapeHtml(meta.instanceName)}</span>`
      : '') +
    `</div>`;

  const editId = m.editId;
  $('wlList').innerHTML = entries
    .map((e) => {
      const wid = escapeHtml(String(e.worklogId));
      const timeStr = escapeHtml(e.timeSpent || fmtTime(e.timeSpentSeconds));
      if (editId && String(e.worklogId) === String(editId)) {
        return `<li class="wl-item wl-editing">
          <label class="field">Date &amp; time
            <div class="dt-row">
              <button type="button" id="wledit_date"></button>
              <input type="text" class="dt-time" id="wledit_time_of_day" placeholder="09:00"
                inputmode="numeric" autocomplete="off" aria-label="Time of day" />
            </div>
          </label>
          <label class="field">Time logged
            <input type="text" id="wledit_time" value="${timeStr}" autocomplete="off" />
          </label>
          <label class="field">Work description
            <textarea id="wledit_comment" rows="2">${escapeHtml(e.comment || '')}</textarea>
          </label>
          <div class="wl-item-actions">
            <button class="pill ghost" data-act="cancel">Cancel</button>
            <button class="pill primary" data-act="save" data-id="${wid}">Save changes</button>
          </div>
        </li>`;
      }
      const comment = e.comment
        ? `<div class="wl-item-comment">${escapeHtml(e.comment)}</div>`
        : '';
      return `<li class="wl-item">
        <div class="wl-item-top">
          <span class="wl-item-clock">${fmtClock(e.started, e.tz)}</span>
          <span class="wl-item-time">${timeStr}</span>
        </div>
        ${comment}
        <div class="wl-item-actions">
          <a class="wl-item-open" href="${e.link}" target="_blank" rel="noopener">Open in Jira ↗</a>
          <span class="wl-item-spacer"></span>
          <button class="wl-linkbtn" data-act="edit" data-id="${wid}">Edit</button>
          <button class="wl-linkbtn danger" data-act="del" data-id="${wid}">Delete</button>
        </div>
      </li>`;
    })
    .join('');

  // The inline edit row is rebuilt each render — (re)create its date picker.
  if (editId) {
    const editEntry = entries.find((e) => String(e.worklogId) === String(editId));
    if (editEntry && $('wledit_date')) {
      datePickers.wledit = createDatePicker($('wledit_date'), { placeholder: 'Pick a date' });
      setStartedControls('wledit', 'wledit_time_of_day', isoToLocalInput(editEntry.started, editEntry.tz));
      wireTimeField('wledit_time_of_day');
    }
  }

  $('wlTzNote').textContent = tz
    ? `Sent to Jira in ${tzLabel(tz)}, exactly as entered.`
    : 'Sent to Jira exactly as entered.';
}

function showWlError(msg) {
  $('wlError').textContent = msg;
  $('wlError').hidden = false;
}

// Shared validation for every worklog form. Returns an error string, or null.
function validateWorklogFields(started, timeSpent) {
  if (!started) return 'Pick a date & time.';
  if (!timeSpent) return 'Enter how much time to log, e.g. “1h 30m”.';
  if (!/^\s*(\d+(?:\.\d+)?\s*[wdhmWDHM]\s*)+$/.test(timeSpent)) {
    return 'Time format looks off — use Jira units like “1h 30m”, “2h”, or “45m”.';
  }
  return null;
}

async function submitWorklog() {
  const m = state.worklogModal;
  if (!m) return;
  const started = composeStarted('wl_date', 'wl_time_of_day');
  const timeSpent = $('wl_time').value.trim();
  const comment = $('wl_comment').value;
  $('wlOk').hidden = true;
  const invalid = validateWorklogFields(started, timeSpent);
  $('wlError').hidden = true;
  if (invalid) return showWlError(invalid);

  showLoading(true);
  $('logWorkBtn').disabled = true;
  try {
    await api('/api/worklog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceId: m.instanceId,
        issueKey: m.issueKey,
        started,
        timeSpent,
        comment,
      }),
    });
    $('wl_time').value = '';
    $('wl_comment').value = '';
    $('wlOk').textContent = `Logged ${timeSpent} on ${m.issueKey}.`;
    $('wlOk').hidden = false;
    await loadData(); // refresh table + totals
    if (state.worklogModal) renderWorklogModalBody(); // still open → refresh its list
  } catch (err) {
    showWlError(err.message || 'Could not log work.');
  } finally {
    showLoading(false);
    $('logWorkBtn').disabled = false;
  }
}

async function saveWorklogEdit(worklogId) {
  const m = state.worklogModal;
  if (!m) return;
  const started = composeStarted('wledit', 'wledit_time_of_day');
  const timeSpent = $('wledit_time').value.trim();
  const comment = $('wledit_comment').value;
  $('wlOk').hidden = true;
  const invalid = validateWorklogFields(started, timeSpent);
  $('wlError').hidden = true;
  if (invalid) return showWlError(invalid);

  showLoading(true);
  try {
    await api('/api/worklog', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceId: m.instanceId,
        issueKey: m.issueKey,
        worklogId,
        started,
        timeSpent,
        comment,
      }),
    });
    m.editId = null;
    $('wlOk').textContent = 'Worklog updated.';
    $('wlOk').hidden = false;
    await loadData();
    if (state.worklogModal) renderWorklogModalBody();
  } catch (err) {
    showWlError(err.message || 'Could not update worklog.');
  } finally {
    showLoading(false);
  }
}

async function deleteWorklogEntry(worklogId) {
  const m = state.worklogModal;
  if (!m) return;
  if (!window.confirm('Delete this worklog? This cannot be undone.')) return;
  $('wlOk').hidden = true;
  $('wlError').hidden = true;
  showLoading(true);
  try {
    await api('/api/worklog', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: m.instanceId, issueKey: m.issueKey, worklogId }),
    });
    $('wlOk').textContent = 'Worklog deleted.';
    $('wlOk').hidden = false;
    await loadData();
    if (state.worklogModal) renderWorklogModalBody();
  } catch (err) {
    showWlError(err.message || 'Could not delete worklog.');
  } finally {
    showLoading(false);
  }
}

/* ================================================================== */
/* "Log new worklog" — pick instance + ticket, then log                */
/* ================================================================== */

function populateNwInstances() {
  const sel = $('nw_instance');
  sel.innerHTML = state.instances
    .map((i) => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}</option>`)
    .join('');
  if (state.activeInstanceId && state.activeInstanceId !== 'all') {
    sel.value = state.activeInstanceId;
  }
}

// Any change to the instance/ticket invalidates a previous check.
function resetNwCheck() {
  state.newWorklog = null;
  $('nw_result').hidden = true;
  $('nw_form').hidden = true;
  $('nw_logBtn').hidden = true;
  $('nw_ok').hidden = true;
}

function showNwError(msg) {
  $('nw_error').textContent = msg;
  $('nw_error').hidden = false;
}

function openNewWorklog() {
  if (!state.instances.length) {
    setStatus('Add a Jira instance first.', true);
    openSettings();
    return;
  }
  resetNwCheck();
  populateNwInstances();
  $('nw_key').value = '';
  $('nw_time').value = '';
  $('nw_comment').value = '';
  setStartedControls('nw_date', 'nw_time_of_day', defaultStartFor(todayYmd()));
  $('nw_error').hidden = true;
  $('newWorklogModal').hidden = false;
  $('nw_key').focus();
}

function closeNewWorklog() {
  $('newWorklogModal').hidden = true;
  state.newWorklog = null;
}

async function checkTicket() {
  const instanceId = $('nw_instance').value;
  const key = $('nw_key').value.trim();
  $('nw_error').hidden = true;
  $('nw_ok').hidden = true;
  if (!key) return showNwError('Enter a ticket id, e.g. TIC-123.');

  showLoading(true);
  $('nw_checkBtn').disabled = true;
  try {
    const r = await api(
      `/api/issue?instance=${encodeURIComponent(instanceId)}&key=${encodeURIComponent(key)}`
    );
    state.newWorklog = { instanceId, issueKey: r.key, summary: r.summary, tz: r.timeZone || '' };
    const res = $('nw_result');
    res.className = 'nw-result ok';
    res.innerHTML =
      `<span class="nw-found-key">✓ ${escapeHtml(r.key)}</span>` +
      `<span class="nw-found-summary">${escapeHtml(r.summary || '(no summary)')}</span>`;
    res.hidden = false;
    $('nw_tzNote').textContent = r.timeZone
      ? `Sent to Jira in ${tzLabel(r.timeZone)}, exactly as entered.`
      : 'Sent to Jira exactly as entered.';
    $('nw_form').hidden = false;
    $('nw_logBtn').hidden = false;
    $('nw_time').focus();
  } catch (err) {
    resetNwCheck();
    const res = $('nw_result');
    res.className = 'nw-result bad';
    res.textContent = err.message || 'Could not find that ticket.';
    res.hidden = false;
  } finally {
    showLoading(false);
    $('nw_checkBtn').disabled = false;
  }
}

async function submitNewWorklog() {
  const nw = state.newWorklog;
  if (!nw) return showNwError('Check a ticket first.');
  const started = composeStarted('nw_date', 'nw_time_of_day');
  const timeSpent = $('nw_time').value.trim();
  const comment = $('nw_comment').value;
  $('nw_ok').hidden = true;
  const invalid = validateWorklogFields(started, timeSpent);
  $('nw_error').hidden = true;
  if (invalid) return showNwError(invalid);

  showLoading(true);
  $('nw_logBtn').disabled = true;
  try {
    await api('/api/worklog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceId: nw.instanceId,
        issueKey: nw.issueKey,
        started,
        timeSpent,
        comment,
      }),
    });
    $('nw_time').value = '';
    $('nw_comment').value = '';
    $('nw_ok').textContent = `Logged ${timeSpent} on ${nw.issueKey}.`;
    $('nw_ok').hidden = false;
    await loadData(); // reflect it in the current view if applicable
  } catch (err) {
    showNwError(err.message || 'Could not log work.');
  } finally {
    showLoading(false);
    $('nw_logBtn').disabled = false;
  }
}

/* ================================================================== */
/* Events                                                             */
/* ================================================================== */

function wireEvents() {
  // Range
  $('prevBtn').addEventListener('click', () => shiftRange(-1));
  $('nextBtn').addEventListener('click', () => shiftRange(1));
  $('presetSelect').addEventListener('change', (e) => {
    if (e.target.value === 'custom') return;
    applyPreset(e.target.value);
  });
  // (From/To pickers apply the range themselves via their onChange — see setupDatePickers.)

  // View toggle
  $('calBtn').addEventListener('click', () => {
    state.viewMode = 'calendar';
    persistView();
    render();
  });
  $('tableBtn').addEventListener('click', () => {
    state.viewMode = 'table';
    persistView();
    render();
  });

  // Instance switching + refresh
  $('instanceSelect').addEventListener('change', (e) => switchInstance(e.target.value));
  $('refreshBtn').addEventListener('click', loadData);

  // Table cell → worklog view/add modal
  $('worklogTable').addEventListener('click', (e) => {
    const td = e.target.closest('td[data-issue]');
    if (!td) return;
    openWorklogModal(td.dataset.instance, td.dataset.issue, td.dataset.date);
  });
  $('closeWorklog').addEventListener('click', closeWorklog);
  $('cancelWorklog').addEventListener('click', closeWorklog);
  $('logWorkBtn').addEventListener('click', submitWorklog);
  // Edit / delete / save / cancel on existing worklogs (event delegation).
  $('wlList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || !state.worklogModal) return;
    const act = btn.dataset.act;
    if (act === 'edit') {
      state.worklogModal.editId = btn.dataset.id;
      renderWorklogModalBody();
    } else if (act === 'cancel') {
      state.worklogModal.editId = null;
      renderWorklogModalBody();
    } else if (act === 'save') {
      saveWorklogEdit(btn.dataset.id);
    } else if (act === 'del') {
      deleteWorklogEntry(btn.dataset.id);
    }
  });
  $('worklogModal').addEventListener('click', (e) => {
    if (e.target === $('worklogModal')) closeWorklog();
  });
  // Enter in the time field submits (textarea keeps its newline behaviour).
  $('wl_time').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitWorklog();
    }
  });

  // Legend: click a project to show/hide it
  $('legend').addEventListener('click', (e) => {
    const item = e.target.closest('.legend-item');
    if (!item) return;
    const key = item.dataset.project;
    if (state.hiddenProjects.has(key)) state.hiddenProjects.delete(key);
    else state.hiddenProjects.add(key);
    render();
  });

  // Log new worklog modal
  $('newWorklogBtn').addEventListener('click', openNewWorklog);
  $('closeNewWorklog').addEventListener('click', closeNewWorklog);
  $('cancelNewWorklog').addEventListener('click', closeNewWorklog);
  $('nw_checkBtn').addEventListener('click', checkTicket);
  $('nw_logBtn').addEventListener('click', submitNewWorklog);
  $('nw_instance').addEventListener('change', resetNwCheck);
  $('nw_key').addEventListener('input', resetNwCheck);
  $('nw_key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      checkTicket();
    }
  });
  $('nw_time').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitNewWorklog();
    }
  });
  $('newWorklogModal').addEventListener('click', (e) => {
    if (e.target === $('newWorklogModal')) closeNewWorklog();
  });

  // Rates modal
  $('ratesBtn').addEventListener('click', openRates);
  $('closeRates').addEventListener('click', closeRates);
  $('cancelRates').addEventListener('click', closeRates);
  $('saveRates').addEventListener('click', saveRates);
  $('ratesModal').addEventListener('click', (e) => {
    if (e.target === $('ratesModal')) closeRates();
  });

  // Settings modal
  $('settingsBtn').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('cancelForm').addEventListener('click', () => {
    $('formView').hidden = true;
    $('listView').hidden = false;
    $('modalTitle').textContent = 'Jira instances';
  });
  $('addInstanceBtn').addEventListener('click', () => openForm(null));
  $('saveForm').addEventListener('click', saveForm);
  $('testForm').addEventListener('click', testConnection);
  $('instanceList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === 'edit') openForm(state.instances.find((i) => i.id === id));
    else if (btn.dataset.act === 'del') deleteInstance(id);
  });

  // Auth type / method toggles in the form
  document.querySelectorAll('input[name="jtype"]').forEach((r) =>
    r.addEventListener('change', (e) => setType(e.target.value))
  );
  document.querySelectorAll('input[name="smethod"]').forEach((r) =>
    r.addEventListener('change', (e) => setMethod(e.target.value))
  );
  $('f_gwEnabled').addEventListener('change', (e) => setGateway(e.target.checked));

  // Backdrop + keyboard
  $('settingsModal').addEventListener('click', (e) => {
    if (e.target === $('settingsModal')) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (!$('settingsModal').hidden) {
      if (e.key === 'Escape') closeSettings();
      return;
    }
    if (!$('ratesModal').hidden) {
      if (e.key === 'Escape') closeRates();
      return;
    }
    if (!$('worklogModal').hidden) {
      if (e.key === 'Escape') closeWorklog();
      return;
    }
    if (!$('newWorklogModal').hidden) {
      if (e.key === 'Escape') closeNewWorklog();
      return;
    }
    if (e.key === 'ArrowLeft') shiftRange(-1);
    if (e.key === 'ArrowRight') shiftRange(1);
  });
}

/* ================================================================== */
/* Boot                                                               */
/* ================================================================== */

async function init() {
  renderWeekdayRow();
  populateTzOptions();
  setupDatePickers(); // must precede restoreRange(), which sets picker values
  wireEvents();
  restoreViewMode(); // last calendar/table choice, before the first render
  restoreRange(); // last date range, without loading yet
  render();

  try {
    await Promise.all([refreshInstances(), refreshRates()]);
    if (!state.instances.length) {
      openSettings();
      openForm(null);
      setStatus('Add your first Jira instance to get started.');
      return;
    }
    // Restore the last selected view (a specific instance, or "All instances").
    let saved = null;
    try {
      saved = localStorage.getItem('jwd_selection');
    } catch {
      /* ignore */
    }
    if (saved === 'all' && state.instances.length > 1) {
      state.activeInstanceId = 'all';
      populateInstanceSelect();
    } else if (saved && state.instances.some((i) => i.id === saved)) {
      state.activeInstanceId = saved;
      populateInstanceSelect();
    }
    await loadData();
  } catch (err) {
    setStatus(err.message || 'Failed to start.', true);
  }
}

init();
