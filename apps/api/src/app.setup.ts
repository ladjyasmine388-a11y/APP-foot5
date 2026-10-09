import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { UPLOAD_CONTENT_TYPES, UPLOAD_MAX_BYTES } from '@footfive/shared';
import type { Env } from './infra/config/env.js';
import { setupOpenApi } from './openapi.js';

export const API_PREFIX = 'api/v1';

/**
 * Options de création de l'application, communes au démarrage réel ET aux tests.
 * `rawBody` : Nest conserve les OCTETS EXACTS du corps JSON dans `request.rawBody`. Les webhooks de paiement en ont
 * besoin : une signature se calcule sur le message reçu tel quel, le re-sérialiser après analyse (espace, ordre des
 * clés) la ferait échouer.
 */
export const NEST_APP_OPTIONS = { rawBody: true } as const;
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
    // Corps JSON limité : les images ont leur propre limite (voir ci-dessous).
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

  const fastify = app.getHttpAdapter().getInstance();

  // Envoi d'images : le corps binaire est lu tel quel, avec SA propre limite (le plafond JSON de 100 Ko ne s'applique pas).
  fastify.addContentTypeParser([...UPLOAD_CONTENT_TYPES], { parseAs: 'buffer', bodyLimit: UPLOAD_MAX_BYTES }, (_request, body, done) => {
    done(null, body);
  });

  fastify.addHook('onSend', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  if (env.OPENAPI_ENABLED ?? env.NODE_ENV !== 'production') {
    setupOpenApi(app);
  }

  app.enableShutdownHooks();
}
