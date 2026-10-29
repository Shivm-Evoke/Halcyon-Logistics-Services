// What the person receiving the parcel sees: no login, just the link from their SMS. Mobile first.
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ThumbsUp, ThumbsDown, MessageSquare } from 'lucide-react';
import { api } from '../api.js';
import { usePoll } from './persona.js';
import Timeline from './Timeline.jsx';
import './demo.css';

const STAGE_LABEL = { received: 'Received', confirmed: 'Confirmed', on_the_way: 'On the way', delivered: 'Delivered' };

export default function Track() {
  const { token } = useParams();
  const { data, error, reload } = usePoll(`/track/${token}`);
  const [zip, setZip] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (path, body) => { setBusy(true); try { await api(`/track/${token}${path}`, { method: 'POST', body }); await reload(); } finally { setBusy(false); } };

  if (error && !data) return <div className="demo"><div className="track"><div className="callout bad">This tracking link is not valid any more.</div></div></div>;
  if (!data) return <div className="demo"><div className="track muted">Loading…</div></div>;
  const at = data.stages.indexOf(data.stage);

  return (
    <div className="demo">
      <div className="track">
        <div className="row" style={{ gap: 10, marginBottom: 14 }}>
          <div className="brand-mark" style={{ width: 28, height: 28, display: 'grid', placeItems: 'center', background: 'var(--brand-mark)', color: 'var(--brand-mark-ink)', fontWeight: 700 }}>H</div>
          <div><b>Halcyon delivery</b><div className="small muted">Order {data.ref}</div></div>
          <span className="demo-badge" style={{ marginLeft: 'auto' }}>Demo</span>
        </div>

        <div className="chips">
          {data.stages.map((s, i) => <span key={s} className={i < at ? 'done' : i === at ? (data.held ? 'held' : 'now') : ''}>{STAGE_LABEL[s]}</span>)}
        </div>

        {data.banner && <div className="callout warn" style={{ marginBottom: 12 }}><AlertTriangle size={15} /> {data.banner}</div>}
        {data.stage === 'delivered' && <div className="callout good" style={{ marginBottom: 12 }}><CheckCircle2 size={15} /> Delivered. Thank you for choosing Halcyon.</div>}

        <div className="card" style={{ marginBottom: 12 }}>
          <div className="small muted">{data.held ? 'Waiting for a complete address' : 'Expected'}</div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>{data.held ? '—' : data.eta}</div>
          {!data.held && data.eta !== data.promised_date && <div className="small muted">Originally promised {data.promised_date}</div>}
          <div className="small muted">{(data.commitment_type || '').replace('_', '-')} delivery{data.carrier_id ? ` · carrier ${data.carrier_id}` : ''}</div>
        </div>

        {data.held && (
          <div className="card" style={{ marginBottom: 12 }}>
            <b>Help us deliver: the ZIP code is missing</b>
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <input className="input" placeholder="ZIP code" value={zip} onChange={(e) => setZip(e.target.value)} aria-label="ZIP code" />
              <button className="btn primary" disabled={busy || !/^\d{5}$/.test(zip)} onClick={() => act('/fix-address', { ship_to: { zip } })}>Fix address</button>
            </div>
          </div>
        )}

        {data.stage === 'delivered' && !data.rated && (
          <div className="card row" style={{ gap: 8, marginBottom: 12 }}>
            <span style={{ flex: 1 }}>How did we do?</span>
            <button className="btn" aria-label="Good" disabled={busy} onClick={() => act('/rate', { up: true })}><ThumbsUp size={15} /></button>
            <button className="btn" aria-label="Bad" disabled={busy} onClick={() => act('/rate', { up: false })}><ThumbsDown size={15} /></button>
          </div>
        )}

        <div className="sms" style={{ marginBottom: 14 }}>
          <div className="from"><MessageSquare size={11} /> SMS preview · demo, not sent</div>
          {data.banner ? `Halcyon: your order ${data.ref} is running about a day late. We are on it. Track: this page.`
            : data.stage === 'delivered' ? `Halcyon: your order ${data.ref} has been delivered.`
              : `Halcyon: your order ${data.ref} is ${STAGE_LABEL[data.stage].toLowerCase()}. Expected ${data.eta || 'soon'}. Track: this page.`}
        </div>

        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Progress</h3>
        <Timeline events={data.events} audience="public" />
      </div>
    </div>
  );
}
