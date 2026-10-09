import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module.js';
import { BookingPricingService } from './booking-pricing.service.js';
import { BookingWriter } from './booking-writer.service.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsMaintenanceService } from './bookings-maintenance.service.js';
import { BookingsService } from './bookings.service.js';
import { IdempotencyService } from './idempotency.service.js';
import { RefundsService } from './refunds.service.js';
import { VenueBookingsController } from './venue-bookings.controller.js';
import { VenueBookingsService } from './venue-bookings.service.js';

@Module({
  imports: [AvailabilityModule],
  controllers: [BookingsController, VenueBookingsController],
  providers: [
    BookingsService,
    VenueBookingsService,
    BookingsMaintenanceService,
    BookingPricingService,
    BookingWriter,
    IdempotencyService,
    RefundsService,
  ],
  exports: [
    BookingsService,
    BookingPricingService,
    BookingWriter,
    IdempotencyService,
    RefundsService,
    BookingsMaintenanceService,
  ],
})
export class BookingsModule {}
