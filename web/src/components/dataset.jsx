// Which data the agents run on: the real history, or an uploaded test dataset. The choice is shared by every
// screen on the page and remembered in this browser.
import { useEffect, useState } from 'react';
import { Database } from 'lucide-react';
import { useApi } from '../api.js';

const KEY = 'halcyon.dataset';
const EVENT = 'halcyon:dataset';

const read = () => {
  try { const v = localStorage.getItem(KEY); return v ? Number(v) : null; } catch { return null; }
};

/** [datasetId | null, setDataset]; null = the real history. */
export function useDataset() {
  const [id, setId] = useState(read);
  useEffect(() => {
    const on = (e) => setId(e.detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const set = (next) => {
    try { if (next == null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(next)); } catch { /* private window */ }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  };
  return [id, set];
}

const span = (d) => (d.days.length > 1 ? `${d.days[0]} to ${d.days.at(-1)}` : d.days[0]);

/** "Data: Real history ▾" selector for screens that run the agents. */
export function DataPicker() {
  const [id, setId] = useDataset();
  const { data, reload } = useApi('/agents/datasets');
  useEffect(() => { reload(); }, [id, reload]);
  const sets = data?.datasets || [];
  const known = id == null || sets.some((d) => d.id === id);
  return (
    <label className="row data-picker" style={{ gap: 8 }}>
      <Database size={15} />
      <span className="small muted">Data</span>
      <select className="input" value={known ? (id ?? '') : ''} onChange={(e) => setId(e.target.value === '' ? null : Number(e.target.value))} aria-label="Data the agents run on">
        <option value="">Real history (Apr–Sep 2026)</option>
        {sets.map((d) => <option key={d.id} value={d.id}>Test: {d.name} · {d.rows.toLocaleString('en-US')} orders · {span(d)}</option>)}
      </select>
    </label>
  );
}
