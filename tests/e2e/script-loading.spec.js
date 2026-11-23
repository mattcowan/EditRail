/**
 * EditRail — script loading spec (#102).
 *
 * The rail is seven scripts. When one of them does not load (a network
 * error, a blocked request, a file that is missing after a partial
 * deploy), the files after it must stop too, and the editor must work
 * with no rail, as it did when the rail was one file that failed to
 * load. Before the files checked each other, a missing middle file left
 * the last file running with names it never got: its store subscriber and
 * its "Pin to toolbar" menu item then threw inside the editor's own code,
 * and the block Options menu showed "The editor has encountered an
 * unexpected error" (review 2026-11-14).
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 * It does not use openNewPost(): that helper waits for the rail, and here
 * there is none.
 */
const { test, expect, AUTH, openNewPost, waitForSavedPref, clickBelowContent, blockNames } = require('./helpers');

test.use({ storageState: AUTH });

/** The rail's scripts, in load order (includes/rail.php, toolrail_rail_scripts()). */
const RAIL_FILES = [
  'editor-rail-core.js',
  'editor-rail-registry.js',
  'editor-rail-tools.js',
  'editor-rail-settings.js',
  'editor-rail-overview.js',
  'editor-rail-dom.js',
  'editor-rail.js',
];

test.describe('script loading (#102)', () => {
  test('when every file has run, the rail is up and its private namespace is off window', async ({ page }) => {
    await page.goto('/wp-admin/post-new.php');
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    // The files share window.toolrailInternal only while they load. The
    // last file removes it, so no other script can read or change the
    // rail's internals; the public API is window.toolrail.
    expect(await page.evaluate(() => ({
      api: typeof window.toolrail,
      internal: typeof window.toolrailInternal,
      own: Object.prototype.hasOwnProperty.call(window, 'toolrailInternal'),
    }))).toEqual({ api: 'object', internal: 'undefined', own: false });
  });

  for (const file of RAIL_FILES) {
    test(`the editor works with no rail when ${file} does not load`, async ({ page }) => {
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      let aborted = 0;
      // `assets/<file>` then `?ver=…`: the pattern for editor-rail.js does
      // not match editor-rail-core.js and the others.
      await page.route(`**/assets/${file}*`, (route) => {
        aborted += 1;
        return route.abort();
      });

      await page.goto('/wp-admin/post-new.php');
      const canvas = page.frameLocator('iframe[name="editor-canvas"]');
      await expect(canvas.locator('.is-root-container')).toBeVisible({ timeout: 20000 });
      expect(aborted, `${file} was requested and stopped`).toBeGreaterThan(0);

      // No rail, and no public API: a provider's script then sees what it
      // saw when the one-file rail did not load.
      await expect(page.locator('#toolrail-region')).toHaveCount(0);
      expect(await page.evaluate(() => typeof window.toolrail)).toBe('undefined');

      // The editor's own actions still work. A block inserted through the
      // store reaches every store subscriber the rail left behind.
      const inserted = await page.evaluate(() => {
        const block = window.wp.blocks.createBlock('core/paragraph', { content: 'SCRIPT-LOADING' });
        window.wp.data.dispatch('core/block-editor').insertBlocks(block);
        window.wp.data.dispatch('core/block-editor').selectBlock(block.clientId);
        return window.wp.data.select('core/block-editor').getBlocks().map((b) => b.name);
      });
      expect(inserted).toEqual(['core/paragraph']);

      // The block Options menu holds the rail's one React island ("Pin to
      // toolbar"). It must open, without the rail's item and without
      // core's error boundary.
      await canvas.locator('[data-type="core/paragraph"]').click();
      await page.locator('.block-editor-block-toolbar .block-editor-block-settings-menu button').first().click();
      await expect(page.getByRole('menu', { name: 'Options' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: /Pin to toolbar/ })).toHaveCount(0);
      await expect(page.getByText('The editor has encountered an unexpected error.')).toHaveCount(0);
      await page.keyboard.press('Escape');

      expect(pageErrors, 'no uncaught error in the page').toEqual([]);
    });
  }

  // A provider (README, "Extending") depends only on toolrail-editor-rail
  // and calls registerTool() while its script is first evaluated. The
  // fixture in tests/e2e/fixtures/mu-plugins does that when the
  // toolrail_e2e_provider cookie is set (PR #127 review).
  test('a provider that depends on toolrail-editor-rail runs after all seven files, and its tool works', async ({ page, context, baseURL }) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await context.addCookies([{ name: 'toolrail_e2e_provider', value: '1', url: baseURL }]);
    await openNewPost(page);

    const seen = await page.evaluate(() => window.__toolrailE2EProvider || null);
    // CI always has the fixture (.wp-env.json). Another site may not.
    test.skip(!seen && !process.env.CI, 'The e2e provider fixture is not on this site: copy tests/e2e/fixtures/mu-plugins/e2e-provider.php to its mu-plugins folder.');
    expect(seen, 'the fixture provider ran').not.toBeNull();
    // It ran after the last file: the public API was there, the private
    // one was gone, and registerTool() did not throw.
    expect(seen).toMatchObject({ api: 'object', internal: 'undefined', error: null });

    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').focus();
    await page.keyboard.press('ArrowRight');
    const child = page.locator('.toolrail-flyout [data-tool="e2e-provider-child"]');
    await expect(child).toBeVisible();
    await child.click();
    await clickBelowContent(page);
    expect(await blockNames(page)).toContain('core/quote');
    expect(pageErrors, 'no uncaught error in the page').toEqual([]);
  });

  // editor-rail-dom.js listens for window resizes, to keep a floating
  // toolbar in the window and to size the settings sidebar. When the last
  // file does not load, the rail never starts, and a resize must leave
  // core's sidebar alone (PR #127 review).
  test('a window resize does not size the sidebar when editor-rail.js does not load', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-sidebar-resize', '1');
      window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-sidebar-width', '500');
    });
    await waitForSavedPref(page, 'toolrail-sidebar-resize', (v) => v === '1');
    await waitForSavedPref(page, 'toolrail-sidebar-width', (v) => v === '500');

    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/assets/editor-rail.js*', (route) => route.abort());
    await page.goto('/wp-admin/post-new.php');
    await expect(page.frameLocator('iframe[name="editor-canvas"]').locator('.is-root-container')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#toolrail-region')).toHaveCount(0);

    await page.evaluate(() => window.wp.data.dispatch('core/interface').enableComplementaryArea('core', 'edit-post/document'));
    await expect(page.locator('.interface-complementary-area')).toBeVisible();
    const size = page.viewportSize();
    await page.setViewportSize({ width: size.width - 40, height: size.height });
    await page.setViewportSize(size);
    // Two frames, so a resize handler has run.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    await expect(page.locator('#toolrail-sidebar-handle')).toHaveCount(0);
    expect(await page.evaluate(() => [...document.body.classList].filter((c) => c.startsWith('toolrail-')))).toEqual([]);
    await expect(page.locator('.interface-complementary-area')).toHaveJSProperty('offsetWidth', 280);
    expect(pageErrors, 'no uncaught error in the page').toEqual([]);
  });
});
