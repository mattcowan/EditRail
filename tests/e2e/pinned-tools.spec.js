/**
 * EditRail — pinned tools spec.
 *
 * The pinned tools (quick slots): order, the default pins, Group as a
 * default, and how the pin list is seeded and migrated.
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const {
  AUTH,
  openNewPost,
  canvas,
  clickBelowContent,
  getPref,
  blockNames,
} = require('./helpers');

test.use({ storageState: AUTH });

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
    // Poll: the rail renders a block icon through createRoot, which
    // renders asynchronously, so the SVG can be missing for a moment after
    // pinBlock returns (null in WebKit CI, PR #63, 2026-10-14).
    await expect.poll(() => page.evaluate(() => {
      const svg = document.querySelector('#toolrail-rail [data-tool="pin:core/cover"] .toolrail-tool-icon svg');
      if (!svg) { return null; }
      const r = svg.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })).toEqual({ w: 24, h: 24 });
  });
});

/**
 * Regressions found by driving the editor by hand (2026-08-26). Each test
 * here failed before its fix; the block-count assertions in
 * 'armed-tool insertion' were tightened in the same pass, because the
 * originals could not see the stray-block bug at all.
 */
test.describe('regressions', () => {
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
