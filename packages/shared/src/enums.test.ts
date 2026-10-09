import { describe, expect, it } from 'vitest';
import {
  BOOKING_ACTIVE_STATUSES,
  BOOKING_STATUSES,
  CURRENCY,
  DEFAULT_LOCALE,
  LOCALES,
} from './enums';

describe('enums partagés', () => {
  it('les statuts actifs de réservation sont un sous-ensemble des statuts', () => {
    for (const status of BOOKING_ACTIVE_STATUSES) {
      expect(BOOKING_STATUSES).toContain(status);
    }
  });

  it("AVAILABLE n'est pas un statut persisté (c'est l'absence de réservation)", () => {
    expect(BOOKING_STATUSES).not.toContain('AVAILABLE');
  });

  it('la locale par défaut est supportée (ar, fr, en)', () => {
    expect(LOCALES).toEqual(['ar', 'fr', 'en']);
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });

  it('la devise du MVP est le dinar algérien', () => {
    expect(CURRENCY).toBe('DZD');
  });
});
