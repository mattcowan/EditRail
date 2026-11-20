/**
 * EditRail — shared sets spec (#98).
 *
 * An author shares a saved set with the other users of the site; other
 * users see it in Toolbar settings and in the Saved sets menu, marked as
 * shared, and load or export it; the author or an Editor stops sharing it.
 * The server side (includes/shared-sets.php) decides who may do what, so
 * the spec runs as real users of each role: it creates them through REST
 * as the admin, with generated passwords, logs each one in with its own
 * browser context, and deletes by exact ID what it created (sets,
 * patterns, users) in afterAll, which runs when a test fails too. A run on
 * a developer's own site leaves nothing behind; CI's fresh site does not
 * need the cleanup but gets it.
 *
 * Runs on post-new.php and NEVER saves a post; helpers.js has the rule.
 */
const crypto = require('crypto');
const fs = require('fs');
const { test, expect, AUTH, openNewPost, liveText, waitForPatternCatalog } = require('./helpers');
const { openApi, turnOffWelcomeGuide } = require('./prefs-account');
const { assertSafeBaseUrl } = require('../../scripts/lib/safe-base-url');

const SETS = '/editrail/v1/sets';
const restUrl = (route, query) => '/?rest_route=' + encodeURIComponent(route) + (query ? '&' + query : '');

/** One REST call with a session's nonce. Never throws on an HTTP error. */
async function rest(api, method, route, data, query) {
  const res = await api.ctx.fetch(restUrl(route, query), {
    method,
    headers: api.nonce ? { 'X-WP-Nonce': api.nonce } : {},
    data,
    failOnStatusCode: false,
  });
  let body;
  try {
    body = await res.json();
  } catch (e) {
    body = null;
  }
  return { status: res.status(), body };
}

/** A set file as the rail writes it (exportConfig / a share). */
function setJson(name, blocks, meta) {
  const payload = { format: 'toolrail-set', version: 1, name, blocks };
  if (meta) {
    payload.meta = meta;
  }
  return JSON.stringify(payload);
}

/**
 * The wait for a dialog change that follows a share or stop-sharing
 * request. The request is a real write on the server; on a slow site a
 * Firefox run waited more than the default 5 s for it (2026-11-14).
 */
const REQUEST_WAIT = { timeout: 15000 };

/** An attribute selector value, quoted for CSS: JSON's escapes are CSS's. */
const attr = (value) => JSON.stringify(value);

/**
 * Whether a browser request goes to the shared-set routes, under either
 * permalink form: /wp-json/editrail/v1/sets or ?rest_route=/editrail/v1/sets
 * (apiFetch does not encode the route; a hand-built URL may).
 */
const isSetsRequest = (url) => String(url).includes(SETS) || String(url).includes(encodeURIComponent(SETS));

test.describe('shared sets (#98)', () => {
  const tag = crypto.randomBytes(3).toString('hex');
  // The created users and their logins: { role: { id, username, state, api } }.
  const users = {};
  const createdPatterns = [];
  let admin = null;

  /**
   * Log a user in without a page and keep the cookies, so each role gets
   * its own browser context from them.
   */
  async function logIn(requestApi, baseURL, username, password) {
    const ctx = await requestApi.newContext({ baseURL });
    try {
      await ctx.get('/wp-login.php');
      const res = await ctx.post('/wp-login.php', {
        form: { log: username, pwd: password, 'wp-submit': 'Log In', testcookie: '1', redirect_to: baseURL + '/wp-admin/' },
        maxRedirects: 0,
      });
      expect(res.status(), `login of ${username}`).toBe(302);
      return await ctx.storageState();
    } finally {
      await ctx.dispose();
    }
  }

  test.beforeAll(async ({ playwright }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    assertSafeBaseUrl(baseURL, 'TOOLRAIL_URL');
    admin = await openApi(baseURL, AUTH);
    const roles = { author: 'author', author2: 'author', contributor: 'contributor', editor: 'editor', subscriber: 'subscriber' };
    for (const [key, role] of Object.entries(roles)) {
      const username = `editrail-e2e-${key}-${tag}`;
      const password = crypto.randomBytes(18).toString('base64url');
      // The Author's display name carries markup, quotes and an ampersand:
      // it reaches other users' screens, and must stay text there, with
      // the ampersand as the author typed it (core stores it as an HTML
      // entity; "&amp;" showed in every label before the 2026-11-14 review).
      const name = key === 'author' ? `Ada "A" & <b>Author</b> ${tag}` : `${key} ${tag}`;
      const res = await rest(admin, 'POST', '/wp/v2/users', {
        username, password, name, roles: [role], email: `${username}@example.invalid`,
      });
      expect(res.status, `create the ${key} user`).toBe(201);
      // What a person reads. Core removes the tags when it saves the name;
      // the REST field still holds the stored entity form, so the Author's
      // name is written out here, not read back.
      const displayName = key === 'author' ? `Ada "A" & Author ${tag}` : res.body.name;
      users[key] = { id: res.body.id, username, displayName };
      users[key].state = await logIn(playwright.request, baseURL, username, password);
      users[key].api = await openApi(baseURL, users[key].state);
      if (role !== 'subscriber') {
        await turnOffWelcomeGuide(baseURL, users[key].state);
      }
    }
  });

  test.afterAll(async () => {
    const left = [];
    try {
      // Every set each created user still shares, by exact ID.
      for (const user of Object.values(users)) {
        if (!user.api) {
          continue;
        }
        const list = await rest(user.api, 'GET', SETS);
        for (const set of (list.body && list.body.sets) || []) {
          if (set.mine) {
            await rest(user.api, 'DELETE', SETS + '/' + set.id);
          }
        }
      }
      for (const id of createdPatterns) {
        await rest(admin, 'DELETE', '/wp/v2/blocks/' + id, undefined, 'force=true');
      }
    } finally {
      for (const user of Object.values(users)) {
        if (user.api) {
          await user.api.ctx.dispose();
        }
        // reassign=false: anything of theirs that is still there goes with
        // them (shared sets are delete_with_user).
        const res = await rest(admin, 'DELETE', '/wp/v2/users/' + user.id, undefined, 'force=true&reassign=false');
        if (res.status !== 200) {
          left.push(`user ${user.id}: HTTP ${res.status}`);
        }
      }
      for (const id of createdPatterns) {
        const res = await rest(admin, 'GET', '/wp/v2/blocks/' + id, undefined, 'context=edit');
        if (res.status === 200) {
          left.push(`pattern ${id}`);
        }
      }
      if (admin) {
        await admin.ctx.dispose();
      }
    }
    // Confirm: none of the users is left, so none of their sets is.
    expect(left, 'everything the spec created is deleted').toEqual([]);
  });

  /** A page in the editor as one of the created users. */
  async function editorAs(browser, key) {
    const context = await browser.newContext({ storageState: users[key].state });
    const page = await context.newPage();
    await openNewPost(page);
    return { context, page };
  }

  /** Share a set through REST as a created user; returns its ID. */
  async function shareAs(key, json) {
    const res = await rest(users[key].api, 'POST', SETS, { set: json });
    expect([200, 201]).toContain(res.status);
    return res.body.id;
  }

  /** Stop sharing every set a user shares (each test cleans up its own). */
  async function unshareAll(key) {
    const list = await rest(users[key].api, 'GET', SETS);
    for (const set of (list.body && list.body.sets) || []) {
      if (set.mine) {
        await rest(users[key].api, 'DELETE', SETS + '/' + set.id);
      }
    }
  }

  /** Save the rail's pins as a set through Toolbar settings, dialog left open. */
  async function saveSetInDialog(page, name) {
    if (!(await page.locator('.toolrail-settings').count())) {
      await page.locator('#toolrail-rail [data-tool="settings"]').click();
    }
    await page.locator('#toolrail-settings-setname').fill(name);
    await page.locator('.toolrail-settings-saveset').click();
    await expect(page.locator(`.toolrail-settings-setrow[data-config=${attr(name)}]`)).toBeVisible();
  }

  test('the server answers each role as core\'s post capabilities say', async ({ playwright }, testInfo) => {
    const anon = { ctx: await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }), nonce: '' };
    const id = await shareAs('author', setJson(`roles ${tag}`, ['core/paragraph']));
    try {
      // Logged out: nothing, not even whether an ID exists.
      expect((await rest(anon, 'GET', SETS)).status).toBe(401);
      expect((await rest(anon, 'GET', SETS + '/' + id)).status).toBe(401);
      expect((await rest(anon, 'GET', SETS + '/999999999')).status).toBe(401);
      // No default posts route exposes the type.
      expect((await rest(anon, 'GET', '/wp/v2/posts/' + id)).status).toBe(404);
      expect((await rest(anon, 'GET', '/wp/v2/editrail_set')).status).toBe(404);
      // A Subscriber cannot read; a Contributor reads but cannot share or delete.
      expect((await rest(users.subscriber.api, 'GET', SETS)).status).toBe(403);
      const list = await rest(users.contributor.api, 'GET', SETS);
      expect(list.status).toBe(200);
      expect(list.body.can_share).toBe(false);
      expect(list.body.sets.map((s) => s.id)).toContain(id);
      expect((await rest(users.contributor.api, 'POST', SETS, { set: setJson('c', []) })).status).toBe(403);
      expect((await rest(users.contributor.api, 'DELETE', SETS + '/' + id)).status).toBe(403);
      // Another Author cannot delete it; nobody can change it by ID.
      expect((await rest(users.author2.api, 'DELETE', SETS + '/' + id)).status).toBe(403);
      expect((await rest(users.editor.api, 'POST', SETS + '/' + id, { set: setJson('x', []) })).status).toBe(404);
      // A share of the same name by the Author replaces the copy in place.
      expect(await shareAs('author', setJson(`roles ${tag}`, ['core/quote']))).toBe(id);
      // An Editor deletes anyone's.
      expect((await rest(users.editor.api, 'DELETE', SETS + '/' + id)).status).toBe(200);
      expect((await rest(users.contributor.api, 'GET', SETS + '/' + id)).status).toBe(404);
    } finally {
      await anon.ctx.dispose();
      await unshareAll('author');
    }
  });

  test('with no shared set, a user who cannot share sees the dialog as before', async ({ browser }) => {
    // A developer's own site can have real shared sets; this test needs a
    // site with none.
    const existing = await rest(admin, 'GET', SETS);
    test.skip(existing.body.sets.length > 0, 'The site already has shared sets.');
    const { context, page } = await editorAs(browser, 'contributor');
    try {
      await saveSetInDialog(page, 'own kit');
      await page.keyboard.press('Escape');
      // The dialog asks for the list each time it opens: wait for that
      // answer, so the checks below see the dialog after it, not before.
      const listed = page.waitForResponse((r) => isSetsRequest(r.url()), { timeout: 15000 });
      await page.locator('#toolrail-rail [data-tool="settings"]').click();
      expect((await listed).status()).toBe(200);
      await expect(page.locator('.toolrail-settings-setrow')).toHaveCount(1);
      await expect(page.locator('.toolrail-settings-share, .toolrail-settings-unshare, .toolrail-settings-sharedrow')).toHaveCount(0);
      await expect(page.locator('#toolrail-settings-shared-head')).toHaveCount(0);
      await expect(page.locator('.toolrail-settings-wraprow')).toHaveCount(0);
      await expect(page.locator('label:has(#toolrail-settings-setsbutton)')).toHaveText('Show a Saved sets button on the toolbar when you have a saved set');
    } finally {
      await context.close();
    }
  });

  test('an author shares a set; a contributor loads it as text, with the same message, and exports the same file', async ({ browser }) => {
    test.slow(); // two browser contexts and two editor loads
    // Markup, quotes, a backslash, emoji and non-Latin text in the name.
    const name = `<img src=x onerror=window.__xss98=1> "Kit" \\ 😀 日本語 ${tag}`;
    const author = await editorAs(browser, 'author');
    const contributor = { context: null, page: null };
    try {
      const page = author.page;
      await page.evaluate(() => {
        window.toolrail.pinBlock('core/quote');
        window.toolrail.setPinMeta('core/quote', { title: 'Pull "quote" <b>', icon: '❝' });
        window.toolrail.setPinData('core/quote', 'e2e', { empty: {}, list: [], n: 1.5 });
      });
      await saveSetInDialog(page, name);
      const row = page.locator(`.toolrail-settings-setrow[data-config=${attr(name)}]`);
      const share = row.locator('.toolrail-settings-share');
      await expect(share).toHaveText('Share');
      await expect(share).toHaveAttribute('aria-label', `Share the set ${name} with other users on this site`);
      await share.click();
      await expect(page.locator('#toolrail-settings-status')).toHaveText(`Shared the set "${name}". Other users on this site can now load it.`, REQUEST_WAIT);
      // wp.a11y.speak() replaces anything shaped like a tag with a space
      // before it speaks (wp-includes/js/dist/a11y.js); the visible status
      // line above keeps the whole name.
      const spoken = name.replace(/<[^<>]+>/g, ' ');
      await expect.poll(() => liveText(page)).toContain(`Shared the set "${spoken}".`);
      await expect(row.locator('.toolrail-settings-tag')).toHaveText('Shared');
      // Focus stays in the row, on the control that replaced Share.
      await expect(row.locator('.toolrail-settings-unshare')).toBeFocused();
      await expect(row.locator('.toolrail-settings-share')).toHaveCount(0);

      const ownDownload = page.waitForEvent('download');
      await row.locator('.toolrail-settings-export').click();
      const ownFile = await (await ownDownload).path();
      const ownBytes = fs.readFileSync(ownFile);

      // The contributor: no set of their own, so the Saved sets button
      // comes from the shared set alone.
      Object.assign(contributor, await editorAs(browser, 'contributor'));
      const cpage = contributor.page;
      const setsBtn = cpage.locator('#toolrail-rail [data-tool="saved-sets"]');
      await expect(setsBtn).toBeVisible({ timeout: 15000 });
      await setsBtn.click();
      const menu = cpage.locator('.toolrail-flyout[aria-label="Saved sets"]');
      const item = menu.locator('[role="menuitemradio"]', { hasText: tag });
      await expect(item).toHaveText(`${name} (shared by ${users.author.displayName})`);
      await item.click();
      await expect(menu).toHaveCount(0);
      await expect(cpage.locator('#toolrail-rail [data-tool="pin:core/quote"]')).toBeVisible();
      // The same message as a load of one's own set.
      await expect.poll(() => liveText(cpage)).toBe(`Loaded "${spoken}".`);
      await expect(setsBtn).toBeFocused();
      // The labels came with the copy, as with a set file.
      expect(await cpage.evaluate(() => window.toolrail.getPinMeta('core/quote'))).toEqual({ title: 'Pull "quote" <b>', description: '', icon: '❝' });
      expect(await cpage.evaluate(() => window.toolrail.getPinData('core/quote', 'e2e'))).toEqual({ empty: {}, list: [], n: 1.5 });

      // Toolbar settings: the row is marked, names say who shared it.
      await cpage.locator('#toolrail-rail [data-tool="settings"]').click();
      const sharedRow = cpage.locator('.toolrail-settings-sharedrow', { hasText: tag });
      await expect(sharedRow.locator('.toolrail-settings-pinnedname')).toHaveText(name);
      await expect(sharedRow.locator('.toolrail-settings-sharedby')).toHaveText(`Shared by ${users.author.displayName}`);
      await expect(sharedRow.locator('.toolrail-settings-sharedload')).toHaveAttribute('aria-label', `Load the set ${name}, shared by ${users.author.displayName}`);
      await expect(sharedRow.locator('.toolrail-settings-unshare')).toHaveCount(0);
      await expect(cpage.locator('.toolrail-settings-share')).toHaveCount(0);
      // The name and the display name are text: no element was made from them.
      expect(await cpage.evaluate(() => ({
        img: document.querySelectorAll('img[src="x"]').length,
        bold: Array.from(document.querySelectorAll('#toolrail-region b')).length,
        xss: window.__xss98 === undefined ? 'none' : 'RAN',
      }))).toEqual({ img: 0, bold: 0, xss: 'none' });

      // The shared copy exports to the same bytes as the author's own set.
      const sharedDownload = cpage.waitForEvent('download');
      await sharedRow.locator('.toolrail-settings-sharedexport').click();
      const shared = await sharedDownload;
      const sharedBytes = fs.readFileSync(await shared.path());
      expect(sharedBytes.equals(ownBytes), 'the two set files are byte-identical').toBe(true);
      const payload = JSON.parse(sharedBytes.toString('utf8'));
      expect(payload.name).toBe(name);
      expect(payload.meta['core/quote'].ext.e2e).toEqual({ empty: {}, list: [], n: 1.5 });
      expect(Object.keys(payload)).toEqual(['format', 'version', 'name', 'blocks', 'meta']);
    } finally {
      await author.context.close();
      if (contributor.context) {
        await contributor.context.close();
      }
      await unshareAll('author');
    }
  });

  test('share again replaces the copy only when the author asks', async ({ browser }) => {
    test.slow(); // three writes on the server, each followed by a check through REST
    const name = `again ${tag}`;
    const { context, page } = await editorAs(browser, 'author');
    try {
      await saveSetInDialog(page, name);
      const row = page.locator(`.toolrail-settings-setrow[data-config=${attr(name)}]`);
      await row.locator('.toolrail-settings-share').click();
      await expect(row.locator('.toolrail-settings-unshare')).toBeFocused(REQUEST_WAIT);
      const before = (await rest(users.contributor.api, 'GET', SETS)).body.sets.find((s) => JSON.parse(s.set).name === name);

      // The author's own menu item says the set is shared.
      await page.keyboard.press('Escape');
      await page.locator('#toolrail-rail [data-tool="saved-sets"]').click();
      await expect(page.locator('.toolrail-flyout[aria-label="Saved sets"] [role="menuitemradio"]', { hasText: name })).toHaveText(`${name} (shared)`);

      // A change to the author's own set does not reach the copy...
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.toolrail.pinBlock('core/quote'));
      await saveSetInDialog(page, name);
      const again = row.locator('.toolrail-settings-share');
      await expect(again).toHaveText('Share again');
      const unchanged = (await rest(users.contributor.api, 'GET', SETS)).body.sets.find((s) => s.id === before.id);
      expect(unchanged.set).toBe(before.set);

      // ...until the author shares it again: same ID, new content.
      await again.click();
      await expect(page.locator('#toolrail-settings-status')).toHaveText(`Shared the set "${name}" again. Other users on this site now get this version.`, REQUEST_WAIT);
      await expect(row.locator('.toolrail-settings-share')).toHaveCount(0);
      await expect(row.locator('.toolrail-settings-unshare')).toBeFocused();
      const after = (await rest(users.contributor.api, 'GET', SETS)).body.sets.find((s) => s.id === before.id);
      expect(JSON.parse(after.set).blocks).toContain('core/quote');

      // Stop sharing from the author's own row: the set stays theirs.
      await row.locator('.toolrail-settings-unshare').click();
      await expect(page.locator('#toolrail-settings-status')).toHaveText(`Stopped sharing the set "${name}".`, REQUEST_WAIT);
      await expect(row.locator('.toolrail-settings-share')).toBeFocused();
      await expect(row.locator('.toolrail-settings-tag')).toHaveCount(0);
      expect((await rest(users.contributor.api, 'GET', SETS + '/' + before.id)).status).toBe(404);
    } finally {
      await context.close();
      await unshareAll('author');
    }
  });

  test('an editor stops sharing other users\' sets, and focus moves to the next row', async ({ browser }) => {
    await shareAs('author', setJson(`first ${tag}`, ['core/paragraph']));
    await shareAs('author2', setJson(`second ${tag}`, ['core/heading']));
    const { context, page } = await editorAs(browser, 'editor');
    try {
      await page.locator('#toolrail-rail [data-tool="settings"]').click();
      const rows = page.locator('.toolrail-settings-sharedrow', { hasText: tag });
      await expect(rows).toHaveCount(2);
      const first = rows.filter({ hasText: `first ${tag}` });
      const second = rows.filter({ hasText: `second ${tag}` });
      await expect(first.locator('.toolrail-settings-unshare')).toHaveAttribute('aria-label', `Stop sharing the set first ${tag}, shared by ${users.author.displayName}`);

      // By keyboard: focus the button, press Enter.
      await first.locator('.toolrail-settings-unshare').focus();
      await page.keyboard.press('Enter');
      await expect(first).toHaveCount(0, REQUEST_WAIT);
      await expect(page.locator('#toolrail-settings-status')).toHaveText(`Stopped sharing the set "first ${tag}".`, REQUEST_WAIT);
      await expect.poll(() => liveText(page)).toContain(`Stopped sharing the set "first ${tag}".`);
      // The removed row's neighbor takes focus, not the page body. Other
      // shared sets on a developer's site may sit between, so the check is
      // "a Load button in the shared list".
      await expect(page.locator('.toolrail-settings-sharedrow .toolrail-settings-sharedload:focus')).toHaveCount(1);

      await second.locator('.toolrail-settings-unshare').click();
      await expect(second).toHaveCount(0);
      expect((await rest(users.author2.api, 'GET', SETS)).body.sets.filter((s) => s.mine)).toEqual([]);
    } finally {
      await context.close();
      await unshareAll('author');
      await unshareAll('author2');
    }
  });

  test('a shared set and an own set with the same name stay two items', async ({ browser }) => {
    const name = `Product page ${tag}`;
    const { context, page } = await editorAs(browser, 'contributor');
    try {
      await saveSetInDialog(page, name);
      await shareAs('author', setJson(name, ['core/quote']));
      // The list comes again when the dialog opens.
      await page.keyboard.press('Escape');
      await page.locator('#toolrail-rail [data-tool="settings"]').click();
      const own = page.locator(`.toolrail-settings-setrow[data-config=${attr(name)}]`);
      const shared = page.locator('.toolrail-settings-sharedrow', { hasText: name });
      await expect(shared).toHaveCount(1);
      await expect(own.locator('.toolrail-settings-load')).toHaveAttribute('aria-label', `Load the set ${name}`);
      await expect(shared.locator('.toolrail-settings-sharedload')).toHaveAttribute('aria-label', `Load the set ${name}, shared by ${users.author.displayName}`);

      await page.keyboard.press('Escape');
      await page.locator('#toolrail-rail [data-tool="saved-sets"]').click();
      const items = page.locator('.toolrail-flyout[aria-label="Saved sets"] [role="menuitemradio"]', { hasText: name });
      await expect(items).toHaveText([name, `${name} (shared by ${users.author.displayName})`]);
      // The rail holds the own set's pins: only that item is checked.
      await expect(items.nth(0)).toHaveAttribute('aria-checked', 'true');
      await expect(items.nth(1)).toHaveAttribute('aria-checked', 'false');
      await items.nth(1).click();
      await expect(page.locator('#toolrail-rail [data-tool="pin:core/quote"]')).toBeVisible();
      await page.locator('#toolrail-rail [data-tool="saved-sets"]').click();
      await expect(items.nth(0)).toHaveAttribute('aria-checked', 'false');
      await expect(items.nth(1)).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
    } finally {
      await context.close();
      await unshareAll('author');
    }
  });

  /**
   * More than one toolbar (#95). A set is a snapshot loaded INTO a
   * toolbar, and a shared set is no different: Load in Toolbar settings
   * fills the toolbar chosen there, and the Saved sets menu fills the main
   * toolbar, which has the menu. These tests live here, not in
   * toolbars.spec.js, because a shared set needs a second user to share it.
   * They run as author2, whose account no other test changes.
   */
  async function seedExtraToolbar(page, slots) {
    await page.evaluate((list) => {
      window.wp.data.dispatch('core/preferences').set('toolrail', 'toolrail-toolbars', JSON.stringify({
        version: 1,
        toolbars: [{ id: 't1', name: 'Animation', dock: 'left', x: 40, y: 40, slots: list, wide: false, hidden: false }],
      }));
    }, slots);
    await expect(page.locator('#toolrail-rail-t1')).toBeVisible();
  }

  /** The pins a rail shows, in order. */
  const railPins = (page, railId) => page.evaluate((id) => Array.from(document.querySelectorAll('#' + id + ' [data-tool^="pin:"]')).map((x) => x.dataset.tool), railId);

  test('with an extra toolbar chosen, a shared set\'s Load fills that toolbar and leaves the main toolbar alone (#95)', async ({ browser }) => {
    const name = `into extra ${tag}`;
    await shareAs('author', setJson(name, ['core/quote', 'core/list'], { 'core/quote': { title: 'Shared quote' } }));
    const { context, page } = await editorAs(browser, 'author2');
    try {
      await seedExtraToolbar(page, ['core/verse']);
      // A pin that the set does not have, on both toolbars, with a label: a
      // load that also wrote the main toolbar would take it away, and the
      // label must stay while the main toolbar still has the pin.
      // The id is needed: without one, pinBlock refuses a slot that a
      // shown toolbar already has.
      expect(await page.evaluate(() => window.toolrail.pinBlock('core/verse', 'main'))).toBe(true);
      await page.evaluate(() => window.toolrail.setPinMeta('core/verse', { title: 'My verse' }));
      const mainBefore = await railPins(page, 'toolrail-rail');
      expect(mainBefore).toContain('pin:core/verse');

      await page.locator('#toolrail-rail [data-tool="settings"]').click();
      await page.locator('#toolrail-settings-toolbar').selectOption('t1');
      const load = page.locator('.toolrail-settings-sharedrow', { hasText: name }).locator('.toolrail-settings-sharedload');
      // The name says which toolbar Load fills, as an own set's Load does.
      await expect(load).toHaveAttribute('aria-label', `Load the set ${name}, shared by ${users.author.displayName}, into Animation`);
      await load.click();
      await expect(page.locator('#toolrail-settings-status')).toHaveText(`Loaded "${name}" into the Animation toolbar.`);
      await expect.poll(() => liveText(page)).toContain(`Loaded "${name}" into the Animation toolbar.`);
      expect(await railPins(page, 'toolrail-rail-t1')).toEqual(['pin:core/quote', 'pin:core/list']);
      expect(await railPins(page, 'toolrail-rail')).toEqual(mainBefore);
      expect(await page.evaluate(() => window.toolrail.getPinMeta('core/quote').title)).toBe('Shared quote');
      expect(await page.evaluate(() => window.toolrail.getPinMeta('core/verse').title)).toBe('My verse');

      // With the main toolbar chosen, the name is the main toolbar's.
      await page.locator('#toolrail-settings-toolbar').selectOption('main');
      await expect(page.locator('.toolrail-settings-sharedrow', { hasText: name }).locator('.toolrail-settings-sharedload'))
        .toHaveAttribute('aria-label', `Load the set ${name}, shared by ${users.author.displayName}, into Main toolbar`);
      await page.keyboard.press('Escape');
    } finally {
      await context.close();
      await unshareAll('author');
    }
  });

  test('the Saved sets menu loads a shared set into the main toolbar, with an extra toolbar shown (#95)', async ({ browser }) => {
    const name = `into main ${tag}`;
    await shareAs('author', setJson(name, ['core/quote', 'core/list']));
    const { context, page } = await editorAs(browser, 'author2');
    try {
      await seedExtraToolbar(page, ['core/verse']);
      const setsBtn = page.locator('#toolrail-rail [data-tool="saved-sets"]');
      await expect(setsBtn).toBeVisible({ timeout: 15000 });
      await setsBtn.click();
      const item = page.locator('.toolrail-flyout[aria-label="Saved sets"] [role="menuitemradio"]', { hasText: name });
      await item.click();
      await expect.poll(() => liveText(page)).toBe(`Loaded "${name}".`);
      await expect(setsBtn).toBeFocused();
      expect(await railPins(page, 'toolrail-rail')).toEqual(['pin:core/quote', 'pin:core/list']);
      expect(await railPins(page, 'toolrail-rail-t1')).toEqual(['pin:core/verse']);
      // The check mark follows the main toolbar's pins.
      await setsBtn.click();
      await expect(item).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
    } finally {
      await context.close();
      await unshareAll('author');
    }
  });

  test('another author\'s pattern in a shared set loads with the not-available message', async ({ browser }) => {
    test.slow(); // two browser contexts and two editor loads, each waiting for the pattern catalog
    // A published pattern of the Author's. Core lists a pattern in the
    // rail's catalog query (context=edit) only to users who can EDIT it:
    // the Author and an Editor, not a Contributor (posts controller
    // get_items, WordPress 7.1).
    const pattern = await rest(users.author.api, 'POST', '/wp/v2/blocks', {
      title: `Shared pattern ${tag}`, status: 'publish', content: '<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->',
    });
    expect(pattern.status).toBe(201);
    createdPatterns.push(pattern.body.id);
    const name = `with pattern ${tag}`;
    await shareAs('author', setJson(name, ['core/paragraph', 'pattern:user:' + pattern.body.id]));
    const contributor = await editorAs(browser, 'contributor');
    const editor = { context: null };
    try {
      const page = contributor.page;
      await waitForPatternCatalog(page);
      await page.locator('#toolrail-rail [data-tool="settings"]').click();
      await page.locator('.toolrail-settings-sharedrow', { hasText: name }).locator('.toolrail-settings-sharedload').click();
      await expect(page.locator('#toolrail-settings-status')).toHaveText(`Loaded "${name}". 1 pinned block is not available on this site and stays hidden until its plugin or theme is active.`);
      await expect(page.locator(`#toolrail-rail [data-tool="pin:pattern:user:${pattern.body.id}"]`)).toHaveCount(0);

      Object.assign(editor, await editorAs(browser, 'editor'));
      await waitForPatternCatalog(editor.page);
      await editor.page.locator('#toolrail-rail [data-tool="settings"]').click();
      await editor.page.locator('.toolrail-settings-sharedrow', { hasText: name }).locator('.toolrail-settings-sharedload').click();
      await expect(editor.page.locator('#toolrail-settings-status')).toHaveText(`Loaded "${name}".`);
      await expect(editor.page.locator(`#toolrail-rail [data-tool="pin:pattern:user:${pattern.body.id}"]`)).toBeVisible();
    } finally {
      await contributor.context.close();
      if (editor.context) {
        await editor.context.close();
      }
      await unshareAll('author');
    }
  });

  for (const failure of ['abort', 403]) {
    test(`the rail boots and the dialog opens when the shared-set request fails (${failure})`, async ({ browser }) => {
      await shareAs('author', setJson(`blocked ${tag}`, ['core/quote']));
      const context = await browser.newContext({ storageState: users.contributor.state });
      const page = await context.newPage();
      let blocked = 0;
      await page.route((url) => isSetsRequest(url.href), (route) => {
        blocked++;
        return failure === 'abort'
          ? route.abort()
          : route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'rest_forbidden', message: 'No.', data: { status: 403 } }) });
      });
      try {
        await openNewPost(page);
        await expect.poll(() => blocked).toBeGreaterThan(0);
        await page.locator('#toolrail-rail [data-tool="settings"]').click();
        await expect(page.locator('.toolrail-settings')).toBeVisible();
        await expect(page.locator('#toolrail-settings-search')).toBeFocused();
        await expect(page.locator('.toolrail-settings-sharedrow')).toHaveCount(0);
        await saveSetInDialog(page, 'still works');
        await expect(page.locator('.toolrail-settings-share')).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(page.locator('#toolrail-rail [data-tool="saved-sets"]')).toBeVisible();
      } finally {
        await context.close();
        await unshareAll('author');
      }
    });
  }
});
