import { Module } from '@nestjs/common';
import { AvailabilityService } from './availability.service.js';

@Module({ providers: [AvailabilityService], exports: [AvailabilityService] })
export class AvailabilityModule {}
