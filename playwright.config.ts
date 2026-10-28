// MyMochis · Playwright config — E2E de la landing y el panel (spec_id=31 V1).
//
// El E2E arranca el server real en un puerto propio con una DB temporal, asi
// que no toca la DB de desarrollo. Los 3 viewports del proyecto son el
// contrato de responsive: 375 (movil pequeno, 90% del trafico), 768
// (tablet) y 1440 (desktop).
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 4210);
export const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'movil-375',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, isMobile: false },
    },
    {
      name: 'tablet-768',
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'desktop-1440',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: 'node e2e/server.mjs',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      E2E_PORT: String(PORT),
    },
  },
});
