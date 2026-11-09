/**
 * EditRail — account persistence spec.
 *
 * Account persistence: the rail settings in the account, a store that
 * fails, a late attach of the account, and local copies in a browser.
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const {
  AUTH,
  openNewPost,
  waitForSavedPref,
  savedDock,
  getPref,
} = require('./helpers');

test.use({ storageState: AUTH });

/**
 * Regressions found by driving the editor by hand (2026-08-26). Each test
 * here failed before its fix; the block-count assertions in
 * 'armed-tool insertion' were tightened in the same pass, because the
 * originals could not see the stray-block bug at all.
 */
test.describe('regressions', () => {
  test('unpinning actually sticks when the account store write throws', async ({ page }) => {
    await openNewPost(page);

    // The account store's own persistence layer writes its localStorage
    // cache SYNCHRONOUSLY inside disp.set() (quota hit, private mode) —
    // that throw must not be swallowed as if the write had landed.
    await page.evaluate(() => {
      window.Storage.prototype.setItem = function () {
        throw new Error('QuotaExceededError');
      };
    });

    await page.evaluate(() => window.toolrail.unpinBlock('core/heading'));

    await expect(page.locator('#toolrail-rail [data-tool="pin:core/heading"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.toolrail.isPinned('core/heading'))).toBe(false);

    // A key that never failed to write must keep reading from the store
    // as normal — one broken key must not orphan every other key.
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/image"]')).toHaveCount(1);
  });

  test('boot migration self-heals if the account attach lands late and wipes it', async ({ page }) => {
    await openNewPost(page);
    await expect(page.locator('#toolrail-rail [data-tool^="pin:"]')).toHaveCount(4);

    // Simulate the real WordPress attach (SET_PERSISTENCE_LAYER) landing
    // AFTER boot()'s migration has already written — core replaces the
    // WHOLE core/preferences state wholesale when this fires, which is
    // exactly what can wipe an early write. A no-op set() keeps this
    // synthetic layer from touching the real account.
    await page.evaluate(() => window.wp.data.dispatch('core/preferences').setPersistenceLayer({
      get: () => Promise.resolve({}),
      set: () => {},
    }));

    // No reload: the watcher must catch the wipe from this same dispatch
    // and repair it live.
    await expect(page.locator('#toolrail-rail [data-tool^="pin:"]')).toHaveCount(4, { timeout: 5000 });
    expect(await getPref(page, 'toolrail-slots-migrated')).toBe('1');
  });

  test('a late attach is still repaired after other preference changes came first', async ({ page }) => {
    await openNewPost(page);
    await expect(page.locator('#toolrail-rail [data-tool^="pin:"]')).toHaveCount(4);

    // On a fresh account, core/preferences takes other changes while its
    // attach still awaits a REST fetch. The stamps survive those, and the
    // watcher used to stop there; the attach then wiped the store unseen,
    // under a rail still showing four pins (PR #69, 2026-10-15). A
    // test-only key stands in for those changes (never restored to the
    // account; see TEST_ONLY_KEY).
    await page.evaluate(() => {
      window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-ext:e2e:unrelated', '1');
    });
    expect(await getPref(page, 'toolrail-slots-migrated')).toBe('1');

    // Now the attach lands, as in the test above.
    await page.evaluate(() => window.wp.data.dispatch('core/preferences').setPersistenceLayer({
      get: () => Promise.resolve({}),
      set: () => {},
    }));

    // Repaired in the STORE, not only on screen: the pins and both stamps
    // read back, so a pin change now acts on the real list.
    await expect.poll(() => getPref(page, 'toolrail-slots-migrated'), { timeout: 5000 }).toBe('1');
    expect(await getPref(page, 'toolrail-group-seeded')).toBe('1');
    expect(JSON.parse(await getPref(page, 'toolrail-quick-slots'))).toEqual([
      'core/group', 'core/paragraph', 'core/heading', 'core/image',
    ]);
    await expect(page.locator('#toolrail-rail [data-tool^="pin:"]')).toHaveCount(4);
  });

  test('a second browser\'s real position is not blocked by an earlier empty-handed migration pass', async ({ page }) => {
    await openNewPost(page); // "browser A": nothing local, migration already ran once

    // "browser B": local position from before this account ever had one.
    // A global migration stamp previously blocked this from ever being
    // lifted once ANY browser — even one with nothing to migrate — had
    // already booted once.
    await page.evaluate(() => {
      window.localStorage.setItem('toolrail-position', JSON.stringify({ dock: 'right', x: 40, y: 60 }));
    });
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });

    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'right');
    const lifted = JSON.parse(await getPref(page, 'toolrail-position'));
    expect(lifted).toEqual({ dock: 'right', x: 40, y: 60 });
  });

  test('a browser\'s stale local copy is dropped once the account holds the key', async ({ page }) => {
    test.slow(); // three editor loads on a slow site
    await openNewPost(page);
    // Give the account a position of its own (boot only READS one; a
    // fresh account has no key, and the lift would rightly win). Then a
    // leftover local copy that disagrees must neither win nor linger: it
    // is the thing that resurrected old pins after a delete + reinstall,
    // and WHICH pins depended on which browser booted first.
    await page.evaluate(() => window.toolrail.setDock('left'));
    await waitForSavedPref(page, 'toolrail-position', (v) => savedDock(v) === 'left');
    await page.evaluate(() => {
      window.localStorage.setItem('toolrail-position', JSON.stringify({ dock: 'right', x: 40, y: 60 }));
      window.localStorage.setItem('toolrail-quick-slots', JSON.stringify(['core/cover']));
    });
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });

    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'left');
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/cover"]')).toHaveCount(0);
    const local = await page.evaluate(() => ({
      position: window.localStorage.getItem('toolrail-position'),
      slots: window.localStorage.getItem('toolrail-quick-slots'),
    }));
    expect(local).toEqual({ position: null, slots: null });
  });

  test('a lifted local copy survives one boot, then is consumed', async ({ page }) => {
    test.slow(); // three editor loads on a slow site
    await openNewPost(page);
    // Account empty of the key, local copy present: the lift keeps the
    // source, because boot's own write can still be wiped by a late
    // attach and the next boot has to lift from it again. The boot after
    // that reads the key back from the account and drops the copy.
    await page.evaluate(() => {
      window.localStorage.setItem('toolrail-position', JSON.stringify({ dock: 'right', x: 40, y: 60 }));
      window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-position', undefined);
    });
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'right');
    expect(await page.evaluate(() => window.localStorage.getItem('toolrail-position'))).not.toBeNull();

    // Let the account write land, then boot against the hydrated account.
    await waitForSavedPref(page, 'toolrail-position', (v) => savedDock(v) === 'right');
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'right');
    expect(await page.evaluate(() => window.localStorage.getItem('toolrail-position'))).toBeNull();
    expect(JSON.parse(await getPref(page, 'toolrail-position'))).toEqual({ dock: 'right', x: 40, y: 60 });
  });
});

test.describe('account persistence', () => {
  test('position and pins follow the account into a fresh browser profile', async ({ page, browser }) => {
    test.slow(); // two browser contexts on a slow site
    await openNewPost(page);

    await page.evaluate(() => window.toolrail.pinBlock('core/quote'));
    await page.evaluate(() => window.toolrail.setDock('bottom'));

    // The preferences store persists to user meta on a debounce: wait for
    // the server copy before the fresh profile loads from it.
    await waitForSavedPref(page, 'toolrail-position', (v) => savedDock(v) === 'bottom');
    await waitForSavedPref(page, 'toolrail-quick-slots', (v) => !!v && JSON.parse(v).indexOf('core/quote') !== -1);

    // Same login, EMPTY localStorage: everything the fresh profile shows
    // came from the account, which is the whole point of the feature.
    const ctx = await browser.newContext({ storageState: AUTH });
    const fresh = await ctx.newPage();
    await fresh.goto(new URL('/wp-admin/post-new.php', page.url()).href);

    // Prove the precondition this test actually rests on, rather than
    // assuming it: a fresh profile has no local copy of preferences to
    // fall back on, so whatever shows up next can only have come from
    // the account. AUTH is captured by auth.setup.js, which only visits
    // wp-login.php and wp-admin — never the editor — so this should
    // always be empty; check it instead of trusting that.
    const localPrefsKeys = await fresh.evaluate(() =>
      Object.keys(window.localStorage).filter((k) => k.startsWith('WP_PREFERENCES_USER_'))
    );
    expect(localPrefsKeys).toEqual([]);

    await expect(fresh.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });

    await expect(fresh.locator('#toolrail-region')).toHaveAttribute('data-dock', 'bottom');
    await expect(fresh.locator('#toolrail-rail [data-tool="pin:core/quote"]')).toBeVisible();

    await ctx.close();
  });
});
