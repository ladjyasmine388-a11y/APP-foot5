import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PG_ERROR, isPgError } from '../../src/infra/database/pg-errors.js';
import {
  SLOT_START,
  addMinutes,
  bookingData,
  expectPgError,
  makeField,
  makeUser,
  makeVenueWithField,
  prisma,
  resetDb,
} from './helpers.js';

/**
 * La règle fondamentale du produit : un terrain ne peut JAMAIS être occupé deux fois en même temps.
 * Ici on teste la garantie au niveau de la BASE DE DONNÉES (contrainte d'exclusion),
 * indépendamment de tout code applicatif.
 */
describe('anti-double-réservation (contrainte d’exclusion PostgreSQL)', () => {
  let ids: { fieldId: string; venueId: string };

  beforeAll(resetDb);

  beforeEach(async () => {
    const { venue, field } = await makeVenueWithField();
    ids = { fieldId: field.id, venueId: venue.id };
  });

  it('refuse une seconde réservation active sur le même créneau', async () => {
    await prisma.booking.create({ data: bookingData(ids) });
    await expectPgError(
      prisma.booking.create({ data: bookingData(ids) }),
      PG_ERROR.EXCLUSION_VIOLATION,
    );
  });

  it('refuse un chevauchement partiel (début ou fin dans un créneau déjà pris)', async () => {
    await prisma.booking.create({ data: bookingData(ids) }); // 19:00 → 20:00
    await expectPgError(
      prisma.booking.create({ data: bookingData(ids, { start: addMinutes(SLOT_START, 30) }) }), // 19:30 → 20:30
      PG_ERROR.EXCLUSION_VIOLATION,
    );
    await expectPgError(
      prisma.booking.create({ data: bookingData(ids, { start: addMinutes(SLOT_START, -30) }) }), // 18:30 → 19:30
      PG_ERROR.EXCLUSION_VIOLATION,
    );
  });

  it('accepte des créneaux consécutifs (19:00–20:00 puis 20:00–21:00)', async () => {
    await prisma.booking.create({ data: bookingData(ids) });
    await expect(
      prisma.booking.create({ data: bookingData(ids, { start: addMinutes(SLOT_START, 60) }) }),
    ).resolves.toBeDefined();
    await expect(
      prisma.booking.create({ data: bookingData(ids, { start: addMinutes(SLOT_START, -60) }) }),
    ).resolves.toBeDefined();
  });

  it('accepte le même horaire sur un AUTRE terrain', async () => {
    const other = await makeField(ids.venueId);
    await prisma.booking.create({ data: bookingData(ids) });
    await expect(
      prisma.booking.create({ data: bookingData({ fieldId: other.id, venueId: ids.venueId }) }),
    ).resolves.toBeDefined();
  });

  it('un verrou en attente de paiement (PENDING_PAYMENT) bloque aussi le créneau', async () => {
    await prisma.booking.create({ data: bookingData(ids, { status: 'PENDING_PAYMENT' }) });
    await expectPgError(
      prisma.booking.create({ data: bookingData(ids) }),
      PG_ERROR.EXCLUSION_VIOLATION,
    );
  });

  it.each(['CANCELLED', 'EXPIRED'] as const)(
    'un créneau %s redevient réservable',
    async (status) => {
      await prisma.booking.create({ data: bookingData(ids, { status }) });
      await expect(prisma.booking.create({ data: bookingData(ids) })).resolves.toBeDefined();
    },
  );

  it.each(['COMPLETED', 'NO_SHOW'] as const)(
    'un créneau %s reste occupé (on ne réécrit pas le passé)',
    async (status) => {
      await prisma.booking.create({ data: bookingData(ids, { status }) });
      await expectPgError(
        prisma.booking.create({ data: bookingData(ids) }),
        PG_ERROR.EXCLUSION_VIOLATION,
      );
    },
  );

  it('l’expiration d’un verrou libère le créneau pour quelqu’un d’autre', async () => {
    const hold = await prisma.booking.create({
      data: bookingData(ids, { status: 'PENDING_PAYMENT' }),
    });
    await prisma.booking.update({ where: { id: hold.id }, data: { status: 'EXPIRED' } });
    await expect(prisma.booking.create({ data: bookingData(ids) })).resolves.toBeDefined();
  });

  it('on ne peut pas « ressusciter » une réservation annulée si le créneau a été repris', async () => {
    const first = await prisma.booking.create({ data: bookingData(ids) });
    await prisma.booking.update({ where: { id: first.id }, data: { status: 'CANCELLED' } });
    await prisma.booking.create({ data: bookingData(ids) }); // quelqu'un d'autre a pris le créneau
    await expectPgError(
      prisma.booking.update({ where: { id: first.id }, data: { status: 'CONFIRMED' } }),
      PG_ERROR.EXCLUSION_VIOLATION,
    );
  });

  describe('blocages du complexe (même table, même contrainte)', () => {
    it('un blocage ne peut pas chevaucher une réservation existante', async () => {
      await prisma.booking.create({ data: bookingData(ids) });
      await expectPgError(
        prisma.booking.create({ data: bookingData(ids, { bookingType: 'BLOCK' }) }),
        PG_ERROR.EXCLUSION_VIOLATION,
      );
    });

    it('une réservation ne peut pas être créée sur un créneau bloqué', async () => {
      await prisma.booking.create({ data: bookingData(ids, { bookingType: 'BLOCK' }) });
      await expectPgError(
        prisma.booking.create({ data: bookingData(ids) }),
        PG_ERROR.EXCLUSION_VIOLATION,
      );
    });
  });
});

/**
 * LE scénario exigé par le cahier des charges :
 * plusieurs utilisateurs réservent EN MÊME TEMPS le même terrain au même créneau → un seul réussit.
 */
describe('concurrence : réservations simultanées du même créneau', () => {
  beforeAll(resetDb);

  it('2 utilisateurs simultanés : un seul obtient le créneau', async () => {
    const { venue, field } = await makeVenueWithField();
    const ids = { fieldId: field.id, venueId: venue.id };
    const [alice, bob] = await Promise.all([makeUser(), makeUser()]);

    const results = await Promise.allSettled([
      prisma.booking.create({
        data: bookingData(ids, { userId: alice.id, status: 'PENDING_PAYMENT' }),
      }),
      prisma.booking.create({
        data: bookingData(ids, { userId: bob.id, status: 'PENDING_PAYMENT' }),
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(isPgError(rejected[0]?.reason, PG_ERROR.EXCLUSION_VIOLATION)).toBe(true);

    expect(await prisma.booking.count({ where: { fieldId: field.id } })).toBe(1);
  });

  it('25 utilisateurs simultanés : exactement UN gagnant, 24 refus propres', async () => {
    const { venue, field } = await makeVenueWithField();
    const ids = { fieldId: field.id, venueId: venue.id };
    const users = await Promise.all(Array.from({ length: 25 }, () => makeUser()));

    const results = await Promise.allSettled(
      users.map((u) =>
        prisma.booking.create({
          data: bookingData(ids, { userId: u.id, status: 'PENDING_PAYMENT' }),
        }),
      ),
    );

    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(24);
    // Chaque refus est bien un conflit de créneau (et pas un autre bug).
    for (const loser of losers) {
      expect(isPgError(loser.reason, PG_ERROR.EXCLUSION_VIOLATION)).toBe(true);
    }
    expect(await prisma.booking.count({ where: { fieldId: field.id } })).toBe(1);
  });

  it('des créneaux DIFFÉRENTS réservés en parallèle réussissent tous (pas de verrou global)', async () => {
    const { venue, field } = await makeVenueWithField();
    const ids = { fieldId: field.id, venueId: venue.id };

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        prisma.booking.create({
          data: bookingData(ids, { start: addMinutes(SLOT_START, i * 60) }),
        }),
      ),
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await prisma.booking.count({ where: { fieldId: field.id } })).toBe(10);
  });
});
