import { z } from 'zod';
import { BOOKING_STATUSES } from '../enums';
import { phoneSchema } from './primitives';
import { dateSchema } from './venues';

// ───────────────────────── Acompte ─────────────────────────

/**
 * Acompte demandé EN LIGNE à la réservation (le reste se règle sur place).
 * - PERCENT : un pourcentage du total (`rateBps`, 2000 = 20 %) ;
 * - FIXED   : un montant fixe en DZD.
 * `minMinor` est un plancher. Dans tous les cas, l'acompte couvre au moins la part de la plateforme
 * (commission) et ne dépasse jamais le total.
 */
export const depositPolicySchema = z
  .object({
    mode: z.enum(['PERCENT', 'FIXED']),
    rateBps: z.number().int().min(0).max(10_000),
    fixedMinor: z.number().int().min(0).max(100_000),
    minMinor: z.number().int().min(0).max(100_000),
  })
  .strict();
export type DepositPolicy = z.infer<typeof depositPolicySchema>;

// ───────────────────────── Joueur ─────────────────────────

/** Modes de paiement proposés à un joueur en ligne. Le paiement 100 % sur place n'est pas ouvert (la commission ne serait pas encaissée). */
export const ONLINE_PAYMENT_MODES = ['DEPOSIT', 'FULL_ONLINE'] as const;

const isoInstant = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

/** Créneau visé : le début EXACT d'un créneau tel que renvoyé par les disponibilités. */
export const createBookingSchema = z
  .object({
    fieldId: z.uuid(),
    startsAt: isoInstant,
    paymentMode: z.enum(ONLINE_PAYMENT_MODES).default('DEPOSIT'),
  })
  .strict();
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const quoteBookingSchema = createBookingSchema;
export type QuoteBookingInput = CreateBookingInput;

export const cancelBookingSchema = z
  .object({ reason: z.string().trim().min(1).max(300).optional() })
  .strict();
export type CancelBookingInput = z.infer<typeof cancelBookingSchema>;

export const MY_BOOKING_FILTERS = ['upcoming', 'past', 'all'] as const;

export const listMyBookingsQuerySchema = z
  .object({
    when: z.enum(MY_BOOKING_FILTERS).default('upcoming'),
    status: z.enum(BOOKING_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(100).optional(),
  })
  .strict();
export type ListMyBookingsQuery = z.infer<typeof listMyBookingsQuerySchema>;

// ───────────────────────── Complexe ─────────────────────────

/** Réservation saisie par le complexe (téléphone, sur place). Sans commission : elle bloque simplement le créneau. */
export const createManualBookingSchema = z
  .object({
    fieldId: z.uuid(),
    startsAt: isoInstant,
    customerName: z.string().trim().min(1).max(100),
    customerPhone: phoneSchema.optional(),
    note: z.string().trim().min(1).max(500).optional(),
    /** Prix convenu (DZD). Par défaut : le tarif du créneau. Obligatoire si le créneau n'a pas de tarif. */
    priceMinor: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();
export type CreateManualBookingInput = z.infer<typeof createManualBookingSchema>;

/** Blocage d'une période (travaux, événement privé…). Peut couvrir plusieurs créneaux, jusqu'à 31 jours. */
export const MAX_BLOCK_DAYS = 31;
export const createBlockSchema = z
  .object({
    fieldId: z.uuid(),
    startsAt: isoInstant,
    endsAt: isoInstant,
    reason: z.string().trim().min(1).max(300).optional(),
  })
  .strict()
  .refine((v) => v.endsAt > v.startsAt, {
    path: ['endsAt'],
    message: 'La fin doit suivre le début',
  })
  .refine(
    (v) =>
      new Date(v.endsAt).getTime() - new Date(v.startsAt).getTime() <= MAX_BLOCK_DAYS * 86_400_000,
    { path: ['endsAt'], message: `Un blocage ne peut pas dépasser ${MAX_BLOCK_DAYS} jours` },
  );
export type CreateBlockInput = z.infer<typeof createBlockSchema>;

export const MANAGE_BOOKINGS_MAX_DAYS = 62;

/** Calendrier : réservations d'une période de jours de service (bornes incluses). */
export const listManageBookingsQuerySchema = z
  .object({
    from: dateSchema,
    to: dateSchema,
    status: z.enum(BOOKING_STATUSES).optional(),
    fieldId: z.uuid().optional(),
    includeBlocks: z.stringbool().default(true),
  })
  .strict()
  .refine((v) => v.to >= v.from, { path: ['to'], message: 'La fin précède le début' })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 < MANAGE_BOOKINGS_MAX_DAYS, {
    path: ['to'],
    message: `Période limitée à ${MANAGE_BOOKINGS_MAX_DAYS} jours`,
  });
export type ListManageBookingsQuery = z.infer<typeof listManageBookingsQuerySchema>;

export const staffCancelBookingSchema = z
  .object({ reason: z.string().trim().min(1).max(300) })
  .strict();
export type StaffCancelBookingInput = z.infer<typeof staffCancelBookingSchema>;

// ───────────────────────── Réponses ─────────────────────────

export interface BookingQuote {
  fieldId: string;
  fieldName: string;
  venueName: string;
  startsAt: string;
  endsAt: string;
  paymentMode: (typeof ONLINE_PAYMENT_MODES)[number];
  /** Prix du terrain. */
  priceMinor: number;
  feesMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** À payer en ligne maintenant. */
  dueOnlineMinor: number;
  /** À régler sur place. */
  dueOnSiteMinor: number;
  currency: 'DZD';
  /** Durée du verrou de paiement une fois la réservation lancée. */
  holdMinutes: number;
}

export interface CancellationInfo {
  allowed: boolean;
  /** Date limite d'annulation gratuite (ISO), si applicable. */
  freeUntil: string | null;
  /** Une annulation maintenant ouvrirait-elle droit à un remboursement ? */
  refundable: boolean;
}

export interface BookingView {
  id: string;
  /** Référence lisible à communiquer au complexe, ex. FF-7K2M9Q4D. */
  reference: string;
  status: (typeof BOOKING_STATUSES)[number];
  venue: {
    id: string;
    slug: string;
    name: string;
    city: string;
    address: string;
    phone: string | null;
  };
  field: { id: string; name: string };
  startsAt: string;
  endsAt: string;
  paymentMode: 'DEPOSIT' | 'FULL_ONLINE' | 'ON_SITE';
  priceMinor: number;
  feesMinor: number;
  taxMinor: number;
  totalMinor: number;
  dueOnlineMinor: number;
  dueOnSiteMinor: number;
  /** Déjà payé en ligne (paiements confirmés par le serveur). */
  paidOnlineMinor: number;
  currency: 'DZD';
  holdExpiresAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  cancellation: CancellationInfo;
  /** Dernier paiement tenté pour cette réservation (null s'il n'y en a pas). */
  payment: { id: string; status: string; checkoutUrl: string | null } | null;
}

export interface BookingListResponse {
  items: BookingView[];
  nextCursor: string | null;
}

export interface CancelBookingResponse {
  booking: BookingView;
  refund: { eligible: boolean; amountMinor: number };
}

/** Vue du personnel du complexe : contact du client et décomposition financière. */
export interface ManageBookingView {
  id: string;
  reference: string;
  status: (typeof BOOKING_STATUSES)[number];
  bookingType: 'STANDARD' | 'SOLO_SESSION' | 'OPPONENT_MATCH' | 'BLOCK';
  source: 'WEB' | 'MOBILE' | 'VENUE_MANUAL' | 'ADMIN';
  field: { id: string; name: string };
  startsAt: string;
  endsAt: string;
  customer: { name: string; phone: string | null } | null;
  note: string | null;
  paymentMode: 'DEPOSIT' | 'FULL_ONLINE' | 'ON_SITE';
  priceMinor: number;
  totalMinor: number;
  /** Part du complexe (prix moins commission). */
  venueAmountMinor: number;
  /** Commission prélevée par la plateforme. */
  commissionMinor: number;
  dueOnlineMinor: number;
  dueOnSiteMinor: number;
  paidOnlineMinor: number;
  holdExpiresAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
}
