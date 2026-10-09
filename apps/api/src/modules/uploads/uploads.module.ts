import { Module } from '@nestjs/common';
import { TeamsModule } from '../teams/teams.module.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

@Module({
  imports: [TeamsModule],
  controllers: [UploadsController],
  providers: [UploadsService],
})
export class UploadsModule {}
