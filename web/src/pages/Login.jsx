// One sign-in for customers and Halcyon staff; each lands in their own area.
import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { LogIn } from 'lucide-react';
import { useSession, homeFor } from '../components/session.jsx';

export default function Login() {
  const { user, loading, signIn } = useSession();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const next = params.get('next');

  if (loading) return null;
  // Signed in: go back to the page that asked for sign-in when it belongs to this user's area.
  if (user) {
    const ownArea = next?.startsWith('/') && !next.startsWith('//') && (user.role === 'customer') === next.startsWith('/portal');
    return <Navigate to={ownArea ? next : homeFor(user)} replace />;
  }

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await signIn(email, password);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <div className="public login-page">
      <form className="card login-card" onSubmit={submit}>
        <Link to="/" className="brand public-brand"><div className="brand-mark">H</div><div>Halcyon Logistics</div></Link>
        <h2>Sign in</h2>
        {params.get('expired') && <div className="callout warn small">Your session ended. Please sign in again.</div>}
        <label className="field"><span>Email</span>
          <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field"><span>Password</span>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="callout bad small" role="alert">{error}</div>}
        <button className="btn primary" type="submit" disabled={busy}><LogIn size={15} /> {busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="small muted">Customers see their orders and shipments; Halcyon staff see operations.</p>
      </form>
    </div>
  );
}
