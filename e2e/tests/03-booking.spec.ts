import { expect, test } from '@playwright/test';
import { PAY_BUTTON, dateIn, loginAs, player } from './helpers';

const CHECKOUT = /\/api\/v1\/dev\/fake-provider\/checkout\//;

test.describe('réservation et paiement', () => {
  test('un joueur réserve un créneau, paie sur la page simulée, puis annule avec remboursement', async ({
    page,
  }) => {
    await loginAs(page, player(6));
    await page.goto(`/venues/setif-five-stadium?date=${dateIn(2)}`);
    await page
      .getByRole('button', { name: /Libre$/ })
      .first()
      .click();

    // Récapitulatif calculé par le serveur : prix, acompte de 20 %, solde sur place.
    await expect(page.getByRole('heading', { name: 'Confirmer la réservation' })).toBeVisible();
    await expect(page.getByText('À payer maintenant (en ligne)')).toBeVisible();
    await expect(page.getByText('À régler sur place')).toBeVisible();
    await page.getByRole('button', { name: PAY_BUTTON }).click();

    // Page de paiement du prestataire (simulée) : aucun argent réel.
    await expect(page).toHaveURL(CHECKOUT);
    await expect(page.getByText('SIMULATION — aucun argent réel')).toBeVisible();
    await page.getByRole('button', { name: 'Payer', exact: true }).click();

    // Retour sur le site : le serveur a vérifié le paiement auprès du prestataire.
    await expect(page).toHaveURL(/\/bookings\/[\w-]+\/payment\?paymentId=/);
    await expect(page.getByText('Paiement reçu : votre réservation est confirmée !')).toBeVisible();

    await page.getByRole('link', { name: 'Détail de la réservation' }).click();
    await expect(page.getByText('Confirmée').first()).toBeVisible();

    // Annulation gratuite (créneau dans 2 jours) : l'acompte est remboursé.
    await page.getByRole('button', { name: 'Annuler la réservation' }).click();
    await expect(page.getByText(/Annulation gratuite jusqu’au/)).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Annuler la réservation' }).click();
    await expect(page.getByText(/Remboursement de .* en cours/)).toBeVisible();
    await expect(page.getByText('Annulée').first()).toBeVisible();
  });

  test('un paiement abandonné laisse la réservation en attente, avec le compte à rebours', async ({
    page,
  }) => {
    await loginAs(page, player(7));
    await page.goto(`/venues/setif-five-stadium?date=${dateIn(3)}`);
    await page
      .getByRole('button', { name: /Libre$/ })
      .nth(2)
      .click();
    await page.getByRole('button', { name: PAY_BUTTON }).click();
    await expect(page).toHaveURL(CHECKOUT);
    await page.getByRole('button', { name: 'Annuler', exact: true }).click(); // « Annuler » sur la page du prestataire

    await expect(page).toHaveURL(/\/bookings\/[\w-]+$/);
    await expect(page.getByText('En attente de paiement').first()).toBeVisible();
    await expect(page.getByText(/Créneau gardé encore \d+:\d{2}/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continuer vers le paiement' })).toBeVisible();
  });

  test('le récapitulatif refuse un créneau passé ou inexistant', async ({ page }) => {
    await loginAs(page, player(8));
    const past = encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString());
    await page.goto(`/book/00000000-0000-4000-8000-000000000000?start=${past}`);
    await expect(page.getByRole('alert')).toBeVisible();
  });
});

test.describe('concurrence', () => {
  test('deux joueurs réservent le MÊME créneau en même temps : un seul l’obtient', async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const a = await contextA.newPage();
    const b = await contextB.newPage();
    try {
      await loginAs(a, player(9));
      await loginAs(b, player(10));

      // A choisit un créneau libre ; B ouvre exactement le même.
      await a.goto(`/venues/blida-foot-zone?date=${dateIn(2)}`);
      await a
        .getByRole('button', { name: /Libre$/ })
        .first()
        .click();
      await expect(a.getByRole('button', { name: PAY_BUTTON })).toBeVisible();
      await b.goto(a.url());
      await expect(b.getByRole('button', { name: PAY_BUTTON })).toBeVisible();

      await Promise.all([
        a.getByRole('button', { name: PAY_BUTTON }).click(),
        b.getByRole('button', { name: PAY_BUTTON }).click(),
      ]);

      const outcome = async (page: typeof a): Promise<'obtenu' | 'refusé'> => {
        const paid = page.waitForURL(CHECKOUT).then(() => 'obtenu' as const);
        const refused = page
          .getByText('Ce créneau vient d’être pris. Choisissez-en un autre.')
          .waitFor()
          .then(() => 'refusé' as const);
        return Promise.race([paid, refused]);
      };
      const results = (await Promise.all([outcome(a), outcome(b)])).sort();
      expect(results).toEqual(['obtenu', 'refusé']);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
