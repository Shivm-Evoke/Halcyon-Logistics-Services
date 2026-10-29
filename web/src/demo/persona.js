// Demo personas. No real authentication: the chosen persona is kept per browser tab (sessionStorage), so three tabs can
// show the customer, Halcyon ops and the analyst side by side.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

export const PERSONAS = {
  client: { label: 'Customer', who: 'Client 190 · Tier 1 · Southeast', account: 'orders@client190.demo', home: '/portal', client_id: 'C190' },
  ops: { label: 'Halcyon Ops', who: 'Warehouse supervisor · W3 Southeast', account: 'supervisor.w3@halcyon.demo', home: '/ops' },
  analyst: { label: 'Analyst / Judge', who: 'Full analysis console', account: 'judge@halcyon.demo', home: '/' },
};

const KEY = 'halcyon.persona';
const read = () => { try { return sessionStorage.getItem(KEY); } catch { return null; } };

export const getPersona = () => (PERSONAS[read()] ? read() : null);
export function setPersona(key) {
  try { if (key) sessionStorage.setItem(KEY, key); else sessionStorage.removeItem(KEY); } catch { /* private mode: persona lasts this page only */ }
}

/** Fetches `path` now and every `ms` milliseconds; `reload()` fetches at once. Pass null to pause. */
export function usePoll(path, ms = 3000) {
  const [state, setState] = useState({ data: null, error: null });
  const load = useCallback(() => (path ? api(path).then((data) => setState({ data, error: null })).catch((error) => setState((s) => ({ ...s, error }))) : Promise.resolve()), [path]);
  useEffect(() => {
    if (!path) return undefined;
    load();
    const t = setInterval(load, ms);
    return () => clearInterval(t);
  }, [path, ms, load]);
  return { ...state, reload: load };
}

// The demo clock: every portal order is placed at this time, so the 08:00 cutoff and 13:00 second wave always apply.
export const DEMO_NOW = { iso: '2026-10-27T10:15', label: 'Tue 27 Oct, 10:15' };
