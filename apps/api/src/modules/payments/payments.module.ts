import { Module } from '@nestjs/common';
import { ENV } from '../../infra/config/config.module.js';
import type { Env } from '../../infra/config/env.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import {
  FakeProviderDevController,
  FakeProviderOnlyGuard,
} from './fake-provider-dev.controller.js';
import { PaymentWebhooksService } from './payment-webhooks.service.js';
import { PaymentWebhooksController, PaymentsController } from './payments.controller.js';
import { PaymentsMaintenanceService } from './payments-maintenance.service.js';
import { PaymentsService } from './payments.service.js';
import { FakePaymentProvider } from './providers/fake-payment.provider.js';
import { PaymentProvider } from './providers/payment-provider.js';

@Module({
  imports: [BookingsModule],
  controllers: [PaymentsController, PaymentWebhooksController, FakeProviderDevController],
  providers: [
    // Le prestataire simulé n'est instancié que si on le demande (jamais en production : refusé par env.ts).
    {
      provide: FakePaymentProvider,
      inject: [ENV],
      useFactory: (env: Env): FakePaymentProvider | null =>
        env.PAYMENT_PROVIDER === 'fake' ? new FakePaymentProvider(env) : null,
    },
    // Le reste de l'application ne connaît QUE le contrat `PaymentProvider`.
    {
      provide: PaymentProvider,
      inject: [FakePaymentProvider],
      useFactory: (fake: FakePaymentProvider | null): PaymentProvider => {
        if (fake) return fake;
        // Brancher CIB / Edahabia = écrire un adaptateur qui étend PaymentProvider et le retourner ici.
        throw new Error(
          'PAYMENT_PROVIDER=live : aucun adaptateur de paiement réel n’est encore branché (voir docs/PAYMENTS.md).',
        );
      },
    },
    FakeProviderOnlyGuard,
    PaymentsService,
    PaymentWebhooksService,
    PaymentsMaintenanceService,
  ],
  exports: [PaymentsService, PaymentProvider, PaymentsMaintenanceService, PaymentWebhooksService],
})
export class PaymentsModule {}
