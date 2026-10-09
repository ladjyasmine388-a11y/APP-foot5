/**
 * Calculs de dates en heure LOCALE d'un complexe (fuseau IANA, ex. « Africa/Algiers »).
 *
 * Tout est stocké en UTC ; les horaires d'ouverture sont saisis en heure locale. Ces fonctions font le pont,
 * sans dépendance externe (Intl intégré à Node). Elles gèrent un fuseau avec changement d'heure (Europe/Paris)
 * même si l'Algérie n'en a pas : un complexe configuré dans un autre fuseau fonctionne donc aussi.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Décalage (ms) du fuseau par rapport à UTC à l'instant donné : heure locale − heure UTC. */
function offsetMs(utcMs: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const localAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return localAsUtc - Math.floor(utcMs / 1000) * 1000;
}

function parseYmd(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number);
  return { y: y as number, m: m as number, d: d as number };
}

/**
 * Instant UTC correspondant à « date locale + minutes depuis minuit » dans le fuseau donné.
 * `minutes` peut dépasser 1440 (créneaux après minuit rattachés au jour de service).
 *
 * Heure inexistante (saut de printemps) → l'instant juste après le saut ; heure ambiguë (retour d'automne)
 * → la première occurrence. Sans objet pour l'Algérie (pas de changement d'heure).
 */
export function localToUtc(date: string, minutes: number, timeZone: string): Date {
  const { y, m, d } = parseYmd(date);
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  let utc = wall - offsetMs(wall, timeZone);
  const corrected = wall - offsetMs(utc, timeZone);
  if (corrected !== utc) utc = corrected;
  return new Date(utc);
}

/** Jour ISO (1 = lundi … 7 = dimanche) d'une date calendaire. Indépendant du fuseau. */
export function isoWeekday(date: string): number {
  const { y, m, d } = parseYmd(date);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = dimanche
  return day === 0 ? 7 : day;
}

export function addDays(date: string, days: number): string {
  const { y, m, d } = parseYmd(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Date calendaire « aujourd'hui » dans le fuseau du complexe (≠ date UTC près de minuit). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = formatterFor(timeZone).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Nombre de jours entre deux dates calendaires (b − a). */
export function daysBetween(a: string, b: string): number {
  const pa = parseYmd(a);
  const pb = parseYmd(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}
