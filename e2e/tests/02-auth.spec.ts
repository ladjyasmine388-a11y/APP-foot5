import { expect, test } from '@playwright/test';
import { DEMO_PASSWORD, player } from './helpers';

test.describe('compte', () => {
  test('inscription : le compte est créé et le joueur est invité à confirmer son email', async ({
    page,
  }) => {
    const email = `nouveau.${Date.now()}@example.com`;
    await page.goto('/register');
    await page.getByLabel('Prénom').fill('Samia');
    await page.getByLabel('Nom', { exact: true }).fill('Bensaid');
    await page.getByLabel('Adresse email').fill(email);
    await page.getByLabel('Téléphone').fill('0550123456');
    await page.getByLabel('Mot de passe').fill('un-mot-de-passe-solide-2026');
    await page.getByLabel(/J’accepte les conditions/).check();
    await page.getByRole('button', { name: 'Créer mon compte' }).click();
    await expect(page.getByText(/Compte créé/)).toBeVisible();

    // Connecté mais email non confirmé : bandeau d'avertissement.
    await page.goto('/venues');
    await expect(
      page.getByText('Confirmez votre adresse email pour pouvoir réserver.'),
    ).toBeVisible();
  });

  test('l’inscription signale un mot de passe trop court et l’absence de consentement', async ({
    page,
  }) => {
    await page.goto('/register');
    await page.getByLabel('Mot de passe').fill('court');
    await page.getByRole('button', { name: 'Créer mon compte' }).click();
    await expect(page.getByText('Champ requis')).toBeVisible(); // consentement
    await expect(page.getByLabel('Mot de passe')).toHaveAttribute('aria-invalid', 'true');
  });

  test('connexion : mauvais mot de passe refusé sans rien révéler, bon mot de passe accepté', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel('Adresse email').fill(player(3));
    await page.getByLabel('Mot de passe').fill('mauvais-mot-de-passe');
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page.getByRole('alert')).toContainText('Email ou mot de passe incorrect.');

    await page.getByLabel('Mot de passe').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page.getByRole('link', { name: 'Notifications' })).toBeVisible();
    await expect(page).toHaveURL('/');
  });

  test('déconnexion : la session et les données disparaissent', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Adresse email').fill(player(4));
    await page.getByLabel('Mot de passe').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page.getByRole('link', { name: 'Notifications' })).toBeVisible();

    await page.getByRole('button', { name: /^\p{L}+ \p{L}+$/u }).click();
    await page.getByRole('menuitem', { name: 'Se déconnecter' }).click();
    await expect(page.getByRole('link', { name: 'Connexion' })).toBeVisible();
    await page.goto('/bookings');
    await expect(page).toHaveURL(/\/login/);
  });

  test('un lien « next » externe est ignoré après la connexion (pas de redirection ouverte)', async ({
    page,
  }) => {
    await page.goto('/login?next=https://evil.example/phishing');
    await page.getByLabel('Adresse email').fill(player(5));
    await page.getByLabel('Mot de passe').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page).toHaveURL('http://localhost:5174/');
  });
});
