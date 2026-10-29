import { useCallback, useEffect, useState } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, ReferenceLine, Cell, LabelList } from 'recharts';
import { RefreshCw, TrendingUp, DollarSign, Users } from 'lucide-react';
import { ResponsiveContainer } from '../components/motion.jsx';
import { api, pct, num, usdK, PAL } from '../api.js';
import { PageHead, Card, Kpi, Loading } from '../components/ui.jsx';
import { axisX, axisY, gridProps, lineProps, barProps, tip, Legend } from '../components/charts.jsx';

const BENCHMARK = 0.94;
const AGENT_LABEL = { baseline: 'Recorded', intake: 'Intake', wave: 'Wave Planner', stock: 'Stock', carrier: 'Carrier', watchtower: 'Watchtower' };

// Settings the replay runs under; most stand in for facts the data does not record, so each says what it assumes.
const FIELDS = [
  { key: 'secondWaveAt', label: 'Second pick wave', type: 'time', note: 'Must fall after the 08:00 list and before 14:00 collection.' },
  { key: 'wave2CapacityPerWarehouse', label: 'Second-wave orders per warehouse', type: 'number', step: 1, note: 'Assumed pick capacity.' },
  { key: 'carrierHeadroom', label: 'Carrier headroom over busiest day', type: 'number', step: 0.05, note: 'Assumed: the data records no carrier capacity.' },
  { key: 'fridayPrebookShare', label: 'Friday capacity booked from Thursday', type: 'number', step: 0.05, note: 'Extra share of A–C capacity on Fridays.' },
  { key: 'addressFixRate', label: 'Incomplete addresses completed', type: 'number', step: 0.05, note: 'Assumed share fixable before the pick list.' },
  { key: 'stockMissThreshold', label: 'Safety stock when misses reach', type: 'number', step: 0.05, note: 'Client × region stock-miss rate.' },
  { key: 'costCapUsd', label: 'Extra carrier cost without approval ($)', type: 'number', step: 1, note: 'Per order.' },
];

function Waterfall({ steps }) {
  // Floating bars: each agent's bar starts where the previous step ended.
  const data = steps.map((s, i) => {
    const prev = i ? steps[i - 1].onTime : 0;
    const first = i === 0;
    return { name: AGENT_LABEL[s.agent], base: first ? 0 : Math.min(prev, s.onTime), delta: first ? s.onTime : Math.abs(s.onTime - prev), total: s.onTime, first };
  });
  data.push({ name: 'With agents', base: 0, delta: steps.at(-1).onTime, total: steps.at(-1).onTime, first: true });
  return (
    <ResponsiveContainer height={300}>
      <BarChart data={data} margin={{ top: 22, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="name" {...axisX} interval={0} />
        <YAxis {...axisY} domain={[0.6, 1]} tickFormatter={(v) => pct(v, 0)} allowDataOverflow />
        {tip((v, n, p) => pct(p.total))}
        <ReferenceLine y={BENCHMARK} stroke={PAL.muted} strokeDasharray="4 4" label={{ value: 'Industry 94%', fill: PAL.muted, fontSize: 12, position: 'insideTopLeft' }} />
        <Bar dataKey="base" stackId="w" fill="transparent" tooltipType="none" {...barProps} isAnimationActive={false} />
        <Bar dataKey="delta" name="On time" stackId="w" {...barProps}>
          {data.map((d) => <Cell key={d.name} fill={d.first ? PAL.series[0] : PAL.series[2]} />)}
          <LabelList dataKey="total" position="top" formatter={(v) => pct(v)} style={{ fontSize: 12, fill: PAL.ink }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function SixMonths() {
  const [settings, setSettings] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [fieldError, setFieldError] = useState(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async (s) => {
    setRunning(true); setFieldError(null);
    try {
      setResult(await api('/agents/replay', { method: 'POST', body: s }));
    } catch (e) {
      setFieldError({ field: e.field || null, message: e.message }); // the API names the field it rejected
    } finally { setRunning(false); }
  }, []);

  useEffect(() => {
    api('/agents/settings').then(({ defaults }) => { setSettings(defaults); return run(defaults); }).catch(setError);
  }, [run]);

  if (!result) return <Loading error={error || (fieldError && new Error(fieldError.message))} />;
  const { overall, weekly, waterfall, money, accounts } = result;
  const recovered = accounts.filter((a) => a.agents >= BENCHMARK - 0.04).length;
  const set = (key, value) => setSettings((s) => ({ ...s, [key]: value }));

  return (
    <>
      <PageHead title="Six months with agents" eyebrow="Proof · all 48,340 deliveries, Apr–Sep 2026">
        Every order from the last six months, re-run day by day with the agents in charge and real limits on carrier and
        warehouse capacity. Each order's chance of arriving on time comes from how such orders actually did in Halcyon's history.
      </PageHead>

      <div id="replay-overall" className="grid g4 section-gap">
        <Kpi icon={TrendingUp} label="On time, as recorded" value={pct(overall.actual)} sub="Apr–Sep 2026" tone="bad" bar={overall.actual} />
        <Kpi icon={TrendingUp} label="On time with the agents" value={pct(overall.agents)} sub={`+${((overall.agents - overall.actual) * 100).toFixed(1)} points · industry 94%`} tone="good" bar={overall.agents} />
        <Kpi icon={DollarSign} label="Net saving, six months" value={usdK(money.netUsd)} sub={`after ${usdK(money.extraCarrierUsd)} more on carriers`} tone="good" />
        <Kpi icon={Users} label="At-risk accounts lifted" value={`${accounts.length}`} sub={`${recovered} within 4 points of the benchmark`} />
      </div>

      <div className="grid g3 section-gap">
        <Card title="Weekly on-time" sub="Recorded against the same orders run by the agents." className="span2">
          <Legend items={[{ label: 'Recorded', color: PAL.series[1] }, { label: 'With agents', color: PAL.series[0] }]} />
          <div id="replay-weekly">
            <ResponsiveContainer height={260}>
              <LineChart data={weekly} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="week" {...axisX} tickFormatter={(w) => w.slice(5)} minTickGap={24} />
                <YAxis {...axisY} domain={[0.6, 1]} tickFormatter={(v) => pct(v, 0)} />
                {tip((v) => pct(v), (w) => `Week of ${w}`)}
                <ReferenceLine y={BENCHMARK} stroke={PAL.muted} strokeDasharray="4 4" />
                <Line dataKey="actual" name="Recorded" stroke={PAL.series[1]} {...lineProps} />
                <Line dataKey="agents" name="With agents" stroke={PAL.series[0]} {...lineProps} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="What it is worth" sub="Six months, from the replay.">
          <table>
            <tbody>
              <tr><td>SLA penalties avoided</td><td className="num-tab">{usdK(money.penaltiesSavedUsd)}</td></tr>
              <tr><td>Redeliveries avoided</td><td className="num-tab">{usdK(money.redeliverySavedUsd)}</td></tr>
              <tr><td>Extra carrier spend</td><td className="num-tab">−{usdK(money.extraCarrierUsd)}</td></tr>
              <tr><td><b>Net</b></td><td className="num-tab"><b>{usdK(money.netUsd)}</b></td></tr>
              <tr><td>Customer success hours freed</td><td className="num-tab">{num(money.csHoursSavedPerWeek)} a week</td></tr>
            </tbody>
          </table>
          <p className="small muted" style={{ marginTop: 10 }}>Hours freed scale the 461 weekly complaint hours by late deliveries avoided.</p>
        </Card>
      </div>

      <div className="grid g3 section-gap">
        <Card title="Where the uplift comes from" sub="Agents switched on one at a time, in order." className="span2">
          <div id="replay-waterfall"><Waterfall steps={waterfall} /></div>
        </Card>
        <Card title="Accounts threatening to leave" sub="On-time, recorded → with agents.">
          <table>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.client_id}><td>{a.client_name}</td><td className="num-tab muted">{pct(a.actual, 0)}</td><td className="num-tab"><b>{pct(a.agents, 0)}</b></td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card title="Assumptions" sub="Change a setting and re-run: the replay takes about a second." className="section-gap">
        <div id="replay-settings" className="settings-grid">
          {FIELDS.map((f) => (
            <label key={f.key} className="setting">
              <span className="small">{f.label}</span>
              <input className="input" type={f.type} step={f.step} value={settings?.[f.key] ?? ''} aria-invalid={fieldError?.field === f.key}
                onChange={(e) => set(f.key, f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />
              <span className={`small ${fieldError?.field === f.key ? 'field-error' : 'muted'}`}>{fieldError?.field === f.key ? fieldError.message : f.note}</span>
            </label>
          ))}
        </div>
        {fieldError && !fieldError.field && <p className="field-error small">{fieldError.message}</p>}
        <button className="btn primary" style={{ marginTop: 12 }} onClick={() => run(settings)} disabled={running}><RefreshCw size={15} /> {running ? 'Running…' : 'Re-run six months'}</button>
      </Card>
    </>
  );
}
