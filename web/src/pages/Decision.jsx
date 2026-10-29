import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { XCircle, CheckCircle2, ArrowRight } from 'lucide-react';
import { api, pct, usdK } from '../api.js';
import { PageHead, Card, Loading } from '../components/ui.jsx';

const ROLLOUT = [
  { when: 'Weeks 1–2', what: 'Pilot at one warehouse: second pick wave and carrier agent, managers approving every exception.' },
  { when: 'Weeks 3–4', what: 'Add Intake on the email inbox and the Watchtower; approvals only above the limits.' },
  { when: 'Weeks 5–8', what: 'All five warehouses; Stock agent places safety stock; weekly on-time reported to leadership.' },
  { when: 'Every week', what: 'One number decides whether to continue: on-time delivery, against the 94% industry benchmark.' },
];

export default function Decision() {
  const [replay, setReplay] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api('/agents/replay', { method: 'POST', body: {} }).then(setReplay).catch(setError); }, []);
  if (!replay) return <Loading error={error} />;
  const { overall, money, waterfall } = replay;
  const carrierStep = waterfall.find((w) => w.agent === 'carrier');
  const beforeCarrier = waterfall[waterfall.indexOf(carrierStep) - 1];

  return (
    <>
      <PageHead title="The decision" eyebrow="For leadership">
        Halcyon's late deliveries are decided before the truck leaves. The recommendation follows from that.
      </PageHead>

      <div className="grid g2 section-gap">
        <Card>
          <div className="row small" style={{ gap: 8, marginBottom: 10, color: 'var(--bad-ink)' }}><XCircle size={15} /> Don't sign the routing contract as scoped</div>
          <p style={{ fontSize: 'var(--t-lg)', fontWeight: 600, lineHeight: 1.35, margin: 0 }}>Route length and stops make no difference to on-time delivery in six months of data.</p>
          <p className="small muted">The routing product optimises the one step that is not causing the delay.</p>
        </Card>
        <Card>
          <div className="row small" style={{ gap: 8, marginBottom: 10, color: 'var(--good-ink)' }}><CheckCircle2 size={15} /> Run the operations agents</div>
          <p style={{ fontSize: 'var(--t-lg)', fontWeight: 600, lineHeight: 1.35, margin: 0 }}>
            On-time from {pct(overall.actual)} to {pct(overall.agents)} on the same six months, saving {usdK(money.netUsd)} net.
          </p>
          <p className="small muted">The carrier agent alone adds {((carrierStep.onTime - beforeCarrier.onTime) * 100).toFixed(1)} points; the second wave fixes the 08:00 gap the routing product cannot see.</p>
        </Card>
      </div>

      <div className="grid g2 section-gap">
        <Card title="What leadership approves" sub="The limits the agents work within; everything above them comes to a manager.">
          <ul className="small">
            <li>A second pick wave at each warehouse, and the warehouse hours to pick it.</li>
            <li>Carrier contracts with capacity on A, B and C, booked from Thursday for Fridays.</li>
            <li>Safety stock at the nearest warehouse for clients who keep missing it.</li>
            <li>Claude on Halcyon's Azure AI Foundry, reading order emails and explaining decisions.</li>
            <li>The approval limits: extra carrier cost per order, transfers per night, messages to key clients.</li>
          </ul>
        </Card>
        <Card title="Rollout" sub="Measured weekly from the first week.">
          <ol className="list-clean">
            {ROLLOUT.map((r) => <li key={r.when} className="small" style={{ gap: 10 }}><b style={{ minWidth: 90 }}>{r.when}</b> {r.what}</li>)}
          </ol>
        </Card>
      </div>

      <div className="callout section-gap">
        <span>The {pct(overall.agents)} rests on stated assumptions about carrier and warehouse capacity. Change them and re-run on <Link to="/six-months">Six months with agents <ArrowRight size={11} /></Link></span>
      </div>
    </>
  );
}
