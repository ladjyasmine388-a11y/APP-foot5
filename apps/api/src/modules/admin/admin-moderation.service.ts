import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type AdminListRefundsQuery,
  type AdminListReviewsQuery,
  type AdminRefundBookingInput,
  type AdminRefundView,
  type AdminReviewView,
  type AuditLogView,
  type AuditQuery,
  type ModerateReviewInput,
  type PageOf,
} from '@footfive/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { localToUtc } from '../../common/time/zoned-time.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { DomainEvents } from '../../infra/events/domain-events.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RefundsService } from '../bookings/refunds.service.js';
import { PLATFORM_TZ } from '../matches/social-common.js';
import { lockVenueForRating, recomputeVenueRating } from '../reviews/reviews.service.js';
import { decodeOffset, encodeOffset } from '../teams/teams.service.js';

const conflict = (message: string): AppException =>
  new AppException('CONFLICT', HttpStatus.CONFLICT, message);

@Injectable()
export class AdminModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly refunds: RefundsService,
    private readonly events: DomainEvents,
  ) {}

  // ───────────────────────── Remboursements ─────────────────────────

  async listRefunds(query: AdminListRefundsQuery): Promise<PageOf<AdminRefundView>> {
    const offset = decodeOffset(query.cursor);
    const rows = await this.prisma.refund.findMany({
      where: query.status ? { status: query.status } : {},
      include: { booking: { select: { reference: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: query.limit + 1,
    });
    return {
      items: rows.slice(0, query.limit).map((r) => ({
        id: r.id,
        bookingId: r.bookingId,
        reference: r.booking.reference,
        amountMinor: r.amountMinor,
        status: r.status,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
        processedAt: r.processedAt?.toISOString() ?? null,
      })),
      nextCursor: rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
    };
  }

  /**
   * Relance un remboursement en échec en créant une NOUVELLE demande pour le solde du paiement. On ne réutilise pas
   * l'ancienne : le prestataire mémorise le résultat par identifiant de remboursement (idempotence), il renverrait
   * le même échec. L'ancienne ligne reste, avec son motif d'échec, comme historique. La réservation est verrouillée :
   * deux clics simultanés ne créent qu'une relance.
   */
  async retryRefund(
    admin: AuthUser,
    id: string,
    ctx: RequestContext,
  ): Promise<{ refundId: string }> {
    const created = await this.prisma.$transaction(async (tx) => {
      const failed = await tx.refund.findUnique({
        where: { id },
        select: { id: true, status: true, paymentId: true, bookingId: true },
      });
      if (!failed) throw Errors.notFound('Remboursement introuvable');
      await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${failed.bookingId}::uuid FOR UPDATE`;
      const current = await tx.refund.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      });
      if (current.status !== 'FAILED')
        throw conflict('Seul un remboursement en échec peut être relancé');
      const requested = await this.refunds.requestForPayment(tx, {
        paymentId: failed.paymentId,
        bookingId: failed.bookingId,
        reason: `Relance du remboursement ${failed.id}`,
        requestedById: admin.id,
      });
      const refundId = requested.refundIds[0];
      if (!refundId) throw conflict('Ce remboursement a déjà été relancé ou réglé');
      await this.audit.record(
        {
          actorId: admin.id,
          actorRole: 'ADMIN',
          action: 'refund.retry',
          entityType: 'Refund',
          entityId: id,
          after: { newRefundId: refundId, amountMinor: requested.totalMinor },
        },
        ctx,
        tx,
      );
      return refundId;
    });
    await this.events.emit('refund.requested', { refundIds: [created] });
    return { refundId: created };
  }

  /** Remboursement décidé par l'administration (litige, geste commercial) : tout ce qui a été payé et pas encore remboursé. */
  async refundBooking(
    admin: AuthUser,
    bookingId: string,
    input: AdminRefundBookingInput,
    ctx: RequestContext,
  ): Promise<{ totalMinor: number; refundIds: string[] }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw Errors.notFound('Réservation introuvable');
      const requested = await this.refunds.requestFullRefund(tx, {
        bookingId,
        reason: `Décision de l'administration : ${input.reason}`,
        requestedById: admin.id,
      });
      if (requested.refundIds.length === 0)
        throw conflict('Rien à rembourser sur cette réservation');
      await this.audit.record(
        {
          actorId: admin.id,
          actorRole: 'ADMIN',
          action: 'refund.admin_request',
          entityType: 'Booking',
          entityId: bookingId,
          after: { totalMinor: requested.totalMinor, reason: input.reason },
        },
        ctx,
        tx,
      );
      return requested;
    });
    await this.events.emit('refund.requested', { refundIds: result.refundIds });
    return result;
  }

  // ───────────────────────── Avis ─────────────────────────

  async listReviews(query: AdminListReviewsQuery): Promise<PageOf<AdminReviewView>> {
    const offset = decodeOffset(query.cursor);
    const rows = await this.prisma.review.findMany({
      where: {
        ...(query.venueId ? { venueId: query.venueId } : {}),
        ...(query.hidden === undefined
          ? {}
          : query.hidden
            ? { hiddenAt: { not: null } }
            : { hiddenAt: null }),
      },
      include: {
        venue: { select: { id: true, name: true } },
        user: { select: { firstName: true, lastName: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: query.limit + 1,
    });
    return {
      items: rows.slice(0, query.limit).map((r) => ({
        id: r.id,
        venue: r.venue,
        rating: r.rating,
        comment: r.comment,
        author: `${r.user.firstName} ${r.user.lastName.charAt(0)}.`,
        hidden: r.hiddenAt !== null,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
    };
  }

  /** Masque (ou rétablit) un avis ; la note du complexe est recalculée dans la même transaction, sous verrou. */
  async setReviewHidden(
    admin: AuthUser,
    id: string,
    hidden: boolean,
    input: ModerateReviewInput,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<void> {
    const review = await this.prisma.review.findUnique({
      where: { id },
      select: { venueId: true },
    });
    if (!review) throw Errors.notFound('Avis introuvable');
    await this.prisma.$transaction(async (tx) => {
      await lockVenueForRating(tx, review.venueId);
      const claimed = await tx.review.updateManyAndReturn({
        where: { id, hiddenAt: hidden ? null : { not: null } },
        data: { hiddenAt: hidden ? now : null },
        select: { id: true },
      });
      if (claimed.length === 0)
        throw conflict(hidden ? 'Cet avis est déjà masqué' : 'Cet avis n’est pas masqué');
      await recomputeVenueRating(tx, review.venueId);
      await this.audit.record(
        {
          actorId: admin.id,
          actorRole: 'ADMIN',
          action: hidden ? 'review.hide' : 'review.unhide',
          entityType: 'Review',
          entityId: id,
          after: { reason: input.reason },
        },
        ctx,
        tx,
      );
    });
  }

  // ───────────────────────── Journal d'audit ─────────────────────────

  async auditLogs(query: AuditQuery): Promise<PageOf<AuditLogView>> {
    const offset = decodeOffset(query.cursor);
    const where: Prisma.AuditLogWhereInput = {
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: localToUtc(query.from, 0, PLATFORM_TZ) } : {}),
              ...(query.to ? { lt: localToUtc(query.to, 1440, PLATFORM_TZ) } : {}),
            },
          }
        : {}),
    };
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: query.limit + 1,
    });
    return {
      items: rows.slice(0, query.limit).map((r) => ({
        id: r.id,
        actorId: r.actorId,
        actorRole: r.actorRole,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        before: r.before,
        after: r.after,
        requestId: r.requestId,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
    };
  }
}
