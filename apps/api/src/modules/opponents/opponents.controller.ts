import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type CreateMatchRequestInput,
  type CreateOpponentListingInput,
  type ListOpponentListingsQuery,
  type MatchRequestView,
  type MatchView,
  type OpponentListingView,
  type PageOf,
  createMatchRequestSchema,
  createOpponentListingSchema,
  listOpponentListingsQuerySchema,
} from '@footfive/shared';
import { z } from 'zod';
import { type RequestContext, ReqCtx } from '../../common/http/request-context.js';
import { ApiZodBody } from '../../common/zod/api-zod.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CurrentUser, OptionalUser, Public, RequireVerifiedEmail } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RateLimit } from '../auth/rate-limit/rate-limit.guard.js';
import { OpponentsService } from './opponents.service.js';

const uuid = new ZodValidationPipe(z.uuid());
const DAY = 24 * 3600;

@ApiTags('Trouvez un adversaire')
@ApiBearerAuth()
@Controller()
export class OpponentsController {
  constructor(private readonly opponents: OpponentsService) {}

  @Get('opponent-listings')
  @Public()
  @RateLimit({ name: 'public-browse', limit: 120, windowSeconds: 60, by: 'ip' })
  @ApiOperation({ summary: 'Annonces « cherche un adversaire » ouvertes (ville, complexe, date, niveau, format)' })
  list(
    @OptionalUser() user: AuthUser | null,
    @Query(new ZodValidationPipe(listOpponentListingsQuerySchema)) query: ListOpponentListingsQuery,
  ): Promise<PageOf<OpponentListingView>> {
    return this.opponents.list(query, user);
  }

  @Get('me/opponent-listings')
  @ApiOperation({ summary: 'Les annonces de mes équipes' })
  mineListings(@CurrentUser() user: AuthUser): Promise<OpponentListingView[]> {
    return this.opponents.listMine(user);
  }

  @Get('me/opponent-requests')
  @ApiOperation({ summary: 'Les demandes faites par les équipes que je dirige' })
  mineRequests(@CurrentUser() user: AuthUser): Promise<MatchRequestView[]> {
    return this.opponents.listMyRequests(user);
  }

  @Get('opponent-listings/:listingId')
  @Public()
  @RateLimit({ name: 'public-browse', limit: 120, windowSeconds: 60, by: 'ip' })
  @ApiOperation({ summary: 'Détail d’une annonce' })
  get(@OptionalUser() user: AuthUser | null, @Param('listingId', uuid) listingId: string): Promise<OpponentListingView> {
    return this.opponents.getForViewer(listingId, user);
  }

  @Post('opponent-listings')
  @RequireVerifiedEmail()
  @RateLimit({ name: 'opponent-create', limit: 20, windowSeconds: DAY, by: 'user' })
  @ApiOperation({ summary: 'Publier une annonce sur ma réservation confirmée (capitaine)' })
  @ApiZodBody(createOpponentListingSchema)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createOpponentListingSchema)) body: CreateOpponentListingInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<OpponentListingView> {
    return this.opponents.create(user, body, ctx);
  }

  @Delete('opponent-listings/:listingId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Retirer mon annonce (capitaine) — les demandes en attente sont rejetées' })
  async cancel(@CurrentUser() user: AuthUser, @Param('listingId', uuid) listingId: string, @ReqCtx() ctx: RequestContext): Promise<void> {
    await this.opponents.cancel(user, listingId, ctx);
  }

  @Post('opponent-listings/:listingId/requests')
  @RequireVerifiedEmail()
  @RateLimit({ name: 'opponent-request', limit: 30, windowSeconds: DAY, by: 'user' })
  @ApiOperation({ summary: 'Demander à affronter l’équipe annonceuse (capitaine de l’équipe demandeuse)' })
  @ApiZodBody(createMatchRequestSchema)
  request(
    @CurrentUser() user: AuthUser,
    @Param('listingId', uuid) listingId: string,
    @Body(new ZodValidationPipe(createMatchRequestSchema)) body: CreateMatchRequestInput,
  ): Promise<MatchRequestView> {
    return this.opponents.request(user, listingId, body);
  }

  @Get('opponent-listings/:listingId/requests')
  @ApiOperation({ summary: 'Demandes reçues pour mon annonce (capitaine)' })
  requests(@CurrentUser() user: AuthUser, @Param('listingId', uuid) listingId: string): Promise<MatchRequestView[]> {
    return this.opponents.listRequests(user, listingId);
  }

  @Post('opponent-listings/:listingId/requests/:requestId/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'Accepter une demande : le match est créé, les autres demandes sont rejetées' })
  accept(
    @CurrentUser() user: AuthUser,
    @Param('listingId', uuid) listingId: string,
    @Param('requestId', uuid) requestId: string,
    @ReqCtx() ctx: RequestContext,
  ): Promise<MatchView> {
    return this.opponents.accept(user, listingId, requestId, ctx);
  }

  @Post('opponent-listings/:listingId/requests/:requestId/reject')
  @HttpCode(204)
  @ApiOperation({ summary: 'Refuser une demande' })
  async reject(
    @CurrentUser() user: AuthUser,
    @Param('listingId', uuid) listingId: string,
    @Param('requestId', uuid) requestId: string,
  ): Promise<void> {
    await this.opponents.reject(user, listingId, requestId);
  }

  @Delete('opponent-requests/:requestId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Retirer ma demande tant qu’elle est en attente (capitaine de l’équipe demandeuse)' })
  async cancelRequest(@CurrentUser() user: AuthUser, @Param('requestId', uuid) requestId: string): Promise<void> {
    await this.opponents.cancelRequest(user, requestId);
  }
}
