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
};

const $ = (id) => document.getElementById(id);

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
function fmtClock(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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
  $('fromDate').value = from;
  $('toDate').value = to;
  $('presetSelect').value = state.preset;
  $('rangeLabel').textContent = fmtRangeLabel(from, to);
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
  el.hidden = false;
  el.innerHTML =
    '<span class="legend-title">Projects</span>' +
    projects
      .map((p) => {
        const muted = isHidden(p.key) ? ' muted' : '';
        return (
          `<span class="legend-item${muted}" data-project="${escapeHtml(p.key)}" title="Click to show/hide">` +
          `<span class="swatch" style="background:${p.color}"></span>` +
          `<span class="legend-key">${escapeHtml(p.key)}</span>` +
          `<span class="legend-total">${fmtTime(p.total)}</span></span>`
        );
      })
      .join('');
}

function renderSummary() {
  const data = state.data;
  if (!data) {
    $('rangeTotal').textContent = '—';
    $('daysLogged').textContent = '—';
    $('avgPerDay').textContent = '—';
    return;
  }
  let total = 0;
  let loggedDays = 0;
  for (const d of Object.values(data.days)) {
    const t = sumSeconds(visibleEntries(d.entries));
    if (t > 0) {
      total += t;
      loggedDays += 1;
    }
  }
  $('rangeTotal').textContent = fmtTime(total);
  $('daysLogged').textContent = String(loggedDays);
  $('avgPerDay').textContent = loggedDays ? fmtTime(Math.round(total / loggedDays)) : '0h';
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
  $('detailEmpty').hidden = true;
  $('detailBody').hidden = false;
  $('detailDate').textContent = fmtDayHeading(key);
  $('detailTotal').textContent = fmtTime(sumSeconds(entries));

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
        `<span class="chip">${fmtClock(e.started)}</span>`,
        e.issueType ? `<span class="chip">${escapeHtml(e.issueType)}</span>` : '',
        e.statusName ? `<span class="chip">${escapeHtml(e.statusName)}</span>` : '',
      ]
        .filter(Boolean)
        .join('');
      const comment = e.comment
        ? `<div class="entry-comment">${escapeHtml(e.comment)}</div>`
        : '';
      return `
        <li class="entry" style="border-left-color:${color}">
          <div class="entry-top">
            <a class="entry-key" href="${issueUrl}" target="_blank" rel="noopener">${escapeHtml(
        e.issueKey
      )}</a>
            <span class="entry-time">${escapeHtml(e.timeSpent || fmtTime(e.timeSpentSeconds))}</span>
          </div>
          <p class="entry-summary">${escapeHtml(e.issueSummary)}</p>
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
          instanceName: e.instanceName,
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

  const colTotals = {};
  dates.forEach((d) => (colTotals[d] = 0));
  for (const t of tasks) {
    for (const d of dates) if (t.perDate[d]) colTotals[d] += t.perDate[d].seconds;
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
      for (const d of dates) {
        const c = t.perDate[d];
        const wcls = isWeekend(d) ? 'weekend' : '';
        if (c) {
          const url =
            c.entries.length === 1
              ? c.entries[0].link
              : `${t.base}/browse/${t.key}?page=com.atlassian.jira.plugin.system.issuetabpanels:worklog-tabpanel`;
          html += `<td class="cell ${wcls}"><a class="cell-link" href="${url}" target="_blank" rel="noopener" title="${
            c.entries.length
          } worklog(s)">${fmtTime(c.seconds)}</a></td>`;
        } else {
          html += `<td class="cell cell-empty ${wcls}">·</td>`;
        }
      }
      html += `<td class="col-total">${fmtTime(t.total)}</td></tr>`;
    }
  }
  html += '</tbody>';

  // Totals row
  const grand = tasks.reduce((s, t) => s + t.total, 0);
  html += '<tbody><tr class="total-row"><td class="col-task">Total</td>';
  for (const d of dates) {
    const v = colTotals[d];
    html += `<td class="${isWeekend(d) ? 'weekend' : ''}">${v ? fmtTime(v) : '·'}</td>`;
  }
  html += `<td class="col-total grand">${fmtTime(grand)}</td></tr></tbody>`;

  table.innerHTML = html;
  $('tableHint').textContent = `${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${
    dates.length
  } day${dates.length === 1 ? '' : 's'} · click a cell to open the worklog in Jira`;
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
            <div class="sub">${escapeHtml(i.baseUrl)} · ${method}</div>
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
  const onDate = () => {
    const from = $('fromDate').value;
    const to = $('toDate').value;
    if (!from || !to) return;
    if (from > to) {
      setRange(to, from, 'custom');
    } else {
      setRange(from, to, 'custom');
    }
  };
  $('fromDate').addEventListener('change', onDate);
  $('toDate').addEventListener('change', onDate);

  // View toggle
  $('calBtn').addEventListener('click', () => {
    state.viewMode = 'calendar';
    render();
  });
  $('tableBtn').addEventListener('click', () => {
    state.viewMode = 'table';
    render();
  });

  // Instance switching + refresh
  $('instanceSelect').addEventListener('change', (e) => switchInstance(e.target.value));
  $('refreshBtn').addEventListener('click', loadData);

  // Legend: click a project to show/hide it
  $('legend').addEventListener('click', (e) => {
    const item = e.target.closest('.legend-item');
    if (!item) return;
    const key = item.dataset.project;
    if (state.hiddenProjects.has(key)) state.hiddenProjects.delete(key);
    else state.hiddenProjects.add(key);
    render();
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
    if (e.key === 'ArrowLeft') shiftRange(-1);
    if (e.key === 'ArrowRight') shiftRange(1);
  });
}

/* ================================================================== */
/* Boot                                                               */
/* ================================================================== */

async function init() {
  renderWeekdayRow();
  wireEvents();
  applyPreset('thisMonth', false); // sets the default range without loading yet
  render();

  try {
    await refreshInstances();
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
