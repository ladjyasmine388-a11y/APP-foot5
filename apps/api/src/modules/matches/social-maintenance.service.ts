import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ENV } from '../../infra/config/config.module.js';
import type { Env } from '../../infra/config/env.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { DomainEvents } from '../../infra/events/domain-events.js';
import {
  type LifecycleOutcome,
  cascadeBookingTx,
  completeMatchTx,
  emitOutcome,
  emptyOutcome,
  mergeOutcome,
  rejectPendingRequestsTx,
} from './social-lifecycle.js';

const INTERVAL_MS = 30_000;
const BATCH = 200;

export interface SocialMaintenanceResult {
  /** Activités arrêtées parce que leur réservation support n'existe plus. */
  cascaded: number;
  /** Annonces restées sans adversaire à l'heure du match. */
  expiredListings: number;
  /** Matchs terminés (statistiques des joueurs créditées). */
  completedMatches: number;
  ran: boolean;
}

/**
 * Cycle de vie des activités sociales.
 *  1. Annulation de la réservation → arrêt de la session / de l'annonce / du match qui en dépend. Déclenché tout de
 *     suite par l'événement `booking.cancelled`, et rattrapé ici si l'événement s'est perdu (redémarrage, erreur).
 *  2. Annonces sans adversaire à l'heure du match → EXPIRED (leurs demandes en attente sont rejetées).
 *  3. Matchs dont l'heure de fin est passée → COMPLETED, statistiques créditées UNE fois.
 * Un verrou consultatif garantit qu'une seule instance de l'API exécute la maintenance à la fois.
 */
@Injectable()
export class SocialMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SocialMaintenanceService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    this.events.on('booking.cancelled', ({ bookingId }) => this.cascadeBooking(bookingId));
    this.events.on('booking.expired', async ({ bookingIds }) => {
      for (const bookingId of bookingIds) await this.cascadeBooking(bookingId);
    });

    if (this.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) =>
        this.logger.error('Échec de la maintenance sociale', error instanceof Error ? error.stack : String(error)),
      );
    }, INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Arrête tout ce qui reposait sur cette réservation. Sans effet si rien n'en dépend. */
  async cascadeBooking(bookingId: string, now: Date = new Date()): Promise<void> {
    const outcome = await this.prisma.$transaction((tx) => cascadeBookingTx(tx, bookingId, now));
    await emitOutcome(this.events, outcome);
  }

  async runOnce(now: Date = new Date()): Promise<SocialMaintenanceResult> {
    const outcome: LifecycleOutcome = emptyOutcome();
    const result = await this.prisma.$transaction(async (tx): Promise<SocialMaintenanceResult> => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(727002) AS locked`;
      if (!lock?.locked) return { cascaded: 0, expiredListings: 0, completedMatches: 0, ran: false };

      // 1. Filet de sécurité : réservation support disparue.
      const dead = ['CANCELLED', 'EXPIRED', 'NO_SHOW'] as const;
      const orphanBookings = await tx.booking.findMany({
        where: {
          status: { in: [...dead] },
          OR: [
            { soloSession: { is: { status: { in: ['OPEN', 'FULL', 'CONFIRMED'] } } } },
            { opponentListing: { is: { status: { in: ['OPEN', 'ACCEPTED'] } } } },
            { match: { is: { status: 'SCHEDULED' } } },
          ],
        },
        select: { id: true },
        take: BATCH,
      });
      for (const { id } of orphanBookings) mergeOutcome(outcome, await cascadeBookingTx(tx, id, now));

      // 2. Annonces restées sans adversaire.
      const expired = await tx.opponentListing.updateManyAndReturn({
        where: { status: 'OPEN', startsAt: { lte: now } },
        data: { status: 'EXPIRED' },
        select: { id: true },
      });
      for (const { id } of expired) outcome.rejected.push(...(await rejectPendingRequestsTx(tx, id, now)));

      // 3. Matchs terminés.
      const ended = await tx.match.findMany({
        where: { status: 'SCHEDULED', endsAt: { lte: now }, booking: { is: { status: { in: ['CONFIRMED', 'COMPLETED'] } } } },
        select: { id: true },
        take: BATCH,
      });
      let completed = 0;
      for (const { id } of ended) if (await completeMatchTx(tx, id)) completed += 1;

      return { cascaded: orphanBookings.length, expiredListings: expired.length, completedMatches: completed, ran: true };
    });
    await emitOutcome(this.events, outcome);
    return result;
  }
}
