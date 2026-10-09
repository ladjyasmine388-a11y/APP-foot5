import { describe, expect, it } from 'vitest';
import { generateBookingReference } from './booking-reference.js';

describe('generateBookingReference', () => {
  it('a le format FF-XXXXXXXX, sans caractère ambigu', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateBookingReference()).toMatch(/^FF-[2-9A-HJKMNP-Z]{8}$/);
    }
  });

  it('ne contient jamais 0, O, 1, I ni L', () => {
    const all = Array.from({ length: 2000 }, generateBookingReference).join('');
    expect(all.replace(/FF-/g, '')).not.toMatch(/[01OIL]/);
  });

  it('ne produit pas de doublon sur 20 000 tirages', () => {
    const refs = new Set(Array.from({ length: 20_000 }, generateBookingReference));
    expect(refs.size).toBe(20_000);
  });
});
