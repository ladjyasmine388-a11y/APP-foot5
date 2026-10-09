import { type OpeningHoursDayView, type PricingRuleView, toRangeView } from '@footfive/shared';

interface HourRow {
  weekday: number;
  opensAtMin: number;
  closesAtMin: number;
}

/** Lignes d'horaires → une entrée par jour de la semaine (1 à 7), plages triées. Jours fermés absents. */
export function toOpeningHoursView(rows: readonly HourRow[]): OpeningHoursDayView[] {
  const byDay = new Map<number, HourRow[]>();
  for (const row of rows) byDay.set(row.weekday, [...(byDay.get(row.weekday) ?? []), row]);
  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([weekday, dayRows]) => ({
      weekday,
      intervals: dayRows
        .sort((a, b) => a.opensAtMin - b.opensAtMin)
        .map((r) => toRangeView({ startMin: r.opensAtMin, endMin: r.closesAtMin })),
    }));
}

interface RuleRow {
  id: string;
  fieldId: string;
  weekdays: number[];
  startMin: number;
  endMin: number;
  priceMinor: number;
  priority: number;
  validFrom: Date | null;
  validTo: Date | null;
  isActive: boolean;
}

export function toPricingRuleView(row: RuleRow): PricingRuleView {
  const range = toRangeView({ startMin: row.startMin, endMin: row.endMin });
  return {
    id: row.id,
    fieldId: row.fieldId,
    weekdays: row.weekdays,
    from: range.from,
    to: range.to,
    overnight: range.overnight,
    priceMinor: row.priceMinor,
    priority: row.priority,
    validFrom: row.validFrom ? row.validFrom.toISOString().slice(0, 10) : null,
    validTo: row.validTo ? row.validTo.toISOString().slice(0, 10) : null,
    isActive: row.isActive,
  };
}

/** Prix « à partir de » : le plus bas des tarifs actifs, ou null si aucun tarif n'est défini. */
export function minPrice(
  rules: readonly { priceMinor: number; isActive: boolean }[],
): number | null {
  const prices = rules.filter((r) => r.isActive).map((r) => r.priceMinor);
  return prices.length > 0 ? Math.min(...prices) : null;
}

/** Distance à vol d'oiseau en kilomètres (formule de haversine). */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
