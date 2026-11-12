/**
 * EditRail — shared helpers for the client behavior specs (*.spec.js in
 * this folder). Each helper is here once; a helper that only one spec
 * file uses lives in that file.
 *
 * Everything runs on post-new.php and NEVER saves: armed insertion only
 * touches the unsaved editor state, so no sandbox seeding is needed and the
 * site's content is never written. (A sandbox post is for specs that
 * SAVE; these must not.)
 *
 * Requires the plugin ACTIVE on the target site (TOOLRAIL_URL).
 */
const { expect } = require('@playwright/test');
const path = require('path');
const { setRailScope, apiForPage, readPrefs } = require('./prefs-account');

const AUTH = path.join(__dirname, '.auth', 'admin.json');

/**
 * Every rail preference this suite is allowed to write, in both stores.
 *
 * `toolrail-help-seen` is the retired first-run stamp (the auto-open
 * went in 0.1.22); clearing it tidies an account that still carries it.
 */
const RAIL_PREF_KEYS = [
  'toolrail-help-seen',
  'toolrail-position',
  'toolrail-quick-slots',
  'toolrail-slot-configs',
  'toolrail-slots-migrated',
  'toolrail-help-hidden',
  'toolrail-wide',
  'toolrail-wide-toggle',
  'toolrail-appearance',
  'toolrail-group-seeded',
  'toolrail-hide-core-inserter',
  'toolrail-pin-meta',
  'toolrail-set-meta',
  'toolrail-sidebar-width',
  'toolrail-sidebar-resize',
  'toolrail-sets-button-hidden',
];

/**
 * Return the rail's stored state to a fresh-install baseline, in the page
 * currently loaded.
 *
 * Dock, pins and saved sets are per-user preferences — since the
 * account-persistence change they live in the core/preferences store
 * (synced to user meta), with localStorage as the migration source and
 * fallback. Clear BOTH, or a spec's changes leak into every later spec
 * through the shared admin account. Clearing also restores the DEFAULT
 * pinned slots (Group/Text/Heading/Image), which several tests rely on.
 *
 * The account is cleared on the SERVER and confirmed there
 * (prefs-account.js setRailScope), never through this page's store: the
 * caller reloads next, and a reload cancels the trailing half of core's
 * debounced save. The developer's own settings are not lost: auth.setup.js
 * saved them, and global-teardown.js restores them after the run.
 *
 * The slot-migration stamp MUST be cleared with the rest: it stops the
 * one-time slot migration from re-running, which is what seeds the
 * defaults — leave it set with the data wiped and the rail comes back
 * empty instead of default. (The local-to-account lift has no stamp of
 * its own — it's a per-key check against the account, safe to re-run.)
 *
 * @param {import('@playwright/test').Page} page Page with the editor loaded.
 * @return {Promise<boolean>} Whether anything was actually stored.
 */
async function resetRailPrefs(page) {
  const localHad = await page.evaluate((keys) => {
    let had = false;
    keys.forEach((k) => {
      if (window.localStorage.getItem(k) !== null) {
        had = true;
      }
      window.localStorage.removeItem(k);
    });
    return had;
  }, RAIL_PREF_KEYS);
  // The account on the SERVER, confirmed, and the page's store left alone:
  // a store change here would schedule core's debounced save, and the
  // reload that follows would cancel its trailing half, leaving a partial
  // state in the account (prefs-account.js has the whole story).
  const serverHad = await setRailScope(page, {});
  return localHad || serverHad;
}

/*
 * The account is put back once per RUN, not per file: auth.setup.js saves
 * the developer's own rail settings right after login, and
 * global-teardown.js restores them after every test has finished, confirmed
 * against the server. The per-file teardown this replaces wrote a fixed
 * baseline through the page's store and trusted a 3 s wait before a reload.
 * Core's debounced save lost the trailing write on this slow site, so the
 * baseline never reached the database, and its "4 pins after reload" check
 * passed anyway because an empty account reseeds its pins on screen. It also
 * replaced the developer's own pins with the defaults (2026-09-24).
 */

async function openNewPost(page) {
  await page.goto('/wp-admin/post-new.php');

  const hadState = await resetRailPrefs(page);
  if (hadState) {
    await page.reload();
  }

  await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });

  // Dismiss core's welcome guide, but wait for it only when the account
  // will show it. Closing it once saves that choice in the account, so on
  // every later load a blind 4 s wait found nothing: about 4 s on each of
  // ~200 loads, close to half of the CI run (measured on wp-env,
  // 2026-10-14). The rail is up, so the stores have loaded. WordPress 7.1
  // keeps the guide in `core/edit-post` (edit-post.js); `core` is read too
  // in case a later release moves it.
  const guideDue = await page.evaluate(() => {
    const prefs = window.wp.data.select('core/preferences');
    return prefs.get('core', 'welcomeGuide') === true || prefs.get('core/edit-post', 'welcomeGuide') === true;
  });
  if (guideDue) {
    const closeModal = page.locator('.components-modal__header button[aria-label="Close"]');
    try {
      await closeModal.waitFor({ state: 'visible', timeout: 4000 });
      await closeModal.click();
    } catch (e) {
      /* No modal — fine. */
    }
  }

  // Give the pattern catalog up to 4 s to arrive, then go on regardless.
  // Its first arrival rebuilds an open settings dialog once, by design,
  // which moves focus to its search field. The old 4 s guide wait gave it
  // that time; without any wait, a test that opened the dialog early saw
  // the rebuild (an idle-dialog check counted 68 mutations, 2026-10-14).
  // It usually lands in ~1.5 s. It is NOT a hard wait: the patterns
  // endpoint can call the WordPress.org pattern directory from the
  // server, and a stall there must not fail every test. Tests that need
  // the catalog call waitForPatternCatalog() themselves.
  await page.waitForFunction(() => {
    const sel = window.wp.data.select('core');
    return sel.hasFinishedResolution('getBlockPatterns', [])
      && sel.hasFinishedResolution('getEntityRecords', ['postType', 'wp_block', { per_page: -1, context: 'edit' }]);
  }, null, { timeout: 4000 }).catch(() => {});
}

function canvas(page) {
  return page.frameLocator('iframe[name="editor-canvas"]');
}

/**
 * Click the canvas in the EMPTY space below everything already laid out
 * (title and blocks), measured live — never at a fixed pixel. Fixed
 * coordinates encode one theme's layout: y=400 was empty space under
 * one theme's title on the test site and landed ON the title/first
 * block under the default theme on wp-env (CI, 2026-08-28), where a
 * second click after an insert also hit the block just inserted.
 * `gap` is the distance below the lowest edge; `modifiers` pass through.
 */
async function clickBelowContent(page, opts) {
  const gap = (opts && opts.gap) || 80;
  const y = await canvas(page).locator('body').evaluate((body, g) => {
    let bottom = 0;
    body
      .querySelectorAll('.editor-post-title, .editor-post-title__input, .is-root-container > [data-block]')
      .forEach((el) => {
        bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
      });
    // Body-relative, clamped inside the iframe's viewport so the click
    // never needs a scroll that would move the measured edges.
    const inBody = bottom - body.getBoundingClientRect().top + g;
    return Math.min(inBody, body.ownerDocument.documentElement.clientHeight - 20);
  }, gap);
  await canvas(page).locator('body').click({
    position: { x: 300, y: Math.round(y) },
    modifiers: (opts && opts.modifiers) || [],
  });
}

/** Read one rail preference from the core/preferences store (null = unset). */
/**
 * Wait until both pattern-catalog resolutions have finished. The rail
 * counts a pattern slot as missing only after this point (before it,
 * "not found" means "not fetched yet"), so a test that asserts a
 * missing count straight after openNewPost — which waits only for the
 * rail — would read 0 on a slow fetch (PR review 2026-09-03).
 */
async function waitForPatternCatalog(page) {
  await expect.poll(async () => page.evaluate(() => {
    const sel = window.wp.data.select('core');
    return sel.hasFinishedResolution('getBlockPatterns', [])
      && sel.hasFinishedResolution('getEntityRecords', ['postType', 'wp_block', { per_page: -1, context: 'edit' }]);
  }), { timeout: 15000 }).toBe(true);
}

/**
 * Wait until the SERVER copy of a rail key passes `check`.
 *
 * Replaces fixed waits before a reload or a second browser. Core saves
 * preferences on a debounce (the first change at once, later ones 2.5 s
 * after that request finishes), so how long a save takes depends on the
 * server and on what else the page saved before. A fixed 3 s wait passed
 * only while the old store-based reset happened to keep that debounce busy
 * (2026-09-24); see prefs-account.js.
 *
 * @param {import('@playwright/test').Page} page  A page on the test site.
 * @param {string}                          key   A toolrail preference key.
 * @param {function(?string): boolean}      check Passes on the saved value (null = absent).
 * @return {Promise<void>}
 */
async function waitForSavedPref(page, key, check) {
  const api = await apiForPage(page);
  await expect.poll(async () => {
    const scope = (await readPrefs(api)).toolrail || {};
    return check(scope[key] === undefined ? null : scope[key]);
  }, { timeout: 20000, message: 'server copy of ' + key }).toBe(true);
}

/** A saved toolrail-position value's dock, or null. */
function savedDock(value) {
  try {
    return value ? JSON.parse(value).dock : null;
  } catch (e) {
    return null;
  }
}

async function getPref(page, key) {
  return page.evaluate((k) => {
    const v = window.wp.data.select('core/preferences').get('toolrail', k);
    return v === undefined ? null : v;
  }, key);
}

async function blockNames(page) {
  return page.evaluate(() =>
    window.wp.data.select('core/block-editor').getBlocks().map((b) => b.name)
  );
}

/** Text of wp.a11y's polite live region (the rail's speak() writes there). */
async function politeText(page) {
  return page.evaluate(() => {
    const el = document.getElementById('a11y-speak-polite');
    return el ? el.textContent : '';
  });
}

/** Set a color input the way the native picker does: value + input +
    change. (Playwright's fill() refuses input[type=color].) */
async function setColor(page, id, value) {
  await page.evaluate(({ inputId, hex }) => {
    const input = document.getElementById(inputId);
    input.value = hex;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { inputId: id, hex: value });
}

/** Seed a known document for the overview specs: two paragraphs around a
    group with two children. resetBlocks touches only unsaved editor
    state — nothing is ever saved (the suite's standing rule). */
async function seedOverviewBlocks(page) {
  await page.evaluate(() => {
    const { createBlock } = window.wp.blocks;
    window.wp.data.dispatch('core/block-editor').resetBlocks([
      createBlock('core/paragraph', { content: 'ALPHA' }),
      createBlock('core/group', {}, [
        createBlock('core/paragraph', { content: 'INNER-ONE' }),
        createBlock('core/heading', { content: 'INNER-TWO' }),
      ]),
      createBlock('core/paragraph', { content: 'OMEGA' }),
    ]);
  });
  await expect.poll(async () => (await blockNames(page)).length).toBe(3);
}

/** Text of core's polite live region — what wp.a11y.speak() last said. */
const liveText = (page) => page.evaluate(() => {
  const el = document.getElementById('a11y-speak-polite');
  return el ? el.textContent.replace(/\u00a0/g, ' ').trim() : '';
});

module.exports = {
  AUTH,
  openNewPost,
  canvas,
  clickBelowContent,
  waitForPatternCatalog,
  waitForSavedPref,
  savedDock,
  getPref,
  blockNames,
  politeText,
  setColor,
  seedOverviewBlocks,
  liveText,
};
