import { expect, test } from '@playwright/test';
import { loginAs, player } from './helpers';

test.describe('équipes, parties ouvertes et adversaires', () => {
  test('un joueur invité accepte l’invitation et rejoint l’équipe', async ({ page }) => {
    await loginAs(page, player(18));
    await page.goto('/teams');
    await expect(page.getByText(/vous invite à rejoindre « Les Lions d’Alger »/)).toBeVisible();
    await page.getByRole('button', { name: 'Accepter' }).click();
    await expect(page.getByRole('link', { name: /Les Lions d’Alger/ })).toBeVisible();

    await page.getByRole('link', { name: /Les Lions d’Alger/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Les Lions d’Alger');
    await expect(page.getByRole('button', { name: 'Quitter l’équipe' })).toBeVisible(); // simple membre
  });

  test('un membre voit l’effectif, un étranger non', async ({ page, browser }) => {
    await loginAs(page, player(2));
    await page.goto('/teams');
    await page
      .getByRole('link', { name: /Les Lions d’Alger/ })
      .first()
      .click();
    await expect(page.getByText('Capitaine').first()).toBeVisible();
    await expect(page.getByText('Yacine Benali').first()).toBeVisible();

    const stranger = await browser.newContext();
    const other = await stranger.newPage();
    await loginAs(other, player(11)); // membre d'une AUTRE équipe
    await other.goto(page.url());
    await expect(
      other.getByText('L’effectif n’est visible que des membres de l’équipe.'),
    ).toBeVisible();
    await expect(other.getByText('Yacine Benali')).toHaveCount(1); // seulement le capitaine, en en-tête
    await stranger.close();
  });

  test('rejoindre une partie ouverte : la place est prise, puis rendue en se désinscrivant', async ({
    page,
  }) => {
    await loginAs(page, player(12));
    await page.goto('/solo');
    await page
      .getByRole('link', { name: /Stade Five Hydra/ })
      .first()
      .click();
    await expect(page.getByText('2 place(s) restante(s) sur 4').first()).toBeVisible();
    await expect(page.getByText(/directement avec l’organisateur/)).toBeVisible();

    await page.getByRole('button', { name: 'Rejoindre' }).click();
    await expect(page.getByText('Vous êtes inscrit').first()).toBeVisible();
    await expect(page.getByText('1 place(s) restante(s) sur 4').first()).toBeVisible();

    await page.getByRole('button', { name: 'Me désinscrire' }).click();
    await expect(page.getByRole('button', { name: 'Rejoindre' })).toBeVisible();
    await expect(page.getByText('2 place(s) restante(s) sur 4').first()).toBeVisible();
  });

  test('un joueur anonyme voit la partie mais pas la liste des joueurs', async ({ page }) => {
    await page.goto('/solo');
    await page
      .getByRole('link', { name: /Stade Five Hydra/ })
      .first()
      .click();
    await expect(
      page.getByText('La liste des joueurs est visible une fois connecté.'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connectez-vous pour réserver' })).toBeVisible();
  });

  test('le capitaine accepte une demande d’adversaire : le match est créé avec les deux effectifs', async ({
    page,
  }) => {
    await loginAs(page, player(1)); // capitaine des Lions
    await page.goto('/opponents');
    await page
      .getByRole('link', { name: /Les Lions d’Alger/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Demandes reçues' })).toBeVisible();
    await expect(page.getByText('On est partants, on arrive avec 6 joueurs.')).toBeVisible();

    await page.getByRole('button', { name: 'Accepter et créer le match' }).click();
    await expect(page).toHaveURL(/\/matches\/[\w-]+$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Les Lions d’Alger — AS Bab Ezzouar',
    );
    // 6 + 6 joueurs, plus le nouveau membre accepté par le premier test de ce fichier : au moins 12 participants.
    const heading = await page
      .getByRole('heading', { name: /^Participants \(\d+\)$/ })
      .textContent();
    expect(Number(/\((\d+)\)/.exec(heading ?? '')?.[1])).toBeGreaterThanOrEqual(12);
  });

  test('une équipe demande à affronter une annonce, puis retire sa demande', async ({ page }) => {
    await loginAs(page, player(7)); // capitaine d'AS Bab Ezzouar
    await page.goto('/opponents');
    await page
      .getByRole('link', { name: /Oran United/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Demander à jouer' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Demander à jouer' }).click();
    await expect(page.getByText('Demande envoyée')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retirer ma demande' })).toBeVisible();
    await page.getByRole('button', { name: 'Retirer ma demande' }).click();
    await expect(page.getByRole('button', { name: 'Demander à jouer' })).toBeVisible();
  });
});
