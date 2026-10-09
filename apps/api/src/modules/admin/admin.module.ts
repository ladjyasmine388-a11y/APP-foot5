import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AdminCommissionService } from './admin-commission.service.js';
import { AdminModerationService } from './admin-moderation.service.js';
import { AdminOpsController } from './admin-ops.controller.js';
import { AdminPlatformController } from './admin-platform.controller.js';
import { AdminUsersService } from './admin-users.service.js';
import { AdminVenuesController } from './admin-venues.controller.js';
import { AdminVenuesService } from './admin-venues.service.js';
import { StatsController } from './stats.controller.js';
import { StatsService } from './stats.service.js';

@Module({
  imports: [BookingsModule, NotificationsModule],
  controllers: [
    AdminVenuesController,
    AdminPlatformController,
    AdminOpsController,
    StatsController,
  ],
  providers: [
    AdminVenuesService,
    AdminUsersService,
    AdminCommissionService,
    AdminModerationService,
    StatsService,
  ],
})
export class AdminModule {}
