// Themes, styles and modes. A device picks three things independently (kept in localStorage):
//   - mode:   'day' | 'night' (header Day/Night button)
//   - theme:  'citadel' | 'lcars' | 'lcars25' | 'borg' (page design: layout, shapes, fonts, motion)
//   - style:  '<builtin id>' (standard, com, sci, eng, ent) or 'c:<custom id>' (colour variant of the theme's family)
//
// Every style has a Day half and a Night half. LCARS and LCARS 25 share the 'lcars' family, so built-in LCARS styles
// and custom LCARS styles work on both. Switching across families restores the last-used style for the target family.
//
// On <html>:
//   data-mode="day|night"      (always present)
//   data-theme="<theme id>"    (citadel | lcars | lcars25 | borg)
//   data-family="<family>"     (citadel | lcars | borg)
// Non-Standard styles (built-in COM/SCI/ENG/ENT and custom styles) cache their resolved vars in `style-spec` so
// theme-init.js applies them before first paint.

import { TOKEN_NAMES, resolve, tokensFor } from './palette.js';
import { THEMES, FAMILIES, FAMILY_LABEL, BUILTIN_STYLES, normTheme, normFamily, themeById, familyOf, builtinStyle, stylesForFamily } from './themes.js';

export { THEMES, FAMILIES, FAMILY_LABEL, BUILTIN_STYLES, normTheme, normFamily, themeById, familyOf, builtinStyle, stylesForFamily };

const MODE_KEY = 'mode';                     // 'day' | 'night'
const THEME_KEY = 'theme';                   // 'citadel' | 'lcars' | 'lcars25' | 'borg'
const STYLE_KEY = 'style';                   // '<builtin id>' | 'c:<custom id>'
const SPEC_KEY = 'style-spec';               // resolved CSS vars for both modes, for theme-init.js
const BY_FAM_KEY = 'style-by-family';        // JSON { [family]: styleKey } — remembers last-used style per family
const BG_VARS = ['--bg-image', '--bg-dim', '--bg-size', '--bg-repeat', '--bg-pos'];
const VAR_NAMES = [...TOKEN_NAMES, ...BG_VARS];

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window */ } },
};

const FIT = { cover: ['cover', 'no-repeat', 'center'], contain: ['contain', 'no-repeat', 'center'], tile: ['auto', 'repeat', 'top left'], center: ['auto', 'no-repeat', 'center'] };

/** One mode's half of a style -> { vars, bg, glow }: every token from its Basic colours, its Advanced overrides
 * on top (palette.js), then the background picture. */
function half(h = {}, m, fam) {
  const vars = resolve(h, m, fam);
  const bg = h.background || {};
  if (bg.file) {
    const [size, repeat, pos] = FIT[bg.fit] || FIT.cover;
    Object.assign(vars, { '--bg-image': `url("${new URL(`backgrounds/${bg.file}`, document.baseURI).href}")`, '--bg-dim': `${bg.dim ?? 40}%`, '--bg-size': size, '--bg-repeat': repeat, '--bg-pos': pos });
  }
  return { vars, bg: !!bg.file, glow: bg.glow !== false };
}

/** A style entry ({ family, day, night }) -> { family, day, night } ready to apply. */
export function specOf(s, fallbackFamily) {
  const fam = normFamily(s.family || fallbackFamily);
  return { family: fam, day: half(s.day, 'day', fam), night: half(s.night, 'night', fam) };
}

/** This device's mode: 'day' or 'night'. */
export function mode() { return store.get(MODE_KEY) === 'day' ? 'day' : 'night'; }

/** This device's chosen theme id: 'citadel', 'lcars', 'lcars25' or 'borg'. */
export function theme() { return normTheme(store.get(THEME_KEY)); }

/** This device's active family: 'citadel', 'lcars' or 'borg'. */
export function family() { return familyOf(theme()); }

/** This device's chosen style key: '<builtin id>' (e.g. 'standard', 'com') or 'c:<custom id>'. */
export function style() { return store.get(STYLE_KEY) || 'standard'; }

function readByFamily() {
  try {
    const v = JSON.parse(store.get(BY_FAM_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

function rememberFamilyStyle(fam, styleKey) {
  const map = readByFamily();
  map[fam] = styleKey;
  store.set(BY_FAM_KEY, JSON.stringify(map));
}

function storedSpec() {
  if (style() === 'standard') return null;
  try { return JSON.parse(store.get(SPEC_KEY) || 'null'); } catch { return null; }
}

/** Resolve a styleKey ('standard' | 'com' | ... | 'c:<id>') for a family against custom styles.
 * Returns { key, spec } where spec is null for 'standard'. */
function resolveStyleChoice(fam, styleKey, customs = []) {
  if (!styleKey || styleKey === 'standard') return { key: 'standard', spec: null };
  if (styleKey.startsWith('c:')) {
    const cid = styleKey.slice(2);
    const custom = customs.find(x => x.id === cid && normFamily(x.family) === fam);
    if (custom) return { key: styleKey, spec: specOf(custom, fam) };
    return { key: 'standard', spec: null };
  }
  const built = builtinStyle(fam, styleKey);
  if (built && built.id !== 'standard') return { key: built.id, spec: specOf(built, fam) };
  return { key: 'standard', spec: null };
}

/** Put a mode + theme + style spec on the page. With no arguments: this device's own choice.
 * Exported for the Settings style editor's live preview. */
export function applySpec(spec = storedSpec(), m = mode(), t = theme()) {
  const root = document.documentElement;
  const resolvedTheme = normTheme(t);
  const fam = spec?.family ? normFamily(spec.family) : familyOf(resolvedTheme);
  // If previewing a different family than the current theme, show that family's canonical theme
  const shownTheme = familyOf(resolvedTheme) === fam ? resolvedTheme : fam;
  root.dataset.mode = m === 'day' ? 'day' : 'night';
  root.dataset.theme = shownTheme;
  root.dataset.family = fam;
  VAR_NAMES.forEach(n => root.style.removeProperty(n));
  root.classList.remove('has-bg', 'no-glow');
  const h = spec?.[m === 'day' ? 'day' : 'night'];
  if (!h) return;
  Object.entries(h.vars).forEach(([k, v]) => root.style.setProperty(k, v));
  root.classList.toggle('has-bg', h.bg);
  root.classList.toggle('no-glow', !h.glow);
}

const changed = () => document.dispatchEvent(new CustomEvent('theme:change', {
  detail: { mode: mode(), theme: theme(), family: family(), style: style() },
}));

// Other pages on this origin (Settings iframe, open tabs) follow changes straight away.
addEventListener('storage', e => {
  if (e.key !== null && ![MODE_KEY, THEME_KEY, STYLE_KEY, SPEC_KEY].includes(e.key)) return;
  applySpec();
  changed();
});

/** Switch this device between Day and Night. */
export function setMode(m) {
  store.set(MODE_KEY, m === 'day' ? 'day' : 'night');
  applySpec();
  changed();
}

/** Switch this device's theme ('citadel' | 'lcars' | 'lcars25' | 'borg').
 * Keeps the active style when staying in the same family (e.g. LCARS <-> LCARS 25);
 * when changing family, restores the last-used style for the target family (or 'standard'). */
export function setTheme(themeId, customs = []) {
  const prevFam = family();
  const nextTheme = normTheme(themeId);
  const nextFam = familyOf(nextTheme);
  let nextStyleKey = style();
  let nextSpec = storedSpec();

  if (nextFam !== prevFam) {
    rememberFamilyStyle(prevFam, style());
    const remembered = readByFamily()[nextFam] || 'standard';
    const resolved = resolveStyleChoice(nextFam, remembered, customs);
    nextStyleKey = resolved.key;
    nextSpec = resolved.spec;
  } else {
    // Re-resolve against customs/builtins so non-standard built-in specs are always fresh
    const resolved = resolveStyleChoice(nextFam, nextStyleKey, customs);
    nextStyleKey = resolved.key;
    nextSpec = resolved.spec;
  }

  store.set(THEME_KEY, nextTheme);
  store.set(STYLE_KEY, nextStyleKey);
  store.set(SPEC_KEY, nextSpec ? JSON.stringify(nextSpec) : null);
  rememberFamilyStyle(nextFam, nextStyleKey);
  applySpec();
  changed();
}

/** Switch this device's style within the current theme's family.
 * Accepts a built-in style id ('standard', 'com', ...), 'c:<custom id>', or a raw custom id. */
export function setStyle(styleId, customs = []) {
  const fam = family();
  let key = styleId || 'standard';
  if (!key.startsWith('c:') && !builtinStyle(fam, key) && customs.some(x => x.id === key && normFamily(x.family) === fam)) {
    key = `c:${key}`;
  }
  const { key: resolvedKey, spec } = resolveStyleChoice(fam, key, customs);
  store.set(STYLE_KEY, resolvedKey);
  store.set(SPEC_KEY, spec ? JSON.stringify(spec) : null);
  rememberFamilyStyle(fam, resolvedKey);
  applySpec();
  changed();
}

/** After the server's custom styles arrive: migrate any dropped seeded-preset UUID, refresh edited custom specs,
 * or fall back to 'standard' if the active custom style was deleted. A missing/non-array `customs` (e.g. a reload
 * before hub restarts after an upgrade) is ignored so devices never lose their style. */
export function syncStyles(customs, migratedPresets = {}) {
  if (!Array.isArray(customs)) return;
  const fam = family();
  let cur = style();
  // Map a dropped seeded preset (e.g. old UUID of LCARS (COM)) to its built-in style id ('com')
  if (cur.startsWith('c:')) {
    const cid = cur.slice(2);
    if (migratedPresets && migratedPresets[cid]) {
      setStyle(migratedPresets[cid], customs);
      return;
    }
    const found = customs.find(x => x.id === cid && normFamily(x.family) === fam);
    if (!found) {
      // If a corrupt/missing look-spec migrated this custom style to the wrong family, move to its actual family
      const other = customs.find(x => x.id === cid);
      if (other) {
        const otherFam = normFamily(other.family);
        store.set(THEME_KEY, otherFam);
        setStyle(cur, customs);
        return;
      }
    }
    const fresh = found ? JSON.stringify(specOf(found, fam)) : null;
    if (!found || fresh !== store.get(SPEC_KEY)) {
      setStyle(found ? cur : 'standard', customs);
    }
    return;
  }
  // Built-in non-Standard style: ensure style-spec is populated and up to date
  if (cur !== 'standard') {
    const built = builtinStyle(fam, cur);
    const fresh = built ? JSON.stringify(specOf(built, fam)) : null;
    if (!built || fresh !== store.get(SPEC_KEY)) {
      setStyle(built ? cur : 'standard', customs);
    }
  }
}

/** Contract v2 payload for framed apps using the Citadel Theme Kit (docs/features/embedded-theming.md).
 * Always includes every resolved shared + active-family colour token (including built-in styles),
 * and never includes --bg-image or its siblings. */
export function currentLook() {
  const m = mode();
  const t = theme();
  const fam = family();
  const st = style();
  const h = storedSpec()?.[m];
  const allowedNames = tokensFor(fam).map(x => x[0]);
  let vars;
  if (h) {
    vars = Object.fromEntries(allowedNames.filter(k => k in h.vars && !BG_VARS.includes(k)).map(k => [k, h.vars[k]]));
  } else {
    const cs = getComputedStyle(document.documentElement);
    vars = Object.fromEntries(allowedNames.map(k => [k, cs.getPropertyValue(k).trim()]).filter(([, v]) => v));
  }
  return {
    type: 'citadel-theme',
    v: 2,
    mode: m,
    theme: t,
    family: fam,
    style: st,
    vars,
    bg: !!h?.bg,
    glow: h ? h.glow : true,
  };
}

/** Contract v1 payload kept permanently for Odysseus (light/dark mode swap only; Mike, 2026-11-23). */
export function currentLookV1() {
  return { type: 'citadel-theme', theme: currentTheme() };
}

/** 'dark' or 'light' — the mode, for Odysseus's v1 query param and message. */
export function currentTheme() {
  return document.documentElement.dataset.mode === 'day' ? 'light' : 'dark';
}

/** Active family ('citadel' | 'lcars' | 'borg') on <html>. */
export function currentFamily() {
  return normFamily(document.documentElement.dataset.family);
}
