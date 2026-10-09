import { LOCALES, NOTIFICATION_TYPES } from '@footfive/shared';
import { describe, expect, it } from 'vitest';
import { EMAIL_NOTIFICATION_TYPES, formatWhen, normalizeLocale, notificationTypes, renderNotification } from './notification-content.js';

const data = {
  reference: 'FF-ABC123',
  venueName: 'Complexe Test',
  startsAt: '2027-03-04T17:00:00.000Z',
  teamName: 'Les Lions',
  invitedBy: 'Yasmine B.',
  playerName: 'Karim D.',
  remaining: 2,
  amountMinor: 2000,
};

describe('contenu des notifications', () => {
  it('couvre exactement les types de notification de la plateforme', () => {
    expect([...notificationTypes].sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });

  it.each(NOTIFICATION_TYPES.flatMap((type) => LOCALES.map((locale) => [type, locale] as const)))('%s en %s : titre et corps renseignés, sans « undefined » ni « null »', (type, locale) => {
    const { title, body } = renderNotification(type, data, locale);
    expect(title.length).toBeGreaterThan(3);
    expect(body.length).toBeGreaterThan(10);
    expect(`${title} ${body}`).not.toMatch(/undefined|null|NaN/);
  });

  it('écrit en arabe pour un compte arabe, en anglais pour un compte anglais', () => {
    expect(renderNotification('BOOKING_CONFIRMED', data, 'ar').title).toMatch(/[؀-ۿ]/);
    expect(renderNotification('BOOKING_CONFIRMED', data, 'en').title).toBe('Booking confirmed');
    expect(renderNotification('BOOKING_CONFIRMED', data, 'fr').title).toBe('Réservation confirmée');
  });

  it('retombe sur le français pour une langue inconnue ou absente', () => {
    expect(normalizeLocale('de')).toBe('fr');
    expect(normalizeLocale(null)).toBe('fr');
    expect(normalizeLocale('ar')).toBe('ar');
  });

  it('remplace une donnée manquante par un tiret plutôt que d’afficher « undefined »', () => {
    const { body } = renderNotification('BOOKING_CONFIRMED', { venueName: 'X' }, 'fr');
    expect(body).toContain('—');
    expect(body).not.toMatch(/undefined|null/);
  });

  it('affiche l’heure d’Alger (UTC+1), pas celle du serveur', () => {
    expect(formatWhen('2027-03-04T17:00:00.000Z', 'fr')).toContain('18:00');
    expect(formatWhen('pas une date', 'fr')).toBe('');
    expect(formatWhen(undefined, 'en')).toBe('');
  });

  it('n’envoie par email que des types qui existent', () => {
    for (const type of EMAIL_NOTIFICATION_TYPES) expect(NOTIFICATION_TYPES).toContain(type);
    expect(EMAIL_NOTIFICATION_TYPES.has('SOLO_ALMOST_FULL')).toBe(false); // bruit : reste dans l'application
  });
});
