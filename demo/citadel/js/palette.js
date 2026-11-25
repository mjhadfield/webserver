// Custom theme palettes (Settings → Appearance; docs/themes.md). A theme's mode is set in one of two ways:
//   Basic    — four colours (primary, secondary, third, panel) plus how see-through the panels are; every token below
//              is worked out from those (derive), so a red theme is red all through, not a red accent on violet.
//   Advanced — any token can be set by hand (half.tokens); the rest still come from Basic.
// The values are real hex (#rrggbb, or #rrggbbaa when see-through), not color-mix() strings, so the editor can show
// every one in a colour input. app/appearance.py keeps the same token names (a test checks they match).

// [name, label, group, alpha?]. alpha: the editor offers an opacity range for it.
export const TOKENS = [
  ['--bg', 'Page', 'page'], ['--bg-2', 'Page, raised', 'page'],
  ['--surface', 'Panel', 'page', 1], ['--surface-2', 'Panel 2', 'page', 1], ['--surface-3', 'Panel 3', 'page', 1],
  ['--well', 'Well', 'page', 1], ['--vignette', 'Vignette', 'page', 1],
  ['--accent', 'Accent', 'accent'], ['--accent-hi', 'Accent, bright', 'accent'], ['--accent-soft', 'Accent text', 'accent'],
  ['--accent-deep', 'Accent, deep', 'accent'], ['--accent-wash', 'Accent wash', 'accent', 1], ['--glow-2', 'Second glow', 'accent'],
  ['--silver-hi', 'Text, strong', 'text'], ['--silver', 'Text', 'text'], ['--silver-mute', 'Text, quiet', 'text'], ['--silver-dim', 'Text, faint', 'text'],
  ['--edge', 'Line', 'lines', 1], ['--edge-strong', 'Line, strong', 'lines', 1],
  ['--ok', 'OK', 'status'], ['--warn', 'Warning', 'status'], ['--bad', 'Bad', 'status'],
  ['--heat-1', 'Heat 1', 'status'], ['--heat-2', 'Heat 2', 'status'], ['--heat-3', 'Heat 3', 'status'],
  ['--series-1', 'Series 1', 'charts'], ['--series-2', 'Series 2', 'charts'], ['--series-3', 'Series 3', 'charts'],
  ['--series-4', 'Series 4', 'charts'], ['--series-5', 'Series 5', 'charts'],
  ['--lc-frame', 'Frame', 'lcars'], ['--lc-1', 'Bar 1', 'lcars'], ['--lc-2', 'Bar 2', 'lcars'], ['--lc-3', 'Bar 3', 'lcars'],
  ['--lc-4', 'Bar 4', 'lcars'], ['--lc-5', 'Bar 5', 'lcars'], ['--lc-6', 'Bar 6', 'lcars'], ['--lc-7', 'Attention', 'lcars'],
  ['--lc-red', 'Red', 'lcars'], ['--lc-gig', 'Next gig', 'lcars'], ['--lc-gig-on', 'Text on Next gig', 'lcars'],
  ['--lc-diary', 'Calendar', 'lcars'], ['--lc-on', 'Text on a block', 'lcars'],
  ['--lc-hd-frame', 'Elbow', 'lcars-hd'], ['--lc-hd-1', 'Bookmarks', 'lcars-hd'], ['--lc-hd-2', 'Day/Night', 'lcars-hd'],
  ['--lc-hd-3', 'Style', 'lcars-hd'], ['--lc-hd-4', 'Settings', 'lcars-hd'],
  ['--brg-node', 'Concentric node', 'borg'], ['--brg-frame', 'Console frame', 'borg'], ['--brg-axis', 'Crosshair axis', 'borg'],
  ['--brg-cyan', 'Neural conduit', 'borg'], ['--brg-sub', 'Glyph blue', 'borg'], ['--brg-on', 'Text on a node', 'borg'],
];
export const GROUPS = [['page', 'Page & panels'], ['accent', 'Accent'], ['text', 'Text'], ['lines', 'Lines'], ['status', 'Status'],
  ['charts', 'Charts'], ['lcars', 'LCARS', 'lcars'], ['lcars-hd', 'LCARS phone header', 'lcars'], ['borg', 'Borg', 'borg']];
export const TOKEN_NAMES = TOKENS.map(t => t[0]);
const FAMILY_GROUPS = { lcars: new Set(['lcars', 'lcars-hd']), borg: new Set(['borg']) };
const ALL_FAMILY_GROUPS = new Set(['lcars', 'lcars-hd', 'borg']);
export const tokensFor = family => TOKENS.filter(t => !ALL_FAMILY_GROUPS.has(t[2]) || FAMILY_GROUPS[family]?.has(t[2]));

// The four Basic colours each family starts from (also app/appearance.py BASE).
export const BASE = {
  citadel: { night: { accent: '#8b5cf6', secondary: '#c084fc', third: '#67e8f9', panel: '#0e0b14' },
    day: { accent: '#b5541f', secondary: '#8a2e2e', third: '#3d5a73', panel: '#f8f0e2' } },
  lcars: { night: { accent: '#a78bfa', secondary: '#8577e0', third: '#d3a4ea', panel: '#0e0b14' },
    day: { accent: '#b5541f', secondary: '#8a2e2e', third: '#3d5a73', panel: '#f8f0e2' } },
  borg: { night: { accent: '#2ee86c', secondary: '#d8a328', third: '#5f8c8a', panel: '#090a0c' },
    day: { accent: '#147a3c', secondary: '#9c6d14', third: '#2c6e73', panel: '#f5f7f9' } },
};

// ---- colour maths (sRGB hex <-> OKLab / OKLCh) ------------------------------------------------------------------------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
function parse(hex) {
  const h = String(hex || '#000000').replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return { r: parseInt(n.slice(0, 2), 16) / 255, g: parseInt(n.slice(2, 4), 16) / 255, b: parseInt(n.slice(4, 6), 16) / 255,
    a: n.length >= 8 ? parseInt(n.slice(6, 8), 16) / 255 : 1 };
}
const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function toLab({ r, g, b }) {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromLab([L, A, B2]) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B2) ** 3, m = (L - 0.1055613458 * A - 0.0638541728 * B2) ** 3, s = (L - 0.0894841775 * A - 1.291485548 * B2) ** 3;
  return { r: gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), g: gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s) };
}
const h2 = x => Math.round(clamp(x) * 255).toString(16).padStart(2, '0');
function hex({ r, g, b }, a = 1) { return `#${h2(r)}${h2(g)}${h2(b)}${a < 1 ? h2(a) : ''}`; }

/** CSS color-mix(in oklab, a pct%, b), as hex. */
export function mix(a, pct, b) {
  const p = pct / 100, x = toLab(parse(a)), y = toLab(parse(b));
  return hex(fromLab([0, 1, 2].map(i => x[i] * p + y[i] * (1 - p))));
}
/** The colour at pct% opacity (#rrggbbaa); 100 and over is solid. */
export function alpha(c, pct) { return hex(parse(c), pct >= 100 ? 1 : clamp(pct / 100)); }
/** Adjust in OKLCh: lightness by dL, chroma times cMul. */
export function shade(c, dL = 0, cMul = 1) {
  const [L, A, B2] = toLab(parse(c));
  return hex(fromLab([clamp(L + dL), A * cMul, B2 * cMul]));
}
/** 0..100 opacity of a #rrggbb(aa). */
export const opacityOf = c => Math.round(parse(c).a * 100);
export const solid = c => String(c).slice(0, 7);

// ---- Basic -> every token --------------------------------------------------------------------------------------------
const WHITE = '#ffffff', BLACK = '#000000';
const NIGHT = { ink: ['#e6e9ee', '#c9ced6', '#9aa1ad', '#6b7280'], ok: '#34d399', warn: '#f5b454', bad: '#f43f5e', heat: ['#f3d899', '#f5a742', '#ff4b2b'] };
const DAY = { ink: ['#2a2015', '#4a3c2a', '#6b5c44', '#93876c'], ok: '#3d5a73', warn: '#b0601c', bad: '#8a2e2e', heat: ['#8c6a45', '#b5541f', '#a3302a'] };
const BORG_NIGHT = { ink: ['#eef1f4', '#c2c8cf', '#7d8590', '#4d545e'], ok: '#2ee86c', warn: '#e5b23a', bad: '#f43f5e', heat: ['#d8a328', '#f59e0b', '#ff4b2b'] };
const BORG_DAY = { ink: ['#14181d', '#2d353e', '#586370', '#7c8794'], ok: '#147a3c', warn: '#9c6d14', bad: '#a3262e', heat: ['#6e6b20', '#9c6d14', '#a3262e'] };

/** One mode's Basic colours (missing ones from the family's defaults) -> { token: hex }. */
export function derive(h = {}, mode = 'night', family = 'citadel') {
  const dark = mode !== 'day', base = (BASE[family] || BASE.citadel)[dark ? 'night' : 'day'];
  const P = h.accent || base.accent, S = h.secondary || base.secondary, T = h.third || base.third, N = h.panel || base.panel;
  const o = h.panel_opacity ?? 100, K = family === 'borg' ? (dark ? BORG_NIGHT : BORG_DAY) : (dark ? NIGHT : DAY);
  const see = c => alpha(c, o);
  const ink = K.ink.map(c => mix(c, dark ? 94 : 90, P));
  const v = {
    '--bg': dark ? shade(N, -0.085, 0.8) : shade(N, -0.03, 1.4),
    '--bg-2': dark ? shade(N, -0.04, 0.9) : shade(N, -0.018, 1.2),
    '--surface': see(N), '--surface-2': see(mix(N, 93, dark ? WHITE : BLACK)), '--surface-3': see(mix(N, 86, dark ? WHITE : BLACK)),
    '--well': dark ? '#00000061' : alpha(ink[0], 7), '--vignette': dark ? '#00000073' : alpha(ink[0], 10),
    '--accent': P, '--accent-hi': mix(P, 82, WHITE), '--accent-soft': dark ? mix(P, 55, WHITE) : mix(P, 62, BLACK),
    '--accent-deep': mix(P, 52, BLACK), '--accent-wash': alpha(P, 10), '--glow-2': mix(S, 52, BLACK),
    '--silver-hi': ink[0], '--silver': ink[1], '--silver-mute': ink[2], '--silver-dim': ink[3],
    '--edge': dark ? alpha(mix('#c9ced6', 88, P), 13) : shade(N, -0.1, 2.6),
    '--edge-strong': alpha(P, 45),
    '--ok': K.ok, '--warn': K.warn, '--bad': K.bad, '--heat-1': K.heat[0], '--heat-2': K.heat[1], '--heat-3': K.heat[2],
  };
  const series = dark ? [mix(P, 75, WHITE), ink[0], mix(S, 70, WHITE), mix(T, 80, WHITE), mix(mix(S, 50, T), 70, WHITE)]
    : [P, T, S, ink[2], ink[1]];
  series.forEach((c, i) => { v[`--series-${i + 1}`] = c; });
  if (family === 'lcars') {
    const bg = v['--bg'];
    const lc = dark ? {
      // lighter and darker steps keep their colour (shade), rather than mixing in white or black, which washes them out
      '--lc-frame': P, '--lc-1': P, '--lc-2': shade(P, 0.1, 0.9), '--lc-3': S, '--lc-4': mix('#c9ced6', 85, P), '--lc-5': T,
      '--lc-6': mix('#8f96a3', 80, P), '--lc-7': '#f2b45a', '--lc-red': '#f43f5e',
      '--lc-gig': shade(P, -0.14), '--lc-gig-on': mix(P, 8, WHITE), '--lc-diary': mix(P, 50, T), '--lc-on': mix(bg, 70, BLACK),
      '--lc-hd-frame': shade(P, -0.06), '--lc-hd-1': shade(S, -0.05), '--lc-hd-2': shade(T, -0.07), '--lc-hd-3': shade(mix(P, 50, S), -0.05),
    } : {
      '--lc-frame': P, '--lc-1': P, '--lc-2': mix(P, 70, S), '--lc-3': T, '--lc-4': mix('#7d6b52', 90, P), '--lc-5': S,
      '--lc-6': mix('#5c4a3a', 90, P), '--lc-7': shade(P, 0.05, 1.15), '--lc-red': '#a3302a',
      '--lc-gig': S, '--lc-gig-on': mix(N, 55, WHITE), '--lc-diary': mix(P, 70, S), '--lc-on': mix(N, 55, WHITE),
    };
    if (!dark) Object.assign(lc, { '--lc-hd-frame': lc['--lc-frame'], '--lc-hd-1': lc['--lc-2'], '--lc-hd-2': lc['--lc-4'], '--lc-hd-3': lc['--lc-5'] });
    lc['--lc-hd-4'] = lc['--lc-hd-frame'];
    Object.assign(v, lc);
  }
  if (family === 'borg') {
    const bg = v['--bg'];
    Object.assign(v, {
      '--brg-node': P,
      '--brg-frame': dark ? '#5c6670' : '#6a7480',
      '--brg-axis': S,
      '--brg-cyan': T,
      '--brg-sub': dark ? mix('#556270', 85, T) : mix('#4a5a6e', 85, T),
      '--brg-on': dark ? mix(bg, 75, BLACK) : mix(N, 50, WHITE),
    });
  }
  return v;
}

const DAY_HEADER = { '--lc-hd-frame': '--lc-frame', '--lc-hd-1': '--lc-2', '--lc-hd-2': '--lc-4', '--lc-hd-3': '--lc-5', '--lc-hd-4': '--lc-hd-frame' };

/** Every token for one mode: Basic's, then the Advanced overrides on top (only names this family has). */
export function resolve(h = {}, mode = 'night', family = 'citadel') {
  const v = derive(h, mode, family), names = new Set(tokensFor(family).map(t => t[0]));
  const own = Object.fromEntries(Object.entries(h.tokens || {}).filter(([k]) => names.has(k)));
  Object.assign(v, own);
  // By Day the phone header's blocks are the page's own bar colours, so they follow an override of those bars
  if (family === 'lcars' && mode === 'day') {
    Object.entries(DAY_HEADER).forEach(([k, src]) => { if (!(k in own)) v[k] = v[src]; });
  }
  return v;
}
