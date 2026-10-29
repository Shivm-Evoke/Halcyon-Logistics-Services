import { Link } from 'react-router-dom';
import { Inbox, Layers, Warehouse, Truck, Radar, Bot, ArrowRight, Sparkles } from 'lucide-react';
import { useApi, pct } from '../api.js';
import { PageHead, Card, Badge, Loading } from '../components/ui.jsx';

// What each agent does, the rule it follows, and the limit beyond which a manager decides.
const AGENTS = [
  { id: 'intake', name: 'Intake', icon: Inbox, fixes: 'Incomplete addresses', drill: '/inbound', drillLabel: 'Inbound gateway',
    rules: 'Checks and repairs every order from email, API, EDI and files before the pick list. Claude reads emails the parser cannot and drafts a question to the client when an address cannot be completed.',
    limit: (s) => `Claude's reading is used only at ${pct(s.intakeConfidenceMin, 0)} confidence or more; changing a Tier 1 order needs approval.` },
  { id: 'wave', name: 'Wave Planner', icon: Layers, fixes: 'The 08:00 pick-list gap', drill: '/inbound', drillLabel: 'Inbound gateway (cutoff-aware promises)',
    rules: 'Opens a second pick wave between the 08:00 list and the 14:00 collection. Same-day orders join it by priority: SLA clients, then accounts threatening to leave, then first come.',
    limit: (s) => `Wave at ${s.secondWaveAt}, up to ${s.wave2CapacityPerWarehouse} orders per warehouse; more needs approval.` },
  { id: 'stock', name: 'Stock', icon: Warehouse, fixes: 'Stock at the wrong warehouse', drill: '/inventory', drillLabel: 'Inventory placement',
    rules: 'Learns each client\'s stock misses by destination region and places safety stock at the nearest warehouse overnight. It only learns from days already seen.',
    limit: (s) => `Triggers at a ${pct(s.stockMissThreshold, 0)} miss rate; up to ${s.transferLimitPerNight} new transfers a night without approval.` },
  { id: 'carrier', name: 'Carrier', icon: Truck, fixes: 'Slow carriers and Friday overflow', drill: '/carriers', drillLabel: 'Carrier scorecard',
    rules: 'Gives each order the carrier with the lowest rate plus expected cost of lateness, within daily capacity. Same-day and Tier 1 orders go only to A, B or C. Friday capacity is booked from Thursday.',
    limit: (s) => `Up to $${s.costCapUsd} above the cheapest carrier per order; more needs approval. Friday A–C capacity +${pct(s.fridayPrebookShare, 0)}.` },
  { id: 'watchtower', name: 'Watchtower', icon: Radar, fixes: 'Whatever risk is left', drill: '/control-tower', drillLabel: 'Exceptions control tower',
    rules: 'Re-scores every order before collection with the risk model and moves risky ones to the safest carrier with room. Key clients get a proactive message drafted by Claude.',
    limit: (s) => `Acts above ${pct(s.watchtowerRiskMin, 0)} risk; messages to Tier 1 or at-risk clients need approval.` },
];

function Recent({ agent }) {
  const { data } = useApi(`/agents/approvals?agent=${agent}&limit=4`);
  if (!data?.length) return <p className="small muted">No decisions yet. Run the operations day to see this agent work.</p>;
  return (
    <ul className="ops-lane" style={{ maxHeight: 'none' }}>
      {data.map((d) => (
        <li key={d.id} className="ops-event">
          <div className="row between small"><span className="muted num-tab">{d.sim_ts.slice(11)}</span>
            {d.reason_source === 'claude' ? <Badge tone="brand"><Sparkles size={11} /> AI</Badge> : <Badge>rules only</Badge>}</div>
          <div className="small">{d.reason}</div>
        </li>
      ))}
    </ul>
  );
}

export default function Agents() {
  const { data, error } = useApi('/agents/settings');
  if (!data) return <Loading error={error} />;
  const s = data.defaults;
  return (
    <>
      <PageHead title="Meet the agents" eyebrow="The solution · five agents and an Ops Lead">
        Each agent owns one cause of lateness. Fixed rules make the routine decisions, so results are repeatable and auditable;
        Claude, running on Azure AI Foundry, reads what rules cannot, explains each decision and handles the exceptions.
        Limits are enforced by the server, not by the AI.
      </PageHead>

      <Card className="section-gap">
        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <Bot size={22} style={{ flex: 'none' }} />
          <div>
            <b>Ops Lead</b>
            <p className="small" style={{ margin: '4px 0 0' }}>Claude coordinates the five agents: every two hours, and at the second wave, it looks at their decisions,
              re-runs any that conflict, and briefs the warehouse manager on what happened and what needs approval.</p>
          </div>
        </div>
      </Card>

      <div className="grid g3 section-gap">
        {AGENTS.map((a) => (
          <Card key={a.id} title={<span className="row" style={{ gap: 8 }}><a.icon size={16} /> {a.name}</span>} sub={`Fixes: ${a.fixes}`}>
            <p className="small">{a.rules}</p>
            <p className="small"><b>Limit:</b> {a.limit(s)}</p>
            <Recent agent={a.id} />
            <Link to={a.drill} className="small">Under the hood: {a.drillLabel} <ArrowRight size={11} /></Link>
          </Card>
        ))}
      </div>
    </>
  );
}
