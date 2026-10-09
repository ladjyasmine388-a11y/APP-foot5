import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/** Pas de nouvelle tentative sur une erreur « définitive » (4xx) : elle se reproduirait à l'identique. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) =>
          !(error instanceof ApiError && error.status >= 400 && error.status < 500) &&
          failureCount < 2,
      },
    },
  });
}

/** Paramètre `next` de connexion : uniquement un chemin interne (jamais une adresse externe → pas de redirection ouverte). */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return '/';
  return value;
}
