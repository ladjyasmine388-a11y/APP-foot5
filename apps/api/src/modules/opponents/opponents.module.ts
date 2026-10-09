import { Module } from '@nestjs/common';
import { MatchesModule } from '../matches/matches.module.js';
import { TeamsModule } from '../teams/teams.module.js';
import { OpponentsController } from './opponents.controller.js';
import { OpponentsService } from './opponents.service.js';

@Module({
  imports: [TeamsModule, MatchesModule],
  controllers: [OpponentsController],
  providers: [OpponentsService],
})
export class OpponentsModule {}
