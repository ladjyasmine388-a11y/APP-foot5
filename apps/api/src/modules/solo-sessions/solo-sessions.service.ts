import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type CreateSoloSessionInput,
  type ListMyActivityQuery,
  type ListSoloSessionsQuery,
  type PageOf,
  type SoloSessionView,
  parseTime,
} from '@footfive/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { localToUtc } from '../../common/time/zoned-time.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { DomainEvents } from '../../infra/events/domain-events.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import {
  MatchingStrategy,
  type PlayerProfile,
  type SessionCandidate,
} from '../matching/matching.strategy.js';
import {
  PLATFORM_TZ,
  conflict,
  displayName,
  hasScheduleClash,
  lockBooking,
  lockSoloSession,
  personBrief,
  requireEligibleBooking,
  venueBrief,
} from '../matches/social-common.js';
import { cancelSoloSessionTx, emitOutcome } from '../matches/social-lifecycle.js';
import { PoliciesService } from '../policies/policies.service.js';
import { decodeOffset, encodeOffset } from '../teams/teams.service.js';

/** Au plus ce nombre de sessions candidates est classé en mémoire (les plus proches dans le temps d'abord). */
const MAX_CANDIDATES = 300;

const soloInclude = {
  venue: { select: venueBrief },
  booking: { select: { field: { select: { id: true, name: true, capacity: true } } } },
  createdBy: { select: personBrief },
  match: { select: { id: true } },
  players: {
    where: { status: 'JOINED' },
    include: { user: { select: personBrief } },
    orderBy: { joinedAt: 'asc' },
  },
} satisfies Prisma.SoloSessionInclude;
type SoloRow = Prisma.SoloSessionGetPayload<{ include: typeof soloInclude }>;

const notFound = (): AppException => Errors.notFound('Session introuvable');

/** Visiteur anonyme : prénom et initiale seulement. */
const publicName = (u: { firstName: string; lastName: string; status?: string }): string =>
  u.status === 'DELETED' ? 'Utilisateur supprimé' : `${u.firstName} ${u.lastName.charAt(0)}.`;

@Injectable()
export class SoloSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PoliciesService,
    private readonly matching: MatchingStrategy,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  // ───────────────────────── Création ─────────────────────────

  /**
   * Ouvre une session sur une réservation CONFIRMÉE.
   *  - joueur-hôte : la réservation est la sienne ; il occupe déjà une place, donc au plus (capacité − 1) places ;
   *  - complexe (`venueId`) : le personnel ouvre des places sur l'une de ses réservations, toutes les places comptent.
   * La part de chaque joueur se règle entre joueurs / sur place : la plateforme n'encaisse rien pour cela.
   */
  async create(
    user: AuthUser,
    input: CreateSoloSessionInput,
    ctx: RequestContext,
    opts: { venueId?: string } = {},
    now: Date = new Date(),
  ): Promise<SoloSessionView> {
    const access = opts.venueId
      ? await this.policies.requireVenueRole(user, opts.venueId, 'STAFF')
      : null;
    const origin = opts.venueId ? 'VENUE' : 'PLAYER';

    const sessionId = await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, input.bookingId);
      const booking = await requireEligibleBooking(
        tx,
        input.bookingId,
        opts.venueId ? { venueId: opts.venueId } : { ownerId: user.id },
        now,
      );

      const maxSpots = booking.fieldCapacity - (origin === 'PLAYER' ? 1 : 0);
      if (input.spots > maxSpots) {
        throw new AppException(
          'VALIDATION_ERROR',
          HttpStatus.BAD_REQUEST,
          `Ce terrain accueille ${maxSpots} joueur(s) à recruter au maximum`,
          [{ path: 'spots', message: `Maximum ${maxSpots}`, code: 'too_big' }],
        );
      }

      const session = await tx.soloSession.create({
        data: {
          bookingId: booking.id,
          origin,
          createdById: user.id,
          venueId: booking.venueId,
          fieldId: booking.fieldId,
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
          capacity: input.spots,
          level: input.level ?? null,
          pricePerPlayerMinor: input.pricePerPlayerMinor ?? 0,
          description: input.description ?? null,
        },
        select: { id: true },
      });
      await tx.match.create({
        data: {
          source: 'SOLO_SESSION',
          bookingId: booking.id,
          venueId: booking.venueId,
          fieldId: booking.fieldId,
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
          soloSessionId: session.id,
          level: input.level ?? null,
          createdById: user.id,
          participants:
            origin === 'PLAYER' ? { create: { userId: user.id, side: 'NONE' } } : undefined,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: access?.role ?? 'USER',
          action: 'solo.create',
          entityType: 'SoloSession',
          entityId: session.id,
          after: { bookingId: booking.id, spots: input.spots, origin },
        },
        ctx,
        tx,
      );
      return session.id;
    });
    return this.getView(sessionId, user.id);
  }

  // ───────────────────────── Rejoindre / quitter ─────────────────────────

  /**
   * Inscription atomique : la ligne de la session est verrouillée (`FOR UPDATE`), le compteur ne peut donc jamais
   * dépasser la capacité, même avec 50 joueurs qui cliquent en même temps.
   */
  async join(user: AuthUser, sessionId: string, now: Date = new Date()): Promise<SoloSessionView> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      await lockSoloSession(tx, sessionId);
      const session = await tx.soloSession.findUnique({
        where: { id: sessionId },
        include: {
          venue: { select: { city: true, status: true } },
          match: { select: { id: true } },
        },
      });
      if (!session || session.venue.status !== 'APPROVED') throw notFound();
      if (
        session.status === 'CANCELLED' ||
        session.status === 'COMPLETED' ||
        session.startsAt <= now
      ) {
        throw conflict('SESSION_CLOSED', 'Cette session n’accepte plus d’inscriptions');
      }
      if (session.origin === 'PLAYER' && session.createdById === user.id) {
        throw conflict('ALREADY_JOINED', 'Vous organisez déjà cette session');
      }
      if (session.joinedCount >= session.capacity)
        throw conflict('SESSION_FULL', 'Cette session est complète');

      const existing = await tx.soloPlayer.findUnique({
        where: { sessionId_userId: { sessionId, userId: user.id } },
      });
      if (existing?.status === 'JOINED')
        throw conflict('ALREADY_JOINED', 'Vous participez déjà à cette session');

      const me = await tx.user.findUniqueOrThrow({
        where: { id: user.id },
        select: {
          level: true,
          preferredPosition: true,
          city: true,
          stats: { select: { reliabilityScore: true } },
        },
      });
      const profile: PlayerProfile = {
        id: user.id,
        level: me.level,
        preferredPosition: me.preferredPosition,
        city: me.city,
        reliabilityScore: me.stats?.reliabilityScore ?? 100,
      };
      const candidate: SessionCandidate = {
        id: session.id,
        startsAt: session.startsAt,
        level: session.level,
        city: session.venue.city,
        remaining: session.capacity - session.joinedCount,
        spots: session.capacity,
      };
      if (!this.matching.isCompatible(profile, candidate)) {
        throw conflict('LEVEL_INCOMPATIBLE', 'Votre niveau ne correspond pas à cette session');
      }
      if (await hasScheduleClash(tx, user.id, session, session.match?.id)) {
        throw conflict('SCHEDULE_CONFLICT', 'Vous avez déjà une activité sur ce créneau');
      }

      const joinedCount = session.joinedCount + 1;
      const full = joinedCount >= session.capacity;
      await tx.soloSession.update({
        where: { id: sessionId },
        data: { joinedCount, status: full ? 'FULL' : 'OPEN' },
      });
      await tx.soloPlayer.upsert({
        where: { sessionId_userId: { sessionId, userId: user.id } },
        create: { sessionId, userId: user.id },
        update: { status: 'JOINED', leftAt: null, joinedAt: now },
      });
      if (session.match) {
        await tx.matchParticipant.upsert({
          where: { matchId_userId: { matchId: session.match.id, userId: user.id } },
          create: { matchId: session.match.id, userId: user.id, side: 'NONE' },
          update: {},
        });
      }
      return { remaining: session.capacity - joinedCount, full };
    });

    await this.events.emit('solo.player_joined', {
      sessionId,
      userId: user.id,
      remaining: outcome.remaining,
    });
    if (outcome.full) await this.events.emit('solo.full', { sessionId });
    return this.getView(sessionId, user.id);
  }

  async leave(user: AuthUser, sessionId: string, now: Date = new Date()): Promise<void> {
    const remaining = await this.prisma.$transaction(async (tx) => {
      await lockSoloSession(tx, sessionId);
      const session = await tx.soloSession.findUnique({
        where: { id: sessionId },
        include: { match: { select: { id: true } } },
      });
      if (!session) throw notFound();
      const player = await tx.soloPlayer.findUnique({
        where: { sessionId_userId: { sessionId, userId: user.id } },
      });
      if (!player || player.status !== 'JOINED')
        throw Errors.notFound('Vous ne participez pas à cette session');
      if (
        session.status === 'CANCELLED' ||
        session.status === 'COMPLETED' ||
        session.startsAt <= now
      ) {
        throw conflict('SESSION_CLOSED', 'Cette session est terminée ou a déjà commencé');
      }

      await tx.soloPlayer.update({
        where: { id: player.id },
        data: { status: 'LEFT', leftAt: now },
      });
      const joinedCount = Math.max(0, session.joinedCount - 1);
      await tx.soloSession.update({
        where: { id: sessionId },
        data: { joinedCount, status: 'OPEN' },
      });
      if (session.match)
        await tx.matchParticipant.deleteMany({
          where: { matchId: session.match.id, userId: user.id },
        });
      return session.capacity - joinedCount;
    });
    await this.events.emit('solo.player_left', { sessionId, userId: user.id, remaining });
  }

  /** Annulation par l'hôte, ou par le personnel du complexe. La réservation de terrain reste acquise. */
  async cancel(
    user: AuthUser,
    sessionId: string,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<void> {
    const session = await this.prisma.soloSession.findUnique({
      where: { id: sessionId },
      select: { createdById: true, venueId: true, startsAt: true },
    });
    if (!session) throw notFound();
    let role = 'USER';
    if (session.createdById !== user.id) {
      role = (await this.policies.requireVenueRole(user, session.venueId, 'STAFF')).role; // sinon 404 : on ne confirme rien
    }
    if (session.startsAt <= now) throw conflict('SESSION_CLOSED', 'Cette session a déjà commencé');

    const outcome = await this.prisma.$transaction(async (tx) => {
      await lockSoloSession(tx, sessionId);
      const result = await cancelSoloSessionTx(tx, sessionId);
      if (result.solo.length === 0)
        throw conflict('SESSION_CLOSED', 'Cette session est déjà fermée');
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: role,
          action: 'solo.cancel',
          entityType: 'SoloSession',
          entityId: sessionId,
        },
        ctx,
        tx,
      );
      return result;
    });
    await emitOutcome(this.events, outcome);
  }

  // ───────────────────────── Consultation ─────────────────────────

  /** Sessions ouvertes, filtrées par lieu / date / heure / niveau / places, triées. Aucune donnée personnelle hors connexion. */
  async list(
    query: ListSoloSessionsQuery,
    viewer: AuthUser | null,
    now: Date = new Date(),
  ): Promise<PageOf<SoloSessionView>> {
    const offset = decodeOffset(query.cursor);
    const startsAt: Prisma.DateTimeFilter = { gt: now };
    if (query.date) {
      const minutes = query.time ? parseTime(query.time) : null;
      if (minutes !== null) {
        const center = localToUtc(query.date, minutes, PLATFORM_TZ);
        startsAt.gte = new Date(center.getTime() - query.window * 60_000);
        startsAt.lte = new Date(center.getTime() + query.window * 60_000);
      } else {
        startsAt.gte = localToUtc(query.date, 0, PLATFORM_TZ);
        startsAt.lt = localToUtc(query.date, 1440, PLATFORM_TZ);
      }
    }
    const rows = await this.prisma.soloSession.findMany({
      where: {
        status: 'OPEN',
        startsAt,
        venue: {
          status: 'APPROVED',
          ...(query.venue ? { slug: query.venue } : {}),
          ...(query.city ? { city: { equals: query.city, mode: 'insensitive' } } : {}),
        },
        ...(query.level ? { OR: [{ level: query.level }, { level: null }] } : {}),
      },
      include: soloInclude,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: MAX_CANDIDATES,
    });

    let ordered = rows.filter((r) => r.capacity - r.joinedCount >= (query.spots ?? 1));
    if (query.sort === 'spots') {
      // Les sessions les plus proches d'être complètes d'abord : c'est là qu'un joueur de plus change tout.
      ordered = [...ordered].sort(
        (a, b) =>
          a.capacity - a.joinedCount - (b.capacity - b.joinedCount) ||
          a.startsAt.getTime() - b.startsAt.getTime(),
      );
    } else if (query.sort === 'recommended' && viewer) {
      const profile = await this.profileOf(viewer.id);
      const byId = new Map(ordered.map((r) => [r.id, r]));
      const candidates: (SessionCandidate & { id: string })[] = ordered.map((r) => ({
        id: r.id,
        startsAt: r.startsAt,
        level: r.level,
        city: r.venue.city,
        remaining: r.capacity - r.joinedCount,
        spots: r.capacity,
      }));
      ordered = this.matching
        .rank(profile, candidates, now)
        .flatMap(({ session }) => byId.get(session.id) ?? []);
    }

    const page = ordered.slice(offset, offset + query.limit);
    return {
      items: page.map((r) => this.toView(r, viewer?.id ?? null)),
      nextCursor: ordered.length > offset + query.limit ? encodeOffset(offset + query.limit) : null,
    };
  }

  /** Mes sessions : celles que j'organise et celles où je suis inscrit. */
  async listMine(
    user: AuthUser,
    query: ListMyActivityQuery,
    now: Date = new Date(),
  ): Promise<PageOf<SoloSessionView>> {
    const offset = decodeOffset(query.cursor);
    const when: Prisma.SoloSessionWhereInput =
      query.when === 'upcoming'
        ? { endsAt: { gt: now } }
        : query.when === 'past'
          ? { endsAt: { lte: now } }
          : {};
    const rows = await this.prisma.soloSession.findMany({
      where: {
        AND: [
          {
            OR: [
              { origin: 'PLAYER', createdById: user.id },
              { players: { some: { userId: user.id, status: 'JOINED' } } },
            ],
          },
          when,
        ],
      },
      include: soloInclude,
      orderBy: [{ startsAt: query.when === 'upcoming' ? 'asc' : 'desc' }, { id: 'asc' }],
      skip: offset,
      take: query.limit + 1,
    });
    return {
      items: rows.slice(0, query.limit).map((r) => this.toView(r, user.id)),
      nextCursor: rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
    };
  }

  /** Une session ouverte est publique ; une session fermée n'est visible que des personnes concernées. */
  async getForViewer(id: string, viewer: AuthUser | null): Promise<SoloSessionView> {
    const row = await this.prisma.soloSession.findUnique({ where: { id }, include: soloInclude });
    if (!row) throw notFound();
    const publicVisible =
      (row.status === 'OPEN' || row.status === 'FULL') && (await this.isApproved(row.venueId));
    if (!publicVisible && !(await this.isConcerned(row, viewer))) throw notFound();
    return this.toView(row, viewer?.id ?? null);
  }

  // ───────────────────────── Internes ─────────────────────────

  private async isApproved(venueId: string): Promise<boolean> {
    return (await this.prisma.venue.count({ where: { id: venueId, status: 'APPROVED' } })) > 0;
  }

  private async isConcerned(row: SoloRow, viewer: AuthUser | null): Promise<boolean> {
    if (!viewer) return false;
    if (viewer.platformRole === 'ADMIN' || row.createdById === viewer.id) return true;
    if (row.players.some((p) => p.userId === viewer.id)) return true;
    return (
      (await this.prisma.venueStaff.count({ where: { venueId: row.venueId, userId: viewer.id } })) >
      0
    );
  }

  private async profileOf(userId: string): Promise<PlayerProfile> {
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        level: true,
        preferredPosition: true,
        city: true,
        stats: { select: { reliabilityScore: true } },
      },
    });
    return {
      id: userId,
      level: me.level,
      preferredPosition: me.preferredPosition,
      city: me.city,
      reliabilityScore: me.stats?.reliabilityScore ?? 100,
    };
  }

  private async getView(id: string, viewerId: string | null): Promise<SoloSessionView> {
    const row = await this.prisma.soloSession.findUniqueOrThrow({
      where: { id },
      include: soloInclude,
    });
    return this.toView(row, viewerId);
  }

  private toView(r: SoloRow, viewerId: string | null): SoloSessionView {
    const isHost = viewerId !== null && r.createdById === viewerId;
    const hostIsPlayer = r.origin === 'PLAYER';
    const nameOf = viewerId ? displayName : publicName;
    return {
      id: r.id,
      status: r.status,
      origin: r.origin,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      venue: r.venue,
      field: r.booking.field,
      spots: r.capacity,
      joinedCount: r.joinedCount,
      remaining: r.capacity - r.joinedCount,
      level: r.level,
      pricePerPlayerMinor: r.pricePerPlayerMinor,
      description: r.description,
      // Une session du complexe ne révèle pas l'identité du membre du personnel qui l'a ouverte.
      host: hostIsPlayer
        ? { id: r.createdBy.id, name: nameOf(r.createdBy), avatarUrl: r.createdBy.avatarUrl }
        : { id: r.venue.id, name: r.venue.name, avatarUrl: null },
      joined:
        viewerId !== null &&
        (r.players.some((p) => p.userId === viewerId) || (isHost && hostIsPlayer)),
      isHost,
      players: viewerId
        ? r.players.map((p) => ({
            id: p.user.id,
            name: displayName(p.user),
            avatarUrl: p.user.avatarUrl,
          }))
        : null,
      matchId: r.match?.id ?? null,
    };
  }
}
