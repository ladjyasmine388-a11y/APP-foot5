import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ListNotificationsQuery,
  NotificationPage,
  NotificationType,
  NotificationView,
} from '@footfive/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { Errors } from '../../common/errors/app-exception.js';
import { ENV } from '../../infra/config/config.module.js';
import type { Env } from '../../infra/config/env.js';
import { PG_ERROR, isPgError } from '../../infra/database/pg-errors.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { Mailer } from '../../infra/mail/mailer.js';
import type { AuthUser } from '../auth/auth.types.js';
import { decodeOffset, encodeOffset } from '../teams/teams.service.js';
import {
  EMAIL_NOTIFICATION_TYPES,
  type NotificationData,
  renderNotification,
} from './notification-content.js';

/** Notifications lues depuis plus de 90 jours, toutes celles de plus d'un an : supprimées. */
const READ_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 365;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Crée la notification dans l'application puis, pour les types importants, envoie l'email dans la langue du compte.
   * Ne lève JAMAIS : une notification qui échoue ne doit pas faire échouer l'action qui l'a provoquée.
   * L'email part en arrière-plan (un SMTP lent ne ralentit pas la requête).
   */
  async notify(userId: string, type: NotificationType, data: NotificationData): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          status: true,
          email: true,
          emailVerifiedAt: true,
          locale: true,
          preferences: true,
        },
      });
      if (!user || user.status !== 'ACTIVE') return;

      try {
        await this.prisma.notification.create({
          data: { userId, type, payload: data as Prisma.InputJsonValue },
        });
      } catch (error) {
        if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) return; // rappel déjà envoyé à ce joueur pour ce match
        throw error;
      }

      const optedOut =
        (user.preferences as Record<string, unknown> | null)?.emailNotifications === false;
      if (EMAIL_NOTIFICATION_TYPES.has(type) && user.emailVerifiedAt && !optedOut) {
        const { title, body } = renderNotification(type, data, user.locale);
        void this.mailer
          .send({
            to: user.email,
            subject: `${title} — Foot Five`,
            text: `${body}\n\n${this.env.WEB_ORIGIN}/notifications`,
          })
          .catch((error: unknown) =>
            this.logger.warn(
              `Email « ${type} » non envoyé : ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
      }
    } catch (error) {
      this.logger.error(
        `Notification « ${type} » en échec pour ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async notifyMany(
    userIds: Iterable<string>,
    type: NotificationType,
    data: NotificationData,
  ): Promise<void> {
    for (const userId of new Set(userIds)) await this.notify(userId, type, data);
  }

  async list(user: AuthUser, query: ListNotificationsQuery): Promise<NotificationPage> {
    const offset = decodeOffset(query.cursor);
    const where: Prisma.NotificationWhereInput = {
      userId: user.id,
      ...(query.unread ? { readAt: null } : {}),
    };
    const [me, rows, unreadCount] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { locale: true } }),
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: query.limit + 1,
      }),
      this.prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    ]);
    return {
      items: rows.slice(0, query.limit).map((row) => this.toView(row, me.locale)),
      nextCursor: rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
      unreadCount,
    };
  }

  async unreadCount(user: AuthUser): Promise<number> {
    return this.prisma.notification.count({ where: { userId: user.id, readAt: null } });
  }

  /** Marque une notification comme lue. Celle d'un autre compte est indiscernable d'une notification inexistante (404). */
  async markRead(user: AuthUser, id: string, now: Date = new Date()): Promise<void> {
    const owned = await this.prisma.notification.count({ where: { id, userId: user.id } });
    if (owned === 0) throw Errors.notFound('Notification introuvable');
    await this.prisma.notification.updateMany({
      where: { id, userId: user.id, readAt: null },
      data: { readAt: now },
    });
  }

  async markAllRead(user: AuthUser, now: Date = new Date()): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: now },
    });
    return result.count;
  }

  async purgeOld(now: Date = new Date()): Promise<number> {
    const day = 86_400_000;
    const result = await this.prisma.notification.deleteMany({
      where: {
        OR: [
          { readAt: { not: null, lt: new Date(now.getTime() - READ_RETENTION_DAYS * day) } },
          { createdAt: { lt: new Date(now.getTime() - MAX_RETENTION_DAYS * day) } },
        ],
      },
    });
    return result.count;
  }

  private toView(
    row: {
      id: string;
      type: NotificationType;
      payload: Prisma.JsonValue;
      readAt: Date | null;
      createdAt: Date;
    },
    locale: string,
  ): NotificationView {
    const data = (row.payload ?? {}) as NotificationData;
    const { title, body } = renderNotification(row.type, data, locale);
    return {
      id: row.id,
      type: row.type,
      title,
      body,
      data,
      read: row.readAt !== null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
