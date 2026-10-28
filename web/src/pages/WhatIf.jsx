import { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell, ReferenceLine, LabelList } from 'recharts';
import { ResponsiveContainer } from '../components/motion.jsx';
import { Scale, CheckCircle2 } from 'lucide-react';
import { useApi, pct, num, usdK, CAUSES, PAL } from '../api.js';
import { axisX, axisY, gridProps, barProps, ChartTip } from '../components/charts.jsx';
import { PageHead, Card, Loading } from '../components/ui.jsx';

const LEVERS = [
  { key: 'address', title: 'Validate addresses at intake', d: 'Hold incomplete orders; parse email orders automatically.', cost: 'Low: rules + parser' },
  { key: 'cutoff', title: 'Cutoff-aware promises', d: 'No same-day promise after the 8am pick list.', cost: 'Low: rule change' },
  { key: 'stock', title: 'Monthly safety-stock placement', d: 'Keep stock at the warehouse nearest demand.', cost: 'Medium: inventory carrying cost' },
  { key: 'carrier', title: 'Performance-based carrier choice', d: 'Time-critical orders to carriers A/B/C only.', cost: 'Medium: ~$3 higher rate per order' },
  { key: 'routing', title: 'Routing optimisation vendor', d: 'Best case: removes all residual lateness on tracked carriers.', cost: '$680K contract' },
];

export default function WhatIf() {
  const [fix, setFix] = useState({ address: true, cutoff: true, stock: true, carrier: true, routing: false });
  const qs = Object.entries(fix).filter(([, v]) => v).map(([k]) => `${k}=1`).join('&');
  const { data, error } = useApi(`/whatif?${qs}`);
  if (!data) return <Loading error={error} />;
  const { baseline, selected, routingOnly, upstreamAll } = data.scenarios;
  const annual = (v) => v * (12 / data.months);
  const saved = annual(baseline.penalties - selected.penalties + baseline.redelivery - selected.redelivery);
  const routingSaved = annual(baseline.penalties - routingOnly.penalties + baseline.redelivery - routingOnly.redelivery);
  const bars = [
    { name: 'Today', v: baseline.onTimeRate, c: PAL.neutral },
    { name: 'Routing vendor only', v: routingOnly.onTimeRate, c: PAL.base },
    { name: 'Upstream fixes (I1–I4)', v: upstreamAll.onTimeRate, c: PAL.ramp[2] },
    { name: 'Your selection', v: selected.onTimeRate, c: PAL.ramp[3] },
  ];

  return (
    <>
      <PageHead title="What-if & vendor decision" eyebrow="Decision · I6 · $680K routing contract">
        Switch fixes on and off to see the on-time rate and cost they would have produced on the same six months of orders.
        Each fixed failure is assumed to perform like clean orders on the same carrier type.
      </PageHead>

      <div className="grid g3" style={{ marginBottom: 16 }}>
        <Card title="Fixes" sub="Toggle to simulate.">
          <div className="stack">
            {LEVERS.map((l) => (
              <div key={l.key} className={`toggle ${fix[l.key] ? 'on' : ''}`} onClick={() => setFix({ ...fix, [l.key]: !fix[l.key] })}>
                <span className="switch" />
                <div>
                  <div className="row"><b>{l.title}</b><span className="dot" style={{ background: CAUSES[l.key === 'routing' ? 'residual' : l.key].color }} /></div>
                  <div className="small muted">{l.d}</div>
                  <div className="small" style={{ marginTop: 2 }}>Cost: {l.cost}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div className="span2 stack">
          <div className="grid g3">
            <Card><div className="small muted">On-time with selection</div><div className="big-num" style={{ color: selected.onTimeRate >= 0.94 ? 'var(--good-ink)' : 'var(--text)' }}>{pct(selected.onTimeRate)}</div><div className="small muted">from {pct(baseline.onTimeRate)} · benchmark 94%</div></Card>
            <Card><div className="small muted">Late deliveries avoided</div><div className="big-num">{num(baseline.late - selected.late)}</div><div className="small muted">over six months</div></Card>
            <Card><div className="small muted">Penalty + redelivery saved</div><div className="big-num" style={{ color: 'var(--good-ink)' }}>{usdK(saved)}</div><div className="small muted">per year</div></Card>
          </div>
          <Card title="On-time delivery by scenario">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={bars} margin={{ top: 20, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="name" {...axisX} interval={0} />
                <YAxis domain={[0.5, 1]} tickFormatter={(v) => pct(v, 0)} {...axisY} />
                <Tooltip cursor={{ fill: PAL.cursor }} content={<ChartTip format={(v) => pct(v)} />} />
                <ReferenceLine y={0.94} stroke={PAL.benchmark} strokeDasharray="4 4" strokeOpacity={0.6} label={{ value: 'Benchmark 94%', fill: PAL.benchmark, fontSize: 12, position: 'insideTopLeft' }} />
                <Bar dataKey="v" name="On-time" {...barProps} maxBarSize={80}>
                  {bars.map((b) => <Cell key={b.name} fill={b.c} />)}
                  <LabelList dataKey="v" position="top" formatter={(v) => pct(v)} fontSize={13} fontWeight={600} fill={PAL.ink} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </div>
      </div>

      <div className="grid g2">
        <Card title="The vendor decision" sub="$680K routing contract, two weeks from signature.">
          <div className="table-wrap">
            <table>
              <thead><tr><th /><th className="num">On-time</th><th className="num">Gain</th><th className="num">Savings / yr</th></tr></thead>
              <tbody>
                <tr><td>Routing vendor only (best case)</td><td className="num">{pct(routingOnly.onTimeRate)}</td><td className="num">+{((routingOnly.onTimeRate - baseline.onTimeRate) * 100).toFixed(1)} pts</td><td className="num">{usdK(routingSaved)}</td></tr>
                <tr><td><b>Upstream fixes I1–I4</b></td><td className="num"><b>{pct(upstreamAll.onTimeRate)}</b></td><td className="num"><b>+{((upstreamAll.onTimeRate - baseline.onTimeRate) * 100).toFixed(1)} pts</b></td><td className="num"><b>{usdK(annual(baseline.penalties - upstreamAll.penalties + baseline.redelivery - upstreamAll.redelivery))}</b></td></tr>
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>Savings count SLA penalties and redelivery only, not retained revenue from the $14.2M at risk.</p>
        </Card>
        <Card title="Recommendation">
          <div className="callout" style={{ marginBottom: 12 }}><Scale size={18} style={{ flex: 'none', marginTop: 2 }} /><div>Do not sign the routing contract as scoped. Fund the four upstream fixes first and revisit routing for the residual once they land.</div></div>
          <ul className="list-clean small">
            {['Pilot intake validation + cutoff promises in 2 weeks (rules only, no new vendor)',
              'Shift same-day / next-day volume off carriers D/E/F; renegotiate the F agreement',
              'Monthly safety-stock review for the nine at-risk accounts first',
              'Measure: on-time % by root cause each week; penalties $ per month'].map((t) => (
              <li key={t}><CheckCircle2 size={15} style={{ color: 'var(--good-ink)', marginTop: 1 }} /><span>{t}</span></li>
            ))}
          </ul>
          <p className="small muted" style={{ marginTop: 10 }}>Would change our mind: D/E/F lateness proves to be reporting lag only, or the vendor PoC also selects carriers on performance.</p>
        </Card>
      </div>
    </>
  );
}
