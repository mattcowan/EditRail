/**
 * EditRail — toolbar spec.
 *
 * The toolbar itself: APG toolbar semantics and focus, tool flyouts,
 * overflow, which tools are available, what "pressed" means, and tooltips.
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const {
  AUTH,
  openNewPost,
  clickBelowContent,
  blockNames,
  setColor,
  seedOverviewBlocks,
} = require('./helpers');

test.use({ storageState: AUTH });

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
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveAttribute('aria-pressed', 'false');
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
    // Group leads the pinned slots (it was the built-in Section tool
    // until 0.1.22; owner decision 2026-09-02).
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('pin:core/group');
    await page.keyboard.press('End');
    const last = await page.evaluate(() => document.activeElement.dataset.tool);
    expect(last).toBeTruthy();
    // Home lands on the first toolbar control — Select, because the
    // wide-mode chevron is OPT-IN (0.1.12) and absent from a default
    // rail. The opted-in arrangement is pinned in the wide-mode suite.
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

test.describe('tool flyouts', () => {
  // The Shape tool — the only built-in flyout — is shelved with Phase 4,
  // so the flyout machinery is exercised the way a provider reaches it:
  // a registered tool nested under a pinned slot.
  test('ArrowRight opens a pinned parent\'s flyout, Escape returns focus, picking arms and inserts', async ({ page }) => {
    await openNewPost(page);

    await page.evaluate(() => {
      window.toolrail.registerTool({
        id: 'e2e-flyout-child',
        label: 'E2E Flyout Child',
        parent: 'text',
        insertBlock: 'core/quote',
      });
    });

    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').focus();
    await page.keyboard.press('ArrowRight');

    const flyout = page.locator('.toolrail-flyout');
    await expect(flyout).toBeVisible();
    await expect(flyout).toHaveAttribute('role', 'menu');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('e2e-flyout-child');

    await page.keyboard.press('Escape');
    await expect(flyout).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('pin:core/paragraph');

    // Pick the child: the parent lights (a child is armed), the canvas
    // click inserts the child's block.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveAttribute('aria-pressed', 'true');
    await clickBelowContent(page);
    expect(await blockNames(page)).toContain('core/quote');
  });

  test('the Shape tool is shelved: not rendered, its id still reserved', async ({ page }) => {
    await openNewPost(page);

    await expect(page.locator('#toolrail-rail [data-tool="shape"]')).toHaveCount(0);

    // The id stays reserved so a provider cannot squat on it before
    // Phase 4 reclaims the tool.
    const refused = await page.evaluate(() =>
      window.toolrail.registerTool({ id: 'shape', onActivate: () => {} })
    );
    expect(refused).toBe(false);
    const childRefused = await page.evaluate(() =>
      window.toolrail.registerTool({ id: 'shape-circle', onActivate: () => {} })
    );
    expect(childRefused).toBe(false);
  });
});

/**
 * Regressions found by driving the editor by hand (2026-08-26). Each test
 * here failed before its fix; the block-count assertions in
 * 'armed-tool insertion' were tightened in the same pass, because the
 * originals could not see the stray-block bug at all.
 */
test.describe('regressions', () => {
  test('Tab out of a flyout closes it', async ({ page }) => {
    await openNewPost(page);

    // Shape is shelved, so the flyout rides a registered child on the
    // pinned Text slot — the provider path.
    await page.evaluate(() => {
      window.toolrail.registerTool({
        id: 'e2e-tabout-child',
        label: 'E2E Tabout Child',
        parent: 'text',
        insertBlock: 'core/quote',
      });
    });
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.toolrail-flyout')).toBeVisible();

    await page.keyboard.press('Tab');

    await expect(page.locator('.toolrail-flyout')).toHaveCount(0);
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  test('keyboard focus genuinely matches :focus-visible on the rail', async ({ page }) => {
    await openNewPost(page);

    // The previous version used programmatic .focus(), which does not
    // reliably match :focus-visible in Chromium — and because the base
    // .toolrail-tool declares no outline of its own, getComputedStyle fell
    // back to currentColor (#e0e0e0, 12.6:1) and the assertion passed no
    // matter what the ring was actually set to.
    await page.locator('#toolrail-rail [data-tool="select"]').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');

    const state = await page.evaluate(() => {
      const btn = document.querySelector('#toolrail-rail [data-tool="select"]');
      return {
        isActive: document.activeElement === btn,
        matchesFocusVisible: btn.matches(':focus-visible'),
        outlineColor: getComputedStyle(btn).outlineColor,
        outlineWidth: getComputedStyle(btn).outlineWidth,
      };
    });

    expect(state.isActive).toBe(true);
    expect(state.matchesFocusVisible).toBe(true);
    // Exact colour, so a regression to #3858e9 fails loudly rather than
    // sliding through on a fallback.
    expect(state.outlineColor).toBe('rgb(123, 144, 255)');
    expect(state.outlineWidth).toBe('2px');
  });
});

test.describe('rail overflow', () => {
  test('an overfull rail scrolls its tools while Help and Settings stay visible', async ({ page }) => {
    await openNewPost(page);

    // Force overflow regardless of how many tools this site registers.
    await page.evaluate(() => {
      ['core/quote', 'core/list', 'core/cover', 'core/gallery', 'core/audio', 'core/video',
        'core/table', 'core/verse', 'core/code', 'core/buttons', 'core/columns', 'core/group',
        'core/pullquote', 'core/preformatted', 'core/separator', 'core/spacer']
        .forEach((n) => window.toolrail.pinBlock(n));
    });

    const m = await page.evaluate(() => {
      const rail = document.getElementById('toolrail-rail');
      const scroll = rail.querySelector('.toolrail-scroll');
      const gear = rail.querySelector('[data-tool="settings"]');
      const help = rail.querySelector('[data-tool="help"]');
      const railRect = rail.getBoundingClientRect();
      return {
        // The tools section is what scrolls…
        scrollOverflows: scroll.scrollHeight > scroll.clientHeight + 1,
        // …while the rail itself does not, so the tail cannot be pushed
        // below the fold (pre-fix: the whole rail scrolled and the gear
        // — the recovery path for everything — was the first casualty).
        railOverflows: rail.scrollHeight > rail.clientHeight + 1,
        gearVisible: gear.getBoundingClientRect().bottom <= railRect.bottom + 1,
        helpVisible: help.getBoundingClientRect().bottom <= railRect.bottom + 1,
        gearOnScreen: gear.getBoundingClientRect().bottom <= window.innerHeight,
      };
    });
    expect(m.scrollOverflows).toBe(true);
    expect(m.railOverflows).toBe(false);
    expect(m.gearVisible).toBe(true);
    expect(m.helpVisible).toBe(true);
    expect(m.gearOnScreen).toBe(true);

    // NO native scrollbars: the classic vertical bar stole width from
    // the 44px tools, which then overflowed sideways and summoned a
    // horizontal scrollbar strip (the owner's 2026-08-27 screenshot).
    const bars = await page.evaluate(() => {
      const scroll = document.querySelector('#toolrail-rail .toolrail-scroll');
      return {
        scrollbarWidth: getComputedStyle(scroll).scrollbarWidth,
        // clientWidth < offsetWidth would mean a scrollbar is consuming
        // layout width; horizontal overflow would show as scrollWidth
        // beyond clientWidth.
        stealsWidth: scroll.offsetWidth - scroll.clientWidth,
        xOverflow: scroll.scrollWidth - scroll.clientWidth,
      };
    });
    expect(bars.scrollbarWidth).toBe('none');
    expect(bars.stealsWidth).toBe(0);
    expect(bars.xOverflow).toBe(0);

    // The first tool sits ≥4px inside the scroll container: an overflow
    // container clips descendant painting at its padding box, and the
    // focus ring (2px stroke + 2px offset) needs those 4px — at inset 0
    // the initial tab stop's ring lost its outer stroke (review
    // 2026-08-27, finding 3, confirmed by measurement).
    const ringInset = await page.evaluate(() => {
      const scroll = document.querySelector('#toolrail-rail .toolrail-scroll');
      scroll.scrollTop = 0;
      const first = scroll.querySelector('.toolrail-tool');
      return first.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    });
    expect(ringInset).toBeGreaterThanOrEqual(4);

    // The step buttons are the affordance: only "more below" shows at
    // the top, both directions mid-scroll, only "more above" at the end.
    const steps = (sel) => page.locator('#toolrail-rail ' + sel);
    await expect(steps('.toolrail-scrollbtn[data-dir="next"]')).toBeVisible();
    await expect(steps('.toolrail-scrollbtn[data-dir="prev"]')).toBeHidden();
    await steps('.toolrail-scrollbtn[data-dir="next"]').click();
    await expect(steps('.toolrail-scrollbtn[data-dir="prev"]')).toBeVisible();
    await page.evaluate(() => {
      const scroll = document.querySelector('#toolrail-rail .toolrail-scroll');
      scroll.scrollTop = scroll.scrollHeight;
    });
    await expect(steps('.toolrail-scrollbtn[data-dir="next"]')).toBeHidden();
    await expect(steps('.toolrail-scrollbtn[data-dir="prev"]')).toBeVisible();

    // The roving tabindex spans the split containers: End still reaches
    // the gear in the pinned tail — and the step buttons, being pointer
    // sugar, are not part of the arrow order.
    await page.locator('#toolrail-rail [data-tool="select"]').focus();
    await page.keyboard.press('End');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('settings');
  });
});

/**
 * R9 — tool availability, and R10 — what "pressed" means. Before R9 the
 * overview disarmed on ENTRY only: any insert tool could be re-armed
 * under it, went pressed, and could never insert because the overlay
 * captures every canvas pointer event (measured 2026-08-28).
 */
test.describe('tool availability (R9) and pressed semantics (R10)', () => {
  const a11yText = (page) => page.evaluate(() => {
    const region = document.getElementById('a11y-speak-polite');
    return region ? region.textContent : '';
  });

  test('the overview dims exactly the canvas tools; a dimmed tool cannot arm; closing restores everything', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);

    // Three provider tools that pin the contract down from both sides:
    // an onActivate panel (default canvas: false — a theme's sidebar
    // tool, the case that proves "disable everything" is wrong), an onActivate
    // that DECLARES it needs the canvas, and an insert tool that
    // declares it does not.
    await page.evaluate(() => {
      window.__e2eFired = [];
      window.__e2eModes = [];
      window.addEventListener('toolrail:mode-changed', (e) => window.__e2eModes.push(e.detail.mode));
      window.toolrail.registerTool({
        id: 'e2e-panel', label: 'E2E Panel',
        onActivate: () => { window.__e2eFired.push('panel'); },
      });
      window.toolrail.registerTool({
        id: 'e2e-needs-canvas', label: 'E2E Needs Canvas',
        onActivate: () => { window.__e2eFired.push('needs-canvas'); },
        supports: { canvas: true },
      });
      window.toolrail.registerTool({
        id: 'e2e-insert-nocanvas', label: 'E2E Insert No Canvas',
        insertBlock: 'core/quote',
        supports: { canvas: false },
      });
    });
    expect(await page.evaluate(() => window.toolrail.getMode())).toBe('edit');

    const rail = (id) => page.locator(`#toolrail-rail [data-tool="${id}"]`);
    const section = rail('pin:core/group');
    const overview = rail('overview');

    // Control for the dimming assertions below: nothing is dimmed in
    // edit mode, and the tooltip carries no reason.
    await expect(page.locator('#toolrail-rail [aria-disabled="true"]')).toHaveCount(0);
    const plainTitle = await section.getAttribute('title');
    expect(plainTitle).not.toContain('not available');

    await overview.click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    expect(await page.evaluate(() => window.toolrail.getMode())).toBe('overview');

    // Dimmed: everything whose activation is completed by a canvas click.
    for (const id of ['pin:core/group', 'pin:core/paragraph', 'pin:core/heading', 'pin:core/image', 'e2e-needs-canvas']) {
      await expect(rail(id), id).toHaveAttribute('aria-disabled', 'true');
    }
    // Live: Select (the "no tool" state), the overview toggle, both
    // chrome buttons, the panel tool, and the insert tool that opted out.
    for (const id of ['select', 'overview', 'help', 'settings', 'e2e-panel', 'e2e-insert-nocanvas']) {
      await expect(rail(id), id).not.toHaveAttribute('aria-disabled', 'true');
    }

    // The reason rides the pointer tooltip; the NAME is unchanged (the
    // dimmed state itself is what aria-disabled conveys).
    expect(await section.getAttribute('title')).toBe(plainTitle + ' — not available in Section overview');
    expect(await section.getAttribute('aria-label')).toBe('Group (pinned block)');

    // One announcement covers the lot, folded into the open message.
    await expect.poll(() => a11yText(page)).toContain('Insert tools are unavailable until you close the overview.');

    // A dimmed tool is inert: no arm, no pressed, Select stays pressed.
    // (force: Playwright's own actionability check refuses to click
    // aria-disabled controls — the rail's handler is what is under test.)
    await section.click({ force: true });
    await expect(section).toHaveAttribute('aria-pressed', 'false');
    await expect(rail('select')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.toolrail.getActiveTool())).toBe('select');
    await rail('e2e-needs-canvas').click({ force: true });
    expect(await page.evaluate(() => window.__e2eFired)).toEqual([]);
    // …while a live provider tool still runs — the whole point of a
    // capability flag over a blanket disable.
    await rail('e2e-panel').click();
    expect(await page.evaluate(() => window.__e2eFired)).toEqual(['panel']);

    // R10: the open toggle says so in its tooltip. Its pressed state is
    // "surface open", and Select's is "nothing armed" — both true.
    expect(await overview.getAttribute('title')).toContain(' — open');
    await expect(overview).toHaveAttribute('aria-pressed', 'true');

    // Close: every dimming lifts, tooltips return to plain.
    await page.locator('#toolrail-overview [data-ov-action="close"]').click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    await expect(page.locator('#toolrail-rail [aria-disabled="true"]')).toHaveCount(0);
    expect(await section.getAttribute('title')).toBe(plainTitle);
    expect(await overview.getAttribute('title')).not.toContain(' — open');
    expect(await page.evaluate(() => window.toolrail.getMode())).toBe('edit');
    expect(await page.evaluate(() => window.__e2eModes)).toEqual(['overview', 'edit']);

    // And the tool arms again — restoration is real, not cosmetic.
    await section.click();
    await expect(section).toHaveAttribute('aria-pressed', 'true');
  });

  test('dimmed tools keep their place in the arrow-key order and keep focus', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/group"]')).toHaveAttribute('aria-disabled', 'true');

    // Enter the rail at Select (live) and arrow onto Group (dimmed).
    // Mutation check: swap aria-disabled for the disabled attribute and
    // this fails — a natively disabled button refuses focus(), so the
    // roving tabindex lands nowhere and activeElement stays on Select.
    await page.locator('#toolrail-rail [data-tool="select"]').focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('pin:core/group');
    expect(await page.evaluate(() => document.activeElement.getAttribute('aria-disabled'))).toBe('true');

    // Enter on the dimmed button is inert too (the click path is the
    // keyboard path for a native button).
    await page.keyboard.press('Enter');
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/group"]')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('pin:core/group');

    // The order continues past it: the next arrow reaches the pinned
    // Paragraph slot, also dimmed, also focusable.
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement.dataset.tool)).toBe('pin:core/paragraph');
  });

  test('a flyout with one live child stays live and opens instead of arming; its dimmed child is inert', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);

    await page.evaluate(() => {
      window.__e2eFired = [];
      window.toolrail.registerTool({
        id: 'e2e-fly-insert', label: 'E2E Fly Insert', parent: 'text', insertBlock: 'core/quote',
      });
      window.toolrail.registerTool({
        id: 'e2e-fly-panel', label: 'E2E Fly Panel', parent: 'text',
        onActivate: () => { window.__e2eFired.push('fly-panel'); },
      });
    });

    const text = page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]');
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-overview')).toBeVisible();

    // Mixed flyout: the parent's OWN action (arm Paragraph) is
    // unavailable, but a child is live, so the button is not dimmed…
    await expect(text).not.toHaveAttribute('aria-disabled', 'true');
    // …and Heading, with no children, is (the control).
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/heading"]')).toHaveAttribute('aria-disabled', 'true');

    // Click opens the flyout rather than arming the parent.
    await text.click();
    await expect(page.locator('.toolrail-flyout')).toBeVisible();
    await expect(text).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => window.toolrail.getActiveTool())).toBe('select');

    // Children are judged one by one.
    const insertItem = page.locator('.toolrail-flyout [data-tool="e2e-fly-insert"]');
    const panelItem = page.locator('.toolrail-flyout [data-tool="e2e-fly-panel"]');
    await expect(insertItem).toHaveAttribute('aria-disabled', 'true');
    await expect(panelItem).not.toHaveAttribute('aria-disabled', 'true');
    expect(await insertItem.getAttribute('title')).toContain('not available in Section overview');

    // The dimmed item does nothing (the flyout even stays open); the
    // live one runs.
    await insertItem.click({ force: true });
    expect(await page.evaluate(() => window.toolrail.getActiveTool())).toBe('select');
    await expect(page.locator('.toolrail-flyout')).toBeVisible();
    await panelItem.click();
    expect(await page.evaluate(() => window.__e2eFired)).toEqual(['fly-panel']);

    // Back in edit mode the parent arms on click again, as it always did.
    await page.locator('#toolrail-overview [data-ov-action="close"]').click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    await text.click();
    await expect(text).toHaveAttribute('aria-pressed', 'true');
  });

  test('an open toggle shows the edge bar without the armed fill; Help and Options show the bar while their dialog is open', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);

    const paint = (id) => page.evaluate((toolId) => {
      const btn = document.querySelector(`#toolrail-rail [data-tool="${toolId}"]`);
      return {
        kind: btn.dataset.kind || null,
        bg: getComputedStyle(btn).backgroundColor,
        bar: getComputedStyle(btn, '::before').width,
      };
    }, id);

    // Control: an ARMED tool is fill + bar.
    await page.locator('#toolrail-rail [data-tool="pin:core/group"]').click();
    const armed = await paint('pin:core/group');
    expect(armed.kind).toBe('arming');
    expect(armed.bar).toBe('3px');
    expect(armed.bg).not.toBe('rgba(0, 0, 0, 0)');
    const armedFill = armed.bg;

    // The open overview: bar, no fill — pressed, but a different blue.
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-rail [data-tool="overview"]')).toHaveAttribute('aria-pressed', 'true');
    const open = await paint('overview');
    expect(open.kind).toBe('toggle');
    expect(open.bar).toBe('3px');
    expect(open.bg).not.toBe(armedFill);
    await page.locator('#toolrail-overview [data-ov-action="close"]').click();
    await expect(page.locator('#toolrail-overview')).toHaveCount(0);
    expect((await paint('overview')).bar).not.toBe('3px');

    // Help and Options: aria-expanded (a dialog opener is not a pressed
    // toggle), and the bar while open, so an open panel has SOME visible
    // state on the rail.
    for (const id of ['help', 'settings']) {
      expect((await paint(id)).bar, id + ' closed').not.toBe('3px');
      await page.locator(`#toolrail-rail [data-tool="${id}"]`).click();
      await expect(page.locator(`#toolrail-rail [data-tool="${id}"]`)).toHaveAttribute('aria-expanded', 'true');
      const shown = await paint(id);
      expect(shown.bar, id + ' open').toBe('3px');
      expect(shown.bg, id + ' open').not.toBe(armedFill);
      await page.keyboard.press('Escape');
      await expect(page.locator(`#toolrail-rail [data-tool="${id}"]`)).toHaveAttribute('aria-expanded', 'false');
    }
  });

  test('every appearance keeps a dimmed icon at 3:1 or better, including a hostile custom pair\'s fallback', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/group"]')).toHaveAttribute('aria-disabled', 'true');

    // Measured color of the dimmed icon against the rail background,
    // straight from computed style — the token, not opacity math.
    const ratio = () => page.evaluate(() => {
      const parse = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const fg = parse(getComputedStyle(document.querySelector('#toolrail-rail [data-tool="pin:core/group"]')).color);
      const bg = parse(getComputedStyle(document.getElementById('toolrail-rail')).backgroundColor);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    });

    // Dark (stylesheet default).
    expect(await ratio()).toBeGreaterThanOrEqual(3);
    // It is DIMMER than a live tool — the state is visible, not just
    // announced.
    const liveRatio = await page.evaluate(() => {
      const parse = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const fg = parse(getComputedStyle(document.querySelector('#toolrail-rail [data-tool="help"]')).color);
      const bg = parse(getComputedStyle(document.getElementById('toolrail-rail')).backgroundColor);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    });
    expect(await ratio()).toBeLessThan(liveRatio);

    // Light and Gray presets, then a custom pair. The settings dialog
    // is live under the overview (canvas: false), so this can run
    // without leaving the mode.
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    const dimToken = () => page.evaluate(() =>
      document.getElementById('toolrail-region').style.getPropertyValue('--toolrail-dim')
    );
    // The preset must CARRY its own token (review 2026-08-29: a bare
    // >= 3 here passed on the stylesheet's dark default alone).
    for (const [preset, token] of [['light', '#838383'], ['gray', '#737679']]) {
      await page.locator(`input[data-appearance="${preset}"]`).check();
      await expect.poll(() => dimToken(), preset).toBe(token);
      expect(await ratio(), preset).toBeGreaterThanOrEqual(3);
    }
    await page.locator('input[data-appearance="custom"]').check();
    await setColor(page, 'toolrail-settings-appearance-bg', '#ffffff');
    await setColor(page, 'toolrail-settings-appearance-fg', '#1e1e1e');
    await expect.poll(() => ratio(), 'custom good pair').toBeGreaterThanOrEqual(3);
    // An ORDINARY passing pair (7.46:1 in the dialog) must still get a
    // dim that is visibly not the foreground — the first derivation
    // collapsed exactly here (review 2026-08-29: the 45% mix measured
    // 2.55:1, failed the floor, and dim === fg with no warning shown).
    await setColor(page, 'toolrail-settings-appearance-fg', '#555555');
    await expect.poll(() => dimToken(), 'ordinary pair').not.toBe('#555555');
    expect(await ratio(), 'ordinary pair on bg').toBeGreaterThanOrEqual(3);
    expect(await ratio(), 'ordinary pair dimmer than fg').toBeLessThan(await liveRatioNow());
    // A hostile pair cannot clear 3:1 at all (fg:bg itself is ~1.6:1);
    // the derivation then falls back to the pair's own fg rather than
    // a still-dimmer mix — the dialog already warns about that pair.
    await setColor(page, 'toolrail-settings-appearance-bg', '#777777');
    await setColor(page, 'toolrail-settings-appearance-fg', '#999999');
    await expect.poll(() => dimToken(), 'hostile pair').toBe('#999999');

    async function liveRatioNow() {
      return page.evaluate(() => {
        const parse = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
        const lum = (rgb) => {
          const [r, g, b] = rgb.map((v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const fg = parse(getComputedStyle(document.querySelector('#toolrail-rail [data-tool="help"]')).color);
        const bg = parse(getComputedStyle(document.getElementById('toolrail-rail')).backgroundColor);
        const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
        return (hi + 0.05) / (lo + 0.05);
      });
    }
  });

  test('the wide-mode chevron is a toggle: bar, no armed fill (review 2026-08-29)', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('#toolrail-settings-widetoggle').check();
    await page.keyboard.press('Escape');
    const chevron = page.locator('#toolrail-rail [data-tool="wide-toggle"]');
    await expect(chevron).toBeVisible();
    await chevron.click();
    await expect(chevron).toHaveAttribute('aria-pressed', 'true');
    const armedFill = await page.evaluate(() =>
      getComputedStyle(document.getElementById('toolrail-region')).getPropertyValue('--toolrail-pressed').trim()
    );
    const paint = await page.evaluate(() => {
      const btn = document.querySelector('#toolrail-rail [data-tool="wide-toggle"]');
      return { kind: btn.dataset.kind, bg: getComputedStyle(btn).backgroundColor, bar: getComputedStyle(btn, '::before').width };
    });
    expect(paint.kind).toBe('toggle');
    expect(paint.bar).toBe('3px');
    // #3858e9 is rgb(56, 88, 233); the toggle must not wear it.
    expect(paint.bg).not.toBe('rgb(56, 88, 233)');
    expect(armedFill).toBe('#3858e9');
  });

  test('ArrowRight does not open the flyout of a fully dimmed container (review 2026-08-29)', async ({ page }) => {
    await openNewPost(page);
    await seedOverviewBlocks(page);
    // Two arming children under Heading: the parent AND every child
    // need the canvas, so the button dims as a unit.
    await page.evaluate(() => {
      window.toolrail.registerTool({ id: 'e2e-h-a', label: 'A', parent: 'heading', insertBlock: 'core/quote' });
      window.toolrail.registerTool({ id: 'e2e-h-b', label: 'B', parent: 'heading', insertBlock: 'core/list' });
    });
    const heading = page.locator('#toolrail-rail [data-tool="pin:core/heading"]');
    // Control: in edit mode the key opens it.
    await heading.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.toolrail-flyout')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.toolrail-flyout')).toHaveCount(0);

    await page.locator('#toolrail-rail [data-tool="overview"]').click();
    await expect(heading).toHaveAttribute('aria-disabled', 'true');
    await heading.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    await expect(page.locator('.toolrail-flyout')).toHaveCount(0);
  });
});

/**
 * NVDA journeys 2026-09-11 (private/qa-2026-09-11-editrail.md, section 2):
 * the screen-reader findings that had a code fix.
 */
test.describe('NVDA findings 2026-09-11 (1.0.2)', () => {
  test('SR-1: a tool\'s tooltip is its label alone (or the author\'s description), never a how-to hint', async ({ page }) => {
    await openNewPost(page);
    // NVDA reads `title` as the accessible description, so a generic
    // how-to there was heard on every stop down the rail.
    const titles = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#toolrail-rail [data-tool^="pin:"], #toolrail-rail [data-tool="overview"]'))
        .map((b) => ({ id: b.dataset.tool, label: b.getAttribute('aria-label'), title: b.title }))
    );
    expect(titles.length).toBeGreaterThanOrEqual(5);
    for (const t of titles) {
      expect(t.title, `${t.id} tooltip`).toBe(t.label);
    }
    // An author-written description still rides the tooltip and the
    // accessible description.
    await page.evaluate(() => window.toolrail.setPinMeta('core/heading', { description: 'Adds a section title' }));
    const heading = page.locator('#toolrail-rail [data-tool="pin:core/heading"]');
    await expect(heading).toHaveAttribute('title', 'Heading (pinned block) — Adds a section title');
    await expect(heading).toHaveAttribute('aria-description', 'Adds a section title');
  });

  /**
   * SR-2, traced 2026-09-22. Only the rail's arrow/Home/End handler moved
   * the roving tab stop, so focus that reached a tool any other way — a
   * mouse click, or a screen reader that moves focus onto the button it
   * activates — left the stop behind on the last arrowed-to tool. Tab from
   * the focused tool then went to that stop when it sat later in the DOM,
   * instead of leaving the toolbar. The NVDA journey hit exactly this: End
   * left the stop on Toolbar settings, focus was put on Paragraph, and Tab
   * landed on Toolbar settings in focus mode too (so it was never NVDA's
   * browse mode). The APG toolbar pattern keeps the stop on the focused
   * item, whatever moved focus there.
   */
  test('SR-2: the tab stop follows focus, so Tab from a clicked tool leaves the toolbar', async ({ page }) => {
    await openNewPost(page);
    const rail = page.locator('#toolrail-rail');
    const stops = () => page.evaluate(() => Array.from(document.querySelectorAll('#toolrail-rail .toolrail-tool'))
      .filter((b) => b.tabIndex === 0).map((b) => b.dataset.tool));

    // End puts the one tab stop on the LAST tool.
    await rail.locator('[data-tool="select"]').focus();
    await page.keyboard.press('End');
    const last = (await stops())[0];
    expect(last).not.toBe('pin:core/paragraph');

    // A mouse click moves focus without the arrow handler.
    await rail.locator('[data-tool="pin:core/paragraph"]').click();
    expect(await stops()).toEqual(['pin:core/paragraph']);

    // Tab leaves the toolbar instead of stopping on the old tab stop.
    await page.keyboard.press('Tab');
    const inRail = await page.evaluate(() => !!document.activeElement.closest('#toolrail-rail'));
    expect(inRail).toBe(false);
  });
});
