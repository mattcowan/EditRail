/**
 * EditRail — appearance spec.
 *
 * Appearance: the presets, a custom color pair, and the contrast of the
 * focus rings and indicators.
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const { AUTH, openNewPost, getPref, setColor } = require('./helpers');

test.use({ storageState: AUTH });

/**
 * Regressions found by driving the editor by hand (2026-08-26). Each test
 * here failed before its fix; the block-count assertions in
 * 'armed-tool insertion' were tightened in the same pass, because the
 * originals could not see the stray-block bug at all.
 */
test.describe('regressions', () => {
  test('every declared focus ring clears 3:1 against its own surface', async ({ page }) => {
    await openNewPost(page);

    // Each surface has to be LIVE to be measured, and the two cannot be
    // open at once: opening the gear runs closeFlyout(), and clicking a
    // rail tool closes the dialog via the outside-mousedown handler. So
    // sweep once per surface and merge.
    //
    // The bug this replaces a weaker test for lived in the settings
    // dialog, not on the rail: the dialog was assumed to be a light
    // surface and its four controls were left on #3858e9, which is 2.99:1
    // on the #1e1e1e it actually is. A sweep that only ever looked at the
    // rail could not see that.
    const sweep = () => page.evaluate(() => {
      const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const parse = (c) => {
        const m = c && c.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(',').map(parseFloat);
        return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
      };
      // Nearest ancestor painting an opaque background.
      const surfaceFrom = (el) => {
        let n = el;
        while (n && n !== document.documentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0.95) return c.rgb;
          n = n.parentElement;
        }
        return [255, 255, 255];
      };
      const ratio = (a, b) => {
        const l1 = lum(a);
        const l2 = lum(b);
        return +((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2);
      };

      const region = document.getElementById('toolrail-region');
      const token = getComputedStyle(region).getPropertyValue('--toolrail-focus-ring').trim();
      const probe = document.createElement('div');
      probe.style.color = token;
      document.body.appendChild(probe);
      const ring = parse(getComputedStyle(probe).color);
      probe.remove();

      const results = [];
      for (const sheet of Array.from(document.styleSheets)) {
        // Match the FILE, not the plugin folder: wp-env mounts the checkout
        // under the repo's directory name (editor-tool-rail in CI), so a
        // folder match found no sheet there and the sweep passed vacuously.
        if (!sheet.href || sheet.href.indexOf('/assets/editor-rail.css') === -1) continue;
        let rules;
        try {
          rules = Array.from(sheet.cssRules);
        } catch (e) {
          continue;
        }
        for (const rule of rules) {
          if (!rule.selectorText || rule.selectorText.indexOf(':focus-visible') === -1) continue;
          // The Section overview's chips draw on the EDITOR, not on the
          // rail, and deliberately sit on a fixed palette instead of
          // the appearance tokens (the 0.1.4 snap-preview boundary) —
          // and they only exist while the overview is open. Their ring
          // is measured by its own test in the overview suite.
          if (rule.selectorText.indexOf('.toolrail-ov-') !== -1) continue;
          const declared = rule.style.getPropertyValue('outline');
          if (!declared) continue;
          // Every focus ring must go through the shared token, or it is
          // not covered by the measurement below.
          const usesToken = declared.indexOf('var(--toolrail-focus-ring)') !== -1;
          const offset = parseFloat(rule.style.getPropertyValue('outline-offset')) || 0;
          for (const sel of rule.selectorText.split(',')) {
            const base = sel.trim().replace(/:focus-visible/g, '');
            const el = document.querySelector(base);
            if (!el) {
              results.push({ selector: sel.trim(), found: false });
              continue;
            }
            // A non-negative offset draws the ring OUTSIDE the border box,
            // so the colour behind it is the parent's, not the element's.
            // Measuring the element's own background instead reads a
            // pressed tool's blue fill and reports a false failure.
            const surface = surfaceFrom(offset >= 0 ? el.parentElement : el);
            results.push({
              selector: sel.trim(),
              found: true,
              usesToken,
              ratio: ratio(ring.rgb, surface),
            });
          }
        }
      }
      return { token, results };
    });

    // Shape is shelved; a registered child on the pinned Text slot
    // provides the live flyout surface to measure.
    await page.evaluate(() => {
      window.toolrail.registerTool({
        id: 'e2e-sweep-child',
        label: 'E2E Sweep Child',
        parent: 'text',
        insertBlock: 'core/quote',
      });
    });
    await page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.toolrail-flyout')).toBeVisible();
    const withFlyout = await sweep();

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await expect(page.locator('.toolrail-settings')).toBeVisible();
    const withDialog = await sweep();

    // Merge: keep the pass in which each selector actually resolved.
    const bySelector = new Map();
    for (const r of withFlyout.results.concat(withDialog.results)) {
      if (!bySelector.has(r.selector) || (!bySelector.get(r.selector).found && r.found)) {
        bySelector.set(r.selector, r);
      }
    }
    const results = Array.from(bySelector.values());

    // Guard against a vacuous pass: the sweep must have found the rules and
    // resolved a real colour.
    expect(withFlyout.token).toBeTruthy();
    expect(results.length).toBeGreaterThanOrEqual(6);
    const missing = results.filter((r) => !r.found);
    expect(missing, `no live element for — ${JSON.stringify(missing)}`).toEqual([]);
    expect(results.filter((r) => !r.usesToken)).toEqual([]);

    const failing = results.filter((r) => r.ratio < 3);
    expect(failing, `focus rings below 3:1 — ${JSON.stringify(failing)}`).toEqual([]);
  });
});

test.describe('appearance', () => {
  test('presets recolor the rail and its surfaces, and persist', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('input[data-appearance="light"]').check();

    await expect.poll(async () => page.evaluate(() =>
      getComputedStyle(document.getElementById('toolrail-rail')).backgroundColor
    )).toBe('rgb(255, 255, 255)');
    expect(JSON.parse(await getPref(page, 'toolrail-appearance')).mode).toBe('light');

    // The dialog inherits the region's tokens — one surface tone.
    expect(await page.evaluate(() =>
      getComputedStyle(document.querySelector('.toolrail-settings')).backgroundColor
    )).toBe('rgb(255, 255, 255)');

    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    expect(await page.evaluate(() =>
      getComputedStyle(document.getElementById('toolrail-rail')).backgroundColor
    )).toBe('rgb(255, 255, 255)');

    // Dark clears the inline tokens instead of restating them, so the
    // stylesheet defaults are back in charge.
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('input[data-appearance="dark"]').check();
    await expect.poll(async () => page.evaluate(() =>
      getComputedStyle(document.getElementById('toolrail-rail')).backgroundColor
    )).toBe('rgb(30, 30, 30)');
    expect(await page.evaluate(() =>
      document.getElementById('toolrail-region').style.getPropertyValue('--toolrail-bg')
    )).toBe('');
  });

  test('a custom pair applies; a low-contrast pair warns in text but is honored', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('input[data-appearance="custom"]').check();

    await expect(page.locator('#toolrail-settings-appearance-bg')).toBeEnabled();

    // A hostile pair: mid-grays at ~1.6:1.
    await setColor(page, 'toolrail-settings-appearance-bg', '#777777');
    await setColor(page, 'toolrail-settings-appearance-fg', '#999999');

    await expect.poll(async () => page.evaluate(() =>
      getComputedStyle(document.getElementById('toolrail-rail')).backgroundColor
    )).toBe('rgb(119, 119, 119)');

    // The warning is text in the dialog (and spoken via wp.a11y), never
    // color alone — and it renders INSIDE the Appearance section, beside
    // the swatches it is about. It must NOT land in the Saved-sets
    // status, which is bound as the import file input's accessible
    // description (review 2026-08-26: a screen-reader user tabbing to
    // Import heard the contrast warning read as that control's
    // description).
    await expect(page.locator('.toolrail-settings-appearance #toolrail-settings-appearance-status'))
      .toContainText('below the 4.5:1 minimum');
    await expect(page.locator('#toolrail-settings-status')).not.toContainText('4.5:1');
    expect(JSON.parse(await getPref(page, 'toolrail-appearance')))
      .toEqual({ mode: 'custom', bg: '#777777', fg: '#999999' });
  });

  test('the derived indicators hold their floors for hostile pairs', async ({ page }) => {
    await openNewPost(page);

    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator('input[data-appearance="custom"]').check();

    const measure = () => page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('toolrail-region'));
      const get = (t) => cs.getPropertyValue('--toolrail-' + t).trim();
      const h2r = (h) => {
        const m = h.replace('#', '');
        return [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16));
      };
      const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a, b) => {
        const l1 = lum(h2r(a));
        const l2 = lum(h2r(b));
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      return {
        ring: ratio(get('focus-ring'), get('bg')),
        pressedEdge: ratio(get('pressed-edge'), get('bg')),
        status: ratio(get('status'), get('bg')),
      };
    });

    // Mid-gray pair (~1.6:1): both brand ring candidates fail, so the
    // black/white fallback must carry the 3:1 floor.
    await setColor(page, 'toolrail-settings-appearance-bg', '#777777');
    await setColor(page, 'toolrail-settings-appearance-fg', '#999999');
    const midGray = await measure();
    expect(midGray.ring).toBeGreaterThanOrEqual(3);
    expect(midGray.pressedEdge).toBeGreaterThanOrEqual(3);
    expect(midGray.status).toBeGreaterThanOrEqual(4.5);

    // The dark band from the review (bg luminance ≈0.033): the light
    // ring candidate clears 3:1 but NOT 4.5, and the pair itself is
    // ~1.3:1 — before the fix the status token fell back to the raw
    // foreground and the "your colors fail contrast" warning itself
    // rendered near-invisible.
    await setColor(page, 'toolrail-settings-appearance-bg', '#333333');
    await setColor(page, 'toolrail-settings-appearance-fg', '#444444');
    const darkBand = await measure();
    expect(darkBand.ring).toBeGreaterThanOrEqual(3);
    expect(darkBand.pressedEdge).toBeGreaterThanOrEqual(3);
    expect(darkBand.status).toBeGreaterThanOrEqual(4.5);
  });
});
