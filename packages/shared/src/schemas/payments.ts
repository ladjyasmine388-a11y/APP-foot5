import { z } from 'zod';
import { PAYMENT_KINDS, PAYMENT_STATUSES } from '../enums';

/**
 * Lancer le paiement d'une réservation : AUCUN champ. Le montant (l'acompte ou le total à régler en ligne)
 * est celui figé dans la réservation, décidé par le serveur.
 */
export const payBookingSchema = z.object({}).strict();
export type PayBookingInput = z.infer<typeof payBookingSchema>;

export interface PaymentView {
  id: string;
  bookingId: string;
  status: (typeof PAYMENT_STATUSES)[number];
  kind: (typeof PAYMENT_KINDS)[number];
  amountMinor: number;
  currency: 'DZD';
  /** Adresse de la page de paiement du prestataire : fournie tant que le paiement est en attente. */
  checkoutUrl: string | null;
  paidAt: string | null;
  failureReason: string | null;
  createdAt: string;
}
