/**
 * Where a login may send the admin password.
 *
 * Shared by every script and test setup that logs in to WordPress with a
 * password: scripts/screenshots.js, tests/e2e/auth.setup.js and
 * tests/e2e-sr/global-setup.js. Each one refuses to type the password when
 * the login would travel over plain HTTP to a host that is not local
 * (PR #36 review). Local development hosts are allowed over HTTP; anything
 * that looks public must use HTTPS. WP_ALLOW_HTTP=1 overrides the check for
 * a trusted intranet host that has no certificate.
 *
 * Moved here from tests/e2e-sr/global-setup.js, which had the only copy, so
 * all three logins share one rule and one message.
 */

/**
 * Is this a host where plain HTTP is acceptable for a login?
 *
 * Local development sites: loopback, private IPv4 ranges, dotless hostnames
 * (`editrail:8080`; `host.docker.internal` is covered by the suffix list),
 * and the usual local TLDs.
 *
 * @param {string} hostname A URL's hostname.
 * @return {boolean} True for a local development host.
 */
function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)) return true;
  if (!h.includes('.')) return true; // dotless intranet / hosts-file name
  return /\.(local|test|localhost|internal|lan|home|example)$/.test(h);
}

/**
 * Throw when a login to this URL would send the password over plain HTTP
 * to a host that is not local.
 *
 * @param {string} url   Absolute URL: the configured base, the login page, or the form target.
 * @param {string} label The variable that set it, for the message (for example 'TOOLRAIL_URL').
 * @return {void}
 */
function assertSafeBaseUrl(url, label) {
  const parsed = new URL(url);
  if (parsed.protocol === 'http:' && !isLocalHost(parsed.hostname) && process.env.WP_ALLOW_HTTP !== '1') {
    throw new Error(`${label || 'The site URL'} uses plain HTTP for a non-local host (${parsed.hostname}). Use https:// for remote sites, or set WP_ALLOW_HTTP=1 for a trusted intranet host.`);
  }
}

/**
 * Check the login page as loaded, before any credential is typed.
 *
 * The configured base was checked already, but a redirect can move the login
 * page to plain HTTP, and the form can post somewhere else again. Both get
 * the same check (PR #35 review).
 *
 * @param {import('@playwright/test').Page} page  Page on wp-login.php.
 * @param {string}                          label As for assertSafeBaseUrl.
 * @return {Promise<void>}
 */
async function assertSafeLoginPage(page, label) {
  assertSafeBaseUrl(page.url(), label);
  const action = await page.locator('#loginform').getAttribute('action');
  assertSafeBaseUrl(new URL(action || page.url(), page.url()).href, label);
}

module.exports = { isLocalHost, assertSafeBaseUrl, assertSafeLoginPage };
