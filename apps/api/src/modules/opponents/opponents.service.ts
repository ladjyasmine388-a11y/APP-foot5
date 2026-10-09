import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type CreateMatchRequestInput,
  type CreateOpponentListingInput,
  type ListOpponentListingsQuery,
  type MatchRequestView,
  type MatchView,
  type OpponentListingView,
  type PageOf,
} from '@footfive/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { localToUtc } from '../../common/time/zoned-time.js';
import { PG_ERROR, isPgError } from '../../infra/database/pg-errors.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { DomainEvents } from '../../infra/events/domain-events.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { MatchesService } from '../matches/matches.service.js';
import {
  PLATFORM_TZ,
  conflict,
  levelsCompatible,
  lockBooking,
  lockListing,
  requireEligibleBooking,
  venueBrief,
} from '../matches/social-common.js';
import { cancelListingTx, emitOutcome } from '../matches/social-lifecycle.js';
import { TeamsService, decodeOffset, encodeOffset } from '../teams/teams.service.js';

const MAX_PENDING_REQUESTS = 20;

const listingInclude = {
  venue: { select: venueBrief },
  booking: {
    select: { endsAt: true, field: { select: { id: true, name: true, capacity: true } } },
  },
  team: {
    select: {
      id: true,
      name: true,
      logoUrl: true,
      level: true,
      _count: { select: { members: { where: { leftAt: null } } } },
    },
  },
  match: { select: { id: true } },
} satisfies Prisma.OpponentListingInclude;
type ListingRow = Prisma.OpponentListingGetPayload<{ include: typeof listingInclude }>;

const requestInclude = {
  requestingTeam: {
    select: {
      id: true,
      name: true,
      logoUrl: true,
      level: true,
      _count: { select: { members: { where: { leftAt: null } } } },
    },
  },
} satisfies Prisma.MatchRequestInclude;
type RequestRow = Prisma.MatchRequestGetPayload<{ include: typeof requestInclude }>;

const notFound = (): AppException => Errors.notFound('Annonce introuvable');
const teamBrief = (t: ListingRow['team'] | RequestRow['requestingTeam']) => ({
  id: t.id,
  name: t.name,
  logoUrl: t.logoUrl,
  level: t.level,
  memberCount: t._count.members,
});

@Injectable()
export class OpponentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly teams: TeamsService,
    private readonly matches: MatchesService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  // ───────────────────────── Annonces ─────────────────────────

  /** « Nous cherchons un adversaire » : le capitaine annonce une de SES réservations confirmées. */
  async create(
    user: AuthUser,
    input: CreateOpponentListingInput,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<OpponentListingView> {
    await this.teams.requireCaptain(user.id, input.teamId);

    const listingId = await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, input.bookingId);
      const booking = await requireEligibleBooking(tx, input.bookingId, { ownerId: user.id }, now);

      const team = await tx.team.findUniqueOrThrow({
        where: { id: input.teamId },
        select: { level: true, _count: { select: { members: { where: { leftAt: null } } } } },
      });
      // Format par défaut : le plus grand que le terrain ET l'effectif permettent (5 à 8 par équipe).
      const perSide =
        input.playersPerSide ??
        Math.min(8, Math.floor(booking.fieldCapacity / 2), Math.max(5, team._count.members));
      if (perSide * 2 > booking.fieldCapacity) {
        throw new AppException(
          'VALIDATION_ERROR',
          HttpStatus.BAD_REQUEST,
          `Ce terrain accueille ${booking.fieldCapacity} joueurs au maximum`,
          [
            {
              path: 'playersPerSide',
              message: `Maximum ${Math.floor(booking.fieldCapacity / 2)}`,
              code: 'too_big',
            },
          ],
        );
      }
      if (team._count.members < perSide) {
        throw conflict(
          'TEAM_TOO_SMALL',
          `Il faut au moins ${perSide} joueurs dans l’équipe pour ce format`,
        );
      }

      const listing = await tx.opponentListing.create({
        data: {
          teamId: input.teamId,
          bookingId: booking.id,
          createdById: user.id,
          venueId: booking.venueId,
          fieldId: booking.fieldId,
          startsAt: booking.startsAt,
          playersPerSide: perSide,
          level: input.level ?? team.level,
          comment: input.comment ?? null,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: 'USER',
          action: 'opponent.listing_create',
          entityType: 'OpponentListing',
          entityId: listing.id,
          after: { teamId: input.teamId, bookingId: booking.id, playersPerSide: perSide },
        },
        ctx,
        tx,
      );
      return listing.id;
    });
    return this.getForViewer(listingId, user);
  }

  async list(
    query: ListOpponentListingsQuery,
    viewer: AuthUser | null,
    now: Date = new Date(),
  ): Promise<PageOf<OpponentListingView>> {
    const offset = decodeOffset(query.cursor);
    const startsAt: Prisma.DateTimeFilter = { gt: now };
    if (query.date) {
      startsAt.gte = localToUtc(query.date, 0, PLATFORM_TZ);
      startsAt.lt = localToUtc(query.date, 1440, PLATFORM_TZ);
    }
    const rows = await this.prisma.opponentListing.findMany({
      where: {
        status: 'OPEN',
        startsAt,
        team: { deletedAt: null },
        venue: {
          status: 'APPROVED',
          ...(query.venue ? { slug: query.venue } : {}),
          ...(query.city ? { city: { equals: query.city, mode: 'insensitive' } } : {}),
        },
        ...(query.level ? { OR: [{ level: query.level }, { level: null }] } : {}),
        ...(query.playersPerSide ? { playersPerSide: query.playersPerSide } : {}),
      },
      include: listingInclude,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      skip: offset,
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const views = await this.toViews(page, viewer);
    return {
      items: views,
      nextCursor: rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
    };
  }

  /** Une annonce ouverte est publique ; sinon réservée aux équipes concernées et au personnel du complexe. */
  async getForViewer(
    id: string,
    viewer: AuthUser | null,
    now: Date = new Date(),
  ): Promise<OpponentListingView> {
    const row = await this.prisma.opponentListing.findUnique({
      where: { id },
      include: listingInclude,
    });
    if (!row) throw notFound();
    const open =
      row.status === 'OPEN' &&
      row.startsAt > now &&
      (await this.prisma.venue.count({ where: { id: row.venueId, status: 'APPROVED' } })) > 0;
    if (!open && !(await this.isConcerned(row, viewer))) throw notFound();
    return (await this.toViews([row], viewer))[0] as OpponentListingView;
  }

  async listMine(user: AuthUser): Promise<OpponentListingView[]> {
    const rows = await this.prisma.opponentListing.findMany({
      where: { team: { deletedAt: null, members: { some: { userId: user.id, leftAt: null } } } },
      include: listingInclude,
      orderBy: [{ startsAt: 'desc' }, { id: 'asc' }],
      take: 50,
    });
    return this.toViews(rows, user);
  }

  /** Retire une annonce encore ouverte (les demandes en attente sont rejetées). Annonce déjà acceptée : annuler le match. */
  async cancel(
    user: AuthUser,
    id: string,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<void> {
    const listing = await this.prisma.opponentListing.findUnique({
      where: { id },
      select: { teamId: true },
    });
    if (!listing) throw notFound();
    await this.teams.requireCaptain(user.id, listing.teamId);

    const outcome = await this.prisma.$transaction(async (tx) => {
      await lockListing(tx, id);
      const current = await tx.opponentListing.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      });
      if (current.status === 'ACCEPTED')
        throw conflict('CONFLICT', 'Un adversaire est déjà confirmé : annulez le match');
      const result = await cancelListingTx(tx, id, now);
      if (result.rejected.length === 0 && current.status !== 'OPEN')
        throw conflict('SESSION_CLOSED', 'Cette annonce est déjà fermée');
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: 'USER',
          action: 'opponent.listing_cancel',
          entityType: 'OpponentListing',
          entityId: id,
        },
        ctx,
        tx,
      );
      return result;
    });
    await emitOutcome(this.events, outcome);
  }

  // ───────────────────────── Demandes ─────────────────────────

  async request(
    user: AuthUser,
    listingId: string,
    input: CreateMatchRequestInput,
    now: Date = new Date(),
  ): Promise<MatchRequestView> {
    await this.teams.requireCaptain(user.id, input.teamId);

    const requestId = await this.prisma.$transaction(async (tx) => {
      const listing = await tx.opponentListing.findUnique({
        where: { id: listingId },
        include: {
          booking: { select: { status: true, endsAt: true } },
          team: { select: { deletedAt: true } },
          venue: { select: { status: true } },
        },
      });
      if (!listing || listing.team.deletedAt || listing.venue.status !== 'APPROVED')
        throw notFound();
      if (listing.teamId === input.teamId)
        throw conflict('CONFLICT', 'Une équipe ne peut pas s’affronter elle-même');
      if (
        listing.status !== 'OPEN' ||
        listing.startsAt <= now ||
        listing.booking.status !== 'CONFIRMED'
      ) {
        throw conflict('SESSION_CLOSED', 'Cette annonce n’est plus ouverte');
      }
      // Un capitaine ne peut pas jouer des deux côtés.
      const bothSides = await tx.teamMember.count({
        where: { teamId: listing.teamId, userId: user.id, role: 'CAPTAIN', leftAt: null },
      });
      if (bothSides > 0)
        throw conflict('CONFLICT', 'Vous dirigez l’équipe qui a publié cette annonce');

      const team = await tx.team.findUniqueOrThrow({
        where: { id: input.teamId },
        select: { level: true, _count: { select: { members: { where: { leftAt: null } } } } },
      });
      if (team._count.members < listing.playersPerSide) {
        throw conflict(
          'TEAM_TOO_SMALL',
          `Il faut au moins ${listing.playersPerSide} joueurs dans l’équipe pour ce format`,
        );
      }
      if (!levelsCompatible(team.level, listing.level))
        throw conflict(
          'LEVEL_INCOMPATIBLE',
          'Le niveau de votre équipe ne correspond pas à cette annonce',
        );
      await this.requireTeamFree(tx, input.teamId, listing.startsAt, listing.booking.endsAt);

      const pending = await tx.matchRequest.count({ where: { listingId, status: 'REQUESTED' } });
      if (pending >= MAX_PENDING_REQUESTS)
        throw conflict('CONFLICT', 'Trop de demandes en attente pour cette annonce');

      try {
        const created = await tx.matchRequest.create({
          data: {
            listingId,
            requestingTeamId: input.teamId,
            requestedById: user.id,
            message: input.message ?? null,
          },
          select: { id: true },
        });
        return created.id;
      } catch (error) {
        if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION))
          throw conflict('CONFLICT', 'Votre équipe a déjà une demande en cours pour cette annonce');
        throw error;
      }
    });
    await this.events.emit('opponent.request_created', { requestId, listingId });
    const row = await this.prisma.matchRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: requestInclude,
    });
    return this.toRequestView(row);
  }

  async listRequests(user: AuthUser, listingId: string): Promise<MatchRequestView[]> {
    const listing = await this.prisma.opponentListing.findUnique({
      where: { id: listingId },
      select: { teamId: true },
    });
    if (!listing) throw notFound();
    await this.teams.requireCaptain(user.id, listing.teamId);
    const rows = await this.prisma.matchRequest.findMany({
      where: { listingId },
      include: requestInclude,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toRequestView(r));
  }

  async listMyRequests(user: AuthUser): Promise<MatchRequestView[]> {
    const rows = await this.prisma.matchRequest.findMany({
      where: {
        requestingTeam: {
          deletedAt: null,
          members: { some: { userId: user.id, role: 'CAPTAIN', leftAt: null } },
        },
      },
      include: requestInclude,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => this.toRequestView(r));
  }

  /**
   * Le capitaine de l'annonce accepte UNE demande : les autres sont rejetées, le match est créé avec les effectifs
   * des deux équipes. L'annonce est verrouillée (`FOR UPDATE`) : deux acceptations simultanées ne peuvent pas
   * produire deux adversaires (un index partiel en base le garantit aussi).
   */
  async accept(
    user: AuthUser,
    listingId: string,
    requestId: string,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<MatchView> {
    const head = await this.prisma.opponentListing.findUnique({
      where: { id: listingId },
      select: { teamId: true },
    });
    if (!head) throw notFound();
    await this.teams.requireCaptain(user.id, head.teamId);

    let matchId = '';
    let rejected: string[] = [];
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockListing(tx, listingId);
        const listing = await tx.opponentListing.findUniqueOrThrow({
          where: { id: listingId },
          include: { booking: { select: { status: true, endsAt: true } } },
        });
        if (
          listing.status !== 'OPEN' ||
          listing.startsAt <= now ||
          listing.booking.status !== 'CONFIRMED'
        ) {
          throw conflict('SESSION_CLOSED', 'Cette annonce n’est plus ouverte');
        }
        const request = await tx.matchRequest.findFirst({
          where: { id: requestId, listingId, status: 'REQUESTED' },
        });
        if (!request) throw Errors.notFound('Demande introuvable ou déjà traitée');

        const opponent = await tx.team.findFirst({
          where: { id: request.requestingTeamId, deletedAt: null },
          select: { _count: { select: { members: { where: { leftAt: null } } } } },
        });
        if (!opponent) throw Errors.notFound('Cette équipe n’existe plus');
        if (opponent._count.members < listing.playersPerSide)
          throw conflict('TEAM_TOO_SMALL', 'L’équipe adverse n’a plus assez de joueurs');
        await this.requireTeamFree(
          tx,
          request.requestingTeamId,
          listing.startsAt,
          listing.booking.endsAt,
        );

        await tx.matchRequest.update({
          where: { id: requestId },
          data: { status: 'ACCEPTED', respondedAt: now },
        });
        const others = await tx.matchRequest.updateManyAndReturn({
          where: { listingId, status: 'REQUESTED', id: { not: requestId } },
          data: { status: 'REJECTED', respondedAt: now },
          select: { id: true },
        });
        rejected = others.map((o) => o.id);
        await tx.opponentListing.update({ where: { id: listingId }, data: { status: 'ACCEPTED' } });

        const [membersA, membersB] = await Promise.all([
          tx.teamMember.findMany({
            where: { teamId: listing.teamId, leftAt: null },
            select: { userId: true },
          }),
          tx.teamMember.findMany({
            where: { teamId: request.requestingTeamId, leftAt: null },
            select: { userId: true },
          }),
        ]);
        const sideA = new Set(membersA.map((m) => m.userId));
        const participants = [
          ...[...sideA].map((userId) => ({ userId, side: 'A' as const })),
          ...membersB
            .filter((m) => !sideA.has(m.userId))
            .map((m) => ({ userId: m.userId, side: 'B' as const })),
        ];
        const match = await tx.match.create({
          data: {
            source: 'OPPONENT_LISTING',
            bookingId: listing.bookingId,
            venueId: listing.venueId,
            fieldId: listing.fieldId,
            startsAt: listing.startsAt,
            endsAt: listing.booking.endsAt,
            teamAId: listing.teamId,
            teamBId: request.requestingTeamId,
            opponentListingId: listingId,
            level: listing.level,
            playersPerSide: listing.playersPerSide,
            createdById: user.id,
            participants: { createMany: { data: participants } },
          },
          select: { id: true },
        });
        matchId = match.id;
        await this.audit.record(
          {
            actorId: user.id,
            actorRole: 'USER',
            action: 'opponent.request_accept',
            entityType: 'OpponentListing',
            entityId: listingId,
            after: { requestId, matchId },
          },
          ctx,
          tx,
        );
      });
    } catch (error) {
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION))
        throw conflict(
          'BOOKING_NOT_ELIGIBLE',
          'Cette réservation est déjà utilisée pour un autre match',
        );
      throw error;
    }

    await this.events.emit('opponent.request_accepted', { requestId, listingId, matchId });
    for (const id of rejected)
      await this.events.emit('opponent.request_rejected', { requestId: id, listingId });
    return this.matches.view(matchId);
  }

  async reject(
    user: AuthUser,
    listingId: string,
    requestId: string,
    now: Date = new Date(),
  ): Promise<void> {
    const listing = await this.prisma.opponentListing.findUnique({
      where: { id: listingId },
      select: { teamId: true },
    });
    if (!listing) throw notFound();
    await this.teams.requireCaptain(user.id, listing.teamId);
    const result = await this.prisma.matchRequest.updateMany({
      where: { id: requestId, listingId, status: 'REQUESTED' },
      data: { status: 'REJECTED', respondedAt: now },
    });
    if (result.count === 0) throw Errors.notFound('Demande introuvable ou déjà traitée');
    await this.events.emit('opponent.request_rejected', { requestId, listingId });
  }

  /** L'équipe demandeuse retire sa demande tant qu'elle est en attente. */
  async cancelRequest(user: AuthUser, requestId: string, now: Date = new Date()): Promise<void> {
    const request = await this.prisma.matchRequest.findUnique({
      where: { id: requestId },
      select: { requestingTeamId: true },
    });
    if (!request) throw Errors.notFound('Demande introuvable');
    await this.teams.requireCaptain(user.id, request.requestingTeamId);
    const result = await this.prisma.matchRequest.updateMany({
      where: { id: requestId, status: 'REQUESTED' },
      data: { status: 'CANCELLED', respondedAt: now },
    });
    if (result.count === 0) throw conflict('CONFLICT', 'Cette demande n’est plus en attente');
  }

  // ───────────────────────── Internes ─────────────────────────

  /** L'équipe n'a aucun match à venir qui chevauche cette plage. */
  private async requireTeamFree(
    tx: Prisma.TransactionClient,
    teamId: string,
    startsAt: Date,
    end: Date,
  ): Promise<void> {
    const clash = await tx.match.count({
      where: {
        status: 'SCHEDULED',
        startsAt: { lt: end },
        endsAt: { gt: startsAt },
        OR: [{ teamAId: teamId }, { teamBId: teamId }],
      },
    });
    if (clash > 0)
      throw conflict('SCHEDULE_CONFLICT', 'Votre équipe a déjà un match sur ce créneau');
  }

  private async isConcerned(row: ListingRow, viewer: AuthUser | null): Promise<boolean> {
    if (!viewer) return false;
    if (viewer.platformRole === 'ADMIN') return true;
    const [team, requester, staff] = await Promise.all([
      this.prisma.teamMember.count({
        where: { teamId: row.teamId, userId: viewer.id, leftAt: null },
      }),
      this.prisma.matchRequest.count({
        where: {
          listingId: row.id,
          requestingTeam: {
            members: { some: { userId: viewer.id, role: 'CAPTAIN', leftAt: null } },
          },
        },
      }),
      this.prisma.venueStaff.count({ where: { venueId: row.venueId, userId: viewer.id } }),
    ]);
    return team + requester + staff > 0;
  }

  private async toViews(
    rows: ListingRow[],
    viewer: AuthUser | null,
  ): Promise<OpponentListingView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    let captainOf = new Set<string>();
    const mine = new Map<
      string,
      { id: string; status: MatchRequestView['status']; teamId: string }
    >();
    const pending = new Map<string, number>();

    if (viewer) {
      const captained = await this.prisma.teamMember.findMany({
        where: { userId: viewer.id, role: 'CAPTAIN', leftAt: null, team: { deletedAt: null } },
        select: { teamId: true },
      });
      captainOf = new Set(captained.map((c) => c.teamId));
      if (captainOf.size > 0) {
        const requests = await this.prisma.matchRequest.findMany({
          where: { listingId: { in: ids }, requestingTeamId: { in: [...captainOf] } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, listingId: true, status: true, requestingTeamId: true },
        });
        for (const r of requests)
          if (!mine.has(r.listingId))
            mine.set(r.listingId, { id: r.id, status: r.status, teamId: r.requestingTeamId });
        const counts = await this.prisma.matchRequest.groupBy({
          by: ['listingId'],
          where: { listingId: { in: ids }, status: 'REQUESTED' },
          _count: { _all: true },
        });
        for (const c of counts) pending.set(c.listingId, c._count._all);
      }
    }

    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.booking.endsAt.toISOString(),
      venue: r.venue,
      field: r.booking.field,
      team: teamBrief(r.team),
      playersPerSide: r.playersPerSide,
      level: r.level,
      comment: r.comment,
      pendingRequests: captainOf.has(r.teamId) ? (pending.get(r.id) ?? 0) : null,
      myRequest: mine.get(r.id) ?? null,
      matchId: r.match?.id ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  private toRequestView(r: RequestRow): MatchRequestView {
    return {
      id: r.id,
      listingId: r.listingId,
      status: r.status,
      team: teamBrief(r.requestingTeam),
      message: r.message,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
