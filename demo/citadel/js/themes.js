// Theme, family and built-in style registry.
// Mirrored in app/appearance.py — tests/test_appearance.py asserts both stay in sync.

export const FAMILIES = ['citadel', 'lcars', 'borg'];

export const FAMILY_LABEL = {
  citadel: 'Citadel',
  lcars: 'LCARS',
  borg: 'Borg',
};

export const THEMES = [
  { id: 'citadel', name: 'Citadel', family: 'citadel' },
  { id: 'lcars', name: 'LCARS', family: 'lcars' },
  { id: 'lcars25', name: 'LCARS 25', family: 'lcars' },
  { id: 'borg', name: 'Borg', family: 'borg' },
];

const NO_PICTURE = { file: '', fit: 'cover', dim: 40, glow: true };

// Built-in styles per family. Each entry has the same { id, name, day, night } shape as a custom style.
// 'standard' is each family's default palette (CSS rules apply untouched when chosen; its Basic four match BASE).
export const BUILTIN_STYLES = {
  citadel: [
    {
      id: 'standard',
      name: 'Standard',
      night: {
        accent: '#8b5cf6', secondary: '#c084fc', third: '#67e8f9', panel: '#0e0b14',
        panel_opacity: 100, background: { ...NO_PICTURE }, tokens: {},
      },
      day: {
        accent: '#b5541f', secondary: '#8a2e2e', third: '#3d5a73', panel: '#f8f0e2',
        panel_opacity: 100, background: { ...NO_PICTURE }, tokens: {},
      },
    },
  ],
  lcars: [
    {
      id: 'standard',
      name: 'Standard',
      night: {
        accent: '#a78bfa', secondary: '#8577e0', third: '#d3a4ea', panel: '#0e0b14',
        panel_opacity: 100, background: { ...NO_PICTURE }, tokens: {},
      },
      day: {
        accent: '#b5541f', secondary: '#8a2e2e', third: '#3d5a73', panel: '#f8f0e2',
        panel_opacity: 100, background: { ...NO_PICTURE }, tokens: {},
      },
    },
    {
      id: 'com',
      name: 'COM',
      night: {
        accent: '#e02b2b', secondary: '#ff7a1f', third: '#f5a524', panel: '#140909',
        panel_opacity: 100, background: { ...NO_PICTURE },
        tokens: { '--bg': '#0b0404', '--lc-4': '#d9a07a', '--lc-7': '#ffd866', '--lc-gig': '#a8141e', '--lc-hd-frame': '#c41f1f' },
      },
      day: {
        accent: '#a8191c', secondary: '#bf3a12', third: '#3d5a73', panel: '#f8f0e2',
        panel_opacity: 100, background: { ...NO_PICTURE },
        tokens: { '--lc-4': '#7d6b52', '--lc-gig': '#6e1212' },
      },
    },
    {
      id: 'sci',
      name: 'SCI',
      night: {
        accent: '#2f72ff', secondary: '#22c3ff', third: '#25c4a4', panel: '#070b14',
        panel_opacity: 100, background: { ...NO_PICTURE },
        tokens: { '--bg': '#03060c', '--lc-4': '#9db3d1', '--lc-gig': '#2c55c9', '--lc-hd-frame': '#1f5be0' },
      },
      day: {
        accent: '#1d4f91', secondary: '#1f6f86', third: '#b5541f', panel: '#f8f0e2',
        panel_opacity: 100, background: { ...NO_PICTURE },
        tokens: { '--lc-4': '#6b6a62', '--lc-gig': '#173a6b' },
      },
    },
    {
      id: 'eng',
      name: 'ENG',
      night: {
        accent: '#f5a300', secondary: '#ff6f1a', third: '#8c9bff', panel: '#120d05',
        panel_opacity: 100, background: { ...NO_PICTURE },
        tokens: { '--bg': '#0a0703', '--lc-4': '#ddbb99', '--lc-7': '#ff6b57', '--lc-gig': '#b35c00', '--lc-diary': '#f08c3c', '--lc-hd-frame': '#e09500' },
      },
      day: {
        accent: '#9a6400', secondary: '#b5541f', third: '#3d5a73', panel: '#f8f0e2',
        panel_opacity: 100, background: { ...NO_PICTURE },
        tokens: { '--lc-4': '#7d6b52', '--lc-7': '#a8191c', '--lc-gig': '#7a4a00' },
      },
    },
    {
      id: 'ent',
      name: 'ENT',
      night: {
        accent: '#c3cad6', secondary: '#8d99ad', third: '#5c8fd6', panel: '#0d0f13',
        panel_opacity: 100, background: { ...NO_PICTURE },
        tokens: { '--bg': '#060709', '--lc-gig': '#3b5b8f', '--lc-gig-on': '#eef2f8', '--lc-hd-frame': '#aab3c2' },
      },
      day: {
        accent: '#4a5568', secondary: '#6b7a90', third: '#2f5f9e', panel: '#f1f2f4',
        panel_opacity: 100, background: { ...NO_PICTURE },
        tokens: { '--silver-hi': '#1d232c', '--silver': '#3a4350', '--silver-mute': '#5b6575', '--silver-dim': '#8a93a1', '--lc-4': '#8a93a1', '--lc-gig': '#2f4f86' },
      },
    },
  ],
  borg: [
    {
      id: 'standard',
      name: 'Obsidian',
      night: {
        accent: '#2ee86c', secondary: '#d8a328', third: '#5f8c8a', panel: '#090a0c',
        panel_opacity: 100, background: { ...NO_PICTURE }, tokens: {},
      },
      day: {
        accent: '#147a3c', secondary: '#9c6d14', third: '#2c6e73', panel: '#f5f7f9',
        panel_opacity: 100, background: { ...NO_PICTURE }, tokens: {},
      },
    },
    {
      id: 'neon',
      name: 'Neon',
      night: {
        accent: '#2ee86c', secondary: '#d8a328', third: '#26c6b8', panel: '#060e08',
        panel_opacity: 100, background: { ...NO_PICTURE },
        tokens: {
          '--bg': '#030704', '--bg-2': '#060d08', '--surface': '#060e08', '--surface-2': '#09150d', '--surface-3': '#0e2014',
          '--well': '#0008038c', '--vignette': '#0006029e', '--accent-hi': '#5eff91', '--accent-soft': '#86f7a9',
          '--accent-deep': '#0d4d24', '--accent-wash': '#2ee86c1c', '--glow-2': '#24c96b',
          '--silver-hi': '#e4f5e9', '--silver': '#b8d4be', '--silver-mute': '#7aa084', '--silver-dim': '#4d6f57',
          '--edge': '#2ee86c38', '--edge-strong': '#2ee86c8f',
          '--brg-frame': '#2ee86c', '--brg-sub': '#6684b5', '--brg-on': '#030805',
        },
      },
      day: {
        accent: '#167a3e', secondary: '#9c6d14', third: '#186b6e', panel: '#f3f7f4',
        panel_opacity: 100, background: { ...NO_PICTURE },
        tokens: {
          '--bg': '#e8efe9', '--bg-2': '#edf4ee', '--surface': '#f3f7f4', '--surface-2': '#f7faf8', '--surface-3': '#fbfdfb',
          '--well': '#11211712', '--vignette': '#1121171c', '--accent-hi': '#1c944c', '--accent-soft': '#115c2f',
          '--accent-deep': '#0c4523', '--accent-wash': '#167a3e1a', '--glow-2': '#167a3e',
          '--silver-hi': '#112117', '--silver': '#263d2e', '--silver-mute': '#476351', '--silver-dim': '#6f8a78',
          '--edge': '#167a3e3d', '--edge-strong': '#167a3e8c',
          '--brg-frame': '#167a3e', '--brg-sub': '#3f5c80', '--brg-on': '#f4fbf6',
        },
      },
    },
  ],
};

const THEME_BY_ID = Object.fromEntries(THEMES.map(t => [t.id, t]));
const FAMILY_SET = new Set(FAMILIES);

export function normTheme(id) {
  if (id === 'lcars2') return 'lcars25';
  return id in THEME_BY_ID ? id : 'citadel';
}

export function normFamily(f) {
  if (f === 'lcars2') return 'lcars';
  return FAMILY_SET.has(f) ? f : 'citadel';
}

export const themeById = id => THEME_BY_ID[normTheme(id)];
export const familyOf = id => themeById(id).family;
export const stylesForFamily = fam => BUILTIN_STYLES[normFamily(fam)] || BUILTIN_STYLES.citadel;
export const builtinStyle = (fam, styleId) => stylesForFamily(fam).find(s => s.id === styleId) || null;
