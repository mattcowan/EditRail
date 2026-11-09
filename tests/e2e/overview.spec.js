/**
 * EditRail — Section overview spec.
 *
 * The Section overview: boxes, selection, moves, drill-in, drag, and
 * late canvas changes.
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const {
  AUTH,
  openNewPost,
  canvas,
  blockNames,
  seedOverviewBlocks,
} = require('./helpers');

test.use({ storageState: AUTH });

function overviewBoxButton(page, clientId, action) {
  return page.locator(
    `#toolrail-overview .toolrail-ov-box[data-clientid="${clientId}"] [data-ov-action="${action}"]`
  );
}

/** Seed six flat paragraphs P-A..P-F for the multi-select specs
    (issue #21). lockSecond gives P-B a movement lock. Unsaved editor
    state only — nothing is ever saved (the standing rule). */
async function seedOverviewParagraphs(page, lockSecond) {
  await page.evaluate((lockIt) => {
    const { createBlock } = window.wp.blocks;
    window.wp.data.dispatch('core/block-editor').resetBlocks(
      ['P-A', 'P-B', 'P-C', 'P-D', 'P-E', 'P-F'].map((content, i) =>
        createBlock('core/paragraph', i === 1 && lockIt
          ? { content, lock: { move: true, remove: false } }
          : { content })
      )
    );
  }, !!lockSecond);
  await expect.poll(async () => (await blockNames(page)).length).toBe(6);
}

/** Top-level paragraph contents in document order — the assertion
    surface for group moves. */
function overviewContents(page) {
  return page.evaluate(() => {
    const sel = window.wp.data.select('core/block-editor');
    return sel.getBlockOrder('').map((id) => String(sel.getBlockAttributes(id).content));
  });
}

function ovAnnouncement(page) {
  return page.evaluate(() => {
    const region = document.getElementById('a11y-speak-polite');
    return region ? region.textContent : '';
  });
}

function ovSelectedBoxes(page) {
  return page.locator('#toolrail-overview .toolrail-ov-box.is-selected');
}

test.describe('section overview (R6)', () => {
  test('the Overview tool zooms a tall document fully into view with chips in document order; closing restores everything', async ({ page }) => {
    await openNewPost(page);

    // A document several viewports tall, made of a few LARGE sections —
    // the shape the fit-the-whole-document zoom exists for. (A long run
    // of bare paragraphs deliberately does NOT fully fit any more: the
    // content-derived floor refuses to shrink the median block below a
    // usable size, and panning covers the rest — pinned by the
    // zoom-floor test below.)
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 4 }, (_, s) =>
          createBlock('core/group', {},
            Array.from({ length: 8 }, (_, i) =>
              createBlock('core/paragraph', { content: 'S' + s + '-PARA-' + i })
            ))
        )
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(4);

    const tool = page.locator('#toolrail-rail [data-tool="overview"]');
    await tool.click();

    await expect(page.locator('#toolrail-overview')).toBeVisible();
    await expect(tool).toHaveAttribute('aria-pressed', 'true');

    // The mode names itself and offers a labeled exit (plus the Esc
    // hint) — the "am I in a modal?" affordances.
    await expect(page.locator('#toolrail-overview .toolrail-ov-title')).toHaveText('Section overview');
    await expect(page.locator('#toolrail-overview [data-ov-action="close"]')).toHaveText('Done');
    await expect(page.locator('#toolrail-overview .toolrail-ov-esc')).toHaveText('Esc exits');

    // The point of the zoom: the LAST block of a 30-block document is on
    // screen. (Behavior, not mechanism — the scale/height plumbing can
    // change; a below-the-fold document may not.)
    await expect.poll(async () => page.evaluate(() => {
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const blocks = frame.contentDocument.querySelectorAll('[data-block]');
      const last = blocks[blocks.length - 1];
      const r = last.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      const k = f.width / frame.offsetWidth;
      return f.top + (r.top + r.height) * k <= window.innerHeight + 1;
    })).toBe(true);

    // One outline box per top-level block, box DOM order = document order.
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const boxIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#toolrail-overview .toolrail-ov-box')).map(
        (c) => c.dataset.clientid
      )
    );
    expect(boxIds).toEqual(ids);

    // Toggle off: overlay gone, pressed off, the canvas handed back —
    // no scale host left stamped, and the iframe scrolls internally
    // again (the document is taller than its restored viewport).
    await tool.click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    await expect(tool).toHaveAttribute('aria-pressed', 'false');
    const restored = await page.evaluate(() => {
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const html = frame.contentDocument.documentElement;
      return {
        scaleHosts: document.querySelectorAll('.toolrail-ov-scale-host').length,
        internallyScrollable: html.scrollHeight > html.clientHeight + 1,
      };
    });
    expect(restored.scaleHosts).toBe(0);
    expect(restored.internallyScrollable).toBe(true);
  });

  test('picking a box reveals its controls; a move announces and keeps focus on that box', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();

    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    // At rest: outlines and corner tags only — NO controls anywhere.
    // The always-on bars this replaces obscured the content (owner
    // feedback 2026-08-27, post 446).
    await expect(page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])')).toHaveCount(0);

    await overviewBoxButton(page, ids[0], 'pick').click();
    await expect(page.locator(
      `#toolrail-overview .toolrail-ov-box[data-clientid="${ids[0]}"] .toolrail-ov-controls`
    )).toBeVisible();
    // One box's controls at a time.
    await expect(page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])')).toHaveCount(1);

    await overviewBoxButton(page, ids[0], 'down').click();

    // ALPHA (a paragraph) moved below the group.
    await expect.poll(async () => await blockNames(page)).toEqual([
      'core/group',
      'core/paragraph',
      'core/paragraph',
    ]);

    // Announced through wp.a11y's persistent live region, with the real
    // position — never a visual-only reorder.
    await expect.poll(async () => page.evaluate(() => {
      const region = document.getElementById('a11y-speak-polite');
      return region ? region.textContent : '';
    })).toContain('Moved Paragraph to position 2 of 3.');

    // The rebuild keeps the box selected with focus on its own button
    // (the settings-arrows contract) — a keyboard user is never dropped.
    const focus = await page.evaluate(() => ({
      action: document.activeElement.dataset ? document.activeElement.dataset.ovAction : null,
      box: document.activeElement.closest
        ? (document.activeElement.closest('.toolrail-ov-box') || {}).dataset
        : null,
    }));
    expect(focus.action).toBe('down');
    expect(focus.box.clientid).toBe(ids[0]);
  });

  test('Shift+click selects a range, Ctrl+click toggles, Alt+click removes — each announced with the count (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    await overviewBoxButton(page, ids[0], 'pick').click();
    await expect(ovSelectedBoxes(page)).toHaveCount(1);

    // Shift+click the third box: the whole A..C range.
    await overviewBoxButton(page, ids[2], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(3);
    await expect.poll(async () => ovAnnouncement(page)).toContain('3 blocks selected.');
    // The disclosure follows the range's end and acts for the group.
    await expect(page.locator(
      `#toolrail-overview .toolrail-ov-box[data-clientid="${ids[2]}"] .toolrail-ov-controls`
    )).toBeVisible();
    await expect(page.locator(
      `#toolrail-overview .toolrail-ov-box[data-clientid="${ids[2]}"] .toolrail-ov-label`
    )).toHaveText('3 blocks selected');

    // Ctrl+click adds a detached box…
    await overviewBoxButton(page, ids[4], 'pick').click({ modifiers: ['Control'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(4);
    await expect.poll(async () => ovAnnouncement(page)).toContain('4 blocks selected.');

    // …and Alt+click removes one.
    await overviewBoxButton(page, ids[0], 'pick').click({ modifiers: ['Alt'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(3);
    await expect.poll(async () => ovAnnouncement(page)).toContain('3 blocks selected.');

    // A plain click collapses the multi-selection back to one box.
    await overviewBoxButton(page, ids[1], 'pick').click();
    await expect(ovSelectedBoxes(page)).toHaveCount(1);
  });

  test('a drag on empty overlay space draws a marquee that selects the boxes it touches; a plain empty click still clears (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const boxSel = (id) => page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${id}"]`);
    const lastBox = await boxSel(ids[5]).boundingBox();
    const targetBox = await boxSel(ids[4]).boundingBox();
    const overlayBox = await page.locator('#toolrail-overview').boundingBox();

    // Start on EMPTY overlay space below the last box, then draw up
    // through the last two boxes.
    const startX = overlayBox.x + overlayBox.width / 2;
    const startY = Math.min(lastBox.y + lastBox.height + 40, overlayBox.y + overlayBox.height - 8);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, targetBox.y + targetBox.height / 2, { steps: 8 });
    // The rectangle is visible while the drag is live.
    await expect(page.locator('#toolrail-overview .toolrail-ov-marquee')).toBeVisible();
    await page.mouse.up();

    await expect(ovSelectedBoxes(page)).toHaveCount(2);
    await expect.poll(async () => ovAnnouncement(page)).toContain('2 blocks selected.');

    // A sub-threshold click on the same empty spot clears everything —
    // today's behavior, kept.
    await page.mouse.click(startX, startY);
    await expect(ovSelectedBoxes(page)).toHaveCount(0);
    await expect(page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])')).toHaveCount(0);
  });

  test('the arrows move a contiguous group as one step, announced with the count, focus kept (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, ids[1], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);

    await overviewBoxButton(page, ids[1], 'down').click();

    // A and B stepped together past C.
    await expect.poll(async () => overviewContents(page)).toEqual(['P-C', 'P-A', 'P-B', 'P-D', 'P-E', 'P-F']);
    await expect.poll(async () => ovAnnouncement(page)).toContain('Moved 2 blocks to position 2 of 6.');

    // The group stays selected and focus stays on the arrow that moved
    // it (the settings-arrows contract).
    await expect(ovSelectedBoxes(page)).toHaveCount(2);
    const focus = await page.evaluate(() => ({
      action: document.activeElement.dataset ? document.activeElement.dataset.ovAction : null,
      box: document.activeElement.closest
        ? (document.activeElement.closest('.toolrail-ov-box') || {}).dataset
        : null,
    }));
    expect(focus.action).toBe('down');
    expect(focus.box.clientid).toBe(ids[1]);
  });

  test('a non-contiguous selection lands contiguous, in document order (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, ids[2], 'pick').click({ modifiers: ['Control'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);

    await overviewBoxButton(page, ids[2], 'down').click();

    // A and C left their gaps, compacted, and stepped past D together.
    await expect.poll(async () => overviewContents(page)).toEqual(['P-B', 'P-D', 'P-A', 'P-C', 'P-E', 'P-F']);
    await expect.poll(async () => ovAnnouncement(page)).toContain('Moved 2 blocks to position 3 of 6.');
  });

  test('dragging any selected box moves the whole group to the drop line (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, ids[1], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);

    const firstBox = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[0]}"]`).boundingBox();
    const lastBox = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[5]}"]`).boundingBox();
    await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstBox.x + firstBox.width / 2, lastBox.y + lastBox.height + 20, { steps: 10 });
    await page.mouse.up();

    // The whole group landed at the end, order kept.
    await expect.poll(async () => overviewContents(page)).toEqual(['P-C', 'P-D', 'P-E', 'P-F', 'P-A', 'P-B']);
    await expect.poll(async () => ovAnnouncement(page)).toContain('Moved 2 blocks to position 5 of 6.');
  });

  test('a locked block shows its lock, stays put when its group moves, and the announcement says so (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page, true);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    // The movement-locked box is annotated at rest — dashed outline
    // class and a "Locked" corner tag (plan review 2026-08-31).
    const lockedBox = page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[1]}"]`);
    await expect(lockedBox).toHaveClass(/is-locked/);
    await expect(lockedBox.locator('.toolrail-ov-locktag')).toContainText('Locked');

    // Selecting it is allowed; the count says up front what cannot move.
    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, ids[1], 'pick').click({ modifiers: ['Shift'] });
    await expect.poll(async () => ovAnnouncement(page)).toContain('2 blocks selected. 1 is locked and cannot move.');

    // The lock marker SURVIVES selection — it is the state the group
    // arrow is about to act on, so hiding it there was exactly
    // backwards (MR review 2026-08-31, finding 2). Before the fix the
    // badge lived inside the name tag, which is display:none while a
    // box is selected.
    await expect(lockedBox).toHaveClass(/is-selected/);
    await expect(lockedBox.locator('.toolrail-ov-locktag')).toBeVisible();

    await overviewBoxButton(page, ids[1], 'down').click();

    // ONE press moves the movable member exactly ONE row: P-A steps
    // past locked P-B, which stays exactly where it was.
    //
    // This expectation moved with the finding-3 fix, and the intent is
    // unchanged — only the arithmetic the arrow uses. The step used to
    // be measured from the last MEMBER, so a locked member at the end
    // of the selection made the first press jump TWO rows (P-A over
    // both P-B and P-C) and every press after it jump one. Measured
    // from the last MOVABLE member it is one row every time.
    await expect.poll(async () => overviewContents(page)).toEqual(['P-B', 'P-A', 'P-C', 'P-D', 'P-E', 'P-F']);
    await expect.poll(async () => ovAnnouncement(page)).toContain('stays where it is.');

    // Pressing again steps one more row — the cadence is now uniform.
    // The group's strip stays anchored to the ACTIVE box (P-B, the one
    // the range click landed on), so that is where the arrow lives —
    // P-A is a member, but a member without the disclosure open.
    await expect(page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])')).toHaveCount(1);
    await overviewBoxButton(page, ids[1], 'down').click();
    await expect.poll(async () => overviewContents(page)).toEqual(['P-B', 'P-C', 'P-A', 'P-D', 'P-E', 'P-F']);
  });

  /**
   * The picked box's reorder strip is about 213x58px and lives inside
   * the box. When the boxes are NARROW — a theme that sizes a one-line
   * paragraph to its content — the strip spills out of its own box and
   * over the next one, swallowing that box's pick button: the four
   * multi-select specs above then time out on an intercepted
   * Shift+click. That is what happened on the test site (QA 2026-09-18).
   *
   * The width is forced here rather than left to the theme, so the
   * spec pins the geometry rule on any site. The second half is the
   * CONTROL: with wide boxes the strip must stay exactly where it
   * always was, or this fix would have moved every strip on every
   * ordinary document.
   */
  test('the reorder strip moves aside when it would cover the next box, and stays inside when it would not (QA 2026-09-18)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);

    const forceWidth = (css) => canvas(page).locator('body').evaluate((body, rule) => {
      const doc = body.ownerDocument;
      let style = doc.getElementById('e2e-box-width');
      if (!style) {
        style = doc.createElement('style');
        style.id = 'e2e-box-width';
        doc.head.appendChild(style);
      }
      style.textContent = '.is-root-container > [data-block] {' + rule + '}';
    }, css);

    // --- Narrow: the strip cannot fit inside its own box. ---
    await forceWidth('width: 90px !important; max-width: 90px !important;');
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    await overviewBoxButton(page, ids[0], 'pick').click();

    const strip = page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])');
    await expect(strip).toHaveCount(1);
    expect(await strip.getAttribute('data-placement')).not.toBe('inside');

    // What the failing specs actually needed: the NEXT box's pick
    // button is the element at its own center, so a click reaches it.
    const atCenter = await page.evaluate((id) => {
      const btn = document.querySelector(
        '#toolrail-overview .toolrail-ov-box[data-clientid="' + id + '"] [data-ov-action="pick"]'
      );
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === btn;
    }, ids[1]);
    expect(atCenter).toBe(true);

    // And the gesture that used to time out completes.
    await overviewBoxButton(page, ids[1], 'pick').click({ modifiers: ['Shift'], timeout: 5000 });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);

    // --- Control: wide boxes keep the strip where it has always been. ---
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    await forceWidth('min-width: 620px !important;');
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await overviewBoxButton(page, ids[0], 'pick').click();
    const wideStrip = page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])');
    await expect(wideStrip).toHaveCount(1);
    expect(await wideStrip.getAttribute('data-placement')).toBe('inside');
  });

  /**
   * Code review 2026-09-22, finding 1. Each selected box sets z-index: 1
   * and so is its own stacking context; the strip's z-index counts only
   * inside its box. When the active box has a selected member directly
   * below it — pick P-B, then Shift+click P-A: the clicked box becomes
   * active, and a marquee makes the topmost member active too — that
   * later member painted over the whole active box, strip included.
   * When the strip stays inside (a wide box, a partial overlap) the
   * lower half of the arrows then sat under that member's pick button,
   * and a click picked it and collapsed the group.
   *
   * Tight margins force the overlap on any theme, and the preconditions
   * are asserted so the test cannot pass on a layout with no overlap.
   */
  test('the active box\'s strip paints above a later selected member it overlaps (review 2026-09-22)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await canvas(page).locator('body').evaluate((body) => {
      const style = body.ownerDocument.createElement('style');
      style.textContent = '.is-root-container > [data-block] {'
        + ' min-width: 620px !important; margin-top: 4px !important; margin-bottom: 0 !important; }';
      body.ownerDocument.head.appendChild(style);
    });
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    await overviewBoxButton(page, ids[1], 'pick').click();
    await overviewBoxButton(page, ids[0], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);

    const probe = await page.evaluate((id1) => {
      const strip = document.querySelector('#toolrail-overview .toolrail-ov-controls:not([hidden])');
      const next = document.querySelector('#toolrail-overview .toolrail-ov-box[data-clientid="' + id1 + '"]');
      const s = strip.getBoundingClientRect();
      const n = next.getBoundingClientRect();
      const overlaps = s.bottom > n.top && s.top < n.bottom && s.right > n.left && s.left < n.right;
      // Every enabled strip button must be the element at its own
      // center AND just above its bottom edge — the part that overlaps.
      // The box-to-box overlap above is not enough on its own: on a
      // theme with taller paragraphs only the strip's bottom padding
      // reaches the next box, and then no sampled point lands on it and
      // the test would pass with the fix reverted. So count the points
      // that fall inside the next box, and the buttons checked.
      const buried = [];
      let checked = 0;
      let pointsInNext = 0;
      strip.querySelectorAll('button:not([disabled])').forEach((btn) => {
        checked += 1;
        const r = btn.getBoundingClientRect();
        [r.top + r.height / 2, r.bottom - 2].forEach((y) => {
          const x = r.left + r.width / 2;
          if (x > n.left && x < n.right && y > n.top && y < n.bottom) {
            pointsInNext += 1;
          }
          const hit = document.elementFromPoint(x, y);
          if (!hit || !(hit === btn || btn.contains(hit))) {
            buried.push(btn.dataset.ovAction + '@' + Math.round(y) + ' -> ' + (hit ? hit.className : 'null'));
          }
        });
      });
      return {
        placement: strip.dataset.placement,
        activeBox: strip.closest('.toolrail-ov-box').dataset.clientid,
        belowIsSelected: next.classList.contains('is-selected'),
        overlaps,
        checked,
        pointsInNext,
        buried,
      };
    }, ids[1]);

    // Preconditions: the reviewer's case, not some easier one.
    expect(probe.placement).toBe('inside');
    expect(probe.activeBox).toBe(ids[0]);
    expect(probe.belowIsSelected).toBe(true);
    expect(probe.overlaps).toBe(true);
    expect(probe.checked).toBeGreaterThan(0);
    expect(probe.pointsInNext).toBeGreaterThan(0);
    // The claim.
    expect(probe.buried).toEqual([]);
  });

  test('a group selection marks every member with a shape, not a colour shift (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, ids[2], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(3);

    // Only the ACTIVE member shows a controls strip; the other two
    // carried nothing but a border hue shift measuring 1.68:1, under
    // 1.4.11's 3:1 for a state indicator — and forced colours flatten
    // every box's border to Highlight, erasing even that (MR review
    // 2026-08-31, finding 1). Every member now carries a mark of its
    // own, so the state does not depend on colour at all.
    await expect(page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])')).toHaveCount(1);
    await expect(page.locator('#toolrail-overview .toolrail-ov-box.is-selected .toolrail-ov-selectmark')).toHaveCount(3);
    for (const id of [ids[0], ids[1], ids[2]]) {
      await expect(page.locator(
        `#toolrail-overview .toolrail-ov-box[data-clientid="${id}"] .toolrail-ov-selectmark`
      )).toBeVisible();
    }
    // Control: an unselected box's mark stays hidden, so the assertion
    // above is really tracking selection and not just "the node exists".
    await expect(page.locator(
      `#toolrail-overview .toolrail-ov-box[data-clientid="${ids[4]}"] .toolrail-ov-selectmark`
    )).toBeHidden();
  });

  test('"Reorder inside" is unavailable while several blocks are selected (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const groupId = ids[1];

    // Control: picked on its own, the group's "Reorder inside" is live —
    // so the disabled assertion below is really about the selection.
    await overviewBoxButton(page, groupId, 'pick').click();
    await expect(overviewBoxButton(page, groupId, 'enter')).toBeEnabled();

    // Add the paragraph before it to the selection, keeping the group
    // as the active box. Stepping INTO a section is a single-block
    // action — the root change would clear the selection the author
    // just built, and "inside which of them?" has no answer (owner
    // decision 2026-09-01).
    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, groupId, 'pick').click({ modifiers: ['Control'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);
    await expect(overviewBoxButton(page, groupId, 'enter')).toBeDisabled();

    // In group mode the button's NAME is group-scoped too, like both
    // arrows — a browse-mode pass must not read "2 blocks selected",
    // two group-scoped arrows, then a single-block "Reorder inside".
    // The visible text still leads the name (WCAG 2.5.3).
    await expect(overviewBoxButton(page, groupId, 'enter'))
      .toHaveAttribute('aria-label', 'Reorder inside — not available while 2 blocks are selected');

    // Dropping back to one block restores it. Alt+click removes the
    // paragraph and leaves the group both selected and active — a
    // plain click on the active box is the disclosure toggle, which
    // closes the strip altogether.
    await overviewBoxButton(page, ids[0], 'pick').click({ modifiers: ['Alt'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(1);
    await expect(overviewBoxButton(page, groupId, 'enter')).toBeEnabled();
    await expect(overviewBoxButton(page, groupId, 'enter'))
      .toHaveAttribute('aria-label', /^Reorder inside Group/);
  });

  test('every root change that drops a group selection says so (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const topIds = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const groupId = topIds[1];

    // Drill in, then select both children.
    const drillIn = async () => {
      await overviewBoxButton(page, groupId, 'pick').click();
      await overviewBoxButton(page, groupId, 'enter').click();
      await expect(page.locator('#toolrail-overview .toolrail-ov-box')).toHaveCount(2);
      return page.evaluate((gid) =>
        window.wp.data.select('core/block-editor').getBlockOrder(gid), groupId
      );
    };
    let innerIds = await drillIn();

    // Control first: a root change with only ONE box picked is the
    // ordinary case and must stay quiet, or the assertions below would
    // pass for the wrong reason.
    await overviewBoxButton(page, innerIds[0], 'pick').click();
    await page.locator('#toolrail-overview [data-ov-action="up-level"]').click();
    await expect.poll(async () => ovAnnouncement(page)).toContain('Viewing all sections');
    expect(await ovAnnouncement(page)).not.toContain('Selection cleared');

    // Door 1 — "Up one level" with a group selected.
    innerIds = await drillIn();
    await overviewBoxButton(page, innerIds[0], 'pick').click();
    await overviewBoxButton(page, innerIds[1], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);
    await page.locator('#toolrail-overview [data-ov-action="up-level"]').click();
    await expect(ovSelectedBoxes(page)).toHaveCount(0);
    await expect.poll(async () => ovAnnouncement(page)).toContain('Selection cleared.');

    // Door 2 — a breadcrumb with a group selected.
    innerIds = await drillIn();
    await overviewBoxButton(page, innerIds[0], 'pick').click();
    await overviewBoxButton(page, innerIds[1], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);
    await page.locator('#toolrail-overview [data-ov-action="crumb"]').first().click();
    await expect(ovSelectedBoxes(page)).toHaveCount(0);
    await expect.poll(async () => ovAnnouncement(page)).toContain('Selection cleared.');

    // Door 3 — the forced climb when the drilled-into block is deleted
    // out from under the author. The review named the first two; this
    // one reaches the same drillTo and was never guarded either.
    innerIds = await drillIn();
    await overviewBoxButton(page, innerIds[0], 'pick').click();
    await overviewBoxButton(page, innerIds[1], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);
    await page.evaluate((gid) =>
      window.wp.data.dispatch('core/block-editor').removeBlock(gid), groupId
    );
    // One composed announcement: the reason, the new level, and the
    // selection — wp.a11y.speak replaces the region, so they cannot race.
    await expect.poll(async () => ovAnnouncement(page)).toContain('was removed.');
    expect(await ovAnnouncement(page)).toContain('Selection cleared.');
  });

  test('a locked member at the document edge does not kill an arrow whose move is legal (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    // Lock the LAST block, so a selection containing it sits against
    // the end of the document.
    await page.evaluate(() => {
      const sel = window.wp.data.select('core/block-editor');
      const ids = sel.getBlockOrder('');
      window.wp.data.dispatch('core/block-editor').updateBlockAttributes(
        ids[5], { lock: { move: true, remove: false } }
      );
    });
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    // Guard the guard: core must genuinely refuse to move P-F, or this
    // proves nothing.
    const refused = await page.evaluate((id) => {
      const sel = window.wp.data.select('core/block-editor');
      return typeof sel.canMoveBlocks === 'function' ? !sel.canMoveBlocks([id], '') : null;
    }, ids[5]);
    test.skip(refused === null, 'canMoveBlocks is not on this WordPress');
    expect(refused).toBe(true);

    // Select P-D (movable, index 3) and the locked P-F (index 5).
    await overviewBoxButton(page, ids[3], 'pick').click();
    await overviewBoxButton(page, ids[5], 'pick').click({ modifiers: ['Control'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);

    // The down arrow was disabled because the LAST member sat at the
    // document end — but the movable member has a legal move, and the
    // engine performs it correctly when asked (MR review 2026-08-31,
    // finding 3). Enabled now, and the click really moves.
    const down = overviewBoxButton(page, ids[5], 'down');
    await expect(down).toBeEnabled();
    await down.click();

    // P-D stepped past P-E; the locked P-F never moved.
    await expect.poll(async () => overviewContents(page)).toEqual(['P-A', 'P-B', 'P-C', 'P-E', 'P-D', 'P-F']);
    await expect.poll(async () => ovAnnouncement(page)).toContain('stays where it is.');
  });

  test('Shift+ArrowDown extends the selection from the focused box; Ctrl+Space toggles it (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    await overviewBoxButton(page, ids[0], 'pick').focus();
    await page.keyboard.press('Shift+ArrowDown');
    await expect(ovSelectedBoxes(page)).toHaveCount(2);
    await expect.poll(async () => ovAnnouncement(page)).toContain('2 blocks selected.');
    // Focus followed the extension to the neighbor's pick button.
    const focus = await page.evaluate(() => ({
      action: document.activeElement.dataset ? document.activeElement.dataset.ovAction : null,
      box: document.activeElement.closest
        ? (document.activeElement.closest('.toolrail-ov-box') || {}).dataset
        : null,
    }));
    expect(focus.action).toBe('pick');
    expect(focus.box.clientid).toBe(ids[1]);

    // Ctrl+Space toggles the focused box back out (and must not open
    // its disclosure — Space alone would).
    await page.keyboard.press('Control+ ');
    await expect(ovSelectedBoxes(page)).toHaveCount(1);
    await expect.poll(async () => ovAnnouncement(page)).toContain('1 block selected.');
  });

  test('Escape exits the overview in one press, even with a selection open (owner decision 2026-09-01)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, ids[2], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(3);

    // ONE press leaves, exactly as "Done" does — which is what the
    // bar's "Esc exits" hint has always promised. Neither the open
    // selection nor the open controls strip buys an extra rung.
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('overview');
    await expect.poll(async () => ovAnnouncement(page)).toContain('Section overview closed.');
  });

  test('Escape cancels an in-flight drag instead of exiting, and says which happened (owner decision 2026-09-01)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const before = await overviewContents(page);

    // Start a real drag and cross the threshold.
    const firstBox = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[0]}"]`).boundingBox();
    const lastBox = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[5]}"]`).boundingBox();
    await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstBox.x + firstBox.width / 2, lastBox.y + lastBox.height / 2, { steps: 10 });
    await expect(page.locator('#toolrail-overview .toolrail-ov-dropline')).toBeVisible();

    // Escape abandons the DRAG and keeps the mode. This rung is not a
    // nicety: the mouseup below is still armed, and exiting instead
    // would let it commit the very move being abandoned.
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    await expect(page.locator('#toolrail-overview .toolrail-ov-dropline')).toHaveCount(0);
    // The quiet outcome announces, and says what the next press does —
    // with only two outcomes, silence would leave a screen-reader user
    // unable to tell whether they had left the mode.
    await expect.poll(async () => ovAnnouncement(page)).toContain('Move canceled.');
    expect(await ovAnnouncement(page)).toContain('Press Escape again to close the overview.');

    await page.mouse.up();
    // Nothing moved, by the release or by the cancel.
    expect(await overviewContents(page)).toEqual(before);

    // And the next press exits, as the announcement said.
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
  });

  test('a canceled drag released back on its own box does not toggle that box (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    // Nothing selected to begin with.
    await expect(ovSelectedBoxes(page)).toHaveCount(0);

    const box = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[0]}"]`).boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Press, drag past the threshold, Escape, then bring the pointer
    // BACK to the originating button and release there. The click the
    // browser then fires targets that button, because it is the
    // common ancestor of the press and the release.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 120, { steps: 8 });
    await expect(page.locator('#toolrail-overview .toolrail-ov-dropline')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.poll(async () => ovAnnouncement(page)).toContain('Move canceled.');
    await page.mouse.move(cx, cy, { steps: 6 });
    await page.mouse.up();

    // A canceled gesture has NO follow-on action: the box must not
    // have picked itself and opened its controls after the cancel was
    // already announced.
    await expect(ovSelectedBoxes(page)).toHaveCount(0);
    await expect(page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])')).toHaveCount(0);

    // Control: a plain click on that same button still works, so the
    // latch released instead of deadening the box.
    await overviewBoxButton(page, ids[0], 'pick').click();
    await expect(ovSelectedBoxes(page)).toHaveCount(1);
  });

  test('the extension prefs API publishes a readiness signal that settles (0.1.21)', async ({ page }) => {
    await openNewPost(page);

    // The contract an extension writes against: a Promise, a
    // synchronous read of the same state, and a window event at the
    // same moment. Before this existed, an extension reading at
    // script-load could get null for a key the account holds, because
    // readKey only knows the STORE exists, not that its persistence
    // has attached (MR review 2026-09-02).
    const shape = await page.evaluate(() => ({
      hasReady: !!(window.toolrail.prefs.ready && typeof window.toolrail.prefs.ready.then === 'function'),
      hasIsReady: typeof window.toolrail.prefs.isReady === 'function',
    }));
    expect(shape.hasReady).toBe(true);
    expect(shape.hasIsReady).toBe(true);

    // It must actually SETTLE — a contract that never resolves would
    // hang every consumer that awaits it. Resolve-or-timeout, so a
    // hang fails loudly instead of stalling the spec.
    const settled = await page.evaluate(() => Promise.race([
      window.toolrail.prefs.ready.then(() => 'ready'),
      new Promise((r) => setTimeout(() => r('timeout'), 10000)),
    ]));
    expect(settled).toBe('ready');
    expect(await page.evaluate(() => window.toolrail.prefs.isReady())).toBe(true);

    // Once settled, a round trip through the account store works.
    const roundTrip = await page.evaluate(() => {
      window.toolrail.prefs.set('toolrail-ext:spec:probe', 'kept');
      return window.toolrail.prefs.get('toolrail-ext:spec:probe');
    });
    expect(roundTrip).toBe('kept');
  });

  test('a canceled drag whose release is never seen does not eat a later click (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    await expect(ovSelectedBoxes(page)).toHaveCount(0);

    const box = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[0]}"]`).boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 120, { steps: 8 });
    await expect(page.locator('#toolrail-overview .toolrail-ov-dropline')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.poll(async () => ovAnnouncement(page)).toContain('Move canceled.');

    // The release is NEVER dispatched — the pointer left the document,
    // or the gesture was cancelled — so the one-shot listener is left
    // armed with the overview still open.
    //
    // The next genuine click must still work. Without the fix that
    // click's own mouseup spent the stale latch, and the `click` that
    // followed was discarded, so the box never picked.
    const target = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[2]}"]`).boundingBox();
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);

    await expect(ovSelectedBoxes(page)).toHaveCount(1);
    await expect(page.locator(
      `#toolrail-overview .toolrail-ov-box[data-clientid="${ids[2]}"] .toolrail-ov-controls`
    )).toBeVisible();
  });

  test('dragging a group that contains a locked block says what stayed behind (issue #21)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page, true);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    // Guard the guard: P-B must genuinely be unmovable.
    const refused = await page.evaluate((id) => {
      const sel = window.wp.data.select('core/block-editor');
      return typeof sel.canMoveBlocks === 'function' ? !sel.canMoveBlocks([id], '') : null;
    }, ids[1]);
    test.skip(refused === null, 'canMoveBlocks is not on this WordPress');
    expect(refused).toBe(true);

    // Select movable P-A plus locked P-B, then DRAG the group.
    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, ids[1], 'pick').click({ modifiers: ['Shift'] });
    await expect(ovSelectedBoxes(page)).toHaveCount(2);

    const firstBox = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[0]}"]`).boundingBox();
    const lastBox = await page.locator(`#toolrail-overview .toolrail-ov-box[data-clientid="${ids[5]}"]`).boundingBox();
    await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstBox.x + firstBox.width / 2, lastBox.y + lastBox.height + 20, { steps: 10 });
    await page.mouse.up();

    // The movable member moved to the end; the locked one held its place.
    await expect.poll(async () => overviewContents(page)).toEqual(['P-B', 'P-C', 'P-D', 'P-E', 'P-F', 'P-A']);
    // The DRAG must say what stayed, exactly as the arrows do — the
    // drag used to filter locked ids out before the move engine saw
    // them, so the engine had nothing left to report.
    await expect.poll(async () => ovAnnouncement(page)).toContain('stays where it is.');
  });

  test('keyboard-only: Enter drills into a section, arrows reorder inside it, "Up one level" climbs, Escape closes', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();

    const topIds = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const groupId = topIds[1];

    // Pick the group by keyboard: its controls appear inside the lines,
    // then its Enter control drills in.
    await overviewBoxButton(page, groupId, 'pick').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(
      `#toolrail-overview .toolrail-ov-box[data-clientid="${groupId}"] .toolrail-ov-controls`
    )).toBeVisible();
    await overviewBoxButton(page, groupId, 'enter').focus();
    await page.keyboard.press('Enter');

    const innerIds = await page.evaluate((gid) =>
      window.wp.data.select('core/block-editor').getBlockOrder(gid), groupId
    );
    expect(innerIds.length).toBe(2);
    await expect(page.locator('#toolrail-overview .toolrail-ov-box')).toHaveCount(2);
    // The breadcrumb names the level; the current crumb is text, not a button.
    await expect(page.locator('#toolrail-overview [aria-current="location"]')).toHaveText('Group');

    // Isolation: the drilled root sits centered in the viewport and
    // everything outside it is veiled at 50% (owner ask 2026-08-27) —
    // the veil is overlay chrome, the canvas document is untouched.
    await page.waitForTimeout(300);
    const iso = await page.evaluate((gid) => {
      const overlay = document.getElementById('toolrail-overview');
      const o = overlay.getBoundingClientRect();
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const el = frame.contentDocument.querySelector(`[data-block="${gid}"]`);
      const r = el.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      const k = f.width / frame.offsetWidth;
      const rootMid = f.top + (r.top + r.height / 2) * k;
      const rootRect = {
        top: f.top + r.top * k,
        bottom: f.top + (r.top + r.height) * k,
        left: f.left + r.left * k,
        right: f.left + (r.left + r.width) * k,
      };
      const veils = Array.from(overlay.querySelectorAll('.toolrail-ov-veil'))
        .filter((v) => v.style.display !== 'none');
      // The HOLE is the point (review 2026-08-27, finding 5): no strip
      // may cover the drilled root itself.
      const overlapsRoot = veils.some((v) => {
        const b = v.getBoundingClientRect();
        return b.left < rootRect.right - 1 && b.right > rootRect.left + 1
          && b.top < rootRect.bottom - 1 && b.bottom > rootRect.top + 1;
      });
      return {
        veils: veils.length,
        bg: veils.length ? getComputedStyle(veils[0]).backgroundColor : '',
        offCenter: Math.abs(rootMid - (o.top + o.height / 2)),
        overlapsRoot,
      };
    }, groupId);
    expect(iso.veils).toBeGreaterThanOrEqual(2);
    expect(iso.bg).toBe('rgba(0, 0, 0, 0.5)');
    expect(iso.offCenter).toBeLessThan(60);
    expect(iso.overlapsRoot).toBe(false);

    // Reorder the heading above the paragraph, by keyboard.
    await overviewBoxButton(page, innerIds[1], 'pick').focus();
    await page.keyboard.press('Enter');
    await overviewBoxButton(page, innerIds[1], 'up').focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => page.evaluate((gid) =>
      window.wp.data.select('core/block-editor').getBlockOrder(gid), groupId
    )).toEqual([innerIds[1], innerIds[0]]);

    // Climbing a level by keyboard is the "Up one level" button, not
    // Escape (owner decision 2026-09-01 — Escape exits the mode).
    await page.locator('#toolrail-overview [data-ov-action="up-level"]').click();
    await expect(page.locator('#toolrail-overview .toolrail-ov-box')).toHaveCount(3);
    await expect(page.locator('#toolrail-overview [aria-current="location"]')).toHaveText('All sections');

    // Escape closes from wherever you are, returning focus to the tool.
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('overview');
  });

  test('Escape exits from a drilled-in level in one press (owner decision 2026-09-01)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const topIds = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const groupId = topIds[1];

    await overviewBoxButton(page, groupId, 'pick').click();
    await overviewBoxButton(page, groupId, 'enter').click();
    await expect(page.locator('#toolrail-overview .toolrail-ov-box')).toHaveCount(2);

    // Two levels of state open — drilled in, with a box picked — and
    // one press still leaves. Nothing is lost: the move is already in
    // the store and the close lands on the block last touched.
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    await expect.poll(async () => ovAnnouncement(page)).toContain('Section overview closed.');
  });

  test('the reorder-controls focus ring clears 3:1 on its own surface', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const firstId = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')[0]
    );
    await overviewBoxButton(page, firstId, 'pick').click();
    await expect(page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])')).toBeVisible();

    // The overview surfaces are excluded from the token-sweep test on
    // purpose: they draw on the editor and use a FIXED palette (the
    // 0.1.4 snap-preview boundary), so their ring is pinned here
    // instead — the DECLARED ring color from the stylesheet, against
    // the controls strip's real computed surface, so an appearance
    // change can never silently break it.
    const m = await page.evaluate(() => {
      const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const parse = (c) => {
        const el = document.createElement('div');
        el.style.color = c;
        document.body.appendChild(el);
        const v = getComputedStyle(el).color.match(/rgba?\(([^)]+)\)/);
        el.remove();
        return v ? v[1].split(',').slice(0, 3).map(parseFloat) : null;
      };

      let declared = '';
      for (const sheet of Array.from(document.styleSheets)) {
        // Match the FILE, not the plugin folder: wp-env mounts the checkout
        // under the repo's directory name (editor-tool-rail in CI), so a
        // folder match found no sheet there and the sweep passed vacuously.
        if (!sheet.href || sheet.href.indexOf('/assets/editor-rail.css') === -1) continue;
        let rules;
        try { rules = Array.from(sheet.cssRules); } catch (e) { continue; }
        for (const rule of rules) {
          if (rule.selectorText
            && rule.selectorText.indexOf('.toolrail-ov-btn:focus-visible') !== -1
            && rule.style && rule.style.outlineColor) {
            declared = rule.style.outlineColor;
          }
        }
      }
      if (!declared) return { declared };

      const strip = document.querySelector('#toolrail-overview .toolrail-ov-controls:not([hidden])');
      const ring = parse(declared);
      const surface = parse(getComputedStyle(strip).backgroundColor);
      const l1 = lum(ring);
      const l2 = lum(surface);
      return {
        declared,
        ratio: +((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2),
      };
    });

    // Guard the guard: the rule must have been found and parsed.
    expect(m.declared).toBeTruthy();
    expect(m.ratio).toBeGreaterThanOrEqual(3);
  });

  test('an overview reorder serializes byte-identically to the same move made directly', async ({ page }) => {
    await openNewPost(page);

    // The overview path.
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    await overviewBoxButton(page, ids[0], 'pick').click();
    await overviewBoxButton(page, ids[0], 'down').click();
    await expect.poll(async () => (await blockNames(page))[0]).toBe('core/group');
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const viaOverview = await page.evaluate(() =>
      window.wp.data.select('core/editor').getEditedPostContent()
    );

    // The direct dispatch — what List View's reorder resolves to.
    await seedOverviewBlocks(page);
    await page.evaluate(() => {
      const order = window.wp.data.select('core/block-editor').getBlockOrder('');
      window.wp.data.dispatch('core/block-editor').moveBlocksToPosition([order[0]], '', '', 1);
    });
    const viaDispatch = await page.evaluate(() =>
      window.wp.data.select('core/editor').getEditedPostContent()
    );

    expect(viaOverview).toBe(viaDispatch);
  });

  test('entering and leaving neither dirties the post nor loses the scroll position', async ({ page }) => {
    await openNewPost(page);

    // A fresh, untouched post: the overview alone must not dirty it.
    expect(await page.evaluate(() =>
      window.wp.data.select('core/editor').isEditedPostDirty()
    )).toBe(false);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    expect(await page.evaluate(() =>
      window.wp.data.select('core/editor').isEditedPostDirty()
    )).toBe(false);

    // Scroll restore: the canvas scrolls INSIDE its iframe on this
    // editor (measured — the parent content region never overflows), so
    // that is the position that must survive the round trip.
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 30 }, (_, i) =>
          createBlock('core/paragraph', { content: 'PARA-' + i })
        )
      );
    });
    await expect.poll(async () => page.evaluate(() => {
      const html = document.querySelector('iframe[name="editor-canvas"]').contentDocument.documentElement;
      return html.scrollHeight > html.clientHeight;
    })).toBe(true);

    // Guard the guard: the scroll must genuinely take, or restore-to-0
    // would pass vacuously.
    const scrolled = await page.evaluate(() => {
      const win = document.querySelector('iframe[name="editor-canvas"]').contentWindow;
      win.scrollTo(0, 300);
      return win.scrollY;
    });
    expect(scrolled).toBeGreaterThan(0);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    // The grown iframe has no internal scroll range left — the whole
    // document is its viewport.
    await expect.poll(async () => page.evaluate(() =>
      document.querySelector('iframe[name="editor-canvas"]').contentWindow.scrollY
    )).toBe(0);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect.poll(async () => page.evaluate(() =>
      document.querySelector('iframe[name="editor-canvas"]').contentWindow.scrollY
    )).toBe(scrolled);
  });

  /** Where a block sits relative to the canvas viewport after close —
      distance of its center from the viewport's center, in iframe px,
      plus what "close" counts as (R11: a block taller than the viewport
      centers to its top instead). */
  async function landingOffset(page, clientId) {
    return page.evaluate((id) => {
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const win = frame.contentWindow;
      const el = frame.contentDocument.querySelector(`[data-block="${id}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const vh = win.innerHeight;
      // Tall branch: the implementation lands a viewport-tall block's
      // TOP at 0, so the miss is r.top itself — not a distance to the
      // viewport middle (review 2026-08-31, finding 3).
      const target = r.height >= vh ? -r.top : vh / 2 - (r.top + r.height / 2);
      return { off: Math.abs(target), vh };
    }, clientId);
  }

  test('closing centers and selects the last PICKED block, and the announcement names it', async ({ page }) => {
    await openNewPost(page);
    // Many short blocks so the document scrolls, the picked block's
    // rect fits well inside the viewport (the centered assertion is
    // about the block's CENTER), and room remains on BOTH sides of it —
    // a block near the document's end can only ever clamp, not center.
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 40 }, (_, i) =>
          createBlock('core/paragraph', { content: 'CENTER-PARA-' + i })
        )
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(40);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    // Mid-document, below the fold at entry scroll 0. Focus + Enter,
    // not click: at floor zoom the box may sit below the overlay's
    // edge, and the overlay's focusin handler pans it into view — the
    // same path a keyboard user takes.
    const picked = ids[20];
    await overviewBoxButton(page, picked, 'pick').focus();
    await page.keyboard.press('Enter');
    await page.locator('#toolrail-overview [data-ov-action="close"]').click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);

    // Behavior, not mechanism: the block's center lands within a
    // quarter-viewport of the canvas viewport's center (the canvas is
    // pre-positioned at close; the poll also covers the corrective
    // write behind it), and the block is selected.
    await expect.poll(async () => {
      const m = await landingOffset(page, picked);
      return m ? m.off < m.vh / 4 : false;
    }).toBe(true);
    expect(await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getSelectedBlockClientId()
    )).toBe(picked);

    // The close announcement names the landed block (issue #20).
    await expect.poll(async () => page.evaluate(() =>
      document.getElementById('a11y-speak-polite').textContent
    )).toContain('Section overview closed. Paragraph is selected.');
  });

  test('under reduced motion, closing after a drill + move still lands on the MOVED child — instantly', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openNewPost(page);
    // A group mid-document with filler on BOTH sides, so landing on its
    // child is a real scroll that can genuinely center (a group at the
    // very end can only clamp against the document's bottom).
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      const filler = (tag) => Array.from({ length: 15 }, (_, i) =>
        createBlock('core/paragraph', { content: tag + '-' + i })
      );
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        ...filler('BEFORE'),
        createBlock('core/group', {}, [
          createBlock('core/paragraph', { content: 'CHILD-ONE' }),
          createBlock('core/heading', { content: 'CHILD-TWO' }),
        ]),
        ...filler('AFTER'),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(31);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const groupId = (await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    ))[15];
    // Focus + Enter: the focusin pan brings a below-the-edge box into
    // view before the pick, same as the keyboard path.
    await overviewBoxButton(page, groupId, 'pick').focus();
    await page.keyboard.press('Enter');
    await overviewBoxButton(page, groupId, 'enter').click();
    const innerIds = await page.evaluate((gid) =>
      window.wp.data.select('core/block-editor').getBlockOrder(gid), groupId
    );
    await overviewBoxButton(page, innerIds[1], 'pick').click();
    await overviewBoxButton(page, innerIds[1], 'up').click();
    await page.locator('#toolrail-overview [data-ov-action="close"]').click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);

    // The moved CHILD (last touched wins over the drilled root) is
    // selected and centered — reduced motion only skips the overlay
    // fade; the landing itself is identical for everyone.
    expect(await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getSelectedBlockClientId()
    )).toBe(innerIds[1]);
    await expect.poll(async () => {
      const m = await landingOffset(page, innerIds[1]);
      return m ? m.off < m.vh / 4 : false;
    }).toBe(true);
  });

  test('a deleted last-touched block falls back to the entry scroll without throwing', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 24 }, (_, i) =>
          createBlock('core/paragraph', { content: 'FALLBACK-' + i })
        )
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(24);
    const scrolled = await page.evaluate(() => {
      const win = document.querySelector('iframe[name="editor-canvas"]').contentWindow;
      win.scrollTo(0, 300);
      return win.scrollY;
    });
    expect(scrolled).toBe(300);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    await overviewBoxButton(page, ids[3], 'pick').click();
    // The touched block vanishes before close — the landing must fall
    // through to the entry scroll, never throw or select a ghost.
    // selectPrevious=false: core's default would select the previous
    // block, and this test's point is the NOTHING-selected fallback.
    await page.evaluate((id) =>
      window.wp.data.dispatch('core/block-editor').removeBlock(id, false), ids[3]
    );
    await page.locator('#toolrail-overview [data-ov-action="close"]').click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    await expect.poll(async () => page.evaluate(() =>
      document.querySelector('iframe[name="editor-canvas"]').contentWindow.scrollY
    )).toBe(scrolled);
    expect(await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getSelectedBlockClientId()
    )).toBeNull();
  });

  test('a movement-locked block gets disabled arrows — never a false "moved" announcement', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/paragraph', { content: 'FREE-1' }),
        createBlock('core/paragraph', { content: 'LOCKED', lock: { move: true } }),
        createBlock('core/paragraph', { content: 'FREE-2' }),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(3);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();

    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    // Guard the guard: core must genuinely refuse this move, or the
    // disabled-arrows assertion proves nothing.
    const refused = await page.evaluate((id) => {
      const sel = window.wp.data.select('core/block-editor');
      return typeof sel.canMoveBlocks === 'function' ? !sel.canMoveBlocks([id], '') : null;
    }, ids[1]);
    test.skip(refused === null, 'canMoveBlocks is not on this WordPress');
    expect(refused).toBe(true);

    // The locked block's arrows are disabled — the UI never offers a
    // move core would silently refuse (review 2026-08-27, finding 1).
    await overviewBoxButton(page, ids[1], 'pick').click();
    await expect(overviewBoxButton(page, ids[1], 'up')).toBeDisabled();
    await expect(overviewBoxButton(page, ids[1], 'down')).toBeDisabled();

    // Control: the free block beside it still moves.
    await overviewBoxButton(page, ids[0], 'pick').click();
    await expect(overviewBoxButton(page, ids[0], 'down')).toBeEnabled();

    // Nor can the locked block be DRAGGED: the drag refuses to start
    // (no drop line), so the order survives the gesture.
    const grab = await page.evaluate((id) => {
      const pick = document.querySelector(
        `#toolrail-overview .toolrail-ov-box[data-clientid="${id}"] [data-ov-action="pick"]`
      );
      const r = pick.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 8) };
    }, ids[1]);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x, grab.y + 200, { steps: 6 });
    await expect(page.locator('.toolrail-ov-dropline')).toHaveCount(0);
    await page.mouse.up();
    expect(await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    )).toEqual(ids);
  });

  test('narrowing below the small-screen breakpoint closes the overview instead of stranding it', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();

    // Below 783px the overlay (the only Escape surface) and the rail are
    // display:none — the overview must close itself rather than leave a
    // scaled canvas with no way back (review 2026-08-27, finding 2).
    await page.setViewportSize({ width: 600, height: 800 });
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    const clean = await page.evaluate(() => ({
      bodyClass: document.body.classList.contains('toolrail-overview-on'),
      hosts: document.querySelectorAll('.toolrail-ov-scale-host').length,
      frameh: document.body.style.getPropertyValue('--toolrail-ov-frameh'),
    }));
    expect(clean).toEqual({ bodyClass: false, hosts: 0, frameh: '' });
  });

  test('opening disarms an armed tool, and the overlay captures canvas clicks', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);

    await page.locator('#toolrail-rail [data-tool="pin:core/group"]').click();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/group"]')).toHaveAttribute('aria-pressed', 'true');

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    // Disarmed on open (review 2026-08-27, finding 4)…
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/group"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#toolrail-rail [data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');

    // …and the overlay is the topmost pointer surface over the canvas,
    // so no click can fall through and edit the document underneath.
    // Guard the guard first: the point probed must be inside the overlay.
    const probe = await page.evaluate(() => {
      const o = document.getElementById('toolrail-overview');
      const r = o.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      return { x, y, captured: !!(hit && (hit === o || o.contains(hit))) };
    });
    expect(probe.captured).toBe(true);

    const before = (await blockNames(page)).length;
    await page.mouse.click(probe.x, probe.y);
    await page.waitForTimeout(300);
    expect((await blockNames(page)).length).toBe(before);
  });

  test('a long document can be zoomed and panned', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 30 }, (_, i) =>
          createBlock('core/paragraph', { content: 'PARA-' + i })
        )
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(30);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview .toolrail-ov-box').first()).toBeVisible();

    const readScale = () => page.evaluate(() =>
      parseFloat(document.body.style.getPropertyValue('--toolrail-overview-scale'))
    );
    // Bare paragraphs floor the DEFAULT zoom at full size (the
    // content-derived rule) — the manual buttons still go below it and
    // back up. Zoom out first, then in.
    const k0 = await readScale();
    await page.locator('#toolrail-overview [data-ov-action="zoom-out"]').click();
    const k1 = await readScale();
    expect(k1).toBeLessThan(k0);
    await page.locator('#toolrail-overview [data-ov-action="zoom-in"]').click();
    const k2 = await readScale();
    expect(k2).toBeGreaterThan(k1);

    // Whatever doesn't fit, the wheel pans instead of shrinking further
    // — the "very long pages" path.
    const tyBefore = await page.evaluate(() =>
      parseFloat(document.body.style.getPropertyValue('--toolrail-ov-ty')) || 0
    );
    const c = await page.evaluate(() => {
      const r = document.getElementById('toolrail-overview').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await page.mouse.move(c.x, c.y);
    await page.mouse.wheel(0, 400);
    await expect.poll(async () => page.evaluate(() =>
      parseFloat(document.body.style.getPropertyValue('--toolrail-ov-ty')) || 0
    )).toBeLessThan(tyBefore);
  });

  test('the zoom floor keeps sections a usable size on very long documents', async ({ page }) => {
    await openNewPost(page);

    // 40 real sections (heading + paragraph groups) — long enough that a
    // naive whole-document fit would shrink each section into a sliver
    // (the post-773 report).
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 40 }, (_, i) =>
          createBlock('core/group', {}, [
            createBlock('core/heading', { content: 'SECTION-' + i }),
            createBlock('core/paragraph', { content: 'Body for section ' + i }),
          ])
        )
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(40);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview .toolrail-ov-box').first()).toBeVisible();

    const m = await page.evaluate(() => {
      const content = document.querySelector('.interface-interface-skeleton__content');
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const naiveFit = (content.clientHeight - 24) / frame.contentDocument.body.scrollHeight;
      const k = parseFloat(document.body.style.getPropertyValue('--toolrail-overview-scale'));
      const hs = Array.from(document.querySelectorAll('#toolrail-overview .toolrail-ov-box'))
        .map((b) => b.getBoundingClientRect().height)
        .sort((a, b) => a - b);
      return { naiveFit, k, medianH: hs[Math.floor(hs.length / 2)] };
    });

    // The scale did NOT chase the naive fit down: the median section
    // stays a usable size, and the remainder is reachable by panning.
    expect(m.k).toBeGreaterThan(m.naiveFit + 0.01);
    expect(m.medianH).toBeGreaterThanOrEqual(44);
  });

  test('opening clears the selected block\'s toolbar; closing restores the selection', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);

    const picked = await page.evaluate(() => {
      const order = window.wp.data.select('core/block-editor').getBlockOrder('');
      window.wp.data.dispatch('core/block-editor').selectBlock(order[0]);
      return order[0];
    });
    expect(await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getSelectedBlockClientId()
    )).toBe(picked);

    // Open: the selection (and with it the floating block toolbar that
    // was fighting the zoomed-out view) goes away for the mode's
    // lifetime…
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    expect(await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getSelectedBlockClientId()
    )).toBeNull();

    // …and comes back on close, so the author's place is kept.
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    expect(await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getSelectedBlockClientId()
    )).toBe(picked);

    // The focus contract holds on THIS path too: restoring the prior
    // selection re-renders chrome a frame later, the same steal the
    // landing path had (review 2026-08-31, finding 1) — the re-assert
    // must cover both. Poll: the steal and its recovery are async.
    await expect.poll(async () => page.evaluate(() =>
      document.activeElement && document.activeElement.dataset
        ? document.activeElement.dataset.tool
        : ''
    )).toBe('overview');
  });

  test('a drilled root taller than the viewport is top-aligned and pans — never centered', async ({ page }) => {
    await openNewPost(page);

    // A group of many short paragraphs: the children's median floors the
    // drill-in zoom at ~1, making the root taller than the viewport —
    // the branch where centering must NOT engage (review 2026-08-27,
    // finding 5: this path was never exercised).
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/paragraph', { content: 'BEFORE' }),
        createBlock('core/group', {},
          Array.from({ length: 30 }, (_, i) =>
            createBlock('core/paragraph', { content: 'TALL-' + i })
          )),
        createBlock('core/paragraph', { content: 'AFTER' }),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(3);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();

    const groupId = (await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    ))[1];
    await overviewBoxButton(page, groupId, 'pick').click();
    await overviewBoxButton(page, groupId, 'enter').click();
    await expect(page.locator('#toolrail-overview [aria-current="location"]')).toHaveText('Group');
    await page.waitForTimeout(300);

    const m = await page.evaluate((gid) => {
      const overlay = document.getElementById('toolrail-overview');
      const o = overlay.getBoundingClientRect();
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const el = frame.contentDocument.querySelector(`[data-block="${gid}"]`);
      const r = el.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      const k = f.width / frame.offsetWidth;
      return {
        rootTopOffset: f.top + r.top * k - o.top,
        rootTallerThanViewport: r.height * k > o.height,
        ty: parseFloat(document.body.style.getPropertyValue('--toolrail-ov-ty')) || 0,
      };
    }, groupId);

    // Guard the guard: the root must genuinely overflow the viewport.
    expect(m.rootTallerThanViewport).toBe(true);
    // Top-aligned (small positive offset), not centered.
    expect(m.rootTopOffset).toBeGreaterThanOrEqual(-2);
    expect(m.rootTopOffset).toBeLessThan(80);

    // And the remainder is reachable by panning.
    const c = await page.evaluate(() => {
      const r = document.getElementById('toolrail-overview').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await page.mouse.move(c.x, c.y);
    await page.mouse.wheel(0, 400);
    await expect.poll(async () => page.evaluate(() =>
      parseFloat(document.body.style.getPropertyValue('--toolrail-ov-ty')) || 0
    )).toBeLessThan(m.ty);
  });

  test('growing the canvas is instant and stable — no creeping background, no dead tail space', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 6 }, (_, s) =>
          createBlock('core/group', {},
            Array.from({ length: 6 }, (_, i) =>
              createBlock('core/paragraph', { content: 'G' + s + '-P' + i })
            ))
        )
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(6);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview .toolrail-ov-box').first()).toBeVisible();

    // The frame height must be INSTANT and then HOLD: core's 0.4s
    // all-property iframe transition animated the growth, and measuring
    // body.scrollHeight (whose ~40vh click-to-append tail chases the
    // iframe's own height) re-targeted it in a feedback loop — the
    // canvas background visibly crept down the page (owner report,
    // 1707×898). Sampling at 120ms — well INSIDE where core's 0.4s
    // transition would still be mid-flight — is what proves
    // instantaneity, not merely eventual stability (review 2026-08-27,
    // finding 5).
    await page.waitForTimeout(120);
    const s1 = await page.evaluate(() =>
      document.querySelector('iframe[name="editor-canvas"]').offsetHeight
    );
    await page.waitForTimeout(1100);
    const state = await page.evaluate(() => {
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const idoc = frame.contentDocument;
      const order = window.wp.data.select('core/block-editor').getBlockOrder('');
      const last = idoc.querySelector(`[data-block="${order[order.length - 1]}"]`);
      const r = last.getBoundingClientRect();
      return {
        s2: frame.offsetHeight,
        transitionProperty: getComputedStyle(frame).transitionProperty,
        contentExtent: Math.round(r.top + r.height + (idoc.defaultView.scrollY || 0)),
        bodyScrollH: idoc.body.scrollHeight,
      };
    });
    expect(state.s2).toBe(s1);
    expect(state.transitionProperty).toBe('none');
    // The frame is sized to the CONTENT, not to the padded scrollHeight
    // — guard the guard: the padded tail must actually exist for the
    // exclusion to mean anything.
    expect(Math.abs(state.s2 - (state.contentExtent + 32))).toBeLessThanOrEqual(2);
    expect(state.bodyScrollH).toBeGreaterThan(state.s2 + 100);

    // The reviewer's variant (2026-08-27, finding 1): a full-height
    // (100vh) Cover resolves against the iframe's own height — the same
    // feedback mechanism as the appender tail, through a different
    // door. With the extent measured un-grown and cached, the frame
    // must hold here too instead of roughly doubling.
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/paragraph', { content: 'ABOVE' }),
        createBlock('core/cover', { minHeight: 100, minHeightUnit: 'vh' },
          [createBlock('core/paragraph', { content: 'HERO' })]),
        createBlock('core/paragraph', { content: 'BELOW' }),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(3);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview .toolrail-ov-box').first()).toBeVisible();
    await page.waitForTimeout(120);
    const c1 = await page.evaluate(() =>
      document.querySelector('iframe[name="editor-canvas"]').offsetHeight
    );
    // Outlive the settle pass and a full transition length.
    await page.waitForTimeout(1100);
    const c2 = await page.evaluate(() =>
      document.querySelector('iframe[name="editor-canvas"]').offsetHeight
    );
    expect(c2).toBe(c1);
  });

  test('a section can be dragged to a new spot — pointer sugar over the same move', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();

    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );

    // Drag ALPHA's box to below the group's midpoint.
    const points = await page.evaluate((pair) => {
      const rect = (id) => document
        .querySelector(`#toolrail-overview .toolrail-ov-box[data-clientid="${id}"]`)
        .getBoundingClientRect();
      const a = rect(pair[0]);
      const b = rect(pair[1]);
      return {
        fromX: Math.round(a.left + a.width / 2),
        fromY: Math.round(a.top + Math.min(a.height / 2, 12)),
        toY: Math.round(b.top + b.height / 2 + 10),
      };
    }, [ids[0], ids[1]]);

    await page.mouse.move(points.fromX, points.fromY);
    await page.mouse.down();
    await page.mouse.move(points.fromX, points.toY, { steps: 8 });
    // The drop line marks the target gap while the drag is live.
    await expect(page.locator('.toolrail-ov-dropline')).toBeVisible();
    await page.mouse.up();

    await expect.poll(async () => await blockNames(page)).toEqual([
      'core/group',
      'core/paragraph',
      'core/paragraph',
    ]);

    // Announced exactly like an arrow move — the drag is sugar over the
    // same dispatch, never a separate path.
    await expect.poll(async () => page.evaluate(() => {
      const region = document.getElementById('a11y-speak-polite');
      return region ? region.textContent : '';
    })).toContain('Moved Paragraph to position 2 of 3.');

    // The release's click must not ALSO toggle the controls open…
    await expect(page.locator('#toolrail-overview .toolrail-ov-controls:not([hidden])')).toHaveCount(0);
    // …and the drag chrome is gone.
    await expect(page.locator('.toolrail-ov-dropline')).toHaveCount(0);
    expect(await page.evaluate(() =>
      document.body.classList.contains('toolrail-ov-dragging')
    )).toBe(false);
  });
});

/** Drilled-box center/edges keyed by paragraph content, for the drag
    stress specs — rects are only trustworthy once the drill's settle
    pass has run, so poll until every box has painted somewhere real. */
async function boxPointsByContent(page, rootId) {
  await expect.poll(async () => page.evaluate((g) => {
    const sel = window.wp.data.select('core/block-editor');
    return sel.getBlockOrder(g).every((id) => {
      const b = document.querySelector(`#toolrail-overview .toolrail-ov-box[data-clientid="${id}"]`);
      return b && b.style.display !== 'none' && b.getBoundingClientRect().width > 10;
    });
  }, rootId)).toBe(true);
  return page.evaluate((g) => {
    const sel = window.wp.data.select('core/block-editor');
    const out = {};
    sel.getBlockOrder(g).forEach((id) => {
      const block = sel.getBlock(id);
      const label = block.name === 'core/column'
        ? block.innerBlocks[0].attributes.content.toString()
        : block.attributes.content.toString();
      const r = document
        .querySelector(`#toolrail-overview .toolrail-ov-box[data-clientid="${id}"]`)
        .getBoundingClientRect();
      out[label] = {
        x: r.left + r.width / 2,
        y: r.top + Math.min(r.height / 2, 12),
        left: r.left,
        right: r.right,
        top: r.top,
      };
    });
    return out;
  }, rootId);
}

/** Child contents at a root, via each child's own paragraph. */
function childContents(page, rootId) {
  return page.evaluate((g) => {
    const sel = window.wp.data.select('core/block-editor');
    return sel.getBlockOrder(g).map((id) => {
      const block = sel.getBlock(id);
      return block.name === 'core/column'
        ? block.innerBlocks[0].attributes.content.toString()
        : block.attributes.content.toString();
    });
  }, rootId);
}

/** Open the overview and drill into the first top-level block. */
async function drillIntoFirst(page) {
  await page.locator('#toolrail-rail [data-tool="overview"]').click();
  await expect(page.locator('#toolrail-overview')).toBeVisible();
  const rootId = await page.evaluate(() =>
    window.wp.data.select('core/block-editor').getBlockOrder('')[0]
  );
  await overviewBoxButton(page, rootId, 'pick').click();
  await overviewBoxButton(page, rootId, 'enter').click();
  return rootId;
}

test.describe('overview follows late canvas changes (#64)', () => {
  test('the boxes follow a canvas change that lands after the timed settle passes, then go idle', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        ['FIRST', 'SECOND', 'THIRD'].map((c) => createBlock('core/paragraph', { content: c }))
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(3);
    const ids = await page.evaluate(() => window.wp.data.select('core/block-editor').getBlockOrder(''));

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    const boxTop = (id) => page.evaluate((cid) => {
      const b = document.querySelector(`#toolrail-overview .toolrail-ov-box[data-clientid="${cid}"]`);
      return b && b.style.display !== 'none' ? b.getBoundingClientRect().top : null;
    }, id);
    await expect.poll(() => boxTop(ids[1])).not.toBeNull();
    // Outlast both timed passes (rAF and 220 ms), so only the canvas
    // observer can move the boxes from here on.
    await page.waitForTimeout(600);
    const firstBefore = await boxTop(ids[0]);
    const secondBefore = await boxTop(ids[1]);
    const k = await page.evaluate(() =>
      parseFloat(document.body.style.getPropertyValue('--toolrail-overview-scale')) || 1
    );

    // A late canvas change with no store change: the same thing a slow
    // reorder flush does. A 300px spacer before SECOND pushes it down.
    await page.evaluate((cid) => {
      const doc = document.querySelector('iframe[name="editor-canvas"]').contentDocument;
      const spacer = doc.createElement('div');
      spacer.id = 'e2e-late-spacer';
      spacer.style.height = '300px';
      const block = doc.querySelector(`[data-block="${cid}"]`);
      block.parentNode.insertBefore(spacer, block);
    }, ids[1]);
    await expect.poll(async () => (await boxTop(ids[1])) - secondBefore).toBeGreaterThan(300 * k * 0.5);
    expect(Math.abs((await boxTop(ids[0])) - firstBefore)).toBeLessThan(1);

    // Settled means idle: the observer reacts to canvas changes only, so
    // the open overview no longer changes its own DOM. Before #64 the
    // zoom label was rewritten about every 110 ms, observer or not.
    await page.waitForTimeout(600);
    const idleMutations = await page.evaluate(() => new Promise((resolve) => {
      let count = 0;
      const mo = new MutationObserver((records) => { count += records.length; });
      mo.observe(document.getElementById('toolrail-overview'), { attributes: true, childList: true, subtree: true });
      setTimeout(() => { mo.disconnect(); resolve(count); }, 1500);
    }));
    expect(idleMutations).toBe(0);

    // Taking the spacer out moves SECOND back.
    await page.evaluate(() => {
      const doc = document.querySelector('iframe[name="editor-canvas"]').contentDocument;
      doc.getElementById('e2e-late-spacer').remove();
    });
    await expect.poll(async () => Math.abs((await boxTop(ids[1])) - secondBefore)).toBeLessThan(1);
  });

  test('after a block-editor reorder, the boxes stand in the order of getBlockOrder', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        ['FIRST', 'SECOND', 'THIRD', 'FOURTH'].map((c) => createBlock('core/paragraph', { content: c }))
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(4);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    // The boxes from top to bottom, as client IDs.
    const boxOrder = () => page.evaluate(() =>
      Array.from(document.querySelectorAll('#toolrail-overview .toolrail-ov-box[data-clientid]'))
        .filter((b) => b.style.display !== 'none')
        .map((b) => ({ id: b.dataset.clientid, top: b.getBoundingClientRect().top }))
        .sort((a, b) => a.top - b.top)
        .map((b) => b.id)
    );
    const storeOrder = () => page.evaluate(() => window.wp.data.select('core/block-editor').getBlockOrder(''));
    await expect.poll(boxOrder).toEqual(await storeOrder());
    await page.waitForTimeout(600);

    // A real reorder through the store: the last block to the top. The
    // canvas applies it when React flushes; the boxes must follow that
    // flush, not the store alone. This test does not force the flush
    // later than the 220 ms pass; the tests below change the canvas
    // after it, which is the late case.
    const before = await storeOrder();
    await page.evaluate((ids) => {
      window.wp.data.dispatch('core/block-editor').moveBlocksToPosition([ids[3]], '', '', 0);
    }, before);
    await expect.poll(storeOrder).toEqual([before[3], before[0], before[1], before[2]]);
    await expect.poll(boxOrder, { message: 'the boxes stand in store order' }).toEqual(await storeOrder());
  });

  test('after a reorder, the boxes end where the blocks end once the canvas slide is over (#78)', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 12 }, (_, i) => createBlock('core/paragraph', { content: 'P' + i }))
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(12);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    // How far each box's top is from its block's on-screen top, in
    // editor-document pixels: the block's rect is read inside the canvas
    // and mapped through the scaled iframe, the way the overview does.
    const maxDrift = () => page.evaluate(() => {
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const doc = frame.contentDocument;
      const f = frame.getBoundingClientRect();
      const k = frame.offsetWidth ? f.width / frame.offsetWidth : 1;
      let max = 0;
      window.wp.data.select('core/block-editor').getBlockOrder('').forEach((id) => {
        const box = document.querySelector(`#toolrail-overview .toolrail-ov-box[data-clientid="${id}"]`);
        const block = doc.querySelector(`[data-block="${id}"]`);
        if (!box || !block || box.style.display === 'none') {
          max = Infinity;
          return;
        }
        const blockTop = f.top + block.getBoundingClientRect().top * k;
        max = Math.max(max, Math.abs(box.getBoundingClientRect().top - blockTop));
      });
      return max;
    });
    await expect.poll(maxDrift).toBeLessThan(1);
    // Outlast the timed passes that opening the overview scheduled (rAF
    // and 220 ms): the boxes can already sit on their blocks while the
    // 220 ms pass is still pending. From here on, only the reorder below
    // moves them.
    await page.waitForTimeout(600);

    // The block editor slides moved blocks into place with an inline
    // transform, and ends the slide by clearing it: a style change, with
    // no node added and no size changed. Record that the slide ran, so
    // this test cannot pass on a canvas that skipped it. The old value
    // counts too: the callback reads the style after the record was made,
    // when the clearing write has already removed the transform.
    await page.evaluate(() => {
      const doc = document.querySelector('iframe[name="editor-canvas"]').contentDocument;
      window.e2eSawSlide = false;
      window.e2eSlideObserver = new MutationObserver((records) => {
        if (records.some((r) => /translate3d/.test(r.oldValue || '') || /translate3d/.test(r.target.style.transform || ''))) {
          window.e2eSawSlide = true;
        }
      });
      window.e2eSlideObserver.observe(doc.body, {
        attributes: true,
        attributeFilter: ['style'],
        attributeOldValue: true,
        subtree: true,
      });
    });
    // The last block to the top: a long slide, still moving at 220 ms.
    await page.evaluate(() => {
      const order = window.wp.data.select('core/block-editor').getBlockOrder('');
      window.wp.data.dispatch('core/block-editor').moveBlocksToPosition([order[order.length - 1]], '', '', 0);
    });
    await expect.poll(() => page.evaluate(() => window.e2eSawSlide), { message: 'the canvas slid the blocks' }).toBe(true);
    await expect.poll(() => page.evaluate(() =>
      Array.from(document.querySelector('iframe[name="editor-canvas"]').contentDocument.querySelectorAll('[data-block]'))
        .every((el) => !el.style.transform)
    ), { message: 'the slide ended' }).toBe(true);
    await page.evaluate(() => window.e2eSlideObserver.disconnect());

    await expect.poll(maxDrift, { message: 'every box sits on its block after the slide' }).toBeLessThan(1);
  });

  test('a late canvas height change at the end of the document is refit, not left past the frame', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        ['FIRST', 'SECOND', 'THIRD'].map((c) => createBlock('core/paragraph', { content: c }))
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(3);
    const ids = await page.evaluate(() => window.wp.data.select('core/block-editor').getBlockOrder(''));

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    const frameHeight = () => page.evaluate(() =>
      parseFloat(document.body.style.getPropertyValue('--toolrail-ov-frameh')) || 0
    );
    await expect.poll(frameHeight).toBeGreaterThan(0);
    // Outlast the timed passes: from here only the canvas observer refits.
    await page.waitForTimeout(600);
    const before = await frameHeight();

    // Content that grows after the store change (an image or embed that
    // loads late), at the END, where a stale extent leaves it past the
    // frame. The store subscription measured before this existed.
    await page.evaluate((cid) => {
      const doc = document.querySelector('iframe[name="editor-canvas"]').contentDocument;
      const tail = doc.createElement('div');
      tail.id = 'e2e-late-tail';
      tail.style.height = '3000px';
      const block = doc.querySelector(`[data-block="${cid}"]`);
      block.appendChild(tail);
    }, ids[2]);
    await expect.poll(frameHeight, { message: 'the frame refits to the taller content' })
      .toBeGreaterThan(before + 2500);

    // And back down when it goes.
    await page.evaluate(() => {
      document.querySelector('iframe[name="editor-canvas"]').contentDocument
        .getElementById('e2e-late-tail').remove();
    });
    await expect.poll(async () => Math.abs((await frameHeight()) - before)).toBeLessThan(2);
  });

  test('an image that loads after the overview settled is refit — a size change with no childList change', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        ['FIRST', 'SECOND', 'THIRD'].map((c) => createBlock('core/paragraph', { content: c }))
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(3);
    const ids = await page.evaluate(() => window.wp.data.select('core/block-editor').getBlockOrder(''));
    // An image already in the last block, with nothing loaded yet: it
    // takes no space. Added BEFORE the overview opens, so this childList
    // change is old news by the time the overview watches the canvas.
    await page.evaluate((cid) => {
      const doc = document.querySelector('iframe[name="editor-canvas"]').contentDocument;
      const img = doc.createElement('img');
      img.id = 'e2e-late-image';
      img.alt = '';
      img.style.display = 'block';
      doc.querySelector(`[data-block="${cid}"]`).appendChild(img);
    }, ids[2]);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    const frameHeight = () => page.evaluate(() =>
      parseFloat(document.body.style.getPropertyValue('--toolrail-ov-frameh')) || 0
    );
    await expect.poll(frameHeight).toBeGreaterThan(0);
    await page.waitForTimeout(600);
    const before = await frameHeight();

    // The image loads: a src ATTRIBUTE change, and a 3000px intrinsic
    // height, with no node added or removed anywhere.
    await page.evaluate(() => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="3000"></svg>';
      document.querySelector('iframe[name="editor-canvas"]').contentDocument
        .getElementById('e2e-late-image').src = 'data:image/svg+xml,' + encodeURIComponent(svg);
    });
    await expect.poll(frameHeight, { message: 'the frame refits to the loaded image' })
      .toBeGreaterThan(before + 2500);
  });
});

test.describe('overview drag stress (grids, columns, notices)', () => {
  test('a grid cell drags HORIZONTALLY past its neighbor — vertical drop line, same-row reorder', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/group', { layout: { type: 'grid', columnCount: 2 } },
          ['CELL-A', 'CELL-B', 'CELL-C', 'CELL-D'].map((c) =>
            createBlock('core/paragraph', { content: c })
          )),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(1);

    const gridId = await drillIntoFirst(page);
    const pts = await boxPointsByContent(page, gridId);
    // The seed really is a 2×2 grid: A and B share a row, C sits below.
    expect(Math.abs(pts['CELL-A'].top - pts['CELL-B'].top)).toBeLessThan(4);
    expect(pts['CELL-C'].top).toBeGreaterThan(pts['CELL-A'].top + 10);

    // Drag A rightward past B's center, along the SAME row.
    await page.mouse.move(pts['CELL-A'].x, pts['CELL-A'].y);
    await page.mouse.down();
    await page.mouse.move(pts['CELL-B'].right - 5, pts['CELL-A'].y, { steps: 8 });
    // The gap marker for a same-row move is the VERTICAL line.
    await expect(page.locator('.toolrail-ov-dropline.is-vertical')).toBeVisible();
    await page.mouse.up();

    await expect.poll(() => childContents(page, gridId)).toEqual([
      'CELL-B', 'CELL-A', 'CELL-C', 'CELL-D',
    ]);
    await expect.poll(async () => page.evaluate(() => {
      const region = document.getElementById('a11y-speak-polite');
      return region ? region.textContent : '';
    })).toContain('Moved Paragraph to position 2 of 4.');
  });

  test('a grid cell drags DIAGONALLY into a gap on another row', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/group', { layout: { type: 'grid', columnCount: 2 } },
          ['CELL-A', 'CELL-B', 'CELL-C', 'CELL-D'].map((c) =>
            createBlock('core/paragraph', { content: c })
          )),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(1);

    const gridId = await drillIntoFirst(page);
    const pts = await boxPointsByContent(page, gridId);

    // Drag A down into row two, between C and D.
    const gapX = (pts['CELL-C'].right + pts['CELL-D'].left) / 2;
    await page.mouse.move(pts['CELL-A'].x, pts['CELL-A'].y);
    await page.mouse.down();
    await page.mouse.move(gapX, pts['CELL-C'].y, { steps: 8 });
    await expect(page.locator('.toolrail-ov-dropline.is-vertical')).toBeVisible();
    await page.mouse.up();

    await expect.poll(() => childContents(page, gridId)).toEqual([
      'CELL-B', 'CELL-C', 'CELL-A', 'CELL-D',
    ]);
  });

  test('columns reorder by horizontal drag the same way', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/columns', {}, ['COL-ONE', 'COL-TWO', 'COL-THREE'].map((c) =>
          createBlock('core/column', {}, [createBlock('core/paragraph', { content: c })])
        )),
      ]);
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(1);

    const columnsId = await drillIntoFirst(page);
    const pts = await boxPointsByContent(page, columnsId);

    // Drag the first column past the second — a column is just a block
    // in a one-row layout, so the same row/gap math must carry it.
    await page.mouse.move(pts['COL-ONE'].x, pts['COL-ONE'].y);
    await page.mouse.down();
    await page.mouse.move(pts['COL-TWO'].right - 5, pts['COL-ONE'].y, { steps: 8 });
    await expect(page.locator('.toolrail-ov-dropline.is-vertical')).toBeVisible();
    await page.mouse.up();

    await expect.poll(() => childContents(page, columnsId)).toEqual([
      'COL-TWO', 'COL-ONE', 'COL-THREE',
    ]);
  });

  test('a plain stack still drags with the horizontal line, first-to-last in one gesture', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 6 }, (_, s) =>
          createBlock('core/group', {}, [
            createBlock('core/paragraph', { content: 'SECTION-' + s }),
          ]))
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(6);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    const points = await page.evaluate((pair) => {
      const rect = (id) => document
        .querySelector(`#toolrail-overview .toolrail-ov-box[data-clientid="${id}"]`)
        .getBoundingClientRect();
      const first = rect(pair[0]);
      const last = rect(pair[1]);
      return {
        fromX: Math.round(first.left + first.width / 2),
        fromY: Math.round(first.top + Math.min(first.height / 2, 12)),
        toY: Math.round(last.bottom + 6),
      };
    }, [ids[0], ids[ids.length - 1]]);

    await page.mouse.move(points.fromX, points.fromY);
    await page.mouse.down();
    await page.mouse.move(points.fromX, points.toY, { steps: 10 });
    // Stacked sections keep the HORIZONTAL gap line — the vertical
    // variant is only for side-by-side neighbors.
    await expect(page.locator('.toolrail-ov-dropline:not(.is-vertical)')).toBeVisible();
    await page.mouse.up();

    await expect.poll(async () => page.evaluate((id) =>
      window.wp.data.select('core/block-editor').getBlockOrder('').indexOf(id), ids[0]
    )).toBe(ids.length - 1);
  });

  test('an editor notice above the canvas costs the overview no reach; dismissing it refits', async ({ page }) => {
    await openNewPost(page);
    // The document from the fit test: several viewports tall.
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks(
        Array.from({ length: 4 }, (_, s) =>
          createBlock('core/group', {},
            Array.from({ length: 8 }, (_, i) =>
              createBlock('core/paragraph', { content: 'S' + s + '-PARA-' + i })
            ))
        )
      );
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(4);

    // The same shape as the "There is an autosave" warning: a
    // dismissible notice rendered inside the content region, ABOVE the
    // visual editor — it shrinks the canvas viewport with no window
    // resize event (diagnosed on post 433, 2026-08-28).
    await page.evaluate(() => {
      window.wp.data.dispatch('core/notices').createWarningNotice(
        'There is an autosave of this post that is more recent than the version below.',
        { id: 'toolrail-e2e-autosave', isDismissible: true }
      );
    });
    await expect(page.locator('.components-notice')).toBeVisible();

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();

    // The overlay starts BELOW the notice — the notice stays readable
    // (and dismissible) above the mode instead of being fenced off.
    const placed = await page.evaluate(() => {
      const overlay = document.getElementById('toolrail-overview').getBoundingClientRect();
      const visual = document.querySelector('.editor-visual-editor').getBoundingClientRect();
      const notice = document.querySelector('.components-notice').getBoundingClientRect();
      return {
        overlayAtCanvas: Math.abs(overlay.top - visual.top) < 2,
        noticeAboveOverlay: notice.bottom <= overlay.top + 2,
      };
    });
    expect(placed.overlayAtCanvas).toBe(true);
    expect(placed.noticeAboveOverlay).toBe(true);

    // The bug being pinned: the LAST block must be reachable. Pan hard
    // to the bottom; with the viewport measured past the notice it ends
    // fully inside the content region.
    const center = await page.evaluate(() => {
      const o = document.getElementById('toolrail-overview').getBoundingClientRect();
      return { x: o.left + o.width / 2, y: o.top + o.height / 2 };
    });
    await page.mouse.move(center.x, center.y);
    await page.mouse.wheel(0, 4000);
    await expect.poll(async () => page.evaluate(() => {
      const content = document.querySelector('.interface-interface-skeleton__content');
      const frame = document.querySelector('iframe[name="editor-canvas"]');
      const order = window.wp.data.select('core/block-editor').getBlockOrder('');
      const last = frame.contentDocument.querySelector(`[data-block="${order[order.length - 1]}"]`);
      const f = frame.getBoundingClientRect();
      const k = frame.offsetWidth ? f.width / frame.offsetWidth : 1;
      const r = last.getBoundingClientRect();
      return f.top + (r.top + r.height) * k <= content.getBoundingClientRect().bottom + 1;
    })).toBe(true);

    // Removing the notice mid-overview refits: the canvas grows back
    // and the overlay climbs to the reclaimed top. (No window event
    // fires for this — the ResizeObserver is what catches it.)
    await page.evaluate(() => {
      window.wp.data.dispatch('core/notices').removeNotice('toolrail-e2e-autosave');
    });
    await expect.poll(async () => page.evaluate(() => {
      const overlay = document.getElementById('toolrail-overview').getBoundingClientRect();
      const content = document.querySelector('.interface-interface-skeleton__content').getBoundingClientRect();
      return Math.abs(overlay.top - content.top) < 2;
    })).toBe(true);
  });

  test('a stack of SHORT blocks at floor zoom still drags vertically — the 24px box floor must not fuse the column into one row', async ({ page }) => {
    await openNewPost(page);
    // Separators are the worst case for the row grouping: their painted
    // boxes hit positionOverviewBoxes' 24px minimum height at low zoom,
    // so every box in the column overlaps its neighbors vertically. A
    // vertical-only row test grouped the whole stack into ONE row and
    // handed a straight-down drag to the sideways X math (review
    // 2026-08-28, finding 1).
    //
    // A tall group LEADS the document: at floor zoom a bare stack of
    // separators is ~70px tall and sits entirely under the overview's
    // own bar, where no pointer can reach a box (elementFromPoint at
    // the first box's grab strip returns the zoom button). The group
    // pushes the separator stack below the bar.
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch('core/block-editor').resetBlocks([
        createBlock('core/group', {},
          Array.from({ length: 10 }, (_, i) =>
            createBlock('core/paragraph', { content: 'LEAD-' + i })
          )),
      ].concat(Array.from({ length: 12 }, () => createBlock('core/separator'))));
    });
    await expect.poll(async () => (await blockNames(page)).length).toBe(13);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    const ids = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlockOrder('')
    );
    // The separators are ids[1..12]; the group at ids[0] stays put.
    const FIRST_SEP = 1;

    // Zoom all the way out — the floor is where the box heights clamp,
    // which is the state the bug needs.
    const scale = () => page.evaluate(() =>
      parseFloat(document.body.style.getPropertyValue('--toolrail-overview-scale')) || 0
    );
    let k = await scale();
    for (let i = 0; i < 15; i += 1) {
      await page.locator('#toolrail-overview [data-ov-action="zoom-out"]').click();
      const next = await scale();
      const stalled = next >= k - 0.0001;
      k = next;
      if (stalled) {
        break;
      }
    }

    // Rects are only trustworthy once the zoom's reposition pass has run.
    await expect.poll(async () => page.evaluate((list) => list.every((id) => {
      const b = document.querySelector(`#toolrail-overview .toolrail-ov-box[data-clientid="${id}"]`);
      return b && b.style.display !== 'none' && b.getBoundingClientRect().width > 10;
    }), ids)).toBe(true);
    // Painted boxes, in current document order. Floored boxes OVERLAP
    // and the later one paints on top, so a box's only grabbable strip
    // is the sliver above its successor — press anywhere lower and the
    // gesture drags the wrong block. The box itself takes no pointer
    // (pointer-events: none); only its select button does, inset by the
    // 2px border. So the strip runs from this button's top to the next
    // button's top: about 3px here. The point stays fractional: aimed at
    // the box's own top, or rounded, it lands on the border, and Firefox
    // hit-tests that to the overview behind it (PR #63, 2026-10-14).
    const geometry = () => page.evaluate(() => {
      const sel = window.wp.data.select('core/block-editor');
      return sel.getBlockOrder('').map((id) => {
        const box = document.querySelector(`#toolrail-overview .toolrail-ov-box[data-clientid="${id}"]`);
        const r = box.getBoundingClientRect();
        const btn = box.querySelector('.toolrail-ov-selectbtn').getBoundingClientRect();
        return { id: id, top: r.top, bottom: r.bottom, height: r.height, x: r.left + r.width / 2, btnTop: btn.top };
      });
    });
    const grabPoint = (boxes, i) => ({
      x: boxes[i].x,
      y: boxes[i].btnTop + (i + 1 < boxes.length
        ? Math.max(0.5, Math.min(12, (boxes[i + 1].btnTop - boxes[i].btnTop) / 2))
        : 12),
    });

    let boxes = await geometry();
    // The premise of the test: the separator boxes really are at the
    // 24px floor (plus at most the 2px borders, depending on
    // box-sizing), they overlap their neighbors by more than half
    // because of it — exactly what a vertical-only row test would fuse
    // — and they sit BELOW the bar where the pointer can reach them.
    expect(Math.round(boxes[FIRST_SEP].height)).toBeLessThanOrEqual(30);
    expect(boxes[FIRST_SEP].bottom - boxes[FIRST_SEP + 1].top)
      .toBeGreaterThan(boxes[FIRST_SEP].height / 2);
    const barBottom = await page.evaluate(() =>
      document.querySelector('#toolrail-overview .toolrail-ov-bar').getBoundingClientRect().bottom
    );
    expect(boxes[FIRST_SEP].top).toBeGreaterThan(barBottom);

    // Straight down the SAME X, to a gap INSIDE the stack — the drop
    // target has to come from the pointer's Y. With the column fused
    // into one row the marker turns vertical and the X math hands back
    // the row's own first index, so the block never moves at all.
    const target = FIRST_SEP + 6;
    const from = grabPoint(boxes, FIRST_SEP);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, Math.round(boxes[target].top + boxes[target].height / 2 + 1), { steps: 10 });
    await expect(page.locator('.toolrail-ov-dropline:not(.is-vertical)')).toBeVisible();
    await expect(page.locator('.toolrail-ov-dropline.is-vertical')).toHaveCount(0);
    await page.mouse.up();

    await expect.poll(async () => page.evaluate((id) =>
      window.wp.data.select('core/block-editor').getBlockOrder('').indexOf(id), ids[FIRST_SEP]
    )).toBeGreaterThan(FIRST_SEP);
    const landed = await page.evaluate((id) =>
      window.wp.data.select('core/block-editor').getBlockOrder('').indexOf(id), ids[FIRST_SEP]
    );
    expect(landed).toBeLessThan(ids.length - 1);

    // And the same gesture carried past the last box still means "after
    // everything", the way it does for a stack of tall sections.
    //
    // Measure only once the boxes have settled after the first drop: in
    // document order, and unchanged across two reads. Measured mid-move,
    // a later box still sat above an earlier one, and the press grabbed
    // the wrong block (WebKit, PR #63, 2026-10-14). The boxes could also
    // STAY out of order: they kept the position measured while the canvas
    // still slid the blocks into place, and nothing moved them after the
    // slide ended (#78). This check then fails here, on the cause.
    await expect.poll(async () => {
      const first = await geometry();
      await page.waitForTimeout(100);
      const second = await geometry();
      return JSON.stringify(first) === JSON.stringify(second)
        && second.every((b, i) => i === 0 || b.top >= second[i - 1].top);
    }, { message: 'overview boxes settle in document order after the first drop' }).toBe(true);
    boxes = await geometry();
    const again = grabPoint(boxes, landed);
    await page.mouse.move(again.x, again.y);
    await page.mouse.down();
    await page.mouse.move(again.x, Math.round(boxes[boxes.length - 1].bottom + 6), { steps: 10 });
    await expect(page.locator('.toolrail-ov-dropline:not(.is-vertical)')).toBeVisible();
    await page.mouse.up();

    await expect.poll(async () => page.evaluate((id) =>
      window.wp.data.select('core/block-editor').getBlockOrder('').indexOf(id), ids[FIRST_SEP]
    )).toBe(ids.length - 1);
  });
});

/**
 * NVDA journeys 2026-09-11 (private/qa-2026-09-11-editrail.md, section 2):
 * the screen-reader findings that had a code fix.
 */
test.describe('NVDA findings 2026-09-11 (1.0.2)', () => {
  test('SR-3: Tab stays inside the Section overview and ends on Done, never in the browser chrome', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewParagraphs(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    const overlay = page.locator('#toolrail-overview');
    await expect(overlay.locator('.toolrail-ov-box')).toHaveCount(6);

    // The bar (zoom, Done) stays FIRST in DOM order, where it is drawn,
    // so Tab order and visual order agree (review 2026-09-13, finding 3);
    // containment comes from the overlay's keydown handler.
    const order = await page.evaluate(() => {
      const o = document.querySelector('#toolrail-overview');
      const list = o.querySelector('.toolrail-ov-list');
      const bar = o.querySelector('.toolrail-ov-bar');
      return !!(bar.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(order).toBe(true);

    const activeLabel = () => page.evaluate(() => {
      const a = document.activeElement;
      return a ? (a.getAttribute('aria-label') || a.textContent.trim()) : null;
    });
    const inside = () => page.evaluate(() => document.querySelector('#toolrail-overview').contains(document.activeElement));

    // Tab from the first section through the rest and on round the bar:
    // every stop stays inside, and Done is reached.
    const stops = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      stops.push({ label: await activeLabel(), inside: await inside() });
    }
    expect(stops.every((s) => s.inside), JSON.stringify(stops)).toBe(true);
    expect(stops.some((s) => s.label === 'Done')).toBe(true);

    // Wrap both ways: Tab on the last section lands on the bar's first
    // button; Shift+Tab on the bar's first button lands on the last section.
    await overlay.locator('.toolrail-ov-box [data-ov-action="pick"]').last().focus();
    await page.keyboard.press('Tab');
    expect(await activeLabel()).toBe('Zoom out');
    await page.keyboard.press('Shift+Tab');
    expect(await activeLabel()).toMatch(/^Paragraph, position 6 of 6/);
    expect(await inside()).toBe(true);

    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
  });
});
