/**
 * Log in once with headless Chromium and save the cookies for the
 * screen-reader project. Credentials come from .env (WP_USERNAME /
 * WP_PASSWORD), with no default. The base URL comes from WP_BASE_URL and
 * defaults to the loopback wp-env site, http://localhost:8888, so an unset
 * URL can never send the password to another machine (PR #36 review).
 */
require('dotenv').config();
const path = require('path');
const { chromium } = require('@playwright/test');
// The plain-HTTP rule is shared with scripts/screenshots.js and the e2e
// login, so all three refuse the same hosts with the same message.
const { assertSafeBaseUrl, assertSafeLoginPage } = require('../../scripts/lib/safe-base-url');

module.exports = async () => {
  const baseURL = process.env.WP_BASE_URL || 'http://localhost:8888';
  const username = process.env.WP_USERNAME;
  const password = process.env.WP_PASSWORD;
  if (!username || !password) {
    throw new Error('Set WP_USERNAME and WP_PASSWORD in .env before running the screen-reader tests.');
  }
  assertSafeBaseUrl(baseURL, 'WP_BASE_URL');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${baseURL}/wp-login.php`);
    // A redirect can move the login page to plain HTTP, and the form can
    // post somewhere else again: check both BEFORE any credential is typed.
    await assertSafeLoginPage(page, 'WP_BASE_URL');
    await page.fill('#user_login', username);
    await page.fill('#user_pass', password);
    // The admin wait is resolved against the login page's OWN URL, not
    // the configured base: after an HTTP→HTTPS redirect the base no longer
    // matches and the wait would time out after a successful login (PR #35
    // review). A subdirectory install keeps its path the same way.
    await Promise.all([
      page.waitForURL(new URL('./wp-admin/**', page.url()).href),
      page.click('#wp-submit'),
    ]);
    await page.context().storageState({ path: path.join(__dirname, 'auth.json') });
  } finally {
    // Always, or a failed login leaves a headless Chromium running until
    // the process exits (PR #35 review).
    await browser.close();
  }
};

