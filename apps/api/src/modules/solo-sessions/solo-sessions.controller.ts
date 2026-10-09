import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type CreateSoloSessionInput,
  type ListMyActivityQuery,
  type ListSoloSessionsQuery,
  type PageOf,
  type SoloSessionView,
  createSoloSessionSchema,
  listMyActivityQuerySchema,
  listSoloSessionsQuerySchema,
} from '@footfive/shared';
import { z } from 'zod';
import { type RequestContext, ReqCtx } from '../../common/http/request-context.js';
import { ApiZodBody } from '../../common/zod/api-zod.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CurrentUser, OptionalUser, Public, RequireVerifiedEmail } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RateLimit } from '../auth/rate-limit/rate-limit.guard.js';
import { SoloSessionsService } from './solo-sessions.service.js';

const uuid = new ZodValidationPipe(z.uuid());
const DAY = 24 * 3600;

@ApiTags('Complétez votre équipe')
@ApiBearerAuth()
@Controller()
export class SoloSessionsController {
  constructor(private readonly sessions: SoloSessionsService) {}

  @Get('solo-sessions')
  @Public()
  @RateLimit({ name: 'public-browse', limit: 120, windowSeconds: 60, by: 'ip' })
  @ApiOperation({
    summary: 'Sessions « Complétez votre équipe » ouvertes',
    description: 'Filtres : ville, complexe, date, heure (± fenêtre), niveau, places libres. Tri : soonest | recommended (connecté) | spots. La liste des joueurs n’est visible que connecté.',
  })
  list(
    @OptionalUser() user: AuthUser | null,
    @Query(new ZodValidationPipe(listSoloSessionsQuerySchema)) query: ListSoloSessionsQuery,
  ): Promise<PageOf<SoloSessionView>> {
    return this.sessions.list(query, user);
  }

  @Get('me/solo-sessions')
  @ApiOperation({ summary: 'Mes sessions (organisées ou rejointes)' })
  mine(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listMyActivityQuerySchema)) query: ListMyActivityQuery,
  ): Promise<PageOf<SoloSessionView>> {
    return this.sessions.listMine(user, query);
  }

  @Get('solo-sessions/:sessionId')
  @Public()
  @RateLimit({ name: 'public-browse', limit: 120, windowSeconds: 60, by: 'ip' })
  @ApiOperation({ summary: 'Détail d’une session' })
  get(@OptionalUser() user: AuthUser | null, @Param('sessionId', uuid) sessionId: string): Promise<SoloSessionView> {
    return this.sessions.getForViewer(sessionId, user);
  }

  @Post('solo-sessions')
  @RequireVerifiedEmail()
  @RateLimit({ name: 'solo-create', limit: 20, windowSeconds: DAY, by: 'user' })
  @ApiOperation({
    summary: 'Ouvrir des places sur ma réservation confirmée',
    description: 'Le règlement de chaque joueur se fait hors plateforme (entre joueurs, sur place) ; seule la réservation du terrain passe par la plateforme.',
  })
  @ApiZodBody(createSoloSessionSchema)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createSoloSessionSchema)) body: CreateSoloSessionInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<SoloSessionView> {
    return this.sessions.create(user, body, ctx);
  }

  @Post('solo-sessions/:sessionId/join')
  @HttpCode(200)
  @RequireVerifiedEmail()
  @RateLimit({ name: 'solo-join', limit: 60, windowSeconds: 3600, by: 'user' })
  @ApiOperation({ summary: 'Rejoindre une session (place garantie, jamais de surréservation)' })
  join(@CurrentUser() user: AuthUser, @Param('sessionId', uuid) sessionId: string): Promise<SoloSessionView> {
    return this.sessions.join(user, sessionId);
  }

  @Post('solo-sessions/:sessionId/leave')
  @HttpCode(204)
  @ApiOperation({ summary: 'Quitter une session avant son début' })
  async leave(@CurrentUser() user: AuthUser, @Param('sessionId', uuid) sessionId: string): Promise<void> {
    await this.sessions.leave(user, sessionId);
  }

  @Delete('solo-sessions/:sessionId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Annuler une session (hôte ou personnel du complexe) — la réservation du terrain reste acquise' })
  async cancel(@CurrentUser() user: AuthUser, @Param('sessionId', uuid) sessionId: string, @ReqCtx() ctx: RequestContext): Promise<void> {
    await this.sessions.cancel(user, sessionId, ctx);
  }

  // ───────────── Côté complexe ─────────────

  @Post('manage/venues/:venueId/solo-sessions')
  @RateLimit({ name: 'solo-create', limit: 100, windowSeconds: DAY, by: 'user' })
  @ApiOperation({ summary: 'Le complexe ouvre des places sur l’une de ses réservations confirmées (personnel)' })
  @ApiZodBody(createSoloSessionSchema)
  createForVenue(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Body(new ZodValidationPipe(createSoloSessionSchema)) body: CreateSoloSessionInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<SoloSessionView> {
    return this.sessions.create(user, body, ctx, { venueId });
  }
}
