import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlatformRole } from '@footfive/shared';
import type { FastifyRequest } from 'fastify';
import { Errors } from '../../common/errors/app-exception.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { TokenService } from '../../infra/security/token.service.js';
import { IS_PUBLIC_KEY, ROLES_KEY, VERIFIED_EMAIL_KEY } from './auth.decorators.js';

/**
 * Garde GLOBAL : authentifie chaque requête puis applique les rôles.
 *
 * Après la vérification de la signature du JWT, on relit la session et l'utilisateur EN BASE :
 *  - session révoquée (déconnexion, vol de jeton, mot de passe changé) → refusée immédiatement ;
 *  - compte bloqué ou supprimé → refusé immédiatement ;
 *  - rôle = valeur actuelle en base (une rétrogradation prend effet tout de suite).
 * Coût : une requête indexée par appel authentifié. C'est le prix d'une révocation instantanée.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    const bearer = extractBearer(request.headers.authorization);
    if (!bearer) {
      if (isPublic) return true;
      throw Errors.unauthenticated();
    }

    let claims;
    try {
      claims = await this.tokens.verifyAccessToken(bearer);
    } catch (error) {
      // Une route publique ignore un jeton invalide/expiré (ex. page d'accueil avec un vieux jeton).
      if (isPublic) return true;
      throw error;
    }

    const session = await this.prisma.session.findFirst({
      where: {
        familyId: claims.sessionId,
        userId: claims.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        user: { select: { id: true, status: true, platformRole: true, emailVerifiedAt: true } },
      },
    });
    if (!session) {
      if (isPublic) return true;
      throw Errors.tokenInvalid();
    }

    const { user } = session;
    if (user.status === 'DELETED') {
      if (isPublic) return true;
      throw Errors.tokenInvalid();
    }
    if (user.status === 'BLOCKED') throw Errors.accountBlocked();

    request.authUser = {
      id: user.id,
      platformRole: user.platformRole,
      sessionId: claims.sessionId,
      emailVerified: user.emailVerifiedAt !== null,
    };

    const roles = this.reflector.getAllAndOverride<PlatformRole[] | undefined>(ROLES_KEY, targets);
    if (roles && roles.length > 0 && !roles.includes(user.platformRole)) throw Errors.forbidden();

    const needsVerifiedEmail =
      this.reflector.getAllAndOverride<boolean | undefined>(VERIFIED_EMAIL_KEY, targets) === true;
    if (needsVerifiedEmail && !request.authUser.emailVerified) throw Errors.emailNotVerified();

    return true;
  }
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) return null;
  return token;
}
