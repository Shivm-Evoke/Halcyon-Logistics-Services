import { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts';
import { ResponsiveContainer } from '../components/motion.jsx';
import { PackagePlus, CheckCircle2 } from 'lucide-react';
import { api, useApi, pct, num, dt, PAL } from '../api.js';
import { PageHead, Card, Badge, Loading, Toast } from '../components/ui.jsx';
import DataTable from '../components/DataTable.jsx';
import { axisX, axisY, gridProps, lineProps, tip, Legend } from '../components/charts.jsx';

const WH = ['W1', 'W2', 'W3', 'W4', 'W5'];
const WH_NAME = { W1: 'Midwest 1', W2: 'Midwest 2', W3: 'Southeast', W4: 'Northeast', W5: 'West' };
const whColor = (w) => PAL.series[WH.indexOf(w)];
const monthLabel = (m) => new Date(`${m}-01T00:00`).toLocaleString('en-US', { month: 'short' });

export default function Inventory() {
  const { data, error, reload } = useApi('/inventory/overview');
  const [toast, setToast] = useState('');
  if (!data) return <Loading error={error} />;
  const { matrix, monthly, byWarehouse, clients, transfers } = data;
  const cell = (n, s) => matrix.find((m) => m.nearest === n && m.shipped_from === s);
  const maxCell = Math.max(...matrix.map((m) => m.n));
  const totalMiss = byWarehouse.reduce((s, w) => s + w.misses, 0);
  const trend = [...new Set(monthly.map((m) => m.month))].map((month) => ({
    month, ...Object.fromEntries(monthly.filter((m) => m.month === month).map((m) => [m.warehouse, m.misses])),
  }));

  const plan = async (c) => {
    await api('/inventory/transfers', { method: 'POST', body: { client_id: c.client_id, warehouse_id: c.warehouse_id, units: c.recommended_units, reason: `Cover ${c.misses} stock misses over 6 months` } });
    setToast(`Safety stock planned: ${c.recommended_units} units for ${c.client_name} at ${c.warehouse_id}`);
    reload();
  };

  return (
    <>
      <PageHead title="Inventory placement" eyebrow="Fix · I3 · 20% of late deliveries">
        When the warehouse nearest the customer is out of stock, the order ships from across the country and half of those arrive late.
        Placement moves from a quarterly review to monthly, demand-driven safety stock.
      </PageHead>

      <div className="grid g5 section-gap">
        {byWarehouse.map((w) => (
          <Card key={w.warehouse}>
            <div className="row between">
              <span className="row" style={{ gap: 8, fontWeight: 600 }}><span className="dot" style={{ background: whColor(w.warehouse) }} />{w.warehouse}</span>
              <span className="small muted">{WH_NAME[w.warehouse]}</span>
            </div>
            <div className="row" style={{ alignItems: 'baseline', gap: 6, marginTop: 12 }}>
              <span style={{ fontSize: 28, fontWeight: 600, }}>{pct(w.miss_rate)}</span>
              <span className="small muted">stock-outs</span>
            </div>
            <div className="small muted">on {num(w.demand)} orders</div>
            <div className="row small" style={{ marginTop: 12, gap: 6, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
              Late <b style={{ color: 'var(--bad-ink)' }}>{pct(w.late_if_miss, 0)}</b> on a miss <span className="muted">vs</span> <b>{pct(w.late_if_hit, 0)}</b>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid section-gap">
        <Card title="Where stock-outs get shipped from" sub={`${num(totalMiss)} orders left from a warehouse that was not the nearest. Darker = more orders.`}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Nearest ↓ · shipped from →</th>{WH.map((w) => <th key={w} className="num">{w}</th>)}</tr></thead>
              <tbody>
                {WH.map((n) => (
                  <tr key={n}>
                    <td><b>{n}</b> <span className="muted small">{WH_NAME[n]}</span></td>
                    {WH.map((s) => {
                      const c = cell(n, s);
                      const t = c ? c.n / maxCell : 0;
                      return (
                        <td key={s} className="num" style={{ background: c ? `rgba(${PAL.heat}, ${0.06 + t * 0.3})` : 'var(--surface-2)' }}
                          title={c ? `${num(c.n)} orders · ${num(c.miles)} mi · ${pct(c.late_rate, 0)} late` : 'Same warehouse'}>
                          {c ? <><b>{num(c.n)}</b><div className="small muted">{num(c.miles)} mi · {pct(c.late_rate, 0)}</div></> : <span className="faint">—</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Stock-outs per month, by nearest warehouse" sub="Steady every month: a planning gap, not a one-off event.">
          <Legend items={WH.map((w) => ({ label: `${w} ${WH_NAME[w]}`, color: whColor(w) }))} />
          <ResponsiveContainer width="100%" height={268}>
            <LineChart data={trend} margin={{ top: 14, right: 12, left: -8, bottom: 0 }}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="month" tickFormatter={monthLabel} {...axisX} />
              <YAxis {...axisY} />
              {tip((v) => `${num(v)} orders`, (m) => new Date(`${m}-01T00:00`).toLocaleString('en-US', { month: 'long' }))}
              {WH.map((w) => <Line key={w} dataKey={w} name={`${w} ${WH_NAME[w]}`} stroke={whColor(w)} {...lineProps} dot={{ ...lineProps.dot, fill: whColor(w) }} />)}
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div className="grid g3">
        <Card className="span2" title="Safety-stock recommendations"
          sub="For each client, the warehouse where they run out most. Recommended units = 1.5 × average monthly misses. At-risk accounts first.">
          <DataTable rows={clients} rowKey={(r) => r.client_id} pageSize={10} exportName="safety-stock-recommendations" searchPlaceholder="Search clients"
            columns={[
              { key: 'client_name', label: 'Client', render: (c) => <span className="row" style={{ gap: 8 }}>{c.client_name}{c.account_status === 'threatening_to_leave' && <Badge tone="bad">at risk</Badge>}</span> },
              { key: 'account_tier', label: 'Tier', filter: 'select' },
              { key: 'warehouse_id', label: 'WH', title: 'Warehouse', filter: 'select' },
              { key: 'misses', label: 'Misses', align: 'num', filter: 'range', render: (c) => num(c.misses) },
              { key: 'miss_rate', label: 'Miss rate', align: 'num', filter: 'range', render: (c) => pct(c.miss_rate) },
              { key: 'recommended_units', label: 'Units', title: 'Recommended safety-stock units', align: 'num', filter: 'range', render: (c) => <b>{c.recommended_units}</b> },
              { key: 'planned', label: 'Action', filter: 'select', value: (c) => (c.planned ? 'Planned' : 'To plan'),
                render: (c) => (c.planned ? <Badge tone="good"><CheckCircle2 size={12} /> Planned</Badge>
                  : <button className="btn sm" onClick={() => plan(c)}><PackagePlus size={13} /> Plan</button>) },
            ]} />
        </Card>
        <Card title="Planned transfers" sub="Safety stock to move to the nearest warehouse before the next monthly review.">
          {transfers.length === 0 ? <div className="loading small" style={{ padding: 32 }}>No transfers planned yet. Use <b>Plan</b> on a recommendation.</div> : (
            <ul className="list-clean">
              {transfers.map((t) => (
                <li key={t.id}>
                  <span className="dot" style={{ background: whColor(t.warehouse_id), marginTop: 6 }} />
                  <div style={{ flex: 1 }}>
                    <b>{t.units} units → {t.warehouse_id}</b> <span className="muted">· {t.client_name}</span>
                    <div className="small muted">{t.reason} · {dt(t.created_at)}</div>
                  </div>
                  <Badge tone="brand">{t.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}
