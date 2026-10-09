import { describe, expect, it } from 'vitest';
import {
  type BookingRow,
  type PriceRule,
  classifyOccupation,
  computeDaySlots,
  dayWindow,
  resolveIntervals,
  resolvePrice,
} from './availability.engine.js';

const TZ = 'Africa/Algiers';
const DATE = '2026-10-20'; // mardi (ISO 2)
const NOW_LONG_BEFORE = new Date('2026-10-01T00:00:00.000Z');

const rule = (overrides: Partial<PriceRule> = {}): PriceRule => ({
  id: 'r1',
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  startMin: 0,
  endMin: 1800,
  priceMinor: 4000,
  priority: 0,
  validFrom: null,
  validTo: null,
  isActive: true,
  ...overrides,
});

const baseInput = {
  date: DATE,
  timeZone: TZ,
  slotDurationMin: 60,
  intervals: [{ opensAtMin: 18 * 60, closesAtMin: 22 * 60 }], // 18:00 → 22:00
  rules: [rule()],
  occupations: [],
  now: NOW_LONG_BEFORE,
  minLeadMinutes: 0,
};

describe('resolveIntervals', () => {
  const venue = [
    { weekday: 2, opensAtMin: 600, closesAtMin: 1380 },
    { weekday: 3, opensAtMin: 600, closesAtMin: 1380 },
  ];

  it('utilise les horaires du complexe par défaut', () => {
    expect(resolveIntervals(venue, [], 2)).toEqual([{ opensAtMin: 600, closesAtMin: 1380 }]);
  });

  it('les horaires PROPRES au terrain remplacent ceux du complexe pour ce jour uniquement', () => {
    const field = [{ weekday: 2, opensAtMin: 900, closesAtMin: 1200 }];
    expect(resolveIntervals(venue, field, 2)).toEqual([{ opensAtMin: 900, closesAtMin: 1200 }]);
    expect(resolveIntervals(venue, field, 3)).toEqual([{ opensAtMin: 600, closesAtMin: 1380 }]);
  });

  it('un jour sans plage = fermé', () => {
    expect(resolveIntervals(venue, [], 7)).toEqual([]);
  });

  it('trie les plages du jour', () => {
    const rows = [
      { weekday: 2, opensAtMin: 840, closesAtMin: 1380 },
      { weekday: 2, opensAtMin: 540, closesAtMin: 720 },
    ];
    expect(resolveIntervals(rows, [], 2).map((i) => i.opensAtMin)).toEqual([540, 840]);
  });
});

describe('resolvePrice', () => {
  it('retourne null sans règle applicable', () => {
    expect(resolvePrice([], 2, 1200, DATE)).toBeNull();
    expect(resolvePrice([rule({ weekdays: [6] })], 2, 1200, DATE)).toBeNull();
  });

  it('respecte le jour, la plage horaire (début inclus, fin exclue) et l’état actif', () => {
    const evening = rule({ startMin: 1080, endMin: 1380 }); // 18:00–23:00
    expect(resolvePrice([evening], 2, 1080, DATE)).toBe(4000);
    expect(resolvePrice([evening], 2, 1379, DATE)).toBe(4000);
    expect(resolvePrice([evening], 2, 1380, DATE)).toBeNull();
    expect(resolvePrice([evening], 2, 1079, DATE)).toBeNull();
    expect(resolvePrice([rule({ isActive: false })], 2, 1200, DATE)).toBeNull();
  });

  it('la règle de plus haute priorité l’emporte (heures de pointe)', () => {
    const base = rule({ id: 'a', priceMinor: 4000, priority: 0 });
    const peak = rule({ id: 'b', priceMinor: 6000, priority: 10, startMin: 1140, endMin: 1380 });
    expect(resolvePrice([base, peak], 2, 1200, DATE)).toBe(6000); // 20:00 : pointe
    expect(resolvePrice([base, peak], 2, 600, DATE)).toBe(4000); // 10:00 : tarif de base
    expect(resolvePrice([peak, base], 2, 1200, DATE)).toBe(6000); // l’ordre de la liste n’a pas d’importance
  });

  it('à priorité égale, la plage la plus étroite (la plus spécifique) l’emporte', () => {
    const wide = rule({ id: 'a', priceMinor: 4000, startMin: 600, endMin: 1380 });
    const narrow = rule({ id: 'b', priceMinor: 5000, startMin: 1200, endMin: 1260 });
    expect(resolvePrice([wide, narrow], 2, 1200, DATE)).toBe(5000);
  });

  it('départage de façon déterministe deux règles identiques', () => {
    const a = rule({ id: 'a', priceMinor: 4000 });
    const b = rule({ id: 'b', priceMinor: 9000 });
    expect(resolvePrice([a, b], 2, 1200, DATE)).toBe(resolvePrice([b, a], 2, 1200, DATE));
  });

  it('respecte la période de validité (bornes incluses)', () => {
    const promo = rule({ priceMinor: 3000, validFrom: '2026-10-20', validTo: '2026-10-25' });
    expect(resolvePrice([promo], 2, 1200, '2026-10-19')).toBeNull();
    expect(resolvePrice([promo], 2, 1200, '2026-10-20')).toBe(3000);
    expect(resolvePrice([promo], 2, 1200, '2026-10-25')).toBe(3000);
    expect(resolvePrice([promo], 2, 1200, '2026-10-26')).toBeNull();
  });

  it('une promotion datée prioritaire ne s’applique que pendant sa période, puis le tarif de base revient', () => {
    const base = rule({ id: 'base', priceMinor: 4000 });
    const promo = rule({
      id: 'promo',
      priceMinor: 3000,
      priority: 5,
      validFrom: '2026-10-20',
      validTo: '2026-10-22',
    });
    expect(resolvePrice([base, promo], 2, 1200, '2026-10-21')).toBe(3000);
    expect(resolvePrice([base, promo], 2, 1200, '2026-10-23')).toBe(4000);
  });
});

describe('classifyOccupation', () => {
  const NOW = new Date('2026-10-20T12:00:00.000Z');
  const booking = (overrides: Partial<BookingRow>): BookingRow => ({
    startsAt: new Date('2026-10-20T19:00:00.000Z'),
    endsAt: new Date('2026-10-20T20:00:00.000Z'),
    status: 'CONFIRMED',
    bookingType: 'STANDARD',
    holdExpiresAt: null,
    ...overrides,
  });

  it('réservation confirmée → BOOKED ; passée (COMPLETED, NO_SHOW) → BOOKED', () => {
    expect(classifyOccupation(booking({}), NOW)?.kind).toBe('BOOKED');
    expect(classifyOccupation(booking({ status: 'COMPLETED' }), NOW)?.kind).toBe('BOOKED');
    expect(classifyOccupation(booking({ status: 'NO_SHOW' }), NOW)?.kind).toBe('BOOKED');
  });

  it('blocage du complexe → BLOCKED', () => {
    expect(classifyOccupation(booking({ bookingType: 'BLOCK' }), NOW)?.kind).toBe('BLOCKED');
  });

  it('annulée ou expirée → libère le créneau', () => {
    expect(classifyOccupation(booking({ status: 'CANCELLED' }), NOW)).toBeNull();
    expect(classifyOccupation(booking({ status: 'EXPIRED' }), NOW)).toBeNull();
  });

  it('verrou de paiement en cours → HELD', () => {
    const held = booking({
      status: 'PENDING_PAYMENT',
      holdExpiresAt: new Date('2026-10-20T12:05:00.000Z'),
    });
    expect(classifyOccupation(held, NOW)?.kind).toBe('HELD');
  });

  it('verrou de paiement DÉPASSÉ → libre, sans attendre le job d’expiration', () => {
    const stale = booking({
      status: 'PENDING_PAYMENT',
      holdExpiresAt: new Date('2026-10-20T11:59:59.000Z'),
    });
    expect(classifyOccupation(stale, NOW)).toBeNull();
    // Frontière : un verrou qui expire EXACTEMENT maintenant est déjà libre.
    const exact = booking({ status: 'PENDING_PAYMENT', holdExpiresAt: NOW });
    expect(classifyOccupation(exact, NOW)).toBeNull();
  });

  it('un verrou sans date d’expiration (état invalide) n’occupe pas le créneau', () => {
    expect(
      classifyOccupation(booking({ status: 'PENDING_PAYMENT', holdExpiresAt: null }), NOW),
    ).toBeNull();
  });
});

describe('computeDaySlots', () => {
  it('génère des créneaux de 60 min alignés sur l’ouverture (18:00 → 22:00 = 4 créneaux)', () => {
    const slots = computeDaySlots(baseInput);
    expect(slots).toHaveLength(4);
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      '2026-10-20T17:00:00.000Z', // 18:00 Alger
      '2026-10-20T18:00:00.000Z',
      '2026-10-20T19:00:00.000Z',
      '2026-10-20T20:00:00.000Z',
    ]);
    expect(slots.every((s) => s.status === 'AVAILABLE' && s.priceMinor === 4000)).toBe(true);
  });

  it('les créneaux sont contigus (la fin de l’un = le début du suivant)', () => {
    const slots = computeDaySlots(baseInput);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i]?.startsAt.getTime()).toBe(slots[i - 1]?.endsAt.getTime());
    }
  });

  it('ignore le créneau incomplet à la fermeture (18:00 → 21:30 avec 60 min = 3 créneaux)', () => {
    const slots = computeDaySlots({
      ...baseInput,
      intervals: [{ opensAtMin: 1080, closesAtMin: 1290 }],
    });
    expect(slots).toHaveLength(3);
  });

  it('durée de 90 min : 18:00, 19:30, 21:00 (jusqu’à 22:30)', () => {
    const slots = computeDaySlots({
      ...baseInput,
      slotDurationMin: 90,
      intervals: [{ opensAtMin: 1080, closesAtMin: 1350 }],
    });
    expect(slots.map((s) => s.startMin)).toEqual([1080, 1170, 1260]);
  });

  it('fermeture après minuit : 22:00 → 02:00 donne 4 créneaux dont deux après minuit, rattachés au jour de service', () => {
    const slots = computeDaySlots({
      ...baseInput,
      intervals: [{ opensAtMin: 22 * 60, closesAtMin: 26 * 60 }],
    });
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      '2026-10-20T21:00:00.000Z', // 22:00 le 20
      '2026-10-20T22:00:00.000Z', // 23:00
      '2026-10-20T23:00:00.000Z', // 00:00 le 21
      '2026-10-21T00:00:00.000Z', // 01:00 le 21
    ]);
  });

  it('deux plages le même jour (pause) : pas de créneau pendant la pause', () => {
    const slots = computeDaySlots({
      ...baseInput,
      intervals: [
        { opensAtMin: 9 * 60, closesAtMin: 11 * 60 },
        { opensAtMin: 14 * 60, closesAtMin: 16 * 60 },
      ],
    });
    expect(slots.map((s) => s.startMin)).toEqual([540, 600, 840, 900]);
  });

  it('un jour fermé (aucune plage) ne produit aucun créneau', () => {
    expect(computeDaySlots({ ...baseInput, intervals: [] })).toEqual([]);
  });

  describe('statuts', () => {
    const occupation = (kind: 'BOOKED' | 'HELD' | 'BLOCKED', startIso: string, endIso: string) => ({
      kind,
      startsAt: new Date(startIso),
      endsAt: new Date(endIso),
    });

    it('un créneau réservé devient BOOKED, ses voisins restent disponibles', () => {
      const slots = computeDaySlots({
        ...baseInput,
        occupations: [occupation('BOOKED', '2026-10-20T19:00:00.000Z', '2026-10-20T20:00:00.000Z')],
      });
      expect(slots.map((s) => s.status)).toEqual(['AVAILABLE', 'AVAILABLE', 'BOOKED', 'AVAILABLE']);
    });

    it('une réservation plus longue (2 h) occupe plusieurs créneaux', () => {
      const slots = computeDaySlots({
        ...baseInput,
        occupations: [occupation('BOOKED', '2026-10-20T18:00:00.000Z', '2026-10-20T20:00:00.000Z')],
      });
      expect(slots.map((s) => s.status)).toEqual(['AVAILABLE', 'BOOKED', 'BOOKED', 'AVAILABLE']);
    });

    it('une occupation qui finit exactement au début d’un créneau ne le bloque pas', () => {
      const slots = computeDaySlots({
        ...baseInput,
        occupations: [occupation('BOOKED', '2026-10-20T16:00:00.000Z', '2026-10-20T17:00:00.000Z')],
      });
      expect(slots[0]?.status).toBe('AVAILABLE');
    });

    it('distingue HELD (paiement en cours) et BLOCKED (fermé par le complexe)', () => {
      const slots = computeDaySlots({
        ...baseInput,
        occupations: [
          occupation('HELD', '2026-10-20T17:00:00.000Z', '2026-10-20T18:00:00.000Z'),
          occupation('BLOCKED', '2026-10-20T18:00:00.000Z', '2026-10-20T19:00:00.000Z'),
        ],
      });
      expect(slots.map((s) => s.status)).toEqual(['HELD', 'BLOCKED', 'AVAILABLE', 'AVAILABLE']);
    });

    it('en cas de chevauchement, BOOKED prime sur BLOCKED et HELD', () => {
      const slots = computeDaySlots({
        ...baseInput,
        occupations: [
          occupation('HELD', '2026-10-20T17:00:00.000Z', '2026-10-20T18:00:00.000Z'),
          occupation('BOOKED', '2026-10-20T17:00:00.000Z', '2026-10-20T18:00:00.000Z'),
        ],
      });
      expect(slots[0]?.status).toBe('BOOKED');
    });

    it('un créneau sans prix est NO_PRICE (non vendable) mais conserve son statut s’il est occupé', () => {
      const none = computeDaySlots({ ...baseInput, rules: [] });
      expect(none.every((s) => s.status === 'NO_PRICE' && s.priceMinor === null)).toBe(true);

      const booked = computeDaySlots({
        ...baseInput,
        rules: [],
        occupations: [occupation('BOOKED', '2026-10-20T17:00:00.000Z', '2026-10-20T18:00:00.000Z')],
      });
      expect(booked[0]?.status).toBe('BOOKED');
    });

    it('applique la tarification par tranche (pointe à partir de 20:00)', () => {
      const slots = computeDaySlots({
        ...baseInput,
        rules: [
          rule({ id: 'a', priceMinor: 4000 }),
          rule({ id: 'b', priceMinor: 6000, priority: 1, startMin: 1200, endMin: 1380 }),
        ],
      });
      expect(slots.map((s) => s.priceMinor)).toEqual([4000, 4000, 6000, 6000]);
    });
  });

  describe('créneaux passés et préavis', () => {
    // 19:30 à Alger = 18:30 UTC
    const now = new Date('2026-10-20T18:30:00.000Z');

    it('les créneaux déjà commencés sont PAST, les suivants restent réservables', () => {
      const slots = computeDaySlots({ ...baseInput, now });
      // 18:00, 19:00 sont passés (19:00 a commencé à 19:00 < 19:30) ; 20:00 et 21:00 restent ouverts.
      expect(slots.map((s) => s.status)).toEqual(['PAST', 'PAST', 'AVAILABLE', 'AVAILABLE']);
    });

    it('le préavis minimal rend PAST les créneaux trop proches (30 min : 20:00 n’est plus réservable à 19:45)', () => {
      const at1945 = new Date('2026-10-20T18:45:00.000Z');
      const slots = computeDaySlots({ ...baseInput, now: at1945, minLeadMinutes: 30 });
      expect(slots.map((s) => s.status)).toEqual(['PAST', 'PAST', 'PAST', 'AVAILABLE']);
    });

    it('un créneau qui commence EXACTEMENT à l’instant limite est encore réservable', () => {
      // préavis 30 min, il est 19:30 → un créneau à 20:00 (= 30 min) reste réservable
      const slots = computeDaySlots({ ...baseInput, now, minLeadMinutes: 30 });
      expect(slots.find((s) => s.startMin === 1200)?.status).toBe('AVAILABLE');
      expect(slots.find((s) => s.startMin === 1140)?.status).toBe('PAST');
    });

    it('PAST prime sur toute autre information', () => {
      const slots = computeDaySlots({
        ...baseInput,
        now,
        occupations: [
          {
            kind: 'BOOKED',
            startsAt: new Date('2026-10-20T17:00:00.000Z'),
            endsAt: new Date('2026-10-20T18:00:00.000Z'),
          },
        ],
      });
      expect(slots[0]?.status).toBe('PAST');
    });
  });
});

describe('dayWindow', () => {
  it('couvre de la première ouverture à la dernière fermeture, en UTC', () => {
    const window = dayWindow(DATE, TZ, [
      { opensAtMin: 18 * 60, closesAtMin: 20 * 60 },
      { opensAtMin: 21 * 60, closesAtMin: 26 * 60 },
    ]);
    expect(window?.from.toISOString()).toBe('2026-10-20T17:00:00.000Z');
    expect(window?.to.toISOString()).toBe('2026-10-21T01:00:00.000Z');
  });

  it('retourne null si le complexe est fermé', () => {
    expect(dayWindow(DATE, TZ, [])).toBeNull();
  });
});
