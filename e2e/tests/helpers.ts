import { readFileSync } from 'node:fs';
import { type Page, expect } from '@playwright/test';

/** Mot de passe des comptes de démonstration : lu dans le fichier de seed (une seule source de vérité). */
export const DEMO_PASSWORD = (() => {
  const source = readFileSync(
    new URL('../../apps/api/prisma/seed-demo.ts', import.meta.url),
    'utf8',
  );
  const match = /DEMO_PASSWORD\s*=\s*'([^']+)'/.exec(source);
  if (!match?.[1]) throw new Error('DEMO_PASSWORD introuvable dans seed-demo.ts');
  return match[1];
})();

export const player = (n: number): string => `joueur${String(n).padStart(2, '0')}@footfive.dz`;
export const owner = (n: number): string => `gerant${n}@footfive.dz`;
export const ADMIN = 'admin@footfive.dz';

/**
 * Ouvre une session en appelant l'API (le cookie de rafraîchissement est posé dans le contexte du navigateur), comme le ferait
 * le formulaire. Un test dédié exerce le vrai formulaire ; les autres gagnent du temps et épargnent la limite de tentatives
 * (5 essais / 15 min par couple IP + email).
 */
export async function loginAs(page: Page, email: string): Promise<void> {
  const res = await page.context().request.post('/api/v1/auth/login', {
    data: { email, password: DEMO_PASSWORD },
  });
  expect(res.ok(), `connexion de ${email} : ${await res.text()}`).toBeTruthy();
}

/** Date `AAAA-MM-JJ` dans `days` jours, à l'heure d'Alger. */
export function dateIn(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers' }).format(
    new Date(Date.now() + days * 86_400_000),
  );
}

export const PAY_BUTTON = /Payer .* et confirmer/;
