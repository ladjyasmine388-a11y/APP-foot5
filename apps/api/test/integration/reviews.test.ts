import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedBaseline } from '../../src/infra/database/baseline.js';
import {
  lockVenueForRating,
  recomputeVenueRating,
} from '../../src/modules/reviews/reviews.service.js';
import { type Signup, type TestApp, bearer, createTestApp, get, post } from './app-helper.js';
import { prisma, resetDb } from './helpers.js';
import { type World, confirmedBooking, createWorld, newPlayer } from './social-fixtures.js';

describe('avis sur les complexes', () => {
  let t: TestApp;
  let w: World;

  beforeAll(async () => {
    await resetDb();
    await seedBaseline(prisma);
    t = await createTestApp();
    w = await createWorld(t);
  });
  afterAll(() => t.close());
  beforeEach(() => t.rateLimits.reset());

  const review = (user: Signup, bookingId: string, body: object) =>
    post(t, `/bookings/${bookingId}/review`, body, bearer(user.accessToken));
  /** Un joueur avec une réservation terminée. */
  async function played(world: World = w) {
    const user = await newPlayer(t);
    const booking = await confirmedBooking(world, user, { status: 'COMPLETED' });
    return { user, booking };
  }
  const venueRating = async (id = w.venue.id) =>
    prisma.venue.findUniqueOrThrow({
      where: { id },
      select: { ratingAvg: true, ratingCount: true },
    });

  it('un avis après le match : enregistré, auteur abrégé, note du complexe recalculée, audit', async () => {
    const { user, booking } = await played();
    const res = await review(user, booking.id, {
      rating: 4,
      comment: 'Très bon terrain, éclairage parfait.',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      rating: 4,
      comment: 'Très bon terrain, éclairage parfait.',
    });
    expect(res.json().author).toMatch(/^\S+ \S\.$/);
    expect(res.body).not.toContain(user.email);
    expect(res.body).not.toContain(user.userId);
    expect(await venueRating()).toEqual({ ratingAvg: 4, ratingCount: 1 });
    expect(
      await prisma.auditLog.count({ where: { action: 'review.create', entityId: res.json().id } }),
    ).toBe(1);

    const mine = await get(t, `/bookings/${booking.id}/review`, user.accessToken);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().id).toBe(res.json().id);
  });

  it('la note est la moyenne des avis visibles', async () => {
    const world = await createWorld(t);
    for (const rating of [5, 4, 4]) {
      const { user, booking } = await played(world);
      await review(user, booking.id, { rating });
    }
    expect(await venueRating(world.venue.id)).toEqual({ ratingAvg: 4.33, ratingCount: 3 });
  });

  it('un seul avis par réservation', async () => {
    const { user, booking } = await played();
    expect((await review(user, booking.id, { rating: 5 })).statusCode).toBe(201);
    const again = await review(user, booking.id, { rating: 1 });
    expect(again.statusCode).toBe(409);
    expect(await prisma.review.count({ where: { bookingId: booking.id } })).toBe(1);
  });

  it('CONCURRENCE : 8 avis simultanés sur le même complexe → la note les compte tous', async () => {
    const world = await createWorld(t);
    const players = await Promise.all(Array.from({ length: 8 }, () => played(world)));
    t.rateLimits.reset();
    const results = await Promise.all(
      players.map(({ user, booking }, i) => review(user, booking.id, { rating: (i % 5) + 1 })),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);

    const expectedAvg =
      Math.round((players.reduce((sum, _p, i) => sum + ((i % 5) + 1), 0) / 8) * 100) / 100;
    expect(await venueRating(world.venue.id)).toEqual({ ratingAvg: expectedAvg, ratingCount: 8 });
  });

  it('refuse : match pas encore joué, réservation annulée, réservation d’un autre, blocage du complexe, délai dépassé', async () => {
    const user = await newPlayer(t);
    const confirmed = await confirmedBooking(w, user);
    const early = await review(user, confirmed.id, { rating: 5 });
    expect(early.statusCode).toBe(409);

    const cancelled = await confirmedBooking(w, user, { status: 'CANCELLED' });
    expect((await review(user, cancelled.id, { rating: 5 })).statusCode).toBe(409);

    const { booking: someoneElses } = await played();
    expect((await review(user, someoneElses.id, { rating: 5 })).statusCode).toBe(404);
    expect(
      (await review(user, '00000000-0000-4000-8000-000000000000', { rating: 5 })).statusCode,
    ).toBe(404);

    const late = await confirmedBooking(w, user, { status: 'COMPLETED' });
    await prisma.booking.update({
      where: { id: late.id },
      data: {
        startsAt: new Date(Date.now() - 41 * 86_400_000),
        endsAt: new Date(Date.now() - 40 * 86_400_000),
      },
    });
    const tooLate = await review(user, late.id, { rating: 5 });
    expect(tooLate.statusCode).toBe(409);
    expect(tooLate.json().error.message).toContain('30');
    expect(await prisma.review.count({ where: { userId: user.userId } })).toBe(0);
  });

  it('valide la note et le commentaire, refuse les champs inconnus, exige une connexion', async () => {
    const { user, booking } = await played();
    for (const bad of [
      { rating: 0 },
      { rating: 6 },
      { rating: 3.5 },
      { rating: '5' },
      {},
      { rating: 5, comment: '' },
      { rating: 5, comment: 'x'.repeat(1001) },
      { rating: 5, venueId: 'x' },
      { rating: 5, hiddenAt: null },
      { rating: 5, userId: user.userId },
    ]) {
      expect(
        (await review(user, booking.id, bad)).statusCode,
        JSON.stringify(bad).slice(0, 60),
      ).toBe(400);
    }
    expect((await post(t, `/bookings/${booking.id}/review`, { rating: 5 })).statusCode).toBe(401);
    expect(await prisma.review.count({ where: { bookingId: booking.id } })).toBe(0);
  });

  it('un commentaire HTML est conservé tel quel (les clients l’affichent comme du texte) et jamais interprété côté serveur', async () => {
    const { user, booking } = await played();
    const res = await review(user, booking.id, {
      rating: 3,
      comment: '<img src=x onerror=alert(1)>',
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json().comment).toBe('<img src=x onerror=alert(1)>');
  });

  describe('avis publics du complexe', () => {
    it('visibles sans connexion, paginés, les plus récents d’abord ; les avis masqués disparaissent et la note suit', async () => {
      const world = await createWorld(t);
      const ids: string[] = [];
      for (const rating of [5, 1, 3]) {
        const { user, booking } = await played(world);
        ids.push((await review(user, booking.id, { rating, comment: `Note ${rating}` })).json().id);
      }

      const page1 = (await get(t, `/venues/${world.venue.slug}/reviews?limit=2`)).json();
      expect(page1.items.map((r: { rating: number }) => r.rating)).toEqual([3, 1]);
      expect(page1).toMatchObject({ ratingAvg: 3, ratingCount: 3 });
      const page2 = (
        await get(t, `/venues/${world.venue.slug}/reviews?limit=2&cursor=${page1.nextCursor}`)
      ).json();
      expect(page2.items.map((r: { rating: number }) => r.rating)).toEqual([5]);
      expect(page2.nextCursor).toBeNull();
      expect(Object.keys(page1.items[0]).sort()).toEqual([
        'author',
        'comment',
        'createdAt',
        'id',
        'rating',
      ]);

      // Modération : masquer l'avis « 1 » (utilisé par l'administration à l'étape suivante)
      await prisma.$transaction(async (tx) => {
        await lockVenueForRating(tx, world.venue.id);
        await tx.review.update({ where: { id: ids[1]! }, data: { hiddenAt: new Date() } });
        await recomputeVenueRating(tx, world.venue.id);
      });
      const after = (await get(t, `/venues/${world.venue.slug}/reviews`)).json();
      expect(after.items.map((r: { rating: number }) => r.rating)).toEqual([3, 5]);
      expect(after).toMatchObject({ ratingAvg: 4, ratingCount: 2 });
    });

    it('un complexe non approuvé ou inconnu : 404 ; paramètres invalides : 400', async () => {
      const world = await createWorld(t);
      await prisma.venue.update({ where: { id: world.venue.id }, data: { status: 'SUSPENDED' } });
      expect((await get(t, `/venues/${world.venue.slug}/reviews`)).statusCode).toBe(404);
      expect((await get(t, '/venues/nulle-part/reviews')).statusCode).toBe(404);
      expect((await get(t, `/venues/${w.venue.slug}/reviews?limit=500`)).statusCode).toBe(400);
    });

    it('le nom d’un compte supprimé n’apparaît pas', async () => {
      const world = await createWorld(t);
      const { user, booking } = await played(world);
      await review(user, booking.id, { rating: 5 });
      await prisma.user.update({ where: { id: user.userId }, data: { status: 'DELETED' } });
      expect((await get(t, `/venues/${world.venue.slug}/reviews`)).json().items[0].author).toBe(
        'Utilisateur supprimé',
      );
    });
  });
});
