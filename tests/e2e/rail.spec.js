/**
 * Editor Tool Rail — client behavior spec.
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

async function openNewPost(page) {
  await page.goto('/wp-admin/post-new.php');

  // Dock, pins and saved sets are per-user preferences — since the
  // account-persistence change they live in the core/preferences store
  // (synced to user meta), with localStorage as the migration source and
  // fallback. Clear BOTH, or a spec's changes leak into every later spec
  // through the shared admin account. Clearing also restores the DEFAULT
  // pinned slots (Text/Heading/Image), which several tests rely on.
  //
  // The slot-migration stamp MUST be cleared with the rest: it stops the
  // one-time slot migration from re-running, which is what seeds the
  // defaults — leave it set with the data wiped and the rail comes back
  // empty instead of default. (The local-to-account lift has no stamp of
  // its own — it's a per-key check against the account, safe to re-run.)
  const hadState = await page.evaluate(() => {
    const keys = [
      'toolrail-position',
      'toolrail-quick-slots',
      'toolrail-slot-configs',
      'toolrail-slots-migrated',
      'toolrail-help-hidden',
      'toolrail-wide',
      'toolrail-wide-toggle',
      'toolrail-appearance',
    ];
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
      // The help-seen stamp is the ONE key that must be SET, not
      // cleared: clearing it would auto-open the help panel over every
      // later spec. (The first-ever pageload on a fresh account stamps
      // it itself by auto-opening — the reload below then starts that
      // spec from the stamped state.) The dedicated first-run test
      // clears it deliberately.
      if (sel.get('toolrail', 'toolrail-help-seen') !== '1') {
        had = true;
        disp.set('toolrail', 'toolrail-help-seen', '1');
      }
    } catch (e) {
      /* Store not ready — nothing stored there either, then. */
    }
    return had;
  });
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

/** Read one rail preference from the core/preferences store (null = unset). */
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
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('pin:core/paragraph');
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

    await canvas(page).locator('body').click({ position: { x: 300, y: 400 } });

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
    await canvas(page).locator('body').click({ position: { x: 300, y: 400 }, modifiers: ['Shift'] });
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/heading"]')).toHaveAttribute('aria-pressed', 'true');

    await canvas(page).locator('body').click({ position: { x: 300, y: 450 } });
    // Two headings and NOTHING else: filtering to core/heading before
    // counting used to hide any stray core added on the way.
    await expect.poll(async () => await blockNames(page)).toEqual(['core/heading', 'core/heading']);
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('Escape in the canvas disarms back to Select', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="section"]').click();
    await canvas(page).locator('body').press('Escape');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('shape flyout', () => {
  test('ArrowRight opens, Escape returns focus, picking arms and inserts', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="shape"]').focus();
    await page.keyboard.press('ArrowRight');

    const flyout = page.locator('.toolrail-flyout');
    await expect(flyout).toBeVisible();
    await expect(flyout).toHaveAttribute('role', 'menu');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('shape-circle');

    await page.keyboard.press('Escape');
    await expect(flyout).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('shape');

    // Pick the circle: parent lights (a child is armed), click inserts SVG html block.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(page.locator('#toolrail-rail [data-tool="shape"]')).toHaveAttribute('aria-pressed', 'true');
    await canvas(page).locator('body').click({ position: { x: 300, y: 400 } });
    expect(await blockNames(page)).toContain('core/html');
  });
});

test.describe('quick slots', () => {
  test('Text, Heading and Image ship as default, reorderable pinned slots', async ({ page }) => {
    await openNewPost(page);

    // Fresh state (openNewPost cleared the key): the three defaults render
    // as slots between Select and the remaining built-ins, in order. (The
    // wide-mode chevron is opt-in as of 0.1.12, so a default rail starts
    // at Select again.)
    const order = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#toolrail-rail .toolrail-tool')).map((b) => b.dataset.tool)
    );
    expect(order.slice(0, 4)).toEqual(['select', 'pin:core/paragraph', 'pin:core/heading', 'pin:core/image']);
    expect(order).toContain('shape');

    // Defaults are ordinary slots: reorder Heading above Text.
    await page.evaluate(() => window.toolrail.moveSlot('core/heading', -1));
    const reordered = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#toolrail-rail .toolrail-tool')).map((b) => b.dataset.tool)
    );
    expect(reordered.slice(1, 3)).toEqual(['pin:core/heading', 'pin:core/paragraph']);
  });

  test('unpin and re-pin via the block menu, persist across reload, settings Remove unpins', async ({ page }) => {
    await openNewPost(page);

    // Insert a paragraph to have a block whose menu we can open.
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').click();
    await canvas(page).locator('body').click({ position: { x: 300, y: 400 } });

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
    expect(payload.blocks).toEqual(['core/paragraph', 'core/heading', 'core/image']);

    // Import the same payload back: the existing name gets a suffix
    // instead of silently overwriting.
    await page.locator('#toolrail-settings-import').setInputFiles({
      name: 'toolrail-set-travel-kit.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(payload)),
    });
    await expect(page.locator('.toolrail-settings-setrow[data-config="travel kit (2)"]')).toBeVisible();
    await expect(page.locator('#toolrail-settings-status')).toContainText('Imported "travel kit (2)" (3 blocks).');
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

  test('sections are divided, Pinned blocks precedes Add a block, and new pins land at the bottom', async ({ page }) => {
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
      const pinnedHead = heads.find((h) => h.textContent === 'Pinned blocks');
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
    await canvas(page).locator('body').click({ position: { x: 300, y: 400 } });
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
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('pin:core/paragraph');
    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('select');
  });

  test('a top rail opens its flyouts downward; a bottom rail upward', async ({ page }) => {
    await openNewPost(page);

    // Top: ArrowDown is the flyout key when the rail is horizontal, and the
    // menu must sit BELOW the rail.
    await page.evaluate(() => window.toolrail.setDock('top'));
    await page.locator('#toolrail-rail [data-tool="shape"]').focus();
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
    await page.locator('#toolrail-rail [data-tool="shape"]').focus();
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
    await canvas(page).locator('body').click({ position: { x: 300, y: 400 } });
    expect(await blockNames(page)).toContain('core/quote');
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
    await canvas(page).locator('body').click({ position: { x: 300, y: 500 } });

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

    await page.locator('#toolrail-rail [data-tool="shape"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.toolrail-flyout')).toBeVisible();

    await page.keyboard.press('Tab');

    await expect(page.locator('.toolrail-flyout')).toHaveCount(0);
    await expect(page.locator('#toolrail-rail [data-tool="shape"]')).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  test('a pre-migration author keeps Text, Heading and Image on upgrade', async ({ page }) => {
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

    // The three return, ahead of the author's own pin, which survives —
    // and the lifted state now lives in the account preferences.
    const slots = JSON.parse(await getPref(page, 'toolrail-quick-slots'));
    expect(slots).toEqual(['core/paragraph', 'core/heading', 'core/image', 'core/quote']);
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
        if (!sheet.href || sheet.href.indexOf('toolrail') === -1) continue;
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

    await page.locator('#toolrail-rail [data-tool="shape"]').click();
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

    await expect(page.locator('#toolrail-rail [data-tool^="pin:"]')).toHaveCount(3);
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
    expect(state.slots.length).toBe(3);

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
    await expect(page.locator('#toolrail-rail [data-tool^="pin:"]')).toHaveCount(3);

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
    await expect(page.locator('#toolrail-rail [data-tool^="pin:"]')).toHaveCount(3, { timeout: 5000 });
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
  test('first-run auto-open happens once, without stealing focus, then never again', async ({ page }) => {
    await openNewPost(page);

    // Simulate a first run: clear the seen stamp and reload. (openNewPost
    // deliberately SETS the stamp for every other spec.)
    await page.evaluate(() => {
      window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-help-seen', undefined);
      window.localStorage.removeItem('toolrail-help-seen');
    });
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });

    // Auto-opens (after its 400ms breather) and stamps the account.
    await expect(page.locator('.toolrail-help')).toBeVisible({ timeout: 5000 });
    await expect.poll(async () => await getPref(page, 'toolrail-help-seen')).toBe('1');

    // The auto-open must not steal the author's caret.
    const focusInPanel = await page.evaluate(() => {
      const panel = document.querySelector('.toolrail-help');
      return panel.contains(document.activeElement);
    });
    expect(focusInPanel).toBe(false);

    // Closing is dismissal — the next load (stamp set) stays closed.
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(900); // outlive the auto-open delay
    await expect(page.locator('.toolrail-help')).toHaveCount(0);
  });

  test('an Escape aimed elsewhere closes the auto-opened panel quietly, without stealing focus', async ({ page }) => {
    await openNewPost(page);

    // Recreate the auto-open state: panel open, focus never inside it.
    await page.evaluate(() => {
      window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-help-seen', undefined);
      window.localStorage.removeItem('toolrail-help-seen');
    });
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.toolrail-help')).toBeVisible({ timeout: 5000 });

    // The author is working elsewhere — a header control has focus.
    await page.evaluate(() => {
      document.querySelector('.interface-interface-skeleton__header button').focus();
    });
    await page.keyboard.press('Escape');

    // The panel goes away, but QUIETLY: the event is not claimed and
    // focus stays where the author put it. Before the fix the panel's
    // capture-phase handler stopPropagation()ed the press (so whatever
    // the author meant to close stayed open) and closeHelp(true)
    // teleported focus to the rail (review 2026-08-26).
    await expect(page.locator('.toolrail-help')).toHaveCount(0);
    const after = await page.evaluate(() => ({
      tool: document.activeElement.dataset ? document.activeElement.dataset.tool : null,
      inHeader: !!document.activeElement.closest('.interface-interface-skeleton__header'),
    }));
    expect(after.tool).not.toBe('help');
    expect(after.inHeader).toBe(true);
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

    // All six sections render as headed text (Section overview joined
    // in 0.1.13).
    await expect(panel.locator('h3')).toHaveCount(6);

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
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('pin:core/paragraph');
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

    await page.locator('#toolrail-rail [data-tool="shape"]').click();
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

function overviewChipButton(page, clientId, action) {
  return page.locator(
    `#toolrail-overview .toolrail-ov-chip[data-clientid="${clientId}"] [data-ov-action="${action}"]`
  );
}

test.describe('section overview (R6)', () => {
  test('the Overview tool zooms a tall document fully into view with chips in document order; closing restores everything', async ({ page }) => {
    await openNewPost(page);

    // A document several viewports tall — the case the zoom exists for.
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 30 }, (_, i) =>
          createBlock('core/paragraph', { content: 'PARA-' + i })
        )
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(30);

    const tool = page.locator('#toolrail-rail [data-tool="overview"]');
    await tool.click();

    await expect(page.locator('#toolrail-overview')).toBeVisible();
    await expect(tool).toHaveAttribute('aria-pressed', 'true');

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

    // One chip per top-level block, chip DOM order = document order.
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const chipIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#toolrail-overview .toolrail-ov-chip')).map(
        (c) => c.dataset.clientid
      )
    );
    expect(chipIds).toEqual(ids);

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

  test('a chip moves its block, announces the move, and keeps focus on that chip', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();

    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    await overviewChipButton(page, ids[0], 'down').click();

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

    // The rebuild keeps focus on the moved chip's own button (the
    // settings-arrows contract) — a keyboard user is never dropped.
    const focus = await page.evaluate(() => ({
      action: document.activeElement.dataset ? document.activeElement.dataset.ovAction : null,
      chip: document.activeElement.closest
        ? (document.activeElement.closest('.toolrail-ov-chip') || {}).dataset
        : null,
    }));
    expect(focus.action).toBe('down');
    expect(focus.chip.clientid).toBe(ids[0]);
  });

  test('keyboard-only: Enter drills into a section, arrows reorder inside it, Escape climbs then closes', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();

    const topIds = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const groupId = topIds[1];

    // Enter the group by keyboard.
    await overviewChipButton(page, groupId, 'enter').focus();
    await page.keyboard.press('Enter');

    const innerIds = await page.evaluate((gid) =>
      window.wp.data.select('core/block-editor').getBlockOrder(gid), groupId
    );
    expect(innerIds.length).toBe(2);
    await expect(page.locator('#toolrail-overview .toolrail-ov-chip')).toHaveCount(2);
    // The breadcrumb names the level; the current crumb is text, not a button.
    await expect(page.locator('#toolrail-overview [aria-current="location"]')).toHaveText('Group');

    // Reorder the heading above the paragraph, by keyboard.
    await overviewChipButton(page, innerIds[1], 'up').focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => page.evaluate((gid) =>
      window.wp.data.select('core/block-editor').getBlockOrder(gid), groupId
    )).toEqual([innerIds[1], innerIds[0]]);

    // Escape climbs one level (focus is inside the overlay)…
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-overview .toolrail-ov-chip')).toHaveCount(3);
    await expect(page.locator('#toolrail-overview [aria-current="location"]')).toHaveText('All sections');

    // …and from the top level Escape closes, returning focus to the tool.
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('overview');
  });

  test('the chip focus ring clears 3:1 on the chip surface', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview .toolrail-ov-chip').first()).toBeVisible();

    // The chips are excluded from the token-sweep test on purpose: they
    // draw on the editor and use a FIXED palette (the 0.1.4 snap-preview
    // boundary), so their ring is pinned here instead — the DECLARED
    // ring color from the stylesheet, against the chip's real computed
    // surface, so an appearance change can never silently break it.
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
        if (!sheet.href || sheet.href.indexOf('toolrail') === -1) continue;
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

      const chip = document.querySelector('#toolrail-overview .toolrail-ov-chip');
      const ring = parse(declared);
      const surface = parse(getComputedStyle(chip).backgroundColor);
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
    await overviewChipButton(page, ids[0], 'down').click();
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
      'core/paragraph', 'core/image', 'core/quote', 'core/heading',
    ]);

    // Nothing missing: says so, changes nothing.
    await page.locator('.toolrail-settings-restore').click();
    await expect(page.locator('#toolrail-settings-pinned-status')).toHaveText('All default tools are already pinned.');
    expect(JSON.parse(await getPref(page, 'toolrail-quick-slots'))).toEqual([
      'core/paragraph', 'core/image', 'core/quote', 'core/heading',
    ]);

    // All three missing: all three come back, in DEFAULT_SLOTS order,
    // after the pin the author kept.
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      ['core/paragraph', 'core/heading', 'core/image'].forEach((n) =>
        window.toolrail.unpinBlock(n)
      );
    });
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('.toolrail-settings-restore').click();
    await expect(page.locator('#toolrail-settings-pinned-status')).toHaveText('Restored 3 default tools.');
    expect(JSON.parse(await getPref(page, 'toolrail-quick-slots'))).toEqual([
      'core/quote', 'core/paragraph', 'core/heading', 'core/image',
    ]);

    // The migration stamp is not this button's to touch.
    expect(await getPref(page, 'toolrail-slots-migrated')).toBe('1');
  });
});
