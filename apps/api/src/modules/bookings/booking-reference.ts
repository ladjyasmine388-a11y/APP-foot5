import { randomInt } from 'node:crypto';

/**
 * Alphabet sans caractères ambigus (ni 0/O, ni 1/I/L) : une référence dictée au téléphone au complexe
 * ne peut pas être mal comprise. 31 symboles ^ 8 positions ≈ 8,5 × 10¹¹ combinaisons.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const LENGTH = 8;

/** Référence lisible, ex. `FF-7K2M9Q4D`. L'unicité est garantie par la base (index unique) ; on réessaie en cas de collision. */
export function generateBookingReference(): string {
  let code = '';
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return `FF-${code}`;
}
