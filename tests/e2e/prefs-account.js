/**
 * Read and write the test account's EditRail preferences on the SERVER.
 *
 * The rail keeps its settings in core's `core/preferences` store, which core
 * saves to the `wp_persisted_preferences` user meta of the logged-in account.
 * On a developer's own site that is the developer's own account, so a test
 * run writes the pins, dock and saved sets the developer uses by hand.
 *
 * Why this goes through the REST API instead of the store: core saves the
 * store with a debounced write (`wp-includes/js/dist/preferences-persistence.js`,
 * `requestDebounceMS = 2500`). The FIRST change is sent at once; later ones
 * are sent 2.5 s after that request finishes. A reload or a closed page in
 * that window cancels the trailing write, so only a partial first snapshot
 * reaches the database. A fixed wait before a reload does not fix that on a
 * slow site, and the rendered rail cannot show it either, because an empty
 * account reseeds its default pins on screen. (2026-09-24: this left a
 * developer's account with the migration stamps set and no pin list, which
 * the rail reads as "the author emptied the rail".) So every write here is
 * followed by a read of the server copy, and a write only counts once two
 * reads agree.
 *
 * Both browser suites use it the same way:
 *   - once per run, right after login, snapshotRailPrefs() saves the
 *     account's own rail settings to a file, and prints them, so a developer
 *     can see they are testing with custom pins;
 *   - each test or journey starts from a server-confirmed default state
 *     (setRailScope(), through the page's own cookies);
 *   - once per run, at the end, restoreRailPrefs() puts the snapshot back.
 * The snapshot file is deleted only after a confirmed restore. A run that
 * dies first leaves it, and the next run keeps it instead of snapshotting a
 * test's leftover state.
 */
const fs = require('fs');
const path = require('path');
const { request } = require('@playwright/test');

/** Where the e2e suite's start-of-run snapshot waits for the end-of-run restore. */
const SNAPSHOT_FILE = path.join(__dirname, '.auth', 'rail-prefs-snapshot.json');

/** The rail's own keys: what a test resets. Extension keys are not touched. */
const RAIL_PREF_KEYS = [
  'toolrail-help-seen',
  'toolrail-position',
  'toolrail-quick-slots',
  'toolrail-slot-configs',
  'toolrail-slots-migrated',
  'toolrail-help-hidden',
  'toolrail-wide',
  'toolrail-wide-toggle',
  'toolrail-appearance',
  'toolrail-group-seeded',
  'toolrail-hide-core-inserter',
  'toolrail-pin-meta',
  'toolrail-set-meta',
];

/** A fresh install after its one-time migrations: the four default pins. */
const BASELINE = {
  'toolrail-quick-slots': JSON.stringify(['core/group', 'core/paragraph', 'core/heading', 'core/image']),
  'toolrail-slots-migrated': '1',
  'toolrail-group-seeded': '1',
};

/** Keys that only tests write. They are never restored. */
const TEST_ONLY_KEY = /^toolrail-ext:(e2e|spec):/;

const USERS_ME = '/?rest_route=/wp/v2/users/me&context=edit';
const USERS_ME_WRITE = '/?rest_route=/wp/v2/users/me';
const NONCE_URL = '/wp-admin/admin-ajax.php?action=rest-nonce';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Open a REST session as the logged-in test account.
 *
 * @param {string} baseURL      Site root.
 * @param {string} storageState Path to the saved login (cookies).
 * @return {Promise<{ctx: import('@playwright/test').APIRequestContext, nonce: string}>}
 */
async function openApi(baseURL, storageState) {
  const ctx = await request.newContext({ baseURL, storageState });
  // Core's own endpoint for a fresh REST nonce for the cookie session.
  const res = await ctx.get(NONCE_URL);
  const nonce = (await res.text()).trim();
  if (!res.ok() || !/^[a-f0-9]{8,}$/i.test(nonce)) {
    await ctx.dispose();
    throw new Error(`Could not get a REST nonce for the test account (HTTP ${res.status()}, body "${nonce.slice(0, 40)}").`);
  }
  return { ctx, nonce };
}

/**
 * A REST session that shares an open page's cookies. Do not dispose it: it
 * belongs to the page's browser context.
 *
 * @param {import('@playwright/test').Page} page A page on the test site.
 * @return {Promise<{ctx: import('@playwright/test').APIRequestContext, nonce: string}>}
 */
async function apiForPage(page) {
  const res = await page.request.get(NONCE_URL);
  const nonce = (await res.text()).trim();
  if (!res.ok() || !/^[a-f0-9]{8,}$/i.test(nonce)) {
    throw new Error(`Could not get a REST nonce from the page's session (HTTP ${res.status()}).`);
  }
  return { ctx: page.request, nonce };
}

/**
 * The account's whole persisted preferences object.
 *
 * @param {{ctx, nonce}} api From openApi() or apiForPage().
 * @return {Promise<Object>}
 */
async function readPrefs(api) {
  const res = await api.ctx.get(USERS_ME, { headers: { 'X-WP-Nonce': api.nonce } });
  if (!res.ok()) {
    throw new Error(`Reading the test account failed (HTTP ${res.status()}).`);
  }
  const user = await res.json();
  return (user.meta && user.meta.persisted_preferences) || {};
}

/** Order-independent comparison of two flat string maps. */
function sameScope(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/**
 * Replace the account's `toolrail` scope with `scope`, and confirm it.
 *
 * Every other scope in the record (core's own editor preferences) is kept
 * as the server has it. Confirmed means two reads `settleMs` apart both
 * match, so a late write from a page that just closed cannot undo it
 * unnoticed.
 *
 * @param {{ctx, nonce}} api      From openApi() or apiForPage().
 * @param {Object}       scope    The toolrail scope to store; {} removes every key.
 * @param {number}       settleMs Gap between the two confirming reads.
 * @return {Promise<void>} Rejects when the server will not keep it.
 */
async function writeToolrailScope(api, scope, settleMs = 1500) {
  let agreed = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const prefs = await readPrefs(api);
    if (sameScope(prefs.toolrail, scope)) {
      agreed += 1;
      if (agreed === 2) {
        return;
      }
      await pause(settleMs);
      continue;
    }
    agreed = 0;
    const next = { ...prefs, _modified: new Date().toISOString() };
    if (Object.keys(scope).length) {
      next.toolrail = { ...scope };
    } else {
      delete next.toolrail;
    }
    // POST, not PUT: the route accepts both for an edit, and some servers
    // refuse PUT on the ?rest_route= form (HTTP 405 on the test site).
    const res = await api.ctx.post(USERS_ME_WRITE, {
      headers: { 'X-WP-Nonce': api.nonce },
      data: { meta: { persisted_preferences: next } },
    });
    if (!res.ok()) {
      throw new Error(`Writing the test account failed (HTTP ${res.status()}).`);
    }
    await pause(500);
  }
  throw new Error('The test account would not keep its EditRail preferences after 10 writes.');
}

/**
 * Set core's saved editor mode ('visual' or 'text'), and confirm it.
 *
 * The rail suites need the visual editor: the canvas iframe does not exist
 * in the Code editor. A test that switches to the Code editor and back
 * loses the switch back when the page closes inside core's 2.5 s save
 * delay, and the account then opens every later page in the Code editor
 * (found 2026-09-24; the old store-based reset hid it by keeping core's save
 * busy, so both switches were lost together).
 *
 * @param {{ctx, nonce}} api  From openApi() or apiForPage().
 * @param {string|undefined} mode The mode to store; undefined removes the key.
 * @return {Promise<boolean>} True when the server copy changed.
 */
async function writeEditorMode(api, mode) {
  let changed = false;
  let agreed = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const prefs = await readPrefs(api);
    const current = prefs.core ? prefs.core.editorMode : undefined;
    if (current === mode) {
      agreed += 1;
      if (agreed === 2 || !changed) {
        return changed;
      }
      await pause(1000);
      continue;
    }
    agreed = 0;
    changed = true;
    const core = { ...(prefs.core || {}) };
    if (mode === undefined) {
      delete core.editorMode;
    } else {
      core.editorMode = mode;
    }
    const res = await api.ctx.post(USERS_ME_WRITE, {
      headers: { 'X-WP-Nonce': api.nonce },
      data: { meta: { persisted_preferences: { ...prefs, core, _modified: new Date().toISOString() } } },
    });
    if (!res.ok()) {
      throw new Error(`Writing the editor mode failed (HTTP ${res.status()}).`);
    }
    await pause(500);
  }
  throw new Error('The test account would not keep its editor mode after 10 writes.');
}

/**
 * The pinned slots in a scope, for a one-line summary.
 *
 * @param {Object} scope A toolrail scope.
 * @return {string}
 */
function describeScope(scope) {
  const raw = scope && scope['toolrail-quick-slots'];
  if (raw === undefined) {
    return (scope && scope['toolrail-slots-migrated'])
      ? 'no pinned tools (the list is empty)'
      : 'no saved rail settings (the defaults will seed)';
  }
  try {
    const slots = JSON.parse(raw);
    return Array.isArray(slots) ? `${slots.length} pinned: ${slots.join(', ')}` : 'an unreadable pin list';
  } catch (e) {
    return 'an unreadable pin list';
  }
}

/**
 * Give a page's account a known rail state on the server, and confirm it:
 * every rail key removed, then `values` added. Extension keys stay. It also
 * puts core's editor mode back to the visual editor. Returns whether
 * anything changed, so a caller knows a reload is needed.
 *
 * Call it BEFORE a reload. The page's own store is not touched, so it
 * schedules no debounced save that could land later with an older state.
 *
 * @param {import('@playwright/test').Page} page   A page on the test site.
 * @param {Object}                          values Rail keys to set after the reset.
 * @return {Promise<boolean>} True when the server copy changed.
 */
async function setRailScope(page, values) {
  const api = await apiForPage(page);
  // A test starts in the visual editor: an earlier test's lost switch back
  // from the Code editor must not carry over.
  const modeChanged = (((await readPrefs(api)).core || {}).editorMode || 'visual') !== 'visual'
    ? await writeEditorMode(api, 'visual')
    : false;
  const current = (await readPrefs(api)).toolrail || {};
  const next = {};
  Object.keys(current).forEach((k) => {
    if (RAIL_PREF_KEYS.indexOf(k) === -1) {
      next[k] = current[k];
    }
  });
  Object.assign(next, values || {});
  if (sameScope(current, next)) {
    return modeChanged;
  }
  await writeToolrailScope(api, next, 1000);
  return true;
}

/**
 * Save the account's own rail settings once per run.
 *
 * A snapshot left by an earlier run that never restored it is KEPT: it holds
 * the developer's real settings, and the account now holds a test's. One
 * from a different site is replaced.
 *
 * @param {string} file         Snapshot path (gitignored).
 * @param {string} baseURL      Site root.
 * @param {string} storageState Saved login for that site.
 * @param {string} tag          Log prefix, e.g. "[editrail e2e]".
 * @return {Promise<void>}
 */
async function snapshotRailPrefs(file, baseURL, storageState, tag) {
  if (fs.existsSync(file)) {
    try {
      const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (kept && kept.baseURL === baseURL && kept.scope) {
        console.log(`${tag} Keeping the rail settings saved at ${kept.takenAt} by a run that did not restore them: ${describeScope(kept.scope)}. They are restored at the end of this run.`);
        return;
      }
    } catch (e) {
      /* Unreadable: replace it below. */
    }
  }
  const api = await openApi(baseURL, storageState);
  try {
    const prefs = await readPrefs(api);
    const scope = prefs.toolrail || {};
    // Core's editor mode rides along: tests force the visual editor.
    // null records "not set" (JSON drops undefined).
    const editorMode = prefs.core && prefs.core.editorMode !== undefined ? prefs.core.editorMode : null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), baseURL, scope, editorMode }, null, 2));
    console.log(`${tag} Saved your rail settings (${describeScope(scope)}). Tests run from the defaults; your settings are restored at the end.`);
  } finally {
    await api.ctx.dispose();
  }
}

/**
 * Put the start-of-run snapshot back, confirm it, then delete the file.
 * Test-only keys are dropped. Throws when the server will not keep it, so a
 * run that could not restore the account says so loudly, and the file stays
 * for the next run.
 *
 * @param {string} file         Snapshot path.
 * @param {string} storageState Saved login for the snapshot's site.
 * @param {string} tag          Log prefix.
 * @return {Promise<void>}
 */
async function restoreRailPrefs(file, storageState, tag) {
  if (!fs.existsSync(file)) {
    return;
  }
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const scope = {};
  Object.keys(snap.scope || {}).forEach((k) => {
    if (!TEST_ONLY_KEY.test(k)) {
      scope[k] = snap.scope[k];
    }
  });
  const api = await openApi(snap.baseURL, storageState);
  try {
    await writeToolrailScope(api, scope);
    // Older snapshots have no editorMode field: leave the mode alone then.
    if (Object.prototype.hasOwnProperty.call(snap, 'editorMode')) {
      await writeEditorMode(api, snap.editorMode === null ? undefined : snap.editorMode);
    }
  } finally {
    await api.ctx.dispose();
  }
  fs.unlinkSync(file);
  console.log(`${tag} Restored your rail settings: ${describeScope(scope)}.`);
}

module.exports = {
  SNAPSHOT_FILE,
  RAIL_PREF_KEYS,
  BASELINE,
  TEST_ONLY_KEY,
  openApi,
  apiForPage,
  readPrefs,
  writeToolrailScope,
  writeEditorMode,
  setRailScope,
  snapshotRailPrefs,
  restoreRailPrefs,
  describeScope,
  sameScope,
};
