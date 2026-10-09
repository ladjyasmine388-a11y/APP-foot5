import type { BookingListResponse, BookingView, TeamView } from '@footfive/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Mes réservations CONFIRMÉES à venir : les seules qui peuvent servir de support à une session, une annonce ou un match.
 * Le serveur revérifie tout (propriété, état, déjà utilisée) : cette liste n'est qu'un confort de choix.
 */
export function useBookableBookings() {
  return useQuery({
    queryKey: ['bookings', 'bookable'],
    queryFn: async (): Promise<BookingView[]> => {
      const res = await api<BookingListResponse>('/bookings', {
        query: { when: 'upcoming', status: 'CONFIRMED', limit: 50 },
      });
      return res.items;
    },
  });
}

export function useMyTeams() {
  return useQuery({ queryKey: ['teams', 'mine'], queryFn: () => api<TeamView[]>('/me/teams') });
}

export const captainOf = (teams: TeamView[] | undefined): TeamView[] =>
  (teams ?? []).filter((team) => team.myRole === 'CAPTAIN');

/**
 * Horloge de l'interface : l'heure courante, rafraîchie à intervalle régulier. Appeler `Date.now()` directement dans le rendu
 * rendrait le résultat instable (et un composant « pur » ne doit pas lire l'heure) ; ce hook la lit hors du rendu.
 */
export function useNow(intervalMs = 30_000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const refresh = setTimeout(() => setNow(Date.now()), 0); // se recale dès l'activation
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => {
      clearTimeout(refresh);
      clearInterval(id);
    };
  }, [intervalMs, active]);
  return now;
}
