import { randomUUID } from 'node:crypto';
import type { BookingStatus, PlayerLevel } from '../../src/generated/prisma/client.js';
import { type Signup, type TestApp, bearer, post, signup, verifiedSignup } from './app-helper.js';
import { prisma } from './helpers.js';
import { book, createVenueWithFields, dayIn, slotAt } from './venue-fixtures.js';

/** Complexe de test : un petit terrain (10 joueurs), un grand (16), un membre du personnel et un étranger. */
export async function createWorld(t: TestApp, venue: { city?: string } = {}) {
  const { venue: v, fields } = await createVenueWithFields({ city: venue.city ?? 'Alger' }, [
    { capacity: 10 },
    { capacity: 16 },
  ]);
  const [staff, outsider] = await Promise.all([signup(t), signup(t)]);
  await prisma.venueStaff.create({ data: { venueId: v.id, userId: staff.userId, role: 'STAFF' } });
  return { venue: v, small: fields[0]!, large: fields[1]!, staff, outsider };
}
export type World = Awaited<ReturnType<typeof createWorld>>;

let slotCounter = 0;
/** Créneau futur unique (jamais deux fois le même) : les réservations ne se chevauchent donc jamais par accident. */
export function nextSlot(): { date: string; hhmm: string } {
  slotCounter += 1;
  return {
    date: dayIn(2 + Math.floor(slotCounter / 10)),
    hhmm: `${String(11 + (slotCounter % 10)).padStart(2, '0')}:00`,
  };
}

/** Réservation CONFIRMÉE appartenant au joueur (ou manuelle du complexe si `owner` est null). */
export async function confirmedBooking(
  world: World,
  owner: Signup | null,
  opts: {
    field?: 'small' | 'large';
    status?: BookingStatus;
    at?: { date: string; hhmm: string };
  } = {},
) {
  const field = opts.field === 'large' ? world.large : world.small;
  const slot = opts.at ?? nextSlot();
  return book({ fieldId: field.id, venueId: world.venue.id }, slot.date, slot.hhmm, {
    status: opts.status ?? 'CONFIRMED',
    userId: owner?.userId,
  });
}

export const slotRange = (at: { date: string; hhmm: string }) => ({
  start: slotAt(at.date, at.hhmm),
});

/** Équipe de `size` joueurs (capitaine compris), créée par l'API ; les autres membres sont ajoutés en base. */
export async function makeTeam(
  t: TestApp,
  captain: Signup,
  size: number,
  opts: { level?: PlayerLevel; city?: string; name?: string } = {},
) {
  const res = await post(
    t,
    '/teams',
    {
      name: opts.name ?? `Équipe ${randomUUID().slice(0, 8)}`,
      city: opts.city,
      level: opts.level ?? 'BEGINNER',
    },
    bearer(captain.accessToken),
  );
  if (res.statusCode !== 201) throw new Error(`Création d'équipe impossible : ${res.body}`);
  const team = res.json() as { id: string; name: string };
  const members = await Promise.all(Array.from({ length: size - 1 }, () => signup(t)));
  if (members.length > 0) {
    await prisma.teamMember.createMany({
      data: members.map((m) => ({ teamId: team.id, userId: m.userId })),
    });
  }
  return { ...team, members };
}

export const newPlayer = (t: TestApp, level?: PlayerLevel) =>
  verifiedSignup(t).then(async (u) => {
    if (level) await prisma.user.update({ where: { id: u.userId }, data: { level } });
    return u;
  });
