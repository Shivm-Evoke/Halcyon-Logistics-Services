import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Cell, ReferenceLine } from 'recharts';
import { ResponsiveContainer } from '../components/motion.jsx';
import { useApi, pct, num, CAUSES, PAL } from '../api.js';
import { PageHead, Card, Loading } from '../components/ui.jsx';
import DataTable from '../components/DataTable.jsx';
import { axisX, axisY, gridProps, barProps, tip, Legend } from '../components/charts.jsx';

const FACTORS = [
  { key: 'address', q: 'Address incomplete at intake' },
  { key: 'cutoff', q: 'Same-day order received after 8am' },
  { key: 'stock', q: 'Nearest warehouse out of stock' },
  { key: 'carrier', q: 'Carrier has no tracking API' },
];

export default function Diagnosis() {
  const { data, error } = useApi('/diagnosis');
  if (!data) return <Loading error={error} />;
  const { factors, sameDayByHour, channel, distance, routeRatio, stops } = data;

  return (
    <>
      <PageHead title="Late-delivery diagnosis" eyebrow="Root-cause evidence">
        The dataset has no "reason late" column. These are the tests used to assign every late delivery to a cause, and the two
        tests that rule routing out.
      </PageHead>

      <div className="grid g4 section-gap">
        {FACTORS.map((f) => {
          const [no, yes] = factors[f.key];
          return (
            <Card key={f.key}>
              <div className="row small" style={{ gap: 8, color: 'var(--ink-2)', fontWeight: 500 }}>
                <span className="dot" style={{ background: CAUSES[f.key].color }} />{f.q}
                <span className="mono muted" style={{ marginLeft: 'auto' }}>{CAUSES[f.key].issue}</span>
              </div>
              <div className="row" style={{ alignItems: 'baseline', gap: 8, margin: '14px 0 12px' }}>
                <span className="big-num" style={{ color: 'var(--bad-ink)' }}>{pct(yes.late_rate, 0)}</span>
                <span className="small muted">late when true</span>
              </div>
              <Compare label="When true" value={yes.late_rate} color={CAUSES[f.key].hex} />
              <Compare label="Otherwise" value={no.late_rate} color={PAL.neutral} />
              <div className="small muted" style={{ marginTop: 10 }}>{num(yes.n)} orders affected · {pct(yes.n / (yes.n + no.n), 0)} of volume</div>
            </Card>
          );
        })}
      </div>

      <div className="grid g2 section-gap">
        <Card title="Same-day orders: late rate by hour received" sub="The 8am pick-list cutoff splits same-day performance in two (I2).">
          <Legend items={[{ label: 'Makes that day’s pick list', color: PAL.series[0] }, { label: 'Received after the cutoff', color: PAL.series[1] }]} />
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={sameDayByHour} margin={{ top: 16, right: 8, left: -8, bottom: 0 }} barCategoryGap="18%">
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="hour" tickFormatter={(h) => `${h}:00`} {...axisX} interval={1} />
              <YAxis tickFormatter={(v) => pct(v, 0)} {...axisY} />
              {tip((v) => pct(v), (h) => `Received ${h}:00–${h}:59`)}
              <ReferenceLine x={8} stroke={PAL.ink2} strokeOpacity={0.5} label={{ value: '8am cutoff', fill: PAL.ink2, fontSize: 12, position: 'top' }} />
              <Bar dataKey="late_rate" name="Late rate" {...barProps}>
                {sameDayByHour.map((h) => <Cell key={h.hour} fill={h.hour >= 8 ? PAL.series[1] : PAL.series[0]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Incomplete addresses by order channel" sub="Email orders are typed in by hand; their error rate is five times the automated channels (I1).">
          <Legend items={[{ label: 'Typed in by hand', color: PAL.series[1] }, { label: 'Automated feed', color: PAL.series[0] }]} />
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={channel} margin={{ top: 22, right: 8, left: -8, bottom: 0 }} barCategoryGap="38%">
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="channel" {...axisX} />
              <YAxis tickFormatter={(v) => pct(v, 0)} {...axisY} />
              {tip((v) => pct(v))}
              <Bar dataKey="incomplete_rate" name="Incomplete address" {...barProps} maxBarSize={64} label={{ position: 'top', fontSize: 12, fill: PAL.ink, fontWeight: 600, formatter: (v) => pct(v, 0) }}>
                {channel.map((c) => <Cell key={c.channel} fill={c.channel === 'Email' ? PAL.series[1] : PAL.series[0]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div className="grid g3">
        <Card title="Late rate by shipping distance (miles)" sub="Long hauls only happen when the nearest warehouse is out of stock (I3).">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={distance} margin={{ top: 22, right: 8, left: -8, bottom: 0 }} barCategoryGap="30%">
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="band" {...axisX} interval={0} />
              <YAxis tickFormatter={(v) => pct(v, 0)} {...axisY} />
              {tip((v) => pct(v), (b) => `${b} miles`)}
              <Bar dataKey="late_rate" name="Late rate" fill={PAL.series[2]} {...barProps} label={{ position: 'top', fontSize: 12, fill: PAL.ink2, formatter: (v) => pct(v, 0) }} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Routing test 1: stops per route" sub="Grouped by number of stops. Worse routing would show up as more stops = more lateness. It doesn't move.">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={stops} margin={{ top: 22, right: 8, left: -8, bottom: 0 }} barCategoryGap="30%">
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="band" {...axisX} interval={0} />
              <YAxis domain={[0, 0.5]} tickFormatter={(v) => pct(v, 0)} {...axisY} />
              {tip((v) => pct(v), (b) => `${b} stops`)}
              <Bar dataKey="late_rate" name="Late rate" fill={PAL.neutral} {...barProps} label={{ position: 'top', fontSize: 12, fill: PAL.ink2, formatter: (v) => pct(v, 0) }} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Routing test 2: actual vs planned route" sub="Median detour is the same 7% for every carrier.">
          <DataTable compact rows={routeRatio} rowKey={(r) => r.carrier_id} initialSort={{ key: 'carrier_id', dir: 'asc' }}
            columns={[
              { key: 'carrier_id', label: 'Carrier', render: (r) => `Carrier ${r.carrier_id}` },
              { key: 'ratio', label: 'Actual ÷ planned', align: 'num', render: (r) => Number(r.ratio).toFixed(3) },
              { key: 'detour', label: 'Detour', align: 'num', value: (r) => r.ratio - 1, render: (r) => `+${((r.ratio - 1) * 100).toFixed(1)}%` },
            ]} />
          <p className="small muted" style={{ margin: '10px 0 0' }}>1,339 deliveries have no actual km recorded and are excluded.</p>
        </Card>
      </div>
    </>
  );
}

function Compare({ label, value, color }) {
  return (
    <div className="row small" style={{ gap: 10, marginTop: 6 }}>
      <span className="muted" style={{ width: 64 }}>{label}</span>
      <div className="meter" style={{ flex: 1 }}><span style={{ width: `${value * 100}%`, background: color }} /></div>
      <b className="num-tab" style={{ width: 34, textAlign: 'right' }}>{pct(value, 0)}</b>
    </div>
  );
}
