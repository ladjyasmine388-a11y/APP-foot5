import { describe, expect, it } from 'vitest';
import {
  availabilityQuerySchema,
  createFieldSchema,
  createPricingRuleSchema,
  createVenueSchema,
  dateSchema,
  openingHoursSchema,
  searchVenuesQuerySchema,
  updateFieldSchema,
  updatePricingRuleSchema,
  updateVenueSchema,
} from './venues';

describe('dateSchema', () => {
  it.each(['2026-10-20', '2028-02-29'])('accepte %s', (d) =>
    expect(dateSchema.safeParse(d).success).toBe(true),
  );
  it.each(['2026-02-30', '2027-02-29', '20-10-2026', '2026-13-01', ''])('refuse %s', (d) =>
    expect(dateSchema.safeParse(d).success).toBe(false),
  );
});

describe('createVenueSchema', () => {
  const valid = { name: 'Five Alger Centre', city: 'Alger', address: '12 rue Didouche Mourad' };

  it('applique les valeurs par défaut (fuseau Africa/Algiers)', () => {
    expect(createVenueSchema.parse(valid).timezone).toBe('Africa/Algiers');
  });

  it('normalise les équipements (minuscules, sans doublon) et le téléphone', () => {
    const parsed = createVenueSchema.parse({
      ...valid,
      amenities: ['Parking', 'parking', ' Douches '],
      phone: '0550 12 34 56',
    });
    expect(parsed.amenities).toEqual(['parking', 'douches']);
    expect(parsed.phone).toBe('+213550123456');
  });

  it('latitude et longitude vont ensemble', () => {
    expect(createVenueSchema.safeParse({ ...valid, latitude: 36.75 }).success).toBe(false);
    expect(
      createVenueSchema.safeParse({ ...valid, latitude: 36.75, longitude: 3.06 }).success,
    ).toBe(true);
    expect(createVenueSchema.safeParse({ ...valid, latitude: 91, longitude: 3 }).success).toBe(
      false,
    );
  });

  it('refuse un fuseau inconnu', () => {
    expect(createVenueSchema.safeParse({ ...valid, timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(createVenueSchema.safeParse({ ...valid, timezone: 'Europe/Paris' }).success).toBe(true);
  });

  it.each(['status', 'slug', 'ratingAvg', 'depositPolicy', 'id'])(
    'REFUSE le champ interdit « %s »',
    (field) => {
      expect(createVenueSchema.safeParse({ ...valid, [field]: 'x' }).success).toBe(false);
    },
  );
});

describe('updateVenueSchema', () => {
  it('modification partielle ; requête vide refusée', () => {
    expect(updateVenueSchema.safeParse({ district: 'Hydra' }).success).toBe(true);
    expect(updateVenueSchema.safeParse({}).success).toBe(false);
  });

  it('le fuseau horaire, le statut et la politique d’acompte ne sont PAS modifiables par le complexe', () => {
    for (const field of ['timezone', 'status', 'depositPolicy', 'slug']) {
      expect(updateVenueSchema.safeParse({ [field]: 'x' }).success).toBe(false);
    }
  });

  it('valide la politique d’annulation', () => {
    expect(
      updateVenueSchema.safeParse({
        cancellationPolicy: { freeUntilHoursBefore: 24, refundDeposit: false },
      }).success,
    ).toBe(true);
    expect(
      updateVenueSchema.safeParse({
        cancellationPolicy: { freeUntilHoursBefore: -1, refundDeposit: false },
      }).success,
    ).toBe(false);
  });
});

describe('terrains', () => {
  it('capacité de 10 à 16 joueurs ; créneau de 60 min par défaut côté base', () => {
    expect(createFieldSchema.safeParse({ name: 'Terrain 1', capacity: 10 }).success).toBe(true);
    expect(createFieldSchema.safeParse({ name: 'Terrain 1', capacity: 16 }).success).toBe(true);
    expect(createFieldSchema.safeParse({ name: 'Terrain 1', capacity: 9 }).success).toBe(false);
    expect(createFieldSchema.safeParse({ name: 'Terrain 1', capacity: 17 }).success).toBe(false);
  });

  it('durée de créneau : multiple de 30 entre 30 et 240', () => {
    const base = { name: 'T', capacity: 10 };
    expect(createFieldSchema.safeParse({ ...base, slotDurationMin: 60 }).success).toBe(true);
    expect(createFieldSchema.safeParse({ ...base, slotDurationMin: 90 }).success).toBe(true);
    expect(createFieldSchema.safeParse({ ...base, slotDurationMin: 45 }).success).toBe(false);
    expect(createFieldSchema.safeParse({ ...base, slotDurationMin: 300 }).success).toBe(false);
  });

  it('un terrain ne peut pas changer de complexe ni de statut via les champs libres', () => {
    expect(createFieldSchema.safeParse({ name: 'T', capacity: 10, venueId: 'x' }).success).toBe(
      false,
    );
    expect(updateFieldSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(updateFieldSchema.safeParse({ venueId: 'x' }).success).toBe(false);
  });
});

describe('openingHoursSchema', () => {
  it('accepte des horaires simples et une fermeture après minuit', () => {
    expect(
      openingHoursSchema.safeParse({
        days: [
          { weekday: 1, intervals: [{ from: '10:00', to: '23:00' }] },
          { weekday: 5, intervals: [{ from: '10:00', to: '02:00' }] },
        ],
      }).success,
    ).toBe(true);
  });

  it('accepte deux plages le même jour (pause déjeuner) mais pas si elles se chevauchent', () => {
    const day = (intervals: { from: string; to: string }[]) => ({
      days: [{ weekday: 2, intervals }],
    });
    expect(
      openingHoursSchema.safeParse(
        day([
          { from: '09:00', to: '12:00' },
          { from: '14:00', to: '23:00' },
        ]),
      ).success,
    ).toBe(true);
    expect(
      openingHoursSchema.safeParse(
        day([
          { from: '09:00', to: '15:00' },
          { from: '14:00', to: '23:00' },
        ]),
      ).success,
    ).toBe(false);
  });

  it('refuse un jour en double, un jour hors 1–7, une plage début = fin', () => {
    expect(
      openingHoursSchema.safeParse({
        days: [
          { weekday: 1, intervals: [{ from: '10:00', to: '12:00' }] },
          { weekday: 1, intervals: [{ from: '14:00', to: '16:00' }] },
        ],
      }).success,
    ).toBe(false);
    expect(
      openingHoursSchema.safeParse({
        days: [{ weekday: 0, intervals: [{ from: '10:00', to: '12:00' }] }],
      }).success,
    ).toBe(false);
    expect(
      openingHoursSchema.safeParse({
        days: [{ weekday: 1, intervals: [{ from: '10:00', to: '10:00' }] }],
      }).success,
    ).toBe(false);
  });

  it('une liste vide = complexe fermé toute la semaine (valide)', () => {
    expect(openingHoursSchema.safeParse({ days: [] }).success).toBe(true);
  });
});

describe('règles de prix', () => {
  const rule = { weekdays: [6, 5, 5], from: '18:00', to: '23:00', priceMinor: 6000 };

  it('trie et dédoublonne les jours, applique les valeurs par défaut', () => {
    const parsed = createPricingRuleSchema.parse(rule);
    expect(parsed.weekdays).toEqual([5, 6]);
  });

  it('refuse un prix nul, négatif, décimal ou aberrant (faute de frappe)', () => {
    for (const priceMinor of [0, -100, 4000.5, 400_000]) {
      expect(createPricingRuleSchema.safeParse({ ...rule, priceMinor }).success).toBe(false);
    }
  });

  it('refuse une validité inversée', () => {
    expect(
      createPricingRuleSchema.safeParse({ ...rule, validFrom: '2026-12-01', validTo: '2026-11-01' })
        .success,
    ).toBe(false);
    expect(
      createPricingRuleSchema.safeParse({ ...rule, validFrom: '2026-11-01', validTo: '2026-12-01' })
        .success,
    ).toBe(true);
  });

  it('refuse un jour invalide et une plage invalide', () => {
    expect(createPricingRuleSchema.safeParse({ ...rule, weekdays: [8] }).success).toBe(false);
    expect(createPricingRuleSchema.safeParse({ ...rule, weekdays: [] }).success).toBe(false);
    expect(createPricingRuleSchema.safeParse({ ...rule, from: '18:00', to: '18:00' }).success).toBe(
      false,
    );
  });

  it('une modification partielle est valide, une requête vide non', () => {
    expect(updatePricingRuleSchema.safeParse({ priceMinor: 5000 }).success).toBe(true);
    expect(updatePricingRuleSchema.safeParse({}).success).toBe(false);
    expect(updatePricingRuleSchema.safeParse({ fieldId: 'x', priceMinor: 5000 }).success).toBe(
      false,
    );
  });
});

describe('searchVenuesQuerySchema', () => {
  it('convertit les chaînes de requête et applique les défauts', () => {
    const parsed = searchVenuesQuerySchema.parse({
      city: 'Alger',
      players: '10',
      date: '2026-10-20',
      time: '20:00',
      priceMax: '5000',
      amenities: 'Parking, douches,parking',
    });
    expect(parsed).toMatchObject({
      city: 'Alger',
      players: 10,
      priceMax: 5000,
      window: 0,
      sort: 'relevance',
      limit: 12,
      amenities: ['parking', 'douches'],
    });
  });

  it('une requête vide est valide (tous les complexes)', () => {
    expect(searchVenuesQuerySchema.parse({}).amenities).toEqual([]);
  });

  it('l’heure exige une date ; lat et lng vont ensemble ; le tri par distance exige une position', () => {
    expect(searchVenuesQuerySchema.safeParse({ time: '20:00' }).success).toBe(false);
    expect(searchVenuesQuerySchema.safeParse({ lat: '36.7' }).success).toBe(false);
    expect(searchVenuesQuerySchema.safeParse({ sort: 'distance' }).success).toBe(false);
    expect(
      searchVenuesQuerySchema.safeParse({ sort: 'distance', lat: '36.7', lng: '3.0' }).success,
    ).toBe(true);
    expect(searchVenuesQuerySchema.safeParse({ radiusKm: '5' }).success).toBe(false);
  });

  it('borne la pagination et le nombre de joueurs', () => {
    expect(searchVenuesQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
    expect(searchVenuesQuerySchema.safeParse({ players: '40' }).success).toBe(false);
    expect(searchVenuesQuerySchema.safeParse({ players: '1' }).success).toBe(false);
  });

  it('refuse les paramètres inconnus', () => {
    expect(searchVenuesQuerySchema.safeParse({ status: 'PENDING' }).success).toBe(false);
  });
});

describe('availabilityQuerySchema', () => {
  it('exige une date valide', () => {
    expect(availabilityQuerySchema.safeParse({ date: '2026-10-20' }).success).toBe(true);
    expect(availabilityQuerySchema.safeParse({}).success).toBe(false);
    expect(availabilityQuerySchema.safeParse({ date: '2026-02-30' }).success).toBe(false);
  });
});
