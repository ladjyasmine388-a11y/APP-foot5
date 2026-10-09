import type { DepositPolicy } from '@footfive/shared';

/**
 * CALCULS FINANCIERS D'UNE RÉSERVATION — fonctions pures, entiers uniquement (DZD, sans flottants).
 *
 * Ils ne s'exécutent QUE sur le serveur : un client ne peut jamais influencer un prix, une commission
 * ou un acompte. Le résultat est figé dans la réservation (snapshot) ; modifier plus tard une règle de
 * commission ne réécrit donc jamais l'historique.
 *
 * Les invariants ci-dessous sont aussi imposés par des contraintes CHECK en base (migration `db_guarantees`) :
 * même un bug ici ne pourrait pas enregistrer un montant incohérent.
 */

export interface CommissionTerms {
  /** Points de base : 100 = 1 %. */
  rateBps: number;
  /** Commission fixe ajoutée (DZD). */
  fixedMinor: number;
}

export type AmountsPaymentMode = 'DEPOSIT' | 'FULL_ONLINE' | 'ON_SITE';

export interface BookingAmounts {
  basePriceMinor: number;
  commissionRateBps: number;
  commissionFixedMinor: number;
  commissionMinor: number;
  /** Part de la plateforme = commission + frais de service. */
  platformAmountMinor: number;
  /** Part du complexe = prix du terrain − commission. */
  venueAmountMinor: number;
  feesMinor: number;
  taxMinor: number;
  /** Ce que le client paie au total = prix + frais + taxes. */
  totalMinor: number;
  /** À payer en ligne tout de suite. */
  dueOnlineMinor: number;
  /** À régler sur place. */
  dueOnSiteMinor: number;
}

export interface ComputeAmountsInput {
  basePriceMinor: number;
  commission: CommissionTerms;
  paymentMode: AmountsPaymentMode;
  deposit: DepositPolicy;
  feesMinor?: number;
  taxMinor?: number;
}

const BPS = 10_000;

function assertMoney(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} doit être un entier positif ou nul (reçu : ${value})`);
  }
}

/** Division entière arrondie à l'inférieur. */
const floorDiv = (a: number, b: number): number => Math.floor(a / b);
/** Division entière arrondie au supérieur, sans passer par un flottant intermédiaire. */
const ceilDiv = (a: number, b: number): number => Math.floor((a + b - 1) / b);

/**
 * Commission = ⌊prix × taux⌋ + fixe, plafonnée au prix du terrain.
 * L'arrondi est à l'INFÉRIEUR : le reliquat revient au complexe (jamais un centime pris en trop).
 * Exemple : 4 000 DA à 1 % → 40 DA ; 3 333 DA à 1 % → 33 DA (et non 33,33).
 */
export function computeCommission(basePriceMinor: number, terms: CommissionTerms): number {
  assertMoney('basePriceMinor', basePriceMinor);
  assertMoney('rateBps', terms.rateBps);
  assertMoney('fixedMinor', terms.fixedMinor);
  if (terms.rateBps > BPS) throw new RangeError('rateBps ne peut pas dépasser 10 000 (100 %)');
  return Math.min(basePriceMinor, floorDiv(basePriceMinor * terms.rateBps, BPS) + terms.fixedMinor);
}

/**
 * Acompte à payer en ligne (mode DEPOSIT).
 * Pourcentage (arrondi au supérieur) ou montant fixe, avec un plancher, mais TOUJOURS au moins la part de la
 * plateforme — sinon la commission ne serait pas encaissée — et JAMAIS plus que le total.
 */
export function computeDeposit(
  policy: DepositPolicy,
  totalMinor: number,
  platformAmountMinor: number,
): number {
  assertMoney('totalMinor', totalMinor);
  assertMoney('platformAmountMinor', platformAmountMinor);
  const requested =
    policy.mode === 'PERCENT' ? ceilDiv(totalMinor * policy.rateBps, BPS) : policy.fixedMinor;
  return Math.min(totalMinor, Math.max(requested, policy.minMinor, platformAmountMinor));
}

export function computeBookingAmounts(input: ComputeAmountsInput): BookingAmounts {
  const feesMinor = input.feesMinor ?? 0;
  const taxMinor = input.taxMinor ?? 0;
  assertMoney('basePriceMinor', input.basePriceMinor);
  assertMoney('feesMinor', feesMinor);
  assertMoney('taxMinor', taxMinor);

  const commissionMinor = computeCommission(input.basePriceMinor, input.commission);
  const platformAmountMinor = commissionMinor + feesMinor;
  const venueAmountMinor = input.basePriceMinor - commissionMinor;
  const totalMinor = input.basePriceMinor + feesMinor + taxMinor;

  let dueOnlineMinor: number;
  switch (input.paymentMode) {
    case 'FULL_ONLINE':
      dueOnlineMinor = totalMinor;
      break;
    case 'ON_SITE':
      dueOnlineMinor = 0;
      break;
    case 'DEPOSIT':
      dueOnlineMinor = computeDeposit(input.deposit, totalMinor, platformAmountMinor);
      break;
  }

  return {
    basePriceMinor: input.basePriceMinor,
    commissionRateBps: input.commission.rateBps,
    commissionFixedMinor: input.commission.fixedMinor,
    commissionMinor,
    platformAmountMinor,
    venueAmountMinor,
    feesMinor,
    taxMinor,
    totalMinor,
    dueOnlineMinor,
    dueOnSiteMinor: totalMinor - dueOnlineMinor,
  };
}

/** Montants d'une réservation saisie par le complexe : aucune commission, tout se règle sur place. */
export function computeManualAmounts(basePriceMinor: number): BookingAmounts {
  return computeBookingAmounts({
    basePriceMinor,
    commission: { rateBps: 0, fixedMinor: 0 },
    paymentMode: 'ON_SITE',
    deposit: { mode: 'FIXED', rateBps: 0, fixedMinor: 0, minMinor: 0 },
  });
}
