/**
 * EditRail — help panel spec.
 *
 * The help panel ("?" tool).
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const { AUTH, openNewPost, getPref } = require('./helpers');

test.use({ storageState: AUTH });

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

    // All eight sections render as headed text (Section overview joined
    // in 0.1.14; "What a highlighted tool means" in 0.1.18, R10;
    // "Settings sidebar width" in 1.0.5, #28).
    await expect(panel.locator('h3')).toHaveCount(8);
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

/**
 * Code review 2026-09-13, findings 1 and 4 on the 1.0.2 fixes.
 */
test.describe('review 2026-09-13 follow-ups (1.0.2)', () => {
  test('finding 4: one Escape closes the help panel and leaves the tool armed; the next disarms', async ({ page }) => {
    await openNewPost(page);
    const heading = page.locator('#toolrail-rail [data-tool="pin:core/heading"]');
    await heading.click();
    await expect(heading).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#toolrail-rail [data-tool="help"]').click();
    await expect(page.locator('.toolrail-help')).toBeVisible();
    // Focus is inside the panel: Escape belongs to the panel.
    await page.keyboard.press('Escape');
    await expect(page.locator('.toolrail-help')).toHaveCount(0);
    await expect(heading).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(heading).toHaveAttribute('aria-pressed', 'false');

    // The add dialog, opened from the block menu, behaves the same.
    await page.evaluate(() => window.wp.data.dispatch('core/block-editor').resetBlocks([window.wp.blocks.createBlock('core/quote', {}, [window.wp.blocks.createBlock('core/paragraph', { content: 'Q' })])]));
    await heading.click();
    await page.evaluate(() => {
      const id = window.wp.data.select('core/block-editor').getBlocks()[0].clientId;
      const dt = new DataTransfer();
      dt.setData('wp-blocks', JSON.stringify({ type: 'block', srcClientIds: [id], srcRootClientId: '' }));
      const region = document.getElementById('toolrail-region');
      region.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      region.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    const add = page.locator('#toolrail-region [role="dialog"][aria-labelledby="toolrail-adddialog-title"]');
    await expect(add).toBeVisible();
    await expect(heading).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(add).toHaveCount(0);
    await expect(heading).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(heading).toHaveAttribute('aria-pressed', 'false');
  });
});
