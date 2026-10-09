-- Rappel de match : colonne revendiquée atomiquement (UPDATE … WHERE "reminderSentAt" IS NULL) pour n'envoyer qu'UN rappel.
ALTER TABLE "Match" ADD COLUMN "reminderSentAt" TIMESTAMPTZ(3);

-- Les rappels n'examinent que les matchs à venir non encore rappelés.
CREATE INDEX "Match_reminder_idx" ON "Match" ("startsAt") WHERE "status" = 'SCHEDULED' AND "reminderSentAt" IS NULL;

-- Une notification de rappel par match et par joueur, quoi qu'il arrive (filet de sécurité en base).
CREATE UNIQUE INDEX "Notification_match_reminder_unique_idx"
  ON "Notification" ("userId", (("payload"->>'matchId')))
  WHERE "type" = 'MATCH_REMINDER';
