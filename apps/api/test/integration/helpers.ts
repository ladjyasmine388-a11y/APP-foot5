import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { expect } from 'vitest';
import {
  PrismaClient,
  type BookingStatus,
  type BookingType,
} from '../../src/generated/prisma/client.js';
import { isPgError } from '../../src/infra/database/pg-errors.js';

const url = process.env['DATABASE_URL'] ?? '';

/** Garde-fou ultime : on ne vide JAMAIS une base qui n'est pas explicitement une base de test. */
function assertTestDatabase(): void {
  if (!/\/[^/?]*_test(\?|$)/.test(url)) {
    throw new Error(`Refus de toucher à une base non-test : ${url}`);
  }
}
assertTestDatabase();

export const prisma = new PrismaClient({
  // Plusieurs connexions pour pouvoir simuler de vraies requêtes concurrentes.
  adapter: new PrismaPg({ connectionString: url, max: 20 }),
});

/**
 * Remet la base à zéro entre deux tests (sauf l'historique des migrations).
 * On ne vide que les tables NON vides : un TRUNCATE de toutes les tables coûte ~1 s (fsync),
 * contre quelques dizaines de ms pour les 3-4 tables réellement touchées par un test.
 */
export async function resetDb(): Promise<void> {
  assertTestDatabase();
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  // Noms issus du catalogue PostgreSQL (jamais d'entrée utilisateur) ; guillemets doublés par prudence.
  const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
  const probe = tables
    .map(
      (t) =>
        `SELECT '${t.tablename.replaceAll("'", "''")}' AS name WHERE EXISTS (SELECT 1 FROM ${quote(t.tablename)})`,
    )
    .join(' UNION ALL ');
  const nonEmpty = await prisma.$queryRawUnsafe<{ name: string }[]>(probe);
  if (nonEmpty.length === 0) return;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${nonEmpty.map((t) => quote(t.name)).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

/** Nettoyage léger des réglages GLOBAUX (une seule règle active par portée) entre deux tests. */
export async function clearGlobalConfig(): Promise<void> {
  await prisma.commissionRule.deleteMany();
  await prisma.platformSetting.deleteMany();
}

let counter = 0;
const uniq = (): string =>
  `${Date.now().toString(36)}${(counter++).toString(36)}${randomBytes(2).toString('hex')}`;

export async function makeUser(overrides: Partial<{ email: string }> = {}) {
  return prisma.user.create({
    data: {
      email: overrides.email ?? `joueur-${uniq()}@test.local`,
      phone: '0550000000',
      firstName: 'Test',
      lastName: 'Joueur',
    },
  });
}

export async function makeVenue(name = 'Complexe Test') {
  return prisma.venue.create({
    data: {
      name,
      slug: `complexe-${uniq()}`,
      city: 'Alger',
      address: '1 rue du Test',
      status: 'APPROVED',
    },
  });
}

export async function makeField(venueId: string, name = `Terrain ${uniq()}`) {
  return prisma.field.create({ data: { venueId, name, capacity: 10 } });
}

/** Un complexe avec un terrain : le cas le plus courant. */
export async function makeVenueWithField() {
  const venue = await makeVenue();
  const field = await makeField(venue.id);
  return { venue, field };
}

/**
 * Instantané financier COHÉRENT pour les tests (mêmes règles que le futur CommissionService :
 * commission = floor(base × bps / 10 000) + fixe, part du complexe = base − commission).
 */
export function money(base: number, rateBps = 100, fixed = 0) {
  const commission = Math.floor((base * rateBps) / 10_000) + fixed;
  return {
    basePriceMinor: base,
    commissionRateBps: rateBps,
    commissionFixedMinor: fixed,
    commissionMinor: commission,
    platformAmountMinor: commission,
    venueAmountMinor: base - commission,
    feesMinor: 0,
    taxMinor: 0,
    totalMinor: base,
    dueOnlineMinor: commission,
    dueOnSiteMinor: base - commission,
  };
}

export const SLOT_START = new Date('2026-10-20T19:00:00.000Z');
export const addMinutes = (d: Date, min: number): Date => new Date(d.getTime() + min * 60_000);

export interface BookingOverrides {
  userId?: string | null;
  start?: Date;
  minutes?: number;
  status?: BookingStatus;
  bookingType?: BookingType;
  base?: number;
}

/** Données d'une réservation valide ; `overrides` permet de fabriquer les cas limites. */
export function bookingData(
  ids: { fieldId: string; venueId: string },
  overrides: BookingOverrides = {},
) {
  const start = overrides.start ?? SLOT_START;
  const status = overrides.status ?? 'CONFIRMED';
  const isBlock = overrides.bookingType === 'BLOCK';
  return {
    reference: `FF-${uniq().toUpperCase()}`,
    fieldId: ids.fieldId,
    venueId: ids.venueId,
    userId: overrides.userId ?? null,
    customerName: overrides.userId || isBlock ? null : 'Client téléphone',
    startsAt: start,
    endsAt: addMinutes(start, overrides.minutes ?? 60),
    status,
    bookingType: overrides.bookingType ?? 'STANDARD',
    holdExpiresAt: status === 'PENDING_PAYMENT' ? addMinutes(new Date(), 10) : null,
    ...(isBlock ? money(0) : money(overrides.base ?? 4000)),
  };
}

/** Vérifie qu'une promesse échoue avec un code SQLSTATE précis (et pas pour une autre raison). */
export async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error, `une erreur PostgreSQL ${code} était attendue`).toBeDefined();
  expect(
    isPgError(error, code),
    `code attendu ${code}, reçu : ${String((error as Error)?.message).slice(0, 300)}`,
  ).toBe(true);
}
