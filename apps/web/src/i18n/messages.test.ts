import { LOCALES } from '@footfive/shared';
import { describe, expect, it } from 'vitest';
import { errorMessages } from './messages/errors';
import { messageSources, messages } from './messages/index';

describe('traductions', () => {
  it('aucune clé n’est définie dans deux fichiers à la fois (l’une écraserait l’autre en silence)', () => {
    const all = messageSources.flatMap((source) => Object.keys(source));
    expect(all.length - new Set(all).size).toBe(0);
    expect(Object.keys(messages)).toHaveLength(all.length);
  });

  it('chaque message existe dans les trois langues et n’est pas vide', () => {
    for (const [key, message] of Object.entries(messages)) {
      for (const locale of LOCALES)
        expect(message[locale]?.trim().length, `${key} (${locale})`).toBeGreaterThan(0);
    }
    for (const [code, message] of Object.entries(errorMessages)) {
      for (const locale of LOCALES)
        expect(message[locale]?.trim().length, `erreur ${code} (${locale})`).toBeGreaterThan(0);
    }
  });

  it('les variables {…} sont les mêmes dans les trois langues (aucune ne manque à la traduction)', () => {
    const vars = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .sort()
        .join(',');
    for (const [key, message] of Object.entries(messages)) {
      const reference = vars(message.fr);
      for (const locale of LOCALES)
        expect(vars(message[locale]), `${key} (${locale})`).toBe(reference);
    }
  });

  it('l’arabe contient de l’arabe, le français n’en contient pas', () => {
    for (const [key, message] of Object.entries(messages)) {
      if (key.startsWith('lang.') || key === 'brand.name') continue;
      expect(message.ar, key).toMatch(/[\u0600-\u06FF]/);
      expect(message.fr, key).not.toMatch(/[\u0600-\u06FF]/);
    }
  });
});
