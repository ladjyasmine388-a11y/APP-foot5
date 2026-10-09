import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/** Informations de corrélation transmises aux services (audit, sessions, journaux). */
export interface RequestContext {
  ip: string;
  userAgent: string | null;
  requestId: string;
}

export function buildRequestContext(request: FastifyRequest): RequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 300) : null,
    requestId: String(request.id),
  };
}

export const ReqCtx = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  buildRequestContext(ctx.switchToHttp().getRequest<FastifyRequest>()),
);
