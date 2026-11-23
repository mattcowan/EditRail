/**
 * EditRail, part 2 of 7 (editor-rail-registry.js).
 *
 * The tool registry: shape output, the built-in tools, registerTool,
 * the quick slots, pin metadata, the Saved sets button, shared sets
 * and the pattern catalog.
 *
 * The public contract (window.toolrail) and the long API documentation
 * are in the header of assets/editor-rail.js, the last of the rail's
 * files. includes/rail.php registers the files in their load order.
 *
 * The block after the guard below lists what this file uses from the
 * files before it. `T.name` in the code is a function from a LATER
 * file (read when it is called, never at load time), or state that
 * more than one file changes. editor-rail-core.js explains T.
 */
(function (wp) {
  'use strict';

  // Run only when every file before this one ran to its end: T.loaded
  // is the number of the last file that did. When a file is missing or
  // stopped early, this file and the files after it stop too, and the
  // editor works with no rail, as it did when the rail was one file.
  var T = window.toolrailInternal;
  if (!T || T.loaded !== 1) {
    return;
  }

  // From editor-rail-core.js.
  var __ = T.__;
  var _n = T._n;
  var sprintf = T.sprintf;
  var speak = T.speak;
  var SLOTS_KEY = T.SLOTS_KEY;
  var CONFIGS_KEY = T.CONFIGS_KEY;
  var MIGRATED_KEY = T.MIGRATED_KEY;
  var GROUP_SEEDED_KEY = T.GROUP_SEEDED_KEY;
  var PIN_META_KEY = T.PIN_META_KEY;
  var SET_META_KEY = T.SET_META_KEY;
  var SETS_BUTTON_HIDDEN_KEY = T.SETS_BUTTON_HIDDEN_KEY;
  var SETS_TOOL_ID = T.SETS_TOOL_ID;
  var TOOLBARS_BUTTON_HIDDEN_KEY = T.TOOLBARS_BUTTON_HIDDEN_KEY;
  var TOOLBAR_LIST_TOOL_ID = T.TOOLBAR_LIST_TOOL_ID;
  var ADD_TOOLS_TOOL_ID = T.ADD_TOOLS_TOOL_ID;
  var SHAPE_FILL = T.SHAPE_FILL;
  var readKey = T.readKey;
  var writeKey = T.writeKey;
  var mainToolbar = T.mainToolbar;
  var toolbarById = T.toolbarById;
  var toolbarLabel = T.toolbarLabel;
  var saveToolbars = T.saveToolbars;
  var disarmedMessage = T.disarmedMessage;
  var joinMessages = T.joinMessages;
  var setToolbarHidden = T.setToolbarHidden;
  var canvasNarrowMessage = T.canvasNarrowMessage;
  var ICONS = T.ICONS;

  // -------------------------------------------------------------------
  // Shape output — PURE core serialization (the Phase 2 guardrail:
  // deactivating the plugin must change nothing about rendering).
  // Curved/angled contours are aria-hidden inline SVG in a core/html
  // block; the rounded rectangle is a core Group (it can hold content and
  // is ready for the Phase 4 image-fill work). The Spike-D clip-path
  // primitive with plugin attributes is deliberately Phase 4.
  // -------------------------------------------------------------------

  function shapeSvgBlock(inner) {
    return wp.blocks.createBlock('core/html', {
      content: '<svg viewBox="0 0 200 200" width="200" height="200" aria-hidden="true" focusable="false">' + inner + '</svg>'
    });
  }

  var SHAPES = [
    {
      id: 'shape-circle',
      label: __('Circle', 'editrail'),
      icon: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="currentColor"/></svg>',
      createBlock: function () {
        return shapeSvgBlock('<circle cx="100" cy="100" r="96" fill="' + SHAPE_FILL + '"/>');
      }
    },
    {
      id: 'shape-rounded-rect',
      label: __('Rounded rectangle', 'editrail'),
      icon: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><rect x="3" y="6" width="18" height="12" rx="4" fill="currentColor"/></svg>',
      createBlock: function () {
        return wp.blocks.createBlock('core/group', {
          layout: { type: 'constrained' },
          style: {
            border: { radius: '24px' },
            color: { background: SHAPE_FILL },
            dimensions: { minHeight: '160px' },
            spacing: { padding: { top: '24px', bottom: '24px', left: '24px', right: '24px' } }
          }
        }, [wp.blocks.createBlock('core/paragraph')]);
      }
    },
    {
      id: 'shape-hexagon',
      label: __('Hexagon', 'editrail'),
      icon: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2l8.7 5v10L12 22l-8.7-5V7z"/></svg>',
      createBlock: function () {
        return shapeSvgBlock('<polygon points="100,4 183,52 183,148 100,196 17,148 17,52" fill="' + SHAPE_FILL + '"/>');
      }
    },
    {
      id: 'shape-star',
      label: __('Star', 'editrail'),
      icon: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg>',
      createBlock: function () {
        return shapeSvgBlock('<polygon points="100,6 129,65 194,74 147,120 158,185 100,154 42,185 53,120 6,74 71,65" fill="' + SHAPE_FILL + '"/>');
      }
    }
  ];

  // -------------------------------------------------------------------
  // Built-in tools. `insertBlock`/`createBlock` tools ARM; `children`
  // renders a flyout. Registered tools are merged in by railModel().
  // -------------------------------------------------------------------

  // Group, Text, Heading and Image are NOT built-ins — they ship as
  // DEFAULT_SLOTS (see loadSlots), so authors can reorder, remove and
  // re-pin them like any other block. Built-ins are only the tools no
  // block type expresses: Select, the Shape flyout, and Section overview.
  // (Section was a built-in until 0.1.22; it is the pinned Group now —
  // owner decision 2026-09-02.)
  var BUILTIN_TOOLS = [
    {
      id: 'select',
      label: __('Select', 'editrail'),
      icon: ICONS.select,
      select: true
    },
    {
      id: 'shape',
      label: __('Shape', 'editrail'),
      icon: ICONS.shape,
      children: SHAPES,
      // SHELVED with Phase 4 (owner decision 2026-08-27): shapes wait
      // until after the .org submission, so the tool does not render.
      // The entry STAYS in BUILTIN_TOOLS so allToolIds keeps 'shape'
      // and the shape-* child ids reserved — a provider must not be
      // able to squat on them before Phase 4 reclaims them. Flip this
      // flag to bring the tool back.
      shelved: true
    },
    {
      id: 'overview',
      label: __('Section overview', 'editrail'),
      // No how-to hint: a screen reader reads `title` as the description,
      // so the hint was heard on every stop (SR-1, QA 2026-09-11). The
      // help panel carries the how-to.
      icon: ICONS.overview,
      // A toggle, not an arming tool: reordering is an ordinary editing
      // action, so the deactivation promise is untouched (roadmap R6).
      onActivate: function () { T.toggleOverview(); },
      isActive: function () { return T.overviewOpen; }
    }
  ];

  // -------------------------------------------------------------------
  // Registry (registerTool) + quick slots (localStorage)
  // -------------------------------------------------------------------

  var registered = [];

  /**
   * Console warning for a registration or API misuse, prefixed so the
   * source is obvious in a console full of other editor noise.
   *
   * @param {string} msg The message.
   * @return {void}
   */
  function warn(msg) {
    if (window.console && console.warn) {
      console.warn('[toolrail] ' + msg);
    }
  }

  // Tool ids are interpolated into [data-tool="…"] selectors all over the
  // rail, so the public contract restricts them to characters that are
  // unambiguous there. The set allows ':' and '/' because the internal
  // pinned-slot ids are 'pin:' + a block name ('pin:core/paragraph').
  var TOOL_ID_PATTERN = /^[A-Za-z0-9_:./-]+$/;

  /**
   * Quote a value for use inside an attribute selector. Belt to
   * TOOL_ID_PATTERN's braces: validation guards the documented entry
   * point, this guards every lookup, so an id arriving by some other
   * route can still never turn a DOM sweep into a SyntaxError.
   */
  function attrValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * An attribute selector matching one tool's button anywhere in the rail.
   *
   * @param {string} id Tool id.
   * @return {string} The selector.
   */
  function toolSelector(id) {
    return '[data-tool="' + attrValue(id) + '"]';
  }

  /**
   * Every id already claimed — the rail's own chrome buttons, the built-in
   * tools and their children, and everything registered. Registration
   * checks against this so a new tool cannot collide with an existing one
   * and hijack its [data-tool="…"] sweeps.
   *
   * @return {Array<string>} The claimed ids.
   */
  function allToolIds() {
    // The rail's own chrome buttons are not tools, but they carry
    // data-tool ids the [data-tool="…"] sweeps can reach — a registered
    // tool must not be able to collide with them.
    // A registered 'saved-sets' would also get the Saved sets menu from
    // the rail's ArrowRight handler, which checks this id first.
    // The Toolbars button and an empty extra toolbar's "Add tools" button
    // are chrome with a data-tool id too (#95).
    var ids = ['settings', 'help', 'wide-toggle', SETS_TOOL_ID, TOOLBAR_LIST_TOOL_ID, ADD_TOOLS_TOOL_ID];
    BUILTIN_TOOLS.forEach(function (t) {
      ids.push(t.id);
      (t.children || []).forEach(function (c) { ids.push(c.id); });
    });
    registered.forEach(function (t) { ids.push(t.id); });
    return ids;
  }

  /**
   * The `supports` descriptor field, kept as declared: only booleans
   * survive, and an axis that was not declared stays ABSENT (not false),
   * so needsCanvas() can fall back to the derived default for it. A
   * non-object is treated as "nothing declared".
   *
   * @param {*} raw The descriptor's `supports`.
   * @return {Object} {canvas?: boolean}
   */
  function normalizeSupports(raw) {
    var out = {};
    if (raw && typeof raw === 'object' && typeof raw.canvas === 'boolean') {
      out.canvas = raw.canvas;
    }
    return out;
  }

  /**
   * Validate + register one tool descriptor. Invalid descriptors are
   * dropped with a console warning, never "fixed up".
   */
  function registerTool(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') {
      warn('registerTool: descriptor must be an object.');
      return false;
    }
    if (typeof descriptor.id !== 'string' || descriptor.id === '') {
      warn('registerTool: a non-empty string id is required.');
      return false;
    }
    if (!TOOL_ID_PATTERN.test(descriptor.id)) {
      warn('registerTool: id "' + descriptor.id + '" has characters outside [A-Za-z0-9_:./-] — ignored.');
      return false;
    }
    if (allToolIds().indexOf(descriptor.id) !== -1) {
      warn('registerTool: duplicate id "' + descriptor.id + '" ignored.');
      return false;
    }
    var hasAction = typeof descriptor.onActivate === 'function'
      || typeof descriptor.createBlock === 'function'
      || (typeof descriptor.insertBlock === 'string' && descriptor.insertBlock !== '');
    if (!hasAction) {
      warn('registerTool("' + descriptor.id + '"): one of onActivate (function), createBlock (function) or insertBlock (block name) is required.');
      return false;
    }

    registered.push({
      id: descriptor.id,
      label: typeof descriptor.label === 'string' && descriptor.label !== '' ? descriptor.label : descriptor.id,
      icon: typeof descriptor.icon === 'string' ? descriptor.icon : '',
      parent: typeof descriptor.parent === 'string' ? descriptor.parent : '',
      insertBlock: typeof descriptor.insertBlock === 'string' ? descriptor.insertBlock : '',
      createBlock: typeof descriptor.createBlock === 'function' ? descriptor.createBlock : null,
      onActivate: typeof descriptor.onActivate === 'function' ? descriptor.onActivate : null,
      isActive: typeof descriptor.isActive === 'function' ? descriptor.isActive : null,
      supports: normalizeSupports(descriptor.supports)
    });

    window.dispatchEvent(new CustomEvent('toolrail:tools-updated'));
    // Every toolbar: a tool with a `parent` nests under that pin on each
    // toolbar that shows it.
    rerenderToolbars();
    return true;
  }

  /**
   * The out-of-the-box quick slots. Group, Text, Heading and Image are
   * ORDINARY pinned blocks (owner decisions 2026-08-26 and 2026-09-02) —
   * reorderable, removable, and saved-set–able like anything the author
   * pins. Group leads, where the built-in Section tool used to sit, and
   * inserts exactly what the inserter would — core's bare Group, which
   * lands as the layout picker. A pin never carries settings of its own
   * (owner decision 2026-09-02; a configured-block pin is a separate
   * idea, see private/issue-drafts).
   *
   * These seed exactly once, from migrateSlots(), and never again: an
   * author who removes all four stays at an empty rail rather than
   * having them resurrected on the next load.
   */
  var DEFAULT_SLOTS = ['core/group', 'core/paragraph', 'core/heading', 'core/image'];

  /**
   * The single gate for what may sit in the slot list: strings only, no
   * duplicates, order preserved.
   *
   * Deduping lives HERE rather than in each caller because a duplicate is
   * not merely untidy — two slots share one `data-tool="pin:<name>"` id,
   * so syncPressed's querySelector paints only the first, unpinning one
   * removes only one, and the settings dialog's `[data-block=…]` focus
   * restore matches both. pinBlock guarded against it; import and
   * loadConfig did not, which is how a hand-edited or hand-written set
   * file could put the rail into that state.
   *
   * @param {*} list Candidate slot list, from storage or a set file.
   * @return {string[]} Clean list, safe to render and store.
   */
  function normalizeSlots(list) {
    if (!Array.isArray(list)) {
      return [];
    }
    var seen = Object.create(null);
    return list.filter(function (name) {
      if (typeof name !== 'string' || name === '' || name in seen) {
        return false;
      }
      seen[name] = true;
      return true;
    });
  }

  /**
   * One-time upgrade to the pinned-slot model, run once per browser.
   *
   * Text, Heading and Image used to be BUILT-IN rail tools; they are now
   * ordinary pinned slots seeded from DEFAULT_SLOTS. Seeding on "the slot
   * key has never been written" alone silently deleted all three for
   * every existing author, because pinning even one block (or loading a
   * saved set) had already written that key under the old build.
   *
   * So a separate STAMP decides, not the presence of the slot list:
   *
   *   no stamp + no slot key      → fresh install, seed the defaults
   *   no stamp + a non-empty list → existing author, restore the three
   *                                 ahead of their own pins
   *   no stamp + an EMPTY list    → treated as an absence, not a
   *                                 decision — restore the three (see
   *                                 the comment below on why)
   *   stamp                       → nothing to do, ever again
   *
   * @return {void}
   */
  function migrateDefaultSlots() {
    if (null !== readKey(MIGRATED_KEY)) {
      return;
    }
    var raw = readKey(SLOTS_KEY);
    if (null === raw) {
      writeKey(SLOTS_KEY, JSON.stringify(DEFAULT_SLOTS));
      writeKey(MIGRATED_KEY, '1');
      return;
    }
    var existing;
    try {
      existing = normalizeSlots(JSON.parse(raw));
    } catch (e) {
      existing = [];
    }

    // A PRE-STAMP empty list is treated as an absence, not a decision
    // (owner decision 2026-08-26, reversing the earlier accepted-cost
    // call): under the old builds Text/Heading/Image were built-in tools,
    // so "[]" back then never meant "I chose an empty rail" — it usually
    // meant a test drive of unpinning whatever HAD been pinned. The
    // plugin has not shipped, so nobody's real preference predates the
    // stamp. POST-stamp emptiness is a decision and sticks (loadSlots
    // never re-seeds; readme.txt promises removing the defaults sticks).
    var restored = DEFAULT_SLOTS.filter(function (name) {
      return existing.indexOf(name) === -1;
    }).concat(existing);
    writeKey(SLOTS_KEY, JSON.stringify(restored));
    writeKey(MIGRATED_KEY, '1');
  }

  /**
   * Second one-time lift (0.1.22): Group joins the defaults. Section was
   * a built-in tool until now, so no stamped account can have pinned or
   * unpinned core/group on purpose — it is prepended to whatever the
   * author has, ahead of their pins, where Section used to sit.
   *
   * An author who EMPTIED the rail after the first stamp keeps it empty:
   * the lift only joins a non-empty, readable list. A corrupt list is
   * left alone, for the same reason "Restore default tools" refuses it.
   * A fresh install already carries Group in DEFAULT_SLOTS; the stamp is
   * written either way so the lift never runs twice.
   *
   * @return {void}
   */
  function seedGroupSlot() {
    if (null !== readKey(GROUP_SEEDED_KEY)) {
      return;
    }
    var raw = readKey(SLOTS_KEY);
    if (null !== raw) {
      var slots;
      try {
        slots = normalizeSlots(JSON.parse(raw));
      } catch (e) {
        slots = null;
      }
      if (slots && slots.length && slots.indexOf('core/group') === -1) {
        writeKey(SLOTS_KEY, JSON.stringify(['core/group'].concat(slots)));
      }
    }
    writeKey(GROUP_SEEDED_KEY, '1');
  }

  /** Both one-time lifts, in order: the three defaults, then Group. */
  function migrateSlots() {
    migrateDefaultSlots();
    seedGroupSlot();
  }

  // migrateSlots() runs from boot(), after migrateLocalToPrefs() — and
  // may run again from watchPersistenceAttach() if the persistence
  // layer's own attach lands late and wipes this pass.

  /**
   * A toolbar's pinned slots, in rail order. Each toolbar has its own
   * list, and the same slot can be on more than one toolbar (owner
   * decision 2026-11-14, #95). The first toolbar's list is the SLOTS_KEY
   * preference; an extra toolbar's list is in its record.
   *
   * @param {Object} tb The toolbar.
   * @return {string[]} Slot names. A copy.
   */
  function loadSlots(tb) {
    if (tb !== mainToolbar) {
      return tb.slots.slice();
    }
    var raw = readKey(SLOTS_KEY);
    if (null === raw) {
      // Post-migration this means the author emptied the rail, which is a
      // legitimate state — never re-seed the defaults here.
      return [];
    }
    try {
      return normalizeSlots(JSON.parse(raw));
    } catch (e) {
      // Corrupt JSON. An empty rail is recoverable (the settings dialog
      // still pins); replaying DEFAULT_SLOTS would fight the author on
      // every read without ever sticking.
      return [];
    }
  }

  /**
   * Persist the pinned slots, normalized on the way out so a caller can
   * hand over a list from a saved set or an imported file without cleaning
   * it first.
   *
   * @param {Object} tb    The toolbar.
   * @param {Array}  slots Slot names, in rail order.
   * @return {void}
   */
  function saveSlots(tb, slots) {
    if (tb === mainToolbar) {
      writeKey(SLOTS_KEY, JSON.stringify(normalizeSlots(slots)));
    } else {
      tb.slots = normalizeSlots(slots);
      saveToolbars();
    }
  }

  /**
   * Whether a slot name is pinned to one toolbar.
   *
   * @param {Object} tb        The toolbar.
   * @param {string} blockName Block type or pattern slot name.
   * @return {boolean} True when pinned there.
   */
  function isPinnedOn(tb, blockName) {
    return loadSlots(tb).indexOf(blockName) !== -1;
  }

  /**
   * Whether a slot name is pinned to a toolbar the author can see: the
   * first toolbar or a SHOWN extra toolbar. A hidden toolbar's pins do not
   * count (owner decision 2026-11-16, D4): the block menu then offers
   * "Pin to toolbar", and a pin made there goes to the first toolbar. The
   * hidden toolbar keeps its own pin.
   *
   * @param {string} blockName Block type or pattern slot name.
   * @return {boolean} True when pinned on a shown toolbar.
   */
  function isPinned(blockName) {
    return T.toolbars.some(function (tb) {
      return !tb.hidden && isPinnedOn(tb, blockName);
    });
  }

  /**
   * Whether a slot name is pinned to any toolbar, shown or hidden. A
   * pin's own name, description, icon and extension data belong to the
   * slot name, so they exist for as long as this is true: hiding a
   * toolbar must not cost its pins their labels.
   *
   * @param {string} blockName Block type or pattern slot name.
   * @return {boolean} True when pinned anywhere.
   */
  function isPinnedAnywhere(blockName) {
    return T.toolbars.some(function (tb) {
      return isPinnedOn(tb, blockName);
    });
  }

  /**
   * Pin a slot to the end of a toolbar, then rebuild it. A no-op for an
   * empty name or one already pinned to that toolbar.
   *
   * @param {Object} tb        The toolbar.
   * @param {string} blockName Block type or pattern slot name.
   * @return {boolean} True when the rail changed.
   */
  function pinBlock(tb, blockName) {
    if (typeof blockName !== 'string' || blockName === '') {
      return false;
    }
    var slots = loadSlots(tb);
    if (slots.indexOf(blockName) !== -1) {
      return false;
    }
    slots.push(blockName);
    saveSlots(tb, slots);
    window.dispatchEvent(new CustomEvent('toolrail:tools-updated'));
    T.rerender(tb);
    rerenderMainForParents(tb);
    return true;
  }

  /**
   * Unpin a slot from a toolbar and rebuild it. The author's metadata and
   * any extension data go with the LAST copy of the pin, so a later
   * re-pin starts clean.
   *
   * @param {Object} tb        The toolbar.
   * @param {string} blockName Block type or pattern slot name.
   * @return {boolean} True when the rail changed.
   */
  function unpinBlock(tb, blockName) {
    var slots = loadSlots(tb);
    var idx = slots.indexOf(blockName);
    if (idx === -1) {
      return false;
    }
    slots.splice(idx, 1);
    saveSlots(tb, slots);
    // The author's name/description/icon for this pin, and any extension
    // data on it, go with it: a later re-pin is a fresh tool, and the map
    // only ever describes tools the author has. A different toolbar that
    // still shows the pin keeps them.
    if (!isPinnedAnywhere(blockName) && clearPinMeta(blockName)) {
      announcePinMetaChange(blockName);
    }
    window.dispatchEvent(new CustomEvent('toolrail:tools-updated'));
    T.rerender(tb);
    rerenderMainForParents(tb);
    return true;
  }

  /**
   * Move a pinned slot up (-1) or down (+1) in a toolbar's order.
   *
   * @param {Object} tb        The toolbar.
   * @param {string} blockName Block type or pattern slot name.
   * @param {number} delta     -1 or 1.
   * @return {boolean} True when the slot moved.
   */
  function moveSlot(tb, blockName, delta) {
    var slots = loadSlots(tb);
    var idx = slots.indexOf(blockName);
    var to = idx + delta;
    if (idx === -1 || to < 0 || to >= slots.length) {
      return false;
    }
    slots.splice(idx, 1);
    slots.splice(to, 0, blockName);
    saveSlots(tb, slots);
    window.dispatchEvent(new CustomEvent('toolrail:tools-updated'));
    T.rerender(tb);
    return true;
  }

  /**
   * The public call's toolbar: the first toolbar when the caller names
   * none, so every call an extension made before #95 means what it meant.
   *
   * @param {*} id A toolbar id, or nothing.
   * @return {Object|null} The toolbar; null for an id that is not there.
   */
  function apiToolbar(id) {
    return id === undefined || id === null ? mainToolbar : toolbarById(String(id));
  }

  /**
   * Unpin a slot from every toolbar that shows it, so isPinned() is false
   * afterwards. The block menu's "Unpin from toolbar" shows exactly when
   * isPinned() is true, so its action must reach a pin that only an
   * extra toolbar shows (#95). A HIDDEN toolbar keeps its pin: its pins do
   * not count for isPinned() (owner decision 2026-11-16, D4).
   *
   * @param {string} blockName Block type or pattern slot name.
   * @return {boolean} True when a toolbar changed.
   */
  function unpinEverywhere(blockName) {
    var changed = false;
    T.toolbars.slice().forEach(function (tb) {
      if (!tb.hidden && unpinBlock(tb, blockName)) {
        changed = true;
      }
    });
    return changed;
  }

  /**
   * Rebuild every shown toolbar's rail. For a change that is not one
   * toolbar's: the tool registry, the pattern catalog, a pin's own name
   * or icon (the same pin can be on two toolbars).
   *
   * @return {void}
   */
  function rerenderToolbars() {
    T.toolbars.forEach(T.rerender);
  }

  /**
   * After the pins of an extra toolbar change, rebuild the first toolbar
   * when a provider tool names a parent. Such a tool sits under its
   * parent pin wherever that pin is, and at the first toolbar's top level
   * when no toolbar has the pin (railModel), so the first toolbar's
   * contents depend on the other toolbars' pins (#95).
   *
   * @param {Object|null} tb The toolbar whose pins changed; null when
   *                         the stored list changed (any toolbar).
   * @return {void}
   */
  function rerenderMainForParents(tb) {
    if (tb !== mainToolbar && registered.some(function (t) { return !!t.parent; })) {
      T.rerender(mainToolbar);
    }
  }

  // -------------------------------------------------------------------
  // Pin metadata (1.0.1). A pinned slot can carry the author's OWN name,
  // description and icon — to tell two pinned patterns apart, or to mark
  // a tool a site set up for the author. Per user, per pin name, in one
  // prototype-less map under PIN_META_KEY:
  //   { '<slot name>': { title?, description?, icon? } }
  // Every field is optional, and an empty field means "the block's own".
  // The map holds entries for PINNED slots only: setPinMeta refuses an
  // unpinned name and unpinBlock clears the entry, so nothing an author
  // cannot see from the Pinned tools list is ever stored here.
  //
  // Saved sets get their own map, SET_META_KEY: { '<set>': { '<slot>':
  // entry } } — a SNAPSHOT of the labels of the set's pins, taken by
  // saveConfig, written by importConfigPayload, read by exportConfig,
  // deleted with the set, and applied to the pin map by loadConfig. So a
  // set carries its labels (a file moved to another site keeps them),
  // while a set that is imported and never loaded labels nothing — the
  // pin map is never written behind the author's back (PR review
  // 2026-09-04, finding 1).
  //
  // Text only, rendered through textContent everywhere: a title or a
  // description is never markup. An icon is either a Dashicon slug
  // ('dashicons-star-filled' — the admin stylesheet is loaded on every
  // editor screen, and string block icons already render that way in
  // renderBlockIcon) or up to three characters of text ('Aa', '¶', one
  // emoji).
  //
  // EXTENSION DATA (owner decision 2026-09-05). The same entry carries
  // an `ext` map, one namespace per extension: { ext: { presets: {…} } }.
  // window.toolrail.setPinData(slot, namespace, data) / getPinData()
  // read and write ONE namespace; the author's three fields are never
  // touched by them, and setPinMeta never touches `ext`. Data is plain
  // JSON (a JSON round trip is the normalizer), capped per namespace at
  // PIN_DATA_MAX_LENGTH characters of serialized JSON (String.length,
  // so UTF-16 code units, not bytes),
  // and opaque to the rail: it changes nothing about how the pin
  // renders or inserts — a provider that registers tools under the pin
  // (parent: 'pin:<slot>') is what gives it meaning. Because it lives in
  // the entry it gets the entry's lifecycle for free: cleared on unpin,
  // snapshotted into saved sets, carried in set files, applied on load.
  // Every change to an entry fires 'toolrail:pin-meta-changed' on window
  // with {slot} in detail.
  // -------------------------------------------------------------------

  var PIN_META_LIMITS = { title: 80, description: 240, icon: 3 };
  var DASHICON_PATTERN = /^dashicons-[a-z0-9-]+$/;
  // Same shape as an extension's 'toolrail-ext:' key segment.
  var PIN_DATA_NAMESPACE = /^[a-z0-9][a-z0-9-]{0,39}$/;
  // Serialized size cap per namespace: the whole preferences array is one
  // user-meta row that core rewrites on every change.
  var PIN_DATA_MAX_LENGTH = 2048;

  /**
   * Plain JSON, or nothing: a round trip drops functions, undefined and
   * anything else JSON cannot carry, and the result must serialize
   * within the cap. Returns the cleaned copy, or undefined when refused.
   */
  function normalizePinData(data) {
    if (data === undefined || data === null || typeof data === 'function') {
      return undefined;
    }
    var json;
    try {
      json = JSON.stringify(data);
    } catch (e) {
      return undefined;
    }
    if (typeof json !== 'string' || json.length > PIN_DATA_MAX_LENGTH) {
      return undefined;
    }
    return JSON.parse(json);
  }

  /**
   * Tell extensions one slot's entry changed. Fired for every writer — the
   * public API, the Edit form, unpinning, and a set load — so a listener
   * needs only this one event to stay current.
   *
   * @param {string} slot The slot name.
   * @return {void}
   */
  function announcePinMetaChange(slot) {
    window.dispatchEvent(new CustomEvent('toolrail:pin-meta-changed', { detail: { slot: slot } }));
  }

  // Every Dashicon WordPress ships, from wp-includes/css/dashicons.css
  // (WP 7.1; the set has not changed since 5.5), so the Icon field's
  // browser can list them and a typed name can be checked — an unknown
  // name would render as an empty box on the toolbar. Kept as data here
  // rather than read from the stylesheet at run time: a site that serves
  // wp-includes from a CDN makes the CSSOM cross-origin and unreadable.
var DASHICON_NAMES = [
    'admin-appearance', 'admin-collapse', 'admin-comments', 'admin-customizer', 'admin-generic',
    'admin-home', 'admin-links', 'admin-media', 'admin-multisite', 'admin-network',
    'admin-page', 'admin-plugins', 'admin-post', 'admin-settings', 'admin-site',
    'admin-site-alt', 'admin-site-alt2', 'admin-site-alt3', 'admin-tools', 'admin-users',
    'airplane', 'album', 'align-center', 'align-full-width', 'align-left', 'align-none',
    'align-pull-left', 'align-pull-right', 'align-right', 'align-wide', 'amazon', 'analytics',
    'archive', 'arrow-down', 'arrow-down-alt', 'arrow-down-alt2', 'arrow-left',
    'arrow-left-alt', 'arrow-left-alt2', 'arrow-right', 'arrow-right-alt', 'arrow-right-alt2',
    'arrow-up', 'arrow-up-alt', 'arrow-up-alt2', 'arrow-up-duplicate', 'art', 'awards',
    'backup', 'bank', 'beer', 'bell', 'block-default', 'book', 'book-alt', 'buddicons-activity',
    'buddicons-bbpress-logo', 'buddicons-buddypress-logo', 'buddicons-community',
    'buddicons-forums', 'buddicons-friends', 'buddicons-groups', 'buddicons-pm',
    'buddicons-replies', 'buddicons-topics', 'buddicons-tracking', 'building', 'businessman',
    'businessperson', 'businesswoman', 'button', 'calculator', 'calendar', 'calendar-alt',
    'camera', 'camera-alt', 'car', 'carrot', 'cart', 'category', 'chart-area', 'chart-bar',
    'chart-line', 'chart-pie', 'clipboard', 'clock', 'cloud', 'cloud-saved', 'cloud-upload',
    'code-standards', 'coffee', 'color-picker', 'columns', 'controls-back', 'controls-forward',
    'controls-pause', 'controls-play', 'controls-repeat', 'controls-skipback',
    'controls-skipforward', 'controls-volumeoff', 'controls-volumeon', 'cover-image',
    'dashboard', 'database', 'database-add', 'database-export', 'database-import',
    'database-remove', 'database-view', 'desktop', 'dismiss', 'download', 'drumstick', 'edit',
    'edit-large', 'edit-page', 'editor-aligncenter', 'editor-alignleft', 'editor-alignright',
    'editor-bold', 'editor-break', 'editor-code', 'editor-code-duplicate', 'editor-contract',
    'editor-customchar', 'editor-distractionfree', 'editor-expand', 'editor-help',
    'editor-indent', 'editor-insertmore', 'editor-italic', 'editor-justify',
    'editor-kitchensink', 'editor-ltr', 'editor-ol', 'editor-ol-rtl', 'editor-outdent',
    'editor-paragraph', 'editor-paste-text', 'editor-paste-word', 'editor-quote',
    'editor-removeformatting', 'editor-rtl', 'editor-spellcheck', 'editor-strikethrough',
    'editor-table', 'editor-textcolor', 'editor-ul', 'editor-underline', 'editor-unlink',
    'editor-video', 'ellipsis', 'email', 'email-alt', 'email-alt2', 'embed-audio',
    'embed-generic', 'embed-photo', 'embed-post', 'embed-video', 'excerpt-view', 'exerpt-view',
    'exit', 'external', 'facebook', 'facebook-alt', 'feedback', 'filter', 'flag', 'food',
    'format-aside', 'format-audio', 'format-chat', 'format-gallery', 'format-image',
    'format-links', 'format-quote', 'format-standard', 'format-status', 'format-video', 'forms',
    'fullscreen-alt', 'fullscreen-exit-alt', 'games', 'google', 'googleplus', 'grid-view',
    'groups', 'hammer', 'heading', 'heart', 'hidden', 'hourglass', 'html', 'id', 'id-alt',
    'image-crop', 'image-filter', 'image-flip-horizontal', 'image-flip-vertical',
    'image-rotate', 'image-rotate-left', 'image-rotate-right', 'images-alt', 'images-alt2',
    'index-card', 'info', 'info-outline', 'insert', 'insert-after', 'insert-before',
    'instagram', 'laptop', 'layout', 'leftright', 'lightbulb', 'linkedin', 'list-view',
    'location', 'location-alt', 'lock', 'lock-duplicate', 'marker', 'media-archive',
    'media-audio', 'media-code', 'media-default', 'media-document', 'media-interactive',
    'media-spreadsheet', 'media-text', 'media-video', 'megaphone', 'menu', 'menu-alt',
    'menu-alt2', 'menu-alt3', 'microphone', 'migrate', 'minus', 'money', 'money-alt', 'move',
    'nametag', 'networking', 'no', 'no-alt', 'open-folder', 'palmtree', 'paperclip', 'pdf',
    'performance', 'pets', 'phone', 'pinterest', 'playlist-audio', 'playlist-video',
    'plugins-checked', 'plus', 'plus-alt', 'plus-alt2', 'podio', 'portfolio', 'post-status',
    'post-trash', 'pressthis', 'printer', 'privacy', 'products', 'randomize', 'reddit', 'redo',
    'remove', 'rest-api', 'rss', 'saved', 'schedule', 'screenoptions', 'search', 'share',
    'share-alt', 'share-alt2', 'share1', 'shield', 'shield-alt', 'shortcode', 'slides',
    'smartphone', 'smiley', 'sort', 'sos', 'spotify', 'star-empty', 'star-filled', 'star-half',
    'sticky', 'store', 'superhero', 'superhero-alt', 'table-col-after', 'table-col-before',
    'table-col-delete', 'table-row-after', 'table-row-before', 'table-row-delete', 'tablet',
    'tag', 'tagcloud', 'testimonial', 'text', 'text-page', 'thumbs-down', 'thumbs-up',
    'tickets', 'tickets-alt', 'tide', 'translation', 'trash', 'twitch', 'twitter',
    'twitter-alt', 'undo', 'universal-access', 'universal-access-alt', 'unlock', 'update',
    'update-alt', 'upload', 'vault', 'video-alt', 'video-alt2', 'video-alt3', 'visibility',
    'warning', 'welcome-add-page', 'welcome-comments', 'welcome-edit-page',
    'welcome-learn-more', 'welcome-view-site', 'welcome-widgets-menus', 'welcome-write-blog',
    'whatsapp', 'wordpress', 'wordpress-alt', 'xing', 'yes', 'yes-alt', 'youtube'
  ];

  /**
   * Whether a string names a Dashicon the platform actually ships. The
   * pattern alone is not enough: an unknown name passes it and then paints
   * an empty box on the toolbar.
   *
   * @param {string} value Candidate icon value.
   * @return {boolean} True when the icon exists.
   */
  function isDashiconName(value) {
    return DASHICON_PATTERN.test(value) && DASHICON_NAMES.indexOf(value.slice('dashicons-'.length)) !== -1;
  }

  /**
   * Characters as a reader counts them: grapheme clusters, so a flag, a
   * skin-toned hand or a family emoji (seven code points joined by ZWJ)
   * is ONE character, which is what the form's "up to 3 characters"
   * promises. Intl.Segmenter is on every browser the editor supports;
   * the code-point count is the fallback for anything older.
   */
  function countCharacters(value) {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      try {
        var n = 0;
        var it = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)[Symbol.iterator]();
        while (!it.next().done) {
          n++;
        }
        return n;
      } catch (e) {
        /* Fall through to the code-point count. */
      }
    }
    return Array.from(value).length;
  }

  /**
   * Whether a string is an acceptable custom icon: a Dashicon slug, or
   * text of at most PIN_META_LIMITS.icon characters (see countCharacters).
   */
  function isValidPinIcon(value) {
    return isDashiconName(value) || countCharacters(value) <= PIN_META_LIMITS.icon;
  }

  /**
   * The single gate for one metadata entry: trimmed strings only, each
   * within its limit, nothing else survives. Returns null when nothing is
   * left, and the caller then DELETES the entry rather than storing an
   * empty object. Whitespace runs collapse so a title can never carry a
   * line break into an aria-label.
   *
   * @param {*} raw A candidate entry, from the UI, storage or a set file.
   * @return {Object|null} {title?, description?, icon?} or null.
   */
  function normalizePinMeta(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    var out = {};
    ['title', 'description'].forEach(function (field) {
      if (typeof raw[field] === 'string') {
        var text = raw[field].replace(/\s+/g, ' ').trim();
        if (text !== '') {
          out[field] = Array.from(text).slice(0, PIN_META_LIMITS[field]).join('');
        }
      }
    });
    if (typeof raw.icon === 'string') {
      var icon = raw.icon.trim();
      if (icon !== '' && isValidPinIcon(icon)) {
        out.icon = icon;
      }
    }
    // Extension namespaces: name must match the pattern (so '__proto__'
    // and friends never become keys), data must be plain JSON in size.
    if (raw.ext && typeof raw.ext === 'object' && !Array.isArray(raw.ext)) {
      var ext = {};
      Object.keys(raw.ext).forEach(function (ns) {
        if (!PIN_DATA_NAMESPACE.test(ns)) {
          return;
        }
        var data = normalizePinData(raw.ext[ns]);
        if (data !== undefined) {
          ext[ns] = data;
        }
      });
      if (Object.keys(ext).length) {
        out.ext = ext;
      }
    }
    return Object.keys(out).length ? out : null;
  }

  /** Whether an entry carries any of the author's three fields. */
  function hasAuthorFields(entry) {
    return !!entry && !!(entry.title || entry.description || entry.icon);
  }

  /**
   * Read every pinned slot's entry, each one normalized and anything
   * unrecognized dropped. The map is prototype-less for the same reason
   * the set map is: a slot named '__proto__' must be an ordinary key.
   *
   * @return {Object} Slot name to entry.
   */
  function loadPinMeta() {
    var out = Object.create(null);
    try {
      var raw = readKey(PIN_META_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.keys(parsed).forEach(function (name) {
          var entry = normalizePinMeta(parsed[name]);
          if (entry) {
            out[name] = entry;
          }
        });
      }
    } catch (e) {
      /* Unparseable or unavailable storage — an empty map is correct. */
    }
    return out;
  }

  /**
   * Write the whole pin-metadata map back. Callers mutate a loaded copy
   * and persist once, so a multi-slot change is one write.
   *
   * @param {Object} map Slot name to entry.
   * @return {void}
   */
  function persistPinMeta(map) {
    writeKey(PIN_META_KEY, JSON.stringify(map));
  }

  /**
   * The author's metadata for one pinned slot, as a complete
   * {title, description, icon} with '' for an unset field — or null when
   * the slot has none of the three (extension data alone does not
   * count: this is the author-facing view, and the Edit form's Custom
   * tag and Reset button key off it). A copy: editing it changes nothing.
   */
  function getPinMeta(blockName) {
    if (!isPinnedAnywhere(blockName)) {
      return null;
    }
    var map = loadPinMeta();
    var entry = map[blockName];
    return hasAuthorFields(entry)
      ? { title: entry.title || '', description: entry.description || '', icon: entry.icon || '' }
      : null;
  }

  /**
   * Set — or clear, with null or all-empty fields — the author's three
   * fields on a PINNED slot. All three are replaced, so pass every field
   * to keep; extension data on the entry is left as it is (see
   * setPinData). An unpinned name is refused, so the map only ever holds
   * entries for tools the author has (unpinBlock clears its entry). An
   * icon that is not valid (see isValidPinIcon) is dropped; the settings
   * form checks it first and says why.
   *
   * @param {string}      blockName Slot name ('core/quote', 'pattern:…').
   * @param {Object|null} meta      {title?, description?, icon?}.
   * @return {boolean} Whether the slot is pinned and the change was made.
   */
  function setPinMeta(blockName, meta) {
    if (!isPinnedAnywhere(blockName)) {
      return false;
    }
    var map = loadPinMeta();
    var fields = normalizePinMeta(meta ? { title: meta.title, description: meta.description, icon: meta.icon } : null);
    var existing = map[blockName];
    var entry = fields || {};
    if (existing && existing.ext) {
      entry.ext = existing.ext;
    }
    if (Object.keys(entry).length) {
      map[blockName] = entry;
    } else if (existing) {
      delete map[blockName];
    } else {
      return true;
    }
    persistPinMeta(map);
    announcePinMetaChange(blockName);
    window.dispatchEvent(new CustomEvent('toolrail:tools-updated'));
    rerenderToolbars();
    return true;
  }

  /**
   * One extension's data on a PINNED slot, as a fresh copy — or null when
   * there is none, or the slot is not pinned (the same gate setPinData
   * has). `namespace` is the extension's own short name.
   *
   * @param {string} blockName Slot name.
   * @param {string} namespace A letter or digit, then [a-z0-9-], up to 40 in all.
   * @return {*} The stored JSON value, or null.
   */
  function getPinData(blockName, namespace) {
    if (typeof namespace !== 'string' || !PIN_DATA_NAMESPACE.test(namespace) || !isPinnedAnywhere(blockName)) {
      return null;
    }
    var map = loadPinMeta();
    var entry = map[blockName];
    if (!entry || !entry.ext || !Object.prototype.hasOwnProperty.call(entry.ext, namespace)) {
      return null;
    }
    return JSON.parse(JSON.stringify(entry.ext[namespace]));
  }

  /**
   * Store — or, with null, remove — one extension's data on a PINNED
   * slot. Refused (false) for an unpinned slot, a namespace that does
   * not match PIN_DATA_NAMESPACE, or data that is not plain JSON within
   * PIN_DATA_MAX_LENGTH characters once serialized. The author's fields
   * and other namespaces are untouched. Fires 'toolrail:pin-meta-changed';
   * does NOT rebuild the rail, because the data means nothing to the
   * rail itself — the extension redraws what it owns.
   *
   * `true` means the value passed every check and was handed to
   * writeKey, which stores it in the account's preferences or, when
   * that store is missing or has failed this session, in the browser's
   * local fallback (see the Storage block). It is not a receipt for the
   * server write, which core debounces; nothing in this file has one.
   *
   * @param {string} blockName Slot name.
   * @param {string} namespace A letter or digit, then [a-z0-9-], up to 40 in all.
   * @param {*}      data      Plain JSON value, or null to remove.
   * @return {boolean} Whether the change was accepted and written.
   */
  function setPinData(blockName, namespace, data) {
    if (!isPinnedAnywhere(blockName) || typeof namespace !== 'string' || !PIN_DATA_NAMESPACE.test(namespace)) {
      return false;
    }
    var map = loadPinMeta();
    var entry = map[blockName] || {};
    var ext = entry.ext || {};
    if (data === null) {
      if (!Object.prototype.hasOwnProperty.call(ext, namespace)) {
        return true;
      }
      delete ext[namespace];
    } else {
      var clean = normalizePinData(data);
      if (clean === undefined) {
        return false;
      }
      ext[namespace] = clean;
    }
    if (Object.keys(ext).length) {
      entry.ext = ext;
    } else {
      delete entry.ext;
    }
    if (Object.keys(entry).length) {
      map[blockName] = entry;
    } else {
      delete map[blockName];
    }
    persistPinMeta(map);
    announcePinMetaChange(blockName);
    return true;
  }

  /** Drop a slot's whole entry. Returns whether there was one. */
  function clearPinMeta(blockName) {
    var map = loadPinMeta();
    if (!map[blockName]) {
      return false;
    }
    delete map[blockName];
    persistPinMeta(map);
    return true;
  }

  /**
   * The saved sets' label snapshots, {setName: {slot: entry}}, every
   * entry through normalizePinMeta. Prototype-less like the configs map
   * (a set named '__proto__' is an ordinary key).
   */
  function loadConfigMeta() {
    var out = Object.create(null);
    try {
      var raw = readKey(SET_META_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.keys(parsed).forEach(function (setName) {
          var entries = normalizeSetMeta(parsed[setName]);
          if (entries) {
            out[setName] = entries;
          }
        });
      }
    } catch (e) {
      /* Unparseable or unavailable storage — an empty map is correct. */
    }
    return out;
  }

  /**
   * One set's label map, cleaned: only string keys with a valid entry.
   * `slots`, when given, restricts it to those slot names — a set file
   * cannot label a pin it does not list.
   *
   * @param {*}        raw   Candidate {slot: entry} map.
   * @param {string[]} slots Optional allow-list of slot names.
   * @return {Object|null} Prototype-less map, or null when empty.
   */
  function normalizeSetMeta(raw, slots) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    var out = Object.create(null);
    Object.keys(raw).forEach(function (slot) {
      if (slots && slots.indexOf(slot) === -1) {
        return;
      }
      var entry = normalizePinMeta(raw[slot]);
      if (entry) {
        out[slot] = entry;
      }
    });
    return Object.keys(out).length ? out : null;
  }

  /**
   * Write the whole set-metadata map back: set name to its label snapshot.
   *
   * @param {Object} map Set name to slot-label map.
   * @return {void}
   */
  function persistConfigMeta(map) {
    writeKey(SET_META_KEY, JSON.stringify(map));
  }

  /** Store (or, with null, drop) one set's label snapshot. */
  function setConfigMeta(setName, entries) {
    var map = loadConfigMeta();
    if (entries) {
      map[setName] = entries;
    } else if (map[setName]) {
      delete map[setName];
    } else {
      return;
    }
    persistConfigMeta(map);
  }

  // Named quick-slot configurations — a per-user account preference like
  // the slots themselves ({name: [blockNames]}).
  //
  // The map is deliberately PROTOTYPE-LESS. A set named '__proto__' on a
  // plain object hits Object.prototype's inherited setter: the write is
  // swallowed, nothing is stored, and saveConfig still reports success.
  // With a null prototype every name is an ordinary data property.
  function loadConfigs() {
    var out = Object.create(null);
    try {
      var raw = readKey(CONFIGS_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.keys(parsed).forEach(function (key) {
          if (Array.isArray(parsed[key])) {
            out[key] = parsed[key];
          }
        });
      }
    } catch (e) {
      /* Unparseable or unavailable storage — an empty map is correct. */
    }
    return out;
  }

  /**
   * Write the whole saved-set map back: set name to its list of slots.
   *
   * @param {Object} map Set name to slot names.
   * @return {void}
   */
  function persistConfigs(map) {
    writeKey(CONFIGS_KEY, JSON.stringify(map));
    // The first saved set adds the Saved sets button to the rail and a
    // delete of the last one removes it (#93). Only that change needs a
    // rebuild: the button's menu reads the map each time it opens.
    reconcileSetsButton();
  }

  /**
   * Save the rail's current pins as a named set, together with a snapshot
   * of the labels those pins carry right now — so restoring the set later
   * restores what the author saw, not just which blocks were on the rail.
   *
   * A set is a snapshot of ONE toolbar's pins. It keeps no link to the
   * toolbar it came from, so it loads into any toolbar (#95).
   *
   * @param {string} name Set name; trimmed, and refused when empty.
   * @param {Object} tb   The toolbar whose pins are saved.
   * @return {boolean} True when saved.
   */
  function saveConfig(name, tb) {
    if (typeof name !== 'string' || name.trim() === '') {
      return false;
    }
    var map = loadConfigs();
    var slots = loadSlots(tb);
    map[name.trim()] = slots;
    persistConfigs(map);
    // The set carries the labels its pins have right now (Pin metadata).
    setConfigMeta(name.trim(), normalizeSetMeta(loadPinMeta(), slots));
    return true;
  }

  /**
   * Restore a saved set: its slots become the rail, every slot the set
   * does not name is unpinned and loses its entry, and the set's label
   * snapshot lands on the pins it names. Extension data merges per
   * namespace so a namespace added since the set was saved survives.
   *
   * @param {string} name Set name.
   * @param {Object} tb   The toolbar the set is loaded into.
   * @return {boolean} True when the set existed and was applied.
   */
  function loadConfig(name, tb) {
    var map = loadConfigs();
    if (!Object.prototype.hasOwnProperty.call(map, name) || !Array.isArray(map[name])) {
      return false;
    }
    applySet(map[name], loadConfigMeta()[name], tb);
    return true;
  }

  /**
   * Put one set on a toolbar: what loadConfig() does for a saved set, and
   * what a shared set's load does with its copy (#98), so the two can
   * never differ. A set is a snapshot loaded INTO a toolbar (#95): only
   * that toolbar's pins change.
   *
   * @param {Array}       blocks The set's slots, in rail order.
   * @param {Object|null} labels The set's label snapshot (normalizeSetMeta
   *                             output), or null/undefined for none.
   * @param {Object}      tb     The toolbar the set is loaded into.
   * @return {void}
   */
  function applySet(blocks, labels, tb) {
    // saveSlots normalizes: a set stored by an older build, hand-edited,
    // or imported from a file can carry duplicates and non-strings.
    saveSlots(tb, blocks);
    var pinned = loadSlots(tb);
    var pinMeta = loadPinMeta();
    var changed = [];
    // Loading a set UNPINS every slot it does not name, and an unpinned
    // slot keeps no entry — the same rule unpinBlock applies — or a
    // re-pin months later would come up with stale labels and stale
    // extension data (PR review 2026-09-05, finding 2). A slot that a
    // different toolbar still shows is still pinned, and keeps its entry.
    Object.keys(pinMeta).forEach(function (slot) {
      if (!isPinnedAnywhere(slot)) {
        delete pinMeta[slot];
        changed.push(slot);
      }
    });
    // The set's snapshot lands on its pins, now that they ARE pinned:
    // the author's three fields come from the snapshot whole; extension
    // data merges per namespace, so a namespace the snapshot never saw
    // (an extension installed since the set was saved) is kept rather
    // than dropped. Slots the snapshot does not name keep what they have.
    if (labels) {
      Object.keys(labels).forEach(function (slot) {
        if (pinned.indexOf(slot) === -1) {
          return;
        }
        var next = {};
        ['title', 'description', 'icon'].forEach(function (field) {
          if (labels[slot][field]) {
            next[field] = labels[slot][field];
          }
        });
        var current = pinMeta[slot];
        if ((current && current.ext) || labels[slot].ext) {
          next.ext = {};
          Object.keys((current && current.ext) || {}).forEach(function (ns) {
            next.ext[ns] = current.ext[ns];
          });
          Object.keys(labels[slot].ext || {}).forEach(function (ns) {
            next.ext[ns] = labels[slot].ext[ns];
          });
        }
        pinMeta[slot] = next;
        if (changed.indexOf(slot) === -1) {
          changed.push(slot);
        }
      });
    }
    if (changed.length) {
      persistPinMeta(pinMeta);
      changed.forEach(announcePinMetaChange);
    }
    window.dispatchEvent(new CustomEvent('toolrail:tools-updated'));
    // The set's labels land on its pins wherever they show.
    rerenderToolbars();
  }

  /**
   * Delete a saved set and its label snapshot.
   *
   * @param {string} name Set name.
   * @return {boolean} True when the set existed.
   */
  function deleteConfig(name) {
    var map = loadConfigs();
    if (!Object.prototype.hasOwnProperty.call(map, name)) {
      return false;
    }
    delete map[name];
    persistConfigs(map);
    setConfigMeta(name, null);
    return true;
  }

  // -------------------------------------------------------------------
  // Saved sets button (#93). A rail button in the tail that opens a menu
  // of the saved sets, so a switch is one press instead of a trip
  // through Toolbar settings. It reuses the flyout machinery: the
  // button is a container tool, each set is a menuitemradio child, and
  // a load does exactly what Load in Toolbar settings does.
  // -------------------------------------------------------------------

  /**
   * The saved set whose slots are the rail's slots now, in the same
   * order. Labels are not compared: a set "is current" when the author
   * would see the same tools. When two sets have the same slots, the
   * first wins, so at most one menu item is checked.
   *
   * @return {string} The set name, or '' when no set matches.
   */
  function currentConfigName() {
    // The Saved sets button is on the first toolbar and loads into it.
    var current = JSON.stringify(loadSlots(mainToolbar));
    var map = loadConfigs();
    var names = Object.keys(map);
    for (var i = 0; i < names.length; i++) {
      if (JSON.stringify(normalizeSlots(map[names[i]])) === current) {
        return names[i];
      }
    }
    return '';
  }

  /**
   * The Saved sets menu item that matches the rail now: the user's own set
   * from currentConfigName() first, then the first listed shared set (#98)
   * with the same slots. One item at most, as the menu promises.
   *
   * @return {string} The item's id, or '' when nothing matches.
   */
  function currentSetMenuId() {
    var own = currentConfigName();
    if (own) {
      return SETS_TOOL_ID + ':' + own;
    }
    // The menu is on the first toolbar and loads into it (#95).
    var current = JSON.stringify(loadSlots(mainToolbar));
    var listed = listedSharedSets();
    for (var i = 0; i < listed.length; i++) {
      if (JSON.stringify(listed[i].blocks) === current) {
        return SETS_TOOL_ID + '-shared-' + listed[i].id;
      }
    }
    return '';
  }

  /**
   * Whether the rail shows the Saved sets button: the author has at
   * least one saved set, or another user shares one (#98), and has not
   * hidden the button in Toolbar settings. With no set the menu would
   * have nothing to switch to.
   *
   * @return {boolean}
   */
  function isSetsButtonShown() {
    return readKey(SETS_BUTTON_HIDDEN_KEY) !== '1'
      && (Object.keys(loadConfigs()).length > 0 || listedSharedSets().length > 0);
  }

  /**
   * Rebuild the rail when the Saved sets button it shows no longer
   * matches isSetsButtonShown(). It compares the rendered rail with the
   * stored state, not the state before and after one write, so it also
   * catches a change that came from outside this file: core's
   * preferences attach can replace the whole store, sets included,
   * while both migration stamps survive, and then no repair runs (PR #97
   * review). watchPersistenceAttach() calls it on every core/preferences
   * dispatch; the cost is one DOM query and two preference reads.
   *
   * @return {boolean} True when the rail was rebuilt.
   */
  function reconcileSetsButton() {
    var rail = document.getElementById(mainToolbar.railId);
    if (!rail) {
      return false;
    }
    var rendered = !!rail.querySelector(toolSelector(SETS_TOOL_ID));
    if (rendered === isSetsButtonShown()) {
      return false;
    }
    T.rerender(mainToolbar);
    return true;
  }

  /**
   * The outcome text for a set load, shared by Load in Toolbar settings
   * and the Saved sets menu so both say the same thing.
   *
   * @param {string} name Set name.
   * @param {Object} tb   The toolbar the set was loaded into.
   * @return {string} The message.
   */
  function configLoadedMessage(name, tb) {
    var missing = T.missingBlockCount(loadSlots(tb));
    // An extra toolbar is named, so the author hears which toolbar the
    // set went into (#95). The first toolbar's messages are as before.
    if (tb !== mainToolbar) {
      return missing > 0
        ? sprintf(
          /* translators: 1: set name, 2: the toolbar's name, 3: count of unavailable blocks. */
          _n(
            'Loaded "%1$s" into the %2$s toolbar. %3$d pinned block is not available on this site and stays hidden until its plugin or theme is active.',
            'Loaded "%1$s" into the %2$s toolbar. %3$d pinned blocks are not available on this site and stay hidden until their plugin or theme is active.',
            missing,
            'editrail'
          ),
          name,
          tb.name,
          missing
        )
        : sprintf(
          /* translators: 1: set name, 2: the toolbar's name. */
          __('Loaded "%1$s" into the %2$s toolbar.', 'editrail'),
          name,
          tb.name
        );
    }
    if (missing > 0) {
      return sprintf(
        /* translators: 1: set name, 2: count of unavailable blocks. */
        _n(
          'Loaded "%1$s". %2$d pinned block is not available on this site and stays hidden until its plugin or theme is active.',
          'Loaded "%1$s". %2$d pinned blocks are not available on this site and stay hidden until their plugin or theme is active.',
          missing,
          'editrail'
        ),
        name,
        missing
      );
    }
    // Announce the ordinary success too. The rail rebuilding is a
    // visual-only cue, so without this a screen-reader user got no
    // confirmation that Load had done anything at all.
    return sprintf(
      /* translators: %s: set name. */
      __('Loaded "%s".', 'editrail'),
      name
    );
  }

  /**
   * Load a set from the Saved sets menu, announce it, and put focus on
   * the rebuilt Saved sets button. The flyout closed before this ran and
   * loadConfig rebuilt the rail, so the button that opened the menu is
   * gone; without the refocus, focus would fall to the page body. When
   * the rebuilt rail has no Saved sets button (another tab hid it since
   * the menu opened), focus goes to Toolbar settings, where the button
   * comes back.
   *
   * @param {string} name Set name.
   * @return {void}
   */
  function loadConfigFromMenu(name) {
    if (loadConfig(name, mainToolbar)) {
      speak(configLoadedMessage(name, mainToolbar));
    } else {
      // Deleted in another tab since the menu opened.
      speak(sprintf(
        /* translators: %s: set name. */
        __('The set "%s" no longer exists.', 'editrail'),
        name
      ));
    }
    focusSetsButton();
  }

  /**
   * Focus the rebuilt Saved sets button after a load from its menu, or
   * Toolbar settings when the rebuilt rail has none (see
   * loadConfigFromMenu). The button is on the first toolbar (#95).
   *
   * @return {void}
   */
  function focusSetsButton() {
    var btn = document.querySelector('#' + mainToolbar.railId + ' ' + toolSelector(SETS_TOOL_ID)) || T.gearButton();
    if (btn) {
      btn.focus();
    }
  }

  /**
   * The Saved sets button as a rail tool descriptor. Its children are a
   * GETTER, read from storage on every access: the flyout reads them when
   * it opens, so a set saved, deleted or imported since the rail was
   * built shows without a rebuild, and the checked item follows the
   * current pins. The author's own sets come first, then the sets other
   * users share (#98), each named with who shared it.
   *
   * @param {HTMLElement} wrapper The rail region (for the settings dialog).
   * @return {Object} The tool descriptor.
   */
  function setsMenuTool(wrapper) {
    var tool = {
      id: SETS_TOOL_ID,
      label: __('Saved sets', 'editrail'),
      shortLabel: __('Sets', 'editrail'),
      icon: ICONS.sets
    };
    Object.defineProperty(tool, 'children', {
      enumerable: true,
      get: function () {
        var current = currentSetMenuId();
        var items = Object.keys(loadConfigs()).map(function (name) {
          var id = SETS_TOOL_ID + ':' + name;
          return {
            id: id,
            // Text, never a mark alone: the author shares this set.
            label: ownSharedCopy(name)
              ? sprintf(
                /* translators: %s: set name. */
                __('%s (shared)', 'editrail'),
                name
              )
              : name,
            radio: true,
            checked: id === current,
            supports: { canvas: false },
            onActivate: function () {
              loadConfigFromMenu(name);
            }
          };
        });
        listedSharedSets().forEach(function (item) {
          // '-shared-' not ':', so no set name can produce this id.
          var sharedId = SETS_TOOL_ID + '-shared-' + item.id;
          items.push({
            id: sharedId,
            label: sharedSetMenuLabel(item),
            radio: true,
            checked: sharedId === current,
            supports: { canvas: false },
            onActivate: function () {
              loadSharedSetFromMenu(item.id);
            }
          });
        });
        items.push({
          // '-' not ':', so no set name can produce this id.
          id: SETS_TOOL_ID + '-new',
          label: __('Save the current tools as a set…', 'editrail'),
          separatorBefore: true,
          supports: { canvas: false },
          onActivate: function () {
            T.openSettings(wrapper, '#toolrail-settings-setname');
          }
        });
        return items;
      }
    });
    return tool;
  }

  // The Toolbars button (#95) is the Saved sets button's sibling and is
  // built the same way: rail chrome in the first toolbar's tail, a
  // container tool whose children are read on every open.

  /**
   * Whether the first toolbar shows the Toolbars button: the author has
   * an extra toolbar and has not hidden the button in Toolbar settings.
   * With no extra toolbar the menu would have nothing to show or hide.
   *
   * @return {boolean}
   */
  function isToolbarsButtonShown() {
    return T.toolbars.length > 1 && readKey(TOOLBARS_BUTTON_HIDDEN_KEY) !== '1';
  }

  /**
   * Rebuild the first toolbar when the Toolbars button it shows no longer
   * matches isToolbarsButtonShown(): the first extra toolbar adds the
   * button and a delete of the last one removes it. The same compare of
   * the rendered rail with the state as reconcileSetsButton().
   *
   * @return {boolean} True when the rail was rebuilt.
   */
  function reconcileToolbarsButton() {
    var rail = document.getElementById(mainToolbar.railId);
    if (!rail) {
      return false;
    }
    var rendered = !!rail.querySelector(toolSelector(TOOLBAR_LIST_TOOL_ID));
    if (rendered === isToolbarsButtonShown()) {
      return false;
    }
    T.rerender(mainToolbar);
    return true;
  }

  /**
   * Show or hide a toolbar from the Toolbars menu, say what happened, and
   * put focus back on the Toolbars button. The flyout closed before this
   * ran, without a refocus (an action item may move focus itself), so
   * without this the focus would fall to the page body.
   *
   * @param {string} id The toolbar's id.
   * @return {void}
   */
  function toggleToolbarFromMenu(id) {
    var tb = toolbarById(id);
    if (tb && tb !== mainToolbar) {
      var result = setToolbarHidden(tb, !tb.hidden);
      // ONE speak() with every fact: a second call in the same task
      // replaces the first (review 2026-11-16, finding 2).
      speak(joinMessages([
        toolbarShownMessage(tb),
        result && result.disarmed ? disarmedMessage() : '',
        tb.hidden ? '' : canvasNarrowMessage()
      ]));
    }
    var rail = document.getElementById(mainToolbar.railId);
    var btn = (rail && rail.querySelector(toolSelector(TOOLBAR_LIST_TOOL_ID))) || T.gearButton();
    if (btn) {
      btn.focus();
    }
  }

  /**
   * The outcome text for a show or hide, shared by the Toolbars menu and
   * the checkbox in Toolbar settings so both say the same thing.
   *
   * @param {Object} tb An extra toolbar.
   * @return {string} The message.
   */
  function toolbarShownMessage(tb) {
    return sprintf(
      tb.hidden
        /* translators: %s: the toolbar's name. */
        ? __('The %s toolbar is hidden.', 'editrail')
        /* translators: %s: the toolbar's name. */
        : __('The %s toolbar is shown.', 'editrail'),
      tb.name
    );
  }

  /**
   * The Toolbars button as a rail tool descriptor. Each extra toolbar is
   * a child with onActivate and isActive, which the flyout draws as a
   * menuitemcheckbox: checked means shown. The children are a GETTER, for
   * the same reason as the Saved sets menu's.
   *
   * @return {Object} The tool descriptor.
   */
  function toolbarsMenuTool() {
    var tool = {
      id: TOOLBAR_LIST_TOOL_ID,
      label: __('Toolbars', 'editrail'),
      shortLabel: __('Toolbars', 'editrail'),
      icon: ICONS.toolbars
    };
    Object.defineProperty(tool, 'children', {
      enumerable: true,
      get: function () {
        var items = T.toolbars.slice(1).map(function (tb) {
          return {
            id: TOOLBAR_LIST_TOOL_ID + ':' + tb.id,
            label: tb.name,
            supports: { canvas: false },
            isActive: function () {
              return !tb.hidden;
            },
            onActivate: function () {
              toggleToolbarFromMenu(tb.id);
            }
          };
        });
        items.push({
          // '-' not ':', so no toolbar id can produce this id.
          id: TOOLBAR_LIST_TOOL_ID + '-settings',
          label: __('Add or change toolbars…', 'editrail'),
          separatorBefore: true,
          supports: { canvas: false },
          onActivate: function () {
            // At the toolbar chooser, which leads the toolbar sections.
            T.openSettingsFor(T.settingsToolbar(), '#toolrail-settings-toolbar');
          }
        });
        return items;
      }
    });
    return tool;
  }

  // -------------------------------------------------------------------
  // Shared sets (#98). An author can share one of their saved sets with
  // the other users of this site; every user who can edit posts sees the
  // shared sets in Toolbar settings and in the Saved sets menu, marked as
  // shared and named with who shared them, and can load or export them.
  //
  // The server keeps each shared set as a COPY in the set file format,
  // one per author and set name (includes/shared-sets.php, which also
  // decides who may share, read and stop sharing). A load applies that
  // copy exactly as Load applies the user's own set (applySet), with the
  // same message, and links nothing: the user's pins do not follow later
  // changes. The author's own set and its shared copy are also separate:
  // a change reaches other users only when the author shares the set
  // again, which replaces the copy in place.
  //
  // Nothing here waits on the network. The list arrives once after boot
  // and again each time Toolbar settings opens. Until it arrives, and
  // whenever a request fails (no capability, offline, a server error),
  // the rail and the dialog are exactly what they are without the
  // feature. Set names and display names come from OTHER users, so they
  // reach the DOM only through textContent and attribute values, never
  // as markup.
  // -------------------------------------------------------------------

  var SHARED_SETS_PATH = '/editrail/v1/sets';
  // The last list the server sent, normalized (normalizeSharedSet),
  // oldest share first. A failed request keeps it.
  var sharedSets = [];
  // Whether the server says this user may share (publish_posts). False
  // until the list arrives, so no Share button shows before then.
  var canShareSets = false;
  // The list request in flight, so a second caller joins it.
  var sharedSetsRequest = null;
  // A share or stop-sharing request is in flight. One at a time: a second
  // press while the first is out does nothing.
  var sharedSetBusy = false;

  /**
   * Whether wp.apiFetch is there. The rail declares it as a dependency,
   * but a context without it must still boot.
   *
   * @return {boolean}
   */
  function canFetchSharedSets() {
    return !!(wp.apiFetch && typeof wp.apiFetch === 'function');
  }

  /**
   * Whether a string is a slot a set may hold: a block name or a pattern
   * slot. The one grammar for a set file (importConfigPayload) and a
   * shared set; includes/shared-sets.php applies the same one.
   *
   * @param {*} name Candidate slot.
   * @return {boolean}
   */
  function isSetSlotName(name) {
    return typeof name === 'string' && (T.BLOCK_NAME_PATTERN.test(name) || PATTERN_SLOT_PATTERN.test(name));
  }

  /**
   * One list entry from the server, checked again here: the server
   * validates, but this is what the rail renders and loads. `set` is the
   * set file's JSON as text.
   *
   * @param {*} raw One entry of the response's `sets`.
   * @return {Object|null} {id, name, blocks, labels, author, mine,
   *                       canDelete}, or null when it is not a set.
   */
  function normalizeSharedSet(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.set !== 'string') {
      return null;
    }
    var id = typeof raw.id === 'number' && raw.id > 0 && Math.floor(raw.id) === raw.id ? raw.id : 0;
    var parsed;
    try {
      parsed = JSON.parse(raw.set);
    } catch (e) {
      return null;
    }
    if (!id || !parsed || typeof parsed !== 'object' || !Array.isArray(parsed.blocks)
      || typeof parsed.name !== 'string' || parsed.name.trim() === '') {
      return null;
    }
    var blocks = normalizeSlots(parsed.blocks.filter(isSetSlotName));
    return {
      id: id,
      name: parsed.name,
      blocks: blocks,
      labels: normalizeSetMeta(parsed.meta, blocks),
      author: typeof raw.author === 'string' ? raw.author : '',
      mine: raw.mine === true,
      canDelete: raw.can_delete === true
    };
  }

  /**
   * A comparable form of a list, so a refresh that brings nothing new
   * rebuilds nothing.
   *
   * @param {Array} list Normalized entries.
   * @return {string}
   */
  function sharedSetsSignature(list) {
    return JSON.stringify(list.map(function (item) {
      return [item.id, item.name, item.blocks, item.labels, item.author, item.mine, item.canDelete];
    }));
  }

  /**
   * Take a list response: keep it, and when it changed what the user can
   * see, add or remove the Saved sets button and redraw an open dialog.
   *
   * @param {*} body The response body: {can_share, sets}.
   * @return {void}
   */
  function receiveSharedSets(body) {
    var list = body && Array.isArray(body.sets)
      ? body.sets.map(normalizeSharedSet).filter(Boolean)
      : [];
    var share = !!(body && body.can_share === true);
    var changed = share !== canShareSets || sharedSetsSignature(list) !== sharedSetsSignature(sharedSets);
    sharedSets = list;
    canShareSets = share;
    if (changed) {
      reconcileSetsButton();
      // Redraw an open dialog, but not from under the author: the redraw
      // can hand focus back only to a control that has an id, and the row
      // buttons (Load, Export, Unpin, the arrows) have none, so focus would
      // jump to the search field. This list arrives on its own, a moment
      // after the dialog opens; an author who is already on a row button
      // keeps it, and the dialog shows the new list at its next redraw
      // (any action in it) or when it opens again. A stale row still acts
      // on its own copy, and a set that is gone answers "no longer shared".
      var focused = document.activeElement;
      var dialog = T.settingsOpen ? T.settingsNode() : null;
      if (dialog && !(focused && dialog.contains(focused) && !focused.id)) {
        T.refreshSettings();
      }
    }
  }

  /**
   * Ask the server for the list. Never throws and never rejects: a failed
   * request keeps the last list, and the rail goes on as it is.
   *
   * @return {Promise|null} Settles when the list is in, or null when
   *                        apiFetch is not there.
   */
  function refreshSharedSets() {
    if (!canFetchSharedSets()) {
      return null;
    }
    if (sharedSetsRequest) {
      return sharedSetsRequest;
    }
    try {
      sharedSetsRequest = wp.apiFetch({ path: SHARED_SETS_PATH }).then(function (body) {
        sharedSetsRequest = null;
        receiveSharedSets(body);
      }, function () {
        sharedSetsRequest = null;
      });
    } catch (e) {
      sharedSetsRequest = null;
    }
    return sharedSetsRequest;
  }

  /**
   * The current user's own shared copy of one of their sets, or null.
   *
   * @param {string} name Set name.
   * @return {Object|null}
   */
  function ownSharedCopy(name) {
    for (var i = 0; i < sharedSets.length; i++) {
      if (sharedSets[i].mine && sharedSets[i].name === name) {
        return sharedSets[i];
      }
    }
    return null;
  }

  /**
   * The shared sets listed under "Shared sets" and in the menu: every one
   * except the user's own copies of sets they still have, which their own
   * set's row and menu item stand for. A copy whose own set the author has
   * deleted is still listed, so it can be loaded or stopped.
   *
   * @return {Array} Normalized entries.
   */
  function listedSharedSets() {
    var own = loadConfigs();
    return sharedSets.filter(function (item) {
      return !(item.mine && Object.prototype.hasOwnProperty.call(own, item.name));
    });
  }

  /**
   * One shared set by its ID, from the last list.
   *
   * @param {number} id Post ID.
   * @return {Object|null}
   */
  function findSharedSet(id) {
    for (var i = 0; i < sharedSets.length; i++) {
      if (sharedSets[i].id === id) {
        return sharedSets[i];
      }
    }
    return null;
  }

  /**
   * "Shared by <name>", the visible mark on a shared set.
   *
   * @param {Object} item A normalized entry.
   * @return {string}
   */
  function sharedByText(item) {
    if (item.mine) {
      return __('Shared by you', 'editrail');
    }
    return item.author
      ? sprintf(
        /* translators: %s: display name of the user who shared the set. */
        __('Shared by %s', 'editrail'),
        item.author
      )
      : __('Shared by another user', 'editrail');
  }

  /**
   * A shared set's menu item text: the name and who shared it, so a
   * shared set and one of the user's own sets with the same name are two
   * different items to a screen reader too.
   *
   * @param {Object} item A normalized entry.
   * @return {string}
   */
  function sharedSetMenuLabel(item) {
    if (item.mine) {
      return sprintf(
        /* translators: %s: set name. */
        __('%s (shared by you)', 'editrail'),
        item.name
      );
    }
    return item.author
      ? sprintf(
        /* translators: 1: set name, 2: display name of the user who shared it. */
        __('%1$s (shared by %2$s)', 'editrail'),
        item.name,
        item.author
      )
      : sprintf(
        /* translators: %s: set name. */
        __('%s (shared by another user)', 'editrail'),
        item.name
      );
  }

  /**
   * "shared by <name>", lower case, for inside the accessible names of a
   * shared set's buttons, after the set name.
   *
   * @param {Object} item A normalized entry.
   * @return {string}
   */
  function sharedByPhrase(item) {
    if (item.mine) {
      return __('shared by you', 'editrail');
    }
    return item.author
      ? sprintf(
        /* translators: %s: display name of the user who shared the set. */
        __('shared by %s', 'editrail'),
        item.author
      )
      : __('shared by another user', 'editrail');
  }

  /**
   * Load a shared set from the Saved sets menu: the same as
   * loadConfigFromMenu() for one of the user's own sets, so it loads into
   * the first toolbar, which has the menu (#95).
   *
   * @param {number} id Post ID.
   * @return {void}
   */
  function loadSharedSetFromMenu(id) {
    var item = findSharedSet(id);
    if (item) {
      applySet(item.blocks, item.labels, mainToolbar);
      speak(configLoadedMessage(item.name, mainToolbar));
    } else {
      speak(__('That set is no longer shared.', 'editrail'));
    }
    focusSetsButton();
  }

  /**
   * The set file payload of one of the user's own sets, as the server
   * receives it on a share: the same object exportConfig() writes.
   *
   * @param {string} name Set name.
   * @return {Object|null} Null when the set does not exist.
   */
  function ownSetPayload(name) {
    var map = loadConfigs();
    if (!Object.prototype.hasOwnProperty.call(map, name) || !Array.isArray(map[name])) {
      return null;
    }
    return T.setFilePayload(name, map[name], loadConfigMeta()[name]);
  }

  /**
   * Whether the author's own set differs from its shared copy, compared
   * the way the server stores a set (valid slots, repeats collapsed,
   * labels of the set's own slots), so "Share again" shows only when it
   * would send something new.
   *
   * @param {string} name Set name.
   * @param {Object} copy The shared copy (a normalized entry).
   * @return {boolean}
   */
  function sharedCopyIsOlder(name, copy) {
    var payload = ownSetPayload(name);
    if (!payload) {
      return false;
    }
    var blocks = normalizeSlots(payload.blocks.filter(isSetSlotName));
    return JSON.stringify(blocks) !== JSON.stringify(copy.blocks)
      || JSON.stringify(normalizeSetMeta(payload.meta, blocks)) !== JSON.stringify(copy.labels);
  }

  /**
   * The text of a failed request, for the author: the server's own
   * sentence when it sent one, else a general one.
   *
   * @param {*} err What apiFetch rejected with.
   * @return {string}
   */
  function sharedSetErrorText(err) {
    return err && typeof err.message === 'string' && err.message
      ? err.message
      : __('The server did not answer.', 'editrail');
  }

  /**
   * Report the outcome of a share or stop-sharing request. The request is
   * async, so the dialog can be closed by the time it settles; the same
   * rule as reportImport(): an open dialog shows the message in its
   * status line and speaks it, otherwise it is only spoken.
   *
   * @param {string}          message        Outcome text.
   * @param {string|string[]} focusSelectors Where focus goes in the dialog.
   * @return {void}
   */
  function reportSharedSet(message, focusSelectors) {
    if (!T.settingsOpen || !T.settingsNode()) {
      speak(message);
      return;
    }
    T.settingsStatus = message;
    T.refreshSettings(focusSelectors);
  }

  /**
   * Put one entry from a share response into the list, replacing an entry
   * with the same ID (a share again keeps its ID).
   *
   * @param {Object} item A normalized entry.
   * @return {void}
   */
  function storeSharedSet(item) {
    var next = sharedSets.filter(function (existing) {
      return existing.id !== item.id;
    });
    next.push(item);
    next.sort(function (a, b) {
      return a.id - b.id;
    });
    sharedSets = next;
  }

  /**
   * A selector prefix for one of the user's own set rows in the dialog,
   * for a focus target after a rebuild. attrValue() escapes quotes and
   * backslashes; a name from a set file can also hold a control
   * character, which a CSS string must escape as a code point or the
   * selector does not parse.
   *
   * @param {string} name Set name.
   * @return {string} The selector prefix, with a trailing space.
   */
  function setRowSelector(name) {
    // eslint-disable-next-line no-control-regex -- matching control characters is the point: each one is escaped.
    var value = attrValue(name).replace(/[\u0000-\u001f\u007f]/g, function (c) {
      return '\\' + c.charCodeAt(0).toString(16) + ' ';
    });
    return '.toolrail-settings-setrow[data-config="' + value + '"] ';
  }

  /**
   * Send a share or stop-sharing request and mark it in flight. An
   * apiFetch that throws instead of rejecting must not leave the flag set,
   * or every later press would do nothing.
   *
   * @param {Object} options apiFetch options.
   * @return {Promise|null} The request, or null when it could not start.
   */
  function sendSharedSetRequest(options) {
    var request;
    try {
      request = wp.apiFetch(options);
    } catch (e) {
      return null;
    }
    if (!request || typeof request.then !== 'function') {
      return null;
    }
    sharedSetBusy = true;
    return request;
  }

  /**
   * Share one of the user's own sets, or share it again. Focus stays in
   * the set's row: on Stop sharing, which every shared row has.
   *
   * @param {string} name Set name.
   * @return {void}
   */
  function shareConfig(name) {
    var payload = ownSetPayload(name);
    if (sharedSetBusy || !payload || !canFetchSharedSets()) {
      return;
    }
    var again = !!ownSharedCopy(name);
    var row = setRowSelector(name);
    var request = sendSharedSetRequest({
      path: SHARED_SETS_PATH,
      method: 'POST',
      data: { set: JSON.stringify(payload) }
    });
    if (!request) {
      return;
    }
    request.then(function (body) {
      sharedSetBusy = false;
      var item = normalizeSharedSet(body);
      if (item) {
        storeSharedSet(item);
        reconcileSetsButton();
      }
      reportSharedSet(again
        ? sprintf(
          /* translators: %s: set name. */
          __('Shared the set "%s" again. Other users on this site now get this version.', 'editrail'),
          name
        )
        : sprintf(
          /* translators: %s: set name. */
          __('Shared the set "%s". Other users on this site can now load it.', 'editrail'),
          name
        ), [row + '.toolrail-settings-unshare', row + '.toolrail-settings-share']);
    }, function (err) {
      sharedSetBusy = false;
      reportSharedSet(sprintf(
        /* translators: 1: set name, 2: the reason, a full sentence. */
        __('The set "%1$s" was not shared. %2$s', 'editrail'),
        name,
        sharedSetErrorText(err)
      ), [row + '.toolrail-settings-share', row + '.toolrail-settings-load']);
    });
  }

  /**
   * Stop sharing a set: the server deletes its shared copy. The user's own
   * set, if they have one, stays.
   *
   * @param {Object}          item           The shared copy (normalized).
   * @param {string|string[]} focusSelectors Where focus goes after the
   *                                         dialog redraws.
   * @return {void}
   */
  function unshareSet(item, focusSelectors) {
    if (sharedSetBusy || !canFetchSharedSets()) {
      return;
    }
    var forget = function () {
      sharedSets = sharedSets.filter(function (existing) {
        return existing.id !== item.id;
      });
      reconcileSetsButton();
    };
    var request = sendSharedSetRequest({
      path: SHARED_SETS_PATH + '/' + item.id,
      method: 'DELETE'
    });
    if (!request) {
      return;
    }
    request.then(function () {
      sharedSetBusy = false;
      forget();
      reportSharedSet(sprintf(
        /* translators: %s: set name. */
        __('Stopped sharing the set "%s".', 'editrail'),
        item.name
      ), focusSelectors);
    }, function (err) {
      sharedSetBusy = false;
      // Gone already (another user or tab stopped it): say so, and drop it.
      if (err && err.code === 'rest_post_invalid_id') {
        forget();
        reportSharedSet(sprintf(
          /* translators: %s: set name. */
          __('The set "%s" is no longer shared.', 'editrail'),
          item.name
        ), focusSelectors);
        return;
      }
      reportSharedSet(sprintf(
        /* translators: 1: set name, 2: the reason, a full sentence. */
        __('The set "%1$s" is still shared. %2$s', 'editrail'),
        item.name,
        sharedSetErrorText(err)
      ), focusSelectors);
    });
  }

  /**
   * The share controls for one of the user's own set rows in Toolbar
   * settings: "Share" when the set is not shared and the user may share;
   * "Share again" when the shared copy is older than the set; "Stop
   * sharing" when the set is shared and the user may delete the copy.
   * A user who can do none of these gets no control, so the row is what
   * it was before #98.
   *
   * @param {string}      name Set name.
   * @param {Object|null} copy The user's shared copy, or null.
   * @return {Array<HTMLElement>} Buttons, in row order.
   */
  function ownSetShareControls(name, copy) {
    var out = [];
    var row = setRowSelector(name);
    if (!copy && canShareSets) {
      var share = T.settingsButton(__('Share', 'editrail'), function () {
        shareConfig(name);
      }, 'toolrail-settings-share');
      share.setAttribute('aria-label', sprintf(
        /* translators: %s: set name. */
        __('Share the set %s with other users on this site', 'editrail'),
        name
      ));
      out.push(share);
    }
    if (copy && canShareSets && sharedCopyIsOlder(name, copy)) {
      var again = T.settingsButton(__('Share again', 'editrail'), function () {
        shareConfig(name);
      }, 'toolrail-settings-share');
      again.setAttribute('aria-label', sprintf(
        /* translators: %s: set name. */
        __('Share again: replace the shared copy of the set %s with the set as it is now', 'editrail'),
        name
      ));
      out.push(again);
    }
    if (copy && copy.canDelete) {
      var stop = T.settingsButton(__('Stop sharing', 'editrail'), function () {
        unshareSet(copy, [row + '.toolrail-settings-share', row + '.toolrail-settings-load']);
      }, 'toolrail-settings-unshare');
      stop.setAttribute('aria-label', sprintf(
        /* translators: %s: set name. */
        __('Stop sharing the set %s', 'editrail'),
        name
      ));
      out.push(stop);
    }
    return out;
  }

  /**
   * One row of the "Shared sets" list in Toolbar settings: the name, who
   * shared it, Load, Export, and Stop sharing when the user may delete it.
   * Every accessible name carries "shared by …", so this row and one of
   * the user's own sets with the same name never sound the same.
   *
   * @param {Object} item      A normalized entry.
   * @param {Array}  neighbors The IDs of the rows after and before this
   *                           one, in that order: focus goes to the first
   *                           that remains after a stop.
   * @param {Object} tb        The toolbar chosen in the dialog: Load puts
   *                           the set into it, as an own set's Load does
   *                           (#95).
   * @return {HTMLElement} The list item.
   */
  function buildSharedSetRow(item, neighbors, tb) {
    var li = T.settingsRow('li', 'toolrail-settings-sharedrow');
    li.dataset.sharedId = String(item.id);
    var label = T.settingsRow('span', 'toolrail-settings-pinnedname');
    label.textContent = item.name;
    li.appendChild(label);
    var tag = T.settingsRow('span', 'toolrail-settings-tag toolrail-settings-sharedby');
    tag.textContent = sharedByText(item);
    li.appendChild(tag);

    var by = sharedByPhrase(item);
    var load = T.settingsButton(__('Load', 'editrail'), function () {
      // Into the chosen toolbar (#95), or the first one when a stored
      // change deleted it while the dialog was open (PR #126 review).
      var into = T.toolbars.indexOf(tb) === -1 ? mainToolbar : tb;
      applySet(item.blocks, item.labels, into);
      T.settingsStatus = configLoadedMessage(item.name, into);
      T.refreshSettings('#toolrail-settings-search');
    }, 'toolrail-settings-sharedload');
    // With several toolbars the name says which one Load fills, as an own
    // set's Load does.
    load.setAttribute('aria-label', T.toolbars.length > 1
      ? sprintf(
        /* translators: 1: set name, 2: "shared by <name>", 3: the toolbar's name. */
        __('Load the set %1$s, %2$s, into %3$s', 'editrail'),
        item.name,
        by,
        toolbarLabel(tb)
      )
      : sprintf(
        /* translators: 1: set name, 2: "shared by <name>". */
        __('Load the set %1$s, %2$s', 'editrail'),
        item.name,
        by
      ));
    li.appendChild(load);

    var exp = T.settingsButton(__('Export', 'editrail'), function () {
      T.downloadSetFile(T.setFilePayload(item.name, item.blocks, item.labels));
    }, 'toolrail-settings-sharedexport');
    exp.setAttribute('aria-label', sprintf(
      /* translators: 1: set name, 2: "shared by <name>". */
      __('Export the set %1$s, %2$s, as a file', 'editrail'),
      item.name,
      by
    ));
    li.appendChild(exp);

    if (item.canDelete) {
      var stop = T.settingsButton(__('Stop sharing', 'editrail'), function () {
        // The row goes: focus to the next row's Load, else the one
        // before, else the set name field above the lists.
        var targets = neighbors.map(function (id) {
          return '.toolrail-settings-sharedrow[data-shared-id="' + id + '"] .toolrail-settings-sharedload';
        });
        targets.push('#toolrail-settings-setname');
        unshareSet(item, targets);
      }, 'toolrail-settings-unshare');
      stop.setAttribute('aria-label', sprintf(
        /* translators: 1: set name, 2: "shared by <name>". */
        __('Stop sharing the set %1$s, %2$s', 'editrail'),
        item.name,
        by
      ));
      li.appendChild(stop);
    }
    return li;
  }

  // -------------------------------------------------------------------
  // Pattern catalog (0.1.23). A pinned slot may name a PATTERN as well
  // as a block type (owner decision 2026-09-02): 'pattern:<name>' for a
  // registered (core/theme/plugin) pattern, 'pattern:user:<post id>'
  // for one of the author's own (a wp_block post). Both come from
  // core-data through public selectors — the registered list resolves
  // over REST once per page, the user list is an ordinary entity query —
  // so nothing here depends on the inserter's private pattern store.
  // An armed pattern click inserts a fresh parse of its content; a
  // SYNCED user pattern inserts a reference block, exactly as the
  // inserter would.
  // -------------------------------------------------------------------

  var PATTERN_SLOT_PREFIX = 'pattern:';
  var USER_PATTERN_SLOT_PREFIX = 'pattern:user:';
  // The one query shape every read and refresh uses — core-data keys
  // its cache by it, so a second shape would be a second fetch. The
  // edit context is what carries the raw block markup.
  var USER_PATTERN_QUERY = { per_page: -1, context: 'edit' };
  /** Slot grammar for a pattern: user:<digits>, or namespace/name. */
  var PATTERN_SLOT_PATTERN = /^pattern:(user:[0-9]+|[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/i;

  /**
   * Whether a slot names a pattern rather than a block type. A cheap
   * prefix test for the hot paths; PATTERN_SLOT_PATTERN is the grammar
   * check for anything arriving from outside.
   *
   * @param {*} name Candidate slot name.
   * @return {boolean} True for a 'pattern:…' slot.
   */
  function isPatternSlot(name) {
    return typeof name === 'string' && name.indexOf(PATTERN_SLOT_PREFIX) === 0;
  }

  /**
   * The core-data store, or null when the data module is not present.
   * Every pattern read goes through it, so the whole catalog degrades to
   * empty rather than throwing in a context without wp.data.
   *
   * @return {Object|null} The store selectors, or null.
   */
  function coreSelect() {
    try {
      return wp.data && wp.data.select ? (wp.data.select('core') || null) : null;
    } catch (e) {
      return null;
    }
  }

  /** Registered patterns the inserter would offer (inserter !== false). */
  function registeredPatterns() {
    var sel = coreSelect();
    if (!sel || typeof sel.getBlockPatterns !== 'function') {
      return [];
    }
    var list;
    try {
      list = sel.getBlockPatterns();
    } catch (e) {
      return [];
    }
    return Array.isArray(list) ? list.filter(function (p) {
      return p && typeof p.name === 'string' && p.title && p.inserter !== false && typeof p.content === 'string';
    }) : [];
  }

  /**
   * Patterns saved this session through the add-to-toolbar dialog. A
   * fresh save lands in core-data's item table but not necessarily in
   * the query cache the list below reads, so they are merged in here
   * (deduped by id) rather than trusting that cache to notice.
   */
  var sessionUserPatterns = [];

  /**
   * The author's own patterns (wp_block posts) from the core store, with
   * anything saved this session merged in and deduped by id — a fresh save
   * lands in the item table before the query cache these read from.
   *
   * @return {Array<Object>} The records, possibly empty.
   */
  function userPatternRecords() {
    var sel = coreSelect();
    var list = [];
    if (sel && typeof sel.getEntityRecords === 'function') {
      try {
        list = sel.getEntityRecords('postType', 'wp_block', USER_PATTERN_QUERY) || [];
      } catch (e) {
        list = [];
      }
    }
    var seen = Object.create(null);
    return list.concat(sessionUserPatterns).filter(function (r) {
      if (!r || !r.id || seen[r.id]) {
        return false;
      }
      seen[r.id] = true;
      return true;
    });
  }

  /** A REST field that may be {raw, rendered} or a plain string. */
  function recordText(field) {
    if (field && typeof field === 'object') {
      if (typeof field.raw === 'string') {
        return field.raw;
      }
      return typeof field.rendered === 'string' ? field.rendered.replace(/<[^>]+>/g, '') : '';
    }
    return typeof field === 'string' ? field : '';
  }

  /**
   * One shape for both kinds: {id (the slot id), kind, name, postId,
   * title, content, synced}.
   */
  function userPatternDescriptor(r) {
    return {
      id: USER_PATTERN_SLOT_PREFIX + r.id,
      kind: 'user',
      name: 'core/block/' + r.id,
      postId: r.id,
      title: recordText(r.title) || sprintf(
        /* translators: %d: pattern post id. */
        __('Pattern %d', 'editrail'),
        r.id
      ),
      content: recordText(r.content),
      synced: r.wp_pattern_sync_status !== 'unsynced'
    };
  }

  /**
   * One registered (core, theme or plugin) pattern as a catalog
   * descriptor, in the same shape a user pattern takes so every consumer
   * handles one kind of object. Registered patterns are never synced: they
   * insert as a fresh parse of their markup.
   *
   * @param {Object} p A core getBlockPatterns() entry.
   * @return {Object} The descriptor.
   */
  function registeredPatternDescriptor(p) {
    return {
      id: PATTERN_SLOT_PREFIX + p.name,
      kind: 'registered',
      name: p.name,
      postId: 0,
      title: p.title,
      content: p.content,
      synced: false
    };
  }

  /** The author's own patterns first, then the theme's and core's. */
  function allPatterns() {
    return userPatternRecords().map(userPatternDescriptor)
      .concat(registeredPatterns().map(registeredPatternDescriptor));
  }

  /** The descriptor for a pattern slot id, or null when this site has
      no such pattern (or has not fetched it yet). */
  function findPattern(slotId) {
    if (!isPatternSlot(slotId)) {
      return null;
    }
    var found = null;
    allPatterns().forEach(function (p) {
      if (!found && p.id === slotId) {
        found = p;
      }
    });
    return found;
  }

  /** Both pattern lists have finished resolving (or cannot resolve at all). */
  function patternCatalogReady() {
    var sel = coreSelect();
    if (!sel || typeof sel.hasFinishedResolution !== 'function') {
      return true;
    }
    try {
      return sel.hasFinishedResolution('getBlockPatterns', [])
        && sel.hasFinishedResolution('getEntityRecords', ['postType', 'wp_block', USER_PATTERN_QUERY]);
    } catch (e) {
      return true;
    }
  }

  /** The blocks an armed pattern click (or a rail drag) inserts. */
  function patternBlocks(pattern) {
    if (pattern.kind === 'user' && pattern.synced) {
      return [wp.blocks.createBlock('core/block', { ref: pattern.postId })];
    }
    return wp.blocks.parse(pattern.content || '').filter(function (b) {
      return b && b.name;
    });
  }

  /**
   * Fetch both lists once per page load, then keep the rail in step with
   * the core store: a pinned pattern renders as soon as its list lands,
   * and drops out if its post is deleted. The subscription re-derives a
   * small signature (the registered count, plus each user pattern's id,
   * sync status and title) on every core store change — post edits live
   * there too, so that is per keystroke — and compares it with the last.
   * Cheap, but not free: which is why it is ids and titles, never
   * content. The capability check for creating patterns is kicked off
   * here too, so it has usually resolved before a dialog asks.
   */
  var patternCatalogStarted = false;
  var patternSignature = '';

  /**
   * A cheap fingerprint of both pattern lists — the registered count, plus
   * each user pattern's id, sync status and title. Deliberately ids and
   * titles only: this is re-derived on every core store change, which
   * includes each keystroke of a post edit, so hashing content would be a
   * real cost for no gain.
   *
   * @return {string} The signature.
   */
  function patternCatalogSignature() {
    return registeredPatterns().length + '|' + userPatternRecords().map(function (r) {
      return r.id + ':' + (r.wp_pattern_sync_status || '') + ':' + recordText(r.title);
    }).join(',');
  }

  /**
   * Start the pattern catalog: fetch both lists once, kick off the
   * create-pattern capability check so a dialog rarely has to wait for it,
   * then subscribe to the core store and rebuild when the signature moves.
   * The rebuild is skipped unless a pattern is pinned or the settings
   * dialog is open — a rebuild for nothing still moves focus out of the
   * rail. Idempotent; boot() and the dialogs all call it.
   */
  function watchPatternCatalog() {
    if (patternCatalogStarted) {
      return;
    }
    patternCatalogStarted = true;
    try {
      var rs = wp.data && wp.data.resolveSelect ? wp.data.resolveSelect('core') : null;
      if (rs) {
        if (typeof rs.getBlockPatterns === 'function') {
          rs.getBlockPatterns().then(null, function () {});
        }
        if (typeof rs.getEntityRecords === 'function') {
          rs.getEntityRecords('postType', 'wp_block', USER_PATTERN_QUERY).then(null, function () {});
        }
        if (typeof rs.canUser === 'function') {
          rs.canUser('create', { kind: 'postType', name: 'wp_block' }).then(null, function () {});
        }
      }
    } catch (e) {
      /* No core-data — pattern slots simply stay hidden. */
    }
    patternSignature = patternCatalogSignature();
    if (wp.data && typeof wp.data.subscribe === 'function') {
      try {
        wp.data.subscribe(function () {
          var next = patternCatalogSignature();
          if (next === patternSignature) {
            return;
          }
          patternSignature = next;
          T.patternMarkupCache = Object.create(null);
          // Only a pinned pattern (its tool may appear or vanish) or an
          // open settings search (its results) can change with the
          // catalog; anything else would be a rebuild for nothing, and
          // a rebuild moves focus when it was in the rail.
          var pinsPattern = T.toolbars.some(function (tb) {
            return loadSlots(tb).some(isPatternSlot);
          });
          if (!pinsPattern && !T.settingsOpen) {
            return;
          }
          window.dispatchEvent(new CustomEvent('toolrail:tools-updated'));
          rerenderToolbars();
          if (T.settingsOpen) {
            T.refreshSettings('#toolrail-settings-search');
          }
        }, 'core');
      } catch (e) {
        /* No store-scoped subscribe: the fetches above still land, the
           rail just shows their patterns on its next rebuild. */
      }
    }
  }

  /**
   * Pinned slots as tool descriptors. Unknown block types (their plugin is
   * deactivated) and patterns this site has not got — or has not fetched
   * yet — are SKIPPED, not deleted: reactivating, or the fetch landing,
   * restores them.
   *
   * @param {Object} tb The toolbar.
   * @return {Object[]} Its pinned slots as tool descriptors.
   */
  function slotTools(tb) {
    // One parse of the metadata map per rebuild, not one per slot: the
    // rail rebuilds on every slot change and on every settings click.
    var metaMap = loadPinMeta();
    return loadSlots(tb).map(function (name) {
      if (isPatternSlot(name)) {
        var pattern = findPattern(name);
        if (!pattern) {
          return null;
        }
        // The author's own name/description/icon for this pin, when set
        // (see the Pin metadata block), stand in for the pattern's.
        var patternMeta = metaMap[name] || null;
        var patternTitle = patternMeta && patternMeta.title ? patternMeta.title : pattern.title;
        return {
          id: 'pin:' + name,
          label: sprintf(
            /* translators: %s: pattern title. */
            __('%s (pinned pattern)', 'editrail'),
            patternTitle
          ),
          shortLabel: patternTitle,
          hint: patternMeta && patternMeta.description ? patternMeta.description : '',
          description: patternMeta && patternMeta.description ? patternMeta.description : '',
          icon: ICONS.pattern,
          customIcon: patternMeta && patternMeta.icon ? patternMeta.icon : '',
          blockIcon: null,
          insertBlock: '',
          createBlock: function () { return patternBlocks(pattern); },
          pinnedBlock: '',
          pinnedPattern: name,
          children: []
        };
      }
      var type = wp.blocks.getBlockType(name);
      if (!type) {
        return null;
      }
      var blockMeta = metaMap[name] || null;
      var blockTitle = blockMeta && blockMeta.title ? blockMeta.title : (type.title || name);
      return {
        id: 'pin:' + name,
        label: sprintf(
          /* translators: %s: block title. */
          __('%s (pinned block)', 'editrail'),
          blockTitle
        ),
        // Wide mode's visible row text: the block title alone — the
        // "(pinned block)" suffix reads noisy repeated down a rail, and
        // the accessible name (which keeps it) still contains the
        // visible text, so WCAG 2.5.3 Label in Name holds.
        shortLabel: blockTitle,
        // The tooltip carries the author's description or nothing. It
        // used to carry a generic how-to ("click in the canvas to
        // insert…"), and a screen reader reads `title` as the description,
        // so every pinned tool announced that sentence (SR-1, QA
        // 2026-09-11). The help panel is where the how-to lives.
        hint: blockMeta && blockMeta.description ? blockMeta.description : '',
        description: blockMeta && blockMeta.description ? blockMeta.description : '',
        icon: '',
        customIcon: blockMeta && blockMeta.icon ? blockMeta.icon : '',
        blockIcon: type.icon,
        insertBlock: name,
        pinnedBlock: name,
        children: []
      };
    }).filter(Boolean);
  }

  /**
   * Where a registered tool's `parent` may land besides a built-in id.
   * 'text'/'heading'/'image' were top-level built-ins before those became
   * default slots (2026-08-26), and 'section' followed on 2026-09-02
   * (it is the pinned Group now); the aliases keep every published
   * integration (the Typography Stylist handoff uses parent: 'text')
   * working against the slot that replaced them. Block names and full
   * slot ids are accepted too, so a provider can nest under ANY pinned
   * block: parent: 'core/paragraph' or parent: 'pin:core/paragraph'.
   */
  var PARENT_SLOT_ALIASES = {
    text: 'core/paragraph',
    heading: 'core/heading',
    image: 'core/image',
    section: 'core/group'
  };

  /**
   * Resolve a registered tool's `parent` to a pinned slot, accepting a
   * legacy alias, a block name, or the full slot id.
   *
   * @param {Array<Object>} slots  The rail model's slot entries.
   * @param {string}        parent The declared parent.
   * @return {Object|null} The slot to nest under, or null.
   */
  function slotForParent(slots, parent) {
    var wanted = Object.prototype.hasOwnProperty.call(PARENT_SLOT_ALIASES, parent)
      ? PARENT_SLOT_ALIASES[parent]
      : parent;
    var found = null;
    slots.forEach(function (slot) {
      if (slot.pinnedBlock === wanted || slot.id === wanted) {
        found = slot;
      }
    });
    return found;
  }

  /**
   * The full render model: built-ins (with registered children merged into
   * their flyouts), pinned slots, then registered top-level tools. Tools
   * whose `parent` names a built-in or registered top-level tool nest there;
   * an unknown parent falls back to top level rather than vanishing.
   *
   * That is the FIRST toolbar's model. An extra toolbar's model is its
   * pinned slots alone: the built-in tools and the top-level provider
   * tools are on the first toolbar only (owner decision 2026-11-14, #95).
   * A provider tool whose `parent` is a pinned slot nests under that slot
   * on each toolbar that shows it.
   *
   * @param {Object} tb The toolbar.
   * @return {Object} {tools, slots}.
   */
  function railModel(tb) {
    var first = tb === mainToolbar;
    var topLevel = (first ? BUILTIN_TOOLS : []).filter(function (t) {
      return !t.shelved;
    }).map(function (t) {
      return {
        id: t.id,
        label: t.label,
        hint: t.hint || '',
        icon: t.icon,
        select: !!t.select,
        insertBlock: t.insertBlock || '',
        createBlock: t.createBlock || null,
        // Built-ins may be toggles too (Section overview): pass their
        // onActivate/isActive through so syncPressed and the click
        // handler treat them exactly like a registered tool's.
        onActivate: t.onActivate || null,
        isActive: t.isActive || null,
        supports: t.supports || {},
        children: (t.children || []).slice()
      };
    });

    var slots = slotTools(tb);

    registered.forEach(function (t) {
      if (!first && !(t.parent && slotForParent(slots, t.parent))) {
        return;
      }
      if (t.parent) {
        var host = null;
        topLevel.forEach(function (candidate) {
          if (candidate.id === t.parent) {
            host = candidate;
          }
        });
        // Slots host children too — by alias ('text'), block name
        // ('core/paragraph') or slot id ('pin:core/paragraph').
        if (!host) {
          host = slotForParent(slots, t.parent);
        }
        if (host) {
          host.children.push(t);
          return;
        }
        // The parent can be a pin that only an extra toolbar shows. The
        // tool is in that pin's flyout there, so it is not unknown. That
        // holds while the toolbar is hidden too: the tool hides with its
        // parent, and does not move to the first toolbar.
        var elsewhere = T.toolbars.some(function (other) {
          return other !== mainToolbar && !!slotForParent(slotTools(other), t.parent);
        });
        if (elsewhere) {
          return;
        }
        warn('tool "' + t.id + '" names unknown parent "' + t.parent + '" — rendering at top level.');
      }
      topLevel.push({
        id: t.id,
        label: t.label,
        hint: '',
        icon: t.icon,
        select: false,
        insertBlock: t.insertBlock,
        createBlock: t.createBlock,
        onActivate: t.onActivate,
        isActive: t.isActive,
        supports: t.supports || {},
        children: []
      });
    });

    return { tools: topLevel, slots: slots };
  }

  /**
   * One top-level tool or pin of ONE toolbar's model, by id: the entry
   * that toolbar's button was built from, with that toolbar's flyout.
   *
   * @param {Object} tb The toolbar.
   * @param {string} id Tool id.
   * @return {Object|null} The model entry, or null.
   */
  function modelTool(tb, id) {
    var model = railModel(tb);
    var all = model.tools.concat(model.slots);
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) {
        return all[i];
      }
    }
    return null;
  }

  /**
   * One tool by id, searched across top-level tools, pinned slots and
   * every flyout child.
   *
   * @param {string} id Tool id.
   * @return {Object|null} The model entry, or null when no such tool.
   */
  function findTool(id) {
    var found = null;
    // Every SHOWN toolbar, the first one first. A hidden toolbar has no
    // buttons, so its tools cannot be armed or found.
    T.toolbars.forEach(function (tb) {
      if (found || tb.hidden) {
        return;
      }
      var model = railModel(tb);
      model.tools.concat(model.slots).forEach(function (t) {
        if (t.id === id) {
          found = t;
        }
        (t.children || []).forEach(function (c) {
          if (c.id === id) {
            found = c;
          }
        });
      });
    });
    return found;
  }

  // Shared with the other files of the rail (see editor-rail-core.js).
  T.BUILTIN_TOOLS = BUILTIN_TOOLS;
  T.registered = registered;
  T.warn = warn;
  T.attrValue = attrValue;
  T.toolSelector = toolSelector;
  T.registerTool = registerTool;
  T.DEFAULT_SLOTS = DEFAULT_SLOTS;
  T.normalizeSlots = normalizeSlots;
  T.migrateSlots = migrateSlots;
  T.loadSlots = loadSlots;
  T.saveSlots = saveSlots;
  T.isPinnedOn = isPinnedOn;
  T.isPinned = isPinned;
  T.isPinnedAnywhere = isPinnedAnywhere;
  T.pinBlock = pinBlock;
  T.unpinBlock = unpinBlock;
  T.moveSlot = moveSlot;
  T.apiToolbar = apiToolbar;
  T.unpinEverywhere = unpinEverywhere;
  T.rerenderToolbars = rerenderToolbars;
  T.rerenderMainForParents = rerenderMainForParents;
  T.PIN_META_LIMITS = PIN_META_LIMITS;
  T.announcePinMetaChange = announcePinMetaChange;
  T.DASHICON_NAMES = DASHICON_NAMES;
  T.isDashiconName = isDashiconName;
  T.isValidPinIcon = isValidPinIcon;
  T.normalizePinMeta = normalizePinMeta;
  T.hasAuthorFields = hasAuthorFields;
  T.getPinMeta = getPinMeta;
  T.setPinMeta = setPinMeta;
  T.getPinData = getPinData;
  T.setPinData = setPinData;
  T.clearPinMeta = clearPinMeta;
  T.loadConfigMeta = loadConfigMeta;
  T.normalizeSetMeta = normalizeSetMeta;
  T.setConfigMeta = setConfigMeta;
  T.loadConfigs = loadConfigs;
  T.persistConfigs = persistConfigs;
  T.saveConfig = saveConfig;
  T.loadConfig = loadConfig;
  T.deleteConfig = deleteConfig;
  T.isSetsButtonShown = isSetsButtonShown;
  T.reconcileSetsButton = reconcileSetsButton;
  T.configLoadedMessage = configLoadedMessage;
  T.setsMenuTool = setsMenuTool;
  T.isToolbarsButtonShown = isToolbarsButtonShown;
  T.reconcileToolbarsButton = reconcileToolbarsButton;
  T.toolbarShownMessage = toolbarShownMessage;
  T.toolbarsMenuTool = toolbarsMenuTool;
  T.isSetSlotName = isSetSlotName;
  T.refreshSharedSets = refreshSharedSets;
  T.ownSharedCopy = ownSharedCopy;
  T.listedSharedSets = listedSharedSets;
  T.ownSetShareControls = ownSetShareControls;
  T.buildSharedSetRow = buildSharedSetRow;
  T.PATTERN_SLOT_PREFIX = PATTERN_SLOT_PREFIX;
  T.USER_PATTERN_SLOT_PREFIX = USER_PATTERN_SLOT_PREFIX;
  T.isPatternSlot = isPatternSlot;
  T.coreSelect = coreSelect;
  T.sessionUserPatterns = sessionUserPatterns;
  T.userPatternDescriptor = userPatternDescriptor;
  T.allPatterns = allPatterns;
  T.findPattern = findPattern;
  T.patternCatalogReady = patternCatalogReady;
  T.watchPatternCatalog = watchPatternCatalog;
  T.railModel = railModel;
  T.modelTool = modelTool;
  T.findTool = findTool;

  // This file ran to its end. The next file checks this number.
  T.loaded = 2;
})(window.wp);
