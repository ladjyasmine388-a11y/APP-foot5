/**
 * Heures d'ouverture et plages tarifaires.
 *
 * Elles sont exprimées en MINUTES depuis minuit, en heure LOCALE du complexe, et rattachées au « jour de service » :
 * un complexe ouvert le vendredi de 10:00 à 02:00 est stocké 600 → 1560, et les créneaux de 00:00 à 02:00
 * (techniquement dans la nuit de samedi) appartiennent au vendredi. Les clients saisissent « 10:00 » et « 02:00 ».
 */

/** Une journée de service peut finir jusqu'à 06:00 le lendemain (1800 min). */
export const MAX_SERVICE_MINUTES = 1800;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** « 20:30 » → 1230. Retourne null si le format est invalide. */
export function parseTime(value: string): number | null {
  const match = TIME_PATTERN.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 1230 → « 20:30 » ; 1560 → « 02:00 » (modulo 24 h : le lendemain est porté par un indicateur à part). */
export function formatTime(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export interface MinuteRange {
  startMin: number;
  endMin: number;
}

/**
 * Convertit « de 10:00 à 02:00 » en minutes de service (600 → 1560).
 * Si la fin est ≤ au début, elle tombe le lendemain. Début = fin est refusé (24 h pleines : ambigu).
 */
export function toMinuteRange(from: string, to: string): MinuteRange | null {
  const start = parseTime(from);
  const end = parseTime(to);
  if (start === null || end === null || start === end) return null;
  const endMin = end > start ? end : end + 1440;
  if (endMin > MAX_SERVICE_MINUTES) return null;
  return { startMin: start, endMin };
}

export interface TimeRangeView {
  from: string;
  to: string;
  /** La fin tombe le lendemain (ex. fermeture à 02:00). */
  overnight: boolean;
}

export function toRangeView(range: MinuteRange): TimeRangeView {
  return {
    from: formatTime(range.startMin),
    to: formatTime(range.endMin),
    overnight: range.endMin > 1440,
  };
}

/** Vrai si deux plages de minutes se chevauchent (les plages sont semi-ouvertes : [début, fin[). */
export function rangesOverlap(a: MinuteRange, b: MinuteRange): boolean {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}
