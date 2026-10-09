import { z } from 'zod';
import { PLATFORM_ROLES, USER_STATUSES, VENUE_STATUSES, VENUE_STAFF_ROLES } from '../enums';
import { depositPolicySchema } from './bookings';
import { citySchema, emailSchema } from './primitives';
import { cancellationPolicySchema, dateSchema } from './venues';

const page = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(100).optional(),
};
const reason = z.string().trim().min(3).max(500);

// ───────────────────────── Complexes ─────────────────────────

export const adminListVenuesQuerySchema = z
  .object({ status: z.enum(VENUE_STATUSES).optional(), q: z.string().trim().min(1).max(80).optional(), city: citySchema.optional(), ...page })
  .strict();
export type AdminListVenuesQuery = z.infer<typeof adminListVenuesQuerySchema>;

/** Approuver ou rétablir : le motif est facultatif. */
export const venueApprovalSchema = z.object({ reason: reason.optional() }).strict();
/** Refuser ou suspendre : le gérant doit savoir pourquoi. */
export const venueRejectionSchema = z.object({ reason }).strict();
export type VenueApprovalInput = z.infer<typeof venueApprovalSchema>;
export type VenueRejectionInput = z.infer<typeof venueRejectionSchema>;

/** `null` : retour à la règle par défaut de la plateforme. */
export const setVenueDepositPolicySchema = z.object({ depositPolicy: depositPolicySchema.nullable() }).strict();
export type SetVenueDepositPolicyInput = z.infer<typeof setVenueDepositPolicySchema>;

// ───────────────────────── Utilisateurs ─────────────────────────

export const adminListUsersQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(80).optional(),
    status: z.enum(USER_STATUSES).optional(),
    role: z.enum(PLATFORM_ROLES).optional(),
    ...page,
  })
  .strict();
export type AdminListUsersQuery = z.infer<typeof adminListUsersQuerySchema>;

export const blockUserSchema = z.object({ reason }).strict();
export type BlockUserInput = z.infer<typeof blockUserSchema>;

// ───────────────────────── Commission et paramètres ─────────────────────────

/** 30 % au plus : un taux saisi par erreur (ex. 100 au lieu de 1) ne doit pas pouvoir ruiner les gérants. */
export const MAX_COMMISSION_BPS = 3000;
export const MAX_COMMISSION_FIXED_MINOR = 100_000;

export const setCommissionSchema = z
  .object({
    rateBps: z.number().int().min(0).max(MAX_COMMISSION_BPS),
    fixedMinor: z.number().int().min(0).max(MAX_COMMISSION_FIXED_MINOR).default(0),
    reason: reason.optional(),
  })
  .strict();
export type SetCommissionInput = z.infer<typeof setCommissionSchema>;

/** Paramètres modifiables par l'administration, avec leur validation : une clé inconnue est refusée. */
export const SETTING_SCHEMAS = {
  'booking.hold_minutes': z.number().int().min(1).max(60),
  'booking.min_lead_minutes': z.number().int().min(0).max(1440),
  'booking.max_days_ahead': z.number().int().min(1).max(365),
  'booking.max_active_holds': z.number().int().min(1).max(10),
  'booking.default_deposit': depositPolicySchema,
  'booking.default_cancellation_policy': cancellationPolicySchema,
} as const;
export type SettingKey = keyof typeof SETTING_SCHEMAS;
export const SETTING_KEYS = Object.keys(SETTING_SCHEMAS) as SettingKey[];

export const updateSettingSchema = z.object({ value: z.unknown() }).strict();

// ───────────────────────── Remboursements, avis ─────────────────────────

export const adminListRefundsQuerySchema = z
  .object({ status: z.enum(['REQUESTED', 'APPROVED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REJECTED']).optional(), ...page })
  .strict();
export type AdminListRefundsQuery = z.infer<typeof adminListRefundsQuerySchema>;

export const adminRefundBookingSchema = z.object({ reason }).strict();
export type AdminRefundBookingInput = z.infer<typeof adminRefundBookingSchema>;

export const moderateReviewSchema = z.object({ reason }).strict();
export type ModerateReviewInput = z.infer<typeof moderateReviewSchema>;

export const adminListReviewsQuerySchema = z
  .object({ hidden: z.stringbool().optional(), venueId: z.uuid().optional(), ...page })
  .strict();
export type AdminListReviewsQuery = z.infer<typeof adminListReviewsQuerySchema>;

// ───────────────────────── Statistiques et audit ─────────────────────────

/** Période (jours de service inclusifs, 366 jours au plus). */
export const statsQuerySchema = z
  .object({ from: dateSchema, to: dateSchema })
  .strict()
  .refine((v) => v.from <= v.to, { path: ['to'], message: 'La fin doit suivre le début' })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 366, { path: ['to'], message: 'Période de 366 jours au maximum' });
export type StatsQuery = z.infer<typeof statsQuerySchema>;

export const auditQuerySchema = z
  .object({
    action: z.string().trim().min(1).max(80).optional(),
    entityType: z.string().trim().min(1).max(40).optional(),
    entityId: z.uuid().optional(),
    actorId: z.uuid().optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    ...page,
  })
  .strict();
export type AuditQuery = z.infer<typeof auditQuerySchema>;

// ───────────────────────── Personnel d'un complexe ─────────────────────────

export const addStaffSchema = z.object({ email: emailSchema, role: z.enum(VENUE_STAFF_ROLES).default('STAFF') }).strict();
export type AddStaffInput = z.infer<typeof addStaffSchema>;
export const updateStaffSchema = z.object({ role: z.enum(VENUE_STAFF_ROLES) }).strict();
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;

// ───────────────────────── Réponses ─────────────────────────

export interface AdminVenueView {
  id: string;
  slug: string;
  name: string;
  city: string;
  district: string | null;
  address: string;
  status: (typeof VENUE_STATUSES)[number];
  statusReason: string | null;
  statusChangedAt: string | null;
  fieldCount: number;
  owners: { id: string; name: string; email: string; phone: string }[];
  depositPolicy: unknown;
  commission: { rateBps: number; fixedMinor: number; scope: 'GLOBAL' | 'VENUE' | 'BOOKING_TYPE' };
  ratingAvg: number;
  ratingCount: number;
  createdAt: string;
}

export interface AdminUserView {
  id: string;
  email: string;
  emailVerified: boolean;
  phone: string;
  firstName: string;
  lastName: string;
  city: string | null;
  platformRole: (typeof PLATFORM_ROLES)[number];
  status: (typeof USER_STATUSES)[number];
  matchesPlayed: number;
  reliabilityScore: number;
  noShowCount: number;
  createdAt: string;
}

export interface CommissionRuleView {
  id: string;
  scope: 'GLOBAL' | 'VENUE' | 'BOOKING_TYPE';
  venueId: string | null;
  rateBps: number;
  fixedMinor: number;
  validFrom: string;
  validTo: string | null;
  isActive: boolean;
}

export interface AdminRefundView {
  id: string;
  bookingId: string;
  reference: string;
  amountMinor: number;
  status: string;
  reason: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface AdminReviewView {
  id: string;
  venue: { id: string; name: string };
  rating: number;
  comment: string | null;
  author: string;
  hidden: boolean;
  createdAt: string;
}

export interface AuditLogView {
  id: string;
  actorId: string | null;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  createdAt: string;
}

export interface DailyPoint {
  date: string;
  bookings: number;
  revenueMinor: number;
}

export interface VenueStats {
  from: string;
  to: string;
  bookings: { total: number; confirmed: number; completed: number; cancelled: number; noShow: number };
  /** Heures réellement réservées (créneaux confirmés ou joués). */
  bookedHours: number;
  /** Prix des terrains réservés (hors réservations annulées). */
  grossMinor: number;
  commissionMinor: number;
  /** Part du complexe : brut − commission. */
  netMinor: number;
  /** Encaissé en ligne (acomptes) et solde à régler sur place. */
  onlineMinor: number;
  onSiteMinor: number;
  noShowRate: number;
  daily: DailyPoint[];
  byHour: { hour: number; bookings: number }[];
  byField: { fieldId: string; name: string; bookings: number; grossMinor: number }[];
}

export interface AdminStats {
  from: string;
  to: string;
  users: { total: number; newInPeriod: number; blocked: number };
  venues: { total: number; pending: number; approved: number; suspended: number; rejected: number };
  bookings: { total: number; confirmed: number; completed: number; cancelled: number; expired: number; noShow: number };
  grossMinor: number;
  commissionMinor: number;
  refundedMinor: number;
  pendingRefunds: number;
  failedRefunds: number;
  matches: { scheduled: number; completed: number };
  daily: DailyPoint[];
  topVenues: { venueId: string; name: string; bookings: number; grossMinor: number }[];
}

export interface PlayerStats {
  matchesPlayed: number;
  noShowCount: number;
  lateCancelCount: number;
  reliabilityScore: number;
  upcomingBookings: number;
  upcomingMatches: number;
  teams: number;
  unreadNotifications: number;
}

export interface StaffMemberView {
  userId: string;
  name: string;
  email: string;
  role: (typeof VENUE_STAFF_ROLES)[number];
  createdAt: string;
}
