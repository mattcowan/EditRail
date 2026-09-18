/**
 * Log in once with headless Chromium and save the cookies for the
 * screen-reader project. Credentials come from .env (WP_USERNAME /
 * WP_PASSWORD); the base URL defaults to the mnc4 Local site.
 */
require('dotenv').config();
const path = require('path');
const { chromium } = require('@playwright/test');

/**
 * Is this a host where plain HTTP is acceptable for a login?
 *
 * Local development sites: loopback, private IPv4 ranges, dotless hostnames
 * (`editrail:8080`, `host.docker.internal` is covered by the
 * suffix list), and the usual local TLDs. Anything else looks public and
 * must use HTTPS, because the login posts the password.
 * `WP_ALLOW_HTTP=1` overrides for the odd intranet host.
 */
function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)) return true;
  if (!h.includes('.')) return true; // dotless intranet / hosts-file name
  return /\.(local|test|localhost|internal|lan|home|example)$/.test(h);
}

function assertSafeBaseUrl(baseURL) {
  const url = new URL(baseURL);
  if (url.protocol === 'http:' && !isLocalHost(url.hostname) && process.env.WP_ALLOW_HTTP !== '1') {
    throw new Error(`WP_BASE_URL uses plain HTTP for a non-local host (${url.hostname}). Use https:// for remote sites, or set WP_ALLOW_HTTP=1 for a trusted intranet host.`);
  }
}

module.exports = async () => {
  const baseURL = process.env.WP_BASE_URL || 'http://mnc4.local';
  const username = process.env.WP_USERNAME;
  const password = process.env.WP_PASSWORD;
  if (!username || !password) {
    throw new Error('Set WP_USERNAME and WP_PASSWORD in .env before running the screen-reader tests.');
  }
  assertSafeBaseUrl(baseURL);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${baseURL}/wp-login.php`);
    // The base URL was checked above, but a redirect can move the login
    // page to plain HTTP, and the form can post somewhere else again. Both
    // destinations get the same check BEFORE any credential is typed
    // (PR #35 review): a password must not travel over HTTP to a public
    // host.
    assertSafeBaseUrl(page.url());
    const action = await page.locator('#loginform').getAttribute('action');
    assertSafeBaseUrl(new URL(action || page.url(), page.url()).href);
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

module.exports.isLocalHost = isLocalHost;
module.exports.assertSafeBaseUrl = assertSafeBaseUrl;
