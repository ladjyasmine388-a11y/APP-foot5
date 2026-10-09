-- ============================================================================
-- Garanties d'intégrité que Prisma ne sait pas exprimer.
-- Elles vivent dans la base : elles tiennent même si le code applicatif a un bug,
-- si un script d'administration écrit en SQL, ou si deux requêtes arrivent en même temps.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. ANTI-DOUBLE-RÉSERVATION
--    Deux réservations qui occupent le même terrain ne peuvent jamais se chevaucher.
--    Plage semi-ouverte [début, fin) : un créneau 20:00–21:00 et un créneau 21:00–22:00 sont compatibles.
--    Seuls CANCELLED et EXPIRED libèrent le créneau.
--    Un blocage du complexe (bookingType = BLOCK) est une ligne de la même table :
--    il est donc protégé par cette même contrainte.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_no_overlap"
  EXCLUDE USING gist (
    "fieldId" WITH =,
    tstzrange("startsAt", "endsAt", '[)') WITH &&
  )
  WHERE ("status" IN ('PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'NO_SHOW'));

-- Le job d'expiration ne scanne que les verrous en cours.
CREATE INDEX "Booking_hold_expiry_idx" ON "Booking" ("holdExpiresAt") WHERE "status" = 'PENDING_PAYMENT';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. COHÉRENCE DES RÉSERVATIONS ET DES MONTANTS
--    Même si un bug applicatif calculait mal, la base refuse d'enregistrer un état incohérent.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_time_range_chk" CHECK ("endsAt" > "startsAt"),
  ADD CONSTRAINT "Booking_money_nonneg_chk" CHECK (
    "basePriceMinor" >= 0 AND "commissionRateBps" >= 0 AND "commissionFixedMinor" >= 0
    AND "commissionMinor" >= 0 AND "platformAmountMinor" >= 0 AND "venueAmountMinor" >= 0
    AND "feesMinor" >= 0 AND "taxMinor" >= 0 AND "totalMinor" >= 0
    AND "dueOnlineMinor" >= 0 AND "dueOnSiteMinor" >= 0
  ),
  ADD CONSTRAINT "Booking_rate_range_chk" CHECK ("commissionRateBps" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "Booking_commission_le_base_chk" CHECK ("commissionMinor" <= "basePriceMinor"),
  ADD CONSTRAINT "Booking_venue_share_chk" CHECK ("venueAmountMinor" = "basePriceMinor" - "commissionMinor"),
  ADD CONSTRAINT "Booking_platform_share_chk" CHECK ("platformAmountMinor" = "commissionMinor" + "feesMinor"),
  ADD CONSTRAINT "Booking_total_chk" CHECK ("totalMinor" = "basePriceMinor" + "feesMinor" + "taxMinor"),
  ADD CONSTRAINT "Booking_split_chk" CHECK ("dueOnlineMinor" + "dueOnSiteMinor" = "totalMinor"),
  -- Un verrou (hold) sans date d'expiration resterait bloqué pour toujours.
  ADD CONSTRAINT "Booking_hold_needs_expiry_chk" CHECK ("status" <> 'PENDING_PAYMENT' OR "holdExpiresAt" IS NOT NULL),
  -- Un blocage n'a ni client ni montant.
  ADD CONSTRAINT "Booking_block_shape_chk" CHECK (
    "bookingType" <> 'BLOCK' OR ("userId" IS NULL AND "totalMinor" = 0 AND "dueOnlineMinor" = 0)
  ),
  -- Toute vraie réservation a un client (compte) ou au moins un nom (client sans compte, saisie par le complexe).
  ADD CONSTRAINT "Booking_has_customer_chk" CHECK (
    "bookingType" = 'BLOCK' OR "userId" IS NOT NULL OR "customerName" IS NOT NULL
  ),
  ADD CONSTRAINT "Booking_currency_chk" CHECK (char_length("currency") = 3);

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_amount_chk" CHECK ("amountMinor" > 0);

ALTER TABLE "Refund"
  ADD CONSTRAINT "Refund_amount_chk" CHECK ("amountMinor" > 0);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. COMMISSION : une seule règle ACTIVE par portée
--    (sinon deux taux possibles pour une même réservation = ambiguïté financière)
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "CommissionRule"
  ADD CONSTRAINT "CommissionRule_rate_chk" CHECK ("rateBps" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "CommissionRule_fixed_chk" CHECK ("fixedMinor" >= 0),
  ADD CONSTRAINT "CommissionRule_scope_chk" CHECK (
    ("scope" = 'GLOBAL'       AND "venueId" IS NULL     AND "bookingType" IS NULL) OR
    ("scope" = 'VENUE'        AND "venueId" IS NOT NULL AND "bookingType" IS NULL) OR
    ("scope" = 'BOOKING_TYPE' AND "venueId" IS NULL     AND "bookingType" IS NOT NULL)
  );

CREATE UNIQUE INDEX "CommissionRule_one_active_global_idx"
  ON "CommissionRule" ("scope") WHERE "scope" = 'GLOBAL' AND "isActive" AND "validTo" IS NULL;
CREATE UNIQUE INDEX "CommissionRule_one_active_venue_idx"
  ON "CommissionRule" ("venueId") WHERE "scope" = 'VENUE' AND "isActive" AND "validTo" IS NULL;
CREATE UNIQUE INDEX "CommissionRule_one_active_type_idx"
  ON "CommissionRule" ("bookingType") WHERE "scope" = 'BOOKING_TYPE' AND "isActive" AND "validTo" IS NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. OFFRE : horaires, tarifs, terrains
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "Field"
  -- 10 joueurs (petit terrain, 5v5) à 16 joueurs (grand terrain, 8v8).
  ADD CONSTRAINT "Field_capacity_chk" CHECK ("capacity" BETWEEN 10 AND 16),
  ADD CONSTRAINT "Field_slot_duration_chk" CHECK ("slotDurationMin" BETWEEN 30 AND 240 AND "slotDurationMin" % 30 = 0);

ALTER TABLE "OpeningHour"
  ADD CONSTRAINT "OpeningHour_weekday_chk" CHECK ("weekday" BETWEEN 1 AND 7),
  -- closesAtMin jusqu'à 1800 (= 06:00 le lendemain) pour les fermetures après minuit.
  ADD CONSTRAINT "OpeningHour_range_chk" CHECK (
    "opensAtMin" >= 0 AND "opensAtMin" < 1440 AND "closesAtMin" > "opensAtMin" AND "closesAtMin" <= 1800
  );

ALTER TABLE "PricingRule"
  ADD CONSTRAINT "PricingRule_price_chk" CHECK ("priceMinor" >= 0),
  ADD CONSTRAINT "PricingRule_range_chk" CHECK (
    "startMin" >= 0 AND "startMin" < 1440 AND "endMin" > "startMin" AND "endMin" <= 1800
  ),
  ADD CONSTRAINT "PricingRule_weekdays_chk" CHECK (
    cardinality("weekdays") > 0 AND "weekdays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
  ),
  ADD CONSTRAINT "PricingRule_validity_chk" CHECK ("validTo" IS NULL OR "validFrom" IS NULL OR "validTo" >= "validFrom");

-- ───────────────────────────────────────────────────────────────────────────
-- 5. UTILISATEURS
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "User"
  -- Un email en majuscules créerait un doublon invisible de "Yas@x.com" / "yas@x.com".
  ADD CONSTRAINT "User_email_lowercase_chk" CHECK ("email" = lower("email")),
  ADD CONSTRAINT "User_locale_chk" CHECK ("locale" IN ('ar', 'fr', 'en'));

ALTER TABLE "PlayerStats"
  ADD CONSTRAINT "PlayerStats_score_chk" CHECK ("reliabilityScore" BETWEEN 0 AND 100),
  ADD CONSTRAINT "PlayerStats_counts_chk" CHECK ("matchesPlayed" >= 0 AND "noShowCount" >= 0 AND "lateCancelCount" >= 0);

ALTER TABLE "Review"
  ADD CONSTRAINT "Review_rating_chk" CHECK ("rating" BETWEEN 1 AND 5);

-- ───────────────────────────────────────────────────────────────────────────
-- 6. ÉQUIPES
-- ───────────────────────────────────────────────────────────────────────────
-- Un joueur n'est membre ACTIF qu'une seule fois d'une même équipe.
CREATE UNIQUE INDEX "TeamMember_one_active_idx" ON "TeamMember" ("teamId", "userId") WHERE "leftAt" IS NULL;
-- Une équipe a exactement un capitaine actif.
CREATE UNIQUE INDEX "TeamMember_one_captain_idx" ON "TeamMember" ("teamId") WHERE "role" = 'CAPTAIN' AND "leftAt" IS NULL;

ALTER TABLE "TeamInvitation"
  ADD CONSTRAINT "TeamInvitation_invitee_chk" CHECK ("inviteeId" IS NOT NULL OR "inviteeEmail" IS NOT NULL);
-- Pas deux invitations en attente pour le même joueur dans la même équipe.
CREATE UNIQUE INDEX "TeamInvitation_one_pending_idx"
  ON "TeamInvitation" ("teamId", "inviteeId") WHERE "status" = 'PENDING' AND "inviteeId" IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. SESSIONS "COMPLÉTEZ VOTRE ÉQUIPE"
--    joinedCount ∈ [0, capacity] : le surbooking est impossible, même en cas de bug de concurrence.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "SoloSession"
  ADD CONSTRAINT "SoloSession_capacity_chk" CHECK ("capacity" BETWEEN 1 AND 16),
  ADD CONSTRAINT "SoloSession_joined_chk" CHECK ("joinedCount" BETWEEN 0 AND "capacity"),
  ADD CONSTRAINT "SoloSession_min_players_chk" CHECK ("minPlayers" IS NULL OR "minPlayers" BETWEEN 1 AND "capacity"),
  ADD CONSTRAINT "SoloSession_price_chk" CHECK ("pricePerPlayerMinor" >= 0),
  ADD CONSTRAINT "SoloSession_time_chk" CHECK ("endsAt" > "startsAt");

-- ───────────────────────────────────────────────────────────────────────────
-- 8. ADVERSAIRES ET MATCHS
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "OpponentListing"
  ADD CONSTRAINT "OpponentListing_players_chk" CHECK ("playersPerSide" BETWEEN 5 AND 8);

-- Une annonce n'a jamais plus d'UN adversaire accepté.
CREATE UNIQUE INDEX "MatchRequest_one_accepted_idx" ON "MatchRequest" ("listingId") WHERE "status" = 'ACCEPTED';
-- Une équipe n'a pas deux demandes en attente sur la même annonce.
CREATE UNIQUE INDEX "MatchRequest_one_active_per_team_idx"
  ON "MatchRequest" ("listingId", "requestingTeamId") WHERE "status" = 'REQUESTED';

ALTER TABLE "Match"
  ADD CONSTRAINT "Match_time_chk" CHECK ("endsAt" > "startsAt"),
  ADD CONSTRAINT "Match_teams_differ_chk" CHECK ("teamAId" IS NULL OR "teamBId" IS NULL OR "teamAId" <> "teamBId"),
  ADD CONSTRAINT "Match_score_chk" CHECK (
    ("scoreA" IS NULL OR "scoreA" >= 0) AND ("scoreB" IS NULL OR "scoreB" >= 0)
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 9. AUDIT IMMUABLE
--    Un journal modifiable n'est pas un journal. UPDATE et DELETE sont interdits pour tous les rôles
--    (y compris le propriétaire de la table). Seul INSERT est possible.
-- ───────────────────────────────────────────────────────────────────────────
CREATE FUNCTION "audit_log_forbid_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog est immuable : % interdit', TG_OP USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER "AuditLog_immutable"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_forbid_mutation"();
