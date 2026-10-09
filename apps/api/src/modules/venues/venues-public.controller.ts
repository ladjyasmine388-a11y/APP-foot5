import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  type AvailabilityQuery,
  type DayAvailability,
  type SearchVenuesQuery,
  type VenueDetail,
  type VenueSearchResponse,
  availabilityQuerySchema,
  searchVenuesQuerySchema,
} from '@footfive/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { Public } from '../auth/auth.decorators.js';
import { RateLimit } from '../auth/rate-limit/rate-limit.guard.js';
import { VenuesPublicService } from './venues-public.service.js';

const slugSchema = z.string().trim().min(1).max(120);
const publicRate = { name: 'public-browse', limit: 120, windowSeconds: 60, by: 'ip' } as const;

/** Consultation publique : aucune authentification, mais limitée en débit (anti-aspiration des données). */
@ApiTags('Complexes et disponibilités')
@Public()
@Controller()
export class VenuesPublicController {
  constructor(private readonly venues: VenuesPublicService) {}

  @Get('venues')
  @RateLimit(publicRate)
  @ApiOperation({
    summary: 'Rechercher des complexes',
    description:
      'Filtres : ville, quartier, nom, équipements, nombre de joueurs, date + heure (créneaux réellement disponibles), prix max, position. ' +
      'Seuls les complexes approuvés sont visibles.',
  })
  @ApiQuery({ name: 'city', required: false })
  @ApiQuery({ name: 'district', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({
    name: 'amenities',
    required: false,
    description: 'Séparés par des virgules : parking,douches',
  })
  @ApiQuery({ name: 'players', required: false })
  @ApiQuery({ name: 'date', required: false, description: 'AAAA-MM-JJ' })
  @ApiQuery({ name: 'time', required: false, description: 'HH:MM (nécessite date)' })
  @ApiQuery({ name: 'window', required: false })
  @ApiQuery({ name: 'priceMax', required: false })
  @ApiQuery({ name: 'lat', required: false })
  @ApiQuery({ name: 'lng', required: false })
  @ApiQuery({ name: 'radiusKm', required: false })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: ['relevance', 'price_asc', 'rating', 'distance'],
  })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  search(
    @Query(new ZodValidationPipe(searchVenuesQuerySchema)) query: SearchVenuesQuery,
  ): Promise<VenueSearchResponse> {
    return this.venues.search(query);
  }

  @Get('venues/:slug')
  @RateLimit(publicRate)
  @ApiOperation({
    summary: 'Fiche d’un complexe : terrains, horaires, équipements, prix « à partir de »',
  })
  detail(@Param('slug', new ZodValidationPipe(slugSchema)) slug: string): Promise<VenueDetail> {
    return this.venues.getBySlug(slug);
  }

  @Get('venues/:slug/availability')
  @RateLimit(publicRate)
  @ApiOperation({ summary: 'Créneaux d’un jour pour tous les terrains d’un complexe' })
  @ApiQuery({ name: 'date', required: true, description: 'AAAA-MM-JJ (jour de service)' })
  venueAvailability(
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
    @Query(new ZodValidationPipe(availabilityQuerySchema)) query: AvailabilityQuery,
  ): Promise<DayAvailability> {
    return this.venues.getVenueAvailability(slug, query.date);
  }

  @Get('fields/:fieldId/availability')
  @RateLimit(publicRate)
  @ApiOperation({ summary: 'Créneaux d’un jour pour un terrain' })
  @ApiQuery({ name: 'date', required: true, description: 'AAAA-MM-JJ (jour de service)' })
  fieldAvailability(
    @Param('fieldId', new ZodValidationPipe(z.uuid())) fieldId: string,
    @Query(new ZodValidationPipe(availabilityQuerySchema)) query: AvailabilityQuery,
  ): Promise<DayAvailability> {
    return this.venues.getFieldAvailability(fieldId, query.date);
  }
}
