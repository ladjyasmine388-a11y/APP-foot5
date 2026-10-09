import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type AddStaffInput,
  type StaffMemberView,
  type UpdateStaffInput,
  addStaffSchema,
  updateStaffSchema,
} from '@footfive/shared';
import { z } from 'zod';
import { type RequestContext, ReqCtx } from '../../common/http/request-context.js';
import { ApiZodBody } from '../../common/zod/api-zod.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RateLimit } from '../auth/rate-limit/rate-limit.guard.js';
import { VenueStaffService } from './venue-staff.service.js';

const uuid = new ZodValidationPipe(z.uuid());

@ApiTags('Espace complexe · personnel')
@ApiBearerAuth()
@Controller('manage/venues/:venueId/staff')
export class VenueStaffController {
  constructor(private readonly staff: VenueStaffService) {}

  @Get()
  @ApiOperation({ summary: 'Personnel du complexe (gérant)' })
  list(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
  ): Promise<StaffMemberView[]> {
    return this.staff.list(user, venueId);
  }

  @Post()
  @RateLimit({ name: 'staff-add', limit: 20, windowSeconds: 3600, by: 'user' })
  @ApiOperation({
    summary:
      'Ajouter un membre du personnel par son adresse email (propriétaire ; le compte doit exister)',
  })
  @ApiZodBody(addStaffSchema)
  add(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Body(new ZodValidationPipe(addStaffSchema)) body: AddStaffInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<StaffMemberView> {
    return this.staff.add(user, venueId, body, ctx);
  }

  @Patch(':userId')
  @ApiOperation({
    summary: 'Changer le rôle d’un membre (propriétaire ; il reste toujours un propriétaire)',
  })
  @ApiZodBody(updateStaffSchema)
  updateRole(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Param('userId', uuid) userId: string,
    @Body(new ZodValidationPipe(updateStaffSchema)) body: UpdateStaffInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<StaffMemberView> {
    return this.staff.updateRole(user, venueId, userId, body, ctx);
  }

  @Delete(':userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Retirer un membre (propriétaire) ou quitter le complexe (soi-même)' })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Param('userId', uuid) userId: string,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.staff.remove(user, venueId, userId, ctx);
  }
}
