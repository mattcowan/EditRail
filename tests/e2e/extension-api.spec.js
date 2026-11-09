/**
 * EditRail — extension API spec.
 *
 * The public extension API: registerTool and the extension hooks.
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const {
  AUTH,
  openNewPost,
  clickBelowContent,
  getPref,
  blockNames,
} = require('./helpers');

test.use({ storageState: AUTH });

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
  /**
   * Apart from the rail's own actions (a press, a rebuild), the only
   * repaint trigger is the wp.data subscription in start(), so a tool
   * whose isActive() reads something the editor's stores never see (a
   * pick mode canceled with Escape, a sidebar section held in React
   * state) stayed pressed until an unrelated keystroke ticked a store. That is the mechanism behind E1 and half
   * of E2 in the 2026-09-11 QA report, and no extension could fix it:
   * the rail owned its own repaint schedule and exposed no way in.
   *
   * The whole flip is read INSIDE one evaluate so no store tick can
   * interleave and repaint the button for us — otherwise the test
   * could pass without refresh() doing anything.
   */
  test('refresh() repaints pressed state that no store change would reach (QA 2026-09-11, E1/E2)', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => {
      window.e2eToolActive = false;
      window.toolrail.registerTool({
        id: 'e2e-refresh',
        label: 'E2E refresh probe',
        onActivate: () => {},
        isActive: () => !!window.e2eToolActive,
      });
    });

    const btn = page.locator('#toolrail-rail [data-tool="e2e-refresh"]');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');

    const flip = await page.evaluate(() => {
      const el = document.querySelector('#toolrail-rail [data-tool="e2e-refresh"]');
      window.e2eToolActive = true;
      const stale = el.getAttribute('aria-pressed');
      window.toolrail.refresh();
      return { stale, painted: el.getAttribute('aria-pressed') };
    });
    // stale: the state moved and nothing repainted — the defect.
    // painted: refresh() closed the gap, in the same synchronous turn.
    expect(flip).toEqual({ stale: 'false', painted: 'true' });

    // And back the other way, so this is a repaint and not a one-way latch.
    const unflip = await page.evaluate(() => {
      const el = document.querySelector('#toolrail-rail [data-tool="e2e-refresh"]');
      window.e2eToolActive = false;
      window.toolrail.refresh();
      return el.getAttribute('aria-pressed');
    });
    expect(unflip).toBe('false');
  });

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
