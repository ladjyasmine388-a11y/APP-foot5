import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Adaptateur PostgreSQL commun à l'API et aux tests.
 *
 * La session est forcée en UTC. Raison : une date passée en paramètre d'un `$queryRaw` est envoyée SANS fuseau
 * ("2026-10-20 17:00:00") ; PostgreSQL la lit alors dans le fuseau de la session. Avec un serveur configuré en
 * heure locale (ex. Africa/Algiers, UTC+1), toutes les comparaisons du SQL brut étaient décalées d'une heure.
 * Les colonnes restent des TIMESTAMPTZ : ce réglage ne change que l'interprétation des paramètres.
 */
export function createPgAdapter(connectionString: string, extra: { max?: number } = {}): PrismaPg {
  return new PrismaPg({ connectionString, options: '-c timezone=UTC', ...extra });
}
