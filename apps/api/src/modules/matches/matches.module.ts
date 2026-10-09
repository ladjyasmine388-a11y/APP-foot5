import { Module } from '@nestjs/common';
import { TeamsModule } from '../teams/teams.module.js';
import { MatchesController } from './matches.controller.js';
import { MatchesService } from './matches.service.js';
import { SocialMaintenanceService } from './social-maintenance.service.js';

@Module({
  imports: [TeamsModule],
  controllers: [MatchesController],
  providers: [MatchesService, SocialMaintenanceService],
  exports: [MatchesService, SocialMaintenanceService],
})
export class MatchesModule {}
