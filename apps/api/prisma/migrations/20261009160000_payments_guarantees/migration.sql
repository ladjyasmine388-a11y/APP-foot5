-- ============================================================================
-- Garanties d'intégrité des paiements.
-- ============================================================================

-- UN SEUL paiement « en cours » (initialisé ou en attente chez le prestataire) par réservation.
-- Sans cette contrainte, un double clic ou deux appareils pourraient ouvrir deux pages de paiement pour la même
-- réservation, et le client pourrait payer deux fois. Les paiements terminés (réussis, échoués, annulés) ne comptent pas :
-- après un échec, un nouvel essai reste possible.
CREATE UNIQUE INDEX "Payment_one_inflight_per_booking_idx"
  ON "Payment" ("bookingId")
  WHERE "status" IN ('INITIATED', 'PENDING');

-- Un paiement réussi a forcément une date de paiement.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_paid_at_chk" CHECK ("status" <> 'SUCCEEDED' OR "paidAt" IS NOT NULL);
