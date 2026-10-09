import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ENV } from '../../infra/config/config.module.js';
import type { Env } from '../../infra/config/env.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { IdempotencyService } from './idempotency.service.js';

const INTERVAL_MS = 30_000;

export interface MaintenanceResult {
  /** Verrous de paiement périmés passés à EXPIRED. */
  expiredHolds: number;
  /** Réservations terminées passées à COMPLETED. */
  completedBookings: number;
  /** Clés d'idempotence expirées supprimées. */
  purgedKeys: number;
  /** Faux si une autre instance de l'API exécutait déjà la maintenance. */
  ran: boolean;
}

/**
 * Maintenance périodique, toutes les 30 secondes :
 *  - les verrous de paiement dépassés deviennent EXPIRED (le créneau est DÉJÀ considéré libre dès l'expiration,
 *    ce nettoyage ne sert qu'à garder des statuts exacts en base) ;
 *  - les réservations dont le créneau est terminé passent à COMPLETED (et alimentent les statistiques du joueur) ;
 *  - les clés d'idempotence périmées sont purgées.
 *
 * Un verrou consultatif PostgreSQL garantit qu'une seule instance de l'API l'exécute à la fois.
 * Désactivée en test (les tests appellent `runOnce` directement). Pour le MVP, une minuterie interne suffit ;
 * une file de tâches (pg-boss) prendra le relais quand les rappels et notifications arriveront.
 */
@Injectable()
export class BookingsMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingsMaintenanceService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) =>
        this.logger.error(
          'Échec de la maintenance des réservations',
          error instanceof Error ? error.stack : String(error),
        ),
      );
    }, INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now: Date = new Date()): Promise<MaintenanceResult> {
    const result = await this.prisma.$transaction(
      async (tx): Promise<Omit<MaintenanceResult, 'purgedKeys'>> => {
        const [lock] = await tx.$queryRaw<
          { locked: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(727001) AS locked`;
        if (!lock?.locked) return { expiredHolds: 0, completedBookings: 0, ran: false };

        const expired = await tx.booking.updateMany({
          where: { status: 'PENDING_PAYMENT', holdExpiresAt: { lte: now } },
          data: { status: 'EXPIRED' },
        });

        // UPDATE … RETURNING : on ne compte pour les statistiques QUE les lignes réellement passées à COMPLETED
        // (une annulation simultanée ne peut pas être comptée comme un match joué).
        const completed = await tx.$queryRaw<{ userId: string | null }[]>`
        UPDATE "Booking" SET "status" = 'COMPLETED', "updatedAt" = now()
        WHERE "status" = 'CONFIRMED' AND "bookingType" <> 'BLOCK' AND "endsAt" <= ${now}
        RETURNING "userId"`;

        const perPlayer = new Map<string, number>();
        for (const { userId } of completed) {
          if (userId) perPlayer.set(userId, (perPlayer.get(userId) ?? 0) + 1);
        }
        for (const [userId, count] of perPlayer) {
          await tx.playerStats.upsert({ where: { userId }, create: { userId }, update: {} });
          await tx.$executeRaw`
          UPDATE "PlayerStats" SET "matchesPlayed" = "matchesPlayed" + ${count}, "updatedAt" = now()
          WHERE "userId" = ${userId}::uuid`;
        }
        return { expiredHolds: expired.count, completedBookings: completed.length, ran: true };
      },
    );

    const purgedKeys = result.ran ? await this.idempotency.purgeExpired(now) : 0;
    return { ...result, purgedKeys };
  }
}
