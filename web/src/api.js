import { PAL } from './theme.js';
import { useCallback, useEffect, useRef, useState } from 'react';

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // A session that ended (expired or signed out elsewhere): back to sign in, except for the session calls themselves.
  if (res.status === 401 && !path.startsWith('/session') && window.location.pathname !== '/login') {
    window.location.assign(`/login?expired=1&next=${encodeURIComponent(window.location.pathname)}`);
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, field: data.field });
  return data;
}

// Responses are kept for the session, so a screen that remounts (a theme change redraws the story)
// shows its data at once instead of a loading skeleton. reload() always fetches fresh data.
const cache = new Map();

export function useApi(path) {
  const [state, setState] = useState(() => (cache.has(path)
    ? { data: cache.get(path), error: null, loading: false }
    : { data: null, error: null, loading: true }));
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    return api(path)
      .then((data) => { cache.set(path, data); setState({ data, error: null, loading: false }); })
      .catch((error) => setState({ data: null, error, loading: false }));
  }, [path]);
  const cachedAtMount = useRef(cache.has(path));
  useEffect(() => {
    if (cachedAtMount.current) { cachedAtMount.current = false; return; }
    load();
  }, [load]);
  return { ...state, reload: load };
}

export const pct = (v, d = 1) => (v == null ? '—' : `${(Number(v) * 100).toFixed(d)}%`);
export const usd = (v) => (v == null ? '—' : `$${Math.round(Number(v)).toLocaleString('en-US')}`);
export const usdK = (v) => {
  const n = Number(v);
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
};
export const num = (v) => (v == null ? '—' : Math.round(Number(v)).toLocaleString('en-US'));
export const dt = (v) => (v ? String(v).replace('T', ' ').slice(0, 16) : '—');

// Late-delivery causes take the first categorical slots; the routing residual is the neutral grey.
// Colours are read from the live theme palette (theme.js), so they follow light/dark mode.
const cause = (label, slot, issue) => ({
  label, issue,
  color: slot == null ? 'var(--c-residual)' : `var(--s${slot + 1})`,
  get hex() { return slot == null ? PAL.neutral : PAL.series[slot]; },
});
export const CAUSES = {
  address: cause('Incomplete address', 0, 'I1'),
  cutoff: cause('Same-day after 8am cutoff', 1, 'I2'),
  stock: cause('Stock not at nearest warehouse', 2, 'I3'),
  carrier: cause('Non-API carrier (D/E/F)', 3, 'I4'),
  residual: cause('Residual (routing-addressable)', null, 'I6'),
};
export { PAL };
export const COMMITMENT = { same_day: 'Same-day', next_day: 'Next-day', standard: 'Standard' };
