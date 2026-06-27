'use strict';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  // First day of the month currently displayed.
  viewMonth: startOfMonth(new Date()),
  data: null, // last /api/worklogs response
  selectedDate: null, // 'YYYY-MM-DD'
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Date helpers (all local-time, calendar-based)                       */
/* ------------------------------------------------------------------ */

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
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

// Monday-first weekday index (Mon=0 .. Sun=6).
function mondayIndex(d) {
  return (d.getDay() + 6) % 7;
}

function fmtMonthLabel(d) {
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function fmtDayHeading(ymdStr) {
  const [y, m, d] = ymdStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
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
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderWeekdayRow() {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  $('weekdayRow').innerHTML = names
    .map((n) => `<div class="weekday">${n}</div>`)
    .join('');
}

function renderCalendar() {
  const cal = $('calendar');
  cal.innerHTML = '';

  const first = state.viewMonth;
  const monthIdx = first.getMonth();
  const lead = mondayIndex(first); // blank cells before day 1
  const daysInMonth = new Date(first.getFullYear(), monthIdx + 1, 0).getDate();
  const days = (state.data && state.data.days) || {};

  // Largest single-day total this month, for relative bar widths.
  let maxSeconds = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const key = ymd(new Date(first.getFullYear(), monthIdx, d));
    if (days[key]) maxSeconds = Math.max(maxSeconds, days[key].totalSeconds);
  }

  for (let i = 0; i < lead; i++) {
    const cell = document.createElement('div');
    cell.className = 'day empty-cell';
    cal.appendChild(cell);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateObj = new Date(first.getFullYear(), monthIdx, d);
    const key = ymd(dateObj);
    const info = days[key];

    const cell = document.createElement('div');
    cell.className = 'day';
    if (key === todayYmd()) cell.classList.add('today');
    if (key === state.selectedDate) cell.classList.add('selected');
    if (info && info.totalSeconds > 0) cell.classList.add('has-work');

    let inner = `<div class="day-num">${d}</div>`;
    if (info && info.totalSeconds > 0) {
      const pct = maxSeconds ? Math.max(12, (info.totalSeconds / maxSeconds) * 100) : 0;
      inner += `<div class="day-bar" style="width:${pct}%"></div>`;
      inner += `<div class="day-total">${fmtTime(info.totalSeconds)}</div>`;
      inner += `<div class="day-count">${info.entries.length} ${
        info.entries.length === 1 ? 'entry' : 'entries'
      }</div>`;
    }
    cell.innerHTML = inner;
    cell.addEventListener('click', () => selectDay(key));
    cal.appendChild(cell);
  }
}

function renderSummary() {
  const data = state.data;
  if (!data) return;
  const days = data.days || {};
  const logged = Object.values(days).filter((d) => d.totalSeconds > 0);
  const total = data.grandTotalSeconds || 0;
  $('monthTotal').textContent = fmtTime(total);
  $('daysLogged').textContent = String(logged.length);
  $('avgPerDay').textContent = logged.length
    ? fmtTime(Math.round(total / logged.length))
    : '0h';
}

function renderDetail() {
  const key = state.selectedDate;
  const info = key && state.data && state.data.days[key];

  if (!key) {
    $('detailEmpty').hidden = false;
    $('detailBody').hidden = true;
    return;
  }

  $('detailEmpty').hidden = true;
  $('detailBody').hidden = false;
  $('detailDate').textContent = fmtDayHeading(key);
  $('detailTotal').textContent = info ? fmtTime(info.totalSeconds) : '0h';

  const list = $('entries');
  if (!info || !info.entries.length) {
    list.innerHTML = '<li class="detail-empty">No worklogs on this day.</li>';
    return;
  }

  list.innerHTML = info.entries
    .map((e) => {
      const issueUrl = e.link.split('?')[0];
      const meta = [
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
        <li class="entry">
          <div class="entry-top">
            <a class="entry-key" href="${issueUrl}" target="_blank" rel="noopener"
               >${escapeHtml(e.issueKey)}</a>
            <span class="entry-time">${escapeHtml(e.timeSpent || fmtTime(e.timeSpentSeconds))}</span>
          </div>
          <p class="entry-summary">${escapeHtml(e.issueSummary)}</p>
          <div class="entry-meta">${meta}</div>
          ${comment}
          <a class="entry-open" href="${e.link}" target="_blank" rel="noopener"
             >Open worklog in Jira ↗</a>
        </li>`;
    })
    .join('');
}

function render() {
  $('monthLabel').textContent = fmtMonthLabel(state.viewMonth);
  $('monthPicker').value = `${state.viewMonth.getFullYear()}-${String(
    state.viewMonth.getMonth() + 1
  ).padStart(2, '0')}`;
  renderCalendar();
  renderSummary();
  renderDetail();
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function selectDay(key) {
  state.selectedDate = state.selectedDate === key ? null : key;
  render();
}

async function loadMonth() {
  const first = state.viewMonth;
  const from = ymd(first);
  const to = ymd(new Date(first.getFullYear(), first.getMonth() + 1, 0));
  showLoading(true);
  setStatus('Loading worklogs from Jira…');
  try {
    state.data = await api(`/api/worklogs?from=${from}&to=${to}`);
    const tz = state.data.timeZone ? ` · ${state.data.timeZone}` : '';
    setStatus(
      `Showing worklogs for ${state.data.user.displayName}${tz}`,
      false
    );
    render();
  } catch (err) {
    state.data = null;
    setStatus(err.message || 'Failed to load worklogs.', true);
    render();
    if (err.body && err.body.error && /auth/i.test(err.body.error)) openSettings();
  } finally {
    showLoading(false);
  }
}

function goMonth(delta) {
  state.viewMonth = addMonths(state.viewMonth, delta);
  state.selectedDate = null;
  loadMonth();
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

async function openSettings() {
  try {
    const cfg = await api('/api/config');
    $('baseUrl').value = cfg.baseUrl || '';
    $('email').value = cfg.email || '';
  } catch {
    /* ignore */
  }
  $('apiToken').value = '';
  $('modalError').hidden = true;
  $('settingsModal').hidden = false;
}

function closeSettings() {
  $('settingsModal').hidden = true;
}

async function saveSettings() {
  const payload = {
    baseUrl: $('baseUrl').value,
    email: $('email').value,
    apiToken: $('apiToken').value,
  };
  const errEl = $('modalError');
  errEl.hidden = true;
  showLoading(true);
  try {
    const res = await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    $('userBadge').textContent = res.user ? res.user.displayName : '';
    closeSettings();
    await loadMonth();
  } catch (err) {
    errEl.textContent = err.message || 'Could not save settings.';
    errEl.hidden = false;
  } finally {
    showLoading(false);
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function wireEvents() {
  $('prevBtn').addEventListener('click', () => goMonth(-1));
  $('nextBtn').addEventListener('click', () => goMonth(1));
  $('todayBtn').addEventListener('click', () => {
    state.viewMonth = startOfMonth(new Date());
    state.selectedDate = todayYmd();
    loadMonth();
  });
  $('refreshBtn').addEventListener('click', loadMonth);
  $('monthPicker').addEventListener('change', (e) => {
    const [y, m] = e.target.value.split('-').map(Number);
    if (y && m) {
      state.viewMonth = new Date(y, m - 1, 1);
      state.selectedDate = null;
      loadMonth();
    }
  });
  $('settingsBtn').addEventListener('click', openSettings);
  $('cancelSettings').addEventListener('click', closeSettings);
  $('saveSettings').addEventListener('click', saveSettings);
  $('settingsModal').addEventListener('click', (e) => {
    if (e.target === $('settingsModal')) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (!$('settingsModal').hidden) {
      if (e.key === 'Escape') closeSettings();
      return;
    }
    if (e.key === 'ArrowLeft') goMonth(-1);
    if (e.key === 'ArrowRight') goMonth(1);
  });
}

async function init() {
  renderWeekdayRow();
  render();
  wireEvents();
  try {
    const cfg = await api('/api/config');
    if (!cfg.configured) {
      openSettings();
      setStatus('Enter your Jira details to get started.');
      return;
    }
    try {
      const me = await api('/api/me');
      $('userBadge').textContent = me.displayName || '';
    } catch {
      /* surfaced by loadMonth */
    }
    await loadMonth();
  } catch (err) {
    setStatus(err.message || 'Failed to start.', true);
  }
}

init();
