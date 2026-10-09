import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type ListNotificationsQuery,
  type NotificationPage,
  listNotificationsQuerySchema,
} from '@footfive/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { NotificationsService } from './notifications.service.js';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('me/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Mes notifications (les plus récentes d’abord), avec le nombre de non lues',
  })
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listNotificationsQuerySchema)) query: ListNotificationsQuery,
  ): Promise<NotificationPage> {
    return this.notifications.list(user, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Nombre de notifications non lues (pastille de l’interface)' })
  async unreadCount(@CurrentUser() user: AuthUser): Promise<{ count: number }> {
    return { count: await this.notifications.unreadCount(user) };
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Tout marquer comme lu' })
  async readAll(@CurrentUser() user: AuthUser): Promise<{ updated: number }> {
    return { updated: await this.notifications.markAllRead(user) };
  }

  @Post(':notificationId/read')
  @HttpCode(204)
  @ApiOperation({ summary: 'Marquer une notification comme lue' })
  async read(
    @CurrentUser() user: AuthUser,
    @Param('notificationId', new ZodValidationPipe(z.uuid())) notificationId: string,
  ): Promise<void> {
    await this.notifications.markRead(user, notificationId);
  }
}
