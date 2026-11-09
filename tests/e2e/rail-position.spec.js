/**
 * EditRail — rail position spec.
 *
 * The rail position: the docks, the floating rail, and how the rail
 * stacks against core's panels and dialogs.
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const {
  AUTH,
  openNewPost,
  clickBelowContent,
  blockNames,
} = require('./helpers');

test.use({ storageState: AUTH });

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
