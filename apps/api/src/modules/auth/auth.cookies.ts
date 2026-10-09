import type { FastifyReply, FastifyRequest } from 'fastify';
import { Errors } from '../../common/errors/app-exception.js';
import type { Env } from '../../infra/config/env.js';

export const REFRESH_COOKIE = 'ff_refresh';
/** Le cookie n'est envoyé qu'aux routes d'authentification : jamais aux autres endpoints de l'API. */
const REFRESH_COOKIE_PATH = '/api/v1/auth';

/**
 * Refresh token du web : cookie httpOnly (illisible par JavaScript → un XSS ne peut pas le voler).
 * SameSite=Lax + contrôle de l'en-tête Origin (voir assertAllowedOrigin) protègent contre le CSRF.
 *
 * Déploiement : le web et l'API doivent partager le même domaine de premier niveau
 * (ex. app.exemple.dz et api.exemple.dz) ou passer par un reverse proxy sous la même origine.
 */
export function setRefreshCookie(reply: FastifyReply, token: string, env: Env): void {
  void reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  });
}

export function clearRefreshCookie(reply: FastifyReply): void {
  void reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
}

/**
 * Anti-CSRF pour les routes qui s'authentifient par COOKIE : le navigateur envoie toujours `Origin` sur
 * un POST ; on exige qu'elle soit exactement celle du web. Un site tiers ne peut pas la falsifier.
 */
export function assertAllowedOrigin(request: FastifyRequest, env: Env): void {
  const origin = request.headers.origin;
  if (origin !== env.WEB_ORIGIN) throw Errors.originNotAllowed();
}

/** Les clients mobiles reçoivent le refresh token dans le corps (pas de cookie sur mobile). */
export function isMobileClient(request: FastifyRequest): boolean {
  return request.headers['x-client-platform'] === 'mobile';
}
