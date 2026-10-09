import type { AuthResponse, LoginInput, PublicUser, RegisterInput } from '@footfive/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, refreshSession, setAccessToken, setSessionLostHandler } from './api';

type Status = 'loading' | 'anon' | 'auth';

interface Auth {
  status: Status;
  user: PublicUser | null;
  isAdmin: boolean;
  login: (input: LoginInput) => Promise<PublicUser>;
  register: (input: RegisterInput) => Promise<PublicUser>;
  logout: () => Promise<void>;
  /** Relit le profil (après une modification ou la vérification de l'email). */
  reload: () => Promise<void>;
  setUser: (user: PublicUser) => void;
}

const AuthContext = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUserState] = useState<PublicUser | null>(null);

  const clear = useCallback(() => {
    setAccessToken(null);
    setUserState(null);
    setStatus('anon');
    queryClient.clear(); // aucune donnée d'un compte ne doit survivre à sa déconnexion
  }, [queryClient]);

  const accept = useCallback((res: AuthResponse): PublicUser => {
    setAccessToken(res.accessToken);
    setUserState(res.user);
    setStatus('auth');
    return res.user;
  }, []);

  // Au chargement : le cookie de rafraîchissement (httpOnly) rouvre la session sans nouvelle saisie.
  useEffect(() => {
    let alive = true;
    void refreshSession().then((res) => {
      if (!alive) return;
      if (res) accept(res);
      else setStatus('anon');
    });
    setSessionLostHandler(clear);
    return () => {
      alive = false;
      setSessionLostHandler(null);
    };
  }, [accept, clear]);

  const value = useMemo<Auth>(
    () => ({
      status,
      user,
      isAdmin: user?.platformRole === 'ADMIN',
      login: async (input) => accept(await api<AuthResponse>('/auth/login', { method: 'POST', body: input, auth: false })),
      register: async (input) => accept(await api<AuthResponse>('/auth/register', { method: 'POST', body: input, auth: false })),
      logout: async () => {
        try {
          await api('/auth/logout', { method: 'POST' });
        } finally {
          clear();
        }
      },
      reload: async () => {
        setUserState(await api<PublicUser>('/me'));
      },
      setUser: setUserState,
    }),
    [status, user, accept, clear],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): Auth {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé dans <AuthProvider>');
  return ctx;
}
