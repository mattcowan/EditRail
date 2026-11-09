/**
 * EditRail — settings sidebar width spec.
 *
 * The width of core's settings sidebar (#28).
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const {
  AUTH,
  openNewPost,
  canvas,
  waitForSavedPref,
  getPref,
  politeText,
} = require('./helpers');

test.use({ storageState: AUTH });

test.describe('settings sidebar width (#28)', () => {
  /** Turn the feature on with its checkbox in Toolbar settings (it is off by default). */
  async function turnOn(page) {
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    const box = page.locator('#toolrail-settings-sidebarresize');
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(page.locator('#toolrail-settings-sidebarwidth-reset')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.toolrail-settings')).toHaveCount(0);
  }

  /** Open core's settings sidebar on the Post tab, and wait for the handle. */
  async function openSidebar(page) {
    await page.evaluate(() => window.wp.data.dispatch('core/interface').enableComplementaryArea('core', 'edit-post/document'));
    await expect(page.locator('.interface-complementary-area')).toBeVisible();
    await expect(page.locator('#toolrail-sidebar-handle')).toBeVisible();
  }

  async function closeSidebar(page) {
    await page.evaluate(() => window.wp.data.dispatch('core/interface').disableComplementaryArea('core'));
    await expect(page.locator('.interface-complementary-area')).toHaveCount(0);
  }

  /** Rounded on-screen widths and edges of the sidebar, the canvas and the rail. */
  async function layout(page) {
    return page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) {
          return null;
        }
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
      };
      return {
        area: box('.interface-complementary-area'),
        sidebar: box('.interface-interface-skeleton__sidebar'),
        content: box('.interface-interface-skeleton__content'),
        rail: box('#toolrail-region'),
        handle: box('#toolrail-sidebar-handle'),
      };
    });
  }

  /** Wait for the sidebar to finish core's open animation at `width`. */
  async function expectSidebarWidth(page, width) {
    await expect.poll(async () => (await layout(page)).sidebar.width).toBe(width);
    await expect(page.locator('.interface-complementary-area')).toHaveJSProperty('offsetWidth', width);
  }

  test('off by default: no handle and no override, even with a stored width; the checkbox turns it on and off', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => window.wp.data.dispatch('core/interface').enableComplementaryArea('core', 'edit-post/document'));
    await expect(page.locator('.interface-complementary-area')).toBeVisible();
    await expect(page.locator('#toolrail-sidebar-handle')).toHaveCount(0);
    // A width stored while the feature was on does nothing while it is off.
    await page.evaluate(() => window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-sidebar-width', '500'));
    await expectSidebarWidth(page, 280);
    await expect(page.locator('#toolrail-sidebar-handle')).toHaveCount(0);
    expect(await page.evaluate(() => [...document.body.classList].filter((c) => c.startsWith('toolrail-sidebar')))).toEqual([]);

    // Toolbar settings: the checkbox alone, unchecked, with a hint.
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    const box = page.locator('#toolrail-settings-sidebarresize');
    await expect(box).not.toBeChecked();
    await expect(page.locator('#toolrail-settings-sidebarwidth-reset')).toHaveCount(0);
    await box.check();
    await expect(box).toBeFocused();
    await expect(page.locator('#toolrail-settings-sidebarwidth-value')).toHaveText('Width: 500 pixels.');
    expect(await getPref(page, 'toolrail-sidebar-resize')).toBe('1');
    await expect(page.locator('#toolrail-sidebar-handle')).toHaveCount(1);
    await expectSidebarWidth(page, 500);

    // Off again: the handle goes and the sidebar is core's own.
    await box.uncheck();
    await expect(page.locator('#toolrail-sidebar-handle')).toHaveCount(0);
    await expectSidebarWidth(page, 280);
    expect(await getPref(page, 'toolrail-sidebar-resize')).toBe('0');
  });

  test('the handle is a focusable separator on the inner edge; arrow keys, Home and End change the width and announce it', async ({ page }) => {
    await openNewPost(page);
    await turnOn(page);
    await openSidebar(page);
    const handle = page.locator('#toolrail-sidebar-handle');

    await expect(handle).toHaveAttribute('role', 'separator');
    await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    await expect(handle).toHaveAttribute('aria-label', 'Settings sidebar width');
    await expect(handle).toHaveAttribute('tabindex', '0');
    await expect(handle).toHaveAttribute('aria-valuenow', '280');
    await expect(handle).toHaveAttribute('aria-valuemin', '280');
    // Desktop Chrome is 1280px wide: half the window is 640, the cap.
    await expect(handle).toHaveAttribute('aria-valuemax', '640');
    await expect(handle).toHaveAttribute('aria-valuetext', '280 pixels, default');
    // It controls the open panel, and it is the sidebar's first Tab stop.
    const areaId = await page.locator('.interface-complementary-area').getAttribute('id');
    await expect(handle).toHaveAttribute('aria-controls', areaId);
    expect(await handle.evaluate((h) => h.parentNode.firstElementChild === h
      && h.parentNode.classList.contains('interface-interface-skeleton__sidebar'))).toBe(true);
    // At the default width nothing is overridden.
    expect(await page.evaluate(() => document.body.classList.contains('toolrail-sidebar-sized'))).toBe(false);

    // Core's open animation has finished at the default width.
    await expectSidebarWidth(page, 280);
    const before = await layout(page);
    // The inner edge: the sidebar's left edge, next to the canvas.
    expect(before.handle.left).toBe(before.sidebar.left);

    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', '290');
    await expectSidebarWidth(page, 290);
    await expect.poll(() => politeText(page)).toContain('Settings sidebar width: 290 pixels.');
    // The canvas gives up exactly what the sidebar took.
    const after = await layout(page);
    expect(after.content.width).toBe(before.content.width - 10);
    expect(after.content.right).toBe(after.sidebar.left);

    await page.keyboard.press('Shift+ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', '340');
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '330');
    await expectSidebarWidth(page, 330);

    await page.keyboard.press('End');
    await expect(handle).toHaveAttribute('aria-valuenow', '640');
    await expectSidebarWidth(page, 640);
    await expect.poll(() => politeText(page)).toContain('640 pixels');
    // Past the maximum, nothing moves.
    await page.keyboard.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', '640');

    await page.keyboard.press('Home');
    await expect(handle).toHaveAttribute('aria-valuenow', '280');
    await expect(handle).toHaveAttribute('aria-valuetext', '280 pixels, default');
    await expectSidebarWidth(page, 280);
    await expect.poll(() => politeText(page)).toContain('280 pixels, default');
    expect(await page.evaluate(() => document.body.classList.contains('toolrail-sidebar-sized'))).toBe(false);
  });

  test('a drag sets the width, the account keeps it across a reload, Escape cancels a drag and a double-click resets', async ({ page }) => {
    await openNewPost(page);
    await turnOn(page);
    await openSidebar(page);
    const handle = page.locator('#toolrail-sidebar-handle');

    let box = await handle.boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(box.x - 60, y, { steps: 4 });
    await page.mouse.move(box.x - 116, y, { steps: 4 });
    await page.mouse.up();
    await expect(handle).toHaveAttribute('aria-valuenow', '400');
    await expectSidebarWidth(page, 400);
    expect(await getPref(page, 'toolrail-sidebar-width')).toBe('400');
    await expect(handle).toBeFocused();
    await expect.poll(() => politeText(page)).toContain('400 pixels');
    await waitForSavedPref(page, 'toolrail-sidebar-width', (v) => v === '400');
    await waitForSavedPref(page, 'toolrail-sidebar-resize', (v) => v === '1');

    // The width comes back from the account on the next editor load.
    // A plain reload: openNewPost would reset the preferences.
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    await openSidebar(page);
    await expect(handle).toHaveAttribute('aria-valuenow', '400');
    await expectSidebarWidth(page, 400);
    // The left-docked rail and the canvas share what is left.
    const l = await layout(page);
    expect(l.rail.right).toBeLessThanOrEqual(l.content.left);
    expect(l.content.right).toBe(l.sidebar.left);

    // Escape during a drag puts the edge back where the drag started. Start
    // with focus in the canvas: the press must still focus the handle, or
    // Escape goes to the canvas (#74: one browser engine ignored it).
    await canvas(page).locator('h1').first().click();
    expect(await page.evaluate(() => document.activeElement && document.activeElement.tagName)).toBe('IFRAME');
    box = await handle.boundingBox();
    await page.mouse.move(box.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(box.x - 96, y, { steps: 4 });
    await expect(handle).toHaveAttribute('aria-valuenow', '500');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(handle).toHaveAttribute('aria-valuenow', '400');
    await expectSidebarWidth(page, 400);
    expect(await getPref(page, 'toolrail-sidebar-width')).toBe('400');

    box = await handle.boundingBox();
    await page.mouse.dblclick(box.x + 4, y);
    await expect(handle).toHaveAttribute('aria-valuenow', '280');
    await expectSidebarWidth(page, 280);
    expect(await getPref(page, 'toolrail-sidebar-width')).toBe('280');
  });

  test('during a drag the edge follows the pointer, arrow keys wait, and a handle that leaves the page ends the drag', async ({ page }) => {
    await openNewPost(page);
    await turnOn(page);
    await page.evaluate(() => window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-sidebar-width', '400'));
    await openSidebar(page);
    await expectSidebarWidth(page, 400);
    const handle = page.locator('#toolrail-sidebar-handle');
    const fillState = () => page.evaluate(() => {
      const fill = document.querySelector('.interface-complementary-area__fill');
      const area = document.querySelector('.interface-complementary-area');
      return {
        transition: getComputedStyle(fill).transitionDuration,
        fill: Math.round(fill.getBoundingClientRect().width),
        area: Math.round(area.getBoundingClientRect().width),
      };
    });

    let box = await handle.boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(box.x - 36, y, { steps: 4 });
    await expect(handle).toHaveAttribute('aria-valuenow', '440');
    // No transition while dragging: the drag rule used to lose to the
    // settled rule on specificity, and the edge trailed the pointer.
    const mid = await fillState();
    expect(mid.transition).toBe('0s');
    expect(mid.fill).toBe(mid.area);

    // An arrow key mid-drag stores and announces nothing; the release does.
    await page.keyboard.press('ArrowLeft');
    expect(await getPref(page, 'toolrail-sidebar-width')).toBe('400');
    await expect(handle).toHaveAttribute('aria-valuenow', '440');
    await page.mouse.up();
    await expect.poll(() => getPref(page, 'toolrail-sidebar-width')).toBe('440');

    // The handle leaves the page mid-drag, as when core rebuilds the
    // sidebar region (the distraction-free shortcut does). The drag ends
    // without a write, and the rebuilt handle takes a new drag.
    box = await handle.boundingBox();
    await page.mouse.move(box.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(box.x - 36, y, { steps: 4 });
    await page.evaluate(() => document.getElementById('toolrail-sidebar-handle').remove());
    // The browser sends lostpointercapture with the next pointer event.
    // Let go over the sidebar: over the canvas, Firefox counts the release
    // as a click there, selects a block, and core rebuilds the sidebar on
    // its Block tab, which replaces the handle again mid-test.
    await page.mouse.move(box.x + 4, y);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('toolrail-sidebar-resizing'))).toBe(false);
    expect(await getPref(page, 'toolrail-sidebar-width')).toBe('440');
    // The rebuilt handle answers again. The key handler ignores width keys
    // while a drag is active, so this also proves the drag state cleared.
    // (A key, not a second pointer drag: in Playwright's Firefox that drag
    // sometimes went to the canvas instead, 2 runs in 7.)
    await expect(handle).toBeVisible();
    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => getPref(page, 'toolrail-sidebar-width')).toBe('450');
  });

  test('with the sidebar closed nothing changes; it still opens and closes, at the stored width', async ({ page }) => {
    await openNewPost(page);
    await turnOn(page);
    await openSidebar(page);
    await page.locator('#toolrail-sidebar-handle').focus();
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await expectSidebarWidth(page, 380);

    await closeSidebar(page);
    await expect(page.locator('#toolrail-sidebar-handle')).toBeHidden();
    const closed = await layout(page);
    expect(closed.sidebar.width).toBe(0);
    // The canvas runs to the window's right edge, the same as without the plugin.
    expect(closed.content.right).toBe(await page.evaluate(() => document.documentElement.clientWidth));

    // Core's own toggle in the header still opens it, at the stored width.
    await page.locator('.editor-header__settings button[aria-controls="edit-post:document"], .editor-header__settings button[aria-label="Settings"]').first().click();
    await expect(page.locator('#toolrail-sidebar-handle')).toBeVisible();
    await expectSidebarWidth(page, 380);
  });

  test('a right-docked rail stays past the wider sidebar', async ({ page }) => {
    await openNewPost(page);
    await turnOn(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('input[data-dock="right"]').check();
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'right');
    await page.keyboard.press('Escape');
    await openSidebar(page);
    await page.locator('#toolrail-sidebar-handle').focus();
    await page.keyboard.press('End');
    await expectSidebarWidth(page, 640);
    const l = await layout(page);
    expect(l.rail.left).toBeGreaterThanOrEqual(l.sidebar.right);
    expect(l.content.right).toBe(l.sidebar.left);
  });

  test('Toolbar settings shows the width in text and resets it with a button', async ({ page }) => {
    test.slow(); // two waits for the server copy of the width, on a slow site
    await openNewPost(page);
    await turnOn(page);
    await openSidebar(page);
    await page.locator('#toolrail-sidebar-handle').focus();
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await expectSidebarWidth(page, 380);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    const value = page.locator('#toolrail-settings-sidebarwidth-value');
    await expect(value).toHaveText('Width: 380 pixels.');
    const reset = page.locator('#toolrail-settings-sidebarwidth-reset');
    await expect(reset).toHaveAttribute('aria-describedby', 'toolrail-settings-sidebarwidth-value');
    await reset.click();
    await expect(value).toHaveText('Width: 280 pixels, default.');
    // Focus stays in the dialog. On the button itself in most browsers; on
    // the dialog in WebKit, which does not focus a button on a click (the
    // reset is in place, so nothing moves focus to the button).
    expect(await page.evaluate(() => document.querySelector('.toolrail-settings').contains(document.activeElement))).toBe(true);
    await expectSidebarWidth(page, 280);
    await expect.poll(() => politeText(page)).toContain('280 pixels, default');

    // From the keyboard, focus stays on the button in every browser.
    await page.getByLabel('Width in pixels').fill('400');
    await page.getByLabel('Width in pixels').press('Enter');
    await expect(value).toHaveText('Width: 400 pixels.');
    // The click reset already stored 280 on the server. Wait for 400 first,
    // so the final wait for 280 can only pass on the keyboard reset's save.
    await waitForSavedPref(page, 'toolrail-sidebar-width', (v) => v === '400');
    await reset.focus();
    await page.keyboard.press('Enter');
    await expect(value).toHaveText('Width: 280 pixels, default.');
    await expect(reset).toBeFocused();
    // Let core's debounced save land before the page closes (see the typed
    // width test below).
    await waitForSavedPref(page, 'toolrail-sidebar-width', (v) => v === '280');
  });

  test('a typed width and the Narrower and Wider buttons set the width without a drag (WCAG 2.5.7)', async ({ page }) => {
    test.slow(); // about twenty saved widths, then a wait for the server copy, on a slow site
    await openNewPost(page);
    await turnOn(page);
    await openSidebar(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    const dialog = page.locator('.toolrail-settings');
    const field = page.getByLabel('Width in pixels');
    const narrower = page.locator('#toolrail-settings-sidebarwidth-narrower');
    const wider = page.locator('#toolrail-settings-sidebarwidth-wider');
    const value = page.locator('#toolrail-settings-sidebarwidth-value');
    await expect(field).toHaveValue('280');
    // At a limit a button is aria-disabled, not disabled: it keeps its Tab stop.
    await expect(narrower).toHaveAttribute('aria-disabled', 'true');
    await expect(wider).not.toHaveAttribute('aria-disabled');

    // An open, idle dialog does not change its own DOM. A rewrite of the
    // same width text was a childList mutation that the body observer
    // answered with another sync, about ten times a second (review
    // 2026-10-10).
    const idleMutations = await page.evaluate(() => new Promise((resolve) => {
      let count = 0;
      const mo = new MutationObserver((records) => { count += records.length; });
      mo.observe(document.querySelector('.toolrail-settings'), { childList: true, subtree: true, characterData: true });
      setTimeout(() => { mo.disconnect(); resolve(count); }, 1500);
    }));
    expect(idleMutations).toBe(0);

    // Keyboard order: the field, then Narrower, Wider and Reset.
    await field.focus();
    await page.keyboard.press('Tab');
    await expect(narrower).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(wider).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#toolrail-settings-sidebarwidth-reset')).toBeFocused();

    // A typed width applies on Enter, in place: focus stays in the field.
    await field.fill('500');
    await field.press('Enter');
    await expect.poll(() => getPref(page, 'toolrail-sidebar-width')).toBe('500');
    await expect(field).toBeFocused();
    await expect(value).toHaveText('Width: 500 pixels.');
    await expectSidebarWidth(page, 500);
    await expect.poll(() => politeText(page)).toContain('500 pixels');

    // The buttons step 50px.
    await wider.click();
    await expect.poll(() => getPref(page, 'toolrail-sidebar-width')).toBe('550');
    await expect(field).toHaveValue('550');
    await narrower.click();
    await expect.poll(() => getPref(page, 'toolrail-sidebar-width')).toBe('500');

    // Out of range is held to the range (1280px window: 640 is the widest).
    await field.fill('9999');
    await field.press('Enter');
    await expect.poll(() => getPref(page, 'toolrail-sidebar-width')).toBe('640');
    await expect(field).toHaveValue('640');
    await expect(wider).toHaveAttribute('aria-disabled', 'true');

    // The field reads what a number field accepts, and rounds.
    await field.fill('500.6');
    await field.press('Enter');
    await expect.poll(() => getPref(page, 'toolrail-sidebar-width')).toBe('501');
    await field.fill('1e3');
    await field.press('Enter');
    await expect.poll(() => getPref(page, 'toolrail-sidebar-width')).toBe('640');

    // A button that reaches its limit keeps focus, and a press there does
    // nothing.
    await field.fill('600');
    await field.press('Enter');
    await expect.poll(() => getPref(page, 'toolrail-sidebar-width')).toBe('600');
    await wider.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => getPref(page, 'toolrail-sidebar-width')).toBe('640');
    await expect(wider).toHaveAttribute('aria-disabled', 'true');
    await expect(wider).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await getPref(page, 'toolrail-sidebar-width')).toBe('640');

    // Empty text changes nothing and says what to type.
    await field.fill('');
    await field.press('Enter');
    await expect(field).toHaveValue('640');
    expect(await getPref(page, 'toolrail-sidebar-width')).toBe('640');
    await expect.poll(() => politeText(page)).toContain('Type a width in pixels.');

    // Tab out of an edited field applies it, and focus goes on to Narrower.
    await field.fill('420');
    await page.keyboard.press('Tab');
    await expect.poll(() => getPref(page, 'toolrail-sidebar-width')).toBe('420');
    await expect(narrower).toBeFocused();
    await expect(dialog).toBeVisible();

    // Tab out of the field to the minimum: the change marks Narrower, the
    // next stop, as at its limit. A disabled Narrower dropped focus to the
    // page here (review 2026-10-10).
    await field.fill('100');
    await page.keyboard.press('Tab');
    await expect.poll(() => getPref(page, 'toolrail-sidebar-width')).toBe('280');
    await expect(narrower).toBeFocused();
    await expect(narrower).toHaveAttribute('aria-disabled', 'true');

    // Let core's debounced save of this burst land before the page
    // closes. A late save reached the account after the next test's reset
    // and turned the feature on there (2026-10-10).
    await waitForSavedPref(page, 'toolrail-sidebar-width', (v) => v === '280');
    await waitForSavedPref(page, 'toolrail-sidebar-resize', (v) => v === '1');
  });

  test('below the 782px breakpoint the handle hides and core\'s full-screen sidebar is left alone', async ({ page }) => {
    await openNewPost(page);
    await turnOn(page);
    await openSidebar(page);
    await page.locator('#toolrail-sidebar-handle').focus();
    await page.keyboard.press('End');
    await expectSidebarWidth(page, 640);

    await page.setViewportSize({ width: 700, height: 720 });
    // Core closes the sidebar when the window gets this narrow; open it
    // again, full screen. Wait for the close first: in WebKit it can land
    // after an early reopen and close the sidebar again.
    await expect(page.locator('.interface-complementary-area')).toHaveCount(0);
    await page.evaluate(() => window.wp.data.dispatch('core/interface').enableComplementaryArea('core', 'edit-post/document'));
    await expect(page.locator('.interface-complementary-area')).toBeVisible();
    await expect(page.locator('#toolrail-sidebar-handle')).toBeHidden();
    await expect(page.locator('.interface-complementary-area')).toHaveJSProperty('offsetWidth', 700);
    // The stored width is kept for the next wide window.
    expect(await getPref(page, 'toolrail-sidebar-width')).toBe('640');
  });
});
