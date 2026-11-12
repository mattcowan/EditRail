/**
 * EditRail — saved sets spec.
 *
 * Saved sets: the Saved sets button, and set files (import and export).
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const { AUTH, openNewPost, getPref } = require('./helpers');

test.use({ storageState: AUTH });

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

test.describe('saved sets button (#93)', () => {
  /**
   * Save the rail's current pins as a set through Toolbar settings, then
   * close the dialog.
   */
  async function saveSet(page, name) {
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-setname').fill(name);
    await page.locator('.toolrail-settings-saveset').click();
    await expect(page.locator(`.toolrail-settings-setrow[data-config="${name}"]`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.toolrail-settings')).toHaveCount(0);
  }

  test('appears with the first saved set, and a press on a set loads it', async ({ page }) => {
    await openNewPost(page);
    const setsBtn = page.locator('#toolrail-rail [data-tool="saved-sets"]');
    await expect(setsBtn).toHaveCount(0);

    await saveSet(page, 'basic');
    await expect(setsBtn).toBeVisible();
    // First in the tail, before Help and Toolbar settings.
    expect(await page.locator('#toolrail-rail .toolrail-tail .toolrail-tool').evaluateAll(
      (nodes) => nodes.map((n) => n.dataset.tool)
    )).toEqual(['saved-sets', 'help', 'settings']);

    await page.evaluate(() => window.toolrail.pinBlock('core/quote'));
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/quote"]')).toBeVisible();
    await saveSet(page, 'with quote');

    await setsBtn.click();
    const menu = page.locator('.toolrail-flyout[aria-label="Saved sets"]');
    await expect(menu).toBeVisible();
    await expect(setsBtn).toHaveAttribute('aria-expanded', 'true');
    // The set that matches the rail now is the one checked radio item.
    await expect(menu.locator('[role="menuitemradio"]')).toHaveCount(2);
    await expect(menu.locator('[role="menuitemradio"][aria-checked="true"]')).toHaveText('with quote');
    await expect(menu.locator('[role="menuitem"]').last()).toContainText('Save the current tools as a set');

    await menu.locator('[role="menuitemradio"]', { hasText: 'basic' }).click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/quote"]')).toHaveCount(0);
    expect(await getPref(page, 'toolrail-quick-slots')).not.toContain('core/quote');
    // Focus goes to the rebuilt button, not the page body.
    await expect(setsBtn).toBeFocused();
  });

  test('opens and loads by keyboard, and Escape returns to the button', async ({ page }) => {
    await openNewPost(page);
    await saveSet(page, 'basic');
    await page.evaluate(() => window.toolrail.pinBlock('core/quote'));
    await saveSet(page, 'with quote');

    const setsBtn = page.locator('#toolrail-rail [data-tool="saved-sets"]');
    await setsBtn.focus();
    // The default left dock is vertical: ArrowRight opens the menu.
    await page.keyboard.press('ArrowRight');
    const first = page.locator('.toolrail-flyout[aria-label="Saved sets"] .toolrail-flyout-item').first();
    await expect(first).toBeFocused();
    await expect(first).toHaveText('basic');

    await page.keyboard.press('Enter');
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/quote"]')).toHaveCount(0);
    await expect(setsBtn).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.toolrail-flyout[aria-label="Saved sets"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.toolrail-flyout[aria-label="Saved sets"]')).toHaveCount(0);
    await expect(setsBtn).toBeFocused();
    // The toolbar keeps one Tab stop.
    await expect(page.locator('#toolrail-rail .toolrail-tool[tabindex="0"]')).toHaveCount(1);
  });

  test('the save item opens Toolbar settings at the set name field', async ({ page }) => {
    await openNewPost(page);
    await saveSet(page, 'basic');

    await page.locator('#toolrail-rail [data-tool="saved-sets"]').click();
    await page.locator('.toolrail-flyout[aria-label="Saved sets"] [role="menuitem"]', { hasText: 'Save the current tools' }).click();
    await expect(page.locator('#toolrail-settings-setname')).toBeFocused();
  });

  test('a checkbox hides the button, and a delete of the last set removes it', async ({ page }) => {
    await openNewPost(page);
    await saveSet(page, 'basic');
    const setsBtn = page.locator('#toolrail-rail [data-tool="saved-sets"]');
    await expect(setsBtn).toBeVisible();

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-setsbutton').uncheck();
    await expect(setsBtn).toHaveCount(0);
    expect(await getPref(page, 'toolrail-sets-button-hidden')).toBe('1');
    await page.locator('#toolrail-settings-setsbutton').check();
    await expect(setsBtn).toBeVisible();

    await page.locator('.toolrail-settings-setrow[data-config="basic"] .toolrail-settings-delset').click();
    await expect(setsBtn).toHaveCount(0);
  });

  test('a rail rebuild keeps focus on the focused button, and the id is reserved', async ({ page }) => {
    await openNewPost(page);
    await saveSet(page, 'basic');
    const setsBtn = page.locator('#toolrail-rail [data-tool="saved-sets"]');
    await setsBtn.focus();

    // A rebuild the author did not start: an extension registers a tool.
    // Focus used to jump to Select (PR #97 review).
    const registered = await page.evaluate(() =>
      window.toolrail.registerTool({ id: 'e2e-rebuild', label: 'E2E Rebuild', onActivate: () => {} })
    );
    expect(registered).toBe(true);
    await expect(page.locator('#toolrail-rail [data-tool="e2e-rebuild"]')).toHaveCount(1);
    await expect(setsBtn).toBeFocused();
    // The one Tab stop follows focus.
    await expect(page.locator('#toolrail-rail .toolrail-tool[tabindex="0"]')).toHaveCount(1);
    await expect(setsBtn).toHaveAttribute('tabindex', '0');

    // Focus on an item of an open menu: the rebuild removes the menu, and
    // focus goes to the rebuilt parent button, not the page body.
    await page.keyboard.press('ArrowRight');
    const menu = page.locator('.toolrail-flyout[aria-label="Saved sets"]');
    await expect(menu.locator('.toolrail-flyout-item').first()).toBeFocused();
    expect(await page.evaluate(() =>
      window.toolrail.registerTool({ id: 'e2e-rebuild-2', label: 'E2E Rebuild 2', onActivate: () => {} })
    )).toBe(true);
    await expect(menu).toHaveCount(0);
    await expect(setsBtn).toBeFocused();

    // The rail's ArrowRight handler opens the Saved sets menu for this
    // id, so no extension may register it.
    const refused = await page.evaluate(() =>
      window.toolrail.registerTool({ id: 'saved-sets', onActivate: () => {} })
    );
    expect(refused).toBe(false);
  });

  test('follows a sets change that comes from outside the rail', async ({ page }) => {
    await openNewPost(page);
    await saveSet(page, 'basic');
    const setsBtn = page.locator('#toolrail-rail [data-tool="saved-sets"]');
    await expect(setsBtn).toBeVisible();

    // A direct core/preferences write stands in for core's attach
    // replacing the store with both migration stamps kept: no repair
    // runs, and the button must still go (PR #97 review).
    await page.evaluate(() =>
      window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-slot-configs', '{}')
    );
    await expect(setsBtn).toHaveCount(0);
    await page.evaluate(() =>
      window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-slot-configs', JSON.stringify({ basic: [] }))
    );
    await expect(setsBtn).toBeVisible();
  });
});

/**
 * Regressions found by driving the editor by hand (2026-08-26). Each test
 * here failed before its fix; the block-count assertions in
 * 'armed-tool insertion' were tightened in the same pass, because the
 * originals could not see the stray-block bug at all.
 */
test.describe('regressions', () => {
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
});
