import { Link, useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { PERSONAS, getPersona, setPersona } from './persona.js';
import './demo.css';

/** Top bar of every demo screen: who you are signed in as, and a way to switch. */
export default function DemoBar({ persona, children }) {
  const navigate = useNavigate();
  const p = PERSONAS[persona ?? getPersona()];
  const signOut = () => { setPersona(null); navigate('/login'); };
  return (
    <header className="demo-bar">
      <div className="who">
        <div className="brand-mark">H</div>
        <div>Halcyon{p ? ` · ${p.label}` : ''}<small>{p ? `${p.who} · ${p.account}` : 'Demo'}</small></div>
      </div>
      <div className="row wrap" style={{ gap: 10 }}>
        {children}
        <span className="demo-badge">Demo: no real login, email or SMS</span>
        {p && <button className="btn sm" onClick={signOut}><LogOut size={13} /> Switch persona</button>}
        {!p && <Link className="btn sm" to="/login">Sign in</Link>}
      </div>
    </header>
  );
}
