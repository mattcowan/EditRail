/**
 * EditRail, part 1 of 7 (editor-rail-core.js).
 *
 * The core of the rail: storage and the per-user preferences, their
 * readiness, the position model, icons, wide mode, the settings
 * sidebar width and appearance (the color tokens).
 *
 * The public contract (window.toolrail) and the long API documentation
 * are in the header of assets/editor-rail.js, the last of the rail's
 * files. includes/rail.php registers the files in their load order.
 *
 * This file creates window.toolrailInternal (T in each file), the
 * private namespace the rail's files share. A name that a later file
 * uses is copied onto T at the end of the file that declares it, and
 * the later file reads it in its header: that header is the list of
 * what the file uses from the files before it. `T.name` in the code is
 * a function from a LATER file (read when it is called, never at load
 * time), or state that more than one file changes.
 */
(function (wp) {
  'use strict';

  if (!(window.wp && wp.data && wp.blocks)) {
    return;
  }

  // The namespace the rail's files share (issue #102). It is PRIVATE:
  // its names and its shape can change in any release, without notice.
  // Extensions use window.toolrail, never this object. The files after
  // this one stop at once when it is missing, or when a file before
  // them did not run to its end (T.loaded, set at the end of each file).
  // The last file removes it from `window` when every file has run.
  var T = window.toolrailInternal = {};

  var __ = wp.i18n ? wp.i18n.__ : function (s) { return s; };
  var _n = wp.i18n ? wp.i18n._n : function (s, p, n) { return n === 1 ? s : p; };
  var sprintf = wp.i18n ? wp.i18n.sprintf : function (s) { return s; };

  /**
   * Announce a transient message to assistive technology.
   *
   * Deliberately core's regions, not ours: wp.a11y.speak() keeps two
   * live regions that persist for the life of the page, so a message
   * announces even when the UI that produced it is being rebuilt around
   * it. A role="status" element that we create and destroy per render
   * cannot — AT has to be observing the region BEFORE its text changes.
   *
   * @param {string} message Plain text.
   * @return {void}
   */
  function speak(message) {
    if (message && window.wp && wp.a11y && typeof wp.a11y.speak === 'function') {
      wp.a11y.speak(message);
    }
  }

  /**
   * Focus an element in this document from inside an event handler that
   * may run while the editor canvas (an iframe) holds focus: a drop from
   * the canvas, or a pointerdown whose default is prevented.
   *
   * One browser engine ignores such a focus() call while the iframe has
   * focus: activeElement stays the iframe and no focus event fires. The
   * same call made after the event has finished does take (measured
   * 2026-10-20, issue #74). So when the first call did not take, try once
   * more on the next task — but only if nothing else has taken focus in
   * between, so the retry never pulls focus away from the author. Focus
   * that moves inside the canvas leaves this document's activeElement on
   * the iframe, so the canvas's own activeElement is compared too.
   *
   * @param {HTMLElement} el      The element to focus.
   * @param {Object}      options Passed to focus(), such as preventScroll.
   * @return {void}
   */
  function focusFromEvent(el, options) {
    el.focus(options);
    if (document.activeElement === el) {
      return;
    }
    var before = document.activeElement;
    var beforeInFrame = frameActiveElement(before);
    window.setTimeout(function () {
      if (el.isConnected && document.activeElement === before
        && frameActiveElement(before) === beforeInFrame) {
        el.focus(options);
      }
    }, 0);
  }

  /**
   * @param {Element|null} node An element, maybe an iframe.
   * @return {Element|null} The focused element inside the iframe, or null
   *                        when node is not a same-origin iframe.
   */
  function frameActiveElement(node) {
    try {
      return node && node.contentDocument ? node.contentDocument.activeElement : null;
    } catch (err) {
      return null;
    }
  }

  var SLOTS_KEY = 'toolrail-quick-slots';
  var CONFIGS_KEY = 'toolrail-slot-configs';
  var POSITION_KEY = 'toolrail-position';
  var MIGRATED_KEY = 'toolrail-slots-migrated';
  var HELP_HIDDEN_KEY = 'toolrail-help-hidden';
  var GROUP_SEEDED_KEY = 'toolrail-group-seeded';
  var HIDE_CORE_INSERTER_KEY = 'toolrail-hide-core-inserter';
  var WIDE_KEY = 'toolrail-wide';
  var WIDE_TOGGLE_KEY = 'toolrail-wide-toggle';
  var APPEARANCE_KEY = 'toolrail-appearance';
  var PIN_META_KEY = 'toolrail-pin-meta';
  var SET_META_KEY = 'toolrail-set-meta';
  var SIDEBAR_WIDTH_KEY = 'toolrail-sidebar-width';
  var SIDEBAR_RESIZE_KEY = 'toolrail-sidebar-resize';
  var SETS_BUTTON_HIDDEN_KEY = 'toolrail-sets-button-hidden';
  // The Saved sets button's data-tool id (#93). Rail chrome, not a
  // registered tool, so allToolIds() reserves it.
  var SETS_TOOL_ID = 'saved-sets';
  // The extra toolbars (#95): one JSON value, {version, toolbars: [...]}.
  // The first toolbar is NOT in it. It keeps the keys it always had
  // (POSITION_KEY, SLOTS_KEY, WIDE_KEY), so an account from an older
  // version shows the same toolbar in the same place with no migration.
  var TOOLBARS_KEY = 'toolrail-toolbars';
  var TOOLBARS_BUTTON_HIDDEN_KEY = 'toolrail-toolbars-button-hidden';
  // The Toolbars button's data-tool id. Rail chrome, like SETS_TOOL_ID.
  var TOOLBAR_LIST_TOOL_ID = 'toolbar-list';
  // The one button of an extra toolbar that has no pinned tool yet.
  var ADD_TOOLS_TOOL_ID = 'toolbar-add-tools';
  // The first toolbar plus three. Each docked toolbar takes its width
  // from the canvas, so the number has to stop somewhere.
  var MAX_TOOLBARS = 4;
  // The narrowest content area (the editor's canvas region) the rail
  // stays quiet about (owner decision 2026-11-16: say so, refuse
  // nothing). 600px is core's own small breakpoint ($break-small), the
  // width under which core lays the editor out for a phone; a canvas
  // narrower than that is a phone layout on a desktop. Measured on the
  // test site, WordPress 7.1.3 at 1280 x 800 with the settings sidebar
  // open: one toolbar leaves 947px, four wide toolbars on one edge 200px.
  var MIN_CANVAS_WIDTH = 600;
  var PREFS_SCOPE = 'toolrail';
  var SHAPE_FILL = '#b9b9b9';

  // -------------------------------------------------------------------
  // Storage
  //
  // Preferences live in wp.data's `core/preferences` store (owner
  // decision 2026-08-26): core persists that store to the CURRENT USER's
  // account (the wp_persisted_preferences user meta, debounced REST
  // writes, preloaded into every editor page) — so the toolbar position,
  // pins and saved sets follow the author across browsers and devices on
  // this site instead of resetting per browser profile. It is the same
  // mechanism core uses for its own editor preferences. User meta is
  // per-site; moving state between SITES stays the job of set
  // export/import.
  //
  // Every preference goes through readKey/writeKey (string values, null
  // = never written — migration semantics depend on that distinction).
  // The localStorage machinery below survives as the FALLBACK for any
  // context where the preferences store is unavailable, OR — per KEY —
  // has proven unreliable this session, keeping the 0.1.4 resilience
  // contract there: a session where Storage THROWS (a private window,
  // "block site data", quota hit) stays coherent for its lifetime via
  // the in-memory mirror; `storageBroken` and `brokenPrefKeys` each
  // latch on their first throw so a hard-failing browser is not
  // re-probed on every read, and — critically — reads and writes agree
  // on which source is authoritative for a given key once it has
  // latched (see writeKey), without dragging every OTHER key still
  // working fine in the store down with it.
  // -------------------------------------------------------------------

  function prefsSelect() {
    try {
      return wp.data && wp.data.select ? (wp.data.select('core/preferences') || null) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * The core/preferences dispatcher, or null when the data module or the
   * store is not present. Wrapped in try/catch for the same reason
   * prefsSelect is: an editor context without wp.data throws here rather
   * than returning undefined.
   *
   * @return {Object|null} The dispatch object, or null.
   */
  function prefsDispatch() {
    try {
      return wp.data && wp.data.dispatch ? (wp.data.dispatch('core/preferences') || null) : null;
    } catch (e) {
      return null;
    }
  }

  var storageBroken = false;
  var memoryStore = Object.create(null);

  /**
   * Read a key from localStorage, falling back to the in-memory mirror.
   * Every successful read is mirrored, not just writes — once
   * storageBroken latches, the mirror is the only copy the session has.
   *
   * @param {string} key Storage key.
   * @return {string|null} The stored string, or null when absent.
   */
  function readLocalKey(key) {
    if (!storageBroken) {
      try {
        var value = window.localStorage.getItem(key);
        // Mirror every SUCCESSFUL read, not just writes — once
        // storageBroken latches this mirror is the only copy left (the
        // 0.1.4 lesson: an unmirrored key read back as null and the rail
        // silently emptied itself of pins and sets until reload).
        memoryStore[key] = value;
        return value;
      } catch (e) {
        storageBroken = true;
      }
    }
    return key in memoryStore ? memoryStore[key] : null;
  }

  /**
   * Write a key to the in-memory mirror first, then to localStorage. The
   * mirror is updated even when Storage is broken, so the session stays
   * coherent for its lifetime; the first throw latches storageBroken so a
   * hard-failing browser is not re-probed on every write.
   *
   * @param {string} key   Storage key.
   * @param {string} value Value to store.
   * @return {void}
   */
  function writeLocalKey(key, value) {
    memoryStore[key] = value;
    if (storageBroken) {
      return;
    }
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      storageBroken = true;
    }
  }

  /**
   * Delete a key from both the in-memory mirror and localStorage.
   *
   * @param {string} key Storage key.
   * @return {void}
   */
  function removeLocalKey(key) {
    delete memoryStore[key];
    if (storageBroken) {
      return;
    }
    try {
      window.localStorage.removeItem(key);
    } catch (e) {
      storageBroken = true;
    }
  }

  // Per-KEY latch: set when disp.set() has thrown once for that key — see
  // writeKey. Reads must honor it too, and only for that key: core's own
  // reducer never applies a failed write, so sel.get() would keep
  // returning the stale pre-write value forever for THIS key, while the
  // fallback write landed in memoryStore/localStorage instead — but every
  // OTHER key the store already holds is untouched by that failure and
  // must keep reading from the store, or a single bad write would wrongly
  // orphan everything else already saved there this session.
  var brokenPrefKeys = Object.create(null);

  /**
   * Read one preference. The account store wins unless THIS key has
   * already proven unreliable (see writeKey), in which case the local
   * fallback holds the authoritative value and the store would keep
   * returning the stale pre-write one.
   *
   * @param {string} key Preference key, within PREFS_SCOPE.
   * @return {string|null} The value as a string, or null when never written.
   */
  function readKey(key) {
    if (!brokenPrefKeys[key]) {
      var sel = prefsSelect();
      if (sel) {
        var value = sel.get(PREFS_SCOPE, key);
        return value === undefined || value === null ? null : String(value);
      }
    }
    return readLocalKey(key);
  }

  /**
   * Write one preference to the account store, falling back to local
   * storage for a key the store has failed on. The catch is load-bearing:
   * core writes its localStorage cache synchronously inside the reducer,
   * so a browser whose Storage throws aborts the whole dispatch and the
   * in-session value never updates either. Swallowing that would drop the
   * write silently.
   *
   * @param {string} key   Preference key, within PREFS_SCOPE.
   * @param {string} value Value to store.
   * @return {void}
   */
  function writeKey(key, value) {
    if (!brokenPrefKeys[key]) {
      var disp = prefsDispatch();
      if (disp) {
        try {
          disp.set(PREFS_SCOPE, key, value);
          return;
        } catch (e) {
          // Core's persistence layer writes its localStorage cache
          // SYNCHRONOUSLY inside the reducer, BEFORE the reducer returns
          // the next state — a browser whose Storage throws (quota hit,
          // private mode) surfaces that throw here, and it aborts the
          // whole dispatch: the in-session redux value never updates
          // either, so a swallow-and-return here would silently drop
          // the write. Once THIS key has proven unreliable, stop
          // trusting the store for it (reads included, above) and fall
          // through to the same local fallback a missing store uses.
          brokenPrefKeys[key] = true;
        }
      }
    }
    writeLocalKey(key, value);
  }

  // -------------------------------------------------------------------
  // Preference READINESS (0.1.21 extension API).
  //
  // readKey only knows whether the core/preferences STORE exists — not
  // whether its persistence layer has attached and hydrated the
  // account's saved values. Before that attach, a key that IS stored on
  // the account reads back null, and a write can be wiped when the
  // persisted state lands. The rail repairs its OWN keys through
  // watchPersistenceAttach(); an extension has no such hook, and reads
  // at script-load time — which is BEFORE boot(), because boot is
  // deferred to _wpLoadBlockEditor. So an extension could read null for
  // a value the author has, or lose an accepted write (MR review
  // 2026-09-02).
  //
  // The contract, deliberately ADDITIVE so nothing existing breaks:
  // window.toolrail.prefs.ready is a Promise resolving once the rail's
  // persistence watcher has settled, and 'toolrail:prefs-ready' fires
  // on window at the same moment. isReady() is the synchronous read.
  // An extension may read eagerly and simply re-read when this fires.
  //
  // Honest about what it means: "settled" is the point at which the
  // rail's own migrated marker reads back after any attach, which is
  // the same moment the rail trusts its own state. It is not a promise
  // from core, which exposes no attach signal of its own.
  // -------------------------------------------------------------------

  T.prefsReady = false;
  var prefsReadyResolve = null;
  var prefsReadyPromise = typeof window.Promise === 'function'
    ? new window.Promise(function (resolve) { prefsReadyResolve = resolve; })
    : null;

  /** Fire the event. Separate from the one-shot Promise because a
      repair AFTER the first settle is also a "re-read me" signal, and
      a Promise can only resolve once. */
  function emitPrefsReady() {
    try {
      window.dispatchEvent(new CustomEvent('toolrail:prefs-ready'));
    } catch (e) {
      /* No CustomEvent constructor — the Promise still resolved. */
    }
  }

  /**
   * Settle the preference-readiness contract: resolve the one-shot Promise
   * the first time, and fire the event EVERY time — a repair after the
   * first settle is also a "re-read me" signal for an extension.
   */
  function markPrefsReady() {
    if (!T.prefsReady) {
      T.prefsReady = true;
      if (prefsReadyResolve) {
        prefsReadyResolve();
      }
    }
    emitPrefsReady();
  }

  /**
   * Lift this browser's localStorage state into the account preferences,
   * run at boot (and re-run by the boot-race guard below if the
   * persistence layer's attach lands after boot() and wipes what boot()
   * just wrote).
   *
   * No global stamp gates this — a per-key check is the whole gate:
   * `sel.get(PREFS_SCOPE, key) !== undefined` skips any key the account
   * already has, so once any browser has established a key, another
   * browser's stale localStorage never overwrites it. Re-running this on
   * every boot is deliberate, not just tolerated: a global stamp here
   * previously let the FIRST browser to boot (even one with nothing to
   * migrate) block every later browser's real local state from ever
   * being lifted. The per-key check alone is idempotent and cheap enough
   * to run unconditionally.
   *
   * The skipped branch also CONSUMES the local copy. A successful account
   * write never touches localStorage (see writeKey), so a local value is
   * either pre-0.1.6 state or a fallback session's write — and once the
   * account holds the key, that copy can never be read again through the
   * store path, only lie in wait: with no uninstall able to reach a
   * browser, a leftover mirror resurrected old pins after a delete +
   * reinstall, and WHICH pins depended on which browser booted first
   * (owner concern 2026-09-04). Deleting it here — at boot, when the
   * account copy read back hydrated — is the safe moment: the lift branch
   * deliberately keeps the local copy, because boot's own write can still
   * be wiped by a late attach (watchPersistenceAttach) and the next boot
   * needs the source to lift from again. So a lifted key survives exactly
   * one more boot and is gone once the account provably has it.
   */
  function migrateLocalToPrefs() {
    var sel = prefsSelect();
    if (!sel || !prefsDispatch()) {
      return;
    }
    // writeKey, not a raw dispatch: it owns the throwing-Storage guard.
    [POSITION_KEY, SLOTS_KEY, CONFIGS_KEY, MIGRATED_KEY].forEach(function (key) {
      if (sel.get(PREFS_SCOPE, key) !== undefined) {
        if (!brokenPrefKeys[key]) {
          removeLocalKey(key);
        }
        return;
      }
      var local = readLocalKey(key);
      if (local !== null) {
        writeKey(key, local);
      }
    });
  }

  // -------------------------------------------------------------------
  // Rail position — docked to an edge, or floating like a graphics-editor
  // palette. A per-user account preference, same as the quick slots.
  //
  // The docks hang off the editor's OWN skeleton rather than being
  // absolutely positioned over it, so the canvas reflows around the rail
  // instead of being overlapped. Verified against core's InterfaceSkeleton
  // render and the shipped editor stylesheet:
  //
  //   .interface-interface-skeleton__editor   flex COLUMN: header, __body
  //   .interface-interface-skeleton__body     flex ROW, position:relative:
  //                                           secondary sidebar, content,
  //                                           settings sidebar, actions
  //
  //   left   → first child of __body   (before the canvas — the default)
  //   right  → last child of __body    (after the settings sidebar)
  //   top    → in __editor before __body  (full-width bar under the header)
  //   bottom → last child of __editor     (full-width bar under the canvas)
  //   float  → last child of __body, absolutely positioned — __body is
  //            already position:relative in core, so no editor CSS is
  //            touched and the palette cannot be dragged off into the
  //            admin chrome.
  // -------------------------------------------------------------------

  var DOCKS = ['left', 'right', 'top', 'bottom', 'float'];
  var DEFAULT_DOCK = 'left';
  var SNAP_THRESHOLD = 72;
  var RAIL_BAND = 53;

  var DOCK_LABELS = {
    left: __('Left edge', 'editrail'),
    right: __('Right edge, past the side panel', 'editrail'),
    top: __('Top, panels open downward', 'editrail'),
    bottom: __('Bottom, panels open upward', 'editrail'),
    float: __('Floating', 'editrail')
  };

  /**
   * Read the stored dock and floating offsets, validating every field
   * before it is trusted: an unknown dock, a non-finite coordinate or
   * unparseable JSON all fall back to the left dock at 24/24 rather than
   * leaving the rail somewhere it cannot be reached.
   *
   * @return {{dock: string, x: number, y: number}} The position.
   */
  function loadPosition() {
    var pos = { dock: DEFAULT_DOCK, x: 24, y: 24 };
    try {
      var raw = readKey(POSITION_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') {
        if (DOCKS.indexOf(parsed.dock) !== -1) {
          pos.dock = parsed.dock;
        }
        if (typeof parsed.x === 'number' && isFinite(parsed.x)) {
          pos.x = parsed.x;
        }
        if (typeof parsed.y === 'number' && isFinite(parsed.y)) {
          pos.y = parsed.y;
        }
      }
    } catch (e) {
      /* Private windows etc. — the default dock is correct. */
    }
    return pos;
  }

  /**
   * The state of ONE toolbar, at its start values (#95). A function that
   * reads or changes this state takes the toolbar as its first argument,
   * so the code that builds, places and moves a toolbar names no
   * particular one. The first toolbar is mainToolbar, below; the author
   * can add up to three more (`toolbars`).
   *
   * A value that belongs to one toolbar goes here, with its start value.
   * Two kinds do not, on purpose:
   *
   *  - The toolbar's NODES. They are looked up by id on every use
   *    (regionId, railId): the editor's re-render can remove the region
   *    at any time, and "not in the document" is how mount() learns that
   *    it must build a new one. A kept reference would outlive the node.
   *  - The roving tab stop. It has no variable: it is the one
   *    .toolrail-tool with tabIndex 0 inside the toolbar's rail node, and
   *    buildRail binds the two listeners that move it to that node.
   *
   * The FIRST toolbar's pins and wide mode are not here either: they stay
   * in the keys they always had (SLOTS_KEY, WIDE_KEY) and are read from
   * storage on every use, so loadSlots() and isWide() ask the store for
   * the first toolbar and this object for the others.
   *
   * State that is ONE FOR THE PAGE stays outside. Where that choice was
   * not obvious, the reason is beside the variable: the armed tool
   * (activeTool), the open flyout (openFlyout), a toolbar drag in flight
   * (drag), a tool drag in flight (railDragActive) and the pressed-state
   * signature (lastPaintedSignature). The flyout and the drag each record
   * the toolbar they belong to. The rest is shared by its nature: the
   * tool registry (`registered`) is what providers register, not what one
   * toolbar shows; the settings, help and add-to-toolbar dialogs are one
   * surface each, opened from the main toolbar's buttons and hung in its
   * region; the Section overview is a mode of the canvas; and the
   * appearance and the saved sets are stored preferences with no variable
   * here.
   *
   * @param {string} id       The toolbar's name in code.
   * @param {string} regionId The id of its region node.
   * @param {string} railId   The id of its role="toolbar" node.
   * @return {Object} A fresh toolbar state.
   */
  function newToolbar(id, regionId, railId) {
    return {
      // The toolbar's name in code: 'main' for the first toolbar, and the
      // stored id of an extra toolbar (TOOLBARS_KEY), which is also the
      // tail of its two node ids and its region's data-toolbar value.
      id: id,
      // An extra toolbar's own values, as stored in its record: the name
      // the author gave it (its accessible name), its pinned slots, its
      // wide mode, and whether the author has hidden it. The first
      // toolbar does not use these: it has no name of its own, it cannot
      // be hidden, and its pins and wide mode are in their own keys.
      name: '',
      slots: [],
      wide: false,
      hidden: false,
      // The ids of the toolbar's two nodes: the positioned region that
      // hangs in the editor's skeleton, and the role="toolbar" rail
      // inside it.
      regionId: regionId,
      railId: railId,
      // The dock and the floating offsets. Defaults until boot() re-loads
      // from storage — reads must wait for the editor to attach the
      // preferences persistence layer, and nothing consumes `position`
      // before mount anyway.
      position: { dock: DEFAULT_DOCK, x: 24, y: 24 },
      // An extra toolbar's floating offsets as STORED in its record.
      // `position` holds the painted offsets, which applyFloatPosition()
      // clamps into the window; only a move of this toolbar
      // (savePosition) or a stored change (syncToolbars) changes these,
      // so a save for a different toolbar never stores a clamp. The first
      // toolbar does not use them: only its own moves write its key.
      stored: { x: 24, y: 24 },
      // Every React root created for a pinned-block icon, so the previous
      // generation can be unmounted. A discarded root keeps its fiber tree
      // alive, and the rail rebuilds on every slot change (the ↑/↓ buttons
      // in the settings dialog rebuild it per click) — so these accumulate
      // fast unless they are disposed. buildRail() is the ONLY producer
      // and always creates a complete new set, which makes it the correct
      // disposal point. Per toolbar, because that set is one rail's: a
      // shared list would let one toolbar's rebuild unmount the icons of
      // a different toolbar.
      iconRoots: [],
      // The tools section's ResizeObserver, disposed on the same rule as
      // the icon roots: buildRail is the only producer, so it disconnects
      // the previous generation before creating the next.
      scrollObserver: null
    };
  }

  // The first toolbar. Its two ids are public: extension plugins read the
  // --toolrail-* tokens off #toolrail-region, and the browser tests name
  // #toolrail-rail. It holds Select, the Section overview, the provider
  // tools, Help and Toolbar settings, so it is never hidden or deleted.
  var mainToolbar = newToolbar('main', 'toolrail-region', 'toolrail-rail');

  // Every toolbar, the first one first. The order is the Tab order and
  // the order on a shared edge (see placeToolbarRegions).
  T.toolbars = [mainToolbar];

  // The stored extra toolbars as syncToolbars() last applied them (the
  // JSON of the validated records), so a preference change that is not
  // about toolbars costs one read and one compare.
  var toolbarsSynced = '[]';

  var TOOLBAR_ID_PATTERN = /^[a-z0-9]{1,12}$/;
  var TOOLBAR_NAME_MAX = 40;

  /**
   * Persist a toolbar's dock and floating offsets.
   *
   * @param {Object} tb The toolbar.
   * @return {void}
   */
  function savePosition(tb) {
    if (tb === mainToolbar) {
      writeKey(POSITION_KEY, JSON.stringify(tb.position));
    } else {
      // This toolbar moved: its painted offsets become its stored ones.
      tb.stored = { x: tb.position.x, y: tb.position.y };
      saveToolbars();
    }
  }

  /**
   * @param {string} id A toolbar id ('main' or a stored id).
   * @return {Object|null} The toolbar, or null.
   */
  function toolbarById(id) {
    for (var i = 0; i < T.toolbars.length; i++) {
      if (T.toolbars[i].id === id) {
        return T.toolbars[i];
      }
    }
    return null;
  }

  /**
   * What the author calls a toolbar: its own name, or "Main toolbar" for
   * the first one. For lists, headings and messages. The first toolbar's
   * ACCESSIBLE name stays "Tools" (buildRail).
   *
   * @param {Object} tb The toolbar.
   * @return {string} The name.
   */
  function toolbarLabel(tb) {
    return tb === mainToolbar ? __('Main toolbar', 'editrail') : tb.name;
  }

  /**
   * A toolbar name as it is stored: a string, with runs of white space
   * as one space, trimmed, and not longer than TOOLBAR_NAME_MAX.
   *
   * @param {*} value A candidate name.
   * @return {string} The clean name; '' when there is none.
   */
  function cleanToolbarName(value) {
    if (typeof value !== 'string') {
      return '';
    }
    return value.replace(/\s+/g, ' ').trim().slice(0, TOOLBAR_NAME_MAX).trim();
  }

  /**
   * Whether a name is in use. A toolbar's name is its accessible name, so
   * two toolbars must not have the same one. The compare ignores case. The
   * first toolbar's two names, "Tools" and "Main toolbar", are taken too.
   *
   * @param {string}   name  A clean name.
   * @param {string[]} taken The names of the other extra toolbars.
   * @return {boolean}
   */
  function toolbarNameTaken(name, taken) {
    var wanted = name.toLowerCase();
    return [__('Tools', 'editrail'), __('Main toolbar', 'editrail')].concat(taken).some(function (other) {
      return other.toLowerCase() === wanted;
    });
  }

  /**
   * A name that no other toolbar has: the name itself, or the name with
   * the first free number after it ("Animation 2").
   *
   * @param {string}   name  A clean name.
   * @param {string[]} taken The names of the other extra toolbars.
   * @return {string} The free name.
   */
  function uniqueToolbarName(name, taken) {
    var candidate = name;
    for (var n = 2; toolbarNameTaken(candidate, taken); n++) {
      candidate = name.slice(0, TOOLBAR_NAME_MAX - String(n).length - 1).trim() + ' ' + n;
    }
    return candidate;
  }

  /**
   * The name a new toolbar gets: "Toolbar 2" for the second toolbar, and
   * the next free number after that.
   *
   * @param {string[]} taken The names of the other extra toolbars.
   * @return {string} The name.
   */
  function defaultToolbarName(taken) {
    for (var n = taken.length + 2; ; n++) {
      var name = sprintf(
        /* translators: %d: the toolbar's number, 2 or more. */
        __('Toolbar %d', 'editrail'),
        n
      );
      if (!toolbarNameTaken(name, taken)) {
        return name;
      }
    }
  }

  /**
   * The stored value of TOOLBARS_KEY as an object, or null when it is not
   * there, cannot be parsed, or is not a version this code knows.
   *
   * A value from a LATER version of the plugin therefore shows no extra
   * toolbars here, and the first change that saves the list (an added
   * toolbar) replaces it with a version 1 list. A downgrade can lose the
   * extra toolbars that way. That is accepted: the first toolbar and its
   * keys are never touched.
   *
   * @return {Object|null} {version: 1, toolbars: Array}, or null.
   */
  function readToolbarStore() {
    try {
      var raw = readKey(TOOLBARS_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && parsed.version === 1 && Array.isArray(parsed.toolbars)) {
        return parsed;
      }
    } catch (e) {
      /* Unparseable or unavailable storage: no extra toolbars. */
    }
    return null;
  }

  /**
   * Which stored records the reader uses, and which it leaves out. Used:
   * an object with a valid id ('main' is not one) that no record before
   * it has, while there is room (MAX_TOOLBARS - 1). Left out: everything
   * else, in stored order: a bad or repeated id, a non-object, a record
   * past the maximum. One rule for the reader and the writer, so the
   * writer can keep exactly what the reader did not show.
   *
   * @param {Array} list The stored `toolbars` array.
   * @return {{accepted: Object[], leftOut: Array}} The two lists.
   */
  function splitToolbarRecords(list) {
    // A prototype-less map: an id such as 'constructor' passes the id
    // pattern and must not read as already seen (review 2026-11-16,
    // finding 6).
    var ids = Object.create(null);
    var accepted = [];
    var leftOut = [];
    list.forEach(function (rec) {
      var usable = accepted.length < MAX_TOOLBARS - 1 && !!rec && typeof rec === 'object'
        && typeof rec.id === 'string' && TOOLBAR_ID_PATTERN.test(rec.id)
        && rec.id !== mainToolbar.id && !ids[rec.id];
      if (usable) {
        ids[rec.id] = true;
        accepted.push(rec);
      } else {
        leftOut.push(rec);
      }
    });
    return { accepted: accepted, leftOut: leftOut };
  }

  /**
   * The stored extra toolbars, each field validated before it is trusted,
   * in stored order. A record with a bad or repeated id is not shown.
   * Every other bad field gets its default: an unknown dock becomes the
   * left dock, a missing name becomes "Toolbar N", and a name another
   * toolbar has gets a number. Records past the maximum are left out,
   * not deleted: nothing is written here, and saveToolbars() writes the
   * left-out records back as they were.
   *
   * @return {Object[]} {id, name, dock, x, y, slots, wide, hidden} each.
   */
  function loadToolbarRecords() {
    var store = readToolbarStore();
    var out = [];
    var names = [];
    splitToolbarRecords(store ? store.toolbars : []).accepted.forEach(function (rec) {
      var name = cleanToolbarName(rec.name);
      name = name ? uniqueToolbarName(name, names) : defaultToolbarName(names);
      names.push(name);
      out.push({
        id: rec.id,
        name: name,
        dock: DOCKS.indexOf(rec.dock) !== -1 ? rec.dock : DEFAULT_DOCK,
        x: typeof rec.x === 'number' && isFinite(rec.x) ? rec.x : 24,
        y: typeof rec.y === 'number' && isFinite(rec.y) ? rec.y : 24,
        slots: T.normalizeSlots(rec.slots),
        wide: rec.wide === true,
        hidden: rec.hidden === true
      });
    });
    return out;
  }

  /**
   * Write every extra toolbar back from its object. The ONE writer of
   * TOOLBARS_KEY: a caller changes the toolbar object first and then calls
   * this, so the stored list and the objects cannot disagree. A field of
   * a stored record that this code does not know is kept.
   *
   * The records the reader left out (splitToolbarRecords) are written back
   * unchanged, after the toolbars this page shows. Without that, the first
   * change deleted records past the maximum, with their pins (review
   * 2026-11-16, finding 3). A repeated id is left out the same way: it
   * stays, as stored, after the toolbar that has that id, and the reader
   * keeps not showing it. A record the reader DID show and that is no
   * longer in `toolbars` was deleted by the author, and goes.
   *
   * @return {void}
   */
  function saveToolbars() {
    var store = readToolbarStore();
    var split = splitToolbarRecords(store ? store.toolbars : []);
    var stored = Object.create(null);
    split.accepted.forEach(function (rec) {
      stored[rec.id] = rec;
    });
    var list = T.toolbars.filter(function (tb) {
      return tb !== mainToolbar;
    }).map(function (tb) {
      var rec = {};
      Object.keys(stored[tb.id] || {}).forEach(function (key) {
        if (key !== '__proto__') {
          rec[key] = stored[tb.id][key];
        }
      });
      rec.id = tb.id;
      rec.name = tb.name;
      rec.dock = tb.position.dock;
      // The STORED offsets, not the painted ones: applyFloatPosition()
      // clamps tb.position into a narrow window, and a save made for a
      // different toolbar wrote that clamp as this toolbar's place
      // (PR #126 review, CodeRabbit). savePosition() updates them when
      // the author moves this toolbar.
      rec.x = tb.stored.x;
      rec.y = tb.stored.y;
      rec.slots = tb.slots.slice();
      rec.wide = tb.wide;
      rec.hidden = tb.hidden;
      return rec;
    });
    // A left-out record with the id of a toolbar the author just deleted
    // (shown before, not in `toolbars` now) is a duplicate of it. Kept, it
    // would be the next record the reader accepts for that id, and the
    // deleted toolbar would come back with its pins (PR #126 review,
    // CodeRabbit). It goes with the toolbar. Other left-out records stay.
    var known = Object.create(null);
    T.toolbars.forEach(function (tb) {
      known[tb.id] = true;
    });
    var leftOut = split.leftOut.filter(function (rec) {
      var id = rec && typeof rec === 'object' ? rec.id : null;
      return !(typeof id === 'string' && stored[id] && !known[id]);
    });
    writeKey(TOOLBARS_KEY, JSON.stringify({ version: 1, toolbars: list.concat(leftOut) }));
    // This page's own change is already in the objects, so the next
    // syncToolbars() has nothing to do for it. The signature is built
    // from the objects, not read back: when a delete makes room for a
    // left-out record, the store now shows one more toolbar than this
    // page, and the next sync must find that difference and add it.
    toolbarsSynced = JSON.stringify(T.toolbars.slice(1).map(function (tb) {
      return {
        id: tb.id,
        name: tb.name,
        dock: tb.position.dock,
        x: tb.stored.x,
        y: tb.stored.y,
        slots: tb.slots,
        wide: tb.wide,
        hidden: tb.hidden
      };
    }));
  }

  /**
   * Tell extensions that a toolbar was added, removed, renamed, moved,
   * shown or hidden.
   *
   * Every change but a rename can move the canvas, so it also fires
   * toolrail:position-changed, first. That event's payload is ALWAYS the
   * first toolbar's position: a listener that reads it as "where the
   * toolbar is" gets what getDock() says, and a listener that reads it as
   * "the layout moved, measure again" measures again. The new event says
   * which toolbar changed (#95).
   *
   * @param {string} id     The toolbar's id; '' when the stored list
   *                        changed from outside this page.
   * @param {string} change 'added', 'removed', 'renamed', 'position',
   *                        'shown', 'hidden' or 'synced'.
   * @return {void}
   */
  function announceToolbarsChange(id, change) {
    if (change !== 'renamed') {
      var first = mainToolbar.position;
      window.dispatchEvent(new CustomEvent('toolrail:position-changed', {
        detail: { dock: first.dock, x: first.x, y: first.y }
      }));
    }
    window.dispatchEvent(new CustomEvent('toolrail:toolbars-changed', {
      detail: { toolbar: id, change: change }
    }));
  }

  /**
   * Take a toolbar's region out of the document for good, and release
   * what its last build holds. setDock removes a region too, but builds
   * it again at once, and that build does the release. A hidden or
   * deleted toolbar gets no next build.
   *
   * @param {Object} tb The toolbar.
   * @return {void}
   */
  function removeToolbarRegion(tb) {
    if (T.openFlyout && T.openFlyout.toolbar === tb) {
      T.closeFlyout(false);
    }
    if (T.drag && T.drag.toolbar === tb) {
      T.finishDrag();
    }
    T.releaseToolDragOf(tb);
    disposeIconRoots(tb);
    if (tb.scrollObserver) {
      tb.scrollObserver.disconnect();
      tb.scrollObserver = null;
    }
    var region = document.getElementById(tb.regionId);
    if (region) {
      region.remove();
    }
  }

  /**
   * Return the rail to Select when the armed tool has no button left on
   * any shown toolbar, and say so. A toolbar that the author hides or
   * deletes can take the armed tool with it; without this the canvas
   * keeps the armed cursor and no button shows as pressed.
   *
   * A caller that announces its own change passes `quiet` and puts
   * disarmedMessage() into its one message: two speak() calls in one
   * task leave only the second in the live region, so the disarm was
   * never heard (review 2026-11-16, finding 2).
   *
   * @param {boolean} quiet Do not speak; the caller does.
   * @return {boolean} True when it disarmed.
   */
  function disarmIfToolGone(quiet) {
    if (T.activeTool !== 'select' && !T.findTool(T.activeTool)) {
      T.setActiveTool('select');
      if (!quiet) {
        speak(disarmedMessage());
      }
      return true;
    }
    return false;
  }

  /** @return {string} The sentence for a disarm the author did not ask for. */
  function disarmedMessage() {
    return __('Tool disarmed. Select is active.', 'editrail');
  }

  /**
   * One message from a change's own message and the sentences it adds
   * (a disarm, a narrow canvas), for one speak() call.
   *
   * @param {string[]} parts Sentences; empty ones are left out.
   * @return {string} The message.
   */
  function joinMessages(parts) {
    return parts.filter(function (part) {
      return !!part;
    }).join(' ');
  }

  /**
   * Make the toolbar objects and their regions agree with the stored
   * list. The one path for every change that did not start in this page's
   * own code: the first read at boot, core's late attach of the saved
   * preferences, and a write from a different tab that a later attach
   * brings in. This page's own changes update the object before they
   * write, so they find nothing to do here.
   *
   * A changed toolbar's region is built again whole. Its position alone
   * is applied in place.
   *
   * @return {boolean} True when a toolbar was added, removed or rebuilt.
   */
  function syncToolbars() {
    var records = loadToolbarRecords();
    var signature = JSON.stringify(records);
    if (signature === toolbarsSynced) {
      return false;
    }
    toolbarsSynced = signature;

    var changed = false;
    // Offsets alone changed: no rebuild, but the layout moved, so
    // listeners still hear of it (PR #126 review, CodeRabbit).
    var moved = false;
    var next = [mainToolbar];
    records.forEach(function (rec) {
      var tb = toolbarById(rec.id);
      // A drag owns the position until it ends, and saves it then.
      var dragging = !!T.drag && T.drag.toolbar === tb;
      if (!tb) {
        tb = newToolbar(rec.id, 'toolrail-region-' + rec.id, 'toolrail-rail-' + rec.id);
        changed = true;
      } else if (tb.name !== rec.name || tb.wide !== rec.wide || tb.hidden !== rec.hidden
        || JSON.stringify(tb.slots) !== JSON.stringify(rec.slots)
        || (!dragging && tb.position.dock !== rec.dock)) {
        removeToolbarRegion(tb);
        changed = true;
        // removeToolbarRegion() ends a drag of this toolbar. A drag that
        // ended no longer owns the position, so the stored one applies
        // (PR #126 review, CodeRabbit).
        dragging = !!T.drag && T.drag.toolbar === tb;
      } else if (!dragging && (tb.stored.x !== rec.x || tb.stored.y !== rec.y)) {
        moved = true;
      }
      tb.name = rec.name;
      tb.slots = rec.slots;
      tb.wide = rec.wide;
      tb.hidden = rec.hidden;
      tb.stored = { x: rec.x, y: rec.y };
      if (!dragging) {
        tb.position.dock = rec.dock;
        tb.position.x = rec.x;
        tb.position.y = rec.y;
      }
      next.push(tb);
    });
    T.toolbars.forEach(function (tb) {
      if (next.indexOf(tb) === -1) {
        removeToolbarRegion(tb);
        changed = true;
      }
    });
    var reordered = next.some(function (tb, i) {
      return T.toolbars[i] !== tb;
    });
    T.toolbars = next;

    if (changed || reordered) {
      // The chosen toolbar in Toolbar settings can be one that is gone.
      if (!toolbarById(T.settingsToolbarId)) {
        T.settingsToolbarId = mainToolbar.id;
      }
      // An open Toolbars menu shows the old list: a checked item would
      // now do the opposite of what it says. Close it, and keep the
      // focus on its button when the focus was in it (PR #126 review,
      // CodeRabbit).
      if (T.openFlyout && T.openFlyout.parentBtn.dataset.tool === TOOLBAR_LIST_TOOL_ID) {
        T.closeFlyout(T.openFlyout.node.contains(document.activeElement));
      }
      T.mountToolbars();
      T.syncLayers();
      // A provider tool under a pin of a changed toolbar can move to or
      // from the first toolbar's top level.
      T.rerenderMainForParents(null);
      // The first toolbar shows the Toolbars button only while an extra
      // toolbar exists.
      T.reconcileToolbarsButton();
      disarmIfToolGone();
    }
    // Paint every floating toolbar BEFORE the events below, so a
    // listener that measures the layout sees the new boxes (PR #126
    // review, CodeRabbit). A toolbar whose offsets alone changed keeps
    // its region.
    T.toolbars.forEach(T.applyFloatPosition);
    if (changed || reordered || moved) {
      announceToolbarsChange('', 'synced');
    }
    if (changed || reordered) {
      if (T.settingsOpen) {
        T.refreshSettings();
      }
      T.placeOpenDialogs();
    }
    return changed || reordered;
  }

  /**
   * Add a toolbar: empty, with the next free name, beside the first
   * toolbar on the same edge (a floating one a little down and right of
   * it, so the two do not start one on the other). Refused at
   * MAX_TOOLBARS.
   *
   * @return {Object|null} The new toolbar, or null when the maximum is
   *                       reached.
   */
  function addToolbar() {
    if (T.toolbars.length >= MAX_TOOLBARS) {
      return null;
    }
    // Skip the ids of stored records too: a left-out record that
    // saveToolbars() keeps must not be shadowed by a new toolbar that
    // takes its id.
    var store = readToolbarStore();
    var used = Object.create(null);
    (store ? store.toolbars : []).forEach(function (rec) {
      if (rec && typeof rec === 'object' && typeof rec.id === 'string') {
        used[rec.id] = true;
      }
    });
    var n = 1;
    while (toolbarById('t' + n) || used['t' + n]) {
      n++;
    }
    var id = 't' + n;
    var tb = newToolbar(id, 'toolrail-region-' + id, 'toolrail-rail-' + id);
    tb.name = defaultToolbarName(T.toolbars.slice(1).map(function (other) {
      return other.name;
    }));
    tb.position.dock = mainToolbar.position.dock;
    tb.position.x = mainToolbar.position.x + 24 * T.toolbars.length;
    tb.position.y = mainToolbar.position.y + 24 * T.toolbars.length;
    tb.stored = { x: tb.position.x, y: tb.position.y };
    T.toolbars.push(tb);
    saveToolbars();
    T.mount(tb);
    T.syncLayers();
    T.reconcileToolbarsButton();
    // A dialog open past the first toolbar's edge now has one more
    // toolbar to clear.
    T.placeOpenDialogs();
    announceToolbarsChange(tb.id, 'added');
    return tb;
  }

  /**
   * Give an extra toolbar a new name. The name is its accessible name,
   * so an empty name and a name another toolbar has are refused.
   *
   * @param {Object} tb    An extra toolbar.
   * @param {string} value The name the author typed.
   * @return {string} 'renamed', 'same', 'empty' or 'taken'.
   */
  function renameToolbar(tb, value) {
    var name = cleanToolbarName(value);
    if (!name) {
      return 'empty';
    }
    if (name === tb.name) {
      return 'same';
    }
    var others = T.toolbars.filter(function (other) {
      return other !== mainToolbar && other !== tb;
    }).map(function (other) {
      return other.name;
    });
    if (toolbarNameTaken(name, others)) {
      return 'taken';
    }
    tb.name = name;
    saveToolbars();
    // The name is on the region and, built in, on the rail: its accessible
    // name and an empty toolbar's "Add tools to <name>" button, which kept
    // the old name until a rebuild (review 2026-11-16, finding 4). The
    // rebuild moves focus only when focus was in that rail, and a rename
    // comes from the dialog.
    var region = document.getElementById(tb.regionId);
    if (region) {
      region.setAttribute('aria-label', regionLabel(tb));
    }
    T.rerender(tb);
    announceToolbarsChange(tb.id, 'renamed');
    return 'renamed';
  }

  /**
   * Delete an extra toolbar. Its pins go with it; a pin's own name,
   * description and icon are cleared only when no other toolbar shows
   * that pin.
   *
   * The armed tool is put back to Select when it went with the toolbar,
   * without a word: the caller says it in its own message.
   *
   * @param {Object} tb An extra toolbar.
   * @return {Object|boolean} {disarmed} when it was deleted; else false.
   */
  function deleteToolbar(tb) {
    var index = T.toolbars.indexOf(tb);
    if (tb === mainToolbar || index === -1) {
      return false;
    }
    var slots = tb.slots.slice();
    T.toolbars.splice(index, 1);
    saveToolbars();
    removeToolbarRegion(tb);
    slots.forEach(function (name) {
      if (!T.isPinnedAnywhere(name) && T.clearPinMeta(name)) {
        T.announcePinMetaChange(name);
      }
    });
    if (T.settingsToolbarId === tb.id) {
      T.settingsToolbarId = mainToolbar.id;
    }
    T.rerenderMainForParents(tb);
    T.mountToolbars();
    T.syncLayers();
    T.reconcileToolbarsButton();
    var disarmed = disarmIfToolGone(true);
    T.placeOpenDialogs();
    window.dispatchEvent(new CustomEvent('toolrail:tools-updated'));
    announceToolbarsChange(tb.id, 'removed');
    return { disarmed: disarmed };
  }

  /**
   * Show or hide an extra toolbar. A hidden toolbar has no region in the
   * document, so it has no Tab stop and no landmark, and the canvas gets
   * its room back. Its record keeps everything else. A disarm is silent;
   * the caller says it in its own message.
   *
   * @param {Object}  tb     An extra toolbar.
   * @param {boolean} hidden Whether to hide it.
   * @return {Object|boolean} {disarmed} when the state changed; else false.
   */
  function setToolbarHidden(tb, hidden) {
    if (tb === mainToolbar || tb.hidden === !!hidden) {
      return false;
    }
    tb.hidden = !!hidden;
    saveToolbars();
    var disarmed = false;
    if (tb.hidden) {
      removeToolbarRegion(tb);
      disarmed = disarmIfToolGone(true);
    } else {
      T.mount(tb);
    }
    T.syncLayers();
    T.placeOpenDialogs();
    announceToolbarsChange(tb.id, tb.hidden ? 'hidden' : 'shown');
    return { disarmed: disarmed };
  }

  /**
   * The sentence to add to an author's change when it left the canvas
   * narrower than MIN_CANVAS_WIDTH, or ''. Nothing is refused (owner
   * decision 2026-11-16): the author hears it and decides. Called only
   * after a change the author made in the rail's own controls (add, dock
   * or move, wide on, show), never on page load or a window resize.
   *
   * Width only. The top and bottom docks never take tool names, so a
   * stack of horizontal bars is at most MAX_TOOLBARS × 53px tall.
   *
   * @return {string} The sentence, or ''.
   */
  function canvasNarrowMessage() {
    // Only while more than one toolbar is SHOWN: a hidden toolbar takes no
    // width, and with one toolbar the rail acts as it did before #95 and
    // "hide or move a toolbar" names nothing the author can do (review
    // 2026-11-16, round 2).
    var shown = T.toolbars.filter(function (tb) {
      return !tb.hidden;
    }).length;
    var content = T.contentRegion();
    var width = content ? Math.round(content.getBoundingClientRect().width) : 0;
    if (shown < 2 || !content || width >= MIN_CANVAS_WIDTH) {
      return '';
    }
    return sprintf(
      /* translators: 1: the canvas width in pixels, 2: the smallest width that keeps blocks easy to edit. */
      __('The content area is now %1$d pixels wide, less than %2$d. To give it more room, hide or move a toolbar, or turn off tool names.', 'editrail'),
      width,
      MIN_CANVAS_WIDTH
    );
  }

  /**
   * The accessible name of a toolbar's region.
   *
   * @param {Object} tb The toolbar.
   * @return {string} The name.
   */
  function regionLabel(tb) {
    return tb === mainToolbar
      ? __('Tool rail', 'editrail')
      : sprintf(
        /* translators: %s: the toolbar's name. */
        __('Tool rail: %s', 'editrail'),
        tb.name
      );
  }

  /**
   * Top and bottom docks lay the rail out as a horizontal bar.
   *
   * @param {Object} tb The toolbar.
   * @return {boolean} True for a left, right or floating toolbar.
   */
  function isVertical(tb) {
    return tb.position.dock !== 'top' && tb.position.dock !== 'bottom';
  }

  /**
   * The editor skeleton's body — the flex row holding the canvas and the
   * settings sidebar. Null before the editor chrome renders.
   *
   * @return {HTMLElement|null} The body element, or null.
   */
  function skeletonBody() {
    return document.querySelector('.interface-interface-skeleton__body');
  }

  /**
   * The editor skeleton's editor column, which stacks the body under the
   * header. Null before the editor chrome renders.
   *
   * @return {HTMLElement|null} The editor element, or null.
   */
  function skeletonEditor() {
    return document.querySelector('.interface-interface-skeleton__editor');
  }

  /**
   * The node a toolbar's region hangs in for its current dock. Returns
   * null when the editor chrome for that dock is not on the page yet —
   * mount() then retries.
   *
   * @param {Object} tb The toolbar.
   * @return {HTMLElement|null} The parent, or null.
   */
  function dockParent(tb) {
    var body = skeletonBody();
    var editor = skeletonEditor();
    switch (tb.position.dock) {
      case 'top':
        return editor && body && body.parentNode === editor ? editor : null;
      case 'bottom':
        return editor || null;
      default:
        return body || null;
    }
  }

  /**
   * Put every toolbar's region where its dock hangs, and move only the
   * regions that are not there, so mount() can run on every observer pass.
   *
   * The places are decided for ALL toolbars in one pass, not one toolbar
   * at a time (#95). Each of the right, bottom and floating docks wants
   * its region at the END of its parent. Two toolbars that each asked
   * "am I the last child?" would move each other on every pass, and each
   * move is a mutation that starts the next pass. So the order is fixed
   * here: the first toolbar keeps the place it always had, against the
   * editor's edge, and each later toolbar on the same edge sits between
   * the one before it and the canvas. The order in the document is then
   * the order on screen on every edge:
   *
   *   left   → the first children of __body, first toolbar first
   *   right  → the last children of __body, first toolbar last
   *   float  → at the end of __body, before the right-docked toolbars
   *   top    → directly before __body in __editor, first toolbar first
   *   bottom → the last children of __editor, first toolbar last
   *
   * A region that already has its place is not touched: moving a node
   * drops the focus inside it.
   *
   * @param {Object|null}      pendingTb   A toolbar whose region is built
   *                                       but not in the document yet.
   * @param {HTMLElement|null} pendingNode That region.
   * @return {Object[]} The toolbars whose region was inserted or moved.
   */
  function placeToolbarRegions(pendingTb, pendingNode) {
    var body = skeletonBody();
    var editor = skeletonEditor();
    var groups = { left: [], right: [], top: [], bottom: [], float: [] };
    var moved = [];
    T.toolbars.forEach(function (tb) {
      var node = tb === pendingTb ? pendingNode : document.getElementById(tb.regionId);
      if (node && dockParent(tb)) {
        groups[tb.position.dock].push({ tb: tb, node: node });
      }
    });

    // Each entry must sit directly in front of the one after it, and the
    // last one directly in front of `end` (null = the end of the parent).
    function settleBefore(parent, entries, end) {
      var before = end;
      for (var i = entries.length - 1; i >= 0; i--) {
        if (entries[i].node.parentNode !== parent || entries[i].node.nextSibling !== before) {
          parent.insertBefore(entries[i].node, before);
          moved.push(entries[i].tb);
        }
        before = entries[i].node;
      }
    }

    // The left dock counts from the START of the parent. A region that
    // is the first child is in its place; that is not a move.
    groups.left.forEach(function (entry, i) {
      if (body.childNodes[i] !== entry.node) {
        body.insertBefore(entry.node, body.childNodes[i] || null);
        moved.push(entry.tb);
      }
    });
    if (body) {
      settleBefore(body, groups.float.concat(groups.right.slice().reverse()), null);
    }
    if (editor) {
      settleBefore(editor, groups.top, body);
      settleBefore(editor, groups.bottom.slice().reverse(), null);
    }
    return moved;
  }

  // -------------------------------------------------------------------
  // Icons — inline SVG, currentColor, theme-agnostic (no dashicons dep).
  // -------------------------------------------------------------------

  var ICONS = {
    pattern: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4 4h7v7H4V4zm2 2v3h3V6H6zm7-2h7v7h-7V4zm2 2v3h3V6h-3zM4 13h7v7H4v-7zm2 2v3h3v-3H6zm9.5-2a3.5 3.5 0 110 7 3.5 3.5 0 010-7zm0 2a1.5 1.5 0 100 3 1.5 1.5 0 000-3z"/></svg>',
    select: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6 3l12 9.4-5.2.8 3 5.9-2.4 1.2-3-5.9-3.9 3.6z"/></svg>',
    text: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M5 5h14v3h-2V7h-4v10h2v2H9v-2h2V7H7v1H5z"/></svg>',
    heading: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6 4h2.5v7h7V4H18v16h-2.5v-7h-7v7H6z"/></svg>',
    image: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zm1 2v10h14V7H5zm3 2a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm-2 7l3.5-4 2.5 3 2-2.5L18 16H6z"/></svg>',
    shape: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 3a6 6 0 015.2 9H21v9h-9v-6.8A6 6 0 019 3zm5 11.7a6 6 0 01-2 .3v5h7v-5h-5zM9 5a4 4 0 100 8 4 4 0 000-8z"/></svg>',
    overview: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3 4h13v4H3V4zm0 6h13v4H3v-4zm0 6h13v4H3v-4zm17.5-12L23 7.5h-1.5V11h-2V7.5H18L20.5 4zM20.5 20L18 16.5h1.5V13h2v3.5H23L20.5 20z"/></svg>',
    pin: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 2.3L6 8.7v6.6l6 3.4 6-3.4V8.7l-6-3.4zM12 8l3.5 2v4L12 16l-3.5-2v-4L12 8z"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 9a3 3 0 110 6 3 3 0 010-6zm-1.7-6h3.4l.5 2.4c.6.2 1.1.5 1.6.9l2.3-.8 1.7 3-1.8 1.6a6.7 6.7 0 010 1.8l1.8 1.6-1.7 3-2.3-.8c-.5.4-1 .7-1.6.9l-.5 2.4h-3.4l-.5-2.4a6.6 6.6 0 01-1.6-.9l-2.3.8-1.7-3 1.8-1.6a6.7 6.7 0 010-1.8L4.2 8.5l1.7-3 2.3.8c.5-.4 1-.7 1.6-.9L10.3 3z"/></svg>',
    help: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 4a5 5 0 015 5c0 2.3-1.5 3.3-2.7 4.1-.9.7-1.3 1.1-1.3 2.2h-2c0-2 1-2.9 2-3.7 1.1-.8 2-1.4 2-2.6a3 3 0 00-6 0H7a5 5 0 015-5zm-1 13h2v2.5h-2z"/></svg>',
    sets: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 3l9 4.5-9 4.5-9-4.5L12 3zm0 2.2L7.5 7.5 12 9.8l4.5-2.3L12 5.2zM3 12l2.2-1.1L12 14.3l6.8-3.4L21 12l-9 4.5L3 12zm0 4.5l2.2-1.1 6.8 3.4 6.8-3.4 2.2 1.1-9 4.5-9-4.5z"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8.6 5.4L10 4l8 8-8 8-1.4-1.4L15.2 12z"/></svg>',
    toolbars: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4 4h6v16H4V4zm2 2v12h2V6H6zm8-2h6v16h-6V4zm2 2v12h2V6h-2z"/></svg>',
    add: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>'
  };

  // The pinned-icon React roots and the tools section's ResizeObserver
  // of one rail generation are the toolbar's own (iconRoots and
  // scrollObserver in newToolbar).

  /**
   * Unmount every React root from the previous rail generation. A
   * discarded root keeps its fiber tree alive, so leaving these behind
   * leaks one tree per rebuild — and the settings dialog rebuilds the rail
   * on each reorder click.
   *
   * @param {Object} tb The toolbar whose rail is being replaced.
   * @return {void}
   */
  function disposeIconRoots(tb) {
    tb.iconRoots.forEach(function (root) {
      try {
        root.unmount();
      } catch (e) {
        /* Already gone with its container — nothing to release. */
      }
    });
    tb.iconRoots = [];
  }

  /**
   * Paint a block type's icon into a span. Block icons come in three
   * shapes: a dashicon slug string, {src: slug}, or {src: ReactElement/
   * component} (inline-SVG block.json icons arrive as the last) — the
   * React shapes render through wp.element so a pinned third-party block
   * shows its real icon instead of a generic glyph.
   *
   * @param {Object}      tb   The toolbar the icon is built for; it owns
   *                           the React root.
   * @param {HTMLElement} span The icon span.
   * @param {*}           icon The block type's icon.
   * @return {void}
   */
  function renderBlockIcon(tb, span, icon) {
    var src = icon && typeof icon === 'object' && 'src' in icon ? icon.src : icon;
    if (typeof src === 'string' && src !== '') {
      span.className += ' dashicons dashicons-' + src;
      return;
    }
    if (src && wp.element && wp.element.createRoot) {
      try {
        var node = typeof src === 'function' ? wp.element.createElement(src) : src;
        var root = wp.element.createRoot(span);
        root.render(node);
        tb.iconRoots.push(root);
        return;
      } catch (e) {
        /* Fall through to the generic glyph. */
      }
    }
    span.innerHTML = ICONS.pin;
  }

  /**
   * Paint an author-chosen pin icon (see the Pin metadata block): a
   * Dashicon slug takes the same path a string block icon does; anything
   * else is a short text glyph, set through textContent so it can never
   * be markup. The span is aria-hidden by its caller either way — the
   * button's name is the label.
   */
  function renderCustomIcon(span, value) {
    if (T.isDashiconName(value)) {
      span.className += ' dashicons ' + value;
      return;
    }
    var glyph = document.createElement('span');
    glyph.className = 'toolrail-tool-glyph';
    glyph.textContent = value;
    span.appendChild(glyph);
  }

  // -------------------------------------------------------------------
  // Wide mode — icon + name rows on vertical docks and the floating
  // palette (left/right/float only; a label-per-tool row makes a
  // horizontal bar unusably long, so the toggle does not render there).
  // Purely visual: every aria-label already carries the name, so wide
  // mode changes nothing for assistive tech.
  // -------------------------------------------------------------------

  /**
   * Whether a toolbar shows tool names. One setting for each toolbar
   * (owner decision 2026-11-14, #95): the first toolbar's is the WIDE_KEY
   * preference it always was, an extra toolbar's is in its own record.
   *
   * @param {Object} tb The toolbar.
   * @return {boolean}
   */
  function isWide(tb) {
    return tb === mainToolbar ? readKey(WIDE_KEY) === '1' : tb.wide;
  }

  /**
   * Whether the on-rail expander chevron renders. OPT-IN (owner decision
   * 2026-08-27): a permanent button at the rail's head spends prime
   * toolbar space, so the chevron is off until the author asks for it in
   * Toolbar settings — where the "Show tool names" checkbox is the
   * canonical (and keyboard) path to wide mode either way, making the
   * chevron pure quick-access sugar, like the drag grip is for docking.
   *
   * ONE setting for all toolbars, where wide mode itself is one for each
   * (#95): this is a choice about the toolbars' chrome, not about one
   * toolbar's content, and a checkbox for each toolbar would be three
   * more controls for a shortcut.
   */
  function isWideToggleShown() {
    return readKey(WIDE_TOGGLE_KEY) === '1';
  }

  /**
   * Turn wide (labeled) mode on or off for one toolbar: persist it,
   * reflect it on the region, and re-clamp a floating palette, whose
   * width just changed.
   *
   * @param {Object}  tb The toolbar.
   * @param {boolean} on Whether tool names show.
   * @return {void}
   */
  function setWide(tb, on) {
    if (tb === mainToolbar) {
      writeKey(WIDE_KEY, on ? '1' : '0');
    } else {
      tb.wide = !!on;
      saveToolbars();
    }
    var region = document.getElementById(tb.regionId);
    if (region) {
      if (on) {
        region.dataset.wide = 'true';
      } else {
        delete region.dataset.wide;
      }
      // Both writers (the settings checkbox and the optional chevron)
      // route through here, so the chevron's pressed state is owned in
      // ONE place and can never disagree with the region.
      var toggle = region.querySelector('[data-tool="wide-toggle"]');
      if (toggle) {
        toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
    // The region's width just changed; a floating palette re-clamps so
    // widening it cannot push it off the editor.
    T.applyFloatPosition(tb);
  }

  // -------------------------------------------------------------------
  // Settings sidebar width (issue #28). A focusable separator on the
  // sidebar's inner edge changes the width of the editor's own settings
  // sidebar (the Post and Block tabs, and any plugin sidebar in the same
  // slot). The width is a per-user preference, like the rail position.
  // It is editor chrome only: nothing goes into the post.
  //
  // OPT-IN (owner decision 2026-10-08): the feature is off until the
  // author turns it on in Toolbar settings. It reaches into core's own
  // sidebar, not the toolbar, and the handle adds a Tab stop to the
  // sidebar. While it is off there is no handle and no override, even
  // with a stored width.
  //
  // Core's markup, checked against @wordpress/interface 5.28.6 (WP 6.5),
  // 9.x (WP 6.6-7.0) and 10.3.0, and in a WordPress 7.1.3 editor:
  //
  //   .interface-interface-skeleton__sidebar    region, overflow:hidden,
  //                                             position:relative >=782px
  //     .interface-complementary-area__fill     6.6+ only: a framer-motion
  //                                             div that animates width
  //       .interface-complementary-area         280px wide >=782px
  //
  // 6.5 and interface 10.x size the area from the stylesheet. 6.6-7.1
  // put an inline width:280px on the area AND hold the fill at an
  // animated inline 280px. So the stylesheet overrides the area with
  // !important, and overrides the fill a moment after the sidebar starts
  // to open (toolrail-sidebar-settled): a CSS transition then carries the
  // fill from wherever core's animation is to the custom width, so the
  // open reads as one movement. The fill must exist first, or the
  // transition has no start value. Interface 10.x animates the fill to
  // `auto`, so there it also follows the area. On close the fill goes to
  // 0 through the same transition (toolrail-sidebar-closing) instead of
  // jumping back to core's 280px first; the class comes off once core
  // has removed the fill.
  //
  // With the stored width at the default, nothing is overridden: the
  // sidebar is exactly core's. Below the 782px breakpoint core shows the
  // sidebar full screen, so the handle hides and nothing is overridden.
  // -------------------------------------------------------------------

  var SIDEBAR_DEFAULT_WIDTH = 280;
  var SIDEBAR_MAX_WIDTH = 640;
  // The sidebar never takes more than this share of the window, so the
  // canvas keeps room on a small screen.
  var SIDEBAR_MAX_SHARE = 0.5;
  var SIDEBAR_STEP = 10;
  var SIDEBAR_BIG_STEP = 50;
  var SIDEBAR_MEDIA = '(min-width: 782px)';
  // How long after the store opens the sidebar the fill override goes
  // on: long enough for core to render the fill (see above).
  var SIDEBAR_SETTLE_MS = 100;
  // Core removes the fill 300ms after a close (ANIMATION_DURATION in
  // complementary-area); the closing override stays a little longer.
  var SIDEBAR_CLOSE_MS = 400;

  var sidebarDrag = null;
  var sidebarDragFrame = null;
  var sidebarSettleTimer = null;
  var sidebarCloseTimer = null;
  var sidebarSynced = false;
  var sidebarLastSeen = '';

  /** Whether the author turned the feature on (off by default). */
  function isSidebarResizeOn() {
    return readKey(SIDEBAR_RESIZE_KEY) === '1';
  }

  /**
   * Turn the feature on or off. Off takes the handle and every override
   * away at once, so the sidebar is exactly core's.
   *
   * @param {boolean} on Whether the handle shows.
   * @return {void}
   */
  function setSidebarResize(on) {
    writeKey(SIDEBAR_RESIZE_KEY, on ? '1' : '0');
    syncSidebarWidth();
  }

  /** The widest the sidebar can be in this window. */
  function sidebarMaxWidth() {
    var share = Math.floor((window.innerWidth || 0) * SIDEBAR_MAX_SHARE);
    return Math.max(SIDEBAR_DEFAULT_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, share));
  }

  /**
   * @param {number} px A width in pixels.
   * @return {number} The width, rounded and held between the default
   *                  (the minimum) and sidebarMaxWidth().
   */
  function clampSidebarWidth(px) {
    var n = Math.round(px);
    if (!isFinite(n)) {
      n = SIDEBAR_DEFAULT_WIDTH;
    }
    return Math.min(sidebarMaxWidth(), Math.max(SIDEBAR_DEFAULT_WIDTH, n));
  }

  /** The stored width, before the window clamps it. */
  function storedSidebarWidth() {
    var n = parseInt(readKey(SIDEBAR_WIDTH_KEY), 10);
    return isFinite(n) ? n : SIDEBAR_DEFAULT_WIDTH;
  }

  /** The width to show now: a drag in progress, else the stored one. */
  function sidebarWidth() {
    return clampSidebarWidth(sidebarDrag ? sidebarDrag.width : storedSidebarWidth());
  }

  function sidebarRegion() {
    return document.querySelector('.interface-interface-skeleton__sidebar');
  }

  function sidebarHandle() {
    return document.getElementById('toolrail-sidebar-handle');
  }

  function sidebarViewportWide() {
    return window.matchMedia ? window.matchMedia(SIDEBAR_MEDIA).matches : true;
  }

  /**
   * Whether the store says a sidebar is open. 'core' is the scope on
   * WP 6.6+; 6.5 used 'core/edit-post'. Null when the store is missing,
   * so the caller falls back to the DOM alone.
   *
   * @return {boolean|null}
   */
  function sidebarStoreOpen() {
    try {
      var sel = wp.data.select('core/interface');
      if (!sel || typeof sel.getActiveComplementaryArea !== 'function') {
        return null;
      }
      return !!(sel.getActiveComplementaryArea('core') || sel.getActiveComplementaryArea('core/edit-post'));
    } catch (e) {
      return null;
    }
  }

  /**
   * Whether the sidebar is open at a width this feature applies to, by
   * the store alone — it changes before core renders. Falls back to the
   * DOM where the store is missing.
   */
  function sidebarOpening() {
    if (!sidebarViewportWide()) {
      return false;
    }
    var stored = sidebarStoreOpen();
    return stored === null ? sidebarOpen() : stored;
  }

  /**
   * Whether the sidebar is open and on the page, which is when the
   * handle shows. The store goes false the moment the author closes the
   * sidebar, while core's close animation still shows the area.
   */
  function sidebarOpen() {
    if (!sidebarViewportWide()) {
      return false;
    }
    var region = sidebarRegion();
    if (!region || !region.querySelector('.interface-complementary-area')) {
      return false;
    }
    return sidebarStoreOpen() !== false;
  }

  function sidebarIsRtl(region) {
    return window.getComputedStyle(region || document.documentElement).direction === 'rtl';
  }

  /** "400 pixels", or "280 pixels, default". */
  function sidebarWidthText(width) {
    return width === SIDEBAR_DEFAULT_WIDTH
      ? sprintf(
        /* translators: %d: the settings sidebar width in pixels. */
        __('%d pixels, default', 'editrail'),
        width
      )
      : sprintf(
        /* translators: %d: the settings sidebar width in pixels. */
        __('%d pixels', 'editrail'),
        width
      );
  }

  /**
   * Store a new width and apply it.
   *
   * @param {number}  width    Requested width in pixels; clamped.
   * @param {boolean} announce Whether to speak the result.
   * @return {number} The width applied.
   */
  function setSidebarWidth(width, announce) {
    var next = clampSidebarWidth(width);
    writeKey(SIDEBAR_WIDTH_KEY, String(next));
    syncSidebarWidth();
    if (announce) {
      speak(sprintf(
        /* translators: %s: the width, such as "400 pixels". */
        __('Settings sidebar width: %s.', 'editrail'),
        sidebarWidthText(next)
      ));
    }
    return next;
  }

  /**
   * Apply the width typed in Toolbar settings. Out-of-range values are
   * held to the range, and the field shows the width actually applied.
   * Text that is not a number puts the field back and says what to type.
   * Number() reads what the number field accepts (1e3 is 1000), and the
   * clamp rounds a fraction the way the other controls do. A value that
   * changes nothing writes nothing and says nothing, so the change event
   * that follows an Enter is silent.
   *
   * @param {HTMLInputElement} field The width field.
   * @return {void}
   */
  function applyTypedSidebarWidth(field) {
    var raw = field.value.trim();
    var typed = raw === '' ? NaN : Number(raw);
    if (!isFinite(typed)) {
      field.value = String(sidebarWidth());
      speak(__('Type a width in pixels.', 'editrail'));
      return;
    }
    var next = clampSidebarWidth(typed);
    field.value = String(next);
    if (next === sidebarWidth() && next === typed) {
      return;
    }
    setSidebarWidth(next, true);
  }

  /**
   * Bring the open dialog's width controls in line with the width, in
   * place (see buildSidebarWidthControl). A button at its limit is
   * aria-disabled, not disabled, the same as a dimmed rail tool: it stays
   * focusable and does nothing. A disabled button dropped focus to the
   * page when a Tab out of the field chose it as the next stop and the
   * field's change then disabled it. Text is written only when it
   * changes: each write is a childList mutation, and the body observer
   * runs this function again 100ms later, which looped while the dialog
   * was open. The field keeps what the author is typing while it has
   * focus.
   *
   * @param {number} width The width shown now.
   * @return {void}
   */
  function syncSidebarWidthControls(width) {
    var value = document.getElementById('toolrail-settings-sidebarwidth-value');
    if (!value) {
      return;
    }
    var text = sprintf(
      /* translators: %s: the width, such as "400 pixels". */
      __('Width: %s.', 'editrail'),
      sidebarWidthText(width)
    );
    if (value.textContent !== text) {
      value.textContent = text;
    }
    var max = sidebarMaxWidth();
    var field = document.getElementById('toolrail-settings-sidebarwidth-input');
    if (field) {
      field.max = String(max);
      if (document.activeElement !== field) {
        field.value = String(width);
      }
    }
    var narrower = document.getElementById('toolrail-settings-sidebarwidth-narrower');
    var wider = document.getElementById('toolrail-settings-sidebarwidth-wider');
    if (!narrower || !wider) {
      return;
    }
    setStepButtonInert(narrower, width <= SIDEBAR_DEFAULT_WIDTH);
    setStepButtonInert(wider, width >= max);
  }

  /**
   * @param {HTMLButtonElement} btn   Narrower or Wider.
   * @param {boolean}           inert True at the button's limit.
   * @return {void}
   */
  function setStepButtonInert(btn, inert) {
    if (inert) {
      btn.setAttribute('aria-disabled', 'true');
    } else {
      btn.removeAttribute('aria-disabled');
    }
  }

  /** Whether a Narrower or Wider button is at its limit. */
  function isStepButtonInert(btn) {
    return btn.getAttribute('aria-disabled') === 'true';
  }

  /**
   * Arrow keys move the separator the way they point (the APG window
   * splitter pattern): on a right-hand sidebar, Left makes it wider. Home
   * and End go to the minimum and the maximum. Shift takes bigger steps.
   */
  function onSidebarHandleKeydown(e) {
    if (e.key === 'Escape' && sidebarDrag) {
      e.preventDefault();
      e.stopPropagation();
      endSidebarDrag(false);
      return;
    }
    // The pointer owns the width until it lets go: a key here would store
    // and announce a width that the release then replaces.
    if (e.altKey || e.ctrlKey || e.metaKey || sidebarDrag) {
      return;
    }
    var current = sidebarWidth();
    var step = e.shiftKey ? SIDEBAR_BIG_STEP : SIDEBAR_STEP;
    var wider = sidebarIsRtl(sidebarRegion()) ? 'ArrowRight' : 'ArrowLeft';
    var next;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      next = current + (e.key === wider ? step : -step);
    } else if (e.key === 'Home') {
      next = SIDEBAR_DEFAULT_WIDTH;
    } else if (e.key === 'End') {
      next = sidebarMaxWidth();
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setSidebarWidth(next, true);
  }

  function onSidebarHandlePointerdown(e) {
    if (e.button !== 0 || sidebarDrag) {
      return;
    }
    var handle = e.currentTarget;
    e.preventDefault();
    // The canvas may hold focus here; without focus, Escape never reaches
    // the handle's keydown and cannot cancel the drag.
    focusFromEvent(handle, { preventScroll: true });
    sidebarDrag = {
      handle: handle,
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth: sidebarWidth(),
      width: sidebarWidth(),
      rtl: sidebarIsRtl(sidebarRegion())
    };
    try {
      handle.setPointerCapture(e.pointerId);
    } catch (err) {
      /* No capture — the move still works while the pointer stays over the handle. */
    }
    document.body.classList.add('toolrail-sidebar-resizing');
    handle.addEventListener('pointermove', onSidebarHandlePointermove);
    handle.addEventListener('pointerup', onSidebarHandlePointerup);
    handle.addEventListener('pointercancel', onSidebarHandlePointercancel);
    // On the document: a handle that leaves the DOM gets no event; the
    // browser fires lostpointercapture at the document instead.
    document.addEventListener('lostpointercapture', onSidebarLostCapture, true);
  }

  function onSidebarHandlePointermove(e) {
    if (!sidebarDrag || e.pointerId !== sidebarDrag.pointerId) {
      return;
    }
    var delta = sidebarDrag.rtl ? e.clientX - sidebarDrag.startX : sidebarDrag.startX - e.clientX;
    sidebarDrag.width = clampSidebarWidth(sidebarDrag.startWidth + delta);
    // One layout per frame: each width change reflows the canvas.
    if (sidebarDragFrame === null) {
      sidebarDragFrame = window.requestAnimationFrame(function () {
        sidebarDragFrame = null;
        syncSidebarWidth();
      });
    }
  }

  function onSidebarHandlePointerup(e) {
    if (sidebarDrag && e.pointerId === sidebarDrag.pointerId) {
      endSidebarDrag(true);
    }
  }

  function onSidebarHandlePointercancel(e) {
    if (sidebarDrag && e.pointerId === sidebarDrag.pointerId) {
      endSidebarDrag(false);
    }
  }

  /**
   * The handle lost the pointer before a pointerup reached it: core
   * re-rendered the sidebar region mid-drag (the distraction-free
   * shortcut does this) and detached the handle. Without this the drag
   * never ended: the resize cursor and user-select:none stayed on every
   * element, and the rebuilt handle refused new drags. After a normal
   * pointerup the drag is already over, so this does nothing.
   */
  function onSidebarLostCapture(e) {
    if (sidebarDrag && e.pointerId === sidebarDrag.pointerId) {
      endSidebarDrag(false);
    }
  }

  /**
   * @param {boolean} commit True stores the dragged width; false puts the
   *                         width back where the drag started (Escape, a
   *                         canceled pointer, or a handle that lost the
   *                         pointer mid-drag).
   */
  function endSidebarDrag(commit) {
    var drag = sidebarDrag;
    if (!drag) {
      return;
    }
    sidebarDrag = null;
    if (sidebarDragFrame !== null) {
      window.cancelAnimationFrame(sidebarDragFrame);
      sidebarDragFrame = null;
    }
    drag.handle.removeEventListener('pointermove', onSidebarHandlePointermove);
    drag.handle.removeEventListener('pointerup', onSidebarHandlePointerup);
    drag.handle.removeEventListener('pointercancel', onSidebarHandlePointercancel);
    document.removeEventListener('lostpointercapture', onSidebarLostCapture, true);
    try {
      drag.handle.releasePointerCapture(drag.pointerId);
    } catch (err) {
      /* Already released. */
    }
    document.body.classList.remove('toolrail-sidebar-resizing');
    // A click without a move (and each half of a double-click) writes
    // nothing.
    if (commit && drag.width !== drag.startWidth) {
      setSidebarWidth(drag.width, true);
    } else {
      syncSidebarWidth();
    }
  }

  function buildSidebarHandle() {
    var handle = document.createElement('div');
    handle.id = 'toolrail-sidebar-handle';
    handle.className = 'toolrail-sidebar-handle';
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', __('Settings sidebar width', 'editrail'));
    handle.setAttribute('aria-valuemin', String(SIDEBAR_DEFAULT_WIDTH));
    handle.tabIndex = 0;
    handle.addEventListener('keydown', onSidebarHandleKeydown);
    handle.addEventListener('pointerdown', onSidebarHandlePointerdown);
    handle.addEventListener('dblclick', function (e) {
      e.preventDefault();
      setSidebarWidth(SIDEBAR_DEFAULT_WIDTH, true);
    });
    return handle;
  }

  /**
   * Bring the page in line with the stored width and the sidebar's state:
   * the custom property and body classes the stylesheet reads, and the
   * handle — first in the sidebar region, so it is the first Tab stop in
   * the sidebar, between the canvas and the panel (APG window splitter).
   * Runs from the store subscription, the mutation observer and window
   * resizes; each run is cheap and idempotent.
   */
  function syncSidebarWidth() {
    var body = document.body;
    if (!body) {
      return;
    }
    var firstSync = !sidebarSynced;
    sidebarSynced = true;
    sidebarLastSeen = sidebarSignature();
    if (!isSidebarResizeOn()) {
      if (sidebarDrag) {
        endSidebarDrag(false);
      }
      window.clearTimeout(sidebarSettleTimer);
      window.clearTimeout(sidebarCloseTimer);
      sidebarSettleTimer = null;
      sidebarCloseTimer = null;
      body.classList.remove('toolrail-sidebar-sized', 'toolrail-sidebar-settled', 'toolrail-sidebar-closing');
      body.style.removeProperty('--toolrail-sidebar-width');
      var stale = sidebarHandle();
      if (stale) {
        stale.remove();
      }
      return;
    }
    var open = sidebarOpen();
    var opening = sidebarOpening();
    var width = sidebarWidth();

    body.style.setProperty('--toolrail-sidebar-width', width + 'px');
    body.classList.toggle('toolrail-sidebar-sized', width !== SIDEBAR_DEFAULT_WIDTH);
    syncSidebarWidthControls(width);

    if (opening) {
      if (body.classList.contains('toolrail-sidebar-closing')) {
        // Opened again before the close finished.
        window.clearTimeout(sidebarCloseTimer);
        sidebarCloseTimer = null;
        body.classList.remove('toolrail-sidebar-closing');
      }
      if (!body.classList.contains('toolrail-sidebar-settled') && sidebarSettleTimer === null) {
        if (firstSync) {
          // Open at page load: core does not animate the first render.
          body.classList.add('toolrail-sidebar-settled');
        } else {
          sidebarSettleTimer = window.setTimeout(function () {
            sidebarSettleTimer = null;
            if (sidebarOpening()) {
              document.body.classList.add('toolrail-sidebar-settled');
            }
          }, SIDEBAR_SETTLE_MS);
        }
      }
    } else {
      if (sidebarSettleTimer !== null) {
        window.clearTimeout(sidebarSettleTimer);
        sidebarSettleTimer = null;
      }
      if (body.classList.contains('toolrail-sidebar-settled')) {
        body.classList.remove('toolrail-sidebar-settled');
        body.classList.add('toolrail-sidebar-closing');
        sidebarCloseTimer = window.setTimeout(function () {
          sidebarCloseTimer = null;
          document.body.classList.remove('toolrail-sidebar-closing');
        }, SIDEBAR_CLOSE_MS);
      }
    }

    var region = sidebarRegion();
    var handle = sidebarHandle();
    if (!region) {
      return;
    }
    if (!handle) {
      handle = buildSidebarHandle();
    }
    if (handle.parentNode !== region || region.firstChild !== handle) {
      region.insertBefore(handle, region.firstChild);
    }
    if (handle.hidden === open) {
      handle.hidden = !open;
    }
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuemax', String(sidebarMaxWidth()));
    handle.setAttribute('aria-valuetext', sidebarWidthText(width));
    var area = region.querySelector('.interface-complementary-area[id]');
    if (area) {
      handle.setAttribute('aria-controls', area.id);
    } else {
      handle.removeAttribute('aria-controls');
    }
  }

  /** What the store subscription compares between runs. */
  function sidebarSignature() {
    return readKey(SIDEBAR_RESIZE_KEY) + '|' + sidebarStoreOpen() + '|' + storedSidebarWidth();
  }

  /**
   * The store subscription's cheap check: a full sync only when the open
   * state or the stored width moved. The mutation observer covers the
   * DOM side (the area mounting a moment after the store opens it).
   */
  function onSidebarStoreChange() {
    if (sidebarDrag) {
      return;
    }
    if (sidebarSignature() !== sidebarLastSeen) {
      syncSidebarWidth();
    }
  }

  // -------------------------------------------------------------------
  // Appearance — the rail's colors as custom-property tokens on the
  // region. The stylesheet's defaults ARE the Dark preset; Light and
  // Gray are complete hand-tuned sets, and Custom derives every token
  // from an author-chosen background + foreground pair by relative
  // luminance. Applied as inline properties on the region, which the
  // flyouts and both dialogs inherit (they are its children). The drag
  // snap-preview and the canvas-side armed cursor draw on the EDITOR,
  // not on the rail, and deliberately stay theme-blue.
  // -------------------------------------------------------------------

  var APPEARANCE_MODES = ['dark', 'light', 'gray', 'custom'];

  var APPEARANCE_LABELS = {
    dark: __('Dark (default)', 'editrail'),
    light: __('Light', 'editrail'),
    gray: __('Gray', 'editrail'),
    custom: __('Custom colors', 'editrail')
  };

  /** Every token applyAppearance() manages — must match the stylesheet's
      var(--toolrail-…) vocabulary. */
  var APPEARANCE_TOKENS = [
    'bg', 'fg', 'fg-strong', 'muted', 'faint', 'grip', 'hover', 'edge',
    'border', 'field-bg', 'field-border', 'field-hover', 'pressed',
    'pressed-fg', 'pressed-edge', 'status', 'focus-ring', 'dim'
  ];

  /**
   * Hand-tuned preset token sets, contrast-verified (measured with the
   * WCAG relative-luminance formula, 2026-08-26):
   *
   *   light: fg:bg 16.67, muted 7.0, faint 5.92 (all ≥4.5); grip 4.54,
   *          ring/pressed/pressed-edge 7.27 on bg (all ≥3);
   *          pressed-fg:pressed 7.27; field-border:field-bg 4.09;
   *          status 8.2.
   *   gray:  fg:bg 11.6, muted 6.91, faint 5.89; grip 4.46, ring/
   *          pressed/pressed-edge 6.91 on bg; pressed-fg:pressed 9.46;
   *          field-border:field-bg 5.03; status 6.91.
   *   dim (unavailable-tool icons, R9, measured 2026-08-29): light
   *          3.79, gray 3.34, dark 3.62 — all ≥3:1 so a dimmed icon
   *          reads as dimmed, never as gone. A COLOR, not opacity, so
   *          the ratio is a fact of the token rather than of whatever
   *          sits under the button.
   *
   * Dark is the stylesheet's defaults and ships unchanged.
   */
  var APPEARANCE_PRESETS = {
    light: {
      'bg': '#ffffff', 'fg': '#1e1e1e', 'fg-strong': '#000000',
      'muted': '#595959', 'faint': '#646464', 'grip': '#767676',
      'hover': '#eaeaea', 'edge': '#c6c6c6', 'border': '#c6c6c6',
      'field-bg': '#f3f3f3', 'field-border': '#767676', 'field-hover': '#e2e2e2',
      'pressed': '#2145d6', 'pressed-fg': '#ffffff', 'pressed-edge': '#2145d6',
      'status': '#1d3fc4', 'focus-ring': '#2145d6', 'dim': '#838383'
    },
    gray: {
      'bg': '#dcdcde', 'fg': '#1d2327', 'fg-strong': '#000000',
      'muted': '#3f474d', 'faint': '#4a5157', 'grip': '#5b636a',
      'hover': '#cbcbce', 'edge': '#8c8f94', 'border': '#8c8f94',
      'field-bg': '#e9e9ea', 'field-border': '#5b636a', 'field-hover': '#d0d0d3',
      'pressed': '#1d35b4', 'pressed-fg': '#ffffff', 'pressed-edge': '#1d35b4',
      'status': '#1d35b4', 'focus-ring': '#1d35b4', 'dim': '#737679'
    }
  };

  /**
   * Parse a 3- or 6-digit hex color. Returns null for anything else, which
   * is how every caller tests an author-supplied value for validity.
   *
   * @param {*} hex Candidate color string.
   * @return {Array<number>|null} [r, g, b] in 0-255, or null.
   */
  function hexToRgb(hex) {
    if (typeof hex !== 'string') {
      return null;
    }
    var m = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) {
      return null;
    }
    var h = m[1];
    if (h.length === 3) {
      h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    }
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16)
    ];
  }

  /**
   * Serialize an RGB triple back to a 6-digit hex string, rounding and
   * clamping each channel — the derived tokens come out of mixes and can
   * land fractionally or slightly outside the range.
   *
   * @param {Array<number>} rgb [r, g, b].
   * @return {string} A '#rrggbb' string.
   */
  function rgbToHex(rgb) {
    return '#' + rgb.map(function (v) {
      var s = Math.round(Math.min(255, Math.max(0, v))).toString(16);
      return s.length === 1 ? '0' + s : s;
    }).join('');
  }

  /**
   * Linear interpolation between two RGB triples.
   *
   * @param {Array<number>} a Start color.
   * @param {Array<number>} b End color.
   * @param {number}        t Position, 0 = a, 1 = b.
   * @return {Array<number>} The mixed triple, channels unrounded.
   */
  function mixRgb(a, b, t) {
    return [0, 1, 2].map(function (i) {
      return a[i] + (b[i] - a[i]) * t;
    });
  }

  /** WCAG relative luminance. */
  function relativeLuminance(rgb) {
    var channels = rgb.map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  /**
   * WCAG contrast ratio between two RGB triples, 1 to 21. Order-free.
   *
   * @param {Array<number>} a First color.
   * @param {Array<number>} b Second color.
   * @return {number} The ratio.
   */
  function contrastRatio(a, b) {
    var l1 = relativeLuminance(a);
    var l2 = relativeLuminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  /**
   * Focus ring / pressed-edge color for a background: the first brand
   * candidate that clears 3:1 on it, else black or white — one of which
   * ALWAYS clears 3:1 (black does above luminance 0.10, white below
   * 0.30; the 0.18 split sits inside the overlap), so state visibility
   * never depends on the author's pair.
   */
  function ringColorFor(bg) {
    var candidates = ['#7b90ff', '#2145d6'];
    for (var i = 0; i < candidates.length; i++) {
      if (contrastRatio(hexToRgb(candidates[i]), bg) >= 3) {
        return candidates[i];
      }
    }
    return relativeLuminance(bg) > 0.18 ? '#000000' : '#ffffff';
  }

  /**
   * Derive the full token set from an author's background + foreground
   * pair. Surfaces mix toward the foreground; text tones mix toward the
   * background but never below their contrast floor (falling back to
   * the foreground itself); pressed is foreground-weighted (an inverted
   * button, so its contrast equals the pair's own); the ring and
   * pressed-edge are always auto-derived to ≥3:1 regardless of the
   * pair.
   */
  function deriveAppearanceTokens(bgHex, fgHex) {
    var bg = hexToRgb(bgHex);
    var fg = hexToRgb(fgHex);
    if (!bg || !fg) {
      return null;
    }
    var toward = function (t) {
      return rgbToHex(mixRgb(bg, fg, t));
    };
    var textTone = function (t, floor) {
      var mixed = mixRgb(fg, bg, t);
      return contrastRatio(mixed, bg) >= floor ? rgbToHex(mixed) : rgbToHex(fg);
    };
    var dimTone = function () {
      for (var t = 0.7; t > 0.001; t -= 0.05) {
        var mixed = mixRgb(fg, bg, t);
        if (contrastRatio(mixed, bg) >= 3) {
          return rgbToHex(mixed);
        }
      }
      return rgbToHex(fg);
    };
    var ring = ringColorFor(bg);

    return {
      'bg': rgbToHex(bg),
      'fg': rgbToHex(fg),
      'fg-strong': rgbToHex(fg),
      'muted': textTone(0.25, 4.5),
      'faint': textTone(0.35, 4.5),
      'grip': textTone(0.5, 3),
      'hover': toward(0.1),
      'edge': toward(0.16),
      'border': toward(0.26),
      'field-bg': toward(0.06),
      'field-border': toward(0.45),
      'field-hover': toward(0.14),
      'pressed': rgbToHex(fg),
      'pressed-fg': rgbToHex(bg),
      'pressed-edge': ring,
      // Status text carries the "your colors fail contrast" warning, so
      // IT can never be allowed to fail: ring when it reads as text
      // (≥4.5), else the pair's own fg when that does — else black or
      // white, split at luminance 0.179, inside the narrow band
      // (0.175–0.183) where BOTH clear 4.5:1, so the floor is
      // guaranteed for any background. A plain fg fallback here
      // rendered the warning at ~1:1 on a dark hostile pair (review
      // 2026-08-26: bg luminance ≈0.021–0.071, where the light ring
      // candidate clears 3:1 but not 4.5).
      'status': contrastRatio(hexToRgb(ring), bg) >= 4.5 ? ring
        : contrastRatio(fg, bg) >= 4.5 ? rgbToHex(fg)
          : relativeLuminance(bg) > 0.179 ? '#000000' : '#ffffff',
      'focus-ring': ring,
      // Unavailable-tool icons and labels (R9): the DIMMEST mix toward
      // the background that still clears 3:1 on it. A fixed mix with a
      // floor collapsed to the live fg for most ordinary pairs (review
      // 2026-08-29: #ffffff/#555555 reads 7.46:1 in the dialog, yet a
      // 45% mix measured 2.55:1, failed the floor, and the dimmed state
      // had no visual expression at all). Searching from the far end
      // guarantees a dim strictly between fg and bg whenever fg itself
      // clears 3:1; only a pair the dialog already warns about (fg:bg
      // below ~3.3) falls back to fg.
      'dim': dimTone()
    };
  }

  /**
   * Read the stored appearance. The custom pair is kept even while a
   * preset is selected, so switching back to Custom restores the author's
   * own colors; an unknown mode or an unparseable color falls back to the
   * dark default.
   *
   * @return {{mode: string, bg: string, fg: string}} The appearance.
   */
  function loadAppearance() {
    var out = { mode: 'dark', bg: '#1e1e1e', fg: '#e0e0e0' };
    try {
      var raw = readKey(APPEARANCE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') {
        if (APPEARANCE_MODES.indexOf(parsed.mode) !== -1) {
          out.mode = parsed.mode;
        }
        // The pair is kept even while a preset is active, so switching
        // back to Custom restores the author's colors.
        if (hexToRgb(parsed.bg)) {
          out.bg = parsed.bg;
        }
        if (hexToRgb(parsed.fg)) {
          out.fg = parsed.fg;
        }
      }
    } catch (e) {
      /* Unparseable — the dark default is correct. */
    }
    return out;
  }

  /**
   * Persist the appearance mode and the custom color pair.
   *
   * @param {Object} appearance A loadAppearance()-shaped object.
   * @return {void}
   */
  function saveAppearance(appearance) {
    writeKey(APPEARANCE_KEY, JSON.stringify(appearance));
  }

  /**
   * The token set for an appearance: a hand-tuned preset, or the pair
   * derived from the author's colors. Returns null for dark — the
   * stylesheet's own defaults ARE dark, so applyAppearance() clears the
   * inline properties instead of restating them.
   *
   * @param {Object} appearance A loadAppearance()-shaped object.
   * @return {Object|null} Token name to color, or null to use the defaults.
   */
  function appearanceTokens(appearance) {
    if (Object.prototype.hasOwnProperty.call(APPEARANCE_PRESETS, appearance.mode)) {
      return APPEARANCE_PRESETS[appearance.mode];
    }
    if (appearance.mode === 'custom') {
      return deriveAppearanceTokens(appearance.bg, appearance.fg);
    }
    return null;
  }

  /**
   * Paint the stored appearance onto the region as inline custom
   * properties. Dark (or an unresolvable custom pair) clears them, which
   * hands every token back to the stylesheet defaults.
   *
   * @param {HTMLElement} [region] Defaults to every mounted region: the
   *                               appearance is one for all toolbars
   *                               (#95; colors for each toolbar are a
   *                               different issue).
   * @param {Object}      [tokens] Override token set — used by the color
   *                               inputs to preview a pair live without
   *                               persisting each intermediate value.
   */
  function applyAppearance(region, tokens) {
    if (!region) {
      T.toolbars.forEach(function (tb) {
        var own = document.getElementById(tb.regionId);
        if (own) {
          applyAppearance(own, tokens);
        }
      });
      return;
    }
    if (tokens === undefined) {
      tokens = appearanceTokens(loadAppearance());
    }
    APPEARANCE_TOKENS.forEach(function (name) {
      var prop = '--toolrail-' + name;
      if (tokens && tokens[name]) {
        region.style.setProperty(prop, tokens[name]);
      } else {
        region.style.removeProperty(prop);
      }
    });
  }

  // Shared with the other files of the rail (see the header of this file).
  T.__ = __;
  T._n = _n;
  T.sprintf = sprintf;
  T.speak = speak;
  T.focusFromEvent = focusFromEvent;
  T.SLOTS_KEY = SLOTS_KEY;
  T.CONFIGS_KEY = CONFIGS_KEY;
  T.MIGRATED_KEY = MIGRATED_KEY;
  T.HELP_HIDDEN_KEY = HELP_HIDDEN_KEY;
  T.GROUP_SEEDED_KEY = GROUP_SEEDED_KEY;
  T.HIDE_CORE_INSERTER_KEY = HIDE_CORE_INSERTER_KEY;
  T.WIDE_TOGGLE_KEY = WIDE_TOGGLE_KEY;
  T.PIN_META_KEY = PIN_META_KEY;
  T.SET_META_KEY = SET_META_KEY;
  T.SETS_BUTTON_HIDDEN_KEY = SETS_BUTTON_HIDDEN_KEY;
  T.SETS_TOOL_ID = SETS_TOOL_ID;
  T.TOOLBARS_BUTTON_HIDDEN_KEY = TOOLBARS_BUTTON_HIDDEN_KEY;
  T.TOOLBAR_LIST_TOOL_ID = TOOLBAR_LIST_TOOL_ID;
  T.ADD_TOOLS_TOOL_ID = ADD_TOOLS_TOOL_ID;
  T.MAX_TOOLBARS = MAX_TOOLBARS;
  T.SHAPE_FILL = SHAPE_FILL;
  T.prefsSelect = prefsSelect;
  T.readKey = readKey;
  T.writeKey = writeKey;
  T.prefsReadyPromise = prefsReadyPromise;
  T.markPrefsReady = markPrefsReady;
  T.migrateLocalToPrefs = migrateLocalToPrefs;
  T.DOCKS = DOCKS;
  T.SNAP_THRESHOLD = SNAP_THRESHOLD;
  T.RAIL_BAND = RAIL_BAND;
  T.DOCK_LABELS = DOCK_LABELS;
  T.loadPosition = loadPosition;
  T.mainToolbar = mainToolbar;
  T.TOOLBAR_NAME_MAX = TOOLBAR_NAME_MAX;
  T.savePosition = savePosition;
  T.toolbarById = toolbarById;
  T.toolbarLabel = toolbarLabel;
  T.saveToolbars = saveToolbars;
  T.announceToolbarsChange = announceToolbarsChange;
  T.disarmedMessage = disarmedMessage;
  T.joinMessages = joinMessages;
  T.syncToolbars = syncToolbars;
  T.addToolbar = addToolbar;
  T.renameToolbar = renameToolbar;
  T.deleteToolbar = deleteToolbar;
  T.setToolbarHidden = setToolbarHidden;
  T.canvasNarrowMessage = canvasNarrowMessage;
  T.regionLabel = regionLabel;
  T.isVertical = isVertical;
  T.skeletonBody = skeletonBody;
  T.dockParent = dockParent;
  T.placeToolbarRegions = placeToolbarRegions;
  T.ICONS = ICONS;
  T.disposeIconRoots = disposeIconRoots;
  T.renderBlockIcon = renderBlockIcon;
  T.renderCustomIcon = renderCustomIcon;
  T.isWide = isWide;
  T.isWideToggleShown = isWideToggleShown;
  T.setWide = setWide;
  T.SIDEBAR_DEFAULT_WIDTH = SIDEBAR_DEFAULT_WIDTH;
  T.SIDEBAR_MAX_WIDTH = SIDEBAR_MAX_WIDTH;
  T.SIDEBAR_BIG_STEP = SIDEBAR_BIG_STEP;
  T.isSidebarResizeOn = isSidebarResizeOn;
  T.setSidebarResize = setSidebarResize;
  T.sidebarMaxWidth = sidebarMaxWidth;
  T.sidebarWidth = sidebarWidth;
  T.sidebarWidthText = sidebarWidthText;
  T.setSidebarWidth = setSidebarWidth;
  T.applyTypedSidebarWidth = applyTypedSidebarWidth;
  T.setStepButtonInert = setStepButtonInert;
  T.isStepButtonInert = isStepButtonInert;
  T.syncSidebarWidth = syncSidebarWidth;
  T.onSidebarStoreChange = onSidebarStoreChange;
  T.APPEARANCE_MODES = APPEARANCE_MODES;
  T.APPEARANCE_LABELS = APPEARANCE_LABELS;
  T.hexToRgb = hexToRgb;
  T.contrastRatio = contrastRatio;
  T.deriveAppearanceTokens = deriveAppearanceTokens;
  T.loadAppearance = loadAppearance;
  T.saveAppearance = saveAppearance;
  T.applyAppearance = applyAppearance;

  // This file ran to its end. The next file checks this number.
  T.loaded = 1;
})(window.wp);
