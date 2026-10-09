import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Valeurs par défaut INDISPENSABLES au fonctionnement de la plateforme (présentes dans tous les environnements).
 * Idempotent : peut être rejoué sans créer de doublon ni écraser une valeur déjà modifiée par l'admin.
 *
 * Rien ici n'est "en dur" dans le code métier : ce sont des DONNÉES que l'admin modifie ensuite.
 */
export const BASELINE_SETTINGS = {
  /** Durée du verrou temporaire pendant le paiement. */
  'booking.hold_minutes': 10,
  /** Préavis minimal (minutes) entre maintenant et le début d'un créneau réservable. */
  'booking.min_lead_minutes': 30,
  /** Horizon de réservation : nombre de jours à l'avance au maximum. */
  'booking.max_days_ahead': 60,
  /** Réservations simultanées en attente de paiement par utilisateur (anti-accaparement de créneaux). */
  'booking.max_active_holds': 3,
  /** Acompte par défaut demandé en ligne : mode et valeurs à définir avec le prestataire de paiement. */
  'booking.default_deposit': { mode: 'PERCENT', rateBps: 2000, fixedMinor: 0, minMinor: 0 },
  /** Politique d'annulation par défaut (à préciser avec le métier). */
  'booking.default_cancellation_policy': { freeUntilHoursBefore: 24, refundDeposit: false },
} as const;

/** Commission globale initiale : 1 % (100 points de base), modifiable par l'admin. */
export const DEFAULT_GLOBAL_COMMISSION_BPS = 100;

export async function seedBaseline(prisma: PrismaClient): Promise<void> {
  for (const [key, value] of Object.entries(BASELINE_SETTINGS)) {
    await prisma.platformSetting.upsert({
      where: { key },
      create: { key, value },
      update: {}, // ne jamais écraser une valeur déjà réglée par l'admin
    });
  }

  const existing = await prisma.commissionRule.findFirst({
    where: { scope: 'GLOBAL', isActive: true, validTo: null },
  });
  if (!existing) {
    await prisma.commissionRule.create({
      data: { scope: 'GLOBAL', rateBps: DEFAULT_GLOBAL_COMMISSION_BPS, fixedMinor: 0 },
    });
  }
}
