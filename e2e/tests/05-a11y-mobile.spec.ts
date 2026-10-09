import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { dateIn, loginAs, player } from './helpers';

/** Règles WCAG 2.1 A/AA : aucune violation « grave » ou « critique » tolérée sur les pages clés. */
async function expectAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const summary = blocking.map(
    (v) =>
      `${v.id} (${v.nodes.length}) : ${v.help}\n   ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join('\n   ')}`,
  );
  expect(summary, `${label} : violations d’accessibilité`).toEqual([]);
}

const PUBLIC_PAGES = [
  '/',
  '/venues',
  '/venues/stade-five-hydra',
  '/solo',
  '/opponents',
  '/login',
  '/register',
];

test.describe('accessibilité (axe, WCAG AA)', () => {
  for (const path of PUBLIC_PAGES) {
    test(`page publique ${path} en français`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expectAccessible(page, path);
    });
  }

  for (const path of ['/', '/venues/stade-five-hydra', '/login']) {
    test(`page ${path} en arabe (droite-à-gauche)`, async ({ page }) => {
      await page.goto(path);
      await page.evaluate(() => localStorage.setItem('ff.locale', 'ar'));
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await page.waitForLoadState('networkidle');
      await expectAccessible(page, `${path} (ar)`);
    });
  }

  test('pages connectées : réservations, équipes, profil, réservation en cours', async ({
    page,
  }) => {
    await loginAs(page, player(15));
    for (const path of ['/bookings', '/teams', '/profile', '/notifications', '/matches']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expectAccessible(page, path);
    }
    await page.goto(`/venues/stade-five-hydra?date=${dateIn(2)}`);
    await page
      .getByRole('button', { name: /Libre$/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Confirmer la réservation' })).toBeVisible();
    await expectAccessible(page, 'récapitulatif de réservation');
  });

  test('la navigation au clavier atteint le contenu principal via le lien d’évitement', async ({
    page,
  }) => {
    await page.goto('/venues');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Aller au contenu' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#content$/);
  });
});

test.describe('mobile (375 px)', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  for (const path of [
    '/',
    '/venues',
    '/venues/stade-five-hydra',
    '/solo',
    '/opponents',
    '/login',
    '/register',
  ]) {
    test(`${path} : pas de défilement horizontal, barre de navigation basse visible`, async ({
      page,
    }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, 'débordement horizontal (px)').toBeLessThanOrEqual(1);
      await expect(page.getByRole('navigation', { name: 'Menu principal' }).last()).toBeVisible();
    });
  }

  test('les zones tactiles de la barre basse font au moins 44 px', async ({ page }) => {
    await page.goto('/');
    const links = page.getByRole('navigation', { name: 'Menu principal' }).last().getByRole('link');
    const count = await links.count();
    expect(count).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < count; i++) {
      const box = await links.nth(i).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test('la réservation complète fonctionne sur mobile', async ({ page }) => {
    await loginAs(page, player(16));
    await page.goto(`/venues/annaba-five-center?date=${dateIn(2)}`);
    await page
      .getByRole('button', { name: /Libre$/ })
      .first()
      .click();
    await expect(page.getByRole('button', { name: /Payer .* et confirmer/ })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
