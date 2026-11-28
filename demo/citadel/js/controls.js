// The Controls page (#controls): fast smart-home lighting through Home Assistant on Probe-1.
// Two tailored layouts over one shared model:
// - Desktop (> 760 px): a dynamic Room Configuration Console on the left (always showing brightness, White/Colour,
//   multi-bulb targeting, and Hue scenes for the active room) beside uniform-height room selector tiles on the right.
// - Mobile (<= 760 px): single-column cards with inline collapsible Colour / N lights / Scenes drawers and 44 px touch
//   targets.
//
// Sync & Hue latency resilience:
// - Every mutation bumps a generation counter (`gen`) so any background GET that started earlier is discarded on arrival.
// - Each commanded entity gets a short optimistic grace window (`GRACE_MS`): if a poll arrives while the Philips Hue
//   Bridge is still finishing a fade or propagating SSE state back to Home Assistant, stale pre-command values won't
//   snap the switch or slider back; once HA catches up (or the window expires), live state reconciles cleanly.
//
// Everything is .hc* / [data-hc-*]; never reuse [data-act] or [data-date] (app.js and util.js treat those globally).
import * as api from './api.js';
import { $, esc, ico, toast } from './util.js';

const API = '/api/owner/controls';
const POLL_MS = 10000;
const SEND_MS = 200;                          // Hue Bridge handles ~5–10 Zigbee commands/s smoothly without queuing lag
const SETTLE_MS = 2200;                       // wait for Hue fade + SSE state propagation back to Home Assistant
const GRACE_MS = 3200;                        // ignore stale pre-command HA readings during Hue propagation
const root = $('#view-controls');
const phone = matchMedia('(max-width: 760px)');

const INKS = ['lc-1', 'lc-3', 'lc-5', 'lc-6'];
const WHITE_PRESETS = [
  ['Candle', 2200],
  ['Warm', 2700],
  ['Neutral', 3500],
  ['Cool', 4500],
  ['Daylight', 5500],
];
const COLOUR_SWATCHES = [
  ['Warm amber', [255, 166, 62]],
  ['Sunset', [255, 98, 42]],
  ['Crimson', [235, 45, 58]],
  ['Rose', [242, 72, 152]],
  ['Magenta', [200, 62, 245]],
  ['Violet', [139, 92, 246]],
  ['Cobalt', [56, 120, 255]],
  ['Cyan', [36, 208, 232]],
  ['Mint', [46, 224, 158]],
  ['Emerald', [46, 212, 92]],
];

let V = null;
let active = false, started = false, loading = false, again = false, timer = null, settleTimer = null;
let busy = 0;
let gen = 0;                                  // bumped on every mutation; stale in-flight GETs with older gen are dropped
let drag = null;                              // { el, id, kind, eid, lastVal } while a slider is held
let selectedRoom = null;                      // room entity_id shown in the desktop Configuration Console
let inspectTarget = null;                     // active entity_id in desktop Console (room or one of its child bulbs)
let openColour = null;                        // mobile: entity_id whose inline White/Colour drawer is open
const colourTabs = new Map();                 // entity_id -> 'white' | 'color'
const openLights = new Set();                 // mobile: room ids whose multi-bulb list is expanded
const openScenes = new Set();                 // mobile: room ids whose Hue scenes list is expanded
const pending = new Map();                    // entity_id -> { until, patch } optimistic grace guards
let reordering = false;
let dragRoomEid = null;                       // desktop drag-and-drop source room entity_id
let armedAllOff = false, armTimer = null;
let pickerStale = false;
const throttle = new Map();                   // key -> { at, timer, fn }

export function onView(v) {
  const was = active;
  active = v === 'controls';
  if (active && !started) {
    started = true;
    phone.addEventListener('change', () => { if (active) render(); });
    document.addEventListener('visibilitychange', () => { if (active && !document.hidden) refresh(); });
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('focusout', e => {
      if (e.target.matches?.('[data-hc-picker]') && pickerStale) { pickerStale = false; render(); }
    });
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerup', onPointerUp);
    root.addEventListener('pointercancel', onPointerUp);
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('dragleave', onDragLeave);
    root.addEventListener('drop', onDrop);
    root.addEventListener('dragend', onDragEnd);
  }
  if (active && !was) refresh();
  if (!active) { clearTimeout(timer); timer = null; }
}

// ---- colour maths --------------------------------------------------------------------------------------------------

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function kelvinToRgb(k) {
  const t = clamp(k, 1500, 9000) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = clamp(99.4708025861 * Math.log(t) - 161.1195681661, 0, 255);
    b = t <= 19 ? 0 : clamp(138.5177312231 * Math.log(t - 10) - 305.0447927307, 0, 255);
  } else {
    r = clamp(329.698727446 * Math.pow(t - 60, -0.1332047592), 0, 255);
    g = clamp(288.1221695283 * Math.pow(t - 60, -0.0755148492), 0, 255);
    b = 255;
  }
  return [Math.round(r), Math.round(g), Math.round(b)];
}

function rgbToHex(rgb) {
  return '#' + rgb.map(c => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function liveRgb(item) {
  if (!item.on) return null;
  if (item.color_mode === 'color_temp' && item.color_temp_kelvin) return kelvinToRgb(item.color_temp_kelvin);
  if (Array.isArray(item.rgb) && item.rgb.length === 3) return item.rgb;
  if (item.color_temp_kelvin) return kelvinToRgb(item.color_temp_kelvin);
  return [255, 214, 156];
}

function themeAccentRgb() {
  const cs = getComputedStyle(document.documentElement);
  const raw = (cs.getPropertyValue('--accent') || '#8b5cf6').trim();
  const hex = hexToRgb(raw);
  let rgb = hex;
  if (!rgb) {
    const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(raw);
    rgb = m ? [+m[1], +m[2], +m[3]] : [139, 92, 246];
  }
  const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (max === 0 || d < 0.05) return rgb;
  let h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? ((b - r) / d + 2) : ((r - g) / d + 4);
  h /= 6;
  const s = clamp(1 - 0.35 * (1 - d / max), 0.45, 1), v = 1;
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [rr, gg, bb] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [Math.round(rr * 255), Math.round(gg * 255), Math.round(bb * 255)];
}

// ---- data helpers & optimistic grace reconciliation ----------------------------------------------------------------

const colourBusy = () => !!document.activeElement?.matches?.('#view-controls [data-hc-picker]');

function allItems(data = V) {
  const map = new Map();
  for (const r of data?.rooms || []) {
    map.set(r.entity_id, r);
    for (const b of r.lights || []) map.set(b.entity_id, b);
  }
  for (const z of data?.zones || []) map.set(z.entity_id, z);
  return map;
}

function findEntity(eid, data = V) { return allItems(data).get(eid) || null; }

function ensureSelection() {
  const rooms = V?.rooms || [];
  if (!rooms.length) { selectedRoom = null; inspectTarget = null; return null; }
  let room = rooms.find(r => r.entity_id === selectedRoom);
  if (!room) {
    room = rooms[0];
    selectedRoom = room.entity_id;
    inspectTarget = room.entity_id;
  }
  const validTargets = [room.entity_id, ...(room.lights || []).map(b => b.entity_id)];
  if (!validTargets.includes(inspectTarget)) inspectTarget = room.entity_id;
  return room;
}

function recomputeSummary(data = V) {
  if (!data?.rooms) return;
  let on = 0, total = 0, roomsOn = 0;
  for (const r of data.rooms) {
    if (r.lights?.length) {
      total += r.lights.length;
      const lit = r.lights.filter(b => b.on).length;
      on += lit;
      if (r.on) roomsOn++;
    } else {
      total += 1;
      if (r.on) { on += 1; roomsOn++; }
    }
  }
  data.summary = { on, total, rooms_on: roomsOn, rooms_total: data.rooms.length };
}

function syncRoomFromChildren(room) {
  if (!room?.lights?.length) return;
  const lit = room.lights.filter(b => b.on);
  room.on = lit.length > 0;
  if (lit.length) {
    const avg = Math.round(lit.reduce((s, b) => s + (b.brightness || 100), 0) / lit.length);
    room.brightness = clamp(avg, 1, 100);
  }
}

function applyPatchToItem(item, patch) {
  if (!item) return;
  if (patch.on === false) {
    item.on = false;
    return;
  }
  if (patch.on === true) {
    item.on = true;
    if (!item.brightness && item.supports?.brightness) item.brightness = 100;
  }
  if (patch.brightness != null) {
    item.on = true;
    item.brightness = patch.brightness;
  }
  if (patch.kelvin != null && item.supports?.color_temp !== false) {
    item.on = true;
    item.color_mode = 'color_temp';
    item.color_temp_kelvin = patch.kelvin;
    item.rgb = kelvinToRgb(patch.kelvin);
    if (!item.brightness && item.supports?.brightness) item.brightness = 100;
  }
  if (patch.rgb != null && item.supports?.color !== false) {
    item.on = true;
    item.color_mode = 'xy';
    item.rgb = [...patch.rgb];
    item.color_temp_kelvin = null;
    if (!item.brightness && item.supports?.brightness) item.brightness = 100;
  }
}

function markPending(eid, patch, ttl = GRACE_MS) {
  const until = performance.now() + ttl;
  const prev = pending.get(eid);
  const merged = prev && prev.until > performance.now() ? { ...prev.patch, ...patch } : { ...patch };
  // Contradictory fields override cleanly (e.g. off clears brightness; brightness/kelvin/rgb clears on=false).
  if (patch.on === false) { delete merged.brightness; delete merged.kelvin; delete merged.rgb; }
  else if (patch.brightness != null || patch.kelvin != null || patch.rgb != null) { merged.on = true; }
  if (patch.kelvin != null) delete merged.rgb;
  if (patch.rgb != null) delete merged.kelvin;
  pending.set(eid, { until, patch: merged });
}

function serverMatchesPatch(item, patch) {
  if (patch.on === false) return !item.on;
  if (patch.on === true && !item.on) return false;
  if (patch.brightness != null && (!item.on || Math.abs((item.brightness ?? 0) - patch.brightness) > 4)) return false;
  if (patch.kelvin != null && (!item.on || item.color_mode !== 'color_temp' || Math.abs((item.color_temp_kelvin ?? 0) - patch.kelvin) > 200)) return false;
  if (patch.rgb != null) {
    if (!item.on || !Array.isArray(item.rgb)) return false;
    const diff = Math.abs(item.rgb[0] - patch.rgb[0]) + Math.abs(item.rgb[1] - patch.rgb[1]) + Math.abs(item.rgb[2] - patch.rgb[2]);
    if (diff > 75) return false;
  }
  return true;
}

function reconcileIncoming(got) {
  if (!got?.available || !pending.size) return false;
  const now = performance.now();
  let stillWaiting = false;
  for (const [eid, entry] of [...pending.entries()]) {
    const item = findEntity(eid, got);
    if (!item || now >= entry.until || serverMatchesPatch(item, entry.patch)) {
      pending.delete(eid);
      continue;
    }
    // Home Assistant hasn't received the Hue Bridge's confirmation yet — hold our optimistic value.
    applyPatchToItem(item, entry.patch);
    stillWaiting = true;
  }
  if (stillWaiting) {
    for (const r of got.rooms || []) {
      if (r.lights?.length && !pending.has(r.entity_id) && r.lights.some(b => pending.has(b.entity_id))) {
        syncRoomFromChildren(r);
      }
    }
    recomputeSummary(got);
  }
  return stillWaiting;
}

function applyLocal(eid, patch, { guard = true } = {}) {
  const item = findEntity(eid);
  if (!item) return;
  applyPatchToItem(item, patch);
  if (guard) markPending(eid, patch);
  const parentRoom = (V?.rooms || []).find(r => r.entity_id === eid);
  if (parentRoom?.lights?.length) {
    for (const b of parentRoom.lights) {
      if (!b.available) continue;
      applyPatchToItem(b, patch);
      if (guard) markPending(b.entity_id, patch);
    }
  } else {
    const owner = (V?.rooms || []).find(r => r.lights?.some(b => b.entity_id === eid));
    if (owner) syncRoomFromChildren(owner);
  }
  recomputeSummary();
}

// ---- reading & sending ---------------------------------------------------------------------------------------------

async function refresh() {
  if (loading || busy || drag) { again = true; return; }
  loading = true;
  clearTimeout(timer);
  const myGen = gen;
  let got = null, err = null;
  try {
    got = await api.get(API);
  } catch (e) {
    err = e;
  } finally {
    loading = false;
  }
  // Drop any poll that raced with a newer user mutation or an active drag — never let an old GET snap the UI back!
  if (myGen !== gen || busy > 0 || drag) {
    if (active && !document.hidden) timer = setTimeout(refresh, POLL_MS);
    return;
  }
  let waitingOnHue = false;
  if (err) {
    V = { ...(V || { rooms: [], zones: [], summary: { on: 0, total: 0, rooms_on: 0, rooms_total: 0 } }), available: false, error: err.message };
  } else {
    waitingOnHue = reconcileIncoming(got);
    V = got;
  }
  if (colourBusy()) pickerStale = true;
  else render();
  if (again) { again = false; refresh(); return; }
  if (active && !document.hidden) {
    timer = setTimeout(refresh, waitingOnHue ? 1500 : POLL_MS);
  }
}

function scheduleSettle(delay = SETTLE_MS) {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { if (active && !drag && !busy) refresh(); }, delay);
}

async function sendLight(eid, body, { redraw = true, settle = true } = {}) {
  gen++;
  clearTimeout(settleTimer);
  applyLocal(eid, body, { guard: true });
  if (redraw) render();
  busy++;
  try {
    await api.post(`${API}/light/${encodeURIComponent(eid)}`, body);
    if (settle) scheduleSettle();
  } catch (e) {
    pending.delete(eid);
    const parentRoom = (V?.rooms || []).find(r => r.entity_id === eid);
    for (const b of parentRoom?.lights || []) pending.delete(b.entity_id);
    toast(e.message || "Home Assistant didn't accept that");
    busy--;
    refresh();
    return;
  }
  busy--;
}

function sendSoon(key, fn) {
  const t = throttle.get(key) || { at: 0, timer: 0, fn: null };
  throttle.set(key, t);
  t.fn = fn;
  const wait = t.at + SEND_MS - performance.now();
  if (wait <= 0) { t.at = performance.now(); fn(); return; }
  if (!t.timer) {
    t.timer = setTimeout(() => { t.timer = 0; t.at = performance.now(); t.fn?.(); }, wait);
  }
}

async function sendScene(eid, label) {
  gen++;
  clearTimeout(settleTimer);
  busy++;
  try {
    await api.post(`${API}/scene/${encodeURIComponent(eid)}`, {});
    toast(`Scene: ${label}`);
    scheduleSettle(1500);
  } catch (e) {
    toast(e.message || "Couldn't activate scene");
  } finally {
    busy--;
  }
}

async function sendAllOff() {
  gen++;
  clearTimeout(settleTimer);
  const before = structuredClone(V);
  for (const r of V.rooms || []) {
    r.on = false;
    markPending(r.entity_id, { on: false });
    for (const b of r.lights || []) { b.on = false; markPending(b.entity_id, { on: false }); }
  }
  for (const z of V.zones || []) { z.on = false; markPending(z.entity_id, { on: false }); }
  recomputeSummary();
  render();
  busy++;
  try {
    const res = await api.post(`${API}/all-off`, {});
    if (res?.turned_off) toast(`Turned off ${res.turned_off} ${res.turned_off === 1 ? 'room' : 'rooms'}`);
    scheduleSettle();
  } catch (e) {
    pending.clear();
    V = before;
    render();
    toast(e.message || "Couldn't turn lights off");
  } finally {
    busy--;
  }
}

async function persistOrder(rooms) {
  gen++;
  const order = rooms.map(r => r.entity_id);
  busy++;
  try {
    await api.put(`${API}/order`, { order });
  } catch (e) {
    toast(e.message || "Couldn't save room order");
    busy--;
    refresh();
    return;
  }
  busy--;
}

function moveRoom(eid, delta) {
  const rooms = V?.rooms;
  if (!rooms) return;
  const i = rooms.findIndex(r => r.entity_id === eid);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= rooms.length) return;
  const [item] = rooms.splice(i, 1);
  rooms.splice(j, 0, item);
  render();
  persistOrder(rooms);
}

function moveRoomTo(fromEid, toEid) {
  const rooms = V?.rooms;
  if (!rooms || fromEid === toEid) return;
  const i = rooms.findIndex(r => r.entity_id === fromEid);
  const j = rooms.findIndex(r => r.entity_id === toEid);
  if (i < 0 || j < 0) return;
  const [item] = rooms.splice(i, 1);
  rooms.splice(j, 0, item);
  render();
  persistOrder(rooms);
}

// ---- shared drawing helpers ----------------------------------------------------------------------------------------

function colourTabFor(item) {
  const saved = colourTabs.get(item.entity_id);
  if (saved === 'white' && item.supports?.color_temp) return 'white';
  if (saved === 'color' && item.supports?.color) return 'color';
  if (item.color_mode === 'color_temp' && item.supports?.color_temp) return 'white';
  if (item.color_mode && item.color_mode !== 'color_temp' && item.supports?.color) return 'color';
  return item.supports?.color_temp ? 'white' : 'color';
}

function dotHtml(item) {
  const rgb = liveRgb(item);
  const style = rgb ? ` style="--hc-live:${rgbToHex(rgb)}"` : '';
  return `<span class="hc-dot${item.on ? ' is-on' : ''}" data-hc-dot="${esc(item.entity_id)}"${style} aria-hidden="true"></span>`;
}

function brightBar(item, compact = false) {
  if (!item.supports?.brightness) return '';
  const pct = item.on ? (item.brightness ?? 100) : 0;
  const n = pct / 100;
  return `<div class="hc-barwrap${compact ? ' is-sm' : ''}">
    <div class="hc-sl hc-sl--bright${item.on ? ' is-on' : ''}" role="slider" tabindex="${item.available ? 0 : -1}"
      aria-label="${esc(item.name)} brightness" aria-valuemin="1" aria-valuemax="100" aria-valuenow="${pct}"
      aria-valuetext="${item.on ? `${pct}%` : 'Off'}"
      data-hc-sl="bright" data-hc-eid="${esc(item.entity_id)}" data-min="1" data-max="100" data-step="1"
      style="--v:${n}">
      <span class="hc-sl__track"><span class="hc-sl__fill"></span></span>
      <span class="hc-sl__thumb"></span>
    </div>
    <output class="hc-pct" data-hc-out="bright:${esc(item.entity_id)}">${item.on ? `${pct}%` : 'Off'}</output>
  </div>`;
}

function colourBtnLabel(item) {
  if (item.on && item.color_mode === 'color_temp' && item.color_temp_kelvin) return `${item.color_temp_kelvin} K`;
  if (item.on && item.supports?.color && item.rgb && item.color_mode !== 'color_temp') return 'Colour';
  return item.supports?.color ? 'Colour' : 'White';
}

function roomMetaText(r) {
  const parts = [];
  if (!r.available) return 'Unavailable';
  if (r.on) {
    if (r.color_mode === 'color_temp' && r.color_temp_kelvin) parts.push(`${r.color_temp_kelvin} K`);
    else if (r.supports?.color && r.rgb && r.color_mode !== 'color_temp') parts.push('Colour');
    else if (!r.supports?.color_temp && !r.supports?.color) parts.push('Dimmable');
  } else {
    parts.push(!r.supports?.color_temp && !r.supports?.color ? 'Dimmable only' : 'Off');
  }
  if ((r.lights?.length || 0) > 1) {
    const lit = r.lights.filter(b => b.on).length;
    parts.push(`${lit}/${r.lights.length} lights`);
  }
  if (r.scenes?.length) parts.push(`${r.scenes.length} ${r.scenes.length === 1 ? 'scene' : 'scenes'}`);
  return parts.join(' · ');
}

function colourControls(item) {
  const canTemp = !!item.supports?.color_temp;
  const canRgb = !!item.supports?.color;
  if (!canTemp && !canRgb) return `<p class="hc-quiet">This light supports brightness only.</p>`;
  const mode = colourTabFor(item);
  const lo = item.min_kelvin || 2000, hi = item.max_kelvin || 6500;
  const k = clamp(item.color_temp_kelvin || 3200, lo, hi);
  const kn = hi > lo ? (k - lo) / (hi - lo) : 0.5;
  const hex = rgbToHex(liveRgb(item) || [139, 92, 246]);

  const tabs = canTemp && canRgb
    ? `<div class="hc-seg" role="tablist" aria-label="Light mode">
        <button type="button" role="tab" aria-selected="${mode === 'white'}" data-hc-tab="white" data-hc-eid="${esc(item.entity_id)}">White</button>
        <button type="button" role="tab" aria-selected="${mode === 'color'}" data-hc-tab="color" data-hc-eid="${esc(item.entity_id)}">Colour</button>
      </div>`
    : '';

  let body = '';
  if (mode === 'white' && canTemp) {
    const presets = WHITE_PRESETS.filter(([, val]) => val >= lo - 250 && val <= hi + 250).map(([label, val]) => {
      const target = clamp(val, lo, hi);
      const activePreset = item.on && item.color_mode === 'color_temp' && Math.abs((item.color_temp_kelvin || 0) - target) <= 200;
      const swatch = rgbToHex(kelvinToRgb(target));
      return `<button type="button" class="hc-preset" data-hc-kelvin="${target}" data-hc-eid="${esc(item.entity_id)}" aria-pressed="${activePreset}">
        <span class="hc-swatch-dot" style="--sw:${swatch}"></span><span>${esc(label)}</span></button>`;
    }).join('');
    body = `<div class="hc-presets">${presets}</div>
      <div class="hc-krow">
        <div class="hc-sl hc-sl--kelvin" role="slider" tabindex="0"
          aria-label="${esc(item.name)} white warmth" aria-valuemin="${lo}" aria-valuemax="${hi}" aria-valuenow="${k}" aria-valuetext="${k} K"
          data-hc-sl="kelvin" data-hc-eid="${esc(item.entity_id)}" data-min="${lo}" data-max="${hi}" data-step="50"
          style="--v:${kn}">
          <span class="hc-sl__track"><span class="hc-sl__fill"></span></span>
          <span class="hc-sl__thumb"></span>
        </div>
        <output class="hc-kout" data-hc-out="kelvin:${esc(item.entity_id)}">${k} K</output>
      </div>`;
  } else if (canRgb) {
    const swatches = COLOUR_SWATCHES.map(([label, rgb]) => {
      const swHex = rgbToHex(rgb);
      const isMatch = item.on && item.color_mode !== 'color_temp' && Array.isArray(item.rgb)
        && Math.abs(item.rgb[0] - rgb[0]) + Math.abs(item.rgb[1] - rgb[1]) + Math.abs(item.rgb[2] - rgb[2]) < 45;
      return `<button type="button" class="hc-swchip" data-hc-rgb="${rgb.join(',')}" data-hc-eid="${esc(item.entity_id)}"
        aria-label="${esc(label)}" title="${esc(label)}" aria-pressed="${isMatch}" style="--sw:${swHex}"></button>`;
    }).join('');
    body = `<div class="hc-swatches">${swatches}</div>
      <div class="hc-cfoot">
        <button type="button" class="hc-pill" data-hc-theme-match="${esc(item.entity_id)}">${ico('palette')}<span>Match theme</span></button>
        <label class="hc-pill hc-picker-lbl">
          <input type="color" class="hc-picker" value="${esc(hex)}" data-hc-picker="${esc(item.entity_id)}" aria-label="Custom colour for ${esc(item.name)}">
          <span>Custom colour</span>
        </label>
      </div>`;
  }
  return `${tabs}${body}`;
}

function reorderButtons(r, i, total, isMobile) {
  return `<span class="hc-order" aria-label="Move ${esc(r.name)}">
    <button type="button" class="hc-mv" data-hc-move="-1" data-hc-eid="${esc(r.entity_id)}" ${i === 0 ? 'disabled' : ''}
      aria-label="Move ${esc(r.name)} earlier" title="Move earlier">${ico(isMobile ? 'up' : 'prev')}</button>
    <button type="button" class="hc-mv" data-hc-move="1" data-hc-eid="${esc(r.entity_id)}" ${i === total - 1 ? 'disabled' : ''}
      aria-label="Move ${esc(r.name)} later" title="Move later">${ico(isMobile ? 'down' : 'next')}</button>
  </span>`;
}

// ---- desktop left Configuration Console + right Room Selector Tiles ------------------------------------------------

function desktopRoomCard(r, i, total) {
  const picked = r.entity_id === selectedRoom;
  const ink = INKS[i % INKS.length];
  return `<section class="card hc-card hc-card--desk${r.on ? ' is-on' : ' is-off'}${r.available ? '' : ' is-unavail'}${picked ? ' is-selected' : ''}${reordering ? ' is-reordering' : ''}"
    data-hc-room="${esc(r.id)}" data-hc-select="${esc(r.entity_id)}"${reordering ? ' draggable="true"' : ''}
    style="--lc-c: var(--${ink})"><div class="card__in">
    <div class="card__head">
      ${dotHtml(r)}
      <span class="hud">${esc(r.name)}</span>
      ${reordering
        ? reorderButtons(r, i, total, false)
        : `<button type="button" class="hc-sw" data-hc-toggle="${esc(r.entity_id)}" aria-pressed="${r.on}" aria-label="${esc(r.name)} ${r.on ? 'off' : 'on'}" ${r.available ? '' : 'disabled'}>${r.available ? (r.on ? 'On' : 'Off') : 'Unavailable'}</button>`}
    </div>
    <div class="card__body">
      ${brightBar(r)}
      <div class="hc-meta">
        <span class="hc-meta__info">${esc(roomMetaText(r))}</span>
        ${reordering
          ? `<span class="hc-meta__cue">Drag or move</span>`
          : picked
            ? `<span class="hc-active-badge">Active</span>`
            : `<span class="hc-meta__cue">Configure</span>`}
      </div>
    </div></div></section>`;
}

function desktopInspector(room, roomIndex) {
  if (!room) return '';
  const ink = INKS[roomIndex % INKS.length];
  const multi = (room.lights?.length || 0) > 1;
  const target = findEntity(inspectTarget) || room;
  const isWholeRoom = target.entity_id === room.entity_id;
  const subtitle = multi
    ? (isWholeRoom ? `Controlling all ${room.lights.length} lights in ${room.name}` : `Controlling ${target.name} only`)
    : (room.on ? roomMetaText(room) : 'Room light off');

  const targetBar = multi
    ? `<div class="hc-targets" role="tablist" aria-label="Control target">
        <button type="button" role="tab" aria-selected="${isWholeRoom}" data-hc-target="${esc(room.entity_id)}">All ${esc(room.name)}</button>
        ${room.lights.map(b => `<button type="button" role="tab" aria-selected="${target.entity_id === b.entity_id}" data-hc-target="${esc(b.entity_id)}">${dotHtml(b)}<span>${esc(b.name)}</span></button>`).join('')}
      </div>`
    : '';

  const lightsSection = multi
    ? `<div class="hc-sec">
        <p class="hc-lab">Individual lights</p>
        <div class="hc-children">${room.lights.map(b => {
          const isT = target.entity_id === b.entity_id;
          return `<div class="hc-child${b.on ? '' : ' is-off'}${b.available ? '' : ' is-unavail'}${isT ? ' is-target' : ''}" data-hc-eid="${esc(b.entity_id)}">
            <div class="hc-child__top">
              <button type="button" class="hc-child__pick" data-hc-target="${esc(b.entity_id)}" title="Edit colour for ${esc(b.name)}">
                ${dotHtml(b)}<span class="hc-child__name">${esc(b.name)}</span>
              </button>
              <button type="button" class="hc-sw hc-sw--sm" data-hc-toggle="${esc(b.entity_id)}" aria-pressed="${b.on}" aria-label="${esc(b.name)} ${b.on ? 'off' : 'on'}" ${b.available ? '' : 'disabled'}>${b.on ? 'On' : 'Off'}</button>
            </div>
            ${brightBar(b, true)}
          </div>`;
        }).join('')}</div>
      </div>`
    : '';

  const scenesSection = room.scenes?.length
    ? `<div class="hc-sec">
        <p class="hc-lab">Scenes</p>
        <div class="hc-scenes hc-scenes--insp">${room.scenes.map(sc =>
          `<button type="button" class="hc-scene" data-hc-scene="${esc(sc.entity_id)}" data-hc-sname="${esc(sc.name)}">${esc(sc.name)}</button>`).join('')}</div>
      </div>`
    : '';

  return `<aside class="hc-inspector" aria-label="Room controls">
    <p class="hc-pane-title">Room configuration</p>
    <section class="card hc-panel${target.on ? ' is-on' : ' is-off'}" style="--lc-c: var(--${ink})"><div class="card__in">
      <div class="hc-panel__banner">
        <div class="hc-panel__titlewrap">
          <div class="hc-panel__row">${dotHtml(target)}<h2 class="hc-panel__title">${esc(isWholeRoom ? room.name : target.name)}</h2></div>
          <p class="hc-panel__sub">${esc(subtitle)}</p>
        </div>
        <button type="button" class="hc-sw" data-hc-toggle="${esc(target.entity_id)}" aria-pressed="${target.on}" aria-label="${esc(target.name)} ${target.on ? 'off' : 'on'}" ${target.available ? '' : 'disabled'}>${target.available ? (target.on ? 'On' : 'Off') : 'Unavailable'}</button>
      </div>
      <div class="card__body hc-panel__body">
        ${targetBar}
        <div class="hc-sec">
          <p class="hc-lab">Brightness</p>
          ${brightBar(target)}
        </div>
        <div class="hc-sec">
          <p class="hc-lab">White &amp; colour</p>
          <div class="hc-drawer hc-drawer--open">${colourControls(target)}</div>
        </div>
        ${lightsSection}
        ${scenesSection}
      </div>
    </div></section>
  </aside>`;
}

// ---- mobile cards (inline UX preserved, plus Reorder up/down) ------------------------------------------------------

function mobileChildRow(bulb) {
  const canColour = bulb.supports?.color_temp || bulb.supports?.color;
  const colOpen = openColour === bulb.entity_id;
  return `<div class="hc-child${bulb.on ? '' : ' is-off'}${bulb.available ? '' : ' is-unavail'}" data-hc-eid="${esc(bulb.entity_id)}">
    <div class="hc-child__top">
      ${dotHtml(bulb)}
      <span class="hc-child__name">${esc(bulb.name)}</span>
      ${canColour ? `<button type="button" class="hc-mini" data-hc-col="${esc(bulb.entity_id)}" aria-expanded="${colOpen}" ${bulb.available ? '' : 'disabled'}>${esc(colourBtnLabel(bulb))}</button>` : ''}
      <button type="button" class="hc-sw hc-sw--sm" data-hc-toggle="${esc(bulb.entity_id)}" aria-pressed="${bulb.on}" aria-label="${esc(bulb.name)} ${bulb.on ? 'off' : 'on'}" ${bulb.available ? '' : 'disabled'}>${bulb.on ? 'On' : 'Off'}</button>
    </div>
    ${brightBar(bulb, true)}
    ${colOpen ? `<div class="hc-drawer">${colourControls(bulb)}</div>` : ''}
  </div>`;
}

function mobileRoomCard(r, i, total) {
  const multi = (r.lights?.length || 0) > 1;
  const litCount = multi ? r.lights.filter(b => b.on).length : 0;
  const canColour = r.supports?.color_temp || r.supports?.color;
  const hasScenes = (r.scenes?.length || 0) > 0;
  const colOpen = !reordering && openColour === r.entity_id;
  const lightsOpen = !reordering && multi && openLights.has(r.id);
  const scenesOpen = !reordering && hasScenes && openScenes.has(r.id);

  const actions = reordering ? '' : [
    canColour ? `<button type="button" class="hc-pill" data-hc-col="${esc(r.entity_id)}" aria-expanded="${colOpen}" ${r.available ? '' : 'disabled'}>${ico('palette')}<span>${esc(colourBtnLabel(r))}</span></button>` : '',
    multi ? `<button type="button" class="hc-pill" data-hc-lights="${esc(r.id)}" aria-expanded="${lightsOpen}">${ico('lamp')}<span>${r.lights.length} lights</span></button>` : '',
    hasScenes ? `<button type="button" class="hc-pill" data-hc-scenes="${esc(r.id)}" aria-expanded="${scenesOpen}">${ico('spark')}<span>Scenes</span></button>` : '',
  ].filter(Boolean).join('');

  const scenesHtml = scenesOpen
    ? `<div class="hc-scenes">${r.scenes.map(sc =>
        `<button type="button" class="hc-scene" data-hc-scene="${esc(sc.entity_id)}" data-hc-sname="${esc(sc.name)}">${esc(sc.name)}</button>`).join('')}</div>`
    : '';

  const childrenHtml = lightsOpen
    ? `<div class="hc-children">${r.lights.map(mobileChildRow).join('')}</div>`
    : '';

  return `<section class="card hc-card${r.on ? ' is-on' : ' is-off'}${r.available ? '' : ' is-unavail'}" data-hc-room="${esc(r.id)}" style="--lc-c: var(--${INKS[i % INKS.length]})"><div class="card__in">
    <div class="card__head">
      ${dotHtml(r)}
      <span class="hud">${esc(r.name)}</span>
      ${multi ? `<span class="hc-count">${litCount}/${r.lights.length}</span>` : ''}
      ${reordering
        ? reorderButtons(r, i, total, true)
        : `<button type="button" class="hc-sw" data-hc-toggle="${esc(r.entity_id)}" aria-pressed="${r.on}" aria-label="${esc(r.name)} ${r.on ? 'off' : 'on'}" ${r.available ? '' : 'disabled'}>${r.available ? (r.on ? 'On' : 'Off') : 'Unavailable'}</button>`}
    </div>
    <div class="card__body">
      ${reordering ? '' : brightBar(r)}
      ${actions ? `<div class="hc-acts">${actions}</div>` : ''}
      ${colOpen ? `<div class="hc-drawer">${colourControls(r)}</div>` : ''}
      ${scenesHtml}
      ${childrenHtml}
    </div></div></section>`;
}

// ---- page render ---------------------------------------------------------------------------------------------------

function summaryText(s) {
  if (!s || !s.total) return 'No lights found';
  if (!s.on) return 'All lights off';
  return `${s.on} of ${s.total} ${s.total === 1 ? 'light' : 'lights'} on`;
}

function render() {
  if (!root || !V) return;
  const rooms = V.rooms || [];
  const zones = V.zones || [];
  const s = V.summary || { on: 0, total: 0, rooms_on: 0, rooms_total: 0 };
  const isMobile = phone.matches;

  let body;
  if (V.configured === false) {
    body = `<p class="hc-note">No Home Assistant token on this PC yet.</p>`;
  } else if (!rooms.length && V.available) {
    body = `<p class="hc-note">No lights found in Home Assistant yet.</p>`;
  } else {
    const zoneBar = zones.length
      ? `<div class="hc-zones" aria-label="Zones">${zones.map(z =>
          `<button type="button" class="hc-zone" data-hc-toggle="${esc(z.entity_id)}" aria-pressed="${z.on}" ${z.available ? '' : 'disabled'}>${dotHtml(z)}<span>${esc(z.name)}</span></button>`).join('')}</div>`
      : '';

    const reorderBtn = rooms.length > 1
      ? `<button type="button" class="hc-btn${reordering ? ' is-active' : ''}" data-hc-reorder aria-pressed="${reordering}">${ico(reordering ? 'check' : 'list')}<span>${reordering ? 'Done' : 'Reorder'}</span></button>`
      : '';

    let main;
    if (isMobile) {
      main = `<div class="hc-grid">${rooms.map((r, i) => mobileRoomCard(r, i, rooms.length)).join('')}</div>`;
    } else {
      const selRoom = ensureSelection();
      const selIdx = Math.max(0, rooms.findIndex(r => r.entity_id === selRoom?.entity_id));
      main = `<div class="hc-desk">
        ${desktopInspector(selRoom, selIdx)}
        <div class="hc-rooms-pane">
          <p class="hc-pane-title">Rooms <small>${reordering ? 'drag or use arrows to reorder' : 'pick a room to configure'}</small></p>
          <div class="hc-rooms">${rooms.map((r, i) => desktopRoomCard(r, i, rooms.length)).join('')}</div>
        </div>
      </div>`;
    }

    body = `<div class="hc-top">
      <p class="hc-summary">${esc(summaryText(s))}</p>
      <div class="hc-top__acts">
        ${reorderBtn}
        <button type="button" class="hc-alloff${armedAllOff ? ' is-armed' : ''}" data-hc-alloff ${s.on > 0 && V.available ? '' : 'disabled'}>
          ${ico('stop')}<span>${armedAllOff ? 'Turn all off?' : 'All off'}</span>
        </button>
      </div>
    </div>
    ${zoneBar}
    ${main}`;
  }

  root.innerHTML = `<div class="hc${V.available ? '' : ' is-down'}">
    ${V.available || V.configured === false ? '' : `<p class="hc-down">${ico('alert')}<span>${esc(V.error || "Home Assistant isn't answering")}</span></p>`}
    ${body}</div>`;
}

// ---- events --------------------------------------------------------------------------------------------------------

function onClick(e) {
  if (!V?.available) return;

  const btn = e.target.closest('button');
  if (btn) {
    if (btn.disabled) return;
    if (btn.matches('[data-hc-reorder]')) {
      reordering = !reordering;
      render();
      return;
    }
    if (btn.matches('[data-hc-move]')) {
      moveRoom(btn.dataset.hcEid, Number(btn.dataset.hcMove));
      return;
    }
    if (btn.matches('[data-hc-toggle]')) {
      const eid = btn.dataset.hcToggle;
      const item = findEntity(eid);
      if (!item) return;
      sendLight(eid, { on: !item.on, transition: 0.2 });
      return;
    }
    if (btn.matches('[data-hc-target]')) {
      inspectTarget = btn.dataset.hcTarget;
      render();
      return;
    }
    if (btn.matches('[data-hc-col]')) {
      const eid = btn.dataset.hcCol;
      openColour = openColour === eid ? null : eid;
      render();
      return;
    }
    if (btn.matches('[data-hc-lights]')) {
      const rid = btn.dataset.hcLights;
      if (openLights.has(rid)) openLights.delete(rid); else openLights.add(rid);
      render();
      return;
    }
    if (btn.matches('[data-hc-scenes]')) {
      const rid = btn.dataset.hcScenes;
      if (openScenes.has(rid)) openScenes.delete(rid); else openScenes.add(rid);
      render();
      return;
    }
    if (btn.matches('[data-hc-tab]')) {
      colourTabs.set(btn.dataset.hcEid, btn.dataset.hcTab);
      render();
      return;
    }
    if (btn.matches('[data-hc-kelvin]')) {
      const eid = btn.dataset.hcEid, kelvin = +btn.dataset.hcKelvin;
      sendLight(eid, { kelvin, transition: 0.25 });
      return;
    }
    if (btn.matches('[data-hc-rgb]')) {
      const eid = btn.dataset.hcEid, rgb = btn.dataset.hcRgb.split(',').map(Number);
      sendLight(eid, { rgb, transition: 0.25 });
      return;
    }
    if (btn.matches('[data-hc-theme-match]')) {
      const eid = btn.dataset.hcThemeMatch;
      sendLight(eid, { rgb: themeAccentRgb(), transition: 0.25 });
      return;
    }
    if (btn.matches('[data-hc-scene]')) {
      sendScene(btn.dataset.hcScene, btn.dataset.hcSname || 'Scene');
      return;
    }
    if (btn.matches('[data-hc-alloff]')) {
      clearTimeout(armTimer);
      if (!armedAllOff) {
        armedAllOff = true;
        render();
        armTimer = setTimeout(() => { armedAllOff = false; render(); }, 4000);
        return;
      }
      armedAllOff = false;
      sendAllOff();
      return;
    }
  }

  // Desktop: clicking anywhere else on a room tile selects it in the left Configuration Console.
  if (!phone.matches && !reordering && !e.target.closest('[data-hc-sl], label, input')) {
    const card = e.target.closest('[data-hc-select]');
    if (card) {
      const eid = card.dataset.hcSelect;
      if (selectedRoom !== eid) {
        selectedRoom = eid;
        inspectTarget = eid;
        render();
      }
    }
  }
}

function onInput(e) {
  const picker = e.target.closest('[data-hc-picker]');
  if (!picker || !V?.available) return;
  const eid = picker.dataset.hcPicker, rgb = hexToRgb(picker.value);
  if (!rgb) return;
  applyLocal(eid, { rgb });
  root.querySelectorAll(`[data-hc-dot="${CSS.escape(eid)}"]`).forEach(d => {
    d.classList.add('is-on');
    d.style.setProperty('--hc-live', picker.value);
  });
  sendSoon(`rgb:${eid}`, () => sendLight(eid, { rgb, transition: 0.1 }, { redraw: false, settle: false }));
}

function onChange(e) {
  const picker = e.target.closest('[data-hc-picker]');
  if (!picker || !V?.available) return;
  const eid = picker.dataset.hcPicker, rgb = hexToRgb(picker.value);
  if (!rgb) return;
  sendLight(eid, { rgb, transition: 0.2 }, { redraw: !colourBusy() });
}

// ---- desktop drag-and-drop reordering ------------------------------------------------------------------------------

function onDragStart(e) {
  if (!reordering) return;
  const card = e.target.closest('[data-hc-select]');
  if (!card) return;
  dragRoomEid = card.dataset.hcSelect;
  card.classList.add('is-dragging');
  e.dataTransfer?.setData('text/plain', dragRoomEid);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}

function onDragOver(e) {
  if (!reordering || !dragRoomEid) return;
  const card = e.target.closest('[data-hc-select]');
  if (!card || card.dataset.hcSelect === dragRoomEid) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  root.querySelectorAll('.hc-card.is-drop').forEach(c => { if (c !== card) c.classList.remove('is-drop'); });
  card.classList.add('is-drop');
}

function onDragLeave(e) {
  const card = e.target.closest('[data-hc-select]');
  if (card && !card.contains(e.relatedTarget)) card.classList.remove('is-drop');
}

function onDrop(e) {
  if (!reordering || !dragRoomEid) return;
  const card = e.target.closest('[data-hc-select]');
  if (!card) return;
  e.preventDefault();
  const targetEid = card.dataset.hcSelect;
  const fromEid = dragRoomEid;
  dragRoomEid = null;
  moveRoomTo(fromEid, targetEid);
}

function onDragEnd() {
  dragRoomEid = null;
  root.querySelectorAll('.hc-card.is-dragging, .hc-card.is-drop').forEach(c => c.classList.remove('is-dragging', 'is-drop'));
}

// ---- touch & pointer sliders ---------------------------------------------------------------------------------------

function sliderValueAt(el, ev) {
  const track = $('.hc-sl__track', el).getBoundingClientRect();
  const min = +el.dataset.min, max = +el.dataset.max, step = +el.dataset.step || 1;
  const n = clamp((ev.clientX - track.left) / Math.max(1, track.width), 0, 1);
  const raw = min + n * (max - min);
  return clamp(Math.round(raw / step) * step, min, max);
}

function applySliderVisual(el, v) {
  const kind = el.dataset.hcSl, eid = el.dataset.hcEid;
  const min = +el.dataset.min, max = +el.dataset.max;
  const n = max > min ? (v - min) / (max - min) : 0;
  root.querySelectorAll(`[data-hc-sl="${kind}"][data-hc-eid="${CSS.escape(eid)}"]`).forEach(s => {
    s.style.setProperty('--v', n);
    s.classList.add('is-on');
    s.setAttribute('aria-valuenow', v);
    s.setAttribute('aria-valuetext', kind === 'bright' ? `${v}%` : `${v} K`);
  });
  root.querySelectorAll(`[data-hc-out="${CSS.escape(`${kind}:${eid}`)}"]`).forEach(o => {
    o.textContent = kind === 'bright' ? `${v}%` : `${v} K`;
  });
  if (kind === 'bright') {
    applyLocal(eid, { brightness: v });
    el.closest('.hc-card, .hc-child')?.classList.remove('is-off');
    el.closest('.hc-card')?.classList.add('is-on');
  } else {
    applyLocal(eid, { kelvin: v });
    const hex = rgbToHex(kelvinToRgb(v));
    root.querySelectorAll(`[data-hc-dot="${CSS.escape(eid)}"]`).forEach(d => {
      d.classList.add('is-on');
      d.style.setProperty('--hc-live', hex);
    });
  }
}

function commitSlider(kind, eid, v, final = false) {
  // Zero transition while dragging so Hue tracks your finger/mouse cleanly without fading behind.
  const body = kind === 'bright'
    ? { brightness: v, transition: final ? 0.15 : 0 }
    : { kelvin: v, transition: final ? 0.15 : 0 };
  if (final) {
    const t = throttle.get(`${kind}:${eid}`);
    if (t?.timer) { clearTimeout(t.timer); t.timer = 0; }
    sendLight(eid, body, { redraw: true, settle: true });
  } else {
    sendSoon(`${kind}:${eid}`, () => sendLight(eid, body, { redraw: false, settle: false }));
  }
}

function onPointerDown(e) {
  if (reordering) return;
  const el = e.target.closest('[data-hc-sl]');
  if (!el || !V?.available || el.closest('.is-unavail')) return;
  e.preventDefault();
  el.focus({ preventScroll: true });
  el.setPointerCapture?.(e.pointerId);
  const kind = el.dataset.hcSl, eid = el.dataset.hcEid;
  const v = sliderValueAt(el, e);
  drag = { el, id: e.pointerId, kind, eid, lastVal: v };
  applySliderVisual(el, v);
  commitSlider(kind, eid, v, false);
}

function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const v = sliderValueAt(drag.el, e);
  if (v === drag.lastVal) return;
  drag.lastVal = v;
  applySliderVisual(drag.el, v);
  commitSlider(drag.kind, drag.eid, v, false);
}

function onPointerUp(e) {
  if (!drag || (e && e.pointerId !== drag.id)) return;
  const { kind, eid, lastVal } = drag;
  drag = null;
  commitSlider(kind, eid, lastVal, true);
}

function onKeyDown(e) {
  const el = e.target.closest('[data-hc-sl]');
  if (!el || !V?.available) return;
  const kind = el.dataset.hcSl, eid = el.dataset.hcEid;
  const min = +el.dataset.min, max = +el.dataset.max, step = +el.dataset.step || 1;
  const cur = Number(el.getAttribute('aria-valuenow')) || min;
  const delta = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: step * 10, PageDown: -step * 10 }[e.key];
  let next;
  if (delta) next = clamp(cur + delta, min, max);
  else if (e.key === 'Home') next = min;
  else if (e.key === 'End') next = max;
  else return;
  e.preventDefault();
  applySliderVisual(el, next);
  commitSlider(kind, eid, next, true);
}
