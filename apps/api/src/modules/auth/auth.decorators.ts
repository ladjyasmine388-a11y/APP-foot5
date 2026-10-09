import { type ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { PlatformRole } from '@footfive/shared';
import type { FastifyRequest } from 'fastify';
import { Errors } from '../../common/errors/app-exception.js';
import type { AuthUser } from './auth.types.js';

export const IS_PUBLIC_KEY = 'auth:public';
export const ROLES_KEY = 'auth:roles';
export const VERIFIED_EMAIL_KEY = 'auth:verified-email';

/**
 * Par défaut TOUTES les routes exigent une authentification (liste fermée par défaut) :
 * oublier un décorateur ne peut donc jamais exposer une route par erreur. On ouvre explicitement avec @Public().
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** Réserve la route aux rôles globaux listés (ex. ADMIN). Les rôles contextuels (capitaine, staff) passent par les politiques. */
export const Roles = (...roles: PlatformRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/** Exige un email vérifié (ex. pour réserver). */
export const RequireVerifiedEmail = (): MethodDecorator & ClassDecorator =>
  SetMetadata(VERIFIED_EMAIL_KEY, true);

/** Utilisateur connecté s'il y en a un, `null` sinon : pour les routes @Public() dont la réponse dépend du visiteur. */
export const OptionalUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser | null => {
  const request = ctx.switchToHttp().getRequest<FastifyRequest>();
  return request.authUser ?? null;
});

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (!request.authUser) throw Errors.unauthenticated();
    return request.authUser;
  },
);
