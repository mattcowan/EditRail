/**
 * EditRail — a graphics-editor-style left toolbar for the block editor.
 *
 * Unlike a launcher rail, tools here ARM: selecting a tool means the next
 * click in the canvas inserts that tool's block at the click point, then the
 * rail returns to Select (Shift-click keeps the tool armed). Ctrl+Enter is
 * the keyboard form of that click (insertOnKey). Every insertion
 * produces ordinary core blocks — deactivating this plugin changes nothing
 * about how authored content renders or edits.
 *
 * CANVAS SELECTION (#14): with Select active, a rectangle dragged from
 * empty canvas space, Ctrl+click, Alt+click and Ctrl+Space select several
 * blocks. "Add to selection" / "Remove from selection" in the block
 * Options menu is the same toggle as Ctrl+Space, for an author whose
 * operating system takes that key. Neighbors at one level become the
 * WordPress selection; a set with a gap is kept by the rail for the
 * editor session, outlined, and given a bar of group actions that are
 * core's own. See the "Canvas selection" block for the rules. Nothing
 * about it is saved.
 *
 * MOUNT STRATEGY (proven in an early prototype): the rail is
 * inserted into the editor's own skeleton so it participates in the editor's
 * flex layout rather than overlapping the canvas; a debounced
 * MutationObserver re-mounts it across React re-renders (it survives the
 * code-editor round-trip, where the whole visual editor unmounts). Vanilla
 * DOM on purpose: the rail lives OUTSIDE the React tree it observes, so
 * React never reconciles it away.
 *
 * POSITION: the rail docks to the left edge by default, and can be moved to
 * the right edge (past the settings side panel), to a full-width bar at the
 * top or bottom, or torn off as a floating tool palette. Drag it
 * by the grip and release near an edge to snap; the settings dialog carries
 * the equivalent keyboard path. Surfaces open away from the docked edge — a
 * top rail opens its flyouts downward, a bottom rail upward. See the
 * "Rail position" block in editor-rail-core.js for where each dock hangs.
 *
 * MORE THAN ONE TOOLBAR (#95): the author can add up to three toolbars
 * to the first one, each with its own name, pins, position and wide mode,
 * and show or hide each. The first toolbar keeps #toolrail-region,
 * #toolrail-rail, the name "Tools", Select, the Section overview, the
 * provider tools, Help, Saved sets and Toolbar settings. An extra
 * toolbar is #toolrail-region-<id> / #toolrail-rail-<id>, its pins only.
 *   window.toolrail.getToolbars() → [{id, name, dock, x, y, hidden}],
 *     the first toolbar first, id 'main'.
 *   getDock(id) / getPosition(id) / setDock(dock, id), pinBlock(slot,
 *   id) / unpinBlock(slot, id) / isPinned(slot, id) / moveSlot(slot,
 *   delta, id), saveConfig(name, id) / loadConfig(name, id): the id is
 *   OPTIONAL and last. Without it each call means what it meant with one
 *   toolbar (the first toolbar), except that isPinned() and a pinBlock()
 *   refusal count a pin on any SHOWN toolbar, unpinBlock() unpins from
 *   every shown toolbar and moveSlot() acts on the first shown toolbar
 *   with the pin. A hidden toolbar's pins do not count and are kept.
 *   An unknown id: false, or null for a getter.
 *   'toolrail:position-changed' keeps its {dock, x, y}, always the FIRST
 *   toolbar's, and also fires when an extra toolbar is added, removed,
 *   moved, shown or hidden (each moves the canvas). Then
 *   'toolrail:toolbars-changed' fires with {toolbar: id, change}, change
 *   one of 'added', 'removed', 'renamed', 'position', 'shown', 'hidden',
 *   'synced' (the stored list changed from outside; toolbar is '').
 *
 * REGISTRATION API (the provider contract):
 *   window.toolrail.registerTool({
 *     id,                        // required, unique
 *     label,                     // accessible name (falls back to id)
 *     icon,                      // inline SVG markup string (optional)
 *     parent,                    // nest under an existing tool's flyout
 *     keywords,                  // reserved for future search
 *     insertBlock | createBlock | onActivate,
 *     isActive,                  // optional pressed-state callback
 *     supports: { canvas },      // optional; what the tool NEEDS (R9)
 *   })
 * Descriptors, not React nodes — the rail owns the roving tabindex.
 * Registry changes fire the 'toolrail:tools-updated' window event.
 *
 * PIN METADATA (1.0.1): window.toolrail.getPinMeta(slot) /
 * setPinMeta(slot, {title, description, icon}) read and write the
 * author's own name, description and icon for a pinned slot — the same
 * values the Edit form in Toolbar settings edits. See the "Pin metadata"
 * block for the rules (text only; icon = Dashicon slug or ≤3 characters).
 *   window.toolrail.getPinData(slot, namespace) / setPinData(slot,
 *   namespace, jsonValue|null) store an EXTENSION's own data on a pinned
 *   slot (namespace [a-z0-9-], plain JSON, ≤2KB serialized). It shares
 *   the entry's lifecycle — cleared on unpin, snapshotted into saved
 *   sets, carried in set files — and is opaque to the rail: pair it with
 *   registerTool({parent: 'pin:<slot>', …}) to give it meaning. Every
 *   entry change fires 'toolrail:pin-meta-changed' ({slot} in detail).
 *
 * AVAILABILITY (roadmap R9): a tool declares what it needs, never where
 * it is hidden. `supports.canvas: true` means "activation is completed
 * by a click in the canvas" — the default for insertBlock/createBlock
 * tools; onActivate-only tools default to false. The rail derives
 * availability from its MODE (see railMode): while a mode captures the
 * canvas (the Section overview), every canvas tool is dimmed with
 * aria-disabled — reachable, announced, inert — and every other tool
 * stays live. Mode changes fire the 'toolrail:mode-changed' window
 * event with {mode} in detail; window.toolrail.getMode() reads it.
 *
 * EXTENSION HOOKS (0.1.21, the first post-release patch on the roadmap's
 * "guides" phase — built for a rulers-and-guides provider plugin):
 *   window.toolrail.prefs.get(key) / .set(key, stringValue)
 *     Per-user preferences over the same readKey/writeKey pair the rail
 *     uses (core/preferences, scope 'toolrail', synced to the account),
 *     so an extension's state follows the author like the rail's own.
 *     Keys MUST start with 'toolrail-ext:' (then the extension's own
 *     prefix, e.g. 'toolrail-ext:guides:snap'); values are strings, null
 *     means never written. Folding an extension into this file later is
 *     a file move — its stored keys do not change.
 *   window.toolrail.prefs.ready / .isReady()
 *     A read before the account's preferences have ATTACHED sees null
 *     for a key the author has, and a write then can be lost — and an
 *     extension's script runs before this file's own boot(). So await
 *     `ready` (or listen for the 'toolrail:prefs-ready' window event)
 *     and re-read. Reading eagerly first is fine; just do not treat
 *     that first answer as final.
 *   window.toolrail.getCanvasGeometry()
 *     Where the canvas document is on screen, so an overlay drawn in the
 *     PARENT document (rulers, guides) can line up with it in every rail
 *     mode: { frameRect, scale, pan, scrollX, scrollY, mode }. A canvas
 *     document point maps to the parent viewport as
 *     frameRect.left + (x - scrollX) * scale (and the same for y).
 *   window.toolrail.refresh()
 *     Repaint the pressed state of every tool NOW. Apart from the rail's
 *     own actions (a press, a rebuild), the only repaint trigger is the
 *     wp.data subscription in start(), so a tool whose isActive() changes
 *     for a reason no store sees (a pick mode canceled with Escape, a
 *     sidebar section held in React state) stayed pressed until an
 *     unrelated keystroke ticked a store.
 *     Cheap to over-call: the signature guard bails when nothing moved.
 *
 * FILES (issue #102): the rail is seven scripts with no build step. They
 * load in this order, each one a dependency of the next
 * (includes/rail.php):
 *   editor-rail-core.js      storage, preferences and their readiness,
 *                            the position model, icons, wide mode, the
 *                            settings sidebar width, appearance
 *   editor-rail-registry.js  shape output, built-in tools, registerTool,
 *                            quick slots, pin metadata, the Saved sets
 *                            button, shared sets, the pattern catalog
 *   editor-rail-tools.js     armed-tool state, availability, canvas
 *                            insertion, canvas selection, flyouts
 *   editor-rail-settings.js  the Toolbar settings dialog and its Shared
 *                            sets list, set import and export, the Help
 *                            panel
 *   editor-rail-overview.js  the Section overview, drag to reorder,
 *                            marquee select
 *   editor-rail-dom.js       moving the rail, the DOM build, drag between
 *                            rail and canvas, the "Add to toolbar"
 *                            dialog, pressed-state painting, mounting
 *   editor-rail.js           this file: extension hooks, the public API,
 *                            "Pin to toolbar", boot
 * The files share names through window.toolrailInternal while they
 * load. It is PRIVATE and can change without notice; editor-rail-core.js
 * explains it. This file removes it from `window` at its end, when
 * every file has run: each file keeps its own reference, and no other
 * script can then read or change the rail's internals. This file's
 * handle, toolrail-editor-rail, is the one a provider depends on: it
 * runs after all the others, so window.toolrail exists when a
 * provider's script runs.
 */
(function (wp) {
  'use strict';

  // Run only when every file before this one ran to its end: T.loaded
  // is the number of the last file that did. When a file is missing or
  // stopped early, this file and the files after it stop too, and the
  // editor works with no rail, as it did when the rail was one file.
  var T = window.toolrailInternal;
  if (!T || T.loaded !== 6) {
    return;
  }

  // From editor-rail-core.js.
  var __ = T.__;
  var MIGRATED_KEY = T.MIGRATED_KEY;
  var GROUP_SEEDED_KEY = T.GROUP_SEEDED_KEY;
  var prefsSelect = T.prefsSelect;
  var readKey = T.readKey;
  var writeKey = T.writeKey;
  var prefsReadyPromise = T.prefsReadyPromise;
  var markPrefsReady = T.markPrefsReady;
  var migrateLocalToPrefs = T.migrateLocalToPrefs;
  var loadPosition = T.loadPosition;
  var mainToolbar = T.mainToolbar;
  var toolbarLabel = T.toolbarLabel;
  var syncToolbars = T.syncToolbars;

  // From editor-rail-registry.js.
  var warn = T.warn;
  var registerTool = T.registerTool;
  var migrateSlots = T.migrateSlots;
  var isPinnedOn = T.isPinnedOn;
  var isPinned = T.isPinned;
  var pinBlock = T.pinBlock;
  var unpinBlock = T.unpinBlock;
  var moveSlot = T.moveSlot;
  var apiToolbar = T.apiToolbar;
  var unpinEverywhere = T.unpinEverywhere;
  var getPinMeta = T.getPinMeta;
  var setPinMeta = T.setPinMeta;
  var getPinData = T.getPinData;
  var setPinData = T.setPinData;
  var loadConfigs = T.loadConfigs;
  var saveConfig = T.saveConfig;
  var loadConfig = T.loadConfig;
  var deleteConfig = T.deleteConfig;
  var reconcileSetsButton = T.reconcileSetsButton;
  var refreshSharedSets = T.refreshSharedSets;
  var allPatterns = T.allPatterns;
  var watchPatternCatalog = T.watchPatternCatalog;

  // From editor-rail-tools.js.
  var railMode = T.railMode;
  var setActiveTool = T.setActiveTool;
  var canvasDoc = T.canvasDoc;
  var csel = T.csel;
  var canvasSelectMenuAction = T.canvasSelectMenuAction;

  // From editor-rail-settings.js.
  var exportConfig = T.exportConfig;
  var importConfigPayload = T.importConfigPayload;

  // From editor-rail-overview.js.
  var contentRegion = T.contentRegion;
  var canvasFrame = T.canvasFrame;

  // From editor-rail-dom.js.
  var setDock = T.setDock;
  var canCreatePatterns = T.canCreatePatterns;
  var openAddToToolbar = T.openAddToToolbar;
  var syncPressed = T.syncPressed;
  var mount = T.mount;
  var start = T.start;

  // -------------------------------------------------------------------
  // Extension hooks (see the file header). Both are additive and read
  // only what the rail already tracks — nothing here changes rail state.
  // -------------------------------------------------------------------

  var EXT_PREFS_PREFIX = 'toolrail-ext:';

  /**
   * Validate an extension preference key. The prefix keeps an extension
   * out of the rail's own keys (a stray write to 'toolrail-quick-slots'
   * would empty the rail) and out of every OTHER extension's keys, and
   * it is what makes a later fold-in a file move: the key is already
   * the one the rail would use.
   *
   * @param {*} key
   * @return {string|null} The key, or null (with a console warning).
   */
  function extPrefKey(key) {
    if (typeof key !== 'string' || key.indexOf(EXT_PREFS_PREFIX) !== 0 || key.length === EXT_PREFS_PREFIX.length) {
      // Describe the value, never SERIALIZE it: this validator takes
      // arbitrary extension input, and JSON.stringify throws a
      // TypeError on a BigInt or a circular object — which would turn
      // a refusal that promises null into an exception thrown back at
      // the caller (MR review 2026-09-02).
      warn('prefs: key must be a string starting with "' + EXT_PREFS_PREFIX + '" — got '
        + (typeof key === 'string' ? '"' + key + '"' : typeof key) + '.');
      return null;
    }
    return key;
  }

  var extPrefs = {
    /**
     * Resolves once the account's stored preferences are attached and
     * trustworthy. Read eagerly if you like, then re-read when this
     * settles: BEFORE it, a key the author has saved can read null,
     * and a write can be lost when the persisted state lands. The
     * 'toolrail:prefs-ready' window event fires at the same moment,
     * for a consumer that would rather listen than await.
     *
     * null on a browser with no Promise — use the event there.
     *
     * @type {Promise<void>|null}
     */
    ready: prefsReadyPromise,
    /**
     * @return {boolean} Whether `ready` has already settled.
     */
    isReady: function () {
      return T.prefsReady;
    },
    /**
     * @param {string} key A 'toolrail-ext:…' key.
     * @return {string|null} The stored string; null = never written,
     *                       key refused, OR the preferences are not
     *                       ready yet (see `ready`).
     */
    get: function (key) {
      var k = extPrefKey(key);
      return k === null ? null : readKey(k);
    },
    /**
     * Strings only — JSON-encode structured data — because readKey
     * stringifies on the way back out, and a caller that stored a
     * number would read a string and not know why.
     *
     * @param {string} key   A 'toolrail-ext:…' key.
     * @param {string} value
     * @return {boolean} Whether the write was accepted.
     */
    set: function (key, value) {
      var k = extPrefKey(key);
      if (k === null) {
        return false;
      }
      if (typeof value !== 'string') {
        warn('prefs.set("' + k + '"): value must be a string (JSON-encode structured data) — got ' + typeof value + '.');
        return false;
      }
      writeKey(k, value);
      return true;
    }
  };

  /**
   * The canvas document's on-screen geometry, in parent-viewport px.
   *
   * frameRect is the iframe ELEMENT's transformed box, so it already
   * carries the Section overview's scale and pan translate; scale is
   * the same ratio overviewBlockViewportRect() uses (on-screen width
   * over layout width — 1 outside the overview). scrollX/scrollY are the
   * canvas document's own scroll, which the parent cannot otherwise see.
   * Non-iframed editors (a page with a pre-v3 block) fall back to the
   * content region at scale 1.
   *
   * @return {Object|null} { frameRect: {left, top, width, height},
   *                         scale, pan, scrollX, scrollY, mode } or null
   *                         when there is no canvas to measure.
   */
  function getCanvasGeometry() {
    var frame = canvasFrame();
    var doc = canvasDoc();
    var rect;
    var scale = 1;
    var scrollX = 0;
    var scrollY = 0;
    if (frame) {
      var f = frame.getBoundingClientRect();
      rect = { left: f.left, top: f.top, width: f.width, height: f.height };
      scale = frame.offsetWidth ? f.width / frame.offsetWidth : 1;
      var win = doc ? doc.defaultView : null;
      if (win) {
        scrollX = win.scrollX || win.pageXOffset || 0;
        scrollY = win.scrollY || win.pageYOffset || 0;
      }
    } else {
      var content = contentRegion();
      if (!content) {
        return null;
      }
      var c = content.getBoundingClientRect();
      rect = { left: c.left, top: c.top, width: c.width, height: c.height };
      scrollX = content.scrollLeft || 0;
      scrollY = content.scrollTop || 0;
    }
    return {
      frameRect: rect,
      scale: scale,
      pan: T.overviewOpen ? T.ov.pan : 0,
      scrollX: scrollX,
      scrollY: scrollY,
      mode: railMode()
    };
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  // The pin, set and position calls take an OPTIONAL toolbar id as their
  // last argument (#95). Without one they mean what they meant with one
  // toolbar: the first toolbar, except where a pin on any SHOWN toolbar
  // must count (isPinned, a pin of a block that is already pinned, unpin,
  // move). A hidden toolbar's pins do not count without an id (owner
  // decision 2026-11-16, D4); with its id, every call acts on it. An id
  // that names no toolbar is refused: false, or null for a getter.
  window.toolrail = {
    registerTool: registerTool,
    /**
     * @param {string} blockName Block type or pattern slot name.
     * @param {string} [id]      A toolbar id; the first toolbar without.
     * @return {boolean} True when the toolbar changed. Without an id,
     *                   false when any SHOWN toolbar already has the pin,
     *                   the same rule as the block menu's item.
     */
    pinBlock: function (blockName, id) {
      var tb = apiToolbar(id);
      if (!tb || ((id === undefined || id === null) && isPinned(blockName))) {
        return false;
      }
      return pinBlock(tb, blockName);
    },
    /**
     * @param {string} blockName Block type or pattern slot name.
     * @param {string} [id]      A toolbar id; every SHOWN toolbar
     *                           without (a hidden one keeps its pin).
     * @return {boolean} True when a toolbar changed.
     */
    unpinBlock: function (blockName, id) {
      if (id === undefined || id === null) {
        return unpinEverywhere(blockName);
      }
      var tb = apiToolbar(id);
      return tb ? unpinBlock(tb, blockName) : false;
    },
    getPatterns: allPatterns,
    openAddToToolbar: openAddToToolbar,
    /**
     * @param {string} blockName Block type or pattern slot name.
     * @param {string} [id]      A toolbar id; any SHOWN toolbar without.
     * @return {boolean}
     */
    isPinned: function (blockName, id) {
      if (id === undefined || id === null) {
        return isPinned(blockName);
      }
      var tb = apiToolbar(id);
      return tb ? isPinnedOn(tb, blockName) : false;
    },
    /**
     * @param {string} blockName Block type or pattern slot name.
     * @param {number} delta     -1 or 1.
     * @param {string} [id]      A toolbar id; without one, the first
     *                           SHOWN toolbar that has the pin.
     * @return {boolean} True when the slot moved.
     */
    moveSlot: function (blockName, delta, id) {
      var tb = apiToolbar(id);
      if (id === undefined || id === null) {
        tb = T.toolbars.filter(function (other) {
          return !other.hidden && isPinnedOn(other, blockName);
        })[0] || mainToolbar;
      }
      return tb ? moveSlot(tb, blockName, delta) : false;
    },
    getPinMeta: getPinMeta,
    setPinMeta: setPinMeta,
    getPinData: getPinData,
    setPinData: setPinData,
    /**
     * @param {string} name  Set name.
     * @param {string} [id]  The toolbar whose pins are saved; the first
     *                       toolbar without.
     * @return {boolean} True when saved.
     */
    saveConfig: function (name, id) {
      var tb = apiToolbar(id);
      return tb ? saveConfig(name, tb) : false;
    },
    /**
     * @param {string} name  Set name.
     * @param {string} [id]  The toolbar the set loads into; the first
     *                       toolbar without.
     * @return {boolean} True when the set existed and was applied.
     */
    loadConfig: function (name, id) {
      var tb = apiToolbar(id);
      return tb ? loadConfig(name, tb) : false;
    },
    deleteConfig: deleteConfig,
    getConfigs: loadConfigs,
    exportConfig: exportConfig,
    importConfig: importConfigPayload,
    /**
     * Repaint pressed state, availability and tooltips now.
     *
     * The rail repaints after its own actions (a press, a rebuild, a
     * re-mount). For every other change, the only trigger is the
     * wp.data subscription in start(). That covers every tool whose
     * isActive() reads the editor's stores, and misses every tool whose
     * active state changes for a reason no store sees: a pick mode
     * canceled with Escape, a sidebar section switched in React state,
     * a modal that closed. Those tools stayed pressed until some
     * unrelated keystroke ticked a store (QA 2026-09-11, E1 and E2).
     *
     * Call this straight after the state your isActive() reads has
     * changed. It is cheap to over-call: pressedSignature() is built
     * first and the paint bails when nothing moved, which is the same
     * guard the store subscription leans on every keystroke.
     *
     * @return {void}
     */
    refresh: function () { syncPressed(); },
    getActiveTool: function () { return T.activeTool; },
    setActiveTool: setActiveTool,
    getMode: railMode,
    prefs: extPrefs,
    getCanvasGeometry: getCanvasGeometry,
    getDock: function (id) {
      var tb = apiToolbar(id);
      return tb ? tb.position.dock : null;
    },
    setDock: function (dock, id) {
      var tb = apiToolbar(id);
      return tb ? setDock(tb, dock) : false;
    },
    getPosition: function (id) {
      var tb = apiToolbar(id);
      if (!tb) {
        return null;
      }
      var position = tb.position;
      return { dock: position.dock, x: position.x, y: position.y };
    },
    /**
     * Every toolbar, the first one first (id 'main'), in the order of
     * the Tab order and of a shared edge (#95). A copy: changing it
     * changes nothing.
     *
     * @return {Object[]} {id, name, dock, x, y, hidden} each.
     */
    getToolbars: function () {
      return T.toolbars.map(function (tb) {
        return {
          id: tb.id,
          name: toolbarLabel(tb),
          dock: tb.position.dock,
          x: tb.position.x,
          y: tb.position.y,
          hidden: tb.hidden
        };
      });
    }
  };

  // -------------------------------------------------------------------
  // "Pin to toolbar" — the keyboard path for quick slots, as a block
  // settings menu item. This is the one React island; the rail itself
  // stays vanilla DOM.
  // -------------------------------------------------------------------

  function registerPinMenuItem() {
    if (!(wp.plugins && wp.plugins.registerPlugin && wp.blockEditor
      && wp.blockEditor.BlockSettingsMenuControls && wp.element && wp.components)) {
      return;
    }
    var el = wp.element.createElement;

    wp.plugins.registerPlugin('toolrail-pin', {
      render: function () {
        // The data registry, for canvas selection's one-undo-step moves
        // (runCanvasSelectBatch). wp.data exports no batch(); a rendered
        // component is the public way to reach the registry. Called on
        // every render or on none, so the hook order never changes.
        if (typeof wp.data.useRegistry === 'function') {
          csel.registry = wp.data.useRegistry();
        }
        return el(wp.blockEditor.BlockSettingsMenuControls, null, function (fillProps) {
          var clientIds = (fillProps && fillProps.selectedClientIds) || [];
          if (!clientIds.length) {
            return null;
          }
          var close = function () {
            if (fillProps && fillProps.onClose) {
              fillProps.onClose();
            }
          };
          var items = [];
          var name = clientIds.length === 1
            ? wp.data.select('core/block-editor').getBlockName(clientIds[0])
            : '';
          if (name) {
            var pinned = isPinned(name);
            items.push(el(wp.components.MenuItem, {
              key: 'toolrail-pin',
              onClick: function () {
                // Pin to the first toolbar; unpin from every toolbar,
                // because the item says "Unpin" when ANY toolbar shows
                // the block (owner decision 2026-11-14, #95).
                if (pinned) {
                  unpinEverywhere(name);
                } else {
                  pinBlock(mainToolbar, name);
                }
                close();
              }
            }, pinned ? __('Unpin from toolbar', 'editrail') : __('Pin to toolbar', 'editrail')));
          }
          // The keyboard path to the add-to-toolbar dialog (the pointer
          // path is dropping the block on the rail). One block or
          // several: a multi-block selection saves as one pattern. The
          // menu closes first so its own focus return settles before
          // the dialog takes focus.
          if (canCreatePatterns() !== false) {
            var ids = clientIds.slice();
            items.push(el(wp.components.MenuItem, {
              key: 'toolrail-pattern',
              onClick: function () {
                close();
                window.setTimeout(function () {
                  openAddToToolbar(ids);
                }, 0);
              }
            }, __('Save as pattern and pin to toolbar…', 'editrail')));
          }
          // Canvas selection's toggle, for an author whose operating
          // system takes Ctrl+Space (canvasSelectMenuAction). Last, so the
          // pin items keep their places. The toggle runs before the menu
          // closes: core's focus return then finds the kept set already
          // made, and the one announcement is the toggle's own.
          var cselAction = canvasSelectMenuAction(clientIds);
          if (cselAction) {
            items.push(el(wp.components.MenuItem, {
              key: 'toolrail-csel',
              onClick: function () {
                cselAction.run();
                close();
              }
            }, cselAction.remove ? __('Remove from selection', 'editrail') : __('Add to selection', 'editrail')));
          }
          return items.length ? el(wp.element.Fragment, null, items) : null;
        });
      }
    });
  }

  /**
   * Self-heals the boot-order race between boot()'s migration writes and
   * the editor's own async attach of the preferences persistence layer.
   *
   * `wp-preferences` being a script dependency only guarantees the
   * `core/preferences` store is REGISTERED, and that core's attach
   * (SET_PERSISTENCE_LAYER) has been dispatched, before this file runs —
   * not that it has RESOLVED. That dispatch is an async thunk which, for
   * an author with no saved preferences yet (no user-meta, no matching
   * localStorage), awaits a real REST fetch before resolving. If that
   * resolution lands after boot()'s migration has already written into
   * the pre-attach state, core's reducer replaces the WHOLE
   * `core/preferences` state wholesale — silently wiping those writes.
   *
   * SET_PERSISTENCE_LAYER is the only action that can make an
   * already-set stamp read back as unset, and WordPress dispatches it at
   * most once per page load. So rather than guess at timing, watch for
   * exactly that: a dispatch against `core/preferences` that leaves
   * EITHER of migrateSlots()'s stamps missing means a wipe happened —
   * or, for an account stamped under 0.1.21, that its real Group-less
   * state has just replaced boot()'s pre-attach writes (which had
   * stamped Group against an empty store). A watcher keyed on the first
   * stamp alone stood down there, and the Group lift never reached that
   * account (review 2026-09-02, finding 1). Redo the migration
   * (idempotent, and this time nothing is racing it) and repaint.
   *
   * The watcher stays subscribed for the whole page load. It used to stop
   * once both stamps had survived a dispatch, on the idea that nothing
   * could wipe them after that. That was wrong: on a fresh account, other
   * core/preferences dispatches come BEFORE core's attach resolves (it
   * awaits a REST fetch), so the stamps survived those, the watcher
   * stopped, and the attach then wiped them unseen. The rail kept showing
   * its default pins over an empty store, and the author's first pin
   * change in that session replaced the defaults for good (measured on
   * wp-env, 2026-10-15). Staying subscribed costs two reads per
   * core/preferences dispatch.
   */
  function liftsComplete() {
    return readKey(MIGRATED_KEY) !== null && readKey(GROUP_SEEDED_KEY) !== null;
  }

  /**
   * Watch for the preferences persistence layer's late attach and repair
   * what it wiped: re-run both migrations, re-read the position, and
   * re-mount. See the note above for why a dispatch that leaves either
   * stamp missing is the reliable signal, and why the watcher never
   * unsubscribes. Settles the readiness contract the first time the
   * stamps read back, and signals it again after each repair (a "re-read
   * me" for extensions) — never on an ordinary dispatch. The
   * localStorage-fallback browser has nothing to wait for and is settled
   * at once, so an extension awaiting `ready` is never left hanging.
   */
  function watchPersistenceAttach() {
    if (!wp.data || typeof wp.data.subscribe !== 'function' || !prefsSelect()) {
      // Nothing to wait for — this browser is on the localStorage
      // fallback, where a read is immediately truthful. Signal ready so
      // an extension awaiting it is never left hanging.
      markPrefsReady();
      return;
    }

    var repairing = false;

    wp.data.subscribe(function () {
      if (repairing) {
        return;
      }
      if (liftsComplete()) {
        if (!T.prefsReady) {
          markPrefsReady();
        }
        // An attach that keeps both stamps needs no repair, but it can
        // still replace the saved sets under the rail (PR #97 review),
        // and the extra toolbars (#95). syncToolbars() costs one read and
        // one compare when the toolbars did not change.
        repairing = true;
        try {
          reconcileSetsButton();
          syncToolbars();
        } finally {
          repairing = false;
        }
        return;
      }
      repairing = true;
      try {
        migrateLocalToPrefs();
        migrateSlots();
        var restored = loadPosition();
        mainToolbar.position.dock = restored.dock;
        mainToolbar.position.x = restored.x;
        mainToolbar.position.y = restored.y;
        var existingRegion = document.getElementById(mainToolbar.regionId);
        if (existingRegion) {
          existingRegion.remove();
        }
        mount(mainToolbar);
        // The attach also brings the extra toolbars the account has.
        syncToolbars();
      } finally {
        repairing = false;
      }
      // A repair is a "re-read me" for extensions: signal it every time.
      if (liftsComplete()) {
        markPrefsReady();
      }
    }, 'core/preferences');

    // Evaluate readiness ONCE up front as well. wp.data.subscribe only
    // fires on CHANGES, so when the marker already reads back there may
    // never be another change — and a consumer awaiting `ready` would
    // hang forever (measured 2026-09-02: marker "1", isReady false, the
    // Promise never settling). The subscription stays live so a later
    // attach that wipes the marker is still repaired, and that repair
    // re-fires the event for anyone listening.
    if (liftsComplete()) {
      markPrefsReady();
    }
  }

  // -------------------------------------------------------------------
  // Boot. _wpLoadBlockEditor resolves when the editor has actually
  // initialized (more precise than domReady — the Phase 0 spike used it);
  // domReady stays as the fallback for editors without it.
  // -------------------------------------------------------------------

  function boot() {
    // Storage order is load-bearing: lift any old localStorage state into
    // the account preferences FIRST, then read position and run the slot
    // migration against the lifted state.
    migrateLocalToPrefs();
    mainToolbar.position = loadPosition();
    migrateSlots();
    // The extra toolbars (#95). With none stored this changes nothing and
    // builds nothing; start() mounts whatever it read.
    syncToolbars();
    // These writes can still lose a race with the preferences store's
    // own async attach — watchPersistenceAttach() catches and repairs
    // that if it happens.
    watchPersistenceAttach();
    registerPinMenuItem();
    start();
    watchPatternCatalog();
    // The shared sets (#98), once per page. Not awaited: the rail is up
    // without them, and a failed request leaves it as it is.
    refreshSharedSets();
  }

  if (window._wpLoadBlockEditor && typeof window._wpLoadBlockEditor.then === 'function') {
    window._wpLoadBlockEditor.then(boot);
  } else if (wp.domReady) {
    wp.domReady(boot);
  } else if (document.readyState !== 'loading') {
    boot();
  } else {
    document.addEventListener('DOMContentLoaded', boot);
  }
  // Shared with the other files of the rail (see editor-rail-core.js).
  T.getCanvasGeometry = getCanvasGeometry;

  // Every file has run, and each keeps its own T. Take the namespace
  // off `window`: the rail was one closed file before #102, and no
  // other script should read or change its internals. An extension
  // uses window.toolrail.
  delete window.toolrailInternal;
})(window.wp);
