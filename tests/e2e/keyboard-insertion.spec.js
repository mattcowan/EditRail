/**
 * EditRail — keyboard insertion spec.
 *
 * Insertion from the keyboard: Ctrl+Enter on an armed tool (#37).
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const { AUTH, openNewPost, blockNames, politeText } = require('./helpers');

test.use({ storageState: AUTH });

/**
 * Two paragraphs, "A" and "B", with A selected — a keyboard insert has a
 * known "after" to land on.
 *
 * @return {Promise<string[]>} The two clientIds, A first.
 */
async function seedTwoParagraphsSelectFirst(page) {
  return page.evaluate(() => {
    const { createBlock } = window.wp.blocks;
    const a = createBlock('core/paragraph', { content: 'A' });
    const b = createBlock('core/paragraph', { content: 'B' });
    window.wp.data.dispatch('core/block-editor').resetBlocks([a, b]);
    window.wp.data.dispatch('core/block-editor').selectBlock(a.clientId);
    return [a.clientId, b.clientId];
  });
}

/** Arm a rail tool by keyboard: focus reaches it, Enter arms it. */
async function armByKeyboard(page, toolId) {
  await page.locator('#toolrail-rail [data-tool="' + toolId + '"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#toolrail-rail [data-tool="' + toolId + '"]')).toHaveAttribute('aria-pressed', 'true');
}

test.describe('keyboard insertion (#37)', () => {
  test('Ctrl+Enter on the rail inserts after the selected block, selects it, announces it and disarms', async ({ page }) => {
    await openNewPost(page);
    const [a] = await seedTwoParagraphsSelectFirst(page);

    await armByKeyboard(page, 'pin:core/heading');
    await page.keyboard.press('Control+Enter');

    await expect.poll(async () => await blockNames(page)).toEqual(['core/paragraph', 'core/heading', 'core/paragraph']);
    const state = await page.evaluate((firstId) => {
      const sel = window.wp.data.select('core/block-editor');
      const blocks = sel.getBlocks();
      return {
        selected: sel.getSelectedBlockClientId(),
        heading: blocks[1].clientId,
        firstStill: blocks[0].clientId === firstId,
      };
    }, a);
    expect(state.selected).toBe(state.heading);
    expect(state.firstStill).toBe(true);
    await expect.poll(() => politeText(page)).toContain('Heading inserted. Select is active.');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('with no block selected, the keyboard insert goes to the end of the post', async ({ page }) => {
    await openNewPost(page);
    await seedTwoParagraphsSelectFirst(page);
    // Take the caret out of the paragraph, not only the block selection.
    // Selecting the block put the caret in it; WebKit reports that caret
    // in a late selectionchange, and core turns a caret in a block back
    // into a selected block. That re-selected the first paragraph after
    // the clear in 1 of 2 WebKit runs (PR #63, 2026-10-14). An author
    // with no block selected has no caret in one either.
    await page.evaluate(() => {
      const doc = document.querySelector('iframe[name="editor-canvas"]').contentDocument;
      doc.getSelection().removeAllRanges();
      if (doc.activeElement) {
        doc.activeElement.blur();
      }
      window.wp.data.dispatch('core/block-editor').clearSelectedBlock();
    });

    await armByKeyboard(page, 'pin:core/heading');
    expect(await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getSelectedBlockClientId()
    )).toBeNull();
    await page.keyboard.press('Control+Enter');

    await expect.poll(async () => await blockNames(page)).toEqual(['core/paragraph', 'core/paragraph', 'core/heading']);
  });

  test('Ctrl+Shift+Enter keeps the tool armed, and the key works again from the canvas', async ({ page }) => {
    await openNewPost(page);
    await seedTwoParagraphsSelectFirst(page);

    await armByKeyboard(page, 'pin:core/heading');
    await page.keyboard.press('Control+Shift+Enter');
    await expect.poll(async () => await blockNames(page)).toEqual(['core/paragraph', 'core/heading', 'core/paragraph']);
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/heading"]')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => politeText(page)).toContain('Heading inserted. The tool stays armed.');

    // Core moves focus into the new block, inside the canvas iframe. The
    // same key there inserts after it, and a plain press disarms.
    await expect.poll(() => page.evaluate(() => document.activeElement && document.activeElement.name)).toBe('editor-canvas');
    await page.keyboard.press('Control+Enter');
    await expect.poll(async () => await blockNames(page)).toEqual(['core/paragraph', 'core/heading', 'core/heading', 'core/paragraph']);
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('an extension createBlock tool inserts by keyboard only', async ({ page }) => {
    await openNewPost(page);
    await seedTwoParagraphsSelectFirst(page);
    await page.evaluate(() => {
      window.toolrail.registerTool({
        id: 'e2e-kbd-create',
        label: 'E2E Keyboard Create',
        createBlock: () => window.wp.blocks.createBlock('core/quote'),
      });
    });

    await armByKeyboard(page, 'e2e-kbd-create');
    await page.keyboard.press('Control+Enter');

    await expect.poll(async () => await blockNames(page)).toEqual(['core/paragraph', 'core/quote', 'core/paragraph']);
    await expect.poll(() => politeText(page)).toContain('Quote inserted.');
  });

  test('a flyout tool armed by keyboard keeps focus on the rail and inserts by keyboard', async ({ page }) => {
    await openNewPost(page);
    await seedTwoParagraphsSelectFirst(page);
    await page.evaluate(() => {
      window.toolrail.registerTool({
        id: 'e2e-kbd-flyout-child',
        label: 'E2E Keyboard Flyout Child',
        parent: 'text',
        insertBlock: 'core/quote',
      });
    });

    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.toolrail-flyout')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('.toolrail-flyout')).toHaveCount(0);

    // The menu that held focus is gone. Focus goes back to the button that
    // opened it, not to the page body (APG menu button).
    expect(await page.evaluate(() => document.activeElement.dataset && document.activeElement.dataset.tool)).toBe('pin:core/paragraph');

    await page.keyboard.press('Control+Enter');
    await expect.poll(async () => await blockNames(page)).toEqual(['core/paragraph', 'core/quote', 'core/paragraph']);
  });

  test('Enter on a flyout parent disarms its armed child, as the help text says', async ({ page }) => {
    await openNewPost(page);
    await seedTwoParagraphsSelectFirst(page);
    await page.evaluate(() => {
      window.toolrail.registerTool({
        id: 'e2e-kbd-flyout-disarm',
        label: 'E2E Keyboard Flyout Disarm',
        parent: 'text',
        insertBlock: 'core/quote',
      });
    });

    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    // Focus is back on the parent, which shows as pressed for its child.
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveAttribute('aria-pressed', 'true');

    // A second Enter disarms. It used to arm the parent instead, silently,
    // so the next Ctrl+Enter inserted a Paragraph, not the Quote.
    await page.keyboard.press('Enter');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => politeText(page)).toContain('Tool disarmed. Select is active.');
    await page.keyboard.press('Control+Enter');
    expect(await blockNames(page)).toEqual(['core/paragraph', 'core/paragraph']);
  });

  test('a selected empty paragraph is replaced, the way core\'s inserter does', async ({ page }) => {
    await openNewPost(page);
    const empty = await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      const a = createBlock('core/paragraph', { content: 'A' });
      const e = createBlock('core/paragraph');
      window.wp.data.dispatch('core/block-editor').resetBlocks([a, e]);
      window.wp.data.dispatch('core/block-editor').selectBlock(e.clientId);
      return e.clientId;
    });

    await armByKeyboard(page, 'pin:core/heading');
    await page.keyboard.press('Control+Enter');

    // "A, heading" — not "A, empty paragraph, heading".
    await expect.poll(async () => await blockNames(page)).toEqual(['core/paragraph', 'core/heading']);
    const state = await page.evaluate((emptyId) => {
      const sel = window.wp.data.select('core/block-editor');
      return {
        emptyGone: !sel.getBlock(emptyId),
        selectedIsHeading: sel.getSelectedBlock() && sel.getSelectedBlock().name === 'core/heading',
      };
    }, empty);
    expect(state).toEqual({ emptyGone: true, selectedIsHeading: true });
    await expect.poll(() => politeText(page)).toContain('Heading inserted. Select is active.');
  });

  test('an empty paragraph that cannot be removed is kept; the block goes after it', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      const a = createBlock('core/paragraph', { content: 'A' });
      const e = createBlock('core/paragraph', { lock: { remove: true } });
      window.wp.data.dispatch('core/block-editor').resetBlocks([a, e]);
      window.wp.data.dispatch('core/block-editor').selectBlock(e.clientId);
    });

    await armByKeyboard(page, 'pin:core/heading');
    await page.keyboard.press('Control+Enter');

    await expect.poll(async () => await blockNames(page)).toEqual(['core/paragraph', 'core/paragraph', 'core/heading']);
  });

  test('a block no parent accepts is announced and the tool stays armed', async ({ page }) => {
    await openNewPost(page);
    await seedTwoParagraphsSelectFirst(page);
    // core/column is allowed only inside core/columns, so no parent on the
    // way up from the selected paragraph accepts it.
    await page.evaluate(() => {
      window.toolrail.registerTool({
        id: 'e2e-kbd-column',
        label: 'E2E Keyboard Column',
        insertBlock: 'core/column',
      });
    });

    await armByKeyboard(page, 'e2e-kbd-column');
    await page.keyboard.press('Control+Enter');

    await expect.poll(() => page.evaluate(() =>
      window.wp.data.select('core/notices').getNotices().some((n) => n.id === 'toolrail-cannot-insert')
    )).toBe(true);
    expect(await blockNames(page)).toEqual(['core/paragraph', 'core/paragraph']);
    await expect(page.locator('#toolrail-rail [data-tool="e2e-kbd-column"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('Ctrl+Enter with Select active inserts nothing; Enter on the armed tool still disarms', async ({ page }) => {
    await openNewPost(page);
    await seedTwoParagraphsSelectFirst(page);

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').focus();
    await page.keyboard.press('Control+Enter');
    // Nothing armed, so the key is not ours and no block appears. (What
    // the browser does with it on a button is its own business; Escape
    // puts the rail back to Select either way.)
    expect(await blockNames(page)).toEqual(['core/paragraph', 'core/paragraph']);
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');

    await armByKeyboard(page, 'pin:core/heading');
    await page.keyboard.press('Enter');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await blockNames(page)).toEqual(['core/paragraph', 'core/paragraph']);
  });
});
