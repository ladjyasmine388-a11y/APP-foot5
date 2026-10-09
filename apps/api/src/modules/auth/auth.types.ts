import type { PlatformRole } from '@footfive/shared';

/** Utilisateur authentifié, reconstruit depuis la BASE à chaque requête (jamais cru sur la seule foi du jeton). */
export interface AuthUser {
  id: string;
  platformRole: PlatformRole;
  /** Identifiant de la session courante (famille de refresh tokens). */
  sessionId: string;
  emailVerified: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}
