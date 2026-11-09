/**
 * EditRail — wide mode spec.
 *
 * Wide mode: the expander chevron and the icon-and-name rows.
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const { AUTH, openNewPost, getPref } = require('./helpers');

test.use({ storageState: AUTH });

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
