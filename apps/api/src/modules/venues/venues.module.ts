import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module.js';
import { VenueStaffController } from './venue-staff.controller.js';
import { VenueStaffService } from './venue-staff.service.js';
import { VenuesManageController } from './venues-manage.controller.js';
import { VenuesManageService } from './venues-manage.service.js';
import { VenuesPublicController } from './venues-public.controller.js';
import { VenuesPublicService } from './venues-public.service.js';

@Module({
  imports: [AvailabilityModule],
  controllers: [VenuesPublicController, VenuesManageController, VenueStaffController],
  providers: [VenuesPublicService, VenuesManageService, VenueStaffService],
  exports: [VenuesPublicService, VenuesManageService],
})
export class VenuesModule {}
