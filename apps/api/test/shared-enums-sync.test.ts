import * as shared from '@footfive/shared';
import { describe, expect, it } from 'vitest';
import * as prismaEnums from '../src/generated/prisma/enums.js';

/**
 * Les enums sont définis dans le schéma Prisma (source de vérité) ET exposés au web/mobile via
 * @footfive/shared. Ce test empêche toute divergence silencieuse entre les deux.
 */
const pairs = {
  PlatformRole: shared.PLATFORM_ROLES,
  UserStatus: shared.USER_STATUSES,
  PlayerLevel: shared.PLAYER_LEVELS,
  PlayerPosition: shared.PLAYER_POSITIONS,
  VenueStaffRole: shared.VENUE_STAFF_ROLES,
  TeamMemberRole: shared.TEAM_MEMBER_ROLES,
  InvitationStatus: shared.INVITATION_STATUSES,
  VenueStatus: shared.VENUE_STATUSES,
  FieldSurface: shared.FIELD_SURFACES,
  BookingStatus: shared.BOOKING_STATUSES,
  BookingSource: shared.BOOKING_SOURCES,
  BookingType: shared.BOOKING_TYPES,
  PaymentMode: shared.PAYMENT_MODES,
  PaymentKind: shared.PAYMENT_KINDS,
  PaymentStatus: shared.PAYMENT_STATUSES,
  RefundStatus: shared.REFUND_STATUSES,
  CommissionScope: shared.COMMISSION_SCOPES,
  SoloSessionOrigin: shared.SOLO_SESSION_ORIGINS,
  SoloSessionStatus: shared.SOLO_SESSION_STATUSES,
  SoloPlayerStatus: shared.SOLO_PLAYER_STATUSES,
  OpponentListingStatus: shared.OPPONENT_LISTING_STATUSES,
  MatchRequestStatus: shared.MATCH_REQUEST_STATUSES,
  MatchSource: shared.MATCH_SOURCES,
  MatchStatus: shared.MATCH_STATUSES,
  TeamSide: shared.TEAM_SIDES,
  NotificationType: shared.NOTIFICATION_TYPES,
} as const;

describe('enums @footfive/shared ↔ schéma Prisma', () => {
  it.each(Object.entries(pairs))('%s est identique des deux côtés', (name, sharedValues) => {
    const prismaEnum = (prismaEnums as Record<string, Record<string, string>>)[name];
    expect(prismaEnum, `enum Prisma "${name}" introuvable`).toBeDefined();
    expect([...sharedValues].sort()).toEqual(Object.values(prismaEnum ?? {}).sort());
  });

  it('les statuts qui occupent un créneau sont exactement ceux de la contrainte SQL', () => {
    // Doit rester aligné avec la clause WHERE de "Booking_no_overlap" (migration db_guarantees).
    expect([...shared.BOOKING_OCCUPYING_STATUSES].sort()).toEqual(
      ['COMPLETED', 'CONFIRMED', 'NO_SHOW', 'PENDING_PAYMENT'].sort(),
    );
    const freeing = shared.BOOKING_STATUSES.filter(
      (s) => !(shared.BOOKING_OCCUPYING_STATUSES as readonly string[]).includes(s),
    );
    expect(freeing.sort()).toEqual(['CANCELLED', 'EXPIRED']);
  });
});
