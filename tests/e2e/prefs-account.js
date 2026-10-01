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
 * test's leftover state. There is one file per account, and it records the
 * runner's process ID, so a second run on the same account stops at setup
 * instead of overwriting the first run's snapshot.
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { request } = require('@playwright/test');

/**
 * Where both suites' start-of-run snapshots wait for the end-of-run restore:
 * one file per account (snapshotFileFor()), in a gitignored directory.
 */
const SNAPSHOT_DIR = path.join(__dirname, '.auth');

/** A snapshot file's name, as snapshotFileFor() builds it. */
const SNAPSHOT_NAME = /^rail-prefs-[0-9a-f]{10}-user-\d+\.json$/;

/** Where each suite kept its one snapshot before the files named an account. */
const LEGACY_SNAPSHOT_FILES = [
  path.join(__dirname, '.auth', 'rail-prefs-snapshot.json'),
  path.join(__dirname, '..', 'e2e-sr', 'rail-prefs-snapshot.json'),
];

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
 * The logged-in account: its user ID and its whole persisted preferences
 * object.
 *
 * @param {{ctx, nonce}} api From openApi() or apiForPage().
 * @return {Promise<{id: number, prefs: Object}>}
 */
async function readAccount(api) {
  const res = await api.ctx.get(USERS_ME, { headers: { 'X-WP-Nonce': api.nonce } });
  if (!res.ok()) {
    throw new Error(`Reading the test account failed (HTTP ${res.status()}).`);
  }
  const user = await res.json();
  return { id: user.id, prefs: (user.meta && user.meta.persisted_preferences) || {} };
}

/**
 * The account's whole persisted preferences object.
 *
 * @param {{ctx, nonce}} api From openApi() or apiForPage().
 * @return {Promise<Object>}
 */
async function readPrefs(api) {
  return (await readAccount(api)).prefs;
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
 * The snapshot file for one account on one site.
 *
 * One file per account, not one per suite: a leftover snapshot can then
 * never be restored into a different account (PR #38 review), and the e2e
 * and NVDA suites share a file when they log in as the same account, so the
 * run lock in snapshotRailPrefs() covers both suites. The site is hashed
 * because a URL is not a safe file name.
 *
 * @param {string} baseURL Site root.
 * @param {number} userId  The account's user ID.
 * @return {string} Absolute path inside SNAPSHOT_DIR.
 */
function snapshotFileFor(baseURL, userId) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`The test account has no usable user ID (${userId}).`);
  }
  const site = crypto.createHash('sha1').update(normalizeBaseURL(baseURL)).digest('hex').slice(0, 10);
  return path.join(SNAPSHOT_DIR, `rail-prefs-${site}-user-${userId}.json`);
}

/**
 * One spelling per site, for the file name AND every comparison:
 * "http://Site/" and "http://site" are the same site. Each suite has its
 * own URL variable (TOOLRAIL_URL, WP_BASE_URL), so both spellings occur, and
 * a comparison that disagreed with the file name treated a kept snapshot
 * as someone else's (PR #38 review, round 2).
 *
 * @param {string} baseURL Site root.
 * @return {string} Scheme and host in lower case, no trailing slash.
 */
function normalizeBaseURL(baseURL) {
  try {
    const u = new URL(String(baseURL));
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch (e) {
    return String(baseURL).replace(/\/+$/, '');
  }
}

/** A snapshot file's contents, or null when it is missing or unreadable. */
function readSnapshot(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * A snapshot file that exists, read once another run has finished writing
 * it. A write is not atomic, so a second run can read a half-written file;
 * a few short retries tell that apart from a file that is really damaged.
 * Throws for a damaged file instead of letting a caller replace it: it may
 * be the only copy of someone's settings.
 *
 * @param {string} file Snapshot path; must exist.
 * @param {string} tag  Log prefix.
 * @return {Promise<Object>}
 */
async function readSnapshotSettled(file, tag) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const snap = readSnapshot(file);
    if (snap) {
      return snap;
    }
    await pause(200);
  }
  throw new Error(`${tag} ${file} cannot be read. It may hold a developer's saved rail settings, so it is not replaced. Check it, then delete it, and run the tests again.`);
}

/**
 * Whether a process is running. EPERM means it exists but belongs to
 * another user, which still counts.
 *
 * @param {number} pid Process ID.
 * @return {boolean}
 */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Save the account's own rail settings once per run, and lock them to this
 * run.
 *
 * A snapshot left by an earlier run that never restored it is KEPT: it holds
 * the developer's real settings, and the account now holds a test's. Only a
 * snapshot of the same account on the same site is kept; another account's
 * has its own file and is never touched.
 *
 * The run lock: the snapshot records the test runner's process ID. While
 * that process is alive, another run on the same account stops here. Two
 * runs at once overwrote each other's snapshot on 2026-10-01: one run's
 * teardown restored and deleted the file, the other's setup then saved the
 * test defaults as the developer's settings, and its teardown "restored"
 * them. A dead process means an interrupted run, and its snapshot is kept.
 * The first snapshot is created exclusively, and every claim is re-read
 * after a pause, so two runs that start together cannot both pass. An
 * existing file is never replaced; one that cannot be read, or that names
 * another account or site, stops the run instead.
 *
 * @param {string} baseURL      Site root.
 * @param {string} storageState Saved login for that site.
 * @param {number} runnerPid    The test runner's process ID. restoreRailPrefs()
 *                              finds the snapshot by it.
 * @param {string} tag          Log prefix, e.g. "[editrail e2e]".
 * @return {Promise<void>}
 */
async function snapshotRailPrefs(baseURL, storageState, runnerPid, tag) {
  const api = await openApi(baseURL, storageState);
  try {
    const account = await readAccount(api);
    const file = snapshotFileFor(baseURL, account.id);

    // A snapshot from before the files named their account. Whose it is
    // cannot be known, so stop rather than restore it into the wrong
    // account or replace the only copy of someone's settings.
    LEGACY_SNAPSHOT_FILES.forEach((legacy) => {
      if (fs.existsSync(legacy)) {
        throw new Error(`${tag} ${legacy} was left by an older test run, and it does not say which account it belongs to. If it holds the rail settings of user ${account.id} on ${baseURL}, move it to ${file}. If not, delete it. Then run the tests again.`);
      }
    });

    const lockError = (pid) => new Error(`${tag} Another test run (process ${pid}) is using the rail settings of user ${account.id} on ${baseURL}. Two runs at once overwrite each other's saved settings. Wait for it to finish. If no test run is going, the process ID was reused by another program: delete the "runnerPid" line from ${file} and run again.`);

    // Two runs can reach this point together; the file is the lock. After
    // this run writes its process ID, a short pause and a re-read show
    // whether another run wrote after it — then that run owns the snapshot,
    // and this one stops.
    const confirmOwnership = async () => {
      await pause(300);
      const now = readSnapshot(file);
      if (!now || now.runnerPid !== runnerPid) {
        throw lockError(now ? now.runnerPid : 'unknown');
      }
    };

    // An existing file is never replaced: it is a kept snapshot, another
    // run's lock, or a file this code cannot vouch for. Replacing any of
    // them can destroy the only copy of a developer's settings (PR #38
    // review, round 2).
    if (fs.existsSync(file)) {
      const kept = await readSnapshotSettled(file, tag);
      // A file adopted by a rename has no userId yet; its name names the account.
      if (!kept.scope || normalizeBaseURL(kept.baseURL) !== normalizeBaseURL(baseURL)
        || (kept.userId !== undefined && kept.userId !== account.id)) {
        throw new Error(`${tag} ${file} does not hold the rail settings of user ${account.id} on ${baseURL}, so it is not used or replaced. Check it, then delete it, and run the tests again.`);
      }
      if (kept.runnerPid !== runnerPid && processAlive(kept.runnerPid)) {
        throw lockError(kept.runnerPid);
      }
      fs.writeFileSync(file, JSON.stringify({ ...kept, userId: account.id, runnerPid }, null, 2));
      await confirmOwnership();
      console.log(`${tag} Keeping the rail settings saved at ${kept.takenAt} by a run that did not restore them: ${describeScope(kept.scope)}. They are restored at the end of this run.`);
      return;
    }

    // No snapshot: save the account as it is now. The file is CREATED
    // exclusively ('wx'), so of two runs that both found no file, only one
    // gets it; the other stops on EEXIST.
    const scope = account.prefs.toolrail || {};
    // Core's editor mode rides along: tests force the visual editor.
    // null records "not set" (JSON drops undefined).
    const editorMode = account.prefs.core && account.prefs.core.editorMode !== undefined ? account.prefs.core.editorMode : null;
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    try {
      fs.writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), baseURL, userId: account.id, runnerPid, scope, editorMode }, null, 2), { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw e;
      }
      const other = await readSnapshotSettled(file, tag);
      throw lockError(other.runnerPid);
    }
    await confirmOwnership();
    console.log(`${tag} Saved your rail settings (${describeScope(scope)}). Tests run from the defaults; your settings are restored at the end.`);
  } finally {
    await api.ctx.dispose();
  }
}

/**
 * Put this run's snapshot back, confirm it, then delete the file.
 *
 * The snapshot is the one that holds this run's runner process ID. Before
 * any write, the logged-in account must be the one the snapshot names; when
 * it is not, nothing is written and the file stays (PR #38 review). Test-only
 * keys are dropped. Throws when the server will not keep it, so a run that
 * could not restore the account says so loudly, and the file stays for the
 * next run.
 *
 * @param {string} storageState Saved login for the snapshot's site.
 * @param {number} runnerPid    This test runner's process ID.
 * @param {string} tag          Log prefix.
 * @return {Promise<void>}
 */
async function restoreRailPrefs(storageState, runnerPid, tag) {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    return;
  }
  const held = fs.readdirSync(SNAPSHOT_DIR)
    .filter((name) => SNAPSHOT_NAME.test(name))
    .map((name) => ({ file: path.join(SNAPSHOT_DIR, name), snap: readSnapshot(path.join(SNAPSHOT_DIR, name)) }))
    .filter((s) => s.snap && s.snap.runnerPid === runnerPid);
  // None: this run's setup stopped before it saved anything.
  for (const { file, snap } of held) {
    const scope = {};
    Object.keys(snap.scope || {}).forEach((k) => {
      if (!TEST_ONLY_KEY.test(k)) {
        scope[k] = snap.scope[k];
      }
    });
    const api = await openApi(snap.baseURL, storageState);
    try {
      const account = await readAccount(api);
      if (account.id !== snap.userId) {
        throw new Error(`${tag} Not restored: ${file} holds the rail settings of user ${snap.userId}, but this run is logged in as user ${account.id}. The file is kept.`);
      }
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
}

module.exports = {
  SNAPSHOT_DIR,
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
