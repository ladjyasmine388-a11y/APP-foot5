import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  type RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeController,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { type PayBookingInput, type PaymentView, payBookingSchema } from '@footfive/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppException } from '../../common/errors/app-exception.js';
import { ApiZodBody } from '../../common/zod/api-zod.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CurrentUser, Public, RequireVerifiedEmail } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RateLimit } from '../auth/rate-limit/rate-limit.guard.js';
import { IdempotencyService, parseIdempotencyKey } from '../bookings/idempotency.service.js';
import { PaymentWebhooksService } from './payment-webhooks.service.js';
import { PaymentsService } from './payments.service.js';

const uuid = new ZodValidationPipe(z.uuid());

@ApiTags('Paiements')
@ApiBearerAuth()
@Controller()
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('bookings/:bookingId/pay')
  @RequireVerifiedEmail()
  @RateLimit({ name: 'payment-initiate', limit: 20, windowSeconds: 10 * 60, by: 'user' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Identifiant unique de la tentative (8 à 128 caractères).',
  })
  @ApiOperation({
    summary: 'Payer une réservation en attente (acompte ou total)',
    description:
      'Aucun montant à fournir : c’est celui figé dans la réservation. Retourne l’adresse de la page de paiement du prestataire. ' +
      'Relancer pendant qu’un paiement est ouvert rend la même page. La réservation n’est confirmée que lorsque le SERVEUR a vérifié le paiement auprès du prestataire.',
  })
  @ApiZodBody(payBookingSchema)
  async pay(
    @CurrentUser() user: AuthUser,
    @Param('bookingId', uuid) bookingId: string,
    @Body(new ZodValidationPipe(payBookingSchema)) body: PayBookingInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PaymentView> {
    const key = parseIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.execute(
      { userId: user.id, key, endpoint: `POST /bookings/${bookingId}/pay`, body },
      async () => ({
        status: 201,
        body: (await this.payments.initiate(user, bookingId, key)) as unknown as Record<
          string,
          never
        >,
      }),
    );
    void reply.status(result.status);
    if (result.replayed) void reply.header('Idempotent-Replayed', 'true');
    return result.body as unknown as PaymentView;
  }

  @Get('payments/:paymentId')
  @ApiOperation({
    summary: 'Statut d’un de mes paiements',
    description:
      'Tant qu’il est en cours, le serveur interroge lui-même le prestataire : la redirection du navigateur n’est jamais une preuve.',
  })
  detail(
    @CurrentUser() user: AuthUser,
    @Param('paymentId', uuid) paymentId: string,
  ): Promise<PaymentView> {
    return this.payments.getForUser(user, paymentId);
  }
}

/**
 * Point d'entrée des webhooks du prestataire. Public (le prestataire n'a pas de compte) mais AUTHENTIFIÉ par la
 * signature du message. Le corps brut est conservé par l'analyseur JSON de l'application (voir app.setup.ts).
 */
@ApiExcludeController()
@Public()
@Controller('webhooks/payments')
export class PaymentWebhooksController {
  constructor(private readonly webhooks: PaymentWebhooksService) {}

  @Post(':provider')
  @HttpCode(200)
  @RateLimit({ name: 'payment-webhook', limit: 600, windowSeconds: 60, by: 'ip' })
  async receive(
    @Param('provider') provider: string,
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ received: true; result: string }> {
    if (!request.rawBody) {
      throw new AppException('VALIDATION_ERROR', 400, 'Corps JSON requis');
    }
    const result = await this.webhooks.handle(provider, request.rawBody, headers);
    return { received: true, result };
  }
}
