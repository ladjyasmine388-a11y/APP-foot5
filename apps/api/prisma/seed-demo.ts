import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { addDays, localToUtc, todayIn } from '../src/common/time/zoned-time.js';
import { generateBookingReference } from '../src/modules/bookings/booking-reference.js';
import { computeBookingAmounts } from '../src/modules/bookings/money.js';
import { slugify } from '../src/modules/venues/slug.js';
import { PasswordService } from '../src/infra/security/password.service.js';

/**
 * Données de DÉMONSTRATION (développement uniquement) : 10 complexes algériens, des terrains et tarifs, des joueurs, des
 * équipes, des réservations payées, des parties ouvertes, des annonces d'adversaire et des avis. Refusé en production.
 * Tout passe par les mêmes tables et les mêmes règles que l'application : rien de « factice » côté code.
 */
export const DEMO_PASSWORD = 'FootFive!2026';
export const DEMO_ADMIN_EMAIL = 'admin@footfive.dz';
const TZ = 'Africa/Algiers';

const FIRST = [
  'Yacine',
  'Amine',
  'Sofiane',
  'Riad',
  'Karim',
  'Nassim',
  'Walid',
  'Samir',
  'Lyes',
  'Mehdi',
  'Anis',
  'Zakaria',
  'Amel',
  'Nadia',
  'Rania',
  'Hichem',
  'Bilal',
  'Tarek',
  'Ines',
  'Farid',
];
const LAST = [
  'Benali',
  'Kaci',
  'Brahimi',
  'Mansouri',
  'Hadjadj',
  'Belkacem',
  'Cherif',
  'Bouzid',
  'Saadi',
  'Ouali',
  'Ferhat',
  'Merabet',
  'Bouchama',
  'Sebaa',
  'Khelifi',
  'Zerrouki',
  'Amrani',
  'Haddad',
  'Ziani',
  'Rahmani',
];
const CITIES = [
  'Alger',
  'Alger',
  'Alger',
  'Alger',
  'Alger',
  'Alger',
  'Alger',
  'Alger',
  'Alger',
  'Alger',
  'Alger',
  'Alger',
  'Oran',
  'Oran',
  'Oran',
  'Oran',
  'Oran',
  'Constantine',
  'Annaba',
  'Blida',
];
const LEVELS = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'] as const;
const POSITIONS = ['GOALKEEPER', 'DEFENDER', 'MIDFIELDER', 'FORWARD', 'ANY'] as const;

interface VenueSpec {
  name: string;
  city: string;
  district: string;
  address: string;
  lat: number;
  lng: number;
  status: 'APPROVED' | 'PENDING';
  amenities: string[];
  fields: {
    name: string;
    capacity: 10 | 12 | 14 | 16;
    surface: 'ARTIFICIAL_TURF' | 'NATURAL_GRASS' | 'HARD_COURT';
    covered?: boolean;
  }[];
  closesAtMin: number;
  description: string;
}

const VENUES: VenueSpec[] = [
  {
    name: 'Stade Five Hydra',
    city: 'Alger',
    district: 'Hydra',
    address: '12 chemin Mackley, Hydra',
    lat: 36.7448,
    lng: 3.0422,
    status: 'APPROVED',
    amenities: ['parking', 'vestiaires', 'douches', 'buvette', 'wifi'],
    closesAtMin: 1500,
    description:
      'Cinq terrains en gazon synthétique de dernière génération, éclairés, au cœur de Hydra. Parking gratuit et buvette.',
    fields: [
      { name: 'Terrain 1', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Terrain 2', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Terrain 3', capacity: 12, surface: 'ARTIFICIAL_TURF' },
      { name: 'Grand terrain', capacity: 16, surface: 'ARTIFICIAL_TURF' },
      { name: 'Terrain couvert', capacity: 10, surface: 'HARD_COURT', covered: true },
    ],
  },
  {
    name: 'Five Arena Bab Ezzouar',
    city: 'Alger',
    district: 'Bab Ezzouar',
    address: 'Zone d’activités, Bab Ezzouar',
    lat: 36.7216,
    lng: 3.183,
    status: 'APPROVED',
    amenities: ['parking', 'vestiaires', 'douches', 'toilettes'],
    closesAtMin: 1500,
    description:
      'Un complexe moderne avec six terrains, idéal pour les tournois entre amis et les matchs d’entreprise.',
    fields: [
      { name: 'Arena 1', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Arena 2', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Arena 3', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Arena 4', capacity: 12, surface: 'ARTIFICIAL_TURF' },
      { name: 'Arena 5', capacity: 14, surface: 'ARTIFICIAL_TURF' },
      { name: 'Arena Max', capacity: 16, surface: 'ARTIFICIAL_TURF' },
    ],
  },
  {
    name: 'Complexe El Mouradia',
    city: 'Alger',
    district: 'El Mouradia',
    address: '5 rue Mohamed Belouizdad',
    lat: 36.7525,
    lng: 3.042,
    status: 'APPROVED',
    amenities: ['vestiaires', 'buvette'],
    closesAtMin: 1440,
    description: 'Trois terrains de quartier, ambiance conviviale.',
    fields: [
      { name: 'Terrain A', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Terrain B', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Terrain C', capacity: 12, surface: 'HARD_COURT' },
    ],
  },
  {
    name: 'Oran Soccer Park',
    city: 'Oran',
    district: 'Es Senia',
    address: 'Route de l’aéroport, Es Senia',
    lat: 35.64,
    lng: -0.63,
    status: 'APPROVED',
    amenities: ['parking', 'vestiaires', 'douches', 'buvette'],
    closesAtMin: 1500,
    description: 'Quatre terrains éclairés près de l’aéroport, ouverts tard.',
    fields: [
      { name: 'Park 1', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Park 2', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Park 3', capacity: 12, surface: 'ARTIFICIAL_TURF' },
      { name: 'Park XL', capacity: 16, surface: 'NATURAL_GRASS' },
    ],
  },
  {
    name: 'Five Corniche Oran',
    city: 'Oran',
    district: 'Les Planteurs',
    address: 'Boulevard de la Corniche',
    lat: 35.7,
    lng: -0.64,
    status: 'APPROVED',
    amenities: ['parking', 'buvette', 'wifi'],
    closesAtMin: 1440,
    description: 'Jouez face à la mer : trois terrains avec vue sur la corniche.',
    fields: [
      { name: 'Mer 1', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Mer 2', capacity: 12, surface: 'ARTIFICIAL_TURF' },
      { name: 'Mer 3', capacity: 14, surface: 'ARTIFICIAL_TURF' },
    ],
  },
  {
    name: 'Constantine Five Club',
    city: 'Constantine',
    district: 'Ali Mendjeli',
    address: 'Unité de voisinage 7, Ali Mendjeli',
    lat: 36.24,
    lng: 6.57,
    status: 'APPROVED',
    amenities: ['parking', 'vestiaires', 'douches', 'toilettes'],
    closesAtMin: 1440,
    description: 'Quatre terrains modernes à Ali Mendjeli, avec vestiaires et douches chaudes.',
    fields: [
      { name: 'Club 1', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Club 2', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Club 3', capacity: 12, surface: 'ARTIFICIAL_TURF' },
      { name: 'Club 4', capacity: 16, surface: 'ARTIFICIAL_TURF' },
    ],
  },
  {
    name: 'Annaba Five Center',
    city: 'Annaba',
    district: 'Séraïdi',
    address: 'Route de Séraïdi',
    lat: 36.9,
    lng: 7.76,
    status: 'APPROVED',
    amenities: ['parking', 'vestiaires', 'buvette'],
    closesAtMin: 1440,
    description: 'Trois terrains calmes en périphérie d’Annaba.',
    fields: [
      { name: 'Centre 1', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Centre 2', capacity: 12, surface: 'ARTIFICIAL_TURF' },
      { name: 'Centre 3', capacity: 14, surface: 'ARTIFICIAL_TURF' },
    ],
  },
  {
    name: 'Blida Foot Zone',
    city: 'Blida',
    district: 'Ouled Yaïch',
    address: 'RN1, Ouled Yaïch',
    lat: 36.47,
    lng: 2.83,
    status: 'APPROVED',
    amenities: ['parking', 'douches', 'buvette'],
    closesAtMin: 1440,
    description:
      'Quatre terrains accessibles depuis l’autoroute, idéal pour les équipes de la Mitidja.',
    fields: [
      { name: 'Zone 1', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Zone 2', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Zone 3', capacity: 12, surface: 'ARTIFICIAL_TURF' },
      { name: 'Zone 4', capacity: 14, surface: 'ARTIFICIAL_TURF' },
    ],
  },
  {
    name: 'Sétif Five Stadium',
    city: 'Sétif',
    district: 'El Hidhab',
    address: 'Cité El Hidhab',
    lat: 36.19,
    lng: 5.41,
    status: 'APPROVED',
    amenities: ['parking', 'vestiaires'],
    closesAtMin: 1440,
    description: 'Trois terrains éclairés au centre de Sétif.',
    fields: [
      { name: 'Stadium 1', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Stadium 2', capacity: 12, surface: 'ARTIFICIAL_TURF' },
      { name: 'Stadium 3', capacity: 16, surface: 'ARTIFICIAL_TURF' },
    ],
  },
  {
    name: 'Complexe Tlemcen Five',
    city: 'Tlemcen',
    district: 'Imama',
    address: 'Avenue de l’Indépendance, Imama',
    lat: 34.88,
    lng: -1.32,
    status: 'PENDING',
    amenities: ['parking', 'vestiaires'],
    closesAtMin: 1440,
    description: 'Nouveau complexe en attente de validation par l’administration.',
    fields: [
      { name: 'Terrain 1', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Terrain 2', capacity: 10, surface: 'ARTIFICIAL_TURF' },
      { name: 'Terrain 3', capacity: 12, surface: 'ARTIFICIAL_TURF' },
    ],
  },
];

const PRICE: Record<number, { day: number; evening: number }> = {
  10: { day: 3000, evening: 4500 },
  12: { day: 4000, evening: 5500 },
  14: { day: 5000, evening: 6500 },
  16: { day: 6000, evening: 8000 },
};

export async function seedDemo(prisma: PrismaClient): Promise<void> {
  if (process.env['NODE_ENV'] === 'production')
    throw new Error('Les données de démonstration sont interdites en production.');
  if (await prisma.user.findUnique({ where: { email: DEMO_ADMIN_EMAIL } })) {
    console.warn(
      'Données de démonstration déjà présentes (réinitialisez la base pour les recréer).',
    );
    return;
  }

  const passwordHash = await new PasswordService().hash(DEMO_PASSWORD);
  const globalRule = await prisma.commissionRule.findFirstOrThrow({
    where: { scope: 'GLOBAL', isActive: true },
  });
  const today = todayIn(TZ);
  const at = (days: number, hhmm: string): Date => {
    const [h, m] = hhmm.split(':').map(Number) as [number, number];
    return localToUtc(addDays(today, days), h * 60 + m, TZ);
  };
  let counter = 0;
  const phone = (): string =>
    `05${50 + (counter % 40)}${String(100000 + counter * 7919).slice(-6)}`;

  // ───────── Utilisateurs ─────────
  const mkUser = async (data: {
    email: string;
    first: string;
    last: string;
    city: string;
    level?: (typeof LEVELS)[number];
    role?: 'ADMIN' | 'USER';
    position?: (typeof POSITIONS)[number];
  }) => {
    counter += 1;
    return prisma.user.create({
      data: {
        email: data.email,
        phone: phone(),
        passwordHash,
        firstName: data.first,
        lastName: data.last,
        city: data.city,
        level: data.level ?? LEVELS[counter % 3]!,
        preferredPosition: data.position ?? POSITIONS[counter % 5]!,
        platformRole: data.role ?? 'USER',
        emailVerifiedAt: new Date(),
        locale: counter % 7 === 0 ? 'ar' : 'fr',
        stats: {
          create: {
            matchesPlayed: counter % 11,
            reliabilityScore: 100 - (counter % 4) * 3,
            noShowCount: counter % 4 === 3 ? 1 : 0,
          },
        },
      },
    });
  };
  const admin = await mkUser({
    email: DEMO_ADMIN_EMAIL,
    first: 'Administrateur',
    last: 'Foot Five',
    city: 'Alger',
    role: 'ADMIN',
  });
  const owners = [];
  for (let i = 1; i <= 5; i++)
    owners.push(
      await mkUser({
        email: `gerant${i}@footfive.dz`,
        first: ['Mourad', 'Salima', 'Djamel', 'Leila', 'Rachid'][i - 1]!,
        last: ['Bensalem', 'Aouadi', 'Taleb', 'Meziane', 'Boudiaf'][i - 1]!,
        city: ['Alger', 'Oran', 'Constantine', 'Annaba', 'Blida'][i - 1]!,
      }),
    );
  const players = [];
  for (let i = 0; i < 20; i++)
    players.push(
      await mkUser({
        email: `joueur${String(i + 1).padStart(2, '0')}@footfive.dz`,
        first: FIRST[i]!,
        last: LAST[i]!,
        city: CITIES[i]!,
      }),
    );
  const P = (n: number) => players[n - 1]!;

  // ───────── Complexes, terrains, horaires, tarifs ─────────
  const venues: { id: string; name: string; fields: { id: string; capacity: number }[] }[] = [];
  for (const [index, spec] of VENUES.entries()) {
    const venue = await prisma.venue.create({
      data: {
        name: spec.name,
        slug: slugify(spec.name),
        description: spec.description,
        city: spec.city,
        district: spec.district,
        address: spec.address,
        latitude: spec.lat,
        longitude: spec.lng,
        phone: `021${String(300000 + index * 1111).slice(-6)}`,
        amenities: spec.amenities,
        status: spec.status,
        statusChangedAt: new Date(),
        openingHours: {
          create: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            opensAtMin: 540,
            closesAtMin: spec.closesAtMin,
          })),
        },
        staff: { create: [{ userId: owners[index % owners.length]!.id, role: 'OWNER' as const }] },
      },
    });
    const fields = [];
    for (const f of spec.fields) {
      const price = PRICE[f.capacity]!;
      const field = await prisma.field.create({
        data: {
          venueId: venue.id,
          name: f.name,
          capacity: f.capacity,
          surface: f.surface,
          covered: f.covered ?? false,
          dimensions: f.capacity <= 10 ? '40 x 20 m' : f.capacity <= 12 ? '45 x 25 m' : '60 x 35 m',
          pricingRules: {
            create: [
              {
                weekdays: [1, 2, 3, 4, 5, 6, 7],
                startMin: 0,
                endMin: 1800,
                priceMinor: price.day,
                priority: 0,
              },
              {
                weekdays: [1, 2, 3, 4, 5, 6, 7],
                startMin: 1080,
                endMin: 1800,
                priceMinor: price.evening,
                priority: 1,
              },
              {
                weekdays: [5, 6],
                startMin: 0,
                endMin: 1800,
                priceMinor: price.evening + 500,
                priority: 2,
              },
            ],
          },
        },
      });
      fields.push({ id: field.id, capacity: f.capacity });
    }
    venues.push({ id: venue.id, name: spec.name, fields });
  }
  // Un second gérant et un membre du personnel sur le premier complexe
  await prisma.venueStaff.createMany({
    data: [
      { venueId: venues[0]!.id, userId: owners[1]!.id, role: 'MANAGER' },
      { venueId: venues[0]!.id, userId: P(20).id, role: 'STAFF' },
    ],
  });

  // ───────── Équipes ─────────
  const mkTeam = async (
    name: string,
    city: string,
    level: (typeof LEVELS)[number],
    memberNumbers: number[],
  ) => {
    const [captain, ...rest] = memberNumbers;
    const team = await prisma.team.create({
      data: {
        name,
        city,
        level,
        description: `Équipe de ${city}, on joue chaque semaine.`,
        captainId: P(captain!).id,
        members: {
          create: [
            { userId: P(captain!).id, role: 'CAPTAIN' as const },
            ...rest.map((n) => ({ userId: P(n).id })),
          ],
        },
      },
    });
    return team;
  };
  const lions = await mkTeam('Les Lions d’Alger', 'Alger', 'INTERMEDIATE', [1, 2, 3, 4, 5, 6]);
  const asBab = await mkTeam('AS Bab Ezzouar', 'Alger', 'INTERMEDIATE', [7, 8, 9, 10, 11, 12]);
  const oran = await mkTeam('Oran United', 'Oran', 'INTERMEDIATE', [13, 14, 15, 16, 17]);
  await prisma.teamInvitation.create({
    data: { teamId: lions.id, inviterId: P(1).id, inviteeId: P(18).id, expiresAt: at(6, '12:00') },
  });

  // ───────── Réservations payées (instantanés financiers cohérents avec les règles) ─────────
  const deposit = { mode: 'PERCENT', rateBps: 2000, fixedMinor: 0, minMinor: 0 } as const;
  const priceOf = (venueIndex: number, fieldIndex: number, day: number, hhmm: string): number => {
    const cap = venues[venueIndex]!.fields[fieldIndex]!.capacity;
    const date = addDays(today, day);
    const weekday = ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const evening = Number(hhmm.slice(0, 2)) >= 18;
    return PRICE[cap]![evening ? 'evening' : 'day'] + (weekday === 5 || weekday === 6 ? 500 : 0);
  };
  const book = async (opts: {
    user: { id: string } | null;
    venueIndex: number;
    fieldIndex: number;
    day: number;
    hhmm: string;
    status?: 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';
    manualName?: string;
  }) => {
    const venue = venues[opts.venueIndex]!;
    const field = venue.fields[opts.fieldIndex]!;
    const base = priceOf(opts.venueIndex, opts.fieldIndex, opts.day, opts.hhmm);
    const amounts = computeBookingAmounts({
      basePriceMinor: base,
      commission: { rateBps: globalRule.rateBps, fixedMinor: globalRule.fixedMinor },
      paymentMode: opts.user ? 'DEPOSIT' : 'ON_SITE',
      deposit,
    });
    const startsAt = at(opts.day, opts.hhmm);
    const status = opts.status ?? 'CONFIRMED';
    const booking = await prisma.booking.create({
      data: {
        reference: generateBookingReference(),
        userId: opts.user?.id ?? null,
        customerName: opts.user ? null : (opts.manualName ?? 'Client téléphone'),
        customerPhone: opts.user ? null : '0550123456',
        fieldId: field.id,
        venueId: venue.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
        status,
        source: opts.user ? 'WEB' : 'VENUE_MANUAL',
        paymentMode: opts.user ? 'DEPOSIT' : 'ON_SITE',
        commissionRuleId: globalRule.id,
        ...amounts,
        // Réservation manuelle du complexe : pas de commission, rien à payer en ligne
        ...(opts.user
          ? {}
          : {
              commissionMinor: 0,
              platformAmountMinor: 0,
              venueAmountMinor: base,
              commissionRateBps: 0,
              commissionFixedMinor: 0,
              dueOnlineMinor: 0,
              dueOnSiteMinor: base,
            }),
        createdById: opts.user?.id ?? owners[0]!.id,
        ...(status === 'CANCELLED'
          ? {
              cancelledAt: new Date(),
              cancelledById: opts.user?.id ?? null,
              cancellationReason: 'Empêchement',
            }
          : {}),
      },
    });
    if (opts.user && status !== 'CANCELLED') {
      await prisma.payment.create({
        data: {
          bookingId: booking.id,
          provider: 'fake',
          providerRef: `fake_seed_${randomUUID().slice(0, 12)}`,
          kind: 'DEPOSIT',
          amountMinor: amounts.dueOnlineMinor,
          status: 'SUCCEEDED',
          idempotencyKey: randomUUID(),
          paidAt: new Date(startsAt.getTime() - 86_400_000 * 2),
        },
      });
    }
    return booking;
  };

  // Hydra (0), Bab Ezzouar (1), Oran Soccer Park (3), Annaba (6), Blida (7), Constantine (5)
  const lionsGame = await book({ user: P(1), venueIndex: 1, fieldIndex: 0, day: 2, hhmm: '20:00' });
  const solo1 = await book({ user: P(7), venueIndex: 0, fieldIndex: 0, day: 3, hhmm: '19:00' });
  const oranGame = await book({ user: P(13), venueIndex: 3, fieldIndex: 0, day: 1, hhmm: '21:00' });
  const solo2 = await book({ user: P(18), venueIndex: 6, fieldIndex: 1, day: 4, hhmm: '18:00' });
  await book({ user: P(19), venueIndex: 7, fieldIndex: 0, day: 5, hhmm: '10:00' });
  const manual = await book({
    user: null,
    venueIndex: 5,
    fieldIndex: 0,
    day: 3,
    hhmm: '20:00',
    manualName: 'Équipe Cirta',
  });
  const teamTraining = await book({
    user: P(2),
    venueIndex: 2,
    fieldIndex: 0,
    day: 6,
    hhmm: '19:00',
  });

  // ───────── Parties « Complétez votre équipe » ─────────
  const mkSolo = async (
    booking: { id: string; venueId: string; fieldId: string; startsAt: Date; endsAt: Date },
    creator: { id: string },
    origin: 'PLAYER' | 'VENUE',
    spots: number,
    joiners: number[],
    level: (typeof LEVELS)[number] | null,
    description: string,
  ) => {
    const session = await prisma.soloSession.create({
      data: {
        bookingId: booking.id,
        origin,
        createdById: creator.id,
        venueId: booking.venueId,
        fieldId: booking.fieldId,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
        capacity: spots,
        joinedCount: joiners.length,
        level,
        pricePerPlayerMinor: origin === 'PLAYER' ? 500 : 0,
        status: joiners.length >= spots ? 'FULL' : 'OPEN',
        description,
      },
    });
    await prisma.soloPlayer.createMany({
      data: joiners.map((n) => ({ sessionId: session.id, userId: P(n).id })),
    });
    await prisma.match.create({
      data: {
        source: 'SOLO_SESSION',
        bookingId: booking.id,
        venueId: booking.venueId,
        fieldId: booking.fieldId,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
        soloSessionId: session.id,
        level,
        createdById: creator.id,
        participants: {
          create: [
            ...(origin === 'PLAYER' ? [{ userId: creator.id, side: 'NONE' as const }] : []),
            ...joiners.map((n) => ({ userId: P(n).id, side: 'NONE' as const })),
          ],
        },
      },
    });
  };
  await mkSolo(
    solo1,
    P(7),
    'PLAYER',
    4,
    [14, 15],
    'INTERMEDIATE',
    'Il nous manque 2 joueurs pour un 5 contre 5 sympa. Ambiance détendue !',
  );
  await mkSolo(
    solo2,
    P(18),
    'PLAYER',
    5,
    [19],
    'BEGINNER',
    'Débutants bienvenus, on joue pour le plaisir.',
  );
  await mkSolo(
    manual,
    owners[2]!,
    'VENUE',
    8,
    [16, 17, 20],
    null,
    'Le complexe ouvre des places : venez compléter le groupe !',
  );

  // ───────── Annonces « Trouvez un adversaire » ─────────
  const listing1 = await prisma.opponentListing.create({
    data: {
      teamId: lions.id,
      bookingId: lionsGame.id,
      createdById: P(1).id,
      venueId: lionsGame.venueId,
      fieldId: lionsGame.fieldId,
      startsAt: lionsGame.startsAt,
      playersPerSide: 5,
      level: 'INTERMEDIATE',
      comment: 'Match amical, niveau intermédiaire. Fair-play exigé !',
    },
  });
  await prisma.matchRequest.create({
    data: {
      listingId: listing1.id,
      requestingTeamId: asBab.id,
      requestedById: P(7).id,
      message: 'On est partants, on arrive avec 6 joueurs.',
    },
  });
  await prisma.opponentListing.create({
    data: {
      teamId: oran.id,
      bookingId: oranGame.id,
      createdById: P(13).id,
      venueId: oranGame.venueId,
      fieldId: oranGame.fieldId,
      startsAt: oranGame.startsAt,
      playersPerSide: 5,
      level: null,
      comment: 'Oran United cherche un adversaire pour jeudi soir.',
    },
  });
  const trainingMatch = await prisma.match.create({
    data: {
      source: 'TEAM',
      bookingId: teamTraining.id,
      venueId: teamTraining.venueId,
      fieldId: teamTraining.fieldId,
      startsAt: teamTraining.startsAt,
      endsAt: teamTraining.endsAt,
      teamAId: lions.id,
      level: 'INTERMEDIATE',
      createdById: P(2).id,
    },
  });
  await prisma.matchParticipant.createMany({
    data: [1, 2, 3, 4, 5, 6].map((n) => ({
      matchId: trainingMatch.id,
      userId: P(n).id,
      side: 'A' as const,
    })),
  });

  // ───────── Historique : matchs terminés et avis ─────────
  const pastBooking = await book({
    user: P(1),
    venueIndex: 1,
    fieldIndex: 1,
    day: -4,
    hhmm: '20:00',
    status: 'COMPLETED',
  });
  const pastListing = await prisma.opponentListing.create({
    data: {
      teamId: lions.id,
      bookingId: pastBooking.id,
      createdById: P(1).id,
      venueId: pastBooking.venueId,
      fieldId: pastBooking.fieldId,
      startsAt: pastBooking.startsAt,
      playersPerSide: 5,
      level: 'INTERMEDIATE',
      status: 'COMPLETED',
    },
  });
  await prisma.matchRequest.create({
    data: {
      listingId: pastListing.id,
      requestingTeamId: asBab.id,
      requestedById: P(7).id,
      status: 'ACCEPTED',
      respondedAt: pastBooking.startsAt,
    },
  });
  const pastMatch = await prisma.match.create({
    data: {
      source: 'OPPONENT_LISTING',
      bookingId: pastBooking.id,
      venueId: pastBooking.venueId,
      fieldId: pastBooking.fieldId,
      startsAt: pastBooking.startsAt,
      endsAt: pastBooking.endsAt,
      teamAId: lions.id,
      teamBId: asBab.id,
      opponentListingId: pastListing.id,
      status: 'COMPLETED',
      scoreA: 4,
      scoreB: 3,
      playersPerSide: 5,
      level: 'INTERMEDIATE',
      createdById: P(1).id,
    },
  });
  await prisma.matchParticipant.createMany({
    data: [
      ...[1, 2, 3, 4, 5, 6].map((n) => ({
        matchId: pastMatch.id,
        userId: P(n).id,
        side: 'A' as const,
      })),
      ...[7, 8, 9, 10, 11, 12].map((n) => ({
        matchId: pastMatch.id,
        userId: P(n).id,
        side: 'B' as const,
      })),
    ],
  });

  const reviewSets: { venueIndex: number; ratings: [number, string][] }[] = [
    {
      venueIndex: 0,
      ratings: [
        [5, 'Terrains impeccables, éclairage parfait.'],
        [4, 'Très bien, un peu cher le week-end.'],
        [5, 'Le meilleur complexe d’Alger !'],
      ],
    },
    {
      venueIndex: 1,
      ratings: [
        [4, 'Grand choix de terrains, accueil sympa.'],
        [5, 'Parfait pour notre tournoi.'],
      ],
    },
    { venueIndex: 3, ratings: [[4, 'Bonne ambiance, parking facile.']] },
    {
      venueIndex: 5,
      ratings: [
        [5, 'Vestiaires propres, pelouse comme neuve.'],
        [4, 'Très bon rapport qualité-prix.'],
      ],
    },
    { venueIndex: 7, ratings: [[3, 'Correct, mais l’éclairage pourrait être meilleur.']] },
  ];
  let day = -6;
  for (const set of reviewSets) {
    const venue = venues[set.venueIndex]!;
    for (const [i, [rating, comment]] of set.ratings.entries()) {
      const reviewer = P(8 + ((set.venueIndex + i) % 10));
      const booking = await book({
        user: reviewer,
        venueIndex: set.venueIndex,
        fieldIndex: 0,
        day: day--,
        hhmm: '17:00',
        status: 'COMPLETED',
      });
      await prisma.review.create({
        data: { bookingId: booking.id, userId: reviewer.id, venueId: venue.id, rating, comment },
      });
    }
    const ratings = set.ratings.map(([r]) => r);
    await prisma.venue.update({
      where: { id: venue.id },
      data: {
        ratingAvg: Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100,
        ratingCount: ratings.length,
      },
    });
  }
  await book({
    user: P(3),
    venueIndex: 0,
    fieldIndex: 2,
    day: -2,
    hhmm: '19:00',
    status: 'CANCELLED',
  });

  // ───────── Quelques notifications ─────────
  await prisma.notification.createMany({
    data: [
      {
        userId: P(1).id,
        type: 'OPPONENT_REQUEST_RECEIVED',
        payload: {
          listingId: listing1.id,
          teamName: asBab.name,
          venueName: venues[1]!.name,
          startsAt: lionsGame.startsAt.toISOString(),
        },
      },
      {
        userId: P(1).id,
        type: 'BOOKING_CONFIRMED',
        payload: {
          bookingId: lionsGame.id,
          reference: lionsGame.reference,
          venueName: venues[1]!.name,
          startsAt: lionsGame.startsAt.toISOString(),
        },
      },
      {
        userId: P(18).id,
        type: 'TEAM_INVITATION_RECEIVED',
        payload: {
          teamId: lions.id,
          teamName: lions.name,
          invitedBy: `${P(1).firstName} ${P(1).lastName}`,
        },
      },
    ],
  });

  console.warn(
    [
      'Données de démonstration créées :',
      `  • 1 administrateur : ${admin.email}`,
      `  • ${owners.length} gérants : gerant1@footfive.dz … gerant5@footfive.dz`,
      `  • ${players.length} joueurs : joueur01@footfive.dz … joueur20@footfive.dz`,
      `  • ${VENUES.length} complexes (dont 1 en attente de validation), ${venues.reduce((n, v) => n + v.fields.length, 0)} terrains`,
      `  Mot de passe de tous les comptes (DÉVELOPPEMENT UNIQUEMENT) : ${DEMO_PASSWORD}`,
    ].join('\n'),
  );
}
