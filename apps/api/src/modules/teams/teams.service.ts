import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type CreateTeamInput,
  type InviteToTeamInput,
  type ListTeamsQuery,
  type PageOf,
  type TeamInvitationAdminView,
  type TeamInvitationView,
  type TeamMemberView,
  type TeamView,
  type TransferCaptaincyInput,
  type UpdateTeamInput,
  TEAM_INVITATION_TTL_DAYS,
  TEAM_MAX_CAPTAIN_OF,
  TEAM_MAX_MEMBERS,
  TEAM_MAX_PENDING_INVITATIONS,
} from '@footfive/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { ENV } from '../../infra/config/config.module.js';
import type { Env } from '../../infra/config/env.js';
import { PG_ERROR, isPgError } from '../../infra/database/pg-errors.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { DomainEvents } from '../../infra/events/domain-events.js';
import { Mailer } from '../../infra/mail/mailer.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';

const conflict = (
  code: 'CONFLICT' | 'TEAM_FULL' | 'TEAM_LIMIT_REACHED' | 'ALREADY_JOINED',
  message: string,
): AppException => new AppException(code, HttpStatus.CONFLICT, message);
const notCaptain = (): AppException =>
  new AppException('NOT_CAPTAIN', HttpStatus.FORBIDDEN, 'Réservé au capitaine de l’équipe');

/** Nom affichable : jamais d'identité d'un compte supprimé. */
export function displayName(user: {
  firstName: string;
  lastName: string;
  status?: string;
}): string {
  return user.status === 'DELETED' ? 'Utilisateur supprimé' : `${user.firstName} ${user.lastName}`;
}

const personSelect = {
  id: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  status: true,
} as const;

/** Offset opaque pour les listes (même convention que le reste de l'API). */
export function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}
export function decodeOffset(cursor: string | undefined): number {
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

@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ───────────────────────── Équipes ─────────────────────────

  async create(user: AuthUser, input: CreateTeamInput, ctx: RequestContext): Promise<TeamView> {
    const led = await this.prisma.teamMember.count({
      where: { userId: user.id, role: 'CAPTAIN', leftAt: null, team: { deletedAt: null } },
    });
    if (led >= TEAM_MAX_CAPTAIN_OF) {
      throw conflict('TEAM_LIMIT_REACHED', `Vous dirigez déjà ${TEAM_MAX_CAPTAIN_OF} équipes`);
    }

    try {
      const team = await this.prisma.$transaction(async (tx) => {
        const created = await tx.team.create({
          data: {
            name: input.name,
            city: input.city,
            level: input.level,
            description: input.description,
            captainId: user.id,
            members: { create: { userId: user.id, role: 'CAPTAIN' } },
          },
        });
        await this.audit.record(
          {
            actorId: user.id,
            actorRole: 'USER',
            action: 'team.create',
            entityType: 'Team',
            entityId: created.id,
            after: { name: created.name },
          },
          ctx,
          tx,
        );
        return created;
      });
      return this.getView(team.id, user.id);
    } catch (error) {
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION))
        throw conflict('CONFLICT', 'Une équipe porte déjà ce nom');
      throw error;
    }
  }

  async get(id: string, viewerId: string | null): Promise<TeamView> {
    return this.getView(id, viewerId);
  }

  async list(query: ListTeamsQuery, viewerId: string | null): Promise<PageOf<TeamView>> {
    const offset = decodeOffset(query.cursor);
    const where: Prisma.TeamWhereInput = {
      deletedAt: null,
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
      ...(query.city ? { city: { equals: query.city, mode: 'insensitive' } } : {}),
      ...(query.level ? { level: query.level } : {}),
    };
    const rows = await this.prisma.team.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: offset,
      take: query.limit + 1,
      include: this.teamInclude(),
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((t) => this.toView(t, viewerId)),
      nextCursor: rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
    };
  }

  async listMine(user: AuthUser): Promise<TeamView[]> {
    const rows = await this.prisma.team.findMany({
      where: { deletedAt: null, members: { some: { userId: user.id, leftAt: null } } },
      orderBy: { name: 'asc' },
      include: this.teamInclude(),
    });
    return rows.map((t) => this.toView(t, user.id));
  }

  async update(
    user: AuthUser,
    teamId: string,
    input: UpdateTeamInput,
    ctx: RequestContext,
  ): Promise<TeamView> {
    await this.requireCaptain(user.id, teamId);
    try {
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.team.findUniqueOrThrow({ where: { id: teamId } });
        await tx.team.update({ where: { id: teamId }, data: input });
        await this.audit.record(
          {
            actorId: user.id,
            actorRole: 'USER',
            action: 'team.update',
            entityType: 'Team',
            entityId: teamId,
            before: Object.fromEntries(
              Object.keys(input).map((k) => [k, (before as Record<string, unknown>)[k] ?? null]),
            ) as Prisma.InputJsonValue,
            after: input as Prisma.InputJsonValue,
          },
          ctx,
          tx,
        );
      });
    } catch (error) {
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION))
        throw conflict('CONFLICT', 'Une équipe porte déjà ce nom');
      throw error;
    }
    return this.getView(teamId, user.id);
  }

  /** Dissolution : refusée tant que l'équipe a une annonce ou un match à venir (les autres équipes comptent dessus). */
  async delete(
    user: AuthUser,
    teamId: string,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<void> {
    await this.requireCaptain(user.id, teamId);
    const [listings, matches] = await Promise.all([
      this.prisma.opponentListing.count({
        where: { teamId, status: { in: ['OPEN', 'ACCEPTED'] }, startsAt: { gt: now } },
      }),
      this.prisma.match.count({
        where: {
          status: 'SCHEDULED',
          startsAt: { gt: now },
          OR: [{ teamAId: teamId }, { teamBId: teamId }],
        },
      }),
    ]);
    if (listings + matches > 0) {
      throw conflict('CONFLICT', 'Annulez d’abord les annonces et matchs à venir de cette équipe');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.team.update({ where: { id: teamId }, data: { deletedAt: now } });
      await tx.teamMember.updateMany({ where: { teamId, leftAt: null }, data: { leftAt: now } });
      await tx.teamInvitation.updateMany({
        where: { teamId, status: 'PENDING' },
        data: { status: 'CANCELLED', respondedAt: now },
      });
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: 'USER',
          action: 'team.delete',
          entityType: 'Team',
          entityId: teamId,
        },
        ctx,
        tx,
      );
    });
  }

  // ───────────────────────── Membres ─────────────────────────

  async listMembers(user: AuthUser, teamId: string): Promise<TeamMemberView[]> {
    await this.requireTeam(teamId);
    await this.requireMember(user, teamId);
    const rows = await this.prisma.teamMember.findMany({
      where: { teamId, leftAt: null },
      include: { user: { select: { ...personSelect, level: true, preferredPosition: true } } },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    });
    return rows.map((m) => ({
      id: m.user.id,
      name: displayName(m.user),
      avatarUrl: m.user.avatarUrl,
      role: m.role,
      level: m.user.level,
      preferredPosition: m.user.preferredPosition,
      joinedAt: m.joinedAt.toISOString(),
    }));
  }

  async removeMember(
    user: AuthUser,
    teamId: string,
    memberId: string,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<void> {
    await this.requireCaptain(user.id, teamId);
    if (memberId === user.id) {
      throw conflict(
        'CONFLICT',
        'Le capitaine ne peut pas se retirer : transférez d’abord la capitainerie',
      );
    }
    const removed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.teamMember.updateMany({
        where: { teamId, userId: memberId, leftAt: null },
        data: { leftAt: now },
      });
      if (result.count > 0) {
        await this.audit.record(
          {
            actorId: user.id,
            actorRole: 'USER',
            action: 'team.remove_member',
            entityType: 'Team',
            entityId: teamId,
            after: { userId: memberId },
          },
          ctx,
          tx,
        );
      }
      return result.count;
    });
    if (removed === 0) throw Errors.notFound('Ce joueur n’est pas membre de l’équipe');
    await this.events.emit('team.member_removed', { teamId, userId: memberId });
  }

  async leave(
    user: AuthUser,
    teamId: string,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<void> {
    await this.requireTeam(teamId);
    const membership = await this.requireMember(user, teamId);
    if (membership.role === 'CAPTAIN') {
      const others = await this.prisma.teamMember.count({
        where: { teamId, leftAt: null, userId: { not: user.id } },
      });
      if (others > 0)
        throw conflict('CONFLICT', 'Transférez la capitainerie avant de quitter l’équipe');
      await this.delete(user, teamId, ctx, now); // dernier membre : l'équipe est dissoute
      return;
    }
    await this.prisma.teamMember.updateMany({
      where: { teamId, userId: user.id, leftAt: null },
      data: { leftAt: now },
    });
    await this.events.emit('team.member_removed', { teamId, userId: user.id });
  }

  async transferCaptaincy(
    user: AuthUser,
    teamId: string,
    input: TransferCaptaincyInput,
    ctx: RequestContext,
  ): Promise<TeamView> {
    await this.requireCaptain(user.id, teamId);
    if (input.userId === user.id) throw conflict('CONFLICT', 'Vous êtes déjà capitaine');

    await this.prisma.$transaction(async (tx) => {
      const target = await tx.teamMember.findFirst({
        where: { teamId, userId: input.userId, leftAt: null },
      });
      if (!target) throw Errors.notFound('Ce joueur n’est pas membre de l’équipe');
      // Ordre imposé par l'index unique « un seul capitaine actif » : on retire d'abord le rôle à l'ancien.
      await tx.teamMember.updateMany({
        where: { teamId, userId: user.id, leftAt: null },
        data: { role: 'MEMBER' },
      });
      await tx.teamMember.update({ where: { id: target.id }, data: { role: 'CAPTAIN' } });
      await tx.team.update({ where: { id: teamId }, data: { captainId: input.userId } });
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: 'USER',
          action: 'team.transfer_captaincy',
          entityType: 'Team',
          entityId: teamId,
          before: { captainId: user.id },
          after: { captainId: input.userId },
        },
        ctx,
        tx,
      );
    });
    return this.getView(teamId, user.id);
  }

  // ───────────────────────── Invitations ─────────────────────────

  async invite(
    user: AuthUser,
    teamId: string,
    input: InviteToTeamInput,
    now: Date = new Date(),
  ): Promise<TeamInvitationAdminView> {
    await this.requireCaptain(user.id, teamId);
    const team = await this.prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { name: true },
    });

    // Une personne invitée par son email est reliée à son compte s'il existe déjà.
    const invitee = await this.prisma.user.findFirst({
      where: input.userId ? { id: input.userId } : { email: input.email },
      select: {
        id: true,
        email: true,
        locale: true,
        firstName: true,
        lastName: true,
        status: true,
      },
    });
    if (input.userId && !invitee) throw Errors.notFound('Joueur introuvable');
    if (invitee && invitee.status !== 'ACTIVE') throw Errors.notFound('Joueur introuvable');
    if (invitee?.id === user.id)
      throw conflict('CONFLICT', 'Vous ne pouvez pas vous inviter vous-même');

    const [members, pending] = await Promise.all([
      this.prisma.teamMember.count({ where: { teamId, leftAt: null } }),
      this.prisma.teamInvitation.count({
        where: { teamId, status: 'PENDING', expiresAt: { gt: now } },
      }),
    ]);
    if (members >= TEAM_MAX_MEMBERS)
      throw conflict('TEAM_FULL', `Une équipe compte ${TEAM_MAX_MEMBERS} joueurs au maximum`);
    if (pending >= TEAM_MAX_PENDING_INVITATIONS)
      throw conflict('CONFLICT', 'Trop d’invitations en attente');

    if (invitee) {
      const already = await this.prisma.teamMember.count({
        where: { teamId, userId: invitee.id, leftAt: null },
      });
      if (already > 0) throw conflict('ALREADY_JOINED', 'Ce joueur fait déjà partie de l’équipe');
    }

    try {
      const invitation = await this.prisma.teamInvitation.create({
        data: {
          teamId,
          inviterId: user.id,
          inviteeId: invitee?.id ?? null,
          inviteeEmail: invitee ? null : (input.email ?? null),
          expiresAt: new Date(now.getTime() + TEAM_INVITATION_TTL_DAYS * 86_400_000),
        },
        include: this.invitationInclude(),
      });

      // Compte inexistant : on prévient par email (le lien mène à l'inscription, l'invitation les attend ensuite).
      if (!invitee && input.email) {
        void this.mailer
          .send({
            to: input.email,
            subject: `${team.name} vous invite à rejoindre son équipe — Foot Five`,
            text: `Bonjour,\n\nL'équipe « ${team.name} » vous invite à la rejoindre sur Foot Five.\nCréez votre compte avec cette adresse email : ${this.env.WEB_ORIGIN}/register\nL'invitation est valable ${TEAM_INVITATION_TTL_DAYS} jours.`,
          })
          .catch(() => undefined);
      }
      await this.events.emit('team.invitation_created', {
        invitationId: invitation.id,
        teamId,
        inviteeId: invitation.inviteeId,
        inviteeEmail: invitation.inviteeEmail,
      });
      return this.toAdminInvitation(invitation);
    } catch (error) {
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION))
        throw conflict('CONFLICT', 'Une invitation est déjà en attente pour ce joueur');
      throw error;
    }
  }

  async listTeamInvitations(
    user: AuthUser,
    teamId: string,
    now: Date = new Date(),
  ): Promise<TeamInvitationAdminView[]> {
    await this.requireCaptain(user.id, teamId);
    const rows = await this.prisma.teamInvitation.findMany({
      where: { teamId, status: 'PENDING', expiresAt: { gt: now } },
      include: this.invitationInclude(),
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toAdminInvitation(r));
  }

  async cancelInvitation(
    user: AuthUser,
    teamId: string,
    invitationId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.requireCaptain(user.id, teamId);
    const result = await this.prisma.teamInvitation.updateMany({
      where: { id: invitationId, teamId, status: 'PENDING' },
      data: { status: 'CANCELLED', respondedAt: now },
    });
    if (result.count === 0) throw Errors.notFound('Invitation introuvable');
  }

  /** Mes invitations en attente : adressées à mon compte, ou à mon adresse email VÉRIFIÉE. */
  async listMyInvitations(user: AuthUser, now: Date = new Date()): Promise<TeamInvitationView[]> {
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { email: true, emailVerifiedAt: true },
    });
    const rows = await this.prisma.teamInvitation.findMany({
      where: {
        status: 'PENDING',
        expiresAt: { gt: now },
        team: { deletedAt: null },
        OR: [{ inviteeId: user.id }, ...(me.emailVerifiedAt ? [{ inviteeEmail: me.email }] : [])],
      },
      include: this.invitationInclude(),
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toInvitation(r));
  }

  async acceptInvitation(
    user: AuthUser,
    invitationId: string,
    now: Date = new Date(),
  ): Promise<TeamView> {
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { email: true, emailVerifiedAt: true },
    });
    let teamId = '';

    try {
      await this.prisma.$transaction(async (tx) => {
        // Revendication atomique : seule la bonne personne, une seule fois, avant l'expiration.
        const claimed = await tx.teamInvitation.updateManyAndReturn({
          where: {
            id: invitationId,
            status: 'PENDING',
            expiresAt: { gt: now },
            OR: [
              { inviteeId: user.id },
              ...(me.emailVerifiedAt ? [{ inviteeEmail: me.email }] : []),
            ],
          },
          data: { status: 'ACCEPTED', respondedAt: now, inviteeId: user.id },
          select: { teamId: true },
        });
        const [invitation] = claimed;
        if (!invitation) throw Errors.notFound('Invitation introuvable ou expirée');
        teamId = invitation.teamId;

        const team = await tx.team.findFirst({
          where: { id: teamId, deletedAt: null },
          select: { id: true },
        });
        if (!team) throw Errors.notFound('Cette équipe n’existe plus');
        const members = await tx.teamMember.count({ where: { teamId, leftAt: null } });
        if (members >= TEAM_MAX_MEMBERS) throw conflict('TEAM_FULL', 'Cette équipe est complète');
        const already = await tx.teamMember.count({
          where: { teamId, userId: user.id, leftAt: null },
        });
        if (already > 0)
          throw conflict('ALREADY_JOINED', 'Vous faites déjà partie de cette équipe');
        await tx.teamMember.create({ data: { teamId, userId: user.id, role: 'MEMBER' } });
      });
    } catch (error) {
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION))
        throw conflict('ALREADY_JOINED', 'Vous faites déjà partie de cette équipe');
      throw error;
    }
    await this.events.emit('team.invitation_accepted', { teamId, userId: user.id });
    return this.getView(teamId, user.id);
  }

  async declineInvitation(
    user: AuthUser,
    invitationId: string,
    now: Date = new Date(),
  ): Promise<void> {
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { email: true, emailVerifiedAt: true },
    });
    const result = await this.prisma.teamInvitation.updateMany({
      where: {
        id: invitationId,
        status: 'PENDING',
        OR: [{ inviteeId: user.id }, ...(me.emailVerifiedAt ? [{ inviteeEmail: me.email }] : [])],
      },
      data: { status: 'DECLINED', respondedAt: now },
    });
    if (result.count === 0) throw Errors.notFound('Invitation introuvable');
  }

  // ───────────────────────── Accès ─────────────────────────

  /** Capitaine ACTIF de l'équipe, sinon : 404 si l'équipe n'existe pas, 403 NOT_CAPTAIN sinon. */
  async requireCaptain(userId: string, teamId: string) {
    await this.requireTeam(teamId);
    const member = await this.prisma.teamMember.findFirst({
      where: { teamId, userId, leftAt: null },
    });
    if (!member || member.role !== 'CAPTAIN') throw notCaptain();
    return member;
  }

  async requireMember(user: AuthUser, teamId: string) {
    const member = await this.prisma.teamMember.findFirst({
      where: { teamId, userId: user.id, leftAt: null },
    });
    if (!member) throw Errors.forbidden('Réservé aux membres de l’équipe');
    return member;
  }

  private async requireTeam(teamId: string) {
    const team = await this.prisma.team.findFirst({
      where: { id: teamId, deletedAt: null },
      select: { id: true },
    });
    if (!team) throw Errors.notFound('Équipe introuvable');
    return team;
  }

  // ───────────────────────── Vues ─────────────────────────

  private teamInclude() {
    return {
      captain: { select: personSelect },
      _count: { select: { members: { where: { leftAt: null } } } },
      members: { where: { leftAt: null }, select: { userId: true, role: true } },
    } satisfies Prisma.TeamInclude;
  }

  private async getView(teamId: string, viewerId: string | null): Promise<TeamView> {
    const team = await this.prisma.team.findFirst({
      where: { id: teamId, deletedAt: null },
      include: this.teamInclude(),
    });
    if (!team) throw Errors.notFound('Équipe introuvable');
    return this.toView(team, viewerId);
  }

  private toView(
    team: Prisma.TeamGetPayload<{ include: ReturnType<TeamsService['teamInclude']> }>,
    viewerId: string | null,
  ): TeamView {
    const mine = viewerId ? team.members.find((m) => m.userId === viewerId) : undefined;
    return {
      id: team.id,
      name: team.name,
      logoUrl: team.logoUrl,
      level: team.level,
      city: team.city,
      description: team.description,
      captain: {
        id: team.captain.id,
        name: displayName(team.captain),
        avatarUrl: team.captain.avatarUrl,
      },
      memberCount: team._count.members,
      myRole: mine?.role ?? null,
      createdAt: team.createdAt.toISOString(),
    };
  }

  private invitationInclude() {
    return {
      team: { select: { id: true, name: true, logoUrl: true } },
      inviter: { select: personSelect },
      invitee: { select: personSelect },
    } satisfies Prisma.TeamInvitationInclude;
  }

  private toInvitation(
    row: Prisma.TeamInvitationGetPayload<{
      include: ReturnType<TeamsService['invitationInclude']>;
    }>,
  ): TeamInvitationView {
    return {
      id: row.id,
      team: row.team,
      invitedBy: displayName(row.inviter),
      status: row.status,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toAdminInvitation(
    row: Prisma.TeamInvitationGetPayload<{
      include: ReturnType<TeamsService['invitationInclude']>;
    }>,
  ): TeamInvitationAdminView {
    return {
      ...this.toInvitation(row),
      invitee: row.invitee ? displayName(row.invitee) : (row.inviteeEmail ?? ''),
    };
  }
}
