// The customer portal: its own simple layout, separate from the staff story.
import { NavLink, Route, Routes, Link } from 'react-router-dom';
import { LayoutDashboard, PackagePlus, Package, LogOut } from 'lucide-react';
import { useApi } from '../api.js';
import { useSession } from '../components/session.jsx';
import Dashboard from './Dashboard.jsx';
import NewOrder from './NewOrder.jsx';
import Shipments from './Shipments.jsx';
import Shipment from './Shipment.jsx';

export default function PortalLayout() {
  const { user, signOut } = useSession();
  const summary = useApi('/portal/summary');
  const client = summary.data?.client;
  return (
    <div className="portal">
      <header className="portal-bar">
        <Link to="/portal" className="brand public-brand"><div className="brand-mark">H</div><div>Halcyon Logistics<small>Customer portal</small></div></Link>
        <nav className="portal-nav">
          <NavLink to="/portal" end><LayoutDashboard size={15} /> Dashboard</NavLink>
          <NavLink to="/portal/new-order"><PackagePlus size={15} /> New order</NavLink>
          <NavLink to="/portal/shipments"><Package size={15} /> My shipments</NavLink>
        </nav>
        <div className="row" style={{ gap: 10 }}>
          <span className="small muted" title={user?.email}>{client ? `${client.client_name} · ${client.client_id}` : user?.email}</span>
          <button className="btn sm" onClick={() => signOut().then(() => window.location.assign('/'))}><LogOut size={14} /> Sign out</button>
        </div>
      </header>
      <main className="portal-page">
        <Routes>
          <Route index element={<Dashboard summary={summary} />} />
          <Route path="new-order" element={<NewOrder />} />
          <Route path="shipments" element={<Shipments />} />
          <Route path="shipments/:ref" element={<Shipment />} />
        </Routes>
      </main>
    </div>
  );
}
