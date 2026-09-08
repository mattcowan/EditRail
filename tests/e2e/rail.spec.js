/**
 * Editrail — client behavior spec.
 *
 * Everything runs on post-new.php and NEVER saves: armed insertion only
 * touches the unsaved editor state, so no sandbox seeding is needed and the
 * site's content is never written. (The Background Candy sandbox rule
 * applies to specs that SAVE; this one must not.)
 *
 * Requires the plugin ACTIVE on the target site (TOOLRAIL_URL).
 */
const { test, expect } = require('@playwright/test');
const path = require('path');

const AUTH = path.join(__dirname, '.auth', 'admin.json');

test.use({ storageState: AUTH });

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
 * The slot-migration stamp MUST be cleared with the rest: it stops the
 * one-time slot migration from re-running, which is what seeds the
 * defaults — leave it set with the data wiped and the rail comes back
 * empty instead of default. (The local-to-account lift has no stamp of
 * its own — it's a per-key check against the account, safe to re-run.)
 *
 * @param {import('@playwright/test').Page} page Page with the editor loaded.
 * @return {Promise<boolean>} Whether anything was actually stored.
 */
function resetRailPrefs(page) {
  return page.evaluate((keys) => {
    let had = false;
    keys.forEach((k) => {
      if (window.localStorage.getItem(k) !== null) {
        had = true;
      }
      window.localStorage.removeItem(k);
    });
    try {
      const sel = window.wp.data.select('core/preferences');
      const disp = window.wp.data.dispatch('core/preferences');
      keys.forEach((k) => {
        if (sel.get('toolrail', k) !== undefined) {
          had = true;
          disp.set('toolrail', k, undefined);
        }
      });
    } catch (e) {
      /* Store not ready — nothing stored there either, then. */
    }
    return had;
  }, RAIL_PREF_KEYS);
}

/**
 * Leave the shared admin account clean when the run ends.
 *
 * resetRailPrefs runs as SETUP inside openNewPost, which protects each
 * spec from the one before it but leaves the LAST spec's writes stranded
 * in wp_persisted_preferences — server-side user meta, shared with the
 * human's own browser on this site. That is not hypothetical: the
 * corrupt-list spec below is the last in this file, and its `not-json{{{`
 * fixture survived a passing run into the real account, emptying the rail
 * of every pinned tool and making "Restore default tools" refuse to run
 * (diagnosed 2026-08-28). Before pins moved to the account store the
 * damage was confined to the Playwright browser profile; it is not any
 * more, so the suite must clean up after itself.
 *
 * A FRESH context, not the finished test's page: two specs leave
 * Storage.prototype.getItem/setItem throwing, and one swaps in a no-op
 * persistence layer — a reset run in that realm would either throw or
 * write nowhere. One clean editor load costs a few seconds per run.
 *
 * Teardown WRITES the baseline rather than clearing and trusting the slot
 * migration to reseed it, because that reseed happens at boot(), not at
 * clear time. Clearing alone measurably strands the account in the one
 * state the setup comment above warns about — stamp set, slot list gone,
 * so migrateSlots() returns early and the rail renders with no pinned
 * tools at all. (Observed on the first cut of this hook: the boot-race
 * watcher re-stamped while the cleared slot list was what the debounced
 * REST write carried up.) Setting both keys together cannot land
 * half-applied.
 *
 * This is per FILE, which is the right granularity while the suite is one
 * serial spec file. Adding a second file, or parallel mode, would need
 * this to move to a globalTeardown instead — otherwise one worker's
 * cleanup lands mid-test in another.
 */
test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: AUTH });
  try {
    const page = await context.newPage();
    await page.goto('/wp-admin/post-new.php');
    // The store has to be attached before a reset can reach the account.
    await page.waitForFunction(
      () => window.wp && window.wp.data && !!window.wp.data.select('core/preferences'),
      null,
      { timeout: 20000 }
    );
    await resetRailPrefs(page);
    await page.evaluate((keys) => {
      const disp = window.wp.data.dispatch('core/preferences');
      keys.forEach((k) => disp.set('toolrail', k, undefined));
      // DEFAULT_SLOTS, spelled out: the account must end in the state a
      // migrated install is in, not in a half-migrated one — both lift
      // stamps set, or the next boot re-runs a lift.
      disp.set(
        'toolrail',
        'toolrail-quick-slots',
        JSON.stringify(['core/group', 'core/paragraph', 'core/heading', 'core/image'])
      );
      disp.set('toolrail', 'toolrail-slots-migrated', '1');
      disp.set('toolrail', 'toolrail-group-seeded', '1');
    }, RAIL_PREF_KEYS);
    // Give the preferences store's debounced REST write time to land —
    // closing the context first would drop it and leave the account dirty.
    await page.waitForTimeout(3000);

    // Prove it landed in user meta, not just in this page's store: the
    // localStorage cache was cleared above, so a fresh load can only get
    // the pins from the preloaded account preferences.
    await page.reload();
    await expect(page.locator('#toolrail-rail [data-tool^="pin:"]')).toHaveCount(4, {
      timeout: 20000,
    });
  } catch (e) {
    /* Editor unreachable at teardown — report it, do not fail the run. */
    // eslint-disable-next-line no-console
    console.warn('[toolrail] preference teardown did not run:', e.message);
  } finally {
    await context.close();
  }
});

async function openNewPost(page) {
  await page.goto('/wp-admin/post-new.php');

  const hadState = await resetRailPrefs(page);
  if (hadState) {
    await page.reload();
  }

  // Dismiss the welcome guide when present.
  const closeModal = page.locator('.components-modal__header button[aria-label="Close"]');
  try {
    await closeModal.waitFor({ state: 'visible', timeout: 4000 });
    await closeModal.click();
  } catch (e) {
    /* No modal — fine. */
  }

  await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
}

function canvas(page) {
  return page.frameLocator('iframe[name="editor-canvas"]');
}

/**
 * Click the canvas in the EMPTY space below everything already laid out
 * (title and blocks), measured live — never at a fixed pixel. Fixed
 * coordinates encode one theme's layout: y=400 was empty space under
 * Background Candy's title on mnc4.local and landed ON the title/first
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

test.describe('rail chrome + APG toolbar', () => {
  test('mounts with toolbar semantics and a navigable region', async ({ page }) => {
    await openNewPost(page);

    const rail = page.locator('#toolrail-rail');
    await expect(rail).toHaveAttribute('role', 'toolbar');
    await expect(rail).toHaveAttribute('aria-orientation', 'vertical');

    const region = page.locator('#toolrail-region');
    await expect(region).toHaveAttribute('role', 'region');
    await expect(region).toHaveClass(/interface-navigable-region/);

    // Select is the default armed tool.
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveAttribute('aria-pressed', 'false');
  });

  test('one tab stop; arrows, Home and End move focus', async ({ page }) => {
    await openNewPost(page);

    const stops = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#toolrail-rail .toolrail-tool'))
        .filter((b) => b.tabIndex === 0).length
    );
    expect(stops).toBe(1);

    await page.locator('#toolrail-rail [data-tool="select"]').focus();
    await page.keyboard.press('ArrowDown');
    // Group leads the pinned slots (it was the built-in Section tool
    // until 0.1.22; owner decision 2026-09-02).
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('pin:core/group');
    await page.keyboard.press('End');
    const last = await page.evaluate(() => document.activeElement.dataset.tool);
    expect(last).toBeTruthy();
    // Home lands on the first toolbar control — Select, because the
    // wide-mode chevron is OPT-IN (0.1.12) and absent from a default
    // rail. The opted-in arrangement is pinned in the wide-mode suite.
    await page.keyboard.press('Home');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('select');
  });

  test('survives list view and the code-editor round-trip', async ({ page }) => {
    await openNewPost(page);

    const listView = page.locator('button[aria-label="Document Overview"]');
    if (await listView.count()) {
      await listView.click();
      await expect(page.locator('#toolrail-rail')).toBeVisible();
      await listView.click();
    }

    // Code editor and back — the whole visual editor unmounts.
    await page.keyboard.press('Control+Shift+Alt+M');
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+Shift+Alt+M');
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 10000 });
  });
});

test.describe('armed-tool insertion', () => {
  test('arm Text, click canvas: paragraph inserted, tool returns to Select', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').click();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'false');

    await clickBelowContent(page);

    // EXACTLY one block. `toContain` used to pass here while core's own
    // "click empty space to start a paragraph" behaviour quietly added a
    // second, empty one alongside the inserted block — the assertion could
    // not tell the stray from the real insert because both were paragraphs.
    await expect.poll(async () => await blockNames(page)).toEqual(['core/paragraph']);
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveAttribute('aria-pressed', 'false');
  });

  test('Shift-click keeps the tool armed for repeat inserts', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    await clickBelowContent(page, { modifiers: ['Shift'] });
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/heading"]')).toHaveAttribute('aria-pressed', 'true');

    // Measured again: the first insert moved the bottom edge.
    await clickBelowContent(page);
    // Two headings and NOTHING else: filtering to core/heading before
    // counting used to hide any stray core added on the way.
    await expect.poll(async () => await blockNames(page)).toEqual(['core/heading', 'core/heading']);
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('Escape in the canvas disarms back to Select', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="pin:core/group"]').click();
    await canvas(page).locator('body').press('Escape');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('tool flyouts', () => {
  // The Shape tool — the only built-in flyout — is shelved with Phase 4,
  // so the flyout machinery is exercised the way a provider reaches it:
  // a registered tool nested under a pinned slot.
  test('ArrowRight opens a pinned parent\'s flyout, Escape returns focus, picking arms and inserts', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => {
      window.toolrail.registerTool({
        id: 'e2e-flyout-child',
        label: 'E2E Flyout Child',
        parent: 'text',
        insertBlock: 'core/quote',
      });
    });

    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').focus();
    await page.keyboard.press('ArrowRight');

    const flyout = page.locator('.toolrail-flyout');
    await expect(flyout).toBeVisible();
    await expect(flyout).toHaveAttribute('role', 'menu');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('e2e-flyout-child');

    await page.keyboard.press('Escape');
    await expect(flyout).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('pin:core/paragraph');

    // Pick the child: the parent lights (a child is armed), the canvas
    // click inserts the child's block.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveAttribute('aria-pressed', 'true');
    await clickBelowContent(page);
    expect(await blockNames(page)).toContain('core/quote');
  });

  test('the Shape tool is shelved: not rendered, its id still reserved', async ({ page }) => {
    await openNewPost(page);

    await expect(page.locator('#toolrail-rail [data-tool="shape"]')).toHaveCount(0);

    // The id stays reserved so a provider cannot squat on it before
    // Phase 4 reclaims the tool.
    const refused = await page.evaluate(() =>
      window.toolrail.registerTool({ id: 'shape', onActivate: () => {} })
    );
    expect(refused).toBe(false);
    const childRefused = await page.evaluate(() =>
      window.toolrail.registerTool({ id: 'shape-circle', onActivate: () => {} })
    );
    expect(childRefused).toBe(false);
  });
});

test.describe('quick slots', () => {
  test('Group, Text, Heading and Image ship as default, reorderable pinned slots', async ({ page }) => {
    await openNewPost(page);

    // Fresh state (openNewPost cleared the key): the four defaults in
    // order, Group first where the built-in Section tool sat until
    // 0.1.22. Shape is shelved with Phase 4 and must not render; the
    // Section overview does.
    const order = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#toolrail-rail .toolrail-tool')).map((b) => b.dataset.tool)
    );
    expect(order.slice(0, 5)).toEqual(['select', 'pin:core/group', 'pin:core/paragraph', 'pin:core/heading', 'pin:core/image']);
    expect(order).toContain('overview');
    expect(order).not.toContain('shape');

    // Defaults are ordinary slots: reorder Heading above Text.
    await page.evaluate(() => window.toolrail.moveSlot('core/heading', -1));
    const reordered = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#toolrail-rail .toolrail-tool')).map((b) => b.dataset.tool)
    );
    expect(reordered.slice(2, 4)).toEqual(['pin:core/heading', 'pin:core/paragraph']);
  });

  test('unpin and re-pin via the block menu, persist across reload, settings Remove unpins', async ({ page }) => {
    await openNewPost(page);

    // Insert a paragraph to have a block whose menu we can open.
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').click();
    await clickBelowContent(page);

    // A dispatched selectBlock() gives no DOM focus, and Gutenberg hides the
    // floating toolbar for an EMPTY placeholder paragraph entirely — so do
    // what an author does: click into the block, give it content, then enter
    // navigation mode (Escape), which summons the block toolbar.
    await canvas(page).locator('[data-block]').last().click();
    await page.keyboard.type('Pin me');
    await page.keyboard.press('Escape');

    // Paragraph is DEFAULT-pinned, so the menu offers Unpin first — the
    // keyboard path works in both directions.
    await page.locator('.block-editor-block-toolbar button[aria-label="Options"]').click();
    await page.locator('.components-menu-item__button, .components-menu-item__item', { hasText: 'Unpin from toolbar' }).first().click();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await page.locator('.block-editor-block-toolbar button[aria-label="Options"]').click();
    await page.locator('.components-menu-item__button, .components-menu-item__item', { hasText: 'Pin to toolbar' }).first().click();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toBeVisible();

    // Persists (localStorage) across a PLAIN reload — openNewPost would
    // deliberately wipe the state this assertion exists to observe.
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toBeVisible();

    // Removal is deliberate-only (owner decision 2026-08-26): the on-rail
    // hover × and Delete key are GONE — Delete on a focused slot must be
    // inert, and unpinning goes through the settings dialog's Remove.
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').focus();
    await page.keyboard.press('Delete');
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toBeVisible();
    expect(await page.evaluate(() =>
      document.querySelector('#toolrail-rail [data-tool="pin:core/paragraph"] .toolrail-slot-remove')
    )).toBeNull();

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('.toolrail-settings-pinnedrow[data-block="core/paragraph"] .toolrail-settings-remove').click();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveCount(0);
    expect(await getPref(page, 'toolrail-quick-slots')).not.toContain('core/paragraph');
  });

  test('a pinned core block renders a visible icon (viewBox-only SVGs get sized)', async ({ page }) => {
    await openNewPost(page);

    // core/cover's @wordpress/icons SVG has NO width/height attributes —
    // it measured 0×0 and the slot looked empty until the CSS sized it.
    await page.evaluate(() => window.toolrail.pinBlock('core/cover'));
    const size = await page.evaluate(() => {
      const svg = document.querySelector('#toolrail-rail [data-tool="pin:core/cover"] .toolrail-tool-icon svg');
      if (!svg) { return null; }
      const r = svg.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    expect(size).toEqual({ w: 24, h: 24 });
  });
});

test.describe('saved-set import/export', () => {
  test('export downloads the set as JSON; import restores it, name-deduped', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-setname').fill('travel kit');
    await page.locator('.toolrail-settings-saveset').click();

    const downloadPromise = page.waitForEvent('download');
    await page.locator('.toolrail-settings-setrow[data-config="travel kit"] .toolrail-settings-export').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('toolrail-set-travel-kit.json');

    const fs = require('fs');
    const tmp = path.join(__dirname, '.auth', 'exported-set.json');
    await download.saveAs(tmp);
    const payload = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    fs.unlinkSync(tmp);
    expect(payload.format).toBe('toolrail-set');
    expect(payload.name).toBe('travel kit');
    expect(payload.blocks).toEqual(['core/group', 'core/paragraph', 'core/heading', 'core/image']);

    // Import the same payload back: the existing name gets a suffix
    // instead of silently overwriting.
    await page.locator('#toolrail-settings-import').setInputFiles({
      name: 'toolrail-set-travel-kit.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(payload)),
    });
    await expect(page.locator('.toolrail-settings-setrow[data-config="travel kit (2)"]')).toBeVisible();
    await expect(page.locator('#toolrail-settings-status')).toContainText('Imported "travel kit (2)" (4 blocks).');
  });

  test('a set with blocks this site does not register imports and loads gracefully', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-import').setInputFiles({
      name: 'other-theme-set.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        format: 'toolrail-set',
        version: 1,
        name: 'other theme',
        blocks: ['core/quote', 'othertheme/fancy-hero', 'not a block name'],
      })),
    });

    // 1 kept-but-unavailable block, 1 invalid entry dropped, both said in text.
    const status = page.locator('#toolrail-settings-status');
    await expect(status).toContainText('Imported "other theme" (2 blocks).');
    await expect(status).toContainText('1 of them is not available on this site');
    await expect(status).toContainText('1 invalid entry was ignored');

    // Loading it: the unknown block is KEPT in storage but not rendered.
    await page.locator('.toolrail-settings-setrow[data-config="other theme"] .toolrail-settings-load').click();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/quote"]')).toBeVisible();
    await expect(page.locator('#toolrail-rail [data-tool="pin:othertheme/fancy-hero"]')).toHaveCount(0);
    expect(await getPref(page, 'toolrail-quick-slots')).toContain('othertheme/fancy-hero');
    await expect(status).toContainText('not available on this site');
  });

  test('a malformed file is refused with a message, not a throw', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-import').setInputFiles({
      name: 'not-json.json',
      mimeType: 'application/json',
      buffer: Buffer.from('this is not json'),
    });
    await expect(page.locator('#toolrail-settings-status')).toContainText('not valid JSON');

    await page.locator('#toolrail-settings-import').setInputFiles({
      name: 'wrong-shape.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ hello: 'world' })),
    });
    await expect(page.locator('#toolrail-settings-status')).toContainText('expected JSON with a "blocks" array');
  });
});

test.describe('toolbar settings dialog', () => {
  test('reordering keeps focus inside the dialog, even at the ends', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => {
      window.toolrail.pinBlock('core/paragraph');
      window.toolrail.pinBlock('core/quote');
    });
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await expect(page.locator('.toolrail-settings')).toBeVisible();

    // Moving the second row up disables the ↑ it was clicked with. Focus
    // must not fall out of the dialog onto the rail behind it.
    await page.locator('.toolrail-settings-pinnedrow[data-block="core/quote"] .toolrail-settings-up').click();

    const focusInDialog = await page.evaluate(() => {
      const dialog = document.querySelector('.toolrail-settings');
      return !!dialog && dialog.contains(document.activeElement)
        && !document.activeElement.disabled;
    });
    expect(focusInDialog).toBe(true);

    await page.evaluate(() => {
      window.toolrail.unpinBlock('core/paragraph');
      window.toolrail.unpinBlock('core/quote');
    });
  });

  test('a half-typed set name survives an update from elsewhere', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-setname').fill('my layout');

    // Pinning from outside the dialog rebuilds its content.
    await page.evaluate(() => window.toolrail.pinBlock('core/quote'));

    await expect(page.locator('#toolrail-settings-setname')).toHaveValue('my layout');
    await page.evaluate(() => window.toolrail.unpinBlock('core/quote'));
  });

  test('a set named __proto__ actually saves', async ({ page }) => {
    await openNewPost(page);

    const result = await page.evaluate(() => {
      window.toolrail.pinBlock('core/quote');
      const returned = window.toolrail.saveConfig('__proto__');
      const configs = window.toolrail.getConfigs();
      window.toolrail.unpinBlock('core/quote');
      return {
        returned,
        // Control: a normal name proves the read-back path itself works.
        normalStores: (window.toolrail.saveConfig('normal name'),
          Object.prototype.hasOwnProperty.call(window.toolrail.getConfigs(), 'normal name')),
        protoStores: Object.prototype.hasOwnProperty.call(configs, '__proto__'),
      };
    });

    expect(result.normalStores).toBe(true);
    expect(result.returned).toBe(true);
    // saveConfig used to return true while silently storing nothing.
    expect(result.protoStores).toBe(true);

    await page.evaluate(() => {
      window.toolrail.deleteConfig('__proto__');
      window.toolrail.deleteConfig('normal name');
    });
  });

  test('sections are divided, Pinned tools precedes Add a block or pattern, and new pins land at the bottom', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await expect(page.locator('.toolrail-settings')).toBeVisible();

    // The standard: an <hr> between each top-level section (position /
    // tool names / appearance / blocks / saved sets / help).
    const dividers = await page.locator('.toolrail-settings .toolrail-settings-divider').count();
    expect(dividers).toBeGreaterThanOrEqual(5);

    // Pinned blocks (what is on the toolbar) reads ABOVE the search
    // that adds to it — the two belong together, in that order (owner
    // decision 2026-08-27).
    const orderOk = await page.evaluate(() => {
      const heads = Array.from(document.querySelectorAll('.toolrail-settings .toolrail-settings-subtitle'));
      const pinnedHead = heads.find((h) => h.textContent === 'Pinned tools');
      const searchLabel = document.querySelector('label[for="toolrail-settings-search"]');
      return !!(pinnedHead && searchLabel)
        && !!(pinnedHead.compareDocumentPosition(searchLabel) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(orderOk).toBe(true);

    // A newly pinned block appends at the BOTTOM of the pinned list,
    // right above the search that added it.
    await page.locator('#toolrail-settings-search').fill('Quote');
    await page.locator('.toolrail-settings-result[data-block="core/quote"]').click();
    const lastRow = await page.evaluate(() => {
      const rows = document.querySelectorAll('.toolrail-settings-pinnedrow');
      return rows[rows.length - 1].dataset.block;
    });
    expect(lastRow).toBe('core/quote');
  });

  test('the gear is not left claiming an open dialog after a remount', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await expect(page.locator('#toolrail-rail [data-tool="settings"]')).toHaveAttribute('aria-expanded', 'true');

    // Destroy the region the way a React re-render does. (The code-editor
    // round-trip does NOT reliably do this — the region hangs off the
    // skeleton BODY, which that toggle leaves standing — so drive the
    // condition directly instead of hoping a UI gesture produces it.)
    // The MutationObserver rebuilds the rail; the rebuilt gear must not
    // still be advertising a dialog that went away with the old region.
    await page.evaluate(() => document.getElementById('toolrail-region').remove());
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 10000 });

    await expect(page.locator('.toolrail-settings')).toHaveCount(0);
    await expect(page.locator('#toolrail-rail [data-tool="settings"]')).toHaveAttribute('aria-expanded', 'false');

    // And ONE click reopens it, rather than the first click being eaten by
    // a closeSettings() call against a node that is already gone.
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await expect(page.locator('.toolrail-settings')).toBeVisible();
  });
});

test.describe('rail position', () => {
  test('defaults to the left edge, before the canvas', async ({ page }) => {
    await openNewPost(page);

    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'left');
    expect(await page.evaluate(() => window.toolrail.getDock())).toBe('left');

    // Left dock = first child of the skeleton body, so the canvas reflows
    // beside the rail instead of being overlapped.
    const isFirstChild = await page.evaluate(() => {
      const body = document.querySelector('.interface-interface-skeleton__body');
      return body.firstElementChild.id === 'toolrail-region';
    });
    expect(isFirstChild).toBe(true);
  });

  test('docking right moves the rail past the settings side panel', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => window.toolrail.setDock('right'));
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'right');

    const placement = await page.evaluate(() => {
      const body = document.querySelector('.interface-interface-skeleton__body');
      const region = document.getElementById('toolrail-region');
      const sidebar = body.querySelector('.interface-interface-skeleton__sidebar');
      return {
        isLastChild: body.lastElementChild.id === 'toolrail-region',
        // DOCUMENT_POSITION_PRECEDING === the sidebar comes before the rail.
        afterSidebar: sidebar
          ? !!(region.compareDocumentPosition(sidebar) & Node.DOCUMENT_POSITION_PRECEDING)
          : null,
      };
    });
    expect(placement.isLastChild).toBe(true);
    if (placement.afterSidebar !== null) {
      expect(placement.afterSidebar).toBe(true);
    }

    // Still a vertical toolbar, and still fully operable.
    await expect(page.locator('#toolrail-rail')).toHaveAttribute('aria-orientation', 'vertical');
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').click();
    await clickBelowContent(page);
    expect(await blockNames(page)).toContain('core/paragraph');
  });

  test('docking top turns the rail horizontal and swaps the arrow axis', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => window.toolrail.setDock('top'));
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'top');
    await expect(page.locator('#toolrail-rail')).toHaveAttribute('aria-orientation', 'horizontal');

    // A top bar lives in the skeleton's flex COLUMN, directly before the body.
    const beforeBody = await page.evaluate(() => {
      const region = document.getElementById('toolrail-region');
      return region.nextElementSibling
        && region.nextElementSibling.classList.contains('interface-interface-skeleton__body');
    });
    expect(beforeBody).toBe(true);

    // APG: a horizontal toolbar moves on Left/Right, not Up/Down.
    await page.locator('#toolrail-rail [data-tool="select"]').focus();
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('pin:core/group');
    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('select');
  });

  test('a top rail opens its flyouts downward; a bottom rail upward', async ({ page }) => {
    await openNewPost(page);

    // Shape is shelved, so the flyout rides a registered child on the
    // pinned Text slot.
    await page.evaluate(() => {
      window.toolrail.registerTool({
        id: 'e2e-dock-child',
        label: 'E2E Dock Child',
        parent: 'text',
        insertBlock: 'core/quote',
      });
    });

    // Top: ArrowDown is the flyout key when the rail is horizontal, and the
    // menu must sit BELOW the rail.
    await page.evaluate(() => window.toolrail.setDock('top'));
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.toolrail-flyout')).toBeVisible();

    let opensDown = await page.evaluate(() => {
      const rail = document.getElementById('toolrail-rail').getBoundingClientRect();
      const menu = document.querySelector('.toolrail-flyout').getBoundingClientRect();
      return menu.top >= rail.bottom - 1;
    });
    expect(opensDown).toBe(true);
    await page.keyboard.press('Escape');

    // Bottom: same rail, mirrored.
    await page.evaluate(() => window.toolrail.setDock('bottom'));
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'bottom');
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.toolrail-flyout')).toBeVisible();

    const opensUp = await page.evaluate(() => {
      const rail = document.getElementById('toolrail-rail').getBoundingClientRect();
      const menu = document.querySelector('.toolrail-flyout').getBoundingClientRect();
      return menu.bottom <= rail.top + 1;
    });
    expect(opensUp).toBe(true);
  });

  test('floating detaches the rail and persists across a reload', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => window.toolrail.setDock('float'));
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'float');

    const floated = await page.evaluate(() => {
      const region = document.getElementById('toolrail-region');
      return window.getComputedStyle(region).position;
    });
    expect(floated).toBe('absolute');

    // Position is a persisted per-user preference: it survives a reload.
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'float');
    expect(await page.evaluate(() => window.toolrail.getDock())).toBe('float');
  });

  test('dragging the grip tears the rail off and snaps it to an edge', async ({ page }) => {
    await openNewPost(page);

    const result = await page.evaluate(() => {
      const grip = document.querySelector('.toolrail-grip');
      const g = grip.getBoundingClientRect();
      const body = document.querySelector('.interface-interface-skeleton__body').getBoundingClientRect();
      const fire = (el, type, x, y) => el.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
      );

      fire(grip, 'mousedown', g.left + 6, g.top + 6);
      fire(document, 'mousemove', 400, 400);
      const afterTear = window.toolrail.getDock();

      fire(document, 'mousemove', 400, Math.round(body.top) + 10);
      const hasPreview = !!document.getElementById('toolrail-snap-preview');

      fire(document, 'mouseup', 400, Math.round(body.top) + 10);
      return {
        afterTear,
        hasPreview,
        afterDrop: window.toolrail.getDock(),
        previewCleanedUp: !document.getElementById('toolrail-snap-preview'),
        bodyClean: !document.body.classList.contains('toolrail-dragging'),
      };
    });

    expect(result.afterTear).toBe('float');   // first move detaches it
    expect(result.hasPreview).toBe(true);     // the snap band appears
    expect(result.afterDrop).toBe('top');     // released near the top edge
    expect(result.previewCleanedUp).toBe(true);
    expect(result.bodyClean).toBe(true);
    await expect(page.locator('#toolrail-rail')).toHaveAttribute('aria-orientation', 'horizontal');
  });

  test('Escape during a drag puts the rail back where it started', async ({ page }) => {
    await openNewPost(page);

    const result = await page.evaluate(() => {
      const grip = document.querySelector('.toolrail-grip');
      const g = grip.getBoundingClientRect();
      const fire = (el, type, x, y) => el.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
      );

      fire(grip, 'mousedown', g.left + 6, g.top + 6);
      fire(document, 'mousemove', 500, 400);
      const midDrag = window.toolrail.getDock();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return {
        midDrag,
        afterEscape: window.toolrail.getDock(),
        previewCleanedUp: !document.getElementById('toolrail-snap-preview'),
        bodyClean: !document.body.classList.contains('toolrail-dragging'),
      };
    });

    expect(result.midDrag).toBe('float');
    expect(result.afterEscape).toBe('left');
    expect(result.previewCleanedUp).toBe(true);
    expect(result.bodyClean).toBe(true);
  });

  test('a LEFT-docked surface renders in front of the Document Overview panel', async ({ page }) => {
    await openNewPost(page);

    // Core stacks the SECONDARY sidebar at the same z-index: 100000 as the
    // settings one, and a left rail opens its surfaces rightward — straight
    // over it. This is the case a per-dock z-index rule missed.
    const listView = page.locator('button[aria-label="Document Overview"]');
    test.skip(!(await listView.count()), 'no Document Overview button in this editor');
    await listView.click();
    await expect(page.locator('.interface-interface-skeleton__secondary-sidebar')).toBeVisible();

    await page.locator('#toolrail-rail [data-tool="settings"]').click();

    const result = await page.evaluate(() => {
      const dlg = document.querySelector('.toolrail-settings');
      const sec = document.querySelector('.interface-interface-skeleton__secondary-sidebar');
      const d = dlg.getBoundingClientRect();
      const s = sec.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(d.left + d.width / 2), Math.round(d.top + 40));
      return {
        // Guard the guard: if these stopped overlapping, a pass would prove nothing.
        overlaps: !(d.right <= s.left || d.left >= s.right),
        topmostIsDialog: !!(hit && dlg.contains(hit)),
      };
    });

    expect(result.overlaps).toBe(true);
    expect(result.topmostIsDialog).toBe(true);

    // Put the panel back. Gutenberg persists the Document Overview's open
    // state in user preferences on the SERVER, so leaving it open leaks out
    // of this spec and into every later run against the same account.
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await listView.click();
    await expect(page.locator('.interface-interface-skeleton__secondary-sidebar')).toHaveCount(0);
  });

  test('a floating palette cannot be parked under the publish footer', async ({ page }) => {
    await openNewPost(page);

    const result = await page.evaluate(() => {
      window.toolrail.setDock('float');
      const region = document.getElementById('toolrail-region');
      const grip = document.querySelector('.toolrail-grip');
      const g = grip.getBoundingClientRect();
      const fire = (el, type, x, y) => el.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
      );

      // Drag it as far down as the pointer can go; the clamp decides where
      // it lands. clientHeight alone would allow it into the padding core
      // reserves for the overlaying footer.
      fire(grip, 'mousedown', g.left + 6, g.top + 6);
      fire(document, 'mousemove', 400, 400);
      fire(document, 'mousemove', 400, 5000);

      const box = region.getBoundingClientRect();
      const footer = document.querySelector('.interface-interface-skeleton__footer');
      const out = {
        hasFooter: !!footer,
        clearsFooter: footer ? box.bottom <= footer.getBoundingClientRect().top + 1 : true,
      };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return out;
    });

    expect(result.hasFooter).toBe(true);
    expect(result.clearsFooter).toBe(true);
  });

  test('the raised rail drops below an open modal, and comes back after', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => window.toolrail.setDock('float'));
    await expect(page.locator('#toolrail-region')).toHaveClass(/is-raised/);

    // Core puts .components-modal__screen-overlay at the SAME z-index as
    // the side panels, so anything that statically beats the panels also
    // covers every modal — including the media library the Image tool opens.
    await page.locator('button[aria-label="Options"]').click();
    await page.getByRole('menuitem', { name: 'Preferences' }).click();
    await expect(page.locator('.components-modal__screen-overlay')).toBeVisible();

    // Assert the STACKING, not the is-raised class: the stylesheet vetoes
    // the raise synchronously while the class may still be set for the
    // moment it takes the observer to catch up. What has to hold is that
    // the rail is not on top of the modal.
    const underModal = await page.evaluate(() => {
      const region = document.getElementById('toolrail-region');
      const rb = region.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(rb.left + rb.width / 2), Math.round(rb.top + 60));
      return {
        effectiveZ: window.getComputedStyle(region).zIndex,
        railIsTopmost: !!(hit && region.contains(hit)),
      };
    });
    expect(underModal.railIsTopmost).toBe(false);
    expect(underModal.effectiveZ).toBe('30');

    // ...and the veto is not sticky: closing the modal restores the raise.
    await page.keyboard.press('Escape');
    await expect(page.locator('.components-modal__screen-overlay')).toHaveCount(0);
    const afterZ = await page.evaluate(() =>
      window.getComputedStyle(document.getElementById('toolrail-region')).zIndex
    );
    expect(afterZ).toBe('100001');
  });

  test('a docked surface renders in front of the settings side panel', async ({ page }) => {
    await openNewPost(page);

    // From the right dock the settings dialog opens leftward, straight over
    // core's side panel — which carries z-index: 100000.
    await page.evaluate(() => window.toolrail.setDock('right'));
    await page.locator('#toolrail-rail [data-tool="settings"]').click();

    const topmostIsDialog = await page.evaluate(() => {
      const dlg = document.querySelector('.toolrail-settings');
      const d = dlg.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(d.left + d.width / 2), Math.round(d.top + 40));
      return !!(hit && dlg.contains(hit));
    });
    expect(topmostIsDialog).toBe(true);
  });

  test('a bottom rail is not covered by the publish footer', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => window.toolrail.setDock('bottom'));

    // Core sizes __editor to the whole skeleton and lets the footer overlay
    // it, reserving room on __body alone — a bottom bar has to reserve its
    // own or the footer sits on top of it.
    const clearsFooter = await page.evaluate(() => {
      const region = document.getElementById('toolrail-region').getBoundingClientRect();
      const footer = document.querySelector('.interface-interface-skeleton__footer');
      if (!footer) { return true; }
      return region.bottom <= footer.getBoundingClientRect().top + 1;
    });
    expect(clearsFooter).toBe(true);
  });

  test('the settings dialog offers a keyboard path for every dock', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await expect(page.locator('.toolrail-settings')).toBeVisible();

    const radios = page.locator('.toolrail-settings-position input[type="radio"]');
    await expect(radios).toHaveCount(5);
    await expect(page.locator('.toolrail-settings-position input[data-dock="left"]')).toBeChecked();

    // Choosing a dock moves the rail and keeps the dialog open on that radio.
    await page.locator('.toolrail-settings-position input[data-dock="bottom"]').check();
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'bottom');
    await expect(page.locator('.toolrail-settings')).toBeVisible();
    expect(await page.evaluate(() => document.activeElement.dataset.dock)).toBe('bottom');
  });
});

test.describe('registration API', () => {
  test('registerTool renders a third-party tool; onActivate runs', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => {
      window.__e2eActivated = false;
      window.toolrail.registerTool({
        id: 'e2e-tool',
        label: 'E2E Tool',
        onActivate: () => { window.__e2eActivated = true; },
      });
    });

    const btn = page.locator('#toolrail-rail [data-tool="e2e-tool"]');
    await expect(btn).toBeVisible();
    await btn.click();
    expect(await page.evaluate(() => window.__e2eActivated)).toBe(true);
  });

  test('parent: "text" lands the tool in the Text flyout', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => {
      window.toolrail.registerTool({
        id: 'e2e-child',
        label: 'E2E Child',
        parent: 'text',
        insertBlock: 'core/quote',
      });
    });

    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.toolrail-flyout [data-tool="e2e-child"]')).toBeVisible();

    // Activating the child arms it; canvas click inserts its block.
    await page.locator('.toolrail-flyout [data-tool="e2e-child"]').click();
    await clickBelowContent(page);
    expect(await blockNames(page)).toContain('core/quote');
  });

  test('a toggle child renders as a checked menu item', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => {
      window.__e2eSnap = true;
      window.toolrail.registerTool({
        id: 'e2e-parent',
        label: 'E2E Parent',
        onActivate: () => {},
      });
      window.toolrail.registerTool({
        id: 'e2e-toggle',
        label: 'E2E Toggle',
        parent: 'e2e-parent',
        onActivate: () => { window.__e2eSnap = !window.__e2eSnap; },
        isActive: () => window.__e2eSnap,
      });
      window.toolrail.registerTool({
        id: 'e2e-plain',
        label: 'E2E Plain',
        parent: 'e2e-parent',
        onActivate: () => {},
      });
    });

    await page.locator('#toolrail-rail [data-tool="e2e-parent"]').focus();
    await page.keyboard.press('ArrowRight');
    const toggle = page.locator('.toolrail-flyout [data-tool="e2e-toggle"]');
    await expect(toggle).toHaveAttribute('role', 'menuitemcheckbox');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // Control: a child without isActive stays a plain menuitem.
    const plain = page.locator('.toolrail-flyout [data-tool="e2e-plain"]');
    await expect(plain).toHaveAttribute('role', 'menuitem');
    await expect(plain).not.toHaveAttribute('aria-checked', /.*/);

    // Activating flips it; the next open reads the new state.
    await toggle.click();
    await expect(page.locator('.toolrail-flyout')).toHaveCount(0);
    await page.locator('#toolrail-rail [data-tool="e2e-parent"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.toolrail-flyout [data-tool="e2e-toggle"]')).toHaveAttribute('aria-checked', 'false');
  });

  test('malformed descriptors are refused', async ({ page }) => {
    await openNewPost(page);

    const results = await page.evaluate(() => [
      window.toolrail.registerTool({ label: 'no id', onActivate: () => {} }),
      window.toolrail.registerTool({ id: 'no-action' }),
      window.toolrail.registerTool('not-an-object'),
    ]);
    expect(results).toEqual([false, false, false]);
    await expect(page.locator('#toolrail-rail [data-tool="no-action"]')).toHaveCount(0);
  });

  test('an id that would break an attribute selector is refused, not thrown', async ({ page }) => {
    await openNewPost(page);

    // The id is interpolated into [data-tool="…"] all over the rail. A
    // quote used to escape registerTool as a SyntaxError instead of the
    // documented false, taking the aria-pressed sweep down with it.
    const outcome = await page.evaluate(() => {
      try {
        return { returned: window.toolrail.registerTool({ id: 'bad"id', onActivate: () => {} }) };
      } catch (e) {
        return { threw: e.message };
      }
    });
    expect(outcome).toEqual({ returned: false });

    // Control: the same descriptor with a clean id IS accepted, so the
    // rejection above is about the id and not about the descriptor shape.
    const control = await page.evaluate(() =>
      window.toolrail.registerTool({ id: 'clean-id', onActivate: () => {} })
    );
    expect(control).toBe(true);
    await expect(page.locator('#toolrail-rail [data-tool="clean-id"]')).toBeVisible();

    // The rail is still painting pressed state — the sweep survived.
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').click();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveAttribute('aria-pressed', 'true');
  });
});

/**
 * The two extension hooks added for the guides plugin (0.1.21). Both are
 * read-mostly; the prefs test writes ONE namespaced key, which the shared
 * admin account then carries — harmless, and the key is the test's own.
 */
test.describe('extension hooks', () => {
  test('prefs accepts only toolrail-ext: keys and string values', async ({ page }) => {
    await openNewPost(page);

    const results = await page.evaluate(() => {
      const p = window.toolrail.prefs;
      return {
        badGet: p.get('toolrail-quick-slots'),
        badSet: p.set('toolrail-quick-slots', '[]'),
        emptyPrefix: p.set('toolrail-ext:', 'x'),
        nonString: p.set('toolrail-ext:e2e:num', 1),
        goodSet: p.set('toolrail-ext:e2e:key', 'value-' + 1),
        goodGet: p.get('toolrail-ext:e2e:key'),
        unset: p.get('toolrail-ext:e2e:never-written'),
      };
    });
    expect(results).toEqual({
      badGet: null,
      badSet: false,
      emptyPrefix: false,
      nonString: false,
      goodSet: true,
      goodGet: 'value-1',
      unset: null,
    });
    // It landed in the same store, under the same scope, as the rail's
    // own keys — the fold-in promise ("stored keys do not change").
    expect(await getPref(page, 'toolrail-ext:e2e:key')).toBe('value-1');
    // Control: the refused write did not touch the rail's key.
    expect(await getPref(page, 'toolrail-quick-slots')).not.toBe('[]');
  });

  test('getCanvasGeometry tracks the canvas frame in edit and overview modes', async ({ page }) => {
    await openNewPost(page);

    const edit = await page.evaluate(() => {
      const g = window.toolrail.getCanvasGeometry();
      const f = document.querySelector('iframe[name="editor-canvas"]').getBoundingClientRect();
      return { g, frame: { left: f.left, top: f.top, width: f.width, height: f.height } };
    });
    expect(edit.g.mode).toBe('edit');
    expect(edit.g.scale).toBeCloseTo(1, 3);
    expect(edit.g.pan).toBe(0);
    expect(edit.g.scrollY).toBe(0);
    expect(edit.g.frameRect).toEqual(edit.frame);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    const overview = await page.evaluate(() => {
      const g = window.toolrail.getCanvasGeometry();
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const f = frame.getBoundingClientRect();
      return { g, ratio: f.width / frame.offsetWidth, width: f.width };
    });
    expect(overview.g.mode).toBe('overview');
    expect(overview.g.scale).toBeCloseTo(overview.ratio, 3);
    expect(overview.g.scale).toBeLessThanOrEqual(1);
    expect(overview.g.frameRect.width).toBeCloseTo(overview.width, 3);
  });
});

/**
 * Regressions found by driving the editor by hand (2026-08-26). Each test
 * here failed before its fix; the block-count assertions in
 * 'armed-tool insertion' were tightened in the same pass, because the
 * originals could not see the stray-block bug at all.
 */
test.describe('regressions', () => {
  test('an armed insert into empty space leaves no stray empty paragraph', async ({ page }) => {
    await openNewPost(page);

    // A known one-block document, so the count after the click is exact.
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data
        .dispatch('core/block-editor')
        .resetBlocks([createBlock('core/paragraph', { content: 'ALPHA' })]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(1);

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    await clickBelowContent(page, { gap: 120 });

    // Before the fix: ['core/paragraph', 'core/paragraph', 'core/heading'].
    // Core appends its default block on a click below the content, and the
    // preventDefault/stopPropagation in handleCanvasClick does not stop it.
    await expect.poll(async () => await blockNames(page)).toEqual([
      'core/paragraph',
      'core/heading',
    ]);
  });

  test('an insert ON an existing block still lands at the click point', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/paragraph', { content: 'ALPHA' }),
        createBlock('core/paragraph', { content: 'BETA' }),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(2);

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    // Top half of BETA inserts before it. The stray sweep must not disturb
    // a click that landed on a real block.
    await canvas(page).locator('p:has-text("BETA")').click({ position: { x: 20, y: 3 } });

    await expect.poll(async () => await blockNames(page)).toEqual([
      'core/paragraph',
      'core/heading',
      'core/paragraph',
    ]);
  });

  test('Tab out of the settings dialog closes it', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    const dialog = page.locator('.toolrail-settings');
    await expect(dialog).toBeVisible();

    // Walk to the last control in the dialog, then one Tab past it.
    await page.evaluate(() => {
      const dlg = document.querySelector('.toolrail-settings');
      const sel =
        'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';
      const items = dlg.querySelectorAll(sel);
      items[items.length - 1].focus();
    });
    await page.keyboard.press('Tab');

    // Was: focus landed in the editor canvas with the dialog still open and
    // the gear still claiming aria-expanded="true" — and Escape, bound to
    // the dialog node, could no longer reach it.
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#toolrail-rail [data-tool="settings"]')).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  test('Escape from inside the dialog closes it and returns focus to the gear', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await expect(page.locator('.toolrail-settings')).toBeVisible();

    // Focus starts on the search field inside the dialog. Escape now
    // reaches a listener on the DOCUMENT rather than one bound to the
    // dialog node, which is what makes it survive focus moving around
    // inside the dialog.
    await page.keyboard.press('Escape');

    await expect(page.locator('.toolrail-settings')).toHaveCount(0);
    await expect(page.locator('#toolrail-rail [data-tool="settings"]')).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('settings');
  });

  test('Tab out of a flyout closes it', async ({ page }) => {
    await openNewPost(page);

    // Shape is shelved, so the flyout rides a registered child on the
    // pinned Text slot — the provider path.
    await page.evaluate(() => {
      window.toolrail.registerTool({
        id: 'e2e-tabout-child',
        label: 'E2E Tabout Child',
        parent: 'text',
        insertBlock: 'core/quote',
      });
    });
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.toolrail-flyout')).toBeVisible();

    await page.keyboard.press('Tab');

    await expect(page.locator('.toolrail-flyout')).toHaveCount(0);
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  test('a pre-migration author keeps Group, Text, Heading and Image on upgrade', async ({ page }) => {
    await openNewPost(page);

    // Reproduce pre-migration storage: a LOCALSTORAGE slot list written by
    // an old build (which held none of the three — they were built-in
    // tools then), no stamps, and NOTHING in the account preferences (the
    // just-booted rail wrote there, so clear it again). Boot must chain
    // both migrations: localStorage → preferences, then the slot seeding.
    await page.evaluate(() => {
      window.localStorage.setItem('toolrail-quick-slots', JSON.stringify(['core/quote']));
      window.localStorage.removeItem('toolrail-slots-migrated');
      const disp = window.wp.data.dispatch('core/preferences');
      ['toolrail-quick-slots', 'toolrail-slots-migrated']
        .forEach((k) => disp.set('toolrail', k, undefined));
    });
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });

    // The four return, ahead of the author's own pin, which survives —
    // and the lifted state now lives in the account preferences.
    const slots = JSON.parse(await getPref(page, 'toolrail-quick-slots'));
    expect(slots).toEqual(['core/group', 'core/paragraph', 'core/heading', 'core/image', 'core/quote']);
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/quote"]')).toHaveCount(1);
  });

  test('an emptied rail is not re-seeded on the next load', async ({ page }) => {
    await openNewPost(page);

    // Post-migration, an author who unpins everything means it. The
    // post-migration home is the account preferences.
    await page.evaluate(() => {
      const disp = window.wp.data.dispatch('core/preferences');
      disp.set('toolrail', 'toolrail-quick-slots', JSON.stringify([]));
      disp.set('toolrail', 'toolrail-slots-migrated', '1');
    });
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });

    await expect(page.locator('#toolrail-rail [data-tool^="pin:"]')).toHaveCount(0);
  });

  test('a set file listing the same block twice yields one button', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-import').setInputFiles({
      name: 'dupes.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'toolrail-set',
          version: 1,
          name: 'dupes',
          blocks: ['core/quote', 'core/quote', 'core/separator'],
        })
      ),
    });

    const status = page.locator('#toolrail-settings-status');
    await expect(status).toContainText('Imported "dupes" (2 blocks).');
    await expect(status).toContainText('1 repeated block was listed once.');

    // Load it: the rail must render one button per block, not two sharing a
    // data-tool id.
    await page.locator('.toolrail-settings-load').first().click();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/quote"]')).toHaveCount(1);
  });

  test('the Unpin button reads the same on screen as it does to AT', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    const unpin = page.locator('.toolrail-settings-remove').first();

    // WCAG 2.5.3 Label in Name: the accessible name must contain the visible
    // label, so "click Unpin" works for speech input. It read "Remove" on
    // screen and "Unpin Paragraph" to AT before.
    await expect(unpin).toHaveText('Unpin');
    expect(await unpin.getAttribute('aria-label')).toContain('Unpin');
  });

  test('every declared focus ring clears 3:1 against its own surface', async ({ page }) => {
    await openNewPost(page);

    // Each surface has to be LIVE to be measured, and the two cannot be
    // open at once: opening the gear runs closeFlyout(), and clicking a
    // rail tool closes the dialog via the outside-mousedown handler. So
    // sweep once per surface and merge.
    //
    // The bug this replaces a weaker test for lived in the settings
    // dialog, not on the rail: the dialog was assumed to be a light
    // surface and its four controls were left on #3858e9, which is 2.99:1
    // on the #1e1e1e it actually is. A sweep that only ever looked at the
    // rail could not see that.
    const sweep = () => page.evaluate(() => {
      const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const parse = (c) => {
        const m = c && c.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(',').map(parseFloat);
        return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
      };
      // Nearest ancestor painting an opaque background.
      const surfaceFrom = (el) => {
        let n = el;
        while (n && n !== document.documentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0.95) return c.rgb;
          n = n.parentElement;
        }
        return [255, 255, 255];
      };
      const ratio = (a, b) => {
        const l1 = lum(a);
        const l2 = lum(b);
        return +((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2);
      };

      const region = document.getElementById('toolrail-region');
      const token = getComputedStyle(region).getPropertyValue('--toolrail-focus-ring').trim();
      const probe = document.createElement('div');
      probe.style.color = token;
      document.body.appendChild(probe);
      const ring = parse(getComputedStyle(probe).color);
      probe.remove();

      const results = [];
      for (const sheet of Array.from(document.styleSheets)) {
        // Match the FILE, not the plugin folder: wp-env mounts the checkout
        // under the repo's directory name (editor-tool-rail in CI), so a
        // folder match found no sheet there and the sweep passed vacuously.
        if (!sheet.href || sheet.href.indexOf('/assets/editor-rail.css') === -1) continue;
        let rules;
        try {
          rules = Array.from(sheet.cssRules);
        } catch (e) {
          continue;
        }
        for (const rule of rules) {
          if (!rule.selectorText || rule.selectorText.indexOf(':focus-visible') === -1) continue;
          // The Section overview's chips draw on the EDITOR, not on the
          // rail, and deliberately sit on a fixed palette instead of
          // the appearance tokens (the 0.1.4 snap-preview boundary) —
          // and they only exist while the overview is open. Their ring
          // is measured by its own test in the overview suite.
          if (rule.selectorText.indexOf('.toolrail-ov-') !== -1) continue;
          const declared = rule.style.getPropertyValue('outline');
          if (!declared) continue;
          // Every focus ring must go through the shared token, or it is
          // not covered by the measurement below.
          const usesToken = declared.indexOf('var(--toolrail-focus-ring)') !== -1;
          const offset = parseFloat(rule.style.getPropertyValue('outline-offset')) || 0;
          for (const sel of rule.selectorText.split(',')) {
            const base = sel.trim().replace(/:focus-visible/g, '');
            const el = document.querySelector(base);
            if (!el) {
              results.push({ selector: sel.trim(), found: false });
              continue;
            }
            // A non-negative offset draws the ring OUTSIDE the border box,
            // so the colour behind it is the parent's, not the element's.
            // Measuring the element's own background instead reads a
            // pressed tool's blue fill and reports a false failure.
            const surface = surfaceFrom(offset >= 0 ? el.parentElement : el);
            results.push({
              selector: sel.trim(),
              found: true,
              usesToken,
              ratio: ratio(ring.rgb, surface),
            });
          }
        }
      }
      return { token, results };
    });

    // Shape is shelved; a registered child on the pinned Text slot
    // provides the live flyout surface to measure.
    await page.evaluate(() => {
      window.toolrail.registerTool({
        id: 'e2e-sweep-child',
        label: 'E2E Sweep Child',
        parent: 'text',
        insertBlock: 'core/quote',
      });
    });
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.toolrail-flyout')).toBeVisible();
    const withFlyout = await sweep();

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await expect(page.locator('.toolrail-settings')).toBeVisible();
    const withDialog = await sweep();

    // Merge: keep the pass in which each selector actually resolved.
    const bySelector = new Map();
    for (const r of withFlyout.results.concat(withDialog.results)) {
      if (!bySelector.has(r.selector) || (!bySelector.get(r.selector).found && r.found)) {
        bySelector.set(r.selector, r);
      }
    }
    const results = Array.from(bySelector.values());

    // Guard against a vacuous pass: the sweep must have found the rules and
    // resolved a real colour.
    expect(withFlyout.token).toBeTruthy();
    expect(results.length).toBeGreaterThanOrEqual(6);
    const missing = results.filter((r) => !r.found);
    expect(missing, `no live element for — ${JSON.stringify(missing)}`).toEqual([]);
    expect(results.filter((r) => !r.usesToken)).toEqual([]);

    const failing = results.filter((r) => r.ratio < 3);
    expect(failing, `focus rings below 3:1 — ${JSON.stringify(failing)}`).toEqual([]);
  });

  test('keyboard focus genuinely matches :focus-visible on the rail', async ({ page }) => {
    await openNewPost(page);

    // The previous version used programmatic .focus(), which does not
    // reliably match :focus-visible in Chromium — and because the base
    // .toolrail-tool declares no outline of its own, getComputedStyle fell
    // back to currentColor (#e0e0e0, 12.6:1) and the assertion passed no
    // matter what the ring was actually set to.
    await page.locator('#toolrail-rail [data-tool="select"]').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');

    const state = await page.evaluate(() => {
      const btn = document.querySelector('#toolrail-rail [data-tool="select"]');
      return {
        isActive: document.activeElement === btn,
        matchesFocusVisible: btn.matches(':focus-visible'),
        outlineColor: getComputedStyle(btn).outlineColor,
        outlineWidth: getComputedStyle(btn).outlineWidth,
      };
    });

    expect(state.isActive).toBe(true);
    expect(state.matchesFocusVisible).toBe(true);
    // Exact colour, so a regression to #3858e9 fails loudly rather than
    // sliding through on a fallback.
    expect(state.outlineColor).toBe('rgb(123, 144, 255)');
    expect(state.outlineWidth).toBe('2px');
  });

  test('rapid repeat inserts are not swept away by a stale pass', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data
        .dispatch('core/block-editor')
        .resetBlocks([createBlock('core/paragraph', { content: 'ALPHA' })]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(1);

    // Paragraph is the DEFAULT block type, so every block this inserts is
    // an unmodified default paragraph — indistinguishable, by shape alone,
    // from the stray the sweep exists to remove. Two inserts inside the
    // 80ms backstop window is the shift-click-to-repeat workflow, and the
    // first click's delayed pass used to run against a knownIds snapshot
    // that predated the second block and delete it.
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').click();
    await page.evaluate(async () => {
      const doc = document.querySelector('iframe[name="editor-canvas"]').contentDocument;
      const fire = (shift) => {
        const opts = {
          bubbles: true,
          cancelable: true,
          clientX: 300,
          clientY: 500,
          view: doc.defaultView,
          button: 0,
          shiftKey: shift,
        };
        doc.body.dispatchEvent(new PointerEvent('pointerdown', opts));
        doc.body.dispatchEvent(new MouseEvent('click', opts));
      };
      fire(true); // keeps the tool armed
      await new Promise((r) => setTimeout(r, 30)); // inside the 80ms window
      fire(false);
    });

    // Wait past both sweep passes before judging.
    await page.waitForTimeout(400);
    expect(await blockNames(page)).toEqual([
      'core/paragraph',
      'core/paragraph',
      'core/paragraph',
    ]);
  });

  test('a later gesture invalidates a pending sweep', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data
        .dispatch('core/block-editor')
        .resetBlocks([createBlock('core/paragraph', { content: 'ALPHA' })]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(1);

    // Arm a tool, insert, then start a NEW gesture and create an unmodified
    // default paragraph inside the 80ms backstop window. Under Select that
    // paragraph is core's click-to-write, which is the author's intent — a
    // pending pass from the armed click must not reach it.
    //
    // Asserted by clientId rather than by block count: the block is an
    // unmodified default paragraph (the only shape the sweep can mistake
    // for a stray), so counting paragraphs is ambiguous, and whatever else
    // the editor does to the document is irrelevant to the question.
    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    const survivorId = await page.evaluate(async () => {
      const doc = document.querySelector('iframe[name="editor-canvas"]').contentDocument;
      const opts = {
        bubbles: true,
        cancelable: true,
        clientX: 300,
        clientY: 500,
        view: doc.defaultView,
        button: 0,
      };
      doc.body.dispatchEvent(new PointerEvent('pointerdown', opts));
      doc.body.dispatchEvent(new MouseEvent('click', opts));

      await new Promise((r) => setTimeout(r, 30));

      // A fresh gesture. This bumps the generation, retiring the armed
      // click's pending passes.
      doc.body.dispatchEvent(new PointerEvent('pointerdown', opts));
      const { createBlock } = window.wp.blocks;
      const block = createBlock('core/paragraph');
      window.wp.data.dispatch('core/block-editor').insertBlocks(block);
      return block.clientId;
    });

    // Past both sweep passes.
    await page.waitForTimeout(400);
    const survived = await page.evaluate(
      (id) => !!window.wp.data.select('core/block-editor').getBlock(id),
      survivorId
    );
    expect(survived).toBe(true);
  });

  test('a PRE-stamp empty slot list seeds the defaults; a POST-stamp one stays empty', async ({ page }) => {
    await openNewPost(page);

    // Owner decision 2026-08-26 (reversing the earlier accepted-cost
    // call): under pre-migration builds Text/Heading/Image were built-in
    // tools, so an old localStorage "[]" never meant "I chose an empty
    // rail" — the migration seeds the defaults for it. Only POST-stamp
    // emptiness (in the account preferences) is a decision that sticks.
    await page.evaluate(() => {
      window.localStorage.setItem('toolrail-quick-slots', JSON.stringify([]));
      window.localStorage.removeItem('toolrail-slots-migrated');
      const disp = window.wp.data.dispatch('core/preferences');
      ['toolrail-quick-slots', 'toolrail-slots-migrated']
        .forEach((k) => disp.set('toolrail', k, undefined));
    });
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });

    await expect(page.locator('#toolrail-rail [data-tool^="pin:"]')).toHaveCount(4);
    expect(await getPref(page, 'toolrail-slots-migrated')).toBe('1');

    // Post-stamp: the author empties the rail and it MUST stay empty.
    await page.evaluate(() => {
      window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-quick-slots', JSON.stringify([]));
    });
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#toolrail-rail [data-tool^="pin:"]')).toHaveCount(0);
  });

  test('saved sets survive storage failing part-way through a session', async ({ page }) => {
    await openNewPost(page);

    // Save a set the normal way, so it is genuinely in localStorage.
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-setname').fill('kit');
    await page.locator('.toolrail-settings-saveset').click();
    await expect(page.locator('.toolrail-settings-setrow')).toHaveCount(1);
    await page.keyboard.press('Escape');

    // Now make storage start throwing mid-session, the way a quota hit
    // would. readKey must already have mirrored what it read, or the rail
    // and the saved sets vanish until reload.
    await page.evaluate(() => {
      const proto = window.Storage.prototype;
      proto.setItem = function () {
        throw new Error('QuotaExceededError');
      };
      proto.getItem = function () {
        throw new Error('SecurityError');
      };
    });

    // Force a re-read through the plugin's own paths.
    await page.evaluate(() => window.toolrail.moveSlot('core/heading', -1));

    const state = await page.evaluate(() => ({
      slots: Array.from(document.querySelectorAll('#toolrail-rail [data-tool^="pin:"]')).map(
        (b) => b.dataset.tool
      ),
    }));
    expect(state.slots.length).toBe(4);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await expect(page.locator('.toolrail-settings-setrow')).toHaveCount(1);
  });

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
    await openNewPost(page);
    // Give the account a position of its own (boot only READS one; a
    // fresh account has no key, and the lift would rightly win). Then a
    // leftover local copy that disagrees must neither win nor linger: it
    // is the thing that resurrected old pins after a delete + reinstall,
    // and WHICH pins depended on which browser booted first.
    await page.evaluate(() => window.toolrail.setDock('left'));
    await page.waitForTimeout(3000);
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
    await page.waitForTimeout(3000);
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'right');
    expect(await page.evaluate(() => window.localStorage.getItem('toolrail-position'))).toBeNull();
    expect(JSON.parse(await getPref(page, 'toolrail-position'))).toEqual({ dock: 'right', x: 40, y: 60 });
  });
});

test.describe('account persistence', () => {
  test('position and pins follow the account into a fresh browser profile', async ({ page, browser }) => {
    await openNewPost(page);

    await page.evaluate(() => window.toolrail.pinBlock('core/quote'));
    await page.evaluate(() => window.toolrail.setDock('bottom'));

    // The preferences store persists to user meta on a debounce — let it
    // flush before the fresh profile loads from the server.
    await page.waitForTimeout(3500);

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

test.describe('help panel', () => {
  test('never opens by itself, even on an account with no first-run stamp', async ({ page }) => {
    await openNewPost(page);

    // 0.1.9–0.1.21 auto-opened once per account, keyed on this stamp.
    // Owner decision 2026-09-02: never — on a fresh account it opened
    // under core's welcome guide and was dismissed with it, unread.
    await page.evaluate(() => {
      window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-help-seen', undefined);
      window.localStorage.removeItem('toolrail-help-seen');
    });
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(1200); // outlive the delay the old auto-open used
    await expect(page.locator('.toolrail-help')).toHaveCount(0);
    expect(await getPref(page, 'toolrail-help-seen')).toBeNull();
  });

  test('opens from the "?" tool; Escape closes and returns focus to it', async ({ page }) => {
    await openNewPost(page);

    const helpBtn = page.locator('#toolrail-rail [data-tool="help"]');
    await expect(helpBtn).toHaveAttribute('aria-haspopup', 'dialog');
    await helpBtn.click();

    const panel = page.locator('.toolrail-help');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('role', 'dialog');
    await expect(panel).toHaveAttribute('aria-labelledby', 'toolrail-help-title');
    await expect(panel.locator('#toolrail-help-title')).toHaveText('Toolbar help');
    await expect(helpBtn).toHaveAttribute('aria-expanded', 'true');

    // All seven sections render as headed text (Section overview joined
    // in 0.1.14; "What a highlighted tool means" in 0.1.18, R10).
    await expect(panel.locator('h3')).toHaveCount(7);
    await expect(panel.locator('h3').last()).toHaveText('What a highlighted tool means');

    // An explicit open moves focus into the panel…
    const focusInPanel = await page.evaluate(() => {
      const node = document.querySelector('.toolrail-help');
      return node === document.activeElement || node.contains(document.activeElement);
    });
    expect(focusInPanel).toBe(true);

    // …and Escape closes it, handing focus back to the opener.
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('help');
    await expect(helpBtn).toHaveAttribute('aria-expanded', 'false');
  });

  test('the hide checkbox removes the tool but keeps the settings path', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-helphidden').check();
    await expect(page.locator('#toolrail-rail [data-tool="help"]')).toHaveCount(0);
    expect(await getPref(page, 'toolrail-help-hidden')).toBe('1');

    // The panel stays reachable from the dialog's own Help button, and
    // opening it closes the dialog (they are sibling surfaces).
    await page.locator('.toolrail-settings-helpbtn').click();
    await expect(page.locator('.toolrail-help')).toBeVisible();
    await expect(page.locator('.toolrail-settings')).toHaveCount(0);

    // With the "?" hidden, Escape falls back to the gear.
    await page.keyboard.press('Escape');
    await expect(page.locator('.toolrail-help')).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('settings');

    // Unhiding restores the tool.
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-helphidden').uncheck();
    await expect(page.locator('#toolrail-rail [data-tool="help"]')).toBeVisible();
  });
});

/** Opt the on-rail expander chevron in via Toolbar settings (it is OFF
    by default — owner decision 2026-08-27: it spends prime toolbar
    space). Leaves the settings dialog closed again. */
async function enableWideToggle(page) {
  await page.locator('#toolrail-rail [data-tool="settings"]').click();
  await page.locator('#toolrail-settings-widetoggle').check();
  await expect(page.locator('#toolrail-rail [data-tool="wide-toggle"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.toolrail-settings')).toHaveCount(0);
}

test.describe('wide mode', () => {
  test('the expander is opt-in; once shown, the chevron toggles icon + name rows and persists', async ({ page }) => {
    await openNewPost(page);

    // No chevron on a default rail — it costs toolbar space, so it only
    // renders once the author asks for it in Toolbar settings.
    await expect(page.locator('#toolrail-rail [data-tool="wide-toggle"]')).toHaveCount(0);
    await enableWideToggle(page);
    expect(await getPref(page, 'toolrail-wide-toggle')).toBe('1');

    const toggle = page.locator('#toolrail-rail [data-tool="wide-toggle"]');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    const selectLabel = page.locator('#toolrail-rail [data-tool="select"] .toolrail-tool-label');
    await expect(selectLabel).toBeHidden();

    await toggle.click();
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-wide', 'true');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(selectLabel).toBeVisible();
    await expect(selectLabel).toHaveText('Select');
    // Pinned slots show the block title WITHOUT the "(pinned block)"
    // suffix — the accessible name keeps it (Label in Name holds).
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"] .toolrail-tool-label')).toHaveText('Paragraph');
    const width = await page.evaluate(() => document.getElementById('toolrail-region').getBoundingClientRect().width);
    expect(width).toBeGreaterThan(150);

    // A long block title must ellipsize, never widen the rail past its
    // 200px basis: min-width:auto (the flex automatic minimum) floored
    // the region at its content's min-content size — measured 270.89px
    // before the min-width:0 fix (review 2026-08-26).
    await page.evaluate(() => window.toolrail.pinBlock('core/latest-comments'));
    const geometry = await page.evaluate(() => {
      const region = document.getElementById('toolrail-region');
      // The scroll container, not the rail: the rail is overflow
      // visible and cannot scroll, so measuring it would pass
      // vacuously (review 2026-08-27, finding 6).
      const scroll = document.querySelector('#toolrail-rail .toolrail-scroll');
      return {
        regionWidth: region.getBoundingClientRect().width,
        horizontalOverflow: scroll.scrollWidth > scroll.clientWidth,
      };
    });
    expect(geometry.regionWidth).toBe(200);
    expect(geometry.horizontalOverflow).toBe(false);
    await page.evaluate(() => window.toolrail.unpinBlock('core/latest-comments'));

    // The chevron row matches the tool rows: as a direct rail child it
    // outgrew them (199px vs 191px) and its pressed edge bar rendered
    // outside the rail (review 2026-08-27, finding 1 — the head
    // container carries the same cross-axis padding now).
    const rowWidths = await page.evaluate(() => ({
      chevron: document.querySelector('#toolrail-rail [data-tool="wide-toggle"]').getBoundingClientRect().width,
      select: document.querySelector('#toolrail-rail [data-tool="select"]').getBoundingClientRect().width,
    }));
    expect(Math.abs(rowWidths.chevron - rowWidths.select)).toBeLessThanOrEqual(1);

    expect(await getPref(page, 'toolrail-wide')).toBe('1');
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-wide', 'true');

    await page.locator('#toolrail-rail [data-tool="wide-toggle"]').click();
    await expect(page.locator('#toolrail-region')).not.toHaveAttribute('data-wide', 'true');
    expect(await getPref(page, 'toolrail-wide')).toBe('0');
  });

  test('wide mode keeps one tab stop and the arrow order', async ({ page }) => {
    await openNewPost(page);
    await enableWideToggle(page);
    await page.locator('#toolrail-rail [data-tool="wide-toggle"]').click();

    const stops = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#toolrail-rail .toolrail-tool'))
        .filter((b) => b.tabIndex === 0).length
    );
    expect(stops).toBe(1);

    await page.locator('#toolrail-rail [data-tool="select"]').focus();
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('wide-toggle');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('select');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('pin:core/group');
  });

  test('the chevron does not render on horizontal docks', async ({ page }) => {
    await openNewPost(page);
    await enableWideToggle(page);

    await page.evaluate(() => window.toolrail.setDock('top'));
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'top');
    await expect(page.locator('#toolrail-rail [data-tool="wide-toggle"]')).toHaveCount(0);

    await page.evaluate(() => window.toolrail.setDock('left'));
    await expect(page.locator('#toolrail-rail [data-tool="wide-toggle"]')).toBeVisible();
  });

  test('flyouts and the settings dialog still place correctly in wide mode', async ({ page }) => {
    await openNewPost(page);

    // Deliberately WITHOUT the chevron: the settings checkbox is the
    // canonical path to wide mode, so this test rides it end to end.
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-wide').check();
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-wide', 'true');
    expect(await getPref(page, 'toolrail-wide')).toBe('1');

    // Shape is shelved; a registered child on the pinned Text slot
    // provides the flyout, opened by keyboard (a pinned parent's click
    // arms its own block rather than opening the menu).
    await page.evaluate(() => {
      window.toolrail.registerTool({
        id: 'e2e-wide-child',
        label: 'E2E Wide Child',
        parent: 'text',
        insertBlock: 'core/quote',
      });
    });
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.toolrail-flyout')).toBeVisible();
    const flyoutPlaced = await page.evaluate(() => {
      const rail = document.getElementById('toolrail-rail').getBoundingClientRect();
      const menu = document.querySelector('.toolrail-flyout').getBoundingClientRect();
      return {
        awayFromRail: menu.left >= rail.right - 1,
        onScreen: menu.right <= window.innerWidth && menu.bottom <= window.innerHeight,
      };
    });
    expect(flyoutPlaced.awayFromRail).toBe(true);
    expect(flyoutPlaced.onScreen).toBe(true);
    await page.keyboard.press('Escape');

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await expect(page.locator('.toolrail-settings')).toBeVisible();
    const dialogPlaced = await page.evaluate(() => {
      const rail = document.getElementById('toolrail-rail').getBoundingClientRect();
      const d = document.querySelector('.toolrail-settings').getBoundingClientRect();
      return d.left >= rail.right - 1 && d.right <= window.innerWidth;
    });
    expect(dialogPlaced).toBe(true);
  });
});

test.describe('rail overflow', () => {
  test('an overfull rail scrolls its tools while Help and Settings stay visible', async ({ page }) => {
    await openNewPost(page);

    // Force overflow regardless of how many tools this site registers.
    await page.evaluate(() => {
      ['core/quote', 'core/list', 'core/cover', 'core/gallery', 'core/audio', 'core/video',
        'core/table', 'core/verse', 'core/code', 'core/buttons', 'core/columns', 'core/group',
        'core/pullquote', 'core/preformatted', 'core/separator', 'core/spacer']
        .forEach((n) => window.toolrail.pinBlock(n));
    });

    const m = await page.evaluate(() => {
      const rail = document.getElementById('toolrail-rail');
      const scroll = rail.querySelector('.toolrail-scroll');
      const gear = rail.querySelector('[data-tool="settings"]');
      const help = rail.querySelector('[data-tool="help"]');
      const railRect = rail.getBoundingClientRect();
      return {
        // The tools section is what scrolls…
        scrollOverflows: scroll.scrollHeight > scroll.clientHeight + 1,
        // …while the rail itself does not, so the tail cannot be pushed
        // below the fold (pre-fix: the whole rail scrolled and the gear
        // — the recovery path for everything — was the first casualty).
        railOverflows: rail.scrollHeight > rail.clientHeight + 1,
        gearVisible: gear.getBoundingClientRect().bottom <= railRect.bottom + 1,
        helpVisible: help.getBoundingClientRect().bottom <= railRect.bottom + 1,
        gearOnScreen: gear.getBoundingClientRect().bottom <= window.innerHeight,
      };
    });
    expect(m.scrollOverflows).toBe(true);
    expect(m.railOverflows).toBe(false);
    expect(m.gearVisible).toBe(true);
    expect(m.helpVisible).toBe(true);
    expect(m.gearOnScreen).toBe(true);

    // NO native scrollbars: the classic vertical bar stole width from
    // the 44px tools, which then overflowed sideways and summoned a
    // horizontal scrollbar strip (the owner's 2026-08-27 screenshot).
    const bars = await page.evaluate(() => {
      const scroll = document.querySelector('#toolrail-rail .toolrail-scroll');
      return {
        scrollbarWidth: getComputedStyle(scroll).scrollbarWidth,
        // clientWidth < offsetWidth would mean a scrollbar is consuming
        // layout width; horizontal overflow would show as scrollWidth
        // beyond clientWidth.
        stealsWidth: scroll.offsetWidth - scroll.clientWidth,
        xOverflow: scroll.scrollWidth - scroll.clientWidth,
      };
    });
    expect(bars.scrollbarWidth).toBe('none');
    expect(bars.stealsWidth).toBe(0);
    expect(bars.xOverflow).toBe(0);

    // The first tool sits ≥4px inside the scroll container: an overflow
    // container clips descendant painting at its padding box, and the
    // focus ring (2px stroke + 2px offset) needs those 4px — at inset 0
    // the initial tab stop's ring lost its outer stroke (review
    // 2026-08-27, finding 3, confirmed by measurement).
    const ringInset = await page.evaluate(() => {
      const scroll = document.querySelector('#toolrail-rail .toolrail-scroll');
      scroll.scrollTop = 0;
      const first = scroll.querySelector('.toolrail-tool');
      return first.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    });
    expect(ringInset).toBeGreaterThanOrEqual(4);

    // The step buttons are the affordance: only "more below" shows at
    // the top, both directions mid-scroll, only "more above" at the end.
    const steps = (sel) => page.locator('#toolrail-rail ' + sel);
    await expect(steps('.toolrail-scrollbtn[data-dir="next"]')).toBeVisible();
    await expect(steps('.toolrail-scrollbtn[data-dir="prev"]')).toBeHidden();
    await steps('.toolrail-scrollbtn[data-dir="next"]').click();
    await expect(steps('.toolrail-scrollbtn[data-dir="prev"]')).toBeVisible();
    await page.evaluate(() => {
      const scroll = document.querySelector('#toolrail-rail .toolrail-scroll');
      scroll.scrollTop = scroll.scrollHeight;
    });
    await expect(steps('.toolrail-scrollbtn[data-dir="next"]')).toBeHidden();
    await expect(steps('.toolrail-scrollbtn[data-dir="prev"]')).toBeVisible();

    // The roving tabindex spans the split containers: End still reaches
    // the gear in the pinned tail — and the step buttons, being pointer
    // sugar, are not part of the arrow order.
    await page.locator('#toolrail-rail [data-tool="select"]').focus();
    await page.keyboard.press('End');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('settings');
  });
});

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

test.describe('appearance', () => {
  test('presets recolor the rail and its surfaces, and persist', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('input[data-appearance="light"]').check();

    await expect.poll(async () => page.evaluate(() =>
      getComputedStyle(document.getElementById('toolrail-rail')).backgroundColor
    )).toBe('rgb(255, 255, 255)');
    expect(JSON.parse(await getPref(page, 'toolrail-appearance')).mode).toBe('light');

    // The dialog inherits the region's tokens — one surface tone.
    expect(await page.evaluate(() =>
      getComputedStyle(document.querySelector('.toolrail-settings')).backgroundColor
    )).toBe('rgb(255, 255, 255)');

    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    expect(await page.evaluate(() =>
      getComputedStyle(document.getElementById('toolrail-rail')).backgroundColor
    )).toBe('rgb(255, 255, 255)');

    // Dark clears the inline tokens instead of restating them, so the
    // stylesheet defaults are back in charge.
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('input[data-appearance="dark"]').check();
    await expect.poll(async () => page.evaluate(() =>
      getComputedStyle(document.getElementById('toolrail-rail')).backgroundColor
    )).toBe('rgb(30, 30, 30)');
    expect(await page.evaluate(() =>
      document.getElementById('toolrail-region').style.getPropertyValue('--toolrail-bg')
    )).toBe('');
  });

  test('a custom pair applies; a low-contrast pair warns in text but is honored', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('input[data-appearance="custom"]').check();

    await expect(page.locator('#toolrail-settings-appearance-bg')).toBeEnabled();

    // A hostile pair: mid-grays at ~1.6:1.
    await setColor(page, 'toolrail-settings-appearance-bg', '#777777');
    await setColor(page, 'toolrail-settings-appearance-fg', '#999999');

    await expect.poll(async () => page.evaluate(() =>
      getComputedStyle(document.getElementById('toolrail-rail')).backgroundColor
    )).toBe('rgb(119, 119, 119)');

    // The warning is text in the dialog (and spoken via wp.a11y), never
    // color alone — and it renders INSIDE the Appearance section, beside
    // the swatches it is about. It must NOT land in the Saved-sets
    // status, which is bound as the import file input's accessible
    // description (review 2026-08-26: a screen-reader user tabbing to
    // Import heard the contrast warning read as that control's
    // description).
    await expect(page.locator('.toolrail-settings-appearance #toolrail-settings-appearance-status'))
      .toContainText('below the 4.5:1 minimum');
    await expect(page.locator('#toolrail-settings-status')).not.toContainText('4.5:1');
    expect(JSON.parse(await getPref(page, 'toolrail-appearance')))
      .toEqual({ mode: 'custom', bg: '#777777', fg: '#999999' });
  });

  test('the derived indicators hold their floors for hostile pairs', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('input[data-appearance="custom"]').check();

    const measure = () => page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('toolrail-region'));
      const get = (t) => cs.getPropertyValue('--toolrail-' + t).trim();
      const h2r = (h) => {
        const m = h.replace('#', '');
        return [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16));
      };
      const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a, b) => {
        const l1 = lum(h2r(a));
        const l2 = lum(h2r(b));
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      return {
        ring: ratio(get('focus-ring'), get('bg')),
        pressedEdge: ratio(get('pressed-edge'), get('bg')),
        status: ratio(get('status'), get('bg')),
      };
    });

    // Mid-gray pair (~1.6:1): both brand ring candidates fail, so the
    // black/white fallback must carry the 3:1 floor.
    await setColor(page, 'toolrail-settings-appearance-bg', '#777777');
    await setColor(page, 'toolrail-settings-appearance-fg', '#999999');
    const midGray = await measure();
    expect(midGray.ring).toBeGreaterThanOrEqual(3);
    expect(midGray.pressedEdge).toBeGreaterThanOrEqual(3);
    expect(midGray.status).toBeGreaterThanOrEqual(4.5);

    // The dark band from the review (bg luminance ≈0.033): the light
    // ring candidate clears 3:1 but NOT 4.5, and the pair itself is
    // ~1.3:1 — before the fix the status token fell back to the raw
    // foreground and the "your colors fail contrast" warning itself
    // rendered near-invisible.
    await setColor(page, 'toolrail-settings-appearance-bg', '#333333');
    await setColor(page, 'toolrail-settings-appearance-fg', '#444444');
    const darkBand = await measure();
    expect(darkBand.ring).toBeGreaterThanOrEqual(3);
    expect(darkBand.pressedEdge).toBeGreaterThanOrEqual(3);
    expect(darkBand.status).toBeGreaterThanOrEqual(4.5);
  });
});

/** Seed a known document for the overview specs: two paragraphs around a
    group with two children. resetBlocks touches only unsaved editor
    state — nothing is ever saved (this spec's standing rule). */
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

function overviewBoxButton(page, clientId, action) {
  return page.locator(
    `#toolrail-overview .toolrail-ov-box[data-clientid="${clientId}"] [data-ov-action="${action}"]`
  );
}

/** Seed six flat paragraphs P-A..P-F for the multi-select specs
    (issue #21). lockSecond gives P-B a movement lock. Unsaved editor
    state only — nothing is ever saved (the standing rule). */
async function seedOverviewParagraphs(page, lockSecond) {
  await page.evaluate((lockIt) => {
    const { createBlock } = window.wp.blocks;
    window.wp.data.dispatch('core/block-editor').resetBlocks(
      ['P-A', 'P-B', 'P-C', 'P-D', 'P-E', 'P-F'].map((content, i) =>
        createBlock('core/paragraph', i === 1 && lockIt
          ? { content, lock: { move: true, remove: false } }
          : { content })
      )
    );
  }, !!lockSecond);
  await expect.poll(async () => (await blockNames(page)).length).toBe(6);
}

/** Top-level paragraph contents in document order — the assertion
    surface for group moves. */
function overviewContents(page) {
  return page.evaluate(() => {
    const sel = window.wp.data.select('core/block-editor');
    return sel.getBlockOrder('').map((id) => String(sel.getBlockAttributes(id).content));
  });
}

function ovAnnouncement(page) {
  return page.evaluate(() => {
    const region = document.getElementById('a11y-speak-polite');
    return region ? region.textContent : '';
  });
}

function ovSelectedBoxes(page) {
  return page.locator('#toolrail-overview .toolrail-ov-box.is-selected');
}

test.describe('section overview (R6)', () => {
  test('the Overview tool zooms a tall document fully into view with chips in document order; closing restores everything', async ({ page }) => {
    await openNewPost(page);

    // A document several viewports tall, made of a few LARGE sections —
    // the shape the fit-the-whole-document zoom exists for. (A long run
    // of bare paragraphs deliberately does NOT fully fit any more: the
    // content-derived floor refuses to shrink the median block below a
    // usable size, and panning covers the rest — pinned by the
    // zoom-floor test below.)
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 4 }, (_, s) =>
          createBlock('core/group', {},
            Array.from({ length: 8 }, (_, i) =>
              createBlock('core/paragraph', { content: 'S' + s + '-PARA-' + i })
            ))
        )
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(4);

    const tool = page.locator('#toolrail-rail [data-tool="overview"]');
    await tool.click();

    await expect(page.locator('#toolrail-overview')).toBeVisible();
    await expect(tool).toHaveAttribute('aria-pressed', 'true');

    // The mode names itself and offers a labeled exit (plus the Esc
    // hint) — the "am I in a modal?" affordances.
    await expect(page.locator('#toolrail-overview .toolrail-ov-title')).toHaveText('Section overview');
    await expect(page.locator('#toolrail-overview [data-ov-action="close"]')).toHaveText('Done');
    await expect(page.locator('#toolrail-overview .toolrail-ov-esc')).toHaveText('Esc exits');

    // The point of the zoom: the LAST block of a 30-block document is on
    // screen. (Behavior, not mechanism — the scale/height plumbing can
    // change; a below-the-fold document may not.)
    await expect.poll(async () => page.evaluate(() => {
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const blocks = frame.contentDocument.querySelectorAll('[data-block]');
      const last = blocks[blocks.length - 1];
      const r = last.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      const k = f.width / frame.offsetWidth;
      return f.top + (r.top + r.height) * k <= window.innerHeight + 1;
    })).toBe(true);

    // One outline box per top-level block, box DOM order = document order.
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const boxIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#toolrail-overview .toolrail-ov-box')).map(
        (c) => c.dataset.clientid
      )
    );
    expect(boxIds).toEqual(ids);

    // Toggle off: overlay gone, pressed off, the canvas handed back —
    // no scale host left stamped, and the iframe scrolls internally
    // again (the document is taller than its restored viewport).
    await tool.click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    await expect(tool).toHaveAttribute('aria-pressed', 'false');
    const restored = await page.evaluate(() => {
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const html = frame.contentDocument.documentElement;
      return {
        scaleHosts: document.querySelectorAll('.toolrail-ov-scale-host').length,
        internallyScrollable: html.scrollHeight > html.clientHeight + 1,
      };
    });
    expect(restored.scaleHosts).toBe(0);
    expect(restored.internallyScrollable).toBe(true);
  });

  test('picking a box reveals its controls; a move announces and keeps focus on that box', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();

    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    // At rest: outlines and corner tags only — NO controls anywhere.
    // The always-on bars this replaces obscured the content (owner
    // feedback 2026-08-27, post 446).
    await expect(page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])')).toHaveCount(0);

    await overviewBoxButton(page, ids[0], 'pick').click();
    await expect(page.locator(
      `#toolrail-overview .toolrail-ov-box[data-clientid="${ids[0]}"] .toolrail-ov-controls`
    )).toBeVisible();
    // One box's controls at a time.
    await expect(page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])')).toHaveCount(1);

    await overviewBoxButton(page, ids[0], 'down').click();

    // ALPHA (a paragraph) moved below the group.
    await expect.poll(async () => await blockNames(page)).toEqual([
      'core/group',
      'core/paragraph',
      'core/paragraph',
    ]);

    // Announced through wp.a11y's persistent live region, with the real
    // position — never a visual-only reorder.
    await expect.poll(async () => page.evaluate(() => {
      const region = document.getElementById('a11y-speak-polite');
      return region ? region.textContent : '';
    })).toContain('Moved Paragraph to position 2 of 3.');

    // The rebuild keeps the box selected with focus on its own button
    // (the settings-arrows contract) — a keyboard user is never dropped.
    const focus = await page.evaluate(() => ({
      action: document.activeElement.dataset ? document.activeElement.dataset.ovAction : null,
      box: document.activeElement.closest
        ? (document.activeElement.closest('.toolrail-ov-box') || {}).dataset
        : null,
    }));
    expect(focus.action).toBe('down');
    expect(focus.box.clientid).toBe(ids[0]);
  });

  test('Shift+click selects a range, Ctrl+click toggles, Alt+click removes — each announced with the count (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    await overviewBoxButton(page, ids[0], 'pick').click();
    await expect(ovSelectedBoxes(page)).toHaveCount(1);

    // Shift+click the third box: the whole A..C range.
    await overviewBoxButton(page, ids[2], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(3);
    await expect.poll(async () => ovAnnouncement(page)).toContain('3 blocks selected.');
    // The disclosure follows the range's end and acts for the group.
    await expect(page.locator(
      `#toolrail-overview .toolrail-ov-box[data-clientid="${ids[2]}"] .toolrail-ov-controls`
    )).toBeVisible();
    await expect(page.locator(
      `#toolrail-overview .toolrail-ov-box[data-clientid="${ids[2]}"] .toolrail-ov-label`
    )).toHaveText('3 blocks selected');

    // Ctrl+click adds a detached box…
    await overviewBoxButton(page, ids[4], 'pick').click({ modifiers: ['Control'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(4);
    await expect.poll(async () => ovAnnouncement(page)).toContain('4 blocks selected.');

    // …and Alt+click removes one.
    await overviewBoxButton(page, ids[0], 'pick').click({ modifiers: ['Alt'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(3);
    await expect.poll(async () => ovAnnouncement(page)).toContain('3 blocks selected.');

    // A plain click collapses the multi-selection back to one box.
    await overviewBoxButton(page, ids[1], 'pick').click();
    await expect(ovSelectedBoxes(page)).toHaveCount(1);
  });

  test('a drag on empty overlay space draws a marquee that selects the boxes it touches; a plain empty click still clears (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const boxSel = (id) => page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${id}"]`);
    const lastBox = await boxSel(ids[5]).boundingBox();
    const targetBox = await boxSel(ids[4]).boundingBox();
    const overlayBox = await page.locator('#toolrail-overview').boundingBox();

    // Start on EMPTY overlay space below the last box, then draw up
    // through the last two boxes.
    const startX = overlayBox.x + overlayBox.width / 2;
    const startY = Math.min(lastBox.y + lastBox.height + 40, overlayBox.y + overlayBox.height - 8);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, targetBox.y + targetBox.height / 2, { steps: 8 });
    // The rectangle is visible while the drag is live.
    await expect(page.locator('#toolrail-overview .toolrail-ov-marquee')).toBeVisible();
    await page.mouse.up();

    await expect(ovSelectedBoxes(page)).toHaveCount(2);
    await expect.poll(async () => ovAnnouncement(page)).toContain('2 blocks selected.');

    // A sub-threshold click on the same empty spot clears everything —
    // today's behavior, kept.
    await page.mouse.click(startX, startY);
    await expect(ovSelectedBoxes(page)).toHaveCount(0);
    await expect(page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])')).toHaveCount(0);
  });

  test('the arrows move a contiguous group as one step, announced with the count, focus kept (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, ids[1], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);

    await overviewBoxButton(page, ids[1], 'down').click();

    // A and B stepped together past C.
    await expect.poll(async () => overviewContents(page)).toEqual(['P-C', 'P-A', 'P-B', 'P-D', 'P-E', 'P-F']);
    await expect.poll(async () => ovAnnouncement(page)).toContain('Moved 2 blocks to position 2 of 6.');

    // The group stays selected and focus stays on the arrow that moved
    // it (the settings-arrows contract).
    await expect(ovSelectedBoxes(page)).toHaveCount(2);
    const focus = await page.evaluate(() => ({
      action: document.activeElement.dataset ? document.activeElement.dataset.ovAction : null,
      box: document.activeElement.closest
        ? (document.activeElement.closest('.toolrail-ov-box') || {}).dataset
        : null,
    }));
    expect(focus.action).toBe('down');
    expect(focus.box.clientid).toBe(ids[1]);
  });

  test('a non-contiguous selection lands contiguous, in document order (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, ids[2], 'pick').click({ modifiers: ['Control'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);

    await overviewBoxButton(page, ids[2], 'down').click();

    // A and C left their gaps, compacted, and stepped past D together.
    await expect.poll(async () => overviewContents(page)).toEqual(['P-B', 'P-D', 'P-A', 'P-C', 'P-E', 'P-F']);
    await expect.poll(async () => ovAnnouncement(page)).toContain('Moved 2 blocks to position 3 of 6.');
  });

  test('dragging any selected box moves the whole group to the drop line (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, ids[1], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);

    const firstBox = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[0]}"]`).boundingBox();
    const lastBox = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[5]}"]`).boundingBox();
    await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstBox.x + firstBox.width / 2, lastBox.y + lastBox.height + 20, { steps: 10 });
    await page.mouse.up();

    // The whole group landed at the end, order kept.
    await expect.poll(async () => overviewContents(page)).toEqual(['P-C', 'P-D', 'P-E', 'P-F', 'P-A', 'P-B']);
    await expect.poll(async () => ovAnnouncement(page)).toContain('Moved 2 blocks to position 5 of 6.');
  });

  test('a locked block shows its lock, stays put when its group moves, and the announcement says so (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page, true);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    // The movement-locked box is annotated at rest — dashed outline
    // class and a "Locked" corner tag (plan review 2026-08-31).
    const lockedBox = page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[1]}"]`);
    await expect(lockedBox).toHaveClass(/is-locked/);
    await expect(lockedBox.locator('.toolrail-ov-locktag')).toContainText('Locked');

    // Selecting it is allowed; the count says up front what cannot move.
    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, ids[1], 'pick').click({ modifiers: ['Shift'] });
    await expect.poll(async () => ovAnnouncement(page)).toContain('2 blocks selected. 1 is locked and cannot move.');

    // The lock marker SURVIVES selection — it is the state the group
    // arrow is about to act on, so hiding it there was exactly
    // backwards (MR review 2026-08-31, finding 2). Before the fix the
    // badge lived inside the name tag, which is display:none while a
    // box is selected.
    await expect(lockedBox).toHaveClass(/is-selected/);
    await expect(lockedBox.locator('.toolrail-ov-locktag')).toBeVisible();

    await overviewBoxButton(page, ids[1], 'down').click();

    // ONE press moves the movable member exactly ONE row: P-A steps
    // past locked P-B, which stays exactly where it was.
    //
    // This expectation moved with the finding-3 fix, and the intent is
    // unchanged — only the arithmetic the arrow uses. The step used to
    // be measured from the last MEMBER, so a locked member at the end
    // of the selection made the first press jump TWO rows (P-A over
    // both P-B and P-C) and every press after it jump one. Measured
    // from the last MOVABLE member it is one row every time.
    await expect.poll(async () => overviewContents(page)).toEqual(['P-B', 'P-A', 'P-C', 'P-D', 'P-E', 'P-F']);
    await expect.poll(async () => ovAnnouncement(page)).toContain('stays where it is.');

    // Pressing again steps one more row — the cadence is now uniform.
    // The group's strip stays anchored to the ACTIVE box (P-B, the one
    // the range click landed on), so that is where the arrow lives —
    // P-A is a member, but a member without the disclosure open.
    await expect(page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])')).toHaveCount(1);
    await overviewBoxButton(page, ids[1], 'down').click();
    await expect.poll(async () => overviewContents(page)).toEqual(['P-B', 'P-C', 'P-A', 'P-D', 'P-E', 'P-F']);
  });

  test('a group selection marks every member with a shape, not a colour shift (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, ids[2], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(3);

    // Only the ACTIVE member shows a controls strip; the other two
    // carried nothing but a border hue shift measuring 1.68:1, under
    // 1.4.11's 3:1 for a state indicator — and forced colours flatten
    // every box's border to Highlight, erasing even that (MR review
    // 2026-08-31, finding 1). Every member now carries a mark of its
    // own, so the state does not depend on colour at all.
    await expect(page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])')).toHaveCount(1);
    await expect(page.locator('#toolrail-overview .toolrail-ov-box.is-selected .toolrail-ov-selectmark')).toHaveCount(3);
    for (const id of [ids[0], ids[1], ids[2]]) {
      await expect(page.locator(
        `#toolrail-overview .toolrail-ov-box[data-clientid="${id}"] .toolrail-ov-selectmark`
      )).toBeVisible();
    }
    // Control: an unselected box's mark stays hidden, so the assertion
    // above is really tracking selection and not just "the node exists".
    await expect(page.locator(
      `#toolrail-overview .toolrail-ov-box[data-clientid="${ids[4]}"] .toolrail-ov-selectmark`
    )).toBeHidden();
  });

  test('"Reorder inside" is unavailable while several blocks are selected (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const groupId = ids[1];

    // Control: picked on its own, the group's "Reorder inside" is live —
    // so the disabled assertion below is really about the selection.
    await overviewBoxButton(page, groupId, 'pick').click();
    await expect(overviewBoxButton(page, groupId, 'enter')).toBeEnabled();

    // Add the paragraph before it to the selection, keeping the group
    // as the active box. Stepping INTO a section is a single-block
    // action — the root change would clear the selection the author
    // just built, and "inside which of them?" has no answer (owner
    // decision 2026-09-01).
    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, groupId, 'pick').click({ modifiers: ['Control'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);
    await expect(overviewBoxButton(page, groupId, 'enter')).toBeDisabled();

    // In group mode the button's NAME is group-scoped too, like both
    // arrows — a browse-mode pass must not read "2 blocks selected",
    // two group-scoped arrows, then a single-block "Reorder inside".
    // The visible text still leads the name (WCAG 2.5.3).
    await expect(overviewBoxButton(page, groupId, 'enter'))
      .toHaveAttribute('aria-label', 'Reorder inside — not available while 2 blocks are selected');

    // Dropping back to one block restores it. Alt+click removes the
    // paragraph and leaves the group both selected and active — a
    // plain click on the active box is the disclosure toggle, which
    // closes the strip altogether.
    await overviewBoxButton(page, ids[0], 'pick').click({ modifiers: ['Alt'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(1);
    await expect(overviewBoxButton(page, groupId, 'enter')).toBeEnabled();
    await expect(overviewBoxButton(page, groupId, 'enter'))
      .toHaveAttribute('aria-label', /^Reorder inside Group/);
  });

  test('every root change that drops a group selection says so (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const topIds = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const groupId = topIds[1];

    // Drill in, then select both children.
    const drillIn = async () => {
      await overviewBoxButton(page, groupId, 'pick').click();
      await overviewBoxButton(page, groupId, 'enter').click();
      await expect(page.locator('#toolrail-overview .toolrail-ov-box')).toHaveCount(2);
      return page.evaluate((gid) =>
        window.wp.data.select('core/block-editor').getBlockOrder(gid), groupId
      );
    };
    let innerIds = await drillIn();

    // Control first: a root change with only ONE box picked is the
    // ordinary case and must stay quiet, or the assertions below would
    // pass for the wrong reason.
    await overviewBoxButton(page, innerIds[0], 'pick').click();
    await page.locator('#toolrail-overview [data-ov-action="up-level"]').click();
    await expect.poll(async () => ovAnnouncement(page)).toContain('Viewing all sections');
    expect(await ovAnnouncement(page)).not.toContain('Selection cleared');

    // Door 1 — "Up one level" with a group selected.
    innerIds = await drillIn();
    await overviewBoxButton(page, innerIds[0], 'pick').click();
    await overviewBoxButton(page, innerIds[1], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);
    await page.locator('#toolrail-overview [data-ov-action="up-level"]').click();
    await expect(ovSelectedBoxes(page)).toHaveCount(0);
    await expect.poll(async () => ovAnnouncement(page)).toContain('Selection cleared.');

    // Door 2 — a breadcrumb with a group selected.
    innerIds = await drillIn();
    await overviewBoxButton(page, innerIds[0], 'pick').click();
    await overviewBoxButton(page, innerIds[1], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);
    await page.locator('#toolrail-overview [data-ov-action="crumb"]').first().click();
    await expect(ovSelectedBoxes(page)).toHaveCount(0);
    await expect.poll(async () => ovAnnouncement(page)).toContain('Selection cleared.');

    // Door 3 — the forced climb when the drilled-into block is deleted
    // out from under the author. The review named the first two; this
    // one reaches the same drillTo and was never guarded either.
    innerIds = await drillIn();
    await overviewBoxButton(page, innerIds[0], 'pick').click();
    await overviewBoxButton(page, innerIds[1], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);
    await page.evaluate((gid) =>
      window.wp.data.dispatch('core/block-editor').removeBlock(gid), groupId
    );
    // One composed announcement: the reason, the new level, and the
    // selection — wp.a11y.speak replaces the region, so they cannot race.
    await expect.poll(async () => ovAnnouncement(page)).toContain('was removed.');
    expect(await ovAnnouncement(page)).toContain('Selection cleared.');
  });

  test('a locked member at the document edge does not kill an arrow whose move is legal (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    // Lock the LAST block, so a selection containing it sits against
    // the end of the document.
    await page.evaluate(() => {
      const sel = window.wp.data.select('core/block-editor');
      const ids = sel.getBlockOrder('');
      window.wp.data.dispatch('core/block-editor').updateBlockAttributes(
        ids[5], { lock: { move: true, remove: false } }
      );
    });
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    // Guard the guard: core must genuinely refuse to move P-F, or this
    // proves nothing.
    const refused = await page.evaluate((id) => {
      const sel = window.wp.data.select('core/block-editor');
      return typeof sel.canMoveBlocks === 'function' ? !sel.canMoveBlocks([id], '') : null;
    }, ids[5]);
    test.skip(refused === null, 'canMoveBlocks is not on this WordPress');
    expect(refused).toBe(true);

    // Select P-D (movable, index 3) and the locked P-F (index 5).
    await overviewBoxButton(page, ids[3], 'pick').click();
    await overviewBoxButton(page, ids[5], 'pick').click({ modifiers: ['Control'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);

    // The down arrow was disabled because the LAST member sat at the
    // document end — but the movable member has a legal move, and the
    // engine performs it correctly when asked (MR review 2026-08-31,
    // finding 3). Enabled now, and the click really moves.
    const down = overviewBoxButton(page, ids[5], 'down');
    await expect(down).toBeEnabled();
    await down.click();

    // P-D stepped past P-E; the locked P-F never moved.
    await expect.poll(async () => overviewContents(page)).toEqual(['P-A', 'P-B', 'P-C', 'P-E', 'P-D', 'P-F']);
    await expect.poll(async () => ovAnnouncement(page)).toContain('stays where it is.');
  });

  test('Shift+ArrowDown extends the selection from the focused box; Ctrl+Space toggles it (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    await overviewBoxButton(page, ids[0], 'pick').focus();
    await page.keyboard.press('Shift+ArrowDown');
    await expect(ovSelectedBoxes(page)).toHaveCount(2);
    await expect.poll(async () => ovAnnouncement(page)).toContain('2 blocks selected.');
    // Focus followed the extension to the neighbor's pick button.
    const focus = await page.evaluate(() => ({
      action: document.activeElement.dataset ? document.activeElement.dataset.ovAction : null,
      box: document.activeElement.closest
        ? (document.activeElement.closest('.toolrail-ov-box') || {}).dataset
        : null,
    }));
    expect(focus.action).toBe('pick');
    expect(focus.box.clientid).toBe(ids[1]);

    // Ctrl+Space toggles the focused box back out (and must not open
    // its disclosure — Space alone would).
    await page.keyboard.press('Control+ ');
    await expect(ovSelectedBoxes(page)).toHaveCount(1);
    await expect.poll(async () => ovAnnouncement(page)).toContain('1 block selected.');
  });

  test('Escape exits the overview in one press, even with a selection open (owner decision 2026-09-01)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, ids[2], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(3);

    // ONE press leaves, exactly as "Done" does — which is what the
    // bar's "Esc exits" hint has always promised. Neither the open
    // selection nor the open controls strip buys an extra rung.
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('overview');
    await expect.poll(async () => ovAnnouncement(page)).toContain('Section overview closed.');
  });

  test('Escape cancels an in-flight drag instead of exiting, and says which happened (owner decision 2026-09-01)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const before = await overviewContents(page);

    // Start a real drag and cross the threshold.
    const firstBox = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[0]}"]`).boundingBox();
    const lastBox = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[5]}"]`).boundingBox();
    await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstBox.x + firstBox.width / 2, lastBox.y + lastBox.height / 2, { steps: 10 });
    await expect(page.locator('#toolrail-overview .toolrail-ov-dropline')).toBeVisible();

    // Escape abandons the DRAG and keeps the mode. This rung is not a
    // nicety: the mouseup below is still armed, and exiting instead
    // would let it commit the very move being abandoned.
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    await expect(page.locator('#toolrail-overview .toolrail-ov-dropline')).toHaveCount(0);
    // The quiet outcome announces, and says what the next press does —
    // with only two outcomes, silence would leave a screen-reader user
    // unable to tell whether they had left the mode.
    await expect.poll(async () => ovAnnouncement(page)).toContain('Move canceled.');
    expect(await ovAnnouncement(page)).toContain('Press Escape again to close the overview.');

    await page.mouse.up();
    // Nothing moved, by the release or by the cancel.
    expect(await overviewContents(page)).toEqual(before);

    // And the next press exits, as the announcement said.
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
  });

  test('a canceled drag released back on its own box does not toggle that box (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    // Nothing selected to begin with.
    await expect(ovSelectedBoxes(page)).toHaveCount(0);

    const box = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[0]}"]`).boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Press, drag past the threshold, Escape, then bring the pointer
    // BACK to the originating button and release there. The click the
    // browser then fires targets that button, because it is the
    // common ancestor of the press and the release.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 120, { steps: 8 });
    await expect(page.locator('#toolrail-overview .toolrail-ov-dropline')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.poll(async () => ovAnnouncement(page)).toContain('Move canceled.');
    await page.mouse.move(cx, cy, { steps: 6 });
    await page.mouse.up();

    // A canceled gesture has NO follow-on action: the box must not
    // have picked itself and opened its controls after the cancel was
    // already announced.
    await expect(ovSelectedBoxes(page)).toHaveCount(0);
    await expect(page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])')).toHaveCount(0);

    // Control: a plain click on that same button still works, so the
    // latch released instead of deadening the box.
    await overviewBoxButton(page, ids[0], 'pick').click();
    await expect(ovSelectedBoxes(page)).toHaveCount(1);
  });

  test('the extension prefs API publishes a readiness signal that settles (0.1.21)', async ({ page }) => {
    await openNewPost(page);

    // The contract an extension writes against: a Promise, a
    // synchronous read of the same state, and a window event at the
    // same moment. Before this existed, an extension reading at
    // script-load could get null for a key the account holds, because
    // readKey only knows the STORE exists, not that its persistence
    // has attached (MR review 2026-09-02).
    const shape = await page.evaluate(() => ({
      hasReady: !!(window.toolrail.prefs.ready && typeof window.toolrail.prefs.ready.then === 'function'),
      hasIsReady: typeof window.toolrail.prefs.isReady === 'function',
    }));
    expect(shape.hasReady).toBe(true);
    expect(shape.hasIsReady).toBe(true);

    // It must actually SETTLE — a contract that never resolves would
    // hang every consumer that awaits it. Resolve-or-timeout, so a
    // hang fails loudly instead of stalling the spec.
    const settled = await page.evaluate(() => Promise.race([
      window.toolrail.prefs.ready.then(() => 'ready'),
      new Promise((r) => setTimeout(() => r('timeout'), 10000)),
    ]));
    expect(settled).toBe('ready');
    expect(await page.evaluate(() => window.toolrail.prefs.isReady())).toBe(true);

    // Once settled, a round trip through the account store works.
    const roundTrip = await page.evaluate(() => {
      window.toolrail.prefs.set('toolrail-ext:spec:probe', 'kept');
      return window.toolrail.prefs.get('toolrail-ext:spec:probe');
    });
    expect(roundTrip).toBe('kept');
  });

  test('a canceled drag whose release is never seen does not eat a later click (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    await expect(ovSelectedBoxes(page)).toHaveCount(0);

    const box = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[0]}"]`).boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 120, { steps: 8 });
    await expect(page.locator('#toolrail-overview .toolrail-ov-dropline')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.poll(async () => ovAnnouncement(page)).toContain('Move canceled.');

    // The release is NEVER dispatched — the pointer left the document,
    // or the gesture was cancelled — so the one-shot listener is left
    // armed with the overview still open.
    //
    // The next genuine click must still work. Without the fix that
    // click's own mouseup spent the stale latch, and the `click` that
    // followed was discarded, so the box never picked.
    const target = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[2]}"]`).boundingBox();
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);

    await expect(ovSelectedBoxes(page)).toHaveCount(1);
    await expect(page.locator(
      `#toolrail-overview .toolrail-ov-box[data-clientid="${ids[2]}"] .toolrail-ov-controls`
    )).toBeVisible();
  });

  test('dragging a group that contains a locked block says what stayed behind (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page, true);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    // Guard the guard: P-B must genuinely be unmovable.
    const refused = await page.evaluate((id) => {
      const sel = window.wp.data.select('core/block-editor');
      return typeof sel.canMoveBlocks === 'function' ? !sel.canMoveBlocks([id], '') : null;
    }, ids[1]);
    test.skip(refused === null, 'canMoveBlocks is not on this WordPress');
    expect(refused).toBe(true);

    // Select movable P-A plus locked P-B, then DRAG the group.
    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, ids[1], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);

    const firstBox = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[0]}"]`).boundingBox();
    const lastBox = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[5]}"]`).boundingBox();
    await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstBox.x + firstBox.width / 2, lastBox.y + lastBox.height + 20, { steps: 10 });
    await page.mouse.up();

    // The movable member moved to the end; the locked one held its place.
    await expect.poll(async () => overviewContents(page)).toEqual(['P-B', 'P-C', 'P-D', 'P-E', 'P-F', 'P-A']);
    // The DRAG must say what stayed, exactly as the arrows do — the
    // drag used to filter locked ids out before the move engine saw
    // them, so the engine had nothing left to report.
    await expect.poll(async () => ovAnnouncement(page)).toContain('stays where it is.');
  });

  test('keyboard-only: Enter drills into a section, arrows reorder inside it, "Up one level" climbs, Escape closes', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();

    const topIds = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const groupId = topIds[1];

    // Pick the group by keyboard: its controls appear inside the lines,
    // then its Enter control drills in.
    await overviewBoxButton(page, groupId, 'pick').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(
      `#toolrail-overview .toolrail-ov-box[data-clientid="${groupId}"] .toolrail-ov-controls`
    )).toBeVisible();
    await overviewBoxButton(page, groupId, 'enter').focus();
    await page.keyboard.press('Enter');

    const innerIds = await page.evaluate((gid) =>
      window.wp.data.select('core/block-editor').getBlockOrder(gid), groupId
    );
    expect(innerIds.length).toBe(2);
    await expect(page.locator('#toolrail-overview .toolrail-ov-box')).toHaveCount(2);
    // The breadcrumb names the level; the current crumb is text, not a button.
    await expect(page.locator('#toolrail-overview [aria-current="location"]')).toHaveText('Group');

    // Isolation: the drilled root sits centered in the viewport and
    // everything outside it is veiled at 50% (owner ask 2026-08-27) —
    // the veil is overlay chrome, the canvas document is untouched.
    await page.waitForTimeout(300);
    const iso = await page.evaluate((gid) => {
      const overlay = document.getElementById('toolrail-overview');
      const o = overlay.getBoundingClientRect();
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const el = frame.contentDocument.querySelector(`[data-block="${gid}"]`);
      const r = el.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      const k = f.width / frame.offsetWidth;
      const rootMid = f.top + (r.top + r.height / 2) * k;
      const rootRect = {
        top: f.top + r.top * k,
        bottom: f.top + (r.top + r.height) * k,
        left: f.left + r.left * k,
        right: f.left + (r.left + r.width) * k,
      };
      const veils = Array.from(overlay.querySelectorAll('.toolrail-ov-veil'))
        .filter((v) => v.style.display !== 'none');
      // The HOLE is the point (review 2026-08-27, finding 5): no strip
      // may cover the drilled root itself.
      const overlapsRoot = veils.some((v) => {
        const b = v.getBoundingClientRect();
        return b.left < rootRect.right - 1 && b.right > rootRect.left + 1
          && b.top < rootRect.bottom - 1 && b.bottom > rootRect.top + 1;
      });
      return {
        veils: veils.length,
        bg: veils.length ? getComputedStyle(veils[0]).backgroundColor : '',
        offCenter: Math.abs(rootMid - (o.top + o.height / 2)),
        overlapsRoot,
      };
    }, groupId);
    expect(iso.veils).toBeGreaterThanOrEqual(2);
    expect(iso.bg).toBe('rgba(0, 0, 0, 0.5)');
    expect(iso.offCenter).toBeLessThan(60);
    expect(iso.overlapsRoot).toBe(false);

    // Reorder the heading above the paragraph, by keyboard.
    await overviewBoxButton(page, innerIds[1], 'pick').focus();
    await page.keyboard.press('Enter');
    await overviewBoxButton(page, innerIds[1], 'up').focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => page.evaluate((gid) =>
      window.wp.data.select('core/block-editor').getBlockOrder(gid), groupId
    )).toEqual([innerIds[1], innerIds[0]]);

    // Climbing a level by keyboard is the "Up one level" button, not
    // Escape (owner decision 2026-09-01 — Escape exits the mode).
    await page.locator('#toolrail-overview [data-ov-action="up-level"]').click();
    await expect(page.locator('#toolrail-overview .toolrail-ov-box')).toHaveCount(3);
    await expect(page.locator('#toolrail-overview [aria-current="location"]')).toHaveText('All sections');

    // Escape closes from wherever you are, returning focus to the tool.
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('overview');
  });

  test('Escape exits from a drilled-in level in one press (owner decision 2026-09-01)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const topIds = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const groupId = topIds[1];

    await overviewBoxButton(page, groupId, 'pick').click();
    await overviewBoxButton(page, groupId, 'enter').click();
    await expect(page.locator('#toolrail-overview .toolrail-ov-box')).toHaveCount(2);

    // Two levels of state open — drilled in, with a box picked — and
    // one press still leaves. Nothing is lost: the move is already in
    // the store and the close lands on the block last touched.
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    await expect.poll(async () => ovAnnouncement(page)).toContain('Section overview closed.');
  });

  test('the reorder-controls focus ring clears 3:1 on its own surface', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const firstId = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')[0]
    );
    await overviewBoxButton(page, firstId, 'pick').click();
    await expect(page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])')).toBeVisible();

    // The overview surfaces are excluded from the token-sweep test on
    // purpose: they draw on the editor and use a FIXED palette (the
    // 0.1.4 snap-preview boundary), so their ring is pinned here
    // instead — the DECLARED ring color from the stylesheet, against
    // the controls strip's real computed surface, so an appearance
    // change can never silently break it.
    const m = await page.evaluate(() => {
      const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const parse = (c) => {
        const el = document.createElement('div');
        el.style.color = c;
        document.body.appendChild(el);
        const v = getComputedStyle(el).color.match(/rgba?\(([^)]+)\)/);
        el.remove();
        return v ? v[1].split(',').slice(0, 3).map(parseFloat) : null;
      };

      let declared = '';
      for (const sheet of Array.from(document.styleSheets)) {
        // Match the FILE, not the plugin folder: wp-env mounts the checkout
        // under the repo's directory name (editor-tool-rail in CI), so a
        // folder match found no sheet there and the sweep passed vacuously.
        if (!sheet.href || sheet.href.indexOf('/assets/editor-rail.css') === -1) continue;
        let rules;
        try { rules = Array.from(sheet.cssRules); } catch (e) { continue; }
        for (const rule of rules) {
          if (rule.selectorText
            && rule.selectorText.indexOf('.toolrail-ov-btn:focus-visible') !== -1
            && rule.style && rule.style.outlineColor) {
            declared = rule.style.outlineColor;
          }
        }
      }
      if (!declared) return { declared };

      const strip = document.querySelector('#toolrail-overview .toolrail-ov-controls:not([hidden])');
      const ring = parse(declared);
      const surface = parse(getComputedStyle(strip).backgroundColor);
      const l1 = lum(ring);
      const l2 = lum(surface);
      return {
        declared,
        ratio: +((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2),
      };
    });

    // Guard the guard: the rule must have been found and parsed.
    expect(m.declared).toBeTruthy();
    expect(m.ratio).toBeGreaterThanOrEqual(3);
  });

  test('an overview reorder serializes byte-identically to the same move made directly', async ({ page }) => {
    await openNewPost(page);

    // The overview path.
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, ids[0], 'down').click();
    await expect.poll(async () => (await blockNames(page))[0]).toBe('core/group');
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const viaOverview = await page.evaluate(() =>
      window.wp.data.select('core/editor').getEditedPostContent()
    );

    // The direct dispatch — what List View's reorder resolves to.
    await seedOverviewBlocks(page);
    await page.evaluate(() => {
      const order = window.wp.data.select('core/block-editor').getBlockOrder('');
      window.wp.data.dispatch('core/block-editor').moveBlocksToPosition([order[0]], '', '', 1);
    });
    const viaDispatch = await page.evaluate(() =>
      window.wp.data.select('core/editor').getEditedPostContent()
    );

    expect(viaOverview).toBe(viaDispatch);
  });

  test('entering and leaving neither dirties the post nor loses the scroll position', async ({ page }) => {
    await openNewPost(page);

    // A fresh, untouched post: the overview alone must not dirty it.
    expect(await page.evaluate(() =>
      window.wp.data.select('core/editor').isEditedPostDirty()
    )).toBe(false);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    expect(await page.evaluate(() =>
      window.wp.data.select('core/editor').isEditedPostDirty()
    )).toBe(false);

    // Scroll restore: the canvas scrolls INSIDE its iframe on this
    // editor (measured — the parent content region never overflows), so
    // that is the position that must survive the round trip.
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 30 }, (_, i) =>
          createBlock('core/paragraph', { content: 'PARA-' + i })
        )
      );
    });
    await expect.poll(async () => page.evaluate(() => {
      const html = document.querySelector('iframe[name="editor-canvas"]').contentDocument.documentElement;
      return html.scrollHeight > html.clientHeight;
    })).toBe(true);

    // Guard the guard: the scroll must genuinely take, or restore-to-0
    // would pass vacuously.
    const scrolled = await page.evaluate(() => {
      const win = document.querySelector('iframe[name="editor-canvas"]').contentWindow;
      win.scrollTo(0, 300);
      return win.scrollY;
    });
    expect(scrolled).toBeGreaterThan(0);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    // The grown iframe has no internal scroll range left — the whole
    // document is its viewport.
    await expect.poll(async () => page.evaluate(() =>
      document.querySelector('iframe[name="editor-canvas"]').contentWindow.scrollY
    )).toBe(0);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect.poll(async () => page.evaluate(() =>
      document.querySelector('iframe[name="editor-canvas"]').contentWindow.scrollY
    )).toBe(scrolled);
  });

  /** Where a block sits relative to the canvas viewport after close —
      distance of its center from the viewport's center, in iframe px,
      plus what "close" counts as (R11: a block taller than the viewport
      centers to its top instead). */
  async function landingOffset(page, clientId) {
    return page.evaluate((id) => {
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const win = frame.contentWindow;
      const el = frame.contentDocument.querySelector(`[data-block="${id}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const vh = win.innerHeight;
      // Tall branch: the implementation lands a viewport-tall block's
      // TOP at 0, so the miss is r.top itself — not a distance to the
      // viewport middle (review 2026-08-31, finding 3).
      const target = r.height >= vh ? -r.top : vh / 2 - (r.top + r.height / 2);
      return { off: Math.abs(target), vh };
    }, clientId);
  }

  test('closing centers and selects the last PICKED block, and the announcement names it', async ({ page }) => {
    await openNewPost(page);
    // Many short blocks so the document scrolls, the picked block's
    // rect fits well inside the viewport (the centered assertion is
    // about the block's CENTER), and room remains on BOTH sides of it —
    // a block near the document's end can only ever clamp, not center.
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 40 }, (_, i) =>
          createBlock('core/paragraph', { content: 'CENTER-PARA-' + i })
        )
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(40);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    // Mid-document, below the fold at entry scroll 0. Focus + Enter,
    // not click: at floor zoom the box may sit below the overlay's
    // edge, and the overlay's focusin handler pans it into view — the
    // same path a keyboard user takes.
    const picked = ids[20];
    await overviewBoxButton(page, picked, 'pick').focus();
    await page.keyboard.press('Enter');
    await page.locator('#toolrail-overview [data-ov-action="close"]').click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);

    // Behavior, not mechanism: the block's center lands within a
    // quarter-viewport of the canvas viewport's center (the canvas is
    // pre-positioned at close; the poll also covers the corrective
    // write behind it), and the block is selected.
    await expect.poll(async () => {
      const m = await landingOffset(page, picked);
      return m ? m.off < m.vh / 4 : false;
    }).toBe(true);
    expect(await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getSelectedBlockClientId()
    )).toBe(picked);

    // The close announcement names the landed block (issue #20).
    await expect.poll(async () => page.evaluate(() =>
      document.getElementById('a11y-speak-polite').textContent
    )).toContain('Section overview closed. Paragraph is selected.');
  });

  test('under reduced motion, closing after a drill + move still lands on the MOVED child — instantly', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openNewPost(page);
    // A group mid-document with filler on BOTH sides, so landing on its
    // child is a real scroll that can genuinely center (a group at the
    // very end can only clamp against the document's bottom).
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      const filler = (tag) => Array.from({ length: 15 }, (_, i) =>
        createBlock('core/paragraph', { content: tag + '-' + i })
      );
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        ...filler('BEFORE'),
        createBlock('core/group', {}, [
          createBlock('core/paragraph', { content: 'CHILD-ONE' }),
          createBlock('core/heading', { content: 'CHILD-TWO' }),
        ]),
        ...filler('AFTER'),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(31);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const groupId = (await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    ))[15];
    // Focus + Enter: the focusin pan brings a below-the-edge box into
    // view before the pick, same as the keyboard path.
    await overviewBoxButton(page, groupId, 'pick').focus();
    await page.keyboard.press('Enter');
    await overviewBoxButton(page, groupId, 'enter').click();
    const innerIds = await page.evaluate((gid) =>
      window.wp.data.select('core/block-editor').getBlockOrder(gid), groupId
    );
    await overviewBoxButton(page, innerIds[1], 'pick').click();
    await overviewBoxButton(page, innerIds[1], 'up').click();
    await page.locator('#toolrail-overview [data-ov-action="close"]').click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);

    // The moved CHILD (last touched wins over the drilled root) is
    // selected and centered — reduced motion only skips the overlay
    // fade; the landing itself is identical for everyone.
    expect(await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getSelectedBlockClientId()
    )).toBe(innerIds[1]);
    await expect.poll(async () => {
      const m = await landingOffset(page, innerIds[1]);
      return m ? m.off < m.vh / 4 : false;
    }).toBe(true);
  });

  test('a deleted last-touched block falls back to the entry scroll without throwing', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 24 }, (_, i) =>
          createBlock('core/paragraph', { content: 'FALLBACK-' + i })
        )
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(24);
    const scrolled = await page.evaluate(() => {
      const win = document.querySelector('iframe[name="editor-canvas"]').contentWindow;
      win.scrollTo(0, 300);
      return win.scrollY;
    });
    expect(scrolled).toBe(300);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    await overviewBoxButton(page, ids[3], 'pick').click();
    // The touched block vanishes before close — the landing must fall
    // through to the entry scroll, never throw or select a ghost.
    // selectPrevious=false: core's default would select the previous
    // block, and this test's point is the NOTHING-selected fallback.
    await page.evaluate((id) =>
      window.wp.data.dispatch('core/block-editor').removeBlock(id, false), ids[3]
    );
    await page.locator('#toolrail-overview [data-ov-action="close"]').click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    await expect.poll(async () => page.evaluate(() =>
      document.querySelector('iframe[name="editor-canvas"]').contentWindow.scrollY
    )).toBe(scrolled);
    expect(await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getSelectedBlockClientId()
    )).toBeNull();
  });

  test('a movement-locked block gets disabled arrows — never a false "moved" announcement', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/paragraph', { content: 'FREE-1' }),
        createBlock('core/paragraph', { content: 'LOCKED', lock: { move: true } }),
        createBlock('core/paragraph', { content: 'FREE-2' }),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(3);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();

    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    // Guard the guard: core must genuinely refuse this move, or the
    // disabled-arrows assertion proves nothing.
    const refused = await page.evaluate((id) => {
      const sel = window.wp.data.select('core/block-editor');
      return typeof sel.canMoveBlocks === 'function' ? !sel.canMoveBlocks([id], '') : null;
    }, ids[1]);
    test.skip(refused === null, 'canMoveBlocks is not on this WordPress');
    expect(refused).toBe(true);

    // The locked block's arrows are disabled — the UI never offers a
    // move core would silently refuse (review 2026-08-27, finding 1).
    await overviewBoxButton(page, ids[1], 'pick').click();
    await expect(overviewBoxButton(page, ids[1], 'up')).toBeDisabled();
    await expect(overviewBoxButton(page, ids[1], 'down')).toBeDisabled();

    // Control: the free block beside it still moves.
    await overviewBoxButton(page, ids[0], 'pick').click();
    await expect(overviewBoxButton(page, ids[0], 'down')).toBeEnabled();

    // Nor can the locked block be DRAGGED: the drag refuses to start
    // (no drop line), so the order survives the gesture.
    const grab = await page.evaluate((id) => {
      const pick = document.querySelector(
        `#toolrail-overview .toolrail-ov-box[data-clientid="${id}"] [data-ov-action="pick"]`
      );
      const r = pick.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 8) };
    }, ids[1]);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x, grab.y + 200, { steps: 6 });
    await expect(page.locator('.toolrail-ov-dropline')).toHaveCount(0);
    await page.mouse.up();
    expect(await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    )).toEqual(ids);
  });

  test('narrowing below the small-screen breakpoint closes the overview instead of stranding it', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();

    // Below 783px the overlay (the only Escape surface) and the rail are
    // display:none — the overview must close itself rather than leave a
    // scaled canvas with no way back (review 2026-08-27, finding 2).
    await page.setViewportSize({ width: 600, height: 800 });
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    const clean = await page.evaluate(() => ({
      bodyClass: document.body.classList.contains('toolrail-overview-on'),
      hosts: document.querySelectorAll('.toolrail-ov-scale-host').length,
      frameh: document.body.style.getPropertyValue('--toolrail-ov-frameh'),
    }));
    expect(clean).toEqual({ bodyClass: false, hosts: 0, frameh: '' });
  });

  test('opening disarms an armed tool, and the overlay captures canvas clicks', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);

    await page.locator('#toolrail-rail [data-tool="pin:core/group"]').click();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/group"]')).toHaveAttribute('aria-pressed', 'true');

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    // Disarmed on open (review 2026-08-27, finding 4)…
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/group"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');

    // …and the overlay is the topmost pointer surface over the canvas,
    // so no click can fall through and edit the document underneath.
    // Guard the guard first: the point probed must be inside the overlay.
    const probe = await page.evaluate(() => {
      const o = document.getElementById('toolrail-overview');
      const r = o.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      return { x, y, captured: !!(hit && (hit === o || o.contains(hit))) };
    });
    expect(probe.captured).toBe(true);

    const before = (await blockNames(page)).length;
    await page.mouse.click(probe.x, probe.y);
    await page.waitForTimeout(300);
    expect((await blockNames(page)).length).toBe(before);
  });

  test('a long document can be zoomed and panned', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 30 }, (_, i) =>
          createBlock('core/paragraph', { content: 'PARA-' + i })
        )
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(30);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview .toolrail-ov-box').first()).toBeVisible();

    const readScale = () => page.evaluate(() =>
      parseFloat(document.body.style.getPropertyValue('--toolrail-overview-scale'))
    );
    // Bare paragraphs floor the DEFAULT zoom at full size (the
    // content-derived rule) — the manual buttons still go below it and
    // back up. Zoom out first, then in.
    const k0 = await readScale();
    await page.locator('#toolrail-overview [data-ov-action="zoom-out"]').click();
    const k1 = await readScale();
    expect(k1).toBeLessThan(k0);
    await page.locator('#toolrail-overview [data-ov-action="zoom-in"]').click();
    const k2 = await readScale();
    expect(k2).toBeGreaterThan(k1);

    // Whatever doesn't fit, the wheel pans instead of shrinking further
    // — the "very long pages" path.
    const tyBefore = await page.evaluate(() =>
      parseFloat(document.body.style.getPropertyValue('--toolrail-ov-ty')) || 0
    );
    const c = await page.evaluate(() => {
      const r = document.getElementById('toolrail-overview').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await page.mouse.move(c.x, c.y);
    await page.mouse.wheel(0, 400);
    await expect.poll(async () => page.evaluate(() =>
      parseFloat(document.body.style.getPropertyValue('--toolrail-ov-ty')) || 0
    )).toBeLessThan(tyBefore);
  });

  test('the zoom floor keeps sections a usable size on very long documents', async ({ page }) => {
    await openNewPost(page);

    // 40 real sections (heading + paragraph groups) — long enough that a
    // naive whole-document fit would shrink each section into a sliver
    // (the post-773 report).
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 40 }, (_, i) =>
          createBlock('core/group', {}, [
            createBlock('core/heading', { content: 'SECTION-' + i }),
            createBlock('core/paragraph', { content: 'Body for section ' + i }),
          ])
        )
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(40);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview .toolrail-ov-box').first()).toBeVisible();

    const m = await page.evaluate(() => {
      const content = document.querySelector('.interface-interface-skeleton__content');
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const naiveFit = (content.clientHeight - 24) / frame.contentDocument.body.scrollHeight;
      const k = parseFloat(document.body.style.getPropertyValue('--toolrail-overview-scale'));
      const hs = Array.from(document.querySelectorAll('#toolrail-overview .toolrail-ov-box'))
        .map((b) => b.getBoundingClientRect().height)
        .sort((a, b) => a - b);
      return { naiveFit, k, medianH: hs[Math.floor(hs.length / 2)] };
    });

    // The scale did NOT chase the naive fit down: the median section
    // stays a usable size, and the remainder is reachable by panning.
    expect(m.k).toBeGreaterThan(m.naiveFit + 0.01);
    expect(m.medianH).toBeGreaterThanOrEqual(44);
  });

  test('opening clears the selected block\'s toolbar; closing restores the selection', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);

    const picked = await page.evaluate(() => {
      const order = window.wp.data.select('core/block-editor').getBlockOrder('');
      window.wp.data.dispatch('core/block-editor').selectBlock(order[0]);
      return order[0];
    });
    expect(await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getSelectedBlockClientId()
    )).toBe(picked);

    // Open: the selection (and with it the floating block toolbar that
    // was fighting the zoomed-out view) goes away for the mode's
    // lifetime…
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    expect(await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getSelectedBlockClientId()
    )).toBeNull();

    // …and comes back on close, so the author's place is kept.
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    expect(await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getSelectedBlockClientId()
    )).toBe(picked);

    // The focus contract holds on THIS path too: restoring the prior
    // selection re-renders chrome a frame later, the same steal the
    // landing path had (review 2026-08-31, finding 1) — the re-assert
    // must cover both. Poll: the steal and its recovery are async.
    await expect.poll(async () => page.evaluate(() =>
      document.activeElement && document.activeElement.dataset
        ? document.activeElement.dataset.tool
        : ''
    )).toBe('overview');
  });

  test('a drilled root taller than the viewport is top-aligned and pans — never centered', async ({ page }) => {
    await openNewPost(page);

    // A group of many short paragraphs: the children's median floors the
    // drill-in zoom at ~1, making the root taller than the viewport —
    // the branch where centering must NOT engage (review 2026-08-27,
    // finding 5: this path was never exercised).
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/paragraph', { content: 'BEFORE' }),
        createBlock('core/group', {},
          Array.from({ length: 30 }, (_, i) =>
            createBlock('core/paragraph', { content: 'TALL-' + i })
          )),
        createBlock('core/paragraph', { content: 'AFTER' }),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(3);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();

    const groupId = (await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    ))[1];
    await overviewBoxButton(page, groupId, 'pick').click();
    await overviewBoxButton(page, groupId, 'enter').click();
    await expect(page.locator('#toolrail-overview [aria-current="location"]')).toHaveText('Group');
    await page.waitForTimeout(300);

    const m = await page.evaluate((gid) => {
      const overlay = document.getElementById('toolrail-overview');
      const o = overlay.getBoundingClientRect();
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const el = frame.contentDocument.querySelector(`[data-block="${gid}"]`);
      const r = el.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      const k = f.width / frame.offsetWidth;
      return {
        rootTopOffset: f.top + r.top * k - o.top,
        rootTallerThanViewport: r.height * k > o.height,
        ty: parseFloat(document.body.style.getPropertyValue('--toolrail-ov-ty')) || 0,
      };
    }, groupId);

    // Guard the guard: the root must genuinely overflow the viewport.
    expect(m.rootTallerThanViewport).toBe(true);
    // Top-aligned (small positive offset), not centered.
    expect(m.rootTopOffset).toBeGreaterThanOrEqual(-2);
    expect(m.rootTopOffset).toBeLessThan(80);

    // And the remainder is reachable by panning.
    const c = await page.evaluate(() => {
      const r = document.getElementById('toolrail-overview').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await page.mouse.move(c.x, c.y);
    await page.mouse.wheel(0, 400);
    await expect.poll(async () => page.evaluate(() =>
      parseFloat(document.body.style.getPropertyValue('--toolrail-ov-ty')) || 0
    )).toBeLessThan(m.ty);
  });

  test('growing the canvas is instant and stable — no creeping background, no dead tail space', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 6 }, (_, s) =>
          createBlock('core/group', {},
            Array.from({ length: 6 }, (_, i) =>
              createBlock('core/paragraph', { content: 'G' + s + '-P' + i })
            ))
        )
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(6);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview .toolrail-ov-box').first()).toBeVisible();

    // The frame height must be INSTANT and then HOLD: core's 0.4s
    // all-property iframe transition animated the growth, and measuring
    // body.scrollHeight (whose ~40vh click-to-append tail chases the
    // iframe's own height) re-targeted it in a feedback loop — the
    // canvas background visibly crept down the page (owner report,
    // 1707×898). Sampling at 120ms — well INSIDE where core's 0.4s
    // transition would still be mid-flight — is what proves
    // instantaneity, not merely eventual stability (review 2026-08-27,
    // finding 5).
    await page.waitForTimeout(120);
    const s1 = await page.evaluate(() =>
      document.querySelector('iframe[name="editor-canvas"]').offsetHeight
    );
    await page.waitForTimeout(1100);
    const state = await page.evaluate(() => {
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const idoc = frame.contentDocument;
      const order = window.wp.data.select('core/block-editor').getBlockOrder('');
      const last = idoc.querySelector(`[data-block="${order[order.length - 1]}"]`);
      const r = last.getBoundingClientRect();
      return {
        s2: frame.offsetHeight,
        transitionProperty: getComputedStyle(frame).transitionProperty,
        contentExtent: Math.round(r.top + r.height + (idoc.defaultView.scrollY || 0)),
        bodyScrollH: idoc.body.scrollHeight,
      };
    });
    expect(state.s2).toBe(s1);
    expect(state.transitionProperty).toBe('none');
    // The frame is sized to the CONTENT, not to the padded scrollHeight
    // — guard the guard: the padded tail must actually exist for the
    // exclusion to mean anything.
    expect(Math.abs(state.s2 - (state.contentExtent + 32))).toBeLessThanOrEqual(2);
    expect(state.bodyScrollH).toBeGreaterThan(state.s2 + 100);

    // The reviewer's variant (2026-08-27, finding 1): a full-height
    // (100vh) Cover resolves against the iframe's own height — the same
    // feedback mechanism as the appender tail, through a different
    // door. With the extent measured un-grown and cached, the frame
    // must hold here too instead of roughly doubling.
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/paragraph', { content: 'ABOVE' }),
        createBlock('core/cover', { minHeight: 100, minHeightUnit: 'vh' },
          [createBlock('core/paragraph', { content: 'HERO' })]),
        createBlock('core/paragraph', { content: 'BELOW' }),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(3);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview .toolrail-ov-box').first()).toBeVisible();
    await page.waitForTimeout(120);
    const c1 = await page.evaluate(() =>
      document.querySelector('iframe[name="editor-canvas"]').offsetHeight
    );
    // Outlive the settle pass and a full transition length.
    await page.waitForTimeout(1100);
    const c2 = await page.evaluate(() =>
      document.querySelector('iframe[name="editor-canvas"]').offsetHeight
    );
    expect(c2).toBe(c1);
  });

  test('a section can be dragged to a new spot — pointer sugar over the same move', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();

    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    // Drag ALPHA's box to below the group's midpoint.
    const points = await page.evaluate((pair) => {
      const rect = (id) => document
        .querySelector(`#toolrail-overview .toolrail-ov-box[data-clientid="${id}"]`)
        .getBoundingClientRect();
      const a = rect(pair[0]);
      const b = rect(pair[1]);
      return {
        fromX: Math.round(a.left + a.width / 2),
        fromY: Math.round(a.top + Math.min(a.height / 2, 12)),
        toY: Math.round(b.top + b.height / 2 + 10),
      };
    }, [ids[0], ids[1]]);

    await page.mouse.move(points.fromX, points.fromY);
    await page.mouse.down();
    await page.mouse.move(points.fromX, points.toY, { steps: 8 });
    // The drop line marks the target gap while the drag is live.
    await expect(page.locator('.toolrail-ov-dropline')).toBeVisible();
    await page.mouse.up();

    await expect.poll(async () => await blockNames(page)).toEqual([
      'core/group',
      'core/paragraph',
      'core/paragraph',
    ]);

    // Announced exactly like an arrow move — the drag is sugar over the
    // same dispatch, never a separate path.
    await expect.poll(async () => page.evaluate(() => {
      const region = document.getElementById('a11y-speak-polite');
      return region ? region.textContent : '';
    })).toContain('Moved Paragraph to position 2 of 3.');

    // The release's click must not ALSO toggle the controls open…
    await expect(page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])')).toHaveCount(0);
    // …and the drag chrome is gone.
    await expect(page.locator('.toolrail-ov-dropline')).toHaveCount(0);
    expect(await page.evaluate(() =>
      document.body.classList.contains('toolrail-ov-dragging')
    )).toBe(false);
  });
});

/** Drilled-box center/edges keyed by paragraph content, for the drag
    stress specs — rects are only trustworthy once the drill's settle
    pass has run, so poll until every box has painted somewhere real. */
async function boxPointsByContent(page, rootId) {
  await expect.poll(async () => page.evaluate((g) => {
    const sel = window.wp.data.select('core/block-editor');
    return sel.getBlockOrder(g).every((id) => {
      const b = document.querySelector(`#toolrail-overview .toolrail-ov-box[data-clientid="${id}"]`);
      return b && b.style.display !== 'none' && b.getBoundingClientRect().width > 10;
    });
  }, rootId)).toBe(true);
  return page.evaluate((g) => {
    const sel = window.wp.data.select('core/block-editor');
    const out = {};
    sel.getBlockOrder(g).forEach((id) => {
      const block = sel.getBlock(id);
      const label = block.name === 'core/column'
        ? block.innerBlocks[0].attributes.content.toString()
        : block.attributes.content.toString();
      const r = document
        .querySelector(`#toolrail-overview .toolrail-ov-box[data-clientid="${id}"]`)
        .getBoundingClientRect();
      out[label] = {
        x: r.left + r.width / 2,
        y: r.top + Math.min(r.height / 2, 12),
        left: r.left,
        right: r.right,
        top: r.top,
      };
    });
    return out;
  }, rootId);
}

/** Child contents at a root, via each child's own paragraph. */
function childContents(page, rootId) {
  return page.evaluate((g) => {
    const sel = window.wp.data.select('core/block-editor');
    return sel.getBlockOrder(g).map((id) => {
      const block = sel.getBlock(id);
      return block.name === 'core/column'
        ? block.innerBlocks[0].attributes.content.toString()
        : block.attributes.content.toString();
    });
  }, rootId);
}

/** Open the overview and drill into the first top-level block. */
async function drillIntoFirst(page) {
  await page.locator('#toolrail-rail [data-tool="overview"]').click();
  await expect(page.locator('#toolrail-overview')).toBeVisible();
  const rootId = await page.evaluate(() =>
    window.wp.data.select('core/block-editor').getBlockOrder('')[0]
  );
  await overviewBoxButton(page, rootId, 'pick').click();
  await overviewBoxButton(page, rootId, 'enter').click();
  return rootId;
}

test.describe('overview drag stress (grids, columns, notices)', () => {
  test('a grid cell drags HORIZONTALLY past its neighbor — vertical drop line, same-row reorder', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/group', { layout: { type: 'grid', columnCount: 2 } },
          ['CELL-A', 'CELL-B', 'CELL-C', 'CELL-D'].map((c) =>
            createBlock('core/paragraph', { content: c })
          )),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(1);

    const gridId = await drillIntoFirst(page);
    const pts = await boxPointsByContent(page, gridId);
    // The seed really is a 2×2 grid: A and B share a row, C sits below.
    expect(Math.abs(pts['CELL-A'].top - pts['CELL-B'].top)).toBeLessThan(4);
    expect(pts['CELL-C'].top).toBeGreaterThan(pts['CELL-A'].top + 10);

    // Drag A rightward past B's center, along the SAME row.
    await page.mouse.move(pts['CELL-A'].x, pts['CELL-A'].y);
    await page.mouse.down();
    await page.mouse.move(pts['CELL-B'].right - 5, pts['CELL-A'].y, { steps: 8 });
    // The gap marker for a same-row move is the VERTICAL line.
    await expect(page.locator('.toolrail-ov-dropline.is-vertical')).toBeVisible();
    await page.mouse.up();

    await expect.poll(() => childContents(page, gridId)).toEqual([
      'CELL-B', 'CELL-A', 'CELL-C', 'CELL-D',
    ]);
    await expect.poll(async () => page.evaluate(() => {
      const region = document.getElementById('a11y-speak-polite');
      return region ? region.textContent : '';
    })).toContain('Moved Paragraph to position 2 of 4.');
  });

  test('a grid cell drags DIAGONALLY into a gap on another row', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/group', { layout: { type: 'grid', columnCount: 2 } },
          ['CELL-A', 'CELL-B', 'CELL-C', 'CELL-D'].map((c) =>
            createBlock('core/paragraph', { content: c })
          )),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(1);

    const gridId = await drillIntoFirst(page);
    const pts = await boxPointsByContent(page, gridId);

    // Drag A down into row two, between C and D.
    const gapX = (pts['CELL-C'].right + pts['CELL-D'].left) / 2;
    await page.mouse.move(pts['CELL-A'].x, pts['CELL-A'].y);
    await page.mouse.down();
    await page.mouse.move(gapX, pts['CELL-C'].y, { steps: 8 });
    await expect(page.locator('.toolrail-ov-dropline.is-vertical')).toBeVisible();
    await page.mouse.up();

    await expect.poll(() => childContents(page, gridId)).toEqual([
      'CELL-B', 'CELL-C', 'CELL-A', 'CELL-D',
    ]);
  });

  test('columns reorder by horizontal drag the same way', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/columns', {}, ['COL-ONE', 'COL-TWO', 'COL-THREE'].map((c) =>
          createBlock('core/column', {}, [createBlock('core/paragraph', { content: c })])
        )),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(1);

    const columnsId = await drillIntoFirst(page);
    const pts = await boxPointsByContent(page, columnsId);

    // Drag the first column past the second — a column is just a block
    // in a one-row layout, so the same row/gap math must carry it.
    await page.mouse.move(pts['COL-ONE'].x, pts['COL-ONE'].y);
    await page.mouse.down();
    await page.mouse.move(pts['COL-TWO'].right - 5, pts['COL-ONE'].y, { steps: 8 });
    await expect(page.locator('.toolrail-ov-dropline.is-vertical')).toBeVisible();
    await page.mouse.up();

    await expect.poll(() => childContents(page, columnsId)).toEqual([
      'COL-TWO', 'COL-ONE', 'COL-THREE',
    ]);
  });

  test('a plain stack still drags with the horizontal line, first-to-last in one gesture', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 6 }, (_, s) =>
          createBlock('core/group', {}, [
            createBlock('core/paragraph', { content: 'SECTION-' + s }),
          ]))
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(6);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const points = await page.evaluate((pair) => {
      const rect = (id) => document
        .querySelector(`#toolrail-overview .toolrail-ov-box[data-clientid="${id}"]`)
        .getBoundingClientRect();
      const first = rect(pair[0]);
      const last = rect(pair[1]);
      return {
        fromX: Math.round(first.left + first.width / 2),
        fromY: Math.round(first.top + Math.min(first.height / 2, 12)),
        toY: Math.round(last.bottom + 6),
      };
    }, [ids[0], ids[ids.length - 1]]);

    await page.mouse.move(points.fromX, points.fromY);
    await page.mouse.down();
    await page.mouse.move(points.fromX, points.toY, { steps: 10 });
    // Stacked sections keep the HORIZONTAL gap line — the vertical
    // variant is only for side-by-side neighbors.
    await expect(page.locator('.toolrail-ov-dropline:not(.is-vertical)')).toBeVisible();
    await page.mouse.up();

    await expect.poll(async () => page.evaluate((id) =>
      window.wp.data.select('core/block-editor').getBlockOrder('').indexOf(id), ids[0]
    )).toBe(ids.length - 1);
  });

  test('an editor notice above the canvas costs the overview no reach; dismissing it refits', async ({ page }) => {
    await openNewPost(page);
    // The document from the fit test: several viewports tall.
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 4 }, (_, s) =>
          createBlock('core/group', {},
            Array.from({ length: 8 }, (_, i) =>
              createBlock('core/paragraph', { content: 'S' + s + '-PARA-' + i })
            ))
        )
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(4);

    // The same shape as the "There is an autosave" warning: a
    // dismissible notice rendered inside the content region, ABOVE the
    // visual editor — it shrinks the canvas viewport with no window
    // resize event (diagnosed on post 433, 2026-08-28).
    await page.evaluate(() => {
      window.wp.data.dispatch('core/notices').createWarningNotice(
        'There is an autosave of this post that is more recent than the version below.',
        { id: 'toolrail-e2e-autosave', isDismissible: true }
      );
    });
    await expect(page.locator('.components-notice')).toBeVisible();

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();

    // The overlay starts BELOW the notice — the notice stays readable
    // (and dismissible) above the mode instead of being fenced off.
    const placed = await page.evaluate(() => {
      const overlay = document.getElementById('toolrail-overview').getBoundingClientRect();
      const visual = document.querySelector('.editor-visual-editor').getBoundingClientRect();
      const notice = document.querySelector('.components-notice').getBoundingClientRect();
      return {
        overlayAtCanvas: Math.abs(overlay.top - visual.top) < 2,
        noticeAboveOverlay: notice.bottom <= overlay.top + 2,
      };
    });
    expect(placed.overlayAtCanvas).toBe(true);
    expect(placed.noticeAboveOverlay).toBe(true);

    // The bug being pinned: the LAST block must be reachable. Pan hard
    // to the bottom; with the viewport measured past the notice it ends
    // fully inside the content region.
    const center = await page.evaluate(() => {
      const o = document.getElementById('toolrail-overview').getBoundingClientRect();
      return { x: o.left + o.width / 2, y: o.top + o.height / 2 };
    });
    await page.mouse.move(center.x, center.y);
    await page.mouse.wheel(0, 4000);
    await expect.poll(async () => page.evaluate(() => {
      const content = document.querySelector('.interface-interface-skeleton__content');
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const order = window.wp.data.select('core/block-editor').getBlockOrder('');
      const last = frame.contentDocument.querySelector(`[data-block="${order[order.length - 1]}"]`);
      const f = frame.getBoundingClientRect();
      const k = frame.offsetWidth ? f.width / frame.offsetWidth : 1;
      const r = last.getBoundingClientRect();
      return f.top + (r.top + r.height) * k <= content.getBoundingClientRect().bottom + 1;
    })).toBe(true);

    // Removing the notice mid-overview refits: the canvas grows back
    // and the overlay climbs to the reclaimed top. (No window event
    // fires for this — the ResizeObserver is what catches it.)
    await page.evaluate(() => {
      window.wp.data.dispatch('core/notices').removeNotice('toolrail-e2e-autosave');
    });
    await expect.poll(async () => page.evaluate(() => {
      const overlay = document.getElementById('toolrail-overview').getBoundingClientRect();
      const content = document.querySelector('.interface-interface-skeleton__content').getBoundingClientRect();
      return Math.abs(overlay.top - content.top) < 2;
    })).toBe(true);
  });

  test('a stack of SHORT blocks at floor zoom still drags vertically — the 24px box floor must not fuse the column into one row', async ({ page }) => {
    await openNewPost(page);
    // Separators are the worst case for the row grouping: their painted
    // boxes hit positionOverviewBoxes' 24px minimum height at low zoom,
    // so every box in the column overlaps its neighbors vertically. A
    // vertical-only row test grouped the whole stack into ONE row and
    // handed a straight-down drag to the sideways X math (review
    // 2026-08-28, finding 1).
    //
    // A tall group LEADS the document: at floor zoom a bare stack of
    // separators is ~70px tall and sits entirely under the overview's
    // own bar, where no pointer can reach a box (elementFromPoint at
    // the first box's grab strip returns the zoom button). The group
    // pushes the separator stack below the bar.
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/group', {},
          Array.from({ length: 10 }, (_, i) =>
            createBlock('core/paragraph', { content: 'LEAD-' + i })
          )),
      ].concat(Array.from({ length: 12 }, () => createBlock('core/separator'))));
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(13);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    // The separators are ids[1..12]; the group at ids[0] stays put.
    const FIRST_SEP = 1;

    // Zoom all the way out — the floor is where the box heights clamp,
    // which is the state the bug needs.
    const scale = () => page.evaluate(() =>
      parseFloat(document.body.style.getPropertyValue('--toolrail-overview-scale')) || 0
    );
    let k = await scale();
    for (let i = 0; i < 15; i += 1) {
      await page.locator('#toolrail-overview [data-ov-action="zoom-out"]').click();
      const next = await scale();
      const stalled = next >= k - 0.0001;
      k = next;
      if (stalled) {
        break;
      }
    }

    // Rects are only trustworthy once the zoom's reposition pass has run.
    await expect.poll(async () => page.evaluate((list) => list.every((id) => {
      const b = document.querySelector(`#toolrail-overview .toolrail-ov-box[data-clientid="${id}"]`);
      return b && b.style.display !== 'none' && b.getBoundingClientRect().width > 10;
    }), ids)).toBe(true);
    // Painted boxes, in current document order. Floored boxes OVERLAP
    // and the later one paints on top, so a box's only grabbable strip
    // is the sliver above its successor's top — press anywhere lower and
    // the gesture drags the wrong block.
    const geometry = () => page.evaluate(() => {
      const sel = window.wp.data.select('core/block-editor');
      return sel.getBlockOrder('').map((id) => {
        const r = document
          .querySelector(`#toolrail-overview .toolrail-ov-box[data-clientid="${id}"]`)
          .getBoundingClientRect();
        return { id: id, top: r.top, bottom: r.bottom, height: r.height, x: r.left + r.width / 2 };
      });
    });
    const grabPoint = (boxes, i) => ({
      x: Math.round(boxes[i].x),
      y: Math.round(boxes[i].top + (i + 1 < boxes.length
        ? Math.max(1, Math.min(12, (boxes[i + 1].top - boxes[i].top) / 2))
        : 12)),
    });

    let boxes = await geometry();
    // The premise of the test: the separator boxes really are at the
    // 24px floor (plus at most the 2px borders, depending on
    // box-sizing), they overlap their neighbors by more than half
    // because of it — exactly what a vertical-only row test would fuse
    // — and they sit BELOW the bar where the pointer can reach them.
    expect(Math.round(boxes[FIRST_SEP].height)).toBeLessThanOrEqual(30);
    expect(boxes[FIRST_SEP].bottom - boxes[FIRST_SEP + 1].top)
      .toBeGreaterThan(boxes[FIRST_SEP].height / 2);
    const barBottom = await page.evaluate(() =>
      document.querySelector('#toolrail-overview .toolrail-ov-bar').getBoundingClientRect().bottom
    );
    expect(boxes[FIRST_SEP].top).toBeGreaterThan(barBottom);

    // Straight down the SAME X, to a gap INSIDE the stack — the drop
    // target has to come from the pointer's Y. With the column fused
    // into one row the marker turns vertical and the X math hands back
    // the row's own first index, so the block never moves at all.
    const target = FIRST_SEP + 6;
    const from = grabPoint(boxes, FIRST_SEP);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, Math.round(boxes[target].top + boxes[target].height / 2 + 1), { steps: 10 });
    await expect(page.locator('.toolrail-ov-dropline:not(.is-vertical)')).toBeVisible();
    await expect(page.locator('.toolrail-ov-dropline.is-vertical')).toHaveCount(0);
    await page.mouse.up();

    await expect.poll(async () => page.evaluate((id) =>
      window.wp.data.select('core/block-editor').getBlockOrder('').indexOf(id), ids[FIRST_SEP]
    )).toBeGreaterThan(FIRST_SEP);
    const landed = await page.evaluate((id) =>
      window.wp.data.select('core/block-editor').getBlockOrder('').indexOf(id), ids[FIRST_SEP]
    );
    expect(landed).toBeLessThan(ids.length - 1);

    // And the same gesture carried past the last box still means "after
    // everything", the way it does for a stack of tall sections.
    boxes = await geometry();
    const again = grabPoint(boxes, landed);
    await page.mouse.move(again.x, again.y);
    await page.mouse.down();
    await page.mouse.move(again.x, Math.round(boxes[boxes.length - 1].bottom + 6), { steps: 10 });
    await expect(page.locator('.toolrail-ov-dropline:not(.is-vertical)')).toBeVisible();
    await page.mouse.up();

    await expect.poll(async () => page.evaluate((id) =>
      window.wp.data.select('core/block-editor').getBlockOrder('').indexOf(id), ids[FIRST_SEP]
    )).toBe(ids.length - 1);
  });
});

/**
 * R9 — tool availability, and R10 — what "pressed" means. Before R9 the
 * overview disarmed on ENTRY only: any insert tool could be re-armed
 * under it, went pressed, and could never insert because the overlay
 * captures every canvas pointer event (measured 2026-08-28).
 */
test.describe('tool availability (R9) and pressed semantics (R10)', () => {
  const a11yText = (page) => page.evaluate(() => {
    const region = document.getElementById('a11y-speak-polite');
    return region ? region.textContent : '';
  });

  test('the overview dims exactly the canvas tools; a dimmed tool cannot arm; closing restores everything', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);

    // Three provider tools that pin the contract down from both sides:
    // an onActivate panel (default canvas: false — the Background Candy
    // case that proves "disable everything" is wrong), an onActivate
    // that DECLARES it needs the canvas, and an insert tool that
    // declares it does not.
    await page.evaluate(() => {
      window.__e2eFired = [];
      window.__e2eModes = [];
      window.addEventListener('toolrail:mode-changed', (e) => window.__e2eModes.push(e.detail.mode));
      window.toolrail.registerTool({
        id: 'e2e-panel', label: 'E2E Panel',
        onActivate: () => { window.__e2eFired.push('panel'); },
      });
      window.toolrail.registerTool({
        id: 'e2e-needs-canvas', label: 'E2E Needs Canvas',
        onActivate: () => { window.__e2eFired.push('needs-canvas'); },
        supports: { canvas: true },
      });
      window.toolrail.registerTool({
        id: 'e2e-insert-nocanvas', label: 'E2E Insert No Canvas',
        insertBlock: 'core/quote',
        supports: { canvas: false },
      });
    });
    expect(await page.evaluate(() => window.toolrail.getMode())).toBe('edit');

    const rail = (id) => page.locator(`#toolrail-rail [data-tool="${id}"]`);
    const section = rail('pin:core/group');
    const overview = rail('overview');

    // Control for the dimming assertions below: nothing is dimmed in
    // edit mode, and the tooltip carries no reason.
    await expect(page.locator('#toolrail-rail [aria-disabled="true"]')).toHaveCount(0);
    const plainTitle = await section.getAttribute('title');
    expect(plainTitle).not.toContain('not available');

    await overview.click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    expect(await page.evaluate(() => window.toolrail.getMode())).toBe('overview');

    // Dimmed: everything whose activation is completed by a canvas click.
    for (const id of ['pin:core/group', 'pin:core/paragraph', 'pin:core/heading', 'pin:core/image', 'e2e-needs-canvas']) {
      await expect(rail(id), id).toHaveAttribute('aria-disabled', 'true');
    }
    // Live: Select (the "no tool" state), the overview toggle, both
    // chrome buttons, the panel tool, and the insert tool that opted out.
    for (const id of ['select', 'overview', 'help', 'settings', 'e2e-panel', 'e2e-insert-nocanvas']) {
      await expect(rail(id), id).not.toHaveAttribute('aria-disabled', 'true');
    }

    // The reason rides the pointer tooltip; the NAME is unchanged (the
    // dimmed state itself is what aria-disabled conveys).
    expect(await section.getAttribute('title')).toBe(plainTitle + ' — not available in Section overview');
    expect(await section.getAttribute('aria-label')).toBe('Group (pinned block)');

    // One announcement covers the lot, folded into the open message.
    await expect.poll(() => a11yText(page)).toContain('Insert tools are unavailable until you close the overview.');

    // A dimmed tool is inert: no arm, no pressed, Select stays pressed.
    // (force: Playwright's own actionability check refuses to click
    // aria-disabled controls — the rail's handler is what is under test.)
    await section.click({ force: true });
    await expect(section).toHaveAttribute('aria-pressed', 'false');
    await expect(rail('select')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.toolrail.getActiveTool())).toBe('select');
    await rail('e2e-needs-canvas').click({ force: true });
    expect(await page.evaluate(() => window.__e2eFired)).toEqual([]);
    // …while a live provider tool still runs — the whole point of a
    // capability flag over a blanket disable.
    await rail('e2e-panel').click();
    expect(await page.evaluate(() => window.__e2eFired)).toEqual(['panel']);

    // R10: the open toggle says so in its tooltip. Its pressed state is
    // "surface open", and Select's is "nothing armed" — both true.
    expect(await overview.getAttribute('title')).toContain(' — open');
    await expect(overview).toHaveAttribute('aria-pressed', 'true');

    // Close: every dimming lifts, tooltips return to plain.
    await page.locator('#toolrail-overview [data-ov-action="close"]').click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    await expect(page.locator('#toolrail-rail [aria-disabled="true"]')).toHaveCount(0);
    expect(await section.getAttribute('title')).toBe(plainTitle);
    expect(await overview.getAttribute('title')).not.toContain(' — open');
    expect(await page.evaluate(() => window.toolrail.getMode())).toBe('edit');
    expect(await page.evaluate(() => window.__e2eModes)).toEqual(['overview', 'edit']);

    // And the tool arms again — restoration is real, not cosmetic.
    await section.click();
    await expect(section).toHaveAttribute('aria-pressed', 'true');
  });

  test('dimmed tools keep their place in the arrow-key order and keep focus', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/group"]')).toHaveAttribute('aria-disabled', 'true');

    // Enter the rail at Select (live) and arrow onto Group (dimmed).
    // Mutation check: swap aria-disabled for the disabled attribute and
    // this fails — a natively disabled button refuses focus(), so the
    // roving tabindex lands nowhere and activeElement stays on Select.
    await page.locator('#toolrail-rail [data-tool="select"]').focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('pin:core/group');
    expect(await page.evaluate(() => document.activeElement.getAttribute('aria-disabled'))).toBe('true');

    // Enter on the dimmed button is inert too (the click path is the
    // keyboard path for a native button).
    await page.keyboard.press('Enter');
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/group"]')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('pin:core/group');

    // The order continues past it: the next arrow reaches the pinned
    // Paragraph slot, also dimmed, also focusable.
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('pin:core/paragraph');
  });

  test('a flyout with one live child stays live and opens instead of arming; its dimmed child is inert', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);

    await page.evaluate(() => {
      window.__e2eFired = [];
      window.toolrail.registerTool({
        id: 'e2e-fly-insert', label: 'E2E Fly Insert', parent: 'text', insertBlock: 'core/quote',
      });
      window.toolrail.registerTool({
        id: 'e2e-fly-panel', label: 'E2E Fly Panel', parent: 'text',
        onActivate: () => { window.__e2eFired.push('fly-panel'); },
      });
    });

    const text = page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]');
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();

    // Mixed flyout: the parent's OWN action (arm Paragraph) is
    // unavailable, but a child is live, so the button is not dimmed…
    await expect(text).not.toHaveAttribute('aria-disabled', 'true');
    // …and Heading, with no children, is (the control).
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/heading"]')).toHaveAttribute('aria-disabled', 'true');

    // Click opens the flyout rather than arming the parent.
    await text.click();
    await expect(page.locator('.toolrail-flyout')).toBeVisible();
    await expect(text).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => window.toolrail.getActiveTool())).toBe('select');

    // Children are judged one by one.
    const insertItem = page.locator('.toolrail-flyout [data-tool="e2e-fly-insert"]');
    const panelItem = page.locator('.toolrail-flyout [data-tool="e2e-fly-panel"]');
    await expect(insertItem).toHaveAttribute('aria-disabled', 'true');
    await expect(panelItem).not.toHaveAttribute('aria-disabled', 'true');
    expect(await insertItem.getAttribute('title')).toContain('not available in Section overview');

    // The dimmed item does nothing (the flyout even stays open); the
    // live one runs.
    await insertItem.click({ force: true });
    expect(await page.evaluate(() => window.toolrail.getActiveTool())).toBe('select');
    await expect(page.locator('.toolrail-flyout')).toBeVisible();
    await panelItem.click();
    expect(await page.evaluate(() => window.__e2eFired)).toEqual(['fly-panel']);

    // Back in edit mode the parent arms on click again, as it always did.
    await page.locator('#toolrail-overview [data-ov-action="close"]').click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    await text.click();
    await expect(text).toHaveAttribute('aria-pressed', 'true');
  });

  test('an open toggle shows the edge bar without the armed fill; Help and Options show the bar while their dialog is open', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);

    const paint = (id) => page.evaluate((toolId) => {
      const btn = document.querySelector(`#toolrail-rail [data-tool="${toolId}"]`);
      return {
        kind: btn.dataset.kind || null,
        bg: getComputedStyle(btn).backgroundColor,
        bar: getComputedStyle(btn, '::before').width,
      };
    }, id);

    // Control: an ARMED tool is fill + bar.
    await page.locator('#toolrail-rail [data-tool="pin:core/group"]').click();
    const armed = await paint('pin:core/group');
    expect(armed.kind).toBe('arming');
    expect(armed.bar).toBe('3px');
    expect(armed.bg).not.toBe('rgba(0, 0, 0, 0)');
    const armedFill = armed.bg;

    // The open overview: bar, no fill — pressed, but a different blue.
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-rail [data-tool="overview"]')).toHaveAttribute('aria-pressed', 'true');
    const open = await paint('overview');
    expect(open.kind).toBe('toggle');
    expect(open.bar).toBe('3px');
    expect(open.bg).not.toBe(armedFill);
    await page.locator('#toolrail-overview [data-ov-action="close"]').click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    expect((await paint('overview')).bar).not.toBe('3px');

    // Help and Options: aria-expanded (a dialog opener is not a pressed
    // toggle), and the bar while open, so an open panel has SOME visible
    // state on the rail.
    for (const id of ['help', 'settings']) {
      expect((await paint(id)).bar, id + ' closed').not.toBe('3px');
      await page.locator(`#toolrail-rail [data-tool="${id}"]`).click();
      await expect(page.locator(`#toolrail-rail [data-tool="${id}"]`)).toHaveAttribute('aria-expanded', 'true');
      const shown = await paint(id);
      expect(shown.bar, id + ' open').toBe('3px');
      expect(shown.bg, id + ' open').not.toBe(armedFill);
      await page.keyboard.press('Escape');
      await expect(page.locator(`#toolrail-rail [data-tool="${id}"]`)).toHaveAttribute('aria-expanded', 'false');
    }
  });

  test('every appearance keeps a dimmed icon at 3:1 or better, including a hostile custom pair\'s fallback', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/group"]')).toHaveAttribute('aria-disabled', 'true');

    // Measured color of the dimmed icon against the rail background,
    // straight from computed style — the token, not opacity math.
    const ratio = () => page.evaluate(() => {
      const parse = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const fg = parse(getComputedStyle(document.querySelector('#toolrail-rail [data-tool="pin:core/group"]')).color);
      const bg = parse(getComputedStyle(document.getElementById('toolrail-rail')).backgroundColor);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    });

    // Dark (stylesheet default).
    expect(await ratio()).toBeGreaterThanOrEqual(3);
    // It is DIMMER than a live tool — the state is visible, not just
    // announced.
    const liveRatio = await page.evaluate(() => {
      const parse = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const fg = parse(getComputedStyle(document.querySelector('#toolrail-rail [data-tool="help"]')).color);
      const bg = parse(getComputedStyle(document.getElementById('toolrail-rail')).backgroundColor);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    });
    expect(await ratio()).toBeLessThan(liveRatio);

    // Light and Gray presets, then a custom pair. The settings dialog
    // is live under the overview (canvas: false), so this can run
    // without leaving the mode.
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    const dimToken = () => page.evaluate(() =>
      document.getElementById('toolrail-region').style.getPropertyValue('--toolrail-dim')
    );
    // The preset must CARRY its own token (review 2026-08-29: a bare
    // >= 3 here passed on the stylesheet's dark default alone).
    for (const [preset, token] of [['light', '#838383'], ['gray', '#737679']]) {
      await page.locator(`input[data-appearance="${preset}"]`).check();
      await expect.poll(() => dimToken(), preset).toBe(token);
      expect(await ratio(), preset).toBeGreaterThanOrEqual(3);
    }
    await page.locator('input[data-appearance="custom"]').check();
    await setColor(page, 'toolrail-settings-appearance-bg', '#ffffff');
    await setColor(page, 'toolrail-settings-appearance-fg', '#1e1e1e');
    await expect.poll(() => ratio(), 'custom good pair').toBeGreaterThanOrEqual(3);
    // An ORDINARY passing pair (7.46:1 in the dialog) must still get a
    // dim that is visibly not the foreground — the first derivation
    // collapsed exactly here (review 2026-08-29: the 45% mix measured
    // 2.55:1, failed the floor, and dim === fg with no warning shown).
    await setColor(page, 'toolrail-settings-appearance-fg', '#555555');
    await expect.poll(() => dimToken(), 'ordinary pair').not.toBe('#555555');
    expect(await ratio(), 'ordinary pair on bg').toBeGreaterThanOrEqual(3);
    expect(await ratio(), 'ordinary pair dimmer than fg').toBeLessThan(await liveRatioNow());
    // A hostile pair cannot clear 3:1 at all (fg:bg itself is ~1.6:1);
    // the derivation then falls back to the pair's own fg rather than
    // a still-dimmer mix — the dialog already warns about that pair.
    await setColor(page, 'toolrail-settings-appearance-bg', '#777777');
    await setColor(page, 'toolrail-settings-appearance-fg', '#999999');
    await expect.poll(() => dimToken(), 'hostile pair').toBe('#999999');

    async function liveRatioNow() {
      return page.evaluate(() => {
        const parse = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
        const lum = (rgb) => {
          const [r, g, b] = rgb.map((v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const fg = parse(getComputedStyle(document.querySelector('#toolrail-rail [data-tool="help"]')).color);
        const bg = parse(getComputedStyle(document.getElementById('toolrail-rail')).backgroundColor);
        const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
        return (hi + 0.05) / (lo + 0.05);
      });
    }
  });

  test('the wide-mode chevron is a toggle: bar, no armed fill (review 2026-08-29)', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-widetoggle').check();
    await page.keyboard.press('Escape');
    const chevron = page.locator('#toolrail-rail [data-tool="wide-toggle"]');
    await expect(chevron).toBeVisible();
    await chevron.click();
    await expect(chevron).toHaveAttribute('aria-pressed', 'true');
    const armedFill = await page.evaluate(() =>
      getComputedStyle(document.getElementById('toolrail-region')).getPropertyValue('--toolrail-pressed').trim()
    );
    const paint = await page.evaluate(() => {
      const btn = document.querySelector('#toolrail-rail [data-tool="wide-toggle"]');
      return { kind: btn.dataset.kind, bg: getComputedStyle(btn).backgroundColor, bar: getComputedStyle(btn, '::before').width };
    });
    expect(paint.kind).toBe('toggle');
    expect(paint.bar).toBe('3px');
    // #3858e9 is rgb(56, 88, 233); the toggle must not wear it.
    expect(paint.bg).not.toBe('rgb(56, 88, 233)');
    expect(armedFill).toBe('#3858e9');
  });

  test('ArrowRight does not open the flyout of a fully dimmed container (review 2026-08-29)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    // Two arming children under Heading: the parent AND every child
    // need the canvas, so the button dims as a unit.
    await page.evaluate(() => {
      window.toolrail.registerTool({ id: 'e2e-h-a', label: 'A', parent: 'heading', insertBlock: 'core/quote' });
      window.toolrail.registerTool({ id: 'e2e-h-b', label: 'B', parent: 'heading', insertBlock: 'core/list' });
    });
    const heading = page.locator('#toolrail-rail [data-tool="pin:core/heading"]');
    // Control: in edit mode the key opens it.
    await heading.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.toolrail-flyout')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.toolrail-flyout')).toHaveCount(0);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(heading).toHaveAttribute('aria-disabled', 'true');
    await heading.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    await expect(page.locator('.toolrail-flyout')).toHaveCount(0);
  });
});

test.describe('restore default tools', () => {
  test('restores exactly the missing defaults, appended in default order, never a reset', async ({ page }) => {
    await openNewPost(page);

    // One default missing, one extra pin present: restore must return
    // ONLY Heading, appended, with the author's arrangement intact —
    // this is the assertion a refactor-to-reset flattens.
    await page.evaluate(() => {
      window.toolrail.unpinBlock('core/heading');
      window.toolrail.pinBlock('core/quote');
    });
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('.toolrail-settings-restore').click();

    await expect(page.locator('#toolrail-settings-pinned-status')).toHaveText('Restored 1 default tool.');
    expect(JSON.parse(await getPref(page, 'toolrail-quick-slots'))).toEqual([
      'core/group', 'core/paragraph', 'core/image', 'core/quote', 'core/heading',
    ]);

    // Nothing missing: says so, changes nothing.
    await page.locator('.toolrail-settings-restore').click();
    await expect(page.locator('#toolrail-settings-pinned-status')).toHaveText('All default tools are already pinned.');
    expect(JSON.parse(await getPref(page, 'toolrail-quick-slots'))).toEqual([
      'core/group', 'core/paragraph', 'core/image', 'core/quote', 'core/heading',
    ]);

    // All four missing: all four come back, in DEFAULT_SLOTS order,
    // after the pin the author kept.
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      ['core/group', 'core/paragraph', 'core/heading', 'core/image'].forEach((n) =>
        window.toolrail.unpinBlock(n)
      );
    });
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('.toolrail-settings-restore').click();
    await expect(page.locator('#toolrail-settings-pinned-status')).toHaveText('Restored 4 default tools.');
    expect(JSON.parse(await getPref(page, 'toolrail-quick-slots'))).toEqual([
      'core/quote', 'core/group', 'core/paragraph', 'core/heading', 'core/image',
    ]);

    // The migration stamp is not this button's to touch.
    expect(await getPref(page, 'toolrail-slots-migrated')).toBe('1');
  });

  test('a corrupt stored list is refused, not overwritten', async ({ page }) => {
    await openNewPost(page);

    // loadSlots() flattens key-absent, key-empty and unparseable to the
    // same [] — restore overwriting a corrupt-but-still-stored value
    // would be a reset wearing restore's label (review 2026-08-27,
    // finding 3).
    await page.evaluate(() => {
      window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-quick-slots', 'not-json{{{');
    });
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('.toolrail-settings-restore').click();

    await expect(page.locator('#toolrail-settings-pinned-status')).toContainText('could not be read');
    expect(await getPref(page, 'toolrail-quick-slots')).toBe('not-json{{{');
  });
});

test.describe('Group as a pinned default (0.1.22)', () => {
  test('Group ships pinned at the head, inserts core\'s bare Group, and unpins like any pin', async ({ page }) => {
    await openNewPost(page);

    const group = page.locator('#toolrail-rail [data-tool="pin:core/group"]');
    await expect(group).toHaveCount(1);
    // No built-in Section tool remains (owner decision 2026-09-02).
    await expect(page.locator('#toolrail-rail [data-tool="section"]')).toHaveCount(0);

    await group.click();
    await expect(group).toHaveAttribute('aria-pressed', 'true');
    await clickBelowContent(page);

    // Core's bare Group, exactly as the inserter adds it — no layout, no
    // inner blocks, so it lands as the layout picker (owner decision
    // 2026-09-02: a pin carries no settings of its own).
    await expect.poll(async () => await blockNames(page)).toEqual(['core/group']);
    const inserted = await page.evaluate(() => {
      const b = window.wp.data.select('core/block-editor').getBlocks()[0];
      return { layout: b.attributes.layout || null, inner: b.innerBlocks.map((i) => i.name) };
    });
    expect(inserted).toEqual({ layout: null, inner: [] });
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');

    // An ordinary pin: it unpins, and the account list says so.
    await page.evaluate(() => window.toolrail.unpinBlock('core/group'));
    await expect(group).toHaveCount(0);
    expect(JSON.parse(await getPref(page, 'toolrail-quick-slots'))).toEqual([
      'core/paragraph', 'core/heading', 'core/image',
    ]);
  });

  test('an account stamped before 0.1.22 gets Group prepended once; an emptied rail stays empty', async ({ page }) => {
    await openNewPost(page);

    // An account that ran the first lift under an older build and has a
    // pin of its own: Group joins ahead of everything, exactly once.
    await page.evaluate(() => {
      const disp = window.wp.data.dispatch('core/preferences');
      disp.set('toolrail', 'toolrail-quick-slots', JSON.stringify(['core/paragraph', 'core/quote']));
      disp.set('toolrail', 'toolrail-slots-migrated', '1');
      disp.set('toolrail', 'toolrail-group-seeded', undefined);
      window.localStorage.removeItem('toolrail-group-seeded');
    });
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    expect(JSON.parse(await getPref(page, 'toolrail-quick-slots'))).toEqual([
      'core/group', 'core/paragraph', 'core/quote',
    ]);
    expect(await getPref(page, 'toolrail-group-seeded')).toBe('1');

    // Stamped: unpinning Group now sticks across a reload.
    await page.evaluate(() => window.toolrail.unpinBlock('core/group'));
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/group"]')).toHaveCount(0);

    // A rail the author emptied after the first stamp is a decision the
    // lift respects: nothing is prepended, but the stamp is written.
    await page.evaluate(() => {
      const disp = window.wp.data.dispatch('core/preferences');
      disp.set('toolrail', 'toolrail-quick-slots', JSON.stringify([]));
      disp.set('toolrail', 'toolrail-group-seeded', undefined);
      window.localStorage.removeItem('toolrail-group-seeded');
    });
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#toolrail-rail [data-tool^="pin:"]')).toHaveCount(0);
    expect(await getPref(page, 'toolrail-group-seeded')).toBe('1');
  });
});

test.describe('core inserter while a tool is armed', () => {
  async function seedTwoParagraphs(page) {
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/paragraph', { content: 'FIRST' }),
        createBlock('core/paragraph', { content: 'SECOND' }),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(2);
  }

  /** The midpoint of the gap between the first two root blocks, in
      canvas-viewport coordinates. */
  async function gapBetweenFirstTwo(page) {
    return canvas(page).locator('body').evaluate(() => {
      const blocks = document.querySelectorAll('.is-root-container > [data-block]');
      const a = blocks[0].getBoundingClientRect();
      const b = blocks[1].getBoundingClientRect();
      return { x: (a.left + a.right) / 2, y: (a.bottom + b.top) / 2 };
    });
  }

  /** Hover that gap until core raises its between-block "+" popover
      (it shows on mousemove over the gap, in the EDITOR document). */
  async function hoverGap(page) {
    const gap = await gapBetweenFirstTwo(page);
    const frame = await page.locator('iframe[name="editor-canvas"]').boundingBox();
    await page.mouse.move(frame.x + gap.x, frame.y + gap.y - 3);
    await page.mouse.move(frame.x + gap.x, frame.y + gap.y);
    await page.mouse.move(frame.x + gap.x + 2, frame.y + gap.y);
  }

  test('the between-block "+" is hidden while a tool is armed, and back when disarmed', async ({ page }) => {
    await openNewPost(page);
    await seedTwoParagraphs(page);

    const plus = page.locator('.block-editor-block-popover__inbetween .block-editor-block-list__insertion-point.is-with-inserter');
    // Control: with nothing armed, hovering the gap raises core's "+".
    await hoverGap(page);
    await expect(plus).toBeVisible({ timeout: 5000 });

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    await expect(page.locator('body')).toHaveClass(/toolrail-hides-inserter/);
    await hoverGap(page);
    await expect(plus).toBeHidden();

    // Only the "+" goes. The same popover shell carries the drop line a
    // drag shows — an insertion point WITHOUT the inserter option, which
    // is exactly what core's drop zone dispatches — and that must
    // survive arming (review 2026-09-02, finding 4).
    await page.evaluate(() => window.wp.data.dispatch('core/block-editor').showInsertionPoint('', 1));
    const line = page.locator('.block-editor-block-popover__inbetween .block-editor-block-list__insertion-point:not(.is-with-inserter)');
    await expect(line).toBeVisible({ timeout: 5000 });
    await page.evaluate(() => window.wp.data.dispatch('core/block-editor').hideInsertionPoint());

    await canvas(page).locator('body').press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/toolrail-hides-inserter/);
  });

  test('the Toolbar settings checkbox turns the hiding off and on', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    const box = page.locator('#toolrail-settings-hideinserter');
    await expect(box).toBeChecked(); // on by default
    await box.uncheck();
    await expect.poll(async () => await getPref(page, 'toolrail-hide-core-inserter')).toBe('0');
    await page.keyboard.press('Escape');

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    await expect(page.locator('body')).not.toHaveClass(/toolrail-hides-inserter/);
    await canvas(page).locator('body').press('Escape');

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await box.check();
    await page.keyboard.press('Escape');
    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    await expect(page.locator('body')).toHaveClass(/toolrail-hides-inserter/);
  });

  test('an armed click in the gap between two blocks inserts between them, not at the end', async ({ page }) => {
    await openNewPost(page);
    await seedTwoParagraphs(page);

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    const gap = await gapBetweenFirstTwo(page);

    // Guard the guard: the point is on the block list and on neither
    // block — the case that used to fall through to "append at end".
    const hit = await canvas(page).locator('body').evaluate((body, g) => {
      const el = body.ownerDocument.elementFromPoint(g.x, g.y);
      return {
        onBlock: !!el.closest('[data-block]'),
        onList: !!el.closest('.block-editor-block-list__layout'),
      };
    }, gap);
    expect(hit).toEqual({ onBlock: false, onList: true });

    const bodyTop = await canvas(page).locator('body').evaluate((b) => b.getBoundingClientRect().top);
    await canvas(page).locator('body').click({
      position: { x: Math.round(gap.x), y: Math.round(gap.y - bodyTop) },
    });
    await expect.poll(async () => await blockNames(page)).toEqual([
      'core/paragraph', 'core/heading', 'core/paragraph',
    ]);
  });
});

test.describe('attach watcher and the Group lift (review 2026-09-02, finding 1)', () => {
  test('a late attach that brings a 0.1.21-stamped, Group-less account still gets the Group lift', async ({ page }) => {
    await openNewPost(page);
    await expect(page.locator('#toolrail-rail [data-tool^="pin:"]')).toHaveCount(4);

    // The real attach landing AFTER boot, carrying an account stamped
    // under 0.1.21: first stamp present, Group stamp absent, Group-less
    // pins. Boot had already stamped Group against the empty pre-attach
    // store, so a watcher keyed on the first stamp alone stood down here
    // and the lift never reached this account. A no-op set() keeps the
    // synthetic layer from touching the real account.
    await page.evaluate(() => window.wp.data.dispatch('core/preferences').setPersistenceLayer({
      get: () => Promise.resolve({
        toolrail: {
          'toolrail-quick-slots': JSON.stringify(['core/paragraph', 'core/heading', 'core/image']),
          'toolrail-slots-migrated': '1',
        },
      }),
      set: () => {},
    }));

    await expect(page.locator('#toolrail-rail [data-tool^="pin:"]')).toHaveCount(4, { timeout: 5000 });
    expect(JSON.parse(await getPref(page, 'toolrail-quick-slots'))).toEqual([
      'core/group', 'core/paragraph', 'core/heading', 'core/image',
    ]);
    expect(await getPref(page, 'toolrail-group-seeded')).toBe('1');
  });
});

test.describe('armed insertion into containers (review 2026-09-02, findings 2 and 3)', () => {
  /** Click the canvas at a point measured in canvas-viewport coordinates. */
  async function clickCanvasAt(page, point) {
    const bodyTop = await canvas(page).locator('body').evaluate((b) => b.getBoundingClientRect().top);
    await canvas(page).locator('body').click({
      position: { x: Math.round(point.x), y: Math.round(point.y - bodyTop) },
    });
  }

  /** data-type of the block under a canvas-viewport point, or null. */
  async function blockTypeAt(page, point) {
    return canvas(page).locator('body').evaluate((body, g) => {
      const el = body.ownerDocument.elementFromPoint(g.x, g.y);
      const block = el && el.closest('[data-block]');
      return block ? block.getAttribute('data-type') : null;
    }, point);
  }

  test('a gap inside a container that refuses the block climbs to the nearest parent that accepts it', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/columns', {}, [
          createBlock('core/column', {}, [createBlock('core/paragraph', { content: 'LEFT' })]),
          createBlock('core/column', {}, [createBlock('core/paragraph', { content: 'RIGHT' })]),
        ]),
      ]);
    });
    await expect.poll(async () => await blockNames(page)).toEqual(['core/columns']);

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    // The gutter between the two columns: on the Columns block's own
    // list, on neither column.
    const gap = await canvas(page).locator('body').evaluate(() => {
      const cols = document.querySelectorAll('[data-type="core/column"]');
      const a = cols[0].getBoundingClientRect();
      const b = cols[1].getBoundingClientRect();
      return { x: (a.right + b.left) / 2, y: (a.top + a.bottom) / 2 };
    });
    expect(await blockTypeAt(page, gap)).toBe('core/columns');

    await clickCanvasAt(page, gap);
    // Columns refuses a Heading (core's insertBlocks would have dropped
    // it without a word); the click meant "here", so the heading lands
    // right after the Columns block at the root, and the tool returns
    // to Select as after any insert.
    await expect.poll(async () => await blockNames(page)).toEqual(['core/columns', 'core/heading']);
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a gap between blocks laid out in a Row resolves by x, not by y alone', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/group', { layout: { type: 'flex', flexWrap: 'nowrap' } }, [
          createBlock('core/paragraph', { content: 'ROW-A' }),
          createBlock('core/paragraph', { content: 'ROW-B' }),
        ]),
      ]);
    });
    await expect.poll(async () => await blockNames(page)).toEqual(['core/group']);

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    const gap = await canvas(page).locator('body').evaluate(() => {
      const ps = document.querySelectorAll('[data-type="core/group"] [data-type="core/paragraph"]');
      const a = ps[0].getBoundingClientRect();
      const b = ps[1].getBoundingClientRect();
      return {
        x: (a.right + b.left) / 2,
        y: (a.top + a.bottom) / 2,
        sideBySide: b.left >= a.right,
        levelWithinPx: Math.abs(a.top - b.top),
      };
    });
    // Guard the guard: the two really share a row, with a gap between.
    expect(gap.sideBySide).toBe(true);
    expect(gap.levelWithinPx).toBeLessThan(4);
    expect(await blockTypeAt(page, gap)).toBe('core/group');

    await clickCanvasAt(page, gap);
    // Between A and B inside the Row. A y-only count saw both midpoints
    // level with the pointer and put the heading first.
    await expect.poll(async () => page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlocks()[0].innerBlocks.map((b) => b.name)
    )).toEqual(['core/paragraph', 'core/heading', 'core/paragraph']);
  });

  test('a block no parent on the path accepts is refused with a message, and the tool stays armed', async ({ page }) => {
    await openNewPost(page);
    // core/column may only live inside Columns: at the root it has no
    // legal home anywhere on the way up.
    await page.evaluate(() => window.toolrail.pinBlock('core/column'));
    const tool = page.locator('#toolrail-rail [data-tool="pin:core/column"]');
    await tool.click();
    await clickBelowContent(page);

    await expect(page.locator('.components-snackbar')).toContainText('Column cannot be inserted here.');
    // No Column. What remains is core's own empty-space paragraph, the
    // same as a Select click there leaves: the refusal path does not
    // sweep it, because removing the only (selected) block hands focus
    // back to core's appender, which inserts another one ~60ms later
    // (measured 2026-09-02 with a 40ms sampler).
    await page.waitForTimeout(400);
    expect(await blockNames(page)).toEqual(['core/paragraph']);
    await expect(tool).toHaveAttribute('aria-pressed', 'true');

    await page.evaluate(() => window.toolrail.unpinBlock('core/column'));
  });
});

test.describe('pattern pins and drag (0.1.23)', () => {
  /**
   * A registered pattern this site can insert at the root, and that a
   * drop would recognize as a pattern (several top-level blocks, or one
   * with children): every top-level block registered and allowed at the
   * root, at most three of them. Null when the site offers none.
   */
  async function usablePattern(page) {
    return page.evaluate(async () => {
      const all = await window.wp.data.resolveSelect('core').getBlockPatterns();
      const { parse, getBlockType } = window.wp.blocks;
      const sel = window.wp.data.select('core/block-editor');
      for (const p of all) {
        if (p.inserter === false || typeof p.content !== 'string') continue;
        const blocks = parse(p.content).filter((b) => b.name);
        if (!blocks.length || blocks.length > 3) continue;
        if (blocks.length === 1 && !blocks[0].innerBlocks.length) continue;
        if (!blocks.every((b) => getBlockType(b.name) && sel.canInsertBlockType(b.name, ''))) continue;
        return { name: p.name, title: p.title, content: p.content, topLevel: blocks.map((b) => b.name) };
      }
      return null;
    });
  }

  /** Drop a 'wp-blocks' payload on the rail, the way the browser would. */
  const dropOnRail = (page, payload) => page.evaluate((data) => {
    const dt = new DataTransfer();
    dt.setData('wp-blocks', JSON.stringify(data));
    const region = document.getElementById('toolrail-region');
    region.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    region.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, payload);

  test('a registered pattern is found in the settings search, pinned, armed and inserted, then unpinned', async ({ page }) => {
    await openNewPost(page);
    const pattern = await usablePattern(page);
    test.skip(!pattern, 'this site registers no pattern the root can take');
    const slot = 'pattern:' + pattern.name;

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-search').fill(pattern.title);
    const result = page.locator(`.toolrail-settings-result[data-pattern="${slot}"]`);
    await expect(result).toBeVisible();
    await expect(result.locator('.toolrail-settings-tag')).toHaveText('Pattern');
    await result.click();

    // Listed under Pinned tools with its kind, and on the rail.
    const row = page.locator(`.toolrail-settings-pinnedrow[data-block="${slot}"]`);
    await expect(row.locator('.toolrail-settings-pinnedname')).toHaveText(pattern.title);
    await expect(row.locator('.toolrail-settings-tag')).toHaveText('Pattern');
    await page.keyboard.press('Escape');
    const tool = page.locator(`#toolrail-rail [data-tool="pin:${slot}"]`);
    await expect(tool).toBeVisible();
    await expect(tool).toHaveAttribute('aria-label', `${pattern.title} (pinned pattern)`);

    // Arm + click: the pattern's own top-level blocks, nothing else.
    await tool.click();
    await clickBelowContent(page);
    await expect.poll(async () => await blockNames(page)).toEqual(pattern.topLevel);
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');

    // Stored like any pin; unpins like any pin.
    expect(JSON.parse(await getPref(page, 'toolrail-quick-slots'))).toContain(slot);
    await page.evaluate((s) => window.toolrail.unpinBlock(s), slot);
    await expect(tool).toHaveCount(0);
  });

  test('a pattern dragged from the inserter (its blocks, no name) pins the pattern, not its first block type', async ({ page }) => {
    await openNewPost(page);
    const pattern = await usablePattern(page);
    test.skip(!pattern, 'this site registers no pattern the root can take');

    // Core's inserter payload for a pattern is {type: 'inserter', blocks}
    // and nothing else (verified in this WordPress), so the rail has to
    // recognize it by content.
    await page.evaluate((content) => {
      const dt = new DataTransfer();
      dt.setData('wp-blocks', JSON.stringify({ type: 'inserter', blocks: window.wp.blocks.parse(content) }));
      const region = document.getElementById('toolrail-region');
      region.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, pattern.content);

    await expect(page.locator(`#toolrail-rail [data-tool="pin:pattern:${pattern.name}"]`)).toBeVisible();
    await expect(page.locator(`#toolrail-rail [data-tool="pin:${pattern.topLevel[0]}"]`)).toHaveCount(
      ['core/paragraph', 'core/heading', 'core/image', 'core/group'].includes(pattern.topLevel[0]) ? 1 : 0
    );
    await page.evaluate((s) => window.toolrail.unpinBlock(s), 'pattern:' + pattern.name);
  });

  test('a tool dragged from the toolbar into the canvas inserts on drop and arms nothing', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([createBlock('core/paragraph', { content: 'ANCHOR' })]);
    });
    await expect.poll(async () => await blockNames(page)).toEqual(['core/paragraph']);

    const tool = page.locator('#toolrail-rail [data-tool="pin:core/heading"]');
    await expect(tool).toHaveAttribute('draggable', 'true');
    const target = canvas(page).locator('[data-type="core/paragraph"]').first();
    const box = await target.boundingBox();
    // The lower half of the paragraph: core's drop zone puts the block
    // after it. Core owns the drop; the rail only supplied the payload.
    await tool.dragTo(target, {
      targetPosition: { x: Math.round(box.width / 2), y: Math.round(box.height * 0.8) },
    });

    await expect.poll(async () => await blockNames(page)).toEqual(['core/paragraph', 'core/heading']);
    await expect(tool).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a block dropped from the canvas onto the toolbar offers to pin its type', async ({ page }) => {
    await openNewPost(page);
    const quoteId = await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      const q = createBlock('core/quote', {}, [createBlock('core/paragraph', { content: 'Q' })]);
      window.wp.data.dispatch('core/block-editor').resetBlocks([q]);
      return q.clientId;
    });
    await dropOnRail(page, { type: 'block', srcClientIds: [quoteId], srcRootClientId: '' });

    const dialog = page.locator('.toolrail-adddialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog.locator('#toolrail-adddialog-title')).toHaveText('Add to toolbar');
    await expect(dialog.locator('#toolrail-adddialog-name')).toHaveValue('Quote');
    await expect(dialog.locator('#toolrail-adddialog-name')).toBeFocused();

    await dialog.locator('.toolrail-adddialog-pintype').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/quote"]')).toBeVisible();
  });

  test('…or to save it as an unsynced pattern and pin that; the pin inserts the saved snapshot', async ({ page }) => {
    await openNewPost(page);
    const groupId = await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      const g = createBlock(
        'core/group',
        { layout: { type: 'constrained' }, style: { spacing: { padding: { top: '40px' } } } },
        [createBlock('core/paragraph', { content: 'CALLOUT' })]
      );
      window.wp.data.dispatch('core/block-editor').resetBlocks([g]);
      return g.clientId;
    });

    // Stand in for the REST save — this suite never writes site content.
    // dispatch('core') hands out one memoized actions object (verified),
    // so the rail's call at save time reaches this stub.
    await page.evaluate(() => {
      window.__savedPattern = null;
      window.wp.data.dispatch('core').saveEntityRecord = async (kind, name, record) => {
        window.__savedPattern = { kind, name, record };
        return { id: 987654, title: { raw: record.title }, content: { raw: record.content } };
      };
    });

    await dropOnRail(page, { type: 'block', srcClientIds: [groupId], srcRootClientId: '' });
    const dialog = page.locator('.toolrail-adddialog');
    // Group is a default pin: the type offer says so instead of a button.
    await expect(dialog).toContainText('The Group block type is already pinned.');
    await expect(dialog.locator('.toolrail-adddialog-pintype')).toHaveCount(0);

    await dialog.locator('#toolrail-adddialog-name').fill('Callout');
    await dialog.locator('.toolrail-adddialog-savepattern').click();
    await expect(dialog).toHaveCount(0);

    const saved = await page.evaluate(() => window.__savedPattern);
    expect(saved.kind).toBe('postType');
    expect(saved.name).toBe('wp_block');
    expect(saved.record.title).toBe('Callout');
    expect(saved.record.status).toBe('publish');
    expect(saved.record.meta).toEqual({ wp_pattern_sync_status: 'unsynced' });
    expect(saved.record.content).toContain('<!-- wp:group');
    expect(saved.record.content).toContain('CALLOUT');

    const tool = page.locator('#toolrail-rail [data-tool="pin:pattern:user:987654"]');
    await expect(tool).toBeVisible();
    await expect(tool).toHaveAttribute('aria-label', 'Callout (pinned pattern)');

    // The pin inserts the snapshot: the configured Group, paragraph and all.
    await tool.click();
    await clickBelowContent(page);
    await expect.poll(async () => await blockNames(page)).toEqual(['core/group', 'core/group']);
    const copy = await page.evaluate(() => {
      const b = window.wp.data.select('core/block-editor').getBlocks()[1];
      return {
        layout: b.attributes.layout,
        padding: b.attributes.style.spacing.padding.top,
        inner: b.innerBlocks.map((i) => String(i.attributes.content)),
      };
    });
    expect(copy).toEqual({ layout: { type: 'constrained' }, padding: '40px', inner: ['CALLOUT'] });

    await page.evaluate(() => window.toolrail.unpinBlock('pattern:user:987654'));
  });

  test('"Save as pattern and pin to toolbar…" in the block menu opens the same dialog by keyboard', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').click();
    await clickBelowContent(page);
    await canvas(page).locator('[data-block]').last().click();
    await page.keyboard.type('Save me');
    await page.keyboard.press('Escape');

    await page.locator('.block-editor-block-toolbar button[aria-label="Options"]').click();
    await page.locator('.components-menu-item__button, .components-menu-item__item', { hasText: 'Save as pattern and pin to toolbar' }).first().click();

    const dialog = page.locator('.toolrail-adddialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#toolrail-adddialog-name')).toBeFocused();
    await expect(dialog.locator('#toolrail-adddialog-name')).toHaveValue('Paragraph');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('a set file may carry pattern pins; one this site lacks is kept and counted as unavailable', async ({ page }) => {
    await openNewPost(page);
    await waitForPatternCatalog(page);
    const result = await page.evaluate(() => window.toolrail.importConfig({
      format: 'toolrail-set',
      version: 1,
      name: 'with patterns',
      blocks: ['core/quote', 'pattern:user:424242', 'pattern:some-theme/hero', 'pattern:bad name'],
    }));
    expect(result.ok).toBe(true);
    expect(result.total).toBe(3);
    expect(result.dropped).toBe(1);
    expect(result.missing).toBe(2);
    await page.evaluate(() => window.toolrail.deleteConfig('with patterns'));
  });
});

test.describe('review 2026-09-03 follow-ups (patterns and drag)', () => {
  const dropOnRail = (page, payload) => page.evaluate((data) => {
    const dt = new DataTransfer();
    dt.setData('wp-blocks', JSON.stringify(data));
    const region = document.getElementById('toolrail-region');
    region.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    region.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, payload);

  async function seedQuote(page) {
    return page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      const q = createBlock('core/quote', {}, [createBlock('core/paragraph', { content: 'Q' })]);
      window.wp.data.dispatch('core/block-editor').resetBlocks([q]);
      return q.clientId;
    });
  }

  test('the Add to toolbar dialog renders in front of the Document Overview panel (finding 1)', async ({ page }) => {
    await openNewPost(page);
    const listView = page.locator('button[aria-label="Document Overview"]');
    test.skip(!(await listView.count()), 'no Document Overview button in this editor');
    await listView.click();
    await expect(page.locator('.interface-interface-skeleton__secondary-sidebar')).toBeVisible();

    const quoteId = await seedQuote(page);
    await dropOnRail(page, { type: 'block', srcClientIds: [quoteId], srcRootClientId: '' });
    await expect(page.locator('.toolrail-adddialog')).toBeVisible();
    await expect(page.locator('#toolrail-region')).toHaveClass(/is-raised/);

    // Assert the STACKING, as the settings-dialog test does: the topmost
    // element at the dialog's own point must be the dialog.
    const result = await page.evaluate(() => {
      const dlg = document.querySelector('.toolrail-adddialog');
      const sec = document.querySelector('.interface-interface-skeleton__secondary-sidebar');
      const d = dlg.getBoundingClientRect();
      const s = sec.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(d.left + d.width / 2), Math.round(d.top + 40));
      return {
        overlaps: !(d.right <= s.left || d.left >= s.right),
        topmostIsDialog: !!(hit && dlg.contains(hit)),
      };
    });
    expect(result.overlaps).toBe(true);
    expect(result.topmostIsDialog).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator('.toolrail-adddialog')).toHaveCount(0);
    await expect(page.locator('#toolrail-region')).not.toHaveClass(/is-raised/);
    // Put the panel back: its open state persists on the server.
    await listView.click();
    await expect(page.locator('.interface-interface-skeleton__secondary-sidebar')).toHaveCount(0);
  });

  test('a single-block pattern dropped from the inserter pins the pattern, not the block type (finding 2)', async ({ page }) => {
    await openNewPost(page);
    // A registered pattern that is exactly one top-level block with no
    // children — the shape that drags like a plain block type. SEEDED,
    // not hunted: most core and theme patterns are Group or Columns
    // wrappers, and a catalog hunt let this test skip itself green
    // (review 2026-09-03, second round, finding 4). select('core') hands
    // out one memoized selectors object, so the rail's catalog read sees
    // the fixture appended to the real list.
    const pattern = {
      name: 'e2e/styled-heading',
      type: 'core/heading',
      content: '<!-- wp:heading {"level":3,"style":{"typography":{"letterSpacing":"3px"}}} --><h3 class="wp-block-heading" style="letter-spacing:3px">E2E STYLED</h3><!-- /wp:heading -->',
    };
    await page.evaluate(async (fx) => {
      const real = await window.wp.data.resolveSelect('core').getBlockPatterns();
      const sel = window.wp.data.select('core');
      window.__realGetBlockPatterns = sel.getBlockPatterns;
      const list = real.concat([{ name: fx.name, title: 'E2E styled heading', content: fx.content, inserter: true }]);
      sel.getBlockPatterns = () => list;
    }, pattern);

    const typeWasPinned = await page.evaluate((t) => window.toolrail.isPinned(t), pattern.type);
    await page.evaluate((content) => {
      const dt = new DataTransfer();
      dt.setData('wp-blocks', JSON.stringify({ type: 'inserter', blocks: window.wp.blocks.parse(content) }));
      document.getElementById('toolrail-region').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, pattern.content);

    await expect(page.locator(`#toolrail-rail [data-tool="pin:pattern:${pattern.name}"]`)).toBeVisible();
    // The block type was NOT pinned by the drop (unless it already was).
    expect(await page.evaluate((t) => window.toolrail.isPinned(t), pattern.type)).toBe(typeWasPinned);
    await page.evaluate((s) => window.toolrail.unpinBlock(s), 'pattern:' + pattern.name);
    await page.evaluate(() => { window.wp.data.select('core').getBlockPatterns = window.__realGetBlockPatterns; });
  });

  test('a user pattern edited to the same byte length is matched by its new content, not a stale parse (second round, finding 2)', async ({ page }) => {
    await openNewPost(page);
    // Two contents of identical length: an h2 and an h3.
    const v1 = '<!-- wp:heading --><h2 class="wp-block-heading">SAME LEN</h2><!-- /wp:heading -->';
    const v2 = '<!-- wp:heading {"level":3} --><h3 class="wp-block-heading">SAME LEN</h3><!-- /wp:heading -->';
    const seed = (page2, content) => page2.evaluate((c) => {
      const sel = window.wp.data.select('core');
      if (!window.__realGetEntityRecords) {
        window.__realGetEntityRecords = sel.getEntityRecords;
      }
      const record = { id: 777001, title: { raw: 'Same length' }, content: { raw: c }, wp_pattern_sync_status: 'unsynced' };
      sel.getEntityRecords = (kind, name, query) => (
        kind === 'postType' && name === 'wp_block' ? [record] : window.__realGetEntityRecords(kind, name, query)
      );
    }, content);
    const dropParsed = (page2, content) => page2.evaluate((c) => {
      const dt = new DataTransfer();
      dt.setData('wp-blocks', JSON.stringify({ type: 'inserter', blocks: window.wp.blocks.parse(c) }));
      document.getElementById('toolrail-region').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, content);

    await seed(page, v1);
    await dropParsed(page, v1);
    await expect(page.locator('#toolrail-rail [data-tool="pin:pattern:user:777001"]')).toBeVisible();
    await page.evaluate(() => window.toolrail.unpinBlock('pattern:user:777001'));

    // Same id, same length, new content: a length-keyed cache served
    // the h2 parse here, the match missed, and the drop pinned Heading.
    await seed(page, v2);
    await dropParsed(page, v2);
    await expect(page.locator('#toolrail-rail [data-tool="pin:pattern:user:777001"]')).toBeVisible();
    await page.evaluate(() => {
      window.toolrail.unpinBlock('pattern:user:777001');
      window.wp.data.select('core').getEntityRecords = window.__realGetEntityRecords;
    });
  });

  test('a synced pattern reference pins by its ref before the list lands; a ref-less core/block pins nothing (finding 3)', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('wp-blocks', JSON.stringify({
        type: 'inserter',
        blocks: [window.wp.blocks.createBlock('core/block', { ref: 424242 })],
      }));
      document.getElementById('toolrail-region').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    // Stored as the pattern slot (hidden until a wp_block 424242 exists
    // here), and never as a pinned "Block" type.
    await expect.poll(async () => JSON.parse(await getPref(page, 'toolrail-quick-slots'))).toContain('pattern:user:424242');
    expect(await page.evaluate(() => window.toolrail.isPinned('core/block'))).toBe(false);
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/block"]')).toHaveCount(0);

    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('wp-blocks', JSON.stringify({ type: 'inserter', blocks: [window.wp.blocks.createBlock('core/block')] }));
      document.getElementById('toolrail-region').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    expect(await page.evaluate(() => window.toolrail.isPinned('core/block'))).toBe(false);
    await page.evaluate(() => window.toolrail.unpinBlock('pattern:user:424242'));
  });

  test('an unresolved permission check is not "denied": the save form still shows; a real "no" hides it (finding 4)', async ({ page }) => {
    await openNewPost(page);
    const quoteId = await seedQuote(page);

    // select('core') hands out one memoized selectors object, so the
    // rail's read at dialog time reaches these stubs.
    await page.evaluate(() => {
      const sel = window.wp.data.select('core');
      window.__realCanUser = sel.canUser;
      sel.canUser = () => undefined;
    });
    await dropOnRail(page, { type: 'block', srcClientIds: [quoteId], srcRootClientId: '' });
    const dialog = page.locator('.toolrail-adddialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.toolrail-adddialog-savepattern')).toBeVisible();
    await expect(dialog).not.toContainText('You cannot create patterns');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await page.evaluate(() => { window.wp.data.select('core').canUser = () => false; });
    await dropOnRail(page, { type: 'block', srcClientIds: [quoteId], srcRootClientId: '' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('You cannot create patterns on this site');
    await expect(dialog.locator('.toolrail-adddialog-savepattern')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.wp.data.select('core').canUser = window.__realCanUser; });
  });

  test('pattern pins are not counted as missing while the catalog is still loading (finding 6)', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const sel = window.wp.data.select('core');
      window.__realHasFinished = sel.hasFinishedResolution;
      sel.hasFinishedResolution = () => false;
    });
    const loading = await page.evaluate(() => window.toolrail.importConfig({
      format: 'toolrail-set', version: 1, name: 'loading', blocks: ['pattern:user:5150', 'nope/nope'],
    }));
    // Only the unknown BLOCK is missing; the pattern is "not fetched yet".
    expect(loading.missing).toBe(1);

    await page.evaluate(() => { window.wp.data.select('core').hasFinishedResolution = window.__realHasFinished; });
    await waitForPatternCatalog(page);
    const loaded = await page.evaluate(() => window.toolrail.importConfig({
      format: 'toolrail-set', version: 1, name: 'loaded', blocks: ['pattern:user:5150', 'nope/nope'],
    }));
    expect(loaded.missing).toBe(2);
    await page.evaluate(() => { window.toolrail.deleteConfig('loading'); window.toolrail.deleteConfig('loaded'); });
  });

  test('a rerender mid-drag does not leave the rail refusing drops (finding 7)', async ({ page }) => {
    await openNewPost(page);
    // Start a drag from a tool (its own dragend will never fire once the
    // button is rebuilt), rebuild the rail, then end the drag the way a
    // canceled one does — and drop something on the rail.
    await page.evaluate(() => {
      const btn = document.querySelector('#toolrail-rail [data-tool="pin:core/heading"]');
      const dt = new DataTransfer();
      btn.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
      window.toolrail.pinBlock('core/quote'); // rerenders the rail
      document.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await dropOnRail(page, { type: 'inserter', blocks: [{ name: 'core/list', attributes: {}, innerBlocks: [] }] });
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/list"]')).toBeVisible();
  });

  test('a block result\'s accessible name contains its visible "Block" chip (finding 8)', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-search').fill('Quote');
    const result = page.locator('.toolrail-settings-result[data-block="core/quote"]');
    await expect(result).toHaveAttribute('aria-label', 'Pin the Quote block to the toolbar');
    await expect(result.locator('.toolrail-settings-tag')).toHaveText('Block');
  });
});
