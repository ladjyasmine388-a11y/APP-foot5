import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '../lib/auth';
import { Loading } from './ui';
import { ForbiddenPage } from '../pages/NotFound';

/** Page réservée aux comptes connectés : sinon connexion, puis retour ici. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Loading />;
  if (status === 'anon')
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );
  return <>{children}</>;
}

/** Réservé à l'administration de la plateforme. Le serveur refait de toute façon la vérification à chaque appel. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { status, isAdmin } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Loading />;
  if (status === 'anon')
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  return isAdmin ? <>{children}</> : <ForbiddenPage />;
}
