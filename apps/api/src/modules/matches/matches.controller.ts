import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type CreateTeamMatchInput,
  type ListMyActivityQuery,
  type MatchView,
  type PageOf,
  type SetScoreInput,
  createTeamMatchSchema,
  listMyActivityQuerySchema,
  setScoreSchema,
} from '@footfive/shared';
import { z } from 'zod';
import { type RequestContext, ReqCtx } from '../../common/http/request-context.js';
import { ApiZodBody } from '../../common/zod/api-zod.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CurrentUser, RequireVerifiedEmail } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RateLimit } from '../auth/rate-limit/rate-limit.guard.js';
import { MatchesService } from './matches.service.js';

const uuid = new ZodValidationPipe(z.uuid());

@ApiTags('Matchs')
@ApiBearerAuth()
@Controller()
export class MatchesController {
  constructor(private readonly matches: MatchesService) {}

  @Post('matches')
  @RequireVerifiedEmail()
  @RateLimit({ name: 'match-create', limit: 20, windowSeconds: 24 * 3600, by: 'user' })
  @ApiOperation({ summary: 'Créer un match d’équipe sur ma réservation confirmée (capitaine)' })
  @ApiZodBody(createTeamMatchSchema)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createTeamMatchSchema)) body: CreateTeamMatchInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<MatchView> {
    return this.matches.createTeamMatch(user, body, ctx);
  }

  @Get('me/matches')
  @ApiOperation({ summary: 'Mes matchs (à venir / passés)' })
  mine(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listMyActivityQuerySchema)) query: ListMyActivityQuery,
  ): Promise<PageOf<MatchView>> {
    return this.matches.listMine(user, query);
  }

  @Get('matches/:matchId')
  @ApiOperation({ summary: 'Détail d’un match (participants, équipes, personnel du complexe)' })
  get(@CurrentUser() user: AuthUser, @Param('matchId', uuid) matchId: string): Promise<MatchView> {
    return this.matches.get(user, matchId);
  }

  @Put('matches/:matchId/score')
  @ApiOperation({
    summary: 'Saisir le score une fois le match terminé (capitaine ; écriture unique)',
  })
  @ApiZodBody(setScoreSchema)
  score(
    @CurrentUser() user: AuthUser,
    @Param('matchId', uuid) matchId: string,
    @Body(new ZodValidationPipe(setScoreSchema)) body: SetScoreInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<MatchView> {
    return this.matches.setScore(user, matchId, body, ctx);
  }

  @Post('matches/:matchId/cancel')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Annuler un match à venir (ou se retirer d’un face-à-face) — capitaine',
  })
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('matchId', uuid) matchId: string,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.matches.cancel(user, matchId, ctx);
  }
}
