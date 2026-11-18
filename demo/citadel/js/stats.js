// The Fleet page (#stats, once "Stats"): every machine's CPU, memory, temperatures, GPU and disks over time, and the moments its CPU
// stayed high with the processes behind them. The history is kept by the stats collector on NZXT
// (collector/citadel_collector.py); Citadel's /api/owner/stats/* reads it back, so nothing here talks to NZXT.
// app.js tells this module when the page is shown (onView). Plan: docs/tasks/stats-collector.md.
//
// Layout ("Fleet", Mike's pick from the 2026-11-18 mockup): every machine down the side with its latest CPU / memory /
// temperature and a CPU trend over the range; the picked one as four equal panels (Load, Memory, Temperature,
// Storage), with its High CPU moments full width underneath only when there are any. Above the machines, the Fleet
// tile opens an overview of every machine's CPU / GPU load and temperatures, three ways (switch beside the range):
// Heatmap (default), Grid and Overlay. Each machine keeps one colour (--rs-m1..5, its place in the list) in all three.
//
// Charts are drawn here as SVG (no chart library: CSP 'self', no build step). The plot stretches to its box
// (preserveAspectRatio none, non-scaling strokes) and the axis labels are HTML on top, so text never distorts. A gap in
// the readings (the collector or the machine was off) breaks the line rather than joining across it.
//
// Everything here is [data-rs-*]; never reuse [data-act] or [data-date] (app.js and util.js treat those globally).
import * as api from './api.js';
import { $, $$, bytes, duration, esc, hhmm, ico } from './util.js';

const API = '/api/owner/stats';
const root = $('#view-stats');
const RANGES = [['1h', '1 hour', 3600], ['6h', '6 hours', 6 * 3600], ['24h', '24 hours', 86400], ['7d', '7 days', 7 * 86400], ['30d', '30 days', 30 * 86400], ['1y', '1 year', 365 * 86400]];
const W = 1000, H = 200;                  // the plot's own units; it's stretched to its box
const GB = 1e9;
// Series colours follow the entity: the first series of a chart is the accent (in LCARS, the card's own colour), the
// second the neutral silver. Status colours (--ok/--warn/--bad) stay reserved for state.
const C1 = 'var(--rs-c1)', C2 = 'var(--rs-c2)';

let active = false, started = false, machines = [], collector = null, timer = null, loading = 0, drawing = 0, win = null, shown = null;
const VIEWS = [['heat', 'Heatmap'], ['grid', 'Grid'], ['overlay', 'Overlay']];
let pick = load('rs-machine', 'fleet'), range = load('rs-range', '6h'), fview = load('rs-fview', 'heat');
if (!VIEWS.some(v => v[0] === fview)) fview = 'heat';
if (!RANGES.some(r => r[0] === range)) range = '6h';
const charts = new Map();                 // chart id -> what its tooltip needs
const hist = new Map();                   // machine id -> {s: series, spikes, range} (the side list); kept across reloads so nothing blanks

function load(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked: just not remembered */ } }
const span = () => RANGES.find(r => r[0] === range)[2];

// A Machines panel in Monitoring links here for its machine (cards.js: data-rs-machine).
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-rs-machine]');
  if (a) { pick = a.dataset.rsMachine; save('rs-machine', pick); if (started) showPick(); }
}, true);

export function onView(v) {
  const was = active;
  active = v === 'stats';
  if (active && !started) { started = true; boot(); }
  else if (active && !was) refresh(true);
  if (!active) { clearTimeout(timer); timer = null; }
}

function boot() {
  root.innerHTML = `<div class="rs"><div class="rs__body"><nav class="rs-fleet" id="rs-fleet" aria-label="Machines"></nav>
    <div class="rs-detail"><div class="rs-dhead"><h2 id="rs-name"></h2><div class="rs__sub" id="rs-sub"></div><span class="rs-ctl">
      <span class="seg" id="rs-views" role="group" aria-label="Fleet view" hidden>${VIEWS.map(([id, label]) => `<button type="button" data-rs-view="${id}" aria-pressed="${id === fview}">${label}</button>`).join('')}</span>
      <span class="seg" role="group" aria-label="Time range">${RANGES.map(([id, label]) => `<button type="button" data-rs-range="${id}" aria-pressed="${id === range}">${label}</button>`).join('')}</span></span></div>
    <div class="rs__grid" id="rs-grid"><div class="rs-empty"><span class="spin"></span></div></div></div></div></div>`;
  root.addEventListener('click', onClick);
  root.addEventListener('pointermove', onHover);
  root.addEventListener('pointerleave', () => $$('.rs-chart', root).forEach(hideTip), true);
  root.addEventListener('pointerleave', fleetUnhover);
  root.addEventListener('pointerover', highlight);
  refresh(true);
}

function onClick(e) {
  const m = e.target.closest('[data-rs-pick]');
  if (m) { pick = m.dataset.rsPick; save('rs-machine', pick); showPick(); return; }
  const v = e.target.closest('[data-rs-view]');
  if (v) { fview = v.dataset.rsView; save('rs-fview', fview); $$('[data-rs-view]', root).forEach(b => b.setAttribute('aria-pressed', String(b === v))); if (pick === 'fleet' && win) drawFleet(); return; }
  const r = e.target.closest('[data-rs-range]');
  if (r) { range = r.dataset.rsRange; save('rs-range', range); $$('[data-rs-range]', root).forEach(b => b.setAttribute('aria-pressed', String(b === r))); loadHistory(); }
}

// The machine list + latest readings. `full` also reloads the history; the timer only does that for a day or less
// (a week or more barely changes in a minute), but always refreshes the side list's latest figures.
async function refresh(full) {
  clearTimeout(timer);
  try {
    const d = await api.get(`${API}/machines`);
    machines = d.machines || [];
    collector = d.collector;
  } catch (exc) {
    if (!machines.length) $('#rs-grid').innerHTML = `<div class="rs-empty">${ico('alert')}<b>No history right now</b>${esc(exc?.message || '')}</div>`;
  }
  if (!active || !machines.length) return;
  if (pick !== 'fleet' && !machines.some(m => m.id === pick)) pick = 'fleet';
  renderFleet(); renderHead();
  if (full || span() <= 86400) loadHistory();
  else schedule();
}
function schedule() { clearTimeout(timer); timer = setTimeout(() => active && refresh(false), span() <= 3600 ? 30_000 : 60_000); }

function showPick() {
  renderFleet(); renderHead();
  const ready = win && (pick === 'fleet' ? machines.some(m => hist.get(m.id)?.range === range) : hist.get(pick)?.range === range);
  if (ready) loadPicked(++drawing); else loadHistory();
}

// ---- the side list: one button per machine ---------------------------------------------------------------------------

function renderFleet() {
  const el = $('#rs-fleet');
  if (!el) return;
  const pct = v => `${Math.round(v)}%`, deg = v => `${Math.round(v)}°C`;
  // machines that are off or asleep drop to the end (stable sort, so each group keeps Remote Access order); the list
  // comes fresh from the API each refresh, so one that wakes goes straight back to its own place
  const order = [...machines].sort((a, b) => (a.up === false) - (b.up === false));
  el.innerHTML = fleetTile() + order.map(m => {
    const st = m.stats, off = m.up === false, live = st && !off;
    const mem = live && st.mem?.total ? st.mem.used / st.mem.total * 100 : null;
    const meter = (k, v, f, hot) => `<span class="rs-meter${v != null && v >= hot ? ' is-hot' : ''}">${k}<b>${v == null ? '—' : f(v)}</b><i><span style="width:${v == null ? 0 : Math.min(100, v)}%"></span></i></span>`;
    const h = hist.get(m.id)?.range === range ? hist.get(m.id) : null, n = h?.spikes.length || 0;
    const dot = off ? '<span class="dot"></span>' : m.error && !st ? '<span class="dot dot--bad"></span>' : '<span class="dot dot--ok"></span>';
    const sub = off ? (m.at ? `asleep · ${hhmm(m.at)}` : 'asleep') : st?.os || '';
    return `<button type="button" class="rs-m${off ? ' is-off' : ''}" data-rs-pick="${esc(m.id)}" aria-pressed="${m.id === pick}">
      <span class="rs-m__head">${dot}<b>${esc(m.name)}</b><small>${esc(sub)}</small></span>
      <span class="rs-meters">${meter('CPU', live ? st.cpu?.percent ?? null : null, pct, 85)}${meter('Mem', mem, pct, 85)}${meter('Temp', live ? st.cpu?.temp ?? null : null, deg, 80)}</span>
      ${h ? spark(h.s) : '<span class="rs-spark"></span>'}${n ? `<span class="rs-m__warn">${n} high CPU</span>` : ''}</button>`;
  }).join('');
  // phones: the list is a sideways strip, so bring the picked machine into it (once per pick, not on every refresh)
  if (shown !== pick && el.scrollWidth > el.clientWidth) {
    const b = $('[aria-pressed="true"]', el);
    if (b) el.scrollLeft += b.getBoundingClientRect().left - el.getBoundingClientRect().left;
  }
  shown = pick;
}

// the CPU trend over the range, on the same clock as the charts so gaps sit where the charts' gaps are
function spark(s) {
  const a = s.metrics?.cpu?.avg || [];
  if (!win || !a.some(v => v != null)) return '<span class="rs-spark"></span>';
  return `<svg class="rs-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d="${linePath(s, a, 0, 100, 100, 30)}"/></svg>`;
}

// one series as an SVG path on the window's clock (w × h units), broken wherever readings are missing
function linePath(s, a, lo, hi, w = W, h = H) {
  const t = s.t || [], b = s.bucket || 30, span = win.end - win.start;
  let d = '', prev = null;
  a.forEach((v, i) => {
    if (v == null) { prev = null; return; }
    const x = ((t[i] + b / 2 - win.start) / span) * w, y = h - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * h;
    d += `${prev != null && t[i] - t[prev] <= 2.5 * b ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(1)}`;
    prev = i;
  });
  return d;
}

function renderHead() {
  $('#rs-views').hidden = pick !== 'fleet';
  if (pick === 'fleet') {
    const off = machines.filter(isOff), err = collector && collector.ok === false ? collector.error : '';
    $('#rs-name').textContent = 'Fleet';
    const txt = [`${machines.length} machines`, `${machines.length - off.length} on`, ...off.map(m => m.at ? `${m.name} asleep since ${hhmm(m.at)}` : `${m.name} asleep`)].join(' · ');
    $('#rs-sub').innerHTML = `<span>${esc(txt)}</span>${err ? `<span class="rs__err">${ico('alert')}${esc(err)}</span>` : ''}`;
    return;
  }
  const m = machines.find(x => x.id === pick), st = m?.stats;
  $('#rs-name').textContent = m?.name || '';
  const parts = st ? [st.os, st.cpu?.cores ? `${st.cpu.cores} threads` : '', st.mem?.total ? `${bytes(st.mem.total)} RAM` : '', st.uptime_s != null && m.up !== false ? `up ${duration(st.uptime_s)}` : ''] : [];
  if (m?.up === false) parts.push(m.at ? `asleep · last seen ${hhmm(m.at)}` : 'asleep');
  const err = collector && collector.ok === false ? collector.error : m?.up !== false && m?.error ? m.error : '';
  $('#rs-sub').innerHTML = `<span>${esc(parts.filter(Boolean).join(' · '))}</span>${err ? `<span class="rs__err">${ico('alert')}${esc(err)}</span>` : ''}`;
}

// ---- loading ------------------------------------------------------------------------------------------------------------

async function loadHistory() {
  clearTimeout(timer);
  const mine = ++loading, end = Math.ceil(Date.now() / 1000);
  win = { start: end - span(), end };
  // every machine's series + spikes (the side list), the picked one's charts drawn from the same answers
  const jobs = machines.map(m => {
    const job = Promise.all([get('series', m.id), get('spikes', m.id)]).then(([s, sp]) => ({ s, spikes: sp.spikes || [], range }));
    job.then(h => { if (mine === loading) { hist.set(m.id, h); if (active) renderFleet(); } }, () => {});
    return job;
  });
  await Promise.allSettled(jobs);
  if (mine !== loading || !active) return;
  renderFleet();
  await loadPicked(++drawing);
}

function get(kind, id) { return api.get(`${API}/${kind}?machine=${encodeURIComponent(id)}&start=${win.start}&end=${win.end}`); }

async function loadPicked(mine) {
  clearTimeout(timer);
  if (pick === 'fleet') { if (mine === drawing && active) drawFleet(); schedule(); return; }
  const grid = $('#rs-grid'), h = hist.get(pick)?.range === range ? hist.get(pick) : null;
  let disks = null, error = '';
  if (!h) error = collector && collector.ok === false ? collector.error : 'The stats collector isn’t answering';
  else { try { disks = await get('disks', pick); } catch { /* the bars still show from the latest reading */ } }
  if (mine !== drawing || !active) return;
  if (error) grid.innerHTML = `<div class="rs-empty">${ico('alert')}<b>No history right now</b>${esc(error)}</div>`;
  else draw(grid, h.s, disks, h.spikes, win.start, win.end);
  schedule();
}

// ---- the panels ---------------------------------------------------------------------------------------------------------

function draw(grid, s, d, spikes, start, end) {
  charts.clear();
  grid.classList.remove('rs__grid--one');
  const m = s.metrics || {}, out = [];
  const pct = v => `${Math.round(v)}%`, deg = v => `${v.toFixed(0)}°C`;
  const ser = (key, label, color, unit) => m[key] && { key, label, color, avg: m[key].avg, max: m[key].max, fmt: unit };
  const marks = spikes.map(sp => ({ at: sp.start, title: `${when(sp.start, end - start)} · peak ${Math.round(sp.peak)}%` }));
  out.push(chart('load', 'Load', s, [ser('cpu', 'CPU', C1, pct), ser('gpu', 'GPU', C2, pct)], [0, 100], pct, start, end, 'var(--lc-1)', marks));
  out.push(chart('mem', 'Memory', s, [ser('mem', 'Memory', C1, pct), ser('swap', 'Swap', C2, pct)], [0, 100], pct, start, end, 'var(--lc-2)'));
  out.push(chart('temp', 'Temperature', s, [ser('cpu_temp', 'CPU', C1, deg), ser('gpu_temp', 'GPU', C2, deg)], 'auto', deg, start, end, 'var(--lc-5)'));
  out.push(storage(d));
  if (spikes.length) out.push(spikeCard(spikes));      // nothing to note: no card at all
  grid.innerHTML = out.join('');
}

// Disks as fill bars from the latest reading (the history is hourly, so a short range may hold none), with how much
// each grew or shrank across the range when the history has a reading at both ends.
function storage(d) {
  const st = machines.find(x => x.id === pick)?.stats, list = st?.disks || [];
  const label = RANGES.find(r => r[0] === range)[1];
  const body = list.length ? `<div class="rs-disks">${list.map(k => {
    const p = k.total ? 100 * (k.total - k.free) / k.total : 0, hot = p >= 90;
    const h = d?.mounts?.[k.mount], i0 = h ? h.free.findIndex(v => v != null) : -1, i1 = h ? h.free.findLastIndex(v => v != null) : -1;
    const grew = i0 >= 0 && i1 > i0 ? h.free[i0] - h.free[i1] : 0;
    const change = Math.abs(grew) >= GB ? ` · ${grew > 0 ? '+' : '−'}${bytes(Math.abs(grew))} over ${label.replace(/^1 /, 'the ')}` : '';
    return `<div class="rs-disk"><span class="rs-disk__name" title="${esc(k.mount)}">${esc(k.mount)}</span><span class="rs-disk__bar"><i style="width:${p.toFixed(1)}%"${hot ? ' class="is-hot"' : ''}></i></span>
      <span class="rs-disk__pct${hot ? ' is-hot' : ''}">${Math.round(p)}%</span><span class="rs-disk__sub">${bytes(k.free)} free of ${bytes(k.total)}${change}</span></div>`;
  }).join('')}</div>` : '<div class="rs-none">No disks reported</div>';
  return `<section class="card rs-card" style="--lc-c:var(--lc-3)"><div class="card__in"><div class="card__head"><span class="hud">Storage</span></div>${body}</div></section>`;
}

function chart(id, title, s, list, yr, fmtAxis, start, end, lc, marks = []) {
  list = list.filter(Boolean);
  const t = s.t || [], bucket = s.bucket || 30;
  const open = `<section class="card rs-card" style="--lc-c:${lc}"><div class="card__in">`;
  if (!list.length || !t.length) {
    return `${open}<div class="card__head"><span class="hud">${esc(title)}</span></div><div class="rs-none">No readings in this range</div></div></section>`;
  }
  let [lo, hi] = yr === 'auto' ? autoRange(list) : yr;
  const mid = t.map(x => x + bucket / 2);
  const X = v => ((v - start) / (end - start)) * W, Y = v => H - ((v - lo) / (hi - lo)) * H;
  const runs = idx => {                     // the runs of consecutive readings, split wherever one is missing
    const out = []; let cur = [];
    for (let i = 0; i < t.length; i++) {
      const ok = idx(i) != null;
      if (ok && cur.length && t[i] - t[cur[cur.length - 1]] > 2.5 * bucket) { out.push(cur); cur = []; }
      if (ok) cur.push(i); else if (cur.length) { out.push(cur); cur = []; }
    }
    if (cur.length) out.push(cur);
    return out;
  };
  const line = (vals, r) => r.map((i, k) => `${k ? 'L' : 'M'}${X(mid[i]).toFixed(1)} ${Y(vals[i]).toFixed(1)}`).join('');
  const paths = list.map(se => {
    const rs = runs(i => se.avg[i]);
    // the peak within each bucket, as a faint band above the average (it only differs once readings are grouped)
    const band = se.max ? rs.map(r => `<path d="${line(se.max, r)}L${r.slice().reverse().map(i => `${X(mid[i]).toFixed(1)} ${Y(se.avg[i]).toFixed(1)}`).join('L')}Z" style="fill:${se.color}" class="rs-band"/>`).join('') : '';
    const dots = rs.filter(r => r.length === 1).map(r => `<circle cx="${X(mid[r[0]]).toFixed(1)}" cy="${Y(se.avg[r[0]]).toFixed(1)}" r="2" style="stroke:${se.color}" class="rs-dot"/>`).join('');
    return `${band}<path d="${rs.map(r => line(se.avg, r)).join('')}" style="stroke:${se.color}" class="rs-line"/>${dots}`;
  }).join('');
  const ticks = [lo, lo + (hi - lo) / 2, hi];
  const grid = ticks.map(v => `<line x1="0" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" class="rs-gridline"/>`).join('');
  const yl = ticks.map(v => `<span style="top:${(Y(v) / H) * 100}%">${esc(fmtAxis(v))}</span>`).join('');
  const xl = xTicks(start, end).map(v => { const at = (X(v) / W) * 100; return `<span style="left:${at}%"${at > 94 ? ' class="is-end"' : at < 4 ? ' class="is-start"' : ''}>${esc(xLabel(v, end - start))}</span>`; }).join('');
  // high CPU moments on the Load chart: an amber pin at each start
  const mk = marks.filter(m => m.at >= start && m.at <= end).map(m => `<span class="rs-mark" style="left:${(X(m.at) / W) * 100}%" title="${esc(m.title)}"></span>`).join('');
  const last = list.map(se => { const i = lastIdx(se.avg); return i == null ? null : se.fmt(se.avg[i], i); });
  const legend = `<span class="rs-legend">${list.map((se, k) => `<span><i style="background:${se.color}"></i>${esc(se.label)}${last[k] ? ` <b>${esc(last[k])}</b>` : ''}</span>`).join('')}</span>`;
  charts.set(id, { t, mid, bucket, list, start, end });
  return `${open}<div class="card__head"><span class="hud">${esc(title)}</span>${legend}</div>
    <div class="rs-chart" data-rs-chart="${id}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${grid}${paths}</svg>
      <div class="rs-y">${yl}</div><div class="rs-x">${xl}</div>${mk}<div class="rs-cross" hidden></div><div class="rs-tip" hidden></div></div></div></section>`;
}

function autoRange(list) {
  const vals = list.flatMap(se => [...se.avg, ...(se.max || [])]).filter(v => v != null);
  const lo = Math.floor((Math.min(...vals) - 5) / 10) * 10, hi = Math.ceil((Math.max(...vals) + 5) / 10) * 10;
  return [Math.max(0, lo), Math.max(hi, lo + 20)];
}
const lastIdx = a => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return i; return null; };

function xTicks(start, end) {
  // whole minutes / hours / days / months in local time, so labels land on 14:15, 12:00, Mon 17, Nov; at most 8 of them
  const span = end - start, M = 60, H = 3600, D = 86400;
  const steps = [[10 * M, 'n'], [15 * M, 'n'], [30 * M, 'n'], [H, 'h'], [3 * H, 'h'], [6 * H, 'h'], [D, 'd'], [2 * D, 'd'], [7 * D, 'd'], [30 * D, 'm'], [60 * D, 'm']];
  const [step, unit] = steps.find(([st]) => span / st <= 8) || steps[steps.length - 1];
  const d = new Date(start * 1000);
  if (unit === 'n') d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  else if (unit === 'h') d.setMinutes(0, 0, 0); else d.setHours(0, 0, 0, 0);
  if (unit === 'm') d.setDate(1);
  const out = [];
  for (let n = 0; n < 400 && d.getTime() / 1000 <= end; n++) {
    const v = d.getTime() / 1000;
    const ok = unit === 'n' ? (d.getHours() * 60 + d.getMinutes()) % (step / M) === 0 : unit === 'h' ? d.getHours() % (step / H) === 0 : unit === 'm' ? d.getMonth() % (step / (30 * D)) === 0 : true;
    if (v >= start && ok) out.push(v);
    if (unit === 'n') d.setMinutes(d.getMinutes() + 5);
    else if (unit === 'h') d.setHours(d.getHours() + 1); else if (unit === 'd') d.setDate(d.getDate() + step / D); else d.setMonth(d.getMonth() + 1);
  }
  return out;
}
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric' });
const monFmt = new Intl.DateTimeFormat('en-GB', { month: 'short' });
const fullFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
function xLabel(v, span) {
  const d = new Date(v * 1000);
  return span <= 86400 ? hhmm(v) : span <= 31 * 86400 ? dayFmt.format(d) : monFmt.format(d);
}
const when = (v, span) => (span <= 86400 ? hhmm(v) : `${fullFmt.format(new Date(v * 1000))} ${hhmm(v)}`);

// ---- hover: a crosshair and every series' value at that moment --------------------------------------------------------

function onHover(e) {
  const box = e.target.closest?.('.rs-chart[data-rs-chart]');
  $$('.rs-chart', root).forEach(c => { if (c !== box) hideTip(c); });
  fleetHover(e);
  if (!box) return;
  const c = charts.get(box.dataset.rsChart);
  if (!c) return;
  const r = box.getBoundingClientRect(), f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const at = c.start + f * (c.end - c.start);
  let i = nearest(c.mid, at);
  const span = c.end - c.start;
  const cross = $('.rs-cross', box), tip = $('.rs-tip', box);
  const near = i != null && Math.abs(c.mid[i] - at) <= c.bucket * 1.5;
  const x = near ? ((c.mid[i] - c.start) / span) * 100 : f * 100;
  cross.hidden = false; cross.style.left = `${x}%`;
  const rows = near ? c.list.map(se => se.avg[i] == null ? '' : `<span><i style="background:${se.color}"></i>${esc(se.label)} <b>${esc(se.fmt(se.avg[i], i))}</b>${se.max && se.max[i] != null && Math.round(se.max[i]) > Math.round(se.avg[i]) ? ` <small>peak ${esc(se.fmt(se.max[i], i))}</small>` : ''}</span>`).join('') : '';
  tip.innerHTML = `<b>${esc(when(near ? c.t[i] : at, span))}</b>${rows || '<span>No readings</span>'}`;
  tip.hidden = false;
  tip.classList.toggle('is-left', x > 60);
  tip.style.left = `${x}%`;
}
function hideTip(box) { $('.rs-cross', box)?.setAttribute('hidden', ''); $('.rs-tip', box)?.setAttribute('hidden', ''); }
function nearest(a, v) {
  if (!a.length) return null;
  let lo = 0, hi = a.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m; else hi = m; }
  return Math.abs(a[lo] - v) <= Math.abs(a[hi] - v) ? lo : hi;
}

// ---- high CPU moments -------------------------------------------------------------------------------------------------

function spikeCard(list) {
  const body = `<ol class="rs-spikes">${list.slice(0, 30).map(sp => {
    const mins = Math.max(1, Math.round((sp.end - sp.start + 30) / 60));
    return `<li><div class="rs-spike__head"><span>${esc(when(sp.start, Infinity))}</span><span>${mins} min · peak ${Math.round(sp.peak)}%</span></div>
      <div class="rs-procs">${sp.top.map(p => `<span class="rs-proc"><span class="rs-proc__name">${esc(p.name)}</span><span class="rs-proc__bar"><i style="width:${Math.min(100, p.percent)}%"></i></span><span class="rs-proc__pct">${Math.round(p.percent)}%</span></span>`).join('')}</div></li>`;
  }).join('')}</ol>`;
  return `<section class="card rs-card rs-card--spikes" style="--lc-c:var(--lc-7)"><div class="card__in"><div class="card__head"><span class="hud">High CPU</span><span class="rs-now">${list.length}</span></div>${body}</div></section>`;
}

// ---- the Fleet overview --------------------------------------------------------------------------------------------------
// Every machine's CPU / GPU load and temperatures from the side list's own answers (hist), so opening it costs nothing.
// Heatmap: four cards (CPU load, CPU temp, GPU load, GPU temp; GPU ones list only machines with a GPU), a band per machine coloured by how busy / hot (Day runs slate → burnt orange → red, Night violet → amber →
// red; only flat-out load or ≥70 °C turns warm). Grid: a machine per row, a figure per column. Overlay: a line per
// machine, pointing at a name picks its line out. Grid and Heatmap share one crosshair, and every number shows the
// moment under it.

const FIGS = [['cpu', 'CPU load'], ['cpu_temp', 'CPU temp'], ['gpu', 'GPU load'], ['gpu_temp', 'GPU temp']];
const isTemp = k => k.endsWith('_temp');
const fmtOf = k => (isTemp(k) ? v => `${Math.round(v)}°C` : v => `${Math.round(v)}%`);
const hotAt = k => (isTemp(k) ? 80 : 85);
const isOff = m => m.up === false;
const colourOf = m => `var(--rs-m${machines.indexOf(m) % 5 + 1})`;
const ordered = () => [...machines].sort((a, b) => isOff(a) - isOff(b));
const fleetRows = () => ordered().map(m => ({ m, h: hist.get(m.id)?.range === range ? hist.get(m.id) : null })).filter(r => r.h);
const seriesOf = (h, k) => { const a = h.s.metrics?.[k]?.avg; return a && a.some(v => v != null) ? a : null; };
const nowVal = (r, k) => { const a = isOff(r.m) ? null : seriesOf(r.h, k), i = a ? lastIdx(a) : null; return i == null ? null : a[i]; };
const posOf = v => ((v - win.start) / (win.end - win.start)) * 100;
const fcard = (title, body, meta, lc, cls = '') =>
  `<section class="card rs-card ${cls}" style="--lc-c:${lc}"><div class="card__in"><div class="card__head"><span class="hud">${esc(title)}</span>${meta}</div>${body}</div></section>`;
const timeTicks = () => xTicks(win.start, win.end).map(v => { const at = posOf(v); return `<span style="left:${at}%"${at > 94 ? ' class="is-end"' : at < 4 ? ' class="is-start"' : ''}>${esc(xLabel(v, win.end - win.start))}</span>`; }).join('');
const val = (r, k) => { const now = nowVal(r, k), f = fmtOf(k), txt = now == null ? '—' : f(now);
  return { txt, hot: now != null && now >= hotAt(k), attrs: `data-rs-val="${esc(r.m.id)}|${k}" data-now="${esc(txt)}"` }; };

function fleetTile() {
  const on = machines.filter(m => !isOff(m) && m.stats);
  const busy = on.map(m => [m, m.stats.cpu?.percent]).filter(x => x[1] != null).sort((a, b) => b[1] - a[1])[0];
  const hot = on.flatMap(m => [[m, 'CPU', m.stats.cpu?.temp], [m, 'GPU', m.stats.gpu?.temp]]).filter(x => x[2] != null).sort((a, b) => b[2] - a[2])[0];
  const rows = fleetRows(), spikes = rows.reduce((n, r) => n + r.h.spikes.length, 0);
  const cell = (k, v, sub, warm) => `<span${warm ? ' class="is-hot"' : ''}>${k}<b>${v}</b><small>${esc(sub)}</small></span>`;
  const lines = win ? rows.map(r => { const a = seriesOf(r.h, 'cpu'); return a ? `<path d="${linePath(r.h.s, a, 0, 100, 100, 30)}" style="stroke:${colourOf(r.m)}"/>` : ''; }).join('') : '';
  return `<button type="button" class="rs-m rs-m--fleet" data-rs-pick="fleet" aria-pressed="${pick === 'fleet'}">
    <span class="rs-m__head"><span class="dot${on.length ? ' dot--ok' : ''}"></span><b>Fleet</b><small>${machines.length - machines.filter(isOff).length} of ${machines.length} on</small></span>
    <span class="rs-fsum">${cell('Busiest', busy ? `${Math.round(busy[1])}%` : '—', busy ? busy[0].name : '', busy && busy[1] >= 85)}${cell('Hottest', hot ? `${Math.round(hot[2])}°C` : '—', hot ? `${hot[0].name} ${hot[1]}` : '', hot && hot[2] >= 80)}${cell('High CPU', spikes, RANGES.find(r => r[0] === range)[1], false)}</span>
    <svg class="rs-fmulti" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">${lines}</svg></button>`;
}

function drawFleet() {
  charts.clear();
  const grid = $('#rs-grid'), rows = fleetRows();
  grid.classList.toggle('rs__grid--one', fview !== 'overlay');
  if (!rows.length) {
    grid.innerHTML = `<div class="rs-empty">${ico('alert')}<b>No history right now</b>${esc(collector && collector.ok === false ? collector.error : 'The stats collector isn’t answering')}</div>`;
    return;
  }
  grid.innerHTML = fview === 'grid' ? fleetGrid(rows) : fview === 'overlay' ? fleetOverlay(rows) : fleetHeat(rows);
}

// ---- Heatmap ----
function heat(v, temp) {
  if (temp && v >= 80) return 'var(--heat-3)';
  if (v >= (temp ? 70 : 85)) return 'var(--heat-2)';
  const x = Math.max(0, Math.min(100, temp ? (v - 30) / 60 * 100 : v));
  return `color-mix(in srgb, var(--rs-heat) ${Math.round(12 + x * .85)}%, var(--well))`;
}
function heatRow(r, k) {
  const s = r.h.s, a = seriesOf(r.h, k) || [], t = s.t || [], b = s.bucket || 30, span = win.end - win.start, temp = isTemp(k), off = isOff(r.m);
  const rects = a.map((v, i) => (v == null ? '' : `<rect x="${(((t[i] - win.start) / span) * W).toFixed(2)}" y="0" width="${((b / span) * W + .6).toFixed(2)}" height="10" style="fill:${heat(v, temp)}"/>`)).join('');
  const pins = k === 'cpu' ? r.h.spikes.filter(sp => sp.start >= win.start).map(sp => `<i class="rs-hpin" style="left:${posOf(sp.start)}%" title="${esc(`${when(sp.start, span)} · peak ${Math.round(sp.peak)}%${sp.top?.[0] ? ` · ${sp.top[0].name}` : ''}`)}"></i>`).join('') : '';
  const v = val(r, k);
  const lbl = `<button type="button" class="rs-heat__lbl${off ? ' is-off' : ''}" data-rs-pick="${esc(r.m.id)}"><i class="rs-msw" style="background:${colourOf(r.m)}"></i><b>${esc(r.m.name)}</b>${off ? '<small>asleep</small>' : ''}</button>`;
  return `${lbl}<div class="rs-strip${off ? ' is-off' : ''}" data-rs-sync><svg viewBox="0 0 ${W} 10" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>${pins}<div class="rs-cross" hidden></div></div>
    <span class="rs-heat__v${v.hot ? ' is-hot' : ''}" ${v.attrs}>${esc(v.txt)}</span>`;
}
function fleetHeat(rows) {
  // CPU load, CPU temp, GPU load, GPU temp — a GPU card lists only the machines that report one, and is left out when none do;
  // CPU temp skips an awake machine with no sensor (Nasferatu: Windows gives none), keeping asleep ones.
  const noSensor = r => !isOff(r.m) && !seriesOf(r.h, 'cpu_temp') && r.m.stats?.cpu?.temp == null;
  const panel = ([k, title], lc) => {
    const list = k.startsWith('gpu') ? rows.filter(r => seriesOf(r.h, k)) : k === 'cpu_temp' ? rows.filter(r => !noSensor(r)) : rows;
    if (!list.length) return '';
    const temp = isTemp(k), ramp = `<span class="rs-ramp">${temp ? '30°C' : '0%'}<i class="${temp ? 'is-temp' : ''}"></i>${temp ? '90°C' : '100%'}</span>`;
    return fcard(title, `<div class="rs-heat">${list.map(r => heatRow(r, k)).join('')}<span></span><div class="rs-heat__axis">${timeTicks()}</div><span></span></div>`,
      `<span class="rs-ftime" data-rs-ftime></span>${ramp}`, lc);
  };
  return panel(['cpu', 'CPU Load'], 'var(--lc-1)') + panel(['cpu_temp', 'CPU Temperature'], 'var(--lc-5)')
    + panel(['gpu', 'GPU Load'], 'var(--lc-2)') + panel(['gpu_temp', 'GPU Temperature'], 'var(--lc-4)');
}

// ---- Grid ----
function fleetGrid(rows) {
  const figs = FIGS.filter(([k]) => rows.some(r => seriesOf(r.h, k)));
  const cells = r => figs.map(([k, label]) => {
    const a = seriesOf(r.h, k);
    if (!a) return '<div class="rs-gcell is-none">—</div>';
    const mx = (r.h.s.metrics[k].max || a).filter(x => x != null), v = val(r, k), lo = isTemp(k) ? 30 : 0;
    return `<div class="rs-gcell" data-label="${label}"><span class="rs-gcell__v${v.hot ? ' is-hot' : ''}" ${v.attrs}>${esc(v.txt)}</span><small>peak ${esc(fmtOf(k)(Math.max(...mx)))}</small>
      <div class="rs-gline" data-rs-sync><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="${W}" y1="${H}" y2="${H}" class="rs-gridline"/>
      <path d="${linePath(r.h.s, a, lo, 100)}" style="stroke:${colourOf(r.m)}" class="rs-line"/></svg><div class="rs-cross" hidden></div></div></div>`;
  }).join('');
  const name = r => { const off = isOff(r.m), n = r.h.spikes.length;
    return `<button type="button" class="rs-gname" data-rs-pick="${esc(r.m.id)}"><b><i class="rs-msw" style="background:${colourOf(r.m)}"></i>${esc(r.m.name)}</b><small>${esc(off ? (r.m.at ? `asleep · ${hhmm(r.m.at)}` : 'asleep') : r.m.stats?.os || '')}</small>${n ? `<span class="rs-m__warn">${n} high CPU</span>` : ''}</button>`; };
  const span = win.end - win.start, ends = `<span class="is-start">${esc(xLabel(win.start, span))}</span><span style="left:50%">${esc(xLabel(win.start + span / 2, span))}</span><span class="is-end">now</span>`;
  const body = `<div class="rs-fgrid" style="--cols:${figs.length}"><div class="rs-gh"></div>${figs.map(([, t]) => `<div class="rs-gh">${t}</div>`).join('')}
    ${rows.map(r => `<div class="rs-grow${isOff(r.m) ? ' is-off' : ''}">${name(r)}${cells(r)}</div>`).join('')}
    <div class="rs-gaxis"></div>${figs.map(() => `<div class="rs-gaxis"><div>${ends}</div></div>`).join('')}</div>`;
  return fcard('All machines', body, '<span class="rs-ftime" data-rs-ftime></span>', 'var(--lc-frame)');
}

// ---- Overlay ----
function fleetOverlay(rows) {
  const span = win.end - win.start;
  const panel = ([k, title], lc) => {
    const rs = rows.filter(r => seriesOf(r.h, k));
    if (!rs.length) return '';
    let lo = 0, hi = 100;
    if (isTemp(k)) {
      const v = rs.flatMap(r => seriesOf(r.h, k).filter(x => x != null));
      lo = Math.max(0, Math.floor((Math.min(...v) - 5) / 10) * 10); hi = Math.max(Math.ceil((Math.max(...v) + 5) / 10) * 10, lo + 20);
    }
    const f = fmtOf(k), Y = v => H - ((v - lo) / (hi - lo)) * H, ticks = [lo, (lo + hi) / 2, hi];
    const legend = `<span class="rs-flegend">${rs.map(r => { const v = nowVal(r, k); return `<button type="button" data-rs-hl="${esc(r.m.id)}"${isOff(r.m) ? ' class="is-off"' : ''}><i style="background:${colourOf(r.m)}"></i>${esc(r.m.name)} <b>${v == null ? '—' : esc(f(v))}</b></button>`; }).join('')}</span>`;
    return fcard(title, `<div class="rs-chart" data-rs-fchart="${k}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      ${ticks.map(v => `<line x1="0" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" class="rs-gridline"/>`).join('')}
      ${rs.map(r => `<path d="${linePath(r.h.s, seriesOf(r.h, k), lo, hi)}" style="stroke:${colourOf(r.m)}" class="rs-line" data-rs-m="${esc(r.m.id)}"/>`).join('')}</svg>
      <div class="rs-y">${ticks.map(v => `<span style="top:${(Y(v) / H) * 100}%">${esc(f(v))}</span>`).join('')}</div><div class="rs-x">${timeTicks()}</div>
      <div class="rs-cross" hidden></div><div class="rs-tip" hidden></div></div>`, legend, lc);
  };
  const pinned = rows.filter(r => r.h.spikes.some(sp => sp.start >= win.start)), n = pinned.reduce((c, r) => c + r.h.spikes.length, 0);
  const pins = pinned.length ? fcard('High CPU', `<div class="rs-fpins">${pinned.map(r => `<div class="rs-fpin"><span>${esc(r.m.name)}</span>${r.h.spikes.filter(sp => sp.start >= win.start).map(sp => `<i style="left:${posOf(sp.start)}%;background:${colourOf(r.m)}" title="${esc(`${when(sp.start, span)} · peak ${Math.round(sp.peak)}%${sp.top?.[0] ? ` · ${sp.top[0].name}` : ''}`)}"></i>`).join('')}</div>`).join('')}
    <div class="rs-fpins__axis">${timeTicks()}</div></div>`, `<span class="rs-now">${n}</span>`, 'var(--lc-7)', 'rs-card--spikes') : '';
  return panel(FIGS[0], 'var(--lc-1)') + panel(FIGS[1], 'var(--lc-5)') + panel(FIGS[2], 'var(--lc-2)') + panel(FIGS[3], 'var(--lc-4)') + pins;
}

// ---- hover + highlight ----
function valueAt(h, k, at) {
  const a = h && seriesOf(h, k);
  if (!a) return null;
  const b = h.s.bucket || 30, mids = h.s.t.map(x => x + b / 2), i = nearest(mids, at);
  return i != null && Math.abs(mids[i] - at) <= b * 1.5 ? a[i] : null;
}
function fleetHover(e) {
  if (pick !== 'fleet' || !win) return;
  const fc = e.target.closest?.('[data-rs-fchart]'), el = fc || e.target.closest?.('[data-rs-sync]');
  fleetUnhover();
  if (!el) return;
  const r = el.getBoundingClientRect(), f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), span = win.end - win.start, at = win.start + f * span;
  if (fc) {
    const k = fc.dataset.rsFchart, fm = fmtOf(k), cross = $('.rs-cross', fc), tip = $('.rs-tip', fc);
    cross.hidden = false; cross.style.left = `${f * 100}%`;
    const rows = fleetRows().filter(x => seriesOf(x.h, k)).map(x => { const v = valueAt(x.h, k, at); return `<span><i style="background:${colourOf(x.m)}"></i>${esc(x.m.name)} <b>${v == null ? '—' : esc(fm(v))}</b></span>`; }).join('');
    tip.innerHTML = `<b>${esc(when(at, span))}</b>${rows}`;
    tip.hidden = false; tip.classList.toggle('is-left', f > .6); tip.style.left = `${f * 100}%`;
    return;
  }
  $$('[data-rs-sync] > .rs-cross', root).forEach(c => { c.hidden = false; c.style.left = `${f * 100}%`; });
  $$('[data-rs-val]', root).forEach(x => { const [id, k] = x.dataset.rsVal.split('|'), v = valueAt(hist.get(id), k, at); x.textContent = v == null ? '—' : fmtOf(k)(v); });
  $$('[data-rs-ftime]', root).forEach(x => { x.textContent = when(at, span); });
}
function fleetUnhover() {
  $$('[data-rs-sync] > .rs-cross', root).forEach(c => { c.hidden = true; });
  $$('[data-rs-val]', root).forEach(x => { x.textContent = x.dataset.now; });
  $$('[data-rs-ftime]', root).forEach(x => { x.textContent = ''; });
}
// Overlay: pointing at a machine's name picks its line out in every chart
function highlight(e) {
  const id = e.target.closest?.('[data-rs-hl]')?.dataset.rsHl;
  $$('[data-rs-m]', root).forEach(p => p.classList.toggle('rs-dim', !!id && p.dataset.rsM !== id));
  $$('[data-rs-hl]', root).forEach(b => b.classList.toggle('rs-dim', !!id && b.dataset.rsHl !== id));
}
