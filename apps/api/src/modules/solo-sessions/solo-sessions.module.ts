import { Module } from '@nestjs/common';
import { SoloSessionsController } from './solo-sessions.controller.js';
import { SoloSessionsService } from './solo-sessions.service.js';

@Module({
  controllers: [SoloSessionsController],
  providers: [SoloSessionsService],
  exports: [SoloSessionsService],
})
export class SoloSessionsModule {}
