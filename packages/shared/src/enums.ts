/**
 * Énumérations métier partagées entre l'API, le web et le futur mobile.
 *
 * Source de vérité des VALEURS : le schéma Prisma (apps/api/prisma/schema.prisma).
 * Un test (apps/api) vérifie que ces listes restent synchronisées avec Prisma.
 */

/** Rôle global du compte. Les rôles "capitaine" et "staff complexe" sont contextuels (TeamMember / VenueStaff). */
export const PLATFORM_ROLES = ['USER', 'ADMIN'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const USER_STATUSES = ['ACTIVE', 'BLOCKED', 'DELETED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const PLAYER_LEVELS = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'] as const;
export type PlayerLevel = (typeof PLAYER_LEVELS)[number];

export const PLAYER_POSITIONS = ['GOALKEEPER', 'DEFENDER', 'MIDFIELDER', 'FORWARD', 'ANY'] as const;
export type PlayerPosition = (typeof PLAYER_POSITIONS)[number];

export const VENUE_STAFF_ROLES = ['OWNER', 'MANAGER', 'STAFF'] as const;
export type VenueStaffRole = (typeof VENUE_STAFF_ROLES)[number];

export const TEAM_MEMBER_ROLES = ['CAPTAIN', 'MEMBER'] as const;
export type TeamMemberRole = (typeof TEAM_MEMBER_ROLES)[number];

export const VENUE_STATUSES = ['PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED'] as const;
export type VenueStatus = (typeof VENUE_STATUSES)[number];

/**
 * Statuts persistés d'une réservation.
 * "AVAILABLE" n'existe pas en base : c'est l'absence de réservation active sur le créneau.
 * Le verrou temporaire (hold) = PENDING_PAYMENT + holdExpiresAt.
 */
export const BOOKING_STATUSES = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'CANCELLED',
  'COMPLETED',
  'EXPIRED',
  'NO_SHOW',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Réservation « vivante » : verrou en cours ou confirmée (à venir). */
export const BOOKING_ACTIVE_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED'] as const;

/**
 * Statuts qui OCCUPENT le créneau : couverts par la contrainte d'exclusion PostgreSQL.
 * Seuls CANCELLED et EXPIRED libèrent le terrain ; un créneau passé (COMPLETED, NO_SHOW) reste occupé.
 */
export const BOOKING_OCCUPYING_STATUSES = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'COMPLETED',
  'NO_SHOW',
] as const;

/** BLOCK = créneau rendu indisponible par le complexe (sans client ni montant). */
export const BOOKING_TYPES = ['STANDARD', 'SOLO_SESSION', 'OPPONENT_MATCH', 'BLOCK'] as const;
export type BookingType = (typeof BOOKING_TYPES)[number];

export const FIELD_SURFACES = ['ARTIFICIAL_TURF', 'NATURAL_GRASS', 'HARD_COURT', 'OTHER'] as const;
export type FieldSurface = (typeof FIELD_SURFACES)[number];

export const INVITATION_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const PAYMENT_KINDS = ['DEPOSIT', 'BALANCE', 'FULL'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const REFUND_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const COMMISSION_SCOPES = ['GLOBAL', 'VENUE', 'BOOKING_TYPE'] as const;
export type CommissionScope = (typeof COMMISSION_SCOPES)[number];

export const SOLO_SESSION_ORIGINS = ['PLAYER', 'VENUE'] as const;
export type SoloSessionOrigin = (typeof SOLO_SESSION_ORIGINS)[number];

export const SOLO_PLAYER_STATUSES = ['JOINED', 'LEFT', 'NO_SHOW'] as const;
export type SoloPlayerStatus = (typeof SOLO_PLAYER_STATUSES)[number];

export const MATCH_SOURCES = ['TEAM', 'SOLO_SESSION', 'OPPONENT_LISTING'] as const;
export type MatchSource = (typeof MATCH_SOURCES)[number];

export const MATCH_STATUSES = ['SCHEDULED', 'CANCELLED', 'COMPLETED'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const TEAM_SIDES = ['A', 'B', 'NONE'] as const;
export type TeamSide = (typeof TEAM_SIDES)[number];

export const NOTIFICATION_TYPES = [
  'BOOKING_CONFIRMED',
  'PAYMENT_CONFIRMED',
  'BOOKING_CANCELLED',
  'BOOKING_EXPIRED',
  'REFUND_PROCESSED',
  'SOLO_ALMOST_FULL',
  'SOLO_FULL',
  'SOLO_CANCELLED',
  'TEAM_INVITATION_RECEIVED',
  'TEAM_INVITATION_ACCEPTED',
  'OPPONENT_REQUEST_RECEIVED',
  'OPPONENT_ACCEPTED',
  'OPPONENT_REJECTED',
  'MATCH_CANCELLED',
  'MATCH_REMINDER',
  'VENUE_APPROVED',
  'VENUE_SUSPENDED',
  'VENUE_REJECTED',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const BOOKING_SOURCES = ['WEB', 'MOBILE', 'VENUE_MANUAL', 'ADMIN'] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

export const PAYMENT_MODES = ['DEPOSIT', 'FULL_ONLINE', 'ON_SITE'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const PAYMENT_STATUSES = [
  'INITIATED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const SOLO_SESSION_STATUSES = [
  'OPEN',
  'FULL',
  'CONFIRMED',
  'CANCELLED',
  'COMPLETED',
] as const;
export type SoloSessionStatus = (typeof SOLO_SESSION_STATUSES)[number];

export const OPPONENT_LISTING_STATUSES = [
  'OPEN',
  'ACCEPTED',
  'CANCELLED',
  'COMPLETED',
  'EXPIRED',
] as const;
export type OpponentListingStatus = (typeof OPPONENT_LISTING_STATUSES)[number];

export const MATCH_REQUEST_STATUSES = ['REQUESTED', 'ACCEPTED', 'REJECTED', 'CANCELLED'] as const;
export type MatchRequestStatus = (typeof MATCH_REQUEST_STATUSES)[number];

export const LOCALES = ['ar', 'fr', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'fr';

/** Devise unique du MVP. Tous les montants sont des entiers en unité mineure (le DZD n'a pas de sous-unité courante). */
export const CURRENCY = 'DZD' as const;
export const DEFAULT_TIMEZONE = 'Africa/Algiers' as const;
