import { Module } from '@nestjs/common';
import { NotificationListenersService } from './notification-listeners.service.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { RemindersService } from './reminders.service.js';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationListenersService, RemindersService],
  exports: [NotificationsService, RemindersService],
})
export class NotificationsModule {}
