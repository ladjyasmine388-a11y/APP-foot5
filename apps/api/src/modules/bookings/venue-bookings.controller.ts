import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  type CreateBlockInput,
  type CreateManualBookingInput,
  type ListManageBookingsQuery,
  type ManageBookingView,
  type StaffCancelBookingInput,
  createBlockSchema,
  createManualBookingSchema,
  listManageBookingsQuerySchema,
  staffCancelBookingSchema,
} from '@footfive/shared';
import { z } from 'zod';
import { type RequestContext, ReqCtx } from '../../common/http/request-context.js';
import { ApiZodBody } from '../../common/zod/api-zod.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { VenueBookingsService } from './venue-bookings.service.js';

const uuid = new ZodValidationPipe(z.uuid());

/** Réservations d'un complexe, vues par son personnel. Droits vérifiés dans le service (STAFF ou MANAGER selon l'action). */
@ApiTags('Espace complexe — réservations')
@ApiBearerAuth()
@Controller('manage/venues/:venueId')
export class VenueBookingsController {
  constructor(private readonly bookings: VenueBookingsService) {}

  @Get('bookings')
  @ApiOperation({
    summary: 'Calendrier : réservations et blocages d’une période (contact du client inclus)',
  })
  @ApiQuery({ name: 'from', required: true, description: 'AAAA-MM-JJ (jour de service)' })
  @ApiQuery({ name: 'to', required: true, description: 'AAAA-MM-JJ (62 jours maximum)' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'fieldId', required: false })
  @ApiQuery({ name: 'includeBlocks', required: false })
  list(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Query(new ZodValidationPipe(listManageBookingsQuerySchema)) query: ListManageBookingsQuery,
  ): Promise<ManageBookingView[]> {
    return this.bookings.list(user, venueId, query);
  }

  @Post('bookings')
  @ApiOperation({
    summary: 'Saisir une réservation (téléphone, sur place)',
    description:
      'Sans commission : elle bloque simplement le créneau, le client règle tout au complexe.',
  })
  @ApiZodBody(createManualBookingSchema)
  createManual(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Body(new ZodValidationPipe(createManualBookingSchema)) body: CreateManualBookingInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ManageBookingView> {
    return this.bookings.createManual(user, venueId, body, ctx);
  }

  @Post('bookings/:bookingId/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Annuler une réservation à l’initiative du complexe',
    description: 'Le client est toujours remboursé intégralement de ce qu’il a payé en ligne.',
  })
  @ApiZodBody(staffCancelBookingSchema)
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Param('bookingId', uuid) bookingId: string,
    @Body(new ZodValidationPipe(staffCancelBookingSchema)) body: StaffCancelBookingInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<{ booking: ManageBookingView; refundRequestedMinor: number }> {
    return this.bookings.cancel(user, venueId, bookingId, body, ctx);
  }

  @Post('bookings/:bookingId/no-show')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marquer le joueur absent (une fois le créneau commencé)' })
  noShow(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Param('bookingId', uuid) bookingId: string,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ManageBookingView> {
    return this.bookings.markNoShow(user, venueId, bookingId, ctx);
  }

  @Post('blocks')
  @ApiOperation({
    summary: 'Bloquer une période sur un terrain',
    description:
      'Jusqu’à 31 jours. 409 `SLOT_UNAVAILABLE` avec la liste des réservations gênantes si la période n’est pas libre.',
  })
  @ApiZodBody(createBlockSchema)
  createBlock(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Body(new ZodValidationPipe(createBlockSchema)) body: CreateBlockInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ManageBookingView> {
    return this.bookings.createBlock(user, venueId, body, ctx);
  }

  @Delete('blocks/:bookingId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Lever un blocage (rouvrir le créneau)' })
  async removeBlock(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Param('bookingId', uuid) bookingId: string,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.bookings.removeBlock(user, venueId, bookingId, ctx);
  }
}
