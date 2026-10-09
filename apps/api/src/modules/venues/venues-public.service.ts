import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type DayAvailability,
  type FieldPublic,
  type SearchVenuesQuery,
  type VenueCard,
  type VenueDetail,
  type VenueSearchResponse,
  DEFAULT_TIMEZONE,
  parseTime,
} from '@footfive/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import {
  AvailabilityService,
  type FieldInputs,
  toPublicSlots,
} from '../availability/availability.service.js';
import type { ComputedSlot } from '../availability/availability.engine.js';
import { SettingsService } from '../settings/settings.service.js';
import { haversineKm, minPrice, toOpeningHoursView } from './venue.mappers.js';

/** Au-delà, la recherche en mémoire devient coûteuse : à ce stade il faudra précalculer (voir docs/ARCHITECTURE). */
const MAX_CANDIDATES = 300;

type Candidate = Prisma.VenueGetPayload<{ select: ReturnType<typeof candidateSelect> }>;

function candidateSelect(fieldWhere: Prisma.FieldWhereInput) {
  return {
    id: true,
    slug: true,
    name: true,
    city: true,
    district: true,
    address: true,
    latitude: true,
    longitude: true,
    photos: true,
    amenities: true,
    ratingAvg: true,
    ratingCount: true,
    timezone: true,
    openingHours: true,
    fields: {
      where: fieldWhere,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        capacity: true,
        slotDurationMin: true,
        pricingRules: { where: { isActive: true } },
      },
    },
  } satisfies Prisma.VenueSelect;
}

@Injectable()
export class VenuesPublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly settings: SettingsService,
  ) {}

  // ───────────────────────── Recherche ─────────────────────────

  async search(query: SearchVenuesQuery, now: Date = new Date()): Promise<VenueSearchResponse> {
    const offset = decodeCursor(query.cursor);
    const fieldWhere: Prisma.FieldWhereInput = {
      isActive: true,
      ...(query.players ? { capacity: { gte: query.players } } : {}),
    };

    const where: Prisma.VenueWhereInput = {
      status: 'APPROVED',
      ...(query.city ? { city: { equals: query.city, mode: 'insensitive' } } : {}),
      ...(query.district ? { district: { equals: query.district, mode: 'insensitive' } } : {}),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
      ...(query.amenities.length > 0 ? { amenities: { hasEvery: query.amenities } } : {}),
      // Un complexe sans terrain actif (ou sans terrain assez grand) n'a rien à proposer.
      fields: { some: fieldWhere },
    };

    const candidates = await this.prisma.venue.findMany({
      where,
      take: MAX_CANDIDATES,
      select: candidateSelect(fieldWhere),
    });

    // 1. Disponibilité réelle pour la date demandée
    const slotsByField = query.date ? await this.slotsForDate(candidates, query.date, now) : null;

    // 2. Cartes + filtres
    const timeMin = query.time ? parseTime(query.time) : null;
    const matchesSlot = (slot: ComputedSlot): boolean =>
      slot.status === 'AVAILABLE' &&
      (query.priceMax === undefined ||
        (slot.priceMinor !== null && slot.priceMinor <= query.priceMax)) &&
      (timeMin === null ||
        // Un créneau après minuit (01:00 = 1500 min) se retrouve aussi en tapant « 01:00 ».
        [timeMin, timeMin + 1440].some((t) => Math.abs(slot.startMin - t) <= query.window));

    const cards: VenueCard[] = [];
    for (const venue of candidates) {
      const priceFromMinor = minPrice(venue.fields.flatMap((f) => f.pricingRules));
      let matchingSlots: number | null = null;
      let firstMatchingSlotAt: string | null = null;

      if (slotsByField) {
        const matching = venue.fields
          .flatMap((f) => slotsByField.get(f.id) ?? [])
          .filter(matchesSlot)
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
        if (matching.length === 0) continue; // rien de réservable correspondant à la recherche
        matchingSlots = matching.length;
        firstMatchingSlotAt = (matching[0] as ComputedSlot).startsAt.toISOString();
      } else if (
        query.priceMax !== undefined &&
        (priceFromMinor === null || priceFromMinor > query.priceMax)
      ) {
        continue;
      }

      const distanceKm =
        query.lat !== undefined &&
        query.lng !== undefined &&
        venue.latitude !== null &&
        venue.longitude !== null
          ? Math.round(haversineKm(query.lat, query.lng, venue.latitude, venue.longitude) * 10) / 10
          : null;
      if (query.radiusKm !== undefined && (distanceKm === null || distanceKm > query.radiusKm))
        continue;

      cards.push({
        id: venue.id,
        slug: venue.slug,
        name: venue.name,
        city: venue.city,
        district: venue.district,
        address: venue.address,
        latitude: venue.latitude,
        longitude: venue.longitude,
        photo: venue.photos[0] ?? null,
        fieldsCount: venue.fields.length,
        priceFromMinor,
        amenities: venue.amenities,
        ratingAvg: venue.ratingAvg,
        ratingCount: venue.ratingCount,
        distanceKm,
        matchingSlots,
        firstMatchingSlotAt,
      });
    }

    // 3. Tri puis pagination
    cards.sort(comparatorFor(query.sort));
    const items = cards.slice(offset, offset + query.limit);
    const next = offset + query.limit;
    return {
      items,
      nextCursor: next < cards.length ? encodeCursor(next) : null,
      total: cards.length,
    };
  }

  private async slotsForDate(
    venues: readonly Candidate[],
    date: string,
    now: Date,
  ): Promise<Map<string, ComputedSlot[]>> {
    await this.availability.assertDateInRange(date, DEFAULT_TIMEZONE, now);
    const minLeadMinutes = await this.settings.getInt('booking.min_lead_minutes', 30);
    return this.availability.computeBatch(
      venues.map((v) => ({
        fields: v.fields as FieldInputs[],
        hours: v.openingHours,
        timeZone: v.timezone,
      })),
      { date, now, minLeadMinutes },
    );
  }

  // ───────────────────────── Fiche d'un complexe ─────────────────────────

  async getBySlug(slug: string): Promise<VenueDetail> {
    const venue = await this.prisma.venue.findFirst({
      where: { slug, status: 'APPROVED' },
      include: {
        openingHours: { where: { fieldId: null } },
        fields: {
          where: { isActive: true },
          orderBy: { name: 'asc' },
          include: { pricingRules: { where: { isActive: true } } },
        },
      },
    });
    // PENDING et SUSPENDED sont invisibles du public : même réponse qu'un complexe inexistant.
    if (!venue) throw Errors.notFound('Complexe introuvable');

    const fields: FieldPublic[] = venue.fields.map((f) => ({
      id: f.id,
      name: f.name,
      capacity: f.capacity,
      dimensions: f.dimensions,
      surface: f.surface,
      lighting: f.lighting,
      covered: f.covered,
      photos: f.photos,
      description: f.description,
      slotDurationMin: f.slotDurationMin,
      priceFromMinor: minPrice(f.pricingRules),
    }));

    return {
      id: venue.id,
      slug: venue.slug,
      name: venue.name,
      description: venue.description,
      city: venue.city,
      district: venue.district,
      address: venue.address,
      latitude: venue.latitude,
      longitude: venue.longitude,
      phone: venue.phone,
      timezone: venue.timezone,
      photo: venue.photos[0] ?? null,
      photos: venue.photos,
      amenities: venue.amenities,
      ratingAvg: venue.ratingAvg,
      ratingCount: venue.ratingCount,
      priceFromMinor: minPrice(venue.fields.flatMap((f) => f.pricingRules)),
      distanceKm: null,
      openingHours: toOpeningHoursView(venue.openingHours),
      fields,
    };
  }

  // ───────────────────────── Disponibilités ─────────────────────────

  async getVenueAvailability(slug: string, date: string): Promise<DayAvailability> {
    const venue = await this.prisma.venue.findFirst({
      where: { slug, status: 'APPROVED' },
      select: { id: true, timezone: true },
    });
    if (!venue) throw Errors.notFound('Complexe introuvable');
    return this.dayFor(venue.id, venue.timezone, date);
  }

  async getFieldAvailability(fieldId: string, date: string): Promise<DayAvailability> {
    const field = await this.prisma.field.findFirst({
      where: { id: fieldId, isActive: true, venue: { status: 'APPROVED' } },
      select: { id: true, venueId: true, venue: { select: { timezone: true } } },
    });
    if (!field) throw Errors.notFound('Terrain introuvable');
    return this.dayFor(field.venueId, field.venue.timezone, date, field.id);
  }

  private async dayFor(
    venueId: string,
    timezone: string,
    date: string,
    fieldId?: string,
  ): Promise<DayAvailability> {
    await this.availability.assertDateInRange(date, timezone);
    const day = await this.availability.getVenueDay(venueId, date, { fieldId });
    if (!day) throw new AppException('NOT_FOUND', HttpStatus.NOT_FOUND, 'Complexe introuvable');
    return {
      date,
      timezone: day.timezone,
      fields: day.fields.map(({ field, slots }) => ({
        fieldId: field.id,
        name: field.name,
        capacity: field.capacity,
        slotDurationMin: field.slotDurationMin,
        slots: toPublicSlots(slots),
      })),
    };
  }
}

// ───────────────────────── Aides ─────────────────────────

function comparatorFor(sort: SearchVenuesQuery['sort']): (a: VenueCard, b: VenueCard) => number {
  const byRelevance = (a: VenueCard, b: VenueCard): number =>
    b.ratingAvg - a.ratingAvg ||
    b.ratingCount - a.ratingCount ||
    a.name.localeCompare(b.name, 'fr');
  const nullsLast = (a: number | null, b: number | null): number =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b;

  switch (sort) {
    case 'price_asc':
      return (a, b) => nullsLast(a.priceFromMinor, b.priceFromMinor) || byRelevance(a, b);
    case 'distance':
      return (a, b) => nullsLast(a.distanceKm, b.distanceKm) || byRelevance(a, b);
    case 'rating':
      return (a, b) =>
        b.ratingAvg - a.ratingAvg ||
        b.ratingCount - a.ratingCount ||
        a.name.localeCompare(b.name, 'fr');
    default:
      return byRelevance;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { o?: unknown };
    if (typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0)
      return parsed.o;
  } catch {
    /* tombe sur l'erreur ci-dessous */
  }
  throw new AppException(
    'VALIDATION_ERROR',
    HttpStatus.BAD_REQUEST,
    'Curseur de pagination invalide',
  );
}
