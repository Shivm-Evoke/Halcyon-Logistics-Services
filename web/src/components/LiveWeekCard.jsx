import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { useApi, pct, num } from '../api.js';
import { Card, Badge, Meter } from './ui.jsx';
import DataTable from './DataTable.jsx';

const KIND_TONE = { 'auto-fix': 'brand', hold: 'warn', reject: 'bad', flag: 'neutral' };
const KIND_LABEL = { 'auto-fix': 'Auto-fixed', hold: 'Held for client', reject: 'Rejected', flag: 'Flagged, accepted' };

// Scorecard of the synthetic live week: every injected problem against what the gateway did with it.
export default function LiveWeekCard() {
  const { data, error } = useApi('/ingest/live-week');
  if (error) {
    return (
      <Card title="Synthetic live week" className="section-gap">
        <div className="small muted">Not run yet. Generate and send a realistic week of orders with <span className="mono">npm run demo:week</span>.</div>
      </Card>
    );
  }
  if (!data) return null;
  const tiles = [
    ['Outcome matched ground truth', pct(data.status_accuracy), data.status_accuracy >= 0.99],
    ['Injected problems caught', `${num(data.defect_detection.caught)} / ${num(data.defect_detection.injected)}`, data.defect_detection.caught === data.defect_detection.injected],
    ['Clean orders wrongly stopped', `${data.clean_orders.wrongly_stopped} / ${num(data.clean_orders.total)}`, data.clean_orders.wrongly_stopped === 0],
    ['Retries with the same key', `${data.idempotent_retries.replayed} / ${data.idempotent_retries.tried} replayed`, data.idempotent_retries.replayed === data.idempotent_retries.tried],
  ];
  return (
    <Card className="section-gap" title={`Synthetic live week · ${data.week}`}
      sub={`${num(data.messages)} messages and ${num(data.orders)} orders built from the supplied data (each client's volume, channel, regions and order times), with realistic problems injected and recorded as ground truth. Processed in ${data.seconds.toFixed(1)} s. Regenerate with npm run demo:week.`}>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        {tiles.map(([label, value, ok]) => (
          <div key={label} className="step">
            <div className="t">{ok ? <CheckCircle2 size={13} color="var(--good-ink)" /> : <AlertTriangle size={13} color="var(--warn-ink)" />} {label}</div>
            <div className="v" style={{ fontSize: 22 }}>{value}</div>
          </div>
        ))}
      </div>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        {data.by_channel.map((c) => (
          <div key={c.channel} className="small">
            <div className="row between"><b>{c.channel}</b><span className="muted">{num(c.orders)} orders · {pct(c.with_defects / (c.orders || 1), 0)} with problems</span></div>
            <div className="muted" style={{ marginTop: 4 }}>{num(c.accepted)} clean · {num(c.corrected)} fixed · {num(c.held)} held · {num(c.rejected + c.duplicate)} rejected</div>
          </div>
        ))}
      </div>
      <DataTable rows={data.defects} rowKey={(d) => d.code} pageSize={10} search={false} initialSort={{ key: 'injected', dir: 'desc' }}
        columns={[
          { key: 'label', label: 'Injected problem', render: (d) => <b>{d.label}</b> },
          { key: 'kind', label: 'Expected handling', filter: 'select', value: (d) => KIND_LABEL[d.kind], render: (d) => <Badge tone={KIND_TONE[d.kind]}>{KIND_LABEL[d.kind]}</Badge> },
          { key: 'injected', label: 'Injected', align: 'num', filter: 'range', render: (d) => num(d.injected) },
          { key: 'caught', label: 'Caught', align: 'num', filter: 'range', render: (d) => num(d.caught) },
          { key: 'rate', label: 'Detection', align: 'num', filter: 'range', value: (d) => Math.round(d.rate * 1000) / 10,
            render: (d) => <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}><span style={{ width: 70 }}><Meter value={d.rate} color={d.rate === 1 ? 'var(--good)' : 'var(--warn)'} /></span><b>{pct(d.rate, 0)}</b></span> },
        ]} />
    </Card>
  );
}
