import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type {
  BookingListResponse,
  BookingQuote,
  BookingView,
  CancelBookingInput,
  CancelBookingResponse,
  CreateBookingInput,
  ListMyBookingsQuery,
  QuoteBookingInput,
} from '@footfive/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { ENV } from '../../infra/config/config.module.js';
import type { Env } from '../../infra/config/env.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { DomainEvents } from '../../infra/events/domain-events.js';
import { AuditService } from '../audit/audit.service.js';
import { type FoundSlot, AvailabilityService } from '../availability/availability.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { SettingsService } from '../settings/settings.service.js';
import { BookingPricingService } from './booking-pricing.service.js';
import { BookingWriter, slotUnavailable } from './booking-writer.service.js';
import { decideRefund } from './cancellation.js';
import {
  type BookingWithRelations,
  bookingInclude,
  effectiveStatus,
  paidOnlineMinor,
  toBookingView,
} from './booking.mappers.js';
import { RefundsService } from './refunds.service.js';

const unprocessable = (code: 'SLOT_NOT_BOOKABLE', message: string): AppException =>
  new AppException(code, HttpStatus.UNPROCESSABLE_ENTITY, message);

export type ClientPlatform = 'WEB' | 'MOBILE';

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly pricing: BookingPricingService,
    private readonly settings: SettingsService,
    private readonly writer: BookingWriter,
    private readonly refunds: RefundsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ───────────────────────── Devis ─────────────────────────

  /**
   * Prix et acompte d'un créneau, calculés par le SERVEUR. Aucune écriture : on peut le rappeler à volonté.
   * Le client n'envoie que « quel créneau » et « quel mode de paiement » — jamais un montant.
   */
  async quote(input: QuoteBookingInput, now: Date = new Date()): Promise<BookingQuote> {
    const found = await this.resolveBookableSlot(input.fieldId, new Date(input.startsAt), now);
    const { amounts } = await this.pricing.price({
      venue: found.venue,
      basePriceMinor: found.slot.priceMinor,
      paymentMode: input.paymentMode,
      bookingType: 'STANDARD',
      now,
    });
    return {
      fieldId: found.field.id,
      fieldName: found.field.name,
      venueName: found.venue.name,
      startsAt: found.slot.startsAt.toISOString(),
      endsAt: found.slot.endsAt.toISOString(),
      paymentMode: input.paymentMode,
      priceMinor: amounts.basePriceMinor,
      feesMinor: amounts.feesMinor,
      taxMinor: amounts.taxMinor,
      totalMinor: amounts.totalMinor,
      dueOnlineMinor: amounts.dueOnlineMinor,
      dueOnSiteMinor: amounts.dueOnSiteMinor,
      currency: 'DZD',
      holdMinutes: await this.holdMinutes(),
    };
  }

  // ───────────────────────── Création ─────────────────────────

  /**
   * Réserve un créneau : verrou temporaire en attendant le paiement.
   *
   * Sécurité et fiabilité :
   *  - le prix, la commission et l'acompte sont recalculés ICI, jamais lus dans la requête ;
   *  - le créneau doit être un vrai créneau de la grille, libre, tarifé, dans l'horizon de réservation ;
   *  - deux joueurs simultanés : la contrainte d'exclusion PostgreSQL n'en laisse passer qu'un (voir BookingWriter) ;
   *  - un joueur ne peut pas accaparer les créneaux (nombre de verrous simultanés limité) ;
   *  - rejouer la même requête rend la même réservation (idempotence naturelle sur joueur + terrain + début).
   */
  async create(
    user: AuthUser,
    input: CreateBookingInput,
    platform: ClientPlatform,
    now: Date = new Date(),
  ): Promise<BookingView> {
    const startsAt = new Date(input.startsAt);

    // Rejeu : le même joueur a déjà un verrou en cours sur CE créneau → on le lui rend, sans en créer un second.
    // À vérifier AVANT l'état du créneau : celui-ci est « en cours de paiement » précisément à cause de ce verrou.
    const existing = await this.prisma.booking.findFirst({
      where: {
        userId: user.id,
        fieldId: input.fieldId,
        startsAt,
        status: 'PENDING_PAYMENT',
        holdExpiresAt: { gt: now },
      },
      include: bookingInclude,
    });
    if (existing) return this.view(existing, now);

    const found = await this.resolveBookableSlot(input.fieldId, startsAt, now);

    const maxHolds = await this.settings.getInt('booking.max_active_holds', 3);
    const activeHolds = await this.prisma.booking.count({
      where: { userId: user.id, status: 'PENDING_PAYMENT', holdExpiresAt: { gt: now } },
    });
    if (activeHolds >= maxHolds) {
      throw new AppException(
        'TOO_MANY_HOLDS',
        HttpStatus.CONFLICT,
        `Vous avez déjà ${maxHolds} réservations en attente de paiement : terminez-les ou attendez leur expiration`,
      );
    }

    const priced = await this.pricing.price({
      venue: found.venue,
      basePriceMinor: found.slot.priceMinor,
      paymentMode: input.paymentMode,
      bookingType: 'STANDARD',
      now,
    });
    const holdMinutes = await this.holdMinutes();

    const row = await this.writer.create(
      {
        userId: user.id,
        fieldId: found.field.id,
        venueId: found.venue.id,
        startsAt: found.slot.startsAt,
        endsAt: found.slot.endsAt,
        status: 'PENDING_PAYMENT',
        source: platform,
        bookingType: 'STANDARD',
        paymentMode: input.paymentMode,
        holdExpiresAt: new Date(now.getTime() + holdMinutes * 60_000),
        commissionRuleId: priced.commissionRuleId,
        createdById: user.id,
        ...priced.amounts,
      },
      bookingInclude,
      { now },
    );
    return this.view(row, now);
  }

  // ───────────────────────── Consultation ─────────────────────────

  async listMine(
    user: AuthUser,
    query: ListMyBookingsQuery,
    now: Date = new Date(),
  ): Promise<BookingListResponse> {
    const offset = decodeOffset(query.cursor);
    // « À venir » = un verrou NON expiré, ou une réservation confirmée qui n'est pas terminée.
    const upcoming: Prisma.BookingWhereInput = {
      endsAt: { gt: now },
      OR: [{ status: 'CONFIRMED' }, { status: 'PENDING_PAYMENT', holdExpiresAt: { gt: now } }],
    };
    const where: Prisma.BookingWhereInput = {
      userId: user.id,
      bookingType: { not: 'BLOCK' },
      ...(query.status ? { status: query.status } : {}),
      ...(query.when === 'upcoming' ? upcoming : query.when === 'past' ? { NOT: upcoming } : {}),
    };

    const rows = await this.prisma.booking.findMany({
      where,
      include: bookingInclude,
      orderBy: { startsAt: query.when === 'upcoming' ? 'asc' : 'desc' },
      skip: offset,
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    return {
      items: await Promise.all(page.map((r) => this.view(r, now))),
      nextCursor: rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
    };
  }

  /** Une réservation n'est visible que par son titulaire : un identifiant d'autrui donne 404 (pas d'IDOR). */
  async getMine(user: AuthUser, id: string, now: Date = new Date()): Promise<BookingView> {
    const row = await this.prisma.booking.findFirst({
      where: { id, userId: user.id, bookingType: { not: 'BLOCK' } },
      include: bookingInclude,
    });
    if (!row) throw Errors.notFound('Réservation introuvable');
    return this.view(row, now);
  }

  // ───────────────────────── Annulation ─────────────────────────

  async cancel(
    user: AuthUser,
    id: string,
    input: CancelBookingInput,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<CancelBookingResponse> {
    const row = await this.prisma.booking.findFirst({
      where: { id, userId: user.id, bookingType: { not: 'BLOCK' } },
      include: bookingInclude,
    });
    if (!row) throw Errors.notFound('Réservation introuvable');

    const status = effectiveStatus(row, now);
    const cancellable =
      status === 'PENDING_PAYMENT' ||
      (status === 'CONFIRMED' && row.startsAt.getTime() > now.getTime());
    if (!cancellable) throw notCancellable(status);

    const policy = await this.pricing.resolveCancellationPolicy(row.venue.cancellationPolicy);
    const decision = decideRefund({
      paidOnlineMinor: paidOnlineMinor(row.payments),
      startsAt: row.startsAt,
      now,
      policy,
      initiator: 'PLAYER',
    });

    let refundIds: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      // Passage conditionnel à CANCELLED : si un paiement vient de confirmer la réservation, ou si deux annulations
      // arrivent ensemble, une seule transition réussit.
      const claimed = await tx.booking.updateMany({
        where: { id, userId: user.id, status: { in: ['PENDING_PAYMENT', 'CONFIRMED'] } },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledById: user.id,
          cancellationReason: input.reason ?? null,
          holdExpiresAt: null,
        },
      });
      if (claimed.count === 0) throw notCancellable('CANCELLED');

      if (decision.eligible) {
        const requested = await this.refunds.requestFullRefund(tx, {
          bookingId: id,
          reason: 'Annulation par le joueur',
          requestedById: user.id,
        });
        refundIds = requested.refundIds;
      }
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: 'USER',
          action: 'booking.cancel',
          entityType: 'Booking',
          entityId: id,
          before: { status },
          after: {
            status: 'CANCELLED',
            refundEligible: decision.eligible,
            refundMinor: decision.amountMinor,
          },
        },
        ctx,
        tx,
      );
    });

    // Effets de bord APRÈS la validation : annuler un paiement en cours chez le prestataire, exécuter le remboursement.
    await this.events.emit('booking.cancelled', { bookingId: id, by: 'PLAYER' });
    if (refundIds.length > 0) await this.events.emit('refund.requested', { refundIds });

    const updated = await this.prisma.booking.findUniqueOrThrow({
      where: { id },
      include: bookingInclude,
    });
    return { booking: await this.view(updated, now), refund: decision };
  }

  // ───────────────────────── Aides ─────────────────────────

  /**
   * Le créneau visé est-il réellement réservable ? Retourne le créneau, ou lève l'erreur la plus précise :
   *  404 terrain/complexe inconnu ou non public · 422 créneau inexistant, passé ou sans tarif · 409 déjà pris.
   */
  private async resolveBookableSlot(
    fieldId: string,
    startsAt: Date,
    now: Date,
  ): Promise<FoundSlot & { slot: NonNullable<FoundSlot['slot']> & { priceMinor: number } }> {
    const found = await this.availability.findSlot(fieldId, startsAt, now);
    // Complexe en attente ou suspendu : même réponse qu'un terrain inexistant.
    if (!found || found.venue.status !== 'APPROVED') throw Errors.notFound('Terrain introuvable');
    if (!found.slot)
      throw unprocessable('SLOT_NOT_BOOKABLE', 'Ce créneau n’existe pas pour ce terrain');

    await this.availability.assertDateInRange(found.date, found.venue.timezone, now);

    switch (found.slot.status) {
      case 'AVAILABLE':
        break;
      case 'PAST':
        throw unprocessable(
          'SLOT_NOT_BOOKABLE',
          'Ce créneau est passé ou trop proche pour être réservé',
        );
      case 'NO_PRICE':
        throw unprocessable(
          'SLOT_NOT_BOOKABLE',
          'Ce créneau n’est pas disponible à la réservation',
        );
      default:
        throw slotUnavailable();
    }
    return found as FoundSlot & { slot: NonNullable<FoundSlot['slot']> & { priceMinor: number } };
  }

  private async holdMinutes(): Promise<number> {
    return this.settings.getInt('booking.hold_minutes', this.env.BOOKING_HOLD_MINUTES);
  }

  private async view(row: BookingWithRelations, now: Date): Promise<BookingView> {
    const policy = await this.pricing.resolveCancellationPolicy(row.venue.cancellationPolicy);
    return toBookingView(row, policy, now);
  }
}

function notCancellable(status: string): AppException {
  const reasons: Record<string, string> = {
    EXPIRED: 'Cette réservation a expiré',
    CANCELLED: 'Cette réservation est déjà annulée',
    COMPLETED: 'Cette réservation est terminée',
    NO_SHOW: 'Cette réservation est terminée',
    CONFIRMED: 'Le créneau a déjà commencé : il ne peut plus être annulé',
  };
  return new AppException(
    'BOOKING_NOT_CANCELLABLE',
    HttpStatus.CONFLICT,
    reasons[status] ?? 'Cette réservation ne peut pas être annulée',
  );
}

function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { o?: unknown };
    if (typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0)
      return parsed.o;
  } catch {
    /* erreur ci-dessous */
  }
  throw new AppException(
    'VALIDATION_ERROR',
    HttpStatus.BAD_REQUEST,
    'Curseur de pagination invalide',
  );
}
