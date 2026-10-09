import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp, get } from './app-helper.js';
import { prisma, resetDb } from './helpers.js';
import { book, createVenueWithFields, dayIn, inMinutes, slotAt } from './venue-fixtures.js';

const DATE = dayIn(7);

describe('consultation publique des complexes', () => {
  let t: TestApp;

  beforeAll(async () => {
    await resetDb();
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const search = async (query: string) => {
    const res = await get(t, `/venues${query ? `?${query}` : ''}`);
    return { res, body: res.json() };
  };
  const names = (body: { items: { name: string }[] }): string[] => body.items.map((i) => i.name);

  describe('visibilité : seuls les complexes APPROUVÉS sont publics', () => {
    it('masque les complexes en attente ou suspendus partout (liste, fiche, disponibilités)', async () => {
      const pending = await createVenueWithFields({
        name: 'Vis Pending',
        status: 'PENDING',
        city: 'Visibilite',
      });
      const suspended = await createVenueWithFields({
        name: 'Vis Suspended',
        status: 'SUSPENDED',
        city: 'Visibilite',
      });
      const approved = await createVenueWithFields({ name: 'Vis Approved', city: 'Visibilite' });

      const { body } = await search('city=Visibilite');
      expect(names(body)).toEqual(['Vis Approved']);

      expect((await get(t, `/venues/${approved.venue.slug}`)).statusCode).toBe(200);
      for (const hidden of [pending, suspended]) {
        expect((await get(t, `/venues/${hidden.venue.slug}`)).statusCode).toBe(404);
        expect(
          (await get(t, `/venues/${hidden.venue.slug}/availability?date=${DATE}`)).statusCode,
        ).toBe(404);
        expect(
          (await get(t, `/fields/${hidden.fields[0]?.id}/availability?date=${DATE}`)).statusCode,
        ).toBe(404);
      }
    });

    it('un complexe sans terrain actif n’apparaît pas', async () => {
      await createVenueWithFields({ name: 'Sans Terrain Actif', city: 'Inactif' }, [
        { isActive: false },
      ]);
      expect(names((await search('city=Inactif')).body)).toEqual([]);
    });

    it('est accessible sans authentification', async () => {
      expect((await get(t, '/venues')).statusCode).toBe(200);
    });
  });

  describe('filtres de recherche', () => {
    beforeAll(async () => {
      await createVenueWithFields(
        {
          name: 'F Hydra',
          city: 'Filtres',
          district: 'Hydra',
          amenities: ['parking', 'douches'],
          ratingAvg: 4.5,
          ratingCount: 20,
          latitude: 36.74,
          longitude: 3.04,
        },
        [
          { capacity: 10, rules: [{ priceMinor: 4000 }] },
          { capacity: 10, rules: [{ priceMinor: 5000 }] },
        ],
      );
      await createVenueWithFields(
        {
          name: 'F Bab Ezzouar',
          city: 'filtres',
          district: 'Bab Ezzouar',
          amenities: ['parking'],
          ratingAvg: 3.8,
          ratingCount: 50,
          latitude: 36.72,
          longitude: 3.18,
        },
        [{ capacity: 16, rules: [{ priceMinor: 3000 }] }],
      );
      await createVenueWithFields(
        {
          name: 'F Kouba',
          city: 'Filtres',
          district: 'Kouba',
          amenities: [],
          ratingAvg: 4.9,
          ratingCount: 5,
          latitude: 36.72,
          longitude: 3.09,
        },
        [{ capacity: 12, rules: [{ priceMinor: 7000 }] }],
      );
      await createVenueWithFields(
        { name: 'F Oran', city: 'Oran Filtres', ratingAvg: 4.0, latitude: 35.69, longitude: -0.63 },
        [{ capacity: 10, rules: [] }],
      );
    });

    it('par ville, sans tenir compte de la casse', async () => {
      expect(names((await search('city=filtres')).body).sort()).toEqual([
        'F Bab Ezzouar',
        'F Hydra',
        'F Kouba',
      ]);
      expect(names((await search('city=FILTRES')).body)).toHaveLength(3);
    });

    it('par quartier et par nom (recherche partielle)', async () => {
      expect(names((await search('city=Filtres&district=hydra')).body)).toEqual(['F Hydra']);
      expect(names((await search('city=Filtres&q=ezzou')).body)).toEqual(['F Bab Ezzouar']);
    });

    it('par équipements : TOUS les équipements demandés sont exigés', async () => {
      expect(names((await search('city=Filtres&amenities=parking')).body).sort()).toEqual([
        'F Bab Ezzouar',
        'F Hydra',
      ]);
      expect(names((await search('city=Filtres&amenities=parking,douches')).body)).toEqual([
        'F Hydra',
      ]);
      expect(names((await search('city=Filtres&amenities=Parking, DOUCHES')).body)).toEqual([
        'F Hydra',
      ]);
    });

    it('par nombre de joueurs : seuls les terrains assez grands comptent', async () => {
      expect(names((await search('city=Filtres&players=14')).body)).toEqual(['F Bab Ezzouar']);
      expect(names((await search('city=Filtres&players=12')).body).sort()).toEqual([
        'F Bab Ezzouar',
        'F Kouba',
      ]);
      expect(names((await search('city=Filtres&players=10')).body)).toHaveLength(3);
    });

    it('par prix maximal (prix « à partir de »)', async () => {
      expect(names((await search('city=Filtres&priceMax=3500')).body)).toEqual(['F Bab Ezzouar']);
      expect(names((await search('city=Filtres&priceMax=4000')).body).sort()).toEqual([
        'F Bab Ezzouar',
        'F Hydra',
      ]);
    });

    it('les cartes contiennent prix « à partir de », nombre de terrains, note, équipements', async () => {
      const { body } = await search('city=Filtres&q=hydra');
      expect(body.items[0]).toMatchObject({
        name: 'F Hydra',
        city: 'Filtres',
        district: 'Hydra',
        fieldsCount: 2,
        priceFromMinor: 4000,
        amenities: ['parking', 'douches'],
        ratingAvg: 4.5,
        ratingCount: 20,
        distanceKm: null,
        matchingSlots: null,
      });
    });

    it('un complexe sans aucun tarif a un prix « à partir de » nul', async () => {
      const { body } = await search('city=Oran Filtres');
      expect(body.items[0]).toMatchObject({ name: 'F Oran', priceFromMinor: null });
    });

    describe('tri', () => {
      it('par prix croissant (sans tarif en dernier)', async () => {
        const { body } = await search('city=Filtres&sort=price_asc');
        expect(names(body)).toEqual(['F Bab Ezzouar', 'F Hydra', 'F Kouba']);
      });

      it('par note, puis par défaut par pertinence (note, puis nombre d’avis)', async () => {
        expect(names((await search('city=Filtres&sort=rating')).body)).toEqual([
          'F Kouba',
          'F Hydra',
          'F Bab Ezzouar',
        ]);
        expect(names((await search('city=Filtres')).body)).toEqual([
          'F Kouba',
          'F Hydra',
          'F Bab Ezzouar',
        ]);
      });

      it('par distance depuis une position, avec distance arrondie', async () => {
        // Position proche de Hydra
        const { body } = await search('city=Filtres&sort=distance&lat=36.74&lng=3.04');
        expect(names(body)).toEqual(['F Hydra', 'F Kouba', 'F Bab Ezzouar']);
        expect(body.items[0].distanceKm).toBe(0);
        expect(body.items[1].distanceKm).toBeGreaterThan(4);
        expect(body.items[1].distanceKm).toBeLessThan(8);
      });

      it('filtre par rayon : exclut les complexes trop loin ou sans coordonnées', async () => {
        const { body } = await search('city=Filtres&lat=36.74&lng=3.04&radiusKm=10');
        expect(names(body).sort()).toEqual(['F Hydra', 'F Kouba']);
      });
    });

    describe('pagination', () => {
      it('découpe en pages, fournit un curseur, et ne perd ni ne duplique aucun résultat', async () => {
        const first = (await search('city=Filtres&limit=2&sort=price_asc')).body;
        expect(first.items).toHaveLength(2);
        expect(first.total).toBe(3);
        expect(first.nextCursor).toEqual(expect.any(String));

        const second = (
          await search(`city=Filtres&limit=2&sort=price_asc&cursor=${first.nextCursor}`)
        ).body;
        expect(second.items).toHaveLength(1);
        expect(second.nextCursor).toBeNull();

        expect([...names(first), ...names(second)]).toEqual([
          'F Bab Ezzouar',
          'F Hydra',
          'F Kouba',
        ]);
      });

      it('refuse un curseur falsifié', async () => {
        const { res } = await search('city=Filtres&cursor=pas-un-curseur');
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('VALIDATION_ERROR');
      });
    });

    describe('paramètres invalides', () => {
      it.each([
        ['paramètre inconnu', 'status=PENDING'],
        ['heure sans date', 'time=20:00'],
        ['nombre de joueurs absurde', 'players=40'],
        ['limite excessive', 'limit=500'],
        ['tri par distance sans position', 'sort=distance'],
        ['date impossible', 'date=2026-02-30'],
        ['latitude sans longitude', 'lat=36.7'],
      ])('refuse : %s', async (_label, query) => {
        const { res } = await search(query);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('VALIDATION_ERROR');
      });
    });

    it('résiste à une tentative d’injection dans les filtres (aucune erreur, aucun résultat)', async () => {
      const { res, body } = await search(
        `city=${encodeURIComponent('\'; DROP TABLE "Venue"; --')}`,
      );
      expect(res.statusCode).toBe(200);
      expect(body.items).toEqual([]);
      expect(await prisma.venue.count()).toBeGreaterThan(0);
    });
  });

  describe('recherche par date et heure (créneaux réellement disponibles)', () => {
    let full: Awaited<ReturnType<typeof createVenueWithFields>>;
    let busyEvening: Awaited<ReturnType<typeof createVenueWithFields>>;

    beforeAll(async () => {
      // Heures de pointe : 6000 DA de 18:00 à 23:00 ; 4000 DA avant.
      const rules = [
        { priceMinor: 4000 },
        { priceMinor: 6000, priority: 1, startMin: 1080, endMin: 1380 },
      ];
      full = await createVenueWithFields(
        { name: 'D Complet', city: 'DateCity', hours: { from: 600, to: 660 } },
        [{ rules }],
      );
      busyEvening = await createVenueWithFields({ name: 'D Soirée prise', city: 'DateCity' }, [
        { rules },
      ]);
      await createVenueWithFields({ name: 'D Libre', city: 'DateCity' }, [{ rules }, { rules }]);

      // « D Complet » n'ouvre qu'une heure (10:00) et elle est réservée
      await book({ fieldId: full.fields[0]!.id, venueId: full.venue.id }, DATE, '10:00');
      // « D Soirée prise » : toute la soirée de 18:00 à 22:00 est réservée
      for (const h of ['18:00', '19:00', '20:00', '21:00', '22:00']) {
        await book({ fieldId: busyEvening.fields[0]!.id, venueId: busyEvening.venue.id }, DATE, h);
      }
    });

    it('exclut les complexes sans créneau disponible ce jour-là', async () => {
      const { body } = await search(`city=DateCity&date=${DATE}`);
      expect(names(body).sort()).toEqual(['D Libre', 'D Soirée prise']);
    });

    it('avec une heure : ne garde que les complexes ayant un créneau libre à CETTE heure', async () => {
      expect(names((await search(`city=DateCity&date=${DATE}&time=20:00`)).body)).toEqual([
        'D Libre',
      ]);
      expect(names((await search(`city=DateCity&date=${DATE}&time=12:00`)).body).sort()).toEqual([
        'D Libre',
        'D Soirée prise',
      ]);
    });

    it('avec une tolérance (window) : accepte les créneaux proches de l’heure demandée', async () => {
      // « Soirée prise » est libre à 17:00 ; on cherche 18:00 avec 60 min de tolérance
      expect(
        names((await search(`city=DateCity&date=${DATE}&time=18:00&window=60`)).body),
      ).toContain('D Soirée prise');
      expect(
        names((await search(`city=DateCity&date=${DATE}&time=18:00&window=0`)).body),
      ).not.toContain('D Soirée prise');
    });

    it('prix max et heure se combinent sur le créneau réel (20:00 coûte 6000, 12:00 coûte 4000)', async () => {
      expect(
        names((await search(`city=DateCity&date=${DATE}&time=20:00&priceMax=5000`)).body),
      ).toEqual([]);
      expect(
        names((await search(`city=DateCity&date=${DATE}&time=20:00&priceMax=6000`)).body),
      ).toEqual(['D Libre']);
      expect(
        names((await search(`city=DateCity&date=${DATE}&time=12:00&priceMax=4000`)).body).sort(),
      ).toEqual(['D Libre', 'D Soirée prise']);
    });

    it('indique le nombre de créneaux correspondants et le premier', async () => {
      const { body } = await search(`city=DateCity&date=${DATE}&q=Libre`);
      const card = body.items[0];
      // 2 terrains × 13 créneaux (10:00 → 23:00)
      expect(card.matchingSlots).toBe(26);
      expect(card.firstMatchingSlotAt).toBe(slotAt(DATE, '10:00').toISOString());
    });

    it('un créneau annulé, expiré ou dont le verrou est dépassé redevient disponible', async () => {
      const target = await createVenueWithFields(
        { name: 'D Libérations', city: 'LiberCity', hours: { from: 600, to: 660 } },
        [{}],
      );
      const ids = { fieldId: target.fields[0]!.id, venueId: target.venue.id };
      const booking = await book(ids, DATE, '10:00', { status: 'CANCELLED' });
      expect(names((await search(`city=LiberCity&date=${DATE}`)).body)).toEqual(['D Libérations']);

      await prisma.booking.delete({ where: { id: booking.id } });
      await book(ids, DATE, '10:00', { status: 'PENDING_PAYMENT', holdExpiresAt: inMinutes(-1) });
      expect(names((await search(`city=LiberCity&date=${DATE}`)).body)).toEqual(['D Libérations']); // verrou dépassé

      await prisma.booking.deleteMany({ where: { fieldId: ids.fieldId } });
      await book(ids, DATE, '10:00', { status: 'PENDING_PAYMENT', holdExpiresAt: inMinutes(5) });
      expect(names((await search(`city=LiberCity&date=${DATE}`)).body)).toEqual([]); // verrou en cours : occupé
    });

    it('un créneau sans prix n’est pas proposé à la vente', async () => {
      await createVenueWithFields({ name: 'D Sans Tarif', city: 'NoPriceCity' }, [{ rules: [] }]);
      expect(names((await search(`city=NoPriceCity&date=${DATE}`)).body)).toEqual([]);
    });

    it('refuse une date passée ou trop lointaine, avec un message exploitable', async () => {
      const past = await search(`date=${dayIn(-5)}`);
      expect(past.res.statusCode).toBe(400);
      expect(past.body.error.details[0]).toMatchObject({ path: 'date', code: 'date_in_past' });

      const far = await search(`date=${dayIn(400)}`);
      expect(far.res.statusCode).toBe(400);
      expect(far.body.error.details[0]).toMatchObject({ path: 'date', code: 'date_too_far' });
    });
  });

  describe('fiche d’un complexe', () => {
    it('affiche terrains actifs, horaires du complexe et prix « à partir de », sans données internes', async () => {
      const { venue } = await createVenueWithFields(
        { name: 'Fiche Complète', photos: ['https://cdn.example/a.jpg'], amenities: ['parking'] },
        [
          { name: 'Terrain A', capacity: 10, rules: [{ priceMinor: 4500 }] },
          { name: 'Terrain B', capacity: 16, rules: [{ priceMinor: 3500 }] },
          { name: 'Terrain Fermé', isActive: false },
        ],
      );
      await prisma.venue.update({
        where: { id: venue.id },
        data: {
          cancellationPolicy: { freeUntilHoursBefore: 24, refundDeposit: false },
          depositPolicy: { mode: 'PERCENT' },
        },
      });

      const res = await get(t, `/venues/${venue.slug}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        name: 'Fiche Complète',
        priceFromMinor: 3500,
        photo: 'https://cdn.example/a.jpg',
        timezone: 'Africa/Algiers',
      });
      expect(body.fields.map((f: { name: string }) => f.name)).toEqual(['Terrain A', 'Terrain B']); // le terrain inactif est masqué
      expect(body.fields[1]).toMatchObject({
        capacity: 16,
        priceFromMinor: 3500,
        slotDurationMin: 60,
      });
      expect(body.openingHours).toHaveLength(7);
      expect(body.openingHours[0]).toEqual({
        weekday: 1,
        intervals: [{ from: '10:00', to: '23:00', overnight: false }],
      });

      // Rien d'interne ne fuite : politiques financières, statut, personnel.
      for (const secret of ['depositPolicy', 'cancellationPolicy', 'status', 'staff']) {
        expect(res.body).not.toContain(secret);
      }
    });

    it('404 pour un slug inconnu', async () => {
      const res = await get(t, '/venues/ce-complexe-nexiste-pas');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });
  });

  describe('disponibilités', () => {
    it('liste les créneaux de chaque terrain avec prix et statut ; la réservation d’un voisin n’affecte pas les autres', async () => {
      const { venue, fields } = await createVenueWithFields({ name: 'Dispo Test' }, [
        {
          name: 'Alpha',
          rules: [
            { priceMinor: 4000 },
            { priceMinor: 6000, priority: 1, startMin: 1200, endMin: 1380 },
          ],
        },
        { name: 'Beta' },
      ]);
      await book({ fieldId: fields[0]!.id, venueId: venue.id }, DATE, '20:00');

      const res = await get(t, `/venues/${venue.slug}/availability?date=${DATE}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ date: DATE, timezone: 'Africa/Algiers' });
      expect(body.fields.map((f: { name: string }) => f.name)).toEqual(['Alpha', 'Beta']);

      const alpha = body.fields[0];
      expect(alpha.slots).toHaveLength(13); // 10:00 → 23:00
      const at = (field: { slots: { startsAt: string }[] }, hhmm: string) =>
        field.slots.find((s) => s.startsAt === slotAt(DATE, hhmm).toISOString());
      expect(at(alpha, '20:00')).toMatchObject({ status: 'UNAVAILABLE', priceMinor: 6000 });
      expect(at(alpha, '21:00')).toMatchObject({ status: 'AVAILABLE', priceMinor: 6000 });
      expect(at(alpha, '12:00')).toMatchObject({ status: 'AVAILABLE', priceMinor: 4000 });
      expect(at(body.fields[1], '20:00')).toMatchObject({ status: 'AVAILABLE', priceMinor: 4000 });
    });

    it('ne révèle PAS pourquoi un créneau est indisponible (réservé, bloqué par le complexe) : seul « en cours de paiement » est visible', async () => {
      const { venue, fields } = await createVenueWithFields({ name: 'Confidentialité' }, [{}]);
      const ids = { fieldId: fields[0]!.id, venueId: venue.id };
      await book(ids, DATE, '10:00');
      await book(ids, DATE, '11:00', { type: 'BLOCK' });
      await book(ids, DATE, '12:00', { status: 'PENDING_PAYMENT', holdExpiresAt: inMinutes(5) });

      const res = await get(t, `/venues/${venue.slug}/availability?date=${DATE}`);
      const statuses = res
        .json()
        .fields[0].slots.slice(0, 4)
        .map((s: { status: string }) => s.status);
      expect(statuses).toEqual(['UNAVAILABLE', 'UNAVAILABLE', 'HELD', 'AVAILABLE']);
      expect(res.body).not.toMatch(/BOOKED|BLOCKED|PAST|NO_PRICE/);
    });

    it('masque les créneaux sans prix et les terrains inactifs', async () => {
      const { venue } = await createVenueWithFields({ name: 'Sans Prix' }, [
        { name: 'Tarifé' },
        { name: 'Non tarifé', rules: [] },
        { name: 'Inactif', isActive: false },
      ]);
      const res = await get(t, `/venues/${venue.slug}/availability?date=${DATE}`);
      const fields = res.json().fields;
      expect(fields.map((f: { name: string }) => f.name)).toEqual(['Non tarifé', 'Tarifé']);
      expect(fields[0].slots).toEqual([]); // aucun créneau vendable
      expect(fields[1].slots.length).toBeGreaterThan(0);
    });

    it('disponibilité d’un seul terrain', async () => {
      const { fields } = await createVenueWithFields({ name: 'Un Terrain' }, [
        { name: 'Premier' },
        { name: 'Second' },
      ]);
      const res = await get(t, `/fields/${fields[1]!.id}/availability?date=${DATE}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().fields).toHaveLength(1);
      expect(res.json().fields[0].name).toBe('Second');
    });

    it('un jour fermé (aucun horaire) ne retourne aucun créneau', async () => {
      const { venue } = await createVenueWithFields({ name: 'Fermé', hours: null }, [{}]);
      const res = await get(t, `/venues/${venue.slug}/availability?date=${DATE}`);
      expect(res.json().fields[0].slots).toEqual([]);
    });

    it('un complexe ouvert après minuit expose des créneaux rattachés au jour de service', async () => {
      const { venue } = await createVenueWithFields(
        { name: 'Nocturne', hours: { from: 22 * 60, to: 26 * 60 } },
        [{}],
      );
      const res = await get(t, `/venues/${venue.slug}/availability?date=${DATE}`);
      const starts = res.json().fields[0].slots.map((s: { startsAt: string }) => s.startsAt);
      expect(starts).toEqual([
        slotAt(DATE, '22:00').toISOString(),
        slotAt(DATE, '23:00').toISOString(),
        slotAt(dayIn(8), '00:00').toISOString(), // 00:00 le lendemain, mais jour de service = DATE
        slotAt(dayIn(8), '01:00').toISOString(),
      ]);
    });

    it('applique des horaires propres à un terrain à la place de ceux du complexe', async () => {
      const { venue, fields } = await createVenueWithFields({ name: 'Horaires Terrain' }, [
        { name: 'Standard' },
        { name: 'Matinal' },
      ]);
      await prisma.openingHour.createMany({
        data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          venueId: venue.id,
          fieldId: fields[1]!.id,
          weekday,
          opensAtMin: 8 * 60,
          closesAtMin: 10 * 60,
        })),
      });
      const res = await get(t, `/venues/${venue.slug}/availability?date=${DATE}`);
      const byName = (name: string) =>
        res.json().fields.find((f: { name: string }) => f.name === name);
      const standard = byName('Standard');
      const matinal = byName('Matinal');
      expect(standard.slots).toHaveLength(13);
      expect(matinal.slots).toHaveLength(2); // 08:00 et 09:00 uniquement
    });

    it('refuse une date mal formée, passée, trop lointaine, ou un identifiant de terrain invalide', async () => {
      const { venue } = await createVenueWithFields({ name: 'Dates' }, [{}]);
      for (const query of [
        '',
        '?date=demain',
        '?date=2026-02-30',
        `?date=${dayIn(-3)}`,
        `?date=${dayIn(400)}`,
      ]) {
        const res = await get(t, `/venues/${venue.slug}/availability${query}`);
        expect(res.statusCode, query).toBe(400);
      }
      expect((await get(t, `/fields/pas-un-uuid/availability?date=${DATE}`)).statusCode).toBe(400);
    });

    it('l’heure d’aujourd’hui : les créneaux déjà commencés sont indisponibles', async () => {
      const today = dayIn(0);
      const { venue } = await createVenueWithFields(
        { name: 'Aujourdhui', hours: { from: 0, to: 1440 } },
        [{}],
      );
      const res = await get(t, `/venues/${venue.slug}/availability?date=${today}`);
      const slots = res.json().fields[0].slots as { startsAt: string; status: string }[];
      const past = slots.filter((s) => new Date(s.startsAt) < new Date());
      expect(past.every((s) => s.status === 'UNAVAILABLE')).toBe(true);
    });
  });

  it('le moteur utilise le préavis réglable par l’admin (booking.min_lead_minutes)', async () => {
    await prisma.platformSetting.upsert({
      where: { key: 'booking.min_lead_minutes' },
      create: { key: 'booking.min_lead_minutes', value: 60 * 24 * 30 },
      update: { value: 60 * 24 * 30 },
    });
    try {
      const { venue } = await createVenueWithFields({ name: 'Préavis' }, [{}]);
      // Préavis de 30 jours : un créneau dans 7 jours n'est plus réservable
      const res = await get(t, `/venues/${venue.slug}/availability?date=${DATE}`);
      expect(
        res.json().fields[0].slots.every((s: { status: string }) => s.status === 'UNAVAILABLE'),
      ).toBe(true);
    } finally {
      await prisma.platformSetting.delete({ where: { key: 'booking.min_lead_minutes' } });
    }
  });

  it('une recherche par date sur 12 complexes (24 terrains) reste rapide', async () => {
    for (let i = 0; i < 12; i++)
      await createVenueWithFields({ name: `Lot ${i}`, city: 'LotCity' }, [{}, {}]);
    const start = Date.now();
    const res = await get(t, `/venues?city=LotCity&date=${DATE}&time=20:00&limit=50`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(12);
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
