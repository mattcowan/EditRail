/**
 * EditRail — pattern pins spec.
 *
 * Pattern pins, and drag and drop between the toolbar, the inserter and
 * the canvas.
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const {
  AUTH,
  openNewPost,
  canvas,
  clickBelowContent,
  waitForPatternCatalog,
  getPref,
  blockNames,
} = require('./helpers');

test.use({ storageState: AUTH });

test.describe('pattern pins and drag (0.1.23)', () => {
  /**
   * A registered pattern this site can insert at the root, and that a
   * drop would recognize as a pattern (several top-level blocks, or one
   * with children): every top-level block registered and allowed at the
   * root, at most three of them. Null when the site offers none.
   */
  async function usablePattern(page) {
    return page.evaluate(async () => {
      const all = await window.wp.data.resolveSelect('core').getBlockPatterns();
      const { parse, getBlockType } = window.wp.blocks;
      const sel = window.wp.data.select('core/block-editor');
      for (const p of all) {
        if (p.inserter === false || typeof p.content !== 'string') continue;
        const blocks = parse(p.content).filter((b) => b.name);
        if (!blocks.length || blocks.length > 3) continue;
        if (blocks.length === 1 && !blocks[0].innerBlocks.length) continue;
        if (!blocks.every((b) => getBlockType(b.name) && sel.canInsertBlockType(b.name, ''))) continue;
        return { name: p.name, title: p.title, content: p.content, topLevel: blocks.map((b) => b.name) };
      }
      return null;
    });
  }

  /** Drop a 'wp-blocks' payload on the rail, the way the browser would. */
  const dropOnRail = (page, payload) => page.evaluate((data) => {
    const dt = new DataTransfer();
    dt.setData('wp-blocks', JSON.stringify(data));
    const region = document.getElementById('toolrail-region');
    region.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    region.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, payload);

  test('a registered pattern is found in the settings search, pinned, armed and inserted, then unpinned', async ({ page }) => {
    await openNewPost(page);
    const pattern = await usablePattern(page);
    test.skip(!pattern, 'this site registers no pattern the root can take');
    const slot = 'pattern:' + pattern.name;

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-search').fill(pattern.title);
    const result = page.locator(`.toolrail-settings-result[data-pattern="${slot}"]`);
    await expect(result).toBeVisible();
    await expect(result.locator('.toolrail-settings-tag')).toHaveText('Pattern');
    await result.click();

    // Listed under Pinned tools with its kind, and on the rail.
    const row = page.locator(`.toolrail-settings-pinnedrow[data-block="${slot}"]`);
    await expect(row.locator('.toolrail-settings-pinnedname')).toHaveText(pattern.title);
    await expect(row.locator('.toolrail-settings-tag')).toHaveText('Pattern');
    await page.keyboard.press('Escape');
    const tool = page.locator(`#toolrail-rail [data-tool="pin:${slot}"]`);
    await expect(tool).toBeVisible();
    await expect(tool).toHaveAttribute('aria-label', `${pattern.title} (pinned pattern)`);

    // Arm + click: the pattern's own top-level blocks, nothing else.
    await tool.click();
    await clickBelowContent(page);
    await expect.poll(async () => await blockNames(page)).toEqual(pattern.topLevel);
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');

    // Stored like any pin; unpins like any pin.
    expect(JSON.parse(await getPref(page, 'toolrail-quick-slots'))).toContain(slot);
    await page.evaluate((s) => window.toolrail.unpinBlock(s), slot);
    await expect(tool).toHaveCount(0);
  });

  test('a pattern dragged from the inserter (its blocks, no name) pins the pattern, not its first block type', async ({ page }) => {
    await openNewPost(page);
    const pattern = await usablePattern(page);
    test.skip(!pattern, 'this site registers no pattern the root can take');

    // Core's inserter payload for a pattern is {type: 'inserter', blocks}
    // and nothing else (verified in this WordPress), so the rail has to
    // recognize it by content.
    await page.evaluate((content) => {
      const dt = new DataTransfer();
      dt.setData('wp-blocks', JSON.stringify({ type: 'inserter', blocks: window.wp.blocks.parse(content) }));
      const region = document.getElementById('toolrail-region');
      region.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, pattern.content);

    await expect(page.locator(`#toolrail-rail [data-tool="pin:pattern:${pattern.name}"]`)).toBeVisible();
    await expect(page.locator(`#toolrail-rail [data-tool="pin:${pattern.topLevel[0]}"]`)).toHaveCount(
      ['core/paragraph', 'core/heading', 'core/image', 'core/group'].includes(pattern.topLevel[0]) ? 1 : 0
    );
    await page.evaluate((s) => window.toolrail.unpinBlock(s), 'pattern:' + pattern.name);
  });

  test('a tool dragged from the toolbar into the canvas inserts on drop and arms nothing', async ({ page, browserName }) => {
    // Playwright cannot drag from the page into the canvas iframe in
    // these browsers: Firefox fires no dragstart, and WebKit drops
    // without the page's 'wp-blocks' data. Core's own inserter, dragged
    // the same way, inserts nothing there either (PR #63, 2026-10-14).
    // The rail and core read the same 'wp-blocks' payload in every
    // browser, so Chromium covers it.
    test.skip(browserName !== 'chromium', 'Playwright cannot drag into the canvas iframe in this browser');
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([createBlock('core/paragraph', { content: 'ANCHOR' })]);
    });
    await expect.poll(async () => await blockNames(page)).toEqual(['core/paragraph']);

    const tool = page.locator('#toolrail-rail [data-tool="pin:core/heading"]');
    await expect(tool).toHaveAttribute('draggable', 'true');
    const target = canvas(page).locator('[data-type="core/paragraph"]').first();
    const box = await target.boundingBox();
    // The lower half of the paragraph: core's drop zone puts the block
    // after it. Core owns the drop; the rail only supplied the payload.
    await tool.dragTo(target, {
      targetPosition: { x: Math.round(box.width / 2), y: Math.round(box.height * 0.8) },
    });

    await expect.poll(async () => await blockNames(page)).toEqual(['core/paragraph', 'core/heading']);
    await expect(tool).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a block dropped from the canvas onto the toolbar offers to pin its type', async ({ page }) => {
    await openNewPost(page);
    const quoteId = await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      const q = createBlock('core/quote', {}, [createBlock('core/paragraph', { content: 'Q' })]);
      window.wp.data.dispatch('core/block-editor').resetBlocks([q]);
      return q.clientId;
    });
    // A block dragged from the canvas leaves focus in the canvas, and the
    // dialog's focus() must still take (#74: one browser engine ignored it).
    await canvas(page).locator('[data-type="core/quote"] p').click();
    expect(await page.evaluate(() => document.activeElement && document.activeElement.tagName)).toBe('IFRAME');
    await dropOnRail(page, { type: 'block', srcClientIds: [quoteId], srcRootClientId: '' });

    const dialog = page.locator('.toolrail-adddialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog.locator('#toolrail-adddialog-title')).toHaveText('Add to toolbar');
    await expect(dialog.locator('#toolrail-adddialog-name')).toHaveValue('Quote');
    await expect(dialog.locator('#toolrail-adddialog-name')).toBeFocused();

    // A click on the dialog's own text keeps it open: the dialog takes the
    // focus, not the rail region behind it (QA 2026-10-09).
    await dialog.locator('#toolrail-adddialog-title').click();
    await expect(dialog).toBeVisible();

    await dialog.locator('.toolrail-adddialog-pintype').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/quote"]')).toBeVisible();
  });

  test('…or to save it as an unsynced pattern and pin that; the pin inserts the saved snapshot', async ({ page }) => {
    await openNewPost(page);
    const groupId = await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      const g = createBlock(
        'core/group',
        { layout: { type: 'constrained' }, style: { spacing: { padding: { top: '40px' } } } },
        [createBlock('core/paragraph', { content: 'CALLOUT' })]
      );
      window.wp.data.dispatch('core/block-editor').resetBlocks([g]);
      return g.clientId;
    });

    // Stand in for the REST save — this suite never writes site content.
    // dispatch('core') hands out one memoized actions object (verified),
    // so the rail's call at save time reaches this stub.
    await page.evaluate(() => {
      window.__savedPattern = null;
      window.wp.data.dispatch('core').saveEntityRecord = async (kind, name, record) => {
        window.__savedPattern = { kind, name, record };
        return { id: 987654, title: { raw: record.title }, content: { raw: record.content } };
      };
    });

    await dropOnRail(page, { type: 'block', srcClientIds: [groupId], srcRootClientId: '' });
    const dialog = page.locator('.toolrail-adddialog');
    // Group is a default pin: the type offer says so instead of a button.
    await expect(dialog).toContainText('The Group block type is already pinned.');
    await expect(dialog.locator('.toolrail-adddialog-pintype')).toHaveCount(0);

    await dialog.locator('#toolrail-adddialog-name').fill('Callout');
    await dialog.locator('.toolrail-adddialog-savepattern').click();
    await expect(dialog).toHaveCount(0);

    const saved = await page.evaluate(() => window.__savedPattern);
    expect(saved.kind).toBe('postType');
    expect(saved.name).toBe('wp_block');
    expect(saved.record.title).toBe('Callout');
    expect(saved.record.status).toBe('publish');
    expect(saved.record.meta).toEqual({ wp_pattern_sync_status: 'unsynced' });
    expect(saved.record.content).toContain('<!-- wp:group');
    expect(saved.record.content).toContain('CALLOUT');

    const tool = page.locator('#toolrail-rail [data-tool="pin:pattern:user:987654"]');
    await expect(tool).toBeVisible();
    await expect(tool).toHaveAttribute('aria-label', 'Callout (pinned pattern)');

    // The pin inserts the snapshot: the configured Group, paragraph and all.
    await tool.click();
    await clickBelowContent(page);
    await expect.poll(async () => await blockNames(page)).toEqual(['core/group', 'core/group']);
    const copy = await page.evaluate(() => {
      const b = window.wp.data.select('core/block-editor').getBlocks()[1];
      return {
        layout: b.attributes.layout,
        padding: b.attributes.style.spacing.padding.top,
        inner: b.innerBlocks.map((i) => String(i.attributes.content)),
      };
    });
    expect(copy).toEqual({ layout: { type: 'constrained' }, padding: '40px', inner: ['CALLOUT'] });

    await page.evaluate(() => window.toolrail.unpinBlock('pattern:user:987654'));
  });

  test('"Save as pattern and pin to toolbar…" in the block menu opens the same dialog by keyboard', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').click();
    await clickBelowContent(page);
    await canvas(page).locator('[data-block]').last().click();
    await page.keyboard.type('Save me');
    await page.keyboard.press('Escape');

    await page.locator('.block-editor-block-toolbar button[aria-label="Options"]').click();
    await page.locator('.components-menu-item__button, .components-menu-item__item', { hasText: 'Save as pattern and pin to toolbar' }).first().click();

    const dialog = page.locator('.toolrail-adddialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#toolrail-adddialog-name')).toBeFocused();
    await expect(dialog.locator('#toolrail-adddialog-name')).toHaveValue('Paragraph');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('a set file may carry pattern pins; one this site lacks is kept and counted as unavailable', async ({ page }) => {
    await openNewPost(page);
    await waitForPatternCatalog(page);
    const result = await page.evaluate(() => window.toolrail.importConfig({
      format: 'toolrail-set',
      version: 1,
      name: 'with patterns',
      blocks: ['core/quote', 'pattern:user:424242', 'pattern:some-theme/hero', 'pattern:bad name'],
    }));
    expect(result.ok).toBe(true);
    expect(result.total).toBe(3);
    expect(result.dropped).toBe(1);
    expect(result.missing).toBe(2);
    await page.evaluate(() => window.toolrail.deleteConfig('with patterns'));
  });
});

test.describe('review 2026-09-03 follow-ups (patterns and drag)', () => {
  const dropOnRail = (page, payload) => page.evaluate((data) => {
    const dt = new DataTransfer();
    dt.setData('wp-blocks', JSON.stringify(data));
    const region = document.getElementById('toolrail-region');
    region.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    region.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, payload);

  async function seedQuote(page) {
    return page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      const q = createBlock('core/quote', {}, [createBlock('core/paragraph', { content: 'Q' })]);
      window.wp.data.dispatch('core/block-editor').resetBlocks([q]);
      return q.clientId;
    });
  }

  test('the Add to toolbar dialog renders in front of the Document Overview panel (finding 1)', async ({ page }) => {
    await openNewPost(page);
    const listView = page.locator('button[aria-label="Document Overview"]');
    test.skip(!(await listView.count()), 'no Document Overview button in this editor');
    await listView.click();
    await expect(page.locator('.interface-interface-skeleton__secondary-sidebar')).toBeVisible();

    const quoteId = await seedQuote(page);
    await dropOnRail(page, { type: 'block', srcClientIds: [quoteId], srcRootClientId: '' });
    await expect(page.locator('.toolrail-adddialog')).toBeVisible();
    await expect(page.locator('#toolrail-region')).toHaveClass(/is-raised/);

    // Assert the STACKING, as the settings-dialog test does: the topmost
    // element at the dialog's own point must be the dialog.
    const result = await page.evaluate(() => {
      const dlg = document.querySelector('.toolrail-adddialog');
      const sec = document.querySelector('.interface-interface-skeleton__secondary-sidebar');
      const d = dlg.getBoundingClientRect();
      const s = sec.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(d.left + d.width / 2), Math.round(d.top + 40));
      return {
        overlaps: !(d.right <= s.left || d.left >= s.right),
        topmostIsDialog: !!(hit && dlg.contains(hit)),
      };
    });
    expect(result.overlaps).toBe(true);
    expect(result.topmostIsDialog).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator('.toolrail-adddialog')).toHaveCount(0);
    await expect(page.locator('#toolrail-region')).not.toHaveClass(/is-raised/);
    // Put the panel back: its open state persists on the server.
    await listView.click();
    await expect(page.locator('.interface-interface-skeleton__secondary-sidebar')).toHaveCount(0);
  });

  test('a single-block pattern dropped from the inserter pins the pattern, not the block type (finding 2)', async ({ page }) => {
    await openNewPost(page);
    // A registered pattern that is exactly one top-level block with no
    // children — the shape that drags like a plain block type. SEEDED,
    // not hunted: most core and theme patterns are Group or Columns
    // wrappers, and a catalog hunt let this test skip itself green
    // (review 2026-09-03, second round, finding 4). select('core') hands
    // out one memoized selectors object, so the rail's catalog read sees
    // the fixture appended to the real list.
    const pattern = {
      name: 'e2e/styled-heading',
      type: 'core/heading',
      content: '<!-- wp:heading {"level":3,"style":{"typography":{"letterSpacing":"3px"}}} --><h3 class="wp-block-heading" style="letter-spacing:3px">E2E STYLED</h3><!-- /wp:heading -->',
    };
    await page.evaluate(async (fx) => {
      const real = await window.wp.data.resolveSelect('core').getBlockPatterns();
      const sel = window.wp.data.select('core');
      window.__realGetBlockPatterns = sel.getBlockPatterns;
      const list = real.concat([{ name: fx.name, title: 'E2E styled heading', content: fx.content, inserter: true }]);
      sel.getBlockPatterns = () => list;
    }, pattern);

    const typeWasPinned = await page.evaluate((t) => window.toolrail.isPinned(t), pattern.type);
    await page.evaluate((content) => {
      const dt = new DataTransfer();
      dt.setData('wp-blocks', JSON.stringify({ type: 'inserter', blocks: window.wp.blocks.parse(content) }));
      document.getElementById('toolrail-region').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, pattern.content);

    await expect(page.locator(`#toolrail-rail [data-tool="pin:pattern:${pattern.name}"]`)).toBeVisible();
    // The block type was NOT pinned by the drop (unless it already was).
    expect(await page.evaluate((t) => window.toolrail.isPinned(t), pattern.type)).toBe(typeWasPinned);
    await page.evaluate((s) => window.toolrail.unpinBlock(s), 'pattern:' + pattern.name);
    await page.evaluate(() => { window.wp.data.select('core').getBlockPatterns = window.__realGetBlockPatterns; });
  });

  test('a user pattern edited to the same byte length is matched by its new content, not a stale parse (second round, finding 2)', async ({ page }) => {
    await openNewPost(page);
    // Two contents of identical length: an h2 and an h3.
    const v1 = '<!-- wp:heading --><h2 class="wp-block-heading">SAME LEN</h2><!-- /wp:heading -->';
    const v2 = '<!-- wp:heading {"level":3} --><h3 class="wp-block-heading">SAME LEN</h3><!-- /wp:heading -->';
    const seed = (page2, content) => page2.evaluate((c) => {
      const sel = window.wp.data.select('core');
      if (!window.__realGetEntityRecords) {
        window.__realGetEntityRecords = sel.getEntityRecords;
      }
      const record = { id: 777001, title: { raw: 'Same length' }, content: { raw: c }, wp_pattern_sync_status: 'unsynced' };
      sel.getEntityRecords = (kind, name, query) => (
        kind === 'postType' && name === 'wp_block' ? [record] : window.__realGetEntityRecords(kind, name, query)
      );
    }, content);
    const dropParsed = (page2, content) => page2.evaluate((c) => {
      const dt = new DataTransfer();
      dt.setData('wp-blocks', JSON.stringify({ type: 'inserter', blocks: window.wp.blocks.parse(c) }));
      document.getElementById('toolrail-region').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, content);

    await seed(page, v1);
    await dropParsed(page, v1);
    await expect(page.locator('#toolrail-rail [data-tool="pin:pattern:user:777001"]')).toBeVisible();
    await page.evaluate(() => window.toolrail.unpinBlock('pattern:user:777001'));

    // Same id, same length, new content: a length-keyed cache served
    // the h2 parse here, the match missed, and the drop pinned Heading.
    await seed(page, v2);
    await dropParsed(page, v2);
    await expect(page.locator('#toolrail-rail [data-tool="pin:pattern:user:777001"]')).toBeVisible();
    await page.evaluate(() => {
      window.toolrail.unpinBlock('pattern:user:777001');
      window.wp.data.select('core').getEntityRecords = window.__realGetEntityRecords;
    });
  });

  test('a synced pattern reference pins by its ref before the list lands; a ref-less core/block pins nothing (finding 3)', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('wp-blocks', JSON.stringify({
        type: 'inserter',
        blocks: [window.wp.blocks.createBlock('core/block', { ref: 424242 })],
      }));
      document.getElementById('toolrail-region').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    // Stored as the pattern slot (hidden until a wp_block 424242 exists
    // here), and never as a pinned "Block" type.
    await expect.poll(async () => JSON.parse(await getPref(page, 'toolrail-quick-slots'))).toContain('pattern:user:424242');
    expect(await page.evaluate(() => window.toolrail.isPinned('core/block'))).toBe(false);
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/block"]')).toHaveCount(0);

    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('wp-blocks', JSON.stringify({ type: 'inserter', blocks: [window.wp.blocks.createBlock('core/block')] }));
      document.getElementById('toolrail-region').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    expect(await page.evaluate(() => window.toolrail.isPinned('core/block'))).toBe(false);
    await page.evaluate(() => window.toolrail.unpinBlock('pattern:user:424242'));
  });

  test('an unresolved permission check is not "denied": the save form still shows; a real "no" hides it (finding 4)', async ({ page }) => {
    await openNewPost(page);
    const quoteId = await seedQuote(page);

    // select('core') hands out one memoized selectors object, so the
    // rail's read at dialog time reaches these stubs.
    await page.evaluate(() => {
      const sel = window.wp.data.select('core');
      window.__realCanUser = sel.canUser;
      sel.canUser = () => undefined;
    });
    await dropOnRail(page, { type: 'block', srcClientIds: [quoteId], srcRootClientId: '' });
    const dialog = page.locator('.toolrail-adddialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.toolrail-adddialog-savepattern')).toBeVisible();
    await expect(dialog).not.toContainText('You cannot create patterns');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await page.evaluate(() => { window.wp.data.select('core').canUser = () => false; });
    await dropOnRail(page, { type: 'block', srcClientIds: [quoteId], srcRootClientId: '' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('You cannot create patterns on this site');
    await expect(dialog.locator('.toolrail-adddialog-savepattern')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.wp.data.select('core').canUser = window.__realCanUser; });
  });

  test('pattern pins are not counted as missing while the catalog is still loading (finding 6)', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const sel = window.wp.data.select('core');
      window.__realHasFinished = sel.hasFinishedResolution;
      sel.hasFinishedResolution = () => false;
    });
    const loading = await page.evaluate(() => window.toolrail.importConfig({
      format: 'toolrail-set', version: 1, name: 'loading', blocks: ['pattern:user:5150', 'nope/nope'],
    }));
    // Only the unknown BLOCK is missing; the pattern is "not fetched yet".
    expect(loading.missing).toBe(1);

    await page.evaluate(() => { window.wp.data.select('core').hasFinishedResolution = window.__realHasFinished; });
    await waitForPatternCatalog(page);
    const loaded = await page.evaluate(() => window.toolrail.importConfig({
      format: 'toolrail-set', version: 1, name: 'loaded', blocks: ['pattern:user:5150', 'nope/nope'],
    }));
    expect(loaded.missing).toBe(2);
    await page.evaluate(() => { window.toolrail.deleteConfig('loading'); window.toolrail.deleteConfig('loaded'); });
  });

  test('a rerender mid-drag does not leave the rail refusing drops (finding 7)', async ({ page }) => {
    await openNewPost(page);
    // Start a drag from a tool (its own dragend will never fire once the
    // button is rebuilt), rebuild the rail, then end the drag the way a
    // canceled one does — and drop something on the rail.
    await page.evaluate(() => {
      const btn = document.querySelector('#toolrail-rail [data-tool="pin:core/heading"]');
      const dt = new DataTransfer();
      btn.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
      window.toolrail.pinBlock('core/quote'); // rerenders the rail
      document.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await dropOnRail(page, { type: 'inserter', blocks: [{ name: 'core/list', attributes: {}, innerBlocks: [] }] });
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/list"]')).toBeVisible();
  });

  test('a block result\'s accessible name contains its visible "Block" chip (finding 8)', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-search').fill('Quote');
    const result = page.locator('.toolrail-settings-result[data-block="core/quote"]');
    await expect(result).toHaveAttribute('aria-label', 'Pin the Quote block to the toolbar');
    await expect(result.locator('.toolrail-settings-tag')).toHaveText('Block');
  });
});
