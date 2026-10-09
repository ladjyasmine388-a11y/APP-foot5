import { expect, test } from '@playwright/test';
import { ADMIN, dateIn, loginAs, owner, player } from './helpers';

test.describe('espace complexe', () => {
  test('le gérant voit ses réservations, en saisit une à la main et bloque un créneau', async ({
    page,
  }) => {
    await loginAs(page, owner(1));
    await page.goto('/manage');
    await page.getByRole('link', { name: /Stade Five Hydra/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Stade Five Hydra');

    // Les coordonnées du client et la décomposition financière sont visibles du complexe.
    await expect(page.getByText('Walid Cherif').first()).toBeVisible();
    await expect(page.getByText(/Commission .* · Part du complexe/).first()).toBeVisible();

    await page.getByRole('button', { name: 'Réservation manuelle' }).click();
    const manual = page.getByRole('dialog');
    await manual.getByLabel('Date').fill(dateIn(1));
    await manual.getByLabel('Nom du client').fill('Client téléphone E2E');
    await manual.getByLabel('Téléphone du client').fill('0550998877');
    await manual.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByText('Réservation enregistrée')).toBeVisible();
    await expect(page.getByText('Client téléphone E2E')).toBeVisible();

    await page.getByRole('button', { name: 'Bloquer un créneau' }).click();
    const block = page.getByRole('dialog');
    await block.getByLabel('Date').fill(dateIn(2));
    await block.getByLabel('Début').fill('21:00');
    await block.getByLabel('Fin').fill('22:00');
    await block.getByLabel('Motif').fill('Travaux');
    await block.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByText('Créneau bloqué').first()).toBeVisible();
  });

  test('un joueur qui n’est pas du personnel ne voit pas les réservations d’un complexe', async ({
    page,
  }) => {
    await loginAs(page, player(13));
    await page.goto('/manage');
    await expect(page.getByText('Vous ne gérez aucun complexe')).toBeVisible();
    await page.goto('/manage/venues/00000000-0000-4000-8000-000000000000/bookings');
    await expect(page.getByText('Page introuvable')).toBeVisible();
  });

  test('un propriétaire ne peut ni quitter ni se rétrograder s’il est le seul propriétaire', async ({
    page,
  }) => {
    await loginAs(page, owner(2));
    await page.goto('/manage');
    await page.getByRole('link', { name: /Five Arena Bab Ezzouar/ }).click(); // gerant2 en est l'unique propriétaire
    await page.getByRole('link', { name: 'Personnel' }).click();
    await expect(
      page.getByText('Un complexe garde toujours au moins un propriétaire.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Quitter ce complexe' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmer' }).click();
    await expect(
      page.getByRole('alert').or(page.getByText(/Cette action est impossible/)),
    ).toBeVisible();
  });
});

test.describe('administration', () => {
  test('un joueur ordinaire n’accède pas à l’administration', async ({ page }) => {
    await loginAs(page, player(14));
    await page.goto('/admin');
    await expect(page.getByText('Accès refusé')).toBeVisible();
  });

  test('l’administrateur approuve un complexe en attente : le gérant est prévenu et le complexe devient public', async ({
    page,
    browser,
  }) => {
    await loginAs(page, ADMIN);
    await page.goto('/admin');
    await expect(page.getByText('Volume des réservations')).toBeVisible();

    await page.goto('/admin/venues?status=PENDING');
    await expect(page.getByText('Complexe Tlemcen Five')).toBeVisible();
    await page.getByRole('button', { name: 'Approuver' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmer' }).click();
    await expect(page.getByText('Décision enregistrée')).toBeVisible();

    const anonymous = await browser.newContext();
    const visitor = await anonymous.newPage();
    await visitor.goto('/venues');
    await expect(visitor.getByRole('link', { name: /Complexe Tlemcen Five/ })).toBeVisible();
    await anonymous.close();

    const ownerContext = await browser.newContext();
    const gerant = await ownerContext.newPage();
    await loginAs(gerant, owner(5));
    await gerant.goto('/notifications');
    await expect(gerant.getByText('Complexe approuvé')).toBeVisible();
    await ownerContext.close();
  });

  test('l’administrateur modifie la commission : la nouvelle règle est en vigueur, l’historique est conservé', async ({
    page,
  }) => {
    await loginAs(page, ADMIN);
    await page.goto('/admin/commission');
    await expect(page.getByText('1 %').first()).toBeVisible();
    await page.getByLabel('Taux (%)').fill('2.5');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByText('Taux enregistré')).toBeVisible();
    await expect(page.getByText('2.5 %').first()).toBeVisible();
    await expect(page.getByText('en cours')).toHaveCount(1);
    await expect(page.getByText('1 %').first()).toBeVisible(); // ancienne règle dans l'historique

    // Remise au taux initial pour ne pas fausser les autres tests.
    await page.getByLabel('Taux (%)').fill('1');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByText('Taux enregistré').last()).toBeVisible();
  });

  test('un taux de commission aberrant est refusé', async ({ page }) => {
    await loginAs(page, ADMIN);
    await page.goto('/admin/commission');
    await page.getByLabel('Taux (%)').fill('45');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByText('Corrigez les champs en rouge.')).toBeVisible();
  });

  test('le journal d’audit garde la trace des décisions', async ({ page }) => {
    await loginAs(page, ADMIN);
    await page.goto('/admin/audit');
    await expect(page.getByText('Journal en lecture seule')).toBeVisible();
    await page.getByLabel('Action (préfixe)').fill('commission.');
    await expect(page.getByText('commission.update_global').first()).toBeVisible();
  });
});
