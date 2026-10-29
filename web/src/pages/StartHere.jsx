import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Target, Compass, Presentation, ListChecks, Workflow, HelpCircle, Database, FlaskConical, CheckCircle2,
  AlertTriangle, Circle, Gauge,
} from 'lucide-react';
import { api, useApi, pct, num, usdK } from '../api.js';
import { PageHead, Card, Badge, Loading } from '../components/ui.jsx';
import DataTable from '../components/DataTable.jsx';

// The 10 steps of "How the work runs today" from the problem statement, and where each one breaks.
const PROCESS = [
  { n: 1, step: 'Client places an order by EDI, API or email', who: '280 clients', issue: null },
  { n: 2, step: 'EDI and API orders flow into the WMS automatically', who: 'Integration team', issue: 'I1', breaks: 'Nothing checks them: bad addresses go straight through (5%)', to: '/inbound' },
  { n: 3, step: 'Email orders are typed into the WMS by customer success', who: 'Customer success', issue: 'I1', breaks: '28% arrive with incomplete addresses; 44 staff hours a week of typing', to: '/inbound' },
  { n: 4, step: 'WMS holds orders and stock, makes pick lists', who: 'WMS', issue: null },
  { n: 5, step: 'Pick list compiled at 8am; later orders go on tomorrow’s list', who: 'Warehouse supervisors', issue: 'I2', breaks: 'Same-day is still promised after 8am: 61% of those arrive late', to: '/why-late' },
  { n: 6, step: 'Pick, pack, place on the dock for collection', who: 'Warehouse floor', issue: null },
  { n: 7, step: 'Which warehouse holds a client’s stock: set at onboarding, reviewed quarterly', who: 'Onboarding team', issue: 'I3', breaks: 'Nearest warehouse is out of stock on 14% of orders: 50% late', to: '/inventory' },
  { n: 8, step: 'Carrier chosen from the rate card and a preference spreadsheet', who: 'Warehouse team', issue: 'I4', breaks: 'Cheapest carriers (D, E, F) have no tracking and are 17–34% late on clean orders', to: '/carriers' },
  { n: 9, step: 'Carrier collects and delivers; delivery events come back', who: '6 carriers', issue: 'I5', breaks: 'Three carriers send no live events, so nobody sees a delay coming', to: '/control-tower' },
  { n: 10, step: 'Client chases; customer success handles re-delivery, penalties, renewals', who: 'Customer success', issue: 'I8', breaks: '64% of the team’s week is firefighting; 9 accounts ($14.2M) threatening to leave', to: '/accounts' },
];

const STORY = [
  { to: '/why-late', screen: 'Why we\'re late', title: 'The problem, and why it isn’t routing', show: 'The five causes table, then the routing chart.',
    say: 'On-time is 71% against a 94% benchmark. Five causes explain it, all before or at the warehouse. Route length and stops make no difference.', point: '5 causes, 0 from routing' },
  { to: '/operations-day', screen: 'Operations day', title: 'The solution at work: our worst Friday', show: 'Start the day (Recorded if offline), jump to 08:00, then 13:00 for the second wave; approve one item.',
    say: 'Five agents run the day: they fix addresses, open a second pick wave, place stock, pick reliable carriers and rescue risky orders. Claude explains each decision; anything over a limit waits for a manager.', point: 'Recorded vs with agents' },
  { to: '/six-months', screen: 'Six months with agents', title: 'Proof on every order since April', show: 'The weekly lines, then the waterfall; change one assumption and re-run.',
    say: 'Re-run on all 48,340 deliveries with real capacity limits, the agents lift on-time by about 20 points and save around $1M net. Each agent’s share is visible.', point: '71% → 91%' },
  { to: '/agents', screen: 'Meet the agents', title: 'What each agent does, and its limits', show: 'One agent card, then its link to the screen under the hood.',
    say: 'Rules make routine decisions, so the numbers are repeatable; Claude reads, explains and handles exceptions. The server enforces the limits, not the AI.', point: '5 agents + Ops Lead' },
  { to: '/decision', screen: 'The decision', title: 'What leadership should do', show: 'The two cards, then the rollout.',
    say: 'Don’t sign the routing contract as scoped. Run the agents, piloting at one warehouse, measured weekly on one number.', point: 'Pilot in 2 weeks' },
  { to: '/inbound', screen: 'Inbound gateway', title: 'Under the hood: Intake at the door', show: 'Process a test email live, then the live-week card.',
    say: 'Every order from email, API, EDI or file is checked and repaired before the pick list; emails the parser cannot read go to Claude.', point: '100% of injected errors caught' },
  { to: '/ai-model', screen: 'AI risk model', title: 'Under the hood: the risk model the Watchtower uses', show: 'Calibration, then the backtest.',
    say: 'Trained on April–August and tested on a September it never saw; its estimates match reality to within 0.1 points.', point: 'Calibrated on unseen data' },
];

const BRIEF = [
  { ask: 'Read the data; generate synthetic data where needed', where: 'Data behind the app (below) · live week on Inbound gateway', to: '/inbound' },
  { ask: 'Map how the work really runs and where it breaks', where: 'Process map (below)', anchor: true },
  { ask: 'Break it down: known, assumed, why it keeps happening', where: 'Known vs assumed (below) · Late-delivery diagnosis', to: '/why-late' },
  { ask: 'Define one measurable outcome and design a solution', where: 'Outcome (below) · the four Fix screens', to: '/inbound' },
  { ask: 'Build a working slice and show it against the data', where: 'Inbound gateway, Control tower, AI risk model', to: '/ai-model' },
  { ask: 'Show how you would prove it worked', where: 'AI risk model backtest · What-if · pilot plan (below)', to: '/six-months' },
  { ask: 'Say honestly what you do not yet know', where: 'Open questions (below)', anchor: true },
];

const KNOWN = [
  ['On-time is 71.0% and flat every month', 'Known', 'deliveries.csv, all 48,340 rows'],
  ['94% of late deliveries have an upstream cause (address, cutoff, stock, carrier)', 'Known', 'Root-cause tagging on every delivery'],
  ['Routing is not the cause', 'Known', 'Late rate flat by region, warehouse, stops; detours equal for all carriers'],
  ['Email addresses are broken by hand-keying, not by the clients', 'Assumed', 'Compare 50 original emails with the WMS record (Q-005)'],
  ['Carriers D/E/F are really late, not just reporting late', 'Assumed', 'Match their delivered dates to proof-of-delivery (Q-011)'],
  ['Same-day promises are a default, not in contracts', 'Assumed', 'Check client contracts (Q-008)'],
  ['A, B and C can take 25% more volume', 'Assumed', 'Ask carriers for committed daily capacity (capacity sliders show the impact)'],
  ['The time study week is typical', 'Assumed', 'Repeat the study for 2 more weeks (Q-019)'],
];

const UNKNOWN = [
  'Whether D/E/F lateness is real delay or late reporting: decides switch carrier vs fix tracking.',
  'How much extra daily capacity A, B and C will commit: decides 92.7% vs ~94% on-time.',
  'What the vendor’s proof of concept actually covers: if it also picks carriers on performance, part of it may be worth keeping.',
  'Real addresses are not verified against a postal database yet; the gateway checks completeness and ZIP ranges only.',
  'The synthetic week was written by the same team as the gateway: a real week of client emails is the true test.',
  'About 2,000 late SLA deliveries have no penalty recorded: still to be billed, waived, or missing.',
];

export default function StartHere() {
  const overview = useApi('/overview');
  const datasets = useApi('/datasets');
  const week = useApi('/ingest/live-week');
  const [agents, setAgents] = useState(null);
  useEffect(() => { api('/agents/replay', { method: 'POST', body: {} }).then((r) => setAgents(r.overall.agents)).catch(() => {}); }, []);
  if (!overview.data || !datasets.data) return <Loading error={overview.error || datasets.error} />;
  const k = overview.data.kpis;
  const causes = overview.data.causes;
  const totalLate = causes.reduce((s, c) => s + c.late, 0);
  const upstream = 1 - (causes.find((c) => c.cause === 'residual')?.late ?? 0) / totalLate;
  const w = week.data;

  return (
    <>
      <PageHead title="Start here" eyebrow="Halcyon Logistics · Problem 2 · Late deliveries">
        A guide to this app: the problem in one line, the answer in one line, the order to present the screens in, and where each part
        of the brief is answered.
      </PageHead>

      <div className="grid g2 section-gap">
        <Card>
          <div className="row small muted" style={{ gap: 8, marginBottom: 10 }}><HelpCircle size={15} /> What leadership believes</div>
          <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.35, }}>
            “Carrier routing is inefficient. A $680K routing engine will lift on-time from 71% and stop the churn.”
          </div>
          <div className="row wrap" style={{ gap: 8, marginTop: 14 }}>
            <Badge tone="bad">On-time {pct(k.on_time_rate)}</Badge><Badge>Benchmark 94%</Badge>
            <Badge tone="warn">{k.complaints} complaints</Badge><Badge tone="bad">{usdK(k.at_risk_revenue)} threatening to leave</Badge>
          </div>
        </Card>
        <Card>
          <div className="row small" style={{ gap: 8, marginBottom: 10, color: 'var(--good-ink)' }}><CheckCircle2 size={15} /> What the data shows</div>
          <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.35, }}>
            {pct(upstream, 0)} of late deliveries go wrong before the truck leaves. Five operations agents that fix those causes reach
            {agents ? ` ${pct(agents)}` : ' ~91%'} on-time over the same six months; route planning makes no measurable difference.
          </div>
          <div className="row wrap" style={{ gap: 8, marginTop: 14 }}>
            <Badge tone="good">Don’t sign the routing contract as scoped</Badge><Badge tone="brand">Run the operations agents</Badge>
          </div>
        </Card>
      </div>

      <Card title="Present it in seven steps" className="section-gap"
        sub="Follow the sidebar from top to bottom. Each step says what to show, what to say, and the one number to point at.">
        <ol className="list-clean">
          {STORY.map((s, i) => (
            <li key={s.to} style={{ alignItems: 'flex-start', gap: 14, padding: '14px 0' }}>
              <span style={{ display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: 0, background: 'var(--accent-soft)', color: 'var(--accent-ink)', fontWeight: 600, flex: 'none' }}>{i + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 10 }}>
                  <b style={{ fontSize: 14 }}>{s.title}</b>
                  <Link to={s.to} className="badge b-brand" style={{ textDecoration: 'none' }}>{s.screen} <ArrowRight size={11} /></Link>
                </div>
                <div className="small" style={{ marginTop: 6, color: 'var(--ink-2)' }}><b>Show:</b> {s.show}</div>
                <div className="small" style={{ marginTop: 3, color: 'var(--ink-2)' }}><b>Say:</b> {s.say}</div>
              </div>
              <div style={{ textAlign: 'right', flex: 'none', maxWidth: 190 }}>
                <div className="small muted">Point at</div>
                <div style={{ fontWeight: 600, }}>{s.point}</div>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <div className="grid g2 section-gap">
        <Card title="The brief, and where each part is answered">
          <ul className="list-clean">
            {BRIEF.map((b) => (
              <li key={b.ask} style={{ alignItems: 'flex-start' }}>
                <ListChecks size={16} style={{ color: 'var(--good-ink)', flex: 'none', marginTop: 2 }} />
                <div style={{ flex: 1 }}><b className="small">{b.ask}</b><div className="small muted">{b.where}</div></div>
                {b.to && <Link to={b.to} className="small" style={{ flex: 'none' }}>Open <ArrowRight size={11} /></Link>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="The one outcome we commit to" sub="One number, measured weekly, that the whole plan is judged on.">
          <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
            <span style={{ display: 'grid', placeItems: 'center', width: 44, height: 44, borderRadius: 0, background: 'var(--good-soft)', color: 'var(--good-ink)', flex: 'none' }}><Target size={22} /></span>
            <div>
              <div style={{ fontSize: 20, fontWeight: 600, }}>On-time delivery from {pct(k.on_time_rate)} to 94% within 90 days</div>
              <div className="small muted" style={{ marginTop: 4 }}>Measured weekly, split by root cause so each fix’s share is visible.</div>
            </div>
          </div>
          <ul className="list-clean small" style={{ marginTop: 14 }}>
            {[['Supporting', 'SLA penalties per month (today ≈ $145K)'], ['Supporting', 'Orders held at intake and fixed within 24h'],
              ['Supporting', 'Share of customer success time on proactive work (25% → 50%)'], ['Guardrail', 'No carrier above 40% of a day’s orders'],
              ['Proof', 'Pilot one warehouse for 4 weeks against the other four, as a control group']].map(([t, d]) => (
              <li key={d}><Badge tone={t === 'Proof' ? 'brand' : t === 'Guardrail' ? 'warn' : 'neutral'}>{t}</Badge><span>{d}</span></li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title="How the work runs today, and where it breaks" className="section-gap" sub="The ten steps from the problem statement. Red rows are where late deliveries are created.">
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Step</th><th>Who</th><th>Where it breaks</th><th /></tr></thead>
            <tbody>
              {PROCESS.map((p) => (
                <tr key={p.n} style={p.issue ? { background: 'var(--bad-wash)' } : undefined}>
                  <td className="mono muted">{p.n}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 260 }}>{p.step}</td>
                  <td className="small muted">{p.who}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 260 }}>{p.issue ? <span className="row" style={{ gap: 8, alignItems: 'flex-start' }}><AlertTriangle size={14} style={{ color: 'var(--bad-ink)', flex: 'none', marginTop: 3 }} /><span><Badge tone="bad">{p.issue}</Badge> {p.breaks}</span></span> : <span className="row muted small" style={{ gap: 6 }}><Circle size={10} /> Works</span>}</td>
                  <td>{p.to && <Link to={p.to} className="small">Fix <ArrowRight size={11} /></Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid g2 section-gap">
        <Card title="Known vs assumed" sub="Every assumption has a test. Question numbers refer to the Discovery Log.">
          <DataTable compact rows={KNOWN.map(([claim, status, how]) => ({ claim, status, how }))} rowKey={(r) => r.claim}
            columns={[
              { key: 'claim', label: 'Claim', render: (r) => <span style={{ whiteSpace: 'normal', display: 'block', minWidth: 120 }}>{r.claim}</span> },
              { key: 'status', label: 'Status', render: (r) => <Badge tone={r.status === 'Known' ? 'good' : 'warn'}>{r.status}</Badge> },
              { key: 'how', label: 'Evidence / how to test', render: (r) => <span className="small muted" style={{ whiteSpace: 'normal', display: 'block', minWidth: 120 }}>{r.how}</span> },
            ]} />
        </Card>
        <Card title="What we don’t know yet" sub="Said plainly, so stakeholders can weigh the recommendation.">
          <ul className="list-clean">
            {UNKNOWN.map((u) => <li key={u}><Compass size={15} style={{ color: 'var(--warn-ink)', flex: 'none', marginTop: 2 }} /><span className="small">{u}</span></li>)}
          </ul>
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Data behind the app" sub="Supplied by the stakeholders; loaded unchanged into PostgreSQL.">
          <DataTable compact rows={datasets.data.supplied} rowKey={(r) => r.file}
            columns={[
              { key: 'name', label: 'Dataset', render: (r) => <><b>{r.name}</b><div className="mono small muted">{r.file}</div></> },
              { key: 'rows', label: 'Rows', align: 'num', render: (r) => num(r.rows) },
              { key: 'what', label: 'What it holds', render: (r) => <span className="small muted" style={{ whiteSpace: 'normal', display: 'block', minWidth: 120 }}>{r.what}</span> },
            ]} />
        </Card>
        <Card title="Synthetic data we generated" sub="Realistic client traffic built from the supplied data, to test the gateway the way real orders would.">
          <ul className="list-clean small">
            <li><FlaskConical size={15} style={{ color: 'var(--accent-ink)', flex: 'none', marginTop: 2 }} />
              <div><b>Live week{w ? ` · ${w.week}` : ''}</b>
                <div className="muted">{w ? `${num(w.messages)} messages, ${num(w.orders)} orders across email, API, EDI and file drops; ${num(w.defect_detection.injected)} injected problems of ${Object.keys(w.injected).length} kinds. Gateway caught ${num(w.defect_detection.caught)}; ${w.clean_orders.wrongly_stopped} of ${num(w.clean_orders.total)} clean orders wrongly stopped.` : 'Not run yet: npm run demo:week'}</div>
                {w && <Link to="/inbound">See the scorecard <ArrowRight size={11} /></Link>}</div></li>
            <li><Presentation size={15} style={{ color: 'var(--accent-ink)', flex: 'none', marginTop: 2 }} />
              <div><b>Test pack · 24 files</b><div className="muted">One file per error pattern, for live demos on the Inbound gateway.</div></div></li>
            <li><Workflow size={15} style={{ color: 'var(--accent-ink)', flex: 'none', marginTop: 2 }} />
              <div><b>Orders received through the gateway</b><div className="muted">{num(datasets.data.received.inbound_orders)} orders in {num(datasets.data.received.messages)} messages so far.</div></div></li>
            <li><Database size={15} style={{ color: 'var(--accent-ink)', flex: 'none', marginTop: 2 }} />
              <div><b>Reset for a clean demo</b><div className="mono muted">npm run demo:fresh</div></div></li>
            <li><Gauge size={15} style={{ color: 'var(--accent-ink)', flex: 'none', marginTop: 2 }} />
              <div><b>Generate a different week</b><div className="mono muted">node ingest/generate-live-week.mjs --seed 42 && node ingest/run-live-week.mjs</div></div></li>
          </ul>
        </Card>
      </div>
    </>
  );
}
