import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { Errors } from '../../../common/errors/app-exception.js';
import { RateLimitStore } from './rate-limit.store.js';

export const RATE_LIMIT_KEY = 'rate-limit';

export interface RateLimitRule {
  /** Nom du compteur (distingue login, inscription…). */
  name: string;
  limit: number;
  windowSeconds: number;
  /**
   * Clé de regroupement :
   *  - `ip` : par adresse IP ;
   *  - `ip+email` : par IP ET email visé (freine le bourrage d'identifiants sans permettre de verrouiller
   *    le compte d'une victime depuis une autre IP) ;
   *  - `user` : par utilisateur connecté.
   */
  by: 'ip' | 'ip+email' | 'user';
}

/** Applique une ou plusieurs règles à une route. Toutes doivent être respectées. */
export const RateLimit = (...rules: RateLimitRule[]): MethodDecorator =>
  SetMetadata(RATE_LIMIT_KEY, rules);

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: RateLimitStore,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const rules = this.reflector.get<RateLimitRule[] | undefined>(
      RATE_LIMIT_KEY,
      context.getHandler(),
    );
    if (!rules) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    let worst: { retryAfterSeconds: number } | null = null;

    for (const rule of rules) {
      const result = this.store.hit(this.keyFor(rule, request), rule.limit, rule.windowSeconds);
      if (!result.allowed && (!worst || result.retryAfterSeconds > worst.retryAfterSeconds)) {
        worst = result;
      }
    }
    if (worst) throw Errors.rateLimited(worst.retryAfterSeconds);
    return true;
  }

  private keyFor(rule: RateLimitRule, request: FastifyRequest): string {
    switch (rule.by) {
      case 'user':
        return `${rule.name}:user:${request.authUser?.id ?? request.ip}`;
      case 'ip+email': {
        const email = (request.body as { email?: unknown } | undefined)?.email;
        const normalized =
          typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : '';
        return `${rule.name}:ip+email:${request.ip}:${normalized}`;
      }
      default:
        return `${rule.name}:ip:${request.ip}`;
    }
  }
}
