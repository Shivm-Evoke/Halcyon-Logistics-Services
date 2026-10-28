import { Link } from 'react-router-dom';
import {
  ArrowRight, Target, Compass, Presentation, ListChecks, Workflow, HelpCircle, Database, FlaskConical, CheckCircle2,
  AlertTriangle, Circle, Gauge,
} from 'lucide-react';
import { useApi, pct, num, usdK } from '../api.js';
import { PageHead, Card, Badge, Loading } from '../components/ui.jsx';
import DataTable from '../components/DataTable.jsx';

// The 10 steps of "How the work runs today" from the problem statement, and where each one breaks.
const PROCESS = [
  { n: 1, step: 'Client places an order by EDI, API or email', who: '280 clients', issue: null },
  { n: 2, step: 'EDI and API orders flow into the WMS automatically', who: 'Integration team', issue: 'I1', breaks: 'Nothing checks them: bad addresses go straight through (5%)', to: '/inbound' },
  { n: 3, step: 'Email orders are typed into the WMS by customer success', who: 'Customer success', issue: 'I1', breaks: '28% arrive with incomplete addresses; 44 staff hours a week of typing', to: '/inbound' },
  { n: 4, step: 'WMS holds orders and stock, makes pick lists', who: 'WMS', issue: null },
  { n: 5, step: 'Pick list compiled at 8am; later orders go on tomorrow’s list', who: 'Warehouse supervisors', issue: 'I2', breaks: 'Same-day is still promised after 8am: 61% of those arrive late', to: '/diagnosis' },
  { n: 6, step: 'Pick, pack, place on the dock for collection', who: 'Warehouse floor', issue: null },
  { n: 7, step: 'Which warehouse holds a client’s stock: set at onboarding, reviewed quarterly', who: 'Onboarding team', issue: 'I3', breaks: 'Nearest warehouse is out of stock on 14% of orders: 50% late', to: '/inventory' },
  { n: 8, step: 'Carrier chosen from the rate card and a preference spreadsheet', who: 'Warehouse team', issue: 'I4', breaks: 'Cheapest carriers (D, E, F) have no tracking and are 17–34% late on clean orders', to: '/carriers' },
  { n: 9, step: 'Carrier collects and delivers; delivery events come back', who: '6 carriers', issue: 'I5', breaks: 'Three carriers send no live events, so nobody sees a delay coming', to: '/control-tower' },
  { n: 10, step: 'Client chases; customer success handles re-delivery, penalties, renewals', who: 'Customer success', issue: 'I8', breaks: '64% of the team’s week is firefighting; 9 accounts ($14.2M) threatening to leave', to: '/accounts' },
];

const STORY = [
  { to: '/overview', screen: 'Executive overview', title: 'The situation, checked', show: 'The six KPI tiles, then the flat monthly line and the cause donut.',
    say: 'The sponsor’s numbers are right: 71% on-time, 34 complaints, $14.2M at risk. But on-time has been flat for six months, and 94% of late deliveries are decided before a truck is loaded.', point: '94% upstream' },
  { to: '/diagnosis', screen: 'Late-delivery diagnosis', title: 'Why it happens, and why it isn’t routing', show: 'The four “late when true” tiles, then the two routing tests at the bottom.',
    say: 'Each problem multiplies the late rate: 65% with a bad address, 61% for same-day after 8am. Routing changes nothing: stops per route and detours are the same everywhere.', point: '65% / 61% / 50% / 34%' },
  { to: '/inbound', screen: 'Inbound gateway', title: 'Fix 1 & 2: catch bad orders at the door', show: 'Process a test email live (e.g. 02-missing-city…), then the live-week card.',
    say: 'Every order, from email, API, EDI or file, is repaired or held before it reaches the warehouse, and same-day after 8am is re-promised honestly. On a synthetic week of 2,000 orders it caught every injected problem.', point: 'Live week: 100% caught, 0 false alarms' },
  { to: '/inventory', screen: 'Inventory placement', title: 'Fix 3: stock where the demand is', show: 'The stock-out matrix, then press Plan on one recommendation.',
    say: 'Stock-outs at the nearest warehouse send orders 600+ miles. Monthly safety stock replaces the quarterly review.', point: '50% late on a miss vs 26%' },
  { to: '/carriers', screen: 'Carrier scorecard', title: 'Fix 4: choose carriers on cost of lateness, not rate', show: 'The scorecard, then the despatch recommendation for an SLA client.',
    say: 'Carrier D is cheapest and slowest. Once a late penalty is priced in, D costs $86 per SLA order against $27 for A, B or C. The new preferred-supplier deal (F) locks in a slow carrier.', point: '$85.92 vs $26.90' },
  { to: '/control-tower', screen: 'Exceptions control tower', title: 'Fix 5: tell clients before they chase', show: 'The risk histogram, then Notify on one order.',
    say: 'Every order in flight is scored by the AI model; 76% of the orders it flags really were late, so clients hear first.', point: '76% precision' },
  { to: '/ai-model', screen: 'AI risk model', title: 'How the AI works, and proof it can be trusted', show: 'The scenario chart, calibration dot plot, and the capacity sliders.',
    say: 'Trained on April–August, tested on September it never saw. Its estimate of today matches reality to 0.1 points, so its projection of 92.7% on-time within real carrier capacity can be trusted.', point: '71.1% → 92.7%' },
  { to: '/accounts', screen: 'Account health', title: 'The nine accounts at risk', show: 'The revenue-vs-late scatter, then open one at-risk account.',
    say: 'They are not served worse; they are the biggest and loudest. Each gets a recovery plan from its own failure pattern.', point: '$14.2M, 24 of 34 complaints' },
  { to: '/what-if', screen: 'What-if & vendor decision', title: 'The decision', show: 'Toggle the routing vendor on alone, then the four fixes.',
    say: 'The $680K routing engine moves on-time by about 1.7 points. The four upstream fixes move it by about 22–24. Don’t sign as scoped.', point: '72.7% vs 92.7–95%' },
];

const BRIEF = [
  { ask: 'Read the data; generate synthetic data where needed', where: 'Data behind the app (below) · live week on Inbound gateway', to: '/inbound' },
  { ask: 'Map how the work really runs and where it breaks', where: 'Process map (below)', anchor: true },
  { ask: 'Break it down: known, assumed, why it keeps happening', where: 'Known vs assumed (below) · Late-delivery diagnosis', to: '/diagnosis' },
  { ask: 'Define one measurable outcome and design a solution', where: 'Outcome (below) · the four Fix screens', to: '/inbound' },
  { ask: 'Build a working slice and show it against the data', where: 'Inbound gateway, Control tower, AI risk model', to: '/ai-model' },
  { ask: 'Show how you would prove it worked', where: 'AI risk model backtest · What-if · pilot plan (below)', to: '/what-if' },
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
  const backtest = useApi('/ml/backtest');
  if (!overview.data || !datasets.data) return <Loading error={overview.error || datasets.error} />;
  const k = overview.data.kpis;
  const causes = overview.data.causes;
  const totalLate = causes.reduce((s, c) => s + c.late, 0);
  const upstream = 1 - (causes.find((c) => c.cause === 'residual')?.late ?? 0) / totalLate;
  const full = backtest.data?.scenarios?.at(-1)?.on_time;
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
            {pct(upstream, 0)} of late deliveries go wrong before the truck leaves. Fixing intake, promises, stock and carrier choice reaches
            {full ? ` ${pct(full)}` : ' ~93%'} on-time; routing alone reaches about 72.7%.
          </div>
          <div className="row wrap" style={{ gap: 8, marginTop: 14 }}>
            <Badge tone="good">Don’t sign the routing contract as scoped</Badge><Badge tone="brand">Fund the four upstream fixes</Badge>
          </div>
        </Card>
      </div>

      <Card title="Present it in nine steps" className="section-gap"
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
