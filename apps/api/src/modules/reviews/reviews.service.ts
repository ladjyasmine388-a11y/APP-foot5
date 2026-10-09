import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type CreateReviewInput,
  type ListReviewsQuery,
  type ReviewPage,
  type ReviewView,
  REVIEW_WINDOW_DAYS,
} from '@footfive/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { PG_ERROR, isPgError } from '../../infra/database/pg-errors.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { decodeOffset, encodeOffset } from '../teams/teams.service.js';

const conflict = (message: string): AppException => new AppException('CONFLICT', HttpStatus.CONFLICT, message);

/**
 * Recalcule la note d'un complexe depuis les avis VISIBLES. À appeler dans la transaction qui ajoute, masque ou
 * rétablit un avis, APRÈS avoir verrouillé la ligne du complexe (`lockVenueForRating`) : deux avis simultanés ne
 * peuvent pas écraser le calcul l'un de l'autre.
 */
export async function recomputeVenueRating(tx: Prisma.TransactionClient, venueId: string): Promise<void> {
  const agg = await tx.review.aggregate({ where: { venueId, hiddenAt: null }, _avg: { rating: true }, _count: { _all: true } });
  await tx.venue.update({
    where: { id: venueId },
    data: { ratingAvg: Math.round((agg._avg.rating ?? 0) * 100) / 100, ratingCount: agg._count._all },
  });
}

export async function lockVenueForRating(tx: Prisma.TransactionClient, venueId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Venue" WHERE "id" = ${venueId}::uuid FOR UPDATE`;
}

const authorName = (u: { firstName: string; lastName: string; status: string }): string =>
  u.status === 'DELETED' ? 'Utilisateur supprimé' : `${u.firstName} ${u.lastName.charAt(0)}.`;

const authorSelect = { select: { firstName: true, lastName: true, status: true } } as const;

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Un seul avis par réservation, déposé par son client, une fois le match joué (réservation COMPLETED) et dans les
   * 30 jours. La note du complexe est recalculée dans la même transaction.
   */
  async create(user: AuthUser, bookingId: string, input: CreateReviewInput, ctx: RequestContext, now: Date = new Date()): Promise<ReviewView> {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, userId: user.id, bookingType: 'STANDARD' },
      select: { id: true, venueId: true, status: true, endsAt: true },
    });
    if (!booking) throw Errors.notFound('Réservation introuvable');
    if (booking.status !== 'COMPLETED') throw conflict('Vous pourrez donner votre avis une fois le match joué');
    if (now.getTime() > booking.endsAt.getTime() + REVIEW_WINDOW_DAYS * 86_400_000) {
      throw conflict(`Le délai pour donner votre avis (${REVIEW_WINDOW_DAYS} jours) est dépassé`);
    }

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await lockVenueForRating(tx, booking.venueId);
        const review = await tx.review.create({
          data: { bookingId, userId: user.id, venueId: booking.venueId, rating: input.rating, comment: input.comment ?? null },
          select: { id: true },
        });
        await recomputeVenueRating(tx, booking.venueId);
        await this.audit.record(
          { actorId: user.id, actorRole: 'USER', action: 'review.create', entityType: 'Review', entityId: review.id, after: { rating: input.rating, venueId: booking.venueId } },
          ctx,
          tx,
        );
        return review.id;
      });
      const row = await this.prisma.review.findUniqueOrThrow({ where: { id: created }, include: { user: authorSelect } });
      return this.toView(row);
    } catch (error) {
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) throw conflict('Vous avez déjà donné votre avis pour cette réservation');
      throw error;
    }
  }

  /** Mon avis sur une de mes réservations (404 s'il n'y en a pas) : permet à l'interface de proposer « Donner mon avis ». */
  async getMine(user: AuthUser, bookingId: string): Promise<ReviewView> {
    const review = await this.prisma.review.findFirst({ where: { bookingId, userId: user.id }, include: { user: authorSelect } });
    if (!review) throw Errors.notFound('Aucun avis pour cette réservation');
    return this.toView(review);
  }

  /** Avis publics d'un complexe approuvé (les avis masqués par la modération n'apparaissent pas). */
  async listForVenue(slug: string, query: ListReviewsQuery): Promise<ReviewPage> {
    const venue = await this.prisma.venue.findFirst({
      where: { slug, status: 'APPROVED' },
      select: { id: true, ratingAvg: true, ratingCount: true },
    });
    if (!venue) throw Errors.notFound('Complexe introuvable');

    const offset = decodeOffset(query.cursor);
    const rows = await this.prisma.review.findMany({
      where: { venueId: venue.id, hiddenAt: null },
      include: { user: authorSelect },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: query.limit + 1,
    });
    return {
      items: rows.slice(0, query.limit).map((r) => this.toView(r)),
      nextCursor: rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
      ratingAvg: venue.ratingAvg,
      ratingCount: venue.ratingCount,
    };
  }

  private toView(r: { id: string; rating: number; comment: string | null; createdAt: Date; user: { firstName: string; lastName: string; status: string } }): ReviewView {
    return { id: r.id, rating: r.rating, comment: r.comment, author: authorName(r.user), createdAt: r.createdAt.toISOString() };
  }
}
