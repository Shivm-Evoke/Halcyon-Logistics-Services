// Demo sign-in: one click per persona. Nothing is checked; the persona is remembered for this browser tab only.
import { useNavigate } from 'react-router-dom';
import { Building2, ShieldCheck, LineChart, Smartphone } from 'lucide-react';
import DemoBar from './DemoBar.jsx';
import { PERSONAS, setPersona } from './persona.js';

const ICONS = { client: Building2, ops: ShieldCheck, analyst: LineChart };
const LANDS = { client: 'Client portal: place orders, fix problems, read messages', ops: 'Ops console: every order\'s event log, approvals, carrier events', analyst: 'The full analysis: why Halcyon is late and the decision' };

export default function Login() {
  const navigate = useNavigate();
  const signIn = (key) => { setPersona(key); navigate(PERSONAS[key].home); };
  return (
    <div className="demo">
      <DemoBar persona={null} />
      <div className="demo-body" style={{ maxWidth: 1000 }}>
        <h1 style={{ fontSize: 26 }}>Sign in to Halcyon</h1>
        <p className="muted">One order, three people, one event log. Pick who you are; open another tab to be someone else at the same time.</p>
        <div className="persona-grid">
          {Object.entries(PERSONAS).map(([key, p]) => {
            const Icon = ICONS[key];
            return (
              <button key={key} className="persona" onClick={() => signIn(key)} aria-label={`Sign in as ${p.label}`}>
                <div className="title"><Icon size={18} /> {p.label}</div>
                <div className="small muted">{p.who}</div>
                <div className="fake">{p.account}</div>
                <div className="fake">••••••••</div>
                <div className="small">{LANDS[key]}</div>
                <span className="btn primary" style={{ alignSelf: 'flex-start' }}>Sign in</span>
              </button>
            );
          })}
        </div>
        <div className="callout section-gap small"><Smartphone size={15} /> The recipient doesn't sign in: they get a tracking link by SMS (shown as a preview in the demo).</div>
      </div>
    </div>
  );
}
