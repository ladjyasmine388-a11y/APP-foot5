import type { Prisma } from '../../generated/prisma/client.js';
import type { DomainEvents } from '../../infra/events/domain-events.js';

type Tx = Prisma.TransactionClient;

/**
 * Transitions d'état des activités sociales (sessions, annonces, matchs). Chaque fonction est IDEMPOTENTE :
 * elle ne change que ce qui est dans l'état attendu (`updateManyAndReturn` avec le statut dans le filtre) et
 * dit ce qu'elle a réellement fait, pour que l'appelant n'émette les événements qu'une fois, après la validation.
 */

export interface SoloCancelled {
  sessionId: string;
  playerIds: string[];
}
export interface MatchCancelled {
  matchId: string;
  participantIds: string[];
}
export interface RequestRejected {
  requestId: string;
  listingId: string;
}

export interface LifecycleOutcome {
  solo: SoloCancelled[];
  matches: MatchCancelled[];
  rejected: RequestRejected[];
}

export const emptyOutcome = (): LifecycleOutcome => ({ solo: [], matches: [], rejected: [] });

export function mergeOutcome(into: LifecycleOutcome, from: LifecycleOutcome): void {
  into.solo.push(...from.solo);
  into.matches.push(...from.matches);
  into.rejected.push(...from.rejected);
}

/** Émet les événements décrits par un résultat, APRÈS la validation de la transaction. */
export async function emitOutcome(events: DomainEvents, outcome: LifecycleOutcome): Promise<void> {
  for (const s of outcome.solo) await events.emit('solo.cancelled', s);
  for (const m of outcome.matches) await events.emit('match.cancelled', m);
  for (const r of outcome.rejected) await events.emit('opponent.request_rejected', r);
}

async function participantIdsOf(tx: Tx, matchId: string): Promise<string[]> {
  const rows = await tx.matchParticipant.findMany({ where: { matchId }, select: { userId: true } });
  return rows.map((r) => r.userId);
}

/** Annule une session « Complétez votre équipe » (et son match). La réservation de l'hôte n'est PAS touchée. */
export async function cancelSoloSessionTx(tx: Tx, sessionId: string): Promise<LifecycleOutcome> {
  const out = emptyOutcome();
  const claimed = await tx.soloSession.updateManyAndReturn({
    where: { id: sessionId, status: { in: ['OPEN', 'FULL', 'CONFIRMED'] } },
    data: { status: 'CANCELLED' },
    select: { id: true },
  });
  if (claimed.length === 0) return out;
  await tx.match.updateMany({ where: { soloSessionId: sessionId, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
  const players = await tx.soloPlayer.findMany({ where: { sessionId, status: 'JOINED' }, select: { userId: true } });
  out.solo.push({ sessionId, playerIds: players.map((p) => p.userId) });
  return out;
}

/** Rejette les demandes en attente d'une annonce. */
export async function rejectPendingRequestsTx(tx: Tx, listingId: string, now: Date): Promise<RequestRejected[]> {
  const rows = await tx.matchRequest.updateManyAndReturn({
    where: { listingId, status: 'REQUESTED' },
    data: { status: 'REJECTED', respondedAt: now },
    select: { id: true },
  });
  return rows.map((r) => ({ requestId: r.id, listingId }));
}

/** Annule une annonce adversaire : demandes en attente rejetées, demande acceptée annulée, match annulé. */
export async function cancelListingTx(tx: Tx, listingId: string, now: Date): Promise<LifecycleOutcome> {
  const out = emptyOutcome();
  const claimed = await tx.opponentListing.updateManyAndReturn({
    where: { id: listingId, status: { in: ['OPEN', 'ACCEPTED'] } },
    data: { status: 'CANCELLED' },
    select: { id: true },
  });
  if (claimed.length === 0) return out;
  out.rejected.push(...(await rejectPendingRequestsTx(tx, listingId, now)));
  await tx.matchRequest.updateMany({ where: { listingId, status: 'ACCEPTED' }, data: { status: 'CANCELLED', respondedAt: now } });
  const match = await tx.match.findFirst({ where: { opponentListingId: listingId, status: 'SCHEDULED' }, select: { id: true } });
  if (match) {
    await tx.match.update({ where: { id: match.id }, data: { status: 'CANCELLED' } });
    out.matches.push({ matchId: match.id, participantIds: await participantIdsOf(tx, match.id) });
  }
  return out;
}

/** Annule un match organisé par une équipe (hors session et annonce, qui ont leurs propres cycles). */
export async function cancelMatchTx(tx: Tx, matchId: string): Promise<LifecycleOutcome> {
  const out = emptyOutcome();
  const claimed = await tx.match.updateManyAndReturn({
    where: { id: matchId, status: 'SCHEDULED' },
    data: { status: 'CANCELLED' },
    select: { id: true },
  });
  if (claimed.length > 0) out.matches.push({ matchId, participantIds: await participantIdsOf(tx, matchId) });
  return out;
}

/**
 * La réservation support n'existe plus (annulée, expirée, no-show) : tout ce qui reposait dessus s'arrête.
 * Appelé par l'événement `booking.cancelled` ET par le balayage périodique (filet de sécurité si l'événement est perdu).
 */
export async function cascadeBookingTx(tx: Tx, bookingId: string, now: Date): Promise<LifecycleOutcome> {
  const out = emptyOutcome();
  const [solo, listing, match] = await Promise.all([
    tx.soloSession.findUnique({ where: { bookingId }, select: { id: true } }),
    tx.opponentListing.findUnique({ where: { bookingId }, select: { id: true } }),
    tx.match.findUnique({ where: { bookingId }, select: { id: true, source: true } }),
  ]);
  if (solo) mergeOutcome(out, await cancelSoloSessionTx(tx, solo.id));
  if (listing) mergeOutcome(out, await cancelListingTx(tx, listing.id, now));
  if (match?.source === 'TEAM') mergeOutcome(out, await cancelMatchTx(tx, match.id));
  return out;
}

/**
 * Termine un match dont l'heure de fin est passée. Les statistiques ne sont créditées que si CETTE transaction
 * a réellement fait passer le match à COMPLETED (jamais deux fois). Le client de la réservation est exclu du
 * décompte : la maintenance des réservations le compte déjà.
 */
export async function completeMatchTx(tx: Tx, matchId: string): Promise<boolean> {
  const claimed = await tx.match.updateManyAndReturn({
    where: { id: matchId, status: 'SCHEDULED' },
    data: { status: 'COMPLETED' },
    select: { id: true, soloSessionId: true, opponentListingId: true, bookingId: true },
  });
  const match = claimed[0];
  if (!match) return false;

  const [booking, participants] = await Promise.all([
    tx.booking.findUniqueOrThrow({ where: { id: match.bookingId }, select: { userId: true } }),
    tx.matchParticipant.findMany({ where: { matchId }, select: { userId: true } }),
  ]);
  for (const { userId } of participants) {
    if (userId === booking.userId) continue;
    await tx.playerStats.upsert({
      where: { userId },
      create: { userId, matchesPlayed: 1 },
      update: { matchesPlayed: { increment: 1 } },
    });
  }
  if (match.soloSessionId) {
    await tx.soloSession.updateMany({
      where: { id: match.soloSessionId, status: { in: ['OPEN', 'FULL', 'CONFIRMED'] } },
      data: { status: 'COMPLETED' },
    });
  }
  if (match.opponentListingId) {
    await tx.opponentListing.updateMany({ where: { id: match.opponentListingId, status: 'ACCEPTED' }, data: { status: 'COMPLETED' } });
  }
  return true;
}
