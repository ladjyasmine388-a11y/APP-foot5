import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PG_ERROR } from '../../src/infra/database/pg-errors.js';
import {
  addMinutes,
  bookingData,
  clearGlobalConfig,
  expectPgError,
  makeField,
  makeUser,
  makeVenue,
  makeVenueWithField,
  money,
  prisma,
  resetDb,
  SLOT_START,
} from './helpers.js';

const { CHECK_VIOLATION, UNIQUE_VIOLATION, FOREIGN_KEY_VIOLATION, INSUFFICIENT_PRIVILEGE } =
  PG_ERROR;

describe('garanties financières d’une réservation', () => {
  let ids: { fieldId: string; venueId: string };

  beforeAll(resetDb);

  beforeEach(async () => {
    const { venue, field } = await makeVenueWithField();
    ids = { fieldId: field.id, venueId: venue.id };
  });

  it('accepte l’exemple du cahier des charges : 4000 DA, commission 1 % = 40 DA, complexe 3960 DA', async () => {
    const booking = await prisma.booking.create({ data: bookingData(ids, { base: 4000 }) });
    expect(booking.basePriceMinor).toBe(4000);
    expect(booking.commissionMinor).toBe(40);
    expect(booking.platformAmountMinor).toBe(40);
    expect(booking.venueAmountMinor).toBe(3960);
  });

  it('refuse un montant complexe incohérent avec le prix et la commission', async () => {
    await expectPgError(
      prisma.booking.create({ data: { ...bookingData(ids), venueAmountMinor: 9999 } }),
      CHECK_VIOLATION,
    );
  });

  it('refuse un total incohérent (base + frais + taxes)', async () => {
    await expectPgError(
      prisma.booking.create({ data: { ...bookingData(ids), totalMinor: 123 } }),
      CHECK_VIOLATION,
    );
  });

  it('refuse un découpage ligne/sur place qui ne somme pas au total', async () => {
    await expectPgError(
      prisma.booking.create({
        data: { ...bookingData(ids), dueOnlineMinor: 5, dueOnSiteMinor: 5 },
      }),
      CHECK_VIOLATION,
    );
  });

  it('refuse un montant négatif', async () => {
    await expectPgError(
      prisma.booking.create({ data: { ...bookingData(ids), feesMinor: -1 } }),
      CHECK_VIOLATION,
    );
  });

  it('refuse une commission supérieure au prix du terrain', async () => {
    await expectPgError(
      prisma.booking.create({
        data: { ...bookingData(ids), ...money(100, 100, 500) },
      }),
      CHECK_VIOLATION,
    );
  });

  it('refuse un taux de commission hors de 0–100 %', async () => {
    await expectPgError(
      prisma.booking.create({ data: { ...bookingData(ids), commissionRateBps: 10001 } }),
      CHECK_VIOLATION,
    );
  });

  it('refuse une réservation dont la fin précède le début', async () => {
    await expectPgError(
      prisma.booking.create({ data: { ...bookingData(ids), endsAt: addMinutes(SLOT_START, -30) } }),
      CHECK_VIOLATION,
    );
  });

  it('refuse un verrou de paiement sans date d’expiration (il bloquerait le créneau à vie)', async () => {
    await expectPgError(
      prisma.booking.create({
        data: { ...bookingData(ids, { status: 'PENDING_PAYMENT' }), holdExpiresAt: null },
      }),
      CHECK_VIOLATION,
    );
  });

  it('refuse une réservation sans client ni nom', async () => {
    await expectPgError(
      prisma.booking.create({ data: { ...bookingData(ids), customerName: null, userId: null } }),
      CHECK_VIOLATION,
    );
  });

  it('refuse qu’un blocage porte un client ou un montant', async () => {
    const user = await makeUser();
    await expectPgError(
      prisma.booking.create({
        data: { ...bookingData(ids, { bookingType: 'BLOCK' }), userId: user.id },
      }),
      CHECK_VIOLATION,
    );
    await expectPgError(
      prisma.booking.create({
        data: { ...bookingData(ids, { bookingType: 'BLOCK' }), ...money(4000) },
      }),
      CHECK_VIOLATION,
    );
  });

  it('refuse deux réservations avec la même référence', async () => {
    const first = await prisma.booking.create({ data: bookingData(ids) });
    await expectPgError(
      prisma.booking.create({
        data: {
          ...bookingData(ids, { start: addMinutes(SLOT_START, 120) }),
          reference: first.reference,
        },
      }),
      UNIQUE_VIOLATION,
    );
  });
});

describe('isolation entre complexes (multi-tenant)', () => {
  it('refuse une réservation qui associe un terrain à un AUTRE complexe', async () => {
    const venueA = await makeVenue('Complexe A');
    const venueB = await makeVenue('Complexe B');
    const fieldOfA = await makeField(venueA.id);

    await expectPgError(
      prisma.booking.create({ data: bookingData({ fieldId: fieldOfA.id, venueId: venueB.id }) }),
      FOREIGN_KEY_VIOLATION,
    );
  });
});

describe('configuration de l’offre', () => {
  it('accepte des terrains de 10 à 16 joueurs, refuse le reste', async () => {
    const venue = await makeVenue();
    for (const capacity of [10, 12, 16]) {
      await expect(
        prisma.field.create({ data: { venueId: venue.id, name: `T${capacity}`, capacity } }),
      ).resolves.toBeDefined();
    }
    for (const capacity of [9, 17]) {
      await expectPgError(
        prisma.field.create({ data: { venueId: venue.id, name: `X${capacity}`, capacity } }),
        CHECK_VIOLATION,
      );
    }
  });

  it('refuse deux terrains de même nom dans un même complexe, mais l’autorise dans un autre', async () => {
    const a = await makeVenue('A');
    const b = await makeVenue('B');
    await makeField(a.id, 'Terrain 1');
    await expectPgError(
      prisma.field.create({ data: { venueId: a.id, name: 'Terrain 1' } }),
      UNIQUE_VIOLATION,
    );
    await expect(makeField(b.id, 'Terrain 1')).resolves.toBeDefined();
  });

  it('accepte une fermeture après minuit (02:00) mais refuse un horaire incohérent', async () => {
    const venue = await makeVenue();
    await expect(
      prisma.openingHour.create({
        data: { venueId: venue.id, weekday: 5, opensAtMin: 10 * 60, closesAtMin: 26 * 60 },
      }),
    ).resolves.toBeDefined();
    await expectPgError(
      prisma.openingHour.create({
        data: { venueId: venue.id, weekday: 5, opensAtMin: 600, closesAtMin: 500 },
      }),
      CHECK_VIOLATION,
    );
    await expectPgError(
      prisma.openingHour.create({
        data: { venueId: venue.id, weekday: 8, opensAtMin: 600, closesAtMin: 900 },
      }),
      CHECK_VIOLATION,
    );
  });

  it('refuse une règle de prix sans jour ou avec un jour invalide', async () => {
    const { field } = await makeVenueWithField();
    await expectPgError(
      prisma.pricingRule.create({
        data: { fieldId: field.id, weekdays: [], startMin: 0, endMin: 600, priceMinor: 4000 },
      }),
      CHECK_VIOLATION,
    );
    await expectPgError(
      prisma.pricingRule.create({
        data: { fieldId: field.id, weekdays: [0], startMin: 0, endMin: 600, priceMinor: 4000 },
      }),
      CHECK_VIOLATION,
    );
  });
});

describe('commission : une seule règle active par portée', () => {
  beforeEach(clearGlobalConfig);

  it('refuse deux règles GLOBAL actives en même temps', async () => {
    await prisma.commissionRule.create({ data: { scope: 'GLOBAL', rateBps: 100 } });
    await expectPgError(
      prisma.commissionRule.create({ data: { scope: 'GLOBAL', rateBps: 200 } }),
      UNIQUE_VIOLATION,
    );
  });

  it('permet de remplacer la règle : on clôture l’ancienne puis on crée la nouvelle', async () => {
    const old = await prisma.commissionRule.create({ data: { scope: 'GLOBAL', rateBps: 100 } });
    await prisma.commissionRule.update({
      where: { id: old.id },
      data: { validTo: new Date(), isActive: false },
    });
    await expect(
      prisma.commissionRule.create({ data: { scope: 'GLOBAL', rateBps: 150 } }),
    ).resolves.toBeDefined();
  });

  it('refuse une portée VENUE sans complexe, ou un taux hors limites', async () => {
    await expectPgError(
      prisma.commissionRule.create({ data: { scope: 'VENUE', rateBps: 100 } }),
      CHECK_VIOLATION,
    );
    await expectPgError(
      prisma.commissionRule.create({ data: { scope: 'GLOBAL', rateBps: 20000 } }),
      CHECK_VIOLATION,
    );
  });

  it('autorise une règle par complexe, avec un taux différent du global', async () => {
    const venue = await makeVenue();
    await prisma.commissionRule.create({ data: { scope: 'GLOBAL', rateBps: 100 } });
    await expect(
      prisma.commissionRule.create({ data: { scope: 'VENUE', venueId: venue.id, rateBps: 50 } }),
    ).resolves.toBeDefined();
    await expectPgError(
      prisma.commissionRule.create({ data: { scope: 'VENUE', venueId: venue.id, rateBps: 70 } }),
      UNIQUE_VIOLATION,
    );
  });
});

describe('utilisateurs', () => {
  it('refuse un email contenant des majuscules (doublon invisible)', async () => {
    await expectPgError(makeUser({ email: 'Yas@Test.local' }), CHECK_VIOLATION);
  });

  it('refuse deux comptes avec le même email', async () => {
    await makeUser({ email: 'yas@test.local' });
    await expectPgError(makeUser({ email: 'yas@test.local' }), UNIQUE_VIOLATION);
  });

  it('refuse une langue non supportée', async () => {
    await expectPgError(
      prisma.user.create({
        data: { email: 'x@test.local', phone: '0', firstName: 'a', lastName: 'b', locale: 'de' },
      }),
      CHECK_VIOLATION,
    );
  });
});

describe('équipes', () => {
  it('refuse deux adhésions actives du même joueur à la même équipe, mais permet de revenir après un départ', async () => {
    const captain = await makeUser();
    const player = await makeUser();
    const team = await prisma.team.create({ data: { name: 'Les Lions', captainId: captain.id } });

    const membership = await prisma.teamMember.create({
      data: { teamId: team.id, userId: player.id },
    });
    await expectPgError(
      prisma.teamMember.create({ data: { teamId: team.id, userId: player.id } }),
      UNIQUE_VIOLATION,
    );

    await prisma.teamMember.update({ where: { id: membership.id }, data: { leftAt: new Date() } });
    await expect(
      prisma.teamMember.create({ data: { teamId: team.id, userId: player.id } }),
    ).resolves.toBeDefined();
  });

  it('refuse deux capitaines actifs dans la même équipe', async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    const team = await prisma.team.create({ data: { name: 'Les Aigles', captainId: a.id } });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: a.id, role: 'CAPTAIN' } });
    await expectPgError(
      prisma.teamMember.create({ data: { teamId: team.id, userId: b.id, role: 'CAPTAIN' } }),
      UNIQUE_VIOLATION,
    );
  });

  it('refuse une invitation sans destinataire, et deux invitations en attente pour le même joueur', async () => {
    const [captain, invitee] = await Promise.all([makeUser(), makeUser()]);
    const team = await prisma.team.create({ data: { name: 'Les Requins', captainId: captain.id } });
    const expiresAt = addMinutes(new Date(), 60 * 24);

    await expectPgError(
      prisma.teamInvitation.create({
        data: { teamId: team.id, inviterId: captain.id, expiresAt },
      }),
      CHECK_VIOLATION,
    );

    await prisma.teamInvitation.create({
      data: { teamId: team.id, inviterId: captain.id, inviteeId: invitee.id, expiresAt },
    });
    await expectPgError(
      prisma.teamInvitation.create({
        data: { teamId: team.id, inviterId: captain.id, inviteeId: invitee.id, expiresAt },
      }),
      UNIQUE_VIOLATION,
    );
  });
});

describe('sessions « Complétez votre équipe »', () => {
  async function makeSession(capacity: number) {
    const { venue, field } = await makeVenueWithField();
    const host = await makeUser();
    const booking = await prisma.booking.create({
      data: bookingData({ fieldId: field.id, venueId: venue.id }, { userId: host.id }),
    });
    return prisma.soloSession.create({
      data: {
        bookingId: booking.id,
        createdById: host.id,
        venueId: venue.id,
        fieldId: field.id,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
        capacity,
      },
    });
  }

  it('refuse le surbooking : joinedCount ne peut pas dépasser la capacité', async () => {
    const session = await makeSession(5);
    await expect(
      prisma.soloSession.update({ where: { id: session.id }, data: { joinedCount: 5 } }),
    ).resolves.toBeDefined();
    await expectPgError(
      prisma.soloSession.update({ where: { id: session.id }, data: { joinedCount: 6 } }),
      CHECK_VIOLATION,
    );
  });

  it('refuse qu’un même joueur s’inscrive deux fois à la même session', async () => {
    const session = await makeSession(5);
    const player = await makeUser();
    await prisma.soloPlayer.create({ data: { sessionId: session.id, userId: player.id } });
    await expectPgError(
      prisma.soloPlayer.create({ data: { sessionId: session.id, userId: player.id } }),
      UNIQUE_VIOLATION,
    );
  });

  it('refuse deux sessions pour la même réservation', async () => {
    const session = await makeSession(5);
    await expectPgError(
      prisma.soloSession.create({
        data: {
          bookingId: session.bookingId,
          createdById: session.createdById,
          venueId: session.venueId,
          fieldId: session.fieldId,
          startsAt: session.startsAt,
          endsAt: session.endsAt,
          capacity: 5,
        },
      }),
      UNIQUE_VIOLATION,
    );
  });
});

describe('adversaires et matchs', () => {
  async function makeListingWithTeams() {
    const { venue, field } = await makeVenueWithField();
    const [capA, capB, capC] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const [teamA, teamB, teamC] = await Promise.all(
      [capA, capB, capC].map((c, i) =>
        prisma.team.create({ data: { name: `Équipe ${i}`, captainId: c.id } }),
      ),
    );
    const booking = await prisma.booking.create({
      data: bookingData({ fieldId: field.id, venueId: venue.id }, { userId: capA.id }),
    });
    const listing = await prisma.opponentListing.create({
      data: {
        teamId: teamA!.id,
        bookingId: booking.id,
        createdById: capA.id,
        venueId: venue.id,
        fieldId: field.id,
        startsAt: booking.startsAt,
        playersPerSide: 5,
      },
    });
    return { listing, teamB: teamB!, teamC: teamC!, capB, capC };
  }

  it('refuse un second adversaire ACCEPTÉ sur la même annonce', async () => {
    const { listing, teamB, teamC, capB, capC } = await makeListingWithTeams();
    await prisma.matchRequest.create({
      data: {
        listingId: listing.id,
        requestingTeamId: teamB.id,
        requestedById: capB.id,
        status: 'ACCEPTED',
      },
    });
    await expectPgError(
      prisma.matchRequest.create({
        data: {
          listingId: listing.id,
          requestingTeamId: teamC.id,
          requestedById: capC.id,
          status: 'ACCEPTED',
        },
      }),
      UNIQUE_VIOLATION,
    );
  });

  it('refuse deux demandes en attente de la même équipe sur la même annonce', async () => {
    const { listing, teamB, capB } = await makeListingWithTeams();
    const data = { listingId: listing.id, requestingTeamId: teamB.id, requestedById: capB.id };
    await prisma.matchRequest.create({ data });
    await expectPgError(prisma.matchRequest.create({ data }), UNIQUE_VIOLATION);
  });

  it('refuse un match entre une équipe et elle-même', async () => {
    const { venue, field } = await makeVenueWithField();
    const captain = await makeUser();
    const team = await prisma.team.create({ data: { name: 'Solo', captainId: captain.id } });
    const booking = await prisma.booking.create({
      data: bookingData({ fieldId: field.id, venueId: venue.id }, { userId: captain.id }),
    });
    await expectPgError(
      prisma.match.create({
        data: {
          source: 'TEAM',
          bookingId: booking.id,
          venueId: venue.id,
          fieldId: field.id,
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
          teamAId: team.id,
          teamBId: team.id,
          createdById: captain.id,
        },
      }),
      CHECK_VIOLATION,
    );
  });
});

describe('avis', () => {
  it('refuse une note hors de 1–5 et un second avis pour la même réservation', async () => {
    const { venue, field } = await makeVenueWithField();
    const user = await makeUser();
    const booking = await prisma.booking.create({
      data: bookingData(
        { fieldId: field.id, venueId: venue.id },
        { userId: user.id, status: 'COMPLETED' },
      ),
    });
    const base = { bookingId: booking.id, userId: user.id, venueId: venue.id };

    await expectPgError(prisma.review.create({ data: { ...base, rating: 6 } }), CHECK_VIOLATION);
    await expectPgError(prisma.review.create({ data: { ...base, rating: 0 } }), CHECK_VIOLATION);
    await prisma.review.create({ data: { ...base, rating: 5 } });
    await expectPgError(prisma.review.create({ data: { ...base, rating: 4 } }), UNIQUE_VIOLATION);
  });
});

describe('journal d’audit immuable', () => {
  it('autorise l’ajout, interdit la modification et la suppression', async () => {
    const entry = await prisma.auditLog.create({
      data: { actorRole: 'ADMIN', action: 'commission.update', entityType: 'CommissionRule' },
    });

    await expectPgError(
      prisma.auditLog.update({ where: { id: entry.id }, data: { action: 'falsifié' } }),
      INSUFFICIENT_PRIVILEGE,
    );
    await expectPgError(
      prisma.auditLog.delete({ where: { id: entry.id } }),
      INSUFFICIENT_PRIVILEGE,
    );

    expect(await prisma.auditLog.findUnique({ where: { id: entry.id } })).toMatchObject({
      action: 'commission.update',
    });
  });

  it('une action sensible de l’admin ne peut pas être effacée en supprimant son compte', async () => {
    const admin = await makeUser();
    await prisma.auditLog.create({
      data: {
        actorId: admin.id,
        actorRole: 'ADMIN',
        action: 'venue.approve',
        entityType: 'Venue',
      },
    });
    await expectPgError(prisma.user.delete({ where: { id: admin.id } }), FOREIGN_KEY_VIOLATION);
  });
});
