-- Refus d'un complexe par l'administration (distinct d'une suspension : il n'a jamais été visible).
ALTER TYPE "VenueStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

ALTER TABLE "Venue" ADD COLUMN "statusReason" TEXT;
ALTER TABLE "Venue" ADD COLUMN "statusChangedAt" TIMESTAMPTZ(3);
