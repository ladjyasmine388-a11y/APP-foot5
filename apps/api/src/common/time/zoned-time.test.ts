import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, isoWeekday, localToUtc, todayIn } from './zoned-time.js';

describe('localToUtc', () => {
  it('Alger (UTC+1, sans changement d’heure) : 20:00 locale = 19:00 UTC, toute l’année', () => {
    expect(localToUtc('2026-10-20', 20 * 60, 'Africa/Algiers').toISOString()).toBe(
      '2026-10-20T19:00:00.000Z',
    );
    expect(localToUtc('2026-07-15', 20 * 60, 'Africa/Algiers').toISOString()).toBe(
      '2026-07-15T19:00:00.000Z',
    );
  });

  it('minuit local tombe à 23:00 UTC la veille', () => {
    expect(localToUtc('2026-10-20', 0, 'Africa/Algiers').toISOString()).toBe(
      '2026-10-19T23:00:00.000Z',
    );
  });

  it('au-delà de 24 h : 26:00 = 02:00 le lendemain (jour de service)', () => {
    expect(localToUtc('2026-10-23', 26 * 60, 'Africa/Algiers').toISOString()).toBe(
      '2026-10-24T01:00:00.000Z',
    );
  });

  it('UTC : aucun décalage', () => {
    expect(localToUtc('2026-10-20', 600, 'UTC').toISOString()).toBe('2026-10-20T10:00:00.000Z');
  });

  describe('fuseau avec changement d’heure (Europe/Paris)', () => {
    it('heure d’hiver (UTC+1) et heure d’été (UTC+2)', () => {
      expect(localToUtc('2026-01-15', 20 * 60, 'Europe/Paris').toISOString()).toBe(
        '2026-01-15T19:00:00.000Z',
      );
      expect(localToUtc('2026-07-15', 20 * 60, 'Europe/Paris').toISOString()).toBe(
        '2026-07-15T18:00:00.000Z',
      );
    });

    it('le jour du passage à l’heure d’été (29 mars 2026), 20:00 locale = 18:00 UTC', () => {
      expect(localToUtc('2026-03-29', 20 * 60, 'Europe/Paris').toISOString()).toBe(
        '2026-03-29T18:00:00.000Z',
      );
      // 01:00 locale existe encore en heure d'hiver (UTC+1) → 00:00 UTC.
      expect(localToUtc('2026-03-29', 60, 'Europe/Paris').toISOString()).toBe(
        '2026-03-29T00:00:00.000Z',
      );
    });

    it('le jour du retour à l’heure d’hiver (25 octobre 2026), 20:00 locale = 19:00 UTC', () => {
      expect(localToUtc('2026-10-25', 20 * 60, 'Europe/Paris').toISOString()).toBe(
        '2026-10-25T19:00:00.000Z',
      );
    });
  });
});

describe('isoWeekday', () => {
  it.each([
    ['2026-10-19', 1], // lundi
    ['2026-10-20', 2],
    ['2026-10-23', 5], // vendredi
    ['2026-10-24', 6],
    ['2026-10-25', 7], // dimanche
  ])('%s → %i', (date, expected) => {
    expect(isoWeekday(date)).toBe(expected);
  });
});

describe('addDays / daysBetween', () => {
  it('traverse les fins de mois et d’année, y compris les années bissextiles', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-10-20', -20)).toBe('2026-09-30');
  });

  it('daysBetween est la différence de dates calendaires', () => {
    expect(daysBetween('2026-10-20', '2026-10-27')).toBe(7);
    expect(daysBetween('2026-10-20', '2026-10-20')).toBe(0);
    expect(daysBetween('2026-10-20', '2026-10-19')).toBe(-1);
  });
});

describe('todayIn', () => {
  it('à 23:30 UTC, il est déjà « demain » à Alger (UTC+1)', () => {
    const now = new Date('2026-10-20T23:30:00.000Z');
    expect(todayIn('UTC', now)).toBe('2026-10-20');
    expect(todayIn('Africa/Algiers', now)).toBe('2026-10-21');
  });
});
