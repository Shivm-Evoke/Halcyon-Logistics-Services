// Who is signed in to the website (customer or Halcyon staff), shared by every page.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from '../api.js';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [state, setState] = useState({ user: null, loading: true });
  useEffect(() => {
    api('/session').then((user) => setState({ user, loading: false })).catch(() => setState({ user: null, loading: false }));
  }, []);
  const signIn = useCallback(async (email, password) => {
    const user = await api('/session/login', { method: 'POST', body: { email, password } });
    setState({ user, loading: false });
    return user;
  }, []);
  const signOut = useCallback(async () => {
    await api('/session/logout', { method: 'POST' }).catch(() => {});
    setState({ user: null, loading: false });
  }, []);
  return <SessionContext.Provider value={{ ...state, signIn, signOut }}>{children}</SessionContext.Provider>;
}

/** { user, loading, signIn(email, password), signOut() } */
export const useSession = () => useContext(SessionContext);

export const homeFor = (user) => (user?.role === 'customer' ? '/portal' : '/problem');

/** Renders children only for the given role; others go to sign in, or to their own area. */
export function RequireRole({ role, children }) {
  const { user, loading } = useSession();
  const { pathname } = useLocation();
  if (loading) return null;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(pathname)}`} replace />;
  if (user.role !== role) return <Navigate to={homeFor(user)} replace />;
  return children;
}
