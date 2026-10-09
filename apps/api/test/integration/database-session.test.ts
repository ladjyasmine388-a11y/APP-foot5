import { describe, expect, it } from 'vitest';
import { prisma } from './helpers.js';

describe('session PostgreSQL', () => {
  it('est en UTC : une date passée à du SQL brut n’est jamais décalée par le fuseau du serveur', async () => {
    const [session] = await prisma.$queryRaw<{ zone: string }[]>`SELECT current_setting('TimeZone') AS zone`;
    expect(session?.zone).toBe('UTC');

    const instant = new Date('2026-10-20T17:00:00.000Z');
    const [row] = await prisma.$queryRaw<{ same: boolean; before: boolean; after: boolean; algiers: number }[]>`
      SELECT (timestamptz '2026-10-20T17:00:00Z' = ${instant}) AS same,
             (timestamptz '2026-10-20T16:59:59Z' < ${instant}) AS before,
             (timestamptz '2026-10-20T17:00:01Z' > ${instant}) AS after,
             EXTRACT(HOUR FROM (${instant}::timestamptz AT TIME ZONE 'Africa/Algiers'))::int AS algiers`;
    expect(row).toEqual({ same: true, before: true, after: true, algiers: 18 });
  });
});
