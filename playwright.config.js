import { defineConfig } from '@playwright/test';
import { STAFF_STATE } from './e2e/accounts.js';

// E2E rebuilds and runs against its own database and ports, so it never touches the dev servers or demo data.
// Empty Foundry settings keep the tests off the real Claude even when server/.env holds a key.
// Test accounts are created in halcyon_test by e2e/seed-accounts.mjs; tests run signed in as staff (see e2e/global-setup.js).
const env = { PGDATABASE: 'halcyon_test', INBOX_WATCH: '0', ANTHROPIC_FOUNDRY_API_KEY: '', ANTHROPIC_FOUNDRY_RESOURCE: '', REQUIRE_LOGIN: '1' };

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.js',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  // Reduced motion: blocks and charts appear at once, so tests never wait on an animation.
  use: { baseURL: 'http://localhost:5174', storageState: STAFF_STATE, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'bash db/load.sh > /dev/null && node e2e/seed-accounts.mjs && npm --prefix server start', url: 'http://localhost:4100/api/health', env: { ...env, PORT: '4100' }, reuseExistingServer: false },
    { command: 'npm --prefix web run dev -- --port 5174 --strictPort', url: 'http://localhost:5174', env: { API_URL: 'http://localhost:4100' }, reuseExistingServer: false },
  ],
});
