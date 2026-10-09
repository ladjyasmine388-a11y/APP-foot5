import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RegisterInput, LoginInput } from '@footfive/shared';
import type { Prisma, User } from '../../generated/prisma/client.js';
import { Errors } from '../../common/errors/app-exception.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { ENV } from '../../infra/config/config.module.js';
import type { Env } from '../../infra/config/env.js';
import { PG_ERROR, isPgError } from '../../infra/database/pg-errors.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { Mailer, type MailMessage } from '../../infra/mail/mailer.js';
import { mailTemplates } from '../../infra/mail/templates.js';
import { generateOpaqueToken, hashToken } from '../../infra/security/crypto.js';
import { PasswordService } from '../../infra/security/password.service.js';
import { TokenService } from '../../infra/security/token.service.js';
import { AuditService } from '../audit/audit.service.js';

const VERIFY_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_PASSWORD_TTL_MS = 60 * 60 * 1000;
/**
 * Deux onglets qui rafraîchissent en même temps présentent le MÊME refresh token : le second arrive
 * quelques millisecondes après la rotation. Dans cette fenêtre on le traite comme une course légitime
 * (le client réessaie avec le nouveau cookie) et non comme un vol de jeton.
 */
const REFRESH_GRACE_MS = 10_000;

export interface IssuedSession {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mailer: Mailer,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ───────────────────────── Inscription / connexion ─────────────────────────

  async register(input: RegisterInput, ctx: RequestContext): Promise<IssuedSession> {
    const passwordHash = await this.passwords.hash(input.password);

    let user: User;
    try {
      user = await this.prisma.user.create({
        data: {
          email: input.email,
          phone: input.phone,
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          city: input.city,
          level: input.level,
          preferredPosition: input.preferredPosition,
          birthDate: input.birthDate ? new Date(`${input.birthDate}T00:00:00.000Z`) : undefined,
          locale: input.locale,
          // Le rôle, le statut et la vérification ne viennent JAMAIS de la requête : valeurs par défaut du schéma.
          stats: { create: {} },
        },
      });
    } catch (error) {
      // L'unicité est garantie par la base : pas de course entre deux inscriptions simultanées.
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) throw Errors.emailTaken();
      throw error;
    }

    await this.sendVerificationEmail(user);
    return this.issueSession(user, ctx);
  }

  async login(input: LoginInput, ctx: RequestContext): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });

    if (!user || !user.passwordHash || user.status === 'DELETED') {
      // Même durée de traitement que pour un vrai compte, même message : pas d'énumération des comptes.
      await this.passwords.verifyAgainstDummy(input.password);
      throw Errors.invalidCredentials();
    }

    const valid = await this.passwords.verify(user.passwordHash, input.password);
    if (!valid) throw Errors.invalidCredentials();

    // Le statut « suspendu » n'est révélé qu'à qui connaît le bon mot de passe.
    if (user.status === 'BLOCKED') throw Errors.accountBlocked();

    return this.issueSession(user, ctx);
  }

  // ───────────────────────── Sessions et rotation ─────────────────────────

  /**
   * Échange un refresh token contre une nouvelle paire de jetons (rotation : l'ancien devient inutilisable).
   * Présenter un jeton DÉJÀ utilisé signale un vol probable : toute la session est alors révoquée.
   */
  async refresh(refreshToken: string, ctx: RequestContext): Promise<IssuedSession> {
    const now = new Date();
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hashToken(refreshToken) },
      include: { user: true },
    });
    if (!session) throw Errors.tokenInvalid();

    if (session.revokedAt) {
      if (session.revokedReason === 'rotated') {
        const age = now.getTime() - session.revokedAt.getTime();
        if (age < REFRESH_GRACE_MS) throw Errors.refreshConflict();

        // Jeton réutilisé bien après sa rotation : quelqu'un d'autre le détient. On coupe toute la famille.
        await this.revokeFamily(session.familyId, 'reuse_detected');
        await this.audit.record(
          {
            actorId: session.userId,
            actorRole: 'USER',
            action: 'auth.refresh_reuse_detected',
            entityType: 'User',
            entityId: session.userId,
          },
          ctx,
        );
        throw Errors.refreshReused();
      }
      throw Errors.tokenInvalid();
    }
    if (session.expiresAt <= now) throw Errors.tokenExpired();
    if (session.user.status === 'DELETED') throw Errors.tokenInvalid();
    if (session.user.status === 'BLOCKED') throw Errors.accountBlocked();

    // Revendication atomique : si deux requêtes arrivent ensemble, une seule gagne la rotation.
    const claimed = await this.prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'rotated', lastUsedAt: now },
    });
    if (claimed.count === 0) throw Errors.refreshConflict();

    return this.issueSession(session.user, ctx, session.familyId);
  }

  /** Révoque la session désignée par ce refresh token. Idempotent : un jeton inconnu n'est pas une erreur. */
  async logout(refreshToken: string): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hashToken(refreshToken) },
      select: { familyId: true },
    });
    if (session) await this.revokeFamily(session.familyId, 'logout');
  }

  async logoutAll(userId: string): Promise<void> {
    await this.revokeAllSessions(userId, 'logout_all');
  }

  // ───────────────────────── Vérification d'email ─────────────────────────

  async verifyEmail(token: string): Promise<void> {
    const record = await this.prisma.emailToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (
      !record ||
      record.type !== 'VERIFY_EMAIL' ||
      record.usedAt !== null ||
      record.expiresAt <= new Date()
    ) {
      throw Errors.tokenInvalid();
    }

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.emailToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) throw Errors.tokenInvalid(); // jeton utilisé entre-temps
      await tx.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } });
    });
  }

  async resendVerification(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.emailVerifiedAt) return; // déjà vérifié : rien à faire
    await this.sendVerificationEmail(user);
  }

  // ───────────────────────── Mot de passe oublié ─────────────────────────

  /**
   * Répond TOUJOURS de la même façon, que l'email existe ou non (le contrôleur renvoie 202) :
   * on ne révèle jamais quels comptes existent. L'envoi est lancé sans attendre pour que la durée
   * de réponse ne trahisse pas non plus l'existence du compte.
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE') return;

    const token = await this.createEmailToken(user.id, 'RESET_PASSWORD', RESET_PASSWORD_TTL_MS);
    void this.safeSend(
      mailTemplates.resetPassword(user.email, user.locale, {
        name: user.firstName,
        link: `${this.env.WEB_ORIGIN}/reset-password?token=${token}`,
      }),
    );
  }

  async resetPassword(token: string, newPassword: string, ctx: RequestContext): Promise<void> {
    const record = await this.prisma.emailToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (
      !record ||
      record.type !== 'RESET_PASSWORD' ||
      record.usedAt !== null ||
      record.expiresAt <= new Date() ||
      record.user.status !== 'ACTIVE'
    ) {
      throw Errors.tokenInvalid();
    }

    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.emailToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) throw Errors.tokenInvalid(); // lien déjà utilisé : usage unique
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
      // Quelqu'un qui connaissait l'ancien mot de passe ne doit plus avoir de session ouverte.
      await tx.session.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'password_reset' },
      });
      await this.audit.record(
        {
          actorId: record.userId,
          actorRole: 'USER',
          action: 'auth.password_reset',
          entityType: 'User',
          entityId: record.userId,
        },
        ctx,
        tx,
      );
    });

    void this.safeSend(
      mailTemplates.passwordChanged(record.user.email, record.user.locale, {
        name: record.user.firstName,
      }),
    );
  }

  // ───────────────────────── Primitives partagées ─────────────────────────

  /** Crée une session (ou en poursuit une : même `familyId` après rotation) et ses jetons. */
  async issueSession(
    user: User,
    ctx: RequestContext,
    familyId: string = randomUUID(),
  ): Promise<IssuedSession> {
    const refreshToken = generateOpaqueToken();
    const now = new Date();
    await this.prisma.session.create({
      data: {
        userId: user.id,
        familyId,
        refreshTokenHash: hashToken(refreshToken),
        userAgent: ctx.userAgent,
        ip: ctx.ip,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + this.env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    const accessToken = await this.tokens.signAccessToken({ userId: user.id, sessionId: familyId });
    return { user, accessToken, refreshToken, expiresIn: this.tokens.accessTtlSeconds };
  }

  revokeFamily(familyId: string, reason: string, tx: Prisma.TransactionClient = this.prisma) {
    return tx.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Révoque toutes les sessions d'un utilisateur, sauf éventuellement la courante. */
  revokeAllSessions(
    userId: string,
    reason: string,
    exceptFamilyId?: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    return tx.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptFamilyId ? { familyId: { not: exceptFamilyId } } : {}),
      },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  private async sendVerificationEmail(user: User): Promise<void> {
    const token = await this.createEmailToken(user.id, 'VERIFY_EMAIL', VERIFY_EMAIL_TTL_MS);
    await this.safeSend(
      mailTemplates.verifyEmail(user.email, user.locale, {
        name: user.firstName,
        link: `${this.env.WEB_ORIGIN}/verify-email?token=${token}`,
      }),
    );
  }

  /** Crée un jeton à usage unique et invalide les précédents du même type (un seul lien valide à la fois). */
  private async createEmailToken(
    userId: string,
    type: 'VERIFY_EMAIL' | 'RESET_PASSWORD',
    ttlMs: number,
  ): Promise<string> {
    const token = generateOpaqueToken();
    await this.prisma.$transaction([
      this.prisma.emailToken.deleteMany({ where: { userId, type, usedAt: null } }),
      this.prisma.emailToken.create({
        data: {
          userId,
          type,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + ttlMs),
        },
      }),
    ]);
    return token;
  }

  /** Un échec d'envoi d'email ne doit jamais faire échouer l'action de l'utilisateur : on le journalise. */
  private async safeSend(message: MailMessage): Promise<void> {
    try {
      await this.mailer.send(message);
    } catch (error) {
      this.logger.error(
        `Échec d'envoi d'email (${message.subject})`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
