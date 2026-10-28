import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { ResponsiveContainer } from '../components/motion.jsx';
import DataTable from '../components/DataTable.jsx';
import { axisX, axisY, hbarProps, ChartTip, Legend, ChartEmpty } from '../components/charts.jsx';
import { Mail, FileCode2, KeyRound, FolderInput, Send, ExternalLink, X, Upload, Inbox as InboxIcon, MessagesSquare, Package, CheckCircle2, Wand2, PauseCircle, XCircle } from 'lucide-react';
import { api, useApi, num, pct, dt, PAL } from '../api.js';

// Outcomes are states, so they use the reserved status colours (always shown with a text label).
const OUTCOMES = [
  { key: 'accepted', label: 'Accepted clean', get color() { return PAL.status.good; } },
  { key: 'corrected', label: 'Auto-fixed', get color() { return PAL.series[0]; } },
  { key: 'held', label: 'Held for client fix', get color() { return PAL.status.warning; } },
  { key: 'rejected', label: 'Rejected / duplicate', get color() { return PAL.status.critical; } },
];
import { PageHead, Card, Kpi, Badge, Loading, Toast } from '../components/ui.jsx';
import IngestResult, { STATUS_TONE } from '../components/IngestResult.jsx';
import LiveWeekCard from '../components/LiveWeekCard.jsx';

const CHANNELS = [
  { id: 'email', label: 'Email', icon: Mail, how: 'Body text in any of the 14 client layouts, HTML-only mail, base64 / quoted-printable parts and CSV attachments. Upload a .eml, pick a test email, or drop it into the inbox folder.' },
  { id: 'edi', label: 'EDI', icon: FileCode2, how: 'ANSI X12 850 purchase orders; each transaction set is one order and the reply is a 997 acknowledgement.' },
  { id: 'api', label: 'API', icon: KeyRound, how: 'Log in with a client id and secret, then POST JSON. The client comes from the token; retries with the same Idempotency-Key are safe.' },
  { id: 'files', label: 'File drop', icon: FolderInput, how: 'SFTP-style CSV batch; the client comes from the file name (C055_orders.csv).' },
];

export default function Inbound() {
  const stats = useApi('/ingest/stats');
  const messages = useApi('/ingest/messages');
  const testFiles = useApi('/ingest/test-files');
  const [open, setOpen] = useState(null);
  if (!stats.data || !messages.data) return <Loading error={stats.error || messages.error} />;

  const t = stats.data.by_channel.reduce((a, c) => {
    for (const k of ['messages', 'orders', 'accepted', 'corrected', 'held', 'rejected']) a[k] = (a[k] || 0) + c[k];
    return a;
  }, {});
  const reload = () => { stats.reload(); messages.reload(); };

  return (
    <>
      <PageHead title="Inbound gateway" eyebrow="AI · I1, I2 · API, EDI, email and file drop"
        actions={<a className="btn" href="/api/docs" target="_blank" rel="noreferrer"><ExternalLink size={14} /> API docs</a>}>
        Every order from a client, whether API, EDI, email or file, goes through one pipeline: parse, normalise and auto-fix, validate,
        then the AI layer (anomaly screen, late-risk score, carrier and promise within capacity). Clean orders flow on; broken ones are held
        and the client gets a reply saying exactly what to fix.
      </PageHead>

      <div className="grid g6 section-gap">
        <Kpi icon={MessagesSquare} label="Messages received" value={num(t.messages || 0)} sub="API calls, emails, EDI, files" />
        <Kpi icon={Package} label="Orders read" value={num(t.orders || 0)} sub="Across every channel" />
        <Kpi icon={CheckCircle2} label="Accepted clean" value={pct((t.accepted || 0) / (t.orders || 1), 0)} sub={`${num(t.accepted || 0)} orders`} tone="good" />
        <Kpi icon={Wand2} label="Auto-fixed, accepted" value={pct((t.corrected || 0) / (t.orders || 1), 0)} sub="No human re-keying" />
        <Kpi icon={PauseCircle} label="Held for client fix" value={pct((t.held || 0) / (t.orders || 1), 0)} sub="Stopped before the warehouse" tone="warn" />
        <Kpi icon={XCircle} label="Rejected / duplicate" value={pct((t.rejected || 0) / (t.orders || 1), 0)} sub="Answered with the reason" tone="bad" />
      </div>

      <SendPanel files={testFiles.data} onDone={reload} />

      <LiveWeekCard />

      <div className="grid g3 section-gap">
        <Card title="Outcome by channel" sub="Share of each channel's orders by outcome.">
          <Legend items={OUTCOMES.map((o) => ({ label: o.label, color: o.color }))} />
          {stats.data.by_channel.length === 0 ? <ChartEmpty height={140} message="No messages processed yet" /> : (
            <div className="stack" style={{ marginTop: 14 }}>
              {stats.data.by_channel.map((c) => (
                <div key={c.channel}>
                  <div className="row between small" style={{ marginBottom: 5 }}><b>{c.channel}</b><span className="muted num-tab">{num(c.orders)} orders</span></div>
                  <div style={{ display: 'flex', gap: 2, height: 10, borderRadius: 0, overflow: 'hidden', background: 'var(--surface-3)' }}>
                    {OUTCOMES.map((o) => c[o.key] > 0 && (
                      <span key={o.key} title={`${o.label}: ${num(c[o.key])}`} style={{ width: `${(c[o.key] / c.orders) * 100}%`, background: o.color }} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Problems found in client data" sub="Issue codes across all inbound orders.">
          {stats.data.by_issue.length === 0 ? <ChartEmpty message="No issues found yet" /> : (
            <ResponsiveContainer width="100%" height={Math.max(180, stats.data.by_issue.length * 26)}>
              <BarChart data={stats.data.by_issue} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={PAL.grid} horizontal={false} />
                <XAxis type="number" {...axisX} allowDecimals={false} />
                <YAxis type="category" dataKey="code" {...axisY} interval={0} width={170} tick={{ fontSize: 12, fill: PAL.ink2, }} />
                <Tooltip cursor={{ fill: PAL.cursor }} content={<ChartTip format={(v) => `${num(v)} orders`} />} />
                <Bar dataKey="n" name="Orders" fill={PAL.series[1]} {...hbarProps} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
        <Card title="Automatic fixes applied" sub="Predictable errors repaired without asking the client.">
          {stats.data.by_correction.length === 0 ? <ChartEmpty message="No automatic fixes applied yet" /> : (
            <ResponsiveContainer width="100%" height={Math.max(180, stats.data.by_correction.length * 30)}>
              <BarChart data={stats.data.by_correction} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={PAL.grid} horizontal={false} />
                <XAxis type="number" {...axisX} allowDecimals={false} />
                <YAxis type="category" dataKey="rule" {...axisY} interval={0} width={210} tick={{ fontSize: 12, fill: PAL.ink2 }} />
                <Tooltip cursor={{ fill: PAL.cursor }} content={<ChartTip format={(v) => `${num(v)} fixes`} />} />
                <Bar dataKey="n" name="Fixes" fill={PAL.series[0]} {...hbarProps} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <Card title="Inbound messages" sub="Click a message to see every order in it and the reply sent back.">
        <DataTable rows={messages.data} rowKey={(m) => m.id} onRowClick={(m) => setOpen(m.id)} pageSize={25} initialSort={{ key: 'id', dir: 'desc' }}
          exportName="inbound-messages" searchPlaceholder="Sender, subject or file"
          columns={[
            { key: 'id', label: '#', align: 'num', filter: false, render: (m) => <span className="mono">{m.id}</span> },
            { key: 'channel', label: 'Channel', filter: 'select' },
            { key: 'source', label: 'From', render: (m) => <span className="small" style={{ display: 'inline-block', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'bottom' }} title={m.source}>{m.source}</span> },
            { key: 'subject', label: 'Subject', render: (m) => <span className="small" style={{ display: 'inline-block', maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'bottom' }} title={m.subject}>{m.subject}</span> },
            { key: 'received_at', label: 'Received', render: (m) => dt(m.received_at) },
            { key: 'orders', label: 'Orders', align: 'num', filter: 'range', value: (m) => m.summary?.orders ?? 0 },
            { key: 'outcome', label: 'Outcome', sortable: false, filter: false, value: (m) => m.summary && `${m.summary.accepted} ok · ${m.summary.corrected} fixed · ${m.summary.held} held · ${m.summary.rejected} rejected`,
              render: (m) => m.summary && (
                <span className="row small" style={{ gap: 10 }}>
                  {OUTCOMES.map((o) => (m.summary[o.key] ? <span key={o.key} className="row num-tab" style={{ gap: 4 }} title={`${m.summary[o.key]} ${o.label.toLowerCase()}`}><span className="dot" style={{ background: o.color }} />{m.summary[o.key]}</span> : null))}
                </span>) },
            { key: 'status', label: 'Status', filter: 'select', value: (m) => m.status.replace('_', ' '),
              render: (m) => <Badge tone={STATUS_TONE[m.status] || 'neutral'}>{m.status.replace('_', ' ')}</Badge> },
          ]} />
      </Card>
      {open && <MessageDrawer id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </>
  );
}

function SendPanel({ files, onDone }) {
  const [channel, setChannel] = useState('email');
  const [picked, setPicked] = useState(null);       // a test file chosen from the list
  const [uploaded, setUploaded] = useState(null);   // { name } of a file uploaded from disk
  const [content, setContent] = useState('');
  const [creds, setCreds] = useState({ client_id: 'C055', client_secret: '' });
  const [token, setToken] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(true);
  const meta = CHANNELS.find((c) => c.id === channel);
  const list = files?.[channel] || [];

  // The first test file is the default until the user picks one; derived, so a quick pick can never be overwritten.
  const selected = picked ?? list[0] ?? '';
  const file = uploaded?.name || selected;

  useEffect(() => {
    if (uploaded) return undefined;                 // uploaded content is already in the box
    if (!selected) { setContent(''); return undefined; }
    // Ignore a response that arrives after the user has already picked another file.
    let current = true;
    fetch(`/api/ingest/test-files/${channel}/${selected}`).then((r) => r.text()).then((text) => { if (current) setContent(text); });
    return () => { current = false; };
  }, [channel, selected, uploaded]);

  const switchChannel = (id) => { setChannel(id); setPicked(null); setUploaded(null); setResult(null); setError(''); };
  const pick = (name) => { setUploaded(null); setPicked(name); };
  const upload = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploaded({ name: f.name });
    f.text().then(setContent);
    e.target.value = '';                            // allow uploading the same file again
  };
  const login = async () => {
    setError('');
    try { setToken((await api('/auth/login', { method: 'POST', body: creds })).access_token); } catch (e) { setError(e.message); }
  };
  const send = async () => {
    setBusy(true); setError(''); setResult(null);
    // Test files use TP- PO numbers; a fresh prefix lets the same file be sent again without being a duplicate.
    const body = fresh ? content.replaceAll('TP-', `TP${Date.now().toString(36).slice(-5).toUpperCase()}-`) : content;
    try {
      let r;
      if (channel === 'email') r = await api('/ingest/email', { method: 'POST', body: { filename: file, content: body } });
      else if (channel === 'edi') r = await api('/ingest/edi', { method: 'POST', body: { filename: file, content: body } });
      else if (channel === 'files') r = await api('/ingest/file', { method: 'POST', body: { filename: file || 'C055_upload.csv', content: body } });
      else {
        const res = await fetch('/api/v1/orders', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body });
        r = await res.json();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${r.message || r.error}`);
        r.reply = JSON.stringify(r, null, 2);
      }
      setResult(r); onDone();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Card title="Send data through the gateway" sub="Use the generated test pack (ingest/test-data) or your own file. Each test file is named after the problem it contains." style={{ marginBottom: 16 }}>
      <div className="seg" style={{ marginBottom: 12 }}>
        {CHANNELS.map((c) => <button key={c.id} className={channel === c.id ? 'on' : ''} onClick={() => switchChannel(c.id)}><c.icon size={13} style={{ verticalAlign: -2 }} /> {c.label}</button>)}
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>{meta.how}</p>
      <div className="stack">
        <div className="stack">
          <div className="row wrap">
            <select className="input" style={{ flex: 1, minWidth: 260 }} value={uploaded ? '__uploaded' : selected} onChange={(e) => pick(e.target.value)} aria-label="Test file">
              {uploaded && <option value="__uploaded">{uploaded.name} (uploaded)</option>}
              {list.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <label className="btn"><Upload size={14} /> Upload<input type="file" hidden onChange={upload} accept=".eml,.edi,.x12,.csv,.json,.txt" /></label>
          </div>
          {channel === 'api' && (
            <div className="row wrap">
              <input className="input" style={{ width: 90 }} value={creds.client_id} onChange={(e) => setCreds({ ...creds, client_id: e.target.value })} aria-label="Client id" />
              <input className="input" style={{ flex: 1, minWidth: 180 }} type="password" placeholder="client secret (ingest/test-data/credentials.json)" value={creds.client_secret} onChange={(e) => setCreds({ ...creds, client_secret: e.target.value })} aria-label="Client secret" />
              <button className="btn" onClick={login}><KeyRound size={14} /> Log in</button>
              {token && <Badge tone="good">token ready (1 h)</Badge>}
            </div>
          )}
          <textarea className="input" rows={10} value={content} onChange={(e) => setContent(e.target.value)} aria-label="Message content" />
          <div className="row between">
            <div className="row">
              <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} /> Fresh PO numbers (re-send without duplicates)</label>
              {error && <span className="small" style={{ color: 'var(--bad)' }}>{error}</span>}
            </div>
            <button className="btn primary" onClick={send} disabled={busy || !content || (channel === 'api' && !token)}><Send size={14} /> {busy ? 'Processing…' : `Process ${meta.label.toLowerCase()}`}</button>
          </div>
        </div>
        <div className="stack">
          {!result ? <div className="loading" style={{ padding: 24 }}><InboxIcon size={20} /><br />The outcome and the reply to the client appear here.</div> : (
            <>
              <div className="row wrap">
                <Badge tone={STATUS_TONE[result.status]}>{result.status.replace('_', ' ')}</Badge>
                <span className="small muted">message #{result.message_id} · {result.summary.orders} order(s) · {result.summary.auto_fixes} auto-fix(es) · {result.summary.ms} ms</span>
              </div>
              <IngestResult orders={result.orders} />
              {result.reply && (
                <div>
                  <div className="small muted" style={{ marginBottom: 4 }}>{channel === 'edi' ? '997 acknowledgement sent back' : channel === 'api' ? 'API response' : 'Reply drafted to the sender'}</div>
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 0, padding: 12, maxHeight: 280, overflow: 'auto', margin: 0 }}>{result.reply}</pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

function MessageDrawer({ id, onClose, onChanged }) {
  const { data, error, reload } = useApi(`/ingest/messages/${id}`);
  const [fixing, setFixing] = useState(null);
  const [toast, setToast] = useState('');
  const orders = data?.orders.map((o) => ({ ...o, line: o.source_ref, late_risk: o.risk == null ? null : Number(o.risk) }));
  const save = async () => {
    const r = await api(`/ingest/orders/${fixing.id}`, { method: 'PATCH', body: { ship_to: fixing.ship_to, sku: fixing.sku, quantity: Number(fixing.quantity) || fixing.quantity } });
    setToast(`${r.ref} is now ${r.status}`); setFixing(null); reload(); onChanged();
  };
  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <div className="drawer" style={{ width: 'min(1100px, 96vw)' }}>
        <div className="drawer-head">
          <div><h3>Message #{id}{data && ` · ${data.channel}`}</h3>{data && <div className="small muted">{data.source} · {data.subject} · {dt(data.received_at)}</div>}</div>
          <button className="btn sm" onClick={onClose}><X size={14} /></button>
        </div>
        {!data ? <Loading error={error} /> : (
          <div className="drawer-body stack">
            <IngestResult orders={orders} onFix={(o) => setFixing({ id: o.id, ref: o.ref, ship_to: { ...o.normalized.ship_to }, sku: o.normalized.sku, quantity: o.normalized.quantity ?? '' })} />
            {fixing && (
              <Card title={`Fix ${fixing.ref}`} sub="Correct the fields and re-run the pipeline. It is released if it now validates.">
                <div className="grid g3">
                  {['name', 'street', 'city', 'state', 'zip'].map((k) => (
                    <label key={k} className="field">{k}<input className="input" value={fixing.ship_to[k] || ''} onChange={(e) => setFixing({ ...fixing, ship_to: { ...fixing.ship_to, [k]: e.target.value } })} /></label>
                  ))}
                  <label className="field">SKU<input className="input" value={fixing.sku || ''} onChange={(e) => setFixing({ ...fixing, sku: e.target.value })} /></label>
                  <label className="field">Quantity<input className="input" value={fixing.quantity} onChange={(e) => setFixing({ ...fixing, quantity: e.target.value })} /></label>
                </div>
                <div className="row" style={{ marginTop: 12 }}><button className="btn primary" onClick={save}>Re-validate</button><button className="btn" onClick={() => setFixing(null)}>Cancel</button></div>
              </Card>
            )}
            {data.reply && (
              <Card title={data.channel === 'EDI' ? '997 acknowledgement' : 'Reply sent to the client'}>
                <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{data.reply}</pre>
              </Card>
            )}
            <Card title="Original message"><pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 300, overflow: 'auto' }}>{data.raw}</pre></Card>
          </div>
        )}
      </div>
      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}
