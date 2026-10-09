import { type CancellationPolicy, cancellationPolicySchema } from '@footfive/shared';

/** Politique appliquée si ni le complexe ni l'admin n'en ont défini une. */
export const FALLBACK_CANCELLATION_POLICY: CancellationPolicy = {
  freeUntilHoursBefore: 24,
  refundDeposit: false,
};

/** Interprète un JSON de la base ; une valeur corrompue retombe sur le niveau suivant plutôt que de bloquer. */
export function parseCancellationPolicy(raw: unknown): CancellationPolicy | null {
  const parsed = cancellationPolicySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type CancellationInitiator = 'PLAYER' | 'VENUE';

export interface RefundDecision {
  eligible: boolean;
  amountMinor: number;
}

const HOUR_MS = 3_600_000;

/**
 * Qui rembourse quoi quand une réservation est annulée ?
 *  - annulation par le COMPLEXE (ou la plateforme) : le client est remboursé INTÉGRALEMENT de ce qu'il a payé ;
 *  - annulation par le joueur, dans le délai gratuit (≥ N heures avant le début) : remboursement intégral ;
 *  - annulation tardive : l'acompte reste acquis, sauf si le complexe a choisi de le rembourser.
 */
export function decideRefund(args: {
  paidOnlineMinor: number;
  startsAt: Date;
  now: Date;
  policy: CancellationPolicy;
  initiator: CancellationInitiator;
}): RefundDecision {
  const { paidOnlineMinor, startsAt, now, policy, initiator } = args;
  if (paidOnlineMinor <= 0) return { eligible: false, amountMinor: 0 };
  if (initiator === 'VENUE') return { eligible: true, amountMinor: paidOnlineMinor };

  const hoursBefore = (startsAt.getTime() - now.getTime()) / HOUR_MS;
  const free = hoursBefore >= policy.freeUntilHoursBefore;
  return free || policy.refundDeposit
    ? { eligible: true, amountMinor: paidOnlineMinor }
    : { eligible: false, amountMinor: 0 };
}

/** Date limite d'annulation gratuite. */
export function freeCancellationDeadline(startsAt: Date, policy: CancellationPolicy): Date {
  return new Date(startsAt.getTime() - policy.freeUntilHoursBefore * HOUR_MS);
}
