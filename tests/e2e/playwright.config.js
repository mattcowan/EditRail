/**
 * Playwright E2E config for EditRail.
 *
 * Point TOOLRAIL_URL at a WordPress site with the plugin ACTIVE. Admin
 * specs get their
 * session from the `setup` project (tests/e2e/auth.setup.js → gitignored
 * .auth/admin.json). Override credentials with TOOLRAIL_ADMIN_USER /
 * TOOLRAIL_ADMIN_PASS.
 *
 * Every variable can also be set in a `.env` file at the repository root
 * (see `.env.example`); a variable set on the command line wins.
 * The default is the local wp-env site that `npx wp-env start` creates
 * (`.wp-env.json`, port 8888) and that CI uses. It is a loopback address,
 * so the login can never send the password to another machine: a `.local`
 * default can be answered by any device on the network (PR #36 review). The default login is wp-env's own,
 * admin / password.
 */
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const baseURL = process.env.TOOLRAIL_URL || 'http://localhost:8888';

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
