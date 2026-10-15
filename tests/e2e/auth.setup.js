/**
 * Authenticated session setup: produce
 * .auth/admin.json once per run; every browser project depends on it. A bad
 * login fails HERE, loudly, instead of as confusing downstream failures.
 */
const { test: setup, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { assertSafeBaseUrl, assertSafeLoginPage } = require('../../scripts/lib/safe-base-url');
const { snapshotRailPrefs, turnOffWelcomeGuide } = require('./prefs-account');

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
  // wp-login.php focuses and selects the username field 200 ms after load
  // (wp_attempt_focus). A fill that straddled that timer typed the
  // password into the username field, and the login failed (PR #69 CI,
  // Firefox; also seen locally in WebKit). So let the timer run first
  // (a site can turn it off, hence the short, optional wait), then fill,
  // and check both fields before the submit. The check compares in the
  // page, so the password never appears in a failure message. A retry is
  // safe: fill replaces a field's text, it never adds to it.
  await page.waitForFunction(
    () => document.activeElement && document.activeElement.id === 'user_login',
    null,
    { timeout: 2000 }
  ).catch(() => {});
  await expect(async () => {
    await page.fill('#user_login', USER);
    await page.fill('#user_pass', PASS);
    expect(await page.evaluate(([u, p]) =>
      document.getElementById('user_login').value === u
        && document.getElementById('user_pass').value === p,
    [USER, PASS]), 'both login fields hold what was typed').toBe(true);
  }).toPass({ timeout: 10000 });
  await page.click('#wp-submit');

  await page.waitForURL(/wp-admin/, { timeout: 15000 });
  await expect(page.locator('#wpadminbar')).toBeVisible();

  // Every browser project reuses this login. WebKit saves WordPress's
  // cookies as sameSite "None" without "secure", and Chromium refuses that
  // pair, so a run that listed webkit before chromium logged Chromium out.
  // WordPress sets no SameSite, which browsers treat as Lax; save that.
  const state = await page.context().storageState();
  state.cookies.forEach((cookie) => {
    if (cookie.sameSite === 'None' && !cookie.secure) {
      cookie.sameSite = 'Lax';
    }
  });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2));

  // Save the account's own rail settings before any test changes them;
  // global-teardown.js puts them back at the end of the run. This setup runs
  // in a worker, so the runner that owns the run (and runs the teardown) is
  // the worker's parent process.
  await snapshotRailPrefs(setup.info().project.use.baseURL, AUTH_FILE, process.ppid, '[editrail e2e]');

  // After the snapshot, which is also the run lock: no test should meet
  // core's welcome guide. See turnOffWelcomeGuide() for why a guide closed
  // just before a hover broke the between-block "+" test in CI.
  await turnOffWelcomeGuide(setup.info().project.use.baseURL, AUTH_FILE);
});
