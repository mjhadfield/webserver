// LCARS motion: the small, data-driven life in the LCARS theme (styles in lcars.css, "Motion: alive").
//
// One switch per device, html[data-motion] = off | calm | lively (localStorage "motion", Settings → Appearance; reduced
// motion forces off). Each effect is a class on <html> (mx-<id>) so CSS can key off it, and LEVELS says which effects
// each level turns on and how often the ambient ones may run. Dialling the whole thing up or down = this table and the
// variables at the top of lcars.css's Motion: alive section. Citadel never gets any of it.
//
// Data-driven effects (readout, dots, cards, gauges) only ever move when something really changed. Ambient ones run from
// a single scheduler: one at a time, at random intervals, on Home only, never while the tab is hidden.
// Designed in the Motion Lab mockup (2026-11-17); Mike dropped its "live tick" and the hollow-ring down dot.

const EFFECTS = ['roll', 'ripple', 'heatfade', 'breathe', 'warnblip', 'ping', 'ack', 'gauge', 'railmark', 'trickle', 'segblink', 'railnums'];
export const LEVELS = {
  off:    { on: [], every: null },
  calm:   { on: ['roll', 'ripple', 'heatfade', 'breathe', 'warnblip', 'ping', 'ack', 'gauge', 'trickle'], every: [20, 45] },
  lively: { on: ['roll', 'ripple', 'heatfade', 'breathe', 'warnblip', 'ping', 'ack', 'gauge', 'railmark', 'trickle', 'segblink', 'railnums'], every: [8, 20] },
};
export const LEVEL_NAMES = [['off', 'Off'], ['calm', 'Calm'], ['lively', 'Lively']];
const KEY = 'motion';

const root = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const aliveFamily = () => root.dataset.family === 'lcars' || root.dataset.family === 'borg';

/** This device's chosen level (what Settings shows), whatever the theme. */
export function savedLevel() {
  let v = null;
  try { v = localStorage.getItem(KEY); } catch { /* private window */ }
  return LEVELS[v] ? v : 'calm';
}
/** Choose this device's level. The dashboard (and any other open page) follows through the storage event. */
export function saveLevel(l) {
  try { localStorage.setItem(KEY, l); } catch { /* private window: this page only */ }
  apply();
}

/** The level in force: the saved one, or off for reduced motion and for Citadel. */
const level = () => (reduced.matches || !aliveFamily() ? 'off' : savedLevel());
export const isOn = id => LEVELS[level()].on.includes(id);

function apply() {
  root.dataset.motion = level();
  for (const id of EFFECTS) root.classList.toggle(`mx-${id}`, isOn(id));
  if (root.dataset.motion !== 'off') phaseAll();
  ambient.reschedule();
  if (isOn('railnums')) mountCascade(document.querySelector('.rail .spacer'));
}

// ---- phase-stable loops ------------------------------------------------------------------------------------------------
// A looping animation on freshly rendered markup starts from 0, so everything re-rendered together pulses together.
// Instead each element gets a negative delay = where it should be in its loop right now, offset by a hash of a stable key:
// a re-render carries on mid-breath, and neighbours stay out of step.
const hash = s => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
function phase(el, periodMs, key, prop = '--ph') {
  const off = (Math.imul(hash(key), 2654435761) >>> 0) % periodMs;      // mixed, so short keys ("1", "2") land far apart
  el.style.setProperty(prop, `${-((Date.now() + off) % periodMs)}ms`);
}
/** Give every status dot / gauge / readout number under `scope` its place in its loop. */
export function phaseAll(scope = document) {
  if (root.dataset.motion === 'off') return;
  const breathe = parseFloat(getComputedStyle(root).getPropertyValue('--mx-breathe')) * 1000 || 5200;
  scope.querySelectorAll('.dot').forEach(d => phase(d, d.classList.contains('dot--warn') ? 3000 : breathe, keyOf(d)));
  const sheen = parseFloat(getComputedStyle(root).getPropertyValue('--mx-sheen-t')) * 1000 || 7200;
  scope.querySelectorAll('.bar__track').forEach(t => { const k = gaugeKey(t); phase(t, 3600, k); phase(t, sheen, `${k}~`, '--phs'); });
  scope.querySelectorAll('.readout dd').forEach(d => phase(d, 4000, d.previousElementSibling?.textContent));
}
// Which row a dot or gauge belongs to, by something that doesn't change with its state (a dot's row text often does:
// "running" → "stopped", a latency reading), so a row keeps its phase and a state change can be recognised.
function keyOf(el) {
  const row = el.closest('[data-slug], [data-vnc], .svc, .bar, .tile, li, a');
  if (!row) return '';
  return row.dataset.slug || row.dataset.vnc || row.getAttribute('href')
    || (row.querySelector('b, .svc > span:nth-child(2), .bar__top > span')?.textContent ?? row.textContent).trim().slice(0, 40);
}

/** A dot that changed state pings once. */
function ping(dot) {
  if (!isOn('ping')) return;
  dot.classList.remove('is-ping'); void dot.offsetWidth; dot.classList.add('is-ping');
  setTimeout(() => dot.classList.remove('is-ping'), 800);
}

// ---- cards -----------------------------------------------------------------------------------------------------------
// Shell.update calls before() just ahead of replacing a card's content and after() once it's in. The content is rebuilt
// from scratch, so what was there is read first: dot states and gauge values by row, and the card's text with its live
// tickers left out (an uptime counting up isn't new data).
const sig = el => {
  let t = el.textContent;
  el.querySelectorAll('[data-since], [data-clock], [data-gig-at]').forEach(e => { t = t.replace(e.textContent, ''); });
  return t.replace(/\s+/g, ' ');
};
export function before(body) {
  if (root.dataset.motion === 'off') return null;
  return {
    sig: sig(body),
    dots: new Map([...body.querySelectorAll('.dot')].map(d => [keyOf(d), d.className])),
  };
}
/** `snap`: before()'s reading, null on a card's first render. `ack`: this render came from new data (not opening,
 * filtering or searching the card), so the card may acknowledge it. */
export function after(card, body, snap, { ack: fresh = false } = {}) {
  if (root.dataset.motion === 'off') return;
  phaseAll(body);
  if (isOn('gauge')) trackGauges(body);
  if (!snap) return;
  body.querySelectorAll('.dot').forEach(d => { const was = snap.dots.get(keyOf(d)); if (was && was !== d.className) ping(d); });
  if (fresh && sig(body) !== snap.sig) ack(card);
}

/** The card's data really changed: its lit edge brightens once. */
function ack(card) {
  if (!isOn('ack') || !card) return;
  let o = card.querySelector(':scope > .mx-ack');
  if (!o) { o = document.createElement('span'); o.className = 'mx-ack'; card.prepend(o); }
  card.classList.remove('is-ack'); void card.offsetWidth; card.classList.add('is-ack');
  setTimeout(() => card.classList.remove('is-ack'), 1000);
}

// ---- gauges ------------------------------------------------------------------------------------------------------------
// Each gauge drifts towards its reading over a few seconds instead of snapping: a 2 s poll of per-core load is jumpy,
// and easing each new reading in under a second then sitting still read as bars dropping and bouncing back. The state
// lives here by gauge (not on the element, which every render replaces), so the drift carries on through re-renders.
// Two first-order lags in a row: no kink when a reading arrives, about half way there in 1.5 s, nearly there by 4 s.
// It paints --gw (the smoothed width) and --gp (the recent high, held a moment then let go: the afterglow) on the
// track; lcars.css draws them. A gauge not seen for a while starts at its reading rather than from somewhere stale.
// Cheap enough for an always-on wallpaper (2026-11-25): readings land every 2 s, so the drift hardly ever rests. It steps
// about 25 times a second (tick), writes a gauge only when it has moved a visible amount (step, in % of the track) and
// rests within `snap` of the reading; every frame at a 0.02 % tolerance kept a Home wallpaper redrawing at 60-75 fps.
const GAUGE = { tau: .9, hold: 1.2, fade: 1.1, stale: 10000, tick: 50, step: .25, snap: .25 };
const gauges = new Map();
let gaugeOn = false, gaugeT = 0;
// unique per gauge: the card, then the machine panel / column / section it's in, then its label (every machine has a
// "CPU" and a "RAM", so the label alone sent one machine's gauge to another's reading on every render)
function gaugeKey(track) {
  const group = track.closest('.mach, .mon-col, .mon-section');
  return [track.closest('.card')?.id, group?.querySelector('.mon-col__label, .hud')?.textContent,
    track.closest('.bar')?.querySelector('.bar__top > span')?.textContent].map(s => (s || '').trim()).join('|');
}
function paintGauge(g, force = false) {
  const gw = `${g.b.toFixed(2)}%`, gp = `${g.pk.toFixed(2)}%`, gl = Math.min(1, g.b / 4).toFixed(2);
  g.pb = g.b; g.ppk = g.pk;
  if (force || g.sgw !== gw) { g.sgw = gw; g.el.style.setProperty('--gw', gw); }
  if (force || g.sgp !== gp) { g.sgp = gp; g.el.style.setProperty('--gp', gp); }
  if (force || g.sgl !== gl) { g.sgl = gl; g.el.style.setProperty('--gl', gl); }   // the lead's glow: none on an empty gauge
}
function trackGauges(scope) {
  // hidden card (e.g. .card--popout on wide screens): never animate off-screen gauges. Not offsetParent, which is also
  // null for a position: fixed element such as an expanded card.
  if (!scope.getClientRects().length) return;
  const now = performance.now();
  let needStep = false;
  scope.querySelectorAll('.bar__track').forEach(el => {
    const t = parseFloat(el.querySelector('.bar__fill')?.style.getPropertyValue('--v')) || 0, k = gaugeKey(el);
    let g = gauges.get(k);
    if (!g || now - g.seen > GAUGE.stale) gauges.set(k, g = { a: t, b: t, pk: t, hold: 0 });
    Object.assign(g, { t, el, seen: now });
    paintGauge(g, true);
    if (Math.abs(g.t - g.b) >= GAUGE.snap || g.pk - g.b >= 2 * GAUGE.snap) needStep = true;
  });
  if (needStep && !gaugeOn) { gaugeOn = true; gaugeT = 0; requestAnimationFrame(stepGauges); }
}
function stepGauges(ts) {
  const dt = gaugeT ? Math.min(.1, (ts - gaugeT) / 1000) : 0, k = 1 - Math.exp(-dt / GAUGE.tau);
  gaugeT = ts;
  let busy = false;
  for (const [key, g] of gauges) {
    if (!g.el.isConnected) { if (ts - g.seen > GAUGE.stale) gauges.delete(key); continue; }
    if (Math.abs(g.t - g.b) < GAUGE.snap && g.pk - g.b < 2 * GAUGE.snap) {
      g.a = g.b = g.pk = g.t;
      if (g.b !== g.pb || g.pk !== g.ppk) paintGauge(g);
      continue;
    }
    g.a += (g.t - g.a) * k; g.b += (g.a - g.b) * k;
    if (g.b >= g.pk) { g.pk = g.b; g.hold = GAUGE.hold; }
    else if (g.hold > 0) g.hold -= dt;
    else g.pk += (g.b - g.pk) * (1 - Math.exp(-dt / GAUGE.fade));
    const rest = Math.abs(g.t - g.b) < GAUGE.snap && g.pk - g.b < 2 * GAUGE.snap;
    if (rest) g.a = g.b = g.pk = g.t; else busy = true;
    if ((rest && (g.b !== g.pb || g.pk !== g.ppk)) || Math.abs(g.b - g.pb) >= GAUGE.step || Math.abs(g.pk - g.ppk) >= GAUGE.step) paintGauge(g);
  }
  if (busy) setTimeout(() => requestAnimationFrame(stepGauges), GAUGE.tick); else gaugeOn = false;
}

// ---- readout -----------------------------------------------------------------------------------------------------------
// A cue (the soft glow) only for a change worth seeing: this much movement, or the number's heat level changing.
// Smaller moves just roll. Several cues on one reading ripple left to right rather than going off together.
const CUE = { 'CPU °C': 2, 'GPU °C': 2, CPU: 8, GPU: 8, VRAM: 5, RAM: 3 };
const rolls = new WeakMap(), cueTimers = new WeakMap(), lastReading = new WeakMap();

/**
 * Update the readout in place (cells: [{ k, n, text, fmt, heat }]; fmt turns a number into its text, for the roll).
 * The dd elements persist between readings, so rolls, cross-fades and loops aren't restarted by a rebuild.
 */
export function updateReadout(el, cells) {
  const rebuilt = el.children.length !== cells.length || [...el.children].some((d, i) => d.firstElementChild.textContent !== cells[i].k);
  if (rebuilt) {
    el.replaceChildren(...cells.map(c => {
      const div = document.createElement('div'), dt = document.createElement('dt');
      dt.textContent = c.k; div.append(dt, document.createElement('dd'));
      return div;
    }));
    lastReading.delete(el);
  }
  const prev = lastReading.get(el);
  let cues = 0, cueMs = 0;
  cells.forEach((c, i) => {
    const dd = el.children[i].lastElementChild, was = prev?.[c.k];
    const heatWas = dd.dataset.heat || '0', heat = String(c.heat || 0);
    if (heat === '0') delete dd.dataset.heat; else dd.dataset.heat = heat;
    const changed = was && was.text !== c.text;
    if (isOn('roll') && changed && c.fmt && c.n != null && was.n != null) roll(dd, was.n, c.n, c.fmt);
    else { clearTimeout(rolls.get(dd)); setText(dd, c.text); }
    const moved = changed && c.n != null && was.n != null ? Math.abs(c.n - was.n) : 0;
    if (isOn('roll') && changed && ((CUE[c.k] && moved >= CUE[c.k]) || heatWas !== heat)) {
      if (!cueMs) cueMs = parseFloat(getComputedStyle(root).getPropertyValue('--mx-cue')) * 1000 || 1200;
      const delay = isOn('ripple') ? cues * 80 : 0;
      clearTimeout(cueTimers.get(dd));
      dd.style.setProperty('--mx-i', isOn('ripple') ? cues : 0);
      dd.classList.remove('is-cue'); void dd.offsetWidth; dd.classList.add('is-cue');
      cueTimers.set(dd, setTimeout(() => dd.classList.remove('is-cue'), cueMs + delay + 80));
      cues++;
    }
  });
  lastReading.set(el, Object.fromEntries(cells.map(c => [c.k, c])));
  if (rebuilt) phaseAll(el);
}

// The text (and data-v, the copy lcars.css glows a hot number with) is written only when it changes, at most every
// ROLL_TICK ms: a number rolling at the display's frame rate relaid the page every frame for no visible gain.
const ROLL_TICK = 50;
function setText(dd, s) {
  if (dd.textContent !== s) dd.textContent = s;
  if (dd.dataset.v !== s) dd.dataset.v = s;
}
function roll(dd, from, to, fmt) {
  clearTimeout(rolls.get(dd));
  const ms = parseFloat(getComputedStyle(root).getPropertyValue('--mx-roll')) || 700, t0 = performance.now();
  const step = () => {
    const p = Math.min(1, (performance.now() - t0) / ms), e = 1 - (1 - p) ** 3;
    setText(dd, p < 1 ? fmt(from + (to - from) * e) : fmt(to));
    if (p < 1) rolls.set(dd, setTimeout(step, ROLL_TICK));
  };
  rolls.set(dd, setTimeout(step, ROLL_TICK));
}

// ---- ambient -----------------------------------------------------------------------------------------------------------
// The frame's bars are pseudo-elements, so each effect lays an overlay over the bar (geometry copied from the pseudo's
// computed style) and works inside one segment. The segment edges mirror the gradients in lcars.css.
const SEGS = {
  head: [[0, 22], [22, 27], [27, 78], [78, 82], [82, 100]],
  body: [[0, 10], [10, 58], [58, 62], [62, 86], [86, 100]],
};
function overlay(host, which) {
  const cs = getComputedStyle(host, '::after');
  if (cs.content === 'none' || cs.display === 'none' || !parseFloat(cs.width)) return null;
  let o = host.querySelector(`:scope > .mx-bar[data-bar="${which}"]`);
  if (!o) { o = document.createElement('span'); o.className = 'mx-bar'; o.dataset.bar = which; host.append(o); }
  Object.assign(o.style, { left: cs.left, top: cs.top, width: cs.width, height: cs.height });
  return o;
}
function pickBar() {
  const options = [[document.querySelector('.top'), 'head'], [document.querySelector('.view.is-active'), 'body']].filter(([h]) => h);
  if (!options.length) return {};
  const [host, which] = options[Math.floor(Math.random() * options.length)];
  const bar = overlay(host, which);
  if (bar && which === 'head' && document.documentElement.dataset.theme === 'lcars25') {
    // LCARS 25's header arm (lcars25.css --lcb-arm-segs): percentages, except its last run, a fixed --lcb-lip
    const w = bar.offsetWidth, lip = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lcb-lip')) || 64;
    const p = Math.max(44, (w - lip - 5) / w * 100);
    return { bar, segs: [[0, 5], [5, 40], [40, 43], [43, p], [p, 100]] };
  }
  return { bar, segs: SEGS[which] };
}
function segment(bar, [a, b], gap = 5) {
  const s = document.createElement('span');
  s.className = 'mx-seg';
  s.style.left = a === 0 ? '0' : `calc(${a}% + ${gap}px)`;
  s.style.width = a === 0 ? `${b}%` : `calc(${b - a}% - ${gap}px)`;
  bar.append(s);
  return s;
}

const RUNNERS = {
  trickle() {
    const { bar, segs } = pickBar(); if (!bar) return;
    const long = segs.filter(([a, b]) => b - a >= 20);
    const seg = segment(bar, long[Math.floor(Math.random() * long.length)]);
    const w = seg.getBoundingClientRect().width, lw = Math.max(80, w * .22), light = document.createElement('i');
    const run = (w / lw) * 100 + 100;
    const dur = Math.min(2.6, Math.max(1.1, w / 520)) * 1000;
    light.className = 'mx-light';
    light.style.setProperty('--mx-w', `${lw}px`);
    seg.append(light);
    // Literal transform keyframes via WAAPI stay on the compositor (var() inside CSS @keyframes kept trickle on main thread)
    light.animate(
      [{ transform: 'translateX(-100%)' }, { transform: `translateX(${run}%)` }],
      { duration: dur, easing: root.dataset.family === 'borg' ? 'linear' : 'cubic-bezier(.4, 0, .6, 1)', fill: 'both' },
    );
    setTimeout(() => seg.remove(), Math.ceil(dur) + 200);
  },
  segblink() {
    const { bar, segs } = pickBar(); if (!bar) return;
    const short = segs.filter(([a, b]) => b - a < 20);
    const seg = segment(bar, short[Math.floor(Math.random() * short.length)]);
    seg.classList.add('mx-dim');
    setTimeout(() => seg.remove(), 1300);
  },
};

// exported so a trickle can be tried from the console: (await import('./js/motion.js')).ambient.fire()
export const ambient = {
  timer: null,
  reschedule() {
    clearTimeout(this.timer);
    const every = LEVELS[level()].every;
    if (!every) return;
    const [lo, hi] = every;
    this.timer = setTimeout(() => { this.fire(); this.reschedule(); }, (lo + Math.random() * (hi - lo)) * 1000);
  },
  fire() {
    if (document.hidden || !LEVELS[level()].every || root.dataset.page !== 'home' || root.classList.contains('lc-boot') || root.classList.contains('brg-boot')) return;
    if (root.dataset.family === 'borg') { if (isOn('trickle')) RUNNERS.trickle(); return; }
    const runs = Object.keys(RUNNERS).filter(isOn);
    if (!runs.length) return;
    // the trickle is the main one; a segment blink is the occasional variation
    const pick = runs.length > 1 && Math.random() < .3 ? runs.find(r => r !== 'trickle') : (runs.includes('trickle') ? 'trickle' : runs[0]);
    RUNNERS[pick]();
  },
};

// ---- data cascade (Lively only): a column of numbers drifting up the rail's empty space ---------------------------------
// LCARS gets plain readouts; Borg gets drone designations, unimatrix and cube numbers, hex, binary and block glyphs (Mike,
// 2026-11-24). ASCII only, never < > & (the rows go in as HTML), at most 12 characters to fit borg.css's column.
const rnd = n => Math.floor(Math.random() * n);
const pad = (n, w) => String(n).padStart(w, '0');
const pick = a => a[rnd(a.length)];
const LCARS_ROW = () => (Math.random() < .5 ? pad(rnd(99), 2) : `${rnd(9)}-${pad(rnd(999), 3)}`);
const BORG_GLYPHS = ['[#]-[#]', '|::|::|', '=#=#=#=', '#.##.#', '[:::]', '/\\/\\/\\', '+--+--+', '.:|:.', '||:||:||', '#=#', '[ ][#][ ]', '::#::'];
const BORG_ROWS = [
  [3, () => `${1 + rnd(9)} OF ${1 + rnd(9)}`],                                   // drone designation, "Seven of Nine" style
  [2, () => `UMX-${pad(rnd(99), 2)}`],                                           // unimatrix
  [1, () => `CUBE ${pad(rnd(999), 3)}`],
  [1, () => `ADJ ${pad(rnd(99), 2)}.${rnd(10)}`],                                // tertiary adjunct
  [2, () => `0x${rnd(65536).toString(16).toUpperCase().padStart(4, '0')}`],
  [2, () => Array.from({ length: 8 }, () => rnd(2)).join('')],
  [3, () => pick(BORG_GLYPHS)],
];
const BORG_ROW = () => {
  let r = Math.random() * BORG_ROWS.reduce((t, [w]) => t + w, 0);
  for (const [w, f] of BORG_ROWS) { if ((r -= w) < 0) return f(); }
  return BORG_ROWS[0][1]();
};
function mountCascade(host) {
  if (!host) return;
  const fam = root.dataset.family;
  const old = host.querySelector('.mx-railnums');
  if (old?.dataset.family === fam) return;
  old?.remove();                                         // switched between LCARS and Borg: each has its own text
  const n = fam === 'borg' ? BORG_ROW : LCARS_ROW;
  const rows = Array.from({ length: 40 }, () => `<span${Math.random() < .06 ? ' class="is-hi"' : ''}>${n()}</span>`).join('');
  host.insertAdjacentHTML('beforeend', `<div class="mx-railnums" data-family="${fam}" aria-hidden="true"><div>${rows}${rows}</div></div>`);
}

/** Start: put the level on the page and follow changes (reduced motion, the theme, another page saving a level). */
export function init() {
  reduced.addEventListener('change', apply);
  document.addEventListener('theme:change', apply);
  addEventListener('storage', e => { if (e.key === KEY || e.key === null) apply(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ambient.reschedule(); });
  apply();
}
