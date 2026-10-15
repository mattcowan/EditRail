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
 * so with no URL set the login sends the password only to this machine; a
 * `.local` default could be answered by any device on the network (PR #36
 * review). A URL set in `.env` or on the command line receives the
 * password too: point it only at a site you trust. Plain http:// to a host
 * that is not local stops the login before the password is typed
 * (scripts/lib/safe-base-url.js); WP_ALLOW_HTTP=1 allows a trusted
 * intranet host. The default login is wp-env's own,
 * admin / password.
 */
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const baseURL = process.env.TOOLRAIL_URL || 'http://localhost:8888';

/**
 * The browsers a run uses, from TOOLRAIL_BROWSERS: a comma-separated list
 * of chromium, firefox and webkit. The default is chromium alone, so a
 * plain local run does not take three times as long. CI runs one job per
 * browser and sets this to that browser (#42).
 */
const BROWSER_DEVICES = { chromium: 'Desktop Chrome', firefox: 'Desktop Firefox', webkit: 'Desktop Safari' };
const browsers = (process.env.TOOLRAIL_BROWSERS || 'chromium')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);
browsers.forEach((name) => {
  if (!BROWSER_DEVICES[name]) {
    throw new Error(`TOOLRAIL_BROWSERS: "${name}" is not chromium, firefox or webkit.`);
  }
});
if (!browsers.length) {
  throw new Error('TOOLRAIL_BROWSERS names no browser. Use chromium, firefox or webkit.');
}

module.exports = defineConfig({
  testDir: '.',
  // Restores the developer's own rail settings once, after every test
  // (auth.setup.js saved them). See prefs-account.js.
  globalTeardown: require.resolve('./global-teardown.js'),
  // One test at a time, always. Every test writes the same account's rail
  // settings, so two at once change each other's state. CI passes
  // --fully-parallel only so that --shard can split this one spec file by
  // test; each shard is its own job with its own wp-env site.
  workers: 1,
  timeout: 30000,
  retries: 0,
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    // retries is 0, so 'on-first-retry' never recorded a trace. In CI,
    // keep one for every failed test: the "Upload Playwright output on
    // failure" step uploads test-results/, and a CI-only failure can then
    // be replayed step by step (npx playwright show-trace).
    trace: process.env.CI ? 'retain-on-failure' : 'on-first-retry',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.js/,
      // The saved login works in every browser. It runs in the first
      // browser listed, so a CI job installs only its own browser.
      use: { browserName: browsers[0] },
    },
    ...browsers.map((name) => ({
      name,
      use: { ...devices[BROWSER_DEVICES[name]] },
      dependencies: ['setup'],
    })),
  ],
});

module.exports.AUTH_FILE = path.join(__dirname, '.auth', 'admin.json');
