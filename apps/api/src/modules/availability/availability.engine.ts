import type { SlotStatus } from '@footfive/shared';
import { isoWeekday, localToUtc } from '../../common/time/zoned-time.js';

/**
 * MOTEUR DE DISPONIBILITÉ — fonctions pures, sans base de données ni horloge cachée.
 *
 * Les créneaux ne sont PAS stockés : ils sont calculés à partir des horaires d'ouverture, des règles de prix
 * et des réservations existantes. Modifier un horaire ou un tarif est donc immédiatement pris en compte,
 * sans régénérer des milliers de lignes, et sans risque d'incohérence.
 *
 * La disponibilité affichée est INDICATIVE. La garantie qu'un créneau n'est jamais vendu deux fois est la
 * contrainte d'exclusion PostgreSQL (migration `db_guarantees`), pas ce calcul.
 */

export interface HourRow {
  weekday: number;
  opensAtMin: number;
  closesAtMin: number;
}

export interface Interval {
  opensAtMin: number;
  closesAtMin: number;
}

export interface PriceRule {
  id: string;
  weekdays: number[];
  startMin: number;
  endMin: number;
  priceMinor: number;
  priority: number;
  /** Dates `AAAA-MM-JJ` (incluses), ou null = sans borne. */
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
}

export interface BookingRow {
  startsAt: Date;
  endsAt: Date;
  status: 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'EXPIRED' | 'NO_SHOW';
  bookingType: 'STANDARD' | 'SOLO_SESSION' | 'OPPONENT_MATCH' | 'BLOCK';
  holdExpiresAt: Date | null;
}

export type OccupationKind = 'BOOKED' | 'HELD' | 'BLOCKED';

export interface Occupation {
  startsAt: Date;
  endsAt: Date;
  kind: OccupationKind;
}

export interface ComputedSlot {
  startsAt: Date;
  endsAt: Date;
  /** Début du créneau en minutes de service (peut dépasser 1440). */
  startMin: number;
  priceMinor: number | null;
  status: SlotStatus;
}

/**
 * Plages d'ouverture d'un terrain pour un jour de la semaine.
 * Si le terrain a ses PROPRES horaires ce jour-là, ils remplacent ceux du complexe ; sinon on prend ceux du complexe.
 * Aucune plage = fermé.
 */
export function resolveIntervals(
  venueHours: readonly HourRow[],
  fieldHours: readonly HourRow[],
  weekday: number,
): Interval[] {
  const own = fieldHours.filter((h) => h.weekday === weekday);
  const rows = own.length > 0 ? own : venueHours.filter((h) => h.weekday === weekday);
  return rows
    .map(({ opensAtMin, closesAtMin }) => ({ opensAtMin, closesAtMin }))
    .sort((a, b) => a.opensAtMin - b.opensAtMin);
}

/**
 * Prix d'un créneau : règle active la plus PRIORITAIRE couvrant son début (jour, heure, période de validité).
 * À priorité égale, la plage la plus ÉTROITE (la plus spécifique) l'emporte ; en dernier recours l'identifiant
 * départage, pour que le résultat soit toujours déterministe.
 */
export function resolvePrice(
  rules: readonly PriceRule[],
  weekday: number,
  startMin: number,
  date: string,
): number | null {
  const matching = rules.filter(
    (r) =>
      r.isActive &&
      r.weekdays.includes(weekday) &&
      r.startMin <= startMin &&
      startMin < r.endMin &&
      (r.validFrom === null || r.validFrom <= date) &&
      (r.validTo === null || date <= r.validTo),
  );
  if (matching.length === 0) return null;
  matching.sort(
    (a, b) =>
      b.priority - a.priority ||
      a.endMin - a.startMin - (b.endMin - b.startMin) ||
      a.id.localeCompare(b.id),
  );
  return (matching[0] as PriceRule).priceMinor;
}

/**
 * Une réservation occupe-t-elle le créneau, et comment ?
 *  - annulée / expirée → libère le créneau ;
 *  - verrou de paiement DÉPASSÉ → libre aussi, sans attendre que le job d'expiration le constate ;
 *  - verrou en cours → HELD ; blocage du complexe → BLOCKED ; sinon → BOOKED.
 */
export function classifyOccupation(booking: BookingRow, now: Date): Occupation | null {
  const { startsAt, endsAt } = booking;
  switch (booking.status) {
    case 'CANCELLED':
    case 'EXPIRED':
      return null;
    case 'PENDING_PAYMENT':
      return booking.holdExpiresAt && booking.holdExpiresAt > now
        ? { startsAt, endsAt, kind: 'HELD' }
        : null;
    default:
      return { startsAt, endsAt, kind: booking.bookingType === 'BLOCK' ? 'BLOCKED' : 'BOOKED' };
  }
}

export interface ComputeSlotsInput {
  /** Jour de service, `AAAA-MM-JJ`. */
  date: string;
  timeZone: string;
  slotDurationMin: number;
  intervals: readonly Interval[];
  rules: readonly PriceRule[];
  occupations: readonly Occupation[];
  now: Date;
  /** Préavis minimal avant le début d'un créneau réservable. */
  minLeadMinutes: number;
}

/** Plage UTC couverte par les créneaux d'un jour : sert à ne charger que les réservations utiles. */
export function dayWindow(
  date: string,
  timeZone: string,
  intervals: readonly Interval[],
): { from: Date; to: Date } | null {
  if (intervals.length === 0) return null;
  const first = Math.min(...intervals.map((i) => i.opensAtMin));
  const last = Math.max(...intervals.map((i) => i.closesAtMin));
  return { from: localToUtc(date, first, timeZone), to: localToUtc(date, last, timeZone) };
}

const PRECEDENCE: Record<OccupationKind, number> = { BOOKED: 3, BLOCKED: 2, HELD: 1 };

export function computeDaySlots(input: ComputeSlotsInput): ComputedSlot[] {
  const { date, timeZone, slotDurationMin, intervals, rules, occupations, now, minLeadMinutes } =
    input;
  const weekday = isoWeekday(date);
  const earliestBookable = now.getTime() + minLeadMinutes * 60_000;
  const slots: ComputedSlot[] = [];

  for (const interval of intervals) {
    // Les créneaux sont alignés sur l'ouverture de la plage ; un créneau incomplet à la fermeture est ignoré.
    for (
      let start = interval.opensAtMin;
      start + slotDurationMin <= interval.closesAtMin;
      start += slotDurationMin
    ) {
      const startsAt = localToUtc(date, start, timeZone);
      const endsAt = localToUtc(date, start + slotDurationMin, timeZone);
      const priceMinor = resolvePrice(rules, weekday, start, date);

      const overlapping = occupations.filter((o) => o.startsAt < endsAt && o.endsAt > startsAt);
      const blocking = overlapping.sort((a, b) => PRECEDENCE[b.kind] - PRECEDENCE[a.kind])[0];

      let status: SlotStatus;
      if (startsAt.getTime() < earliestBookable) status = 'PAST';
      else if (blocking) status = blocking.kind;
      else if (priceMinor === null) status = 'NO_PRICE';
      else status = 'AVAILABLE';

      slots.push({ startsAt, endsAt, startMin: start, priceMinor, status });
    }
  }
  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

// ───────────────────────── Assemblage pour un terrain ─────────────────────────

export interface HourRowWithField extends HourRow {
  fieldId: string | null;
}

/** Sépare les horaires d'un complexe : lignes du complexe (fieldId nul) et surcharges d'un terrain donné. */
export function splitHours(
  rows: readonly HourRowWithField[],
  fieldId: string,
): { venueHours: HourRow[]; fieldHours: HourRow[] } {
  return {
    venueHours: rows.filter((r) => r.fieldId === null),
    fieldHours: rows.filter((r) => r.fieldId === fieldId),
  };
}

export interface BuildFieldSlotsInput {
  date: string;
  timeZone: string;
  slotDurationMin: number;
  fieldId: string;
  /** TOUTES les lignes d'horaires du complexe (complexe + terrains). */
  hours: readonly HourRowWithField[];
  rules: readonly PriceRule[];
  bookings: readonly BookingRow[];
  now: Date;
  minLeadMinutes: number;
}

/** Créneaux d'un terrain pour un jour de service : horaires → prix → occupation → statut. */
export function buildFieldSlots(input: BuildFieldSlotsInput): ComputedSlot[] {
  const { venueHours, fieldHours } = splitHours(input.hours, input.fieldId);
  const intervals = resolveIntervals(venueHours, fieldHours, isoWeekday(input.date));
  const occupations = input.bookings
    .map((b) => classifyOccupation(b, input.now))
    .filter((o): o is Occupation => o !== null);

  return computeDaySlots({
    date: input.date,
    timeZone: input.timeZone,
    slotDurationMin: input.slotDurationMin,
    intervals,
    rules: input.rules,
    occupations,
    now: input.now,
    minLeadMinutes: input.minLeadMinutes,
  });
}

/** Plage UTC des réservations à charger pour un terrain ce jour-là (null si fermé). */
export function bookingWindow(
  input: Pick<BuildFieldSlotsInput, 'date' | 'timeZone' | 'fieldId' | 'hours'>,
): { from: Date; to: Date } | null {
  const { venueHours, fieldHours } = splitHours(input.hours, input.fieldId);
  return dayWindow(
    input.date,
    input.timeZone,
    resolveIntervals(venueHours, fieldHours, isoWeekday(input.date)),
  );
}
