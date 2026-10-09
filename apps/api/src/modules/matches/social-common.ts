import { HttpStatus } from '@nestjs/common';
import type { PlayerLevel } from '@footfive/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import type { PrismaService } from '../../infra/database/prisma.service.js';

/** Client Prisma ou transaction : les mêmes requêtes servent dans les deux cas. */
export type Db = PrismaService | Prisma.TransactionClient;

/** Fuseau des filtres « date / heure » des listes publiques (la plateforme ne couvre que l'Algérie au MVP). */
export const PLATFORM_TZ = 'Africa/Algiers';

export const LEVEL_RANK: Record<PlayerLevel, number> = { BEGINNER: 0, INTERMEDIATE: 1, ADVANCED: 2 };

/** Niveaux voisins (±1) ou activité ouverte à tous (`null`). */
export const levelsCompatible = (a: PlayerLevel, b: PlayerLevel | null): boolean =>
  b === null || Math.abs(LEVEL_RANK[a] - LEVEL_RANK[b]) <= 1;

export const conflict = (
  code: 'CONFLICT' | 'SESSION_FULL' | 'SESSION_CLOSED' | 'SCHEDULE_CONFLICT' | 'LEVEL_INCOMPATIBLE' | 'BOOKING_NOT_ELIGIBLE' | 'TEAM_TOO_SMALL' | 'ALREADY_JOINED',
  message: string,
): AppException => new AppException(code, HttpStatus.CONFLICT, message);

export const venueBrief = { id: true, slug: true, name: true, city: true, district: true } as const;
export const personBrief = { id: true, firstName: true, lastName: true, avatarUrl: true, status: true } as const;
export const teamBrief = { id: true, name: true, logoUrl: true } as const;

/** Verrouille la ligne d'une réservation : les créations concurrentes sur la même réservation passent l'une après l'autre. */
export async function lockBooking(tx: Prisma.TransactionClient, bookingId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId}::uuid FOR UPDATE`;
}

/** Idem pour une session solo (compteur de places) et une annonce adversaire (acceptation d'une seule demande). */
export async function lockSoloSession(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "SoloSession" WHERE "id" = ${id}::uuid FOR UPDATE`;
}
export async function lockListing(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "OpponentListing" WHERE "id" = ${id}::uuid FOR UPDATE`;
}

export interface EligibleBooking {
  id: string;
  userId: string | null;
  venueId: string;
  fieldId: string;
  startsAt: Date;
  endsAt: Date;
  fieldCapacity: number;
}

/**
 * Une réservation ne peut servir de support à une session, une annonce ou un match que si elle est CONFIRMÉE
 * (acompte payé ou réservation manuelle du complexe), à venir, de type standard et pas déjà utilisée.
 * À appeler APRÈS `lockBooking`, dans la même transaction.
 *  - `owner` : le joueur doit être le client de la réservation ;
 *  - `venueId` : la réservation doit appartenir à ce complexe (personnel du complexe).
 * Une réservation d'autrui est indiscernable d'une réservation inexistante (404).
 */
export async function requireEligibleBooking(
  db: Db,
  bookingId: string,
  scope: { ownerId?: string; venueId?: string },
  now: Date,
): Promise<EligibleBooking> {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    include: {
      field: { select: { capacity: true } },
      soloSession: { select: { id: true } },
      opponentListing: { select: { id: true } },
      match: { select: { id: true } },
    },
  });
  if (
    !booking ||
    (scope.ownerId !== undefined && booking.userId !== scope.ownerId) ||
    (scope.venueId !== undefined && booking.venueId !== scope.venueId)
  ) {
    throw Errors.notFound('Réservation introuvable');
  }
  if (booking.bookingType !== 'STANDARD' || booking.status !== 'CONFIRMED') {
    throw conflict('BOOKING_NOT_ELIGIBLE', 'Seule une réservation confirmée peut servir de support');
  }
  if (booking.startsAt <= now) throw conflict('BOOKING_NOT_ELIGIBLE', 'Cette réservation a déjà commencé');
  if (booking.soloSession || booking.opponentListing || booking.match) {
    throw conflict('BOOKING_NOT_ELIGIBLE', 'Cette réservation est déjà utilisée pour une autre activité');
  }
  return {
    id: booking.id,
    userId: booking.userId,
    venueId: booking.venueId,
    fieldId: booking.fieldId,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    fieldCapacity: booking.field.capacity,
  };
}

/** Le joueur a-t-il déjà un match à venir qui chevauche cette plage ? (`exceptMatchId` : le match de la session visée.) */
export async function hasScheduleClash(
  db: Db,
  userId: string,
  range: { startsAt: Date; endsAt: Date },
  exceptMatchId?: string,
): Promise<boolean> {
  const clash = await db.matchParticipant.findFirst({
    where: {
      userId,
      match: {
        status: 'SCHEDULED',
        startsAt: { lt: range.endsAt },
        endsAt: { gt: range.startsAt },
        ...(exceptMatchId ? { id: { not: exceptMatchId } } : {}),
      },
    },
    select: { id: true },
  });
  return clash !== null;
}

export { displayName } from '../teams/teams.service.js';
