import { defineConfig, devices } from '@playwright/test';

const API_PORT = process.env['E2E_API_PORT'] ?? '3100';
const WEB_PORT = process.env['E2E_WEB_PORT'] ?? '5174';
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;

/**
 * Tests de bout en bout dans un VRAI navigateur, contre l'API compilée et une base dédiée (remise à zéro à chaque lancement).
 * Navigateur : le Chromium de Playwright (CI : `playwright install chromium`) ou, en local, un navigateur déjà installé
 * (`PLAYWRIGHT_CHANNEL=msedge` ou `chrome`) — rien à télécharger.
 */
export default defineConfig({
  testDir: './tests',
  // Les tests partagent une base : exécution séquentielle, chaque test choisit ses propres comptes et créneaux.
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: WEB_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'fr-FR',
    timezoneId: 'Africa/Algiers',
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        channel: process.env['PLAYWRIGHT_CHANNEL'] || undefined,
      },
    },
  ],
  webServer: [
    {
      command: 'node e2e/scripts/start-api.mjs',
      cwd: '..',
      url: `http://localhost:${API_PORT}/api/v1/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `pnpm --filter @footfive/web exec vite --port ${WEB_PORT} --strictPort`,
      cwd: '..',
      url: WEB_ORIGIN,
      timeout: 120_000,
      reuseExistingServer: !process.env['CI'],
      env: { API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
