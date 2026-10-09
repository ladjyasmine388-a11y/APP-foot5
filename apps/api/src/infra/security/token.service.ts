import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, errors, jwtVerify } from 'jose';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

const ISSUER = 'footfive-api';
const AUDIENCE = 'footfive-clients';

export interface AccessClaims {
  /** Identifiant de l'utilisateur. */
  userId: string;
  /** Identifiant de la session (famille de refresh tokens), stable malgré la rotation. */
  sessionId: string;
}

/**
 * Jeton d'accès JWT (HS256), volontairement MINIMAL : identité + session, rien d'autre.
 * Le rôle et le statut du compte sont relus en base à chaque requête (AuthGuard) :
 * bloquer un compte ou révoquer une session prend effet IMMÉDIATEMENT, pas à l'expiration du jeton.
 */
@Injectable()
export class TokenService {
  private readonly secret: Uint8Array;
  readonly accessTtlSeconds: number;

  constructor(@Inject(ENV) env: Env) {
    this.secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
    this.accessTtlSeconds = env.JWT_ACCESS_TTL_SECONDS;
  }

  signAccessToken(claims: AccessClaims): Promise<string> {
    return new SignJWT({ sid: claims.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtlSeconds}s`)
      .sign(this.secret);
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: ISSUER,
        audience: AUDIENCE,
        // Liste blanche : refuse `alg: none` et toute confusion d'algorithme.
        algorithms: ['HS256'],
      });
      const sessionId = payload['sid'];
      if (typeof payload.sub !== 'string' || typeof sessionId !== 'string') {
        throw Errors.tokenInvalid();
      }
      return { userId: payload.sub, sessionId };
    } catch (error) {
      if (error instanceof errors.JWTExpired) throw Errors.tokenExpired();
      if (error instanceof AppException) throw error;
      throw Errors.tokenInvalid();
    }
  }
}
