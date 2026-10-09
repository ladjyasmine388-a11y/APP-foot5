/**
 * Codes d'erreur PostgreSQL qui ont un sens métier.
 * https://www.postgresql.org/docs/16/errcodes-appendix.html
 */
export const PG_ERROR = {
  /** Contrainte d'exclusion : deux réservations se chevauchent sur le même terrain. */
  EXCLUSION_VIOLATION: '23P01',
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  /** Droit insuffisant — utilisé par le trigger d'immuabilité de l'audit. */
  INSUFFICIENT_PRIVILEGE: '42501',
} as const;

type Candidate = { code?: unknown; originalCode?: unknown; cause?: unknown; meta?: unknown };

/**
 * Retrouve le code SQLSTATE d'une erreur remontée par Prisma + adaptateur pg,
 * quelle que soit la profondeur à laquelle il est enveloppé.
 */
export function pgErrorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const c = current as Candidate;
    for (const value of [c.originalCode, c.code]) {
      if (typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value) && !/^P\d{4}$/.test(value)) {
        return value;
      }
    }
    queue.push(
      c.cause,
      c.meta,
      (c.meta as { driverAdapterError?: unknown } | undefined)?.driverAdapterError,
    );
  }
  return undefined;
}

export function isPgError(error: unknown, code: string): boolean {
  return pgErrorCode(error) === code;
}
