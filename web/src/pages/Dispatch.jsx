// Staff: every open order by stage. Advance moves one order on one stage; the customer sees it at once.
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { api, useApi, num } from '../api.js';
import { PageHead, Badge, Loading } from '../components/ui.jsx';
import { STAGE_LABEL } from '../portal/stages.js';

const COLUMNS = ['on_hold', 'received', 'picked', 'collected', 'in_transit'];

export default function Dispatch() {
  const board = useApi('/dispatch');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  if (!board.data) return <Loading error={board.error} />;
  const advance = async (ref) => {
    setBusy(ref); setError('');
    try { await api(`/dispatch/${ref}/advance`, { method: 'POST' }); await board.reload(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };
  return (
    <>
      <PageHead title="Dispatch board" eyebrow="Run the company · every open order">
        Orders from the portal, API, email and files, by stage. Advance moves an order on one stage; the customer sees it in their
        portal straight away. Orders on hold wait for the customer's fix.
      </PageHead>
      {error && <div className="callout bad section-gap">{error}</div>}
      <div className="dispatch section-gap">
        {COLUMNS.map((col) => (
          <div key={col} className="dispatch-col" data-stage={col}>
            <div className="dispatch-head"><b>{STAGE_LABEL[col]}</b><span className="muted small">{num(board.data[col].length)}</span></div>
            {board.data[col].slice(0, 40).map((o) => (
              <div key={o.ref} className="dispatch-card" data-ref={o.ref}>
                <div className="row between"><b>{o.ref}</b>{o.atRisk && <Badge tone="warn">At risk</Badge>}</div>
                <div className="small">{o.client_name}</div>
                <div className="small muted">{o.carrier_id ? `Carrier ${o.carrier_id}` : 'No carrier yet'} · {o.promised_date ? String(o.promised_date).slice(0, 10) : 'no date'}</div>
                {col !== 'on_hold' && (
                  <button className="btn sm" onClick={() => advance(o.ref)} disabled={busy === o.ref} aria-label={`Advance ${o.ref}`}>
                    {busy === o.ref ? 'Moving…' : <>To {STAGE_LABEL[{ received: 'picked', picked: 'collected', collected: 'in_transit', in_transit: 'delivered' }[col]]} <ChevronRight size={13} /></>}
                  </button>
                )}
              </div>
            ))}
            {board.data[col].length > 40 && <div className="small muted">and {num(board.data[col].length - 40)} more</div>}
          </div>
        ))}
      </div>
    </>
  );
}
