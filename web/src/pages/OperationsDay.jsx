import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, Clock, Inbox, Layers, Warehouse, Truck, Radar, Sparkles, CheckCircle2, XCircle, PlayCircle, Bot } from 'lucide-react';
import { api, pct, num } from '../api.js';
import { PageHead, Card, Kpi, Badge } from '../components/ui.jsx';
import { DataPicker, useDataset } from '../components/dataset.jsx';

const LANES = [
  { id: 'intake', label: 'Intake', icon: Inbox, job: 'Completes addresses before the pick list' },
  { id: 'wave', label: 'Wave Planner', icon: Layers, job: 'Second pick wave for same-day orders' },
  { id: 'stock', label: 'Stock', icon: Warehouse, job: 'Safety stock at the nearest warehouse' },
  { id: 'carrier', label: 'Carrier', icon: Truck, job: 'Reliable carriers within capacity' },
  { id: 'watchtower', label: 'Watchtower', icon: Radar, job: 'Rescues risky orders before collection' },
];
const SPEEDS = [1, 2, 4];                 // simulated hours per real minute x 3: 30 sim-minutes every 10 s at speed 1
const STEP = 30;
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

function summary(e) {
  const d = e.decision;
  switch (e.agent) {
    case 'intake': return d.fixAddress ? 'Address completed' : 'Address query sent to the client';
    case 'wave': return d.wave === 2 ? `Second wave, priority ${d.rank}` : 'Second wave full';
    case 'stock': return d.pair ? `Transfer for ${d.pair.replace('|', ' → ')}` : 'Safety stock used at the nearest warehouse';
    case 'carrier': return `Carrier ${d.carrier_id}${d.needsApproval ? ` (+$${d.extraCost.toFixed(2)})` : ''}`;
    case 'watchtower': return d.action === 'upgrade' ? `Moved to carrier ${d.carrier_id}` : 'Client to be told about the risk';
    default: return e.rule;
  }
}

function Event({ e }) {
  return (
    <li className="ops-event">
      <div className="row between small">
        <span className="muted num-tab">{e.simTime}</span>
        <span className="row" style={{ gap: 6 }}>
          {e.reason_source === 'claude' ? <Badge tone="brand"><Sparkles size={11} /> AI</Badge> : <Badge>rules only</Badge>}
          {e.approval === 'pending' && <Badge tone="warn">awaiting approval</Badge>}
          {e.approval === 'approved' && <Badge tone="good">approved</Badge>}
          {e.approval === 'rejected' && <Badge tone="bad">rejected</Badge>}
          {e.approval === 'expired' && <Badge>expired</Badge>}
        </span>
      </div>
      <div className="ops-event-title">{summary(e)}{e.client ? <span className="muted"> · {e.client.client_name}</span> : null}</div>
      <div className="small muted">{e.reason}</div>
    </li>
  );
}

export default function OperationsDay() {
  const [run, setRun] = useState(null);        // { runId, day, mode }
  const [state, setState] = useState(null);
  const [mode, setMode] = useState('live');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState({}); // decision id -> message while/after deciding
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const [dataset] = useDataset();
  const [days, setDays] = useState(null);       // { days: [{ day, weekday, orders, onTime }], default, recordedDay }
  const [day, setDay] = useState('');           // '' = the suggested day

  // The days the chosen data covers; the choice resets when the data changes.
  useEffect(() => {
    setDay(''); setDays(null);
    api(`/agents/days${dataset != null ? `?dataset=${dataset}` : ''}`).then(setDays).catch(() => setDays(null));
  }, [dataset]);
  // A recording holds Claude's reasons for one day of the history only.
  const recordedOnly = mode === 'recorded' && dataset == null && days?.recordedDay;

  const load = useCallback(async (runId) => {
    const s = await api(`/agents/live/${runId}`);
    setState(s);
    return s;
  }, []);

  // Resume a run that is already going (a refresh or a second tab).
  useEffect(() => {
    api('/agents/live/current')
      .then(({ runId }) => load(runId).then((s) => setRun({ runId, day: s.day, mode: s.mode, label: s.label })))
      .catch(() => {});
  }, [load]);

  const start = async () => {
    setBusy(true); setError(''); setPlaying(false); setDeciding({});
    try {
      const r = await api('/agents/live', { method: 'POST', body: { mode, dataset, day: (recordedOnly ? days.recordedDay : day) || undefined } });
      setRun(r);
      await load(r.runId);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const advance = useCallback(async (minutes) => {
    if (!run || inFlight.current || minutes <= 0) return;
    inFlight.current = true;
    try {
      const s = await api(`/agents/live/${run.runId}/advance`, { method: 'POST', body: { minutes } });
      setState(s);
      if (s.simMinutes >= 1440) setPlaying(false);
    } catch (e) { setError(e.message); setPlaying(false); } finally { inFlight.current = false; }
  }, [run]);

  // Play: half an hour of the day every 10 s at speed 1. Paused: keep collecting Claude's reasons as they arrive.
  useEffect(() => {
    if (!run) return undefined;
    const id = setInterval(() => {
      if (playing) advance(STEP);
      else if (!inFlight.current) load(run.runId).catch(() => {});
    }, playing ? 10000 / speed : 4000);
    return () => clearInterval(id);
  }, [run, playing, speed, advance, load]);

  const decide = async (id, approval) => {
    setDeciding((d) => ({ ...d, [id]: 'saving' }));
    try {
      const r = await api(`/agents/approvals/${id}`, { method: 'POST', body: { approval } });
      setDeciding((d) => ({ ...d, [id]: r.changed ? approval : 'already decided' }));
      await load(run.runId);
    } catch (e) { setDeciding((d) => ({ ...d, [id]: e.message })); }
  };

  const jumpTo = (hhmm) => state && advance(toMin(hhmm) - state.simMinutes);

  return (
    <>
      <PageHead title="Operations day" eyebrow={run ? `Live · ${run.day} · ${run.label || 'the worst Friday of September'}` : 'Live · one day of orders, replayed'}>
        One day of Halcyon's orders arrives as it really did: the worst Friday of September unless you pick another day, from the history or your test data. Five
        agents decide what happens to each one, within the limits a manager sets; anything outside those limits waits for approval
        here. The counters compare the day without the agents and with them.
      </PageHead>

      <div className="row wrap ops-start section-gap" style={{ gap: 8 }}>
            <DataPicker />
            <DayPicker days={days} value={recordedOnly ? days.recordedDay : day} onChange={setDay} disabled={Boolean(recordedOnly)} />
            <select id="ops-mode" className="input" value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Run mode">
              <option value="live">Live: Claude on Azure Foundry</option>
              <option value="recorded">Recorded: no network needed</option>
            </select>
            <button className="btn primary" onClick={start} disabled={busy}><PlayCircle size={15} /> {run ? 'Restart the day' : 'Start the day'}</button>
      </div>

      {error && <div className="callout bad section-gap">{error}</div>}
      {!state && !error && <div className="callout section-gap">Start the day to watch the agents work. Recorded mode replays saved Claude reasoning and runs offline.</div>}

      {state && (
        <>
          {!state.aiAvailable && <div className="callout warn section-gap"><Bot size={15} /> AI offline: rules running. Every decision still happens; reasons show the rule applied.</div>}

          <div className="ops-controls section-gap">
            <div id="ops-clock" className="ops-clock"><Clock size={18} /> {state.simTime}</div>
            <button className="btn" onClick={() => setPlaying((p) => !p)} disabled={state.simMinutes >= 1440}>
              {playing ? <><Pause size={15} /> Pause</> : <><Play size={15} /> Play</>}
            </button>
            <div className="row" style={{ gap: 4 }} role="group" aria-label="Speed">
              {SPEEDS.map((s) => <button key={s} className={`btn ${speed === s ? 'primary' : ''}`} onClick={() => setSpeed(s)}>{s}×</button>)}
            </div>
            <div className="row" style={{ gap: 4 }} role="group" aria-label="Jump to">
              {['08:00', '13:00', '14:00', '24:00'].map((t) => (
                <button key={t} className="btn" onClick={() => jumpTo(t)} disabled={toMin(t) <= state.simMinutes}>{t === '24:00' ? 'End of day' : t}</button>
              ))}
            </div>
          </div>

          <div className="grid g4 section-gap">
            {state.counters.actual != null
              ? <Kpi label="On time, as it really happened" value={<span id="ops-counter-actual">{pct(state.counters.actual)}</span>} sub={`${num(state.counters.orders)} orders received so far`} tone="bad" />
              : <Kpi label="On time expected without agents" value={<span id="ops-counter-actual">{pct(state.counters.baseline)}</span>} sub={`${num(state.counters.orders)} test orders so far`} tone="bad" />}
            <Kpi label="On time with the agents" value={<span id="ops-counter-agents">{pct(state.counters.agents)}</span>} sub="Same orders, expected" tone="good" />
            <Kpi label="Second wave" value={num(state.totals.wave)} sub="Same-day orders placed after 08:00" />
            <Kpi label="Awaiting approval" value={num(state.approvals.length)} sub="Decisions outside the agents' limits" tone={state.approvals.length ? 'warn' : undefined} />
          </div>

          <div className="grid g3 section-gap">
            <Card title="Ops Lead briefing" sub="Claude coordinates the agents and briefs the manager.">
              {state.briefings.length ? (
                <ul className="ops-briefings">
                  {state.briefings.map((b) => (
                    <li key={b.simTime}><span className="muted num-tab">{b.simTime}</span> {b.source === 'claude' ? <Badge tone="brand"><Sparkles size={11} /> AI</Badge> : <Badge>rules only</Badge>}<p>{b.text}</p></li>
                  ))}
                </ul>
              ) : <p className="muted small">The first briefing is at 06:00.</p>}
            </Card>
            <Card title="Approval queue" sub="Over a limit: a manager decides. Unanswered for two hours, the safe option stands." className="span2">
              {state.approvals.length ? (
                <ul className="ops-approvals">
                  {state.approvals.map((e) => (
                    <li key={e.id} className="ops-approval">
                      <div>
                        <div className="ops-event-title">{LANES.find((l) => l.id === e.agent)?.label}: {summary(e)}{e.client ? <span className="muted"> · {e.client.client_name} ({e.client.tier})</span> : null}</div>
                        <div className="small muted">{e.reason}</div>
                      </div>
                      <div className="row" style={{ gap: 6 }}>
                        {deciding[e.id] && deciding[e.id] !== 'saving' ? <span className="small muted">{deciding[e.id]}</span> : null}
                        <button className="btn" data-approve={e.id} disabled={deciding[e.id] === 'saving'} onClick={() => decide(e.id, 'approved')}><CheckCircle2 size={14} /> Approve</button>
                        <button className="btn" data-reject={e.id} disabled={deciding[e.id] === 'saving'} onClick={() => decide(e.id, 'rejected')}><XCircle size={14} /> Reject</button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <p className="muted small">Nothing waiting. {Object.values(deciding).includes('already decided') ? 'That decision had already been made.' : ''}</p>}
            </Card>
          </div>

          <div className="ops-lanes section-gap">
            {LANES.map(({ id, label, icon: Icon, job }) => (
              <Card key={id} title={<span className="row" style={{ gap: 8 }}><Icon size={16} /> {label} <span className="muted small num-tab">{num(state.totals[id])}</span></span>} sub={job}>
                <ul className="ops-lane" data-agent={id}>
                  {state.lanes[id].length ? state.lanes[id].map((e) => <Event key={e.id} e={e} />) : <li className="muted small">No decisions yet.</li>}
                </ul>
              </Card>
            ))}
          </div>
        </>
      )}
    </>
  );
}

const dayLabel = (d, suggested) => `${d.weekday} ${d.day} · ${num(d.orders)} ${d.orders === 1 ? 'order' : 'orders'}${d.onTime != null ? ` · ${pct(d.onTime)} on time` : ''}${suggested ? ' · suggested' : ''}`;

/** "Day: Fri 2026-09-25 ▾": any day the chosen data covers, the suggested one first; '' = the suggested day. */
function DayPicker({ days, value, onChange, disabled }) {
  if (!days?.days?.length) return null;
  const suggested = days.days.find((d) => d.day === days.default);
  return (
    <label className="row data-picker" style={{ gap: 8 }} title={disabled ? 'Recorded mode replays the day it was recorded on' : undefined}>
      <span className="small muted">Day</span>
      <select className="input" value={value || days.default} onChange={(e) => onChange(e.target.value === days.default ? '' : e.target.value)} disabled={disabled} aria-label="Day to play">
        {suggested && <option value={suggested.day}>{dayLabel(suggested, true)}</option>}
        {days.days.filter((d) => d !== suggested).map((d) => <option key={d.day} value={d.day}>{dayLabel(d)}</option>)}
      </select>
    </label>
  );
}
