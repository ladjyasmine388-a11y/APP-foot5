import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { ConfigModule } from './infra/config/config.module.js';
import { PrismaModule } from './infra/database/prisma.module.js';
import { EventsModule } from './infra/events/domain-events.js';
import { MailModule } from './infra/mail/mail.module.js';
import { StorageModule } from './infra/storage/file-storage.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BookingsModule } from './modules/bookings/bookings.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { PoliciesModule } from './modules/policies/policies.module.js';
import { MatchesModule } from './modules/matches/matches.module.js';
import { MatchingModule } from './modules/matching/matching.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { OpponentsModule } from './modules/opponents/opponents.module.js';
import { ReviewsModule } from './modules/reviews/reviews.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { SoloSessionsModule } from './modules/solo-sessions/solo-sessions.module.js';
import { TeamsModule } from './modules/teams/teams.module.js';
import { UploadsModule } from './modules/uploads/uploads.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { VenuesModule } from './modules/venues/venues.module.js';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    EventsModule,
    MailModule,
    StorageModule,
    AuditModule,
    SettingsModule,
    PoliciesModule,
    AuthModule,
    UsersModule,
    VenuesModule,
    BookingsModule,
    PaymentsModule,
    MatchingModule,
    TeamsModule,
    MatchesModule,
    SoloSessionsModule,
    OpponentsModule,
    NotificationsModule,
    ReviewsModule,
    UploadsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
