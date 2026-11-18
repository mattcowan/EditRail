/**
 * EditRail — end-of-test save spec.
 *
 * The suite's own `test` (helpers.js) ends each test only once the account
 * holds the page's last preference save (#113). These tests check the wait
 * that it runs, waitForAccountSaves().
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const {
  test,
  expect,
  AUTH,
  openNewPost,
  waitForAccountSaves,
} = require('./helpers');
const { apiForPage, readPrefs } = require('./prefs-account');

test.use({ storageState: AUTH });

/** A preference save to the account: core sends it to users/me. */
const isPrefsWrite = (url) => url.searchParams.get('rest_route') === '/wp/v2/users/me'
  || /\/wp-json\/wp\/v2\/users\/me\/?$/.test(url.pathname);

test.describe('end-of-test save wait (#113)', () => {
  test('the wait holds until a save that reaches the account late has landed', async ({ page }) => {
    // An empty account, so the rail's boot saves (its first-boot seed): the
    // wait must also hold for a save the test itself did not make.
    await openNewPost(page, { emptyAccount: true });
    // Those boot saves land first, so only the save below is late.
    const boot = await waitForAccountSaves([page.context()], 20000);
    expect(boot.pending).toEqual([]);
    expect(boot.restReads).toBeGreaterThan(0);
    // The suite's `test` is in use here: its init script ran in this page.
    expect(await page.evaluate(() => typeof window.__editrailE2EPrefsStampsAtLoad)).toBe('object');

    // A slow server: the page gets its answer at once, and the save reaches
    // the account 3 s later, sent from the test with the page's nonce.
    const late = page.request;
    let applied = Promise.resolve();
    let appliedAt = 0;
    let applyError = null;
    await page.route(isPrefsWrite, async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        await route.continue();
        return;
      }
      const sent = req.headers();
      const headers = {};
      ['x-wp-nonce', 'content-type', 'x-http-method-override'].forEach((name) => {
        if (sent[name]) {
          headers[name] = sent[name];
        }
      });
      const call = { url: req.url(), method: req.method(), headers, data: req.postData() };
      applied = applied
        .then(() => new Promise((r) => setTimeout(r, 3000)))
        .then(() => late.fetch(call.url, { method: call.method, headers: call.headers, data: call.data }))
        .then((response) => {
          // A refused write must fail HERE, with its status, not later as a
          // missing key (PR #122 review).
          if (!response.ok()) {
            throw new Error(`the late save was refused: HTTP ${response.status()}`);
          }
          appliedAt = Date.now();
        })
        .catch((error) => { applyError = error; });
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    try {
      await page.evaluate(() => window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-ext:e2e:late-save', '1'));
      const result = await waitForAccountSaves([page.context()], 20000);
      const returnedAt = Date.now();

      expect(applyError, 'the late save reached the server').toBeNull();
      expect(result.pending).toEqual([]);
      // It returned only after the late save was on the server.
      expect(appliedAt).toBeGreaterThan(0);
      expect(returnedAt).toBeGreaterThanOrEqual(appliedAt);
      const scope = (await readPrefs(await apiForPage(page))).toolrail || {};
      expect(scope['toolrail-ext:e2e:late-save']).toBe('1');
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await applied.catch(() => {});
    }
  });

  test('a document that saved nothing, or that left the editor, needs no read of the account', async ({ page }) => {
    // openNewPost() starts from BASELINE, the state the rail's boot writes,
    // so the boot saves nothing and a test that writes no preference is
    // not held at its end (#113). It once started from an empty account,
    // and every test waited for the boot's re-seed save.
    await openNewPost(page);
    expect(await waitForAccountSaves([page.context()], 20000)).toMatchObject({ restReads: 0, pending: [] });

    // A plain reload: the rail boots on the saved account and writes nothing.
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    expect(await waitForAccountSaves([page.context()], 20000)).toMatchObject({ restReads: 0, pending: [] });

    // A page that is no longer the editor.
    await page.goto('/wp-admin/index.php');
    expect(await waitForAccountSaves([page.context()], 20000)).toMatchObject({ restReads: 0, pending: [] });
  });
});
