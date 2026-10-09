import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type AdminListRefundsQuery,
  type AdminListReviewsQuery,
  type AdminRefundBookingInput,
  type AdminRefundView,
  type AdminReviewView,
  type AdminStats,
  type AuditLogView,
  type AuditQuery,
  type ModerateReviewInput,
  type PageOf,
  type StatsQuery,
  adminListRefundsQuerySchema,
  adminListReviewsQuerySchema,
  adminRefundBookingSchema,
  auditQuerySchema,
  moderateReviewSchema,
  statsQuerySchema,
} from '@footfive/shared';
import { z } from 'zod';
import { type RequestContext, ReqCtx } from '../../common/http/request-context.js';
import { ApiZodBody } from '../../common/zod/api-zod.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { AdminModerationService } from './admin-moderation.service.js';
import { StatsService } from './stats.service.js';

const uuid = new ZodValidationPipe(z.uuid());

@ApiTags('Administration · remboursements, avis, statistiques, audit')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin')
export class AdminOpsController {
  constructor(
    private readonly moderation: AdminModerationService,
    private readonly stats: StatsService,
  ) {}

  @Get('stats')
  @ApiOperation({ summary: 'Statistiques de la plateforme sur une période (réservations, chiffre d’affaires, commission, remboursements)' })
  adminStats(@Query(new ZodValidationPipe(statsQuerySchema)) query: StatsQuery): Promise<AdminStats> {
    return this.stats.admin(query);
  }

  @Get('audit-logs')
  @ApiOperation({ summary: 'Journal d’audit (lecture seule, immuable)' })
  audit(@Query(new ZodValidationPipe(auditQuerySchema)) query: AuditQuery): Promise<PageOf<AuditLogView>> {
    return this.moderation.auditLogs(query);
  }

  @Get('refunds')
  @ApiOperation({ summary: 'Remboursements, filtrables par statut' })
  refunds(@Query(new ZodValidationPipe(adminListRefundsQuerySchema)) query: AdminListRefundsQuery): Promise<PageOf<AdminRefundView>> {
    return this.moderation.listRefunds(query);
  }

  @Post('refunds/:refundId/retry')
  @ApiOperation({ summary: 'Relancer un remboursement en échec (crée une nouvelle demande ; l’ancienne reste dans l’historique)' })
  retry(@CurrentUser() admin: AuthUser, @Param('refundId', uuid) refundId: string, @ReqCtx() ctx: RequestContext): Promise<{ refundId: string }> {
    return this.moderation.retryRefund(admin, refundId, ctx);
  }

  @Post('bookings/:bookingId/refund')
  @ApiOperation({ summary: 'Rembourser tout ce qui a été payé pour une réservation (litige, geste commercial)' })
  @ApiZodBody(adminRefundBookingSchema)
  refundBooking(
    @CurrentUser() admin: AuthUser,
    @Param('bookingId', uuid) bookingId: string,
    @Body(new ZodValidationPipe(adminRefundBookingSchema)) body: AdminRefundBookingInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<{ totalMinor: number; refundIds: string[] }> {
    return this.moderation.refundBooking(admin, bookingId, body, ctx);
  }

  @Get('reviews')
  @ApiOperation({ summary: 'Avis (masqués ou non, par complexe)' })
  reviews(@Query(new ZodValidationPipe(adminListReviewsQuerySchema)) query: AdminListReviewsQuery): Promise<PageOf<AdminReviewView>> {
    return this.moderation.listReviews(query);
  }

  @Post('reviews/:reviewId/hide')
  @HttpCode(204)
  @ApiOperation({ summary: 'Masquer un avis (la note du complexe est recalculée)' })
  @ApiZodBody(moderateReviewSchema)
  async hide(
    @CurrentUser() admin: AuthUser,
    @Param('reviewId', uuid) reviewId: string,
    @Body(new ZodValidationPipe(moderateReviewSchema)) body: ModerateReviewInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.moderation.setReviewHidden(admin, reviewId, true, body, ctx);
  }

  @Post('reviews/:reviewId/unhide')
  @HttpCode(204)
  @ApiOperation({ summary: 'Rétablir un avis masqué' })
  @ApiZodBody(moderateReviewSchema)
  async unhide(
    @CurrentUser() admin: AuthUser,
    @Param('reviewId', uuid) reviewId: string,
    @Body(new ZodValidationPipe(moderateReviewSchema)) body: ModerateReviewInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.moderation.setReviewHidden(admin, reviewId, false, body, ctx);
  }
}
