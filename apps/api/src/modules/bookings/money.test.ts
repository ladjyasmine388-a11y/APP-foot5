import type { DepositPolicy } from '@footfive/shared';
import { describe, expect, it } from 'vitest';
import {
  type AmountsPaymentMode,
  computeBookingAmounts,
  computeCommission,
  computeDeposit,
  computeManualAmounts,
} from './money.js';

const PERCENT_20: DepositPolicy = { mode: 'PERCENT', rateBps: 2000, fixedMinor: 0, minMinor: 0 };
const ONE_PERCENT = { rateBps: 100, fixedMinor: 0 };

describe('computeCommission', () => {
  it('1 % de 4 000 DA = 40 DA (taux initial de la plateforme)', () => {
    expect(computeCommission(4000, ONE_PERCENT)).toBe(40);
  });

  it('exemple du cahier des charges : 10 % de 4 000 DA = 400 DA', () => {
    expect(computeCommission(4000, { rateBps: 1000, fixedMinor: 0 })).toBe(400);
  });

  it('arrondit à l’INFÉRIEUR : le reliquat revient au complexe', () => {
    expect(computeCommission(3333, ONE_PERCENT)).toBe(33);
    expect(computeCommission(3999, ONE_PERCENT)).toBe(39);
    expect(computeCommission(99, ONE_PERCENT)).toBe(0);
  });

  it('ajoute la commission fixe', () => {
    expect(computeCommission(4000, { rateBps: 100, fixedMinor: 25 })).toBe(65);
    expect(computeCommission(4000, { rateBps: 0, fixedMinor: 100 })).toBe(100);
  });

  it('ne dépasse JAMAIS le prix du terrain', () => {
    expect(computeCommission(100, { rateBps: 100, fixedMinor: 500 })).toBe(100);
    expect(computeCommission(100, { rateBps: 10_000, fixedMinor: 50 })).toBe(100);
    expect(computeCommission(0, { rateBps: 100, fixedMinor: 50 })).toBe(0);
  });

  it('taux nul = pas de commission ; 100 % = tout le prix', () => {
    expect(computeCommission(4000, { rateBps: 0, fixedMinor: 0 })).toBe(0);
    expect(computeCommission(4000, { rateBps: 10_000, fixedMinor: 0 })).toBe(4000);
  });

  it.each([
    ['prix négatif', -1, ONE_PERCENT],
    ['prix décimal', 4000.5, ONE_PERCENT],
    ['prix NaN', Number.NaN, ONE_PERCENT],
    ['taux négatif', 4000, { rateBps: -1, fixedMinor: 0 }],
    ['taux > 100 %', 4000, { rateBps: 10_001, fixedMinor: 0 }],
    ['commission fixe décimale', 4000, { rateBps: 100, fixedMinor: 1.5 }],
  ])('refuse une entrée invalide : %s', (_label, base, terms) => {
    expect(() => computeCommission(base, terms)).toThrow(RangeError);
  });
});

describe('computeDeposit', () => {
  it('20 % de 4 000 DA = 800 DA', () => {
    expect(computeDeposit(PERCENT_20, 4000, 40)).toBe(800);
  });

  it('arrondit le pourcentage au SUPÉRIEUR (l’acompte ne peut pas être sous-évalué)', () => {
    expect(computeDeposit(PERCENT_20, 3333, 33)).toBe(667); // 666,6 → 667
    expect(computeDeposit(PERCENT_20, 4001, 40)).toBe(801); // 800,2 → 801
  });

  it('montant fixe', () => {
    expect(
      computeDeposit({ mode: 'FIXED', rateBps: 0, fixedMinor: 500, minMinor: 0 }, 4000, 40),
    ).toBe(500);
  });

  it('respecte le plancher (minMinor)', () => {
    expect(computeDeposit({ ...PERCENT_20, minMinor: 1000 }, 4000, 40)).toBe(1000);
  });

  it('couvre TOUJOURS au moins la part de la plateforme (sinon la commission ne serait pas encaissée)', () => {
    // 1 % d'acompte = 40 DA, mais la plateforme doit toucher 400 DA
    const tiny: DepositPolicy = { mode: 'PERCENT', rateBps: 100, fixedMinor: 0, minMinor: 0 };
    expect(computeDeposit(tiny, 4000, 400)).toBe(400);
    expect(
      computeDeposit({ mode: 'FIXED', rateBps: 0, fixedMinor: 10, minMinor: 0 }, 4000, 400),
    ).toBe(400);
  });

  it('ne dépasse JAMAIS le total, même si le plancher ou la commission le dépassent', () => {
    expect(computeDeposit({ ...PERCENT_20, minMinor: 9000 }, 4000, 40)).toBe(4000);
    expect(
      computeDeposit({ mode: 'FIXED', rateBps: 0, fixedMinor: 9999, minMinor: 0 }, 4000, 40),
    ).toBe(4000);
    expect(computeDeposit(PERCENT_20, 0, 0)).toBe(0);
  });
});

describe('computeBookingAmounts', () => {
  const base = { basePriceMinor: 4000, commission: ONE_PERCENT, deposit: PERCENT_20 };

  it('exemple complet : 4 000 DA, commission 1 %, acompte 20 %', () => {
    expect(computeBookingAmounts({ ...base, paymentMode: 'DEPOSIT' })).toEqual({
      basePriceMinor: 4000,
      commissionRateBps: 100,
      commissionFixedMinor: 0,
      commissionMinor: 40,
      platformAmountMinor: 40,
      venueAmountMinor: 3960,
      feesMinor: 0,
      taxMinor: 0,
      totalMinor: 4000,
      dueOnlineMinor: 800,
      dueOnSiteMinor: 3200,
    });
  });

  it('exemple du cahier des charges (commission 10 %) : plateforme 400 DA, complexe 3 600 DA', () => {
    const amounts = computeBookingAmounts({
      ...base,
      commission: { rateBps: 1000, fixedMinor: 0 },
      paymentMode: 'FULL_ONLINE',
    });
    expect(amounts.commissionMinor).toBe(400);
    expect(amounts.platformAmountMinor).toBe(400);
    expect(amounts.venueAmountMinor).toBe(3600);
  });

  it('paiement 100 % en ligne : tout est dû en ligne', () => {
    const a = computeBookingAmounts({ ...base, paymentMode: 'FULL_ONLINE' });
    expect(a.dueOnlineMinor).toBe(4000);
    expect(a.dueOnSiteMinor).toBe(0);
  });

  it('paiement sur place : rien en ligne', () => {
    const a = computeBookingAmounts({ ...base, paymentMode: 'ON_SITE' });
    expect(a.dueOnlineMinor).toBe(0);
    expect(a.dueOnSiteMinor).toBe(4000);
  });

  it('les frais et taxes s’ajoutent au total payé par le client, les frais vont à la plateforme', () => {
    const a = computeBookingAmounts({
      ...base,
      paymentMode: 'FULL_ONLINE',
      feesMinor: 50,
      taxMinor: 120,
    });
    expect(a.totalMinor).toBe(4170);
    expect(a.platformAmountMinor).toBe(40 + 50);
    expect(a.venueAmountMinor).toBe(3960); // inchangé : les frais ne diminuent pas la part du complexe
    expect(a.dueOnlineMinor).toBe(4170);
  });

  it('un terrain gratuit (0 DA) ne génère aucun montant', () => {
    const a = computeBookingAmounts({ ...base, basePriceMinor: 0, paymentMode: 'DEPOSIT' });
    expect(a).toMatchObject({
      totalMinor: 0,
      commissionMinor: 0,
      venueAmountMinor: 0,
      dueOnlineMinor: 0,
      dueOnSiteMinor: 0,
    });
  });

  it('fige le taux et la commission fixe appliqués (traçabilité)', () => {
    const a = computeBookingAmounts({
      ...base,
      commission: { rateBps: 250, fixedMinor: 10 },
      paymentMode: 'DEPOSIT',
    });
    expect(a).toMatchObject({
      commissionRateBps: 250,
      commissionFixedMinor: 10,
      commissionMinor: 110,
    });
  });

  it('refuse des frais ou taxes invalides', () => {
    expect(() => computeBookingAmounts({ ...base, paymentMode: 'DEPOSIT', feesMinor: -1 })).toThrow(
      RangeError,
    );
    expect(() => computeBookingAmounts({ ...base, paymentMode: 'DEPOSIT', taxMinor: 0.5 })).toThrow(
      RangeError,
    );
  });
});

describe('computeManualAmounts (réservation saisie par le complexe)', () => {
  it('aucune commission, tout se règle sur place, le complexe garde tout', () => {
    expect(computeManualAmounts(4000)).toMatchObject({
      commissionMinor: 0,
      commissionRateBps: 0,
      platformAmountMinor: 0,
      venueAmountMinor: 4000,
      totalMinor: 4000,
      dueOnlineMinor: 0,
      dueOnSiteMinor: 4000,
    });
  });

  it('accepte un prix nul (créneau offert)', () => {
    expect(computeManualAmounts(0).totalMinor).toBe(0);
  });
});

/**
 * Tirages aléatoires (graine fixe → reproductibles) : pour des milliers de combinaisons, les montants
 * respectent EXACTEMENT les contraintes CHECK de la base. Si ce test passe, la base n'a aucune raison de refuser
 * une réservation calculée par ce module.
 */
describe('invariants (miroir des contraintes SQL)', () => {
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('5 000 réservations aléatoires respectent toutes les invariants', () => {
    const rand = mulberry32(20261009);
    const int = (max: number): number => Math.floor(rand() * (max + 1));
    const modes: AmountsPaymentMode[] = ['DEPOSIT', 'FULL_ONLINE', 'ON_SITE'];

    for (let i = 0; i < 5000; i++) {
      const deposit: DepositPolicy = {
        mode: rand() < 0.5 ? 'PERCENT' : 'FIXED',
        rateBps: int(10_000),
        fixedMinor: int(100_000),
        minMinor: int(100_000),
      };
      const a = computeBookingAmounts({
        basePriceMinor: int(100_000),
        commission: { rateBps: int(10_000), fixedMinor: int(5_000) },
        paymentMode: modes[int(2)] as AmountsPaymentMode,
        deposit,
        feesMinor: int(1_000),
        taxMinor: int(5_000),
      });
      const ctx = JSON.stringify(a);

      for (const value of Object.values(a)) {
        expect(Number.isSafeInteger(value) && value >= 0, ctx).toBe(true); // entiers, non négatifs
      }
      expect(a.commissionMinor <= a.basePriceMinor, ctx).toBe(true); // Booking_commission_le_base_chk
      expect(a.venueAmountMinor, ctx).toBe(a.basePriceMinor - a.commissionMinor); // Booking_venue_share_chk
      expect(a.platformAmountMinor, ctx).toBe(a.commissionMinor + a.feesMinor); // Booking_platform_share_chk
      expect(a.totalMinor, ctx).toBe(a.basePriceMinor + a.feesMinor + a.taxMinor); // Booking_total_chk
      expect(a.dueOnlineMinor + a.dueOnSiteMinor, ctx).toBe(a.totalMinor); // Booking_split_chk
      expect(a.commissionRateBps >= 0 && a.commissionRateBps <= 10_000, ctx).toBe(true);
    }
  });

  it('en mode acompte, l’acompte couvre toujours la part de la plateforme (quand c’est possible)', () => {
    const rand = mulberry32(42);
    const int = (max: number): number => Math.floor(rand() * (max + 1));
    for (let i = 0; i < 2000; i++) {
      const a = computeBookingAmounts({
        basePriceMinor: int(100_000),
        commission: { rateBps: int(2_000), fixedMinor: int(500) },
        paymentMode: 'DEPOSIT',
        deposit: { mode: 'PERCENT', rateBps: int(10_000), fixedMinor: 0, minMinor: 0 },
      });
      expect(
        a.dueOnlineMinor >= Math.min(a.platformAmountMinor, a.totalMinor),
        JSON.stringify(a),
      ).toBe(true);
      expect(a.dueOnlineMinor <= a.totalMinor).toBe(true);
    }
  });
});
