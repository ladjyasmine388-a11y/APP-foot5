import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  type AvailabilityQuery,
  type CreateFieldInput,
  type CreatePricingRuleInput,
  type CreateVenueInput,
  type DayAvailability,
  type ManageFieldView,
  type ManageSlot,
  type ManageVenueDetail,
  type ManageVenueSummary,
  type OpeningHoursInput,
  type PricingRuleView,
  type UpdateFieldInput,
  type UpdatePricingRuleInput,
  type UpdateVenueInput,
  availabilityQuerySchema,
  createFieldSchema,
  createPricingRuleSchema,
  createVenueSchema,
  openingHoursSchema,
  updateFieldSchema,
  updatePricingRuleSchema,
  updateVenueSchema,
} from '@footfive/shared';
import { z } from 'zod';
import { type RequestContext, ReqCtx } from '../../common/http/request-context.js';
import { ApiZodBody } from '../../common/zod/api-zod.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CurrentUser, RequireVerifiedEmail } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RateLimit } from '../auth/rate-limit/rate-limit.guard.js';
import { VenuesManageService } from './venues-manage.service.js';

const uuid = new ZodValidationPipe(z.uuid());

/**
 * Espace complexe. Chaque route vérifie dans le SERVICE que l'utilisateur appartient au complexe visé
 * (rôle minimal par action) ; un identifiant d'un autre complexe donne 404.
 */
@ApiTags('Espace complexe')
@ApiBearerAuth()
@Controller('manage/venues')
export class VenuesManageController {
  constructor(private readonly manage: VenuesManageService) {}

  @Post()
  @RequireVerifiedEmail()
  @RateLimit({ name: 'venue-create', limit: 5, windowSeconds: 24 * 3600, by: 'user' })
  @ApiOperation({
    summary: 'Déclarer un complexe',
    description:
      'Le complexe est créé « en attente » : il n’apparaît publiquement qu’après approbation par la plateforme.',
  })
  @ApiZodBody(createVenueSchema)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createVenueSchema)) body: CreateVenueInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ManageVenueDetail> {
    return this.manage.createVenue(user, body, ctx);
  }

  @Get()
  @ApiOperation({ summary: 'Mes complexes' })
  mine(@CurrentUser() user: AuthUser): Promise<ManageVenueSummary[]> {
    return this.manage.listMine(user);
  }

  @Get(':venueId')
  @ApiOperation({ summary: 'Détail complet d’un de mes complexes (terrains, horaires, tarifs)' })
  detail(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
  ): Promise<ManageVenueDetail> {
    return this.manage.getVenue(user, venueId);
  }

  @Patch(':venueId')
  @ApiOperation({ summary: 'Modifier les informations du complexe' })
  @ApiZodBody(updateVenueSchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Body(new ZodValidationPipe(updateVenueSchema)) body: UpdateVenueInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ManageVenueDetail> {
    return this.manage.updateVenue(user, venueId, body, ctx);
  }

  @Put(':venueId/opening-hours')
  @ApiOperation({
    summary: 'Définir les horaires d’ouverture du complexe',
    description:
      'Remplace tous les horaires. Un jour absent est fermé. `to` ≤ `from` = fermeture le lendemain (10:00 → 02:00).',
  })
  @ApiZodBody(openingHoursSchema)
  setHours(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Body(new ZodValidationPipe(openingHoursSchema)) body: OpeningHoursInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ManageVenueDetail> {
    return this.manage.setVenueHours(user, venueId, body, ctx);
  }

  @Get(':venueId/availability')
  @ApiOperation({
    summary: 'Créneaux d’un jour avec tous les statuts (réservé, bloqué, sans prix…)',
  })
  @ApiQuery({ name: 'date', required: true, description: 'AAAA-MM-JJ' })
  availability(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Query(new ZodValidationPipe(availabilityQuerySchema)) query: AvailabilityQuery,
  ): Promise<DayAvailability<ManageSlot>> {
    return this.manage.getAvailability(user, venueId, query.date);
  }

  // ───────────── Terrains ─────────────

  @Post(':venueId/fields')
  @ApiOperation({ summary: 'Ajouter un terrain' })
  @ApiZodBody(createFieldSchema)
  createField(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Body(new ZodValidationPipe(createFieldSchema)) body: CreateFieldInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ManageFieldView> {
    return this.manage.createField(user, venueId, body, ctx);
  }

  @Patch(':venueId/fields/:fieldId')
  @ApiOperation({ summary: 'Modifier un terrain (ou le réactiver avec isActive)' })
  @ApiZodBody(updateFieldSchema)
  updateField(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Param('fieldId', uuid) fieldId: string,
    @Body(new ZodValidationPipe(updateFieldSchema)) body: UpdateFieldInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ManageFieldView> {
    return this.manage.updateField(user, venueId, fieldId, body, ctx);
  }

  @Delete(':venueId/fields/:fieldId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Désactiver un terrain (l’historique des réservations est conservé)' })
  async deactivateField(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Param('fieldId', uuid) fieldId: string,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.manage.deactivateField(user, venueId, fieldId, ctx);
  }

  @Put(':venueId/fields/:fieldId/opening-hours')
  @ApiOperation({
    summary: 'Définir des horaires propres à un terrain',
    description:
      'Remplacent ceux du complexe pour les jours indiqués. `days: []` supprime la surcharge.',
  })
  @ApiZodBody(openingHoursSchema)
  setFieldHours(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Param('fieldId', uuid) fieldId: string,
    @Body(new ZodValidationPipe(openingHoursSchema)) body: OpeningHoursInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ManageFieldView> {
    return this.manage.setFieldHours(user, venueId, fieldId, body, ctx);
  }

  // ───────────── Tarifs ─────────────

  @Get(':venueId/fields/:fieldId/pricing-rules')
  @ApiOperation({ summary: 'Règles de prix d’un terrain' })
  listRules(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Param('fieldId', uuid) fieldId: string,
  ): Promise<PricingRuleView[]> {
    return this.manage.listPricingRules(user, venueId, fieldId);
  }

  @Post(':venueId/fields/:fieldId/pricing-rules')
  @ApiOperation({
    summary: 'Ajouter une règle de prix',
    description:
      'Prix en DZD par jour et tranche horaire. À chevauchement, la règle de plus haute priorité l’emporte.',
  })
  @ApiZodBody(createPricingRuleSchema)
  createRule(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Param('fieldId', uuid) fieldId: string,
    @Body(new ZodValidationPipe(createPricingRuleSchema)) body: CreatePricingRuleInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<PricingRuleView> {
    return this.manage.createPricingRule(user, venueId, fieldId, body, ctx);
  }

  @Patch(':venueId/fields/:fieldId/pricing-rules/:ruleId')
  @ApiOperation({ summary: 'Modifier une règle de prix' })
  @ApiZodBody(updatePricingRuleSchema)
  updateRule(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Param('fieldId', uuid) fieldId: string,
    @Param('ruleId', uuid) ruleId: string,
    @Body(new ZodValidationPipe(updatePricingRuleSchema)) body: UpdatePricingRuleInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<PricingRuleView> {
    return this.manage.updatePricingRule(user, venueId, fieldId, ruleId, body, ctx);
  }

  @Delete(':venueId/fields/:fieldId/pricing-rules/:ruleId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Supprimer une règle de prix' })
  async deleteRule(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Param('fieldId', uuid) fieldId: string,
    @Param('ruleId', uuid) ruleId: string,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.manage.deletePricingRule(user, venueId, fieldId, ruleId, ctx);
  }
}
