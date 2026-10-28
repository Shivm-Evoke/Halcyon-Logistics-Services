import { Fragment } from 'react';
import { pct, COMMITMENT } from '../api.js';
import { Badge } from './ui.jsx';

export const STATUS_TONE = { accepted: 'good', corrected: 'brand', held: 'warn', rejected: 'bad', duplicate: 'bad', processed: 'good', needs_attention: 'warn' };
const SEV_TONE = { fatal: 'bad', error: 'warn', warning: 'neutral' };

/** Per-order outcome table: status, auto-fixes (from → to), issues, AI risk and the decision. */
export default function IngestResult({ orders, onFix }) {
  if (!orders?.length) return <div className="small muted">No orders.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Order</th><th>Status</th><th>Auto-fixes</th><th>Issues</th><th className="num">AI late risk</th><th>Decision</th>{onFix && <th />}</tr></thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.ref} style={{ verticalAlign: 'top' }}>
              <td className="mono">{o.ref}<div className="small muted">{o.client_order_ref || '—'} · {o.line || o.source_ref}</div></td>
              <td><Badge tone={STATUS_TONE[o.status]}>{o.status}</Badge></td>
              <td className="small" style={{ whiteSpace: 'normal', minWidth: 200 }}>
                {o.corrections?.length ? o.corrections.map((c, i) => (
                  <div key={i}><b>{c.field}</b>: <s className="muted">{String(c.from)}</s> → {String(c.to)}</div>
                )) : <span className="muted">—</span>}
              </td>
              <td className="small" style={{ whiteSpace: 'normal', minWidth: 260 }}>
                {o.issues?.length ? o.issues.map((iss, i) => (
                  <Fragment key={i}>
                    <div><Badge tone={SEV_TONE[iss.severity]}>{iss.code}</Badge> {iss.message}</div>
                    {iss.suggestion && <div className="muted" style={{ marginLeft: 8 }}>↳ {iss.suggestion}</div>}
                  </Fragment>
                )) : <span className="muted">—</span>}
              </td>
              <td className="num">{o.late_risk == null ? '—' : <b style={{ color: o.late_risk >= 0.4 ? 'var(--bad)' : 'var(--good)' }}>{pct(o.late_risk, 0)}</b>}</td>
              <td className="small">{o.carrier_id ? <>Carrier {o.carrier_id} · {COMMITMENT[o.commitment_type] || o.commitment_type}<div className="muted">{o.promised_date ? `promised ${o.promised_date}` : 'promise after fix'}</div></> : '—'}</td>
              {onFix && <td>{o.status === 'held' && <button className="btn sm" onClick={() => onFix(o)}>Fix</button>}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
