import { describe, expect, it } from 'vitest';
import { AppException } from '../../common/errors/app-exception.js';
import { canonicalJson, parseIdempotencyKey } from './idempotency.service.js';

describe('canonicalJson', () => {
  it('ne dépend pas de l’ordre des clés, à tous les niveaux', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { y: 1, x: 2 }] } })).toBe(
      canonicalJson({ a: { c: [3, { x: 2, y: 1 }], d: 2 }, b: 1 }),
    );
  });

  it('distingue des contenus différents', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(canonicalJson({ a: '1' })).not.toBe(canonicalJson({ a: 1 }));
  });

  it('ignore les champs indéfinis (absents du JSON réellement envoyé)', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('gère null, tableaux vides et valeurs simples', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson('x')).toBe('"x"');
  });
});

describe('parseIdempotencyKey', () => {
  it('accepte des clés de 8 à 128 caractères [A-Za-z0-9_-]', () => {
    expect(parseIdempotencyKey('abcd1234')).toBe('abcd1234');
    expect(parseIdempotencyKey('3f2b9c1e-7a54-4d0a-9e66-1b2c3d4e5f60')).toBeTruthy();
    expect(parseIdempotencyKey('a'.repeat(128))).toBeTruthy();
  });

  it.each([
    undefined,
    '',
    'court',
    'a'.repeat(129),
    'espace interdit',
    'caractère-é-interdit',
    '<script>12345678',
  ])('refuse « %s »', (value) => {
    expect(() => parseIdempotencyKey(value as string | undefined)).toThrow(AppException);
  });

  it('prend la première valeur si l’en-tête est répété', () => {
    expect(parseIdempotencyKey(['abcd1234', 'zzzzzzzz'])).toBe('abcd1234');
  });
});
