import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type ChangePasswordInput,
  type DeleteAccountInput,
  type PublicUser,
  type SessionInfo,
  type UpdateProfileInput,
  changePasswordSchema,
  deleteAccountSchema,
  updateProfileSchema,
} from '@footfive/shared';
import { z } from 'zod';
import { type RequestContext, ReqCtx } from '../../common/http/request-context.js';
import { ApiZodBody } from '../../common/zod/api-zod.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { toPublicUser } from './user.mapper.js';
import { UsersService } from './users.service.js';

@ApiTags('Mon compte')
@ApiBearerAuth()
@Controller('me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Mon profil' })
  async me(@CurrentUser() user: AuthUser): Promise<PublicUser> {
    return toPublicUser(await this.users.getById(user.id));
  }

  @Patch()
  @ApiOperation({
    summary: 'Modifier mon profil',
    description:
      'Champs inconnus refusés : email, rôle, statut et fiabilité ne sont pas modifiables ici.',
  })
  @ApiZodBody(updateProfileSchema)
  async update(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(updateProfileSchema)) body: UpdateProfileInput,
  ): Promise<PublicUser> {
    return toPublicUser(await this.users.updateProfile(user.id, body));
  }

  @Post('change-password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Changer mon mot de passe (déconnecte mes autres appareils)' })
  @ApiZodBody(changePasswordSchema)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.users.changePassword(user.id, user.sessionId, body, ctx);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Mes appareils connectés' })
  sessions(@CurrentUser() user: AuthUser): Promise<SessionInfo[]> {
    return this.users.listSessions(user.id, user.sessionId);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Déconnecter un de mes appareils' })
  async revokeSession(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ): Promise<void> {
    await this.users.revokeSession(user.id, id);
  }

  @Post('delete-account')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Supprimer mon compte (anonymisation)',
    description:
      'Exige le mot de passe. Refusé s’il reste des réservations à venir ou une équipe à transférer.',
  })
  @ApiZodBody(deleteAccountSchema)
  async deleteAccount(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(deleteAccountSchema)) body: DeleteAccountInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.users.deleteAccount(user.id, body.password, ctx);
  }
}
