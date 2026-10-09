import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type AdminListUsersQuery,
  type AdminUserView,
  type BlockUserInput,
  type CommissionRuleView,
  type PageOf,
  type SetCommissionInput,
  adminListUsersQuerySchema,
  blockUserSchema,
  setCommissionSchema,
  updateSettingSchema,
} from '@footfive/shared';
import { z } from 'zod';
import { type RequestContext, ReqCtx } from '../../common/http/request-context.js';
import { ApiZodBody } from '../../common/zod/api-zod.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { AdminCommissionService } from './admin-commission.service.js';
import { AdminUsersService } from './admin-users.service.js';

const uuid = new ZodValidationPipe(z.uuid());

@ApiTags('Administration · utilisateurs, commission, paramètres')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin')
export class AdminPlatformController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly commission: AdminCommissionService,
  ) {}

  // ───────────── Utilisateurs ─────────────

  @Get('users')
  @ApiOperation({ summary: 'Rechercher des utilisateurs (email, nom, téléphone, statut, rôle)' })
  listUsers(
    @Query(new ZodValidationPipe(adminListUsersQuerySchema)) query: AdminListUsersQuery,
  ): Promise<PageOf<AdminUserView>> {
    return this.users.list(query);
  }

  @Get('users/:userId')
  @ApiOperation({ summary: 'Détail d’un utilisateur' })
  getUser(@Param('userId', uuid) userId: string): Promise<AdminUserView> {
    return this.users.get(userId);
  }

  @Post('users/:userId/block')
  @HttpCode(200)
  @ApiOperation({ summary: 'Bloquer un compte (sessions révoquées, motif obligatoire)' })
  @ApiZodBody(blockUserSchema)
  block(
    @CurrentUser() admin: AuthUser,
    @Param('userId', uuid) userId: string,
    @Body(new ZodValidationPipe(blockUserSchema)) body: BlockUserInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<AdminUserView> {
    return this.users.block(admin, userId, body, ctx);
  }

  @Post('users/:userId/unblock')
  @HttpCode(200)
  @ApiOperation({ summary: 'Débloquer un compte' })
  unblock(
    @CurrentUser() admin: AuthUser,
    @Param('userId', uuid) userId: string,
    @ReqCtx() ctx: RequestContext,
  ): Promise<AdminUserView> {
    return this.users.unblock(admin, userId, ctx);
  }

  // ───────────── Commission ─────────────

  @Get('commission')
  @ApiOperation({ summary: 'Taux de commission en vigueur (global et par complexe) et historique' })
  commissionOverview(): ReturnType<AdminCommissionService['overview']> {
    return this.commission.overview();
  }

  @Put('commission/global')
  @ApiOperation({
    summary:
      'Changer le taux global (s’applique aux nouvelles réservations ; les anciennes gardent le leur)',
  })
  @ApiZodBody(setCommissionSchema)
  setGlobal(
    @CurrentUser() admin: AuthUser,
    @Body(new ZodValidationPipe(setCommissionSchema)) body: SetCommissionInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<CommissionRuleView> {
    return this.commission.setGlobal(admin, body, ctx);
  }

  @Put('commission/venues/:venueId')
  @ApiOperation({ summary: 'Taux propre à un complexe' })
  @ApiZodBody(setCommissionSchema)
  setVenue(
    @CurrentUser() admin: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Body(new ZodValidationPipe(setCommissionSchema)) body: SetCommissionInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<CommissionRuleView> {
    return this.commission.setVenue(admin, venueId, body, ctx);
  }

  @Delete('commission/venues/:venueId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Retirer le taux propre à un complexe (il retombe sur le taux global)' })
  async removeVenue(
    @CurrentUser() admin: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.commission.removeVenue(admin, venueId, ctx);
  }

  // ───────────── Paramètres ─────────────

  @Get('settings')
  @ApiOperation({
    summary: 'Paramètres de la plateforme (durée du verrou, acompte par défaut, annulation…)',
  })
  settings(): ReturnType<AdminCommissionService['listSettings']> {
    return this.commission.listSettings();
  }

  @Put('settings/:key')
  @ApiOperation({ summary: 'Modifier un paramètre (validé selon sa clé)' })
  @ApiZodBody(updateSettingSchema)
  updateSetting(
    @CurrentUser() admin: AuthUser,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(updateSettingSchema)) body: { value?: unknown },
    @ReqCtx() ctx: RequestContext,
  ): Promise<{ key: string; value: unknown }> {
    return this.commission.updateSetting(admin, key, body.value, ctx);
  }
}
