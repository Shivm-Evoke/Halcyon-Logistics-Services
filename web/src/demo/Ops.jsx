// Halcyon's side: the supervisor at W3 sees every demo order's full event log, approves what the agents park, and
// (for the demo) plays the carrier's events.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, Truck, RotateCcw, CheckCircle2, XCircle, Activity, ExternalLink, Send } from 'lucide-react';
import { api } from '../api.js';
import { Card, Kpi, Badge } from '../components/ui.jsx';
import DemoBar from './DemoBar.jsx';
import Timeline from './Timeline.jsx';
import { usePoll } from './persona.js';

const STATUS_TONE = { held: 'warn', accepted: 'good', corrected: 'brand', rejected: 'bad', duplicate: 'bad' };
const last = (o) => o.events.at(-1);

export default function Ops() {
  const orders = usePoll('/orders');
  const approvals = usePoll('/agents/approvals?runId=thread&approval=pending');
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const list = orders.data || [];
  const current = list.find((o) => o.id === picked) || list[0];

  const run = async (key, fn) => {
    setBusy(key);
    try { await fn(); await Promise.all([orders.reload(), approvals.reload()]); } finally { setBusy(''); }
  };
  const sim = (type) => run(type, () => api('/sim/carrier-event', { method: 'POST', body: { order_id: current.id, type } }));
  const decide = (id, approval) => run(`${approval}-${id}`, () => api(`/agents/approvals/${id}`, { method: 'POST', body: { approval, actor: 'supervisor' } }));
  const reset = () => run('reset', async () => { await api('/demo/reset', { method: 'POST' }); setPicked(null); });
  const send = () => run('send', async () => { await api(`/orders/${current.id}/notify`, { method: 'POST', body: { message: note } }); setNote(''); });

  const delivered = list.filter((o) => o.events.some((e) => e.type === 'delivered'));
  const onTime = delivered.filter((o) => !o.events.find((e) => e.type === 'delivered').detail?.late);
  const told = delivered.filter((o) => o.events.some((e) => e.type === 'delayed')).every((o) => o.events.some((e) => e.type === 'client_notified' && e.actor !== 'intake_agent'));
  const pending = approvals.data || [];
  const types = new Set(current?.events.map((e) => e.type) || []);

  return (
    <div className="demo">
      <DemoBar persona="ops">
        <Link className="btn sm" to="/operations-day">Operations day</Link>
        <Link className="btn sm" to="/inbound">Inbound gateway</Link>
      </DemoBar>
      <div className="demo-body">
        <div className="row between wrap section-gap" style={{ gap: 12, marginTop: 0 }}>
          <div><h1 style={{ fontSize: 22 }}>Ops console</h1><div className="muted small">Orders from the client portal, with every agent decision and approval.</div></div>
          <button className="btn" onClick={reset} disabled={busy === 'reset'}><RotateCcw size={14} /> Reset demo</button>
        </div>

        <div className="grid g4 section-gap">
          <Kpi icon={Activity} label="Demo orders" value={list.length} sub={`${list.filter((o) => o.status === 'held').length} held for the client`} />
          <Kpi icon={ShieldCheck} label="Waiting for approval" value={pending.length} sub="Parked by the agents" tone={pending.length ? 'warn' : undefined} />
          <Kpi icon={CheckCircle2} label="Delivered on time" value={delivered.length ? `${onTime.length}/${delivered.length}` : '—'} sub="Today's demo orders" tone={delivered.length && onTime.length === delivered.length ? 'good' : undefined} />
          <Kpi icon={Send} label="Late orders told in advance" value={delivered.length ? (told ? 'All' : 'Not all') : '—'} sub="Nobody had to chase" tone={delivered.length && told ? 'good' : undefined} />
        </div>

        {pending.length > 0 && (
          <Card title="Approval queue" sub="The agents act within limits; anything outside them comes here." className="section-gap">
            {pending.map((a) => (
              <div key={a.id} className="order-row">
                <div className="row between wrap" style={{ gap: 8 }}>
                  <div><Badge tone="warn">{a.delivery_id}</Badge> <b>{a.rule}</b></div>
                  <div className="row" style={{ gap: 8 }}>
                    <button className="btn primary sm" disabled={Boolean(busy)} onClick={() => decide(a.id, 'approved')}><CheckCircle2 size={13} /> Approve and send</button>
                    <button className="btn sm" disabled={Boolean(busy)} onClick={() => decide(a.id, 'rejected')}><XCircle size={13} /> Reject</button>
                  </div>
                </div>
                <div className="small" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{a.decision?.message}</div>
                <div className="small muted">{a.reason_source === 'claude' ? 'Drafted by Claude' : 'Template (rules only)'}</div>
              </div>
            ))}
          </Card>
        )}

        <div className="grid g2 section-gap">
          <Card title="Orders" sub="Newest first. Pick one to see its event log.">
            {!list.length && <div className="small muted">No demo orders yet. Place one from the client portal.</div>}
            {list.map((o) => (
              <div key={o.id} className={`order-row order-pick ${current?.id === o.id ? 'on' : ''}`} onClick={() => setPicked(o.id)}>
                <div className="row between" style={{ gap: 8 }}>
                  <div><b>{o.ref}</b> <span className="small muted">· {o.client_name || o.client_id} · {(o.commitment_type || '').replace('_', '-')}{o.carrier_id && o.status !== 'held' ? ` · carrier ${o.carrier_id}` : ''}</span></div>
                  <Badge tone={STATUS_TONE[o.status] || 'neutral'}>{o.status}</Badge>
                </div>
                <div className="small muted" style={{ marginTop: 4 }}>Last: {last(o)?.type.replaceAll('_', ' ')} · {String(last(o)?.ts || '').slice(11, 16)}</div>
              </div>
            ))}
          </Card>
          <Card title={current ? `${current.ref} event log` : 'Event log'} sub="The same log the client portal and the tracking page read."
            actions={current?.tracking_token && <a className="btn sm" href={`/track/${current.tracking_token}`} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Tracking page</a>}>
            {current ? (
              <>
                <div className="row wrap" style={{ gap: 8, marginBottom: 14 }}>
                  <span className="small muted"><Truck size={13} /> Simulate carrier (demo):</span>
                  <button className="btn sm" disabled={Boolean(busy) || current.status === 'held' || types.has('shipped') || types.has('delivered')} onClick={() => sim('shipped')}>Shipped</button>
                  <button className="btn sm" disabled={Boolean(busy) || current.status === 'held' || types.has('delayed') || types.has('delivered')} onClick={() => sim('delayed')}>Delayed</button>
                  <button className="btn sm" disabled={Boolean(busy) || current.status === 'held' || types.has('delivered')} onClick={() => sim('delivered')}>Delivered</button>
                </div>
                <Timeline events={current.events} />
                <div className="row" style={{ gap: 8, marginTop: 12 }}>
                  <input className="input" placeholder="Message to the client (customer success)" value={note} onChange={(e) => setNote(e.target.value)} />
                  <button className="btn" disabled={!note.trim() || Boolean(busy)} onClick={send}><Send size={13} /> Send</button>
                </div>
              </>
            ) : <div className="small muted">Pick an order.</div>}
          </Card>
        </div>
      </div>
    </div>
  );
}
