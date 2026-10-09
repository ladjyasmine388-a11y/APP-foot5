import { Injectable } from '@nestjs/common';
import type { ChangePasswordInput, SessionInfo, UpdateProfileInput } from '@footfive/shared';
import type { Prisma, User } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { Mailer } from '../../infra/mail/mailer.js';
import { mailTemplates } from '../../infra/mail/templates.js';
import { PasswordService } from '../../infra/security/password.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly mailer: Mailer,
  ) {}

  async getById(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Errors.notFound();
    return user;
  }

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<User> {
    const { birthDate, preferences, ...rest } = input;
    const data: Prisma.UserUpdateInput = { ...rest };
    if (birthDate !== undefined) {
      data.birthDate = birthDate === null ? null : new Date(`${birthDate}T00:00:00.000Z`);
    }
    if (preferences !== undefined) data.preferences = preferences;
    return this.prisma.user.update({ where: { id: userId }, data });
  }

  async changePassword(
    userId: string,
    currentSessionId: string,
    input: ChangePasswordInput,
    ctx: RequestContext,
  ): Promise<void> {
    const user = await this.getById(userId);
    if (
      !user.passwordHash ||
      !(await this.passwords.verify(user.passwordHash, input.currentPassword))
    ) {
      throw Errors.invalidCurrentPassword();
    }

    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      // Les AUTRES appareils sont déconnectés ; celui qui vient de changer le mot de passe reste connecté.
      await this.auth.revokeAllSessions(userId, 'password_change', currentSessionId, tx);
      await this.audit.record(
        {
          actorId: userId,
          actorRole: 'USER',
          action: 'auth.password_change',
          entityType: 'User',
          entityId: userId,
        },
        ctx,
        tx,
      );
    });

    // Prévenir par email : si ce n'était pas l'utilisateur, il le saura immédiatement.
    void this.mailer
      .send(mailTemplates.passwordChanged(user.email, user.locale, { name: user.firstName }))
      .catch(() => undefined);
  }

  async listSessions(userId: string, currentSessionId: string): Promise<SessionInfo[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
    });
    // Une ligne active par appareil : `id` = identifiant stable de la session (famille), pas du refresh token.
    return rows.map((row) => ({
      id: row.familyId,
      userAgent: row.userAgent,
      ip: row.ip,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      current: row.familyId === currentSessionId,
    }));
  }

  async revokeSession(userId: string, familyId: string): Promise<void> {
    // Le filtre sur userId empêche de révoquer la session de quelqu'un d'autre (pas d'IDOR).
    const result = await this.prisma.session.updateMany({
      where: { familyId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'revoked_by_user' },
    });
    if (result.count === 0) throw Errors.notFound('Session introuvable');
  }

  /**
   * Suppression de compte = ANONYMISATION. Les données personnelles sont effacées, mais la ligne est conservée :
   * les réservations passées restent nécessaires à la comptabilité des complexes et de la plateforme.
   */
  async deleteAccount(userId: string, password: string, ctx: RequestContext): Promise<void> {
    const user = await this.getById(userId);
    if (!user.passwordHash || !(await this.passwords.verify(user.passwordHash, password))) {
      throw Errors.invalidCurrentPassword();
    }

    const now = new Date();
    const [upcomingBookings, upcomingSolo, ledTeam] = await Promise.all([
      this.prisma.booking.count({
        where: {
          userId,
          bookingType: { not: 'BLOCK' },
          status: { in: ['PENDING_PAYMENT', 'CONFIRMED'] },
          endsAt: { gt: now },
        },
      }),
      this.prisma.soloPlayer.count({
        where: {
          userId,
          status: 'JOINED',
          session: { startsAt: { gt: now }, status: { in: ['OPEN', 'FULL', 'CONFIRMED'] } },
        },
      }),
      this.prisma.teamMember.findFirst({
        where: {
          userId,
          role: 'CAPTAIN',
          leftAt: null,
          team: { deletedAt: null, members: { some: { userId: { not: userId }, leftAt: null } } },
        },
        select: { id: true },
      }),
    ]);

    if (upcomingBookings > 0 || upcomingSolo > 0) {
      throw new AppException(
        'ACCOUNT_HAS_UPCOMING_BOOKINGS',
        409,
        'Annulez vos réservations et sessions à venir avant de supprimer votre compte',
      );
    }
    if (ledTeam) {
      throw new AppException(
        'ACCOUNT_IS_TEAM_CAPTAIN',
        409,
        'Transférez la capitainerie de votre équipe avant de supprimer votre compte',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          // `.invalid` est un TLD réservé (RFC 2606) : l'adresse ne peut jamais exister, et l'email d'origine est libéré.
          email: `deleted-${userId}@deleted.invalid`,
          phone: '',
          firstName: 'Utilisateur',
          lastName: 'supprimé',
          passwordHash: null,
          birthDate: null,
          avatarUrl: null,
          city: null,
          preferences: {},
          status: 'DELETED',
          emailVerifiedAt: null,
          anonymizedAt: now,
        },
      });
      await tx.session.deleteMany({ where: { userId } });
      await tx.emailToken.deleteMany({ where: { userId } });
      await tx.authIdentity.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { userId } });
      await tx.teamMember.updateMany({ where: { userId, leftAt: null }, data: { leftAt: now } });
      // Équipes dont il était le seul membre : archivées.
      await tx.team.updateMany({
        where: { captainId: userId, deletedAt: null },
        data: { deletedAt: now },
      });
      await this.audit.record(
        {
          actorId: userId,
          actorRole: 'USER',
          action: 'user.delete',
          entityType: 'User',
          entityId: userId,
        },
        ctx,
        tx,
      );
    });
  }
}
