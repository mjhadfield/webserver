// Themes. A device picks two things, independently, from the header:
//   - the mode, Day or Night (one button), and
//   - the theme (a small menu): the built-in Citadel or LCARS, or a custom theme (Settings → Appearance).
// Every theme has both modes. Both choices are this device's own, kept in localStorage along with a ready-to-apply copy
// of a custom theme's colours (theme-init.js applies that copy before first paint, so nothing flashes the wrong look).
//
// On the page: Day is html[data-theme="light"] (the name every stylesheet already keys off) and the LCARS theme is
// html[data-skin="lcars"] (web/css/lcars.css, loaded on the dashboard only). A custom theme is built on Citadel or
// LCARS and overrides, separately for Day and for Night, the accent, the panel colour and how see-through the panels
// are, and can add a background picture behind everything.

const MODE_KEY = 'mode';           // 'day' | 'night'
const LOOK_KEY = 'look';           // 'citadel' | 'lcars' | 'c:<custom theme id>'
const SPEC_KEY = 'look-spec';      // the chosen custom theme's computed CSS for both modes, for theme-init.js
const VAR_NAMES = ['--accent', '--accent-hi', '--accent-soft', '--accent-deep', '--accent-wash', '--edge-strong', '--surface', '--surface-2', '--surface-3',
  '--bg-image', '--bg-dim', '--bg-size', '--bg-repeat', '--bg-pos', '--lc-1', '--lc-2'];

export const THEMES = [{ id: 'citadel', name: 'Citadel', skin: 'citadel' }, { id: 'lcars', name: 'LCARS', skin: 'lcars' }];

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window: this device just won't remember */ } },
};

const mix = (a, pct, b) => `color-mix(in oklab, ${a} ${pct}%, ${b})`;
const see = (c, pct) => (pct >= 100 ? c : `color-mix(in srgb, ${c} ${pct}%, transparent)`);
const FIT = { cover: ['cover', 'no-repeat', 'center'], contain: ['contain', 'no-repeat', 'center'], tile: ['auto', 'repeat', 'top left'], center: ['auto', 'no-repeat', 'center'] };

/** One mode's half of a custom theme -> { vars, bg, glow }. */
function half(h = {}, m, skin) {
  const dark = m === 'night', a = h.accent, p = h.panel, o = h.panel_opacity ?? 100;
  const vars = {
    '--accent': a,
    '--accent-hi': mix(a, 82, '#fff'),
    '--accent-soft': dark ? mix(a, 55, '#fff') : mix(a, 62, '#000'),        // text-safe: lighter on dark, darker on light
    '--accent-deep': mix(a, 52, '#000'),
    '--accent-wash': `color-mix(in srgb, ${a} 10%, transparent)`,
    '--edge-strong': `color-mix(in srgb, ${a} 45%, transparent)`,
    '--surface': see(p, o),
    '--surface-2': see(mix(p, 93, dark ? '#fff' : '#000'), o),
    '--surface-3': see(mix(p, 86, dark ? '#fff' : '#000'), o),
  };
  if (skin === 'lcars') Object.assign(vars, { '--lc-1': a, '--lc-2': dark ? mix(a, 60, '#fff') : mix(a, 75, '#fff') });   // the frame and highlight bars
  const bg = h.background || {};
  if (bg.file) {
    const [size, repeat, pos] = FIT[bg.fit] || FIT.cover;
    Object.assign(vars, { '--bg-image': `url("${new URL(`backgrounds/${bg.file}`, document.baseURI).href}")`, '--bg-dim': `${bg.dim ?? 40}%`, '--bg-size': size, '--bg-repeat': repeat, '--bg-pos': pos });
  }
  return { vars, bg: !!bg.file, glow: bg.glow !== false };
}

/** A custom theme -> { skin, day, night } ready to apply. */
export function specOf(t) {
  const skin = t.skin === 'lcars' ? 'lcars' : 'citadel';
  return { skin, day: half(t.day, 'day', skin), night: half(t.night, 'night', skin) };
}

/** This device's mode: 'day' or 'night'. */
export function mode() { return store.get(MODE_KEY) === 'day' ? 'day' : 'night'; }

/** This device's chosen theme id: 'citadel', 'lcars' or a custom theme's id. */
export function look() {
  const v = store.get(LOOK_KEY);
  return v === 'lcars' ? 'lcars' : v?.startsWith('c:') ? v.slice(2) : 'citadel';
}

function storedSpec() {
  if (!store.get(LOOK_KEY)?.startsWith('c:')) return null;
  try { return JSON.parse(store.get(SPEC_KEY) || 'null'); } catch { return null; }
}

/** Put a mode + theme on the page. With no arguments: this device's own choice. Exported for the editor's live preview. */
export function applySpec(spec = storedSpec(), m = mode(), skin = spec ? spec.skin : (look() === 'lcars' ? 'lcars' : 'citadel')) {
  const root = document.documentElement;
  if (m === 'day') root.dataset.theme = 'light'; else delete root.dataset.theme;
  if (skin === 'lcars') root.dataset.skin = 'lcars'; else delete root.dataset.skin;
  VAR_NAMES.forEach(n => root.style.removeProperty(n));
  root.classList.remove('has-bg', 'no-glow');
  const h = spec?.[m];
  if (!h) return;
  Object.entries(h.vars).forEach(([k, v]) => root.style.setProperty(k, v));
  root.classList.toggle('has-bg', h.bg);
  root.classList.toggle('no-glow', !h.glow);
}

const changed = () => document.dispatchEvent(new CustomEvent('theme:change', { detail: { base: currentTheme(), skin: currentSkin() } }));

// The same device's other pages follow a change at once: the dashboard and the Settings page it frames (and any other
// open tab). The browser tells every other page of this origin when localStorage changes.
addEventListener('storage', e => {
  if (e.key !== null && ![MODE_KEY, LOOK_KEY, SPEC_KEY].includes(e.key)) return;
  applySpec();
  changed();
});

/** Switch this device between Day and Night (whatever theme it uses). */
export function setMode(m) {
  store.set(MODE_KEY, m === 'day' ? 'day' : 'night');
  applySpec();
  changed();
}

/** Use a theme on this device. `customs` is the list of custom themes (from the server). */
export function setLook(id, customs = []) {
  const t = customs.find(x => x.id === id);
  if (t) { store.set(LOOK_KEY, `c:${id}`); store.set(SPEC_KEY, JSON.stringify(specOf(t))); }
  else { store.set(LOOK_KEY, id === 'lcars' ? 'lcars' : 'citadel'); store.set(SPEC_KEY, null); }
  applySpec();
  changed();
}

/** After the server's list arrives: re-apply this device's theme (it may have been edited elsewhere, or deleted). */
export function syncThemes(customs = []) {
  const id = look();
  if (id === 'citadel' || id === 'lcars') return;
  const t = customs.find(x => x.id === id);
  const fresh = t ? JSON.stringify(specOf(t)) : null;
  if (fresh !== store.get(SPEC_KEY) || !t) setLook(t ? id : 'citadel', customs);
}

/** What an embedded page (Music Companion, Music DB Explorer, Odysseus, Home Improvements) needs to look the same:
 * the mode as dark/light, a custom theme's colours for that mode (they use the same variable names; the LCARS bar
 * colours stay here), and whether Citadel is drawing a background picture behind them — if so they make their own
 * page backdrop see-through and the picture shows through the frame. */
export function currentLook() {
  const h = storedSpec()?.[mode()];
  const vars = h ? Object.fromEntries(Object.entries(h.vars).filter(([k]) => !k.startsWith('--bg-') && !k.startsWith('--lc-'))) : null;
  return { type: 'citadel-theme', theme: currentTheme(), vars, bg: !!h?.bg, glow: h ? h.glow : true };
}

/** 'dark' or 'light' — the mode, in the words embedded pages know. */
export function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** 'citadel' or 'lcars' — the built-in theme this device's look is built on. */
export function currentSkin() {
  return document.documentElement.dataset.skin === 'lcars' ? 'lcars' : 'citadel';
}
