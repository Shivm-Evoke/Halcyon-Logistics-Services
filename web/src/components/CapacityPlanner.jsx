import { useState } from 'react';
import { useApi, pct, num, PAL } from '../api.js';
import { Card, Loading } from './ui.jsx';

const CARRIERS = ['A', 'B', 'C', 'D', 'E', 'F'];

// Carrier-capacity what-if: re-runs the September backtest with a different capacity policy.
export default function CapacityPlanner() {
  const [maxShare, setMaxShare] = useState(0.4);
  const [headroom, setHeadroom] = useState(0.25);
  const { data } = useApi(`/ml/capacity?max_share=${maxShare}&headroom=${headroom}`);
  const rows = data && [
    ['Today', data.carrier_mix.today],
    ['AI, no capacity limit', data.carrier_mix.ai_unlimited],
    ['AI, within capacity', data.carrier_mix.ai_capacity_limited],
  ];
  return (
    <Card title="Carrier capacity" style={{ marginBottom: 16 }}
      sub="Without a limit the AI would send almost every order to the single best carrier. Each carrier gets a daily limit: the lower of its busiest day plus headroom, and a maximum share of the day's orders. Move the sliders to see what extra capacity would buy.">
      <div className="grid g3">
        <div className="stack">
          <label className="field">Max share of a day's orders per carrier: <b style={{ color: 'var(--text)' }}>{pct(maxShare, 0)}</b>
            <input type="range" min="0.2" max="1" step="0.05" value={maxShare} onChange={(e) => setMaxShare(Number(e.target.value))} style={{ width: '100%' }} aria-label="Max share per carrier" />
          </label>
          <label className="field">Extra capacity above each carrier's busiest day: <b style={{ color: 'var(--text)' }}>+{pct(headroom, 0)}</b>
            <input type="range" min="0" max="1.5" step="0.25" value={headroom} onChange={(e) => setHeadroom(Number(e.target.value))} style={{ width: '100%' }} aria-label="Extra capacity" />
          </label>
          {data && (
            <div className="grid g2">
              <div className="step"><div className="t">On-time within capacity</div>
                <div className="v" style={{ fontSize: 24, color: data.on_time >= 0.94 ? 'var(--good-ink)' : 'var(--text)' }}>{pct(data.on_time)}</div></div>
              <div className="step"><div className="t">With no limit</div><div className="v" style={{ fontSize: 24 }}>{pct(data.unconstrained_on_time)}</div></div>
            </div>
          )}
          {data && (
            <p className="small muted" style={{ margin: 0 }}>
              Busiest carrier-day: {pct(data.peak_daily_share, 0)} of orders · orders with no carrier left: {data.over_capacity_orders} ·
              expected cost ${data.expected_cost_per_order.toFixed(2)}/order
            </p>
          )}
        </div>
        <div className="span2">
          {!data ? <Loading /> : (
            <>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Share of Sept. orders</th>{CARRIERS.map((c) => <th key={c} className="num">{c}</th>)}</tr></thead>
                  <tbody>
                    {rows.map(([name, mix]) => (
                      <tr key={name}>
                        <td><b>{name}</b></td>
                        {CARRIERS.map((c) => (
                          <td key={c} className="num" style={{ background: `rgba(${PAL.heat}, ${(mix[c] || 0) * 0.75})`, color: (mix[c] || 0) > 0.5 ? '#fff' : undefined, fontWeight: (mix[c] || 0) > 0.3 ? 600 : 400 }}>
                            {pct(mix[c] || 0, 0)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row wrap small muted" style={{ marginTop: 10, gap: 14 }}>
                <span>Daily limit (busiest day + headroom):</span>
                {CARRIERS.map((c) => <span key={c}><b>{c}</b> {num(data.peak_limits[c])}</span>)}
                <span>· {num(data.avg_daily_orders)} orders on an average day</span>
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
