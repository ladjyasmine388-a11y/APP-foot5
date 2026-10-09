import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ENV } from '../../infra/config/config.module.js';
import type { Env } from '../../infra/config/env.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { NotificationsService } from './notifications.service.js';

const INTERVAL_MS = 60_000;
/** Rappel envoyé quand le match a lieu dans moins de 24 h… */
const REMINDER_HORIZON_MS = 24 * 3_600_000;
/** …sauf si le match vient d'être créé : personne n'a besoin d'un rappel une minute après avoir réservé. */
const MIN_AGE_MS = 3_600_000;

export interface RemindersResult {
  reminded: number;
  purged: number;
  ran: boolean;
}

/**
 * Rappels de match et ménage des notifications. Chaque match est « revendiqué » par un UPDATE atomique
 * (`reminderSentAt IS NULL`) AVANT l'envoi : même avec plusieurs instances de l'API, il n'y a qu'un rappel par match
 * (et un index unique en base le garantit pour chaque joueur).
 */
@Injectable()
export class RemindersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RemindersService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) =>
        this.logger.error('Échec des rappels', error instanceof Error ? error.stack : String(error)),
      );
    }, INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now: Date = new Date()): Promise<RemindersResult> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(727003) AS locked`;
      if (!lock?.locked) return null;
      return tx.match.updateManyAndReturn({
        where: {
          status: 'SCHEDULED',
          reminderSentAt: null,
          startsAt: { gt: now, lte: new Date(now.getTime() + REMINDER_HORIZON_MS) },
          createdAt: { lte: new Date(now.getTime() - MIN_AGE_MS) },
          booking: { is: { status: 'CONFIRMED' } },
        },
        data: { reminderSentAt: now },
        select: { id: true, startsAt: true, bookingId: true, venue: { select: { name: true } } },
      });
    });
    if (claimed === null) return { reminded: 0, purged: 0, ran: false };

    for (const match of claimed) {
      const [participants, booking] = await Promise.all([
        this.prisma.matchParticipant.findMany({ where: { matchId: match.id }, select: { userId: true } }),
        this.prisma.booking.findUnique({ where: { id: match.bookingId }, select: { userId: true } }),
      ]);
      const recipients = new Set(participants.map((p) => p.userId));
      if (booking?.userId) recipients.add(booking.userId);
      await this.notifications.notifyMany(recipients, 'MATCH_REMINDER', {
        matchId: match.id,
        venueName: match.venue.name,
        startsAt: match.startsAt.toISOString(),
      });
    }

    const purged = await this.notifications.purgeOld(now);
    return { reminded: claimed.length, purged, ran: true };
  }
}
