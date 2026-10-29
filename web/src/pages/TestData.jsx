import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UploadCloud, Download, PlayCircle, LineChart as LineChartIcon, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useApi, num } from '../api.js';
import { PageHead, Card, Badge, Loading } from '../components/ui.jsx';
import { useDataset } from '../components/dataset.jsx';

const MAX_BYTES = 25 * 1024 * 1024;

async function upload(file, name) {
  const res = await fetch(`/api/agents/datasets?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: await file.text() });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, ...data };
}

export default function TestData() {
  const list = useApi('/agents/datasets');
  const [current, setDataset] = useDataset();
  const navigate = useNavigate();
  const input = useRef(null);
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const pick = (f) => {
    if (!f) return;
    setResult(f.size > MAX_BYTES ? { ok: false, error: 'The file is larger than 25 MB' } : null);
    setFile(f);
    setName((n) => n || f.name.replace(/\.csv$/i, ''));
  };
  const send = async () => {
    setBusy(true);
    try {
      const r = await upload(file, name);
      setResult(r);
      if (r.ok) { setFile(null); setName(''); list.reload(); }
    } catch (e) { setResult({ ok: false, error: e.message }); } finally { setBusy(false); }
  };
  const use = (id, to) => { setDataset(id); navigate(to); };

  if (!list.data) return <Loading error={list.error} />;
  const { datasets, required, optional } = list.data;

  return (
    <>
      <PageHead title="Test data" eyebrow="Try it · run the agents on your own orders">
        Drop a CSV of orders here and the agents run on it exactly as they do on the history: the same rules, limits and
        explanations. Test data is stored on its own and never changes the real numbers. Then choose it in the Data selector on
        Operations day or Results.
      </PageHead>

      <div className="grid g3 section-gap">
        <Card title="Upload a CSV" sub="Same columns as the hackathon's deliveries.csv." className="span2">
          <div className={`dropzone${over ? ' over' : ''}`} role="button" tabIndex={0}
            onClick={() => input.current?.click()} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}>
            <UploadCloud size={28} />
            <div><b>{file ? file.name : 'Drop a CSV file here'}</b></div>
            <div className="small muted">{file ? `${num(file.size / 1024)} KB` : 'or click to choose one · up to 25 MB, 100,000 orders'}</div>
            <input ref={input} type="file" accept=".csv,text/csv" hidden data-testid="dataset-file" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          </div>
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <input className="input" style={{ flex: 1 }} placeholder="Name, e.g. November test week" value={name} onChange={(e) => setName(e.target.value)} aria-label="Dataset name" />
            <button className="btn primary" onClick={send} disabled={!file || busy}><UploadCloud size={15} /> {busy ? 'Checking…' : 'Upload and check'}</button>
          </div>

          {result && !result.ok && (
            <div className="callout bad" style={{ marginTop: 12 }}>
              <AlertTriangle size={15} />
              <div>
                <b>{result.error}</b>
                {result.rejected?.length > 0 && <RejectedRows rows={result.rejected} total={result.rejectedCount} />}
              </div>
            </div>
          )}
          {result?.ok && (
            <div className="callout good" style={{ marginTop: 12 }}>
              <CheckCircle2 size={15} />
              <div style={{ flex: 1 }}>
                <b>{num(result.accepted)} orders saved as “{result.name}”</b>
                {result.rejectedCount > 0 ? `; ${num(result.rejectedCount)} rows rejected (below).` : ', every row passed.'}
                {!result.has_outcomes && <div className="small">No on_time column: the agents are compared with the expected on-time rate without them.</div>}
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <button className="btn" onClick={() => use(result.id, '/results')}><LineChartIcon size={14} /> See it on Results</button>
                  <button className="btn" onClick={() => use(result.id, '/operations-day')}><PlayCircle size={14} /> Play a day</button>
                </div>
                {result.rejected?.length > 0 && <RejectedRows rows={result.rejected} total={result.rejectedCount} />}
              </div>
            </div>
          )}
        </Card>

        <Card title="What the file needs" sub="One row per order.">
          <p className="small"><b>Required:</b> {required.map((c) => <code key={c} className="col-name">{c}</code>)}</p>
          <p className="small"><b>Optional:</b> {optional.map((c) => <code key={c} className="col-name">{c}</code>)}</p>
          <p className="small muted">Leave <code>on_time</code> out (or blank) for orders that have not happened yet. Clients must be existing Halcyon clients (C001–C280).</p>
          <a className="btn" href="/api/agents/datasets/sample.csv" download><Download size={14} /> Download a sample week</a>
        </Card>
      </div>

      <Card title="Uploaded test data" sub="Choose one to run the agents on it." className="section-gap" flush>
        {datasets.length ? (
          <div className="table-wrap" style={{ boxShadow: 'none', border: 0 }}>
            <table>
              <thead><tr><th>Name</th><th>Orders</th><th>Days</th><th>Outcomes</th><th>Rejected rows</th><th>Uploaded</th><th /></tr></thead>
              <tbody>
                {datasets.map((d) => (
                  <tr key={d.id}>
                    <td><b>{d.name}</b> {current === d.id && <Badge tone="brand">in use</Badge>}</td>
                    <td className="num-tab">{num(d.rows)}</td>
                    <td className="num-tab">{d.days.length > 1 ? `${d.days[0]} to ${d.days.at(-1)}` : d.days[0]}</td>
                    <td>{d.has_outcomes ? 'Yes' : 'No'}</td>
                    <td className="num-tab">{num(d.rejected)}</td>
                    <td className="num-tab">{String(d.created_at).slice(0, 16).replace('T', ' ')}</td>
                    <td><button className="btn sm" onClick={() => use(d.id, '/results')}>Use</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted small" style={{ padding: 16 }}>Nothing uploaded yet. Try the sample week.</p>}
        {current != null && <p className="small" style={{ padding: '0 16px 16px' }}><button className="btn sm" onClick={() => setDataset(null)}>Back to the real history</button></p>}
      </Card>
    </>
  );
}

function RejectedRows({ rows, total }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div className="small">Rejected rows{total > rows.length ? ` (first ${rows.length} of ${num(total)})` : ''}:</div>
      <ul className="small rejected-rows">
        {rows.map((r) => <li key={r.line}>Line {r.line}: {r.reason}</li>)}
      </ul>
    </div>
  );
}
