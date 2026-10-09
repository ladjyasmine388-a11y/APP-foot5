import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type CreateBlockInput,
  type CreateManualBookingInput,
  type ListManageBookingsQuery,
  type ManageBookingView,
  type StaffCancelBookingInput,
} from '@footfive/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { localToUtc } from '../../common/time/zoned-time.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AvailabilityService } from '../availability/availability.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { PoliciesService } from '../policies/policies.service.js';
import {
  type ManageBookingWithRelations,
  effectiveStatus,
  manageBookingInclude,
  toManageBookingView,
} from './booking.mappers.js';
import { BookingWriter, slotUnavailable } from './booking-writer.service.js';
import { computeManualAmounts } from './money.js';
import { RefundsService } from './refunds.service.js';

/** Points de fiabilité retirés à un joueur pour un no-show. */
export const NO_SHOW_PENALTY = 10;

const notFound = (): AppException => Errors.notFound('Réservation introuvable');
const unprocessable = (message: string): AppException =>
  new AppException('SLOT_NOT_BOOKABLE', HttpStatus.UNPROCESSABLE_ENTITY, message);
const notCancellable = (message: string): AppException =>
  new AppException('BOOKING_NOT_CANCELLABLE', HttpStatus.CONFLICT, message);

/**
 * Opérations du PERSONNEL d'un complexe sur ses réservations. Chaque méthode vérifie d'abord, dans le service,
 * que l'utilisateur appartient au complexe visé (404 sinon) avec le rôle requis, puis que la réservation / le
 * terrain appartient bien à CE complexe.
 */
@Injectable()
export class VenueBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PoliciesService,
    private readonly availability: AvailabilityService,
    private readonly writer: BookingWriter,
    private readonly refunds: RefundsService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── Calendrier ─────────────────────────

  /** Réservations (et blocages) d'une période de jours de service, avec le contact du client. */
  async list(
    user: AuthUser,
    venueId: string,
    query: ListManageBookingsQuery,
    now: Date = new Date(),
  ): Promise<ManageBookingView[]> {
    await this.policies.requireVenueRole(user, venueId, 'STAFF');
    const venue = await this.prisma.venue.findUniqueOrThrow({
      where: { id: venueId },
      select: { timezone: true },
    });

    // Du début du premier jour de service à la fin du dernier (les créneaux d'après minuit y sont inclus).
    const from = localToUtc(query.from, 0, venue.timezone);
    const to = localToUtc(query.to, 30 * 60, venue.timezone);

    const where: Prisma.BookingWhereInput = {
      venueId,
      startsAt: { gte: from, lt: to },
      ...(query.fieldId ? { fieldId: query.fieldId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.includeBlocks ? {} : { bookingType: { not: 'BLOCK' } }),
    };
    const rows = await this.prisma.booking.findMany({
      where,
      include: manageBookingInclude,
      orderBy: [{ startsAt: 'asc' }, { createdAt: 'asc' }],
      take: 2000,
    });
    return rows.map((r) => toManageBookingView(r, now));
  }

  // ───────────────────────── Réservation saisie par le complexe ─────────────────────────

  /**
   * Réservation par téléphone ou sur place. Sans commission : elle bloque simplement le créneau
   * (le client règle tout au complexe). Passe par la MÊME contrainte anti-double-réservation que les joueurs.
   */
  async createManual(
    user: AuthUser,
    venueId: string,
    input: CreateManualBookingInput,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<ManageBookingView> {
    const access = await this.policies.requireVenueRole(user, venueId, 'STAFF');
    const startsAt = new Date(input.startsAt);

    const found = await this.availability.findSlot(input.fieldId, startsAt, now);
    // Le terrain doit appartenir à CE complexe (un identifiant d'un autre complexe = introuvable).
    if (!found || found.venue.id !== venueId) throw Errors.notFound('Terrain introuvable');
    const { slot } = found;
    if (!slot) throw unprocessable('Ce créneau n’existe pas pour ce terrain');

    switch (slot.status) {
      case 'AVAILABLE':
      case 'NO_PRICE':
        break;
      case 'PAST':
        // Client qui se présente à l'accueil : le créneau en cours (commencé, pas fini) reste réservable.
        if (slot.endsAt <= now) throw unprocessable('Ce créneau est terminé');
        break;
      default:
        throw slotUnavailable();
    }

    const basePriceMinor = input.priceMinor ?? slot.priceMinor;
    if (basePriceMinor === null || basePriceMinor === undefined) {
      throw new AppException(
        'VALIDATION_ERROR',
        HttpStatus.BAD_REQUEST,
        'Ce créneau n’a pas de tarif : indiquez le prix convenu',
        [{ path: 'priceMinor', message: 'Requis pour un créneau sans tarif', code: 'required' }],
      );
    }

    const row = await this.writer.create(
      {
        userId: null,
        customerName: input.customerName,
        customerPhone: input.customerPhone ?? null,
        note: input.note ?? null,
        fieldId: found.field.id,
        venueId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        status: 'CONFIRMED',
        source: 'VENUE_MANUAL',
        bookingType: 'STANDARD',
        paymentMode: 'ON_SITE',
        createdById: user.id,
        ...computeManualAmounts(basePriceMinor),
      },
      manageBookingInclude,
      { now },
    );
    await this.audit.record(
      {
        actorId: user.id,
        actorRole: access.role,
        action: 'booking.manual_create',
        entityType: 'Booking',
        entityId: row.id,
        after: {
          fieldId: row.fieldId,
          startsAt: row.startsAt.toISOString(),
          priceMinor: basePriceMinor,
        },
      },
      ctx,
    );
    return toManageBookingView(row, now);
  }

  // ───────────────────────── Blocages ─────────────────────────

  /**
   * Rend une période indisponible (travaux, événement privé…). Un blocage est une ligne de réservation :
   * la même contrainte garantit qu'il ne peut jamais chevaucher une réservation existante.
   * En cas de conflit, la réponse liste les réservations gênantes pour que le gérant les traite d'abord.
   */
  async createBlock(
    user: AuthUser,
    venueId: string,
    input: CreateBlockInput,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<ManageBookingView> {
    const access = await this.policies.requireVenueRole(user, venueId, 'MANAGER');
    const field = await this.prisma.field.findFirst({
      where: { id: input.fieldId, venueId },
      select: { id: true },
    });
    if (!field) throw Errors.notFound('Terrain introuvable');

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (endsAt <= now) throw unprocessable('Cette période est terminée');

    try {
      const row = await this.writer.create(
        {
          userId: null,
          customerName: null,
          note: input.reason ?? null,
          fieldId: field.id,
          venueId,
          startsAt,
          endsAt,
          status: 'CONFIRMED',
          source: 'VENUE_MANUAL',
          bookingType: 'BLOCK',
          paymentMode: 'ON_SITE',
          createdById: user.id,
          ...computeManualAmounts(0),
        },
        manageBookingInclude,
        { now },
      );
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: access.role,
          action: 'booking.block',
          entityType: 'Booking',
          entityId: row.id,
          after: {
            fieldId: field.id,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            reason: input.reason ?? null,
          },
        },
        ctx,
      );
      return toManageBookingView(row, now);
    } catch (error) {
      if (error instanceof AppException && error.code === 'SLOT_UNAVAILABLE') {
        throw slotUnavailable(await this.conflictingBookings(field.id, startsAt, endsAt, now));
      }
      throw error;
    }
  }

  /** « Ouvrir » un créneau bloqué : le blocage est annulé (l'historique est conservé). */
  async removeBlock(
    user: AuthUser,
    venueId: string,
    bookingId: string,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<void> {
    const access = await this.policies.requireVenueRole(user, venueId, 'MANAGER');
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.booking.updateMany({
        where: { id: bookingId, venueId, bookingType: 'BLOCK', status: 'CONFIRMED' },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledById: user.id,
          cancellationReason: 'Blocage levé',
        },
      });
      if (updated.count === 0) return null;
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: access.role,
          action: 'booking.unblock',
          entityType: 'Booking',
          entityId: bookingId,
        },
        ctx,
        tx,
      );
      return updated.count;
    });
    if (result === null) throw Errors.notFound('Blocage introuvable');
  }

  // ───────────────────────── Annulation par le complexe ─────────────────────────

  /** Annulation à l'initiative du complexe : le client est TOUJOURS remboursé intégralement de ce qu'il a payé. */
  async cancel(
    user: AuthUser,
    venueId: string,
    bookingId: string,
    input: StaffCancelBookingInput,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<{ booking: ManageBookingView; refundRequestedMinor: number }> {
    const access = await this.policies.requireVenueRole(user, venueId, 'MANAGER');
    const row = await this.findOwned(venueId, bookingId);
    if (row.bookingType === 'BLOCK') throw notFound(); // un blocage se lève, il ne s'annule pas comme une réservation

    const status = effectiveStatus(row, now);
    const cancellable =
      status === 'PENDING_PAYMENT' || (status === 'CONFIRMED' && row.startsAt > now);
    if (!cancellable) throw notCancellable('Cette réservation ne peut plus être annulée');

    const refundRequestedMinor = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.booking.updateMany({
        where: { id: bookingId, venueId, status: { in: ['PENDING_PAYMENT', 'CONFIRMED'] } },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledById: user.id,
          cancellationReason: input.reason,
          holdExpiresAt: null,
        },
      });
      if (claimed.count === 0) throw notCancellable('Cette réservation vient d’être modifiée');

      const requested = await this.refunds.requestFullRefund(tx, {
        bookingId,
        reason: `Annulation par le complexe : ${input.reason}`,
        requestedById: user.id,
      });
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: access.role,
          action: 'booking.cancel_by_venue',
          entityType: 'Booking',
          entityId: bookingId,
          before: { status },
          after: { status: 'CANCELLED', refundMinor: requested, reason: input.reason },
        },
        ctx,
        tx,
      );
      return requested;
    });

    return {
      booking: toManageBookingView(await this.findOwned(venueId, bookingId), now),
      refundRequestedMinor,
    };
  }

  // ───────────────────────── Présence ─────────────────────────

  /**
   * Le joueur ne s'est pas présenté. Possible une fois le créneau commencé. Le créneau reste occupé
   * (on ne réécrit pas le passé) et la fiabilité du joueur baisse — décision du complexe, tracée dans l'audit.
   */
  async markNoShow(
    user: AuthUser,
    venueId: string,
    bookingId: string,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<ManageBookingView> {
    const access = await this.policies.requireVenueRole(user, venueId, 'STAFF');
    const row = await this.findOwned(venueId, bookingId);
    if (row.bookingType === 'BLOCK') throw notFound();
    if (row.status !== 'CONFIRMED')
      throw notCancellable('Seule une réservation confirmée peut être marquée absente');
    if (row.startsAt > now) throw notCancellable('Le créneau n’a pas encore commencé');

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.booking.updateMany({
        where: { id: bookingId, venueId, status: 'CONFIRMED' },
        data: { status: 'NO_SHOW' },
      });
      if (claimed.count === 0) throw notCancellable('Cette réservation vient d’être modifiée');

      if (row.userId) {
        // S'assure que la fiche existe, puis met à jour en UNE instruction : deux no-shows simultanés ne se marchent pas dessus.
        await tx.playerStats.upsert({
          where: { userId: row.userId },
          create: { userId: row.userId },
          update: {},
        });
        await tx.$executeRaw`
          UPDATE "PlayerStats"
          SET "noShowCount" = "noShowCount" + 1,
              "reliabilityScore" = GREATEST(0, "reliabilityScore" - ${NO_SHOW_PENALTY}),
              "updatedAt" = now()
          WHERE "userId" = ${row.userId}::uuid`;
      }
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: access.role,
          action: 'booking.no_show',
          entityType: 'Booking',
          entityId: bookingId,
          before: { status: 'CONFIRMED' },
          after: { status: 'NO_SHOW' },
        },
        ctx,
        tx,
      );
    });
    return toManageBookingView(await this.findOwned(venueId, bookingId), now);
  }

  // ───────────────────────── Aides ─────────────────────────

  /** Une réservation n'est accessible que par le complexe qui la possède : sinon 404. */
  private async findOwned(venueId: string, bookingId: string): Promise<ManageBookingWithRelations> {
    const row = await this.prisma.booking.findFirst({
      where: { id: bookingId, venueId },
      include: manageBookingInclude,
    });
    if (!row) throw notFound();
    return row;
  }

  private async conflictingBookings(fieldId: string, startsAt: Date, endsAt: Date, now: Date) {
    const rows = await this.prisma.booking.findMany({
      where: {
        fieldId,
        status: { in: ['PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'NO_SHOW'] },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      select: {
        id: true,
        reference: true,
        startsAt: true,
        endsAt: true,
        status: true,
        bookingType: true,
        holdExpiresAt: true,
      },
      orderBy: { startsAt: 'asc' },
      take: 20,
    });
    return {
      conflicts: rows
        .filter((r) => effectiveStatus(r, now) !== 'EXPIRED')
        .map((r) => ({
          id: r.id,
          reference: r.reference,
          startsAt: r.startsAt.toISOString(),
          endsAt: r.endsAt.toISOString(),
          type: r.bookingType,
        })),
    };
  }
}
