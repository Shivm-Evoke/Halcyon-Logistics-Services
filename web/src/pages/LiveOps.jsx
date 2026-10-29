// Staff: the live order desk. The ops clock, every live order (newest first, searchable) with its tracking, the
// gateway's checks and each agent's decision, the approval queue, and moving orders on. Polls the desk every 4 seconds;
// orders that arrived since the previous poll are highlighted for a few seconds.
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Clock, ChevronRight, ChevronDown, Sparkles, CheckCircle2, Circle, XCircle, SkipForward, Inbox, Layers, Warehouse, Truck, Radar, Search } from 'lucide-react';
import { api, num, pct } from '../api.js';
import { PageHead, Card, Badge } from '../components/ui.jsx';
import { STAGES, STAGE_LABEL, stageTone } from '../portal/stages.js';

const DEFAULT_CLOCK = '2026-09-25 09:15';
const POLL_MS = 4000;
const NEW_FOR_MS = 10000;                       // how long an order that just arrived stays highlighted
const AGENTS = [
  { id: 'intake', label: 'Intake', icon: Inbox },
  { id: 'wave', label: 'Wave Planner', icon: Layers },
  { id: 'stock', label: 'Stock', icon: Warehouse },
  { id: 'carrier', label: 'Carrier', icon: Truck },
  { id: 'watchtower', label: 'Watchtower', icon: Radar },
];
const agentName = (id) => AGENTS.find((a) => a.id === id)?.label ?? id;
const MOVABLE = new Set(['received', 'picked', 'collected', 'in_transit']);

/** Newest first: by received time, then ref. */
const newestFirst = (a, b) => String(b.received_ts ?? '').localeCompare(String(a.received_ts ?? '')) || String(b.ref).localeCompare(String(a.ref));
/** Case-insensitive match on the order ref (IN-002072 or just 2072) or the client's name or id. */
const matches = (o, query) => {
  const t = query.trim().toLowerCase();
  return !t || [o.ref, o.client?.client_name, o.client?.client_id].some((v) => v && String(v).toLowerCase().includes(t));
};
/** When each stage was reached: its first stage event (agent notes carry the stage they were written at). */
function stageTimes(events = []) {
  const at = {};
  for (const e of events) if (!e.note && !(e.stage in at)) at[e.stage] = e.at;
  for (const e of events) if (!(e.stage in at)) at[e.stage] = e.at;
  return at;
}

const checkText = (c) => (c.kind === 'issue' ? c.message : `${c.field}: ${c.from ?? 'empty'} → ${c.to} (${c.rule})`);

const SourceBadge = ({ source }) => (source === 'claude' ? <Badge tone="brand"><Sparkles size={11} /> AI</Badge> : <Badge>rules only</Badge>);

function ApprovalBadge({ approval }) {
  const tone = { pending: 'warn', approved: 'good', rejected: 'bad' }[approval];
  return approval && approval !== 'none' ? <Badge tone={tone}>{approval === 'pending' ? 'awaiting approval' : approval}</Badge> : null;
}

function Tracking({ order }) {
  const at = stageTimes(order.events);
  const steps = [...(at.on_hold ? ['on_hold'] : []), ...STAGES, ...(at.cancelled ? ['cancelled'] : [])];
  return (
    <div className="live-track">
      <div className="live-track-facts small">
        <span><span className="muted">Promised</span> <b>{order.promised_date ?? '—'}</b></span>
        <span><span className="muted">Carrier</span> <b>{order.carrier_id ? `Carrier ${order.carrier_id}` : '—'}</b></span>
        <span><span className="muted">Late risk</span> <b>{order.risk == null ? '—' : pct(order.risk, 0)}</b></span>
      </div>
      <ol className="live-timeline" aria-label={`Tracking for ${order.ref}`}>
        {steps.map((s) => (
          <li key={s} className={at[s] ? 'done' : ''} data-stage={s}>
            {at[s] ? <CheckCircle2 size={15} /> : <Circle size={15} />}
            <b>{STAGE_LABEL[s] ?? s}</b>
            <span className="small muted num-tab">{at[s] ?? ''}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Detail({ order }) {
  return (
    <div className="live-detail">
      <Tracking order={order} />
      <div>
        <div className="small muted">Gateway checks</div>
        {order.checks.length
          ? <ul className="list-clean">{order.checks.map((c, i) => <li key={i} className="small">{checkText(c)}</li>)}</ul>
          : <p className="small muted">Nothing to fix or change.</p>}
      </div>
      <div>
        <div className="small muted">Agent decisions</div>
        {!order.agentsRun && <p className="small"><Badge tone="warn">agents not run</Badge> <span className="muted">The agents could not run on this order yet; the gateway's values stand.</span></p>}
        {order.agentsRun && !order.decisions.length && <p className="small muted">No decisions yet.</p>}
        <ul className="ops-lane">
          {order.decisions.map((d) => (
            <li key={d.id} className="ops-event">
              <div className="row between small">
                <b>{agentName(d.agent)}</b>
                <span className="row" style={{ gap: 6 }}><SourceBadge source={d.reason_source} /><ApprovalBadge approval={d.approval} /></span>
              </div>
              <div className="ops-event-title">{d.rule}</div>
              <div className="small muted">{d.reason}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** @returns the Live operations screen */
export default function LiveOps() {
  const [desk, setDesk] = useState(null);
  const [error, setError] = useState('');
  const [setTo, setSetTo] = useState(DEFAULT_CLOCK);
  const [open, setOpen] = useState(() => new Set());
  const [busy, setBusy] = useState(null);       // what is being sent: 'clock' | 'advance' | an order ref | a decision id
  const sending = useRef(false);
  const seq = useRef(0);                         // bumped by every change, so a poll that started before one is dropped
  const [query, setQuery] = useState('');
  const [fresh, setFresh] = useState(() => new Set()); // refs that arrived since the previous poll, highlighted for a while
  const seen = useRef(null);                     // refs of the previous state (null before the first)
  const timers = useRef(new Set());
  useEffect(() => () => { for (const t of timers.current) clearTimeout(t); }, []);

  // Every new state: note the orders that were not in the previous one and highlight them for NEW_FOR_MS.
  const show = useCallback((next) => {
    const refs = (next?.orders ?? []).map((o) => o.ref);
    const arrived = seen.current ? refs.filter((r) => !seen.current.has(r)) : [];
    seen.current = new Set(refs);
    setDesk(next);
    if (!arrived.length) return;
    setFresh((s) => new Set([...s, ...arrived]));
    const t = setTimeout(() => {
      timers.current.delete(t);
      setFresh((s) => { const n = new Set(s); for (const r of arrived) n.delete(r); return n; });
    }, NEW_FOR_MS);
    timers.current.add(t);
  }, []);

  const load = useCallback(async () => {
    if (sending.current) return;
    const at = seq.current;
    try {
      const next = await api('/desk');
      if (at === seq.current && !sending.current) { show(next); setError(''); }
    } catch (e) { if (at === seq.current) setError(e.message); }
  }, [show]);
  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // A change to the desk: the answer is the new state, so show it at once.
  const act = async (key, path, body) => {
    seq.current += 1; sending.current = true; setBusy(key); setError('');
    try { show(await api(path, { method: 'POST', body })); } catch (e) { setError(e.message); } finally { sending.current = false; setBusy(null); }
  };
  const decide = async (id, approval) => {
    seq.current += 1; sending.current = true; setBusy(id); setError('');
    try { await api(`/agents/approvals/${id}`, { method: 'POST', body: { approval } }); show(await api('/desk')); } catch (e) { setError(e.message); } finally { sending.current = false; setBusy(null); }
  };
  const toggle = (ref) => setOpen((s) => { const n = new Set(s); if (n.has(ref)) n.delete(ref); else n.add(ref); return n; });

  const head = (
    <PageHead title="Live operations" eyebrow="Run the company · the live order desk">
      Orders from the portal, API, EDI and email arrive here as they are placed. The gateway checks each one, then five agents decide
      what happens to it; anything over a limit waits for approval. Move the ops clock to see the day unfold.
    </PageHead>
  );
  if (!desk) return <>{head}{error ? <div className="callout bad">Could not load the desk: {error}</div> : <div className="skeleton" style={{ height: 200 }} />}</>;
  if (!desk.enabled) return <>{head}<div className="callout warn">The live order desk is off (DESK=0), so there are no live orders or agent decisions. Start the server without DESK=0 to turn it on.</div></>;

  const { approvals, counts, clock } = desk;
  const orders = desk.orders.filter((o) => matches(o, query)).sort(newestFirst);
  const off = busy != null;
  return (
    <>
      {head}
      {error && <div className="callout bad section-gap">{error}</div>}

      <div className="ops-controls section-gap">
        <div id="live-clock" className="ops-clock"><Clock size={18} /> {clock.now}</div>
        <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); act('clock', '/desk/clock', { set_to: setTo.trim() }); }}>
          <input className="input" style={{ width: 170 }} value={setTo} onChange={(e) => setSetTo(e.target.value)} aria-label="Ops clock, date and time" placeholder="YYYY-MM-DD HH:MM" />
          <button className="btn" type="submit" disabled={off}>Set clock</button>
        </form>
        <button className="btn primary" onClick={() => act('advance', '/desk/advance')} disabled={off}><SkipForward size={15} /> Advance to next event</button>
        <span className="small muted">Setting the clock starts a new run; advancing keeps it. Sample orders take the clock's time, so set it after 08:00 to see the 8 AM cutoff.</span>
      </div>

      <div className="ops-lanes section-gap" aria-label="The five agents">
        {AGENTS.map(({ id, label, icon: Icon }) => (
          <div key={id} className="card kpi" data-agent={id}>
            <div className="label"><Icon size={14} strokeWidth={2} />{label}</div>
            <div className="value">{num(counts[id] ?? 0)}</div>
            <div className="sub">decisions</div>
          </div>
        ))}
      </div>

      <Card title="Approval queue" sub="Over a limit: a manager decides. Unanswered for two simulated hours, the safe option stands." className="section-gap">
        {approvals.length ? (
          <ul className="ops-approvals">
            {approvals.map((a) => (
              <li key={a.id} className="ops-approval">
                <div>
                  <div className="ops-event-title">{agentName(a.agent)}: {a.rule} <span className="muted">· {a.ref}{a.client?.client_name ? ` · ${a.client.client_name}` : ''}</span></div>
                  <div className="small muted">{a.reason}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn" data-approve={a.id} disabled={busy === a.id} onClick={() => decide(a.id, 'approved')}><CheckCircle2 size={14} /> Approve</button>
                  <button className="btn" data-reject={a.id} disabled={busy === a.id} onClick={() => decide(a.id, 'rejected')}><XCircle size={14} /> Reject</button>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="muted small">Nothing waiting.</p>}
      </Card>

      <div className="row between section-gap" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div className="dt-search">
          <Search size={14} />
          <input className="input" type="search" placeholder="Search by order ref or client" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search live orders" />
        </div>
        <span className="small muted">{query.trim() ? `${orders.length} of ${desk.orders.length} orders` : `${desk.orders.length} orders, newest first`}</span>
      </div>
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table id="live-orders">
          <thead><tr><th>Order</th><th>Client</th><th>Channel</th><th>Received</th><th>Stage</th><th>Promised</th><th>Carrier</th><th>Risk</th><th /></tr></thead>
          <tbody>
            {desk.orders.length === 0 && <tr><td colSpan={9} className="muted">No live orders in this run yet. Send orders from the customer portal.</td></tr>}
            {desk.orders.length > 0 && orders.length === 0 && <tr><td colSpan={9} className="muted">No live order matches “{query.trim()}”.</td></tr>}
            {orders.map((o) => (
              <Fragment key={o.ref}>
                <tr data-ref={o.ref} className={fresh.has(o.ref) ? 'live-new' : undefined}>
                  <td>
                    <button className="btn sm" onClick={() => toggle(o.ref)} aria-expanded={open.has(o.ref)} aria-label={`Details for ${o.ref}`}>
                      {open.has(o.ref) ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {o.ref}
                    </button>
                    {!o.agentsRun && <> <Badge tone="warn">agents not run</Badge></>}
                  </td>
                  <td>{o.client?.client_name ?? o.client?.client_id ?? '—'}</td>
                  <td>{o.channel ?? '—'}</td>
                  <td className="num-tab">{o.received_ts ?? '—'}</td>
                  <td><Badge tone={stageTone(o.stage)}>{STAGE_LABEL[o.stage] ?? o.stage}</Badge></td>
                  <td className="num-tab">{o.promised_date ?? '—'}</td>
                  <td>{o.carrier_id ?? '—'}</td>
                  <td className="num-tab">{o.risk == null ? '—' : pct(o.risk, 0)}</td>
                  <td>
                    {MOVABLE.has(o.stage) && (
                      <button className="btn sm" onClick={() => act(o.ref, `/desk/orders/${o.ref}/advance`)} disabled={off} aria-label={`Move on ${o.ref}`}>
                        {busy === o.ref ? 'Moving…' : <>Move on <ChevronRight size={13} /></>}
                      </button>
                    )}
                  </td>
                </tr>
                {open.has(o.ref) && <tr className="live-detail-row"><td colSpan={9}><Detail order={o} /></td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
