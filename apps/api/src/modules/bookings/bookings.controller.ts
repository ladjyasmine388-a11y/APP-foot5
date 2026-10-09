import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  type BookingListResponse,
  type BookingQuote,
  type BookingView,
  type CancelBookingInput,
  type CancelBookingResponse,
  type CreateBookingInput,
  type ListMyBookingsQuery,
  type QuoteBookingInput,
  cancelBookingSchema,
  createBookingSchema,
  listMyBookingsQuerySchema,
  quoteBookingSchema,
} from '@footfive/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type RequestContext, ReqCtx } from '../../common/http/request-context.js';
import { ApiZodBody } from '../../common/zod/api-zod.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CurrentUser, RequireVerifiedEmail } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { isMobileClient } from '../auth/auth.cookies.js';
import { RateLimit } from '../auth/rate-limit/rate-limit.guard.js';
import { BookingsService } from './bookings.service.js';
import { IdempotencyService, parseIdempotencyKey } from './idempotency.service.js';

const uuid = new ZodValidationPipe(z.uuid());

@ApiTags('Réservations')
@ApiBearerAuth()
@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('quote')
  @HttpCode(200)
  @RequireVerifiedEmail()
  @RateLimit({ name: 'booking-quote', limit: 60, windowSeconds: 60, by: 'user' })
  @ApiOperation({
    summary: 'Devis : prix et acompte d’un créneau (calculés par le serveur)',
    description:
      'N’écrit rien. Le client indique le créneau et le mode de paiement, jamais un montant.',
  })
  @ApiZodBody(quoteBookingSchema)
  quote(
    @Body(new ZodValidationPipe(quoteBookingSchema)) body: QuoteBookingInput,
  ): Promise<BookingQuote> {
    return this.bookings.quote(body);
  }

  @Post()
  @RequireVerifiedEmail()
  @RateLimit({ name: 'booking-create', limit: 20, windowSeconds: 10 * 60, by: 'user' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Identifiant unique de la tentative (8 à 128 caractères). Rejouer la même requête rend la même réponse.',
  })
  @ApiOperation({
    summary: 'Réserver un créneau (verrou temporaire en attendant le paiement)',
    description:
      'Crée une réservation `PENDING_PAYMENT` avec un verrou de quelques minutes. 409 `SLOT_UNAVAILABLE` si le créneau vient d’être pris.',
  })
  @ApiZodBody(createBookingSchema)
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createBookingSchema)) body: CreateBookingInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<BookingView> {
    const key = parseIdempotencyKey(idempotencyKey);
    const platform = isMobileClient(request) ? 'MOBILE' : 'WEB';

    const result = await this.idempotency.execute(
      { userId: user.id, key, endpoint: 'POST /bookings', body },
      async () => ({
        status: 201,
        // La vue ne contient que des valeurs JSON (chaînes, nombres, booléens, null).
        body: (await this.bookings.create(user, body, platform)) as unknown as Record<
          string,
          never
        >,
      }),
    );
    void reply.status(result.status);
    if (result.replayed) void reply.header('Idempotent-Replayed', 'true');
    return result.body as unknown as BookingView;
  }

  @Get()
  @ApiOperation({ summary: 'Mes réservations' })
  @ApiQuery({ name: 'when', required: false, enum: ['upcoming', 'past', 'all'] })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listMyBookingsQuerySchema)) query: ListMyBookingsQuery,
  ): Promise<BookingListResponse> {
    return this.bookings.listMine(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Détail d’une de mes réservations' })
  detail(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<BookingView> {
    return this.bookings.getMine(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Annuler une de mes réservations',
    description:
      'Gratuit jusqu’au délai fixé par le complexe (24 h par défaut) : remboursement intégral. Ensuite, l’acompte reste acquis sauf politique contraire.',
  })
  @ApiZodBody(cancelBookingSchema)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(cancelBookingSchema)) body: CancelBookingInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<CancelBookingResponse> {
    return this.bookings.cancel(user, id, body, ctx);
  }
}
