-- ============================================================================
-- Garanties d'intégrité : équipes, adversaires, matchs.
-- ============================================================================

-- Un nom d'équipe désigne UNE équipe active (insensible à la casse) : pas d'usurpation « Les Lions » / « les lions ».
CREATE UNIQUE INDEX "Team_name_unique_idx" ON "Team" (lower("name")) WHERE "deletedAt" IS NULL;

-- Une seule invitation en attente par adresse email et par équipe (le cas « compte existant » est déjà couvert).
CREATE UNIQUE INDEX "TeamInvitation_one_pending_email_idx"
  ON "TeamInvitation" ("teamId", lower("inviteeEmail"))
  WHERE "status" = 'PENDING' AND "inviteeEmail" IS NOT NULL;

-- Un match a une forme cohérente avec son origine.
ALTER TABLE "Match"
  ADD CONSTRAINT "Match_source_shape_chk" CHECK (
    ("source" = 'OPPONENT_LISTING' AND "teamAId" IS NOT NULL AND "teamBId" IS NOT NULL AND "opponentListingId" IS NOT NULL)
    OR ("source" = 'SOLO_SESSION' AND "soloSessionId" IS NOT NULL AND "teamAId" IS NULL AND "teamBId" IS NULL)
    OR ("source" = 'TEAM' AND "teamAId" IS NOT NULL AND "teamBId" IS NULL)
  ),
  -- Un score est toujours complet (les deux équipes) et n'existe que pour un match entre deux équipes.
  ADD CONSTRAINT "Match_score_pair_chk" CHECK (("scoreA" IS NULL) = ("scoreB" IS NULL)),
  ADD CONSTRAINT "Match_score_needs_teams_chk" CHECK (
    "scoreA" IS NULL OR ("teamAId" IS NOT NULL AND "teamBId" IS NOT NULL)
  ),
  ADD CONSTRAINT "Match_players_per_side_chk" CHECK ("playersPerSide" IS NULL OR "playersPerSide" BETWEEN 2 AND 11);
