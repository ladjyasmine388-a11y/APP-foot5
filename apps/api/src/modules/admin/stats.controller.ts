import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type PlayerStats, type StatsQuery, type VenueStats, statsQuerySchema } from '@footfive/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { StatsService } from './stats.service.js';

@ApiTags('Tableaux de bord')
@ApiBearerAuth()
@Controller()
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('me/stats')
  @ApiOperation({ summary: 'Mon tableau de bord de joueur (fiabilité, matchs joués, à venir, équipes, notifications)' })
  player(@CurrentUser() user: AuthUser): Promise<PlayerStats> {
    return this.stats.player(user);
  }

  @Get('manage/venues/:venueId/stats')
  @ApiOperation({ summary: 'Tableau de bord d’un complexe sur une période (gérant) : réservations, revenus, commission, heures, no-shows' })
  venue(
    @CurrentUser() user: AuthUser,
    @Param('venueId', new ZodValidationPipe(z.uuid())) venueId: string,
    @Query(new ZodValidationPipe(statsQuerySchema)) query: StatsQuery,
  ): Promise<VenueStats> {
    return this.stats.venue(user, venueId, query);
  }
}
