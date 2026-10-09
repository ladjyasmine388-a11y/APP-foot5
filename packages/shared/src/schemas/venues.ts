import { z } from 'zod';
import { FIELD_SURFACES, type VenueStatus } from '../enums';
import { rangesOverlap, toMinuteRange } from '../time';
import { citySchema, phoneSchema } from './primitives';

// ───────────────────────── Primitives ─────────────────────────

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const timeSchema = z.string().regex(HHMM, 'Format attendu : HH:MM (ex. 20:30)');

/** Date calendaire `AAAA-MM-JJ` (31 février refusé). */
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format attendu : AAAA-MM-JJ')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Date invalide');

/** Jour ISO : 1 = lundi … 7 = dimanche. */
export const weekdaySchema = z.number().int().min(1).max(7);

const timezoneSchema = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('fr', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Fuseau horaire inconnu (ex. Africa/Algiers)');

const amenitySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u, 'Caractères non autorisés');

export const amenitiesSchema = z
  .array(amenitySchema)
  .max(30)
  .transform((list) => [...new Set(list)]);

const latitudeSchema = z.number().min(-90).max(90);
const longitudeSchema = z.number().min(-180).max(180);

// ───────────────────────── Complexe ─────────────────────────

/** Politique d'annulation : gratuite jusqu'à N heures avant, ensuite l'acompte reste acquis (ou non). */
export const cancellationPolicySchema = z
  .object({
    freeUntilHoursBefore: z.number().int().min(0).max(720),
    refundDeposit: z.boolean(),
  })
  .strict();
export type CancellationPolicy = z.infer<typeof cancellationPolicySchema>;

const venueBase = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(2000).nullable(),
  city: citySchema,
  /** Quartier. */
  district: z.string().trim().min(1).max(80).nullable(),
  address: z.string().trim().min(3).max(200),
  latitude: latitudeSchema.nullable(),
  longitude: longitudeSchema.nullable(),
  phone: phoneSchema.nullable(),
  amenities: amenitiesSchema,
});

const coordinatesTogether = (v: { latitude?: number | null; longitude?: number | null }) =>
  (v.latitude === undefined || v.latitude === null) ===
  (v.longitude === undefined || v.longitude === null);
const coordinatesMessage = { path: ['latitude'], message: 'Latitude et longitude vont ensemble' };

export const createVenueSchema = venueBase
  .partial({
    description: true,
    district: true,
    latitude: true,
    longitude: true,
    phone: true,
    amenities: true,
  })
  .extend({ timezone: timezoneSchema.default('Africa/Algiers') })
  .strict()
  .refine(coordinatesTogether, coordinatesMessage);
export type CreateVenueInput = z.infer<typeof createVenueSchema>;

/** Le fuseau horaire n'est pas modifiable : il fixe l'interprétation de tous les horaires existants. */
export const updateVenueSchema = venueBase
  .partial()
  .extend({ cancellationPolicy: cancellationPolicySchema.nullable().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Aucune modification fournie' })
  .refine(coordinatesTogether, coordinatesMessage);
export type UpdateVenueInput = z.infer<typeof updateVenueSchema>;

// ───────────────────────── Terrain ─────────────────────────

/** 10 joueurs (petit terrain, 5v5) à 16 joueurs (grand terrain, 8v8). */
export const FIELD_MIN_CAPACITY = 10;
export const FIELD_MAX_CAPACITY = 16;

const fieldBase = z.object({
  name: z.string().trim().min(1).max(60),
  capacity: z.number().int().min(FIELD_MIN_CAPACITY).max(FIELD_MAX_CAPACITY),
  dimensions: z.string().trim().max(40).nullable(),
  surface: z.enum(FIELD_SURFACES),
  lighting: z.boolean(),
  covered: z.boolean(),
  description: z.string().trim().max(1000).nullable(),
  /** Durée d'un créneau en minutes (MVP : 60), multiple de 30. */
  slotDurationMin: z.number().int().min(30).max(240).multipleOf(30),
});

export const createFieldSchema = fieldBase
  .partial({
    dimensions: true,
    surface: true,
    lighting: true,
    covered: true,
    description: true,
    slotDurationMin: true,
  })
  .strict();
export type CreateFieldInput = z.infer<typeof createFieldSchema>;

export const updateFieldSchema = fieldBase
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Aucune modification fournie' });
export type UpdateFieldInput = z.infer<typeof updateFieldSchema>;

// ───────────────────────── Horaires ─────────────────────────

const intervalInput = z.object({ from: timeSchema, to: timeSchema }).strict();

/**
 * Horaires hebdomadaires. Remplace TOUT : les jours absents sont fermés. `to` ≤ `from` signifie le lendemain
 * (ex. 10:00 → 02:00). Les plages d'un même jour ne peuvent pas se chevaucher.
 */
export const openingHoursSchema = z
  .object({
    days: z
      .array(
        z
          .object({ weekday: weekdaySchema, intervals: z.array(intervalInput).min(1).max(4) })
          .strict(),
      )
      .max(7),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<number>();
    value.days.forEach((day, dayIndex) => {
      if (seen.has(day.weekday)) {
        ctx.addIssue({
          code: 'custom',
          path: ['days', dayIndex, 'weekday'],
          message: 'Jour en double',
        });
      }
      seen.add(day.weekday);

      const ranges = day.intervals.map((i) => toMinuteRange(i.from, i.to));
      ranges.forEach((range, i) => {
        if (!range) {
          ctx.addIssue({
            code: 'custom',
            path: ['days', dayIndex, 'intervals', i],
            message: 'Plage invalide (début = fin, ou fermeture après 06:00 le lendemain)',
          });
        }
      });
      for (let a = 0; a < ranges.length; a++) {
        for (let b = a + 1; b < ranges.length; b++) {
          const ra = ranges[a];
          const rb = ranges[b];
          if (ra && rb && rangesOverlap(ra, rb)) {
            ctx.addIssue({
              code: 'custom',
              path: ['days', dayIndex, 'intervals', b],
              message: 'Cette plage chevauche une autre plage du même jour',
            });
          }
        }
      }
    });
  });
export type OpeningHoursInput = z.infer<typeof openingHoursSchema>;

// ───────────────────────── Tarifs ─────────────────────────

/** Prix maximal d'un créneau accepté (garde-fou contre une faute de frappe : 400 000 au lieu de 4 000). */
export const MAX_SLOT_PRICE_MINOR = 100_000;

const pricingRuleBase = z
  .object({
    weekdays: z
      .array(weekdaySchema)
      .min(1)
      .max(7)
      .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
    from: timeSchema,
    to: timeSchema,
    /** Prix du créneau en DZD (entier). */
    priceMinor: z.number().int().min(1).max(MAX_SLOT_PRICE_MINOR),
    /** À chevauchement, la règle de plus haute priorité l'emporte. */
    priority: z.number().int().min(0).max(100),
    validFrom: dateSchema.nullable(),
    validTo: dateSchema.nullable(),
    isActive: z.boolean(),
  })
  .strict();

const rangeIsValid = (v: { from?: string; to?: string }) =>
  v.from === undefined || v.to === undefined || toMinuteRange(v.from, v.to) !== null;
const rangeMessage = {
  path: ['to'],
  message: 'Plage invalide (début = fin, ou fin après 06:00 le lendemain)',
};
const validityIsValid = (v: { validFrom?: string | null; validTo?: string | null }) =>
  !v.validFrom || !v.validTo || v.validTo >= v.validFrom;
const validityMessage = { path: ['validTo'], message: 'La fin de validité précède le début' };

export const createPricingRuleSchema = pricingRuleBase
  .partial({ priority: true, validFrom: true, validTo: true, isActive: true })
  .refine(rangeIsValid, rangeMessage)
  .refine(validityIsValid, validityMessage);
export type CreatePricingRuleInput = z.infer<typeof createPricingRuleSchema>;

export const updatePricingRuleSchema = pricingRuleBase
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Aucune modification fournie' })
  .refine(rangeIsValid, rangeMessage)
  .refine(validityIsValid, validityMessage);
export type UpdatePricingRuleInput = z.infer<typeof updatePricingRuleSchema>;

// ───────────────────────── Recherche et disponibilités ─────────────────────────

export const VENUE_SORTS = ['relevance', 'price_asc', 'rating', 'distance'] as const;
export type VenueSort = (typeof VENUE_SORTS)[number];

const optionalString = (max: number) => z.string().trim().min(1).max(max).optional();

/** Paramètres de la recherche de complexes (chaînes de requête → types). */
export const searchVenuesQuerySchema = z
  .object({
    city: optionalString(80),
    district: optionalString(80),
    /** Recherche par nom. */
    q: optionalString(100),
    /** Équipements exigés, séparés par des virgules : `parking,douches`. */
    amenities: z
      .string()
      .max(300)
      .optional()
      .transform((value) =>
        value
          ? [
              ...new Set(
                value
                  .split(',')
                  .map((a) => a.trim().toLowerCase())
                  .filter(Boolean),
              ),
            ].slice(0, 10)
          : [],
      ),
    /** Nombre de joueurs : seuls les terrains pouvant les accueillir sont retenus. */
    players: z.coerce.number().int().min(2).max(FIELD_MAX_CAPACITY).optional(),
    date: dateSchema.optional(),
    /** Heure de début souhaitée (nécessite `date`). */
    time: timeSchema.optional(),
    /** Tolérance en minutes autour de `time` (0 = heure exacte). */
    window: z.coerce.number().int().min(0).max(720).default(0),
    /** Prix maximal d'un créneau, en DZD. */
    priceMax: z.coerce.number().int().min(1).max(MAX_SLOT_PRICE_MINOR).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusKm: z.coerce.number().min(0.5).max(500).optional(),
    sort: z.enum(VENUE_SORTS).default('relevance'),
    limit: z.coerce.number().int().min(1).max(50).default(12),
    cursor: z.string().max(100).optional(),
  })
  .strict()
  .refine((v) => !v.time || v.date, { path: ['time'], message: 'L’heure nécessite une date' })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    path: ['lat'],
    message: 'lat et lng vont ensemble',
  })
  .refine((v) => !v.radiusKm || v.lat !== undefined, {
    path: ['radiusKm'],
    message: 'Le rayon nécessite lat et lng',
  })
  .refine((v) => v.sort !== 'distance' || v.lat !== undefined, {
    path: ['sort'],
    message: 'Le tri par distance nécessite lat et lng',
  });
export type SearchVenuesQuery = z.infer<typeof searchVenuesQuerySchema>;

export const availabilityQuerySchema = z.object({ date: dateSchema }).strict();
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

// ───────────────────────── Réponses ─────────────────────────

/** Vue publique d'un créneau : la raison d'indisponibilité n'est pas divulguée (réservation, blocage ou passé). */
export type PublicSlotStatus = 'AVAILABLE' | 'HELD' | 'UNAVAILABLE';

/** Vue complète (complexe, admin). */
export type SlotStatus = 'AVAILABLE' | 'HELD' | 'BOOKED' | 'BLOCKED' | 'PAST' | 'NO_PRICE';

export interface PublicSlot {
  startsAt: string;
  endsAt: string;
  priceMinor: number | null;
  status: PublicSlotStatus;
}

export interface ManageSlot extends Omit<PublicSlot, 'status'> {
  status: SlotStatus;
}

export interface FieldDayAvailability<S = PublicSlot> {
  fieldId: string;
  name: string;
  capacity: number;
  slotDurationMin: number;
  slots: S[];
}

export interface DayAvailability<S = PublicSlot> {
  date: string;
  timezone: string;
  fields: FieldDayAvailability<S>[];
}

export interface FieldPublic {
  id: string;
  name: string;
  capacity: number;
  dimensions: string | null;
  surface: (typeof FIELD_SURFACES)[number];
  lighting: boolean;
  covered: boolean;
  photos: string[];
  description: string | null;
  slotDurationMin: number;
  priceFromMinor: number | null;
}

export interface VenueCard {
  id: string;
  slug: string;
  name: string;
  city: string;
  district: string | null;
  address: string;
  latitude: number | null;
  longitude: number | null;
  photo: string | null;
  fieldsCount: number;
  /** Prix « à partir de » d'un créneau, en DZD. */
  priceFromMinor: number | null;
  amenities: string[];
  ratingAvg: number;
  ratingCount: number;
  distanceKm: number | null;
  /** Renseignés quand la recherche contient une date : nombre de créneaux correspondants et le premier. */
  matchingSlots: number | null;
  firstMatchingSlotAt: string | null;
}

export interface VenueSearchResponse {
  items: VenueCard[];
  nextCursor: string | null;
  total: number;
}

export interface OpeningHoursDayView {
  weekday: number;
  intervals: { from: string; to: string; overnight: boolean }[];
}

export interface VenueDetail extends Omit<
  VenueCard,
  'fieldsCount' | 'matchingSlots' | 'firstMatchingSlotAt'
> {
  description: string | null;
  phone: string | null;
  timezone: string;
  photos: string[];
  openingHours: OpeningHoursDayView[];
  fields: FieldPublic[];
}

// ───────────────────────── Réponses du back-office complexe ─────────────────────────

export interface PricingRuleView {
  id: string;
  fieldId: string;
  weekdays: number[];
  from: string;
  to: string;
  overnight: boolean;
  priceMinor: number;
  priority: number;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
}

export interface ManageFieldView extends FieldPublic {
  isActive: boolean;
  /** Horaires PROPRES au terrain (vide = il suit les horaires du complexe). */
  openingHours: OpeningHoursDayView[];
  pricingRules: PricingRuleView[];
}

export interface ManageVenueSummary {
  id: string;
  slug: string;
  name: string;
  city: string;
  status: VenueStatus;
  /** Rôle de l'utilisateur dans ce complexe. */
  role: 'OWNER' | 'MANAGER' | 'STAFF' | 'ADMIN';
  fieldsCount: number;
}

export interface ManageVenueDetail {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  city: string;
  district: string | null;
  address: string;
  latitude: number | null;
  longitude: number | null;
  phone: string | null;
  timezone: string;
  amenities: string[];
  photos: string[];
  status: VenueStatus;
  cancellationPolicy: CancellationPolicy | null;
  role: 'OWNER' | 'MANAGER' | 'STAFF' | 'ADMIN';
  /** Horaires du complexe. */
  openingHours: OpeningHoursDayView[];
  fields: ManageFieldView[];
}
