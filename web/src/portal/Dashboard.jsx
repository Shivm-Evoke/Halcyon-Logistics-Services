import { Link } from 'react-router-dom';
import { PackagePlus } from 'lucide-react';
import { pct, num } from '../api.js';
import { PageHead, Kpi, Loading } from '../components/ui.jsx';
import { STAGES, STAGE_LABEL } from './stages.js';

export default function Dashboard({ summary }) {
  if (!summary.data) return <Loading error={summary.error} />;
  const { client, history, byStage } = summary.data;
  const open = STAGES.slice(0, -1).reduce((n, s) => n + (byStage[s] || 0), 0);
  return (
    <>
      <PageHead title={`Welcome, ${client.client_name}`} eyebrow={`${client.account_tier} · ${client.region}`}
        actions={<Link className="btn primary" to="/portal/new-order"><PackagePlus size={15} /> New order</Link>}>
        Your orders with Halcyon at a glance.
      </PageHead>
      <div className="grid g4 section-gap">
        <Kpi label="On time, last 90 days" value={pct(history.on_time)} sub={`${num(history.orders)} deliveries`} />
        <Kpi label="Open shipments" value={num(open)} sub="Received to in transit" />
        <Kpi label="On hold" value={num(byStage.on_hold || 0)} sub="Need a fix from you" tone={byStage.on_hold ? 'warn' : undefined} />
        <Kpi label="Delivered" value={num(byStage.delivered || 0)} sub="Orders with Halcyon" />
      </div>
      <div className="card section-gap">
        <div className="row wrap" style={{ gap: 24 }}>
          {[...STAGES, 'on_hold'].map((s) => (
            <Link key={s} to={`/portal/shipments?stage=${s}`} className="stage-count"><b>{num(byStage[s] || 0)}</b><span>{STAGE_LABEL[s]}</span></Link>
          ))}
        </div>
      </div>
    </>
  );
}
