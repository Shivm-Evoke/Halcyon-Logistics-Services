// Public homepage: what Halcyon Logistics does, and the way in for customers and staff.
import { Link } from 'react-router-dom';
import { Truck, Warehouse, Clock, ShieldCheck, ArrowRight } from 'lucide-react';
import { useSession, homeFor } from '../components/session.jsx';

const FACTS = [
  ['48,340', 'deliveries in the last six months'],
  ['5', 'warehouses across the US'],
  ['6', 'carrier partners'],
];
const SERVICES = [
  [Warehouse, 'Warehousing and fulfilment', 'Stock held close to your customers, picked the day the order arrives.'],
  [Truck, 'Same-day to standard delivery', 'Same day, next day, two-day and standard, with the carrier chosen for each order.'],
  [Clock, 'Live tracking', 'Every order from received to delivered, with a promised date you can plan around.'],
  [ShieldCheck, 'Orders checked on arrival', 'Addresses and item codes checked before picking, so mistakes are fixed, not shipped.'],
];

export default function Home() {
  const { user } = useSession();
  return (
    <div className="public">
      <header className="public-bar">
        <div className="brand public-brand"><div className="brand-mark">H</div><div>Halcyon Logistics</div></div>
        {user
          ? <Link className="btn primary" to={homeFor(user)}>Go to {user.role === 'customer' ? 'your portal' : 'operations'} <ArrowRight size={15} /></Link>
          : <Link className="btn primary" to="/login">Sign in <ArrowRight size={15} /></Link>}
      </header>
      <section className="public-hero">
        <p className="public-kicker">Warehousing · fulfilment · delivery</p>
        <h1>Your orders, delivered when we said they would be.</h1>
        <p className="public-lede">
          Halcyon Logistics stores, picks and delivers for 280 businesses. Place orders by email, file, API or our customer
          portal, and follow every shipment until it arrives.
        </p>
        <div className="row" style={{ gap: 10 }}>
          <Link className="btn primary" to="/login">Customer sign in</Link>
          <Link className="btn" to="/login">Staff sign in</Link>
        </div>
      </section>
      <section className="public-facts">
        {FACTS.map(([n, label]) => <div key={label}><b>{n}</b><span>{label}</span></div>)}
      </section>
      <section className="public-services">
        {SERVICES.map(([Icon, title, text]) => (
          <div key={title} className="card"><Icon size={20} /><h3>{title}</h3><p className="muted small">{text}</p></div>
        ))}
      </section>
      <footer className="public-foot small muted">Halcyon Logistics · a hackathon demonstration company</footer>
    </div>
  );
}
