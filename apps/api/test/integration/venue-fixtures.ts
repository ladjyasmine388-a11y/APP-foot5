import { randomBytes } from 'node:crypto';
import type { BookingStatus, BookingType, VenueStatus } from '../../src/generated/prisma/client.js';
import { addDays, localToUtc, todayIn } from '../../src/common/time/zoned-time.js';
import { parseTime } from '@footfive/shared';
import { addMinutes, bookingData, prisma } from './helpers.js';

export const TZ = 'Africa/Algiers';

/** Date de service dans `n` jours (heure d'Alger). Les tests visent le futur : jamais de créneau « passé ». */
export const dayIn = (n: number): string => addDays(todayIn(TZ), n);

/** Instant UTC d'un créneau « date + HH:MM » en heure d'Alger. */
export function slotAt(date: string, hhmm: string): Date {
  const minutes = parseTime(hhmm);
  if (minutes === null) throw new Error(`Heure invalide : ${hhmm}`);
  return localToUtc(date, minutes, TZ);
}

const uniq = (): string => randomBytes(3).toString('hex');

export interface VenueSpec {
  name?: string;
  city?: string;
  district?: string | null;
  status?: VenueStatus;
  latitude?: number | null;
  longitude?: number | null;
  amenities?: string[];
  ratingAvg?: number;
  ratingCount?: number;
  photos?: string[];
  /** Plage d'ouverture appliquée à tous les jours, en minutes de service. Défaut : 10:00 → 23:00. */
  hours?: { from: number; to: number } | null;
}

export async function createVenue(spec: VenueSpec = {}) {
  const name = spec.name ?? `Complexe ${uniq()}`;
  const venue = await prisma.venue.create({
    data: {
      name,
      slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${uniq()}`,
      city: spec.city ?? 'Alger',
      district: spec.district ?? null,
      address: '1 rue du Test',
      status: spec.status ?? 'APPROVED',
      latitude: spec.latitude ?? null,
      longitude: spec.longitude ?? null,
      amenities: spec.amenities ?? [],
      ratingAvg: spec.ratingAvg ?? 0,
      ratingCount: spec.ratingCount ?? 0,
      photos: spec.photos ?? [],
    },
  });
  const hours = spec.hours === undefined ? { from: 600, to: 1380 } : spec.hours;
  if (hours) {
    await prisma.openingHour.createMany({
      data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        venueId: venue.id,
        weekday,
        opensAtMin: hours.from,
        closesAtMin: hours.to,
      })),
    });
  }
  return venue;
}

export interface RuleSpec {
  priceMinor: number;
  startMin?: number;
  endMin?: number;
  priority?: number;
  weekdays?: number[];
  isActive?: boolean;
}

export interface FieldSpec {
  name?: string;
  capacity?: number;
  isActive?: boolean;
  slotDurationMin?: number;
  /** Défaut : 4000 DA toute la journée. `[]` = aucun tarif (créneaux non vendables). */
  rules?: RuleSpec[];
}

export async function createField(venueId: string, spec: FieldSpec = {}) {
  const field = await prisma.field.create({
    data: {
      venueId,
      name: spec.name ?? `Terrain ${uniq()}`,
      capacity: spec.capacity ?? 10,
      isActive: spec.isActive ?? true,
      slotDurationMin: spec.slotDurationMin ?? 60,
    },
  });
  const rules = spec.rules ?? [{ priceMinor: 4000 }];
  if (rules.length > 0) {
    await prisma.pricingRule.createMany({
      data: rules.map((r) => ({
        fieldId: field.id,
        priceMinor: r.priceMinor,
        startMin: r.startMin ?? 0,
        endMin: r.endMin ?? 1800,
        priority: r.priority ?? 0,
        weekdays: r.weekdays ?? [1, 2, 3, 4, 5, 6, 7],
        isActive: r.isActive ?? true,
      })),
    });
  }
  return field;
}

/** Complexe + terrains en une ligne. */
export async function createVenueWithFields(venue: VenueSpec = {}, fields: FieldSpec[] = [{}]) {
  const v = await createVenue(venue);
  const created = [];
  for (const f of fields) created.push(await createField(v.id, f));
  return { venue: v, fields: created };
}

/** Insère directement une réservation (ou un blocage) sur un créneau « date + HH:MM ». */
export async function book(
  ids: { fieldId: string; venueId: string },
  date: string,
  hhmm: string,
  options: {
    status?: BookingStatus;
    type?: BookingType;
    minutes?: number;
    holdExpiresAt?: Date;
    userId?: string;
  } = {},
) {
  const data = bookingData(ids, {
    start: slotAt(date, hhmm),
    status: options.status ?? 'CONFIRMED',
    bookingType: options.type,
    minutes: options.minutes,
    userId: options.userId,
  });
  if (options.holdExpiresAt) data.holdExpiresAt = options.holdExpiresAt;
  return prisma.booking.create({ data });
}

export const inMinutes = (n: number): Date => addMinutes(new Date(), n);
