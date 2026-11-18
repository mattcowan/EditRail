/**
 * EditRail — more than one toolbar (#95).
 *
 * The first toolbar keeps its old keys, ids and behavior. Each extra
 * toolbar is a record in `toolrail-toolbars`, with its own name, pins,
 * position and wide mode, and its own region (`#toolrail-region-<id>`)
 * and rail (`#toolrail-rail-<id>`).
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const {
  AUTH,
  openNewPost,
  canvas,
  clickBelowContent,
  waitForSavedPref,
  getPref,
  liveText,
} = require('./helpers');
const { setRailScope, BASELINE } = require('./prefs-account');

test.use({ storageState: AUTH });

/** One stored extra-toolbar record, with defaults for the test. */
function record(id, name, extra) {
  return Object.assign({ id, name, dock: 'left', x: 40, y: 40, slots: ['core/quote'], wide: false, hidden: false }, extra || {});
}

/**
 * Put extra toolbars in the page's store, the way core's late attach or a
 * different tab's write arrives: a core/preferences dispatch. The rail
 * applies it with no reload (syncToolbars).
 */
async function seedByDispatch(page, records) {
  await page.evaluate((list) => {
    window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-toolbars', JSON.stringify({ version: 1, toolbars: list }));
  }, records);
}

/**
 * Put extra toolbars (and any other rail keys) in the account on the
 * SERVER, then reload: the boot path. The rest of the rail keys go back to
 * a fresh install's baseline.
 */
async function seedByServer(page, values) {
  // Leave the editor first. Its own boot writes (the slot migration after
  // the reset) go out through core's debounced save, and a trailing save
  // that lands after the write below puts the page's older state back
  // over it (prefs-account.js has the story). Seen once in a full run of
  // this file: the seeded key was gone after the reload.
  await page.goto('about:blank');
  await setRailScope(page, Object.assign({}, BASELINE, values));
  await page.goto('/wp-admin/post-new.php');
  await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
}

/** The boxes of the given ids and of the canvas region, in px. */
async function boxes(page, ids) {
  return page.evaluate((list) => {
    const out = {};
    list.forEach((id) => {
      const el = document.getElementById(id);
      const r = el ? el.getBoundingClientRect() : null;
      out[id] = r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
    });
    const c = document.querySelector('.interface-interface-skeleton__content').getBoundingClientRect();
    out.canvas = { left: c.left, top: c.top, right: c.right, bottom: c.bottom };
    return out;
  }, ids);
}

/** Whether two boxes share any area. */
function overlap(a, b) {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
}

/** Child-list mutations on the editor skeleton in one window of `ms`. */
async function skeletonMutations(page, ms) {
  return page.evaluate((wait) => new Promise((resolve) => {
    let n = 0;
    const mo = new MutationObserver((list) => {
      n += list.length;
    });
    mo.observe(document.querySelector('.interface-interface-skeleton__body'), { childList: true });
    mo.observe(document.querySelector('.interface-interface-skeleton__editor'), { childList: true });
    setTimeout(() => {
      mo.disconnect();
      resolve(n);
    }, wait);
  }), ms);
}

test.describe('multiple toolbars (#95)', () => {
  test('default: one toolbar, no extra region, no Toolbars button', async ({ page }) => {
    await openNewPost(page);

    await expect(page.locator('.toolrail-region')).toHaveCount(1);
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-toolbar', 'main');
    await expect(page.locator('#toolrail-rail')).toHaveAttribute('aria-label', 'Tools');
    await expect(page.locator('#toolrail-rail [data-tool="toolbar-list"]')).toHaveCount(0);
    expect(await getPref(page, 'toolrail-toolbars')).toBeNull();
    expect(await page.evaluate(() => window.toolrail.getToolbars())).toEqual([
      { id: 'main', name: 'Main toolbar', dock: 'left', x: 24, y: 24, hidden: false },
    ]);

    // One toolbar: no chooser, and the way to add one.
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await expect(page.locator('#toolrail-settings-toolbar')).toHaveCount(0);
    await expect(page.locator('.toolrail-settings-addtoolbar')).toBeVisible();
  });

  test('old saved data: the same toolbar in the same place', async ({ page }) => {
    await openNewPost(page);
    // An account from before #95: its own dock and pins, no toolbars key.
    await seedByServer(page, {
      'toolrail-position': JSON.stringify({ dock: 'right', x: 24, y: 24 }),
      'toolrail-quick-slots': JSON.stringify(['core/quote', 'core/list']),
    });

    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'right');
    await expect(page.locator('.toolrail-region')).toHaveCount(1);
    const pins = await page.evaluate(() => Array.from(document.querySelectorAll('#toolrail-rail [data-tool^="pin:"]')).map((b) => b.dataset.tool));
    expect(pins).toEqual(['pin:core/quote', 'pin:core/list']);
    // Nothing was written for the new feature.
    expect(await getPref(page, 'toolrail-toolbars')).toBeNull();
  });

  test('a stored extra toolbar is its own region and toolbar, with its own name and pins', async ({ page }) => {
    await openNewPost(page);
    await seedByServer(page, {
      'toolrail-toolbars': JSON.stringify({ version: 1, toolbars: [record('t1', 'Animation', { dock: 'right', slots: ['core/quote', 'core/list'] })] }),
    });

    const region = page.locator('#toolrail-region-t1');
    await expect(region).toHaveAttribute('role', 'region');
    await expect(region).toHaveAttribute('aria-label', 'Tool rail: Animation');
    await expect(region).toHaveAttribute('data-toolbar', 't1');
    await expect(region).toHaveAttribute('data-dock', 'right');
    const rail = page.locator('#toolrail-rail-t1');
    await expect(rail).toHaveAttribute('role', 'toolbar');
    await expect(rail).toHaveAttribute('aria-label', 'Animation');
    await expect(rail).toHaveClass(/toolrail-rail/);

    // Its own pins, and none of the first toolbar's built-in tools.
    const tools = await page.evaluate(() => Array.from(document.querySelectorAll('#toolrail-rail-t1 .toolrail-tool')).map((b) => b.dataset.tool));
    expect(tools).toEqual(['pin:core/quote', 'pin:core/list']);
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/quote"]')).toHaveCount(0);
    // The first toolbar is unchanged.
    await expect(page.locator('#toolrail-rail')).toHaveAttribute('aria-label', 'Tools');
    await expect(page.locator('#toolrail-rail [data-tool="settings"]')).toHaveCount(1);
    await expect(page.locator('#toolrail-rail-t1 [data-tool="settings"]')).toHaveCount(0);
  });

  test('each toolbar is one Tab stop; arrow keys stay inside one toolbar', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation', { slots: ['core/quote', 'core/list'] })]);
    await expect(page.locator('#toolrail-rail-t1')).toBeVisible();

    for (const id of ['toolrail-rail', 'toolrail-rail-t1']) {
      const stops = await page.evaluate((railId) => Array.from(document.querySelectorAll('#' + railId + ' .toolrail-tool'))
        .filter((b) => b.tabIndex === 0).length, id);
      expect(stops).toBe(1);
    }

    // Both on the left: Tab goes from the first toolbar to the extra one.
    await page.locator('#toolrail-rail [data-tool="select"]').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#toolrail-rail-t1 [data-tool="pin:core/quote"]')).toBeFocused();

    // Arrows wrap inside the extra toolbar and never leave it.
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#toolrail-rail-t1 [data-tool="pin:core/list"]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#toolrail-rail-t1 [data-tool="pin:core/quote"]')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('#toolrail-rail-t1 [data-tool="pin:core/list"]')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.locator('#toolrail-rail-t1 [data-tool="pin:core/quote"]')).toBeFocused();

    // Shift+Tab goes back to the first toolbar's stop.
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toBeFocused();
  });

  for (const edge of ['left', 'right', 'top', 'bottom']) {
    test(`two toolbars on the ${edge} edge cover neither each other nor the canvas, and the layout settles`, async ({ page }) => {
      await openNewPost(page);
      if (edge !== 'left') {
        await page.evaluate((d) => window.toolrail.setDock(d), edge);
      }
      await seedByDispatch(page, [record('t1', 'One', { dock: edge }), record('t2', 'Two', { dock: edge })]);
      await expect(page.locator('#toolrail-region-t2')).toHaveAttribute('data-dock', edge);

      // No observer loop: two of our regions that each want the end of
      // the same parent would move each other on every pass (design 4.2).
      await skeletonMutations(page, 500);
      expect(await skeletonMutations(page, 2000)).toBe(0);

      const b = await boxes(page, ['toolrail-region', 'toolrail-region-t1', 'toolrail-region-t2']);
      const ids = ['toolrail-region', 'toolrail-region-t1', 'toolrail-region-t2'];
      ids.forEach((id) => {
        expect(b[id], id).not.toBeNull();
        expect(overlap(b[id], b.canvas), id + ' over the canvas').toBe(false);
      });
      expect(overlap(b['toolrail-region'], b['toolrail-region-t1'])).toBe(false);
      expect(overlap(b['toolrail-region-t1'], b['toolrail-region-t2'])).toBe(false);
      expect(overlap(b['toolrail-region'], b['toolrail-region-t2'])).toBe(false);

      // The first toolbar is against the edge; each later one is nearer
      // the canvas.
      const order = {
        left: (x) => x.left,
        right: (x) => -x.right,
        top: (x) => x.top,
        bottom: (x) => -x.bottom,
      }[edge];
      expect(order(b['toolrail-region'])).toBeLessThan(order(b['toolrail-region-t1']));
      expect(order(b['toolrail-region-t1'])).toBeLessThan(order(b['toolrail-region-t2']));
      // Two bottom bars: no empty band between them (design Q3).
      if (edge === 'bottom') {
        expect(Math.abs(b['toolrail-region-t1'].bottom - b['toolrail-region'].top)).toBeLessThan(1);
      }
    });
  }

  test('each toolbar keeps its own pins and position after a reload', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation', { slots: [] })]);
    await expect(page.locator('#toolrail-rail-t1')).toBeVisible();

    expect(await page.evaluate(() => window.toolrail.pinBlock('core/quote', 't1'))).toBe(true);
    expect(await page.evaluate(() => window.toolrail.setDock('float', 't1'))).toBe(true);
    expect(await page.evaluate(() => window.toolrail.setDock('right'))).toBe(true);
    await waitForSavedPref(page, 'toolrail-toolbars', (v) => {
      try {
        const rec = JSON.parse(v).toolbars[0];
        return rec.dock === 'float' && rec.slots.join() === 'core/quote';
      } catch (e) {
        return false;
      }
    });
    await waitForSavedPref(page, 'toolrail-position', (v) => !!v && JSON.parse(v).dock === 'right');

    await page.reload();
    await expect(page.locator('#toolrail-rail-t1')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#toolrail-region-t1')).toHaveAttribute('data-dock', 'float');
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'right');
    await expect(page.locator('#toolrail-rail-t1 [data-tool="pin:core/quote"]')).toHaveCount(1);
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/quote"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.toolrail.getDock('t1'))).toBe('float');
    expect(await page.evaluate(() => window.toolrail.getDock())).toBe('right');
  });

  test('only one tool is armed across all toolbars', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation', { slots: ['core/heading'] })]);
    const mainPara = page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]');
    const extraHeading = page.locator('#toolrail-rail-t1 [data-tool="pin:core/heading"]');
    const mainHeading = page.locator('#toolrail-rail [data-tool="pin:core/heading"]');

    await mainPara.click();
    await expect(mainPara).toHaveAttribute('aria-pressed', 'true');
    await extraHeading.click();
    await expect(extraHeading).toHaveAttribute('aria-pressed', 'true');
    await expect(mainPara).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'false');
    // The same tool on two toolbars is one tool: both buttons show it.
    await expect(mainHeading).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.toolrail.getActiveTool())).toBe('pin:core/heading');

    // An armed click from the extra toolbar inserts.
    await clickBelowContent(page);
    await expect.poll(() => page.evaluate(() => window.wp.data.select('core/block-editor').getBlocks().map((x) => x.name))).toContain('core/heading');
  });

  test('pins and the public calls: the same block can be on two toolbars', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation', { slots: ['core/quote'] })]);
    await expect(page.locator('#toolrail-rail-t1')).toBeVisible();

    const r = await page.evaluate(() => {
      const tr = window.toolrail;
      const out = {};
      out.pinnedAny = tr.isPinned('core/quote');
      out.pinnedMain = tr.isPinned('core/quote', 'main');
      // Without an id, a pin that ANY toolbar shows is refused, like the
      // block menu item; with an id it goes to that toolbar.
      out.pinNoId = tr.pinBlock('core/quote');
      out.pinMain = tr.pinBlock('core/quote', 'main');
      out.pinUnknown = tr.pinBlock('core/list', 'nope');
      out.dockUnknown = tr.getDock('nope');
      out.setDockUnknown = tr.setDock('right', 'nope');
      out.bothBefore = [tr.isPinned('core/quote', 'main'), tr.isPinned('core/quote', 't1')];
      // Without an id, unpin removes it from every toolbar.
      out.unpin = tr.unpinBlock('core/quote');
      out.after = [tr.isPinned('core/quote'), tr.isPinned('core/quote', 't1')];
      // The two new chrome ids are reserved.
      out.reserved = ['toolbar-list', 'toolbar-add-tools'].map((id) => tr.registerTool({ id, label: id, onActivate: () => {} }));
      return out;
    });
    expect(r).toEqual({
      pinnedAny: true,
      pinnedMain: false,
      pinNoId: false,
      pinMain: true,
      pinUnknown: false,
      dockUnknown: null,
      setDockUnknown: false,
      bothBefore: [true, true],
      unpin: true,
      after: [false, false],
      reserved: [false, false],
    });
    // An empty extra toolbar shows its one "Add tools" button.
    await expect(page.locator('#toolrail-rail-t1 [data-tool="toolbar-add-tools"]')).toHaveAttribute('aria-label', 'Add tools to Animation');
  });

  test('an empty extra toolbar\'s button opens Toolbar settings for that toolbar', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation', { slots: [] })]);
    const add = page.locator('#toolrail-rail-t1 [data-tool="toolbar-add-tools"]');
    await add.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#toolrail-settings-search')).toBeFocused();
    await expect(page.locator('#toolrail-settings-toolbar')).toHaveValue('t1');
    await expect(page.locator('.toolrail-settings-subtitle').first()).toHaveText('Pinned tools: Animation');

    // A pin from the search goes to the chosen toolbar only.
    await page.locator('#toolrail-settings-search').fill('quote');
    await page.locator('.toolrail-settings-result[data-block="core/quote"]').click();
    await expect(page.locator('#toolrail-rail-t1 [data-tool="pin:core/quote"]')).toHaveCount(1);
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/quote"]')).toHaveCount(0);
    await expect.poll(() => liveText(page)).toContain('Quote pinned to the Animation toolbar.');
    // The "Add tools" button left with the first pin.
    await expect(page.locator('#toolrail-rail-t1 [data-tool="toolbar-add-tools"]')).toHaveCount(0);
  });

  test('Toolbar settings adds, names and deletes a toolbar by keyboard, and says so', async ({ page }) => {
    await openNewPost(page);
    const events = await page.evaluateHandle(() => {
      const list = [];
      window.addEventListener('toolrail:toolbars-changed', (e) => list.push(e.detail));
      return list;
    });
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('.toolrail-settings-addtoolbar').focus();
    await page.keyboard.press('Enter');

    // Beside the first toolbar, on the same edge, chosen, named "Toolbar 2".
    await expect(page.locator('#toolrail-region-t1')).toHaveAttribute('data-dock', 'left');
    await expect(page.locator('#toolrail-settings-toolbarname')).toBeFocused();
    await expect(page.locator('#toolrail-settings-toolbarname')).toHaveValue('Toolbar 2');
    await expect.poll(() => liveText(page)).toContain('Added the Toolbar 2 toolbar');
    // The dialog stays open, and it does not cover the new toolbar on the
    // same edge.
    const b = await page.evaluate(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      return { dialog: box(document.querySelector('.toolrail-settings')), t1: box(document.getElementById('toolrail-region-t1')) };
    });
    expect(overlap(b.dialog, b.t1)).toBe(false);
    expect(b.dialog.left).toBeGreaterThanOrEqual(b.t1.right);

    // Rename: a name in use is refused; a free one is applied.
    await page.locator('#toolrail-settings-toolbarname').fill('Tools');
    await page.keyboard.press('Enter');
    await expect(page.locator('#toolrail-settings-toolbars-status')).toContainText('A different toolbar has that name');
    await expect(page.locator('#toolrail-settings-toolbarname')).toHaveValue('Tools');
    await page.locator('#toolrail-settings-toolbarname').fill('Animation');
    await page.keyboard.press('Enter');
    await expect(page.locator('#toolrail-rail-t1')).toHaveAttribute('aria-label', 'Animation');
    await expect(page.locator('#toolrail-region-t1')).toHaveAttribute('aria-label', 'Tool rail: Animation');
    await expect(page.locator('#toolrail-settings-toolbarname')).toBeFocused();
    await expect.poll(() => liveText(page)).toContain('Renamed the Toolbar 2 toolbar to Animation.');

    // A dock change of the extra toolbar keeps the dialog open.
    await page.locator('input[data-dock="right"]').check();
    await expect(page.locator('#toolrail-region-t1')).toHaveAttribute('data-dock', 'right');
    await expect(page.locator('.toolrail-settings')).toBeVisible();
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-dock', 'left');

    // Delete: its pins go with it, and the status says so.
    await page.evaluate(() => window.toolrail.pinBlock('core/quote', 't1'));
    await page.locator('.toolrail-settings-deletetoolbar').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#toolrail-region-t1')).toHaveCount(0);
    await expect.poll(() => liveText(page)).toContain('Deleted the Animation toolbar and its 1 pinned tool.');
    await expect(page.locator('.toolrail-settings-addtoolbar')).toBeFocused();
    await expect(page.locator('#toolrail-settings-toolbar')).toHaveCount(0);
    expect(await page.evaluate(() => window.toolrail.getToolbars().length)).toBe(1);

    const changes = await events.evaluate((list) => list.map((d) => d.toolbar + ':' + d.change));
    expect(changes).toEqual(['t1:added', 't1:renamed', 't1:position', 't1:removed']);
  });

  test('a fifth toolbar is refused, and stored data with more is clamped', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [
      record('t1', 'A'), record('t2', 'B'), record('t3', 'C'), record('t4', 'D'),
    ]);
    // The first toolbar plus three: the fourth record is left out.
    await expect(page.locator('.toolrail-region')).toHaveCount(4);
    await expect(page.locator('#toolrail-region-t4')).toHaveCount(0);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('.toolrail-settings-addtoolbar').click();
    await expect(page.locator('#toolrail-settings-toolbars-status')).toContainText('You have 4 toolbars, which is the most there can be.');
    await expect(page.locator('.toolrail-region')).toHaveCount(4);
  });

  test('records the reader leaves out are kept, unchanged, by the next write', async ({ page }) => {
    await openNewPost(page);
    const extra = [
      record('t4', 'D', { slots: ['core/verse'] }),
      record('t5', 'E', { slots: ['core/code'], future: { kept: true } }),
      record('BAD ID', 'Bad'),
      record('t1', 'Repeated id', { slots: ['core/list'] }),
    ];
    await seedByDispatch(page, [record('t1', 'A', { future: 'kept' }), record('t2', 'B'), record('t3', 'C')].concat(extra));
    await expect(page.locator('#toolrail-region-t3')).toBeVisible();

    // One change to a shown toolbar writes the list.
    expect(await page.evaluate(() => window.toolrail.setDock('right', 't1'))).toBe(true);
    const stored = JSON.parse(await getPref(page, 'toolrail-toolbars')).toolbars;
    // The shown toolbars first, the first one changed and its unknown
    // field kept; then every left-out record, as it was stored.
    expect(stored.map((r) => r.id)).toEqual(['t1', 't2', 't3', 't4', 't5', 'BAD ID', 't1']);
    expect(stored[0].dock).toBe('right');
    expect(stored[0].future).toBe('kept');
    expect(stored.slice(3)).toEqual(extra);
    await expect(page.locator('.toolrail-region')).toHaveCount(4);
  });

  test('an id that is also an object property name is an ordinary id', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('constructor', 'Ctor'), record('toString', 'Not lowercase')]);
    await expect(page.locator('#toolrail-region-constructor')).toBeVisible();
    expect(await page.evaluate(() => window.toolrail.getToolbars().map((t) => t.id))).toEqual(['main', 'constructor']);
  });

  test('renaming an empty toolbar renames its "Add tools" button, and focus stays in the dialog', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('.toolrail-settings-addtoolbar').click();
    const name = page.locator('#toolrail-settings-toolbarname');
    await expect(name).toBeFocused();
    await name.fill('Animation');
    await page.keyboard.press('Enter');
    await expect(page.locator('#toolrail-rail-t1 [data-tool="toolbar-add-tools"]')).toHaveAttribute('aria-label', 'Add tools to Animation');
    await expect(name).toBeFocused();
  });

  test('stored data is validated: bad ids are dropped, names are made unique', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [
      record('main', 'Not allowed'),
      record('BAD ID', 'Dropped'),
      record('t1', 'Same'),
      record('t1', 'Repeated id'),
      record('t2', 'same'),
      record('t3', '   ', { dock: 'nowhere', x: 'a' }),
    ]);
    await expect(page.locator('#toolrail-region-t3')).toBeVisible();
    const list = await page.evaluate(() => window.toolrail.getToolbars().map((t) => [t.id, t.name, t.dock]));
    expect(list).toEqual([
      ['main', 'Main toolbar', 'left'],
      ['t1', 'Same', 'left'],
      ['t2', 'same 2', 'left'],
      ['t3', 'Toolbar 4', 'left'],
    ]);
  });
});

test.describe('second-toolbar twins of the single-toolbar tests (#95)', () => {
  test('a top extra toolbar is horizontal while the first stays vertical, and opens its flyouts downward', async ({ page }) => {
    await openNewPost(page);
    // A provider child under a pin gives the extra toolbar's pin a flyout.
    await page.evaluate(() => window.toolrail.registerTool({
      id: 'spec:quote-child', label: 'Quote child', parent: 'pin:core/quote', insertBlock: 'core/quote',
    }));
    await seedByDispatch(page, [record('t1', 'Animation', { dock: 'top' })]);
    await expect(page.locator('#toolrail-rail-t1')).toHaveAttribute('aria-orientation', 'horizontal');
    await expect(page.locator('#toolrail-rail')).toHaveAttribute('aria-orientation', 'vertical');

    // Horizontal: ArrowDown opens the flyout, and it opens below the bar.
    const quote = page.locator('#toolrail-rail-t1 [data-tool="pin:core/quote"]');
    await quote.focus();
    await page.keyboard.press('ArrowDown');
    const flyout = page.locator('#toolrail-region-t1 .toolrail-flyout');
    await expect(flyout).toBeVisible();
    await expect(flyout.locator('[data-tool="spec:quote-child"]')).toBeFocused();
    const b = await page.evaluate(() => ({
      bar: document.getElementById('toolrail-region-t1').getBoundingClientRect().bottom,
      menu: document.querySelector('#toolrail-region-t1 .toolrail-flyout').getBoundingClientRect().top,
    }));
    expect(b.menu).toBeGreaterThanOrEqual(b.bar);
    // Only the owner is raised while its flyout is open.
    await expect(page.locator('#toolrail-region-t1')).toHaveClass(/is-raised/);
    await expect(page.locator('#toolrail-region')).not.toHaveClass(/is-raised/);
    await page.keyboard.press('Escape');
    await expect(quote).toBeFocused();
    // The registered child is on the extra toolbar; no top-level copy on
    // the first toolbar.
    await expect(page.locator('#toolrail-rail [data-tool="spec:quote-child"]')).toHaveCount(0);
  });

  test('a top-level provider tool stays on the first toolbar', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation')]);
    await page.evaluate(() => window.toolrail.registerTool({ id: 'spec:top', label: 'Top tool', onActivate: () => {} }));
    await expect(page.locator('#toolrail-rail [data-tool="spec:top"]')).toHaveCount(1);
    await expect(page.locator('#toolrail-rail-t1 [data-tool="spec:top"]')).toHaveCount(0);
  });

  test('a provider child follows its parent pin: hidden with its toolbar, at the top level when no toolbar has the pin', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation', { slots: ['core/quote'] })]);
    await page.evaluate(() => window.toolrail.registerTool({
      id: 'spec:quote-child', label: 'Quote child', parent: 'pin:core/quote', insertBlock: 'core/quote',
    }));
    const onMain = page.locator('#toolrail-rail [data-tool="spec:quote-child"]');
    await expect(onMain).toHaveCount(0);
    // Hidden with its toolbar: it does not move to the first toolbar.
    await page.evaluate(() => {
      document.querySelector('#toolrail-rail [data-tool="toolbar-list"]').click();
    });
    await page.locator('.toolrail-flyout[aria-label="Toolbars"] [role="menuitemcheckbox"]').first().click();
    await expect(page.locator('#toolrail-region-t1')).toHaveCount(0);
    await expect(onMain).toHaveCount(0);
    // No toolbar has the pin: the fallback to the top level, as with one
    // toolbar.
    await page.evaluate(() => window.toolrail.unpinBlock('core/quote', 't1'));
    await expect(onMain).toHaveCount(1);
  });

  test('the outer toolbar\'s flyout paints over the inner toolbar on the same edge', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation', { slots: ['core/quote', 'core/list', 'core/code'] })]);
    // The first toolbar's Saved sets menu needs a set.
    await page.evaluate(() => window.toolrail.saveConfig('basic'));
    const sets = page.locator('#toolrail-rail [data-tool="saved-sets"]');
    await sets.click();
    const menu = page.locator('#toolrail-region .toolrail-flyout');
    await expect(menu).toBeVisible();
    const hit = await page.evaluate(() => {
      const m = document.querySelector('#toolrail-region .toolrail-flyout').getBoundingClientRect();
      const inner = document.getElementById('toolrail-region-t1').getBoundingClientRect();
      // A point that is inside both the menu and the inner toolbar.
      const x = Math.round(Math.max(m.left, inner.left) + 4);
      const y = Math.round(m.top + 8);
      const el = document.elementFromPoint(x, y);
      return { overlaps: m.left < inner.right, onMenu: !!(el && el.closest('.toolrail-flyout')) };
    });
    expect(hit.overlaps).toBe(true);
    expect(hit.onMenu).toBe(true);
  });

  test('dragging the extra toolbar\'s grip moves only that toolbar, and it lands beside the first', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation', { dock: 'right' })]);
    await expect(page.locator('#toolrail-region-t1')).toHaveAttribute('data-dock', 'right');
    const result = await page.evaluate(() => {
      const grip = document.querySelector('#toolrail-region-t1 .toolrail-grip');
      const g = grip.getBoundingClientRect();
      const body = document.querySelector('.interface-interface-skeleton__body').getBoundingClientRect();
      const fire = (el, type, x, y) => el.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
      );
      fire(grip, 'mousedown', g.left + 6, g.top + 6);
      fire(document, 'mousemove', 400, 400);
      const afterTear = window.toolrail.getDock('t1');
      fire(document, 'mousemove', Math.round(body.left) + 10, 400);
      const preview = document.getElementById('toolrail-snap-preview').getBoundingClientRect();
      const main = document.getElementById('toolrail-region').getBoundingClientRect();
      fire(document, 'mouseup', Math.round(body.left) + 10, 400);
      return { afterTear, previewLeft: preview.left, mainRight: main.right, afterDrop: window.toolrail.getDock('t1'), mainDock: window.toolrail.getDock() };
    });
    expect(result.afterTear).toBe('float');
    // The snap band shows the place beside the first toolbar, not on it.
    expect(result.previewLeft).toBeCloseTo(result.mainRight, 0);
    expect(result.afterDrop).toBe('left');
    expect(result.mainDock).toBe('left');
    const b = await boxes(page, ['toolrail-region', 'toolrail-region-t1']);
    expect(overlap(b['toolrail-region'], b['toolrail-region-t1'])).toBe(false);
    expect(b['toolrail-region-t1'].left).toBeGreaterThanOrEqual(b['toolrail-region'].right - 0.5);
  });

  test('two floating toolbars keep separate offsets across a reload, and drop under a modal', async ({ page }) => {
    await openNewPost(page);
    await seedByServer(page, {
      'toolrail-toolbars': JSON.stringify({ version: 1, toolbars: [
        record('t1', 'One', { dock: 'float', x: 100, y: 60 }),
        record('t2', 'Two', { dock: 'float', x: 300, y: 200 }),
      ] }),
    });
    await expect(page.locator('#toolrail-region-t2')).toBeVisible();
    expect(await page.evaluate(() => [window.toolrail.getPosition('t1'), window.toolrail.getPosition('t2')])).toEqual([
      { dock: 'float', x: 100, y: 60 },
      { dock: 'float', x: 300, y: 200 },
    ]);
    await expect(page.locator('#toolrail-region-t1')).toHaveClass(/is-raised/);

    await page.locator('button[aria-label="Options"]').click();
    await page.getByRole('menuitem', { name: 'Preferences' }).click();
    await expect(page.locator('.components-modal__screen-overlay')).toBeVisible();
    expect(await page.evaluate(() => window.getComputedStyle(document.getElementById('toolrail-region-t2')).zIndex)).toBe('30');
    await page.keyboard.press('Escape');
  });

  test('a floating extra toolbar stays above the side panel while a dialog is open, and the dialog paints above it', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    const dialog = page.locator('.toolrail-settings');
    await expect(dialog).toBeVisible();
    // t1 floats over the settings sidebar; t2 floats where the dialog is.
    const spots = await page.evaluate(() => {
      const body = document.querySelector('.interface-interface-skeleton__body').getBoundingClientRect();
      const side = document.querySelector('.interface-interface-skeleton__sidebar');
      const s = side ? side.getBoundingClientRect() : null;
      const d = document.querySelector('.toolrail-settings').getBoundingClientRect();
      return {
        sidebar: s && s.width > 0 ? { x: Math.round(s.left - body.left + 40), y: 120 } : null,
        dialog: { x: Math.round(d.left - body.left + 20), y: Math.round(d.top - body.top + 20) },
      };
    });
    expect(spots.sidebar, 'the settings sidebar is open').not.toBeNull();
    await seedByDispatch(page, [
      record('t1', 'Over the panel', { dock: 'float', x: spots.sidebar.x, y: spots.sidebar.y }),
      record('t2', 'Under the dialog', { dock: 'float', x: spots.dialog.x, y: spots.dialog.y }),
    ]);
    await expect(page.locator('#toolrail-region-t2')).toBeVisible();
    await expect(dialog).toBeVisible();
    const hits = await page.evaluate(() => {
      const center = (el) => {
        const r = el.getBoundingClientRect();
        return document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + 20));
      };
      const t1 = document.getElementById('toolrail-region-t1');
      const t2 = document.getElementById('toolrail-region-t2');
      const d = document.querySelector('.toolrail-settings').getBoundingClientRect();
      const r2 = t2.getBoundingClientRect();
      // A point inside both the dialog and t2.
      const x = Math.round((Math.max(d.left, r2.left) + Math.min(d.right, r2.right)) / 2);
      const y = Math.round((Math.max(d.top, r2.top) + Math.min(d.bottom, r2.bottom)) / 2);
      const both = document.elementFromPoint(x, y);
      return {
        t1: t1.contains(center(t1)),
        overlap: Math.min(d.right, r2.right) > Math.max(d.left, r2.left) && Math.min(d.bottom, r2.bottom) > Math.max(d.top, r2.top),
        dialogOnTop: !!(both && both.closest('.toolrail-settings')),
      };
    });
    expect(hits.t1, 'the floating toolbar is not under the sidebar').toBe(true);
    expect(hits.overlap).toBe(true);
    expect(hits.dialogOnTop, 'the dialog paints over the floating toolbar').toBe(true);
  });

  test('a floating first toolbar stays above the side panel while an extra toolbar\'s flyout is open', async ({ page }) => {
    await openNewPost(page);
    const x = await page.evaluate(() => {
      const body = document.querySelector('.interface-interface-skeleton__body').getBoundingClientRect();
      const s = document.querySelector('.interface-interface-skeleton__sidebar').getBoundingClientRect();
      return Math.round(s.left - body.left + 40);
    });
    // The first toolbar floats over the settings sidebar.
    await seedByServer(page, {
      'toolrail-position': JSON.stringify({ dock: 'float', x, y: 120 }),
      'toolrail-toolbars': JSON.stringify({ version: 1, toolbars: [record('t1', 'Animation')] }),
    });
    await expect(page.locator('#toolrail-rail-t1')).toBeVisible({ timeout: 20000 });
    await page.evaluate(() => window.toolrail.registerTool({
      id: 'spec:quote-child', label: 'Quote child', parent: 'pin:core/quote', insertBlock: 'core/quote',
    }));
    await page.locator('#toolrail-rail-t1 [data-tool="pin:core/quote"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#toolrail-region-t1 .toolrail-flyout')).toBeVisible();
    const onTop = await page.evaluate(() => {
      const region = document.getElementById('toolrail-region');
      const r = region.getBoundingClientRect();
      return region.contains(document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + 20)));
    });
    expect(onTop).toBe(true);
  });

  test('both toolbars survive the code-editor round trip, in order, and the layout settles', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'One', { dock: 'right' })]);
    await expect(page.locator('#toolrail-region-t1')).toBeVisible();
    // Prove each switch happened: the code editor's text area, then the
    // visual editor's canvas frame.
    await page.keyboard.press('Control+Shift+Alt+M');
    await expect(page.locator('.editor-post-text-editor')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Control+Shift+Alt+M');
    await expect(page.locator('iframe[name="editor-canvas"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.editor-post-text-editor')).toHaveCount(0);
    await expect(page.locator('#toolrail-rail-t1')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#toolrail-rail')).toBeVisible();
    await skeletonMutations(page, 500);
    expect(await skeletonMutations(page, 2000)).toBe(0);
    const last = await page.evaluate(() => document.querySelector('.interface-interface-skeleton__body').lastElementChild.id);
    expect(last).toBe('toolrail-region-t1');
  });

  test('Ctrl+Enter on an armed tool of the extra toolbar inserts after the selected block', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation', { slots: ['core/quote'] })]);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      const a = createBlock('core/paragraph', { content: 'A' });
      window.wp.data.dispatch('core/block-editor').resetBlocks([a]);
      window.wp.data.dispatch('core/block-editor').selectBlock(a.clientId);
    });
    const quote = page.locator('#toolrail-rail-t1 [data-tool="pin:core/quote"]');
    await quote.focus();
    await page.keyboard.press('Enter');
    await expect(quote).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Control+Enter');
    await expect.poll(() => page.evaluate(() => window.wp.data.select('core/block-editor').getBlocks().map((x) => x.name))).toEqual(['core/paragraph', 'core/quote']);
  });

  test('a block dropped on the extra toolbar pins there', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation', { slots: [] })]);
    await expect(page.locator('#toolrail-region-t1')).toBeVisible();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('wp-blocks', JSON.stringify({ type: 'inserter', blocks: [{ name: 'core/verse', attributes: {}, innerBlocks: [] }] }));
      const region = document.getElementById('toolrail-region-t1');
      region.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      region.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('#toolrail-rail-t1 [data-tool="pin:core/verse"]')).toHaveCount(1);
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/verse"]')).toHaveCount(0);
  });

  test('a saved set loads into the chosen toolbar, and saves from it in the same file format', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation', { slots: ['core/quote', 'core/list'] })]);
    // The first toolbar's defaults, saved as a set before the dialog opens.
    await page.evaluate(() => window.toolrail.saveConfig('defaults'));
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-toolbar').selectOption('t1');
    await page.locator('#toolrail-settings-setname').fill('motion');
    await page.locator('.toolrail-settings-saveset').click();
    expect(await page.evaluate(() => window.toolrail.getConfigs().motion)).toEqual(['core/quote', 'core/list']);

    // Load the defaults into the extra toolbar; the first toolbar keeps
    // its pins, all of them, in order.
    const mainPins = () => page.evaluate(() => Array.from(document.querySelectorAll('#toolrail-rail [data-tool^="pin:"]')).map((x) => x.dataset.tool));
    const mainBefore = await mainPins();
    expect(mainBefore.length).toBeGreaterThan(0);
    await page.locator('.toolrail-settings-setrow[data-config="defaults"] .toolrail-settings-load').click();
    await expect.poll(() => liveText(page)).toContain('Loaded "defaults" into the Animation toolbar.');
    const extra = await page.evaluate(() => Array.from(document.querySelectorAll('#toolrail-rail-t1 [data-tool^="pin:"]')).map((x) => x.dataset.tool));
    expect(extra).toEqual(['pin:core/group', 'pin:core/paragraph', 'pin:core/heading', 'pin:core/image']);
    expect(await mainPins()).toEqual(mainBefore);

    // A set saved from the extra toolbar exports in the one set format.
    const file = await page.evaluate(() => {
      const payloads = [];
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        payloads.push(blob);
        return orig.call(URL, blob);
      };
      window.toolrail.exportConfig('motion');
      URL.createObjectURL = orig;
      return payloads.length ? payloads[0].text() : null;
    });
    const parsed = JSON.parse(file);
    expect(parsed.format).toBe('toolrail-set');
    expect(parsed.version).toBe(1);
    expect(parsed.blocks).toEqual(['core/quote', 'core/list']);
  });

  test('wide mode is one setting for each toolbar, and each has its chevron', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation')]);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-widetoggle').check();
    await expect(page.locator('#toolrail-rail-t1 [data-tool="wide-toggle"]')).toHaveCount(1);
    await expect(page.locator('#toolrail-rail [data-tool="wide-toggle"]')).toHaveCount(1);
    await page.locator('#toolrail-settings-toolbar').selectOption('t1');
    await page.locator('#toolrail-settings-wide').check();
    await expect(page.locator('#toolrail-region-t1')).toHaveAttribute('data-wide', 'true');
    await expect(page.locator('#toolrail-region')).not.toHaveAttribute('data-wide', 'true');
    expect(await getPref(page, 'toolrail-wide')).not.toBe('1');
    // The extra toolbar's chevron is its own: pressed with its region.
    await expect(page.locator('#toolrail-rail-t1 [data-tool="wide-toggle"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#toolrail-rail [data-tool="wide-toggle"]')).toHaveAttribute('aria-pressed', 'false');
  });

  test('an appearance preset recolors every toolbar', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation')]);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('input[data-appearance="light"]').check();
    // The same --toolrail-* tokens, inline, on both regions.
    const tokens = await page.evaluate(() => ['toolrail-region', 'toolrail-region-t1'].map((id) => {
      const style = document.getElementById(id).style;
      const out = {};
      for (let i = 0; i < style.length; i++) {
        if (style[i].indexOf('--toolrail-') === 0) {
          out[style[i]] = style.getPropertyValue(style[i]);
        }
      }
      return out;
    }));
    expect(Object.keys(tokens[0]).length).toBeGreaterThan(0);
    expect(tokens[1]).toEqual(tokens[0]);
  });
});

test.describe('owner decisions of 2026-11-16 (#95)', () => {
  /** Four toolbars on the left, all wide except the first. */
  async function fourWideOnTheLeft(page) {
    await seedByDispatch(page, [
      record('t1', 'A', { wide: true }), record('t2', 'B', { wide: true }), record('t3', 'C', { wide: true }),
    ]);
    await expect(page.locator('#toolrail-region-t3')).toHaveAttribute('data-wide', 'true');
  }

  test('a change that leaves the canvas too narrow says so, in one message; a page load says nothing', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openNewPost(page);
    await fourWideOnTheLeft(page);
    // Stored data that arrives without an author's change says nothing.
    expect(await liveText(page)).not.toContain('content area');

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-wide').check();
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-wide', 'true');
    const width = await page.evaluate(() => Math.round(document.querySelector('.interface-interface-skeleton__content').getBoundingClientRect().width));
    expect(width).toBeLessThan(600);
    const message = `The content area is now ${width} pixels wide, less than 600. To give it more room, hide or move a toolbar, or turn off tool names.`;
    await expect(page.locator('#toolrail-settings-toolbars-status')).toHaveText(message);
    await expect.poll(() => liveText(page)).toBe(message);
    await expect(page.locator('#toolrail-settings-wide')).toBeFocused();

    // Together with the change's own message: a show of a hidden toolbar.
    await page.locator('#toolrail-settings-toolbar').selectOption('t1');
    await page.locator('#toolrail-settings-toolbarshown').uncheck();
    await page.locator('#toolrail-settings-toolbarshown').check();
    await expect.poll(() => liveText(page)).toMatch(/^The A toolbar is shown\. The content area is now \d+ pixels wide, less than 600\./);
  });

  test('at a window wide enough, the same change says nothing about the canvas', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 });
    await openNewPost(page);
    await fourWideOnTheLeft(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-wide').check();
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-wide', 'true');
    const width = await page.evaluate(() => Math.round(document.querySelector('.interface-interface-skeleton__content').getBoundingClientRect().width));
    expect(width).toBeGreaterThanOrEqual(600);
    await expect(page.locator('#toolrail-settings-toolbars-status')).toHaveText('');
    expect(await liveText(page)).not.toContain('content area');
  });

  test('with one toolbar, a narrow canvas adds nothing to the default path', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-wide').check();
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-wide', 'true');
    const width = await page.evaluate(() => Math.round(document.querySelector('.interface-interface-skeleton__content').getBoundingClientRect().width));
    expect(width).toBeLessThan(600);
    await expect(page.locator('#toolrail-settings-toolbars-status')).toHaveText('');
    expect(await liveText(page)).not.toContain('content area');
  });

  test('D4: a hidden toolbar\'s pins do not count as pinned, and stay where they are', async ({ page }) => {
    await openNewPost(page);
    // A paragraph to open the block menu on.
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').click();
    await clickBelowContent(page);
    await canvas(page).locator('[data-block]').last().click();
    await page.keyboard.type('Pin me');
    await page.keyboard.press('Escape');

    // Paragraph only on a HIDDEN extra toolbar.
    await seedByDispatch(page, [record('t1', 'Animation', { slots: ['core/paragraph'], hidden: true })]);
    await expect(page.locator('#toolrail-rail [data-tool="toolbar-list"]')).toBeVisible();
    expect(await page.evaluate(() => window.toolrail.unpinBlock('core/paragraph', 'main'))).toBe(true);
    expect(await page.evaluate(() => [window.toolrail.isPinned('core/paragraph'), window.toolrail.isPinned('core/paragraph', 't1')])).toEqual([false, true]);

    // The block menu offers "Pin to toolbar", and pins to the first toolbar.
    await page.locator('.block-editor-block-toolbar button[aria-label="Options"]').click();
    await page.locator('.components-menu-item__button, .components-menu-item__item', { hasText: 'Pin to toolbar' }).first().click();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveCount(1);
    expect(await page.evaluate(() => window.toolrail.isPinned('core/paragraph', 't1'))).toBe(true);

    const r = await page.evaluate(() => {
      const tr = window.toolrail;
      const out = {};
      // No id: shown toolbars only. The hidden toolbar keeps its pin.
      out.unpin = tr.unpinBlock('core/paragraph');
      out.after = [tr.isPinned('core/paragraph'), tr.isPinned('core/paragraph', 'main'), tr.isPinned('core/paragraph', 't1')];
      out.pinNoId = tr.pinBlock('core/paragraph');
      out.onMain = tr.isPinned('core/paragraph', 'main');
      // With an id, the call acts on the hidden toolbar.
      out.unpinHidden = tr.unpinBlock('core/paragraph', 't1');
      out.hiddenAfter = tr.isPinned('core/paragraph', 't1');
      return out;
    });
    expect(r).toEqual({
      unpin: true,
      after: [false, false, true],
      pinNoId: true,
      onMain: true,
      unpinHidden: true,
      hiddenAfter: false,
    });
  });
});

test.describe('PR #126 review fixes (#95)', () => {
  test('a save for one toolbar keeps another toolbar\'s stored offsets, not its clamp', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await openNewPost(page);
    await seedByDispatch(page, [
      record('t1', 'Wide away', { dock: 'float', x: 1800, y: 60 }),
      record('t2', 'Other'),
    ]);
    await expect(page.locator('#toolrail-region-t1')).toBeVisible();
    // The narrow window clamps t1 where it is painted.
    expect((await page.evaluate(() => window.toolrail.getPosition('t1'))).x).toBeLessThan(1800);
    // A change to t2 writes the list.
    expect(await page.evaluate(() => window.toolrail.setDock('right', 't2'))).toBe(true);
    const stored = JSON.parse(await getPref(page, 'toolrail-toolbars')).toolbars;
    expect(stored[0].x).toBe(1800);
    expect(stored[0].y).toBe(60);
  });

  test('deleting a toolbar drops a left-out record with the same id', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [
      record('t1', 'A'), record('t2', 'B'), record('t1', 'Old copy', { slots: ['core/verse'] }),
    ]);
    await expect(page.locator('#toolrail-region-t2')).toBeVisible();
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-toolbar').selectOption('t1');
    await page.locator('.toolrail-settings-deletetoolbar').click();
    await expect(page.locator('#toolrail-region-t1')).toHaveCount(0);
    const stored = JSON.parse(await getPref(page, 'toolrail-toolbars')).toolbars;
    expect(stored.map((r) => r.id)).toEqual(['t2']);
  });

  test('a stored change of offsets alone fires the events after the new box is painted', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Palette', { dock: 'float', x: 100, y: 60 })]);
    await expect(page.locator('#toolrail-region-t1')).toBeVisible();
    const seen = await page.evaluate(() => new Promise((resolve) => {
      const body = document.querySelector('.interface-interface-skeleton__body').getBoundingClientRect();
      window.addEventListener('toolrail:toolbars-changed', (e) => {
        const r = document.getElementById('toolrail-region-t1').getBoundingClientRect();
        resolve({ change: e.detail.change, left: Math.round(r.left - body.left) });
      }, { once: true });
      window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-toolbars', JSON.stringify({ version: 1, toolbars: [
        { id: 't1', name: 'Palette', dock: 'float', x: 300, y: 200, slots: ['core/quote'], wide: false, hidden: false },
      ] }));
      setTimeout(() => resolve(null), 2000);
    }));
    expect(seen).toEqual({ change: 'synced', left: 300 });
  });

  test('a stored change closes an open Toolbars menu, and focus stays on its button', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation')]);
    const button = page.locator('#toolrail-rail [data-tool="toolbar-list"]');
    await button.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.toolrail-flyout[aria-label="Toolbars"]')).toBeVisible();
    await seedByDispatch(page, [record('t1', 'Animation', { hidden: true })]);
    await expect(page.locator('.toolrail-flyout[aria-label="Toolbars"]')).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test('Toolbar settings stays in the window when four wide toolbars fill it', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 800 });
    await openNewPost(page);
    await seedByDispatch(page, [
      record('t1', 'A', { wide: true }), record('t2', 'B', { wide: true }), record('t3', 'C', { wide: true }),
    ]);
    await expect(page.locator('#toolrail-region-t3')).toBeVisible();
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    // The fourth wide toolbar: the first one, from the dialog itself.
    await page.locator('#toolrail-settings-wide').check();
    await expect(page.locator('#toolrail-region')).toHaveAttribute('data-wide', 'true');
    // Open it again, so it is placed from scratch past the full stack.
    await page.keyboard.press('Escape');
    await expect(page.locator('.toolrail-settings')).toHaveCount(0);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await expect(page.locator('.toolrail-settings')).toBeVisible();
    const r = await page.evaluate(() => {
      const d = document.querySelector('.toolrail-settings').getBoundingClientRect();
      return { left: d.left, right: d.right, width: window.innerWidth };
    });
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.right).toBeLessThanOrEqual(r.width);
  });

  test('the snap preview for a second top toolbar sits right under the first', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => window.toolrail.setDock('top'));
    await seedByDispatch(page, [record('t1', 'Palette', { dock: 'float', x: 300, y: 300 })]);
    await expect(page.locator('#toolrail-region-t1')).toBeVisible();
    const r = await page.evaluate(() => {
      const grip = document.querySelector('#toolrail-region-t1 .toolrail-grip');
      const g = grip.getBoundingClientRect();
      const body = document.querySelector('.interface-interface-skeleton__body').getBoundingClientRect();
      const main = document.getElementById('toolrail-region').getBoundingClientRect();
      const fire = (el, type, x, y) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      fire(grip, 'mousedown', g.left + 4, g.top + 4);
      fire(document, 'mousemove', 400, Math.round(body.top) + 10);
      const preview = document.getElementById('toolrail-snap-preview').getBoundingClientRect();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return { previewTop: preview.top, mainBottom: main.bottom };
    });
    expect(r.previewTop).toBeCloseTo(r.mainBottom, 0);
  });

  test('ArrowRight opens the flyout of the focused toolbar\'s own button', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      window.toolrail.registerTool({ id: 'core/quote', label: 'Provider quote', insertBlock: 'core/quote' });
      window.toolrail.registerTool({ id: 'spec:under-quote', label: 'Under quote', parent: 'core/quote', insertBlock: 'core/quote' });
      window.toolrail.pinBlock('core/quote', 'main');
    });
    await seedByDispatch(page, [record('t1', 'Animation', { slots: ['core/quote'] })]);
    const pin = page.locator('#toolrail-rail-t1 [data-tool="pin:core/quote"]');
    await expect(pin).toHaveAttribute('aria-haspopup', 'true');
    await pin.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#toolrail-region-t1 .toolrail-flyout [data-tool="spec:under-quote"]')).toBeFocused();
  });

  test('a rebuild of a different toolbar keeps a tool drag from being dropped on a third toolbar', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'One', { slots: ['core/quote'] }), record('t2', 'Two', { slots: [] })]);
    await expect(page.locator('#toolrail-region-t2')).toBeVisible();
    const accepted = await page.evaluate(() => {
      const dt = new DataTransfer();
      const source = document.querySelector('#toolrail-rail-t1 [data-tool="pin:core/quote"]');
      source.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const region = document.getElementById('toolrail-region-t2');
      // The rail's own answer is the drop-target mark. defaultPrevented
      // is not: the editor's own drop zones prevent every dragover that
      // bubbles to them.
      const overAt = () => {
        region.classList.remove('is-drop-target');
        region.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
        return region.classList.contains('is-drop-target');
      };
      // Control: the drag is the rail's own, so t2 refuses it.
      const before = overAt();
      // A rebuild of the FIRST toolbar while the drag is in flight.
      window.toolrail.unpinBlock('core/heading', 'main');
      return { before, after: overAt(), types: Array.from(dt.types) };
    });
    expect(accepted).toEqual({ before: false, after: false, types: ['wp-blocks'] });
  });
});

test.describe('show and hide a toolbar (#95)', () => {
  test('the Toolbars menu hides and shows a toolbar by keyboard, announced, and focus returns', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation')]);
    const button = page.locator('#toolrail-rail [data-tool="toolbar-list"]');
    await expect(button).toHaveAttribute('aria-label', 'Toolbars');
    const leftBefore = await page.evaluate(() => window.toolrail.getCanvasGeometry().frameRect.left);

    await button.focus();
    await page.keyboard.press('ArrowRight');
    const item = page.locator('.toolrail-flyout[aria-label="Toolbars"] [role="menuitemcheckbox"]').first();
    await expect(item).toBeFocused();
    await expect(item).toHaveText('Animation');
    await expect(item).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Enter');

    await expect(page.locator('#toolrail-region-t1')).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect.poll(() => liveText(page)).toContain('The Animation toolbar is hidden.');
    // The canvas gets the room back.
    await expect.poll(() => page.evaluate(() => window.toolrail.getCanvasGeometry().frameRect.left)).toBeLessThan(leftBefore);
    expect(await page.evaluate(() => window.toolrail.getToolbars()[1].hidden)).toBe(true);

    await page.keyboard.press('ArrowRight');
    await expect(item).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Enter');
    await expect(page.locator('#toolrail-region-t1')).toBeVisible();
    await expect(button).toBeFocused();
    await expect.poll(() => liveText(page)).toContain('The Animation toolbar is shown.');
    await expect.poll(() => page.evaluate(() => window.toolrail.getCanvasGeometry().frameRect.left)).toBeCloseTo(leftBefore, 0);
  });

  test('the checkbox in Toolbar settings hides and shows the chosen toolbar', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation')]);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-toolbar').selectOption('t1');
    const shown = page.locator('#toolrail-settings-toolbarshown');
    await expect(shown).toBeChecked();
    await shown.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#toolrail-region-t1')).toHaveCount(0);
    await expect(shown).not.toBeChecked();
    await expect(shown).toBeFocused();
    await expect.poll(() => liveText(page)).toContain('The Animation toolbar is hidden.');
    await expect(page.locator('#toolrail-settings-toolbar option[value="t1"]')).toHaveText('Animation (hidden)');
    await page.keyboard.press('Space');
    await expect(page.locator('#toolrail-region-t1')).toBeVisible();
  });

  test('a hidden toolbar stays hidden after a reload', async ({ page }) => {
    await openNewPost(page);
    await seedByServer(page, {
      'toolrail-toolbars': JSON.stringify({ version: 1, toolbars: [record('t1', 'Animation', { hidden: true })] }),
    });
    await expect(page.locator('#toolrail-rail [data-tool="toolbar-list"]')).toBeVisible();
    await expect(page.locator('#toolrail-region-t1')).toHaveCount(0);
  });

  test('hiding the toolbar that shows the armed tool disarms, and says so', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation', { slots: ['core/quote'] })]);
    await page.locator('#toolrail-rail-t1 [data-tool="pin:core/quote"]').click();
    expect(await page.evaluate(() => window.toolrail.getActiveTool())).toBe('pin:core/quote');

    await page.locator('#toolrail-rail [data-tool="toolbar-list"]').click();
    await page.locator('.toolrail-flyout[aria-label="Toolbars"] [role="menuitemcheckbox"]').first().click();
    await expect(page.locator('#toolrail-region-t1')).toHaveCount(0);
    expect(await page.evaluate(() => window.toolrail.getActiveTool())).toBe('select');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
    // ONE message with both facts: a second speak() in the same task
    // replaces the first, so two calls lost the disarm (review
    // 2026-11-16, finding 2).
    await expect.poll(() => liveText(page)).toBe('The Animation toolbar is hidden. Tool disarmed. Select is active.');
  });

  test('deleting the toolbar that shows the armed tool disarms, and the status says both', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation', { slots: ['core/quote'] })]);
    await page.locator('#toolrail-rail-t1 [data-tool="pin:core/quote"]').click();
    expect(await page.evaluate(() => window.toolrail.getActiveTool())).toBe('pin:core/quote');

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-toolbar').selectOption('t1');
    await page.locator('.toolrail-settings-deletetoolbar').click();
    await expect(page.locator('#toolrail-region-t1')).toHaveCount(0);
    expect(await page.evaluate(() => window.toolrail.getActiveTool())).toBe('select');
    const message = 'Deleted the Animation toolbar and its 1 pinned tool. Tool disarmed. Select is active.';
    await expect(page.locator('#toolrail-settings-toolbars-status')).toHaveText(message);
    await expect.poll(() => liveText(page)).toBe(message);
  });

  test('a checkbox hides the Toolbars button', async ({ page }) => {
    await openNewPost(page);
    await seedByDispatch(page, [record('t1', 'Animation')]);
    const button = page.locator('#toolrail-rail [data-tool="toolbar-list"]');
    await expect(button).toBeVisible();
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-toolbarsbutton').uncheck();
    await expect(button).toHaveCount(0);
    expect(await getPref(page, 'toolrail-toolbars-button-hidden')).toBe('1');
    await page.locator('#toolrail-settings-toolbarsbutton').check();
    await expect(button).toBeVisible();
  });
});
