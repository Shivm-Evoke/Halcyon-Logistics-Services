import { useEffect } from 'react';
import { CAUSES, pct } from '../api.js';
import { CountUp } from './motion.jsx';

export function PageHead({ title, eyebrow, children, actions }) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {actions && <div className="row wrap" style={{ flex: 'none' }}>{actions}</div>}
    </div>
  );
}

export function Card({ title, sub, actions, children, className = '', style, flush }) {
  return (
    <section className={`card ${flush ? 'flush' : ''} ${className}`} style={style}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {sub && <p>{sub}</p>}
          </div>
          {actions && <div className="row wrap" style={{ flex: 'none' }}>{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

const TONE_COLOR = { bad: 'var(--bad)', good: 'var(--good-ink)', warn: 'var(--warn-ink)' };
const TONE_BAR = { bad: 'var(--bad)', good: 'var(--good)', warn: 'var(--warn)' };

/** Stat tile. `bar` (0–1) draws a thin progress rule under the value. */
export function Kpi({ label, value, sub, icon: Icon, tone, bar }) {
  return (
    <div className="card kpi">
      <div className="label">{Icon && <Icon size={14} strokeWidth={2} />}{label}</div>
      <div className="value" style={{ color: TONE_COLOR[tone] }}><CountUp value={value} /></div>
      {sub && <div className="sub">{sub}</div>}
      {bar != null && <div className="accent-bar"><span style={{ width: `${Math.min(100, bar * 100)}%`, background: TONE_BAR[tone] || 'var(--accent)' }} /></div>}
    </div>
  );
}

export const Badge = ({ tone = 'neutral', children }) => <span className={`badge b-${tone}`}>{children}</span>;

export function CauseTag({ cause }) {
  const c = CAUSES[cause];
  if (!c) return <span className="muted">—</span>;
  return <span className="row" style={{ gap: 7 }}><span className="dot" style={{ background: c.color }} />{c.label}</span>;
}

export function RiskBadge({ risk }) {
  const tone = risk >= 0.6 ? 'bad' : risk >= 0.4 ? 'warn' : 'good';
  return <Badge tone={tone}>{pct(risk, 0)} risk</Badge>;
}

export function Meter({ value, color = 'var(--accent)', max = 1 }) {
  return <div className="meter"><span style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }} /></div>;
}

export function Loading({ error }) {
  if (error) return <div className="callout bad">Could not load data: {error.message}. Is the API running on port 4000?</div>;
  return (
    <div className="stack" style={{ padding: '8px 0' }}>
      <div className="skeleton" style={{ width: 220, height: 22 }} />
      <div className="skeleton" style={{ width: '60%' }} />
      <div className="grid g4" style={{ marginTop: 24 }}>{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 96, }} />)}</div>
      <div className="skeleton" style={{ height: 280, marginTop: 16 }} />
    </div>
  );
}

export function Toast({ message, onDone }) {
  useEffect(() => {
    if (!message) return undefined;
    const t = setTimeout(onDone, 2800);
    return () => clearTimeout(t);
  }, [message, onDone]);
  return message ? <div className="toast">{message}</div> : null;
}
