import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type CreateTeamInput,
  type InviteToTeamInput,
  type ListTeamsQuery,
  type PageOf,
  type TeamInvitationAdminView,
  type TeamInvitationView,
  type TeamMemberView,
  type TeamView,
  type TransferCaptaincyInput,
  type UpdateTeamInput,
  createTeamSchema,
  inviteToTeamSchema,
  listTeamsQuerySchema,
  transferCaptaincySchema,
  updateTeamSchema,
} from '@footfive/shared';
import { z } from 'zod';
import { type RequestContext, ReqCtx } from '../../common/http/request-context.js';
import { ApiZodBody } from '../../common/zod/api-zod.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CurrentUser, RequireVerifiedEmail } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RateLimit } from '../auth/rate-limit/rate-limit.guard.js';
import { TeamsService } from './teams.service.js';

const uuid = new ZodValidationPipe(z.uuid());
const DAY = 24 * 3600;

@ApiTags('Équipes')
@ApiBearerAuth()
@Controller()
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Post('teams')
  @RequireVerifiedEmail()
  @RateLimit({ name: 'team-create', limit: 10, windowSeconds: DAY, by: 'user' })
  @ApiOperation({ summary: 'Créer une équipe (le créateur en devient le capitaine)' })
  @ApiZodBody(createTeamSchema)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createTeamSchema)) body: CreateTeamInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TeamView> {
    return this.teams.create(user, body, ctx);
  }

  @Get('teams')
  @ApiOperation({ summary: 'Chercher des équipes (nom, ville, niveau)' })
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listTeamsQuerySchema)) query: ListTeamsQuery,
  ): Promise<PageOf<TeamView>> {
    return this.teams.list(query, user.id);
  }

  @Get('me/teams')
  @ApiOperation({ summary: 'Mes équipes' })
  mine(@CurrentUser() user: AuthUser): Promise<TeamView[]> {
    return this.teams.listMine(user);
  }

  @Get('teams/:teamId')
  @ApiOperation({ summary: 'Fiche d’une équipe' })
  get(@CurrentUser() user: AuthUser, @Param('teamId', uuid) teamId: string): Promise<TeamView> {
    return this.teams.get(teamId, user.id);
  }

  @Patch('teams/:teamId')
  @ApiOperation({ summary: 'Modifier mon équipe (capitaine)' })
  @ApiZodBody(updateTeamSchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param('teamId', uuid) teamId: string,
    @Body(new ZodValidationPipe(updateTeamSchema)) body: UpdateTeamInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TeamView> {
    return this.teams.update(user, teamId, body, ctx);
  }

  @Delete('teams/:teamId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Dissoudre mon équipe (capitaine) — refusé s’il reste une annonce ou un match à venir',
  })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('teamId', uuid) teamId: string,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.teams.delete(user, teamId, ctx);
  }

  // ───────────── Membres ─────────────

  @Get('teams/:teamId/members')
  @ApiOperation({ summary: 'Effectif (réservé aux membres)' })
  members(
    @CurrentUser() user: AuthUser,
    @Param('teamId', uuid) teamId: string,
  ): Promise<TeamMemberView[]> {
    return this.teams.listMembers(user, teamId);
  }

  @Delete('teams/:teamId/members/:userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Retirer un joueur de l’équipe (capitaine)' })
  async removeMember(
    @CurrentUser() user: AuthUser,
    @Param('teamId', uuid) teamId: string,
    @Param('userId', uuid) memberId: string,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.teams.removeMember(user, teamId, memberId, ctx);
  }

  @Post('teams/:teamId/leave')
  @HttpCode(204)
  @ApiOperation({ summary: 'Quitter l’équipe' })
  async leave(
    @CurrentUser() user: AuthUser,
    @Param('teamId', uuid) teamId: string,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.teams.leave(user, teamId, ctx);
  }

  @Post('teams/:teamId/transfer-captaincy')
  @HttpCode(200)
  @ApiOperation({ summary: 'Passer la capitainerie à un autre membre' })
  @ApiZodBody(transferCaptaincySchema)
  transfer(
    @CurrentUser() user: AuthUser,
    @Param('teamId', uuid) teamId: string,
    @Body(new ZodValidationPipe(transferCaptaincySchema)) body: TransferCaptaincyInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TeamView> {
    return this.teams.transferCaptaincy(user, teamId, body, ctx);
  }

  // ───────────── Invitations ─────────────

  @Post('teams/:teamId/invitations')
  @RateLimit({ name: 'team-invite', limit: 30, windowSeconds: DAY, by: 'user' })
  @ApiOperation({ summary: 'Inviter un joueur (par compte ou par email) — capitaine' })
  @ApiZodBody(inviteToTeamSchema)
  invite(
    @CurrentUser() user: AuthUser,
    @Param('teamId', uuid) teamId: string,
    @Body(new ZodValidationPipe(inviteToTeamSchema)) body: InviteToTeamInput,
  ): Promise<TeamInvitationAdminView> {
    return this.teams.invite(user, teamId, body);
  }

  @Get('teams/:teamId/invitations')
  @ApiOperation({ summary: 'Invitations en attente de mon équipe (capitaine)' })
  teamInvitations(
    @CurrentUser() user: AuthUser,
    @Param('teamId', uuid) teamId: string,
  ): Promise<TeamInvitationAdminView[]> {
    return this.teams.listTeamInvitations(user, teamId);
  }

  @Delete('teams/:teamId/invitations/:invitationId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Annuler une invitation (capitaine)' })
  async cancelInvitation(
    @CurrentUser() user: AuthUser,
    @Param('teamId', uuid) teamId: string,
    @Param('invitationId', uuid) invitationId: string,
  ): Promise<void> {
    await this.teams.cancelInvitation(user, teamId, invitationId);
  }

  @Get('me/invitations')
  @ApiOperation({ summary: 'Mes invitations en attente' })
  myInvitations(@CurrentUser() user: AuthUser): Promise<TeamInvitationView[]> {
    return this.teams.listMyInvitations(user);
  }

  @Post('invitations/:invitationId/accept')
  @HttpCode(200)
  @RequireVerifiedEmail()
  @ApiOperation({ summary: 'Accepter une invitation : je rejoins l’équipe' })
  accept(
    @CurrentUser() user: AuthUser,
    @Param('invitationId', uuid) invitationId: string,
  ): Promise<TeamView> {
    return this.teams.acceptInvitation(user, invitationId);
  }

  @Post('invitations/:invitationId/decline')
  @HttpCode(204)
  @ApiOperation({ summary: 'Refuser une invitation' })
  async decline(
    @CurrentUser() user: AuthUser,
    @Param('invitationId', uuid) invitationId: string,
  ): Promise<void> {
    await this.teams.declineInvitation(user, invitationId);
  }
}
