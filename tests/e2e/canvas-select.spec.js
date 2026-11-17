/**
 * EditRail — canvas selection spec (#14).
 *
 * Several blocks selected in the editing canvas: a rectangle dragged from
 * empty canvas space, Ctrl+click and Alt+click, Ctrl+Space from the
 * keyboard and its twin in the block Options menu, the bar with the group
 * actions, and the rules that keep the rail's kept selection true to the
 * WordPress selection.
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const { AUTH, openNewPost, canvas, liveText } = require('./helpers');

test.use({ storageState: AUTH });

const ATTR = 'data-toolrail-selected';

/**
 * Seed a known document: three paragraphs, a Group with padding around
 * two blocks, and a last paragraph. Nothing is selected afterward.
 *
 * @return {Promise<Object>} The clientIds by name.
 */
async function seedCanvas(page) {
  // openNewPost waits for the rail, which can be up before the canvas
  // iframe has rendered its block list (seen once in Firefox).
  await expect(canvas(page).locator('.is-root-container')).toBeVisible({ timeout: 20000 });
  const ids = await page.evaluate(() => {
    const { createBlock } = window.wp.blocks;
    const pad = { spacing: { padding: { top: '40px', bottom: '40px', left: '40px', right: '40px' } } };
    const blocks = {
      alpha: createBlock('core/paragraph', { content: 'ALPHA paragraph with enough text to select part of it.' }),
      beta: createBlock('core/paragraph', { content: 'BETA' }),
      gamma: createBlock('core/paragraph', { content: 'GAMMA' }),
      inner1: createBlock('core/paragraph', { content: 'INNER-ONE' }),
      inner2: createBlock('core/heading', { content: 'INNER-TWO' }),
      omega: createBlock('core/paragraph', { content: 'OMEGA' }),
    };
    blocks.group = createBlock('core/group', { style: pad }, [blocks.inner1, blocks.inner2]);
    const d = window.wp.data.dispatch('core/block-editor');
    d.resetBlocks([blocks.alpha, blocks.beta, blocks.gamma, blocks.group, blocks.omega]);
    d.clearSelectedBlock();
    const out = {};
    Object.keys(blocks).forEach((k) => {
      out[k] = blocks[k].clientId;
    });
    return out;
  });
  await expect(canvas(page).locator('#block-' + ids.omega)).toBeVisible({ timeout: 15000 });
  // Park the pointer over the settings sidebar, away from the admin bar's
  // hover menus and from the canvas.
  await page.mouse.move(1150, 500);
  return ids;
}

/** A block's box in PAGE coordinates (the canvas iframe's offset added). */
async function boxOf(page, clientId) {
  const box = await canvas(page).locator('#block-' + clientId).boundingBox();
  return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, width: box.width, height: box.height };
}

/**
 * An x in the EMPTY space beside the content: halfway between the canvas
 * edge and a block's left edge. Fails with a clear message on a theme
 * that leaves no such space, so a later drag is never read as "the
 * rectangle is broken".
 */
async function marginX(page, clientId) {
  const frame = await page.locator('iframe[name="editor-canvas"]').boundingBox();
  const box = await boxOf(page, clientId);
  expect(box.left - frame.x, 'the theme leaves empty space beside the content').toBeGreaterThan(24);
  return frame.x + (box.left - frame.x) / 2;
}

/** Press, move in steps, and (unless told not to) release. */
async function drag(page, from, to, opts) {
  const o = opts || {};
  for (const key of (o.modifiers || [])) {
    await page.keyboard.down(key);
  }
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  if (o.hold) {
    return;
  }
  await page.mouse.up();
  for (const key of (o.modifiers || [])) {
    await page.keyboard.up(key);
  }
}

/** The WordPress selection, as clientIds. */
const selected = (page) => page.evaluate(() =>
  window.wp.data.select('core/block-editor').getSelectedBlockClientIds());

/** The blocks that carry the rail's outline, as clientIds in DOM order. */
const outlined = (page) => canvas(page).locator('body').evaluate((body, attr) =>
  Array.prototype.map.call(body.querySelectorAll('[' + attr + ']'), (el) => el.getAttribute('data-block')), ATTR);

/** Top-level block order, as clientIds. */
const order = (page) => page.evaluate(() =>
  window.wp.data.select('core/block-editor').getBlockOrder(''));

/** The post content as it would be saved. */
const serialized = (page) => page.evaluate(() =>
  window.wp.blocks.serialize(window.wp.data.select('core/block-editor').getBlocks()));

/** Core's assertive live region (core's own multiSelect speaks there). */
const assertiveText = (page) => page.evaluate(() => {
  const el = document.getElementById('a11y-speak-assertive');
  return el ? el.textContent.split(String.fromCharCode(160)).join(' ').trim() : '';
});

/** The click-toggle modifier in this browser: Cmd on a Mac, else Ctrl. */
const toggleKey = (page) => page.evaluate(() =>
  (/Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? 'Meta' : 'Control'));

/** Click a point in a block with modifiers held. */
async function clickBlock(page, clientId, modifiers) {
  const box = await boxOf(page, clientId);
  for (const key of (modifiers || [])) {
    await page.keyboard.down(key);
  }
  await page.mouse.click(box.left + Math.min(30, box.width / 2), box.top + Math.min(12, box.height / 2));
  for (const key of (modifiers || [])) {
    await page.keyboard.up(key);
  }
}

/**
 * Build a kept selection with the click toggle: a plain click on the
 * first block, then the toggle modifier on each of the others.
 */
async function keepWithClicks(page, clientIds) {
  const key = await toggleKey(page);
  await clickBlock(page, clientIds[0]);
  for (const id of clientIds.slice(1)) {
    await clickBlock(page, id, [key]);
  }
  await expect.poll(() => outlined(page)).toEqual(clientIds);
}

/**
 * Build the kept selection [alpha, gamma] with the keyboard: Ctrl+Space
 * on alpha, the arrow keys to gamma, Ctrl+Space again. The block cursor
 * (the WordPress selection) ends on gamma. A plain CLICK between the two
 * would end the set, by design, so the cursor moves with the keys.
 */
async function keepWithKeys(page, ids) {
  await clickBlock(page, ids.alpha);
  await expect.poll(() => selected(page)).toEqual([ids.alpha]);
  await page.keyboard.press('Control+Space');
  await expect.poll(() => outlined(page)).toEqual([ids.alpha]);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => selected(page)).toEqual([ids.beta]);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => selected(page)).toEqual([ids.gamma]);
  await page.keyboard.press('Control+Space');
  await expect.poll(() => outlined(page)).toEqual([ids.alpha, ids.gamma]);
}

/**
 * Open the selected block's Options menu with keys only: Alt+F10 to the
 * block toolbar, the arrow keys to its Options button, Enter to open.
 * Returns the menu.
 */
async function openOptionsByKeys(page) {
  const options = page.locator('.block-editor-block-toolbar button[aria-label="Options"]');
  await page.keyboard.press('Alt+F10');
  await expect.poll(() => page.evaluate(() => !!document.activeElement.closest('.block-editor-block-toolbar'))).toBe(true);
  for (let i = 0; i < 20; i++) {
    if (await options.evaluate((btn) => btn === document.activeElement)) {
      break;
    }
    await page.keyboard.press('ArrowRight');
  }
  await expect(options).toBeFocused();
  await page.keyboard.press('Enter');
  const menu = page.locator('.block-editor-block-settings-menu__popover [role="menu"]');
  await expect(menu).toBeVisible();
  return menu;
}

/** Move focus down a menu with the arrow keys to the item with this name. */
async function arrowToItem(page, menu, name) {
  const item = menu.getByRole('menuitem', { name, exact: true });
  await expect(item).toBeVisible();
  for (let i = 0; i < 30; i++) {
    if (await item.evaluate((node) => node === document.activeElement)) {
      return item;
    }
    await page.keyboard.press('ArrowDown');
  }
  await expect(item).toBeFocused();
  return item;
}

/**
 * Record every message written to core's two live regions from now on:
 * the rail's and core's own. wp.a11y.speak empties both regions and then
 * sets one region's text, so each message is one record that adds a
 * non-empty text node; two messages in one task are two records.
 * (wp.a11y.speak itself cannot be wrapped: its exports are read-only.)
 */
const recordSpeech = (page) => page.evaluate(() => {
  window.__toolrailSpoken = [];
  if (window.__toolrailSpeechObserver) {
    return;
  }
  const regions = ['a11y-speak-polite', 'a11y-speak-assertive']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  window.__toolrailSpeechObserver = new MutationObserver((records) => {
    records.forEach((record) => {
      Array.prototype.forEach.call(record.addedNodes, (node) => {
        const text = (node.textContent || '').split(String.fromCharCode(160)).join(' ').trim();
        if (text) {
          window.__toolrailSpoken.push(text);
        }
      });
    });
  });
  regions.forEach((el) => window.__toolrailSpeechObserver.observe(el, { childList: true }));
});
const spoken = (page) => page.evaluate(() => window.__toolrailSpoken.slice());

const bar = (page) => page.locator('#toolrail-csel-bar');
const barButton = (page, action) => page.locator('#toolrail-csel-bar [data-csel-action="' + action + '"]');

test.describe('canvas selection (#14): the rectangle', () => {
  test('a drag from empty canvas space draws a rectangle and selects every block it touches', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const before = await serialized(page);
    const alpha = await boxOf(page, ids.alpha);
    const gamma = await boxOf(page, ids.gamma);
    const x = await marginX(page, ids.alpha);

    await drag(page, { x, y: alpha.top - 4 }, { x: alpha.left + 200, y: gamma.top + gamma.height / 2 }, { hold: true });
    // Mid-drag: the rectangle is on screen, the touched blocks carry the
    // outline, and WordPress's selection has not been touched yet.
    await expect(page.locator('#toolrail-canvas-marquee')).toBeVisible();
    expect(await outlined(page)).toEqual([ids.alpha, ids.beta, ids.gamma]);
    expect(await selected(page)).toEqual([]);
    const rect = await page.locator('#toolrail-canvas-marquee').boundingBox();
    expect(Math.abs(rect.x - x)).toBeLessThan(3);
    expect(Math.abs(rect.y - (alpha.top - 4))).toBeLessThan(3);
    await page.mouse.up();

    // Three neighbors: WordPress can hold them, so it does, and the rail
    // keeps nothing — no outline of its own and no bar.
    await expect.poll(() => selected(page)).toEqual([ids.alpha, ids.beta, ids.gamma]);
    await expect(page.locator('#toolrail-canvas-marquee')).toHaveCount(0);
    expect(await outlined(page)).toEqual([]);
    await expect(bar(page)).toBeHidden();
    // The count is announced once, by core's own multiSelect.
    await expect.poll(() => assertiveText(page)).toBe('3 blocks selected.');
    // Nothing was written to the post.
    expect(await serialized(page)).toBe(before);
    expect(before).not.toContain('toolrail');
  });

  test('a drag that starts below the last block selects too, and the paragraph WordPress appends for the press is removed', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const before = await serialized(page);
    const omega = await boxOf(page, ids.omega);
    const group = await boxOf(page, ids.group);

    await drag(page, { x: omega.left + 100, y: omega.bottom + 90 }, { x: omega.left + 260, y: group.bottom - 10 });

    await expect.poll(() => selected(page)).toEqual([ids.group, ids.omega]);
    expect(await order(page)).toEqual([ids.alpha, ids.beta, ids.gamma, ids.group, ids.omega]);
    expect(await serialized(page)).toBe(before);
  });

  test('a press on empty space that does not move behaves as before: beside the content it clears the selection, below it WordPress appends a paragraph', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const alpha = await boxOf(page, ids.alpha);
    const omega = await boxOf(page, ids.omega);
    const x = await marginX(page, ids.alpha);

    await page.evaluate((id) => window.wp.data.dispatch('core/block-editor').selectBlock(id), ids.alpha);
    await page.mouse.click(x, alpha.bottom + 4);
    await expect.poll(() => selected(page)).toEqual([]);
    await expect(page.locator('#toolrail-canvas-marquee')).toHaveCount(0);
    expect(await order(page)).toHaveLength(5);

    await page.mouse.click(omega.left + 100, omega.bottom + 90);
    await expect.poll(async () => (await order(page)).length).toBe(6);
    const names = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlocks().map((b) => b.name));
    expect(names[5]).toBe('core/paragraph');
    expect(await outlined(page)).toEqual([]);
  });

  test('a drag that starts inside a block\'s text still selects text', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const alpha = await boxOf(page, ids.alpha);
    const y = alpha.top + alpha.height / 2;

    await drag(page, { x: alpha.left + 10, y }, { x: alpha.left + 170, y }, { hold: true });
    await expect(page.locator('#toolrail-canvas-marquee')).toHaveCount(0);
    await page.mouse.up();

    const text = await canvas(page).locator('body').evaluate((body) => body.ownerDocument.getSelection().toString());
    expect(text.length).toBeGreaterThan(3);
    expect('ALPHA paragraph with enough text to select part of it.').toContain(text);
    expect(await selected(page)).toEqual([ids.alpha]);
    expect(await outlined(page)).toEqual([]);
    await expect(bar(page)).toBeHidden();
  });

  test('WordPress\'s own drag selection and Shift+click still select a range', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const alpha = await boxOf(page, ids.alpha);
    const gamma = await boxOf(page, ids.gamma);

    // A drag from one block's text into another's is core's gesture.
    await drag(page, { x: alpha.left + 10, y: alpha.top + alpha.height / 2 }, { x: gamma.left + 30, y: gamma.top + gamma.height / 2 }, { hold: true });
    await expect(page.locator('#toolrail-canvas-marquee')).toHaveCount(0);
    await page.mouse.up();
    await expect.poll(() => selected(page)).toEqual([ids.alpha, ids.beta, ids.gamma]);
    expect(await outlined(page)).toEqual([]);

    await page.evaluate(() => window.wp.data.dispatch('core/block-editor').clearSelectedBlock());
    await clickBlock(page, ids.beta);
    await expect.poll(() => selected(page)).toEqual([ids.beta]);
    await clickBlock(page, ids.omega, ['Shift']);
    await expect.poll(() => selected(page)).toEqual([ids.beta, ids.gamma, ids.group, ids.omega]);
    expect(await outlined(page)).toEqual([]);
    await expect(bar(page)).toBeHidden();
  });

  test('a press on a block\'s own surface is not a rectangle start', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const group = await boxOf(page, ids.group);

    // The Group's padding: core selects the Group, and a drag from there
    // is core's block drag.
    await drag(page, { x: group.left + 10, y: group.top + 10 }, { x: group.left + 200, y: group.top + 100 }, { hold: true });
    await expect(page.locator('#toolrail-canvas-marquee')).toHaveCount(0);
    expect(await outlined(page)).toEqual([]);
    await page.mouse.up();
    await expect(bar(page)).toBeHidden();
  });

  test('with a tool armed, a drag from empty space is not a rectangle', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const alpha = await boxOf(page, ids.alpha);
    const gamma = await boxOf(page, ids.gamma);
    const x = await marginX(page, ids.alpha);

    await page.locator('#toolrail-rail [data-tool="pin:core/heading"]').click();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/heading"]')).toHaveAttribute('aria-pressed', 'true');
    await drag(page, { x, y: alpha.top - 4 }, { x: alpha.left + 200, y: gamma.top + 10 }, { hold: true });
    await expect(page.locator('#toolrail-canvas-marquee')).toHaveCount(0);
    expect(await outlined(page)).toEqual([]);
    await page.mouse.up();
    await expect(bar(page)).toBeHidden();
  });

  test('the level rule: a rectangle over part of a Group selects the blocks inside it, and a rectangle around the Group selects the Group', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const group = await boxOf(page, ids.group);
    const inner2 = await boxOf(page, ids.inner2);
    const x = await marginX(page, ids.alpha);

    await drag(page, { x, y: group.top + 30 }, { x: group.left + 200, y: inner2.top + inner2.height / 2 });
    await expect.poll(() => selected(page)).toEqual([ids.inner1, ids.inner2]);

    await page.evaluate(() => window.wp.data.dispatch('core/block-editor').clearSelectedBlock());
    await drag(page, { x, y: group.top - 6 }, { x: group.right + 20, y: group.bottom + 6 });
    await expect.poll(() => selected(page)).toEqual([ids.group]);
    await expect.poll(() => liveText(page)).toBe('1 block selected.');
  });

  test('a rectangle with the toggle key held adds to the selection, with a gap the rail keeps', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const key = await toggleKey(page);
    const alpha = await boxOf(page, ids.alpha);
    const omega = await boxOf(page, ids.omega);
    const x = await marginX(page, ids.alpha);

    await drag(page, { x, y: alpha.top - 4 }, { x: alpha.left + 100, y: alpha.top + 6 });
    await expect.poll(() => selected(page)).toEqual([ids.alpha]);

    await drag(page, { x, y: omega.top + 4 }, { x: omega.left + 100, y: omega.bottom - 4 }, { modifiers: [key] });
    await expect.poll(() => outlined(page)).toEqual([ids.alpha, ids.omega]);
    // WordPress cannot hold a gap: its own selection is empty, and the
    // rail's bar carries the count.
    expect(await selected(page)).toEqual([]);
    await expect(bar(page)).toBeVisible();
    await expect(bar(page).locator('.toolrail-csel-count')).toHaveText('2 blocks selected.');
    await expect.poll(() => liveText(page)).toBe('2 blocks selected. Press Control+Enter for the selection actions.');
  });

  test('Escape cancels a rectangle in flight and leaves the selection as it was', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const alpha = await boxOf(page, ids.alpha);
    const gamma = await boxOf(page, ids.gamma);
    const x = await marginX(page, ids.alpha);

    await drag(page, { x, y: alpha.top - 4 }, { x: alpha.left + 200, y: gamma.top + 10 }, { hold: true });
    await expect(page.locator('#toolrail-canvas-marquee')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-canvas-marquee')).toHaveCount(0);
    expect(await outlined(page)).toEqual([]);
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await selected(page)).toEqual([]);
    expect(await outlined(page)).toEqual([]);
  });

  test('a pointerdown that another listener canceled is left alone', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const alpha = await boxOf(page, ids.alpha);
    const gamma = await boxOf(page, ids.gamma);
    const x = await marginX(page, ids.alpha);

    // Stands in for an extension plugin with its own canvas gesture: a
    // window capture listener runs before the rail's document one.
    await canvas(page).locator('body').evaluate((body) => {
      body.ownerDocument.defaultView.addEventListener('pointerdown', (e) => {
        e.preventDefault();
      }, true);
    });
    await drag(page, { x, y: alpha.top - 4 }, { x: alpha.left + 200, y: gamma.top + 10 }, { hold: true });
    await expect(page.locator('#toolrail-canvas-marquee')).toHaveCount(0);
    expect(await outlined(page)).toEqual([]);
    await page.mouse.up();
  });
});

test.describe('canvas selection (#14): click toggles', () => {
  test('Ctrl+click adds a block with a gap: the rail keeps the set, outlines it and shows the bar; filling the gap hands it to WordPress', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const key = await toggleKey(page);

    await clickBlock(page, ids.alpha);
    await expect.poll(() => selected(page)).toEqual([ids.alpha]);
    await clickBlock(page, ids.gamma, [key]);
    await expect.poll(() => outlined(page)).toEqual([ids.alpha, ids.gamma]);
    expect(await selected(page)).toEqual([]);
    await expect(bar(page)).toBeVisible();
    await expect.poll(() => liveText(page)).toBe('2 blocks selected. Press Control+Enter for the selection actions.');

    // The outline is a dashed line inside the canvas, on the members only.
    const styles = await canvas(page).locator('body').evaluate((body, list) => list.map((id) => {
      const cs = body.ownerDocument.defaultView.getComputedStyle(body.ownerDocument.getElementById('block-' + id));
      return cs.outlineStyle + ' ' + cs.outlineWidth;
    }), [ids.alpha, ids.beta, ids.gamma]);
    expect(styles[0]).toBe('dashed 2px');
    expect(styles[2]).toBe('dashed 2px');
    expect(styles[1]).not.toContain('dashed');

    await clickBlock(page, ids.beta, [key]);
    await expect.poll(() => selected(page)).toEqual([ids.alpha, ids.beta, ids.gamma]);
    expect(await outlined(page)).toEqual([]);
    await expect(bar(page)).toBeHidden();
    await expect.poll(() => assertiveText(page)).toBe('3 blocks selected.');
  });

  test('Alt+click removes one block from a WordPress selection, and Ctrl+click removes one from the kept set', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const key = await toggleKey(page);

    await page.evaluate((list) => window.wp.data.dispatch('core/block-editor').multiSelect(list[0], list[1]), [ids.alpha, ids.gamma]);
    await expect.poll(() => selected(page)).toEqual([ids.alpha, ids.beta, ids.gamma]);
    await clickBlock(page, ids.beta, ['Alt']);
    await expect.poll(() => outlined(page)).toEqual([ids.alpha, ids.gamma]);
    expect(await selected(page)).toEqual([]);
    await expect.poll(() => liveText(page)).toBe('2 blocks selected. Press Control+Enter for the selection actions.');

    await clickBlock(page, ids.gamma, [key]);
    // One block is left: WordPress holds it.
    await expect.poll(() => selected(page)).toEqual([ids.alpha]);
    expect(await outlined(page)).toEqual([]);
    await expect(bar(page)).toBeHidden();
    await expect.poll(() => liveText(page)).toBe('1 block selected.');
  });

  test('a plain click still places the caret, and ends a kept set', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await keepWithClicks(page, [ids.alpha, ids.gamma]);

    await clickBlock(page, ids.beta);
    await expect.poll(() => selected(page)).toEqual([ids.beta]);
    expect(await outlined(page)).toEqual([]);
    await expect(bar(page)).toBeHidden();
    const caret = await canvas(page).locator('body').evaluate((body, id) => {
      const doc = body.ownerDocument;
      const s = doc.getSelection();
      const block = doc.getElementById('block-' + id);
      return { collapsed: s.isCollapsed, inBlock: !!s.anchorNode && block.contains(s.anchorNode) };
    }, ids.beta);
    expect(caret).toEqual({ collapsed: true, inBlock: true });
    await page.keyboard.type('x');
    const content = await page.evaluate((id) =>
      String(window.wp.data.select('core/block-editor').getBlockAttributes(id).content), ids.beta);
    expect(content).toContain('x');
  });

  test('Ctrl+click on a link is left to the browser; on plain text it is the toggle', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const key = await toggleKey(page);
    await page.evaluate((id) => {
      window.wp.data.dispatch('core/block-editor').updateBlockAttributes(id, { content: '<a href="#nowhere">LINKTEXT</a> and plain words after it' });
    }, ids.beta);
    await expect(canvas(page).locator('#block-' + ids.beta + ' a')).toBeVisible();

    // Record whether the press was canceled, and keep the browser from
    // following the link in the test.
    await canvas(page).locator('body').evaluate((body) => {
      const win = body.ownerDocument.defaultView;
      win.__presses = [];
      win.addEventListener('pointerdown', (e) => {
        win.__presses.push(e.defaultPrevented);
      }, false);
      body.ownerDocument.addEventListener('click', (e) => {
        if (e.target.closest && e.target.closest('a')) {
          e.preventDefault();
        }
      }, true);
    });
    await clickBlock(page, ids.omega);
    const link = await canvas(page).locator('#block-' + ids.beta + ' a').boundingBox();
    await page.keyboard.down(key);
    await page.mouse.click(link.x + link.width / 2, link.y + link.height / 2);
    await page.keyboard.up(key);
    await page.waitForTimeout(200);
    expect(await outlined(page)).toEqual([]);
    await expect(bar(page)).toBeHidden();

    // Core selected BETA on that press, and its block toolbar now covers
    // ALPHA. Start again from a block whose toolbar covers neither.
    await page.evaluate(() => window.wp.data.dispatch('core/block-editor').clearSelectedBlock());
    await clickBlock(page, ids.omega);
    await expect.poll(() => selected(page)).toEqual([ids.omega]);
    await clickBlock(page, ids.alpha, [key]);
    await expect.poll(() => outlined(page)).toEqual([ids.alpha, ids.omega]);
    const presses = await canvas(page).locator('body').evaluate((body) => body.ownerDocument.defaultView.__presses);
    // plain, Ctrl on the link, plain, Ctrl on text.
    expect(presses).toEqual([false, false, false, true]);
  });

  test('a selection never holds a block with its ancestor, and blocks at two levels turn Move, Duplicate and Group off', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const key = await toggleKey(page);

    await page.evaluate((id) => window.wp.data.dispatch('core/block-editor').selectBlock(id), ids.group);
    await expect.poll(() => selected(page)).toEqual([ids.group]);
    // A block inside the selected Group replaces the Group.
    await clickBlock(page, ids.inner1, [key]);
    await expect.poll(() => selected(page)).toEqual([ids.inner1]);
    expect(await outlined(page)).toEqual([]);

    await clickBlock(page, ids.alpha, [key]);
    await expect.poll(() => outlined(page)).toEqual([ids.alpha, ids.inner1]);
    for (const action of ['up', 'down', 'duplicate', 'group']) {
      await expect(barButton(page, action)).toHaveAttribute('aria-disabled', 'true');
      await expect(barButton(page, action)).toHaveAttribute('title', /at different levels/);
    }
    await expect(barButton(page, 'delete')).not.toHaveAttribute('aria-disabled', 'true');

    // A dimmed action says why, and does nothing.
    const before = await serialized(page);
    // focus + Enter, not click(): Playwright waits for an aria-disabled
    // button to become enabled.
    await barButton(page, 'group').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => liveText(page)).toBe('Not available: the selected blocks are at different levels.');
    expect(await serialized(page)).toBe(before);
  });
});

test.describe('canvas selection (#14): keyboard', () => {
  test('Ctrl+Space keeps the selected block, the block cursor moves with the arrow keys, and a second Ctrl+Space adds a block with a gap', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);

    await clickBlock(page, ids.beta);
    await expect.poll(() => selected(page)).toEqual([ids.beta]);
    await recordSpeech(page);
    await page.keyboard.press('Control+Space');
    await expect.poll(() => outlined(page)).toEqual([ids.beta]);
    await expect.poll(() => liveText(page)).toBe('1 block selected. Press Control+Enter for the selection actions.');
    // Focus stays in the canvas, where Ctrl+Enter works: the key's hint
    // is not the menu item's, and it is said once.
    expect(await spoken(page)).toEqual(['1 block selected. Press Control+Enter for the selection actions.']);
    // The key is taken: no space was typed into the paragraph.
    expect(await page.evaluate((id) =>
      String(window.wp.data.select('core/block-editor').getBlockAttributes(id).content), ids.beta)).toBe('BETA');

    // Core's own arrow keys move the block cursor; the kept set stays.
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => selected(page)).toEqual([ids.gamma]);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => selected(page)).toEqual([ids.inner1]);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => selected(page)).toEqual([ids.omega]);
    expect(await outlined(page)).toEqual([ids.beta]);

    await page.keyboard.press('Control+Space');
    await expect.poll(() => outlined(page)).toEqual([ids.beta, ids.omega]);
    await expect.poll(() => liveText(page)).toBe('2 blocks selected.');
    expect(await selected(page)).toEqual([ids.omega]);

    // The same key on a member removes it.
    await page.keyboard.press('Control+Space');
    await expect.poll(() => outlined(page)).toEqual([ids.beta]);
    await expect.poll(() => liveText(page)).toBe('1 block selected.');
  });

  test('Escape does one thing at a time: it disarms a tool first, then clears the kept set', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await keepWithClicks(page, [ids.alpha, ids.gamma]);

    await page.evaluate(() => window.toolrail.setActiveTool('pin:core/heading'));
    await canvas(page).locator('body').evaluate((body) => body.focus());
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.toolrail.getActiveTool())).toBe('select');
    expect(await outlined(page)).toEqual([ids.alpha, ids.gamma]);
    await expect.poll(() => liveText(page)).toBe('Tool disarmed. Select is active.');

    await page.keyboard.press('Escape');
    await expect.poll(() => outlined(page)).toEqual([]);
    await expect(bar(page)).toBeHidden();
    await expect.poll(() => liveText(page)).toBe('Selection cleared.');
  });

  test('Ctrl+Enter goes to the bar: one Tab stop, arrows inside, and Escape returns to the canvas with the set kept', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await keepWithKeys(page, ids);

    await expect(bar(page)).toHaveAttribute('role', 'toolbar');
    await expect(bar(page)).toHaveAttribute('aria-label', 'Selection actions');
    await page.keyboard.press('Control+Enter');
    await expect(barButton(page, 'up')).toBeFocused();
    expect(await bar(page).locator('[data-csel-action][tabindex="0"]').count()).toBe(1);
    expect(await bar(page).locator('[data-csel-action]').allTextContents())
      .toEqual(['Move up', 'Move down', 'Duplicate', 'Group', 'Delete', 'Clear selection']);

    // The focus ring clears 3:1 against the bar it is drawn on. (The
    // appearance sweep skips the bar, as it skips the overview: both use
    // a fixed palette, not the rail's tokens.)
    const ring = await barButton(page, 'up').evaluate((btn) => {
      const lum = (c) => {
        const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const cs = getComputedStyle(btn);
      const a = lum(cs.outlineColor);
      const b = lum(getComputedStyle(btn.parentElement).backgroundColor);
      return { style: cs.outlineStyle, width: cs.outlineWidth, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
    });
    expect(ring.style).toBe('solid');
    expect(ring.width).toBe('2px');
    expect(ring.ratio).toBeGreaterThanOrEqual(3);

    await page.keyboard.press('ArrowRight');
    await expect(barButton(page, 'down')).toBeFocused();
    await page.keyboard.press('End');
    await expect(barButton(page, 'clear')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(barButton(page, 'up')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(barButton(page, 'clear')).toBeFocused();
    expect(await bar(page).locator('[data-csel-action][tabindex="0"]').count()).toBe(1);
    await expect(barButton(page, 'clear')).toHaveAttribute('tabindex', '0');

    await page.keyboard.press('Escape');
    // Focus is back in the canvas, where it came from: in the block, or
    // on the canvas body with the caret in the block (core moves focus to
    // the body a moment after an arrow key, and keeps the caret).
    await expect.poll(() => page.evaluate(() => document.activeElement.tagName)).toBe('IFRAME');
    const where = await canvas(page).locator('body').evaluate((body, id) => {
      const doc = body.ownerDocument;
      const block = doc.getElementById('block-' + id);
      const s = doc.getSelection();
      return block.contains(doc.activeElement)
        || (doc.activeElement === body && !!s.anchorNode && block.contains(s.anchorNode));
    }, ids.gamma);
    expect(where).toBe(true);
    expect(await selected(page)).toEqual([ids.gamma]);
    // A late focus retry must not pull the author back to the bar.
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.activeElement.tagName)).toBe('IFRAME');
    expect(await outlined(page)).toEqual([ids.alpha, ids.gamma]);
    await expect(bar(page)).toBeVisible();
  });
});

test.describe('canvas selection (#14): the Options menu item', () => {
  test('with keys only, the Options menu starts a kept set, adds a block with a gap and removes one, each announced once', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const before = await serialized(page);
    const dirtyBefore = await page.evaluate(() => window.wp.data.select('core/editor').isEditedPostDirty());
    // Count changes to the preferences store: the selection is editor
    // session state and must not write one.
    await page.evaluate(() => {
      window.__toolrailPrefChanges = 0;
      window.wp.data.subscribe(() => {
        window.__toolrailPrefChanges += 1;
      }, 'core/preferences');
    });
    const optionsButton = page.locator('.block-editor-block-toolbar button[aria-label="Options"]');
    const inCanvas = () => expect.poll(() => page.evaluate(() => document.activeElement.tagName)).toBe('IFRAME');

    // The click only puts the block cursor in alpha. Every step after it
    // is a key.
    await clickBlock(page, ids.alpha);
    await expect.poll(() => selected(page)).toEqual([ids.alpha]);

    // One block selected and nothing kept yet: the menu offers the item,
    // as a menu item with a text name, after the rail's pin items.
    await recordSpeech(page);
    let menu = await openOptionsByKeys(page);
    const names = await menu.getByRole('menuitem').allTextContents();
    expect(names.indexOf('Add to selection')).toBe(names.indexOf('Save as pattern and pin to toolbar…') + 1);
    expect(names).not.toContain('Remove from selection');
    await arrowToItem(page, menu, 'Add to selection');
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect.poll(() => outlined(page)).toEqual([ids.alpha]);
    await expect(bar(page)).toBeVisible();
    // Core closes the menu and returns focus to the Options button.
    await expect(optionsButton).toBeFocused();
    // Heard once: no second message from the rail or from core. The wait
    // gives a late duplicate the time to arrive.
    await page.waitForTimeout(300);
    // Focus is on the Options button, where Ctrl+Enter does nothing, so
    // the hint names Escape first.
    expect(await spoken(page)).toEqual(['1 block selected. Press Escape to go back to the block, then press Control+Enter for the selection actions.']);

    // Escape goes back to the block; the arrow keys move the block cursor
    // to gamma; the kept set stays.
    await page.keyboard.press('Escape');
    await inCanvas();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => selected(page)).toEqual([ids.beta]);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => selected(page)).toEqual([ids.gamma]);
    expect(await outlined(page)).toEqual([ids.alpha]);

    await recordSpeech(page);
    menu = await openOptionsByKeys(page);
    await arrowToItem(page, menu, 'Add to selection');
    await page.keyboard.press('Enter');
    await expect.poll(() => outlined(page)).toEqual([ids.alpha, ids.gamma]);
    await expect(optionsButton).toBeFocused();
    await page.waitForTimeout(300);
    expect(await spoken(page)).toEqual(['2 blocks selected.']);
    // The focus return did not end the set or move the block cursor.
    expect(await outlined(page)).toEqual([ids.alpha, ids.gamma]);
    expect(await selected(page)).toEqual([ids.gamma]);
    await expect(bar(page)).toBeVisible();

    // Ctrl+Enter from the canvas still goes to the bar, and Escape there
    // comes back.
    await page.keyboard.press('Escape');
    await inCanvas();
    await page.keyboard.press('Control+Enter');
    await expect(barButton(page, 'up')).toBeFocused();
    await page.keyboard.press('Escape');
    await inCanvas();
    expect(await selected(page)).toEqual([ids.gamma]);

    // On a member, the menu offers the other item, and it removes the
    // member.
    await recordSpeech(page);
    menu = await openOptionsByKeys(page);
    expect(await menu.getByRole('menuitem').allTextContents()).not.toContain('Add to selection');
    await arrowToItem(page, menu, 'Remove from selection');
    await page.keyboard.press('Enter');
    await expect.poll(() => outlined(page)).toEqual([ids.alpha]);
    await page.waitForTimeout(300);
    expect(await spoken(page)).toEqual(['1 block selected.']);

    // Nothing entered the post, and no preference was written.
    expect(await serialized(page)).toBe(before);
    expect(await page.evaluate(() => window.wp.data.select('core/editor').isEditedPostDirty())).toBe(dirtyBefore);
    expect(await page.evaluate(() => window.__toolrailPrefChanges)).toBe(0);
  });

  test('the item acts on every block of a WordPress multi-selection, the same as Ctrl+Space', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await page.evaluate((list) => window.wp.data.dispatch('core/block-editor').multiSelect(list[0], list[1]), [ids.alpha, ids.beta]);
    await expect.poll(() => selected(page)).toEqual([ids.alpha, ids.beta]);

    await page.locator('.block-editor-block-toolbar button[aria-label="Options"]').click();
    await page.getByRole('menuitem', { name: 'Add to selection', exact: true }).click();
    await expect.poll(() => outlined(page)).toEqual([ids.alpha, ids.beta]);
    // Neighbors: WordPress holds them too, and the rail keeps them.
    expect(await selected(page)).toEqual([ids.alpha, ids.beta]);
    await expect(bar(page)).toBeVisible();

    await page.locator('.block-editor-block-toolbar button[aria-label="Options"]').click();
    await page.getByRole('menuitem', { name: 'Remove from selection', exact: true }).click();
    await expect.poll(() => outlined(page)).toEqual([]);
    await expect(bar(page)).toBeHidden();
  });

  test('the item is not offered while the gestures are off: a tool armed, or the Section overview open', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await clickBlock(page, ids.beta);
    await expect.poll(() => selected(page)).toEqual([ids.beta]);
    const items = (menu) => menu.getByRole('menuitem').allTextContents();

    // Control: Select active, the item is there.
    let menu = await openOptionsByKeys(page);
    expect(await items(menu)).toContain('Add to selection');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // A tool armed: no item, and the pin items are unchanged.
    await page.evaluate(() => window.toolrail.setActiveTool('pin:core/heading'));
    await page.locator('.block-editor-block-toolbar button[aria-label="Options"]').click();
    menu = page.locator('.block-editor-block-settings-menu__popover [role="menu"]');
    await expect(menu).toBeVisible();
    let names = await items(menu);
    expect(names).toContain('Unpin from toolbar');
    expect(names).toContain('Save as pattern and pin to toolbar…');
    expect(names).not.toContain('Add to selection');
    expect(names).not.toContain('Remove from selection');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await page.evaluate(() => window.toolrail.setActiveTool('select'));

    // The overview open: the block toolbar is gone under it, but the list
    // view's own Options menu is reachable. No item there.
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    await page.locator('button[aria-label="Document Overview"], button[aria-label="List View"]').first().click();
    await page.locator('.block-editor-list-view-block__menu').first().click();
    menu = page.locator('[role="menu"]').filter({ hasText: 'Duplicate' });
    await expect(menu).toBeVisible();
    names = await items(menu);
    expect(names).toContain('Save as pattern and pin to toolbar…');
    expect(names).not.toContain('Add to selection');
    expect(names).not.toContain('Remove from selection');
    await expect(page.locator('#toolrail-overview')).toBeVisible();
  });
});

test.describe('canvas selection (#14): group actions', () => {
  test('Move down closes the members up and moves them one step, one undo step each; the bar keeps focus, and a second Enter moves again', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await keepWithClicks(page, [ids.alpha, ids.gamma]);
    const before = await serialized(page);

    // Alpha is first, so the set cannot go up; the button says so.
    await expect(barButton(page, 'up')).toHaveAttribute('aria-disabled', 'true');
    await barButton(page, 'down').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => order(page)).toEqual([ids.beta, ids.group, ids.alpha, ids.gamma, ids.omega]);
    await expect.poll(() => liveText(page)).toBe('Moved 2 blocks to position 3 of 5.');
    await expect(barButton(page, 'down')).toBeFocused();
    // From the keyboard the set stays the rail's own, and WordPress's
    // selection and focus are not touched: the next Enter must reach this
    // button again. (When the set was handed to WordPress here, core
    // focused the canvas, and in one browser the second Enter replaced
    // both moved blocks with an empty paragraph.)
    expect(await selected(page)).toEqual([]);
    expect(await outlined(page)).toEqual([ids.alpha, ids.gamma]);
    await expect(barButton(page, 'up')).not.toHaveAttribute('aria-disabled', 'true');

    await page.keyboard.press('Enter');
    await expect.poll(() => order(page)).toEqual([ids.beta, ids.group, ids.omega, ids.alpha, ids.gamma]);
    await expect.poll(() => liveText(page)).toBe('Moved 2 blocks to position 4 of 5.');
    await expect(barButton(page, 'down')).toBeFocused();
    await expect(barButton(page, 'down')).toHaveAttribute('aria-disabled', 'true');
    expect(await order(page)).toHaveLength(5);

    // Escape goes back to the canvas, and the neighbors become the
    // WordPress selection there.
    await page.keyboard.press('Escape');
    await expect.poll(() => selected(page)).toEqual([ids.alpha, ids.gamma]);
    await expect.poll(() => page.evaluate(() => document.activeElement.tagName)).toBe('IFRAME');

    await page.evaluate(() => window.wp.data.dispatch('core/editor').undo());
    await expect.poll(() => order(page)).toEqual([ids.beta, ids.group, ids.alpha, ids.gamma, ids.omega]);
    await page.evaluate(() => window.wp.data.dispatch('core/editor').undo());
    await expect.poll(() => order(page)).toEqual([ids.alpha, ids.beta, ids.gamma, ids.group, ids.omega]);
    expect(await serialized(page)).toBe(before);
  });

  test('a pointer click on Move hands neighbors to WordPress at once', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await keepWithClicks(page, [ids.alpha, ids.gamma]);

    await barButton(page, 'down').click();
    await expect.poll(() => order(page)).toEqual([ids.beta, ids.group, ids.alpha, ids.gamma, ids.omega]);
    await expect.poll(() => selected(page)).toEqual([ids.alpha, ids.gamma]);
    await expect.poll(() => liveText(page)).toBe('Moved 2 blocks to position 3 of 5.');
    // The set stays kept too, so the bar is still there for the next step.
    await expect(bar(page)).toBeVisible();
    expect(await outlined(page)).toEqual([ids.alpha, ids.gamma]);
  });

  test('Move up leaves a locked member where it is, and says so', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await page.evaluate((id) => {
      window.wp.data.dispatch('core/block-editor').updateBlockAttributes(id, { lock: { move: true } });
    }, ids.omega);
    await keepWithClicks(page, [ids.beta, ids.omega]);

    await barButton(page, 'up').click();
    await expect.poll(() => order(page)).toEqual([ids.beta, ids.alpha, ids.gamma, ids.group, ids.omega]);
    await expect.poll(() => liveText(page)).toBe('Moved 1 block to position 1 of 5. 1 locked block stays where it is.');
  });

  test('Duplicate puts the copies after the last member and keeps them selected, in one undo step', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await keepWithClicks(page, [ids.alpha, ids.gamma]);
    const before = await serialized(page);

    await barButton(page, 'duplicate').focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await order(page)).length).toBe(7);
    const after = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlocks().map((b) => String(b.attributes.content || b.name).slice(0, 5)));
    expect(after).toEqual(['ALPHA', 'BETA', 'GAMMA', 'ALPHA', 'GAMMA', 'core/', 'OMEGA']);
    const now = await order(page);
    await expect.poll(() => liveText(page)).toBe('2 blocks duplicated.');
    // The copies are the kept set now, and focus is still on the button.
    await expect.poll(() => outlined(page)).toEqual([now[3], now[4]]);
    await expect(bar(page).locator('.toolrail-csel-count')).toHaveText('2 blocks selected.');
    await expect(barButton(page, 'duplicate')).toBeFocused();
    expect(await selected(page)).toEqual([]);

    // Back in the canvas, the copies (neighbors) are WordPress's selection.
    await page.keyboard.press('Escape');
    await expect.poll(() => selected(page)).toEqual([now[3], now[4]]);
    await expect.poll(() => page.evaluate(() => document.activeElement.tagName)).toBe('IFRAME');

    await page.evaluate(() => window.wp.data.dispatch('core/editor').undo());
    await expect.poll(async () => (await order(page)).length).toBe(5);
    expect(await serialized(page)).toBe(before);
    // The copies are gone, and the kept set with them.
    await expect(bar(page)).toBeHidden();
    await expect.poll(() => outlined(page)).toEqual([]);
  });

  test('Group puts the members in one Group where the first one was, in one undo step', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await keepWithClicks(page, [ids.alpha, ids.gamma]);
    const before = await serialized(page);

    await barButton(page, 'group').click();
    await expect.poll(async () => (await order(page)).length).toBe(4);
    const shape = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlocks().map((b) =>
        b.name + '(' + b.innerBlocks.map((c) => String(c.attributes.content).slice(0, 5)).join(',') + ')'));
    expect(shape[0]).toBe('core/group(ALPHA,GAMMA)');
    expect(shape[1]).toBe('core/paragraph()');
    const now = await order(page);
    // A pointer click: the new Group is handed to WordPress at once, and
    // stays the kept set, so the bar is still there.
    await expect.poll(() => selected(page)).toEqual([now[0]]);
    await expect.poll(() => liveText(page)).toBe('2 blocks grouped.');
    await expect.poll(() => outlined(page)).toEqual([now[0]]);
    await expect(bar(page).locator('.toolrail-csel-count')).toHaveText('1 block selected.');

    await page.evaluate(() => window.wp.data.dispatch('core/editor').undo());
    await expect.poll(() => order(page)).toEqual([ids.alpha, ids.beta, ids.gamma, ids.group, ids.omega]);
    expect(await serialized(page)).toBe(before);
  });

  test('Delete removes the members in one undo step and leaves a locked one, and says so', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await page.evaluate((id) => {
      window.wp.data.dispatch('core/block-editor').updateBlockAttributes(id, { lock: { remove: true } });
    }, ids.omega);
    await keepWithClicks(page, [ids.alpha, ids.gamma, ids.omega]);
    const before = await serialized(page);

    await barButton(page, 'delete').click();
    await expect.poll(() => order(page)).toEqual([ids.beta, ids.group, ids.omega]);
    await expect.poll(() => liveText(page)).toBe('2 blocks deleted. 1 locked block stays where it is.');
    // The locked block is still selected.
    await expect.poll(() => outlined(page)).toEqual([ids.omega]);
    await expect(bar(page).locator('.toolrail-csel-count')).toHaveText('1 block selected.');

    await page.evaluate(() => window.wp.data.dispatch('core/editor').undo());
    await expect.poll(() => order(page)).toEqual([ids.alpha, ids.beta, ids.gamma, ids.group, ids.omega]);
    expect(await serialized(page)).toBe(before);
  });

  test('Clear selection ends the set and returns focus to the canvas', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await keepWithClicks(page, [ids.alpha, ids.gamma]);

    await barButton(page, 'clear').focus();
    await page.keyboard.press('Enter');
    await expect(bar(page)).toBeHidden();
    expect(await outlined(page)).toEqual([]);
    await expect.poll(() => liveText(page)).toBe('Selection cleared.');
    await expect.poll(() => page.evaluate(() => document.activeElement.tagName)).toBe('IFRAME');
    expect(await order(page)).toEqual([ids.alpha, ids.beta, ids.gamma, ids.group, ids.omega]);
  });
});

test.describe('canvas selection (#14): the kept set follows the document and the WordPress selection', () => {
  test('a WordPress selection of several blocks made another way ends the kept set', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await keepWithClicks(page, [ids.alpha, ids.omega]);

    // What a Shift+click in the List View dispatches.
    await page.evaluate((list) => window.wp.data.dispatch('core/block-editor').multiSelect(list[0], list[1]), [ids.beta, ids.gamma]);
    await expect.poll(() => outlined(page)).toEqual([]);
    await expect(bar(page)).toBeHidden();
    expect(await selected(page)).toEqual([ids.beta, ids.gamma]);

    // And core's own Shift+Arrow, from a set the keyboard built. (Clear
    // first: the block toolbar of the selection above covers ALPHA.)
    await page.evaluate(() => window.wp.data.dispatch('core/block-editor').clearSelectedBlock());
    await keepWithKeys(page, ids);
    for (let i = 0; i < 4 && (await selected(page)).length < 2; i++) {
      await page.keyboard.press('Shift+ArrowDown');
      await page.waitForTimeout(150);
    }
    expect((await selected(page)).length).toBeGreaterThan(1);
    await expect.poll(() => outlined(page)).toEqual([]);
    await expect(bar(page)).toBeHidden();
  });

  test('a selection of one block made another way (the List View, an arrow key) leaves the kept set on screen', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await keepWithClicks(page, [ids.alpha, ids.omega]);

    await page.evaluate((id) => window.wp.data.dispatch('core/block-editor').selectBlock(id), ids.gamma);
    await expect.poll(() => selected(page)).toEqual([ids.gamma]);
    expect(await outlined(page)).toEqual([ids.alpha, ids.omega]);
    await expect(bar(page)).toBeVisible();
    await expect(bar(page).locator('.toolrail-csel-count')).toHaveText('2 blocks selected.');
  });

  test('a member that leaves the document is dropped at once, and a replaced document leaves nothing behind', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await keepWithClicks(page, [ids.alpha, ids.gamma, ids.omega]);

    // Another plugin removes one member.
    await page.evaluate((id) => window.wp.data.dispatch('core/block-editor').removeBlocks([id], false), ids.gamma);
    await expect.poll(() => outlined(page)).toEqual([ids.alpha, ids.omega]);
    await expect(bar(page).locator('.toolrail-csel-count')).toHaveText('2 blocks selected.');
    await expect.poll(() => liveText(page)).toBe('2 blocks selected.');

    // The post is switched: every block is replaced.
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([createBlock('core/paragraph', { content: 'OTHER POST' })]);
    });
    await expect(bar(page)).toBeHidden();
    await expect.poll(() => outlined(page)).toEqual([]);
    await expect.poll(() => liveText(page)).toBe('Selection cleared.');
    expect(errors).toEqual([]);
  });

  test('members that become neighbors are handed to WordPress', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await keepWithClicks(page, [ids.alpha, ids.gamma]);

    await page.evaluate((id) => window.wp.data.dispatch('core/block-editor').removeBlocks([id], false), ids.beta);
    await expect.poll(() => selected(page)).toEqual([ids.alpha, ids.gamma]);
    await expect.poll(() => outlined(page)).toEqual([]);
    await expect(bar(page)).toBeHidden();
  });

  test('undo that removes a member drops it from the kept set', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const key = await toggleKey(page);
    const added = await page.evaluate(() => {
      const block = window.wp.blocks.createBlock('core/paragraph', { content: 'ADDED' });
      // Second in the document, not last: at the default viewport the
      // last block sits under the selection bar, and a click there would
      // press the bar.
      window.wp.data.dispatch('core/block-editor').insertBlocks([block], 1, '', false);
      return block.clientId;
    });
    await expect(canvas(page).locator('#block-' + added)).toBeVisible();
    await clickBlock(page, ids.alpha);
    await clickBlock(page, ids.gamma, [key]);
    await clickBlock(page, added, [key]);
    await expect.poll(() => outlined(page)).toEqual([ids.alpha, added, ids.gamma]);

    await page.evaluate(() => window.wp.data.dispatch('core/editor').undo());
    await expect.poll(async () => (await order(page)).length).toBe(5);
    await expect.poll(() => outlined(page)).toEqual([ids.alpha, ids.gamma]);
    await expect(bar(page).locator('.toolrail-csel-count')).toHaveText('2 blocks selected.');

    // Delete acts on the two that exist, never on the one that is gone.
    await barButton(page, 'delete').click();
    await expect.poll(() => order(page)).toEqual([ids.beta, ids.group, ids.omega]);
    await expect.poll(() => liveText(page)).toBe('2 blocks deleted.');
  });

  test('the code editor ends the kept set, and the visual editor comes back clean', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await keepWithClicks(page, [ids.alpha, ids.gamma]);

    // No message from the rail here: core announces the editor it
    // switched to, and the two would replace each other.
    await page.evaluate(() => window.wp.data.dispatch('core/editor').switchEditorMode('text'));
    await expect(bar(page)).toBeHidden();
    await page.evaluate(() => window.wp.data.dispatch('core/editor').switchEditorMode('visual'));
    await expect(canvas(page).locator('.is-root-container')).toBeVisible();
    await expect.poll(() => outlined(page)).toEqual([]);
    await expect(bar(page)).toBeHidden();
    await expect(page.locator('#toolrail-rail')).toBeVisible();
  });

  test('the Section overview ends the kept set, and its own selection starts empty', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await keepWithClicks(page, [ids.alpha, ids.gamma]);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    await expect(bar(page)).toBeHidden();
    // Read through the editor document here, not through a frame locator:
    // with the overview open, a frame-locator read took most of this
    // test's 30 s in one browser (29.3 s for the test, 2026-11-14).
    await expect.poll(() => page.evaluate((attr) => {
      const doc = document.querySelector('iframe[name="editor-canvas"]').contentDocument;
      return doc.querySelectorAll('[' + attr + ']').length;
    }, ATTR)).toBe(0);
    await expect(page.locator('#toolrail-overview .toolrail-ov-box.is-selected')).toHaveCount(0);
  });

  test('the outline comes back when the editor makes a member\'s element again', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await keepWithClicks(page, [ids.alpha, ids.omega]);

    // Moving a block into another parent makes React build a new element
    // for it, which starts without the rail's attribute.
    await page.evaluate((list) => {
      window.wp.data.dispatch('core/block-editor').moveBlocksToPosition([list[0]], '', list[1], 0);
    }, [ids.alpha, ids.group]);
    await expect.poll(() => page.evaluate((id) =>
      window.wp.data.select('core/block-editor').getBlockRootClientId(id), ids.alpha)).toBe(ids.group);
    await expect.poll(() => outlined(page)).toEqual([ids.alpha, ids.omega]);
    await expect(bar(page)).toBeVisible();
  });
});

test.describe('canvas selection (#14): outlines and the post', () => {
  test('the outline takes no pointer events, survives forced colors, reduced motion and the tablet preview, and nothing enters the post', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    const before = await serialized(page);
    const dirtyBefore = await page.evaluate(() => window.wp.data.select('core/editor').isEditedPostDirty());
    await keepWithClicks(page, [ids.alpha, ids.gamma]);

    expect(await serialized(page)).toBe(before);
    expect(await page.evaluate(() => window.wp.data.select('core/editor').isEditedPostDirty())).toBe(dirtyBefore);
    // Nothing of the rail's is in the canvas body except the attribute:
    // the element under a member's middle is the member.
    const hit = await canvas(page).locator('body').evaluate((body, id) => {
      const doc = body.ownerDocument;
      const el = doc.getElementById('block-' + id);
      const r = el.getBoundingClientRect();
      const at = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { same: el === at || el.contains(at), foreign: doc.querySelectorAll('[id^="toolrail-"]:not(style)').length };
    }, ids.gamma);
    expect(hit).toEqual({ same: true, foreign: 0 });

    const outlineOf = (id) => canvas(page).locator('body').evaluate((body, blockId) => {
      const cs = body.ownerDocument.defaultView.getComputedStyle(body.ownerDocument.getElementById('block-' + blockId));
      return cs.outlineStyle + ' ' + cs.outlineWidth;
    }, id);
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    expect(await outlineOf(ids.alpha)).toBe('dashed 2px');
    expect(await outlineOf(ids.beta)).not.toContain('dashed');
    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });

    await page.evaluate(() => window.wp.data.dispatch('core/editor').setDeviceType('Tablet'));
    await expect.poll(async () => (await page.locator('iframe[name="editor-canvas"]').boundingBox()).width).toBeLessThan(900);
    await expect.poll(() => outlined(page)).toEqual([ids.alpha, ids.gamma]);
    expect(await outlineOf(ids.gamma)).toBe('dashed 2px');
    await expect(bar(page)).toBeVisible();
    await page.evaluate(() => window.wp.data.dispatch('core/editor').setDeviceType('Desktop'));
  });

  test('a rectangle in the tablet preview is drawn where the pointer is and selects what it touches', async ({ page }) => {
    await openNewPost(page);
    const ids = await seedCanvas(page);
    await page.evaluate(() => window.wp.data.dispatch('core/editor').setDeviceType('Tablet'));
    await expect.poll(async () => (await page.locator('iframe[name="editor-canvas"]').boundingBox()).width).toBeLessThan(900);
    await page.waitForTimeout(400);
    const alpha = await boxOf(page, ids.alpha);
    const beta = await boxOf(page, ids.beta);
    const x = await marginX(page, ids.alpha);

    await drag(page, { x, y: alpha.top - 4 }, { x: alpha.left + 120, y: beta.top + beta.height / 2 }, { hold: true });
    await expect(page.locator('#toolrail-canvas-marquee')).toBeVisible();
    const rect = await page.locator('#toolrail-canvas-marquee').boundingBox();
    expect(Math.abs(rect.x - x)).toBeLessThan(3);
    expect(Math.abs(rect.x + rect.width - (alpha.left + 120))).toBeLessThan(3);
    await page.mouse.up();
    await expect.poll(() => selected(page)).toEqual([ids.alpha, ids.beta]);
    await page.evaluate(() => window.wp.data.dispatch('core/editor').setDeviceType('Desktop'));
  });
});
