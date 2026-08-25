/**
 * Authenticated session setup (the Background Candy pattern): produce
 * .auth/admin.json once per run; the chromium project depends on it. A bad
 * login fails HERE, loudly, instead of as confusing downstream failures.
 */
const { test: setup, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const AUTH_FILE = path.join(__dirname, '.auth', 'admin.json');
const USER = process.env.TOOLRAIL_ADMIN_USER || process.env.BGCANDY_ADMIN_USER || 'admin';
const PASS = process.env.TOOLRAIL_ADMIN_PASS || process.env.BGCANDY_ADMIN_PASS || 'pass';

setup('authenticate as admin', async ({ page }) => {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });

  await page.goto('/wp-login.php');
  await page.fill('#user_login', USER);
  await page.fill('#user_pass', PASS);
  await page.click('#wp-submit');

  await page.waitForURL(/wp-admin/, { timeout: 15000 });
  await expect(page.locator('#wpadminbar')).toBeVisible();

  await page.context().storageState({ path: AUTH_FILE });
});
