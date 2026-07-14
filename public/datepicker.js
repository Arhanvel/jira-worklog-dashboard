/* ==================================================================
 * Lightweight themed date-picker popover — no dependencies.
 *
 *   const p = createDatePicker(triggerEl, { value, placeholder, onChange, min, max });
 *   p.getValue()          -> "YYYY-MM-DD" (or "")
 *   p.setValue(ymd, fire) -> set programmatically; fire=true calls onChange
 *
 * `triggerEl` is any element (usually an empty <button>); if it has no
 * `.dp-text` child the component fills in a calendar icon + text span.
 * A single popover is shared across every picker and lives on <body>, so
 * it never gets clipped by a modal or a scroll container.
 * ================================================================== */
(function () {
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

  const ICON =
    '<svg class="dp-cal" width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"></rect>' +
    '<line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line>' +
    '<line x1="3" y1="10" x2="21" y2="10"></line></svg>';

  const pad = (n) => String(n).padStart(2, '0');
  const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function fromYmd(s) {
    const [y, m, d] = String(s).split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function fmtDisplay(s) {
    if (!s) return '';
    return fromYmd(s).toLocaleDateString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  }

  /* ---------- shared popover ---------- */
  let pop = null;
  let current = null; // active DatePicker
  let view = null; // { y, m } month on screen

  function buildPop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'dp-pop';
    pop.hidden = true;
    pop.innerHTML =
      '<div class="dp-head">' +
      '<button type="button" class="dp-nav" data-nav="-1" aria-label="Previous month">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg></button>' +
      '<div class="dp-title" aria-live="polite"></div>' +
      '<button type="button" class="dp-nav" data-nav="1" aria-label="Next month">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></button>' +
      '</div>' +
      '<div class="dp-weekdays">' + WEEKDAYS.map((w) => `<span>${w}</span>`).join('') + '</div>' +
      '<div class="dp-grid"></div>' +
      '<div class="dp-foot">' +
      '<button type="button" class="dp-quick" data-quick="today">Today</button>' +
      '<button type="button" class="dp-quick dp-clear" data-quick="clear">Clear</button>' +
      '</div>';
    document.body.appendChild(pop);
    pop.addEventListener('click', onPopClick);
    return pop;
  }

  function onPopClick(e) {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      shiftMonth(Number(nav.getAttribute('data-nav')));
      return;
    }
    const quick = e.target.closest('[data-quick]');
    if (quick) {
      if (quick.getAttribute('data-quick') === 'today') current.setValue(toYmd(new Date()), true);
      else current.setValue('', true);
      close();
      return;
    }
    const cell = e.target.closest('.dp-day');
    if (cell && !cell.disabled) {
      current.setValue(cell.getAttribute('data-ymd'), true);
      close();
    }
  }

  function shiftMonth(delta) {
    let m = view.m + delta;
    let y = view.y;
    while (m < 0) { m += 12; y--; }
    while (m > 11) { m -= 12; y++; }
    view = { y, m };
    renderGrid();
  }

  function renderGrid() {
    pop.querySelector('.dp-title').textContent = `${MONTHS[view.m]} ${view.y}`;
    const first = new Date(view.y, view.m, 1);
    const offset = (first.getDay() + 6) % 7; // Monday-based grid
    const start = new Date(view.y, view.m, 1 - offset);
    const todayStr = toYmd(new Date());
    const selected = current.getValue();
    const min = current.opts.min || null;
    const max = current.opts.max || null;
    let html = '';
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const s = toYmd(d);
      const cls = ['dp-day'];
      if (d.getMonth() !== view.m) cls.push('dp-out');
      if (s === todayStr) cls.push('dp-today');
      if (s === selected) cls.push('dp-sel');
      const dow = d.getDay();
      if (dow === 0 || dow === 6) cls.push('dp-weekend');
      const disabled = (min && s < min) || (max && s > max);
      html +=
        `<button type="button" class="${cls.join(' ')}" data-ymd="${s}"` +
        `${disabled ? ' disabled' : ''}>${d.getDate()}</button>`;
    }
    pop.querySelector('.dp-grid').innerHTML = html;
  }

  function position() {
    if (!current) return;
    const r = current.trigger.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const gap = 6;
    let left = r.left;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
    if (left < 8) left = 8;
    let top = r.bottom + gap;
    if (top + ph > window.innerHeight - 8) {
      const above = r.top - gap - ph;
      if (above >= 8) top = above;
    }
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  function open(picker) {
    buildPop();
    current = picker;
    const base = picker.getValue() ? fromYmd(picker.getValue()) : new Date();
    view = { y: base.getFullYear(), m: base.getMonth() };
    renderGrid();
    pop.hidden = false;
    position();
    picker.trigger.classList.add('dp-active');
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
  }

  function close() {
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    if (current) current.trigger.classList.remove('dp-active');
    current = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', position, true);
  }

  function onDocDown(e) {
    if (pop.contains(e.target)) return;
    if (current && current.trigger.contains(e.target)) return;
    close();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }

  function toggle(picker) {
    if (current === picker && pop && !pop.hidden) close();
    else { close(); open(picker); }
  }

  class DatePicker {
    constructor(trigger, opts) {
      this.trigger = trigger;
      this.opts = opts || {};
      this.value = this.opts.value || '';
      trigger.classList.add('dp-field');
      if (!trigger.querySelector('.dp-text')) {
        trigger.innerHTML = ICON + '<span class="dp-text"></span>';
      }
      if (trigger.tagName === 'BUTTON' && !trigger.getAttribute('type')) {
        trigger.setAttribute('type', 'button');
      }
      this.textEl = trigger.querySelector('.dp-text');
      trigger.addEventListener('click', (e) => {
        e.preventDefault();
        toggle(this);
      });
      this.render();
    }
    render() {
      this.textEl.textContent = this.value
        ? fmtDisplay(this.value)
        : (this.opts.placeholder || 'Select date');
      this.trigger.classList.toggle('dp-empty', !this.value);
    }
    getValue() {
      return this.value;
    }
    setValue(v, fire) {
      this.value = v || '';
      this.render();
      if (current === this && pop && !pop.hidden) {
        const base = this.value ? fromYmd(this.value) : new Date();
        view = { y: base.getFullYear(), m: base.getMonth() };
        renderGrid();
      }
      if (fire && this.opts.onChange) this.opts.onChange(this.value);
    }
  }

  window.createDatePicker = function (trigger, opts) {
    return new DatePicker(trigger, opts);
  };
})();
