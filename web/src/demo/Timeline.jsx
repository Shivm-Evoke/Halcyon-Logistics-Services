// One order's event log, read by all three sides. Internal view: who did what and why. Public view: plain labels only.
import { Bot, User, Truck, Building2, ShieldCheck } from 'lucide-react';

const LABELS = {
  received: 'Order received', auto_fixed: 'Formatting fixed automatically', held: 'On hold: address incomplete', client_notified: 'Message sent to the client',
  client_fixed: 'Address corrected', released: 'Released to the warehouse', wave_assigned: 'Pick wave planned', carrier_selected: 'Carrier selected',
  tracking_sent: 'Tracking link sent to the recipient', shipped: 'Collected by the carrier', delayed: 'Carrier reports a delay',
  risk_flagged: 'Watchtower flagged the order', approval_requested: 'Waiting for supervisor approval', approved: 'Approved by supervisor',
  rejected: 'Rejected', delivered: 'Delivered', rated: 'Recipient rated the delivery',
};
const ACTORS = {
  client: ['Client', User], recipient: ['Recipient', User], intake_agent: ['Intake agent', Bot], wave_planner: ['Wave Planner', Bot],
  carrier_agent: ['Carrier agent', Bot], watchtower: ['Watchtower', Bot], supervisor: ['Supervisor', ShieldCheck], cs_rep: ['Customer success', Building2],
  carrier: ['Carrier (simulated)', Truck], system: ['Halcyon', Building2],
};
const TONE = { held: 'warn', delayed: 'bad', risk_flagged: 'warn', approval_requested: 'warn', rejected: 'bad', delivered: 'good', approved: 'good', client_fixed: 'good' };

const time = (ts) => String(ts).slice(11, 16);

function detailOf(e) {
  const d = e.detail || {};
  if (e.type === 'held') return (d.issues || []).join('; ');
  if (e.type === 'client_notified' || e.type === 'approval_requested') return `${d.message}${d.source ? `\n(${d.source === 'claude' ? 'drafted by Claude' : d.source === 'cs_rep' ? 'written by customer success' : 'template: rules only'})` : ''}`;
  if (e.type === 'wave_assigned') return `${d.wave === 2 ? 'Second wave, 13:00' : d.wave === 1 ? 'First wave, 08:00' : 'Tomorrow\'s pick list'} at ${d.warehouse_id}: ${d.rule}`;
  if (e.type === 'carrier_selected') return `Carrier ${d.carrier_id}: ${d.rule}${d.extra_cost_usd ? ` (+$${d.extra_cost_usd})` : ''}`;
  if (e.type === 'released') return [d.commitment_type && `${d.commitment_type.replace('_', '-')}, promised ${d.promised_date}`, ...(d.notes || [])].filter(Boolean).join('\n');
  if (e.type === 'tracking_sent') return `${d.channel}: ${d.url}`;
  if (e.type === 'risk_flagged') return d.reason;
  if (e.type === 'delivered') return d.late ? 'A day late, client told in advance' : 'On time';
  if (e.type === 'rated') return d.up ? '👍' : '👎';
  return '';
}

// The client sees what happened to their order and every message, but not Halcyon's internal steps or rules.
const INTERNAL = new Set(['risk_flagged', 'approval_requested', 'approved', 'rejected', 'tracking_sent']);
const clientDetail = (e) => {
  const d = e.detail || {};
  if (e.type === 'client_notified') return d.message;
  if (e.type === 'held') return (d.issues || []).join('; ');
  if (e.type === 'released') return d.commitment_type ? `${d.commitment_type.replace('_', '-')}, promised ${d.promised_date}` : '';
  if (e.type === 'wave_assigned') return d.wave === 2 ? 'On the 13:00 second pick list: same-day kept' : d.wave === 1 ? 'On the 08:00 pick list' : 'On tomorrow\'s pick list';
  if (e.type === 'carrier_selected') return `Carrier ${d.carrier_id}`;
  if (e.type === 'delivered') return d.late ? 'A day late; we told you in advance' : 'On time';
  return '';
};

export default function Timeline({ events, audience = 'internal' }) {
  if (!events?.length) return <div className="small muted">Nothing yet.</div>;
  const shown = audience === 'client' ? events.filter((e) => !INTERNAL.has(e.type)) : events;
  return (
    <ul className="tl">
      {shown.map((e, i) => {
        if (audience === 'client') {
          const d = clientDetail(e);
          return <li key={e.id ?? i} className={TONE[e.type] || ''}><div className="t">{LABELS[e.type] || e.type}</div><div className="m">{time(e.ts)}</div>{d && <div className="d">{d}</div>}</li>;
        }
        if (audience === 'public') return <li key={i} className={TONE[e.type] || ''}><div className="t">{e.label}</div><div className="m">{time(e.ts)}</div></li>;
        const [who, Icon] = ACTORS[e.actor] || [e.actor, Building2];
        const d = detailOf(e);
        return (
          <li key={e.id ?? i} className={TONE[e.type] || ''}>
            <div className="t">{LABELS[e.type] || e.type}</div>
            <div className="m row" style={{ gap: 6 }}><Icon size={12} /> {who} · {time(e.ts)}</div>
            {d && <div className="d">{d}</div>}
          </li>
        );
      })}
    </ul>
  );
}
