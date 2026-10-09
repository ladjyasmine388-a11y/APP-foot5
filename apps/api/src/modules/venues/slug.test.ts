import { describe, expect, it } from 'vitest';
import { slugCandidate, slugify } from './slug.js';

describe('slugify', () => {
  it.each([
    ['Five Alger Centre', 'five-alger-centre'],
    ['  Five   Alger  ', 'five-alger'],
    ['Étoile du Sahel — Hydra !', 'etoile-du-sahel-hydra'],
    ['Complexe N°1 (Bab Ezzouar)', 'complexe-n-1-bab-ezzouar'],
    ['FOOT5.dz', 'foot5-dz'],
  ])('%s → %s', (name, expected) => {
    expect(slugify(name)).toBe(expected);
  });

  it('un nom arabe (non latin) donne « complexe » par défaut', () => {
    expect(slugify('ملعب الجزائر')).toBe('complexe');
    expect(slugify('!!!')).toBe('complexe');
  });

  it('borne la longueur sans finir par un tiret', () => {
    const slug = slugify(`${'a'.repeat(59)} b c d`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('ne produit que des caractères sûrs pour une URL', () => {
    expect(slugify('<script>alert("x")</script> ../../etc')).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('slugCandidate', () => {
  it('le premier essai est le slug seul, les suivants ajoutent un suffixe aléatoire', () => {
    expect(slugCandidate('five', 0)).toBe('five');
    const retry = slugCandidate('five', 1);
    expect(retry).toMatch(/^five-[0-9a-f]{6}$/);
    expect(slugCandidate('five', 2)).not.toBe(retry);
  });
});
