import { defineConfig } from '@playwright/test';

// E2E rebuilds and runs against its own database and ports, so it never touches the dev servers or demo data.
// Empty Foundry settings keep the tests off the real Claude even when server/.env holds a key.
const env = { PGDATABASE: 'halcyon_test', INBOX_WATCH: '0', ANTHROPIC_FOUNDRY_API_KEY: '', ANTHROPIC_FOUNDRY_RESOURCE: '' };
// E2E_API_PORT / E2E_WEB_PORT move the test servers when the defaults are taken (e.g. a second dev server).
const API_PORT = process.env.E2E_API_PORT || '4100';
const WEB_PORT = process.env.E2E_WEB_PORT || '5174';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  // Reduced motion: blocks and charts appear at once, so tests never wait on an animation.
  use: { baseURL: `http://localhost:${WEB_PORT}`, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'bash db/load.sh > /dev/null && npm --prefix server start', url: `http://localhost:${API_PORT}/api/health`, env: { ...env, PORT: API_PORT }, reuseExistingServer: false },
    { command: `npm --prefix web run dev -- --port ${WEB_PORT} --strictPort`, url: `http://localhost:${WEB_PORT}`, env: { API_URL: `http://localhost:${API_PORT}` }, reuseExistingServer: false },
  ],
});
