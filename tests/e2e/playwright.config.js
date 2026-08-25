/**
 * Playwright E2E config for Editor Tool Rail.
 *
 * Set TOOLRAIL_URL to a local WordPress site with the plugin ACTIVE
 * (BGCANDY_URL is honored as a fallback so this suite slots into the same
 * environment as the Background Candy theme's). Admin specs get their
 * session from the `setup` project (tests/e2e/auth.setup.js → gitignored
 * .auth/admin.json). Override credentials with TOOLRAIL_ADMIN_USER /
 * TOOLRAIL_ADMIN_PASS.
 */
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

const baseURL = process.env.TOOLRAIL_URL || process.env.BGCANDY_URL || 'http://mnc4.local';

module.exports = defineConfig({
  testDir: '.',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.js/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
});

module.exports.AUTH_FILE = path.join(__dirname, '.auth', 'admin.json');
