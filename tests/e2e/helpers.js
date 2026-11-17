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
 *
 * Every spec file takes `test` and `expect` from here, not from
 * @playwright/test (eslint.config.js enforces it): this `test` ends each
 * test only once the account holds the page's last preference save (#113,
 * waitForAccountSaves below).
 */
const base = require('@playwright/test');
const path = require('path');
// RAIL_PREF_KEYS: every rail preference this suite is allowed to write,
// in both stores. One list, in prefs-account.js (#104).
const { setRailScope, apiForPage, readPrefs, RAIL_PREF_KEYS, BASELINE } = require('./prefs-account');

const { expect } = base;

const AUTH = path.join(__dirname, '.auth', 'admin.json');

/*
 * The end of every test (#113).
 *
 * Core saves the `core/preferences` store to the account on a debounce
 * (prefs-account.js has the details): the first change goes at once, later
 * ones 2.5 s after that request finishes. A test could end with a save
 * still pending or in flight. The next test's openNewPost() resets the
 * account and confirms it, and a slow server could apply the old save
 * after that, so the next test started from the old test's state. On
 * 2026-10-10 a late save turned the sidebar width feature on in the next
 * test. Tests guarded it one at a time with waitForSavedPref(), and some
 * did not (#41, #108).
 *
 * So `test` below holds every test, after its body, until the account has
 * the page's last save. The signal is core's own local copy: on every
 * store change, the persistence layer (wp-includes/js/dist/
 * preferences-persistence.js, WordPress 7.1.3) writes the WHOLE store, with
 * a new `_modified` stamp, to localStorage key `WP_PREFERENCES_USER_<id>`,
 * then sends that same object to the account. The debounce always sends
 * the newest object last. So a save is pending or in flight exactly while
 * the account's `_modified` differs from the local copy's, and once they
 * match, the account's `toolrail` scope is the one the page last saved.
 *
 * Only a document that saved has something to wait for. An init script
 * notes each local copy's stamp when a document starts; a copy with the
 * same stamp at the end was not written by this document. That is what
 * keeps a reload safe: a reload cancels a trailing save, the new document
 * then loads the newer local copy, and the account never gets it. Nothing
 * is pending then, and waiting would never end. A test that saves nothing
 * costs one page.evaluate() per browser context and no REST request.
 * openNewPost() starts each test on BASELINE, which the rail's boot does
 * not rewrite, so a test that writes no preference itself saves nothing.
 * (Until that reset was changed, it emptied the account and every boot
 * re-seeded the default pins: 195 of 218 tests then waited about 2.3 s for
 * a save the test never made, 2026-11-13. resetRailPrefs() has the rest.)
 *
 * Limits: a page the test closed, or a document it left, cannot be asked,
 * so a save still in flight from it is not waited for. Two contexts that
 * both save to the account in one test can never both match its stamp.
 * No test does either at its end today.
 */

/** Core's local copy of the store, one per user (`WP_PREFERENCES_USER_<id>`). */
const LOCAL_PREFS_PREFIX = 'WP_PREFERENCES_USER_';

/** Where the init script keeps the stamps it noted when the document started. */
const STAMPS_AT_LOAD = '__editrailE2EPrefsStampsAtLoad';

/** How long a passed test waits for the account; the same as waitForSavedPref(). */
const SAVE_WAIT_MS = 20000;

/**
 * A test that did not pass waits less, and never fails here: its own error
 * is the one to read. It still waits, because a save it leaves pending can
 * change the next test's start state.
 */
const SAVE_WAIT_AFTER_FAILURE_MS = 8000;

/** How long to ask again when an open page does not answer (it is between documents). */
const UNANSWERED_MS = 2000;

/**
 * Init script (runs in the page before core's scripts): note the `_modified`
 * stamp of each local copy of the store as this document starts.
 *
 * @param {{prefix: string, slot: string}} names LOCAL_PREFS_PREFIX, STAMPS_AT_LOAD.
 */
function noteLocalPrefsStamps(names) {
  try {
    const stamps = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.indexOf(names.prefix) === 0) {
        let stamp = null;
        try {
          stamp = JSON.parse(window.localStorage.getItem(key))._modified || null;
        } catch (e) {
          // An unreadable copy has no stamp.
        }
        stamps[key] = stamp;
      }
    }
    window[names.slot] = stamps;
  } catch (e) {
    // No storage in this document (about:blank, an opaque origin).
  }
}

/**
 * In the page: the local copies of the store that this document wrote, with
 * their stamp and `toolrail` scope. A page with no noted stamps (one from a
 * context without the init script) counts every copy it has.
 *
 * @param {{prefix: string, slot: string}} names LOCAL_PREFS_PREFIX, STAMPS_AT_LOAD.
 * @return {Array<{key: string, stamp: string, toolrail: Object}>}
 */
function localPrefsSavedHere(names) {
  const saved = [];
  try {
    const atLoad = window[names.slot] || {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || key.indexOf(names.prefix) !== 0) {
        continue;
      }
      let copy = null;
      try {
        copy = JSON.parse(window.localStorage.getItem(key));
      } catch (e) {
        // Unreadable: core cannot have sent it either.
      }
      const stamp = copy && typeof copy._modified === 'string' ? copy._modified : null;
      if (stamp !== null && stamp !== atLoad[key]) {
        saved.push({ key, stamp, toolrail: copy.toolrail || {} });
      }
    }
  } catch (e) {
    // No storage in this document: nothing it could have saved.
  }
  return saved;
}

/**
 * Whether two `toolrail` scopes hold the same keys and values. Values are
 * compared as JSON, because a test may store a non-string value; an empty
 * scope can come back from the server as [] (PHP's empty array).
 */
function sameScopeJSON(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  return ka.length === kb.length
    && ka.every((k, i) => k === kb[i] && JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/**
 * Wait until the account holds the last preference save of every open page
 * in `contexts` (#113; the reasoning is above `test`). A closed page, a page
 * that left the editor, and a page that saved nothing have nothing to wait
 * for. Pages of one context share one local copy, so a context is checked
 * once per pass.
 *
 * @param {import('@playwright/test').BrowserContext[]} contexts Contexts to check.
 * @param {number} timeoutMs How long to wait.
 * @return {Promise<{waitedMs: number, restReads: number, pending: Array}>}
 *   `pending` is empty when every save has landed.
 */
async function waitForAccountSaves(contexts, timeoutMs) {
  const names = { prefix: LOCAL_PREFS_PREFIX, slot: STAMPS_AT_LOAD };
  const started = Date.now();
  const deadline = started + timeoutMs;
  const apis = new Map();
  let restReads = 0;
  let pending = [];
  for (;;) {
    pending = [];
    let unanswered = false;
    for (const context of contexts) {
      const pages = context.pages().filter((p) => !p.isClosed());
      let saved = null;
      for (const page of pages) {
        try {
          saved = { page, copies: await page.evaluate(localPrefsSavedHere, names) };
          break;
        } catch (e) {
          // Closed or between documents: try the context's next page, then
          // the next pass.
        }
      }
      if (!saved) {
        // Open pages, and none answered: most likely one is between two
        // documents. Ask again for a short while.
        unanswered = unanswered || pages.length > 0;
        continue;
      }
      if (!saved.copies.length) {
        continue;
      }
      let prefs = null;
      try {
        if (!apis.has(context)) {
          apis.set(context, await apiForPage(saved.page));
        }
        prefs = await readPrefs(apis.get(context));
        restReads += 1;
      } catch (e) {
        // The page closed under us, or one read failed; the next pass
        // decides.
      }
      saved.copies.forEach((copy) => {
        if (!prefs || prefs._modified !== copy.stamp || !sameScopeJSON(prefs.toolrail, copy.toolrail)) {
          pending.push({ key: copy.key, local: copy.stamp, account: prefs ? prefs._modified : 'unread' });
        }
      });
    }
    // A page that does not answer for UNANSWERED_MS has no editor document
    // that could still save (a page that never loaded one, or one that
    // hangs; the test's own result reports that).
    const answered = !unanswered || Date.now() - started >= UNANSWERED_MS;
    if ((!pending.length && answered) || Date.now() >= deadline) {
      return { waitedMs: Date.now() - started, restReads, pending };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * The suite's `test`: @playwright/test's, with the `context` fixture
 * wrapped. Wrapping `context` (not an auto fixture) means a test that never
 * opens a page (login-url-check.spec.js) starts no browser for this.
 *
 * Contexts the test opens itself (browser.newContext()) and leaves open are
 * checked too. They have no init script, so every local copy they hold
 * counts as saved by them.
 */
const test = base.test.extend({
  context: async ({ context }, use, testInfo) => {
    const browser = context.browser();
    const before = new Set(browser ? browser.contexts() : []);
    await context.addInitScript(noteLocalPrefsStamps, { prefix: LOCAL_PREFS_PREFIX, slot: STAMPS_AT_LOAD });

    await use(context);

    // A test that timed out or was stopped may have a page that does not
    // answer; it is already reported.
    if (testInfo.status === 'timedOut' || testInfo.status === 'interrupted') {
      return;
    }
    const passed = testInfo.status === 'passed';
    const opened = browser ? browser.contexts().filter((c) => c !== context && !before.has(c)) : [];
    const result = await waitForAccountSaves([context, ...opened], passed ? SAVE_WAIT_MS : SAVE_WAIT_AFTER_FAILURE_MS);
    if (passed && result.pending.length) {
      throw new Error(`The test ended, but after ${result.waitedMs} ms the account still did not hold the page's last preference save (#113): ${JSON.stringify(result.pending)}. A save that never lands is an error; a slow server needs a longer SAVE_WAIT_MS in tests/e2e/helpers.js.`);
    }
  },
});

/**
 * Return the rail's stored state to a fresh-install baseline, in the page
 * currently loaded.
 *
 * Dock, pins and saved sets are per-user preferences — since the
 * account-persistence change they live in the core/preferences store
 * (synced to user meta), with localStorage as the migration source and
 * fallback. Reset BOTH, or a spec's changes leak into every later spec
 * through the shared admin account. The local `toolrail-*` keys are
 * removed; the account gets BASELINE (prefs-account.js): the DEFAULT
 * pinned slots (Group/Text/Heading/Image), which several tests rely on,
 * and both migration stamps.
 *
 * Why BASELINE and not an empty scope (#113): BASELINE is exactly what
 * boot() writes on an empty account (migrateSlots() seeds the four pins
 * and both stamps; nothing else is written at boot). The reset used to
 * empty the scope instead, so nearly every test booted on an empty
 * account, re-seeded, and made a preference save the end-of-test wait
 * (`test` above) then had to wait about 2.3 s for: 195 of 218 tests,
 * about 447 s of a full Chromium run (2026-11-13). On BASELINE a plain
 * boot saves nothing. A test that needs the empty account of a fresh
 * install passes `{ emptyAccount: true }`; the stamps go with the pins
 * then, because a stamp left set over a wiped pin list stops the one-time
 * slot migration, and the rail comes back empty instead of default. (The
 * local-to-account lift has no stamp of its own — it's a per-key check
 * against the account, safe to re-run.)
 *
 * The account is written on the SERVER and confirmed there
 * (prefs-account.js setRailScope), never through this page's store: the
 * caller reloads next, and a reload cancels the trailing half of core's
 * debounced save. The developer's own settings are not lost: auth.setup.js
 * saved them, and global-teardown.js restores them after the run.
 *
 * @param {import('@playwright/test').Page} page Page with the editor loaded.
 * @param {{emptyAccount?: boolean}} [opts] emptyAccount: remove every rail
 *   key from the account instead of writing BASELINE.
 * @return {Promise<boolean>} Whether anything was actually changed, in the
 *   account or in localStorage; the page must then be reloaded.
 */
async function resetRailPrefs(page, opts) {
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
  const serverHad = await setRailScope(page, opts && opts.emptyAccount ? {} : BASELINE);
  const coreCopyHad = await dropNewerCorePrefsCopy(page);
  return localHad || serverHad || coreCopyHad;
}

/**
 * Remove core's local copy of the store (LOCAL_PREFS_PREFIX) when it is
 * newer than the account, and say whether one was removed.
 *
 * Core boots from that copy instead of the account when its `_modified`
 * stamp is newer (preferences-persistence.js,
 * __unstableCreatePersistenceLayer). A reload inside core's 2.5 s save
 * delay leaves exactly that: the copy holds the dropped save, the account
 * does not. When the account already holds the start state, the reset
 * writes nothing, so without this a document booted from such a copy
 * counted as "nothing to do" and the test started from the dropped save
 * (shown with a second openNewPost() in one context, #113 follow-on,
 * 2026-11-16). Before the reset wrote BASELINE, it always wrote, and the
 * new stamp beat any copy. A new context has no copy, so this is one
 * page.evaluate() and no REST read for nearly every test.
 *
 * @param {import('@playwright/test').Page} page Page with the editor loaded.
 * @return {Promise<boolean>} True when a copy was removed (reload the page).
 */
async function dropNewerCorePrefsCopy(page) {
  const copies = await page.evaluate((prefix) => {
    const out = {};
    Object.keys(window.localStorage).forEach((key) => {
      if (key.indexOf(prefix) === 0) {
        let stamp = null;
        try {
          stamp = JSON.parse(window.localStorage.getItem(key))._modified || null;
        } catch (e) {
          // An unreadable copy: core cannot boot from it either.
        }
        out[key] = stamp;
      }
    });
    return out;
  }, LOCAL_PREFS_PREFIX);
  const keys = Object.keys(copies);
  if (!keys.length) {
    return false;
  }
  const accountAt = Date.parse((await readPrefs(await apiForPage(page)))._modified) || 0;
  const newer = keys.filter((key) => (Date.parse(copies[key]) || 0) > accountAt);
  if (!newer.length) {
    return false;
  }
  await page.evaluate((drop) => drop.forEach((key) => window.localStorage.removeItem(key)), newer);
  return true;
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

/**
 * Open a new post with the rail on its test start state (resetRailPrefs()).
 *
 * Each test has a new browser context, so the first load boots on the
 * account as the last test left it. The page is reloaded only when the
 * reset changed something; an account already at BASELINE is used as it
 * is, and its boot saves nothing.
 *
 * Before the reset, it waits for that first load's rail to boot and for
 * any save its boot made to land. On an account the boot migrates, the boot's save can
 * otherwise reach the server AFTER the reset has confirmed its write, and
 * the account then held the migrated state under a page that showed
 * BASELINE (reproduced 2026-11-16 with a pre-migration pin list). The old
 * empty reset hid this: the reloaded page always re-seeded and saved last.
 * On an account at BASELINE the boot saves nothing, so this costs one
 * page.evaluate() after the rail is up, which the test waits for anyway.
 *
 * @param {import('@playwright/test').Page} page A page of the test's context.
 * @param {{emptyAccount?: boolean}} [opts] Passed to resetRailPrefs():
 *   `{ emptyAccount: true }` starts from the empty account of a fresh
 *   install, so the rail's first-boot seed runs (and saves) in this test.
 * @return {Promise<void>}
 */
async function openNewPost(page, opts) {
  await page.goto('/wp-admin/post-new.php');

  // isReady() turns true once boot's own migrations have written (or found
  // nothing to write). A rail that never boots is reported by the
  // visibility check below, not here. So this wait is short: at 20 s it
  // and the 20 s visibility check together passed the 30 s test timeout,
  // and a rail that never booted failed as a plain test timeout, not as
  // "#toolrail-rail is not visible" (#113 review, 2026-11-16).
  await page.waitForFunction(() => !!(window.toolrail && window.toolrail.prefs && window.toolrail.prefs.isReady()), null, { timeout: 8000 })
    .catch(() => {});
  await waitForAccountSaves([page.context()], SAVE_WAIT_MS);

  const hadState = await resetRailPrefs(page, opts);
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
 * Use it only where a test needs the server copy before it goes on (a
 * reload, a second browser). The end of every test already waits for the
 * account (`test` above, #113).
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
  test,
  expect,
  waitForAccountSaves,
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
