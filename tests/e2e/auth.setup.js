/**
 * Authenticated session setup: produce
 * .auth/admin.json once per run; the chromium project depends on it. A bad
 * login fails HERE, loudly, instead of as confusing downstream failures.
 */
const { test: setup, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { assertSafeBaseUrl, assertSafeLoginPage } = require('../../scripts/lib/safe-base-url');

const AUTH_FILE = path.join(__dirname, '.auth', 'admin.json');
const USER = process.env.TOOLRAIL_ADMIN_USER || 'admin';
// wp-env's default admin password, to match the default site in
// playwright.config.js. Set TOOLRAIL_ADMIN_PASS (or .env) for any other site.
const PASS = process.env.TOOLRAIL_ADMIN_PASS || 'password';

setup('authenticate as admin', async ({ page }) => {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });

  // Plain HTTP to a non-local host would send PASS in clear text: stop
  // first, then check again after any redirect (PR #36 review).
  assertSafeBaseUrl(setup.info().project.use.baseURL, 'TOOLRAIL_URL');
  await page.goto('/wp-login.php');
  await assertSafeLoginPage(page, 'TOOLRAIL_URL');
  await page.fill('#user_login', USER);
  await page.fill('#user_pass', PASS);
  await page.click('#wp-submit');

  await page.waitForURL(/wp-admin/, { timeout: 15000 });
  await expect(page.locator('#wpadminbar')).toBeVisible();

  await page.context().storageState({ path: AUTH_FILE });
});
