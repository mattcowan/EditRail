/**
 * EditRail — armed insertion spec.
 *
 * Armed-tool insertion with the pointer: where a click inserts, arming
 * and disarming, and core's inserter while a tool is armed.
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const {
  AUTH,
  openNewPost,
  canvas,
  clickBelowContent,
  getPref,
  blockNames,
  liveText,
} = require('./helpers');

test.use({ storageState: AUTH });

test.describe('armed-tool insertion', () => {
  test('arm Text, click canvas: paragraph inserted, tool returns to Select', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').click();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'false');

    await clickBelowContent(page);

    // EXACTLY one block. `toContain` used to pass here while core's own
    // "click empty space to start a paragraph" behaviour quietly added a
    // second, empty one alongside the inserted block — the assertion could
    // not tell the stray from the real insert because both were paragraphs.
    await expect.poll(async () => await blockNames(page)).toEqual(['core/paragraph']);
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveAttribute('aria-pressed', 'false');
  });

  test('Shift-click keeps the tool armed for repeat inserts', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    await clickBelowContent(page, { modifiers: ['Shift'] });
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/heading"]')).toHaveAttribute('aria-pressed', 'true');

    // Measured again: the first insert moved the bottom edge.
    await clickBelowContent(page);
    // Two headings and NOTHING else: filtering to core/heading before
    // counting used to hide any stray core added on the way.
    await expect.poll(async () => await blockNames(page)).toEqual(['core/heading', 'core/heading']);
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('Escape in the canvas disarms back to Select', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="pin:core/group"]').click();
    await canvas(page).locator('body').press('Escape');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  });
});

/**
 * Regressions found by driving the editor by hand (2026-08-26). Each test
 * here failed before its fix; the block-count assertions in
 * 'armed-tool insertion' were tightened in the same pass, because the
 * originals could not see the stray-block bug at all.
 */
test.describe('regressions', () => {
  test('an armed insert into empty space leaves no stray empty paragraph', async ({ page }) => {
    await openNewPost(page);

    // A known one-block document, so the count after the click is exact.
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data
        .dispatch('core/block-editor')
        .resetBlocks([createBlock('core/paragraph', { content: 'ALPHA' })]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(1);

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    await clickBelowContent(page, { gap: 120 });

    // Before the fix: ['core/paragraph', 'core/paragraph', 'core/heading'].
    // Core appends its default block on a click below the content, and the
    // preventDefault/stopPropagation in handleCanvasClick does not stop it.
    await expect.poll(async () => await blockNames(page)).toEqual([
      'core/paragraph',
      'core/heading',
    ]);
  });

  test('an insert ON an existing block still lands at the click point', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/paragraph', { content: 'ALPHA' }),
        createBlock('core/paragraph', { content: 'BETA' }),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(2);

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    // Top half of BETA inserts before it. The stray sweep must not disturb
    // a click that landed on a real block.
    await canvas(page).locator('p:has-text("BETA")').click({ position: { x: 20, y: 3 } });

    await expect.poll(async () => await blockNames(page)).toEqual([
      'core/paragraph',
      'core/heading',
      'core/paragraph',
    ]);
  });

  test('rapid repeat inserts are not swept away by a stale pass', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data
        .dispatch('core/block-editor')
        .resetBlocks([createBlock('core/paragraph', { content: 'ALPHA' })]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(1);

    // Paragraph is the DEFAULT block type, so every block this inserts is
    // an unmodified default paragraph — indistinguishable, by shape alone,
    // from the stray the sweep exists to remove. Two inserts inside the
    // 80ms backstop window is the shift-click-to-repeat workflow, and the
    // first click's delayed pass used to run against a knownIds snapshot
    // that predated the second block and delete it.
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').click();
    await page.evaluate(async () => {
      const doc = document.querySelector('iframe[name="editor-canvas"]').contentDocument;
      const fire = (shift) => {
        const opts = {
          bubbles: true,
          cancelable: true,
          clientX: 300,
          clientY: 500,
          view: doc.defaultView,
          button: 0,
          shiftKey: shift,
        };
        doc.body.dispatchEvent(new PointerEvent('pointerdown', opts));
        doc.body.dispatchEvent(new MouseEvent('click', opts));
      };
      fire(true); // keeps the tool armed
      await new Promise((r) => setTimeout(r, 30)); // inside the 80ms window
      fire(false);
    });

    // Wait past both sweep passes before judging.
    await page.waitForTimeout(400);
    expect(await blockNames(page)).toEqual([
      'core/paragraph',
      'core/paragraph',
      'core/paragraph',
    ]);
  });

  test('a later gesture invalidates a pending sweep', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data
        .dispatch('core/block-editor')
        .resetBlocks([createBlock('core/paragraph', { content: 'ALPHA' })]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(1);

    // Arm a tool, insert, then start a NEW gesture and create an unmodified
    // default paragraph inside the 80ms backstop window. Under Select that
    // paragraph is core's click-to-write, which is the author's intent — a
    // pending pass from the armed click must not reach it.
    //
    // Asserted by clientId rather than by block count: the block is an
    // unmodified default paragraph (the only shape the sweep can mistake
    // for a stray), so counting paragraphs is ambiguous, and whatever else
    // the editor does to the document is irrelevant to the question.
    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    const survivorId = await page.evaluate(async () => {
      const doc = document.querySelector('iframe[name="editor-canvas"]').contentDocument;
      const opts = {
        bubbles: true,
        cancelable: true,
        clientX: 300,
        clientY: 500,
        view: doc.defaultView,
        button: 0,
      };
      doc.body.dispatchEvent(new PointerEvent('pointerdown', opts));
      doc.body.dispatchEvent(new MouseEvent('click', opts));

      await new Promise((r) => setTimeout(r, 30));

      // A fresh gesture. This bumps the generation, retiring the armed
      // click's pending passes.
      doc.body.dispatchEvent(new PointerEvent('pointerdown', opts));
      const { createBlock } = window.wp.blocks;
      const block = createBlock('core/paragraph');
      window.wp.data.dispatch('core/block-editor').insertBlocks(block);
      return block.clientId;
    });

    // Past both sweep passes.
    await page.waitForTimeout(400);
    const survived = await page.evaluate(
      (id) => !!window.wp.data.select('core/block-editor').getBlock(id),
      survivorId
    );
    expect(survived).toBe(true);
  });
});

test.describe('core inserter while a tool is armed', () => {
  async function seedTwoParagraphs(page) {
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/paragraph', { content: 'FIRST' }),
        createBlock('core/paragraph', { content: 'SECOND' }),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(2);
  }

  /** The midpoint of the gap between the first two root blocks, in
      canvas-viewport coordinates. */
  async function gapBetweenFirstTwo(page) {
    return canvas(page).locator('body').evaluate(() => {
      const blocks = document.querySelectorAll('.is-root-container > [data-block]');
      const a = blocks[0].getBoundingClientRect();
      const b = blocks[1].getBoundingClientRect();
      return { x: (a.left + a.right) / 2, y: (a.bottom + b.top) / 2 };
    });
  }

  /** Hover that gap until core raises its between-block "+" popover
      (it shows on mousemove over the gap, in the EDITOR document). */
  async function hoverGap(page) {
    const gap = await gapBetweenFirstTwo(page);
    const frame = await page.locator('iframe[name="editor-canvas"]').boundingBox();
    await page.mouse.move(frame.x + gap.x, frame.y + gap.y - 3);
    await page.mouse.move(frame.x + gap.x, frame.y + gap.y);
    await page.mouse.move(frame.x + gap.x + 2, frame.y + gap.y);
  }

  test('the between-block "+" is hidden while a tool is armed, and back when disarmed', async ({ page }) => {
    await openNewPost(page);
    await seedTwoParagraphs(page);

    const plus = page.locator('.block-editor-block-popover__inbetween .block-editor-block-list__insertion-point.is-with-inserter');
    // Control: with nothing armed, hovering the gap raises core's "+".
    await hoverGap(page);
    await expect(plus).toBeVisible({ timeout: 5000 });

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    await expect(page.locator('body')).toHaveClass(/toolrail-hides-inserter/);
    await hoverGap(page);
    await expect(plus).toBeHidden();

    // Only the "+" goes. The same popover shell carries the drop line a
    // drag shows — an insertion point WITHOUT the inserter option, which
    // is exactly what core's drop zone dispatches — and that must
    // survive arming (review 2026-09-02, finding 4).
    await page.evaluate(() => window.wp.data.dispatch('core/block-editor').showInsertionPoint('', 1));
    const line = page.locator('.block-editor-block-popover__inbetween .block-editor-block-list__insertion-point:not(.is-with-inserter)');
    await expect(line).toBeVisible({ timeout: 5000 });
    await page.evaluate(() => window.wp.data.dispatch('core/block-editor').hideInsertionPoint());

    await canvas(page).locator('body').press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/toolrail-hides-inserter/);
  });

  test('the Toolbar settings checkbox turns the hiding off and on', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    const box = page.locator('#toolrail-settings-hideinserter');
    await expect(box).toBeChecked(); // on by default
    await box.uncheck();
    await expect.poll(async () => await getPref(page, 'toolrail-hide-core-inserter')).toBe('0');
    await page.keyboard.press('Escape');

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    await expect(page.locator('body')).not.toHaveClass(/toolrail-hides-inserter/);
    await canvas(page).locator('body').press('Escape');

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await box.check();
    await page.keyboard.press('Escape');
    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    await expect(page.locator('body')).toHaveClass(/toolrail-hides-inserter/);
  });

  test('an armed click in the gap between two blocks inserts between them, not at the end', async ({ page }) => {
    await openNewPost(page);
    await seedTwoParagraphs(page);

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    const gap = await gapBetweenFirstTwo(page);

    // Guard the guard: the point is on the block list and on neither
    // block — the case that used to fall through to "append at end".
    const hit = await canvas(page).locator('body').evaluate((body, g) => {
      const el = body.ownerDocument.elementFromPoint(g.x, g.y);
      return {
        onBlock: !!el.closest('[data-block]'),
        onList: !!el.closest('.block-editor-block-list__layout'),
      };
    }, gap);
    expect(hit).toEqual({ onBlock: false, onList: true });

    const bodyTop = await canvas(page).locator('body').evaluate((b) => b.getBoundingClientRect().top);
    await canvas(page).locator('body').click({
      position: { x: Math.round(gap.x), y: Math.round(gap.y - bodyTop) },
    });
    await expect.poll(async () => await blockNames(page)).toEqual([
      'core/paragraph', 'core/heading', 'core/paragraph',
    ]);
  });
});

test.describe('armed insertion into containers (review 2026-09-02, findings 2 and 3)', () => {
  /** Click the canvas at a point measured in canvas-viewport coordinates. */
  async function clickCanvasAt(page, point) {
    const bodyTop = await canvas(page).locator('body').evaluate((b) => b.getBoundingClientRect().top);
    await canvas(page).locator('body').click({
      position: { x: Math.round(point.x), y: Math.round(point.y - bodyTop) },
    });
  }

  /** data-type of the block under a canvas-viewport point, or null. */
  async function blockTypeAt(page, point) {
    return canvas(page).locator('body').evaluate((body, g) => {
      const el = body.ownerDocument.elementFromPoint(g.x, g.y);
      const block = el && el.closest('[data-block]');
      return block ? block.getAttribute('data-type') : null;
    }, point);
  }

  test('a gap inside a container that refuses the block climbs to the nearest parent that accepts it', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/columns', {}, [
          createBlock('core/column', {}, [createBlock('core/paragraph', { content: 'LEFT' })]),
          createBlock('core/column', {}, [createBlock('core/paragraph', { content: 'RIGHT' })]),
        ]),
      ]);
    });
    await expect.poll(async () => await blockNames(page)).toEqual(['core/columns']);

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    // The gutter between the two columns: on the Columns block's own
    // list, on neither column.
    const gap = await canvas(page).locator('body').evaluate(() => {
      const cols = document.querySelectorAll('[data-type="core/column"]');
      const a = cols[0].getBoundingClientRect();
      const b = cols[1].getBoundingClientRect();
      return { x: (a.right + b.left) / 2, y: (a.top + a.bottom) / 2 };
    });
    expect(await blockTypeAt(page, gap)).toBe('core/columns');

    await clickCanvasAt(page, gap);
    // Columns refuses a Heading (core's insertBlocks would have dropped
    // it without a word); the click meant "here", so the heading lands
    // right after the Columns block at the root, and the tool returns
    // to Select as after any insert.
    await expect.poll(async () => await blockNames(page)).toEqual(['core/columns', 'core/heading']);
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a gap between blocks laid out in a Row resolves by x, not by y alone', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/group', { layout: { type: 'flex', flexWrap: 'nowrap' } }, [
          createBlock('core/paragraph', { content: 'ROW-A' }),
          createBlock('core/paragraph', { content: 'ROW-B' }),
        ]),
      ]);
    });
    await expect.poll(async () => await blockNames(page)).toEqual(['core/group']);

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    const gap = await canvas(page).locator('body').evaluate(() => {
      const ps = document.querySelectorAll('[data-type="core/group"] [data-type="core/paragraph"]');
      const a = ps[0].getBoundingClientRect();
      const b = ps[1].getBoundingClientRect();
      return {
        x: (a.right + b.left) / 2,
        y: (a.top + a.bottom) / 2,
        sideBySide: b.left >= a.right,
        levelWithinPx: Math.abs(a.top - b.top),
      };
    });
    // Guard the guard: the two really share a row, with a gap between.
    expect(gap.sideBySide).toBe(true);
    expect(gap.levelWithinPx).toBeLessThan(4);
    expect(await blockTypeAt(page, gap)).toBe('core/group');

    await clickCanvasAt(page, gap);
    // Between A and B inside the Row. A y-only count saw both midpoints
    // level with the pointer and put the heading first.
    await expect.poll(async () => page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlocks()[0].innerBlocks.map((b) => b.name)
    )).toEqual(['core/paragraph', 'core/heading', 'core/paragraph']);
  });

  test('a block no parent on the path accepts is refused with a message, and the tool stays armed', async ({ page }) => {
    await openNewPost(page);
    // core/column may only live inside Columns: at the root it has no
    // legal home anywhere on the way up.
    await page.evaluate(() => window.toolrail.pinBlock('core/column'));
    const tool = page.locator('#toolrail-rail [data-tool="pin:core/column"]');
    await tool.click();
    await clickBelowContent(page);

    await expect(page.locator('.components-snackbar')).toContainText('Column cannot be inserted here.');
    // No Column. What remains is core's own empty-space paragraph, the
    // same as a Select click there leaves: the refusal path does not
    // sweep it, because removing the only (selected) block hands focus
    // back to core's appender, which inserts another one ~60ms later
    // (measured 2026-09-02 with a 40ms sampler).
    await page.waitForTimeout(400);
    expect(await blockNames(page)).toEqual(['core/paragraph']);
    await expect(tool).toHaveAttribute('aria-pressed', 'true');

    await page.evaluate(() => window.toolrail.unpinBlock('core/column'));
  });
});

/**
 * QA sweep 2026-09-11 (private/qa-2026-09-11-editrail.md): one test per
 * core finding, C1–C8. Each names the finding so the report and the
 * spec can be read side by side.
 */
test.describe('QA 2026-09-11 follow-ups (1.0.2)', () => {
  /**
   * Pressed CORE tools (Select and the pins). Extension toggles — a
   * theme's "Page design", a guides plugin's rulers — keep their own
   * pressed state across page loads and are not what these tests are
   * about.
   */
  const pressedTools = (page) => page.evaluate(() =>
    Array.from(document.querySelectorAll('#toolrail-rail [data-tool][aria-pressed="true"]'))
      .map((b) => b.dataset.tool)
      .filter((id) => id === 'select' || id.startsWith('pin:'))
  );

  test('C1: Escape disarms with focus on the rail, and from the editor chrome, and says so', async ({ page }) => {
    await openNewPost(page);
    const paragraph = page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]');

    // Arm by keyboard: focus stays on the rail button.
    await paragraph.focus();
    await page.keyboard.press('Enter');
    await expect(paragraph).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(paragraph).toHaveAttribute('aria-pressed', 'false');
    expect(await pressedTools(page)).toEqual(['select']);
    expect(await liveText(page)).toContain('Tool disarmed');

    // Arm by click, then Escape with focus somewhere else in wp-admin.
    await paragraph.click();
    await expect(paragraph).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.editor-header button, .edit-post-header button').first().focus();
    await page.keyboard.press('Escape');
    await expect(paragraph).toHaveAttribute('aria-pressed', 'false');

    // A surface that owns Escape keeps it: with the settings dialog open,
    // Escape closes the dialog and the tool stays armed.
    await paragraph.click();
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await expect(page.locator('.toolrail-settings')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.toolrail-settings')).toHaveCount(0);
    await expect(paragraph).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(paragraph).toHaveAttribute('aria-pressed', 'false');
  });

  test('C8: a second press on the armed tool disarms it', async ({ page }) => {
    await openNewPost(page);
    const heading = page.locator('#toolrail-rail [data-tool="pin:core/heading"]');
    await heading.click();
    await expect(heading).toHaveAttribute('aria-pressed', 'true');
    await heading.click();
    await expect(heading).toHaveAttribute('aria-pressed', 'false');
    expect(await pressedTools(page)).toEqual(['select']);
    // Keyboard too.
    await heading.focus();
    await page.keyboard.press('Enter');
    await expect(heading).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Enter');
    await expect(heading).toHaveAttribute('aria-pressed', 'false');
    // Switching between two arming tools still arms the second.
    await heading.click();
    await page.locator('#toolrail-rail [data-tool="pin:core/image"]').click();
    expect(await pressedTools(page)).toEqual(['pin:core/image']);
  });

  test('C5: an armed click on the post title inserts at the top, not the bottom', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const blocks = [];
      for (let i = 0; i < 12; i++) {
        blocks.push(window.wp.blocks.createBlock('core/paragraph', { content: 'Paragraph ' + (i + 1) + ' ' + 'text '.repeat(30) }));
      }
      window.wp.data.dispatch('core/block-editor').resetBlocks(blocks);
    });
    await canvas(page).locator('body').evaluate((b) => b.ownerDocument.defaultView.scrollTo(0, 0));

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    await canvas(page).locator('.editor-post-title__input, .editor-post-title').first().click({ position: { x: 20, y: 10 } });

    await expect.poll(() => blockNames(page)).toHaveLength(13);
    const names = await blockNames(page);
    expect(names[0]).toBe('core/heading');
    expect(names.slice(1).every((n) => n === 'core/paragraph')).toBe(true);
    // The author stays at the top: the canvas did not scroll to the bottom.
    expect(await canvas(page).locator('body').evaluate((b) => b.ownerDocument.defaultView.scrollY)).toBeLessThan(200);
  });

  test('C6: an armed click inside an empty Group inserts inside it; a leaf block still takes before/after', async ({ page }) => {
    await openNewPost(page);
    for (const frac of [0.25, 0.75]) {
      await page.evaluate(() => {
        window.wp.data.dispatch('core/block-editor').resetBlocks([window.wp.blocks.createBlock('core/group')]);
      });
      const group = canvas(page).locator('[data-type="core/group"]').first();
      await expect(group).toBeVisible();
      await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').click();
      const box = await group.boundingBox();
      await group.click({ position: { x: 30, y: Math.round(box.height * frac) } });
      await expect.poll(() => page.evaluate(() => {
        const s = window.wp.data.select('core/block-editor');
        return s.getBlocks().map((b) => b.name + ':' + b.innerBlocks.map((c) => c.name).join(','));
      })).toEqual(['core/group:core/paragraph']);
    }

    // A leaf block (an image) has no root that accepts a paragraph, so
    // the click still lands beside it: top half is before.
    await page.evaluate(() => {
      window.wp.data.dispatch('core/block-editor').resetBlocks([window.wp.blocks.createBlock('core/image')]);
    });
    const image = canvas(page).locator('[data-type="core/image"]').first();
    await expect(image).toBeVisible();
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').click();
    await image.click({ position: { x: 30, y: 8 } });
    await expect.poll(() => blockNames(page)).toEqual(['core/paragraph', 'core/image']);
  });
});
