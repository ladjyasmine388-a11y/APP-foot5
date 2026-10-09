import { DEFAULT_LOCALE, LOCALES, type Locale } from '@footfive/shared';

/** Les créneaux sont toujours affichés à l'heure d'Alger, quel que soit le fuseau du navigateur. */
export const DISPLAY_TZ = 'Africa/Algiers';

/** Chiffres occidentaux même en arabe (usage courant en Algérie) : les montants et heures restent lisibles et alignés. */
const TAGS: Record<Locale, string> = { fr: 'fr-FR', en: 'en-GB', ar: 'ar-DZ-u-nu-latn' };

/** Nombres : l'espace comme séparateur de milliers en français ET en arabe (le point arabe se lirait comme une décimale). */
const NUMBER_TAGS: Record<Locale, string> = { fr: 'fr-FR', en: 'en-GB', ar: 'fr-FR' };

export const isLocale = (value: unknown): value is Locale => typeof value === 'string' && (LOCALES as readonly string[]).includes(value);

export const directionOf = (locale: Locale): 'rtl' | 'ltr' => (locale === 'ar' ? 'rtl' : 'ltr');

/** Langue du navigateur parmi les langues supportées, sinon le français. */
export function detectLocale(languages: readonly string[]): Locale {
  for (const lang of languages) {
    const short = lang.toLowerCase().slice(0, 2);
    if (isLocale(short)) return short;
  }
  return DEFAULT_LOCALE;
}

/** Montant en dinars : l'unité mineure de la plateforme EST le dinar (pas de centimes). */
export function formatMoney(amountMinor: number, locale: Locale): string {
  const number = new Intl.NumberFormat(NUMBER_TAGS[locale]).format(amountMinor);
  return locale === 'ar' ? `${number} دج` : `${number} DA`;
}

export function formatDate(iso: string | Date, locale: Locale, style: 'short' | 'long' = 'long'): string {
  return new Intl.DateTimeFormat(TAGS[locale], style === 'long'
    ? { weekday: 'long', day: 'numeric', month: 'long', timeZone: DISPLAY_TZ }
    : { day: '2-digit', month: '2-digit', timeZone: DISPLAY_TZ }).format(typeof iso === 'string' ? new Date(iso) : iso);
}

export function formatTime(iso: string | Date, locale: Locale): string {
  return new Intl.DateTimeFormat(TAGS[locale], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: DISPLAY_TZ }).format(typeof iso === 'string' ? new Date(iso) : iso);
}

export const formatDateTime = (iso: string | Date, locale: Locale): string => `${formatDate(iso, locale)} · ${formatTime(iso, locale)}`;

export function formatNumber(value: number, locale: Locale, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat(NUMBER_TAGS[locale], { maximumFractionDigits }).format(value);
}

/** Date du jour (ou décalée de `days`) au format AAAA-MM-JJ, à l'heure d'Alger. */
export function localDate(days = 0, from: Date = new Date()): string {
  const shifted = new Date(from.getTime() + days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: DISPLAY_TZ }).format(shifted);
}

/** `{name}` → valeur. Une variable manquante est laissée visible plutôt que remplacée par « undefined ». */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match));
}

/**
 * Instant UTC (ISO) d'une date + heure locales dans un fuseau donné (ex. 2026-10-20 + 20:00 à Alger → 19:00Z).
 * Deux passes de correction suffisent (le décalage d'un fuseau ne varie qu'aux changements d'heure).
 */
export function localToUtcIso(date: string, hhmm: string, timeZone: string = DISPLAY_TZ): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const wanted = Date.parse(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const offsetAt = (instant: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instant));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - instant;
  };
  let guess = wanted - offsetAt(wanted);
  guess = wanted - offsetAt(guess);
  return new Date(guess).toISOString();
}

/** « HH:MM » → minutes depuis minuit (null si le format est invalide). */
export function parseHHMM(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
