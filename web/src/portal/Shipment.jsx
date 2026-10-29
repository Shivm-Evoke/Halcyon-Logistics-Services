// One shipment: where it is, when it will arrive, and, if it is on hold, what to fix.
import { useEffect, useState } from 'react';
import { useLocation, useParams, Link } from 'react-router-dom';
import { CheckCircle2, Circle, AlertTriangle, Wrench } from 'lucide-react';
import { api } from '../api.js';
import { PageHead, Badge, Loading } from '../components/ui.jsx';
import { STAGES, STAGE_LABEL, stageTone } from './stages.js';
import { AddressFields } from './NewOrder.jsx';

const when = (t) => String(t).slice(0, 16).replace('T', ' ');

export default function Shipment() {
  const { ref } = useParams();
  const { state } = useLocation();
  const [o, setO] = useState(null);
  const [error, setError] = useState(null);
  const [fix, setFix] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api(`/portal/orders/${ref}`).then((d) => { setO(d); setFix({ sku: d.sku || '', quantity: d.quantity || 1, ship_to: d.ship_to || {} }); }).catch(setError);
  useEffect(() => { load(); }, [ref]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!o) return <Loading error={error} />;
  const reached = new Set(o.events.map((e) => e.stage));
  const at = Object.fromEntries(o.events.map((e) => [e.stage, e.at]));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try { setO(await api(`/portal/orders/${ref}`, { method: 'PATCH', body: { ...fix, quantity: Number(fix.quantity) } })); } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHead title={`Shipment ${o.ref}`} eyebrow={o.client_order_ref ? `Your reference ${o.client_order_ref}` : 'Order placed with Halcyon'}>
        <Link to="/portal/shipments">All shipments</Link>
      </PageHead>
      {state?.justPlaced && o.stage === 'received' && <div className="callout good section-gap">Order received. We'll update this page as it moves.</div>}
      <div className="grid g3 section-gap">
        <div className="card"><div className="small muted">Stage</div><div className="row" style={{ gap: 6, marginTop: 6 }}><Badge tone={stageTone(o.stage)}>{STAGE_LABEL[o.stage]}</Badge>{o.atRisk && o.stage !== 'delivered' && <Badge tone="warn">At risk</Badge>}</div></div>
        <div className="card"><div className="small muted">Promised delivery</div><div className="kpi-value-sm">{o.promised_date ? String(o.promised_date).slice(0, 10) : 'Once the order is fixed'}</div></div>
        <div className="card"><div className="small muted">Carrier</div><div className="kpi-value-sm">{o.carrier_id && o.stage !== 'on_hold' && o.stage !== 'cancelled' ? `Carrier ${o.carrier_id}` : '—'}</div></div>
      </div>

      {o.stage !== 'on_hold' && o.stage !== 'cancelled' && (
        <ol className="timeline card section-gap" aria-label="Shipment progress">
          {STAGES.map((s) => (
            <li key={s} className={reached.has(s) ? 'done' : ''}>
              {reached.has(s) ? <CheckCircle2 size={18} /> : <Circle size={18} />}
              <b>{STAGE_LABEL[s]}</b>
              <span className="small muted">{at[s] ? when(at[s]) : ''}</span>
            </li>
          ))}
        </ol>
      )}

      {o.stage === 'on_hold' && fix && (
        <form className="card section-gap" onSubmit={save}>
          <div className="callout warn"><AlertTriangle size={15} /><div><b>We're holding this order until it's fixed.</b>
            <ul className="small">{o.issues.filter((i) => i.severity === 'error').map((i) => <li key={i.code + i.field}>{i.message}</li>)}</ul></div></div>
          <div className="form-grid">
            <label className="field"><span>Item code (SKU)</span><input className="input" value={fix.sku} onChange={(e) => setFix({ ...fix, sku: e.target.value })} /></label>
            <label className="field"><span>Quantity</span><input className="input" type="number" min="1" value={fix.quantity} onChange={(e) => setFix({ ...fix, quantity: e.target.value })} /></label>
          </div>
          <AddressFields value={fix.ship_to} onChange={(ship_to) => setFix({ ...fix, ship_to })} issues={o.issues} />
          <button className="btn primary" disabled={busy}><Wrench size={15} /> {busy ? 'Checking…' : 'Fix and release'}</button>
        </form>
      )}
      {o.stage === 'cancelled' && <div className="callout bad section-gap">This order was not accepted: {o.issues.map((i) => i.message).join(' ') || o.status}</div>}
      {o.issues.some((i) => i.severity !== 'error') && o.stage !== 'on_hold' && (
        <p className="small muted">Notes from our checks: {o.issues.map((i) => i.message).join(' · ')}</p>
      )}
    </>
  );
}
