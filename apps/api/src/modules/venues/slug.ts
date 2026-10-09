import { randomBytes } from 'node:crypto';

/**
 * Transforme un nom en adresse lisible : « Five Alger — Hydra ! » → « five-alger-hydra ».
 * Les accents sont retirés (« Étoile » → « etoile »). Un nom entièrement non latin (arabe) donne « complexe » :
 * l'unicité est de toute façon garantie par le suffixe aléatoire ajouté en cas de collision.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'complexe';
}

/** Candidat n°`attempt` : le slug seul d'abord, puis suffixé d'un jeton aléatoire court. */
export function slugCandidate(base: string, attempt: number): string {
  return attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
}
