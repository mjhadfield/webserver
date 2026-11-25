// The header's GoXLR volume buttons (app/volume.py): Line out and Vinyl, each a small upright slider of a button.
// The button fills from the bottom to the slider's position; drag up or down on it to set the level, or use the wheel.
// A click drops the full slider under it (one piece with the button, like Bookmarks), Mute at its foot.
// Line out's slider is curved like its old desktop widget: position p ↔ volume 100·(p/100)^(1/curve), the readout
// shows the volume. Both channels start muted after each boot (the server does that).
import * as api from './api.js';
import { $, esc, ico, toast } from './util.js';

const group = $('#vol-group'), bar = $('#vol-bar'), rail = $('.rail');
if (group && bar) init();

function init() {
  const ICON = { lineout: 'vol', vinyl: 'disc' };
  const DRAG_PX = 2;                        // button drag: screen pixels per 1 % of slider travel
  let chans = [], openId = null, drag = null, suppressClick = false;
  const sending = new Map();                // id -> { want, busy }
  let sent = 0;                             // changes sent so far: a re-read begun before the latest is out of date

  async function refresh() {
    const at = sent;
    let v;
    try { v = await api.get('/api/owner/volume'); } catch { group.hidden = true; close(true); return; }
    // a Mute or a new level went out while this was on its way (e.g. the re-read Opening starts): it can only hold the
    // old level, and drawing it flipped the button back until the change's own answer came in. That answer redraws.
    if (at === sent) apply(v);
  }

  const clamp = p => Math.max(0, Math.min(100, p));
  const posOf = c => (c.volume == null ? 0 : clamp(Math.round(100 * Math.pow(c.volume / 100, c.curve))));
  const volOf = (c, p) => clamp(Math.round(100 * Math.pow(clamp(p) / 100, 1 / c.curve)));
  const byId = id => chans.find(c => c.id === id);
  const label = c => `${c.name} · ${c.volume == null ? 'not answering' : c.muted ? 'muted' : `${c.volume}%`}`;

  function apply(v) {
    group.hidden = !v.configured;
    if (!v.configured) { close(true); return; }
    chans = v.channels.map(c => {
      const old = byId(c.id), mine = drag?.id === c.id;
      return { ...c, available: v.available, pos: mine && old ? old.pos : posOf(c), volume: mine && old ? old.volume : c.volume, muted: mine && old ? old.muted : c.muted };
    });
    if (!group.children.length || group.dataset.ids !== chans.map(c => c.id).join()) {
      group.dataset.ids = chans.map(c => c.id).join();
      group.innerHTML = chans.map(c => `<button class="btn vol-btn" type="button" data-vol="${esc(c.id)}" aria-haspopup="true" aria-expanded="false" aria-controls="vol-bar"><span class="vol-btn__fill"></span>${ico(ICON[c.id] || 'vol')}</button>`).join('');
    }
    chans.forEach(draw);
  }
  function draw(c) {
    const btn = group.querySelector(`[data-vol="${c.id}"]`);
    if (!btn) return;
    btn.style.setProperty('--vol', `${c.muted ? 0 : c.pos}%`);
    btn.classList.toggle('is-muted', !!c.muted);
    btn.disabled = !c.available;
    btn.title = label(c);
    btn.setAttribute('aria-label', label(c));
    if (openId === c.id) drawBar(c);
  }
  function drawBar(c) {
    const at = c.muted ? 0 : c.pos;
    bar.style.setProperty('--vol', `${at}%`);
    bar.style.setProperty('--vol-n', String(at / 100));
    bar.classList.toggle('is-muted', !!c.muted);
    $('.volbar__pct', bar).textContent = c.muted ? 'Mute' : `${c.volume}%`;
    const t = $('.volbar__track', bar);
    t.setAttribute('aria-valuenow', String(at));
    t.setAttribute('aria-valuetext', c.muted ? 'muted' : `${c.volume}%`);
    const m = $('.volbar__mute', bar);
    m.innerHTML = ico(c.muted ? 'mute' : 'vol');
    m.setAttribute('aria-label', c.muted ? `Unmute ${c.name}` : `Mute ${c.name}`);
    m.title = c.muted ? 'Unmute' : 'Mute';
    m.setAttribute('aria-pressed', String(!!c.muted));
  }

  // ---- talking to the server: the newest level wins, one request at a time per channel ----
  function setPos(c, p) {
    c.pos = clamp(Math.round(p));
    c.volume = volOf(c, c.pos);
    c.muted = c.volume === 0;
    draw(c);
    send(c.id, { volume: c.volume });
  }
  function send(id, body) {
    const s = sending.get(id) || { want: null, busy: false };
    sending.set(id, s);
    s.want = body;
    sent++;
    if (!s.busy) pump(id, s);
  }
  async function pump(id, s) {
    s.busy = true;
    while (s.want) {
      const body = s.want;
      s.want = null;
      try {
        const v = await api.put(`/api/owner/volume/${id}${'muted' in body ? '/mute' : ''}`, body);
        if (!s.want) apply(v);
      } catch (e) { toast(e.message); s.want = null; refresh(); }
    }
    s.busy = false;
  }

  // ---- the drop-down slider ----
  const zoom = () => rail ? (rail.getBoundingClientRect().width / parseFloat(getComputedStyle(rail).width) || 1) : 1;
  function place() {
    const btn = openId && group.querySelector(`[data-vol="${openId}"]`);
    if (!btn || bar.hidden) return;
    const z = zoom(), b = btn.getBoundingClientRect(), m = bar.offsetParent.getBoundingClientRect();
    bar.style.setProperty('--bm-top', `${(b.bottom - m.top) / z}px`);
    bar.style.setProperty('--bm-left', `${(b.left - m.left) / z}px`);
    bar.style.setProperty('--bm-w', `${b.width / z}px`);
  }
  function open(id) {
    const c = byId(id);
    if (!c) return;
    close(true);
    openId = id;
    bar.innerHTML = `<span class="volbar__pct"></span>`
      + `<div class="volbar__track" role="slider" tabindex="0" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(c.name)}"><span class="volbar__rail"><span class="volbar__fill"></span></span><span class="volbar__thumb"></span></div>`
      + `<button class="volbar__mute" type="button"></button>`;
    group.querySelector(`[data-vol="${id}"]`)?.setAttribute('aria-expanded', 'true');
    bar.classList.remove('is-opening', 'is-closing');
    bar.hidden = false;
    drawBar(c);
    place();
    void bar.offsetWidth;
    bar.classList.add('is-opening');
    $('.volbar__track', bar).focus({ preventScroll: true });
    refresh();                              // the desktop widgets or the GoXLR app may have moved it meanwhile
  }
  function close(now = false) {
    if (openId == null) return;
    group.querySelector(`[data-vol="${openId}"]`)?.setAttribute('aria-expanded', 'false');
    openId = null;
    bar.classList.remove('is-opening', 'is-closing');
    if (now || matchMedia('(prefers-reduced-motion: reduce)').matches) { bar.hidden = true; return; }
    bar.classList.add('is-closing');
    bar.addEventListener('animationend', () => { if (bar.classList.contains('is-closing')) { bar.hidden = true; bar.classList.remove('is-closing'); } }, { once: true });
  }

  // ---- the button: drag up/down sets the level, a plain click opens the slider ----
  group.addEventListener('pointerdown', e => {
    const btn = e.target.closest('.vol-btn');
    if (!btn || btn.disabled || e.button !== 0) return;
    const c = byId(btn.dataset.vol);
    drag = { id: c.id, el: btn, y: e.clientY, from: c.muted ? 0 : c.pos, moved: false, where: 'btn' };
    btn.setPointerCapture(e.pointerId);
  });
  group.addEventListener('click', e => {
    const btn = e.target.closest('.vol-btn');
    if (!btn) return;
    if (suppressClick) { suppressClick = false; return; }
    openId === btn.dataset.vol ? close() : open(btn.dataset.vol);
  });

  // ---- the slider: press, drag, keys ----
  const trackPos = (t, y) => { const r = $('.volbar__rail', t).getBoundingClientRect(); return (r.bottom - y) / r.height * 100; };
  bar.addEventListener('pointerdown', e => {
    const t = e.target.closest('.volbar__track');
    if (!t || e.button !== 0) return;
    const c = byId(openId);
    drag = { id: c.id, el: t, where: 'track' };
    t.setPointerCapture(e.pointerId);
    setPos(c, trackPos(t, e.clientY));
  });
  bar.addEventListener('click', e => {
    if (!e.target.closest('.volbar__mute')) return;
    const c = byId(openId);
    c.muted = !c.muted;
    if (!c.muted) { c.volume = c.restore; c.pos = posOf(c); }
    draw(c);
    send(c.id, { muted: c.muted });
  });
  bar.addEventListener('keydown', e => {
    if (!e.target.closest('.volbar__track')) return;
    const c = byId(openId), at = c.muted ? 0 : c.pos;
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (step != null) setPos(c, at + step);
    else if (e.key === 'Home') setPos(c, 0);
    else if (e.key === 'End') setPos(c, 100);
    else return;
    e.preventDefault();
  });

  addEventListener('pointermove', e => {
    if (!drag) return;
    const c = byId(drag.id);
    if (!c) return;
    if (drag.where === 'track') { setPos(c, trackPos(drag.el, e.clientY)); return; }
    const dy = drag.y - e.clientY;
    if (!drag.moved && Math.abs(dy) < 4) return;
    drag.moved = true;
    setPos(c, drag.from + dy / DRAG_PX);
  });
  const endDrag = () => {
    if (!drag) return;
    if (drag.moved) suppressClick = true;   // the click that follows the drag doesn't open the slider
    drag = null;
  };
  addEventListener('pointerup', endDrag);
  addEventListener('pointercancel', endDrag);

  // the wheel nudges whichever one it's over (button or slider)
  const onWheel = e => {
    const id = e.target.closest('.vol-btn')?.dataset.vol || (e.target.closest('#vol-bar') && openId);
    const c = id && byId(id);
    if (!c || !c.available) return;
    e.preventDefault();
    setPos(c, (c.muted ? 0 : c.pos) + (e.deltaY < 0 ? 2 : -2));
  };
  group.addEventListener('wheel', onWheel, { passive: false });
  bar.addEventListener('wheel', onWheel, { passive: false });

  // a click anywhere else, or Escape, puts the slider away
  // (by the event's path: Mute redraws its icon during the click, so the target may no longer be in the page)
  document.addEventListener('click', e => { if (openId && !e.composedPath().some(n => n === bar || n === group)) close(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !openId) return;
    const id = openId;
    close();
    group.querySelector(`[data-vol="${id}"]`)?.focus();
  });
  addEventListener('resize', place);

  // kept fresh: a change from any device, a tab coming back, and now and then for the desktop widgets / GoXLR app
  api.subscribe(() => { if (!drag) refresh(); }, ok => { if (ok) refresh(); }, '/api/owner/events', ['volume']);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden && !drag) refresh(); }, 30_000);
  refresh();
}
