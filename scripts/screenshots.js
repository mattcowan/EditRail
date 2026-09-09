/**
 * Regenerate the WordPress.org listing screenshots.
 *
 *   node scripts/screenshots.js
 *
 * Writes .wordpress-org/screenshot-1.png … screenshot-N.png at
 * 1440x900, deviceScaleFactor 1, from a real WordPress install with
 * EditRail active. It drives the same DOM the e2e suite drives
 * (tests/e2e/rail.spec.js); the selectors are deliberately the same
 * strings, so a rename that breaks the suite breaks this too.
 *
 * Environment:
 *   TOOLRAIL_URL           site root      (default http://typographystylist.local)
 *   TOOLRAIL_ADMIN_USER    admin login    (default admin)
 *   TOOLRAIL_ADMIN_PASS    admin password (default pass)
 *   TOOLRAIL_FIXTURE_POST  post ID of a long draft used for the Section
 *                          overview shot. Unset: the overview document is
 *                          built in memory on post-new.php instead, which
 *                          needs no fixture and saves nothing.
 *   TOOLRAIL_DEMO_POST     post ID of the Playground demo post (2026 in
 *                          the blueprint). Set: screenshot 1 is taken on
 *                          that post, read-only, with the Typography
 *                          Stylist pin removed for the frame so the rail
 *                          shows only the default tools. Unset: screenshot
 *                          1 uses the in-memory sample document.
 *   TOOLRAIL_ONLY          comma-separated screenshot numbers to take,
 *                          e.g. "1" or "1,3". Unset: all of them.
 *   TOOLRAIL_HEADED=1      watch it run.
 *
 * The listing set was taken on a local WordPress Playground of the
 * blueprint (`npm run playground -- --port=9400`, login admin/password):
 *   TOOLRAIL_URL=http://127.0.0.1:9400 TOOLRAIL_ADMIN_PASS=password \
 *   TOOLRAIL_DEMO_POST=2026 node scripts/screenshots.js
 *
 * TWO STANDING RULES, both enforced here, not merely intended:
 *
 * 1. NOTHING IS EVER SAVED. Every shot happens on post-new.php (or on a
 *    read-only visit to the fixture post). A request filter aborts every
 *    write to a post, an autosave or a revision, so an autosave that
 *    fires while a page is open cannot reach the database. Blocked
 *    attempts are reported at the end.
 *
 * 2. THE ACCOUNT'S RAIL PREFERENCES ARE THE OWNER'S OWN. Dock, pins,
 *    appearance and wide mode live in the core/preferences store under
 *    the `toolrail` scope, synced to wp_persisted_preferences — the same
 *    user meta the human's browser reads. The shots have to change some
 *    of them, so the run snapshots every key first, restores the exact
 *    snapshot in a `finally`, and then RELOADS and re-reads to prove the
 *    restore landed. The verification is the point: a restore that only
 *    reached this page's store, and not the debounced REST write, would
 *    otherwise look like a success.
 *
 *    The same applies to the three editor settings the shots change for
 *    a clean frame — the welcome guide, fullscreen mode and the open
 *    settings sidebar. They are per-user too, so they are snapshotted,
 *    restored and verified with the rest.
 *
 * A THIRD RULE follows from the second: because those settings survive
 * a closed browser context, every shot resets the rail to the snapshot
 * before it starts. Without that, the dock set for the horizontal-bar
 * shot rides into the shots after it.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const BASE = (process.env.TOOLRAIL_URL || 'http://typographystylist.local').replace(/\/+$/, '');
const USER = process.env.TOOLRAIL_ADMIN_USER || 'admin';
const PASS = process.env.TOOLRAIL_ADMIN_PASS || 'pass';
const FIXTURE_POST = process.env.TOOLRAIL_FIXTURE_POST || '';
const DEMO_POST = process.env.TOOLRAIL_DEMO_POST || '';
const ONLY = (process.env.TOOLRAIL_ONLY || '')
  .split(',')
  .map((s) => parseInt(s, 10))
  .filter((n) => n > 0);
const HEADED = !!process.env.TOOLRAIL_HEADED;

const OUT_DIR = path.join(__dirname, '..', '.wordpress-org');
const VIEWPORT = { width: 1440, height: 900 };

/** Every rail preference a shot is allowed to write. Mirrors RAIL_PREF_KEYS
    in tests/e2e/rail.spec.js — keep the two lists identical. */
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
];

/**
 * Core preferences the shots change, and therefore have to restore:
 * the welcome guide is turned off (it lands over the first shot), and
 * fullscreen mode is turned on (it is core's own default for a new
 * account, and it keeps the admin bar out of the frame).
 *
 * WordPress moved the guide's scope from `core/edit-post` to `core`;
 * both are carried so the script works either side of that move.
 */
const CORE_PREFS = [
  ['core/edit-post', 'welcomeGuide'],
  ['core', 'welcomeGuide'],
  ['core/edit-post', 'fullscreenMode'],
  ['core', 'fullscreenMode'],
];

/**
 * Interface scopes whose open sidebar ("complementary area") is
 * snapshotted and restored. WordPress moved the post editor's scope
 * from `core/edit-post` to `core`; carrying both makes the script work
 * either side of that move, and an unused scope reads back as null.
 */
const SIDEBAR_SCOPES = ['core', 'core/edit-post'];

const blockedWrites = [];
/** Shots that threw, so a run that left old PNGs in place cannot exit 0. */
const failedShots = [];

/**
 * The account's rail preferences as they were found, filled in before
 * the first shot. Every shot resets to this, so no shot inherits the
 * one before it: dock, appearance and wide mode are per-USER settings
 * that survive a closed context, and on the first cut of this script
 * the top dock set for the horizontal-bar shot rode into the two shots
 * after it, both of which are meant to show the left dock.
 */
let BASELINE = null;

/** One line to stdout; every message this script prints goes through here. */
function log(msg) {
  process.stdout.write(`${msg}\n`);
}

/* ------------------------------------------------------------------ */
/* Save guard                                                          */
/* ------------------------------------------------------------------ */

/**
 * Abort every request that could write a post, an autosave or a
 * revision. Preference writes (…/wp/v2/users/me) are NOT blocked — the
 * restore in `finally` travels that route.
 *
 * @param {import('@playwright/test').BrowserContext} context Context to guard.
 */
async function guardAgainstSaves(context) {
  await context.route('**/*', (route) => {
    const request = route.request();
    const method = request.method();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return route.continue();
    }
    const url = request.url();
    const body = request.postData() || '';
    // Heartbeat is deliberately NOT blocked: in the block editor it
    // carries the post lock, not the save, and killing it puts a
    // "connection lost" notice across the shot.
    const writesAPost =
      /\/wp\/v2\/(posts|pages|media)(\/|\?|$)/.test(url) ||
      /rest_route=[^&]*(wp%2Fv2%2F|wp\/v2\/)(posts|pages)/.test(url) ||
      /autosaves/.test(url) ||
      /wp-admin\/post\.php/.test(url) ||
      (/admin-ajax\.php/.test(url) && /action=wp_autosave/.test(body));
    if (writesAPost) {
      blockedWrites.push(`${method} ${url}`);
      return route.abort();
    }
    return route.continue();
  });
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

/**
 * Log in and return the storage state, the way tests/e2e/auth.setup.js
 * does. The script never depends on that suite's gitignored .auth file.
 *
 * @param {import('@playwright/test').Browser} browser Browser to use.
 * @return {Promise<Object>} Playwright storage state for an admin session.
 */
async function login(browser) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    await page.goto(`${BASE}/wp-login.php`, { waitUntil: 'domcontentloaded' });
    await page.fill('#user_login', USER);
    await page.fill('#user_pass', PASS);
    await page.click('#wp-submit');
    await page.waitForURL(/wp-admin/, { timeout: 20000 });
    if (!(await page.locator('#wpadminbar').count())) {
      throw new Error('Logged in, but no admin bar — is this account an administrator?');
    }
    return await context.storageState();
  } finally {
    await context.close();
  }
}

/**
 * Open the block editor and get it to a photographable state: welcome
 * guide gone, rail mounted, no spinner.
 *
 * @param {import('@playwright/test').Page} page   Page to drive.
 * @param {string}                          target Admin path to open.
 */
async function openEditor(page, target) {
  await page.goto(`${BASE}${target}`, { waitUntil: 'domcontentloaded' });
  await resetToBaseline(page);
  await dismissWelcomeGuide(page);
  await page.waitForSelector('#toolrail-rail', { state: 'visible', timeout: 30000 });
  // The canvas iframe mounts after the rail; a shot taken before it is
  // laid out catches a blank white column where the document should be.
  await page.waitForSelector('iframe[name="editor-canvas"]', { timeout: 30000 });
  await page.waitForFunction(
    () => {
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      return !!(frame && frame.contentDocument && frame.contentDocument.body);
    },
    null,
    { timeout: 30000 }
  );
  await closeSidebar(page);
  await page.waitForTimeout(800);
}

/**
 * Wait until the editor is mounted enough for every store this script
 * reads to hold real values.
 *
 * Waiting for `core/preferences` alone is not enough: the sidebar's
 * state comes from `core/interface`, which only has an answer once the
 * editor's interface has rendered, and reading it too early returns
 * null for an open sidebar. A snapshot taken from that null then
 * "restores" the sidebar closed.
 *
 * @param {import('@playwright/test').Page} page Page to wait on.
 */
async function waitForStores(page) {
  await page.waitForFunction(
    () => window.wp && window.wp.data && !!window.wp.data.select('core/preferences')
      && !!window.wp.data.select('core/interface'),
    null,
    { timeout: 30000 }
  );
  // The interface store answers only once the editor's chrome exists.
  await page
    .waitForSelector('.interface-interface-skeleton__body', { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(2500);
}

/**
 * Close core's welcome guide when it is showing.
 *
 * This is only the BACKSTOP. The guide is turned off as an account
 * preference before any shot runs, because waiting for the modal is a
 * race the modal can win: it mounts after the editor's stores, so a
 * five-second wait that starts too early finds nothing, and the guide
 * then appears over the shot (observed on the first run — the "Welcome
 * to the editor" panel sat across screenshot-1).
 */
async function dismissWelcomeGuide(page) {
  const close = page
    .locator('.components-modal__frame')
    .locator('button[aria-label="Close"]')
    .first();
  try {
    await close.waitFor({ state: 'visible', timeout: 2500 });
    await close.click();
    await page.waitForTimeout(400);
  } catch (e) {
    /* No modal — the preference already turned it off. */
  }
}

/**
 * Turn the welcome guide off and fullscreen mode on, for the account,
 * once. Every shot context then loads an editor that is already in the
 * right state, instead of racing a modal on each load.
 *
 * @param {import('@playwright/test').Page} page Page with the stores loaded.
 */
async function setEditorChrome(page) {
  await page.evaluate((corePrefs) => {
    const disp = window.wp.data.dispatch('core/preferences');
    corePrefs.forEach(([scope, key]) => {
      disp.set(scope, key, key === 'welcomeGuide' ? false : true);
    });
  }, CORE_PREFS);
  // The preferences store persists on a debounce; the next context has
  // to read this from the server, not from a store it never saw.
  await page.waitForTimeout(3500);
}

/**
 * Close the editor's settings sidebar for a shot.
 *
 * Every shot is framed without it. The reason is the Section overview:
 * it zooms the whole document into the canvas and draws its control bar
 * over the canvas's top-left corner, and with the sidebar open the
 * canvas is narrow enough that the first section's name tag sits under
 * that bar and reads as clipped. The wider canvas also gives the other
 * shots more of the document and less chrome.
 *
 * The sidebar is a per-user setting like the rest, so it is snapshotted
 * and restored with them (see SIDEBAR_SCOPES).
 *
 * @param {import('@playwright/test').Page} page Page to change.
 */
async function closeSidebar(page) {
  await page.evaluate((scopes) => {
    const disp = window.wp.data.dispatch('core/interface');
    scopes.forEach((scope) => disp.disableComplementaryArea(scope));
  }, SIDEBAR_SCOPES);
  await page.waitForTimeout(500);
}

/** Move focus off the last thing clicked, so no focus ring rides into
    the shot. Never call this while a dialog is open — the rail closes
    its surfaces on focus-out. */
async function blurFocus(page) {
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
  });
  await page.waitForTimeout(250);
}

/**
 * Scroll the settings dialog so `selector` sits at its top edge.
 *
 * The dialog is a fixed 320x560 box with `overflow-y: auto`, and it
 * opens already scrolled. Nothing is clipped by the viewport — the
 * interesting section is simply below the fold of the dialog's own
 * scroller, which is what made the first cut of the Edit-form shot look
 * like a cut-off panel (measured: scrollHeight 2274, clientHeight 558).
 *
 * @param {import('@playwright/test').Page} page     Page to drive.
 * @param {string}                          selector Element to bring to the top.
 * @param {number}                          pad      Pixels of room above it.
 */
async function scrollDialogTo(page, selector, pad) {
  await page.evaluate(
    ({ sel, gap }) => {
      const dialog = document.querySelector('.toolrail-settings');
      const target = document.querySelector(sel);
      if (!dialog || !target) {
        return;
      }
      dialog.scrollTop += target.getBoundingClientRect().top - dialog.getBoundingClientRect().top - gap;
    },
    { sel: selector, gap: pad === undefined ? 12 : pad }
  );
  await page.waitForTimeout(300);
}

/** Wait for both pattern-catalog resolutions, so the settings dialog's
    "Add a block or pattern" search has something to find. */
async function waitForPatternCatalog(page) {
  await page
    .waitForFunction(
      () => {
        const sel = window.wp && window.wp.data && window.wp.data.select('core');
        return (
          !!sel &&
          sel.hasFinishedResolution('getBlockPatterns', []) &&
          sel.hasFinishedResolution('getEntityRecords', [
            'postType',
            'wp_block',
            { per_page: -1, context: 'edit' },
          ])
        );
      },
      null,
      { timeout: 20000 }
    )
    .catch(() => {
      /* A site with no patterns never resolves both; the block results
         still render, which is what the shot is of. */
    });
}

/* ------------------------------------------------------------------ */
/* Preferences: snapshot, restore, verify                              */
/* ------------------------------------------------------------------ */

/**
 * Read every rail preference from BOTH stores, plus core's welcome-guide
 * flags.
 *
 * @param {import('@playwright/test').Page} page Page with the editor loaded.
 * @return {Promise<Object>} `{ prefs, local, core }` — `null` means unset.
 */
function snapshotPrefs(page) {
  return page.evaluate(
    ({ keys, corePrefs, scopes }) => {
      const read = (scope, key) => {
        const v = window.wp.data.select('core/preferences').get(scope, key);
        return v === undefined ? null : v;
      };
      const prefs = {};
      const local = {};
      keys.forEach((k) => {
        prefs[k] = read('toolrail', k);
        local[k] = window.localStorage.getItem(k);
      });
      const core = {};
      corePrefs.forEach(([scope, key]) => {
        core[`${scope}::${key}`] = read(scope, key);
      });
      const sel = window.wp.data.select('core/interface');
      const sidebar = {};
      scopes.forEach((scope) => {
        const area = sel && sel.getActiveComplementaryArea ? sel.getActiveComplementaryArea(scope) : null;
        sidebar[scope] = area === undefined ? null : area;
      });
      return { prefs, local, core, sidebar };
    },
    { keys: RAIL_PREF_KEYS, corePrefs: CORE_PREFS, scopes: SIDEBAR_SCOPES }
  );
}

/**
 * Write a snapshot back, in the page currently loaded.
 *
 * @param {import('@playwright/test').Page} page        Page with the editor loaded.
 * @param {Object}                          snap        Value from snapshotPrefs.
 * @param {boolean}                         includeCore Also restore core's
 *   editor-chrome preferences. False between shots, where the chrome
 *   settings are deliberately left in place for the whole run.
 */
function applyPrefs(page, snap, includeCore) {
  return page.evaluate(
    ({ s, withCore }) => {
      const disp = window.wp.data.dispatch('core/preferences');
      Object.keys(s.prefs).forEach((k) => {
        disp.set('toolrail', k, s.prefs[k] === null ? undefined : s.prefs[k]);
      });
      if (withCore) {
        Object.keys(s.core).forEach((full) => {
          const [scope, key] = full.split('::');
          disp.set(scope, key, s.core[full] === null ? undefined : s.core[full]);
        });
        const ui = window.wp.data.dispatch('core/interface');
        Object.keys(s.sidebar || {}).forEach((scope) => {
          if (s.sidebar[scope]) {
            ui.enableComplementaryArea(scope, s.sidebar[scope]);
          } else {
            ui.disableComplementaryArea(scope);
          }
        });
      }
      Object.keys(s.local).forEach((k) => {
        if (s.local[k] === null) {
          window.localStorage.removeItem(k);
        } else {
          window.localStorage.setItem(k, s.local[k]);
        }
      });
    },
    { s: snap, withCore: !!includeCore }
  );
}

/**
 * Put the rail's preferences back to the baseline in a page that has
 * just loaded, and reload if anything had to move.
 *
 * The reload is what makes this reliable rather than hopeful: several
 * rail preferences are read at boot, and the preferences store writes
 * to the account on a debounce, so the pause before the reload is not
 * padding — without it, the reload reads the OLD values back off the
 * server and undoes the reset.
 *
 * @param {import('@playwright/test').Page} page Page to reset.
 */
async function resetToBaseline(page) {
  if (!BASELINE) {
    return;
  }
  await page.waitForFunction(
    () => window.wp && window.wp.data && !!window.wp.data.select('core/preferences'),
    null,
    { timeout: 30000 }
  );
  const drifted = await page.evaluate(
    ({ keys, want }) => {
      const sel = window.wp.data.select('core/preferences');
      return keys.some((k) => {
        const now = sel.get('toolrail', k);
        return JSON.stringify(now === undefined ? null : now) !== JSON.stringify(want[k]);
      });
    },
    { keys: RAIL_PREF_KEYS, want: BASELINE.prefs }
  );
  if (!drifted) {
    return;
  }
  await applyPrefs(page, BASELINE, false);
  await page.waitForTimeout(3500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.wp && window.wp.data && !!window.wp.data.select('core/preferences'),
    null,
    { timeout: 30000 }
  );
}

/**
 * Put the account back exactly as it was found, then prove it.
 *
 * A FRESH context, not a page the shots have been driven through: the
 * shots leave dialogs open and tokens applied, and the point of the
 * check is that the value came back from the SERVER, not from a store
 * this run happens to be holding. The reload after the debounce is what
 * makes the check meaningful.
 *
 * @param {import('@playwright/test').Browser} browser  Browser to use.
 * @param {Object}                             state    Admin storage state.
 * @param {Object}                             snapshot Value from snapshotPrefs.
 * @return {Promise<{ok: boolean, diffs: string[]}>} Verification result.
 */
async function restorePrefs(browser, state, snapshot) {
  const context = await browser.newContext({ viewport: VIEWPORT, storageState: state });
  await guardAgainstSaves(context);
  try {
    const page = await context.newPage();
    await page.goto(`${BASE}/wp-admin/post-new.php`, { waitUntil: 'domcontentloaded' });
    await waitForStores(page);
    await applyPrefs(page, snapshot, true);
    // The preferences store writes to user meta on a debounce. Closing
    // the context before that lands would leave the account dirty and
    // the run would still report success.
    await page.waitForTimeout(3500);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForStores(page);
    const after = await snapshotPrefs(page);

    const diffs = [];
    RAIL_PREF_KEYS.forEach((k) => {
      if (JSON.stringify(after.prefs[k]) !== JSON.stringify(snapshot.prefs[k])) {
        diffs.push(`toolrail/${k}: expected ${JSON.stringify(snapshot.prefs[k])}, got ${JSON.stringify(after.prefs[k])}`);
      }
    });
    Object.keys(snapshot.core).forEach((full) => {
      if (JSON.stringify(after.core[full]) !== JSON.stringify(snapshot.core[full])) {
        diffs.push(`${full}: expected ${JSON.stringify(snapshot.core[full])}, got ${JSON.stringify(after.core[full])}`);
      }
    });
    Object.keys(snapshot.sidebar).forEach((scope) => {
      if (JSON.stringify(after.sidebar[scope]) !== JSON.stringify(snapshot.sidebar[scope])) {
        diffs.push(
          `sidebar ${scope}: expected ${JSON.stringify(snapshot.sidebar[scope])}, got ${JSON.stringify(after.sidebar[scope])}`
        );
      }
    });
    return { ok: diffs.length === 0, diffs };
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* Document fixtures (unsaved editor state only)                       */
/* ------------------------------------------------------------------ */

/**
 * Replace the editor's blocks. resetBlocks touches unsaved state only —
 * nothing here reaches the database.
 *
 * @param {import('@playwright/test').Page} page  Page with the editor loaded.
 * @param {string}                          shape 'article' or 'overview'.
 */
async function seedBlocks(page, shape) {
  await page.evaluate((kind) => {
    const { createBlock } = window.wp.blocks;
    const dispatch = window.wp.data.dispatch('core/block-editor');
    const p = (content) => createBlock('core/paragraph', { content });
    // Sections carry padding for a reason beyond looks: the overview
    // draws each block's name tag inside the top-left of its outline,
    // so a heading flush to the group's edge ends up underneath it.
    // The tag is drawn at full size over a canvas that the overview has
    // scaled to about 38%, so the top padding has to be generous to
    // clear it: 1.75rem measured out to roughly 10px on screen and the
    // heading still showed from behind the tag.
    const PAD = {
      style: { spacing: { padding: { top: '4rem', right: '1.5rem', bottom: '2rem', left: '1.5rem' } } },
    };
    /** A named group — the name is what the overview's tag reads. */
    const section = (name, children) =>
      createBlock('core/group', Object.assign({ metadata: { name } }, PAD), children);

    if (kind === 'article') {
      window.wp.data.dispatch('core/editor').editPost({ title: 'Field notes' });
      dispatch.resetBlocks([
        p('The toolbar sits beside the canvas. Pick a tool, then click the place on the page where the block goes.'),
        p('Every tool on the toolbar is a block. Add the ones you use, and take off the ones you do not.'),
        createBlock('core/quote', {}, [p('A tool stays armed while you hold Shift, so a run of blocks takes one trip.')]),
        section('A section', [
          createBlock('core/heading', { level: 3, content: 'A section' }),
          p('Groups keep related blocks together. The overview shows each one as an outline with its own name.'),
        ]),
        p('Nothing on this page is saved. It is a sample document for the screenshots.'),
      ]);
      return;
    }

    window.wp.data.dispatch('core/editor').editPost({ title: 'A long page' });
    // The section NAME and the section's own heading are deliberately
    // different: identical text reads as a rendering fault at the
    // overview's zoom, where the tag sits right above the heading.
    const titles = [
      ['Intro', 'Opening notes'],
      ['How it works', 'How the toolbar works'],
      ['Arming', 'Arming a tool'],
      ['Pinning', 'Pinning your own blocks'],
      ['Docking', 'Docking the toolbar'],
      ['Wrap-up', 'Closing notes'],
    ];
    dispatch.resetBlocks(
      titles.map(([name, title], i) =>
        section(name, [
          createBlock('core/heading', { level: 2, content: title }),
          p('Plain filler text for the screenshot. It says nothing and holds the shape of a paragraph.'),
          p('A second paragraph gives the section enough height to read as a block of content.'),
          i % 2 === 0
            ? p('A third paragraph, so the sections are not all the same size.')
            : createBlock('core/separator', {}),
        ])
      )
    );
  }, shape);

  await page.waitForFunction(
    () => window.wp.data.select('core/block-editor').getBlocks().length > 0,
    null,
    { timeout: 10000 }
  );
  // Let the canvas iframe lay the new blocks out before anything is shot.
  await page.waitForTimeout(1200);
}

/* ------------------------------------------------------------------ */
/* Rail helpers                                                        */
/* ------------------------------------------------------------------ */

const tool = (id) => `#toolrail-rail [data-tool="${id}"]`;
const SETTINGS = '.toolrail-settings';

/** Open Toolbar settings from the gear and wait for the dialog. */
async function openSettings(page) {
  await page.click(tool('settings'));
  await page.waitForSelector(SETTINGS, { state: 'visible', timeout: 10000 });
  await page.waitForTimeout(400);
}

/** Close Toolbar settings with Escape, if it is open. */
async function closeSettings(page) {
  if (await page.locator(SETTINGS).count()) {
    await page.keyboard.press('Escape');
    await page.waitForSelector(SETTINGS, { state: 'detached', timeout: 5000 }).catch(() => {});
  }
  await page.waitForTimeout(300);
}

/** Take one shot, after a beat for animations and web fonts. */
async function shoot(page, index, what) {
  await page
    .evaluate(async () => {
      if (document.fonts) {
        await document.fonts.ready;
      }
      return true;
    })
    .catch(() => {});
  await page.waitForTimeout(500);
  const file = path.join(OUT_DIR, `screenshot-${index}.png`);
  await page.screenshot({ path: file, type: 'png' });
  log(`  screenshot-${index}.png — ${what}`);
}

/* ------------------------------------------------------------------ */
/* The shots                                                           */
/* ------------------------------------------------------------------ */

/**
 * Each entry gets a FRESH page, opened and closed inside its own step:
 * a page that stays open collects an autosave timer and a dirty-state
 * prompt, and a shot is cheap to re-take from a clean load.
 */
const SHOTS = [
  {
    what: 'The toolbar docked left, the Heading tool armed, over a sample document.',
    async run(page) {
      if (DEMO_POST) {
        // The blueprint's demo post: EB Garamond headline and tagline
        // in the canvas. Opened read-only (the save guard holds), and
        // the demo's own Typography Stylist pin is removed for the
        // frame so the rail shows the default tools only. The account
        // restore at the end puts the pin and its metadata back.
        await openEditor(page, `/wp-admin/post.php?post=${DEMO_POST}&action=edit`);
        await page.evaluate(() => {
          if (window.toolrail && typeof window.toolrail.isPinned === 'function' && window.toolrail.isPinned('typost/block')) {
            window.toolrail.unpinBlock('typost/block');
          }
        });
        await page.waitForSelector(tool('pin:typost/block'), { state: 'detached', timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(400);
      } else {
        await openEditor(page, '/wp-admin/post-new.php');
        await seedBlocks(page, 'article');
      }
      await page.click(tool('pin:core/heading'));
      await page.waitForSelector(`${tool('pin:core/heading')}[aria-pressed="true"]`, { timeout: 5000 });
      // The armed look comes from aria-pressed, so dropping focus keeps
      // it and takes the focus ring out of the frame.
      await blurFocus(page);
    },
  },
  {
    what: 'Toolbar settings: the pinned tools, and the search that adds more.',
    async run(page) {
      await openEditor(page, '/wp-admin/post-new.php');
      await seedBlocks(page, 'article');
      await waitForPatternCatalog(page);
      await openSettings(page);
      await page.fill('#toolrail-settings-search', 'quote');
      await page.waitForSelector('.toolrail-settings-result', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(600);
      // Bring the pinned list to the dialog's top edge, so the shot
      // starts at a heading instead of halfway through one.
      await scrollDialogTo(page, '.toolrail-settings-pinnedrow', 34);
    },
  },
  {
    what: 'Section overview: the whole document as named outlines you can reorder.',
    async run(page) {
      if (FIXTURE_POST) {
        await openEditor(page, `/wp-admin/post.php?post=${encodeURIComponent(FIXTURE_POST)}&action=edit`);
      } else {
        await openEditor(page, '/wp-admin/post-new.php');
        await seedBlocks(page, 'overview');
      }
      await page.click(tool('overview'));
      await page.waitForSelector('#toolrail-overview', { state: 'visible', timeout: 15000 });
      await page.waitForSelector('#toolrail-overview .toolrail-ov-box', { timeout: 15000 });
      await page.waitForTimeout(1500);
    },
  },
  {
    what: 'Tool names turned on, with the Light appearance.',
    async run(page) {
      await openEditor(page, '/wp-admin/post-new.php');
      await seedBlocks(page, 'article');
      await openSettings(page);
      await page.check('#toolrail-settings-widetoggle');
      await page.check('input[data-appearance="light"]');
      await page.waitForTimeout(400);
      await closeSettings(page);
      await page.click(tool('wide-toggle'));
      await page.waitForSelector('#toolrail-region[data-wide="true"]', { timeout: 5000 });
      await page.waitForTimeout(500);
    },
  },
  {
    what: 'The toolbar docked along the top as a horizontal bar.',
    async run(page) {
      await openEditor(page, '/wp-admin/post-new.php');
      await seedBlocks(page, 'article');
      await openSettings(page);
      await page.check('.toolrail-settings-position input[data-dock="top"]');
      await page.waitForSelector('#toolrail-region[data-dock="top"]', { timeout: 5000 });
      await closeSettings(page);
      await blurFocus(page);
      await page.waitForTimeout(400);
    },
  },
  {
    what: 'Renaming a tool, with the Dashicon browser open.',
    async run(page) {
      await openEditor(page, '/wp-admin/post-new.php');
      await seedBlocks(page, 'article');
      await openSettings(page);
      await page.click('.toolrail-settings-pinnedrow[data-block="core/paragraph"] .toolrail-settings-edit');
      await page.waitForSelector('#toolrail-editform', { state: 'visible', timeout: 5000 });
      await page.fill('#toolrail-editform-title', 'Body text');
      await page.click('.toolrail-settings-iconbrowse');
      await page.waitForSelector('#toolrail-iconbrowser', { state: 'visible', timeout: 5000 });
      await page.fill('#toolrail-iconbrowser-search', 'text');
      await page.waitForTimeout(700);
      // The form plus the open icon browser is taller than the dialog's
      // scroller, so say which end of it the shot is of.
      await scrollDialogTo(page, '#toolrail-editform', 10);
    },
  },
  {
    what: 'Toolbar help: what each tool does and every keyboard shortcut.',
    async run(page) {
      await openEditor(page, '/wp-admin/post-new.php');
      await seedBlocks(page, 'article');
      await page.click(tool('help'));
      await page.waitForSelector('.toolrail-help', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(600);
    },
  },
];

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log(`EditRail screenshots — ${BASE} as ${USER}`);

  const browser = await chromium.launch({ headless: !HEADED });
  let snapshot = null;
  let state = null;
  let restore = { ok: false, diffs: ['restore never ran'] };

  try {
    state = await login(browser);

    // Snapshot BEFORE anything is changed, from a plain editor load.
    const snapContext = await browser.newContext({ viewport: VIEWPORT, storageState: state });
    await guardAgainstSaves(snapContext);
    try {
      const page = await snapContext.newPage();
      await page.goto(`${BASE}/wp-admin/post-new.php`, { waitUntil: 'domcontentloaded' });
      await waitForStores(page);
      snapshot = await snapshotPrefs(page);
      BASELINE = snapshot;
      log('Snapshotted rail preferences:');
      RAIL_PREF_KEYS.forEach((k) => {
        if (snapshot.prefs[k] !== null) log(`  ${k} = ${JSON.stringify(snapshot.prefs[k])}`);
      });
      // Only AFTER the snapshot: the restore puts these back too.
      await setEditorChrome(page);
    } finally {
      await snapContext.close();
    }

    for (let i = 0; i < SHOTS.length; i += 1) {
      const shot = SHOTS[i];
      if (ONLY.length && !ONLY.includes(i + 1)) {
        continue;
      }
      const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        storageState: state,
        colorScheme: 'light',
      });
      await guardAgainstSaves(context);
      try {
        const page = await context.newPage();
        await shot.run(page);
        await shoot(page, i + 1, shot.what);
        if (shot.after) {
          // Undo anything the shot changed outside the rail's own
          // preferences, while the page is still alive to write it.
          await shot.after(page);
        }
      } catch (e) {
        log(`  screenshot-${i + 1}.png FAILED — ${e.message}`);
        failedShots.push(`screenshot-${i + 1}.png: ${e.message}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    if (snapshot && state) {
      restore = await restorePrefs(browser, state, snapshot).catch((e) => ({
        ok: false,
        diffs: [`restore threw: ${e.message}`],
      }));
    }
    await browser.close();
  }

  log('');
  if (restore.ok) {
    log('Preferences restored and verified after a reload: the account matches the snapshot.');
  } else {
    log('PREFERENCES NOT RESTORED — fix by hand:');
    restore.diffs.forEach((d) => log(`  ${d}`));
  }
  if (blockedWrites.length) {
    log(`Blocked ${blockedWrites.length} post write(s) — nothing was saved:`);
    [...new Set(blockedWrites)].slice(0, 10).forEach((w) => log(`  ${w}`));
  } else {
    log('No post write was even attempted.');
  }
  if (failedShots.length) {
    // The old file for each of these is still in .wordpress-org/, so a
    // caller that only checks the exit code must not treat the set as
    // regenerated.
    log(`${failedShots.length} screenshot(s) FAILED — the old files are still in place:`);
    failedShots.forEach((f) => log(`  ${f}`));
  }
  process.exit(restore.ok && !failedShots.length ? 0 : 1);
}

main().catch((e) => {
  log(`x ${e.stack || e.message}`);
  process.exit(1);
});
