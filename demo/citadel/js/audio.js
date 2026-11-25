// The Audio page (#audio): Citadel's own GoXLR mixer, in Citadel's looks and from any device. The hub holds the one
// connection to the goxlr-utility daemon on this PC (app/goxlr.py) and shapes its status for this page (app/audio.py);
// the page reads GET /api/owner/audio and sends one action at a time to POST /api/owner/audio. Plan, decisions and task
// list: ~/Projects/HomeLab/audio. The layout is Mike's pick from the mockup (2026-11-23).
//
// Four tabs: Audio (mixer, routing, effects, sampler), Microphone (input + mic profile, noise gate, compressor, EQ),
// Lighting (a drawing of the front panel: pick a part, set its colours; animation; Match my theme) and Settings (not
// built: a pointer to the GoXLR utility). The tab is remembered per device.
//
// Live: SSE `audio` (a trigger) re-reads the view while the page is on screen, so a physical fader or the utility's own
// page shows here at once. A control being dragged ignores those updates until it's let go, and its sends are throttled
// to ~10 a second, last value always sent. Every action is applied here first (optimistic) and corrected by the re-read.
//
// Saving: the daemon only writes a profile file on Save, and loading a profile drops what wasn't saved. Save and
// Save as… sit beside both pickers (profile in the heading, mic profile on the Microphone tab); the hub works out what's
// unsaved (app/audio.py Unsaved) and Save lights up then. Switching profile with unsaved changes asks first.
//
// Everything is .ax* / [data-ax-*]; never reuse [data-act] or [data-date] (app.js and util.js treat those globally).
import * as api from './api.js';
import { $, esc, ico, toast } from './util.js';
import { applySpec, mode as themeMode } from './theme.js';

const API = '/api/owner/audio';
const UTILITY = 'http://localhost:14564/';
const root = $('#view-audio');
const TABS = [['audio', 'Audio', 'mixer'], ['mic', 'Microphone', 'mic'], ['lighting', 'Lighting', 'sun'], ['settings', 'Settings', 'gear']];
const MUTE_TO = { All: 'to all', ToStream: 'to stream', ToVoiceChat: 'to chat', ToPhones: 'to phones', ToLineOut: 'to line out', ToStream2: 'to stream 2', ToStreams: 'to streams' };
const SEND_MS = 100;                        // a dragged slider sends at most this often (the last value always goes)
const LEVEL_MS = 120;                       // the Microphone tab's level meter

let V = null;                               // the last view from the hub
let active = false, started = false, loading = false, again = false, timer = null, levelTimer = null;
let tab = load('ax-tab', 'audio');
if (!TABS.some(t => t[0] === tab)) tab = 'audio';
let drag = null;                            // {el, id, key} while a slider is held
const phone = matchMedia('(max-width: 760px)');

function load(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked: just not remembered */ } }

export function onView(v) {
  const was = active;
  active = v === 'audio';
  if (active && !started) {
    started = true;
    api.subscribe(() => { if (active) refresh(); }, ok => { if (ok && active) refresh(); }, '/api/owner/events', ['audio']);
    phone.addEventListener('change', () => { if (active) render(); });
    document.addEventListener('visibilitychange', () => { if (active && !document.hidden) refresh(); levelPoll(); });
  }
  if (active && !was) refresh();
  if (!active) { clearTimeout(timer); timer = null; }
  levelPoll();
}

// ---- reading -------------------------------------------------------------------------------------------------------

async function refresh() {
  if (loading) { again = true; return; }
  loading = true;
  clearTimeout(timer);
  try {
    const got = await api.get(API);
    if (got.available) V = got;
    else if (V) V = { ...V, available: false, configured: got.configured };
    else V = got;
  } catch {
    if (V) V = { ...V, available: false };
  } finally {
    loading = false;
  }
  if (drag) { /* the slider redraws on let-go */ } else if (colourBusy()) ltStale = true; else render();
  levelPoll();
  timer = setTimeout(() => { if (active) refresh(); }, V?.available ? 30000 : 5000);   // a safety net under the SSE nudges; sooner while it's down
  if (again) { again = false; refresh(); }
}

// ---- sending -------------------------------------------------------------------------------------------------------

async function send(body) {
  try {
    await api.post(API, body);
    return true;
  } catch (e) {
    toast(e.message || 'The GoXLR didn\'t take that');
    refresh();                              // put the page back as it really is
    return false;
  }
}
const throttle = new Map();                 // slider key -> {at, timer, body}
function sendSoon(key, body) {
  const t = throttle.get(key) || { at: 0, timer: 0, body: null };
  throttle.set(key, t);
  t.body = body;
  const wait = t.at + SEND_MS - performance.now();
  if (wait <= 0) { t.at = performance.now(); send(body); return; }
  if (!t.timer) t.timer = setTimeout(() => { t.timer = 0; t.at = performance.now(); send(t.body); }, wait);
}

// ---- sliders -------------------------------------------------------------------------------------------------------
// One kind for everything: data-ax-sl = a key (see SLIDERS), upright on the mixer (sideways on phones) and sideways
// elsewhere. Each key knows how to read its value from V, change V, make the action, and label the value.
const chan = id => V.channels.find(c => c.id === id) || V.outputs.find(c => c.id === id);
const ms = n => (n >= 1000 ? `${(n / 1000).toFixed(n % 1000 ? 1 : 0)} s` : `${n} ms`);
const signed = n => `${n > 0 ? '+' : ''}${n}`;
const SLIDERS = {
  vol: { get: id => chan(id).v, set: (id, v) => { chan(id).v = v; }, act: (id, v) => ({ cmd: 'volume', channel: id, value: v }), label: v => `${v}` },
  sub: { get: id => chan(id).sub, set: (id, v) => { chan(id).sub = v; }, act: (id, v) => ({ cmd: 'sub_volume', channel: id, value: v }), label: v => `${v}` },
  amt: {
    get: k => V.effects.amounts[k], set: (k, v) => { V.effects.amounts[k] = v; }, act: (k, v) => ({ cmd: 'amount', what: k, value: v }),
    label: (v, k) => (k === 'reverb' || k === 'echo' ? `${v}%` : signed(v)),
  },
  gain: { get: () => V.mic.gain, set: (k, v) => { V.mic.gain = v; }, act: (k, v) => ({ cmd: 'mic_gain', value: v }), label: v => `${v} dB` },
  gate: {
    get: k => V.mic.gate[k], set: (k, v) => { V.mic.gate[k] = v; }, act: (k, v) => ({ cmd: 'gate', what: k, value: v }),
    label: (v, k) => (k === 'threshold' ? `${v} dB` : k === 'attenuation' ? `${v}%` : ms(V.scales.gate_ms[v])),
  },
  comp: {
    get: k => V.mic.comp[k], set: (k, v) => { V.mic.comp[k] = v; }, act: (k, v) => ({ cmd: 'comp', what: k, value: v }),
    label: (v, k) => (k === 'ratio' ? `${V.scales.ratio[v]}:1` : k === 'attack' ? ms(V.scales.comp_attack_ms[v])
      : k === 'release' ? ms(V.scales.comp_release_ms[v]) : `${v} dB`),
  },
  eq: { get: i => V.mic.eq[i][1], set: (i, v) => { V.mic.eq[i][1] = v; }, act: (i, v) => ({ cmd: 'eq', band: +i, value: v }), label: v => signed(v) },
  deess: { get: () => V.mic.deess, set: (k, v) => { V.mic.deess = v; }, act: (k, v) => ({ cmd: 'deess', value: v }), label: v => `${v}%` },
  mod: { get: k => V.lighting.animation[k], set: (k, v) => { V.lighting.animation[k] = v; }, act: (k, v) => ({ cmd: 'anim', [k]: v }), label: v => `${v}` },
  bleep: { get: () => V.mic.bleep, set: (k, v) => { V.mic.bleep = v; }, act: (k, v) => ({ cmd: 'bleep', value: v }), label: v => `${v} dB` },
};
const part = key => { const i = key.indexOf(':'); return [key.slice(0, i), key.slice(i + 1)]; };
function slider(key, { min = 0, max = 100, step = 1, dir = 'h', mid = false, sub = false, label = '' } = {}) {
  const [kind, id] = part(key);
  const v = SLIDERS[kind].get(id), n = (v - min) / (max - min), z = Math.min(1, Math.max(0, (0 - min) / (max - min)));
  return `<div class="ax-sl ax-sl--${dir}${mid ? ' ax-sl--mid' : ''}${sub ? ' is-sub' : ''}" role="slider" tabindex="0" aria-orientation="${dir === 'v' ? 'vertical' : 'horizontal'}"
    aria-label="${esc(label)}" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${v}" aria-valuetext="${esc(SLIDERS[kind].label(v, id))}"
    data-ax-sl="${esc(key)}" data-min="${min}" data-max="${max}" data-step="${step}"
    style="--v:${n};--lo:${Math.min(n, z)};--d:${Math.abs(n - z)}"><span class="ax-sl__rail"><span class="ax-sl__fill"></span></span><span class="ax-sl__thumb"></span></div>`;
}
const out = key => { const [kind, id] = part(key); return `<output data-ax-out="${esc(key)}">${esc(SLIDERS[kind].label(SLIDERS[kind].get(id), id))}</output>`; };
const row = (name, key, opts) => `<span>${esc(name)}</span>${slider(key, { label: name, ...opts })}${out(key)}`;
const mixDir = () => (phone.matches ? 'h' : 'v');

// ---- render --------------------------------------------------------------------------------------------------------
const card = (cls, colour, title, right, body) => `<section class="card ${cls}" style="--lc-c: var(--${colour})"><div class="card__in">
  <div class="card__head"><span class="hud">${title}</span>${right}</div><div class="card__body">${body}</div></div></section>`;
const saves = which => {
  const dirty = !!V.unsaved?.[which];
  return `<span class="ax-saves"><button type="button" class="ax-save${dirty ? ' is-unsaved' : ''}" data-ax-save="${which}" title="${dirty ? 'Unsaved changes: save them to this profile' : 'Saved'}">${ico('save')}<span>Save</span></button>`
    + `<button type="button" class="ax-save" data-ax-saveas="${which}" title="Save as a new profile">Save as…</button></span>`;
};
const sw = (what, on, label) => `<button type="button" class="ax-sw" data-ax-switch="${what}" aria-pressed="${!!on}">${label}</button>`;

function strip(c, fader = null) {
  const sub = V.submix.enabled && c.sub !== undefined;
  return `<div class="ax-strip">
    <div class="ax-strip__top">${fader ? `<span class="ax-key">${fader.id}</span>` : ''}<span class="ax-name" title="${esc(c.name)}">${esc(c.name)}</span></div>
    <div class="ax-sls">${slider(`vol:${c.id}`, { dir: mixDir(), label: c.name })}${sub ? slider(`sub:${c.id}`, { dir: mixDir(), sub: true, label: `${c.name} stream mix` }) : ''}</div>
    <span class="ax-pct"><span data-ax-out="vol:${esc(c.id)}">${c.v}</span>${sub ? `<small data-ax-out="sub:${esc(c.id)}">${c.sub}</small>` : ''}</span>
    ${sub ? `<button type="button" class="ax-link" data-ax-link="${esc(c.id)}" aria-pressed="${c.linked}" title="Stream mix follows">${ico('link')}</button>` : ''}
    ${fader ? `<button type="button" class="ax-mute" data-ax-mute="${fader.id}" aria-pressed="${fader.muted}">${fader.muted ? 'Muted' : 'Mute'}</button><span class="ax-mtype">${esc(MUTE_TO[fader.mute_to] || fader.mute_to)}</span>` : ''}
  </div>`;
}
function outStrip(o) {
  return `<div class="ax-strip">
    <div class="ax-strip__top"><span class="ax-name" title="${esc(o.name)}">${esc(o.name)}</span></div>
    <div class="ax-sls">${slider(`vol:${o.id}`, { dir: mixDir(), label: o.name })}</div>
    <span class="ax-pct"><span data-ax-out="vol:${esc(o.id)}">${o.v}</span></span>
    ${V.submix.enabled && o.mix ? `<span class="seg" role="group" aria-label="${esc(o.name)} mix">${['A', 'B'].map(m => `<button type="button" data-ax-mix="${esc(o.id)}:${m}" aria-pressed="${o.mix === m}">${m}</button>`).join('')}</span>` : ''}
  </div>`;
}

function mixerCard() {
  const fadered = new Set(V.faders.map(f => f.channel));
  const byId = Object.fromEntries(V.channels.map(c => [c.id, c]));
  const others = V.channels.filter(c => !fadered.has(c.id));
  const faders = V.faders.filter(f => byId[f.channel]);
  const right = V.submix.supported ? `<span class="ax-hr">${sw('submix', V.submix.enabled, 'Submix')}</span>` : '';
  return card('ax-mixer', 'lc-1', 'Mixer', right, `<div class="ax-mix" style="--cols:${faders.length + 1}fr ${others.length}fr ${V.outputs.length}fr">
    <div class="ax-group"><div class="ax-lab">Faders</div><div class="ax-strips" style="--n:${faders.length + 1}">
      ${faders.map(f => strip(byId[f.channel], f)).join('')}
      <div class="ax-strip ax-strip--cough"><div class="ax-strip__top"><span class="ax-name">Mic mute</span></div>
        <button type="button" class="ax-cough" data-ax-cough aria-pressed="${V.cough.muted}">${ico('mic')}<span>${V.cough.muted ? 'Muted' : 'Live'}</span></button>
        <span class="ax-mtype">${esc(MUTE_TO[V.cough.mute_to] || V.cough.mute_to)}</span></div>
    </div></div>
    <div class="ax-group"><div class="ax-lab">Channels</div><div class="ax-strips" style="--n:${others.length}">${others.map(c => strip(c)).join('')}</div></div>
    <div class="ax-group"><div class="ax-lab">Outputs</div><div class="ax-strips" style="--n:${V.outputs.length}">${V.outputs.map(outStrip).join('')}</div>
      ${V.submix.enabled ? `<div class="ax-monitor">Headphones hear <span class="seg" role="group" aria-label="Headphones hear">${[['Headphones', 'Main'], ['BroadcastMix', 'Stream']].map(([id, l]) => `<button type="button" data-ax-monitor="${id}" aria-pressed="${V.monitor === id}">${l}</button>`).join('')}</span></div>` : ''}
    </div>
  </div>`);
}

function routingCard() {
  const R = V.router, blocked = new Set(R.blocked.map(b => b.join(':')));
  return card('ax-route', 'lc-3', 'Routing', '', `<div class="ax-rt" style="--cols:${R.outputs.length}">
    <span></span>${R.outputs.map(([, l, s]) => `<span class="ax-rt__h" title="${esc(l)}"><span class="ax-l">${esc(l)}</span><span class="ax-s">${esc(s)}</span></span>`).join('')}
    ${R.inputs.map(([id, name]) => `<span class="ax-rt__r">${esc(name)}</span>${R.outputs.map(([oid, ol], j) => (blocked.has(`${id}:${oid}`)
      ? `<button type="button" class="ax-rc" disabled aria-label="${esc(name)} can't go to ${esc(ol)}"></button>`
      : `<button type="button" class="ax-rc" data-ax-route="${esc(id)}:${esc(oid)}" aria-pressed="${!!R.on[id][j]}" aria-label="${esc(name)} to ${esc(ol)}"></button>`)).join('')}`).join('')}
  </div>`);
}

function effectsCard() {
  const E = V.effects;
  if (!E) return '';
  const A = E.amounts;
  return card('ax-fx', 'lc-5', 'Effects', sw('fx', E.enabled, 'FX'), `
    <div class="ax-pre">${E.presets.map(([id, name], i) => `<button type="button" data-ax-preset="${esc(id)}" aria-pressed="${id === E.preset}"><span class="ax-key">${i + 1}</span><span>${esc(name)}</span></button>`).join('')}</div>
    <div class="ax-togs">${sw('megaphone', E.megaphone, 'Megaphone')}${sw('robot', E.robot, 'Robot')}${sw('hardtune', E.hardtune, 'Hard tune')}</div>
    <div class="ax-sec"><div class="ax-lab">Amounts</div><div class="ax-rows">
      ${row('Reverb', 'amt:reverb')}${row('Echo', 'amt:echo')}
      ${row('Pitch', 'amt:pitch', { min: A.pitch_min, max: A.pitch_max, step: A.pitch_step, mid: true })}
      ${row('Gender', 'amt:gender', { min: A.gender_min, max: A.gender_max, mid: true })}
    </div></div>`);
}

function samplerCard() {
  const S = V.sampler;
  if (!S) return '';
  return card('ax-smp', 'lc-6', 'Sampler', '', `
    <span class="seg" role="group" aria-label="Bank">${['A', 'B', 'C'].map(b => `<button type="button" data-ax-bank="${b}" aria-pressed="${S.bank === b}">Bank ${b}</button>`).join('')}</span>
    <div class="ax-pads">${S.pads.map(p => {
      const n = p.samples.length;
      return `<button type="button" class="ax-pad${n ? '' : ' is-empty'}${p.playing ? ' is-playing' : ''}" data-ax-pad="${esc(p.id)}" aria-pressed="${p.playing}" ${n ? '' : 'disabled'}>
        <b>${esc(p.name)}${n ? ico(p.playing ? 'stop' : 'play') : ''}</b>
        <small>${n ? `${n} sample${n > 1 ? 's' : ''} · ${esc(p.fn)}` : 'Empty'}</small>
        ${n ? `<small>${esc(p.samples.join(', '))}</small>` : ''}</button>`;
    }).join('')}</div>`);
}

function micCards() {
  const M = V.mic, sc = V.scales;
  const types = [['Dynamic', 'XLR'], ['Condenser', 'XLR +48V'], ['Jack', 'Jack']];
  return card('ax-in', 'lc-2', 'Input', '', `
      <div class="ax-pickrow"><label class="ax-pick ax-pick--card">Mic profile <select data-ax-pick="mic_profile">${V.mic_profiles.map(p => `<option${p === V.mic_profile ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>${saves('mic_profile')}</div>
      <span class="seg" role="group" aria-label="Microphone type">${types.map(([id, l]) => `<button type="button" data-ax-mictype="${id}" aria-pressed="${M.type === id}">${l}</button>`).join('')}</span>
      <div class="ax-meter" id="ax-meter" style="--gate:${(M.gate.threshold + 60) / 60}" title="Mic level (the mark is the gate's threshold)"><i></i><b></b></div>
      <div class="ax-rows">${row('Gain', 'gain:', { max: 72 })}</div>`)
    + card('ax-gate', 'lc-3', 'Noise gate', sw('gate', M.gate.on, 'On'), `<div class="ax-rows">
      ${row('Threshold', 'gate:threshold', { min: -59, max: 0 })}${row('Attenuation', 'gate:attenuation')}
      ${row('Attack', 'gate:attack', { max: sc.gate_ms.length - 1 })}${row('Release', 'gate:release', { max: sc.gate_ms.length - 1 })}</div>`)
    + card('ax-comp', 'lc-4', 'Compressor', '', `<div class="ax-rows">
      ${row('Threshold', 'comp:threshold', { min: -40, max: 0 })}${row('Ratio', 'comp:ratio', { max: sc.ratio.length - 1 })}
      ${row('Attack', 'comp:attack', { max: sc.comp_attack_ms.length - 1 })}${row('Release', 'comp:release', { max: sc.comp_release_ms.length - 1 })}
      ${row('Makeup', 'comp:makeup', { max: 24 })}</div>`)
    + card('ax-eqc', 'lc-1', 'Equaliser', '', `<div class="ax-eq" style="grid-template-columns: repeat(${M.eq.length}, minmax(0, 1fr)) auto">
      ${M.eq.map(([f], i) => `<div class="ax-eq__b">${out(`eq:${i}`)}${slider(`eq:${i}`, { dir: 'v', min: -9, max: 9, mid: true, label: `EQ ${f}Hz` })}<small>${esc(f)}</small></div>`).join('')}
      <div class="ax-eq__side"><div class="ax-rows">${M.deess === null ? '' : row('De-esser', 'deess:')}${row('Bleep', 'bleep:', { min: -34, max: 0 })}</div></div>
    </div>`);
}

// ---- the Lighting tab -----------------------------------------------------------------------------------------------
// A drawing of the GoXLR's front panel in its current colours (SVG from V.lighting + the mixer's state), the picked
// part's settings and the Global card. Every colour is six hex digits, as the daemon takes them. Colour pickers fire
// while dragged: they update the drawing in place and send like a slider (≤10 a second, last value always sent), and
// re-reads don't redraw the page while a colour control has focus (that would close the browser's picker).

let ltPick = 'fader:A';
let ltStale = false;                        // a re-read arrived while a colour control was in use
const MUTE_BTN = { A: 'Fader1Mute', B: 'Fader2Mute', C: 'Fader3Mute', D: 'Fader4Mute' };
const FX_BTN = { EffectMegaphone: ['Megaphone', 'megaphone'], EffectRobot: ['Robot', 'robot'], EffectHardTune: ['Hard tune', 'hardtune'], EffectFx: ['FX', 'enabled'] };
const KNOBS = ['Reverb', 'Echo', 'Pitch', 'Gender'];
const OFF_STYLES = [['Dimmed', 'Dim'], ['Colour2', 'Off colour'], ['DimmedColour2', 'Dim off colour']];
const FADER_STYLES = [['TwoColour', 'Two colour'], ['Gradient', 'Gradient'], ['Meter', 'Meter'], ['GradientMeter', 'Gradient meter']];
const MODES = [['None', 'None'], ['Simple', 'Simple'], ['Ripple', 'Ripple'], ['RainbowBright', 'Rainbow bright'], ['RainbowDark', 'Rainbow dark'], ['RetroRainbow', 'Retro rainbow']];
const isMini = () => V.device.type === 'GoXLR Mini';
const colourBusy = () => !!document.activeElement?.closest?.('#view-audio input[type="color"], #view-audio .ax-col__hex');

// colours
const rgbOf = h => [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
const hexOf = rgb => rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
const dim = (h, k = 0.25) => hexOf(rgbOf(h).map(v => v * k));
const lum = h => { const [r, g, b] = rgbOf(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
const inkOn = h => (lum(h) > 0.42 ? '#0b0b0d' : '#e8e8ec');
// Theme colours → LED colours. An LED can't show a dark colour, only a dimmer one, and a pastel washes out to nearly
// white because every channel glows (Mike, 2026-11-23: "quite pastely, even more so in reality"). So: full brightness,
// and most of the way to a pure colour (saturation s → 1 − 0.35·(1 − s)) with the hue kept; greys become white.
function led(h) {
  const [r, g, b] = rgbOf(h).map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx === 0) return '000000';
  const s = (mx - mn) / mx;
  if (s < 0.15) return 'FFFFFF';
  const s2 = 1 - (1 - s) * 0.35;
  return hexOf([r, g, b].map(c => 255 * (1 - (s2 * (mx - c)) / (mx - mn))));
}
function cssColour(token) {
  const p = document.createElement('span');
  p.style.color = `var(${token})`;
  document.body.append(p);
  const c = getComputedStyle(p).color;
  p.remove();
  const n = c.match(/[\d.]+/g)?.map(Number) || [0, 0, 0];
  return hexOf(c.startsWith('color(') ? n.slice(0, 3).map(v => v * 255) : n.slice(0, 3));
}
// The GoXLR has one scheme per theme, Night's, in Day too (Mike, 2026-11-23): read the tokens with the page switched to
// Night for a moment (applySpec is synchronous, so nothing is painted in between); a custom theme's Night half applies.
function themeLeds() {
  const lc = document.documentElement.dataset.family === 'lcars';
  const t = lc ? { frame: '--lc-1', soft: '--lc-2', alt: '--lc-3', warm: '--lc-5', attention: '--lc-7', alert: '--lc-red' }
    : { frame: '--accent', soft: '--accent-soft', alt: '--accent-hi', warm: '--silver', attention: '--warn', alert: '--bad' };
  const day = themeMode() === 'day';
  if (day) applySpec(undefined, 'night');
  try { return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, led(cssColour(v))])); } finally { if (day) applySpec(); }
}
const CHIP_NAMES = { frame: 'Frame', soft: 'Soft', alt: 'Accent', warm: 'Fourth', attention: 'Attention', alert: 'Alert' };

// the parts: what each is called, its colours (in the order the hub takes them) and its style
const fname = id => { const f = V.faders.find(x => x.id === id); return chan(f?.channel)?.name || f?.channel || id; };
const ref = (obj, key) => ({ get: () => obj()[key], set: v => { obj()[key] = v; } });
function partInfo(id) {
  const L = V.lighting, [kind, k] = id.split(':');
  if (kind === 'global' || kind === 'accent') return { title: kind === 'global' ? 'Global' : 'Accent', cols: [[kind === 'global' ? 'Global' : 'Accent', ref(() => L, kind)]] };
  if (kind === 'fader') {
    const f = () => L.faders[k];
    return { title: `Fader ${k}`, sub: fname(k), cols: [['Top', ref(f, 'top')], ['Bottom', ref(f, 'bottom')]], style: { opts: FADER_STYLES, label: 'Style', ...ref(f, 'style') }, all: 'Apply to all faders' };
  }
  if (kind === 'scribble') return { title: `Screen ${k}`, sub: fname(k), cols: [['Colour', ref(() => L.faders[k], 'screen')]], all: 'Apply to all screens' };
  if (kind === 'knob') { const e = () => L.knobs[k]; return { title: `${k} knob`, cols: [['Left', ref(e, 'left')], ['Right', ref(e, 'right')], ['Knob', ref(e, 'knob')]], all: 'Apply to all knobs' }; }
  if (kind === 'bank') {
    const b = () => L.banks[k];
    return { title: `Sampler bank ${k}`, cols: [['On', ref(b, 'on')], ['Off', ref(b, 'off')], ['Empty pad', ref(b, 'empty')]], style: { opts: OFF_STYLES, label: 'When off', ...ref(b, 'off_style') }, all: 'Apply to all banks' };
  }
  const name = kind === 'mute' ? MUTE_BTN[k] : k, b = () => L.buttons[name];
  const preset = name.startsWith('EffectSelect');
  const title = kind === 'mute' ? `Mute ${k}` : name === 'Cough' ? 'Mic mute' : name === 'Bleep' ? 'Bleep' : preset ? `Effect preset ${name.slice(-1)}` : FX_BTN[name][0];
  const sub = kind === 'mute' ? fname(k) : preset ? V.effects?.presets[+name.slice(-1) - 1]?.[1] : '';
  const all = kind === 'mute' ? 'Apply to all mute buttons' : preset ? 'Apply to all presets' : FX_BTN[name] ? 'Apply to all effect buttons' : '';
  return { title, sub, cols: [['On', ref(b, 'on')], ['Off', ref(b, 'off')]], style: { opts: OFF_STYLES, label: 'When off', ...ref(b, 'off_style') }, all };
}
const lightBody = (part, extra = {}) => ({ cmd: 'light', part, colours: partInfo(part).cols.map(([, f]) => f.get()), ...extra });

// the drawing
const btnFill = (b, on) => (on ? b.on : b.off_style === 'Dimmed' ? dim(b.on) : b.off_style === 'Colour2' ? b.off : dim(b.off));
const hit = (x, y, w, h, r = 6) => `<rect class="ax-lt-hit" x="${x - 5}" y="${y - 5}" width="${w + 10}" height="${h + 10}" rx="${r + 4}"/>`;
const partG = (id, label, inner) => `<g data-ax-part="${id}" tabindex="0" role="button" aria-label="${esc(label)}" aria-pressed="${ltPick === id}"${ltPick === id ? ' class="is-picked"' : ''}>${inner}</g>`;
function ltButton(id, label, b, on, x, y, w, h, text, size = 11) {
  const fill = btnFill(b, on);
  return partG(id, label, `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="#${fill}" stroke="rgba(255,255,255,.08)"/>
    <text x="${x + w / 2}" y="${y + h / 2 + size * 0.36}" text-anchor="middle" font-size="${size}" fill="${inkOn(fill)}" letter-spacing=".08em">${esc(text)}</text>${hit(x, y, w, h)}`);
}
function fadersSvg() {
  const L = V.lighting, top = 150, len = 262;
  let defs = '<pattern id="axseg" width="8" height="7" patternUnits="userSpaceOnUse"><rect width="8" height="4.5" fill="#fff"/></pattern>', body = '';
  V.faders.forEach((f, i) => {
    const x0 = 22 + i * 124, cx = x0 + 55, F = L.faders[f.id], capY = top + (1 - (chan(f.channel)?.v ?? 0) / 100) * len;
    defs += `<linearGradient id="axg${f.id}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#${F.bottom}"/><stop offset="1" stop-color="#${F.top}"/></linearGradient>
      <mask id="axm${f.id}"><rect x="${cx - 5}" y="${top}" width="10" height="${len}" fill="url(#axseg)"/></mask>`;
    const strip = F.style.includes('Gradient') ? `<rect x="${cx - 4}" y="${top}" width="8" height="${len}" rx="4" fill="url(#axg${f.id})"/>`
      : `<rect x="${cx - 4}" y="${top}" width="8" height="${capY - top}" fill="#${F.top}"/><rect x="${cx - 4}" y="${capY}" width="8" height="${top + len - capY}" fill="#${F.bottom}"/>`;
    const text = F.text || fname(f.id);
    body += partG(`scribble:${f.id}`, `Screen ${f.id}, ${text}`, `<rect x="${x0 + 6}" y="22" width="98" height="58" rx="4" fill="#${F.screen}"/>
        <text x="${x0 + 13}" y="38" font-size="11" fill="${inkOn(F.screen)}">${esc(F.number)}</text>
        <text x="${cx}" y="66" text-anchor="middle" font-size="13" fill="${inkOn(F.screen)}">${esc(text.slice(0, 11))}</text>${hit(x0 + 6, 22, 98, 58)}`)
      + ltButton(`mute:${f.id}`, `Mute ${f.id}`, L.buttons[MUTE_BTN[f.id]], f.muted, x0 + 18, 94, 74, 30, 'MUTE', 10)
      + partG(`fader:${f.id}`, `Fader ${f.id}, ${fname(f.id)}`, `<rect class="ax-lt-slot" x="${cx - 9}" y="${top - 6}" width="18" height="${len + 12}" rx="9"/>
        <g${F.style.includes('Meter') ? ` mask="url(#axm${f.id})"` : ''}>${strip}</g>
        <rect class="ax-lt-cap" x="${cx - 26}" y="${capY - 11}" width="52" height="22" rx="4"/><rect x="${cx - 18}" y="${capY - 1}" width="36" height="2" fill="#8d8c95"/>
        ${hit(cx - 30, top - 8, 60, len + 16)}`)
      + `<text x="${cx}" y="444" text-anchor="middle" font-size="15" fill="#${L.global}" font-weight="600">${f.id}</text>`;
  });
  return `<svg viewBox="0 0 520 464" role="group" aria-label="Faders"><defs>${defs}</defs>
    <rect class="ax-lt-body" x="1" y="1" width="518" height="462" rx="18" stroke="#${L.accent}"/>${body}</svg>`;
}
function arc(cx, cy, r, a0, a1) {
  const p = a => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}
function knobAt(k) {
  const A = V.effects?.amounts;
  if (!A) return 0.5;
  const key = k.toLowerCase(), lo = A[`${key}_min`] ?? 0, hi = A[`${key}_max`] ?? 100;
  return Math.max(0, Math.min(1, (A[key] - lo) / (hi - lo || 1)));
}
function effectsSvg() {
  const L = V.lighting, cough = L.buttons.Cough, bleep = L.buttons.Bleep;
  if (isMini() && phone.matches) {                    // phones: the Mini's two buttons side by side under the faders
    return `<svg viewBox="0 0 520 124" role="group" aria-label="Mic mute and bleep">
      <rect class="ax-lt-body" x="1" y="1" width="518" height="122" rx="18" stroke="#${L.accent}"/>
      ${ltButton('btn:Bleep', 'Bleep', bleep, false, 22, 22, 180, 80, 'BLEEP', 14)}${ltButton('btn:Cough', 'Mic mute', cough, V.cough.muted, 222, 22, 276, 80, 'MIC MUTE', 14)}</svg>`;
  }
  if (isMini()) {
    return `<svg viewBox="0 0 160 464" role="group" aria-label="Mic mute and bleep">
      <rect class="ax-lt-body" x="1" y="1" width="158" height="462" rx="18" stroke="#${L.accent}"/>
      ${ltButton('btn:Bleep', 'Bleep', bleep, false, 22, 150, 116, 80, 'BLEEP')}${ltButton('btn:Cough', 'Mic mute', cough, V.cough.muted, 22, 250, 116, 150, 'MIC MUTE')}</svg>`;
  }
  const E = V.effects || { preset: '', enabled: false };
  let s = '';
  for (let i = 1; i <= 6; i++) s += ltButton(`btn:EffectSelect${i}`, `Effect preset ${i}`, L.buttons[`EffectSelect${i}`], E.preset === `Preset${i}`, 22 + (i - 1) * 74, 22, 66, 34, String(i), 13);
  KNOBS.forEach((k, i) => {
    const cx = 76.5 + i * 109, cy = 116, K = L.knobs[k], av = -135 + 270 * knobAt(k);
    const px = (cx + 17 * Math.sin((av * Math.PI) / 180)).toFixed(1), py = (cy - 17 * Math.cos((av * Math.PI) / 180)).toFixed(1);
    s += partG(`knob:${k}`, `${k} knob`, `<path d="${arc(cx, cy, 38, -135, av)}" fill="none" stroke="#${K.left}" stroke-width="7" stroke-linecap="round"/>
      <path d="${arc(cx, cy, 38, av, 135)}" fill="none" stroke="#${K.right}" stroke-width="7" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="25" fill="#1d1c22" stroke="#${K.knob}" stroke-width="4"/>
      <line x1="${cx}" y1="${cy}" x2="${px}" y2="${py}" stroke="#8d8c95" stroke-width="3" stroke-linecap="round"/>${hit(cx - 46, cy - 46, 92, 92, 40)}`)
      + `<text x="${cx}" y="178" text-anchor="middle" font-size="11" fill="#${L.global}" letter-spacing=".1em">${k.toUpperCase()}</text>`;
  });
  Object.entries(FX_BTN).forEach(([k, [label, key]], i) => { s += ltButton(`btn:${k}`, label, L.buttons[k], !!E[key], 22 + i * 111, 196, 103, 34, label.toUpperCase(), 10.5); });
  s += `<line x1="22" y1="250" x2="458" y2="250" stroke="#${L.accent}" stroke-width="1.5"/>`;
  const bank = V.sampler?.bank || 'A';
  ['A', 'B', 'C'].forEach((k, i) => { s += ltButton(`bank:${k}`, `Sampler bank ${k}`, L.banks[k], bank === k, 22 + i * 64, 266, 56, 30, k, 13); });
  const cur = L.banks[bank];
  (V.sampler?.pads || []).forEach((p, i) => {
    const x = 22 + (i % 2) * 96, y = 308 + Math.floor(i / 2) * 70, fill = p.samples.length ? cur.on : cur.empty;
    s += partG(`bank:${bank}`, `${p.name} pad (bank ${bank}'s colours)`, `<rect x="${x}" y="${y}" width="88" height="62" rx="6" fill="#${fill}" stroke="rgba(255,255,255,.1)"/>${hit(x, y, 88, 62)}`);
  });
  s += ltButton('btn:Bleep', 'Bleep', bleep, false, 236, 266, 222, 62, 'BLEEP') + ltButton('btn:Cough', 'Mic mute', cough, V.cough.muted, 236, 340, 222, 100, 'MIC MUTE', 12);
  return `<svg viewBox="0 0 480 464" role="group" aria-label="Effects and sampler">
    <rect class="ax-lt-body" x="1" y="1" width="478" height="462" rx="18" stroke="#${L.accent}"/>${s}</svg>`;
}
const drawing = () => `<div class="ax-dev${isMini() ? ' is-mini' : ''}">${fadersSvg()}${effectsSvg()}</div>`;

// the settings
let fields = [];                            // the colour rows on screen: index → {part, f}
function colRow(label, part, f, T) {
  const i = fields.push({ part, f }) - 1, v = f.get();
  return `<span class="ax-col__l">${esc(label)}</span>
    <label class="ax-col__sw" style="--c:#${v}" title="Pick a colour"><input type="color" value="#${v.toLowerCase()}" data-ax-col="${i}" aria-label="${esc(label)} colour"></label>
    <input class="ax-col__hex" value="${v}" maxlength="6" spellcheck="false" autocomplete="off" data-ax-hex="${i}" aria-label="${esc(label)} hex">
    <span class="ax-chips">${Object.entries(T).map(([k, c]) => `<button type="button" class="ax-chip" style="--c:#${c}" data-ax-chip="${i}:${c}" title="${CHIP_NAMES[k]}" aria-label="${esc(label)}: theme ${CHIP_NAMES[k]}"></button>`).join('')}
      <button type="button" class="ax-chip" style="--c:#fff" data-ax-chip="${i}:FFFFFF" title="White" aria-label="${esc(label)}: white"></button>
      <button type="button" class="ax-chip ax-chip--off" data-ax-chip="${i}:000000" title="Off" aria-label="${esc(label)}: off"></button></span>`;
}
const lseg = (label, opts, cur, data) => `<span class="seg" role="group" aria-label="${esc(label)}">${opts.map(([id, l]) => `<button type="button" data-${data}="${id}" aria-pressed="${id === cur}">${esc(l)}</button>`).join('')}</span>`;
function lightingCards() {
  fields = [];
  const L = V.lighting, T = themeLeds(), P = partInfo(ltPick), A = L.animation;
  const panel = card('ax-panel', 'lc-1', 'Front panel', `<span class="ax-hr"><button type="button" class="ax-save ax-match" data-ax-match>${ico('palette')}<span>Match my theme</span></button></span>`,
    `<div data-ax-dev>${drawing()}</div>`);
  const picked = card('ax-part', 'lc-3', 'Picked', '', `<p class="ax-part__name">${esc(P.title)}${P.sub ? `<small>${esc(P.sub)}</small>` : ''}</p>
    <div class="ax-cols">${P.cols.map(([l, f]) => colRow(l, ltPick, f, T)).join('')}</div>
    ${P.style ? `<div class="ax-sec"><div class="ax-lab">${P.style.label}</div>${lseg(P.style.label, P.style.opts, P.style.get(), 'ax-lstyle')}</div>` : ''}
    ${P.all ? `<div class="ax-acts"><button type="button" class="ax-save" data-ax-all>${esc(P.all)}</button></div>` : ''}`);
  const m = A?.mode;
  const others = V.profiles.filter(p => p !== V.profile);
  const global = card('ax-anim', 'lc-2', 'Global', '', `
    ${A ? `<div class="ax-lab">Animation</div>${lseg('Animation', MODES.filter(([id]) => !isMini() || id !== 'Ripple'), m, 'ax-amode')}
      ${m !== 'None' ? `<div class="ax-rows">${row('Gradient 1', 'mod:mod1')}${m === 'RainbowBright' || m === 'RainbowDark' ? row('Gradient 2', 'mod:mod2') : ''}</div>` : ''}
      ${m !== 'None' && m !== 'RetroRainbow' ? `<div class="ax-sec"><div class="ax-lab">Waterfall</div>${lseg('Waterfall', [['Down', 'Down'], ['Up', 'Up'], ['Off', 'Off']], A.waterfall, 'ax-water')}</div>` : ''}` : ''}
    <div class="ax-sec"><div class="ax-lab">Colours</div><div class="ax-cols">${colRow('Global', 'global', ref(() => L, 'global'), T)}${colRow('Accent', 'accent', ref(() => L, 'accent'), T)}</div></div>
    ${others.length ? `<div class="ax-sec"><div class="ax-lab">Copy colours from</div><div class="ax-pickrow"><label class="ax-pick ax-pick--card"><select data-ax-copyfrom aria-label="Profile to copy colours from">${others.map(p => `<option>${esc(p)}</option>`).join('')}</select></label><button type="button" class="ax-save" data-ax-copy>Copy</button></div></div>` : ''}`);
  return panel + picked + global;
}
const redrawPanel = () => { const d = $('[data-ax-dev]', root); if (d) d.innerHTML = drawing(); };
function pickPart(id) {
  ltPick = id;
  render();
  if (phone.matches) $('.ax-part', root)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function applyAll() {                       // the picked part's colours and style onto the rest of its kind, here first
  const [kind] = ltPick.split(':'), P = partInfo(ltPick), btn = ltPick.slice(4);
  const ids = ['fader', 'scribble', 'mute'].includes(kind) ? ['A', 'B', 'C', 'D'].map(k => `${kind}:${k}`)
    : kind === 'knob' ? KNOBS.map(k => `knob:${k}`) : kind === 'bank' ? ['A', 'B', 'C'].map(k => `bank:${k}`)
      : btn.startsWith('EffectSelect') ? [1, 2, 3, 4, 5, 6].map(n => `btn:EffectSelect${n}`) : Object.keys(FX_BTN).map(k => `btn:${k}`);
  for (const id of ids) {
    if (id === ltPick) continue;
    const Q = partInfo(id);
    Q.cols.forEach(([, f], i) => f.set(P.cols[i][1].get()));
    if (Q.style) Q.style.set(P.style.get());
  }
  return lightBody(ltPick, { all: true, ...(P.style ? { style: P.style.get() } : {}) });
}

function soonCard() {
  const t = TABS.find(x => x[0] === tab);
  return card('ax-soon', 'lc-6', t[1], '', `<p class="ax-soon__p">Not here yet. <a class="ax-util" href="${UTILITY}" target="_blank" rel="noopener" title="Opens on this PC only">Open the GoXLR utility ${ico('ext')}</a></p>`);
}

function render() {
  if (!V) { root.innerHTML = '<div class="ax"><div class="ax-head"><h2>Audio</h2></div></div>'; return; }
  const keep = document.activeElement?.closest?.('#view-audio [data-ax-sl], #view-audio button[data-ax-tab], #view-audio [data-ax-part]');
  const focusKey = !keep ? null : keep.dataset.axSl ? `[data-ax-sl="${CSS.escape(keep.dataset.axSl)}"]`
    : keep.dataset.axPart ? `[data-ax-part="${CSS.escape(keep.dataset.axPart)}"]` : `[data-ax-tab="${keep.dataset.axTab}"]`;
  ltStale = false;
  const ready = !!V.channels;                         // the daemon has answered at least once
  const down = V.available ? '' : V.configured === false ? 'No GoXLR utility is set up for this hub.' : 'The GoXLR utility isn\'t answering. Trying again…';
  const head = `<div class="ax-head">
    <h2>Audio</h2>
    ${ready ? `<div class="ax-sub"><span>${esc(V.device.type)}</span>${V.device.firmware ? `<span>Firmware ${esc(V.device.firmware)}</span>` : ''}${V.device.daemon ? `<span>Utility ${esc(V.device.daemon)}</span>` : ''}</div>` : ''}
    <nav class="mtabs ax-tabs" aria-label="Audio sections">${TABS.map(([id, label, icon]) => `<button type="button" data-ax-tab="${id}" aria-pressed="${id === tab}">${ico(icon)}<span>${label}</span></button>`).join('')}</nav>
    <div class="ax-picks">
      ${ready ? `<label class="ax-pick">Profile <select data-ax-pick="profile">${V.profiles.map(p => `<option${p === V.profile ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>${saves('profile')}` : ''}
      <a class="ax-util" href="${UTILITY}" target="_blank" rel="noopener" title="The GoXLR utility's own page (opens on this PC only)">GoXLR utility ${ico('ext')}</a>
    </div>
  </div>
  <div class="ax-down" ${down ? '' : 'hidden'}>${ico('alert')}<span>${down}</span></div>`;
  let body = '';
  if (ready) {
    body = tab === 'audio' ? mixerCard() + routingCard() + effectsCard() + samplerCard()
      : tab === 'mic' ? micCards() : tab === 'lighting' && V.lighting ? lightingCards() : soonCard();
  }
  root.innerHTML = `<div class="ax${V.available ? '' : ' is-down'}">${head}${body ? `<div class="ax-grid ax-grid--${tab}">${body}</div>` : ''}</div>`;
  if (focusKey) $(focusKey, root)?.focus({ preventScroll: true });
}

// ---- actions -------------------------------------------------------------------------------------------------------

root.addEventListener('click', e => {
  const p = e.target.closest('[data-ax-part]');
  if (p && root.contains(p)) { pickPart(p.dataset.axPart); return; }
  const b = e.target.closest('button');
  if (!b || b.disabled || !root.contains(b)) return;
  const d = b.dataset;
  if (d.axTab) { tab = d.axTab; save('ax-tab', tab); render(); levelPoll(); return; }
  if (!V?.available) return;
  if (d.axSave) { saveProfile(d.axSave); return; }
  if (d.axSaveas) { saveAs(d.axSaveas); return; }
  // Lighting
  if (d.axChip) { const [i, c] = d.axChip.split(':'), F = fields[+i]; F.f.set(c); render(); send(lightBody(F.part)); return; }
  if (d.axLstyle) { partInfo(ltPick).style.set(d.axLstyle); render(); send({ cmd: 'light', part: ltPick, style: d.axLstyle }); return; }
  if ('axAll' in d) { const body = applyAll(); render(); send(body); return; }
  if (d.axAmode) { V.lighting.animation.mode = d.axAmode; render(); send({ cmd: 'anim', mode: d.axAmode }); return; }
  if (d.axWater) { V.lighting.animation.waterfall = d.axWater; render(); send({ cmd: 'anim', waterfall: d.axWater }); return; }
  if ('axMatch' in d) { b.disabled = true; send({ cmd: 'light_theme', ...themeLeds() }).then(() => refresh()); return; }
  if ('axCopy' in d) { const name = $('[data-ax-copyfrom]', root)?.value; if (name) send({ cmd: 'light_copy', name }).then(() => refresh()); return; }
  let body = null;
  if (d.axMute) { const f = V.faders.find(x => x.id === d.axMute); f.muted = !f.muted; body = { cmd: 'fader_mute', fader: f.id, muted: f.muted }; }
  else if ('axCough' in d) { V.cough.muted = !V.cough.muted; body = { cmd: 'cough', muted: V.cough.muted }; }
  else if (d.axSwitch) {
    const on = b.getAttribute('aria-pressed') !== 'true';
    const w = d.axSwitch;
    if (w === 'fx') V.effects.enabled = on; else if (w === 'submix') V.submix.enabled = on; else if (w === 'gate') V.mic.gate.on = on; else V.effects[w] = on;
    body = { cmd: 'switch', what: w, on };
  } else if (d.axRoute) {
    const [i, o] = d.axRoute.split(':'), j = V.router.outputs.findIndex(x => x[0] === o);
    V.router.on[i][j] = !V.router.on[i][j];
    body = { cmd: 'route', input: i, output: o, on: V.router.on[i][j] };
  } else if (d.axPreset) { V.effects.preset = d.axPreset; body = { cmd: 'preset', preset: d.axPreset }; }
  else if (d.axLink) { const c = chan(d.axLink); c.linked = !c.linked; body = { cmd: 'sub_link', channel: c.id, linked: c.linked }; }
  else if (d.axMix) { const [o, m] = d.axMix.split(':'); chan(o).mix = m; body = { cmd: 'out_mix', output: o, mix: m }; }
  else if (d.axMonitor) { V.monitor = d.axMonitor; body = { cmd: 'monitor', output: d.axMonitor }; }
  else if (d.axMictype) { V.mic.type = d.axMictype; body = { cmd: 'mic_type', type: d.axMictype }; }
  else if (d.axBank) { V.sampler.bank = d.axBank; body = { cmd: 'bank', bank: d.axBank }; }
  else if (d.axPad) { const p = V.sampler.pads.find(x => x.id === d.axPad); p.playing = !p.playing; body = { cmd: 'pad', pad: p.id, play: p.playing }; }
  if (!body) return;
  render();
  send(body);
});

root.addEventListener('change', e => {
  const s = e.target.closest('[data-ax-pick]');
  if (!s || !V?.available) return;
  const which = s.dataset.axPick, was = V[which];
  if (V.unsaved?.[which] && !confirm(`Load “${s.value}”? The unsaved changes to “${was}” will be lost.`)) { s.value = was; return; }
  V[which] = s.value;
  if (V.unsaved) V.unsaved[which] = false;
  send({ cmd: which, name: s.value });
});

// Lighting colour controls: the picker and the hex box change the drawing in place and send like a slider
root.addEventListener('input', e => {
  const t = e.target, i = t.dataset.axCol ?? t.dataset.axHex, F = fields[+i];
  if (i === undefined || !F || !V?.available) return;
  const v = t.value.replace('#', '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(v)) return;
  F.f.set(v);
  const sw = root.querySelector(`[data-ax-col="${i}"]`);
  sw.value = `#${v.toLowerCase()}`;
  sw.parentElement.style.setProperty('--c', `#${v}`);
  if (t.dataset.axCol !== undefined) root.querySelector(`[data-ax-hex="${i}"]`).value = v;
  redrawPanel();
  sendSoon(`light:${F.part}`, lightBody(F.part));
});
// the picker closed, or the hex box was left: show anything that changed meanwhile (and put a half-typed hex back)
root.addEventListener('change', e => { if (e.target.matches('input[type="color"], .ax-col__hex')) render(); });
root.addEventListener('focusout', e => {
  if (ltStale && e.target.matches?.('input[type="color"], .ax-col__hex')) setTimeout(() => { if (!colourBusy()) render(); }, 0);
});

// ---- saving ----------------------------------------------------------------------------------------------------------

async function saveProfile(which) {
  if (await send({ cmd: 'save', which })) {
    if (V.unsaved) V.unsaved[which] = false;
    render();
    toast(`Saved “${V[which]}”`);
  }
}
let saveDlg = null;
function saveAs(which) {
  if (!saveDlg) {
    saveDlg = document.createElement('dialog');
    saveDlg.className = 'book ax-saveas';
    saveDlg.setAttribute('aria-labelledby', 'ax-saveas-title');
    saveDlg.innerHTML = `<form class="book__form" novalidate>
      <h2 class="book__title" id="ax-saveas-title"></h2>
      <div class="book__grid"><label class="book__field book__field--wide"><span>Name</span><input name="name" maxlength="64" required autocomplete="off"></label></div>
      <p class="book__error" role="alert" hidden></p>
      <div class="book__actions"><button class="btn" type="button" data-ax-cancel>Cancel</button><button class="btn btn--solid" type="submit">Save</button></div>
    </form>`;
    document.body.append(saveDlg);
    saveDlg.querySelector('[data-ax-cancel]').addEventListener('click', () => saveDlg.close());
    saveDlg.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const w = saveDlg.dataset.which, name = saveDlg.querySelector('input').value.trim(), err = saveDlg.querySelector('.book__error');
      if (!name) return;
      try {
        await api.post(API, { cmd: 'save_as', which: w, name });
      } catch (x) {
        err.textContent = x.message || 'The GoXLR didn\'t take that'; err.hidden = false;
        return;
      }
      saveDlg.close();
      V[w] = name;
      if (V.unsaved) V.unsaved[w] = false;
      render();
      toast(`Saved as “${name}”`);
      refresh();
    });
  }
  saveDlg.dataset.which = which;
  saveDlg.querySelector('h2').textContent = which === 'profile' ? 'Save profile as' : 'Save mic profile as';
  const input = saveDlg.querySelector('input'), err = saveDlg.querySelector('.book__error');
  input.value = `${V[which]} copy`; err.hidden = true;
  saveDlg.showModal();
  input.select();
}

// sliders: press, drag, keys, wheel. While dragging, only this slider (and its readout) is redrawn.
function valueAt(el, ev) {
  const r = $('.ax-sl__rail', el).getBoundingClientRect(), min = +el.dataset.min, max = +el.dataset.max, step = +el.dataset.step || 1;
  const n = el.classList.contains('ax-sl--h') ? (ev.clientX - r.left) / r.width : (r.bottom - ev.clientY) / r.height;
  const v = min + Math.max(0, Math.min(1, n)) * (max - min);
  return Math.max(min, Math.min(max, Math.round(v / step) * step));
}
function setSlider(el, v) {
  const key = el.dataset.axSl, [kind, id] = part(key), S = SLIDERS[kind];
  if (S.get(id) === v) return;
  S.set(id, v);
  const min = +el.dataset.min, max = +el.dataset.max, n = (v - min) / (max - min), z = Math.min(1, Math.max(0, -min / (max - min)));
  el.style.setProperty('--v', n); el.style.setProperty('--lo', Math.min(n, z)); el.style.setProperty('--d', Math.abs(n - z));
  el.setAttribute('aria-valuenow', v); el.setAttribute('aria-valuetext', S.label(v, id));
  root.querySelectorAll(`[data-ax-out="${CSS.escape(key)}"]`).forEach(o => { o.textContent = S.label(v, id); });
  if (kind === 'gate' && id === 'threshold') $('#ax-meter')?.style.setProperty('--gate', (v + 60) / 60);
  sendSoon(key, S.act(id, v));
}
root.addEventListener('pointerdown', e => {
  const el = e.target.closest('[data-ax-sl]');
  if (!el || !V?.available) return;
  e.preventDefault();
  el.focus({ preventScroll: true });
  el.setPointerCapture?.(e.pointerId);
  drag = { el, id: e.pointerId };
  setSlider(el, valueAt(el, e));
});
root.addEventListener('pointermove', e => { if (drag && e.pointerId === drag.id) setSlider(drag.el, valueAt(drag.el, e)); });
function endDrag(e) {
  if (!drag || (e && e.pointerId !== drag.id)) return;
  drag = null;
  render();                                           // catch up on anything that changed meanwhile
}
root.addEventListener('pointerup', endDrag);
root.addEventListener('pointercancel', endDrag);
root.addEventListener('keydown', e => {
  const p = e.target.closest('[data-ax-part]');
  if (p && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickPart(p.dataset.axPart); return; }
  const el = e.target.closest('[data-ax-sl]');
  if (!el || !V?.available) return;
  const step = +el.dataset.step || 1;
  const by = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: step * 10, PageDown: -step * 10 }[e.key];
  const [kind, id] = part(el.dataset.axSl);
  let v;
  if (by) v = SLIDERS[kind].get(id) + by;
  else if (e.key === 'Home') v = +el.dataset.min;
  else if (e.key === 'End') v = +el.dataset.max;
  else return;
  e.preventDefault();
  setSlider(el, Math.max(+el.dataset.min, Math.min(+el.dataset.max, v)));
});
root.addEventListener('wheel', e => {
  const el = e.target.closest('[data-ax-sl]');
  if (!el || !V?.available || phone.matches) return;
  e.preventDefault();
  const [kind, id] = part(el.dataset.axSl), step = +el.dataset.step || 1;
  setSlider(el, Math.max(+el.dataset.min, Math.min(+el.dataset.max, SLIDERS[kind].get(id) + (e.deltaY < 0 ? step : -step))));
}, { passive: false });

// ---- the Microphone tab's level meter -------------------------------------------------------------------------------

function levelPoll() {
  const want = active && tab === 'mic' && V?.available && !document.hidden;
  if (!want) { clearTimeout(levelTimer); levelTimer = null; return; }
  if (levelTimer) return;
  const tick = async () => {
    let wait = LEVEL_MS;
    try {
      const { level } = await api.get(`${API}/level`);
      $('#ax-meter')?.style.setProperty('--m', Math.max(0, Math.min(1, (level + 60) / 60)).toFixed(3));
    } catch {
      wait = 2000;                                    // not connected: try again in a bit, quietly
    }
    levelTimer = active && tab === 'mic' && !document.hidden ? setTimeout(tick, wait) : null;
  };
  levelTimer = setTimeout(tick, 0);
}
