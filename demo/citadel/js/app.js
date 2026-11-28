// Owner dashboard bootstrap: load state, render cards, keep them fresh from the event stream.
import * as api from './api.js';
import { cards, ui, selectedSlug } from './cards.js';
import { vinylUi } from './content-cards.js';
import { Shell } from './shell.js';
import { $, $$, esc, gcalUrl, hostUrl, ico, safeUrl, tickClock, tickUptimes, toast } from './util.js';
import { THEMES, currentLook, currentLookV1, currentTheme, family, mode, setMode, setStyle, setTheme, style, stylesForFamily, syncStyles, theme } from './theme.js';
import * as music from './music.js';
import * as news from './news.js';
import * as stats from './stats.js';
import * as audio from './audio.js';
import * as controls from './controls.js';
import * as routines from './routines.js';
import * as schedule from './schedule.js';
import * as padd from './padd.js';
import * as motion from './motion.js';
import './volume.js';                      // the header's GoXLR volume buttons (Line out, Vinyl)

let state = null;
const shell = new Shell($('#grid'), cards, id => renderCard(id));
const defs = new Map(cards.map(c => [c.id, c]));

// The Monitoring tile's data lives here, not on `state` — `state` gets wholesale replaced by every unrelated
// dashboard refresh (any widget's own refresh notifies over SSE and triggers a full re-fetch; the System
// widget alone does this every 30s), which was wiping `state.monitoring` and flashing "Reading sensors…"
// each time, even though the tile's own 1s-fresh data was perfectly fine. Keeping it in its own variable and
// merging it in at render time means it survives every one of those reloads untouched.
let monitoring = null;
// The other machines (app/machines.py) change every 30 s server-side: fetched on every 15th 2 s tick and when Monitoring opens.
let machines = null, monTicks = 0;
async function pollMachines() {
  try { machines = (await api.get('/api/owner/machines')).machines; } catch { /* keep the last list */ }
  if (monVisible()) renderCard('monitoring');
}

function renderCard(id) {
  if (!state) return;
  if (id === 'monitoring') { shell.update(id, defs.get(id).render({ ...state, monitoring, machines }, shell.ctx(id))); return; }
  shell.update(id, defs.get(id).render(state, shell.ctx(id)), { fresh: freshData });
  if (id === 'vinyl') {
    // Shell's own expand/collapse (#apply) already hides .maxbar (filters + search) on the small tile and
    // un-hides it once expanded — that has to be reasserted here too, not just left to Shell, because
    // Confirmed Pre-orders has no filtering of its own and must stay hidden even when expanded.
    const card = $('#vinyl');
    const maxbar = $('.maxbar', card);
    if (maxbar) maxbar.hidden = vinylUi.mode === 'preorders' || !card.classList.contains('is-max');
  }
  if (id === 'now') tickClock();
}

// The reminder strip. ✕ hides that one reminder everywhere (TVs too) — its key names one occurrence, so next
// week's bin or the next race still shows — and leaves a few seconds of "Undo" in its place. The server sends them
// most urgent first; past ALERTS_SHOWN the rest fold behind "+N more" so the fixed 1440p grid isn't pushed down.
const ALERTS_SHOWN = 6;
// Phones: the reminders fold into a drawer behind the Citadel logo in the header (which shows how many there are),
// on every page. placeLcars moves the strip into the header for it; it opens on a tap and closes on a tap elsewhere,
// or once the last one is dismissed. Reminders still only go when dismissed.
const phone = matchMedia('(max-width: 760px)');
function alertsDrawer(on) {
  const strip = $('#alerts');
  on = (on ?? !strip.classList.contains('is-open')) && phone.matches && strip.childElementCount > 0;
  strip.classList.toggle('is-open', on);
  $('[data-alerts-toggle]').setAttribute('aria-expanded', String(on));
}
const UNDO_MS = 6000;
let alertsOpen = false;
const undoable = new Map();                           // key -> { title, timer }
const rechecking = new Map();                         // alert key -> the widget's sync stamp when Recheck was pressed
const syncStamp = id => { const w = state.widgets?.[id]; return w ? `${w.fetched_at}|${w.error_at}` : ''; };

function alertHtml(a) {
  const title = a.href ? `<a href="${esc(safeUrl(a.href))}" target="_blank" rel="noopener">${esc(a.title)}</a>` : esc(a.title);
  const done = a.done || 'Dismiss';
  return `<div class="alert alert--${esc(a.level)} cut">${ico(a.icon)}
    <span class="alert__text"><b>${title}</b> — ${esc(a.detail)}</span>
    <span class="chip ${a.level === 'now' ? 'chip--today' : a.level === 'info' ? 'chip--fresh' : 'chip--new'} alert__when">${esc(a.chip)}</span>
    ${a.action ? `<button class="btn alert__act" type="button" data-alert-action="${esc(a.key)}"${rechecking.has(a.key) ? ' disabled>Checking…' : `>${esc(a.action.label)}`}</button>` : ''}
    ${a.key ? `<button class="btn btn--icon alert__x" type="button" data-alert-dismiss="${esc(a.key)}" aria-label="${esc(done)}: ${esc(a.title)}" title="${esc(done)}">${ico(a.done ? 'check' : 'x')}</button>` : ''}</div>`;
}

function renderAlerts() {
  for (const [key, stamp] of rechecking) {                // the sync finished (or the alert went): the button comes back
    const a = state.alerts.find(x => x.key === key);
    if (!a || syncStamp(a.action.widget) !== stamp) rechecking.delete(key);
  }
  const list = state.alerts.filter(a => !undoable.has(a.key));
  const folded = !alertsOpen && list.length > ALERTS_SHOWN ? list.length - (ALERTS_SHOWN - 1) : 0;
  const shown = folded ? list.slice(0, ALERTS_SHOWN - 1) : list;
  const undo = [...undoable].map(([key, u]) => `<div class="alert alert--undo cut"><span class="alert__text">Dismissed <b>${esc(u.title)}</b></span>
    <button class="btn" type="button" data-alert-restore="${esc(key)}">Undo</button></div>`);
  const more = folded ? `<button class="btn alerts__more" type="button" data-alerts-more aria-expanded="false">+${folded} more</button>`
    : alertsOpen && list.length > ALERTS_SHOWN ? '<button class="btn alerts__more" type="button" data-alerts-more aria-expanded="true">Show fewer</button>' : '';
  // Only redraw when something changed: a rebuild restarts the reminders' animations (LCARS draws them in on boot, and
  // a routine refresh mid-boot made them draw in twice), and it would lose hover and focus anyway.
  const count = $('#alerts-count');
  count.textContent = list.length;
  count.hidden = !list.length;
  const html = [...undo, ...shown.map(alertHtml), more].join('');
  if (html === alertsHtml) return;
  alertsHtml = html;
  $('#alerts').innerHTML = html;
  if (!html) alertsDrawer(false);
}
let alertsHtml = null;

async function dismissAlert(key) {
  const a = state.alerts.find(x => x.key === key);
  if (!a) return;
  // LCARS: the reminder shrinks away first (lcars.css .is-going); the timeout covers reduced motion, where no animation runs
  const el = $(`[data-alert-dismiss="${CSS.escape(key)}"]`)?.closest('.alert');
  if (el && family() === 'lcars') {
    el.classList.add('is-going');
    await new Promise(done => { el.addEventListener('animationend', done, { once: true }); setTimeout(done, 400); });
  }
  undoable.set(key, { title: a.title, timer: setTimeout(() => { undoable.delete(key); state.alerts = state.alerts.filter(x => x.key !== key); renderAlerts(); }, UNDO_MS) });
  renderAlerts();
  try { await api.post('/api/owner/alerts/dismiss', { key }); }
  catch (err) { clearTimeout(undoable.get(key)?.timer); undoable.delete(key); renderAlerts(); toast(`Couldn't dismiss: ${err.message}`); }
}

async function alertAction(key) {
  const a = state.alerts.find(x => x.key === key);
  if (!a?.action || rechecking.has(key)) return;
  rechecking.set(key, syncStamp(a.action.widget));
  renderAlerts();
  try { await api.post(`/api/owner/widgets/${encodeURIComponent(a.action.widget)}/refresh`); }
  catch (err) { rechecking.delete(key); renderAlerts(); toast(`Couldn't recheck: ${err.message}`); }
}

async function restoreAlert(key) {
  clearTimeout(undoable.get(key)?.timer);
  undoable.delete(key);
  try { await api.post('/api/owner/alerts/restore', { key }); }
  catch (err) { toast(`Couldn't undo: ${err.message}`); }
  await load();
}

// On a desktop wallpaper (?wall: an always-behind Brave window whose KWin rule forbids fullscreen) framed pages may
// not ask for fullscreen. Brave would blow the frame up to fill the window, never get KWin's go-ahead, and stay stuck
// there until a reload (Jellyfin's fullscreen button did this, 2026-11-23). The permission has to go before any
// frame loads, which holds because every frame's src is set later by script.
if (new URLSearchParams(location.search).has('wall')) {
  for (const f of document.querySelectorAll('iframe')) {
    f.removeAttribute('allowfullscreen');
    const allow = (f.getAttribute('allow') || '').split(';').map(s => s.trim()).filter(s => s && s !== 'fullscreen');
    f.setAttribute('allow', [...allow, "fullscreen 'none'"].join('; '));
  }
  // Gaming's wallpaper runs in a Brave profile of its own, without Mike's logins, so its new-window links (Bookmarks,
  // tiles, news) open as tabs in his own Brave instead: the hub runs `brave <url>` on this PC (Mike, 2026-11-23). Only a
  // page on this PC itself may (NZXT's wallpaper keeps its own windows), so ask once first. Links inside framed apps
  // belong to their own pages and still open in the wallpaper's profile.
  api.get('/api/owner/browser').then(({ here }) => {
    if (!here) return;
    const handOver = e => {
      if (e.type === 'auxclick' && e.button !== 1) return;
      const a = e.target.closest?.('a[target="_blank"][href]');
      if (!a || !/^https?:$/.test(a.protocol)) return;
      e.preventDefault();
      api.post('/api/owner/browser/open', { url: a.href }).catch(err => toast(`Couldn't open it in Brave: ${err.message}`));
    };
    document.addEventListener('click', handOver, true);
    document.addEventListener('auxclick', handOver, true);
  }).catch(() => {});
}

// The Media page's iframe is created once in the HTML and its src is set exactly once, here — never
// reassigned on later state refreshes, so navigating away and back never reloads (and never loses the
// session/playback state of) whatever's embedded there.
const mediaFrame = $('#media-frame');
let mediaSrcSet = false;
function setMediaSrc() {
  if (mediaSrcSet) return;
  const link = state.links.find(l => l.for_media);
  if (!link) return;
  mediaFrame.src = link.url;
  mediaSrcSet = true;
}

// Same "set once" idea as setMediaSrc(), a separate latch so the two iframes never interfere with each other.
// Music Companion reads its initial theme off this query param (it has no other way to know Citadel's
// current theme before its own first paint); live theme changes after this point go via postMessage
// instead (tellFrames, on every 'theme:change'), since the iframe's src is never reassigned.
const musicFrame = $('#music-frame');
let MUSIC_ORIGIN = 'https://mjhadfield.github.io';
let musicSrcSet = false;

/** Where an embedded page comes from: a link marked for it, or a project marked for it (Settings → Projects), so
 * an app doesn't have to be a Launchpad link just to be embedded. A project's address may say {host}. */
function pageUrl(flag) {
  const link = state.links.find(l => l[flag]);
  if (link) return link.url;
  const proj = state.projects.find(p => p[flag] && p.url);
  // {host} becomes the PC's network address, not whatever Citadel was opened as (e.g. localhost): the CSP's
  // frame-src, and the embedded pages' own check of who is messaging them, are both keyed to that address.
  return proj ? hostUrl(proj.url.replace('{host}', state.ip || location.hostname)) : null;
}
function setMusicSrc() {
  if (musicSrcSet) return;
  const url = pageUrl('for_music');
  if (!url) return;
  const sep = url.includes('?') ? '&' : '?';
  musicFrame.src = `${url}${sep}citadel_mode=${mode()}&citadel_theme=${theme()}`;
  try { MUSIC_ORIGIN = new URL(url).origin; } catch { /* keep the default */ }
  musicSrcSet = true;
}

// Same "set once" idea again, for the SQL DB page's iframe (Music DB Explorer).
const sqlFrame = $('#sql-frame');
let sqlSrcSet = false, sqlOrigin = null;

// The embedded pages follow Citadel's theme, custom colours and background included (Odysseus: light/dark only):
// told on every load of theirs (the ?theme= param alone can't carry a custom theme) and on every change here.
// Companion's gear button opens Music Maintenance inside that same frame, a different origin (its own project),
// so the Companion frame is told at both; the browser drops whichever doesn't match the page it's showing.
function maintenanceOrigin() {
  const proj = state?.projects.find(p => p.slug === 'music-maintenance' && p.url);
  try { return proj ? new URL(hostUrl(proj.url.replace('{host}', state.ip || location.hostname))).origin : null; } catch { return null; }
}
function tellFrames() {
  const v2 = currentLook();
  const postV2 = (frame, origin) => {
    if (!origin) return;
    frame.contentWindow?.postMessage(v2, origin);
  };
  if (musicSrcSet) {
    postV2(musicFrame, MUSIC_ORIGIN);
    postV2(musicFrame, maintenanceOrigin());
  }
  if (sqlSrcSet) postV2(sqlFrame, sqlOrigin);
  // Odysseus stays on contract v1 permanently (Mike, 2026-11-23).
  if (aiSrcSet && aiOrigin) aiFrame.contentWindow?.postMessage(currentLookV1(), aiOrigin);
  if (houseSrcSet) postV2(houseFrame, houseOrigin);
  if (labelsSrcSet) postV2(labelsFrame, labelsOrigin);
  if (holodeckSrcSet) postV2(holodeckFrame, holodeckOrigin);
  if (labSrcSet) postV2(labFrame, labOrigin);
  if (curateSrcSet) postV2(curateFrame, maintenanceOrigin());
}
musicFrame.addEventListener('load', tellFrames);

// The Curate page: Music Maintenance (Music Companion's maintenance tool, the `music-maintenance` project) in its own
// frame, set once like the others. It's already made to sit inside Citadel: it takes the theme from ?theme= and then
// tellFrames, and the CSP's frame-src lists it. Not LCARS-styled; it keeps its own look in Citadel's colours.
const curateFrame = $('#curate-frame');
let curateSrcSet = false;
function setCurateSrc() {
  if (curateSrcSet) return;
  const origin = maintenanceOrigin();
  if (!origin) return;
  curateFrame.src = `${origin}/?citadel_mode=${mode()}&citadel_theme=${theme()}`;
  curateSrcSet = true;
}
curateFrame.addEventListener('load', tellFrames);
sqlFrame.addEventListener('load', tellFrames);
function setSqlSrc() {
  if (sqlSrcSet) return;
  const url = pageUrl('for_sql');
  if (!url) return;
  const sep = url.includes('?') ? '&' : '?';
  sqlFrame.src = `${url}${sep}citadel_mode=${mode()}&citadel_theme=${theme()}`;
  try { sqlOrigin = new URL(url).origin; } catch { sqlOrigin = null; }
  sqlSrcSet = true;
}

// Same "set once" latch again, for the Odysseus page (a link only). Odysseus follows Citadel's light/dark mode
// too, but only the base mode: it swaps between its own "Citadel" and "Citadel Dark" themes (a local patch on
// its `local` branch, static/js/theme.js), so it reads ?citadel_theme= and the same message as the other frames.
const aiFrame = $('#ai-frame');
let aiSrcSet = false, aiOrigin = null;
function setAiSrc() {
  if (aiSrcSet) return;
  const link = state.links.find(l => l.for_ai);
  if (!link) return;
  const sep = link.url.includes('?') ? '&' : '?';
  aiFrame.src = `${link.url}${sep}citadel_theme=${currentTheme()}`;
  try { aiOrigin = new URL(link.url).origin; } catch { aiOrigin = null; }
  aiSrcSet = true;
}
aiFrame.addEventListener('load', tellFrames);

// And for the House page (Home Improvements, a link). It follows Citadel's theme like Companion, custom colours
// included (same token names): ?citadel_theme= for the first paint, then the same message.
const houseFrame = $('#house-frame');
let houseSrcSet = false, houseOrigin = null;
function setHouseSrc() {
  if (houseSrcSet) return;
  const link = state.links.find(l => l.for_house);
  if (!link) return;
  const sep = link.url.includes('?') ? '&' : '?';
  houseFrame.src = `${link.url}${sep}citadel_mode=${mode()}&citadel_theme=${theme()}`;
  try { houseOrigin = new URL(link.url).origin; } catch { houseOrigin = null; }
  houseSrcSet = true;
}
houseFrame.addEventListener('load', tellFrames);

// And for the Labels page (ZebraLab, a link). Follows Citadel's theme like House (custom colours included).
const labelsFrame = $('#labels-frame');
let labelsSrcSet = false, labelsOrigin = null;
function setLabelsSrc() {
  if (labelsSrcSet) return;
  const link = state.links.find(l => l.for_labels);
  if (!link) return;
  const sep = link.url.includes('?') ? '&' : '?';
  labelsFrame.src = `${link.url}${sep}citadel_mode=${mode()}&citadel_theme=${theme()}`;
  try { labelsOrigin = new URL(link.url).origin; } catch { labelsOrigin = null; }
  labelsSrcSet = true;
}
labelsFrame.addEventListener('load', tellFrames);

// And for the Holodeck page (retro games emulator, a link). Follows Citadel's theme like Labels.
// When Citadel itself is opened on loopback (127.0.0.1 / localhost on Gaming) and the link points at Gaming's
// LAN address, rewrite the frame host to loopback too so browsers treat the iframe as a secure context and
// allow the Gamepad API (controllers).
const holodeckFrame = $('#holodeck-frame');
let holodeckSrcSet = false, holodeckOrigin = null;
function setHolodeckSrc() {
  if (holodeckSrcSet) return;
  const link = state.links.find(l => l.for_holodeck);
  if (!link) return;
  let url = link.url;
  try {
    const parsed = new URL(url);
    if ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') && state.ip && parsed.hostname === state.ip) {
      parsed.hostname = location.hostname;
      url = parsed.toString();
    }
    holodeckOrigin = parsed.origin;
  } catch { holodeckOrigin = null; }
  const sep = url.includes('?') ? '&' : '?';
  holodeckFrame.src = `${url}${sep}citadel_mode=${mode()}&citadel_theme=${theme()}`;
  holodeckSrcSet = true;
}
holodeckFrame.addEventListener('load', tellFrames);

// And for the HomeLab page (Home Assistant on Probe-1, a link). Follows Citadel's theme like Labels: Home Assistant
// loads a small bridge (~/Projects/HomeLab/home-assistant/citadel-theme) that turns the same message into its own
// Citadel themes.
const labFrame = $('#lab-frame');
let labSrcSet = false, labOrigin = null;
function setLabSrc() {
  if (labSrcSet) return;
  const link = state.links.find(l => l.for_lab);
  if (!link) return;
  const sep = link.url.includes('?') ? '&' : '?';
  labFrame.src = `${link.url}${sep}citadel_mode=${mode()}&citadel_theme=${theme()}`;
  try { labOrigin = new URL(link.url).origin; } catch { labOrigin = null; }
  labSrcSet = true;
}
labFrame.addEventListener('load', tellFrames);

// And for the Casino page (Casino World, a link). A Godot game with its own look, so no theme hand-off.
const casinoFrame = $('#casino-frame');
let casinoSrcSet = false;
function setCasinoSrc() {
  if (casinoSrcSet) return;
  const link = state.links.find(l => l.for_casino);
  if (!link) return;
  casinoFrame.src = link.url;
  casinoSrcSet = true;
}

// The bookmarks across the top (Settings → Widgets → Bookmarks; the widget is still called "shortcuts" inside):
// a Bookmarks button, then the first four in Settings' order. The button drops a panel with the rest, laid over the
// reminders so the card grid never moves. On desktop the panel hangs from the button as a column of the button's width
// (placeBookmarks), and starts another column alongside when it would run off the bottom of the screen. Invisible until something is configured, or when it's switched off there.
// Links open in a new tab.
const BM_TOP = 4;
let shortcutsKey = null;
function scIcon(s) {
  const letter = `<span class="sc__letter" aria-hidden="true">${esc((s.label || new URL(s.url).hostname).trim().charAt(0).toUpperCase())}</span>`;
  if (s.icon_mode === 'builtin') return ico(s.icon);
  if (s.img) return `<img class="sc__img" src="${esc(s.img)}" alt="" loading="lazy" decoding="async">`;
  return letter;
}
const hostOf = url => { try { return new URL(url).host; } catch { return url; } };
function renderShortcuts() {
  const w = state.widgets?.shortcuts?.data;
  const list = w && w.show ? w.shortcuts : [];
  const nav = $('#shortcuts'), bar = $('#bm-bar');
  const key = JSON.stringify(list);
  if (key === shortcutsKey) return;                  // nothing changed: don't rebuild (keeps hover/focus steady)
  shortcutsKey = key;
  bookmarks(false, true);
  nav.hidden = !list.length;
  const top = list.slice(0, BM_TOP), rest = list.slice(BM_TOP);
  nav.innerHTML = `<button class="sc sc--menu" type="button" data-bm-toggle aria-expanded="false" aria-controls="bm-bar" title="All bookmarks">${ico('list')}<span class="sc__label">Bookmarks</span>${ico('down', 'sc__chev')}</button>`
    + top.map(s => {
      const host = hostOf(s.url);
      return `<a class="sc${s.label ? '' : ' sc--bare'}" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.label ? `${s.label} — ${host}` : host)}">${scIcon(s)}${s.label ? `<span class="sc__label">${esc(s.label)}</span>` : ''}</a>`;
    }).join('');
  // The panel lists the rest. The first four are in it too, as .bm--top, which only phones show: they have no room
  // for the four in the bar.
  const tile = (s, i, top = false) => `<a class="bm${top ? ' bm--top' : ''}" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.label ? `${s.label}\n${s.url}` : s.url)}" style="--d:${80 + i * 22}ms">${scIcon(s)}<span><b>${esc(s.label || hostOf(s.url))}</b><small>${esc(hostOf(s.url))}</small></span></a>`;
  bar.innerHTML = `<div class="bmbar__list">${top.map((s, i) => tile(s, i, true)).join('')}${rest.map((s, i) => tile(s, i)).join('')}</div>`
    + '<a class="bmbar__edit" href="/settings#widgets">Edit in Settings</a>';
}
/** Desktop: hang an open drop-down (Bookmarks, Style) from its button. Its columns are the button's width, and each
 *  holds as many tiles as fit between the button and the bottom of the screen. Measured in screen pixels and divided
 *  back down by the shell's zoom (the 2560 layout's 1.2), the same way layoutRail does. Style hangs from the button's
 *  right edge (--bm-right), Bookmarks from its left. Phones keep their own fixed panel (CSS). */
function placeDrop(bar, btn) {
  const list = bar?.querySelector('.bmbar__list');
  if (!bar || bar.hidden || !btn || !list) return;
  if (bar === styleBar) btn = lookGroup;          // Style hangs from both look buttons
  const props = ['--bm-top', '--bm-left', '--bm-right', '--bm-w', '--bm-col', '--bm-rows'];
  if (matchMedia('(max-width: 760px)').matches) { props.forEach(p => bar.style.removeProperty(p)); return; }
  const z = rail.getBoundingClientRect().width / parseFloat(getComputedStyle(rail).width) || 1;
  const b = btn.getBoundingClientRect(), m = bar.offsetParent.getBoundingClientRect(), cs = getComputedStyle(bar);
  bar.style.setProperty('--bm-top', `${(b.bottom - m.top) / z}px`);   // flush: the panel carries on from the button
  bar.style.setProperty('--bm-left', `${(b.left - m.left) / z}px`);
  bar.style.setProperty('--bm-right', `${(m.right - b.right) / z}px`);
  bar.style.setProperty('--bm-w', `${b.width / z}px`);
  const sides = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((n, k) => n + parseFloat(cs[k]), 0);
  bar.style.setProperty('--bm-col', `${b.width / z - sides}px`);
  const tiles = [...list.children].filter(t => t.offsetParent);
  if (!tiles.length) return;
  bar.style.setProperty('--bm-rows', tiles.length);                  // one column first, to measure a tile and the rest
  const gap = parseFloat(getComputedStyle(list).rowGap) * z, tile = tiles[0].getBoundingClientRect().height;
  const room = innerHeight - 16 - bar.getBoundingClientRect().top - (bar.getBoundingClientRect().height - list.getBoundingClientRect().height);
  bar.style.setProperty('--bm-rows', Math.max(1, Math.min(tiles.length, Math.floor((room + gap) / (tile + gap)))));
}
const placeBookmarks = () => placeDrop($('#bm-bar'), $('[data-bm-toggle]'));
const isDropOpen = bar => !!bar && !bar.hidden && !bar.classList.contains('is-closing');
/** Open/close the bookmarks panel (no argument: toggle). `now` skips the fold-away animation. */
function bookmarks(on, now = false) { drop($('#bm-bar'), $('[data-bm-toggle]'), on, now); }
/** Open/close a drop-down panel (no argument: toggle). `now` skips the fold-away animation. */
function drop(bar, btn, on, now = false) {
  if (!bar) return;
  const isOpen = isDropOpen(bar);
  on = on ?? !isOpen;
  if (on === isOpen && !now) return;
  btn?.setAttribute('aria-expanded', String(on));
  bar.classList.remove('is-opening', 'is-closing');
  if (on) { bar.hidden = false; placeDrop(bar, btn); void bar.offsetWidth; bar.classList.add('is-opening'); return; }
  if (now || matchMedia('(prefers-reduced-motion: reduce)').matches) { bar.hidden = true; return; }
  bar.classList.add('is-closing');
  bar.addEventListener('animationend', () => { if (bar.classList.contains('is-closing')) { bar.hidden = true; bar.classList.remove('is-closing'); } }, { once: true });
}

// The header readout (Home only, on wide screens, both themes): live temperatures, usage and uptime, every one real.
// It stands in for the Monitoring tile: clicking it opens Monitoring's full view, which also has what used to be here
// (services, this PC's address).
const pct = n => (n == null || Number.isNaN(n) ? '—' : `${Math.round(n)}%`);
// Heat: the reading at which a number turns pale gold, amber, then red (data-heat 1–3, colours in tokens.css).
// The CPU idles in the 60s °C (a Ryzen's normal), so its first step starts higher than the GPU's.
const HEAT = { 'CPU °C': [70, 75, 80], 'GPU °C': [60, 70, 80], CPU: [50, 70, 90], GPU: [50, 70, 90], VRAM: [50, 70, 90], RAM: [50, 70, 90] };
const heatOf = (k, n) => (n == null || !HEAT[k] ? 0 : HEAT[k].filter(t => n >= t).length);
function renderReadout() {
  const el = $('#readout');
  if (!el || !state) return;
  const m = monitoring, up = state.widgets?.system?.data?.uptime_s;
  const cpuT = m?.cpu?.temp?.package, gpuT = m?.gpu?.temp, cpu = m?.cpu?.percent, gpu = m?.gpu?.percent;
  const vram = m?.gpu?.mem_total_mb && m.gpu.mem_used_mb != null ? m.gpu.mem_used_mb / m.gpu.mem_total_mb * 100 : null, ram = m?.mem ? m.mem.used / m.mem.total * 100 : null;
  const t1 = v => v.toFixed(1), p1 = v => `${v.toFixed(1)}%`;
  const cells = [                                                   // fmt: number -> text, so LCARS can roll between readings
    { k: 'CPU °C', n: cpuT, fmt: t1 },
    { k: 'GPU °C', n: gpuT, fmt: t1 },
    { k: 'CPU', n: cpu, fmt: p1 },
    { k: 'GPU', n: m?.gpu ? gpu : null, fmt: pct },
    { k: 'VRAM', n: vram, fmt: pct },
    { k: 'RAM', n: ram, fmt: pct },
    { k: 'Uptime', n: null, text: up != null ? `${Math.floor(up / 86400)}d ${Math.floor(up % 86400 / 3600)}h` : '—' },
  ].map(c => ({ ...c, n: c.n ?? null, text: c.text ?? (c.n != null ? c.fmt(c.n) : '—'), heat: heatOf(c.k, c.n) }));
  // updated in place: in LCARS a number rolls to its new value and only a real change gets a cue (motion.js)
  motion.updateReadout(el, cells);
}
// On the element itself, so it runs before Shell's document-level "click outside closes the open card": opening stops
// the click there (or Shell would close it again at once without View Transitions); with a card open, Shell closes it.
function openMonitoring(e) {
  if (shell.open) return;
  e.stopPropagation();
  shell.toggle($('#monitoring'));
  pollMachines();
}
$('#readout').addEventListener('click', openMonitoring);
$('#readout').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMonitoring(e); } });

// Lazy first-visit loaders for embedded iframes: each sets its src once (never reassigned on later refreshes, so
// navigating away and back keeps playback/session state), without loading all 10 apps in the background on ?wall#home.
const FRAME_LOADERS = {
  media: setMediaSrc, music: setMusicSrc, sql: setSqlSrc, ai: setAiSrc,
  house: setHouseSrc, labels: setLabelsSrc, holodeck: setHolodeckSrc,
  lab: setLabSrc, casino: setCasinoSrc, curate: setCurateSrc,
};

// True while renderAll redraws the cards from new state, so LCARS can show which cards' data changed (motion.js); not
// for redraws from opening, filtering or searching a card, or Monitoring's own 2 s poll.
let freshData = false;
function renderAll() {
  renderShortcuts();
  renderReadout();
  freshData = true;
  try { cards.forEach(c => renderCard(c.id)); } finally { freshData = false; }
  renderAlerts();
  FRAME_LOADERS[lastView]?.();
  renderNav(state.navigation);
  music.onState(state);
  $('#host-label').textContent = `${state.host} · ${location.hostname}`;
  $('#device-label').textContent = `${state.device.role === 'owner' ? 'Owner' : state.device.role} device`;
}

// The Monitoring tile needs to feel close to real-time — temperatures swing over seconds, not the 30s+ the
// other widgets refresh at — so it's polled directly here, bypassing the state/SSE cycle entirely. Routing it
// through there instead would mean every tick triggers a full dashboard refresh (including two systemctl calls
// for project status) just for one tile. The server-side reading itself is a background loop now too (see
// app/monitor.py) — this fetch just reads its latest cached value, no live sensor read in the request at all.
// Not offsetParent: an expanded card is position: fixed, whose offsetParent is null wherever the viewport contains it
// (every screen ≤1500px), so the open Monitoring card froze. getClientRects() is empty only when it isn't rendered.
const monVisible = () => ($('#monitoring')?.getClientRects().length ?? 1) > 0;
async function pollMonitoring() {
  if (!state || document.hidden || VIEWS.includes(location.hash.slice(1)) && location.hash !== '#home') return;   // the tile is on Home only
  try { monitoring = await api.get('/api/owner/monitoring'); } catch { /* keep the last good reading, don't blank the tile over one dropped request */ }
  if (monTicks++ % 15 === 0) pollMachines();
  if (monVisible()) renderCard('monitoring');
  renderReadout();
}

// ---- view router (Home / News / Media / Companion / SQL DB / Music / Casino / Odysseus / House / Stats) --------------------------------------------------------------
const VIEWS = ['home', 'news', 'media', 'music', 'sql', 'listen', 'casino', 'ai', 'house', 'labels', 'holodeck', 'lab', 'controls', 'routines', 'schedule', 'padd', 'stats', 'curate', 'audio', 'settings'];
// While an embedded page is showing, the phone keyboard shrinks the screen (interactive-widget=resizes-content) rather
// than sliding over it, so the pinned page (dashboard.css, .main:has(...)) ends just above the keyboard and a chat box
// at the bottom of it stays visible. Only on those pages: Home, News and Music keep the browser's default.
const FRAME_VIEWS = ['media', 'music', 'sql', 'casino', 'ai', 'house', 'labels', 'holodeck', 'lab', 'curate', 'settings'];
const viewportMeta = $('meta[name="viewport"]');
const VIEWPORT = viewportMeta.content;
// Settings opens inside the dashboard, framed like the embedded pages (it's Citadel's own page, same origin). It loads
// afresh every time it's opened, so its forms never show config that changed since, on the section a link asked for
// or else the one it was last on (Settings keeps its section in its own address). Every link to /settings on the
// dashboard comes here instead of leaving the page (see the click handler).
const settingsFrame = $('#settings-frame');
let settingsNext = null, lastView = null;
function openSettings() {
  let at = null;
  try { const l = settingsFrame.contentWindow.location; if (l.pathname.endsWith('/settings.html')) at = 'settings.html' + l.search + l.hash; } catch { /* not loaded yet */ }
  const to = (settingsNext || at || '/settings').replace(/^\/settings/, 'settings.html');
  settingsNext = null;
  if (!settingsFrame.getAttribute('src')) { settingsFrame.src = to; return; }
  // a new address that differs only after the # doesn't reload a page by itself, so reload explicitly
  const w = settingsFrame.contentWindow;
  w.location.replace(to);
  w.location.reload();
}

// LCARS 25's header row (lcars25.css; hidden in the other themes): the page's number and name as the rail shows them,
// and on a framed app where it comes from (the frame's title, when it says more than the page's name) with Reload and
// Open in new tab. Home has its bookmarks and readout there instead. Reload sets the frame's address again (the apps are
// on other origins, so their own location can't be reached), which takes it back to the page Citadel opened.
function renderTopCtx() {
  const v = document.documentElement.dataset.page, ctx = $('#top-ctx');
  const view = $(`.view[data-view="${v}"]`), frame = view?.querySelector('.frame-shell iframe');
  ctx.hidden = !view || v === 'home';
  if (ctx.hidden) return;
  const links = $$('.rail a[data-view]').filter(a => !a.hidden), i = links.findIndex(a => a.dataset.view === v);
  const label = $(`.rail a[data-view="${v}"] .rail__label`)?.textContent || view.getAttribute('aria-label') || v;
  $('#top-page').textContent = i >= 0 ? `${String(i + 1).padStart(2, '0')} · ${label}` : label;
  const own = frame && v !== 'settings';
  $('#top-src').textContent = own && frame.title.toLowerCase() !== label.toLowerCase() ? frame.title : '';
  $('#top-acts').hidden = !own;
}
const activeFrame = () => $('.view.is-active .frame-shell iframe');
document.addEventListener('click', e => {
  if (e.target.closest('[data-frame-reload]')) {
    const f = activeFrame(), src = f?.getAttribute('src');
    if (src) f.src = src;
  } else if (e.target.closest('[data-frame-open]')) {
    const src = activeFrame()?.getAttribute('src');
    if (src) open(safeUrl(new URL(src, location.href).href), '_blank', 'noopener');
  }
});

function route() {
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home';
  if (v === 'settings' && lastView !== 'settings') openSettings();
  lastView = v;
  if (state) FRAME_LOADERS[v]?.();
  viewportMeta.content = FRAME_VIEWS.includes(v) ? `${VIEWPORT}, interactive-widget=resizes-content` : VIEWPORT;
  document.documentElement.dataset.page = v;         // the header's middle slot follows it (shortcuts, or the Music page's player)
  $$('.view').forEach(el => el.classList.toggle('is-active', el.dataset.view === v));
  if (slideDir) slideIn($(`.view[data-view="${v}"]`), slideDir);
  slideDir = null;
  moreSheet(false);
  markCurrent();
  renderTopCtx();
  music.onView(v);                                  // the Music page (music.js) only polls Spotify while it's on screen
  news.onView(v);                                   // the News page (news.js) loads its own stories when shown
  stats.onView(v);                                  // the Fleet page (stats.js): machine history from the collector on NZXT
  audio.onView(v);                                  // the Audio page (audio.js): the GoXLR, through the hub
  controls.onView(v);                               // the Controls page (controls.js): Home Assistant lights & scenes
  routines.onView(v);                               // the Routines page (routines.js): Home Assistant's routine times
  schedule.onView(v);                               // the Unified Schedule page (schedule.js): Calendar, Gigs, F1, Bins, Releases, Vinyl, House, Poker
  padd.onView(v);                                   // the PADD page (padd.js): cross-device Dropzone, Notes & Checklists, HA Shopping list
}
function markCurrent() {
  $$('.rail a[data-view], .tabbar a[data-view], #more-sheet a[data-view]').forEach(a => {
    if (a.dataset.view === lastView) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('[data-more]')?.classList.toggle('is-current', !!$(`#more-sheet a[data-view="${lastView}"]`));   // the page shown is under More
}

// ---- navigation (Settings → Navigation): page names, the phone's tabs, the rail's pages, and their order -----------------
// index.html holds the defaults; this renames, reorders and hides rail links and rebuilds the phone's tab bar from the
// saved settings (this device's own, or every device's). Pages without a phone tab go under the tab bar's More. The last
// settings seen are kept on this device too, so a phone draws its own tabs straight away instead of the defaults until
// the state arrives.
const tabbar = $('.tabbar'), more = $('#more-sheet');
$$('.rail a[data-view]').forEach(a => { a.dataset.title = a.title; });     // a page under its own name keeps its fuller tooltip
let navShown = '';
function renderNav(nav) {
  if (!nav?.pages?.length) return;
  const key = JSON.stringify(nav);
  if (key === navShown) return;
  navShown = key;
  try { localStorage.setItem('nav', key); } catch { /* storage blocked: just no head start next time */ }
  const spacer = $('.rail .spacer'), railEnd = $('.rail .rail__settings');
  for (const p of nav.pages) {
    const a = $(`.rail a[data-view="${p.id}"]`);
    if (!a) continue;
    $('.rail__label', a).textContent = p.label;
    a.title = p.label === p.default ? a.dataset.title : p.label;
    a.hidden = !p.rail;
    // its group, for Citadel's department brackets (dashboard.css); the fixed pages at the foot are Ops, Home has none
    a.dataset.group = p.movable ? (p.group || '') : (p.id === 'home' ? '' : 'ops');
    // in turn, so they end up in the saved order between Home and the gap. Hidden ones wait at the very end, out of the
    // way of LCARS lining up whichever page follows Home (lcars.css) and of the boot animation's one-after-another.
    if (!p.rail) railEnd.after(a); else if (p.movable) spacer.before(a);
  }
  // Desktop rail groups (Settings → Navigation): a small heading before each group's first page on the rail. The pages
  // come already sorted into their groups; ones with no group sit above the first heading. Phones have no rail.
  $$('.rail .rail__group').forEach(h => h.remove());
  for (const g of nav.groups || []) {
    const first = nav.pages.find(p => p.rail && p.group === g.id);
    if (first) $(`.rail a[data-view="${first.id}"]`)?.insertAdjacentHTML('beforebegin', `<span class="rail__group" data-group="${esc(g.id)}">${esc(g.label)}</span>`);
  }
  const shown = nav.pages.filter(p => $(`.view[data-view="${p.id}"]`));
  const icon = p => (p.id === 'home' && document.documentElement.dataset.family === 'lcars' ? 'logo' : p.icon);    // as placeLcars does
  const link = p => `<a href="#${esc(p.id)}" data-view="${esc(p.id)}"><svg class="i"><use href="#i-${esc(icon(p))}"/></svg><span class="tabbar__label">${esc(p.label)}</span></a>`;
  const rest = shown.filter(p => !p.phone);
  more.innerHTML = rest.map(link).join('');
  tabbar.innerHTML = shown.filter(p => p.phone).map(link).join('')
    + (rest.length ? `<button type="button" class="tabbar__more" data-more aria-expanded="false" aria-controls="more-sheet"><svg class="i"><use href="#i-grid"/></svg><span class="tabbar__label">More</span></button>` : '');
  moreSheet(false);
  markCurrent();
  renderTopCtx();
  if (booted) requestAnimationFrame(layoutRail);       // the first page under Home may have changed (LCARS lines it up)
}

// More: the phone's other pages, in a small sheet over the tab bar. Picking one changes the address, and route() closes it.
function moreSheet(on) {
  more.hidden = !on;
  $('[data-more]')?.setAttribute('aria-expanded', String(on));
}
tabbar.addEventListener('click', e => { if (e.target.closest('[data-more]')) moreSheet(more.hidden); });
document.addEventListener('click', e => { if (!more.hidden && !e.target.closest('#more-sheet, [data-more]')) moreSheet(false); });

// ---- swiping between Citadel's own pages (phones) -----------------------------------------------------------------------
// Left and right go to the next and previous built-in page in tab-bar order. Embedded pages are skipped, both ways: a
// swipe inside one belongs to the app in it, so it's never swiped to or from. "Built in" is read from the page itself (a
// view with no .frame-shell), so a new page of Citadel's own joins without a change here.
const builtIn = id => { const v = $(`.view[data-view="${id}"]`); return !!v && !v.querySelector('.frame-shell'); };
let swipe = null, slideDir = null;
function scrollsSideways(el) {                          // a row that scrolls sideways (News sections, playlists) keeps its swipe
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return true;
  }
  return false;
}
function slideIn(view, dir) {
  if (!view || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const root = document.documentElement;
  view.dataset.slide = dir; root.classList.add('is-sliding');            // .main clips it meanwhile, so the page never widens
  clearTimeout(slideIn.t);
  slideIn.t = setTimeout(() => { delete view.dataset.slide; root.classList.remove('is-sliding'); }, 260);
}
const mainEl = $('.main');
mainEl.addEventListener('touchstart', e => {
  swipe = null;
  if (!phone.matches || e.touches.length !== 1 || !builtIn(lastView)) return;
  const t = e.touches[0];
  if (t.clientX < 24 || t.clientX > innerWidth - 24) return;            // the screen's edges are the browser's back gesture
  if (e.target.closest('input, textarea, select, dialog, [role="slider"], .card.is-max, .top') || scrollsSideways(e.target)) return;
  swipe = { x: t.clientX, y: t.clientY, at: e.timeStamp };
}, { passive: true });
mainEl.addEventListener('touchcancel', () => { swipe = null; }, { passive: true });
mainEl.addEventListener('touchend', e => {
  const s = swipe; swipe = null;
  if (!s) return;
  const t = e.changedTouches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
  if (Math.abs(dx) < 70 || Math.abs(dx) < 2 * Math.abs(dy) || e.timeStamp - s.at > 700) return;
  if (!more.hidden || $('#alerts').classList.contains('is-open') || !$('#bm-bar').hidden || !styleBar.hidden || $('dialog[open]') || window.getSelection()?.toString()) return;
  const pages = $$('.tabbar a[data-view]').map(a => a.dataset.view).filter(builtIn);
  const i = pages.indexOf(lastView), to = i < 0 ? null : pages[i + (dx < 0 ? 1 : -1)];
  if (!to) return;
  slideDir = dx < 0 ? 'next' : 'prev';
  location.hash = to;
}, { passive: true });

addEventListener('hashchange', route);
route();

// The header's two look buttons. Day/Night flips this device's mode in one press; Style drops a panel the same way
// Bookmarks does: the built-in Citadel and LCARS, then any custom themes (Settings → Appearance), the one in use lit,
// and Customise as its foot. Each is this device's own choice.
const modeBtn = $('[data-mode-toggle]');
const themeBtn = $('[data-theme-menu]');
function syncLookButtons() {
  const day = mode() === 'day', to = day ? 'Night' : 'Day';     // the button names the mode it switches to
  if (modeBtn) {
    $('use', modeBtn).setAttribute('href', day ? '#i-moon' : '#i-sun');
    $('.look-btn__word', modeBtn).textContent = to;
    modeBtn.setAttribute('aria-label', `Switch to ${to}`); modeBtn.title = `Switch to ${to}`;
  }
}
function themeSwatch(t) {
  return `<span class="tm__sw tm__sw--${esc(t.id)}"></span>`;
}
function styleSwatch(s, fam) {
  const h = s[mode()];
  if (s.id === 'standard') return `<span class="tm__sw tm__sw--${esc(fam)}"></span>`;
  return `<span class="tm__sw tm__sw--${esc(fam)}" style="--sw-bg:${esc(h.panel)};--sw-ac:${esc(h.accent)}">${h.background?.file ? `<img src="backgrounds/${esc(h.background.file)}" alt="">` : ''}</span>`;
}
// Theme's panel hangs from the pair (Day/Night + Theme, #look-group) and spans both. Open, the pair joins into one
// cap over it (.look-group.is-open: the gap filled, only the outer top corners rounded).
const styleBar = $('#style-bar'), lookGroup = $('#look-group');
const placeStyles = () => placeDrop(styleBar, themeBtn);
function renderStyles() {
  const curTheme = theme(), curFam = family(), curStyle = style();
  const builtins = stylesForFamily(curFam);
  const customs = (state?.appearance?.styles || []).filter(s => s.family === curFam);
  const themeTiles = THEMES.map((t, i) => `<button class="bm" type="button" role="menuitemradio" aria-checked="${t.id === curTheme}" data-use-theme="${esc(t.id)}" style="--d:${80 + i * 22}ms">${themeSwatch(t)}<span><b>${esc(t.name)}</b></span></button>`);
  const styleItems = [
    ...builtins.map(s => ({ ...s, key: s.id })),
    ...customs.map(s => ({ ...s, key: `c:${s.id}` })),
  ];
  const baseI = THEMES.length;
  const styleTiles = styleItems.map((s, i) => `<button class="bm" type="button" role="menuitemradio" aria-checked="${s.key === curStyle}" data-use-style="${esc(s.key)}" style="--d:${80 + (baseI + i) * 22}ms">${styleSwatch(s, curFam)}<span><b>${esc(s.name)}</b></span></button>`);
  styleBar.innerHTML = `<div class="bmbar__list" role="menu" aria-label="Theme">${themeTiles.join('')}<div class="stylebar__sep" role="separator"></div>${styleTiles.join('')}</div>`
    + '<a class="bmbar__edit" href="/settings#appearance">Customise</a>';
}
/** Open/close the Style panel (no argument: toggle). It's drawn afresh on each open, so the lit theme is current. */
function styles(on, now = false) {
  on = on ?? !isDropOpen(styleBar);
  if (on && !isDropOpen(styleBar)) renderStyles();
  lookGroup?.classList.toggle('is-open', on);
  drop(styleBar, themeBtn, on, now);
  if (on) { placeStyles(); styleBar.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true }); }
}
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (isDropOpen(styleBar)) { styles(false); themeBtn?.focus(); }
  if (!$('#bm-bar')?.hidden) { bookmarks(false); $('[data-bm-toggle]')?.focus(); }
  if ($('#alerts').classList.contains('is-open')) { alertsDrawer(false); $('[data-alerts-toggle]').focus(); }
  if (!more.hidden) { moreSheet(false); $('[data-more]')?.focus(); }
});
// LCARS lays the header out differently, so two pieces move into it: the reminders (a row inside the header's frame,
// under the bookmarks and buttons) and the readout (centred on the header itself, not in the bookmarks' slot).
// Citadel puts them back: the reminders at the top of Home, the readout in the header's middle slot.
// They're the same elements either way, just moved. In LCARS the reminders show on every page (so the header, and the
// rail lined up with it, keep one shape); the readout stays Home's (Monitoring is only polled there).
// LCARS motion that CSS can't trigger by itself (lcars.css, Motion). Boot: html.lc-boot for a moment after the first
// load in LCARS and whenever a device switches to LCARS. Page change: the rail button bumps and html.lc-sweep runs a
// light along the body's bar.
let lastTheme = null, booted = false;
function restartClass(el, cls, ms) {
  el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
  clearTimeout(el[`_${cls}`]); el[`_${cls}`] = setTimeout(() => el.classList.remove(cls), ms);
}
function bootLcars() {
  const fam = document.documentElement.dataset.family;
  if (fam === 'lcars') restartClass(document.documentElement, 'lc-boot', 2200);
  else if (fam === 'borg') restartClass(document.documentElement, 'brg-boot', 1400);
}
document.addEventListener('click', e => {
  const link = e.target.closest('.rail a[data-view]');
  if (!link) return;
  const fam = document.documentElement.dataset.family;
  if (fam === 'lcars') {
    restartClass(link, 'is-bump', 300);
    restartClass(document.documentElement, 'lc-sweep', 700);
  } else if (fam === 'borg') {
    restartClass(document.documentElement, 'brg-pulse', 600);
  }
});

function placeLcars() {
  const { theme: th, family: fam } = document.documentElement.dataset;
  const lc = fam === 'lcars';
  if (lastTheme !== null && th !== lastTheme && (lc || fam === 'borg')) bootLcars();
  lastTheme = th;
  const top = $('.top'), strip = $('#alerts'), readout = $('#readout');
  // the reminders sit in the header in LCARS, and on phones in every theme (their drawer, see alertsDrawer)
  if (lc || phone.matches) { if (strip.parentElement !== top) top.append(strip); }
  else if (strip.parentElement.id !== 'view-home') $('#view-home').prepend(strip);
  if (lc) { if (readout.parentElement !== top) top.append(readout); }
  else if (readout.parentElement === top) $('#mu-bar').before(readout);
  // LCARS has no separate logo at the top of the rail: Home wears it instead (rail and phone tab bar alike)
  // (the rail and tab bar links only: the Home page section is [data-view="home"] too, and holds every card's icons)
  $$('.rail [data-view="home"] use, .tabbar [data-view="home"] use').forEach(u => u.setAttribute('href', lc ? '#i-logo' : '#i-home'));
  // LCARS 25 on desktop keeps the GoXLR volumes, Day/Night and Theme in a console under Home (lcars25.css), so the
  // header's row is all the page's. Same elements, just moved: their listeners and drop-downs go with them (the
  // drop-downs measure the button wherever it is). Everywhere else they go back into the header, in their old places.
  const vols = $('#vol-group'), look = $('#look-group');
  if (th === 'lcars25' && !phone.matches) {
    if (vols.parentElement !== railConsole) { railConsole.append(vols, look); $('.rail a[data-view="home"]').after(railConsole); }
  } else if (vols.parentElement === railConsole) {
    $('#vol-bar').before(vols); $('#style-bar').before(look);
    // and the empty console off the rail: left after Home, it took the place of "the first item after Home" that the
    // LCARS rail pushes down to the page body, so after a switch from LCARS 25 the pages rode up under Home (2026-11-23)
    railConsole.remove();
  }
  layoutRail();
}
const railConsole = Object.assign(document.createElement('div'), { className: 'rail__console' });

// LCARS rail: Home sits level with the middle of the header (top-aligned by lcars25.css in LCARS 25), and the other
// pages start where the page body does. The header's height moves (the reminders show on Home only, and wrap), so it's
// measured, and re-measured whenever the header changes size. Positions are taken relative to the shell, which scrolls
// with the header. Under the 1440p zoom the measured (zoomed) pixels are divided back down to the rail's own CSS pixels.
const rail = $('.rail');
function layoutRail() {
  const view = $('.view.is-active');
  const { theme: th, family: fam } = document.documentElement.dataset;
  if (fam !== 'lcars' || !rail.offsetParent || !view) { rail.style.removeProperty('--lc-home-top'); rail.style.removeProperty('--lc-body-top'); return; }
  const z = rail.getBoundingClientRect().width / parseFloat(getComputedStyle(rail).width) || 1;
  const s = $('.shell').getBoundingClientRect(), t = $('.top').getBoundingClientRect(), v = view.getBoundingClientRect();
  if (th === 'lcars25') {
    rail.style.removeProperty('--lc-home-top');
  } else {
    // Home's layout height, not its on-screen box: switching to LCARS runs the boot animation, which grows the rail buttons
    // from scaleY(0), so measured then its box is 0 tall and Home landed half its height too low
    const homeH = parseFloat(getComputedStyle($('.rail [data-view="home"]')).height) * z;
    rail.style.setProperty('--lc-home-top', `${Math.round((t.top - s.top + (t.height - homeH) / 2) / z)}px`);
  }
  // LCARS 25: the pages (and the spine beside them) start under the corner console, not level with the page body
  const c = th === 'lcars25' && railConsole.isConnected && railConsole.childElementCount ? railConsole.getBoundingClientRect() : null;
  rail.style.setProperty('--lc-body-top', `${Math.round(((c ? c.bottom + 4 : v.top) - s.top) / z)}px`);
}
const railRO = new ResizeObserver(() => layoutRail());
railRO.observe($('.top'));
railRO.observe(railConsole);   // LCARS 25: the GoXLR volumes arrive after first paint and add a row to the console
addEventListener('resize', layoutRail);
addEventListener('resize', () => { placeBookmarks(); placeStyles(); if (monVisible()) renderCard('monitoring'); });
addEventListener('hashchange', () => requestAnimationFrame(layoutRail));
document.fonts?.ready.then(layoutRail);
document.addEventListener('theme:change', () => { tellFrames(); syncLookButtons(); placeLcars(); if (isDropOpen(styleBar)) { styleBar.classList.remove('is-opening'); renderStyles(); placeStyles(); } });
phone.addEventListener('change', () => { alertsDrawer(false); moreSheet(false); placeLcars(); });
try { renderNav(JSON.parse(localStorage.getItem('nav'))); } catch { /* nothing saved on this device yet */ }
syncLookButtons();
placeLcars();

// Keys 1–9 and 0 open the matching Home card (the LCARS theme numbers them 01–10). Not while typing, not with a card,
// dialog or menu already open, and only on Home.
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const n = '1234567890'.indexOf(e.key);
  if (n < 0 || document.documentElement.dataset.page !== 'home' || shell.open) return;
  if (e.target.closest('input, textarea, select, [contenteditable], dialog') || $('dialog[open]') || isDropOpen(styleBar)) return;
  const card = [...shell.cards.values()][n]?.el;
  if (card) { e.preventDefault(); bookmarks(false, true); shell.toggle(card); }
});

let loading = null, startedSeen = null;
const wall = new URLSearchParams(location.search).has('wall');   // NZXT's wallpaper (README: NZXT wallpaper)
async function load() {
  if (loading) return loading;                       // coalesce bursts of events into one fetch
  loading = api.get('/api/owner/state').then(s => {
    // the wallpaper picks up a hub restart's new code by reloading; other pages never reload under you
    if (wall && startedSeen && s.started !== startedSeen) { location.reload(); return; }
    startedSeen = s.started;
    state = s; syncStyles(s.appearance?.styles, s.appearance?.migrated_presets); syncLookButtons(); renderAll();
    // the first fill: the boot began at first paint (theme-init.js); let it finish, then take the class off
    if (!booted) { booted = true; setTimeout(() => { document.documentElement.classList.remove('lc-boot', 'brg-boot'); $('.sweep')?.remove(); }, 1800); }
  }).catch(e => console.error(e)).finally(() => { loading = null; });
  return loading;
}
let debounce;
const changed = () => { clearTimeout(debounce); debounce = setTimeout(load, 250); };

// ---- Gig radar → Booked ----------------------------------------------------------------------------------
// A quick form filled in from Ticketmaster; saving makes it a booked gig (off the radar, onto the Gigs card) and, if
// ticked, opens it as a new Google Calendar event — the Diary card reads that calendar, so it shows up there too.
const bookDlg = $('#book-gig');
const bookForm = bookDlg.querySelector('form');
const bookErr = bookDlg.querySelector('.book__error');
let bookingId = null;

function openBooking(d) {
  bookingId = d.id;
  bookForm.reset();
  const f = bookForm.elements;
  f.artist.value = d.artist || '';
  f.date.value = d.gigDay || '';
  f.venue.value = d.venue || '';
  f.city.value = d.city || '';
  f.doors.value = /^\d{2}:\d{2}$/.test(d.time || '') ? d.time : '';
  f.ticket_url.value = d.url || '';
  bookErr.hidden = true;
  bookDlg.showModal();
  f.notes.focus();
}

bookDlg.querySelector('[data-book-cancel]').addEventListener('click', () => bookDlg.close());
bookForm.addEventListener('submit', async e => {
  e.preventDefault();
  const f = bookForm.elements;
  const body = { artist: f.artist.value.trim(), date: f.date.value, venue: f.venue.value.trim(), city: f.city.value.trim(),
                 doors: f.doors.value, ticket_url: f.ticket_url.value.trim() || null, notes: f.notes.value.trim() };
  if (!body.artist || !body.date) { bookErr.textContent = 'An artist and a date are needed.'; bookErr.hidden = false; return; }
  // Opened now, inside the click, or the popup blocker stops it; pointed at Google once the gig is safely saved.
  const tab = f.diary.checked ? window.open('about:blank', '_blank') : null;
  try {
    await api.post(`/api/owner/radar/${bookingId}/book`, body);
  } catch (err) {
    tab?.close();
    bookErr.textContent = err.message;
    bookErr.hidden = false;
    return;
  }
  if (tab) { tab.opener = null; tab.location.href = gcalUrl(body); }
  const blocked = f.diary.checked && !tab;
  bookDlg.close();
  toast(blocked ? `Booked — added to Gigs. The Google Calendar tab was blocked: use “diary” on the Gigs card` : `Booked — ${body.artist} added to Gigs`);
  await load();
});

// ---- start / stop -----------------------------------------------------------------------------------------
document.addEventListener('click', async e => {
  if (e.target.closest('[data-mode-toggle]')) { setMode(mode() === 'day' ? 'night' : 'day'); return; }
  if (e.target.closest('[data-theme-menu]')) { bookmarks(false); styles(); return; }
  const useTheme = e.target.closest('[data-use-theme]');
  if (useTheme) { styles(false, true); setTheme(useTheme.dataset.useTheme, state?.appearance?.styles); return; }   // a new theme re-lays the header: no fold-away
  const useStyle = e.target.closest('[data-use-style]');
  if (useStyle) { styles(false, true); setStyle(useStyle.dataset.useStyle, state?.appearance?.styles); return; }
  if (isDropOpen(styleBar) && (e.target.closest('#style-bar .bmbar__edit') || !e.target.closest('#style-bar'))) styles(false);
  if (!e.target.closest('#alerts, [data-alerts-toggle]')) alertsDrawer(false);   // a tap outside the reminders drawer closes it
  if (e.target.closest('[data-alerts-toggle]')) { alertsDrawer(); return; }
  if (e.target.closest('[data-bm-toggle]')) { bookmarks(); return; }
  if (!$('#bm-bar').hidden && (e.target.closest('#bm-bar .bm, #bm-bar .bmbar__edit') || !e.target.closest('#bm-bar'))) bookmarks(false);   // picked one, or clicked elsewhere
  const toSettings = e.target.closest('a[href^="/settings"]');
  if (toSettings && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {     // opens in the Settings view (openSettings)
    e.preventDefault();
    styles(false, true);
    settingsNext = toSettings.getAttribute('href');
    if (location.hash === '#settings') openSettings(); else location.hash = '#settings';
    return;
  }
  const dismiss = e.target.closest('[data-alert-dismiss]');
  if (dismiss) { dismissAlert(dismiss.dataset.alertDismiss); return; }
  const act = e.target.closest('[data-alert-action]');
  if (act) { alertAction(act.dataset.alertAction); return; }
  const restore = e.target.closest('[data-alert-restore]');
  if (restore) { restoreAlert(restore.dataset.alertRestore); return; }
  if (e.target.closest('[data-alerts-more]')) { alertsOpen = !alertsOpen; renderAlerts(); return; }
  const pin = e.target.closest('[data-pin]');
  if (pin) {                                                                // pin / unpin a link or project
    const { pin: kind, id, to } = pin.dataset;
    try { await api.post(`/api/owner/${kind === 'link' ? 'links' : 'projects'}/${encodeURIComponent(id)}/pin`, { pinned: to === 'true' }); }
    catch (err) { toast(`Couldn't ${to === 'true' ? 'pin' : 'unpin'}: ${err.message}`); }
    await load();
    return;
  }
  const curate = e.target.closest('[data-item-act]');
  if (curate) {                                                             // pin / dismiss / restore an item, mute its artist, or resolve a pre-order
    // "date" is deliberately not read from curate.dataset.date here — tickClock() (see util.js) sweeps every
    // element with a plain [data-date] attribute once a second to redraw the Now card's clock, and would stomp
    // this button's own icon the same way it did before this was renamed to data-release-date.
    const { itemAct, id, to, artist, releaseDate, title } = curate.dataset;
    if (itemAct === 'book') { openBooking(curate.dataset); return; }
    // Purchased (moves a listing to Confirmed Pre-orders) and both pre-order resolutions are one-way enough to
    // warrant a pause; dismiss/pin/seen stay instant, same as everywhere else in the app.
    const prompts = {
      purchased: `Mark “${title}” as purchased? It’ll move to Confirmed Pre-orders.`,
      received: `Mark “${title}” as received? It’ll come off this list.`,
      remove: `Remove “${title}” from Confirmed Pre-orders? This can’t be undone.`,
    };
    if (prompts[itemAct] && !confirm(prompts[itemAct])) return;
    try {
      if (itemAct === 'mute') {
        await api.post('/api/owner/artists/mute', { name: artist });
        toast(`Muted ${artist} — undo in Settings → Music`);
      } else if (itemAct === 'remove' || itemAct === 'received') {
        await api.del(`/api/owner/items/${id}`);
      } else {
        await api.post(`/api/owner/items/${id}/status`, { status: to });
        // Vinyl radar shows a date it may have borrowed from another store listing the same record (the
        // underlying row's own date can be blank) — freeze that displayed date onto the row now, or Confirmed
        // Pre-orders would show TBC for something that visibly had a release date a second ago.
        if (itemAct === 'purchased' && releaseDate) await api.patch(`/api/owner/items/${id}/date`, { date: releaseDate });
      }
    } catch (err) { toast(err.message); }
    await load();
    return;
  }
  const seen = e.target.closest('[data-mark-seen]');
  if (seen) {
    try { const r = await api.post(`/api/owner/items/mark-seen/${seen.dataset.markSeen}`); toast(r.cleared ? `Marked ${r.cleared} as seen` : 'Nothing new to clear'); }
    catch (err) { toast(err.message); }
    await load();
    return;
  }
  const vinylMode = e.target.closest('[data-vinyl-mode]');
  if (vinylMode) {                                                          // dual-content tile header: Shell never touches this markup again after building it, so the pressed state is set here directly
    vinylUi.mode = vinylMode.dataset.vinylMode;
    $$('[data-vinyl-mode]', vinylMode.closest('.card__head')).forEach(b => b.setAttribute('aria-pressed', b === vinylMode));
    renderCard('vinyl');
    return;
  }
  const wakeTile = e.target.closest('[data-wake]');
  if (wakeTile) {                                                           // Remote Access: wake a sleeping device (Wake-on-LAN)
    const id = wakeTile.dataset.wake;
    const name = state.remote.find(r => String(r.id) === id)?.name || 'that device';
    ui.pending[`vnc:${id}`] = 'wake';
    renderCard('remote');
    try {
      await api.post(`/api/owner/remote/${encodeURIComponent(id)}/wake`);
      toast(`Waking ${name}…`);
      // "Waking…" until the ping sees it (the server's quick recheck sends a health event), or 3 minutes
      const until = Date.now() + 180000;
      const done = () => state.remote.find(r => String(r.id) === id)?.up || Date.now() > until;
      const tick = setInterval(() => { if (done()) { clearInterval(tick); delete ui.pending[`vnc:${id}`]; renderCard('remote'); } }, 1000);
    } catch (err) {
      delete ui.pending[`vnc:${id}`];
      renderCard('remote');
      toast(err.message);
    }
    return;
  }
  const vnc = e.target.closest('[data-vnc], [data-vnc-close]');
  if (vnc) {                                                                // Remote Access: open / close a viewer on this PC
    const close = 'vncClose' in vnc.dataset, id = close ? vnc.dataset.vncClose : vnc.dataset.vnc;
    const name = state.remote.find(r => String(r.id) === id)?.name || 'that device';
    ui.pending[`vnc:${id}`] = close ? 'close' : 'open';
    renderCard('remote');
    try {
      const r = await api.post(`/api/owner/remote/${encodeURIComponent(id)}/${close ? 'close' : 'open'}`);
      if (r.already_open) toast(`${name} is already open on ${state.host}`);
    } catch (err) {
      toast(err.message);
    } finally {
      delete ui.pending[`vnc:${id}`];
      await load();
    }
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (btn) {
    const { act, slug } = btn.dataset;
    ui.pending[slug] = act;
    renderCard('projects');
    renderCard('launchpad');    // a desktop project's Launchpad tile is itself the start button, so it needs the busy state too
    try {
      await api.post(`/api/owner/projects/${encodeURIComponent(slug)}/${act}`);
    } catch (err) {
      toast(`Couldn't ${act} ${slug}: ${err.message}`);
    } finally {
      delete ui.pending[slug];
      await load();
    }
    return;
  }
  const wxDay = e.target.closest('[data-wx-day]');
  if (wxDay) {
    const picked = wxDay.dataset.wxDay;
    const card = $('#now');
    if (card.classList.contains('is-max')) {
      ui.wxDay = ui.wxDay === picked ? null : picked;
      renderCard('now');
    } else {
      ui.wxDay = picked;
      shell.toggle(card);
    }
    return;
  }
  if (e.target.closest('[data-wx-close]')) {
    ui.wxDay = null;
    renderCard('now');
    return;
  }
  const row = e.target.closest('.proj[data-select]');                      // pick a project to view its log (expanded view)
  if (row && $('#projects').classList.contains('is-max')) {
    ui.selected = row.dataset.slug;
    ui.logText = '';
    renderCard('projects');
    pollLogs();
  }
});

// A pre-order's release-date field commits on blur, not on `change` — Chrome fires `change` on a date input
// after every keystroke that makes *some* value parseable (typing just the year's first digit already yields
// a complete, if wrong, "0002-…" date), and reacting to that mid-type triggers load()'s full card re-render,
// which tears down the very input the person is still typing into. Waiting for focusout means the API only
// ever sees what they actually finished typing, and only when it's genuinely different from what was there.
// The "only if unset" guard on focusin matters: a multi-segment date field can re-fire focusin without an
// intervening focusout (seen from Playwright's fill(), plausible from real segment-to-segment interaction too)
// — overwriting dataset.orig there would snapshot the value *after* the edit instead of before it, so the
// focusout comparison would never see a difference and silently drop the change.
document.addEventListener('focusin', e => {
  const el = e.target.closest('[data-preorder-date]');
  if (el && el.dataset.orig === undefined) el.dataset.orig = el.value;
});
document.addEventListener('focusout', e => {
  const el = e.target.closest('[data-preorder-date]');
  if (!el) return;
  if (el.value !== el.dataset.orig) {
    api.patch(`/api/owner/items/${el.dataset.preorderDate}/date`, { date: el.value || null })
      .catch(err => toast(err.message)).finally(load);
  }
  delete el.dataset.orig;
});

// ---- live log for the selected project while the Projects card is expanded ----------------------------------
let logTimer = null;
async function pollLogs() {
  if (!state || !$('#projects').classList.contains('is-max')) return;
  const slug = selectedSlug(state);
  if (!slug) return;
  try {
    const { lines } = await api.get(`/api/owner/projects/${encodeURIComponent(slug)}/logs?n=300`);
    const text = lines.map(l => `${l.t} ${l.msg}`).join('\n');
    if (slug !== selectedSlug(state)) return;                              // selection changed while fetching
    ui.logText = text;
    const pre = $('[data-log]', $('#projects'));
    if (pre) {
      const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
      pre.textContent = text || 'No output yet — start the project to see its log.';
      if (stick) pre.scrollTop = pre.scrollHeight;
    }
  } catch { /* transient */ }
}
document.addEventListener('card:max', e => {
  if (e.detail.id === 'now' && !e.detail.on) { ui.wxDay = null; return; }
  if (e.detail.id !== 'projects') return;
  clearInterval(logTimer);
  if (e.detail.on) { ui.logText = ''; pollLogs(); logTimer = setInterval(pollLogs, 3000); }
});

// ---- boot -------------------------------------------------------------------------------------------------
motion.init();
await load();
tickClock();
tickUptimes();
setInterval(() => { tickClock(); tickUptimes(); }, 1000);
pollMonitoring();
setInterval(pollMonitoring, 2000);

const dot = $('#conn-dot');
api.subscribe(changed, ok => { dot.className = `dot ${ok ? 'dot--ok' : 'dot--warn'}`; dot.title = ok ? 'live' : 'reconnecting…'; if (ok) changed(); });
setInterval(load, 60_000);                                                  // safety net if the stream is blocked
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
