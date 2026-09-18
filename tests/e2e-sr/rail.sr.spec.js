/**
 * EditRail — NVDA journeys (Guidepup + headed Firefox).
 *
 * Each test is one screen-reader journey through a core surface. The
 * speech log is the deliverable (tests/e2e-sr/logs/<journey>.json); the
 * assertions marked (SR-n) encode findings and are allowed to fail.
 *
 * Rules (see helpers.js): build state with Playwright, act through
 * `nvda.press` so the announcement is captured, read back the product
 * state with wp.data. Run with `npm run test:sr`; do not touch the
 * keyboard while it runs.
 */
const { nvdaTest: test } = require('@guidepup/playwright');
const { expect } = require('@playwright/test');
const { WindowsKeyCodes, WindowsModifiers } = require('@guidepup/guidepup');
const h = require('./helpers');

test.use({ nvdaStartOptions: { capture: true } });

const RAIL = '#toolrail-rail';
const SETTINGS = '#toolrail-region [role="dialog"][aria-labelledby="toolrail-settings-title"]';
const HELP = '#toolrail-region [role="dialog"][aria-labelledby="toolrail-help-title"]';
const OVERVIEW = '#toolrail-overview';

const BASELINE = {
  'toolrail-quick-slots': JSON.stringify(['core/group', 'core/paragraph', 'core/heading', 'core/image']),
  'toolrail-slots-migrated': '1',
  'toolrail-group-seeded': '1',
};
const RAIL_KEYS = ['toolrail-help-seen', 'toolrail-position', 'toolrail-quick-slots', 'toolrail-slot-configs', 'toolrail-slots-migrated', 'toolrail-help-hidden', 'toolrail-wide', 'toolrail-wide-toggle', 'toolrail-appearance', 'toolrail-group-seeded', 'toolrail-hide-core-inserter', 'toolrail-pin-meta', 'toolrail-set-meta'];

/** Reset the shared account to the fresh-install baseline (the e2e suite's teardown shape). */
async function resetPrefs(page) {
  await page.evaluate(({ keys, base }) => {
    keys.forEach((k) => { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } });
    const d = wp.data.dispatch('core/preferences');
    keys.forEach((k) => d.set('toolrail', k, undefined));
    Object.entries(base).forEach(([k, v]) => d.set('toolrail', k, v));
  }, { keys: RAIL_KEYS, base: BASELINE });
  await page.waitForTimeout(2500);
}

/**
 * What NVDA said for ONE command: the log entries added since before it.
 * `lastSpokenPhrase()` returns the last entry of the accumulated log, so a
 * silent step would hand back the previous step's phrase and an assertion
 * could go green on silence (review 2026-09-13, finding 2). Returns '' for
 * a silent step.
 */
async function spokenSince(nvda, before) {
  const log = await nvda.spokenPhraseLog();
  return log.slice(before).filter(Boolean).join(' ');
}

/** NVDA+Tab: report the current focus (captures what the user would hear after a Playwright-driven change). */
async function reportFocus(nvda) {
  const before = (await nvda.spokenPhraseLog()).length;
  await nvda.perform(nvda.keyboardCommands.reportCurrentFocus);
  await h.delay(400);
  return spokenSince(nvda, before);
}

async function press(nvda, key, wait = 600) {
  const before = (await nvda.spokenPhraseLog()).length;
  await nvda.press(key);
  await h.delay(wait);
  return spokenSince(nvda, before);
}

/**
 * Enter on the focused rail button through NVDA, retried once after a
 * mode toggle: in browse mode NVDA's Enter goes to its own caret, not the
 * DOM focus Playwright just set, so the first press can open nothing
 * (run 3, 2026-09-11: all three dialog journeys failed at this step).
 */
async function activateFocused(page, nvda, openSelector, wait) {
  const phrases = [];
  for (let i = 0; i < 3; i++) {
    phrases.push(await press(nvda, 'Enter', wait || 1200));
    if (await page.locator(openSelector).count()) return { phrase: phrases[phrases.length - 1], attempts: i + 1, phrases };
    await nvda.perform(nvda.keyboardCommands.toggleBetweenBrowseAndFocusMode);
    await h.delay(400);
  }
  return { phrase: phrases[phrases.length - 1], attempts: 3, phrases, failed: true };
}

async function open(page) {
  await h.openNewPost(page);
  await page.waitForSelector(RAIL, { timeout: 30000 });
  await page.waitForTimeout(800);
}

test.describe('EditRail with NVDA', () => {
  test.afterEach(async ({ page }, testInfo) => {
    // The journeys run against a REAL account and site, so a failed
    // cleanup is reported, never swallowed (review 2026-09-13, finding 6).
    // Reported, not thrown: a teardown throw would hide the journey's own
    // result.
    const resetError = await resetPrefs(page).then(() => null, (e) => e.message);
    const deleted = await h.deleteCurrentPost(page);
    if (resetError || !deleted) {
      const note = `[editrail test:sr] cleanup after "${testInfo.title}": prefs reset ${resetError ? 'FAILED: ' + resetError : 'ok'}; post ${deleted ? 'deleted (' + deleted + ')' : 'NOT deleted'}`;
      console.warn(note);
      testInfo.annotations.push({ type: 'cleanup', description: note });
    }
  });

  test('toolbar: arrow through tools, arm by Enter, insert, disarm', async ({ page, nvda }) => {
    await open(page);
    const focusTitles = await h.focusBrowser(page, nvda);
    const log = {};

    await page.locator(`${RAIL} [data-tool="select"]`).focus();
    await h.delay(400);
    log.focusSelect = await reportFocus(nvda);

    // What ArrowDown does BEFORE any mode switch (NVDA defaults to browse mode on a web page).
    log.arrowInDefaultMode = await press(nvda, 'ArrowDown');
    log.focusAfterArrowDefault = await h.describeFocus(page);

    // Make sure focus mode is on, then arrow along the rail.
    await page.locator(`${RAIL} [data-tool="select"]`).focus();
    await h.delay(300);
    log.modeToggle = await h.ensureFocusMode(nvda, async () => {
      await nvda.press('ArrowDown'); await h.delay(300);
      // Read the DOM directly: the rail moves focus to another tool button
      // only when the key reached the widget (that is, in focus mode).
      return page.evaluate(() => {
        const a = document.activeElement;
        return !!(a && a.dataset && a.dataset.tool && a.dataset.tool !== 'select');
      });
    });
    await page.locator(`${RAIL} [data-tool="select"]`).focus();
    await h.delay(300);
    log.arrows = [];
    for (let i = 0; i < 6; i++) {
      const phrase = await press(nvda, 'ArrowDown', 700);
      const f = await h.describeFocus(page);
      log.arrows.push({ phrase, tool: f && f.tool });
    }
    log.home = await press(nvda, 'Home');
    log.end = await press(nvda, 'End');

    // Arm Paragraph by keyboard.
    await page.locator(`${RAIL} [data-tool="pin:core/paragraph"]`).focus();
    await h.delay(300);
    log.enterOnParagraph = await press(nvda, 'Enter', 900);
    log.pressedAfterEnter = await page.locator(`${RAIL} [data-tool="pin:core/paragraph"]`).getAttribute('aria-pressed');

    // Escape with focus still on the rail: does it disarm? (help text says "at any time")
    log.escapeOnRail = await press(nvda, 'Escape', 700);
    log.pressedAfterEscape = await page.locator(`${RAIL} [data-tool="pin:core/paragraph"]`).getAttribute('aria-pressed');

    // Tab away from the rail while armed: where does focus go, what is said.
    log.tabAway = await press(nvda, 'Tab', 900);
    log.focusAfterTab = await h.describeFocus(page);
    log.canvasFocusAfterTab = await h.describeCanvasFocus(page);

    // Insert with a real click (Playwright) and report what NVDA then announces for the focus.
    await page.locator(`${RAIL} [data-tool="pin:core/paragraph"]`).focus();
    await h.delay(200);
    if (log.pressedAfterEscape !== 'true') { await page.keyboard.press('Enter'); await h.delay(300); }
    const canvas = page.frameLocator('iframe[name="editor-canvas"]');
    await canvas.locator('body').click({ position: { x: 300, y: 500 } });
    await h.delay(1200);
    log.blocksAfterInsert = await page.evaluate(() => wp.data.select('core/block-editor').getBlocks().map((b) => b.name));
    log.focusAfterInsert = await reportFocus(nvda);
    log.pressedAfterInsert = await page.locator(`${RAIL} [data-tool="pin:core/paragraph"]`).getAttribute('aria-pressed');
    log.liveRegionAfterInsert = await page.evaluate(() => Array.from(document.querySelectorAll('#a11y-speak-polite, #a11y-speak-assertive')).map((e) => e.textContent.trim()).filter(Boolean));

    const spoken = await h.saveSpeechLog(nvda, 'toolbar', { focusTitles, ...log });

    expect(log.blocksAfterInsert).toEqual(['core/paragraph']);
    expect(log.arrows.filter((a) => a.phrase).length, 'arrowing should announce each tool').toBeGreaterThan(3);
    expect(log.enterOnParagraph, '(SR-1) arming should be announced as pressed').toMatch(/pressed/i);
    expect(log.pressedAfterEscape, '(SR-2) Escape on the rail should disarm (help: "at any time")').toBe('false');
    expect(h.spoke(spoken, /./)).toBe(true);
  });

  test('settings dialog: open, Tab forward until it closes, Shift+Tab back through every control, pin, save a set', async ({ page, nvda }) => {
    await open(page);
    const focusTitles = await h.focusBrowser(page, nvda);
    const log = {};
    await page.locator(`${RAIL} [data-tool="settings"]`).focus();
    await h.delay(300);
    log.openAttempt = await activateFocused(page, nvda, SETTINGS, 1200); log.openPhrase = log.openAttempt.phrase;
    await page.waitForSelector(SETTINGS, { timeout: 5000 });
    log.focusAtOpen = await h.describeFocus(page);

    // Forward walk from the opening focus: how many Tabs until the dialog closes?
    log.forward = [];
    for (let i = 0; i < 12; i++) {
      const phrase = await press(nvda, 'Tab', 700);
      const el = await h.describeFocus(page);
      const openNow = (await page.locator(SETTINGS).count()) > 0;
      log.forward.push({ phrase, el: el && (el.ariaLabel || el.labelText || el.text || el.tag), inside: openNow && await h.focusInside(page, SETTINGS), dialogOpen: openNow });
      if (!openNow) break;
    }
    log.focusAfterForwardClose = await h.describeFocus(page);
    log.canvasFocusAfterForwardClose = await h.describeCanvasFocus(page);

    // Reopen, then Shift+Tab backwards through the controls above the search field.
    await page.locator(`${RAIL} [data-tool="settings"]`).focus();
    await h.delay(300);
    await press(nvda, 'Enter', 1000);
    await page.waitForSelector(SETTINGS, { timeout: 5000 });
    log.backward = [];
    for (let i = 0; i < 32; i++) {
      const before = (await nvda.spokenPhraseLog()).length;
      await nvda.perform({ keyCode: [WindowsKeyCodes.Tab], modifiers: [WindowsModifiers.Shift] });
      await h.delay(650);
      const phrase = await spokenSince(nvda, before);
      const el = await h.describeFocus(page);
      const openNow = (await page.locator(SETTINGS).count()) > 0;
      log.backward.push({ phrase, el: el && (el.ariaLabel || el.labelText || el.text || el.tag), type: el && el.type, dialogOpen: openNow });
      if (!openNow) break;
    }

    // The backward walk can leave the dialog past Close (it closes when
    // focus leaves); reopen before the pin step.
    if (!(await page.locator(SETTINGS).count())) {
      await page.locator(`${RAIL} [data-tool="settings"]`).focus();
      await h.delay(300);
      log.reopenForPin = await press(nvda, 'Enter', 1000);
      await page.waitForSelector(SETTINGS, { timeout: 5000 });
    }

    // Pin a block through the search: type, Tab to the first result, Enter.
    await page.locator('#toolrail-settings-search').focus();
    await h.delay(300);
    await nvda.type('quote');
    await h.delay(900);
    log.typedSearch = await nvda.lastSpokenPhrase();
    log.tabToResult = await press(nvda, 'Tab', 700);
    log.pinResult = await press(nvda, 'Enter', 1200);
    log.focusAfterPin = await h.describeFocus(page);
    log.railAfterPin = await page.evaluate(() => Array.from(document.querySelectorAll('#toolrail-rail [data-tool^="pin:"]')).map((b) => b.dataset.tool));

    // Unpin it again from its row.
    const unpin = page.locator(`${SETTINGS} button[aria-label^="Unpin"]`).last();
    log.unpinLabel = await unpin.getAttribute('aria-label');
    await unpin.focus();
    await h.delay(300);
    log.unpin = await press(nvda, 'Enter', 1200);
    log.focusAfterUnpin = await h.describeFocus(page);

    // Save a set: type a name, Tab to Save set, Enter.
    await page.locator('#toolrail-settings-setname').focus();
    await h.delay(300);
    await nvda.type('NVDA set');
    await h.delay(600);
    log.tabToSave = await press(nvda, 'Tab', 700);
    log.saveSet = await press(nvda, 'Enter', 1200);
    log.setsAfterSave = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel + ' button[aria-label^="Load the set"]')).map((b) => b.getAttribute('aria-label')), SETTINGS);
    const del = page.locator(`${SETTINGS} button[aria-label="Delete the set NVDA set"]`);
    if (await del.count()) { await del.focus(); await h.delay(300); log.deleteSet = await press(nvda, 'Enter', 1200); log.focusAfterDelete = await h.describeFocus(page); }

    const close = await h.closeModalWithEscape(page, nvda, SETTINGS);
    log.close = close;
    log.focusAfterClose = await h.describeFocus(page);
    const spoken = await h.saveSpeechLog(nvda, 'settings', { focusTitles, ...log });

    expect(log.openPhrase, 'opening should announce a dialog').toMatch(/dialog/i);
    expect(log.railAfterPin.length, 'the pin should land on the rail').toBe(5);
    expect(log.pinResult, '(SR-3) pinning should announce the outcome').toMatch(/pinned|added|toolbar/i);
    expect(log.saveSet, '(SR-4) saving a set should announce the outcome').toMatch(/saved|set/i);
    expect(log.forward.length, '(SR-5) forward Tab from the opening focus should not leave the dialog within a handful of stops').toBeGreaterThan(10);
    expect(close.closed).toBe(true);
    expect(h.spoke(spoken, /./)).toBe(true);
  });

  test('section overview: open, walk, pick, move, close', async ({ page, nvda }) => {
    await open(page);
    const focusTitles = await h.focusBrowser(page, nvda);
    const log = {};
    await page.evaluate(() => wp.data.dispatch('core/block-editor').resetBlocks([
      wp.blocks.createBlock('core/group', {}, [wp.blocks.createBlock('core/heading', { content: 'Inside A' })]),
      wp.blocks.createBlock('core/heading', { content: 'Second' }),
      wp.blocks.createBlock('core/paragraph', { content: 'Third paragraph' }),
      wp.blocks.createBlock('core/image'),
    ]));
    await page.waitForTimeout(800);
    await page.locator(`${RAIL} [data-tool="overview"]`).focus();
    await h.delay(300);
    log.openAttempt = await activateFocused(page, nvda, `${OVERVIEW} .toolrail-ov-box`, 1500); log.openPhrase = log.openAttempt.phrase;
    await page.waitForSelector(`${OVERVIEW} .toolrail-ov-box`, { timeout: 8000 });
    log.focusAtOpen = await h.describeFocus(page);
    // One Tab per remaining section, no further: the section buttons are
    // the last focusable things in the document, so one more Tab leaves
    // the page for the browser chrome (SR-3, run 4) and every later
    // keystroke lands there.
    const boxCount = await page.locator(`${OVERVIEW} .toolrail-ov-box`).count();
    log.tabs = [];
    for (let i = 0; i < boxCount - 1; i++) {
      const phrase = await press(nvda, 'Tab', 700);
      const el = await h.describeFocus(page);
      log.tabs.push({ phrase, el: el && (el.ariaLabel || el.text || el.tag), inOverview: await h.focusInside(page, OVERVIEW) });
    }
    const pick = page.locator(`${OVERVIEW} .toolrail-ov-box [data-ov-action="pick"]`).first();
    await pick.focus();
    await h.delay(300);
    log.pickFocus = await reportFocus(nvda);
    log.pick = await press(nvda, 'Enter', 1200);
    log.controlsAfterPick = await page.evaluate((sel) => { const c = document.querySelector(sel + ' .toolrail-ov-controls:not([hidden])'); return c ? Array.from(c.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') || b.textContent.trim()) : null; }, OVERVIEW);
    log.tabAfterPick = await press(nvda, 'Tab', 700);
    log.focusAfterTabPick = await h.describeFocus(page);
    const down = page.locator(`${OVERVIEW} .toolrail-ov-controls:not([hidden]) button[aria-label*="down" i]`).first();
    if (await down.count()) {
      await down.focus();
      await h.delay(300);
      log.moveDown = await press(nvda, 'Enter', 1500);
      log.orderAfterMove = await page.evaluate(() => wp.data.select('core/block-editor').getBlocks().map((b) => b.name));
      log.focusAfterMove = await h.describeFocus(page);
    }
    log.escape = await press(nvda, 'Escape', 1500);
    log.overviewOpenAfterEscape = await page.locator(OVERVIEW).count();
    log.focusAfterEscape = await h.describeFocus(page);
    log.canvasFocusAfterEscape = await h.describeCanvasFocus(page);
    log.reportAfterEscape = await reportFocus(nvda);
    const spoken = await h.saveSpeechLog(nvda, 'overview', { focusTitles, ...log });

    expect(log.openPhrase, 'opening should announce the overview').toMatch(/overview/i);
    expect(log.pick, 'picking a box should announce something').toBeTruthy();
    expect(log.orderAfterMove).toEqual(['core/heading', 'core/group', 'core/paragraph', 'core/image']);
    expect(log.overviewOpenAfterEscape).toBe(0);
    expect(h.spoke(spoken, /./)).toBe(true);
  });

  test('help panel: open, read, close', async ({ page, nvda }) => {
    await open(page);
    const focusTitles = await h.focusBrowser(page, nvda);
    const log = {};
    await page.locator(`${RAIL} [data-tool="help"]`).focus();
    await h.delay(300);
    log.openAttempt = await activateFocused(page, nvda, HELP, 1500); log.openPhrase = log.openAttempt.phrase;
    await page.waitForSelector(HELP, { timeout: 5000 });
    log.focusAtOpen = await h.describeFocus(page);
    log.tab1 = await press(nvda, 'Tab', 700);
    log.focusAfterTab1 = await h.describeFocus(page);
    // Browse-mode reading: next heading (H) a few times.
    log.headings = [];
    for (let i = 0; i < 4; i++) log.headings.push(await press(nvda, 'h', 600));
    log.close = await h.closeModalWithEscape(page, nvda, HELP);
    log.focusAfterClose = await h.describeFocus(page);
    const spoken = await h.saveSpeechLog(nvda, 'help', { focusTitles, ...log });
    expect(log.openPhrase).toMatch(/help/i);
    expect(log.close.closed).toBe(true);
    expect(h.spoke(spoken, /./)).toBe(true);
  });

  test('extension flyout (Rulers and guides): ArrowRight opens a menu, items announce, Escape returns', async ({ page, nvda }) => {
    await open(page);
    const focusTitles = await h.focusBrowser(page, nvda);
    const log = {};
    const parent = page.locator(`${RAIL} [data-tool="toolrail-guides"]`);
    test.skip(!(await parent.count()), 'editrail-guides is not active');
    await parent.focus();
    await h.delay(300);
    log.modeToggle = await h.ensureFocusMode(nvda, async () => { await nvda.press('ArrowRight'); await h.delay(400); return (await page.locator('#toolrail-region [role="menu"]').count()) > 0; });
    if (!(await page.locator('#toolrail-region [role="menu"]').count())) {
      await parent.focus(); await h.delay(300);
      log.arrowRight = await press(nvda, 'ArrowRight', 900);
    } else {
      log.arrowRight = await nvda.lastSpokenPhrase();
    }
    log.menuOpen = await page.locator('#toolrail-region [role="menu"]').count();
    log.focusInMenu = await h.describeFocus(page);
    log.items = [];
    for (let i = 0; i < 4; i++) { log.items.push(await press(nvda, 'ArrowDown', 700)); }
    log.escape = await press(nvda, 'Escape', 700);
    log.focusAfterEscape = await h.describeFocus(page);
    log.menuAfterEscape = await page.locator('#toolrail-region [role="menu"]').count();
    const spoken = await h.saveSpeechLog(nvda, 'flyout-guides', { focusTitles, ...log });
    expect(log.menuOpen).toBe(1);
    expect(h.spoke(spoken, /menu/i)).toBe(true);
  });
});
