import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type CreateTeamMatchInput,
  type ListMyActivityQuery,
  type MatchView,
  type PageOf,
  type SetScoreInput,
} from '@footfive/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { DomainEvents } from '../../infra/events/domain-events.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { TeamsService, decodeOffset, encodeOffset } from '../teams/teams.service.js';
import {
  conflict,
  displayName,
  lockBooking,
  lockListing,
  personBrief,
  requireEligibleBooking,
  teamBrief,
  venueBrief,
} from './social-common.js';
import {
  cancelListingTx,
  cancelMatchTx,
  completeMatchTx,
  emitOutcome,
} from './social-lifecycle.js';

const matchInclude = {
  venue: { select: venueBrief },
  booking: { select: { field: { select: { id: true, name: true } } } },
  teamA: { select: teamBrief },
  teamB: { select: teamBrief },
  participants: { include: { user: { select: personBrief } } },
} satisfies Prisma.MatchInclude;
type MatchRow = Prisma.MatchGetPayload<{ include: typeof matchInclude }>;

const notFound = (): AppException => Errors.notFound('Match introuvable');

@Injectable()
export class MatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly teams: TeamsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  /** Match organisé par une équipe sur UNE de ses réservations confirmées (entraînement, match interne). */
  async createTeamMatch(
    user: AuthUser,
    input: CreateTeamMatchInput,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<MatchView> {
    await this.teams.requireCaptain(user.id, input.teamId);

    const matchId = await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, input.bookingId);
      const booking = await requireEligibleBooking(tx, input.bookingId, { ownerId: user.id }, now);
      const team = await tx.team.findUniqueOrThrow({
        where: { id: input.teamId },
        select: { level: true },
      });
      const members = await tx.teamMember.findMany({
        where: { teamId: input.teamId, leftAt: null },
        select: { userId: true },
      });
      const match = await tx.match.create({
        data: {
          source: 'TEAM',
          bookingId: booking.id,
          venueId: booking.venueId,
          fieldId: booking.fieldId,
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
          teamAId: input.teamId,
          level: team.level,
          createdById: user.id,
          participants: {
            createMany: { data: members.map((m) => ({ userId: m.userId, side: 'A' as const })) },
          },
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: 'USER',
          action: 'match.create',
          entityType: 'Match',
          entityId: match.id,
          after: { source: 'TEAM', bookingId: booking.id, teamId: input.teamId },
        },
        ctx,
        tx,
      );
      return match.id;
    });
    return this.view(matchId);
  }

  async get(user: AuthUser, id: string): Promise<MatchView> {
    const row = await this.findVisible(user, id);
    return this.toView(row);
  }

  async listMine(
    user: AuthUser,
    query: ListMyActivityQuery,
    now: Date = new Date(),
  ): Promise<PageOf<MatchView>> {
    const offset = decodeOffset(query.cursor);
    const when: Prisma.MatchWhereInput =
      query.when === 'upcoming'
        ? { endsAt: { gt: now } }
        : query.when === 'past'
          ? { endsAt: { lte: now } }
          : {};
    const rows = await this.prisma.match.findMany({
      where: { AND: [this.visibleTo(user.id), when] },
      include: matchInclude,
      orderBy: [{ startsAt: query.when === 'upcoming' ? 'asc' : 'desc' }, { id: 'asc' }],
      skip: offset,
      take: query.limit + 1,
    });
    return {
      items: rows.slice(0, query.limit).map((r) => this.toView(r)),
      nextCursor: rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
    };
  }

  /**
   * Saisie du score par l'un des deux capitaines, une fois le match terminé. Écriture UNIQUE : un second envoi est
   * refusé (le score ne se discute pas après coup ; un litige se règle avec le complexe / l'administrateur).
   */
  async setScore(
    user: AuthUser,
    id: string,
    input: SetScoreInput,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<MatchView> {
    const match = await this.findVisible(user, id);
    await this.requireCaptainOfEither(user.id, match);
    if (match.status === 'CANCELLED') throw conflict('CONFLICT', 'Ce match est annulé');
    if (!match.teamAId || !match.teamBId)
      throw conflict('CONFLICT', 'Un score nécessite deux équipes');
    if (match.endsAt > now) throw conflict('CONFLICT', 'Le match n’est pas terminé');

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.match.updateMany({
        where: { id, scoreA: null, status: { in: ['SCHEDULED', 'COMPLETED'] } },
        data: { scoreA: input.scoreA, scoreB: input.scoreB },
      });
      if (claimed.count === 0) throw conflict('CONFLICT', 'Le score de ce match est déjà saisi');
      await completeMatchTx(tx, id);
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: 'USER',
          action: 'match.score',
          entityType: 'Match',
          entityId: id,
          after: { scoreA: input.scoreA, scoreB: input.scoreB },
        },
        ctx,
        tx,
      );
    });
    return this.view(id);
  }

  /**
   * Annulation d'un match à venir.
   *  - match d'équipe : le capitaine ;
   *  - face-à-face trouvé par annonce : le capitaine de l'équipe ANNONCEUSE annule tout (annonce comprise) ; le
   *    capitaine de l'équipe ADVERSE se retire : le match disparaît et l'annonce redevient ouverte ;
   *  - session « Complétez votre équipe » : on annule la session, pas le match.
   * La réservation du terrain n'est jamais annulée ici (son annulation suit sa propre politique de remboursement).
   */
  async cancel(
    user: AuthUser,
    id: string,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<void> {
    const match = await this.findVisible(user, id);
    if (match.status !== 'SCHEDULED') throw conflict('CONFLICT', 'Ce match n’est plus à venir');
    if (match.startsAt <= now) throw conflict('SESSION_CLOSED', 'Ce match a déjà commencé');

    if (match.source === 'SOLO_SESSION')
      throw conflict('CONFLICT', 'Annulez la session « Complétez votre équipe » correspondante');

    if (match.source === 'TEAM') {
      await this.teams.requireCaptain(user.id, match.teamAId as string);
      const outcome = await this.prisma.$transaction(async (tx) => {
        const result = await cancelMatchTx(tx, id);
        await this.audit.record(
          {
            actorId: user.id,
            actorRole: 'USER',
            action: 'match.cancel',
            entityType: 'Match',
            entityId: id,
          },
          ctx,
          tx,
        );
        return result;
      });
      await emitOutcome(this.events, outcome);
      return;
    }

    // Face-à-face issu d'une annonce
    const isCaptain = async (teamId: string | null): Promise<boolean> =>
      teamId !== null &&
      (await this.prisma.teamMember.count({
        where: {
          teamId,
          userId: user.id,
          role: 'CAPTAIN',
          leftAt: null,
          team: { deletedAt: null },
        },
      })) > 0;
    const listingId = match.opponentListingId as string;

    if (await isCaptain(match.teamAId)) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const result = await cancelListingTx(tx, listingId, now);
        await this.audit.record(
          {
            actorId: user.id,
            actorRole: 'USER',
            action: 'match.cancel',
            entityType: 'Match',
            entityId: id,
            after: { listingId },
          },
          ctx,
          tx,
        );
        return result;
      });
      await emitOutcome(this.events, outcome);
      return;
    }
    if (await isCaptain(match.teamBId)) {
      const participantIds = match.participants.map((p) => p.userId);
      const withdrawn = await this.prisma.$transaction(async (tx) => {
        await lockListing(tx, listingId);
        const stillThere = await tx.match.findFirst({
          where: { id, status: 'SCHEDULED' },
          select: { id: true },
        });
        if (!stillThere) return false;
        await tx.match.delete({ where: { id } }); // les participants partent avec (cascade)
        await tx.opponentListing.update({ where: { id: listingId }, data: { status: 'OPEN' } });
        await tx.matchRequest.updateMany({
          where: { listingId, requestingTeamId: match.teamBId as string, status: 'ACCEPTED' },
          data: { status: 'CANCELLED', respondedAt: now },
        });
        await this.audit.record(
          {
            actorId: user.id,
            actorRole: 'USER',
            action: 'match.withdraw',
            entityType: 'Match',
            entityId: id,
            after: { listingId },
          },
          ctx,
          tx,
        );
        return true;
      });
      if (withdrawn)
        await this.events.emit('match.cancelled', {
          matchId: id,
          participantIds,
          venueName: match.venue.name,
          startsAt: match.startsAt.toISOString(),
        });
      return;
    }
    throw new AppException(
      'NOT_CAPTAIN',
      HttpStatus.FORBIDDEN,
      'Réservé aux capitaines des équipes du match',
    );
  }

  // ───────────────────────── Accès et vues ─────────────────────────

  /** Un match est visible de ses participants, des membres de ses équipes, de son créateur et du personnel du complexe. */
  visibleTo(userId: string): Prisma.MatchWhereInput {
    return {
      OR: [
        { participants: { some: { userId } } },
        { createdById: userId },
        { teamA: { is: { members: { some: { userId, leftAt: null } } } } },
        { teamB: { is: { members: { some: { userId, leftAt: null } } } } },
        { venue: { is: { staff: { some: { userId } } } } },
      ],
    };
  }

  private async findVisible(user: AuthUser, id: string): Promise<MatchRow> {
    const row = await this.prisma.match.findFirst({
      where: user.platformRole === 'ADMIN' ? { id } : { id, ...this.visibleTo(user.id) },
      include: matchInclude,
    });
    if (!row) throw notFound();
    return row;
  }

  private async requireCaptainOfEither(userId: string, match: MatchRow): Promise<void> {
    const teamIds = [match.teamAId, match.teamBId].filter((t): t is string => t !== null);
    const captain = await this.prisma.teamMember.count({
      where: {
        userId,
        teamId: { in: teamIds },
        role: 'CAPTAIN',
        leftAt: null,
        team: { deletedAt: null },
      },
    });
    if (captain === 0)
      throw new AppException(
        'NOT_CAPTAIN',
        HttpStatus.FORBIDDEN,
        'Réservé aux capitaines des équipes du match',
      );
  }

  async view(id: string): Promise<MatchView> {
    const row = await this.prisma.match.findUniqueOrThrow({ where: { id }, include: matchInclude });
    return this.toView(row);
  }

  toView(m: MatchRow): MatchView {
    const order = { A: 0, B: 1, NONE: 2 } as const;
    return {
      id: m.id,
      source: m.source,
      status: m.status,
      startsAt: m.startsAt.toISOString(),
      endsAt: m.endsAt.toISOString(),
      venue: m.venue,
      field: m.booking.field,
      teamA: m.teamA,
      teamB: m.teamB,
      playersPerSide: m.playersPerSide,
      level: m.level,
      scoreA: m.scoreA,
      scoreB: m.scoreB,
      participants: m.participants
        .map((p) => ({
          id: p.user.id,
          name: displayName(p.user),
          avatarUrl: p.user.avatarUrl,
          side: p.side,
        }))
        .sort((a, b) => order[a.side] - order[b.side] || a.name.localeCompare(b.name)),
      bookingId: m.bookingId,
      soloSessionId: m.soloSessionId,
      opponentListingId: m.opponentListingId,
    };
  }
}
