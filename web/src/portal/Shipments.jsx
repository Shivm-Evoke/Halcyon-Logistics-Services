import { Link, useSearchParams } from 'react-router-dom';
import { useApi, num } from '../api.js';
import { PageHead, Badge, Loading } from '../components/ui.jsx';
import { STAGE_LABEL, stageTone } from './stages.js';

export default function Shipments() {
  const { data, error } = useApi('/portal/orders');
  const [params, setParams] = useSearchParams();
  const stage = params.get('stage');
  if (!data) return <Loading error={error} />;
  const rows = stage ? data.filter((o) => o.stage === stage) : data;
  return (
    <>
      <PageHead title="My shipments" eyebrow={`${num(data.length)} orders placed with Halcyon`}>
        Every order you sent us by portal, API, email or file, newest first.
      </PageHead>
      {stage && <p className="small">Showing {STAGE_LABEL[stage]} only · <button className="link" onClick={() => setParams({})}>Show all</button></p>}
      <div className="card flush section-gap">
        {rows.length ? (
          <div className="table-wrap" style={{ boxShadow: 'none', border: 0 }}>
            <table>
              <thead><tr><th>Order</th><th>Your ref</th><th>Item</th><th>Deliver to</th><th>Stage</th><th>Carrier</th><th>Promised</th></tr></thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.ref}>
                    <td><Link to={`/portal/shipments/${o.ref}`}><b>{o.ref}</b></Link></td>
                    <td>{o.client_order_ref || '—'}</td>
                    <td>{o.sku ? `${o.sku} × ${o.quantity}` : '—'}</td>
                    <td>{o.ship_to?.city ? `${o.ship_to.city}, ${o.ship_to.state}` : '—'}</td>
                    <td><Badge tone={stageTone(o.stage)}>{STAGE_LABEL[o.stage] || o.stage}</Badge> {o.atRisk && o.stage !== 'delivered' && <Badge tone="warn">At risk</Badge>}</td>
                    <td>{o.carrier_id ? `Carrier ${o.carrier_id}` : '—'}</td>
                    <td className="num-tab">{o.promised_date ? String(o.promised_date).slice(0, 10) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted small" style={{ padding: 16 }}>No shipments yet. <Link to="/portal/new-order">Place your first order.</Link></p>}
      </div>
    </>
  );
}
