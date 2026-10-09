import { describe, expect, it } from 'vitest';
import { detectLocale, directionOf, formatMoney, formatTime, interpolate, localDate, localToUtcIso, parseHHMM } from './format';

describe('formats', () => {
  it('affiche les montants en dinars avec des espaces comme séparateur de milliers, y compris en arabe', () => {
    expect(formatMoney(8500, 'fr').replace(/\s/g, ' ')).toBe('8 500 DA');
    expect(formatMoney(8500, 'en')).toBe('8,500 DA');
    expect(formatMoney(8500, 'ar').replace(/\s/g, ' ')).toBe('8 500 دج');
  });

  it('affiche toujours l’heure d’Alger, quel que soit le fuseau du navigateur', () => {
    expect(formatTime('2026-10-20T19:00:00Z', 'fr')).toBe('20:00');
    expect(formatTime('2026-10-20T19:00:00Z', 'en')).toBe('20:00');
  });

  it('convertit une date et une heure locales en instant UTC', () => {
    expect(localToUtcIso('2026-10-20', '20:00')).toBe('2026-10-20T19:00:00.000Z');
    expect(localToUtcIso('2026-10-20', '00:30')).toBe('2026-10-19T23:30:00.000Z');
    expect(localToUtcIso('2026-07-01', '12:00', 'Europe/Paris')).toBe('2026-07-01T10:00:00.000Z'); // heure d'été
    expect(localToUtcIso('2026-01-15', '12:00', 'Europe/Paris')).toBe('2026-01-15T11:00:00.000Z');
  });

  it('calcule la date du jour à l’heure d’Alger', () => {
    expect(localDate(0, new Date('2026-10-09T23:30:00Z'))).toBe('2026-10-10'); // déjà demain à Alger
    expect(localDate(2, new Date('2026-10-09T10:00:00Z'))).toBe('2026-10-11');
  });

  it('détecte la langue et le sens de lecture', () => {
    expect(detectLocale(['ar-DZ', 'fr'])).toBe('ar');
    expect(detectLocale(['de-DE', 'en-US'])).toBe('en');
    expect(detectLocale(['de'])).toBe('fr');
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('fr')).toBe('ltr');
  });

  it('interpole sans jamais afficher « undefined »', () => {
    expect(interpolate('{n} places sur {total}', { n: 2, total: 8 })).toBe('2 places sur 8');
    expect(interpolate('Bonjour {name}', {})).toBe('Bonjour {name}');
    expect(interpolate('Texte', undefined)).toBe('Texte');
  });

  it('lit une heure HH:MM', () => {
    expect(parseHHMM('20:30')).toBe(1230);
    expect(parseHHMM('24:00')).toBeNull();
    expect(parseHHMM('9:00')).toBeNull();
  });
});
