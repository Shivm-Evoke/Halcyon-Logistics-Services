// Light and dark themes.
// CSS handles everything it can through variables (index.css). Charts draw SVG attributes, which cannot
// read CSS variables, so their colours come from PAL: a live object updated by applyTheme() and read
// while components render. Never copy PAL values into module-level constants: they would go stale.
//
// Both categorical sets are validated (dataviz validate_palette.js): light on #ffffff, dark on #1a1a19.
// Dark is its own set of steps, not an automatic inversion.

const PALETTES = {
  light: {
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'],
    neutral: '#c9c5ba',
    status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' },
    // Ordinal blue ramp for ordered scenarios: [neutral start, then light → strong].
    ramp: ['#c9c5ba', '#86b6ef', '#5598e7', '#1c5cab'],
    surface: '#ffffff',
    ink: '#15171c',
    ink2: '#4b4a46',
    muted: '#85837c',
    grid: '#ece9e1',
    base: '#d8d4c9',
    benchmark: '#0b6b1e',
    cursor: 'rgba(21, 23, 28, 0.04)',
    heat: '42, 120, 214',
    trophy: '#b07800',
  },
  dark: {
    series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'],
    neutral: '#5e5d58',
    status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' },
    ramp: ['#5e5d58', '#1c5cab', '#2a78d6', '#6da7ec'],
    surface: '#1a1a19',
    ink: '#f0efec',
    ink2: '#c3c2b7',
    muted: '#898781',
    grid: '#2c2c2a',
    base: '#45443f',
    benchmark: '#3fbf5a',
    cursor: 'rgba(255, 255, 255, 0.05)',
    heat: '57, 135, 229',
    trophy: '#f0b429',
  },
};

export const PAL = { ...PALETTES.light };

const STORAGE_KEY = 'halcyon-theme';
const media = () => window.matchMedia?.('(prefers-color-scheme: dark)');

/** The saved choice: 'light' | 'dark' | 'system'. Storage can be unavailable (private mode), so default safely. */
export function savedChoice() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export const resolve = (choice) => (choice === 'system' ? (media()?.matches ? 'dark' : 'light') : choice);

/** Applies a choice to the document and to PAL; returns the resolved mode. */
export function applyTheme(choice) {
  const mode = resolve(choice);
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme; else root.dataset.theme = choice;
  // Match system keeps the dark sidebar in both page themes; light and dark give the sidebar their own palette.
  if (choice === 'system') root.dataset.nav = 'dark'; else delete root.dataset.nav;
  root.style.colorScheme = mode;
  Object.assign(PAL, PALETTES[mode]);
  try {
    if (choice === 'system') localStorage.removeItem(STORAGE_KEY); else localStorage.setItem(STORAGE_KEY, choice);
  } catch { /* storage unavailable: the choice lasts for this visit only */ }
  return mode;
}

export function onSystemChange(callback) {
  const m = media();
  if (!m) return () => {};
  m.addEventListener('change', callback);
  return () => m.removeEventListener('change', callback);
}
