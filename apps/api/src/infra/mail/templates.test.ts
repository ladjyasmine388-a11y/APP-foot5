import { LOCALES } from '@footfive/shared';
import { describe, expect, it } from 'vitest';
import { mailTemplates } from './templates.js';

const link = 'https://app.example.dz/verify-email?token=abc';

describe('gabarits d’email', () => {
  it.each(LOCALES)('contiennent le lien et le prénom en « %s »', (locale) => {
    const mail = mailTemplates.verifyEmail('a@b.co', locale, { name: 'Yasmine', link });
    expect(mail.to).toBe('a@b.co');
    expect(mail.text).toContain(link);
    expect(mail.text).toContain('Yasmine');
    expect(mail.subject.length).toBeGreaterThan(5);
  });

  it('sont réellement traduits (objets différents selon la langue)', () => {
    const subjects = LOCALES.map(
      (l) => mailTemplates.resetPassword('a@b.co', l, { name: 'X', link }).subject,
    );
    expect(new Set(subjects).size).toBe(LOCALES.length);
    expect(subjects.find((s) => /[؀-ۿ]/.test(s))).toBeDefined(); // un sujet en arabe
  });

  it('retombent sur le français pour une langue inconnue', () => {
    const fallback = mailTemplates.passwordChanged('a@b.co', 'xx', { name: 'Yas' });
    const french = mailTemplates.passwordChanged('a@b.co', 'fr', { name: 'Yas' });
    expect(fallback).toEqual(french);
  });

  it('le message « mot de passe modifié » ne contient aucun lien (anti-hameçonnage)', () => {
    for (const locale of LOCALES) {
      expect(mailTemplates.passwordChanged('a@b.co', locale, { name: 'X' }).text).not.toMatch(
        /https?:\/\//,
      );
    }
  });
});
