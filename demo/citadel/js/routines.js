// The Routines page (#routines): when Home Assistant's routines run, changed on the fly (Mike moves his morning routine
// with his shifts, 2026-11-24). Each routine is a card: on/off, its time, its weekdays, Skip next and Run now. The
// schedules live in Home Assistant on Probe-1 (app/routines.py says how a routine is put together there), so they still
// run when Citadel is off. The page reads GET /api/owner/routines when shown and every 30 s while on screen, and sends
// one change at a time to POST /api/owner/routines/<id>, applied here first and corrected by the re-read.
//
// Everything is .rt* / [data-rt-*]; never reuse [data-act] or [data-date] (app.js and util.js treat those globally).
import * as api from './api.js';
import { $, esc, ico, toast } from './util.js';

const API = '/api/owner/routines';
const POLL_MS = 30000;
const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const root = $('#view-routines');
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

let V = null, active = false, started = false, loading = false, again = false, timer = null;
let armed = null, armTimer = null;          // the routine whose Run now is waiting for its second press
let busy = 0;                               // changes in flight: a poll landing mid-change would undo the optimistic update

export function onView(v) {
  const was = active;
  active = v === 'routines';
  if (active && !started) {
    started = true;
    document.addEventListener('visibilitychange', () => { if (active && !document.hidden) refresh(); });
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('focusout', e => { if (e.target.matches?.('[data-rt-time]')) { if (!sendTime(e.target)) setTimeout(render); } });
  }
  if (active && !was) refresh();
  if (!active) { clearTimeout(timer); timer = null; }
}

async function refresh() {
  if (loading || busy) { again = true; return; }
  loading = true;
  clearTimeout(timer);
  try {
    V = await api.get(API);
  } catch (e) {
    V = { ...(V || { routines: [] }), available: false, error: e.message };
  } finally {
    loading = false;
  }
  render();
  if (again) { again = false; refresh(); return; }
  if (active && !document.hidden) timer = setTimeout(refresh, POLL_MS);
}

// ---- words ---------------------------------------------------------------------------------------------------------

function when(iso) {
  const d = new Date(iso), today = new Date();
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 864e5);
  const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday' : dayFmt.format(d).replace(',', '');
  return `${day} at ${timeFmt.format(d)}`;
}

const lc = s => s.replace(/^(Today|Tomorrow|Yesterday)/, w => w.toLowerCase());     // "Next: tomorrow at …", but "Thu 26 Nov" keeps its capital

function status(r) {
  if (!r.available) return 'Not available in Home Assistant';
  if (!r.on) return 'Off';
  if (!r.days.length) return 'No days picked';
  if (r.skipped_run) return `Skipping ${lc(when(r.skipped_run))}` + (r.next_run ? ` · then ${lc(when(r.next_run))}` : '');
  return r.next_run ? `Next: ${lc(when(r.next_run))}` : 'Not due in the next two weeks';
}

// ---- drawing -------------------------------------------------------------------------------------------------------

const INKS = ['lc-1', 'lc-3', 'lc-5', 'lc-6'];          // LCARS inks each card in its own colour (as the Audio page)

function card(r, i) {
  const days = r.can_days
    ? `<div class="rt-days" role="group" aria-label="Days">${DAYS.map(([d, label]) =>
        `<button class="rt-day" type="button" data-rt-day="${d}" aria-pressed="${r.days.includes(d)}">${label}</button>`).join('')}</div>`
    : '';
  const skip = r.can_skip
    ? `<button class="rt-btn" type="button" data-rt-skip aria-pressed="${r.skip}" ${r.on && r.days.length ? '' : 'disabled'}>${ico('next')}<span>${r.skip ? "Don't skip" : 'Skip next'}</span></button>`
    : '';
  const run = r.can_run
    ? `<button class="rt-btn${armed === r.id ? ' is-armed' : ''}" type="button" data-rt-run ${r.running ? 'disabled' : ''}>${ico('play')}<span>${r.running ? 'Running…' : armed === r.id ? 'Run it now?' : 'Run now'}</span></button>`
    : '';
  return `<section class="card rt-card${r.on ? '' : ' is-off'}" data-rt-id="${esc(r.id)}" style="--lc-c: var(--${INKS[i % INKS.length]})"><div class="card__in">
    <div class="card__head"><span class="hud">${esc(r.name)}</span>
      <button class="rt-sw" type="button" data-rt-on aria-pressed="${r.on}" aria-label="${esc(r.name)} on">${r.on ? 'On' : 'Off'}</button></div>
    <div class="card__body">
      <div class="rt-when">
        <input class="rt-time" type="time" step="60" value="${esc(r.time || '')}" aria-label="Time" data-rt-time>
        ${days}
      </div>
      <p class="rt-status${r.skipped_run ? ' is-skip' : ''}">${esc(status(r))}</p>
      <div class="rt-acts">${skip}${run}${r.last_run ? `<span class="rt-last">Last ran ${esc(lc(when(r.last_run)))}</span>` : ''}</div>
    </div></div></section>`;
}

function render() {
  if (!root || !V) return;
  if (document.activeElement?.matches?.('.rt-card [data-rt-time]')) return;   // not under a time being typed (redrawn on leaving it)
  const list = V.routines || [];
  let body;
  if (V.configured === false) body = `<p class="rt-note">No Home Assistant token on this PC yet.</p>`;
  else if (!list.length && V.available) body = `<p class="rt-note">No routines in Home Assistant yet.</p>`;
  else body = `<div class="rt-grid">${list.map(card).join('')}</div>`;
  root.innerHTML = `<div class="rt${V.available ? '' : ' is-down'}">
    ${V.available ? '' : `<p class="rt-down">${ico('alert')}<span>${esc(V.error || "Home Assistant isn't answering")}</span></p>`}
    ${body}</div>`;
}

// ---- changing ------------------------------------------------------------------------------------------------------

const find = el => {
  const id = el.closest('[data-rt-id]')?.dataset.rtId;
  return { id, r: (V?.routines || []).find(x => x.id === id) };
};

async function send(id, change, local) {
  const r = V.routines.find(x => x.id === id);
  const before = { ...r };
  if (local) { Object.assign(r, local); render(); }
  busy++;
  let ok = true;
  try {
    await api.post(`${API}/${encodeURIComponent(id)}`, change);
  } catch (e) {
    ok = false;
    Object.assign(r, before);
    toast(e.message);
  } finally {
    busy--;
  }
  refresh();
  return ok;
}

function onClick(e) {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  const { id, r } = find(b);
  if (!r) return;
  if (b.matches('[data-rt-on]')) send(id, { on: !r.on }, { on: !r.on, next_run: null, skipped_run: null });
  else if (b.matches('[data-rt-day]')) {
    const d = b.dataset.rtDay, days = r.days.includes(d) ? r.days.filter(x => x !== d) : DAYS.map(x => x[0]).filter(x => x === d || r.days.includes(x));
    send(id, { days }, { days });
  } else if (b.matches('[data-rt-skip]')) send(id, { skip: !r.skip }, { skip: !r.skip });
  else if (b.matches('[data-rt-run]')) {
    clearTimeout(armTimer);
    if (armed !== id) {                     // the first press asks; it makes noise in a room, so a stray tap shouldn't run it
      armed = id; render();
      armTimer = setTimeout(() => { armed = null; render(); }, 4000);
      return;
    }
    armed = null;
    send(id, { run: true }, { running: true }).then(ok => { if (ok) toast(`${r.name} started`); });
  }
}

// A time box fires "change" as soon as each part is typed (the hour, then the minutes), so the time is sent when the
// box is left, or after a pause in typing, not on every change.
let timeTimer = null;
function onChange(e) {
  const input = e.target.closest('[data-rt-time]');
  if (!input) return;
  clearTimeout(timeTimer);
  timeTimer = setTimeout(() => sendTime(input), 2500);
}
function sendTime(input) {
  clearTimeout(timeTimer);
  const { id, r } = find(input);
  if (!r || !/^\d{2}:\d{2}$/.test(input.value) || input.value === r.time) return false;
  send(id, { time: input.value }, { time: input.value });
  return true;
}
