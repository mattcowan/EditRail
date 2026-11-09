/**
 * EditRail — Toolbar settings dialog spec.
 *
 * The Toolbar settings dialog: focus, keyboard, closing, and what the
 * actions in it announce.
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const { AUTH, openNewPost, canvas, getPref, liveText } = require('./helpers');

test.use({ storageState: AUTH });

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

  test('a click on text in the dialog keeps it open, and a click on a label toggles its checkbox', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    const dialog = page.locator('.toolrail-settings');
    await expect(dialog).toBeVisible();

    // A heading is not focusable. The click used to focus the rail region,
    // outside the dialog, and the focus listener closed the dialog. In
    // WebKit every checkbox and button click did the same (QA 2026-10-09).
    await dialog.locator('h3.toolrail-settings-subtitle').first().click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();

    // A rebuild from elsewhere (a pin added outside the dialog) keeps the
    // focus on the dialog. It used to fall back to the search field.
    await page.evaluate(() => window.toolrail.pinBlock('core/quote'));
    await expect(dialog.locator('.toolrail-settings-pinnedrow[data-block="core/quote"]')).toHaveCount(1);
    await expect(dialog).toBeFocused();
    await page.evaluate(() => window.toolrail.unpinBlock('core/quote'));

    const box = page.locator('#toolrail-settings-sidebarresize');
    await expect(box).not.toBeChecked();
    await page.locator('label:has(#toolrail-settings-sidebarresize) span').click();
    await expect(dialog).toBeVisible();
    await expect(box).toBeChecked();
    expect(await getPref(page, 'toolrail-sidebar-resize')).toBe('1');
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

/**
 * Regressions found by driving the editor by hand (2026-08-26). Each test
 * here failed before its fix; the block-count assertions in
 * 'armed-tool insertion' were tightened in the same pass, because the
 * originals could not see the stray-block bug at all.
 */
test.describe('regressions', () => {
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
});

/**
 * QA sweep 2026-09-11 (private/qa-2026-09-11-editrail.md): one test per
 * core finding, C1–C8. Each names the finding so the report and the
 * spec can be read side by side.
 */
test.describe('QA 2026-09-11 follow-ups (1.0.2)', () => {
  test('C2: pinned tools and the search precede the position group, so Tab from the search reaches every group', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await expect(page.locator('.toolrail-settings')).toBeVisible();

    const order = await page.evaluate(() => {
      const dlg = document.querySelector('.toolrail-settings');
      const note = dlg.querySelector('.toolrail-settings-note');
      const pinnedHead = Array.from(dlg.querySelectorAll('.toolrail-settings-subtitle')).find((h) => h.textContent === 'Pinned tools');
      const search = dlg.querySelector('#toolrail-settings-search');
      const position = dlg.querySelector('input[name="toolrail-dock"]');
      const appearance = dlg.querySelector('input[name="toolrail-appearance"]');
      const setName = dlg.querySelector('#toolrail-settings-setname');
      const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return {
        noteThenPinned: follows(note, pinnedHead),
        pinnedThenSearch: follows(pinnedHead, search),
        searchThenPosition: follows(search, position),
        positionThenAppearance: follows(position, appearance),
        appearanceThenSets: follows(appearance, setName),
      };
    });
    expect(order).toEqual({ noteThenPinned: true, pinnedThenSearch: true, searchThenPosition: true, positionThenAppearance: true, appearanceThenSets: true });

    // Focus still opens in the search; from there Tab reaches the
    // position radios without leaving the dialog.
    expect(await page.evaluate(() => document.activeElement.id)).toBe('toolrail-settings-search');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement.name)).toBe('toolrail-dock');
    await expect(page.locator('.toolrail-settings')).toBeVisible();
  });

  test('C3: a click into the canvas closes the settings dialog, the help panel and a flyout', async ({ page }) => {
    await openNewPost(page);
    const gear = page.locator('#toolrail-rail [data-tool="settings"]');
    await gear.click();
    await expect(page.locator('.toolrail-settings')).toBeVisible();
    await canvas(page).locator('body').click({ position: { x: 700, y: 300 } });
    await expect(page.locator('.toolrail-settings')).toHaveCount(0);
    await expect(gear).toHaveAttribute('aria-expanded', 'false');

    await page.locator('#toolrail-rail [data-tool="help"]').click();
    await expect(page.locator('.toolrail-help')).toBeVisible();
    await canvas(page).locator('body').click({ position: { x: 700, y: 300 } });
    await expect(page.locator('.toolrail-help')).toHaveCount(0);

    // A flyout: register a parent with one child through the public API.
    await page.evaluate(() => {
      window.toolrail.registerTool({ id: 'qa/parent', label: 'QA parent', onActivate: () => {} });
      window.toolrail.registerTool({ id: 'qa/child', label: 'QA child', parent: 'qa/parent', onActivate: () => {} });
    });
    const parent = page.locator('#toolrail-rail [data-tool="qa/parent"]');
    await parent.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#toolrail-region [role="menu"]')).toHaveCount(1);
    await canvas(page).locator('body').click({ position: { x: 700, y: 300 } });
    await expect(page.locator('#toolrail-region [role="menu"]')).toHaveCount(0);
  });

  test('C4/C7: pin, unpin, move, save set and delete announce; Enter saves a set; an empty name is refused in text', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    const dialog = page.locator('.toolrail-settings');
    await expect(dialog).toBeVisible();
    const pinnedStatus = dialog.locator('#toolrail-settings-pinned-status');
    const setStatus = dialog.locator('#toolrail-settings-status');

    await page.locator('#toolrail-settings-search').fill('Quote');
    await page.locator('.toolrail-settings-result[data-block="core/quote"]').click();
    await expect(pinnedStatus).toHaveText('Quote pinned to the toolbar.');
    expect(await liveText(page)).toBe('Quote pinned to the toolbar.');

    await dialog.locator('button[aria-label="Move Quote up"]').click();
    await expect(pinnedStatus).toHaveText('Quote moved to position 4 of 5.');
    await dialog.locator('button[aria-label="Move Quote down"]').click();
    await expect(pinnedStatus).toHaveText('Quote moved to position 5 of 5.');

    await dialog.locator('button[aria-label="Unpin Quote"]').click();
    await expect(pinnedStatus).toHaveText('Quote unpinned from the toolbar.');
    expect(await liveText(page)).toBe('Quote unpinned from the toolbar.');
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/quote"]')).toHaveCount(0);

    // Save set: empty name is refused in text; Enter saves.
    await dialog.locator('.toolrail-settings-saveset').click();
    await expect(setStatus).toHaveText('Type a name for the set.');
    await page.locator('#toolrail-settings-setname').fill('QA enter');
    await page.keyboard.press('Enter');
    await expect(setStatus).toHaveText('Saved the set "QA enter".');
    await expect(dialog.locator('button[aria-label="Load the set QA enter"]')).toHaveCount(1);
    expect(await liveText(page)).toBe('Saved the set "QA enter".');

    await dialog.locator('button[aria-label="Delete the set QA enter"]').click();
    await expect(setStatus).toHaveText('Deleted the set "QA enter".');
    await expect(dialog.locator('button[aria-label="Load the set QA enter"]')).toHaveCount(0);
  });
});

/**
 * Code review 2026-09-13, findings 1 and 4 on the 1.0.2 fixes.
 */
test.describe('review 2026-09-13 follow-ups (1.0.2)', () => {
  test('finding 1: after a Code editor round trip, a press inside Toolbar settings does not close it', async ({ page }) => {
    await openNewPost(page);
    // Iframe-less editor (the Code editor) and back: the canvas document
    // becomes the top document for a while, and the canvas handlers must
    // not stay bound to it afterwards. The editor mode is a persisted
    // preference, so it is restored whatever happens.
    const setMode = (mode) => page.evaluate((m) => window.wp.data.dispatch('core/edit-post').switchEditorMode(m), mode);
    try {
      await setMode('text');
      await expect(page.locator('iframe[name="editor-canvas"]')).toHaveCount(0, { timeout: 10000 });
      await page.waitForTimeout(600);
      await setMode('visual');
      await expect(page.locator('iframe[name="editor-canvas"]')).toHaveCount(1, { timeout: 15000 });
      await expect(page.locator('#toolrail-rail')).toBeVisible();
      await page.waitForTimeout(800);

      await page.locator('#toolrail-rail [data-tool="settings"]').click();
      const dialog = page.locator('.toolrail-settings');
      await expect(dialog).toBeVisible();
      // Real presses on controls INSIDE the dialog.
      await page.locator('#toolrail-settings-search').click();
      await expect(dialog).toBeVisible();
      await dialog.locator('input[name="toolrail-dock"][value="right"]').click();
      await expect(dialog).toBeVisible();
      expect(await page.evaluate(() => document.getElementById('toolrail-region').dataset.dock)).toBe('right');
      await dialog.locator('input[name="toolrail-dock"][value="left"]').click();
      await expect(dialog).toBeVisible();

      // The help panel too, then a canvas press still closes it (C3 holds after the round trip).
      await page.keyboard.press('Escape');
      await page.locator('#toolrail-rail [data-tool="help"]').click();
      await expect(page.locator('.toolrail-help')).toBeVisible();
      await page.locator('.toolrail-help button[aria-label="Close toolbar help"]').hover();
      await page.mouse.down();
      await page.mouse.up();
      await expect(page.locator('.toolrail-help')).toHaveCount(0);
      await page.locator('#toolrail-rail [data-tool="help"]').click();
      await expect(page.locator('.toolrail-help')).toBeVisible();
      await canvas(page).locator('body').click({ position: { x: 700, y: 300 } });
      await expect(page.locator('.toolrail-help')).toHaveCount(0);
    } finally {
      await setMode('visual');
      await page.waitForTimeout(1500);
    }
  });
});
