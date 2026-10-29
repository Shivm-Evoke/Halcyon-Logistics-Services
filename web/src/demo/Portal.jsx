// The customer's side: Client 190 places orders and sees every message and step for each one.
// Orders go in through the same gateway as email, EDI, API and file drops.
import { useState } from 'react';
import { Send, Inbox, Clock, ExternalLink } from 'lucide-react';
import { api } from '../api.js';
import { Card } from '../components/ui.jsx';
import DemoBar from './DemoBar.jsx';
import Timeline from './Timeline.jsx';
import { PERSONAS, usePoll, DEMO_NOW } from './persona.js';

const CLIENT = PERSONAS.client.client_id;
const SERVICES = [['same_day', 'Same day'], ['next_day', 'Next day'], ['standard', 'Standard']];
// A realistic order with the ZIP left out, as in the demo script.
const START = { sku: 'HX-2201', quantity: 5, service: 'same_day', name: 'Sam Lee', street: '12 Peachtree Road', city: 'Atlanta', state: 'GA', zip: '' };

const STAGES = ['Received', 'Held', 'Confirmed', 'On the way', 'Delivered'];
function stageOf(o) {
  const types = new Set(o.events.map((e) => e.type));
  if (types.has('delivered')) return 4;
  if (types.has('shipped') || types.has('delayed') || types.has('carrier_selected')) return 3;
  if (o.status === 'held') return 1;
  if (types.has('released')) return 2;
  return 0;
}

function promiseText(service) {
  if (service !== 'same_day') return 'Before the 08:00 cutoff or not, this service keeps its promise.';
  return `It is ${DEMO_NOW.label.slice(-5)}, after the 08:00 pick-list cutoff: same-day is kept only on the 13:00 second wave if the warehouse has room; otherwise it is promised next-day.`;
}

function OrderCard({ o, onChange }) {
  const [zip, setZip] = useState('');
  const [busy, setBusy] = useState(false);
  const stage = stageOf(o);
  const fix = async () => { setBusy(true); try { await api(`/orders/${o.id}/fix-address`, { method: 'POST', body: { ship_to: { zip } } }); await onChange(); } finally { setBusy(false); } };
  const delayed = o.events.some((e) => e.type === 'delayed') && stage < 4;
  return (
    <div className="order-row">
      <div className="row between wrap" style={{ gap: 8, marginBottom: 8 }}>
        <div><b>{o.ref}</b> <span className="muted small">· {o.normalized?.sku} × {o.normalized?.quantity} · {(o.commitment_type || '').replace('_', '-')}{o.promised_date ? `, promised ${o.promised_date}` : ''}</span></div>
        <div className="row" style={{ gap: 8 }}>
          {o.tracking_token && <a className="btn sm" href={`/track/${o.tracking_token}`} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Tracking page</a>}
        </div>
      </div>
      <div className="chips">
        {STAGES.map((s, i) => <span key={s} className={i < stage ? 'done' : i === stage ? (stage === 1 ? 'held' : 'now') : ''}>{s}</span>)}
      </div>
      {delayed && <div className="callout warn" style={{ marginBottom: 10 }}>Running about a day late. Halcyon spotted it and will keep you posted.</div>}
      {o.status === 'held' && (
        <div className="callout warn" style={{ marginBottom: 10, flexDirection: 'column', alignItems: 'stretch' }}>
          <div><b>Action needed:</b> the ZIP code is missing. Fix it here and the order is released straight away.</div>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <input className="input" style={{ maxWidth: 160 }} placeholder="ZIP code" value={zip} onChange={(e) => setZip(e.target.value)} aria-label="ZIP code" />
            <button className="btn primary" disabled={busy || !/^\d{5}$/.test(zip)} onClick={fix}>Fix and release</button>
          </div>
        </div>
      )}
      <Timeline events={o.events} audience="client" />
    </div>
  );
}

export default function Portal() {
  const [form, setForm] = useState(START);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const orders = usePoll(`/orders?client=${CLIENT}`);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const place = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/orders', { method: 'POST', body: { client_id: CLIENT, order: {
        sku: form.sku, quantity: Number(form.quantity), service: form.service, received_at: DEMO_NOW.iso,
        ship_to: { name: form.name, street: form.street, city: form.city, state: form.state, zip: form.zip },
      } } });
      await orders.reload();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const messages = (orders.data || []).flatMap((o) => o.events.filter((e) => e.type === 'client_notified').map((e) => ({ ...e, ref: o.ref }))).sort((a, b) => String(b.ts).localeCompare(String(a.ts)) || b.id - a.id);

  return (
    <div className="demo">
      <DemoBar persona="client"><span className="pill"><Clock size={13} /> Order time {DEMO_NOW.label} (demo)</span></DemoBar>
      <div className="demo-body">
        <div className="grid g2">
          <Card title="New order" sub="Goes through Halcyon's inbound gateway, like email, EDI and API orders.">
            <form onSubmit={place}>
              <div className="form-grid">
                <label className="field">Service
                  <select className="input" value={form.service} onChange={set('service')}>{SERVICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                </label>
                <label className="field">Item (SKU)<input className="input" value={form.sku} onChange={set('sku')} /></label>
                <label className="field">Quantity<input className="input" type="number" min="1" value={form.quantity} onChange={set('quantity')} /></label>
                <label className="field">Recipient<input className="input" value={form.name} onChange={set('name')} /></label>
                <label className="field wide">Street<input className="input" value={form.street} onChange={set('street')} /></label>
                <label className="field">City<input className="input" value={form.city} onChange={set('city')} /></label>
                <label className="field">State<input className="input" value={form.state} onChange={set('state')} /></label>
                <label className="field">ZIP<input className="input" value={form.zip} onChange={set('zip')} placeholder="(left empty in the demo)" /></label>
              </div>
              <div className="callout section-gap small">{promiseText(form.service)}</div>
              {error && <div className="callout bad section-gap">{error}</div>}
              <button className="btn primary section-gap" disabled={busy}><Send size={14} /> {busy ? 'Placing…' : 'Place order'}</button>
            </form>
          </Card>
          <Card title={<span className="row" style={{ gap: 8 }}><Inbox size={16} /> Inbox</span>} sub="Messages from Halcyon about your orders.">
            {!messages.length && <div className="small muted">No messages yet.</div>}
            {messages.map((m) => (
              <div key={m.id} className="order-row">
                <div className="small muted">{m.ref} · {String(m.ts).slice(11, 16)}{m.detail?.source === 'claude' ? ' · drafted by Claude' : ''}</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.detail?.message}</div>
              </div>
            ))}
          </Card>
        </div>
        <Card title="My orders" className="section-gap">
          {!orders.data?.length && <div className="small muted">No orders yet. Place one above.</div>}
          {(orders.data || []).map((o) => <OrderCard key={o.id} o={o} onChange={orders.reload} />)}
        </Card>
      </div>
    </div>
  );
}
