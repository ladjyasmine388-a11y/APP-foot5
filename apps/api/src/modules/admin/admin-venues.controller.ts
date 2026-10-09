import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type AdminListVenuesQuery,
  type AdminVenueView,
  type PageOf,
  type SetVenueDepositPolicyInput,
  type VenueApprovalInput,
  type VenueRejectionInput,
  adminListVenuesQuerySchema,
  setVenueDepositPolicySchema,
  venueApprovalSchema,
  venueRejectionSchema,
} from '@footfive/shared';
import { z } from 'zod';
import { type RequestContext, ReqCtx } from '../../common/http/request-context.js';
import { ApiZodBody } from '../../common/zod/api-zod.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { AdminVenuesService } from './admin-venues.service.js';

const uuid = new ZodValidationPipe(z.uuid());

@ApiTags('Administration · complexes')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/venues')
export class AdminVenuesController {
  constructor(private readonly venues: AdminVenuesService) {}

  @Get()
  @ApiOperation({ summary: 'Complexes (les demandes en attente d’abord), avec propriétaires, taux de commission et acompte' })
  list(@Query(new ZodValidationPipe(adminListVenuesQuerySchema)) query: AdminListVenuesQuery): Promise<PageOf<AdminVenueView>> {
    return this.venues.list(query);
  }

  @Get(':venueId')
  @ApiOperation({ summary: 'Détail d’un complexe' })
  get(@Param('venueId', uuid) venueId: string): Promise<AdminVenueView> {
    return this.venues.get(venueId);
  }

  @Post(':venueId/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approuver un complexe en attente ou refusé (il doit avoir au moins un terrain actif)' })
  @ApiZodBody(venueApprovalSchema)
  approve(
    @CurrentUser() admin: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Body(new ZodValidationPipe(venueApprovalSchema)) body: VenueApprovalInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<AdminVenueView> {
    return this.venues.approve(admin, venueId, body, ctx);
  }

  @Post(':venueId/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Refuser un complexe en attente (motif obligatoire, communiqué aux gérants)' })
  @ApiZodBody(venueRejectionSchema)
  reject(
    @CurrentUser() admin: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Body(new ZodValidationPipe(venueRejectionSchema)) body: VenueRejectionInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<AdminVenueView> {
    return this.venues.reject(admin, venueId, body, ctx);
  }

  @Post(':venueId/suspend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Suspendre un complexe approuvé (motif obligatoire) : il disparaît des recherches et n’accepte plus de réservation' })
  @ApiZodBody(venueRejectionSchema)
  suspend(
    @CurrentUser() admin: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Body(new ZodValidationPipe(venueRejectionSchema)) body: VenueRejectionInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<AdminVenueView> {
    return this.venues.suspend(admin, venueId, body, ctx);
  }

  @Post(':venueId/reinstate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rétablir un complexe suspendu' })
  @ApiZodBody(venueApprovalSchema)
  reinstate(
    @CurrentUser() admin: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Body(new ZodValidationPipe(venueApprovalSchema)) body: VenueApprovalInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<AdminVenueView> {
    return this.venues.reinstate(admin, venueId, body, ctx);
  }

  @Put(':venueId/deposit-policy')
  @ApiOperation({ summary: 'Acompte propre à un complexe (null : règle par défaut de la plateforme)' })
  @ApiZodBody(setVenueDepositPolicySchema)
  setDeposit(
    @CurrentUser() admin: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Body(new ZodValidationPipe(setVenueDepositPolicySchema)) body: SetVenueDepositPolicyInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<AdminVenueView> {
    return this.venues.setDepositPolicy(admin, venueId, body, ctx);
  }
}
