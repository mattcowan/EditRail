/**
 * EditRail — pin metadata spec.
 *
 * Pin metadata: the label, description and icon of a pin, the icon
 * browser, and extension data on a pin.
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const { test, expect } = require('@playwright/test');
const { AUTH, openNewPost, clickBelowContent, getPref } = require('./helpers');

test.use({ storageState: AUTH });

test.describe('pin metadata (1.0.1)', () => {
  const quoteBtn = '#toolrail-rail [data-tool="pin:core/quote"]';
  const paragraphRow = '.toolrail-settings-pinnedrow[data-block="core/paragraph"]';

  test('setPinMeta renames a pinned tool, describes it, gives it a glyph, and persists to the account', async ({ page }) => {
    await openNewPost(page);

    // Only a PINNED slot can carry metadata.
    expect(await page.evaluate(() => window.toolrail.setPinMeta('core/quote', { title: 'Nope' }))).toBe(false);
    expect(await page.evaluate(() => window.toolrail.getPinMeta('core/quote'))).toBeNull();

    await page.evaluate(() => {
      window.toolrail.pinBlock('core/quote');
      window.toolrail.setPinMeta('core/quote', {
        title: '  Pull  quote ',
        description: 'Added by the site. Click, then click the canvas.',
        icon: 'Aa',
      });
    });
    const btn = page.locator(quoteBtn);
    // The name keeps the kind suffix; the description is exposed to AT
    // and rides the tooltip; the glyph is text inside the icon box.
    await expect(btn).toHaveAttribute('aria-label', 'Pull quote (pinned block)');
    await expect(btn).toHaveAttribute('aria-description', 'Added by the site. Click, then click the canvas.');
    await expect(btn).toHaveAttribute('title', 'Pull quote (pinned block) — Added by the site. Click, then click the canvas.');
    await expect(btn.locator('.toolrail-tool-glyph')).toHaveText('Aa');
    expect(await page.evaluate(() => window.toolrail.getPinMeta('core/quote'))).toEqual({
      title: 'Pull quote',
      description: 'Added by the site. Click, then click the canvas.',
      icon: 'Aa',
    });

    // Account store, not this page: a plain reload still reads it.
    expect(await getPref(page, 'toolrail-pin-meta')).toContain('Pull quote');
    await page.reload();
    await expect(page.locator('#toolrail-rail')).toBeVisible({ timeout: 20000 });
    await expect(page.locator(quoteBtn)).toHaveAttribute('aria-label', 'Pull quote (pinned block)');

    // Unpinning takes the entry with it.
    await page.evaluate(() => window.toolrail.unpinBlock('core/quote'));
    expect(await page.evaluate(() => window.toolrail.getPinMeta('core/quote'))).toBeNull();
    expect(await getPref(page, 'toolrail-pin-meta')).not.toContain('core/quote');
  });

  test('a Dashicon slug renders as a Dashicon; an over-long icon is dropped; a title is never markup', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      window.toolrail.pinBlock('core/quote');
      window.toolrail.setPinMeta('core/quote', { icon: 'dashicons-star-filled' });
    });
    const icon = page.locator(`${quoteBtn} .toolrail-tool-icon`);
    await expect(icon).toHaveClass(/dashicons-star-filled/);

    await page.evaluate(() => window.toolrail.setPinMeta('core/quote', { title: '<b>Bold</b>', icon: 'toolong' }));
    expect(await page.evaluate(() => window.toolrail.getPinMeta('core/quote'))).toEqual({
      title: '<b>Bold</b>',
      description: '',
      icon: '',
    });
    // Rendered as text: the label span carries the literal angle brackets
    // and the button gained no child <b>.
    expect(await page.locator(`${quoteBtn} b`).count()).toBe(0);
    await expect(page.locator(`${quoteBtn} .toolrail-tool-label`)).toHaveText('<b>Bold</b>');
    // No custom icon any more: the block's own icon is back.
    expect(await page.locator(`${quoteBtn} .toolrail-tool-glyph`).count()).toBe(0);

    // Clearing every field removes the entry.
    await page.evaluate(() => window.toolrail.setPinMeta('core/quote', { title: '', description: '', icon: '' }));
    expect(await page.evaluate(() => window.toolrail.getPinMeta('core/quote'))).toBeNull();
    await page.evaluate(() => window.toolrail.unpinBlock('core/quote'));
  });

  test('Edit in Toolbar settings: a disclosure form, Enter saves, focus returns to Edit, the row shows Custom', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await expect(page.locator('.toolrail-settings')).toBeVisible();

    const edit = page.locator(`${paragraphRow} .toolrail-settings-edit`);
    await expect(edit).toHaveAttribute('aria-label', 'Edit Paragraph');
    await expect(edit).toHaveAttribute('aria-expanded', 'false');
    await edit.click();

    // Open: focus lands in the first field, the button says so, and the
    // legend names the block so the author knows which tool this is.
    await expect(page.locator('#toolrail-editform')).toBeVisible();
    await expect(page.locator('#toolrail-editform-title')).toBeFocused();
    await expect(edit).toHaveAttribute('aria-expanded', 'true');
    await expect(edit).toHaveAttribute('aria-controls', 'toolrail-editform');
    await expect(page.locator('#toolrail-editform legend')).toHaveText('Edit the Paragraph tool');
    // Every field has a visible, associated label.
    for (const id of ['toolrail-editform-title', 'toolrail-editform-description', 'toolrail-editform-icon']) {
      await expect(page.locator(`label[for="${id}"]`)).toBeVisible();
    }

    await page.keyboard.type('Body text');
    await page.keyboard.press('Enter');

    // Saved: the form is gone, focus is back on THIS row's Edit, the row
    // reads the new name with a Custom tag, the outcome is visible text,
    // and the rail button carries the name.
    await expect(page.locator('#toolrail-editform')).toHaveCount(0);
    await expect(page.locator(`${paragraphRow} .toolrail-settings-edit`)).toBeFocused();
    await expect(page.locator(`${paragraphRow} .toolrail-settings-pinnedname`)).toHaveText('Body text');
    await expect(page.locator(`${paragraphRow} .toolrail-settings-tag`)).toHaveText('Custom');
    await expect(page.locator(`${paragraphRow} .toolrail-settings-edit`)).toHaveAttribute('aria-label', 'Edit Body text');
    await expect(page.locator(`${paragraphRow} .toolrail-settings-remove`)).toHaveAttribute('aria-label', 'Unpin Body text');
    await expect(page.locator('#toolrail-settings-pinned-status')).toHaveText('Saved your changes to Body text.');
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"]')).toHaveAttribute('aria-label', 'Body text (pinned block)');

    // Reset puts the block's own name back and clears the entry.
    await page.locator(`${paragraphRow} .toolrail-settings-edit`).click();
    await page.locator('.toolrail-settings-editreset').click();
    await expect(page.locator(`${paragraphRow} .toolrail-settings-pinnedname`)).toHaveText('Paragraph');
    expect(await page.evaluate(() => window.toolrail.getPinMeta('core/paragraph'))).toBeNull();
    await expect(page.locator(`${paragraphRow} .toolrail-settings-edit`)).toBeFocused();
  });

  test('Escape inside the form closes the form only; a second Escape closes the dialog', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator(`${paragraphRow} .toolrail-settings-edit`).click();
    await expect(page.locator('#toolrail-editform-title')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-editform')).toHaveCount(0);
    await expect(page.locator('.toolrail-settings')).toBeVisible();
    await expect(page.locator(`${paragraphRow} .toolrail-settings-edit`)).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.locator('.toolrail-settings')).toHaveCount(0);
    await expect(page.locator('#toolrail-rail [data-tool="settings"]')).toBeFocused();
  });

  test('an invalid icon is refused in text, marks the field, keeps focus there, and does not save', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator(`${paragraphRow} .toolrail-settings-edit`).click();
    await page.locator('#toolrail-editform-icon').fill('toolong');
    await page.locator('.toolrail-settings-editsave').click();

    await expect(page.locator('#toolrail-editform')).toBeVisible();
    await expect(page.locator('#toolrail-editform-icon')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#toolrail-editform-icon')).toBeFocused();
    await expect(page.locator('#toolrail-editform-status')).toContainText('up to 3 characters');
    expect(await page.evaluate(() => window.toolrail.getPinMeta('core/paragraph'))).toBeNull();

    // Typing clears the error state; a valid value then saves.
    await page.locator('#toolrail-editform-icon').fill('¶');
    await expect(page.locator('#toolrail-editform-icon')).not.toHaveAttribute('aria-invalid', 'true');
    await page.locator('.toolrail-settings-editsave').click();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"] .toolrail-tool-glyph')).toHaveText('¶');
    await page.evaluate(() => window.toolrail.setPinMeta('core/paragraph', null));
  });

  test('a half-edited form survives a rebuild from elsewhere', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator(`${paragraphRow} .toolrail-settings-edit`).click();
    await page.locator('#toolrail-editform-title').fill('Draft name');
    await page.locator('#toolrail-editform-description').fill('Draft description');
    // Put the caret mid-word, so a restore to the END would show.
    await page.evaluate(() => {
      const d = document.getElementById('toolrail-editform-description');
      d.focus();
      d.setSelectionRange(5, 5);
    });

    // Pinning from outside the dialog rebuilds its content.
    await page.evaluate(() => window.toolrail.pinBlock('core/quote'));

    await expect(page.locator('#toolrail-editform')).toBeVisible();
    await expect(page.locator('#toolrail-editform-title')).toHaveValue('Draft name');
    await expect(page.locator('#toolrail-editform-description')).toHaveValue('Draft description');
    // The text AND the author's place in it survive: focus is still in
    // the description with the caret where it was, not in block search.
    await expect(page.locator('#toolrail-editform-description')).toBeFocused();
    expect(await page.evaluate(() => {
      const d = document.getElementById('toolrail-editform-description');
      return [d.selectionStart, d.selectionEnd];
    })).toEqual([5, 5]);
    await page.keyboard.type('X');
    await expect(page.locator('#toolrail-editform-description')).toHaveValue('DraftX description');
    await expect(page.locator('#toolrail-settings-search')).toHaveValue('');

    // A refused icon stays refused across the same kind of rebuild.
    await page.locator('#toolrail-editform-icon').fill('toolong');
    await page.locator('.toolrail-settings-editsave').click();
    await expect(page.locator('#toolrail-editform-icon')).toHaveAttribute('aria-invalid', 'true');
    await page.evaluate(() => window.toolrail.pinBlock('core/list'));
    await expect(page.locator('#toolrail-editform-icon')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#toolrail-editform-status')).toContainText('up to 3 characters');
    await expect(page.locator('#toolrail-editform-icon')).toHaveValue('toolong');

    await page.evaluate(() => {
      window.toolrail.unpinBlock('core/quote');
      window.toolrail.unpinBlock('core/list');
    });
  });

  test('a family emoji counts as one character; four plain letters do not fit', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => window.toolrail.pinBlock('core/quote'));
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
    expect(await page.evaluate((f) => {
      window.toolrail.setPinMeta('core/quote', { icon: f });
      return window.toolrail.getPinMeta('core/quote').icon === f;
    }, family)).toBe(true);
    // Control: the limit still bites on ordinary text.
    expect(await page.evaluate(() => {
      window.toolrail.setPinMeta('core/quote', { icon: 'abcd' });
      return window.toolrail.getPinMeta('core/quote');
    })).toBeNull();
    await page.evaluate(() => window.toolrail.unpinBlock('core/quote'));
  });

  test('set files carry the labels of their blocks; import reports how many it set', async ({ page }) => {
    await openNewPost(page);
    const result = await page.evaluate(() => window.toolrail.importConfig({
      format: 'toolrail-set',
      version: 1,
      name: 'labeled',
      blocks: ['core/quote', 'core/paragraph'],
      meta: {
        'core/quote': { title: 'Testimonial', icon: '“' },
        'core/list': { title: 'Not in the set' },
        'core/paragraph': { title: '', description: '' },
      },
    }));
    expect(result.ok).toBe(true);
    expect(result.labels).toBe(1);

    // Imported, not loaded: nothing on the pins changes yet. Pinning
    // Quote by hand now gives the block's own name, not the file's.
    expect(await getPref(page, 'toolrail-pin-meta')).toBeNull();
    await page.evaluate(() => window.toolrail.pinBlock('core/quote'));
    await expect(page.locator(quoteBtn)).toHaveAttribute('aria-label', 'Quote (pinned block)');
    await page.evaluate(() => window.toolrail.unpinBlock('core/quote'));

    // Loading the set applies its labels to its pins.
    await page.evaluate(() => window.toolrail.loadConfig('labeled'));
    await expect(page.locator(quoteBtn)).toHaveAttribute('aria-label', 'Testimonial (pinned block)');
    await expect(page.locator(`${quoteBtn} .toolrail-tool-glyph`)).toHaveText('“');
    // A label for a block the file did not list is ignored.
    expect(await page.evaluate(() => window.toolrail.getPinMeta('core/list'))).toBeNull();

    // Saving a set snapshots its pins' labels, so a round trip keeps them
    // and deleting the set drops its snapshot.
    await page.evaluate(() => {
      window.toolrail.setPinMeta('core/quote', { title: 'Renamed' });
      window.toolrail.saveConfig('labeled');
    });
    expect(await getPref(page, 'toolrail-set-meta')).toContain('Renamed');
    await page.evaluate(() => {
      window.toolrail.deleteConfig('labeled');
      window.toolrail.unpinBlock('core/quote');
    });
    expect(await getPref(page, 'toolrail-set-meta')).not.toContain('labeled');
  });
});

test.describe('Icon field: Dashicon browser and dark-mode fields (1.0.1)', () => {
  const paragraphRow = '.toolrail-settings-pinnedrow[data-block="core/paragraph"]';

  test('every text field in the dialog shares one background on the Dark preset', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator(`${paragraphRow} .toolrail-settings-edit`).click();
    const colors = await page.evaluate(() => {
      const bg = (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor;
      return {
        search: bg('#toolrail-settings-search'),
        setName: bg('#toolrail-settings-setname'),
        title: bg('#toolrail-editform-title'),
        description: bg('#toolrail-editform-description'),
        icon: bg('#toolrail-editform-icon'),
        dialog: bg('.toolrail-settings'),
      };
    });
    // wp-admin's input[type="text"] rule used to win and paint the inputs
    // white while the textarea took the rail's dark field color.
    expect(colors.title).toBe(colors.description);
    expect(colors.icon).toBe(colors.description);
    expect(colors.search).toBe(colors.description);
    expect(colors.setName).toBe(colors.description);
    expect(colors.title).not.toBe('rgb(255, 255, 255)');
  });

  test('Browse icons: search, pick, and the name lands in the field with a preview', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator(`${paragraphRow} .toolrail-settings-edit`).click();

    const browse = page.locator('.toolrail-settings-iconbrowse');
    await expect(browse).toHaveAttribute('aria-expanded', 'false');
    await browse.click();
    await expect(page.locator('#toolrail-iconbrowser')).toBeVisible();
    await expect(page.locator('#toolrail-iconbrowser-search')).toBeFocused();
    await expect(browse).toHaveAttribute('aria-expanded', 'true');
    await expect(browse).toHaveAttribute('aria-controls', 'toolrail-iconbrowser');
    // Capped, with the cap said in text.
    await expect(page.locator('#toolrail-iconbrowser-count')).toContainText('Showing the first 72 of');

    await page.keyboard.type('star');
    await expect(page.locator('#toolrail-iconbrowser-count')).toHaveText('3 icons.');
    const names = await page.locator('.toolrail-settings-iconresult').allTextContents();
    expect(names).toEqual(['star-empty', 'star-filled', 'star-half']);
    // The chip's accessible name is the name the field will hold.
    await expect(page.locator('.toolrail-settings-iconresult[data-icon="star-filled"]')).toHaveAccessibleName('star-filled');

    // A rebuild from elsewhere keeps the browser open with its query.
    await page.evaluate(() => window.toolrail.pinBlock('core/quote'));
    await expect(page.locator('#toolrail-iconbrowser-search')).toHaveValue('star');
    await expect(page.locator('#toolrail-iconbrowser-count')).toHaveText('3 icons.');

    await page.locator('.toolrail-settings-iconresult[data-icon="star-filled"]').click();
    await expect(page.locator('#toolrail-iconbrowser')).toHaveCount(0);
    await expect(page.locator('#toolrail-editform-icon')).toHaveValue('dashicons-star-filled');
    await expect(page.locator('#toolrail-editform-icon')).toBeFocused();
    await expect(page.locator('.toolrail-settings-iconpreview')).toHaveClass(/dashicons-star-filled/);

    // Reopening marks the current value's chip as pressed.
    await browse.click();
    await page.keyboard.type('star-f');
    await expect(page.locator('.toolrail-settings-iconresult[data-icon="star-filled"]')).toHaveAttribute('aria-pressed', 'true');
    // Escape closes the browser only; the form stays, focus on Browse icons.
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-iconbrowser')).toHaveCount(0);
    await expect(page.locator('#toolrail-editform')).toBeVisible();
    await expect(browse).toBeFocused();

    await page.locator('.toolrail-settings-editsave').click();
    await expect(page.locator('#toolrail-rail [data-tool="pin:core/paragraph"] .toolrail-tool-icon')).toHaveClass(/dashicons-star-filled/);
    await page.evaluate(() => {
      window.toolrail.setPinMeta('core/paragraph', null);
      window.toolrail.unpinBlock('core/quote');
    });
  });

  test('a Dashicon name WordPress does not ship is refused, so no tool ends up with an empty icon', async ({ page }) => {
    await openNewPost(page);
    expect(await page.evaluate(() => {
      window.toolrail.setPinMeta('core/paragraph', { icon: 'dashicons-not-a-real-icon' });
      return window.toolrail.getPinMeta('core/paragraph');
    })).toBeNull();
    // Control: a real one is kept.
    expect(await page.evaluate(() => {
      window.toolrail.setPinMeta('core/paragraph', { icon: 'dashicons-heart' });
      const m = window.toolrail.getPinMeta('core/paragraph');
      window.toolrail.setPinMeta('core/paragraph', null);
      return m && m.icon;
    })).toBe('dashicons-heart');
  });
});

test.describe('extension data on a pin (setPinData / getPinData / pin-meta-changed)', () => {
  const quoteBtn = '#toolrail-rail [data-tool="pin:core/quote"]';
  const quoteRow = '.toolrail-settings-pinnedrow[data-block="core/quote"]';

  test('namespaced JSON on a pinned slot: gates, copies, and independence from the author fields', async ({ page }) => {
    await openNewPost(page);
    const result = await page.evaluate(() => {
      const t = window.toolrail;
      const out = {};
      out.unpinned = t.setPinData('core/quote', 'presets', { a: 1 });
      t.pinBlock('core/quote');
      out.badNamespace = [t.setPinData('core/quote', 'Bad NS', {}), t.setPinData('core/quote', '__proto__', {}), t.setPinData('core/quote', '', {})];
      out.badData = [t.setPinData('core/quote', 'presets', () => 1), t.setPinData('core/quote', 'presets', undefined), t.setPinData('core/quote', 'presets', 'x'.repeat(3000))];
      out.stored = t.setPinData('core/quote', 'presets', { list: [{ name: 'Pull', attrs: { align: 'wide' } }], n: 2 });
      const copy = t.getPinData('core/quote', 'presets');
      copy.list.push('mutated');
      out.roundTrip = t.getPinData('core/quote', 'presets');
      out.other = t.getPinData('core/quote', 'other');
      // The author's view does not see extension data, and setPinMeta
      // leaves it alone in both directions.
      out.metaBefore = t.getPinMeta('core/quote');
      t.setPinMeta('core/quote', { title: 'Testimonial' });
      out.afterTitle = t.getPinData('core/quote', 'presets');
      t.setPinMeta('core/quote', null);
      out.afterReset = t.getPinData('core/quote', 'presets');
      out.removed = t.setPinData('core/quote', 'presets', null);
      out.afterRemove = t.getPinData('core/quote', 'presets');
      return out;
    });
    expect(result.unpinned).toBe(false);
    expect(result.badNamespace).toEqual([false, false, false]);
    expect(result.badData).toEqual([false, false, false]);
    expect(result.stored).toBe(true);
    expect(result.roundTrip).toEqual({ list: [{ name: 'Pull', attrs: { align: 'wide' } }], n: 2 });
    expect(result.other).toBeNull();
    expect(result.metaBefore).toBeNull();
    expect(result.afterTitle).toEqual({ list: [{ name: 'Pull', attrs: { align: 'wide' } }], n: 2 });
    expect(result.afterReset).toEqual({ list: [{ name: 'Pull', attrs: { align: 'wide' } }], n: 2 });
    expect(result.removed).toBe(true);
    expect(result.afterRemove).toBeNull();

    // Extension data alone does not make a pin "Custom" in the dialog.
    await page.evaluate(() => window.toolrail.setPinData('core/quote', 'presets', { n: 1 }));
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    expect(await page.locator(`${quoteRow} .toolrail-settings-tag`).count()).toBe(0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.toolrail.unpinBlock('core/quote'));
  });

  test('pin-meta-changed fires for every entry change, and unpinning drops the data with the pin', async ({ page }) => {
    await openNewPost(page);
    const events = await page.evaluate(() => {
      const t = window.toolrail;
      const seen = [];
      window.addEventListener('toolrail:pin-meta-changed', (e) => seen.push(e.detail.slot));
      t.pinBlock('core/quote');
      t.setPinData('core/quote', 'presets', { n: 1 });
      t.setPinMeta('core/quote', { title: 'Testimonial' });
      t.setPinData('core/quote', 'presets', { n: 1 }); // the same value is still a write
      t.unpinBlock('core/quote');
      const afterUnpin = { meta: t.getPinMeta('core/quote'), data: t.getPinData('core/quote', 'presets') };
      t.pinBlock('core/quote');
      const afterRepin = t.getPinData('core/quote', 'presets');
      t.unpinBlock('core/quote');
      return { seen, afterUnpin, afterRepin };
    });
    expect(events.seen).toEqual(['core/quote', 'core/quote', 'core/quote', 'core/quote']);
    expect(events.afterUnpin).toEqual({ meta: null, data: null });
    expect(events.afterRepin).toBeNull();
  });

  test('extension data rides in saved sets and set files, and comes back on load', async ({ page }) => {
    await openNewPost(page);
    const result = await page.evaluate(() => {
      const t = window.toolrail;
      t.pinBlock('core/quote');
      t.setPinData('core/quote', 'presets', { n: 3 });
      t.saveConfig('with data');
      t.unpinBlock('core/quote');
      const gone = t.getPinData('core/quote', 'presets');
      t.loadConfig('with data');
      const back = t.getPinData('core/quote', 'presets');
      t.deleteConfig('with data');
      t.unpinBlock('core/quote');
      // A set FILE carries it too, through the same normalizer.
      const imported = t.importConfig({
        format: 'toolrail-set', version: 1, name: 'from file', blocks: ['core/quote'],
        meta: { 'core/quote': { title: 'Q', ext: { presets: { n: 4 }, 'Bad NS': { n: 5 }, big: 'x'.repeat(3000) } } },
      });
      t.loadConfig('from file');
      const fromFile = { data: t.getPinData('core/quote', 'presets'), bad: t.getPinData('core/quote', 'big'), meta: t.getPinMeta('core/quote') };
      t.deleteConfig('from file');
      t.unpinBlock('core/quote');
      return { gone, back, imported: imported.labels, fromFile };
    });
    expect(result.gone).toBeNull();
    expect(result.back).toEqual({ n: 3 });
    expect(result.imported).toBe(1);
    expect(result.fromFile.data).toEqual({ n: 4 });
    expect(result.fromFile.bad).toBeNull();
    expect(result.fromFile.meta.title).toBe('Q');
  });

  test('a provider tool nested under a pin reads that pin’s data when it inserts', async ({ page }) => {
    await openNewPost(page);
    await page.evaluate(() => {
      const t = window.toolrail;
      t.pinBlock('core/quote');
      t.setPinData('core/quote', 'presets', { citation: 'Preset citation' });
      t.registerTool({
        id: 'e2e-quote-preset',
        label: 'Quote with preset',
        parent: 'pin:core/quote',
        createBlock: () => window.wp.blocks.createBlock('core/quote', {
          citation: (t.getPinData('core/quote', 'presets') || {}).citation || '',
        }),
      });
    });
    // The child renders in the pin's flyout; arm it and click the canvas.
    await page.locator(quoteBtn).focus();
    await page.keyboard.press('ArrowRight');
    await page.locator('.toolrail-flyout [data-tool="e2e-quote-preset"]').click();
    await clickBelowContent(page);
    const citation = await page.evaluate(() => {
      const blocks = window.wp.data.select('core/block-editor').getBlocks();
      const q = blocks.filter((b) => b.name === 'core/quote').pop();
      return q ? q.attributes.citation : null;
    });
    expect(citation).toBe('Preset citation');
    await page.evaluate(() => window.toolrail.unpinBlock('core/quote'));
  });
});

test.describe('review 2026-09-05 follow-ups (pin data, icon browser)', () => {
  const paragraphRow = '.toolrail-settings-pinnedrow[data-block="core/paragraph"]';

  test('a refused icon changes the field border, not only the text (finding 1)', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator(`${paragraphRow} .toolrail-settings-edit`).click();
    const before = await page.locator('#toolrail-editform-icon').evaluate((el) => getComputedStyle(el).borderTopColor);
    await page.locator('#toolrail-editform-icon').fill('toolong');
    await page.locator('.toolrail-settings-editsave').click();
    await expect(page.locator('#toolrail-editform-icon')).toHaveAttribute('aria-invalid', 'true');
    const after = await page.locator('#toolrail-editform-icon').evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(after).not.toBe(before);
    // Same on the Description textarea, which shares the rule.
    const textareaNormal = await page.locator('#toolrail-editform-description').evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(textareaNormal).toBe(before);
  });

  test('loading a set that omits a pin clears that pin’s entry and says so; a later re-pin starts clean (finding 2)', async ({ page }) => {
    await openNewPost(page);
    const result = await page.evaluate(() => {
      const t = window.toolrail;
      const seen = [];
      window.addEventListener('toolrail:pin-meta-changed', (e) => seen.push(e.detail.slot));
      t.saveConfig('defaults only');
      t.pinBlock('core/quote');
      t.setPinMeta('core/quote', { title: 'Testimonial' });
      t.setPinData('core/quote', 'presets', { n: 1 });
      seen.length = 0;
      t.loadConfig('defaults only'); // no core/quote in it
      const afterLoad = { pinned: t.isPinned('core/quote'), stored: window.wp.data.select('core/preferences').get('toolrail', 'toolrail-pin-meta') || '' };
      t.pinBlock('core/quote');
      const afterRepin = { meta: t.getPinMeta('core/quote'), data: t.getPinData('core/quote', 'presets') };
      t.unpinBlock('core/quote');
      t.deleteConfig('defaults only');
      return { seen, afterLoad, afterRepin };
    });
    expect(result.afterLoad.pinned).toBe(false);
    expect(result.afterLoad.stored).not.toContain('core/quote');
    expect(result.seen).toContain('core/quote');
    expect(result.afterRepin).toEqual({ meta: null, data: null });
  });

  test('loading a set merges extension data per namespace instead of replacing it (finding 6)', async ({ page }) => {
    await openNewPost(page);
    const result = await page.evaluate(() => {
      const t = window.toolrail;
      t.pinBlock('core/quote');
      t.setPinData('core/quote', 'presets', { n: 1 });
      t.saveConfig('with presets'); // snapshot: presets only
      // An extension installed since then writes its own namespace, and
      // the presets change locally.
      t.setPinData('core/quote', 'guides', { snap: true });
      t.setPinData('core/quote', 'presets', { n: 2 });
      t.loadConfig('with presets');
      const after = { presets: t.getPinData('core/quote', 'presets'), guides: t.getPinData('core/quote', 'guides') };
      t.deleteConfig('with presets');
      t.unpinBlock('core/quote');
      return after;
    });
    // The snapshot's namespace wins; the namespace it never saw is kept.
    expect(result).toEqual({ presets: { n: 1 }, guides: { snap: true } });
  });

  test('the icon search accepts the field’s own value, prefix and all (finding 3)', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator(`${paragraphRow} .toolrail-settings-edit`).click();
    await page.locator('.toolrail-settings-iconbrowse').click();
    await page.locator('#toolrail-iconbrowser-search').fill('dashicons-star-filled');
    await expect(page.locator('#toolrail-iconbrowser-count')).toHaveText('1 icon.');
    await expect(page.locator('.toolrail-settings-iconresult')).toHaveText('star-filled');
  });

  test('Escape with the browser open closes the browser first, even from the Browse button (finding 8)', async ({ page }) => {
    await openNewPost(page);
    await page.locator('#toolrail-rail [data-tool="settings"]').click();
    await page.locator(`${paragraphRow} .toolrail-settings-edit`).click();
    const browse = page.locator('.toolrail-settings-iconbrowse');
    await browse.click();
    await expect(page.locator('#toolrail-iconbrowser')).toBeVisible();
    // Move focus back onto the opener, outside the panel, then Escape.
    await browse.focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolrail-iconbrowser')).toHaveCount(0);
    await expect(page.locator('#toolrail-editform')).toBeVisible();
    await expect(browse).toBeFocused();
  });

  test('the import count reports author-visible labels only; getPinData is gated like setPinData (findings 5, 2)', async ({ page }) => {
    await openNewPost(page);
    const result = await page.evaluate(() => {
      const t = window.toolrail;
      const imported = t.importConfig({
        format: 'toolrail-set', version: 1, name: 'ext only', blocks: ['core/quote', 'core/list'],
        meta: { 'core/quote': { ext: { presets: { n: 1 } } }, 'core/list': { title: 'Steps' } },
      });
      const unpinnedRead = t.getPinData('core/quote', 'presets');
      t.loadConfig('ext only');
      const loaded = { quote: t.getPinData('core/quote', 'presets'), list: t.getPinMeta('core/list') };
      t.deleteConfig('ext only');
      t.unpinBlock('core/quote');
      t.unpinBlock('core/list');
      return { labels: imported.labels, unpinnedRead, loaded };
    });
    expect(result.labels).toBe(1);
    expect(result.unpinnedRead).toBeNull();
    expect(result.loaded.quote).toEqual({ n: 1 });
    expect(result.loaded.list.title).toBe('Steps');
  });
});
