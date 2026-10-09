import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { ConfigModule } from './infra/config/config.module.js';
import { PrismaModule } from './infra/database/prisma.module.js';
import { MailModule } from './infra/mail/mail.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BookingsModule } from './modules/bookings/bookings.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { PoliciesModule } from './modules/policies/policies.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { VenuesModule } from './modules/venues/venues.module.js';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    MailModule,
    AuditModule,
    SettingsModule,
    PoliciesModule,
    AuthModule,
    UsersModule,
    VenuesModule,
    BookingsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
