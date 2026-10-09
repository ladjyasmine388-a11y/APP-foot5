import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type CreateReviewInput,
  type ListReviewsQuery,
  type ReviewPage,
  type ReviewView,
  createReviewSchema,
  listReviewsQuerySchema,
} from '@footfive/shared';
import { z } from 'zod';
import { type RequestContext, ReqCtx } from '../../common/http/request-context.js';
import { ApiZodBody } from '../../common/zod/api-zod.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CurrentUser, Public } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RateLimit } from '../auth/rate-limit/rate-limit.guard.js';
import { ReviewsService } from './reviews.service.js';

const uuid = new ZodValidationPipe(z.uuid());

@ApiTags('Avis')
@ApiBearerAuth()
@Controller()
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Post('bookings/:bookingId/review')
  @RateLimit({ name: 'review-create', limit: 20, windowSeconds: 24 * 3600, by: 'user' })
  @ApiOperation({ summary: 'Donner mon avis sur une réservation jouée (un seul avis, dans les 30 jours)' })
  @ApiZodBody(createReviewSchema)
  create(
    @CurrentUser() user: AuthUser,
    @Param('bookingId', uuid) bookingId: string,
    @Body(new ZodValidationPipe(createReviewSchema)) body: CreateReviewInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ReviewView> {
    return this.reviews.create(user, bookingId, body, ctx);
  }

  @Get('bookings/:bookingId/review')
  @ApiOperation({ summary: 'Mon avis sur cette réservation (404 s’il n’y en a pas)' })
  mine(@CurrentUser() user: AuthUser, @Param('bookingId', uuid) bookingId: string): Promise<ReviewView> {
    return this.reviews.getMine(user, bookingId);
  }

  @Get('venues/:slug/reviews')
  @Public()
  @RateLimit({ name: 'public-browse', limit: 120, windowSeconds: 60, by: 'ip' })
  @ApiOperation({ summary: 'Avis publics d’un complexe' })
  list(
    @Param('slug', new ZodValidationPipe(z.string().trim().min(1).max(120))) venueSlug: string,
    @Query(new ZodValidationPipe(listReviewsQuerySchema)) query: ListReviewsQuery,
  ): Promise<ReviewPage> {
    return this.reviews.listForVenue(venueSlug, query);
  }
}
