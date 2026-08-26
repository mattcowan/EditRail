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

  // The dock is a per-user browser preference, so a spec that moves the
  // rail would otherwise leak its position into every later spec. Only
  // pay for a reload when something was actually left behind.
  const hadPosition = await page.evaluate(() => {
    const stored = window.localStorage.getItem('toolrail-position');
    window.localStorage.removeItem('toolrail-position');
    return stored !== null;
  });
  if (hadPosition) {
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
    await expect(page.locator('#toolrail-rail [data-tool="text"]')).toHaveAttribute('aria-pressed', 'false');
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
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('text');
    await page.keyboard.press('End');
    const last = await page.evaluate(() => document.activeElement.dataset.tool);
    expect(last).toBeTruthy();
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

    await page.locator('#toolrail-rail [data-tool="text"]').click();
    await expect(page.locator('#toolrail-rail [data-tool="text"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'false');

    await canvas(page).locator('body').click({ position: { x: 300, y: 400 } });

    expect(await blockNames(page)).toContain('core/paragraph');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#toolrail-rail [data-tool="text"]')).toHaveAttribute('aria-pressed', 'false');
  });

  test('Shift-click keeps the tool armed for repeat inserts', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="heading"]').click();
    await canvas(page).locator('body').click({ position: { x: 300, y: 400 }, modifiers: ['Shift'] });
    await expect(page.locator('#toolrail-rail [data-tool="heading"]')).toHaveAttribute('aria-pressed', 'true');

    await canvas(page).locator('body').click({ position: { x: 300, y: 450 } });
    const names = await blockNames(page);
    expect(names.filter((n) => n === 'core/heading').length).toBe(2);
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
  test('pin via the block menu, persist across reload, Delete unpins', async ({ page }) => {
    await openNewPost(page);

    // Insert a paragraph to have a block to pin.
    await page.locator('#toolrail-rail [data-tool="text"]').click();
    await canvas(page).locator('body').click({ position: { x: 300, y: 400 } });

    // A dispatched selectBlock() gives no DOM focus, and Gutenberg hides the
    // floating toolbar for an EMPTY placeholder paragraph entirely — so do
    // what an author does: click into the block, give it content, then enter
    // navigation mode (Escape), which summons the block toolbar.
    await canvas(page).locator('[data-block]').last().click();
    await page.keyboard.type('Pin me');
    await page.keyboard.press('Escape');

    // Keyboard path: Pin to toolbar in the block options menu.
    await page.locator('.block-editor-block-toolbar button[aria-label="Options"]').click();
    await page.locator('.components-menu-item__button, .components-menu-item__item', { hasText: 'Pin to toolbar' }).first().click();

    const slot = page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]');
    await expect(slot).toBeVisible();

    // Persists (localStorage) across a reload.
    await openNewPost(page);
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toBeVisible();

    // Delete on the focused slot unpins it.
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').focus();
    await page.keyboard.press('Delete');
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.localStorage.getItem('toolrail-quick-slots'))).not.toContain('core/paragraph');
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
    await page.locator('#toolrail-rail [data-tool="text"]').click();
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
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('text');
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

    // Position is a browser preference: it survives a reload.
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

    await page.locator('#toolrail-rail [data-tool="text"]').focus();
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
    await page.locator('#toolrail-rail [data-tool="text"]').click();
    await expect(page.locator('#toolrail-rail [data-tool="text"]')).toHaveAttribute('aria-pressed', 'true');
  });
});
