import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Env } from './infra/config/env.js';
import { setupOpenApi } from './openapi.js';

export const API_PREFIX = 'api/v1';
const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[\w-]{8,64}$/;

/** Adaptateur Fastify avec identifiant de requête (corrélation des logs et des erreurs). */
export function createAdapter(): FastifyAdapter {
  return new FastifyAdapter({
    // On n'accepte un identifiant fourni par le client que s'il est inoffensif.
    genReqId: (req: IncomingMessage) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming)
        ? incoming
        : randomUUID();
    },
    // Derrière un reverse proxy (production), pour des IP clientes correctes (rate limiting, audit).
    trustProxy: true,
    // Corps JSON limité : aucune route du MVP n'a besoin de plus (les images passeront par un upload dédié).
    bodyLimit: 100 * 1024,
  });
}

/**
 * Configuration HTTP commune à l'application réelle ET aux tests,
 * pour que les tests exercent exactement la même pile (en-têtes de sécurité, CORS, limites).
 */
export async function configureApp(app: NestFastifyApplication, env: Env): Promise<void> {
  app.setGlobalPrefix(API_PREFIX);

  await app.register(helmet);
  await app.register(cors, {
    origin: [env.WEB_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
      'X-Client-Platform',
    ],
  });
  // Pas de secret de signature : le cookie de refresh n'est pas signé (il est opaque et vérifié en base).
  await app.register(cookie);
  // Limite globale ; des limites plus strictes sont appliquées route par route (@RateLimit).
  await app.register(rateLimit, {
    global: true,
    max: env.GLOBAL_RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
  });

  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', async (request, reply) => {
      reply.header(REQUEST_ID_HEADER, request.id);
    });

  if (env.OPENAPI_ENABLED ?? env.NODE_ENV !== 'production') {
    setupOpenApi(app);
  }

  app.enableShutdownHooks();
}
