import { useEffect, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, Cell, ReferenceLine,
  ScatterChart, Scatter, ZAxis, LabelList,
} from 'recharts';
import { ResponsiveContainer, anim } from '../components/motion.jsx';
import { BrainCircuit, Gauge, Target, Timer, RefreshCw, Zap } from 'lucide-react';
import { api, useApi, pct, num, COMMITMENT, PAL } from '../api.js';
import { axisX, axisY, gridProps, barProps, hbarProps, ChartTip } from '../components/charts.jsx';
import { PageHead, Card, Kpi, Loading, Badge, Toast, RiskBadge } from '../components/ui.jsx';
import CapacityPlanner from '../components/CapacityPlanner.jsx';

// Scenarios are ordered (each adds more of the fix), so they take one blue ramp light→dark; today is neutral.
const scenarioColor = (i) => PAL.ramp[i];
const DEFAULT_ORDER = {
  order_channel: 'Email', commitment_type: 'same_day', received_hour: 10, address_incomplete: 0, stock_miss: 0,
  carrier_id: 'D', destination_region: 'Northeast', fulfilment_warehouse_id: 'W4', distance_miles: 120, account_tier: 'Tier 1', sla: 1,
};

export default function AiModel() {
  const { data, error, reload } = useApi('/ml/model');
  const backtest = useApi('/ml/backtest');
  const [toast, setToast] = useState('');
  const [training, setTraining] = useState(false);
  if (!data || !backtest.data) return <Loading error={error || backtest.error} />;
  const { meta, importance, labels } = data;
  const t = meta.test;
  const ece = t.calibration.reduce((s, c) => s + c.n * Math.abs(c.predicted - c.actual), 0) / t.n;
  const bt = backtest.data;
  const SHORT = ['AI carrier + promise', 'Data fixes only', 'Full AI operation'];
  const bars = [{ name: 'Actual today', on_time: bt.actual_on_time }, ...bt.scenarios.slice(1).map((s, i) => ({ name: SHORT[i], full: s.name, on_time: s.on_time }))];

  const retrain = async () => {
    setTraining(true);
    const r = await api('/ml/retrain', { method: 'POST' });
    setTraining(false); setToast(`Retrained ${r.version} in ${r.train_ms} ms · AUC ${r.auc.toFixed(3)}`); reload(); backtest.reload();
  };

  return (
    <>
      <PageHead title="AI risk model" eyebrow="Machine learning · trained Apr–Aug, tested on September"
        actions={<button className="btn" onClick={retrain} disabled={training}><RefreshCw size={14} /> {training ? 'Training…' : 'Retrain model'}</button>}>
        A late-delivery risk model trained on {num(meta.train_rows)} deliveries and tested on {num(meta.test_rows)} September orders it never saw.
        It scores every order instantly, explains why, and drives the carrier and promise decision.
      </PageHead>

      <div className="grid g6" style={{ marginBottom: 16 }}>
        <Kpi icon={Target} label="Accuracy (AUC)" value={t.auc.toFixed(3)} sub="0.5 = guessing, 1 = perfect" tone="good" />
        <Kpi icon={Gauge} label="Precision at 40% risk" value={pct(t.at_threshold.precision, 0)} sub="of flagged orders were late" />
        <Kpi icon={Gauge} label="Recall at 40% risk" value={pct(t.at_threshold.recall, 0)} sub="of late orders were flagged" />
        <Kpi icon={BrainCircuit} label="Calibration error" value={pct(ece)} sub="predicted vs actual late rate" tone="good" />
        <Kpi icon={Timer} label="Training time" value={`${num(meta.train_ms)} ms`} sub={`${meta.iterations} Newton iterations`} />
        <Kpi icon={Zap} label="Model version" value={`v${meta.id}`} sub={`${meta.algorithm} · trained ${String(meta.trained_at).slice(0, 16)}`} />
      </div>

      <div className="grid g2" style={{ marginBottom: 16 }}>
        <Card title="What the AI-driven operation would have achieved in September" sub="Expected on-time rate, replaying the test month day by day within each carrier's daily capacity. The model's estimate of 'today' matches reality, which is why the other bars can be trusted.">
          <ResponsiveContainer width="100%" height={270}>
            <BarChart data={bars} margin={{ top: 22, right: 10, left: -10, bottom: 0 }}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="name" {...axisX} interval={0} />
              <YAxis domain={[0.5, 1]} tickFormatter={(v) => pct(v, 0)} {...axisY} />
              <Tooltip cursor={{ fill: PAL.cursor }} content={<ChartTip format={(v) => pct(v)} />} />
              <ReferenceLine y={0.94} stroke={PAL.benchmark} strokeDasharray="4 4" strokeOpacity={0.6} label={{ value: 'Benchmark 94%', fill: PAL.benchmark, fontSize: 12, position: 'insideTopLeft' }} />
              <Bar dataKey="on_time" name="On-time" {...barProps} maxBarSize={72}>
                {bars.map((b, i) => <Cell key={b.name} fill={scenarioColor(i)} />)}
                <LabelList dataKey="on_time" position="top" formatter={(v) => pct(v)} fontSize={13} fontWeight={600} fill={PAL.ink} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="row wrap small muted" style={{ gap: 16 }}>
            <span>Model estimate of today: <b>{pct(bt.scenarios[0].on_time)}</b> vs actual <b>{pct(bt.actual_on_time)}</b></span>
            <span>Carrier changed on <b>{pct(bt.changed_carrier_share, 0)}</b> of orders</span>
            <span>Re-promised: <b>{pct(bt.repromised_share, 0)}</b></span>
            <span>Expected cost/order: <b>${bt.expected_cost_per_order.current.toFixed(2)}</b> → <b>${bt.expected_cost_per_order.next_best_action.toFixed(2)}</b></span>
          </div>
        </Card>

        <Card title="What drives late-delivery risk" sub="Global importance: how much each input moves the risk across all orders.">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={importance.slice(0, 10).map((i) => ({ ...i, label: labels[i.feature] }))} layout="vertical" margin={{ top: 0, right: 16, left: 60, bottom: 0 }}>
              <CartesianGrid stroke={PAL.grid} horizontal={false} />
              <XAxis type="number" {...axisX} />
              <YAxis type="category" dataKey="label" {...axisY} width={170} tick={{ fontSize: 12, fill: PAL.ink2 }} />
              <Tooltip cursor={{ fill: PAL.cursor }} content={<ChartTip format={(v) => v.toFixed(2)} />} />
              <Bar dataKey="importance" name="Importance" fill={PAL.series[0]} {...hbarProps} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div className="grid g3" style={{ marginBottom: 16 }}>
        <Card title="ROC curve (test month)" sub={`AUC ${t.auc.toFixed(3)}. The further above the diagonal, the better the model separates late from on-time.`}>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={t.roc} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid {...gridProps} vertical />
              <XAxis dataKey="fpr" type="number" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v) => pct(v, 0)} {...axisX} />
              <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v) => pct(v, 0)} {...axisY} />
              <Tooltip content={<ChartTip format={(v) => pct(v)} title={(v) => `False-positive rate ${pct(v)}`} />} />
              <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke={PAL.base} strokeDasharray="4 4" />
              <Line {...anim} type="monotone" dataKey="tpr" name="True-positive rate" stroke={PAL.series[0]} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Calibration (test month)" sub="Each dot: orders grouped by predicted risk. On the diagonal = the predicted % really happened.">
          <ResponsiveContainer width="100%" height={240}>
            <ScatterChart margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid {...gridProps} vertical />
              <XAxis dataKey="predicted" type="number" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v) => pct(v, 0)} {...axisX} name="Predicted" />
              <YAxis dataKey="actual" type="number" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v) => pct(v, 0)} {...axisY} name="Actual" />
              <ZAxis dataKey="n" range={[40, 400]} name="Orders" />
              <Tooltip content={<ChartTip format={(v, n) => (n === 'Orders' ? num(v) : pct(v))} title={() => 'Risk band'} />} />
              <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke={PAL.base} strokeDasharray="4 4" />
              <Scatter {...anim} data={t.calibration} fill={PAL.series[0]} stroke={PAL.surface} strokeWidth={2} />
            </ScatterChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Confusion matrix at 40% risk" sub={`${num(t.n)} September orders.`}>
          <div className="grid g2" style={{ gap: 8, marginTop: 6 }}>
            {[['Flagged & late', t.at_threshold.tp, 'good'], ['Flagged, on time', t.at_threshold.fp, 'warn'], ['Missed (late)', t.at_threshold.fn, 'bad'], ['Clear & on time', t.at_threshold.tn, 'good']].map(([l, v, tone]) => (
              <div key={l} className="step"><div className="t">{l}</div><div className="v" style={{ fontSize: 28, color: `var(--${tone})` }}>{num(v)}</div></div>
            ))}
          </div>
          <p className="small muted" style={{ marginTop: 12 }}>Base late rate {pct(t.base_rate)} · accuracy {pct(t.at_threshold.accuracy)} · F1 {t.at_threshold.f1.toFixed(2)}</p>
        </Card>
      </div>

      <CapacityPlanner />
      <LiveScorer labels={labels} />
      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}

function LiveScorer({ labels }) {
  const [o, setO] = useState(DEFAULT_ORDER);
  const [res, setRes] = useState(null);
  const [nba, setNba] = useState(null);
  useEffect(() => {
    const order = { ...o, cutoff_breach: o.commitment_type === 'same_day' && o.received_hour >= 8 ? 1 : 0, after_cutoff: o.received_hour >= 8 ? 1 : 0 };
    api('/ml/score', { method: 'POST', body: { order } }).then(setRes);
    api('/ml/decide', { method: 'POST', body: { order } }).then(setNba);
  }, [o]);
  const sel = (k, opts) => (
    <label className="field">{labels[k] || { received_hour: 'Order received at' }[k] || k}
      <select className="input" value={o[k]} onChange={(e) => setO({ ...o, [k]: isNaN(e.target.value) ? e.target.value : Number(e.target.value) })}>
        {opts.map(([v, l]) => <option key={v} value={v}>{l ?? v}</option>)}
      </select>
    </label>
  );
  const yn = [[0, 'No'], [1, 'Yes']];
  return (
    <Card title="Try it: score an order in real time" sub="Change any input; the model re-scores instantly and the decision engine re-plans.">
      <div className="grid g3">
        <div className="grid g2" style={{ alignContent: 'start' }}>
          {sel('order_channel', [['API'], ['EDI'], ['Email']])}
          {sel('commitment_type', Object.entries(COMMITMENT))}
          {sel('received_hour', Array.from({ length: 14 }, (_, h) => [h, `${h}:00`]))}
          {sel('carrier_id', ['A', 'B', 'C', 'D', 'E', 'F'].map((c) => [c, `Carrier ${c}`]))}
          {sel('address_incomplete', yn)}
          {sel('stock_miss', yn)}
          {sel('sla', yn)}
          {sel('account_tier', [['Tier 1'], ['Tier 2'], ['Tier 3']])}
        </div>
        <div>
          {res && (
            <>
              <div className="small muted">Late-delivery risk</div>
              <div className="big-num" style={{ color: res.risk >= 0.6 ? 'var(--bad-ink)' : res.risk >= 0.4 ? 'var(--warn-ink)' : 'var(--good-ink)' }}>{pct(res.risk)}</div>
              <div className="small muted" style={{ marginBottom: 10 }}>scored in {res.latency_us.toFixed(1)} µs (server-side)</div>
              <ul className="list-clean small">
                {res.drivers.slice(0, 6).map((d) => (
                  <li key={d.feature}><span style={{ flex: 1 }}>{labels[d.feature] || d.feature}</span>
                    <b style={{ color: d.impact > 0 ? 'var(--bad)' : 'var(--good)' }}>{d.impact > 0 ? '+' : ''}{(d.impact * 100).toFixed(1)} pts</b></li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div>
          {nba && (
            <>
              <div className="small muted">AI recommendation (next best action)</div>
              <div className="callout good" style={{ margin: '8px 0 10px' }}>
                <div><b>Carrier {nba.best.carrier_id} · {COMMITMENT[nba.best.commitment_type]}</b>
                  <div className="small">Risk {pct(nba.best.risk)} · expected cost ${nba.best.expected_cost.toFixed(2)}{nba.best.downgraded && ' · re-promised'}</div></div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Option</th><th className="num">Risk</th><th className="num">Exp. cost</th></tr></thead>
                  <tbody>{nba.options.slice(0, 6).map((x, i) => (
                    <tr key={x.carrier_id + x.commitment_type}><td>{i === 0 && <Badge tone="good">best</Badge>} {x.carrier_id} · {COMMITMENT[x.commitment_type]}</td><td className="num"><RiskBadge risk={x.risk} /></td><td className="num">${x.expected_cost.toFixed(2)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
