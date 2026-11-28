// Unified Schedule (#view-schedule): Google Calendar / iCal, Booked gigs, Ticket on-sales, Album releases,
// Vinyl pre-orders, spoiler-free F1 sessions, Salford bins, plus optional read-only House and Poker overlays.
//
// Everything is .sch* / [data-sch-*]; never reuse [data-act] or [data-date] (app.js and util.js handle those globally).
import * as api from './api.js';
import { $, esc, ico, safeUrl, fmtDay, relDays, isoOf, parseDate, gcalUrl, toast } from './util.js';

const API = '/api/owner/schedule';
const root = $('#view-schedule');
const STORAGE_HIDDEN = 'sch-hidden';
const STORAGE_MODE = 'sch-mode';
const STORAGE_HIDE_EMPTY = 'sch-hide-empty';

const THEME_COLOURS = { violet: 'var(--accent-hi)', silver: 'var(--silver)', indigo: 'var(--sch-c-indigo)' };
const HEX_RE = /^#[0-9a-f]{3,8}$/i;
const DOW_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FMT = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
const LONG_DAY_FMT = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

let active = false, started = false, loading = false, pendingReload = false;
let data = null, loadError = null;
let viewYear = null, viewMonth = null;           // 0-indexed month currently shown
let selectedIso = null;                          // YYYY-MM-DD highlighted in Month view
let viewMode = loadViewMode();                   // 'month' | 'agenda'
let hiddenLayers = loadHidden();                 // Set<string> of toggled-off source layer ids
let hideEmpty = loadHideEmpty();                 // hide category chips with 0 events in the current view
let searchText = '';                             // live text filter in Agenda view
let fetchedRange = null;                         // { start, end } of currently cached `data`
let pickerOpen = false, pickerYear = null;       // inline Month/Year picker popover state

function loadHidden() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_HIDDEN) || '[]');
    return new Set(Array.isArray(raw) ? raw.filter(x => typeof x === 'string') : []);
  } catch { return new Set(); }
}

function saveHidden() {
  try { localStorage.setItem(STORAGE_HIDDEN, JSON.stringify([...hiddenLayers])); } catch { /* ignore */ }
}

function loadViewMode() {
  try { return localStorage.getItem(STORAGE_MODE) === 'agenda' ? 'agenda' : 'month'; } catch { return 'month'; }
}

function saveViewMode(m) {
  try { localStorage.setItem(STORAGE_MODE, m); } catch { /* ignore */ }
}

function loadHideEmpty() {
  try { return localStorage.getItem(STORAGE_HIDE_EMPTY) !== '0'; } catch { return true; }
}

function saveHideEmpty(v) {
  try { localStorage.setItem(STORAGE_HIDE_EMPTY, v ? '1' : '0'); } catch { /* ignore */ }
}

function addDays(iso, n) {
  const d = parseDate(iso);
  d.setDate(d.getDate() + n);
  return isoOf(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBetween(aIso, bIso) {
  const a = parseDate(aIso), b = parseDate(bIso);
  return Math.round((b - a) / 864e5);
}

function todayIso() {
  if (data?.today) return data.today;
  const d = new Date();
  return isoOf(d.getFullYear(), d.getMonth(), d.getDate());
}

function ensureMonthInit() {
  if (viewYear !== null && viewMonth !== null) return;
  const t = parseDate(todayIso());
  viewYear = t.getFullYear();
  viewMonth = t.getMonth();
  selectedIso = todayIso();
}

function monthBounds(y, m0) {
  const first = new Date(y, m0, 1);
  const last = new Date(y, m0 + 1, 0);
  return {
    firstIso: isoOf(y, m0, 1),
    lastIso: isoOf(y, m0, last.getDate()),
    gridStart: addDays(isoOf(y, m0, 1), -((first.getDay() + 6) % 7)),
    gridEnd: addDays(isoOf(y, m0, last.getDate()), 6 - ((last.getDay() + 6) % 7)),
  };
}

function neededWindow() {
  ensureMonthInit();
  const b = monthBounds(viewYear, viewMonth);
  const start = addDays(b.gridStart, -7);
  // Agenda covers 2+ months ahead from the viewed month; keep a generous window
  const end = addDays(b.lastIso, 65);
  return { start, end };
}

function windowCovers(win) {
  return !!(fetchedRange && fetchedRange.start <= win.start && fetchedRange.end >= win.end);
}

export function onView(v) {
  const was = active;
  active = v === 'schedule';
  if (active && !started) {
    started = true;
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('pointerover', onPointerOver);
    root.addEventListener('pointerout', onPointerOut);
    document.addEventListener('click', e => {
      if (pickerOpen && !e.target.closest?.('.sch-nav__center')) { pickerOpen = false; render(); }
    });
    document.addEventListener('keydown', e => {
      if (pickerOpen && e.key === 'Escape') { pickerOpen = false; render(); }
    });
    document.addEventListener('visibilitychange', () => { if (active && !document.hidden) fetchSchedule(true); });
    api.subscribe(ev => {
      if (!active) return;
      if (ev.type === 'config' || (ev.type === 'widget' && ['diary', 'gigs', 'bins', 'f1cal', 'releases', 'vinyl', 'radar'].includes(ev.id))) {
        fetchSchedule(true);
      }
    });
  }
  if (active && !was) {
    ensureMonthInit();
    render();
    fetchSchedule(!data);
  }
}

async function fetchSchedule(force = false) {
  const win = neededWindow();
  if (!force && data && windowCovers(win)) { render(); return; }
  if (loading) { pendingReload = true; return; }
  loading = true;
  loadError = null;
  try {
    const res = await api.get(`${API}?start=${encodeURIComponent(win.start)}&end=${encodeURIComponent(win.end)}`);
    data = res;
    fetchedRange = { start: res.start, end: res.end };
    if (!selectedIso) selectedIso = res.today;
  } catch (err) {
    loadError = err.message || 'Could not load schedule';
  } finally {
    loading = false;
  }
  render();
  if (pendingReload) {
    pendingReload = false;
    fetchSchedule(true);
  }
}

// ---- colour & formatting helpers ----------------------------------------------------------------

function resolveDiaryColour(raw) {
  if (raw && HEX_RE.test(raw)) return raw;
  return THEME_COLOURS[raw] || 'var(--sch-c-diary)';
}

function sourceColour(src) {
  if (src?.kind === 'diary' || src?.id?.startsWith?.('cal:')) {
    return resolveDiaryColour(src.colour);
  }
  return `var(--sch-c-${src?.id || 'diary'})`;
}

function eventColour(ev) {
  if (ev.kind === 'diary' || ev.layer === 'diary' || ev.layer?.startsWith?.('cal:')) {
    return resolveDiaryColour(ev.colour);
  }
  if (ev.layer === 'bins' && ev.colour && HEX_RE.test(ev.colour)) return ev.colour;
  return `var(--sch-c-${ev.layer})`;
}

function sourceLabel(layerId) {
  return (data?.sources || []).find(s => s.id === layerId)?.label || layerId;
}

function sourceIcon(layerId) {
  return (data?.sources || []).find(s => s.id === layerId)?.icon || 'cal';
}

function eventLayers(ev) {
  return Array.isArray(ev.layers) && ev.layers.length ? ev.layers : [ev.layer];
}

function visibleEvents() {
  return (data?.events || []).filter(ev => eventLayers(ev).some(l => !hiddenLayers.has(l)));
}

function eventTagLabel(ev) {
  if (ev.kind === 'diary' && Array.isArray(ev.meta?.cals) && ev.meta.cals.length > 1) {
    // Only list calendars that aren't currently toggled off
    const layers = eventLayers(ev);
    const activeNames = ev.meta.cals.filter((_, i) => !layers[i] || !hiddenLayers.has(layers[i]));
    return (activeNames.length ? activeNames : ev.meta.cals).join(' · ');
  }
  return sourceLabel(ev.layer);
}

function eventBarBackground(ev) {
  if (ev.kind === 'diary' && Array.isArray(ev.meta?.cal_colours) && ev.meta.cal_colours.length > 1) {
    const layers = eventLayers(ev);
    const cols = ev.meta.cal_colours
      .filter((_, i) => !layers[i] || !hiddenLayers.has(layers[i]))
      .map(resolveDiaryColour);
    if (cols.length > 1) {
      const stops = cols.map((col, i) => `${col} ${(i / cols.length) * 100}% ${((i + 1) / cols.length) * 100}%`).join(', ');
      return `linear-gradient(180deg, ${stops})`;
    }
    if (cols.length === 1) return cols[0];
  }
  return eventColour(ev);
}

function indexByDay(events, startIso, endIso) {
  const map = new Map();
  for (const ev of events) {
    const first = ev.date < startIso ? startIso : ev.date;
    const last = (ev.until || ev.date) > endIso ? endIso : (ev.until || ev.date);
    if (first > endIso || last < startIso) continue;
    for (let d = first, guard = 0; d <= last && guard < 120; d = addDays(d, 1), guard++) {
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(ev);
    }
  }
  return map;
}

function formatTime(ev) {
  if (ev.all_day) return 'All day';
  if (ev.time && ev.end_time && ev.end_time !== ev.time) return `${ev.time} – ${ev.end_time}`;
  return ev.time || 'All day';
}

function dayBadge(iso, today) {
  const diff = daysBetween(today, iso);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff <= 30) return relDays(diff);
  return '';
}

function linkLabel(ev) {
  if (ev.kind === 'diary' || ev.layer === 'diary' || ev.layer?.startsWith?.('cal:')) return 'Open in Google Calendar';
  if (ev.layer === 'gigs') return 'Tickets';
  if (ev.layer === 'onsale') return 'Ticketmaster';
  if (ev.layer === 'releases') return 'MusicBrainz';
  if (ev.layer === 'vinyl') return 'Shop page';
  return 'Open link';
}

// ---- rendering ----------------------------------------------------------------------------------

function renderMonthPicker(today) {
  if (!pickerOpen) return '';
  const py = pickerYear ?? viewYear;
  const t = parseDate(today);
  const nowY = t.getFullYear(), nowM = t.getMonth();
  const months = MONTH_SHORT.map((label, m0) => {
    const isSel = py === viewYear && m0 === viewMonth;
    const isNow = py === nowY && m0 === nowM;
    return `<button type="button" class="sch-picker__m${isSel ? ' is-sel' : ''}${isNow ? ' is-now' : ''}" data-sch-pick-month="${m0}" aria-pressed="${isSel}">${label}</button>`;
  }).join('');
  return `<div class="sch-picker" role="dialog" aria-label="Choose month and year">
    <div class="sch-picker__head">
      <button type="button" class="btn btn--icon sch-picker__yrbtn" data-sch-pyear="-1" aria-label="Previous year">${ico('prev')}</button>
      <span class="sch-picker__year">${py}</span>
      <button type="button" class="btn btn--icon sch-picker__yrbtn" data-sch-pyear="1" aria-label="Next year">${ico('next')}</button>
    </div>
    <div class="sch-picker__grid">${months}</div>
  </div>`;
}

function renderToolbar(viewEvents, today) {
  const monthLabel = MONTH_FMT.format(new Date(viewYear, viewMonth, 1));
  const counts = {};
  for (const ev of viewEvents) {
    for (const l of eventLayers(ev)) counts[l] = (counts[l] || 0) + 1;
  }

  const allSources = (data?.sources || []).filter(s => s.available || s.count > 0 || !['house', 'poker'].includes(s.id));
  const emptyCount = allSources.filter(s => !(counts[s.id] || 0)).length;
  const sources = hideEmpty ? allSources.filter(s => (counts[s.id] || 0) > 0) : allSources;
  const anyHidden = sources.some(s => hiddenLayers.has(s.id));
  const chips = sources.map(s => {
    const on = !hiddenLayers.has(s.id);
    const n = counts[s.id] || 0;
    return `<button type="button" class="sch-chip${on ? ' is-on' : ''}${n ? '' : ' is-zero'}" data-sch-layer="${esc(s.id)}" aria-pressed="${on}" style="--chip-c: ${esc(sourceColour(s))}">
      <span class="sch-chip__dot"></span>
      <span class="sch-chip__name">${esc(s.label)}</span>
      ${n ? `<span class="sch-chip__n">${n}</span>` : ''}
    </button>`;
  }).join('');
  const emptyToggle = emptyCount
    ? `<button type="button" class="sch-reset" data-sch-toggle-empty aria-pressed="${!hideEmpty}">${hideEmpty ? `Show empty (${emptyCount})` : 'Hide empty'}</button>`
    : '';

  return `<header class="sch-head">
    <div class="sch-nav">
      <div class="sch-nav__left">
        <div class="sch-seg" role="tablist" aria-label="Schedule view">
          <button type="button" class="sch-seg__btn${viewMode === 'month' ? ' is-on' : ''}" role="tab" aria-selected="${viewMode === 'month'}" data-sch-mode="month">${ico('cal')}<span>Month</span></button>
          <button type="button" class="sch-seg__btn${viewMode === 'agenda' ? ' is-on' : ''}" role="tab" aria-selected="${viewMode === 'agenda'}" data-sch-mode="agenda">${ico('list')}<span>Agenda</span></button>
        </div>
        ${data?.diary_configured ? `<button type="button" class="btn sch-sync" data-sch-sync title="Sync calendar now">${ico('refresh')}<span>Sync</span></button>` : ''}
      </div>
      <div class="sch-nav__center">
        <button type="button" class="btn btn--icon sch-nav__btn" data-sch-step="-1" aria-label="Previous month" title="Previous month">${ico('prev')}</button>
        <button type="button" class="sch-month-btn${pickerOpen ? ' is-open' : ''}" data-sch-picker-toggle aria-expanded="${pickerOpen}" aria-haspopup="dialog" title="Jump to another month">
          <span class="sch-month">${esc(monthLabel)}</span>${ico('down', 'sch-month-btn__chev')}
        </button>
        <button type="button" class="btn btn--icon sch-nav__btn" data-sch-step="1" aria-label="Next month" title="Next month">${ico('next')}</button>
        ${renderMonthPicker(today)}
      </div>
      <div class="sch-nav__right">
        <button type="button" class="btn sch-nav__today" data-sch-today>Today</button>
      </div>
    </div>
    <div class="sch-filters" role="group" aria-label="Filter sources">
      ${chips}
      ${anyHidden ? `<button type="button" class="sch-reset" data-sch-show-all>Show all</button>` : ''}
      ${emptyToggle}
    </div>
  </header>`;
}

function renderBanners() {
  const parts = [];
  if (loadError) {
    parts.push(`<p class="sch-banner sch-banner--warn">${ico('alert')}<span>${esc(loadError)}</span></p>`);
  }
  if (data?.google_expired) {
    parts.push(`<div class="sch-banner sch-banner--warn">${ico('alert')}<span>Google Calendar sign-in has expired — reconnect to resume syncing.</span><a class="btn sch-banner__act" href="/settings#widgets">Open Settings</a></div>`);
  } else if (data && !data.diary_configured) {
    parts.push(`<div class="sch-banner">${ico('cal')}<span>Connect Google Calendar (or add an iCal feed) in Settings to see personal events alongside gigs, releases, F1 and bins.</span><a class="btn sch-banner__act" href="/settings#widgets">Connect Calendar</a></div>`);
  }
  return parts.join('');
}

function renderEventCard(ev, activeIso) {
  const c = eventColour(ev);
  const timeStr = formatTime(ev);
  const multi = ev.until && ev.until !== ev.date ? `until ${fmtDay(ev.until)}` : '';
  const metaBits = [ev.subtitle, ev.location, multi].filter(Boolean).join(' · ');
  const binSwatches = ev.layer === 'bins' && Array.isArray(ev.meta?.streams)
    ? `<div class="sch-bins">${ev.meta.streams.map(s => `<span class="sch-bin" style="--sw:${esc(s.colour)}"><i></i>${esc(s.title)}</span>`).join('')}</div>`
    : '';
  const presaleList = ev.layer === 'onsale' && Array.isArray(ev.meta?.presales) && ev.meta.presales.length > 1
    ? (() => {
        const sameTime = new Set(ev.meta.presales.map(p => p.time)).size === 1;
        return `<div class="sch-presales">${ev.meta.presales.map(p =>
          `<span class="sch-presale">${sameTime ? '' : `<b>${esc(p.time)}</b> `}${esc(p.name)}</span>`
        ).join('')}</div>`;
      })()
    : '';
  const actions = [];
  if (ev.href) {
    actions.push(`<a class="sch-link" href="${esc(safeUrl(ev.href))}" target="_blank" rel="noopener">${esc(linkLabel(ev))} ${ico('ext', 'xi')}</a>`);
  }
  if (ev.layer === 'gigs' && ev.meta?.gig) {
    actions.push(`<a class="sch-link" href="${esc(safeUrl(gcalUrl(ev.meta.gig)))}" target="_blank" rel="noopener">Add to Google Calendar ${ico('ext', 'xi')}</a>`);
  }
  const tentative = ev.meta?.status === 'tentative' ? '<span class="chip">Tentative</span>' : '';
  const layerAttr = eventLayers(ev).join(' ');
  const barBg = eventBarBackground(ev);
  return `<article class="sch-ev${ev.meta?.status === 'tentative' ? ' is-tentative' : ''}" data-sch-ev-layer="${esc(layerAttr)}" style="--ev-c:${esc(c)}">
    <div class="sch-ev__bar" style="background:${esc(barBg)}"></div>
    <div class="sch-ev__body">
      <div class="sch-ev__top">
        <span class="sch-ev__time">${esc(timeStr)}</span>
        <span class="sch-ev__tag">${ico(sourceIcon(ev.layer))}<span>${esc(eventTagLabel(ev))}</span></span>
        ${tentative}
      </div>
      <div class="sch-ev__title">${esc(ev.title)}</div>
      ${metaBits ? `<div class="sch-ev__sub">${esc(metaBits)}</div>` : ''}
      ${binSwatches}
      ${presaleList}
      ${ev.detail && ev.layer !== 'bins' && !presaleList ? `<p class="sch-ev__detail">${esc(ev.detail)}</p>` : ''}
      ${actions.length ? `<div class="sch-ev__acts">${actions.join('')}</div>` : ''}
    </div>
  </article>`;
}

function renderMonthView(events, today) {
  const b = monthBounds(viewYear, viewMonth);
  const byDay = indexByDay(events, b.gridStart, b.gridEnd);

  const cells = [];
  for (let d = b.gridStart, guard = 0; d <= b.gridEnd && guard < 42; d = addDays(d, 1), guard++) {
    const dt = parseDate(d);
    const inMonth = dt.getMonth() === viewMonth;
    const dow = (dt.getDay() + 6) % 7;          // 0 = Mon .. 6 = Sun
    const weekend = dow >= 5;
    const isToday = d === today;
    const isSel = d === selectedIso;
    const isPast = d < today;
    const dayEvs = byDay.get(d) || [];

    const pills = dayEvs.map(ev => {
      const c = eventColour(ev);
      const t = ev.all_day ? '' : `<span class="sch-pill__t">${esc(ev.time)}</span>`;
      return `<span class="sch-pill" data-sch-ev-layer="${esc(eventLayers(ev).join(' '))}" style="--ev-c:${esc(c)}">${t}<span class="sch-pill__n">${esc(ev.title)}</span></span>`;
    }).join('');
    const dots = dayEvs.slice(0, 6).map(ev => `<i class="sch-dot" style="--ev-c:${esc(eventColour(ev))}"></i>`).join('');
    const cellLayers = [...new Set(dayEvs.flatMap(eventLayers))].join(' ');

    cells.push(`<button type="button" class="sch-cell${inMonth ? '' : ' is-out'}${weekend ? ' is-wknd' : ''}${isToday ? ' is-today' : ''}${isSel ? ' is-sel' : ''}${isPast ? ' is-past' : ''}${dayEvs.length ? ' has-ev' : ''}" data-sch-day="${esc(d)}"${cellLayers ? ` data-sch-cell-layers="${esc(cellLayers)}"` : ''} aria-pressed="${isSel}" aria-label="${esc(LONG_DAY_FMT.format(dt))}${dayEvs.length ? `, ${dayEvs.length} event${dayEvs.length === 1 ? '' : 's'}` : ''}">
      <span class="sch-cell__head"><b class="sch-cell__num">${dt.getDate()}</b>${dayEvs.length > 6 ? `<span class="sch-cell__cnt">${dayEvs.length}</span>` : ''}</span>
      <span class="sch-cell__pills" aria-hidden="true">${pills}</span>
      <span class="sch-cell__dots" aria-hidden="true">${dots}</span>
    </button>`);
  }

  // Right-hand Day Inspector
  const selIso = selectedIso || today;
  const selDate = parseDate(selIso);
  const selBadge = dayBadge(selIso, today);
  const selEvs = indexByDay(events, selIso, selIso).get(selIso) || [];

  // Upcoming next list: strictly future events starting after today (never repeating today's items)
  const upcoming = events
    .filter(ev => ev.date > today)
    .slice(0, 7);

  const upcomingHtml = upcoming.length
    ? `<div class="sch-up">
        <div class="sch-up__head hud">Coming up next</div>
        <ul class="sch-up__list">${upcoming.map(ev => {
          const jumpDate = ev.date;
          const badge = dayBadge(jumpDate, today);
          return `<li><button type="button" class="sch-up__row" data-sch-jump="${esc(jumpDate)}" data-sch-ev-layer="${esc(eventLayers(ev).join(' '))}" style="--ev-c:${esc(eventColour(ev))}">
            <span class="sch-up__bar" style="background:${esc(eventBarBackground(ev))}"></span>
            <span class="sch-up__main"><span class="sch-up__title">${esc(ev.title)}</span><span class="sch-up__sub">${esc(badge || fmtDay(jumpDate))}${ev.all_day ? '' : ` · ${esc(ev.time)}`} · ${esc(eventTagLabel(ev))}</span></span>
          </button></li>`;
        }).join('')}</ul>
      </div>`
    : '';

  return `<div class="sch-split">
    <section class="card sch-calcard" style="--lc-c: var(--lc-6)">
      <div class="card__in">
        <div class="sch-dows">${DOW_SHORT.map((d, i) => `<span class="sch-dow${i >= 5 ? ' is-wknd' : ''}">${d}</span>`).join('')}</div>
        <div class="sch-grid">${cells.join('')}</div>
      </div>
    </section>
    <aside class="card sch-side" style="--lc-c: var(--lc-2)">
      <div class="card__in">
        <div class="card__head sch-side__head">
          <span class="hud sch-side__day">${esc(LONG_DAY_FMT.format(selDate))}</span>
          ${selBadge ? `<span class="chip${selIso === today ? ' chip--today' : ''}">${esc(selBadge)}</span>` : ''}
        </div>
        <div class="card__body sch-side__body">
          ${selEvs.length
            ? `<div class="sch-evs">${selEvs.map(ev => renderEventCard(ev, selIso)).join('')}</div>`
            : `<div class="sch-empty">Nothing scheduled on this day.</div>`}
          ${upcomingHtml}
        </div>
      </div>
    </aside>
  </div>`;
}

function renderAgendaView(events, today) {
  const b = monthBounds(viewYear, viewMonth);
  const startIso = b.firstIso <= today && today <= b.lastIso ? today : b.firstIso;
  const endIso = addDays(b.lastIso, 45);
  const q = searchText.trim().toLowerCase();

  const filtered = events.filter(ev => {
    if ((ev.until || ev.date) < startIso || ev.date > endIso) return false;
    if (!q) return true;
    const hay = `${ev.title} ${ev.subtitle} ${ev.location} ${ev.detail} ${sourceLabel(ev.layer)}`.toLowerCase();
    return hay.includes(q);
  });

  const groups = new Map();
  for (const ev of filtered) {
    const d = ev.date < startIso ? startIso : ev.date;
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(ev);
  }
  const sortedDays = [...groups.keys()].sort();

  const body = sortedDays.length
    ? sortedDays.map(d => {
        const badge = dayBadge(d, today);
        const dt = parseDate(d);
        const dayLayers = [...new Set(groups.get(d).flatMap(eventLayers))].join(' ');
      return `<section class="sch-agday${d === today ? ' is-today' : ''}" data-sch-cell-layers="${esc(dayLayers)}">
          <div class="sch-agday__head">
            <button type="button" class="sch-agday__btn" data-sch-jump-month="${esc(d)}">
              <b>${esc(LONG_DAY_FMT.format(dt))}</b>
              ${badge ? `<span class="chip${d === today ? ' chip--today' : ''}">${esc(badge)}</span>` : ''}
            </button>
          </div>
          <div class="sch-evs">${groups.get(d).map(ev => renderEventCard(ev, d)).join('')}</div>
        </section>`;
      }).join('')
    : `<div class="sch-empty sch-empty--box">${q ? `No events matching “${esc(searchText)}”.` : 'Nothing scheduled in this period.'}</div>`;

  return `<section class="card sch-agenda" style="--lc-c: var(--lc-6)">
    <div class="card__in">
      <div class="sch-agbar">
        <label class="sch-search">
          ${ico('filter')}
          <input type="search" class="sch-search__in" data-sch-search value="${esc(searchText)}" placeholder="Filter events by title, venue, artist…" aria-label="Filter schedule events">
        </label>
        <span class="sch-agbar__meta">${filtered.length} event${filtered.length === 1 ? '' : 's'}</span>
      </div>
      <div class="sch-aglist">${body}</div>
    </div>
  </section>`;
}

function render() {
  if (!root || !active) return;
  spottedLayer = null;
  ensureMonthInit();
  const today = todayIso();
  const b = monthBounds(viewYear, viewMonth);
  const allEvs = data?.events || [];
  // Match the exact events visible in the active view (visible grid for Month, agenda span for Agenda)
  const rangeStart = viewMode === 'agenda' ? (b.firstIso <= today && today <= b.lastIso ? today : b.firstIso) : b.gridStart;
  const rangeEnd = viewMode === 'agenda' ? addDays(b.lastIso, 45) : b.gridEnd;
  const viewAll = allEvs.filter(ev => (ev.until || ev.date) >= rangeStart && ev.date <= rangeEnd);
  const visEvs = visibleEvents();

  // Preserve search focus & caret when typing in Agenda search box
  const hadSearchFocus = document.activeElement?.matches?.('[data-sch-search]');
  const selStart = hadSearchFocus ? document.activeElement.selectionStart : null;

  root.innerHTML = `<div class="sch">
    ${renderToolbar(viewAll, today)}
    ${renderBanners()}
    ${!data && loading
      ? `<div class="sch-empty sch-empty--box">Loading schedule…</div>`
      : viewMode === 'agenda'
        ? renderAgendaView(visEvs, today)
        : renderMonthView(visEvs, today)}
  </div>`;

  if (hadSearchFocus) {
    const inp = $('[data-sch-search]', root);
    if (inp) {
      inp.focus();
      if (selStart != null) inp.setSelectionRange(selStart, selStart);
    }
  }
}

// ---- interactions -------------------------------------------------------------------------------

function stepMonth(delta) {
  const next = new Date(viewYear, viewMonth + delta, 1);
  viewYear = next.getFullYear();
  viewMonth = next.getMonth();
  const today = todayIso();
  const b = monthBounds(viewYear, viewMonth);
  selectedIso = (today >= b.firstIso && today <= b.lastIso) ? today : b.firstIso;
  fetchSchedule(false);
}

function jumpToDate(iso, switchToMonth = false) {
  const dt = parseDate(iso);
  viewYear = dt.getFullYear();
  viewMonth = dt.getMonth();
  selectedIso = iso;
  if (switchToMonth) {
    viewMode = 'month';
    saveViewMode('month');
  }
  fetchSchedule(false);
}

function onClick(e) {
  const btn = e.target.closest('button');
  if (!btn || !root.contains(btn)) return;

  if (btn.matches('[data-sch-step]')) {
    pickerOpen = false;
    stepMonth(Number(btn.dataset.schStep));
  } else if (btn.matches('[data-sch-picker-toggle]')) {
    pickerOpen = !pickerOpen;
    pickerYear = viewYear;
    render();
  } else if (btn.matches('[data-sch-pyear]')) {
    pickerYear = (pickerYear ?? viewYear) + Number(btn.dataset.schPyear);
    render();
  } else if (btn.matches('[data-sch-pick-month]')) {
    viewYear = pickerYear ?? viewYear;
    viewMonth = Number(btn.dataset.schPickMonth);
    pickerOpen = false;
    const today = todayIso();
    const b = monthBounds(viewYear, viewMonth);
    selectedIso = (today >= b.firstIso && today <= b.lastIso) ? today : b.firstIso;
    fetchSchedule(false);
  } else if (btn.matches('[data-sch-today]')) {
    pickerOpen = false;
    jumpToDate(todayIso());
  } else if (btn.matches('[data-sch-mode]')) {
    viewMode = btn.dataset.schMode === 'agenda' ? 'agenda' : 'month';
    saveViewMode(viewMode);
    render();
  } else if (btn.matches('[data-sch-layer]')) {
    const id = btn.dataset.schLayer;
    if (hiddenLayers.has(id)) hiddenLayers.delete(id);
    else hiddenLayers.add(id);
    saveHidden();
    render();
  } else if (btn.matches('[data-sch-show-all]')) {
    hiddenLayers.clear();
    saveHidden();
    render();
  } else if (btn.matches('[data-sch-toggle-empty]')) {
    hideEmpty = !hideEmpty;
    saveHideEmpty(hideEmpty);
    render();
  } else if (btn.matches('[data-sch-day]')) {
    selectedIso = btn.dataset.schDay;
    const dt = parseDate(selectedIso);
    if (dt.getMonth() !== viewMonth || dt.getFullYear() !== viewYear) {
      viewYear = dt.getFullYear();
      viewMonth = dt.getMonth();
      fetchSchedule(false);
    } else {
      render();
    }
  } else if (btn.matches('[data-sch-jump]')) {
    jumpToDate(btn.dataset.schJump, false);
  } else if (btn.matches('[data-sch-jump-month]')) {
    jumpToDate(btn.dataset.schJumpMonth, true);
  } else if (btn.matches('[data-sch-sync]')) {
    btn.disabled = true;
    api.post('/api/owner/widgets/diary/refresh')
      .then(() => { toast('Syncing calendar…'); setTimeout(() => fetchSchedule(true), 1200); })
      .catch(err => toast(err.message))
      .finally(() => { btn.disabled = false; });
  }
}

function onInput(e) {
  if (e.target.matches?.('[data-sch-search]')) {
    searchText = e.target.value;
    render();
  }
}

function onKeyDown(e) {
  if (viewMode !== 'month' || !selectedIso) return;
  if (!e.target.matches?.('[data-sch-day]')) return;
  const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  if (!delta) return;
  e.preventDefault();
  const nextIso = addDays(selectedIso, delta);
  jumpToDate(nextIso, false);
  requestAnimationFrame(() => root.querySelector(`[data-sch-day="${nextIso}"]`)?.focus());
}

// Desktop-only category hover spotlight: highlights matching events/days and dims everything else in-place (no layout shift).
let spottedLayer = null;
const canHover = () => window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;

function setSpotlight(layerId, chipEl = null) {
  if (spottedLayer === layerId) return;
  spottedLayer = layerId;
  const wrap = root?.querySelector('.sch');
  if (!wrap) return;
  wrap.classList.toggle('is-spotting', !!layerId);
  if (layerId && chipEl) {
    wrap.style.setProperty('--spot-c', chipEl.style.getPropertyValue('--chip-c') || 'var(--sch-c)');
  } else {
    wrap.style.removeProperty('--spot-c');
  }
  wrap.querySelectorAll('[data-sch-layer]').forEach(el => el.classList.toggle('is-spot', !!layerId && el.dataset.schLayer === layerId));
  wrap.querySelectorAll('[data-sch-ev-layer]').forEach(el => {
    const match = !!layerId && el.dataset.schEvLayer.split(' ').includes(layerId);
    el.classList.toggle('is-spot', match);
  });
  wrap.querySelectorAll('[data-sch-cell-layers]').forEach(el => {
    const match = !!layerId && el.dataset.schCellLayers.split(' ').includes(layerId);
    el.classList.toggle('is-spot', match);
  });
}

function onPointerOver(e) {
  if (e.pointerType !== 'mouse' || !canHover()) return;
  const chip = e.target.closest?.('[data-sch-layer].is-on');
  if (chip && root.contains(chip)) setSpotlight(chip.dataset.schLayer, chip);
}

function onPointerOut(e) {
  if (!spottedLayer) return;
  const chip = e.target.closest?.('[data-sch-layer]');
  if (!chip) return;
  const nextChip = e.relatedTarget?.closest?.('[data-sch-layer].is-on');
  if (nextChip && root.contains(nextChip)) {
    setSpotlight(nextChip.dataset.schLayer, nextChip);
  } else {
    setSpotlight(null);
  }
}
