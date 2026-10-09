import { loginSchema, registerSchema } from '@footfive/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { blankToUndefined, parseForm, serverFieldErrors } from './forms';
import { safeNext } from './query';

describe('formulaires', () => {
  it('valide avec le même schéma que l’API et ne retient que les champs en faute', () => {
    const bad = parseForm(loginSchema, { email: 'pas-un-email', password: '' });
    expect(bad.data).toBeNull();
    expect(Object.keys(bad.errors ?? {}).sort()).toEqual(['email', 'password']);
    const ok = parseForm(loginSchema, { email: ' Joueur@Example.COM ', password: 'x' });
    expect(ok.errors).toBeNull();
    expect(ok.data).toEqual({ email: 'joueur@example.com', password: 'x' }); // normalisé comme côté serveur
  });

  it('refuse un compte sans consentement aux conditions ni mot de passe acceptable', () => {
    const base = { firstName: 'Yacine', lastName: 'Benali', email: 'y@example.com', phone: '0550123456', level: 'BEGINNER', preferredPosition: 'ANY', locale: 'fr' };
    expect(parseForm(registerSchema, { ...base, password: 'un-bon-mot-de-passe', acceptTerms: false }).errors).toHaveProperty('acceptTerms');
    expect(parseForm(registerSchema, { ...base, password: 'court', acceptTerms: true }).errors).toHaveProperty('password');
    expect(parseForm(registerSchema, { ...base, password: 'un-bon-mot-de-passe', acceptTerms: true }).errors).toBeNull();
  });

  it('lit les champs refusés par le serveur', () => {
    const error = new ApiError(400, 'VALIDATION_ERROR', 'x', [{ path: 'spots', message: 'Maximum 9', code: 'too_big' }, { path: '', message: 'ignoré' }]);
    expect(serverFieldErrors(error)).toEqual({ spots: 'too_big' });
    expect(serverFieldErrors(new ApiError(500, 'INTERNAL_ERROR', 'x'))).toEqual({});
    expect(serverFieldErrors(new Error('autre'))).toEqual({});
  });

  it('un champ facultatif vide n’est pas envoyé', () => {
    expect(blankToUndefined('   ')).toBeUndefined();
    expect(blankToUndefined(' Alger ')).toBe('Alger');
  });
});

describe('redirection après connexion', () => {
  it('n’accepte qu’un chemin interne : jamais une adresse externe (pas de redirection ouverte)', () => {
    expect(safeNext('/bookings/123?x=1')).toBe('/bookings/123?x=1');
    for (const evil of ['https://evil.example', '//evil.example', 'javascript:alert(1)', '\\\\evil', '/\\evil', '', null, undefined]) {
      expect(safeNext(evil), String(evil)).toBe('/');
    }
  });
});
