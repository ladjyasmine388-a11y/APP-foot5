import { expect, test } from '@playwright/test';

test.describe('parcours public', () => {
  test('l’accueil s’affiche et la recherche mène aux terrains de la ville', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Foot Five/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Réservez votre Foot Five');

    await page.getByLabel('Ville').first().fill('Oran');
    await page.getByRole('button', { name: 'Chercher un terrain' }).click();
    await expect(page).toHaveURL(/\/venues\?.*city=Oran/);
    await expect(page.getByRole('link', { name: /Oran Soccer Park/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Stade Five Hydra/ })).toHaveCount(0); // autre ville
  });

  test('la liste n’affiche que des complexes approuvés', async ({ page }) => {
    await page.goto('/venues');
    await expect(page.getByRole('link', { name: /Stade Five Hydra/ })).toBeVisible();
    await expect(page.getByText('Complexe Tlemcen Five')).toHaveCount(0); // en attente de validation
  });

  test('la fiche d’un complexe montre ses disponibilités, ses avis et ses horaires', async ({
    page,
  }) => {
    await page.goto('/venues/stade-five-hydra');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Stade Five Hydra');
    await expect(page.getByRole('heading', { name: 'Disponibilités' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Avis des joueurs' })).toBeVisible();
    await expect(page.getByText('Terrains impeccables, éclairage parfait.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Horaires d’ouverture' })).toBeVisible();
  });

  test('un complexe inconnu donne une page claire, pas une erreur technique', async ({ page }) => {
    await page.goto('/venues/ce-complexe-n-existe-pas');
    await expect(page.getByText('Ce complexe est introuvable.')).toBeVisible();
    await page.goto('/une/page/inconnue');
    await expect(page.getByText('Page introuvable')).toBeVisible();
  });

  test('une page privée renvoie vers la connexion', async ({ page }) => {
    await page.goto('/bookings');
    await expect(page).toHaveURL(/\/login\?next=%2Fbookings/);
    await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();
  });

  test('l’arabe passe l’interface en droite-à-gauche, le français la rétablit', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByLabel('Langue').selectOption('ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByRole('link', { name: 'الملاعب' }).first()).toBeVisible();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl'); // mémorisé

    await page.getByLabel('اللغة').selectOption('fr');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('link', { name: 'Terrains' }).first()).toBeVisible();
  });

  test('les créneaux sont affichés à l’heure d’Alger et les montants en dinars', async ({
    page,
  }) => {
    await page.goto(
      '/venues/stade-five-hydra?date=' +
        new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
    );
    const slot = page.getByRole('button', { name: /Libre$/ }).first();
    await expect(slot).toBeVisible();
    await expect(slot).toContainText(/\d{2}:\d{2}/);
    await expect(slot).toContainText(/DA/);
  });
});
