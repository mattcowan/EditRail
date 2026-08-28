/**
 * Editor Tool Rail — a Photoshop-familiar left toolbar for the block editor.
 *
 * Unlike a launcher rail, tools here ARM: selecting a tool means the next
 * click in the canvas inserts that tool's block at the click point, then the
 * rail returns to Select (Shift-click keeps the tool armed). Every insertion
 * produces ordinary core blocks — deactivating this plugin changes nothing
 * about how authored content renders or edits.
 *
 * MOUNT STRATEGY (proven in the Background Candy Phase 0 spike): the rail is
 * inserted into the editor's own skeleton so it participates in the editor's
 * flex layout rather than overlapping the canvas; a debounced
 * MutationObserver re-mounts it across React re-renders (it survives the
 * code-editor round-trip, where the whole visual editor unmounts). Vanilla
 * DOM on purpose: the rail lives OUTSIDE the React tree it observes, so
 * React never reconciles it away.
 *
 * POSITION: the rail docks to the left edge by default, and can be moved to
 * the right edge (past the settings side panel), to a full-width bar at the
 * top or bottom, or torn off as a floating Photoshop-style palette. Drag it
 * by the grip and release near an edge to snap; the settings dialog carries
 * the equivalent keyboard path. Surfaces open away from the docked edge — a
 * top rail opens its flyouts downward, a bottom rail upward. See the
 * "Rail position" block below for where each dock hangs.
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
 *   })
 * Descriptors, not React nodes — the rail owns the roving tabindex.
 * Registry changes fire the 'toolrail:tools-updated' window event.
 */
(function (wp) {
  'use strict';

  if (!(window.wp && wp.data && wp.blocks)) {
    return;
  }

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

  var SLOTS_KEY = 'toolrail-quick-slots';
  var CONFIGS_KEY = 'toolrail-slot-configs';
  var POSITION_KEY = 'toolrail-position';
  var MIGRATED_KEY = 'toolrail-slots-migrated';
  var HELP_SEEN_KEY = 'toolrail-help-seen';
  var HELP_HIDDEN_KEY = 'toolrail-help-hidden';
  var WIDE_KEY = 'toolrail-wide';
  var WIDE_TOGGLE_KEY = 'toolrail-wide-toggle';
  var APPEARANCE_KEY = 'toolrail-appearance';
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

  function prefsDispatch() {
    try {
      return wp.data && wp.data.dispatch ? (wp.data.dispatch('core/preferences') || null) : null;
    } catch (e) {
      return null;
    }
  }

  var storageBroken = false;
  var memoryStore = Object.create(null);

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

  // Per-KEY latch: set when disp.set() has thrown once for that key — see
  // writeKey. Reads must honor it too, and only for that key: core's own
  // reducer never applies a failed write, so sel.get() would keep
  // returning the stale pre-write value forever for THIS key, while the
  // fallback write landed in memoryStore/localStorage instead — but every
  // OTHER key the store already holds is untouched by that failure and
  // must keep reading from the store, or a single bad write would wrongly
  // orphan everything else already saved there this session.
  var brokenPrefKeys = Object.create(null);

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
   */
  function migrateLocalToPrefs() {
    var sel = prefsSelect();
    if (!sel || !prefsDispatch()) {
      return;
    }
    // writeKey, not a raw dispatch: it owns the throwing-Storage guard.
    [POSITION_KEY, SLOTS_KEY, CONFIGS_KEY, MIGRATED_KEY].forEach(function (key) {
      if (sel.get(PREFS_SCOPE, key) !== undefined) {
        return;
      }
      var local = readLocalKey(key);
      if (local !== null) {
        writeKey(key, local);
      }
    });
  }

  // -------------------------------------------------------------------
  // Rail position — docked to an edge, or floating like a Photoshop
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
    left: __('Left edge', 'toolrail'),
    right: __('Right edge, past the side panel', 'toolrail'),
    top: __('Top, panels open downward', 'toolrail'),
    bottom: __('Bottom, panels open upward', 'toolrail'),
    float: __('Floating', 'toolrail')
  };

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

  // Defaults until boot() re-loads from storage — reads must wait for the
  // editor to attach the preferences persistence layer, and nothing
  // consumes `position` before mount anyway.
  var position = { dock: DEFAULT_DOCK, x: 24, y: 24 };

  function savePosition() {
    writeKey(POSITION_KEY, JSON.stringify(position));
  }

  /** Top and bottom docks lay the rail out as a horizontal bar. */
  function isVertical() {
    return position.dock !== 'top' && position.dock !== 'bottom';
  }

  function skeletonBody() {
    return document.querySelector('.interface-interface-skeleton__body');
  }

  function skeletonEditor() {
    return document.querySelector('.interface-interface-skeleton__editor');
  }

  /**
   * Where the region belongs for the current dock, as a parent plus the
   * node to insert before (null = append). Returns null when the editor
   * chrome for that dock is not on the page yet — mount() then retries.
   */
  function dockPlacement() {
    var body = skeletonBody();
    var editor = skeletonEditor();
    switch (position.dock) {
      case 'right':
      case 'float':
        return body ? { parent: body, before: null } : null;
      case 'top':
        return editor && body && body.parentNode === editor
          ? { parent: editor, before: body }
          : null;
      case 'bottom':
        return editor ? { parent: editor, before: null } : null;
      default:
        return body ? { parent: body, before: body.firstChild } : null;
    }
  }

  function isPlacedCorrectly(region, place) {
    if (region.parentNode !== place.parent) {
      return false;
    }
    // A left dock's `before` resolves to the region itself once it is the
    // first child — that is the placed state, not a move.
    return place.before === region || region.nextSibling === place.before;
  }

  // -------------------------------------------------------------------
  // Icons — inline SVG, currentColor, theme-agnostic (no dashicons dep).
  // -------------------------------------------------------------------

  var ICONS = {
    select: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6 3l12 9.4-5.2.8 3 5.9-2.4 1.2-3-5.9-3.9 3.6z"/></svg>',
    text: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M5 5h14v3h-2V7h-4v10h2v2H9v-2h2V7H7v1H5z"/></svg>',
    heading: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6 4h2.5v7h7V4H18v16h-2.5v-7h-7v7H6z"/></svg>',
    image: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zm1 2v10h14V7H5zm3 2a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm-2 7l3.5-4 2.5 3 2-2.5L18 16H6z"/></svg>',
    shape: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 3a6 6 0 015.2 9H21v9h-9v-6.8A6 6 0 019 3zm5 11.7a6 6 0 01-2 .3v5h7v-5h-5zM9 5a4 4 0 100 8 4 4 0 000-8z"/></svg>',
    section: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3 4h18v2H3V4zm2 4h14a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1V9a1 1 0 011-1zm1 2v4h12v-4H6zM3 18h18v2H3v-2z"/></svg>',
    overview: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3 4h13v4H3V4zm0 6h13v4H3v-4zm0 6h13v4H3v-4zm17.5-12L23 7.5h-1.5V11h-2V7.5H18L20.5 4zM20.5 20L18 16.5h1.5V13h2v3.5H23L20.5 20z"/></svg>',
    pin: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 2.3L6 8.7v6.6l6 3.4 6-3.4V8.7l-6-3.4zM12 8l3.5 2v4L12 16l-3.5-2v-4L12 8z"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 9a3 3 0 110 6 3 3 0 010-6zm-1.7-6h3.4l.5 2.4c.6.2 1.1.5 1.6.9l2.3-.8 1.7 3-1.8 1.6a6.7 6.7 0 010 1.8l1.8 1.6-1.7 3-2.3-.8c-.5.4-1 .7-1.6.9l-.5 2.4h-3.4l-.5-2.4a6.6 6.6 0 01-1.6-.9l-2.3.8-1.7-3 1.8-1.6a6.7 6.7 0 010-1.8L4.2 8.5l1.7-3 2.3.8c.5-.4 1-.7 1.6-.9L10.3 3z"/></svg>',
    help: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 4a5 5 0 015 5c0 2.3-1.5 3.3-2.7 4.1-.9.7-1.3 1.1-1.3 2.2h-2c0-2 1-2.9 2-3.7 1.1-.8 2-1.4 2-2.6a3 3 0 00-6 0H7a5 5 0 015-5zm-1 13h2v2.5h-2z"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8.6 5.4L10 4l8 8-8 8-1.4-1.4L15.2 12z"/></svg>'
  };

  // Every React root created for a pinned-block icon, so the previous
  // generation can be unmounted. A discarded root keeps its fiber tree
  // alive, and the rail rebuilds on every slot change (the ↑/↓ buttons in
  // the settings dialog rebuild it per click) — so these accumulate fast
  // unless they are disposed. buildRail() is the ONLY producer and always
  // creates a complete new set, which makes it the correct disposal point.
  var iconRoots = [];

  // The tools section's ResizeObserver, disposed on the same rule as the
  // icon roots: buildRail is the only producer, so it disconnects the
  // previous generation before creating the next.
  var railScrollObserver = null;

  function disposeIconRoots() {
    iconRoots.forEach(function (root) {
      try {
        root.unmount();
      } catch (e) {
        /* Already gone with its container — nothing to release. */
      }
    });
    iconRoots = [];
  }

  /**
   * Paint a block type's icon into a span. Block icons come in three
   * shapes: a dashicon slug string, {src: slug}, or {src: ReactElement/
   * component} (inline-SVG block.json icons arrive as the last) — the
   * React shapes render through wp.element so a pinned third-party block
   * shows its real icon instead of a generic glyph.
   */
  function renderBlockIcon(span, icon) {
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
        iconRoots.push(root);
        return;
      } catch (e) {
        /* Fall through to the generic glyph. */
      }
    }
    span.innerHTML = ICONS.pin;
  }

  // -------------------------------------------------------------------
  // Wide mode — icon + name rows on vertical docks and the floating
  // palette (left/right/float only; a label-per-tool row makes a
  // horizontal bar unusably long, so the toggle does not render there).
  // Purely visual: every aria-label already carries the name, so wide
  // mode changes nothing for assistive tech.
  // -------------------------------------------------------------------

  function isWide() {
    return readKey(WIDE_KEY) === '1';
  }

  /**
   * Whether the on-rail expander chevron renders. OPT-IN (owner decision
   * 2026-08-27): a permanent button at the rail's head spends prime
   * toolbar space, so the chevron is off until the author asks for it in
   * Toolbar settings — where the "Show tool names" checkbox is the
   * canonical (and keyboard) path to wide mode either way, making the
   * chevron pure quick-access sugar, like the drag grip is for docking.
   */
  function isWideToggleShown() {
    return readKey(WIDE_TOGGLE_KEY) === '1';
  }

  function setWide(on) {
    writeKey(WIDE_KEY, on ? '1' : '0');
    var region = document.getElementById('toolrail-region');
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
    applyFloatPosition();
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
    dark: __('Dark (default)', 'toolrail'),
    light: __('Light', 'toolrail'),
    gray: __('Gray', 'toolrail'),
    custom: __('Custom colors', 'toolrail')
  };

  /** Every token applyAppearance() manages — must match the stylesheet's
      var(--toolrail-…) vocabulary. */
  var APPEARANCE_TOKENS = [
    'bg', 'fg', 'fg-strong', 'muted', 'faint', 'grip', 'hover', 'edge',
    'border', 'field-bg', 'field-border', 'field-hover', 'pressed',
    'pressed-fg', 'pressed-edge', 'status', 'focus-ring'
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
      'status': '#1d3fc4', 'focus-ring': '#2145d6'
    },
    gray: {
      'bg': '#dcdcde', 'fg': '#1d2327', 'fg-strong': '#000000',
      'muted': '#3f474d', 'faint': '#4a5157', 'grip': '#5b636a',
      'hover': '#cbcbce', 'edge': '#8c8f94', 'border': '#8c8f94',
      'field-bg': '#e9e9ea', 'field-border': '#5b636a', 'field-hover': '#d0d0d3',
      'pressed': '#1d35b4', 'pressed-fg': '#ffffff', 'pressed-edge': '#1d35b4',
      'status': '#1d35b4', 'focus-ring': '#1d35b4'
    }
  };

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

  function rgbToHex(rgb) {
    return '#' + rgb.map(function (v) {
      var s = Math.round(Math.min(255, Math.max(0, v))).toString(16);
      return s.length === 1 ? '0' + s : s;
    }).join('');
  }

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
      'focus-ring': ring
    };
  }

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

  function saveAppearance(appearance) {
    writeKey(APPEARANCE_KEY, JSON.stringify(appearance));
  }

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
   * @param {HTMLElement} [region] Defaults to the mounted region.
   * @param {Object}      [tokens] Override token set — used by the color
   *                               inputs to preview a pair live without
   *                               persisting each intermediate value.
   */
  function applyAppearance(region, tokens) {
    region = region || document.getElementById('toolrail-region');
    if (!region) {
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
      label: __('Circle', 'toolrail'),
      icon: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="currentColor"/></svg>',
      createBlock: function () {
        return shapeSvgBlock('<circle cx="100" cy="100" r="96" fill="' + SHAPE_FILL + '"/>');
      }
    },
    {
      id: 'shape-rounded-rect',
      label: __('Rounded rectangle', 'toolrail'),
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
      label: __('Hexagon', 'toolrail'),
      icon: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2l8.7 5v10L12 22l-8.7-5V7z"/></svg>',
      createBlock: function () {
        return shapeSvgBlock('<polygon points="100,4 183,52 183,148 100,196 17,148 17,52" fill="' + SHAPE_FILL + '"/>');
      }
    },
    {
      id: 'shape-star',
      label: __('Star', 'toolrail'),
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

  // Text, Heading and Image are NOT built-ins — they ship as DEFAULT_SLOTS
  // (see loadSlots), so authors can reorder, remove and re-pin them like
  // any other block. Built-ins are only the tools no block type expresses:
  // Select, the Shape flyout, and Section.
  var BUILTIN_TOOLS = [
    {
      id: 'select',
      label: __('Select', 'toolrail'),
      icon: ICONS.select,
      select: true
    },
    {
      id: 'shape',
      label: __('Shape', 'toolrail'),
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
      id: 'section',
      label: __('Section', 'toolrail'),
      hint: __('click in the canvas to insert a group section; Shift-click keeps the tool active', 'toolrail'),
      icon: ICONS.section,
      createBlock: function () {
        return wp.blocks.createBlock('core/group', { layout: { type: 'constrained' } },
          [wp.blocks.createBlock('core/paragraph')]);
      }
    },
    {
      id: 'overview',
      label: __('Section overview', 'toolrail'),
      hint: __('zoom the canvas out and reorder sections; Enter a section to reorder the blocks inside it', 'toolrail'),
      icon: ICONS.overview,
      // A toggle, not an arming tool: reordering is an ordinary editing
      // action, so the deactivation promise is untouched (roadmap R6).
      onActivate: function () { toggleOverview(); },
      isActive: function () { return overviewOpen; }
    }
  ];

  // -------------------------------------------------------------------
  // Registry (registerTool) + quick slots (localStorage)
  // -------------------------------------------------------------------

  var registered = [];

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
  function toolSelector(id) {
    return '[data-tool="' + String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
  }

  function allToolIds() {
    // The rail's own chrome buttons are not tools, but they carry
    // data-tool ids the [data-tool="…"] sweeps can reach — a registered
    // tool must not be able to collide with them.
    var ids = ['settings', 'help', 'wide-toggle'];
    BUILTIN_TOOLS.forEach(function (t) {
      ids.push(t.id);
      (t.children || []).forEach(function (c) { ids.push(c.id); });
    });
    registered.forEach(function (t) { ids.push(t.id); });
    return ids;
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
      isActive: typeof descriptor.isActive === 'function' ? descriptor.isActive : null
    });

    window.dispatchEvent(new CustomEvent('toolrail:tools-updated'));
    rerender();
    return true;
  }

  /**
   * The out-of-the-box quick slots. Text, Heading and Image are ORDINARY
   * pinned blocks (owner decision 2026-08-26) — reorderable, removable,
   * and saved-set–able like anything the author pins.
   *
   * These seed exactly once, from migrateSlots(), and never again: an
   * author who removes all three stays at an empty rail rather than
   * having them resurrected on the next load.
   */
  var DEFAULT_SLOTS = ['core/paragraph', 'core/heading', 'core/image'];

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
  function migrateSlots() {
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

  // migrateSlots() runs from boot(), after migrateLocalToPrefs() — and
  // may run again from watchPersistenceAttach() if the persistence
  // layer's own attach lands late and wipes this pass.

  function loadSlots() {
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

  function saveSlots(slots) {
    writeKey(SLOTS_KEY, JSON.stringify(normalizeSlots(slots)));
  }

  function isPinned(blockName) {
    return loadSlots().indexOf(blockName) !== -1;
  }

  function pinBlock(blockName) {
    if (typeof blockName !== 'string' || blockName === '') {
      return false;
    }
    var slots = loadSlots();
    if (slots.indexOf(blockName) !== -1) {
      return false;
    }
    slots.push(blockName);
    saveSlots(slots);
    window.dispatchEvent(new CustomEvent('toolrail:tools-updated'));
    rerender();
    return true;
  }

  function unpinBlock(blockName) {
    var slots = loadSlots();
    var idx = slots.indexOf(blockName);
    if (idx === -1) {
      return false;
    }
    slots.splice(idx, 1);
    saveSlots(slots);
    window.dispatchEvent(new CustomEvent('toolrail:tools-updated'));
    rerender();
    return true;
  }

  /** Move a pinned slot up (-1) or down (+1) in the rail order. */
  function moveSlot(blockName, delta) {
    var slots = loadSlots();
    var idx = slots.indexOf(blockName);
    var to = idx + delta;
    if (idx === -1 || to < 0 || to >= slots.length) {
      return false;
    }
    slots.splice(idx, 1);
    slots.splice(to, 0, blockName);
    saveSlots(slots);
    window.dispatchEvent(new CustomEvent('toolrail:tools-updated'));
    rerender();
    return true;
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

  function persistConfigs(map) {
    writeKey(CONFIGS_KEY, JSON.stringify(map));
  }

  function saveConfig(name) {
    if (typeof name !== 'string' || name.trim() === '') {
      return false;
    }
    var map = loadConfigs();
    map[name.trim()] = loadSlots();
    persistConfigs(map);
    return true;
  }

  function loadConfig(name) {
    var map = loadConfigs();
    if (!Object.prototype.hasOwnProperty.call(map, name) || !Array.isArray(map[name])) {
      return false;
    }
    // saveSlots normalizes: a set stored by an older build, hand-edited,
    // or imported from a file can carry duplicates and non-strings.
    saveSlots(map[name]);
    window.dispatchEvent(new CustomEvent('toolrail:tools-updated'));
    rerender();
    return true;
  }

  function deleteConfig(name) {
    var map = loadConfigs();
    if (!Object.prototype.hasOwnProperty.call(map, name)) {
      return false;
    }
    delete map[name];
    persistConfigs(map);
    return true;
  }

  /**
   * Pinned slots as tool descriptors. Unknown block types (their plugin is
   * deactivated) are SKIPPED, not deleted — reactivating restores them.
   */
  function slotTools() {
    return loadSlots().map(function (name) {
      var type = wp.blocks.getBlockType(name);
      if (!type) {
        return null;
      }
      return {
        id: 'pin:' + name,
        label: sprintf(
          /* translators: %s: block title. */
          __('%s (pinned block)', 'toolrail'),
          type.title || name
        ),
        // Wide mode's visible row text: the block title alone — the
        // "(pinned block)" suffix reads noisy repeated down a rail, and
        // the accessible name (which keeps it) still contains the
        // visible text, so WCAG 2.5.3 Label in Name holds.
        shortLabel: type.title || name,
        hint: __('click in the canvas to insert; manage pinned blocks in Toolbar settings', 'toolrail'),
        icon: '',
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
   * default slots (2026-08-26); the aliases keep every published
   * integration (the Typography Stylist handoff uses parent: 'text')
   * working against the slot that replaced them. Block names and full
   * slot ids are accepted too, so a provider can nest under ANY pinned
   * block: parent: 'core/paragraph' or parent: 'pin:core/paragraph'.
   */
  var PARENT_SLOT_ALIASES = {
    text: 'core/paragraph',
    heading: 'core/heading',
    image: 'core/image'
  };

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
   */
  function railModel() {
    var topLevel = BUILTIN_TOOLS.filter(function (t) {
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
        children: (t.children || []).slice()
      };
    });

    var slots = slotTools();

    registered.forEach(function (t) {
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
        children: []
      });
    });

    return { tools: topLevel, slots: slots };
  }

  function findTool(id) {
    var found = null;
    var model = railModel();
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
    return found;
  }

  // -------------------------------------------------------------------
  // Armed-tool state + canvas insertion
  // -------------------------------------------------------------------

  var activeTool = 'select';

  function isArmingTool(tool) {
    return !!(tool && (tool.insertBlock || tool.createBlock));
  }

  function setActiveTool(id) {
    activeTool = id;
    syncPressed(true);
    markCanvasArmed();
  }

  function makeBlockFor(tool) {
    try {
      if (tool.createBlock) {
        return tool.createBlock();
      }
      if (tool.insertBlock && wp.blocks.getBlockType(tool.insertBlock)) {
        return wp.blocks.createBlock(tool.insertBlock);
      }
    } catch (e) {
      warn('tool "' + tool.id + '" failed to create its block: ' + e.message);
    }
    return null;
  }

  /**
   * Insert the armed tool's block at the click point: clicks resolve to the
   * nearest block, above its vertical midpoint inserts before it, below
   * inserts after; empty canvas space appends at the end of the document.
   * (Flow-document position — x/y freeform layout is a later phase.)
   */
  /**
   * clientIds present at pointerdown, before core has reacted to the
   * gesture at all. handleCanvasClick uses this to tell the block core
   * appended during THIS click from one the author already had.
   *
   * @type {Object|null}
   */
  var preGestureIds = null;

  /**
   * Bumped on every canvas gesture. sweepStrayDefaultBlock captures it and
   * its delayed passes bail once it moves, so a sweep can only ever act on
   * the gesture that scheduled it.
   *
   * @type {number}
   */
  var gestureGeneration = 0;

  function handleCanvasPointerdown() {
    // Bump FIRST and unconditionally: a gesture with Select active still
    // has to invalidate a pending sweep from the previous armed click,
    // because core's append is the author's intent under Select.
    gestureGeneration++;

    if (activeTool === 'select') {
      preGestureIds = null;
      return;
    }
    var ids = Object.create(null);
    wp.data.select('core/block-editor').getBlocks().forEach(function (b) {
      ids[b.clientId] = true;
    });
    preGestureIds = ids;
  }

  function handleCanvasClick(e) {
    if (activeTool === 'select') {
      return;
    }
    var tool = findTool(activeTool);
    if (!isArmingTool(tool)) {
      setActiveTool('select');
      return;
    }

    var block = makeBlockFor(tool);
    if (!block) {
      setActiveTool('select');
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    var sel = wp.data.select('core/block-editor');
    var dispatch = wp.data.dispatch('core/block-editor');
    var rootClientId = '';
    var index = sel.getBlockCount('');

    var target = e.target && e.target.closest ? e.target.closest('[data-block]') : null;
    if (target) {
      var clientId = target.getAttribute('data-block');
      rootClientId = sel.getBlockRootClientId(clientId) || '';
      index = sel.getBlockIndex(clientId);
      var rect = target.getBoundingClientRect();
      if (e.clientY > rect.top + rect.height / 2) {
        index += 1;
      }
    }

    // preGestureIds is captured at POINTERDOWN, not here. Core has
    // already appended its default block by the time this click handler
    // runs (measured: count 1 at pointerdown, 3 by the time a listener
    // registered after ours sees the click), so a snapshot taken here
    // would include the stray and the sweep would never match it.
    var knownIds = preGestureIds || (function () {
      var ids = Object.create(null);
      sel.getBlocks().forEach(function (b) { ids[b.clientId] = true; });
      return ids;
    }());
    preGestureIds = null;

    dispatch.insertBlocks(block, index, rootClientId);
    sweepStrayDefaultBlock(knownIds, block.clientId);

    if (!e.shiftKey) {
      setActiveTool('select');
    }
  }

  /**
   * Drop the empty default block core appends on a canvas click.
   *
   * Clicking the empty space below the content is core's "start a new
   * paragraph here" gesture, and it fires whatever the rail is doing —
   * preventDefault() and stopPropagation() on this click do NOT suppress
   * it (measured: with Heading armed on a one-paragraph document, one
   * click yields paragraph, EMPTY PARAGRAPH, heading; the same click with
   * Select armed yields paragraph, empty paragraph, which is core's own
   * behaviour and correct there). So every insert made by clicking empty
   * space left a stray empty paragraph above the block the author asked
   * for.
   *
   * Rather than race core for the event, let it run and reclaim the block
   * afterwards. The sweep is scoped as tightly as it can be: a block has
   * to have appeared during THIS click, not be the one the tool inserted,
   * be the site's default block type, and still be unmodified. Anything
   * pre-existing, and anything the author has typed into, is out of
   * scope.
   *
   * Two passes because core's append can land either synchronously in the
   * same event or on the next React flush; the second pass is a no-op
   * whenever the first already caught it.
   *
   * @param {Object} knownIds   clientIds present before the insert.
   * @param {string} insertedId clientId of the tool's own block.
   * @return {void}
   */
  function sweepStrayDefaultBlock(knownIds, insertedId) {
    // Only the CURRENT gesture may sweep. Both passes below are scheduled
    // against one click's knownIds, and that snapshot goes stale the
    // moment another canvas gesture starts — at which point a delayed
    // pass would be judging blocks it has no business judging:
    //
    //   shift-click to repeat  a second insert 40ms later is absent from
    //                          this call's knownIds, so an unmodified
    //                          default paragraph the author just asked
    //                          for looked exactly like a stray
    //   switch to Select       core's append is then the author's INTENT,
    //                          and a pending pass would delete it
    //
    // handleCanvasPointerdown bumps the generation on every canvas
    // gesture, armed or not, so both stale passes simply bail.
    var generation = gestureGeneration;

    var run = function () {
      if (generation !== gestureGeneration) {
        return;
      }
      var sel = wp.data.select('core/block-editor');
      if (!sel
        || typeof wp.blocks.getDefaultBlockName !== 'function'
        || typeof wp.blocks.isUnmodifiedDefaultBlock !== 'function') {
        return;
      }
      var defaultName = wp.blocks.getDefaultBlockName();
      if (!defaultName) {
        return;
      }
      var strays = sel.getBlocks().filter(function (b) {
        return b.clientId !== insertedId
          && !knownIds[b.clientId]
          && b.name === defaultName
          && wp.blocks.isUnmodifiedDefaultBlock(b);
      }).map(function (b) { return b.clientId; });

      if (!strays.length) {
        return;
      }
      // selectPrevious=false: removing the stray must not move the caret
      // off the block the tool just inserted.
      wp.data.dispatch('core/block-editor').removeBlocks(strays, false);
      if (sel.getBlock(insertedId)) {
        wp.data.dispatch('core/block-editor').selectBlock(insertedId);
      }
    };
    // The t=0 pass is the one that does the work in practice (measured:
    // core has already appended by the time our click handler runs). The
    // 80ms pass is a backstop for a slower machine where React batches the
    // append into a later flush; the generation guard is what makes
    // keeping it safe.
    window.setTimeout(run, 0);
    window.setTimeout(run, 80);
  }

  function handleCanvasKeydown(e) {
    if (e.key === 'Escape' && activeTool !== 'select') {
      setActiveTool('select');
    }
  }

  /**
   * The canvas is usually an iframe whose document is REPLACED after the
   * element is inserted (the editor-preview-context lesson), so binding is
   * re-checked from the mount observer and re-applied whenever the document
   * identity changes. Falls back to the content region for non-iframed
   * editors.
   */
  var boundDoc = null;

  function canvasDoc() {
    var iframe = document.querySelector('iframe[name="editor-canvas"]');
    if (iframe) {
      try {
        return iframe.contentDocument || null;
      } catch (e) {
        return null;
      }
    }
    var content = document.querySelector('.interface-interface-skeleton__content');
    return content ? content.ownerDocument : null;
  }

  function bindCanvas() {
    var doc = canvasDoc();
    if (!doc || doc === boundDoc) {
      return;
    }
    boundDoc = doc;
    doc.addEventListener('pointerdown', handleCanvasPointerdown, true);
    doc.addEventListener('click', handleCanvasClick, true);
    doc.addEventListener('keydown', handleCanvasKeydown, true);

    // Armed-cursor style lives INSIDE the canvas document.
    if (doc !== document && doc.head && !doc.getElementById('toolrail-canvas-style')) {
      var style = doc.createElement('style');
      style.id = 'toolrail-canvas-style';
      style.textContent = 'html.toolrail-armed, html.toolrail-armed * { cursor: crosshair !important; }';
      doc.head.appendChild(style);
    }
    markCanvasArmed();
  }

  function markCanvasArmed() {
    var doc = boundDoc || canvasDoc();
    if (doc && doc.documentElement) {
      doc.documentElement.classList.toggle('toolrail-armed', activeTool !== 'select');
    }
  }

  // -------------------------------------------------------------------
  // Flyouts (APG: parent button aria-haspopup; ArrowRight/click opens,
  // arrows move within, Escape returns focus to the parent)
  // -------------------------------------------------------------------

  var openFlyout = null;

  function closeFlyout(refocusParent) {
    if (!openFlyout) {
      return;
    }
    var parentBtn = openFlyout.parentBtn;
    openFlyout.node.remove();
    document.removeEventListener('mousedown', onDocMousedown, true);
    document.removeEventListener('keydown', onFlyoutKeydown, true);
    document.removeEventListener('focusin', onFlyoutFocusin, true);
    parentBtn.setAttribute('aria-expanded', 'false');
    openFlyout = null;
    syncLayer();
    if (refocusParent) {
      parentBtn.focus();
    }
  }

  function onDocMousedown(e) {
    if (openFlyout && !openFlyout.node.contains(e.target) && e.target !== openFlyout.parentBtn) {
      closeFlyout(false);
    }
  }

  // Same contract as the settings dialog, for the same reason: menu items
  // are tabIndex -1, so one Tab walked out of the flyout and left it open
  // with the parent still reporting aria-expanded="true" — and Escape,
  // bound to the menu node, could no longer reach it. Both listeners sit
  // on the document for as long as the flyout is open.
  function onFlyoutKeydown(e) {
    if (e.key !== 'Escape' || !openFlyout) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    closeFlyout(true);
  }

  function onFlyoutFocusin(e) {
    if (!openFlyout) {
      return;
    }
    if (openFlyout.node.contains(e.target) || e.target === openFlyout.parentBtn) {
      return;
    }
    closeFlyout(false);
  }

  function activateChild(child) {
    closeFlyout(false);
    if (child.onActivate) {
      try {
        child.onActivate();
      } catch (e) {
        warn('tool "' + child.id + '" onActivate threw: ' + e.message);
      }
      syncPressed(true);
      return;
    }
    setActiveTool(child.id);
  }

  /**
   * Place a floating surface (a flyout, or the settings dialog) beside the
   * rail, opening AWAY from the docked edge: to the right of a left rail,
   * to the left of a right rail, DOWN from a top rail, UP from a bottom
   * one. The surface must already be in the DOM — the overflow clamp
   * measures it.
   *
   * @param {HTMLElement} node    The surface.
   * @param {HTMLElement} anchor  Button to align with (falls back to the rail).
   * @param {HTMLElement} wrapper The positioned region the surface lives in.
   */
  function placeSurface(node, anchor, wrapper) {
    var wrapperRect = wrapper.getBoundingClientRect();
    var anchorRect = anchor ? anchor.getBoundingClientRect() : wrapperRect;

    node.style.top = '';
    node.style.right = '';
    node.style.bottom = '';
    node.style.left = '';

    if (position.dock === 'top') {
      node.style.top = 'calc(100% + 4px)';
      node.style.left = Math.max(0, anchorRect.left - wrapperRect.left) + 'px';
    } else if (position.dock === 'bottom') {
      node.style.bottom = 'calc(100% + 4px)';
      node.style.left = Math.max(0, anchorRect.left - wrapperRect.left) + 'px';
    } else if (position.dock === 'right') {
      node.style.right = 'calc(100% + 4px)';
      node.style.top = Math.max(0, anchorRect.top - wrapperRect.top) + 'px';
    } else {
      node.style.left = 'calc(100% + 4px)';
      node.style.top = Math.max(0, anchorRect.top - wrapperRect.top) + 'px';
    }

    // Pull back anything that would run off the viewport. Horizontal docks
    // clamp sideways, vertical docks clamp downward.
    var rect = node.getBoundingClientRect();
    if (isVertical()) {
      var overshootY = rect.bottom - window.innerHeight + 8;
      if (overshootY > 0 && node.style.top) {
        node.style.top = Math.max(0, parseFloat(node.style.top) - overshootY) + 'px';
      }
    } else {
      var overshootX = rect.right - window.innerWidth + 8;
      if (overshootX > 0) {
        node.style.left = Math.max(0, parseFloat(node.style.left) - overshootX) + 'px';
      }
    }
  }

  function openFlyoutFor(btn, tool, wrapper) {
    closeFlyout(false);
    if (!tool.children.length) {
      return;
    }

    var menu = document.createElement('div');
    menu.className = 'toolrail-flyout';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', tool.label);

    tool.children.forEach(function (child) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'toolrail-flyout-item';
      item.setAttribute('role', 'menuitem');
      item.dataset.tool = child.id;
      item.tabIndex = -1;
      if (child.icon) {
        var ic = document.createElement('span');
        ic.className = 'toolrail-flyout-icon';
        ic.innerHTML = child.icon;
        item.appendChild(ic);
      }
      var text = document.createElement('span');
      text.textContent = child.label;
      item.appendChild(text);
      item.addEventListener('click', function () {
        activateChild(child);
      });
      menu.appendChild(item);
    });

    menu.addEventListener('keydown', function (e) {
      var items = Array.prototype.slice.call(menu.querySelectorAll('.toolrail-flyout-item'));
      var idx = items.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(e.key) === -1) {
        return;
      }
      e.preventDefault();
      var next = e.key === 'ArrowDown' ? (idx + 1) % items.length
        : e.key === 'ArrowUp' ? (idx - 1 + items.length) % items.length
          : e.key === 'Home' ? 0 : items.length - 1;
      items[next].focus();
    });

    wrapper.appendChild(menu);
    placeSurface(menu, btn, wrapper);
    btn.setAttribute('aria-expanded', 'true');
    openFlyout = { node: menu, parentBtn: btn };
    syncLayer();
    document.addEventListener('mousedown', onDocMousedown, true);
    document.addEventListener('keydown', onFlyoutKeydown, true);
    document.addEventListener('focusin', onFlyoutFocusin, true);

    var first = menu.querySelector('.toolrail-flyout-item');
    if (first) {
      first.focus();
    }
  }

  // -------------------------------------------------------------------
  // Toolbar settings dialog — choose which blocks show as quick slots,
  // reorder them, and save/load named sets. All of it is a per-user
  // account preference, never site-wide settings or post data.
  // -------------------------------------------------------------------

  var settingsOpen = false;

  function insertableBlockTypes() {
    return wp.blocks.getBlockTypes().filter(function (t) {
      // Parent-restricted blocks (core/column etc.) can't insert at the
      // document root, which is where armed insertion lands them.
      return t && t.title && !t.parent && (!t.supports || t.supports.inserter !== false);
    });
  }

  function settingsNode() {
    return document.querySelector('.toolrail-settings');
  }

  function gearButton() {
    var rail = document.getElementById('toolrail-rail');
    return rail ? rail.querySelector('[data-tool="settings"]') : null;
  }

  /** Keep an open dialog truthful when slots change OUTSIDE it (a drag
      onto the rail, the block menu's pin item). Its own buttons refresh
      explicitly with a focus target, which runs after this and wins. */
  function onToolsUpdatedWhileOpen() {
    if (settingsOpen) {
      refreshSettings();
    }
  }

  function closeSettings(refocusGear) {
    var node = settingsNode();
    if (node) {
      node.remove();
    }
    settingsOpen = false;
    syncLayer();
    // Drop any message that never got rendered — closing the dialog
    // before an in-flight file read resolves used to strand it here, and
    // it then surfaced out of context the NEXT time settings was opened.
    // The appearance section's transient follows the same rule.
    settingsStatus = '';
    appearanceStatus = '';
    pinnedStatus = '';
    document.removeEventListener('mousedown', onSettingsMousedown, true);
    document.removeEventListener('keydown', onSettingsKeydown, true);
    document.removeEventListener('focusin', onSettingsFocusin, true);
    window.removeEventListener('toolrail:tools-updated', onToolsUpdatedWhileOpen);
    var gear = gearButton();
    if (gear) {
      gear.setAttribute('aria-expanded', 'false');
      if (refocusGear) {
        gear.focus();
      }
    }
  }

  function onSettingsMousedown(e) {
    var node = settingsNode();
    var gear = gearButton();
    if (node && !node.contains(e.target) && e.target !== gear && !(gear && gear.contains(e.target))) {
      closeSettings(false);
    }
  }

  // The dialog is a POPOVER, not a modal: the editor behind it stays
  // usable, so it gets no focus trap and no aria-modal. What it does need
  // is for the keyboard and the pointer to agree. An outside click always
  // dismissed it; leaving by Tab now dismisses it too.
  //
  // The bug this closes: Escape was bound to the dialog NODE, so one Tab
  // put focus in the editor canvas and the dialog was left open, still
  // claiming aria-expanded="true", with no keyboard route back to close
  // it. Both listeners now sit on the document for the dialog's lifetime.
  var refreshingSettings = false;

  function onSettingsKeydown(e) {
    if (e.key !== 'Escape' || !settingsOpen) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    closeSettings(true);
  }

  function onSettingsFocusin(e) {
    // refreshSettings empties and rebuilds the body; the focus churn in
    // between is ours, not the author leaving.
    if (!settingsOpen || refreshingSettings) {
      return;
    }
    var node = settingsNode();
    var gear = gearButton();
    if (!node || node.contains(e.target) || e.target === gear || (gear && gear.contains(e.target))) {
      return;
    }
    // Focus has genuinely moved on. Close, but do NOT pull it back — the
    // author is going somewhere on purpose.
    closeSettings(false);
  }

  function settingsRow(tag, className) {
    var el = document.createElement(tag);
    if (className) {
      el.className = className;
    }
    return el;
  }

  function settingsButton(label, onClick, className) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toolrail-settings-btn' + (className ? ' ' + className : '');
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /** A rebuilt control is only a usable focus target if it still exists,
      is enabled and is actually rendered. Restoring focus to a button that
      the rebuild just disabled (moving a slot to either end disables the
      arrow you clicked) silently leaves focus outside the dialog. */
  function focusableIn(node, selector) {
    if (!selector) {
      return null;
    }
    var el = node.querySelector(selector);
    if (!el || el.disabled || el.hidden) {
      return null;
    }
    return el.offsetParent === null && el !== document.body ? null : el;
  }

  /**
   * Rebuild the dialog's content, preserving both text fields, and hand
   * focus to the first candidate in `focusSelectors` that survives the
   * rebuild in a focusable state (search field as the last resort).
   *
   * @param {string|string[]} focusSelectors Ordered focus candidates.
   */
  function refreshSettings(focusSelectors) {
    var node = settingsNode();
    if (!node) {
      return;
    }

    // Both fields carry unsaved typing: an update triggered elsewhere
    // (pinning from the search results, a drag onto the rail) must not
    // discard a half-typed set name.
    var preserved = {};
    ['#toolrail-settings-search', '#toolrail-settings-setname'].forEach(function (sel) {
      var field = node.querySelector(sel);
      if (field) {
        preserved[sel] = field.value;
      }
    });

    refreshingSettings = true;
    node.textContent = '';
    buildSettingsContent(node, preserved['#toolrail-settings-search'] || '');

    var setName = node.querySelector('#toolrail-settings-setname');
    if (setName && preserved['#toolrail-settings-setname']) {
      setName.value = preserved['#toolrail-settings-setname'];
    }

    var candidates = Array.isArray(focusSelectors) ? focusSelectors.slice() : [focusSelectors];
    candidates.push('#toolrail-settings-search');
    var target = null;
    candidates.some(function (sel) {
      target = focusableIn(node, sel);
      return !!target;
    });
    if (target) {
      target.focus();
    }
    refreshingSettings = false;
  }

  /**
   * Position picker. Dragging the rail's grip is the pointer affordance;
   * this radio group is the equivalent keyboard and screen-reader path,
   * so repositioning never depends on a drag.
   */
  function buildPositionControl() {
    var fieldset = document.createElement('fieldset');
    fieldset.className = 'toolrail-settings-position';

    var legend = document.createElement('legend');
    legend.className = 'toolrail-settings-label';
    legend.textContent = __('Toolbar position', 'toolrail');
    fieldset.appendChild(legend);

    DOCKS.forEach(function (dock) {
      var row = settingsRow('label', 'toolrail-settings-positionrow');
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'toolrail-dock';
      input.value = dock;
      input.checked = position.dock === dock;
      input.dataset.dock = dock;
      input.addEventListener('change', function () {
        if (!input.checked) {
          return;
        }
        // The dock change rebuilds the region, so the dialog is reopened
        // with focus back on the radio the author just chose. A refused
        // dock leaves the radio showing a position the rail is not in, so
        // repaint the dialog from the real state instead.
        if (!setDock(dock, { reopenSettings: true })) {
          refreshSettings('input[data-dock="' + position.dock + '"]');
        }
      });
      row.appendChild(input);
      var text = settingsRow('span', '');
      text.textContent = DOCK_LABELS[dock];
      row.appendChild(text);
      fieldset.appendChild(row);
    });

    var hint = settingsRow('p', 'toolrail-settings-empty');
    hint.textContent = __('You can also drag the toolbar by the grip at its end; releasing near an edge snaps it there.', 'toolrail');
    fieldset.appendChild(hint);

    return fieldset;
  }

  /** The standard separator between the dialog's top-level sections. */
  function settingsDivider() {
    var hr = document.createElement('hr');
    hr.className = 'toolrail-settings-divider';
    return hr;
  }

  /**
   * Wide-mode controls. The checkbox here is the CANONICAL path to wide
   * mode (keyboard-first, like the position radios); the on-rail
   * chevron is opt-in sugar that spends toolbar space only when asked
   * for (owner decision 2026-08-27). Both persist per user.
   */
  function buildWideControl() {
    var fieldset = document.createElement('fieldset');
    fieldset.className = 'toolrail-settings-widegroup';

    var legend = document.createElement('legend');
    legend.className = 'toolrail-settings-label';
    legend.textContent = __('Tool names', 'toolrail');
    fieldset.appendChild(legend);

    var wideRow = settingsRow('label', 'toolrail-settings-positionrow');
    var wideInput = document.createElement('input');
    wideInput.type = 'checkbox';
    wideInput.id = 'toolrail-settings-wide';
    wideInput.checked = isWide();
    wideInput.addEventListener('change', function () {
      setWide(wideInput.checked);
    });
    var wideText = settingsRow('span', '');
    wideText.textContent = __('Show tool names beside the icons (wide toolbar)', 'toolrail');
    wideRow.appendChild(wideInput);
    wideRow.appendChild(wideText);
    fieldset.appendChild(wideRow);

    var toggleRow = settingsRow('label', 'toolrail-settings-positionrow');
    var toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.id = 'toolrail-settings-widetoggle';
    toggleInput.checked = isWideToggleShown();
    toggleInput.addEventListener('change', function () {
      writeKey(WIDE_TOGGLE_KEY, toggleInput.checked ? '1' : '0');
      // The chevron enters or leaves the rail — rebuild it. Focus stays
      // on this checkbox (rerender only moves focus when it was IN the
      // rail).
      rerender();
    });
    var toggleText = settingsRow('span', '');
    toggleText.textContent = __('Show an expand/contract button on the toolbar', 'toolrail');
    toggleRow.appendChild(toggleInput);
    toggleRow.appendChild(toggleText);
    fieldset.appendChild(toggleRow);

    // Both preferences persist on every dock; the effect shows where
    // wide mode applies. Stated rather than disabling the controls —
    // a disabled checkbox hides its state.
    var hint = settingsRow('p', 'toolrail-settings-empty');
    hint.textContent = __('Tool names show on left, right and floating toolbars.', 'toolrail');
    fieldset.appendChild(hint);

    return fieldset;
  }

  /** One line reporting the custom pair's contrast, warning below 4.5:1
      — the pair is applied either way (the author's choice, stated
      honestly), with the ring and pressed markers auto-derived so state
      visibility never drops below 3:1. */
  function pairContrastMessage(appearance) {
    var ratio = contrastRatio(hexToRgb(appearance.bg), hexToRgb(appearance.fg));
    // Floor, never round: a pair in the [4.495, 4.5) window rounded up
    // to "4.5:1" while the raw ratio still tripped the sub-threshold
    // branch, producing "These colors measure 4.5:1, below the 4.5:1
    // minimum" (review 2026-08-27). Flooring keeps the shown value
    // consistent with the branch and never displays a failing pair at
    // the threshold.
    var formatted = (Math.floor(ratio * 100) / 100) + ':1';
    if (ratio < 4.5) {
      return sprintf(
        /* translators: %s: measured contrast ratio, e.g. "2.5:1". */
        __('These colors measure %s, below the 4.5:1 minimum for text. They are applied anyway; the focus ring and pressed markers are adjusted automatically and stay at 3:1 or better.', 'toolrail'),
        formatted
      );
    }
    return sprintf(
      /* translators: %s: measured contrast ratio, e.g. "12.6:1". */
      __('Custom colors applied. Text contrast is %s.', 'toolrail'),
      formatted
    );
  }

  /**
   * One transient outcome line for the APPEARANCE section, consumed by
   * its next render — the appearance twin of settingsStatus. It gets its
   * OWN node inside the fieldset because the shared
   * #toolrail-settings-status sits under Saved sets AND is bound as the
   * import file input's accessible description: a contrast warning
   * written there appeared far from the swatches it was about, and a
   * screen-reader user tabbing to Import heard it read as that
   * control's description (review 2026-08-26).
   */
  var appearanceStatus = '';

  /**
   * The Pinned-blocks section's transient outcome line — same contract
   * as appearanceStatus (its own node beside the controls it reports
   * on, rendered + spoken by the next build, cleared on close). Carries
   * the "Restore default tools" outcome.
   */
  var pinnedStatus = '';

  /**
   * Appearance picker: three contrast-verified presets plus a custom
   * background + text pair. A preset switch re-renders the dialog (the
   * color inputs enable only under Custom); the color inputs apply live
   * on `input` and persist + report on `change` WITHOUT a rebuild —
   * refreshing mid-interaction would dismiss the native color picker.
   */
  function buildAppearanceControl() {
    // Its OWN class, not .toolrail-settings-position — the dock radios
    // are counted and queried through that class, so sharing it would
    // sweep these radios into the position picker's selectors.
    var fieldset = document.createElement('fieldset');
    fieldset.className = 'toolrail-settings-appearance';

    var legend = document.createElement('legend');
    legend.className = 'toolrail-settings-label';
    legend.textContent = __('Appearance', 'toolrail');
    fieldset.appendChild(legend);

    var current = loadAppearance();

    APPEARANCE_MODES.forEach(function (mode) {
      var row = settingsRow('label', 'toolrail-settings-positionrow');
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'toolrail-appearance';
      input.value = mode;
      input.checked = current.mode === mode;
      input.dataset.appearance = mode;
      input.addEventListener('change', function () {
        if (!input.checked) {
          return;
        }
        var appearance = loadAppearance();
        appearance.mode = mode;
        saveAppearance(appearance);
        applyAppearance();
        if (mode === 'custom') {
          appearanceStatus = pairContrastMessage(appearance);
        }
        refreshSettings('input[data-appearance="' + mode + '"]');
      });
      row.appendChild(input);
      var text = settingsRow('span', '');
      text.textContent = APPEARANCE_LABELS[mode];
      row.appendChild(text);
      fieldset.appendChild(row);
    });

    var inputs = {};
    [
      { key: 'bg', id: 'toolrail-settings-appearance-bg', label: __('Background color', 'toolrail') },
      { key: 'fg', id: 'toolrail-settings-appearance-fg', label: __('Text color', 'toolrail') }
    ].forEach(function (spec) {
      var row = settingsRow('label', 'toolrail-settings-colorrow');
      var text = settingsRow('span', 'toolrail-settings-colortext');
      text.textContent = spec.label;
      var input = document.createElement('input');
      input.type = 'color';
      input.id = spec.id;
      input.className = 'toolrail-settings-color';
      input.value = current[spec.key];
      // Rendered even while a preset is active (disabled), so the pair
      // is visible and the dialog's shape never jumps.
      input.disabled = current.mode !== 'custom';
      inputs[spec.key] = input;
      row.appendChild(text);
      row.appendChild(input);
      fieldset.appendChild(row);
    });

    // The section's own outcome line, right under the swatches it
    // reports on. Same render-and-speak contract as the Saved-sets
    // status; deliberately NOT the shared #toolrail-settings-status
    // (see appearanceStatus above).
    var status = settingsRow('p', 'toolrail-settings-status');
    status.id = 'toolrail-settings-appearance-status';
    status.textContent = appearanceStatus;
    fieldset.appendChild(status);
    if (appearanceStatus) {
      speak(appearanceStatus);
    }
    appearanceStatus = '';

    ['bg', 'fg'].forEach(function (key) {
      // Live preview while the native picker is open — not persisted;
      // the change event persists the settled pair.
      inputs[key].addEventListener('input', function () {
        applyAppearance(null, deriveAppearanceTokens(inputs.bg.value, inputs.fg.value));
      });
      inputs[key].addEventListener('change', function () {
        var appearance = { mode: 'custom', bg: inputs.bg.value, fg: inputs.fg.value };
        saveAppearance(appearance);
        applyAppearance();
        // Update the status text in place (a dialog rebuild here would
        // close the native picker and drop focus); speak() owns the
        // announcement.
        var msg = pairContrastMessage(appearance);
        status.textContent = msg;
        speak(msg);
      });
    });

    return fieldset;
  }

  // -------------------------------------------------------------------
  // Saved-set import/export. Sets travel as small JSON files so a set
  // built on one site works on another — including a site whose theme or
  // plugins don't register some of the blocks. Unavailable blocks are
  // KEPT in the set and simply don't render until their provider is
  // active (the same skip-not-delete rule the rail applies to slots).
  // -------------------------------------------------------------------

  /** WP block-name grammar: namespace/name, lowercase alnum + dashes. */
  var BLOCK_NAME_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

  /**
   * One transient outcome line, consumed by the next settings render: it
   * is painted as visible text in the dialog and announced via speak().
   * Cleared on close so it cannot surface out of context later.
   */
  var settingsStatus = '';

  function missingBlockCount(blocks) {
    return blocks.filter(function (name) {
      return !wp.blocks.getBlockType(name);
    }).length;
  }

  function exportConfig(name) {
    var map = loadConfigs();
    if (!Object.prototype.hasOwnProperty.call(map, name)) {
      return false;
    }
    var payload = {
      format: 'toolrail-set',
      version: 1,
      name: name,
      blocks: map[name]
    };
    var slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'set';
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'toolrail-set-' + slug + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return true;
  }

  /**
   * Validate + store a parsed import. Returns a result object; never
   * throws. Invalid block-name entries are dropped (they could not be
   * looked up or rendered anyway); a name collision gets a " (2)" suffix
   * rather than silently overwriting the author's existing set.
   */
  function importConfigPayload(parsed) {
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.blocks)) {
      return { ok: false, error: __('Not a Toolrail set file — expected JSON with a "blocks" array.', 'toolrail') };
    }
    var valid = parsed.blocks.filter(function (n) {
      return typeof n === 'string' && BLOCK_NAME_PATTERN.test(n);
    });
    var dropped = parsed.blocks.length - valid.length;
    // A set file is hand-editable and hand-writable, so it can repeat a
    // block name. Two slots sharing one `pin:<name>` tool id break the
    // rail (see normalizeSlots), so collapse them here and report the
    // collapse separately from genuinely invalid entries.
    var blocks = normalizeSlots(valid);
    var duplicates = valid.length - blocks.length;

    var base = typeof parsed.name === 'string' && parsed.name.trim() !== ''
      ? parsed.name.trim()
      : __('Imported set', 'toolrail');
    var map = loadConfigs();
    var name = base;
    var n = 2;
    while (Object.prototype.hasOwnProperty.call(map, name)) {
      name = base + ' (' + n + ')';
      n++;
    }

    map[name] = blocks;
    persistConfigs(map);

    return {
      ok: true,
      name: name,
      total: blocks.length,
      missing: missingBlockCount(blocks),
      dropped: dropped,
      duplicates: duplicates
    };
  }

  function importStatusMessage(result) {
    var msg = sprintf(
      /* translators: 1: set name, 2: block count. */
      _n('Imported "%1$s" (%2$d block).', 'Imported "%1$s" (%2$d blocks).', result.total, 'toolrail'),
      result.name,
      result.total
    );
    if (result.missing > 0) {
      msg += ' ' + sprintf(
        /* translators: %d: count of blocks not registered on this site. */
        _n(
          '%d of them is not available on this site — it stays in the set and appears when its plugin or theme is active.',
          '%d of them are not available on this site — they stay in the set and appear when their plugin or theme is active.',
          result.missing,
          'toolrail'
        ),
        result.missing
      );
    }
    if (result.duplicates > 0) {
      msg += ' ' + sprintf(
        /* translators: %d: count of repeated block names collapsed to one. */
        _n('%d repeated block was listed once.', '%d repeated blocks were listed once.', result.duplicates, 'toolrail'),
        result.duplicates
      );
    }
    if (result.dropped > 0) {
      msg += ' ' + sprintf(
        /* translators: %d: count of invalid entries. */
        _n('%d invalid entry was ignored.', '%d invalid entries were ignored.', result.dropped, 'toolrail'),
        result.dropped
      );
    }
    return msg;
  }

  function buildSettingsContent(node, searchValue) {
    var head = settingsRow('div', 'toolrail-settings-head');
    var title = settingsRow('h2', 'toolrail-settings-title');
    title.textContent = __('Toolbar settings', 'toolrail');
    title.id = 'toolrail-settings-title';
    head.appendChild(title);
    var close = settingsButton('×', function () { closeSettings(true); }, 'toolrail-settings-close');
    close.setAttribute('aria-label', __('Close toolbar settings', 'toolrail'));
    head.appendChild(close);
    node.appendChild(head);

    var note = settingsRow('p', 'toolrail-settings-note');
    note.textContent = __('Pinned blocks appear on the toolbar as quick-insert tools. They are saved to your account on this site, for you only.', 'toolrail');
    node.appendChild(note);

    node.appendChild(buildPositionControl());
    node.appendChild(settingsDivider());
    node.appendChild(buildWideControl());
    node.appendChild(settingsDivider());
    node.appendChild(buildAppearanceControl());
    node.appendChild(settingsDivider());

    // --- Pinned blocks, THEN Add a block (one section, this order on
    // purpose: the list shows what is already on the toolbar, the
    // search below adds to it, and a new pin lands at the BOTTOM of the
    // list — right above the search that added it, owner decision
    // 2026-08-27) ---
    var pinnedHead = settingsRow('h3', 'toolrail-settings-subtitle');
    pinnedHead.textContent = __('Pinned blocks', 'toolrail');
    node.appendChild(pinnedHead);

    var pinnedList = settingsRow('ul', 'toolrail-settings-pinned');
    var slots = loadSlots();
    if (!slots.length) {
      var empty = settingsRow('p', 'toolrail-settings-empty');
      empty.textContent = __('Nothing pinned yet.', 'toolrail');
      node.appendChild(empty);
    }
    slots.forEach(function (name, i) {
      var type = wp.blocks.getBlockType(name);
      var li = settingsRow('li', 'toolrail-settings-pinnedrow');
      var label = settingsRow('span', 'toolrail-settings-pinnedname');
      label.textContent = type ? type.title : name + ' ' + __('(inactive)', 'toolrail');
      li.appendChild(label);

      // Reaching either end disables the arrow that was just clicked, so
      // each handler offers the opposite arrow on the same row as its
      // second choice — focus stays on the row the author is moving.
      var row = '.toolrail-settings-pinnedrow[data-block="' + name + '"] ';

      var up = settingsButton('↑', function () {
        if (moveSlot(name, -1)) {
          refreshSettings([row + '.toolrail-settings-up', row + '.toolrail-settings-down']);
        }
      }, 'toolrail-settings-up');
      up.setAttribute('aria-label', sprintf(__('Move %s up', 'toolrail'), label.textContent));
      up.disabled = i === 0;
      li.appendChild(up);

      var down = settingsButton('↓', function () {
        if (moveSlot(name, 1)) {
          refreshSettings([row + '.toolrail-settings-down', row + '.toolrail-settings-up']);
        }
      }, 'toolrail-settings-down');
      down.setAttribute('aria-label', sprintf(__('Move %s down', 'toolrail'), label.textContent));
      down.disabled = i === slots.length - 1;
      li.appendChild(down);

      // Visible text is "Unpin", not "Remove", so that it is contained in
      // the accessible name "Unpin <block>" (WCAG 2.5.3 Label in Name).
      // With "Remove" on screen and "Unpin Paragraph" as the name, a
      // speech-input user saying "click Remove" matched nothing. It also
      // matches the wording of the block menu's own Unpin item.
      var remove = settingsButton(__('Unpin', 'toolrail'), function () {
        unpinBlock(name);
        refreshSettings('#toolrail-settings-search');
      }, 'toolrail-settings-remove');
      remove.setAttribute('aria-label', sprintf(__('Unpin %s', 'toolrail'), label.textContent));
      li.appendChild(remove);

      li.dataset.block = name;
      pinnedList.appendChild(li);
    });
    if (slots.length) {
      node.appendChild(pinnedList);
    }

    // The section's own outcome line (see pinnedStatus): rendered as
    // text right under the list it reports on; speak() announces it.
    var pinnedStatusNode = settingsRow('p', 'toolrail-settings-status');
    pinnedStatusNode.id = 'toolrail-settings-pinned-status';
    pinnedStatusNode.textContent = pinnedStatus;
    node.appendChild(pinnedStatusNode);
    if (pinnedStatus) {
      speak(pinnedStatus);
    }
    pinnedStatus = '';

    // "Restore default tools" closes a first-run dead end (roadmap R6):
    // loadSlots deliberately never re-seeds after the migration stamp,
    // so an author who unpinned Text/Heading/Image while exploring had
    // no way back short of searching for each by name. This APPENDS
    // only the DEFAULT_SLOTS currently missing, in DEFAULT_SLOTS order,
    // and leaves every pin the author chose exactly where it is —
    // restoring is never a reset. The migration stamp is untouched: its
    // meaning ("the one-time upgrade has run") is unrelated, and
    // clearing it would re-arm the upgrade path.
    var restoreRow = settingsRow('div', 'toolrail-settings-restorerow');
    restoreRow.appendChild(settingsButton(__('Restore default tools', 'toolrail'), function () {
      // A corrupt stored list must not be silently replaced (review
      // 2026-08-27, finding 3): loadSlots() returns [] for key-absent,
      // key-empty AND unparseable alike, and "restore" overwriting a
      // corrupt-but-still-stored value would be a reset wearing
      // restore's label. Bail with an honest message instead.
      var raw = readKey(SLOTS_KEY);
      if (raw !== null) {
        var parseFailed = false;
        try {
          JSON.parse(raw);
        } catch (err) {
          parseFailed = true;
        }
        if (parseFailed) {
          pinnedStatus = __('Your saved pinned list could not be read, so nothing was changed. Pin a block or load a saved set to start a fresh list.', 'toolrail');
          refreshSettings('.toolrail-settings-restore');
          return;
        }
      }
      var current = loadSlots();
      var missing = DEFAULT_SLOTS.filter(function (name) {
        return current.indexOf(name) === -1;
      });
      if (!missing.length) {
        // Say so rather than silently no-op'ing.
        pinnedStatus = __('All default tools are already pinned.', 'toolrail');
        refreshSettings('.toolrail-settings-restore');
        return;
      }
      saveSlots(current.concat(missing));
      window.dispatchEvent(new CustomEvent('toolrail:tools-updated'));
      rerender();
      pinnedStatus = sprintf(
        /* translators: %d: number of default tools restored. */
        _n('Restored %d default tool.', 'Restored %d default tools.', missing.length, 'toolrail'),
        missing.length
      );
      refreshSettings('.toolrail-settings-restore');
    }, 'toolrail-settings-restore'));
    node.appendChild(restoreRow);

    // --- Add a block ---
    var searchLabel = settingsRow('label', 'toolrail-settings-label');
    searchLabel.setAttribute('for', 'toolrail-settings-search');
    searchLabel.textContent = __('Add a block', 'toolrail');
    node.appendChild(searchLabel);

    var search = document.createElement('input');
    search.type = 'search';
    search.id = 'toolrail-settings-search';
    search.className = 'toolrail-settings-search';
    search.placeholder = __('Search block types…', 'toolrail');
    search.value = searchValue || '';
    node.appendChild(search);

    var results = settingsRow('div', 'toolrail-settings-results');
    results.id = 'toolrail-settings-results';
    node.appendChild(results);

    function renderResults() {
      results.textContent = '';
      var term = search.value.trim().toLowerCase();
      var pinned = loadSlots();
      var matches = insertableBlockTypes().filter(function (t) {
        if (pinned.indexOf(t.name) !== -1) {
          return false;
        }
        if (!term) {
          return false;
        }
        return t.title.toLowerCase().indexOf(term) !== -1 || t.name.toLowerCase().indexOf(term) !== -1;
      }).slice(0, 12);

      if (!term) {
        var hint = settingsRow('p', 'toolrail-settings-empty');
        hint.textContent = __('Type to search the available block types.', 'toolrail');
        results.appendChild(hint);
        return;
      }
      if (!matches.length) {
        var none = settingsRow('p', 'toolrail-settings-empty');
        none.textContent = __('No matching blocks.', 'toolrail');
        results.appendChild(none);
        return;
      }
      matches.forEach(function (t) {
        var btn = settingsButton(t.title, function () {
          pinBlock(t.name);
          refreshSettings('#toolrail-settings-search');
        }, 'toolrail-settings-result');
        btn.setAttribute('aria-label', sprintf(
          /* translators: %s: block title. */
          __('Pin %s to the toolbar', 'toolrail'),
          t.title
        ));
        btn.dataset.block = t.name;
        results.appendChild(btn);
      });
    }
    search.addEventListener('input', renderResults);
    renderResults();

    // --- Saved sets ---
    node.appendChild(settingsDivider());
    var setsHead = settingsRow('h3', 'toolrail-settings-subtitle');
    setsHead.textContent = __('Saved sets', 'toolrail');
    node.appendChild(setsHead);

    // Import/load outcomes land here in TEXT (never color/glyph alone).
    //
    // This node is NOT the live region. refreshSettings rebuilds the whole
    // dialog body, so a role="status" here was destroyed and recreated on
    // every render, and a live region that enters the DOM with its text
    // already in it does not announce — the message was visual-only. The
    // announcement goes through wp.a11y.speak() instead, which owns
    // persistent regions that outlive any rebuild of ours.
    var status = settingsRow('p', 'toolrail-settings-status');
    status.id = 'toolrail-settings-status';
    status.textContent = settingsStatus;
    node.appendChild(status);
    if (settingsStatus) {
      speak(settingsStatus);
    }
    settingsStatus = '';

    var saveRow = settingsRow('div', 'toolrail-settings-saverow');
    var nameLabel = settingsRow('label', 'toolrail-settings-label');
    nameLabel.setAttribute('for', 'toolrail-settings-setname');
    nameLabel.textContent = __('Save the current set as', 'toolrail');
    node.appendChild(nameLabel);

    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'toolrail-settings-setname';
    nameInput.className = 'toolrail-settings-search';
    saveRow.appendChild(nameInput);
    saveRow.appendChild(settingsButton(__('Save set', 'toolrail'), function () {
      if (saveConfig(nameInput.value)) {
        refreshSettings('#toolrail-settings-setname');
      } else {
        nameInput.focus();
      }
    }, 'toolrail-settings-saveset'));
    node.appendChild(saveRow);

    var configs = loadConfigs();
    var configNames = Object.keys(configs);
    if (configNames.length) {
      var setList = settingsRow('ul', 'toolrail-settings-sets');
      configNames.forEach(function (cfg) {
        var li = settingsRow('li', 'toolrail-settings-setrow');
        var label = settingsRow('span', 'toolrail-settings-pinnedname');
        label.textContent = cfg;
        li.appendChild(label);
        var load = settingsButton(__('Load', 'toolrail'), function () {
          loadConfig(cfg);
          var missing = missingBlockCount(loadSlots());
          if (missing > 0) {
            settingsStatus = sprintf(
              /* translators: 1: set name, 2: count of unavailable blocks. */
              _n(
                'Loaded "%1$s". %2$d pinned block is not available on this site and stays hidden until its plugin or theme is active.',
                'Loaded "%1$s". %2$d pinned blocks are not available on this site and stay hidden until their plugin or theme is active.',
                missing,
                'toolrail'
              ),
              cfg,
              missing
            );
          } else {
            // Announce the ordinary success too. The rail rebuilding is a
            // visual-only cue, so without this a screen-reader user got
            // no confirmation that Load had done anything at all.
            settingsStatus = sprintf(
              /* translators: %s: set name. */
              __('Loaded "%s".', 'toolrail'),
              cfg
            );
          }
          refreshSettings('#toolrail-settings-search');
        }, 'toolrail-settings-load');
        load.setAttribute('aria-label', sprintf(__('Load the set %s', 'toolrail'), cfg));
        li.appendChild(load);
        var exp = settingsButton(__('Export', 'toolrail'), function () {
          exportConfig(cfg);
        }, 'toolrail-settings-export');
        exp.setAttribute('aria-label', sprintf(__('Export the set %s as a file', 'toolrail'), cfg));
        li.appendChild(exp);
        var del = settingsButton(__('Delete', 'toolrail'), function () {
          deleteConfig(cfg);
          refreshSettings('#toolrail-settings-setname');
        }, 'toolrail-settings-delset');
        del.setAttribute('aria-label', sprintf(__('Delete the set %s', 'toolrail'), cfg));
        li.appendChild(del);
        li.dataset.config = cfg;
        setList.appendChild(li);
      });
      node.appendChild(setList);
    }

    // --- Import ---
    var importLabel = settingsRow('label', 'toolrail-settings-label');
    importLabel.setAttribute('for', 'toolrail-settings-import');
    importLabel.textContent = __('Import a set file', 'toolrail');
    node.appendChild(importLabel);

    var importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.id = 'toolrail-settings-import';
    importInput.className = 'toolrail-settings-import';
    importInput.accept = 'application/json,.json';
    importInput.setAttribute('aria-describedby', 'toolrail-settings-status');
    /**
     * Deliver the outcome of a file read.
     *
     * Reading a file is async, so the dialog can be gone by the time the
     * promise settles. Parking the message in `settingsStatus` regardless
     * stranded it there — closeSettings had already run and cleared the
     * slot, so the message survived to be rendered, out of context, the
     * NEXT time settings was opened. When there is no dialog left to
     * render into, speak the result and drop it.
     *
     * @param {string} message Outcome text.
     * @return {void}
     */
    function reportImport(message) {
      if (!settingsOpen || !settingsNode()) {
        speak(message);
        return;
      }
      settingsStatus = message;
      refreshSettings('#toolrail-settings-import');
    }

    importInput.addEventListener('change', function () {
      var file = importInput.files && importInput.files[0];
      if (!file) {
        return;
      }
      file.text().then(function (text) {
        var result;
        try {
          result = importConfigPayload(JSON.parse(text));
        } catch (e) {
          result = { ok: false, error: __('That file is not valid JSON.', 'toolrail') };
        }
        reportImport(result.ok ? importStatusMessage(result) : result.error);
      }).catch(function () {
        reportImport(__('The file could not be read.', 'toolrail'));
      });
    });
    node.appendChild(importInput);

    // --- Help ---
    node.appendChild(settingsDivider());
    var helpHead = settingsRow('h3', 'toolrail-settings-subtitle');
    helpHead.textContent = __('Help', 'toolrail');
    node.appendChild(helpHead);

    var helpRow = settingsRow('div', 'toolrail-settings-helprow');
    helpRow.appendChild(settingsButton(__('Open toolbar help', 'toolrail'), function () {
      // openHelp closes this dialog on purpose — the panel and the
      // dialog are sibling surfaces anchored to the same rail.
      var wrapper = document.getElementById('toolrail-region');
      if (wrapper) {
        openHelp(wrapper);
      }
    }, 'toolrail-settings-helpbtn'));
    node.appendChild(helpRow);

    var hideHelpRow = settingsRow('label', 'toolrail-settings-positionrow');
    var hideHelp = document.createElement('input');
    hideHelp.type = 'checkbox';
    hideHelp.id = 'toolrail-settings-helphidden';
    hideHelp.checked = isHelpHidden();
    hideHelp.addEventListener('change', function () {
      writeKey(HELP_HIDDEN_KEY, hideHelp.checked ? '1' : '0');
      // Rebuild the rail with/without the "?" tool. Focus stays on this
      // checkbox — rerender() only moves focus when it was in the rail.
      rerender();
    });
    var hideHelpText = settingsRow('span', '');
    hideHelpText.textContent = __('Hide the Help button from the toolbar (help stays available here)', 'toolrail');
    hideHelpRow.appendChild(hideHelp);
    hideHelpRow.appendChild(hideHelpText);
    node.appendChild(hideHelpRow);
  }

  /**
   * @param {HTMLElement} wrapper       The region to hang the dialog in.
   * @param {string}      focusSelector Optional initial focus target, used
   *                                    when a dock change reopens the
   *                                    dialog to keep focus on the control
   *                                    that caused it.
   */
  function openSettings(wrapper, focusSelector) {
    if (settingsOpen) {
      closeSettings(true);
      return;
    }
    closeFlyout(false);
    closeHelp(false);

    var node = settingsRow('div', 'toolrail-settings');
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-labelledby', 'toolrail-settings-title');

    buildSettingsContent(node, '');
    wrapper.appendChild(node);
    settingsOpen = true;
    syncLayer();

    var gear = gearButton();
    if (gear) {
      gear.setAttribute('aria-expanded', 'true');
    }
    placeSurface(node, gear, wrapper);
    document.addEventListener('mousedown', onSettingsMousedown, true);
    document.addEventListener('keydown', onSettingsKeydown, true);
    document.addEventListener('focusin', onSettingsFocusin, true);
    window.addEventListener('toolrail:tools-updated', onToolsUpdatedWhileOpen);

    if (focusSelector) {
      var initial = focusableIn(node, focusSelector);
      if (initial) {
        initial.focus();
        return;
      }
    }
    node.querySelector('#toolrail-settings-search').focus();
  }

  // -------------------------------------------------------------------
  // Help panel — the how-to copy that 0.1.5 moved out of every button's
  // accessible name, given a home a first-time user can find. Same
  // surface machinery as the settings dialog (placeSurface, syncLayer,
  // Escape returns focus, click-outside close). Static content only —
  // nothing here goes through the status machinery, because none of it
  // is a status.
  // -------------------------------------------------------------------

  var helpOpen = false;

  function helpNode() {
    return document.querySelector('.toolrail-help');
  }

  function helpButton() {
    var rail = document.getElementById('toolrail-rail');
    return rail ? rail.querySelector('[data-tool="help"]') : null;
  }

  function isHelpHidden() {
    return readKey(HELP_HIDDEN_KEY) === '1';
  }

  /** Where Escape sends focus back: the "?" tool when it renders, the
      gear when the author has hidden it (the settings dialog's own Help
      button cannot take it — that dialog closes when the panel opens). */
  function helpOpenerButton() {
    return helpButton() || gearButton();
  }

  function closeHelp(refocusOpener) {
    var node = helpNode();
    if (node) {
      node.remove();
    }
    helpOpen = false;
    syncLayer();
    document.removeEventListener('mousedown', onHelpMousedown, true);
    document.removeEventListener('keydown', onHelpKeydown, true);
    document.removeEventListener('focusin', onHelpFocusin, true);
    var btn = helpButton();
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
    }
    if (refocusOpener) {
      var opener = helpOpenerButton();
      if (opener) {
        opener.focus();
      }
    }
  }

  function onHelpMousedown(e) {
    var node = helpNode();
    var btn = helpButton();
    if (node && !node.contains(e.target) && e.target !== btn && !(btn && btn.contains(e.target))) {
      closeHelp(false);
    }
  }

  function onHelpKeydown(e) {
    if (e.key !== 'Escape' || !helpOpen) {
      return;
    }
    // Only claim the Escape when focus is actually in the panel (or on
    // its button). The auto-opened panel never takes focus, so an
    // Escape pressed there is aimed at whatever the author IS in — the
    // inserter, a sidebar. Swallowing it (and yanking focus to the
    // rail, as closeHelp(true) does) hijacked that press: the inserter
    // stayed open and the caret teleported (review 2026-08-26). With
    // focus elsewhere, close quietly and let the event through to its
    // real target.
    var node = helpNode();
    var btn = helpButton();
    var inside = !!(node && node.contains(document.activeElement))
      || (btn && document.activeElement === btn);
    if (inside) {
      e.preventDefault();
      e.stopPropagation();
      closeHelp(true);
    } else {
      closeHelp(false);
    }
  }

  function onHelpFocusin(e) {
    if (!helpOpen) {
      return;
    }
    var node = helpNode();
    var btn = helpButton();
    if (!node || node.contains(e.target) || e.target === btn || (btn && btn.contains(e.target))) {
      return;
    }
    closeHelp(false);
  }

  function helpSections() {
    return [
      {
        title: __('Inserting with a tool', 'toolrail'),
        body: [
          __('Select a tool, then click in the canvas. The tool\'s block is inserted at the click point and the toolbar returns to Select.', 'toolrail'),
          __('Shift-click in the canvas to keep the tool armed for repeat inserts. Press Escape to return to Select at any time.', 'toolrail')
        ]
      },
      {
        title: __('Pinning blocks', 'toolrail'),
        body: [
          __('Pin any block type as a quick-insert tool: search under "Add a block" in Toolbar settings, drag a block from the inserter onto the toolbar, or choose "Pin to toolbar" in a block\'s options menu.', 'toolrail'),
          __('Remove a pin with Unpin in Toolbar settings, or "Unpin from toolbar" in the block\'s options menu.', 'toolrail')
        ]
      },
      {
        title: __('Section overview', 'toolrail'),
        body: [
          __('The Section overview tool zooms the canvas out and outlines every top-level block. Click an outline to show its reorder controls — arrows to move it, "Reorder inside" to step into a section — or simply drag an outline to a new spot. Zoom with the +/− buttons and pan long documents with the mouse wheel.', 'toolrail'),
          __('Escape collapses the open controls, then steps up one level, then closes the overview. Closing returns you to where you were scrolled.', 'toolrail')
        ]
      },
      {
        title: __('Moving the toolbar', 'toolrail'),
        body: [
          __('Drag the toolbar by its grip and release near an edge to dock it there, or let go anywhere to float it over the editor.', 'toolrail'),
          __('The keyboard path: pick a position under "Toolbar position" in Toolbar settings.', 'toolrail')
        ]
      },
      {
        title: __('Keyboard', 'toolrail'),
        body: [
          __('The toolbar is one Tab stop. Arrow keys move between tools, following the toolbar\'s orientation; Home and End jump to the ends.', 'toolrail'),
          __('ArrowRight opens a tool\'s flyout on a vertical toolbar; ArrowDown opens it on a horizontal one. Escape closes any open panel.', 'toolrail')
        ]
      },
      {
        title: __('Saved sets', 'toolrail'),
        body: [
          __('Save the current pinned arrangement as a named set in Toolbar settings, and load a set to switch arrangements.', 'toolrail'),
          __('Export a set as a small JSON file and import it on another site. Blocks the site does not have stay in the set and appear when their plugin or theme is active.', 'toolrail')
        ]
      }
    ];
  }

  /**
   * @param {HTMLElement} wrapper The region to hang the panel in.
   * @param {Object}      opts    {takeFocus: false} for the first-run
   *                              auto-open, which must not steal the
   *                              author's caret. Explicit opens move
   *                              focus into the panel so Escape and Tab
   *                              behave like the settings dialog.
   */
  function openHelp(wrapper, opts) {
    if (helpOpen) {
      closeHelp(true);
      return;
    }
    closeFlyout(false);
    closeSettings(false);

    var options = opts || {};
    var node = settingsRow('div', 'toolrail-help');
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-labelledby', 'toolrail-help-title');
    node.tabIndex = -1;

    var head = settingsRow('div', 'toolrail-settings-head');
    var title = settingsRow('h2', 'toolrail-settings-title');
    title.textContent = __('Toolbar help', 'toolrail');
    title.id = 'toolrail-help-title';
    head.appendChild(title);
    var close = settingsButton('×', function () { closeHelp(true); }, 'toolrail-settings-close');
    close.setAttribute('aria-label', __('Close toolbar help', 'toolrail'));
    head.appendChild(close);
    node.appendChild(head);

    helpSections().forEach(function (section) {
      var h = settingsRow('h3', 'toolrail-settings-subtitle');
      h.textContent = section.title;
      node.appendChild(h);
      section.body.forEach(function (line) {
        var p = settingsRow('p', 'toolrail-help-copy');
        p.textContent = line;
        node.appendChild(p);
      });
    });

    wrapper.appendChild(node);
    helpOpen = true;
    syncLayer();

    var btn = helpButton();
    if (btn) {
      btn.setAttribute('aria-expanded', 'true');
    }
    placeSurface(node, btn || gearButton(), wrapper);
    document.addEventListener('mousedown', onHelpMousedown, true);
    document.addEventListener('keydown', onHelpKeydown, true);

    // The focusin close is for a panel the author is INSIDE of and tabs
    // past. The auto-opened panel never holds focus — on a new post the
    // editor moves focus to the title moments after boot, and a focusin
    // listener would read that as "the author left" and close the panel
    // before it was ever seen. Click-outside and Escape still close it.
    if (options.takeFocus !== false) {
      document.addEventListener('focusin', onHelpFocusin, true);
      node.focus();
    }
  }

  /**
   * First-run auto-open: once per account (the `toolrail-help-seen`
   * stamp goes through the account preferences like every other key),
   * never again unless invoked — closing IS dismissal, so there is no
   * "don't show this again" affordance.
   *
   * The 400ms delay gives the preferences persistence attach a beat to
   * resolve, so a stamp set on another browser is normally visible
   * before this reads it. If the attach still lands later, the worst
   * case is one extra auto-open — accepted, matching the tolerance the
   * migration lift already lives with.
   */
  var helpFirstRunChecked = false;

  function maybeAutoOpenHelp() {
    if (helpFirstRunChecked) {
      return;
    }
    helpFirstRunChecked = true;
    window.setTimeout(function () {
      if (helpOpen || settingsOpen || isHelpHidden() || readKey(HELP_SEEN_KEY) !== null) {
        return;
      }
      var wrapper = document.getElementById('toolrail-region');
      if (!wrapper) {
        return;
      }
      writeKey(HELP_SEEN_KEY, '1');
      openHelp(wrapper, { takeFocus: false });
    }, 400);
  }

  // -------------------------------------------------------------------
  // Section overview (R6) — zoom the canvas out, reorder sections, and
  // drill into one to reorder its children at their own zoom.
  //
  // Owned end to end, NO private APIs: core's zoom-out machinery moved
  // behind the private-apis unlock (verified in the Phase 0 spike —
  // __unstableSetEditorMode('zoom-out') dispatches but visibly no-ops),
  // and depending on it means breakage on any core release. Instead the
  // canvas iframe's parent-document container is scaled with a CSS
  // transform (the iframe keeps its layout truth; only the viewport onto
  // it shrinks), and CHIPS are overlaid in the PARENT document from each
  // block's getBoundingClientRect(). Reordering dispatches the public
  // moveBlocksToPosition, an ordinary editing action — so the
  // deactivation promise is untouched, which is what keeps R6 above the
  // release line.
  //
  // Invariants (roadmap R6):
  //  - Chip DOM order IS document order (getBlocks order) — never CSS
  //    `order` (the theme header's tab-sequence trap).
  //  - ↑/↓ buttons are the keyboard path; every move and every root
  //    change is announced via speak().
  //  - Rects go stale on store changes: a change-guarded subscription
  //    (the syncPressed pattern) rebuilds; scroll/resize only reposition.
  //  - Exiting restores the pre-entry scroll position.
  //  - Entering/leaving must not dirty the post — nothing here writes
  //    content beyond the reorders the author asks for.
  //  - The overlay sits at z-index 30, UNDER core's side panels and
  //    modals (they stack at 100000) — it draws over the canvas only,
  //    so the layout-reference modal veto needs no special casing here.
  // -------------------------------------------------------------------

  var overviewOpen = false;
  var overviewRoot = '';
  // The one box whose reorder controls are shown ('' = none). The v2
  // interaction (owner feedback 2026-08-27, from post 446): boxes are
  // OUTLINES around each block, and the commands appear only after
  // clicking/entering a box — the always-on chip bars obscured content.
  var overviewSelected = '';
  // Pan offset (visual px, ≥0) down the current root, and the author's
  // explicit zoom (0 = fit the current root). Together they make a very
  // long document SCROLLABLE in the overview instead of shrinking it
  // past legibility.
  var overviewPan = 0;
  var overviewUserScale = 0;
  var overviewMetrics = { k: 1, rootTop: 0, fitHeight: 0 };
  var overviewEntryScroll = null;
  var overviewSignature = '';
  var overviewUnsubscribe = null;
  var overviewRepositionTimer = null;
  var overviewPanFrame = null;
  var overviewHadFrame = false;
  var overviewMedia = null;
  // In-flight box drag ({clientId, startX, startY, active, toIndex}).
  // Drag-to-reorder is POINTER SUGAR over the same public move the
  // arrows dispatch (owner ask 2026-08-27) — the keyboard path is the
  // arrows, and nothing here is reachable only by dragging.
  var overviewDrag = null;
  // Latched for one tick after a completed drag so the click the
  // browser fires on the same button cannot ALSO toggle its controls.
  var overviewDragConsumedClick = false;
  // The block that was selected when the overview opened — its floating
  // toolbar stays alive over the zoomed canvas otherwise (owner
  // feedback 2026-08-27), so the selection is cleared for the
  // overview's lifetime and put back on close.
  var overviewPriorSelection = '';

  function contentRegion() {
    return document.querySelector('.interface-interface-skeleton__content');
  }

  function canvasFrame() {
    return document.querySelector('iframe[name="editor-canvas"]');
  }

  function overviewNode() {
    return document.getElementById('toolrail-overview');
  }

  function overviewButton() {
    var rail = document.getElementById('toolrail-rail');
    return rail ? rail.querySelector('[data-tool="overview"]') : null;
  }

  /** Block title for box tags and announcements. A custom name the
      author gave the block (List View rename → attributes.metadata.name)
      wins over the type title — a page of Groups otherwise tags every
      box "Group" (seen on post 446). */
  function overviewBlockLabel(clientId) {
    var sel = wp.data.select('core/block-editor');
    var name = sel ? sel.getBlockName(clientId) : null;
    var type = name ? wp.blocks.getBlockType(name) : null;
    var custom = '';
    if (sel && typeof sel.getBlockAttributes === 'function') {
      var attrs = sel.getBlockAttributes(clientId);
      if (attrs && attrs.metadata && typeof attrs.metadata.name === 'string') {
        custom = attrs.metadata.name;
      }
    }
    return custom || (type && type.title) || name || __('Block', 'toolrail');
  }

  /** clientIds at the current root, in document order. */
  function overviewOrder() {
    var sel = wp.data.select('core/block-editor');
    return sel ? sel.getBlockOrder(overviewRoot) : [];
  }

  function overviewCurrentSignature() {
    return overviewRoot + '|' + overviewOrder().join(',');
  }

  /**
   * A block's rect in PARENT-document viewport coordinates. Rects read
   * inside the iframe are in the iframe's own (untransformed) space and
   * know nothing about the parent scale, so they are mapped through the
   * iframe element's transformed box: effective scale = the iframe's
   * on-screen width over its layout width.
   */
  function overviewBlockViewportRect(clientId) {
    var doc = canvasDoc();
    if (!doc) {
      return null;
    }
    var el = doc.querySelector('[data-block="' + String(clientId).replace(/"/g, '') + '"]');
    if (!el) {
      return null;
    }
    var r = el.getBoundingClientRect();
    var frame = canvasFrame();
    if (frame && doc !== document) {
      var f = frame.getBoundingClientRect();
      var k = frame.offsetWidth ? f.width / frame.offsetWidth : 1;
      return { left: f.left + r.left * k, top: f.top + r.top * k, width: r.width * k, height: r.height * k };
    }
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  /**
   * Fit the current root into the content viewport. Top level fits the
   * whole DOCUMENT; a drilled-in root fits THAT block's height, which is
   * what "reorder its children at their own zoom" means. Clamped to
   * [0.25, 1] — the overview never magnifies, and never shrinks past
   * legibility.
   *
   * The mechanism, measured on WP 7.1 (2026-08-27) — the roadmap's
   * "scale the wrapper" sketch assumed the PARENT scrolled the canvas,
   * and it does not; the iframe scrolls internally:
   *
   *  1. The iframe is GROWN to its document's full height so its
   *     internal viewport IS the document — the only way the whole
   *     document can render at once without touching the canvas
   *     document. `min-height` is the property that actually takes:
   *     core's own zoom machinery holds the iframe's height with a
   *     filling web animation, and a filling animation outranks any
   *     inline or stylesheet `height` (even !important — measured:
   *     inline height:1861px!important computed back to 591px) — but it
   *     cannot beat min-height's clamp.
   *  2. The scale transform lives on the iframe's PARENT (core's
   *     scale-container), never the iframe: the same core animation
   *     pins the iframe's transform at identity (measured: an inline
   *     !important scale computed to matrix(1,0,0,1,0,0)). The wrapper
   *     is free, so we stamp it `toolrail-ov-scale-host` and let the
   *     stylesheet's body-class rule do the rest.
   *  3. A drilled-in root is brought to the top by a translateY IN the
   *     same transform — the parent chain is fixed viewport-height
   *     boxes (overflow hidden at .editor-visual-editor), so nothing up
   *     there ever scrolls, and parent scrollTop is a dead end.
   *
   * Everything is custom properties on <body> + two classes; removing
   * them hands the canvas back byte-for-byte. A non-iframed editor gets
   * no zoom (chips and reordering still work at 1:1).
   */
  function applyOverviewScale() {
    var content = contentRegion();
    var frame = canvasFrame();
    var doc = canvasDoc();
    if (!content || !frame || !doc || doc === document || !doc.body) {
      return;
    }
    var host = frame.parentElement;
    if (host) {
      host.classList.add('toolrail-ov-scale-host');
    }

    // The document height comes from the CONTENT — the bottom edge of
    // the last top-level block — never from body.scrollHeight: the
    // canvas pads its tail with a viewport-relative click-to-append
    // area (~40vh INSIDE the iframe), so scrollHeight chases the
    // iframe's own height. Measuring it while growing the iframe is a
    // feedback loop (measured 2026-08-27 at 1707×898: 3938 → 5191 over
    // 1.2s — the "background slowly falls down the page" report), and
    // the inflated number also padded the fit with dead tail space.
    var editorSel = wp.data.select('core/block-editor');
    var scrollY = doc.defaultView ? (doc.defaultView.scrollY || 0) : 0;
    var extent = 0;
    (editorSel ? editorSel.getBlockOrder('') : []).forEach(function (id) {
      var el = doc.querySelector('[data-block="' + String(id).replace(/"/g, '') + '"]');
      if (el) {
        var r = el.getBoundingClientRect();
        extent = Math.max(extent, r.top + r.height + scrollY);
      }
    });
    if (extent <= 0) {
      // Empty canvas: nothing to fit or grow.
      return;
    }
    var docHeight = Math.ceil(extent) + 32;
    var fitHeight = docHeight;
    var rootTop = 0;
    if (overviewRoot) {
      var rootEl = doc.querySelector('[data-block="' + String(overviewRoot).replace(/"/g, '') + '"]');
      if (rootEl && rootEl.offsetHeight) {
        fitHeight = rootEl.offsetHeight;
        // The grown iframe cannot scroll internally, so the rect IS the
        // layout position (scrollY is belt for the pre-grow first call).
        rootTop = rootEl.getBoundingClientRect().top
          + (doc.defaultView ? doc.defaultView.scrollY : 0);
      }
    }

    // Fit unless the author has zoomed explicitly — but never fit past
    // the point of legibility. The floor is computed FROM THE CONTENT
    // (owner feedback 2026-08-27, post 773: a fixed floor zoomed a very
    // long post out too far): the MEDIAN block at the current root must
    // render at least OVERVIEW_MIN_BLOCK_PX tall on screen. Median, not
    // minimum — one spacer must not veto the zoom. A page of large
    // sections still reaches the absolute 0.25 floor (post 446 fits at
    // 25% and stays there); whatever a floored fit leaves off-screen is
    // reachable by PANNING (wheel, or focusing a box), not by shrinking
    // further. Manual −/+ zoom may still go below this.
    var viewport = Math.max(0, content.clientHeight - 24);
    var k = overviewUserScale;
    if (!k) {
      var heights = [];
      overviewOrder().forEach(function (id) {
        var el = doc.querySelector('[data-block="' + String(id).replace(/"/g, '') + '"]');
        if (el && el.offsetHeight) {
          heights.push(el.offsetHeight);
        }
      });
      heights.sort(function (a, b) {
        return a - b;
      });
      var medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
      var floorK = 0.25;
      if (medianH > 0) {
        floorK = Math.min(1, Math.max(0.25, OVERVIEW_MIN_BLOCK_PX / medianH));
      }
      k = 1;
      if (fitHeight > 0 && viewport > 0) {
        k = viewport / fitHeight;
      }
      k = Math.min(1, Math.max(floorK, k));
    }
    // A drilled-in root that FITS the viewport is CENTERED in it (owner
    // feedback 2026-08-27) — isolation should read as "this section, on
    // its own". A root taller than the viewport stays top-aligned and
    // pans instead; the two never combine.
    var maxPan = Math.max(0, fitHeight * k - viewport);
    var centerOffset = overviewRoot && maxPan === 0
      ? Math.max(0, (viewport - fitHeight * k) / 2)
      : 0;
    overviewMetrics = { k: k, rootTop: rootTop, fitHeight: fitHeight, centerOffset: centerOffset };
    overviewPan = Math.min(Math.max(0, overviewPan), maxPan);

    var style = document.body.style;
    style.setProperty('--toolrail-overview-scale', String(k));
    style.setProperty('--toolrail-ov-frameh', docHeight + 'px');
    // Keeps the scale-container's layout footprint at the VISUAL size,
    // for any build whose wrappers do size from their children.
    style.setProperty('--toolrail-ov-mb', (-(1 - k) * docHeight) + 'px');
    style.setProperty('--toolrail-ov-ty', (-(rootTop * k + overviewPan) + centerOffset) + 'px');
    updateOverviewZoomLabel();
  }

  /** Pan the overview (visual px from the current root's top), clamped
      to the content that exists. Box repositioning rides one rAF so a
      wheel burst costs one layout pass per frame, not per event. */
  function setOverviewPan(next) {
    var content = contentRegion();
    var viewport = content ? Math.max(0, content.clientHeight - 24) : 0;
    var maxPan = Math.max(0, overviewMetrics.fitHeight * overviewMetrics.k - viewport);
    overviewPan = Math.min(Math.max(0, next), maxPan);
    document.body.style.setProperty(
      '--toolrail-ov-ty',
      (-(overviewMetrics.rootTop * overviewMetrics.k + overviewPan) + (overviewMetrics.centerOffset || 0)) + 'px'
    );
    if (!overviewPanFrame) {
      overviewPanFrame = window.requestAnimationFrame(function () {
        overviewPanFrame = null;
        positionOverviewBoxes();
      });
    }
  }

  var OVERVIEW_MIN_SCALE = 0.15;

  /** The default zoom never renders the median block at the current
      root below this on-screen height — the content-derived floor. */
  var OVERVIEW_MIN_BLOCK_PX = 48;

  function setOverviewZoom(nextK, announceIt) {
    overviewUserScale = Math.min(1, Math.max(OVERVIEW_MIN_SCALE, nextK));
    applyOverviewScale();
    positionOverviewBoxes();
    if (announceIt) {
      speak(sprintf(
        /* translators: %d: zoom percentage. */
        __('Zoom %d%%.', 'toolrail'),
        Math.round(overviewMetrics.k * 100)
      ));
    }
  }

  function updateOverviewZoomLabel() {
    var label = document.querySelector('#toolrail-overview .toolrail-ov-zoomlabel');
    if (label) {
      label.textContent = Math.round(overviewMetrics.k * 100) + '%';
    }
  }

  function clearOverviewScale() {
    var style = document.body.style;
    style.removeProperty('--toolrail-overview-scale');
    style.removeProperty('--toolrail-ov-frameh');
    style.removeProperty('--toolrail-ov-mb');
    style.removeProperty('--toolrail-ov-ty');
    // Sweep, not "the current frame's parent": the editor can have
    // replaced the iframe (and its wrapper) while the overview was open.
    Array.prototype.slice.call(document.querySelectorAll('.toolrail-ov-scale-host'))
      .forEach(function (el) {
        el.classList.remove('toolrail-ov-scale-host');
      });
  }

  /** Size the overlay to the content region's LAYOUT box (offsets are
      unaffected by the transform, unlike getBoundingClientRect). Chip
      positions are computed viewport-rect-minus-overlay-rect, so this
      only defines coverage, not precision. */
  function placeOverviewOverlay() {
    var overlay = overviewNode();
    var content = contentRegion();
    if (!overlay || !content) {
      return;
    }
    overlay.style.left = content.offsetLeft + 'px';
    overlay.style.top = content.offsetTop + 'px';
    overlay.style.width = content.offsetWidth + 'px';
    overlay.style.height = content.offsetHeight + 'px';
  }

  /**
   * Size each outline box to its block's on-screen rect, in document
   * order. Boxes ARE the blocks now (v2) — no overlap-avoid needed,
   * because blocks don't overlap. A short block keeps a 24px hit floor;
   * a block with no DOM element yet simply hides until the next pass.
   */
  function positionOverviewBoxes() {
    var overlay = overviewNode();
    if (!overlay) {
      return;
    }
    var oRect = overlay.getBoundingClientRect();
    Array.prototype.slice.call(overlay.querySelectorAll('.toolrail-ov-box')).forEach(function (box) {
      var rect = overviewBlockViewportRect(box.dataset.clientid);
      if (!rect) {
        box.style.display = 'none';
        return;
      }
      box.style.display = '';
      var left = Math.max(0, rect.left - oRect.left);
      box.style.left = left + 'px';
      box.style.top = (rect.top - oRect.top) + 'px';
      box.style.width = Math.max(0, Math.min(rect.width, oRect.width - left)) + 'px';
      box.style.height = Math.max(rect.height, 24) + 'px';
    });
    positionOverviewVeil(oRect);
  }

  /** Punch the veil's hole at the drilled root's rect: four strips
      covering everything the current level is NOT. No-op at top level
      (buildOverviewContent only creates the strips when drilled). */
  function positionOverviewVeil(oRect) {
    var overlay = overviewNode();
    if (!overlay) {
      return;
    }
    var veils = Array.prototype.slice.call(overlay.querySelectorAll('.toolrail-ov-veil'));
    if (!veils.length) {
      return;
    }
    var rect = overviewRoot ? overviewBlockViewportRect(overviewRoot) : null;
    if (!rect) {
      veils.forEach(function (v) {
        v.style.display = 'none';
      });
      return;
    }
    var top = Math.max(0, rect.top - oRect.top);
    var bottom = Math.min(oRect.height, rect.top + rect.height - oRect.top);
    var left = Math.max(0, rect.left - oRect.left);
    var right = Math.min(oRect.width, rect.left + rect.width - oRect.left);
    var place = function (v, x, y, w, h) {
      if (w <= 0 || h <= 0) {
        v.style.display = 'none';
        return;
      }
      v.style.display = '';
      v.style.left = x + 'px';
      v.style.top = y + 'px';
      v.style.width = w + 'px';
      v.style.height = h + 'px';
    };
    veils.forEach(function (v) {
      switch (v.dataset.veil) {
        case 'top':
          place(v, 0, 0, oRect.width, top);
          break;
        case 'bottom':
          place(v, 0, bottom, oRect.width, oRect.height - bottom);
          break;
        case 'left':
          place(v, 0, top, left, Math.max(0, bottom - top));
          break;
        default:
          place(v, right, top, oRect.width - right, Math.max(0, bottom - top));
      }
    });
  }

  function overviewBoxFor(clientId) {
    var overlay = overviewNode();
    return overlay
      ? overlay.querySelector('.toolrail-ov-box[data-clientid="' + String(clientId).replace(/"/g, '') + '"]')
      : null;
  }

  /** Paint the selection state onto every box: is-selected class, the
      pick button's aria-expanded, and the controls strip's hidden. ONE
      box may be selected at a time. */
  function syncOverviewSelection() {
    var overlay = overviewNode();
    if (!overlay) {
      return;
    }
    Array.prototype.slice.call(overlay.querySelectorAll('.toolrail-ov-box')).forEach(function (box) {
      var selected = box.dataset.clientid === overviewSelected;
      box.classList.toggle('is-selected', selected);
      var pick = box.querySelector('[data-ov-action="pick"]');
      if (pick) {
        pick.setAttribute('aria-expanded', selected ? 'true' : 'false');
      }
      var controls = box.querySelector('.toolrail-ov-controls');
      if (controls) {
        controls.hidden = !selected;
      }
    });
  }

  /** Open a box's reorder controls and move focus to the first usable
      one. The controls are a DISCLOSURE on the box's pick button —
      the outline stays clean until the author asks. */
  function selectOverviewBox(clientId) {
    overviewSelected = clientId;
    syncOverviewSelection();
    var box = overviewBoxFor(clientId);
    if (!box) {
      return;
    }
    var target = focusableIn(box, '[data-ov-action="down"]')
      || focusableIn(box, '[data-ov-action="up"]')
      || focusableIn(box, '[data-ov-action="enter"]')
      || box.querySelector('[data-ov-action="pick"]');
    if (target) {
      target.focus();
    }
  }

  function deselectOverviewBox(refocusPick) {
    if (!overviewSelected) {
      return;
    }
    var box = overviewBoxFor(overviewSelected);
    overviewSelected = '';
    syncOverviewSelection();
    if (refocusPick && box) {
      var pick = box.querySelector('[data-ov-action="pick"]');
      if (pick) {
        pick.focus();
      }
    }
  }

  // -------------------------------------------------------------------
  // Drag-to-reorder — pointer sugar over moveOverviewBlockTo. A press
  // that moves past a small threshold becomes a drag with a drop line at
  // the target gap; a press that doesn't is the ordinary click (the
  // controls disclosure). Locked blocks refuse the drag the way their
  // arrows are disabled. Escape cancels (handled in onOverviewKeydown —
  // the drag has no listener of its own there, because the overview's
  // Escape handler registered first and would run first regardless).
  // -------------------------------------------------------------------

  function startOverviewDrag(e, clientId) {
    if (e.button !== 0 || overviewDrag) {
      return;
    }
    var sel = wp.data.select('core/block-editor');
    if (sel && typeof sel.canMoveBlocks === 'function') {
      try {
        if (!sel.canMoveBlocks([clientId], overviewRoot)) {
          return;
        }
      } catch (err) {
        /* Selector newer than this WP — assume movable, the verify in
           moveOverviewBlockTo still guards the announcement. */
      }
    }
    overviewDrag = { clientId: clientId, startX: e.clientX, startY: e.clientY, active: false, toIndex: -1 };
    document.addEventListener('mousemove', onOverviewDragMove, true);
    document.addEventListener('mouseup', onOverviewDragEnd, true);
  }

  function onOverviewDragMove(e) {
    if (!overviewDrag) {
      return;
    }
    if (!overviewDrag.active) {
      if (Math.abs(e.clientX - overviewDrag.startX) < 5 && Math.abs(e.clientY - overviewDrag.startY) < 5) {
        return;
      }
      overviewDrag.active = true;
      document.body.classList.add('toolrail-ov-dragging');
      var box = overviewBoxFor(overviewDrag.clientId);
      if (box) {
        box.classList.add('is-dragging');
      }
    }
    e.preventDefault();
    updateOverviewDropline(e.clientY);
  }

  /** Place the drop line at the gap the pointer is over, and remember
      the move index a release would dispatch. */
  function updateOverviewDropline(clientY) {
    var overlay = overviewNode();
    if (!overlay || !overviewDrag) {
      return;
    }
    var order = overviewOrder();
    var idx = order.indexOf(overviewDrag.clientId);
    var rects = order.map(function (id) {
      var box = overviewBoxFor(id);
      return box && box.style.display !== 'none' ? box.getBoundingClientRect() : null;
    });
    var insertIndex = 0;
    rects.forEach(function (r) {
      if (r && r.top + r.height / 2 < clientY) {
        insertIndex++;
      }
    });
    overviewDrag.toIndex = insertIndex > idx ? insertIndex - 1 : insertIndex;

    var oRect = overlay.getBoundingClientRect();
    var y = 0;
    if (insertIndex >= order.length) {
      var last = rects[rects.length - 1];
      y = last ? last.bottom + 2 - oRect.top : 0;
    } else {
      var at = rects[insertIndex];
      y = at ? at.top - 4 - oRect.top : 0;
    }
    var line = overlay.querySelector('.toolrail-ov-dropline');
    if (!line) {
      line = document.createElement('div');
      line.className = 'toolrail-ov-dropline';
      line.setAttribute('aria-hidden', 'true');
      overlay.appendChild(line);
    }
    line.style.top = y + 'px';
  }

  function finishOverviewDrag() {
    if (!overviewDrag) {
      return;
    }
    var line = document.querySelector('#toolrail-overview .toolrail-ov-dropline');
    if (line) {
      line.remove();
    }
    document.body.classList.remove('toolrail-ov-dragging');
    var box = overviewBoxFor(overviewDrag.clientId);
    if (box) {
      box.classList.remove('is-dragging');
    }
    document.removeEventListener('mousemove', onOverviewDragMove, true);
    document.removeEventListener('mouseup', onOverviewDragEnd, true);
    overviewDrag = null;
  }

  function onOverviewDragEnd(e) {
    if (!overviewDrag) {
      return;
    }
    var wasActive = overviewDrag.active;
    var clientId = overviewDrag.clientId;
    var to = overviewDrag.toIndex;
    finishOverviewDrag();
    if (!wasActive) {
      // A plain click — let the disclosure toggle proceed.
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // The browser still fires click on the button under the release —
    // one latch keeps a completed drag from ALSO toggling the controls.
    overviewDragConsumedClick = true;
    window.setTimeout(function () {
      overviewDragConsumedClick = false;
    }, 0);
    if (to !== -1) {
      moveOverviewBlockTo(clientId, to, null);
    }
  }

  /**
   * Two reposition passes: an immediate rAF for the common case, and a
   * 220ms pass that outlives both the scale transition (150ms) and the
   * canvas's own React flush after a reorder — chip positions computed
   * against mid-transition or pre-flush rects are wrong, and this is
   * cheaper and steadier than polling.
   */
  function scheduleOverviewSettle() {
    window.requestAnimationFrame(function () {
      if (overviewOpen) {
        positionOverviewBoxes();
      }
    });
    window.setTimeout(function () {
      if (!overviewOpen) {
        return;
      }
      // Refit too, not just reposition: the canvas flush after a reorder
      // (or any content change a dispatch made) can change the document
      // height the scale and pan clamp were computed from.
      applyOverviewScale();
      positionOverviewBoxes();
    }, 220);
  }

  /**
   * Rebuild the overlay's content (breadcrumb bar + outline boxes) from
   * the store. With no explicit focus candidates, focus inside the overlay
   * is preserved by re-deriving candidates from the control it was on —
   * a store-driven rebuild must never silently drop the keyboard user
   * on the floor.
   *
   * @param {string[]} [focusSelectors] Ordered focus candidates
   *                                    (focusableIn contract).
   */
  function buildOverviewContent(focusSelectors) {
    var overlay = overviewNode();
    if (!overlay) {
      return;
    }
    // A rebuild replaces every box a drag is measuring — abandon it.
    finishOverviewDrag();
    var sel = wp.data.select('core/block-editor');

    if (!focusSelectors && overlay.contains(document.activeElement)) {
      var active = document.activeElement;
      var activeBox = active.closest ? active.closest('.toolrail-ov-box') : null;
      var action = active.dataset ? active.dataset.ovAction : '';
      if (activeBox && action) {
        var boxSel = '.toolrail-ov-box[data-clientid="' + activeBox.dataset.clientid + '"] ';
        focusSelectors = [boxSel + '[data-ov-action="' + action + '"]', boxSel + 'button'];
      } else if (action) {
        focusSelectors = ['[data-ov-action="' + action + '"]'];
      }
    }

    overlay.textContent = '';

    // --- Bar: mode title + breadcrumb + up-one-level + zoom + Done ---
    var bar = settingsRow('div', 'toolrail-ov-bar');

    // The bar names the MODE, and the exit is a labeled button plus a
    // visible Esc hint (owner feedback 2026-08-27: make it clearer that
    // this is a modal-like state and how to leave it).
    var modeTitle = settingsRow('strong', 'toolrail-ov-title');
    modeTitle.textContent = __('Section overview', 'toolrail');
    bar.appendChild(modeTitle);

    var crumbs = document.createElement('nav');
    crumbs.className = 'toolrail-ov-crumbs';
    crumbs.setAttribute('aria-label', __('Overview level', 'toolrail'));

    var chain = [];
    var id = overviewRoot;
    while (id) {
      chain.unshift(id);
      id = (sel && sel.getBlockRootClientId(id)) || '';
    }

    var addCrumb = function (label, targetRoot, isCurrent) {
      if (isCurrent) {
        var here = settingsRow('span', 'toolrail-ov-crumb toolrail-ov-crumb--current');
        here.setAttribute('aria-current', 'location');
        here.textContent = label;
        crumbs.appendChild(here);
        return;
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toolrail-ov-crumb';
      btn.dataset.ovAction = 'crumb';
      btn.textContent = label;
      btn.setAttribute('aria-label', sprintf(
        /* translators: %s: breadcrumb level label. */
        __('Go to %s', 'toolrail'),
        label
      ));
      btn.addEventListener('click', function () {
        drillTo(targetRoot);
      });
      crumbs.appendChild(btn);
    };

    addCrumb(__('All sections', 'toolrail'), '', chain.length === 0);
    chain.forEach(function (cid, i) {
      addCrumb(overviewBlockLabel(cid), cid, i === chain.length - 1);
    });
    bar.appendChild(crumbs);

    if (overviewRoot) {
      var up = document.createElement('button');
      up.type = 'button';
      up.className = 'toolrail-ov-btn toolrail-ov-uplevel';
      up.dataset.ovAction = 'up-level';
      up.textContent = __('Up one level', 'toolrail');
      up.addEventListener('click', function () {
        drillTo((sel && sel.getBlockRootClientId(overviewRoot)) || '');
      });
      bar.appendChild(up);
    }

    // Zoom controls + a visible percentage. Panning covers whatever a
    // floored fit leaves off-screen: the wheel over the overlay, or
    // simply focusing a box (the focusin handler pans it into view).
    var zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.className = 'toolrail-ov-btn toolrail-ov-zoom';
    zoomOut.dataset.ovAction = 'zoom-out';
    zoomOut.textContent = '−';
    zoomOut.setAttribute('aria-label', __('Zoom out', 'toolrail'));
    zoomOut.addEventListener('click', function () {
      setOverviewZoom(overviewMetrics.k / 1.25, true);
    });
    bar.appendChild(zoomOut);

    var zoomLabel = settingsRow('span', 'toolrail-ov-zoomlabel');
    zoomLabel.setAttribute('aria-hidden', 'true');
    zoomLabel.textContent = Math.round(overviewMetrics.k * 100) + '%';
    bar.appendChild(zoomLabel);

    var zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'toolrail-ov-btn toolrail-ov-zoom';
    zoomIn.dataset.ovAction = 'zoom-in';
    zoomIn.textContent = '+';
    zoomIn.setAttribute('aria-label', __('Zoom in', 'toolrail'));
    zoomIn.addEventListener('click', function () {
      setOverviewZoom(overviewMetrics.k * 1.25, true);
    });
    bar.appendChild(zoomIn);

    var escHint = settingsRow('span', 'toolrail-ov-esc');
    escHint.textContent = __('Esc exits', 'toolrail');
    bar.appendChild(escHint);

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toolrail-ov-btn toolrail-ov-close';
    close.dataset.ovAction = 'close';
    // A labeled exit, not a bare × — the visible text IS the accessible
    // name, so speech input's "click Done" just works.
    close.textContent = __('Done', 'toolrail');
    close.addEventListener('click', function () {
      closeOverview(true);
    });
    bar.appendChild(close);
    overlay.appendChild(bar);

    // --- Outline boxes, one per block, DOM order = document order.
    // A box is lines around the block plus a small corner tag; the
    // reorder controls appear only after the box is picked (owner
    // feedback 2026-08-27: the always-on chip bars obscured content). ---
    var order = overviewOrder();
    if (!order.length) {
      var empty = settingsRow('p', 'toolrail-ov-empty');
      empty.textContent = __('Nothing to reorder here.', 'toolrail');
      bar.appendChild(empty);
    }
    if (overviewSelected && order.indexOf(overviewSelected) === -1) {
      overviewSelected = '';
    }

    // Drilled in, everything OUTSIDE the root gets a 50% veil (owner
    // feedback 2026-08-27): four strips punched around the root's rect,
    // so what can be reordered is the only thing at full strength. Pure
    // overlay chrome — the canvas document is untouched, and removing
    // the overlay removes the veil. Appended BEFORE the boxes so DOM
    // order stacks the boxes above it; the bar carries its own z-index.
    if (overviewRoot) {
      ['top', 'bottom', 'left', 'right'].forEach(function (side) {
        var veil = settingsRow('div', 'toolrail-ov-veil');
        veil.dataset.veil = side;
        veil.setAttribute('aria-hidden', 'true');
        overlay.appendChild(veil);
      });
    }

    var list = document.createElement('ul');
    list.className = 'toolrail-ov-list';
    order.forEach(function (clientId, i) {
      var label = overviewBlockLabel(clientId);
      var selected = clientId === overviewSelected;
      var li = document.createElement('li');
      li.className = 'toolrail-ov-box' + (selected ? ' is-selected' : '');
      li.dataset.clientid = clientId;

      // The whole box is one focusable disclosure: click it (or press
      // Enter on it) and the reorder controls appear inside the lines.
      var pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'toolrail-ov-selectbtn';
      pick.dataset.ovAction = 'pick';
      pick.setAttribute('aria-expanded', selected ? 'true' : 'false');
      pick.setAttribute('aria-label', sprintf(
        /* translators: 1: block title, 2: its position, 3: count. */
        __('%1$s, position %2$d of %3$d — show reorder controls', 'toolrail'),
        label,
        i + 1,
        order.length
      ));
      pick.addEventListener('mousedown', function (e) {
        startOverviewDrag(e, clientId);
      });
      pick.addEventListener('click', function () {
        // A completed drag's release fires a click on this same button;
        // the latch keeps it from also toggling the controls.
        if (overviewDragConsumedClick) {
          return;
        }
        if (overviewSelected === clientId) {
          deselectOverviewBox(true);
        } else {
          selectOverviewBox(clientId);
        }
      });
      li.appendChild(pick);

      var tag = settingsRow('span', 'toolrail-ov-tag');
      tag.textContent = label;
      tag.setAttribute('aria-hidden', 'true');
      li.appendChild(tag);

      var controls = settingsRow('div', 'toolrail-ov-controls');
      controls.hidden = !selected;

      var name = settingsRow('span', 'toolrail-ov-label');
      name.textContent = label;
      controls.appendChild(name);

      var pos = settingsRow('span', 'toolrail-ov-pos');
      pos.textContent = sprintf(
        /* translators: 1: position, 2: count. */
        __('%1$d of %2$d', 'toolrail'),
        i + 1,
        order.length
      );
      controls.appendChild(pos);

      // canMoveBlocks: core's own moveBlocksToPosition refuses (silently)
      // for a movement-locked block, so the arrows must not offer a move
      // core will refuse — announcing an unperformed move would lie to a
      // screen-reader user (review 2026-08-27, finding 1; the selector
      // is guarded because it is newer than this plugin's floor).
      var movable = true;
      if (sel && typeof sel.canMoveBlocks === 'function') {
        try {
          movable = !!sel.canMoveBlocks([clientId], overviewRoot);
        } catch (e) {
          movable = true;
        }
      }

      var upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'toolrail-ov-btn toolrail-ov-move';
      upBtn.dataset.ovAction = 'up';
      upBtn.textContent = '↑';
      upBtn.setAttribute('aria-label', sprintf(
        /* translators: 1: block title, 2: its position. */
        __('Move %1$s, position %2$d, up', 'toolrail'),
        label,
        i + 1
      ));
      upBtn.disabled = i === 0 || !movable;
      upBtn.addEventListener('click', function () {
        moveOverviewBlock(clientId, -1);
      });
      controls.appendChild(upBtn);

      var downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'toolrail-ov-btn toolrail-ov-move';
      downBtn.dataset.ovAction = 'down';
      downBtn.textContent = '↓';
      downBtn.setAttribute('aria-label', sprintf(
        /* translators: 1: block title, 2: its position. */
        __('Move %1$s, position %2$d, down', 'toolrail'),
        label,
        i + 1
      ));
      downBtn.disabled = i === order.length - 1 || !movable;
      downBtn.addEventListener('click', function () {
        moveOverviewBlock(clientId, 1);
      });
      controls.appendChild(downBtn);

      if (sel && sel.getBlockCount(clientId) > 0) {
        var enter = document.createElement('button');
        enter.type = 'button';
        enter.className = 'toolrail-ov-btn toolrail-ov-enter';
        enter.dataset.ovAction = 'enter';
        // "Reorder inside", not "Enter" (owner feedback 2026-08-27: on
        // a keyboard-driven surface "Enter" reads as the key, not the
        // action). The visible text leads the accessible name (WCAG
        // 2.5.3 Label in Name).
        enter.textContent = __('Reorder inside', 'toolrail');
        enter.setAttribute('aria-label', sprintf(
          /* translators: 1: block title, 2: its position. */
          __('Reorder inside %1$s, position %2$d', 'toolrail'),
          label,
          i + 1
        ));
        enter.addEventListener('click', function () {
          drillTo(clientId);
        });
        controls.appendChild(enter);
      }

      li.appendChild(controls);
      list.appendChild(li);
    });
    overlay.appendChild(list);
    positionOverviewBoxes();

    if (focusSelectors) {
      var candidates = Array.isArray(focusSelectors) ? focusSelectors.slice() : [focusSelectors];
      candidates.push('[data-ov-action="close"]');
      var target = null;
      candidates.some(function (s) {
        target = focusableIn(overlay, s);
        return !!target;
      });
      if (target) {
        target.focus();
      }
    }
  }

  /** The default focus candidates for a freshly (re)built level: the
      first box's pick disclosure, then the bar. */
  var OVERVIEW_FOCUS_CANDIDATES = [
    '.toolrail-ov-box [data-ov-action="pick"]',
    '[data-ov-action="up-level"]',
    '[data-ov-action="close"]'
  ];

  /**
   * Move one block within the current root. Reorder dispatches the
   * PUBLIC moveBlocksToPosition — no private APIs anywhere in R6 — so
   * the serialized result is byte-identical to the same move made in
   * List View. The rebuild runs here with focus preserved on the moved
   * chip (the settings-arrows pattern: the opposite arrow is the second
   * candidate for a chip that just reached an end); the store
   * subscription is pre-empted by writing the new signature first.
   */
  /**
   * @param {string}      clientId    Block to move within the current root.
   * @param {number}      to          Target index.
   * @param {string|null} focusAction 'up'/'down' when an arrow drove the
   *                                  move (keeps the box selected with
   *                                  focus on that arrow — the
   *                                  settings-arrows contract); null for
   *                                  a drag, which preserves focus
   *                                  generically and leaves the
   *                                  selection as it was.
   */
  function moveOverviewBlockTo(clientId, to, focusAction) {
    var order = overviewOrder();
    var idx = order.indexOf(clientId);
    if (idx === -1 || to < 0 || to >= order.length || to === idx) {
      return;
    }
    wp.data.dispatch('core/block-editor').moveBlocksToPosition([clientId], overviewRoot, overviewRoot, to);

    // VERIFY before announcing: core's action has its own canMoveBlocks
    // guard and returns early — silently — for a locked block. The
    // arrows are disabled (and the drag refused) for those, but
    // belt-and-braces: never tell a screen-reader user a move happened
    // when the order did not change (review 2026-08-27, finding 1).
    if (overviewOrder()[to] !== clientId) {
      speak(sprintf(
        /* translators: %s: block title. */
        __('%s cannot be moved.', 'toolrail'),
        overviewBlockLabel(clientId)
      ));
      return;
    }
    overviewSignature = overviewCurrentSignature();

    if (focusAction) {
      overviewSelected = clientId;
      var boxSel = '.toolrail-ov-box[data-clientid="' + clientId + '"] ';
      buildOverviewContent([
        boxSel + '[data-ov-action="' + focusAction + '"]',
        boxSel + '[data-ov-action="' + (focusAction === 'up' ? 'down' : 'up') + '"]'
      ]);
    } else {
      buildOverviewContent();
    }
    scheduleOverviewSettle();

    speak(sprintf(
      /* translators: 1: block title, 2: new position, 3: count. */
      __('Moved %1$s to position %2$d of %3$d.', 'toolrail'),
      overviewBlockLabel(clientId),
      to + 1,
      order.length
    ));
  }

  function moveOverviewBlock(clientId, delta) {
    var idx = overviewOrder().indexOf(clientId);
    if (idx === -1) {
      return;
    }
    moveOverviewBlockTo(clientId, idx + delta, delta < 0 ? 'up' : 'down');
  }

  /**
   * Re-root the overview ('' = top level) — the drill-in machinery. The
   * SAME chips reorder children inside a section; the root change is
   * announced, and the zoom refits to the new root.
   */
  function drillTo(root, announcePrefix) {
    overviewRoot = root || '';
    // Each level gets its own zoom, pan and selection.
    overviewSelected = '';
    overviewPan = 0;
    overviewUserScale = 0;
    overviewSignature = overviewCurrentSignature();
    applyOverviewScale();
    buildOverviewContent(OVERVIEW_FOCUS_CANDIDATES);
    scheduleOverviewSettle();

    var count = overviewOrder().length;
    var message;
    if (overviewRoot) {
      message = sprintf(
        /* translators: 1: block title, 2: number of blocks inside it. */
        _n('Viewing inside %1$s — %2$d block.', 'Viewing inside %1$s — %2$d blocks.', count, 'toolrail'),
        overviewBlockLabel(overviewRoot),
        count
      );
    } else {
      message = sprintf(
        /* translators: %d: number of top-level sections. */
        _n('Viewing all sections — %d section.', 'Viewing all sections — %d sections.', count, 'toolrail'),
        count
      );
    }
    // wp.a11y.speak REPLACES the region's text, so a forced root change
    // (the drilled-into block was deleted) composes its reason into ONE
    // message instead of racing two.
    speak(announcePrefix ? announcePrefix + ' ' + message : message);
  }

  /**
   * Escape walks back out one layer at a time — collapse the open
   * controls, then climb a level, then close — but ONLY when focus is
   * inside the overlay (the help panel lesson: an Escape aimed at the
   * inserter or a sidebar must never be hijacked).
   */
  function onOverviewKeydown(e) {
    if (e.key !== 'Escape' || !overviewOpen) {
      return;
    }
    var overlay = overviewNode();
    if (!overlay || !overlay.contains(document.activeElement)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (overviewDrag) {
      // Abandon an in-flight drag; nothing moves.
      finishOverviewDrag();
    } else if (overviewSelected) {
      deselectOverviewBox(true);
    } else if (overviewRoot) {
      var sel = wp.data.select('core/block-editor');
      drillTo((sel && sel.getBlockRootClientId(overviewRoot)) || '');
    } else {
      closeOverview(true);
    }
  }

  /** Scroll/resize only REPOSITION (debounced); the store subscription
      below owns rebuilds. Also the self-heal hook: the editor replacing
      its content region (code-editor round trip) closes the overview
      cleanly rather than leaving a scaled ghost. */
  function onOverviewViewportChange() {
    if (!overviewOpen || overviewRepositionTimer) {
      return;
    }
    overviewRepositionTimer = window.setTimeout(function () {
      overviewRepositionTimer = null;
      if (!overviewOpen) {
        return;
      }
      if (!contentRegion() || (overviewHadFrame && !canvasFrame())) {
        closeOverview(false);
        return;
      }
      placeOverviewOverlay();
      applyOverviewScale();
      positionOverviewBoxes();
    }, 50);
  }

  /** Change-guarded store subscription (the syncPressed pattern): bail
      on the cached signature before touching the DOM; a deleted root
      climbs to the top level rather than stranding the overview. */
  function onOverviewStoreChange() {
    if (!overviewOpen) {
      return;
    }
    var sel = wp.data.select('core/block-editor');
    if (overviewRoot && sel && !sel.getBlock(overviewRoot)) {
      // A forced root change is a root change like any other — announce
      // it (review 2026-08-27, finding 5), composed with the reason.
      drillTo('', __('The section you were viewing was removed.', 'toolrail'));
      return;
    }
    var sig = overviewCurrentSignature();
    if (sig === overviewSignature) {
      return;
    }
    overviewSignature = sig;
    // Refit as well as rebuild: content changes move the document
    // height the scale and pan clamp were computed from (review
    // 2026-08-27, finding 6 — the overlay now captures pointer events,
    // so canvas edits mid-overview are rare, but dispatches from other
    // code are not).
    applyOverviewScale();
    buildOverviewContent();
    scheduleOverviewSettle();
  }

  function createOverviewOverlay(body) {
    var overlay = document.createElement('div');
    overlay.id = 'toolrail-overview';
    overlay.setAttribute('role', 'region');
    overlay.setAttribute('aria-label', __('Section overview', 'toolrail'));

    // The overview is a MODE: while it is open the overlay captures all
    // pointer events over the canvas (CSS pointer-events: auto), so a
    // click can never fall through and edit — or, with a tool armed,
    // INSERT INTO — the zoomed-out document underneath (review
    // 2026-08-27, finding 4's surface). The wheel pans; a click on
    // empty space collapses the open controls; focusing a box pans it
    // into view (the keyboard's path to off-screen content).
    overlay.addEventListener('wheel', function (e) {
      e.preventDefault();
      var delta = e.deltaY;
      if (e.deltaMode === 1) {
        delta *= 16;
      }
      setOverviewPan(overviewPan + delta);
    }, { passive: false });

    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay || (e.target.classList && e.target.classList.contains('toolrail-ov-list'))) {
        deselectOverviewBox(false);
      }
    });

    overlay.addEventListener('focusin', function (e) {
      var box = e.target.closest ? e.target.closest('.toolrail-ov-box') : null;
      if (!box) {
        return;
      }
      var oRect = overlay.getBoundingClientRect();
      var bRect = box.getBoundingClientRect();
      var bar = overlay.querySelector('.toolrail-ov-bar');
      var topEdge = oRect.top + (bar ? bar.offsetHeight + 16 : 8);
      if (bRect.top < topEdge) {
        setOverviewPan(overviewPan - (topEdge - bRect.top));
      } else if (bRect.bottom > oRect.bottom - 8) {
        setOverviewPan(overviewPan + Math.min(bRect.bottom - (oRect.bottom - 8), bRect.top - topEdge));
      }
    });

    body.appendChild(overlay);
    placeOverviewOverlay();
    return overlay;
  }

  function onOverviewMediaChange(e) {
    // Below the admin small-screen breakpoint the rail AND the overlay
    // are display:none — without this, the author would be stranded in
    // a scaled canvas with no Escape surface left (review 2026-08-27,
    // finding 2). Close cleanly instead.
    if (e.matches) {
      closeOverview(false);
    }
  }

  function toggleOverview() {
    if (overviewOpen) {
      closeOverview(true);
    } else {
      openOverview();
    }
  }

  function openOverview() {
    if (overviewOpen) {
      return;
    }
    var body = skeletonBody();
    var content = contentRegion();
    if (!body || !content) {
      return;
    }
    // Below the small-screen breakpoint the overlay cannot render — do
    // not open into a state with no close surface.
    if (window.matchMedia && window.matchMedia('(max-width: 782px)').matches) {
      return;
    }
    closeFlyout(false);
    // Disarm: an armed tool's canvas insertion must never stay live
    // under the overview (review 2026-08-27, finding 4).
    if (activeTool !== 'select') {
      setActiveTool('select');
    }

    overviewOpen = true;
    overviewRoot = '';
    overviewSelected = '';
    overviewPan = 0;
    overviewUserScale = 0;
    // The canvas scrolls INSIDE its iframe on iframed editors (measured:
    // the parent content region never overflows) — that scroll position
    // is what "exiting restores where you were" means. Growing the
    // iframe clamps it to 0 for the overview's lifetime.
    var frame = canvasFrame();
    if (frame && frame.contentWindow) {
      try {
        overviewEntryScroll = frame.contentWindow.scrollY || 0;
      } catch (e) {
        overviewEntryScroll = 0;
      }
    } else {
      overviewEntryScroll = content.scrollTop;
    }
    overviewHadFrame = !!frame;
    // A selected block keeps its floating toolbar alive over the zoomed
    // canvas — clear the selection for the overview's lifetime (the
    // reorder chrome is the only chrome this mode shows) and put it
    // back on close. Selection is editor state, not content: neither
    // direction dirties the post.
    var editorSel = wp.data.select('core/block-editor');
    overviewPriorSelection = editorSel && typeof editorSel.getSelectedBlockClientId === 'function'
      ? (editorSel.getSelectedBlockClientId() || '')
      : '';
    if (wp.data.dispatch('core/block-editor').clearSelectedBlock) {
      wp.data.dispatch('core/block-editor').clearSelectedBlock();
    }
    document.body.classList.add('toolrail-overview-on');

    createOverviewOverlay(body);
    applyOverviewScale();
    // Chromium PRESERVES the internal scroll offset when the viewport
    // grows past the content (measured: scrollY stayed at 300), which
    // would shift every mapped rect — home it explicitly; the saved
    // entry position is restored on close.
    if (frame && frame.contentWindow) {
      try {
        frame.contentWindow.scrollTo(0, 0);
      } catch (e) {
        /* Nothing to home. */
      }
    }
    overviewSignature = overviewCurrentSignature();
    buildOverviewContent(OVERVIEW_FOCUS_CANDIDATES);
    scheduleOverviewSettle();

    document.addEventListener('keydown', onOverviewKeydown, true);
    document.addEventListener('scroll', onOverviewViewportChange, true);
    window.addEventListener('resize', onOverviewViewportChange);
    if (window.matchMedia) {
      overviewMedia = window.matchMedia('(max-width: 782px)');
      if (typeof overviewMedia.addEventListener === 'function') {
        overviewMedia.addEventListener('change', onOverviewMediaChange);
      }
    }
    if (wp.data && typeof wp.data.subscribe === 'function') {
      overviewUnsubscribe = wp.data.subscribe(onOverviewStoreChange, 'core/block-editor');
    }
    syncPressed(true);

    var count = overviewOrder().length;
    speak(sprintf(
      /* translators: %d: number of top-level sections. */
      _n(
        'Section overview — %d section. Choose a section to show its reorder controls; Escape steps back out.',
        'Section overview — %d sections. Choose a section to show its reorder controls; Escape steps back out.',
        count,
        'toolrail'
      ),
      count
    ));
  }

  function closeOverview(refocus) {
    if (!overviewOpen) {
      return;
    }
    overviewOpen = false;
    finishOverviewDrag();
    var overlay = overviewNode();
    if (overlay) {
      overlay.remove();
    }
    document.body.classList.remove('toolrail-overview-on');
    clearOverviewScale();
    // Restore the pre-entry scroll position — the iframe's own window
    // on iframed editors (its viewport just shrank back, so the scroll
    // range exists again), the content region otherwise.
    if (overviewEntryScroll !== null) {
      var frame = canvasFrame();
      if (frame && frame.contentWindow) {
        try {
          frame.contentWindow.scrollTo(0, overviewEntryScroll);
        } catch (e) {
          /* Cross-origin surprise — nothing to restore. */
        }
      } else {
        var content = contentRegion();
        if (content) {
          content.scrollTop = overviewEntryScroll;
        }
      }
    }
    overviewEntryScroll = null;
    overviewRoot = '';
    overviewSelected = '';
    overviewPan = 0;
    overviewUserScale = 0;
    document.removeEventListener('keydown', onOverviewKeydown, true);
    document.removeEventListener('scroll', onOverviewViewportChange, true);
    window.removeEventListener('resize', onOverviewViewportChange);
    if (overviewMedia) {
      if (typeof overviewMedia.removeEventListener === 'function') {
        overviewMedia.removeEventListener('change', onOverviewMediaChange);
      }
      overviewMedia = null;
    }
    if (overviewUnsubscribe) {
      overviewUnsubscribe();
      overviewUnsubscribe = null;
    }
    if (overviewRepositionTimer) {
      window.clearTimeout(overviewRepositionTimer);
      overviewRepositionTimer = null;
    }
    if (overviewPanFrame) {
      window.cancelAnimationFrame(overviewPanFrame);
      overviewPanFrame = null;
    }
    // Restore the selection the overview cleared on open, if the block
    // is still there (a dispatched selectBlock takes no DOM focus, so
    // this never fights the refocus below).
    if (overviewPriorSelection) {
      var editorSel = wp.data.select('core/block-editor');
      if (editorSel && editorSel.getBlock(overviewPriorSelection)) {
        wp.data.dispatch('core/block-editor').selectBlock(overviewPriorSelection);
      }
      overviewPriorSelection = '';
    }
    syncPressed(true);
    if (refocus) {
      var btn = overviewButton();
      if (btn) {
        btn.focus();
      }
    }
    speak(__('Section overview closed.', 'toolrail'));
  }

  /** Re-create the overlay if a React re-render swept it away while the
      overview was open — the rail's own self-heal, for the overlay. Runs
      from the mount observer. */
  function healOverview() {
    if (!overviewOpen) {
      return;
    }
    var content = contentRegion();
    var body = skeletonBody();
    if (!content || !body || (overviewHadFrame && !canvasFrame())) {
      closeOverview(false);
      return;
    }
    // Re-assert the scale even when the overlay survived: a React
    // re-render can replace the iframe's wrapper, taking the
    // scale-host class with it.
    applyOverviewScale();
    if (!overviewNode()) {
      createOverviewOverlay(body);
      buildOverviewContent();
      scheduleOverviewSettle();
    }
  }

  // -------------------------------------------------------------------
  // Moving the rail: dock changes, floating placement, drag-and-snap
  // -------------------------------------------------------------------

  /**
   * Raise the rail above the editor's side panels, but only while it
   * actually needs to be there.
   *
   * There is no single z-index that works statically. Core stacks BOTH the
   * settings sidebar and the Document Overview secondary sidebar at
   * 100000, so a surface opening over either one has to beat that — but it
   * puts .components-modal__screen-overlay at the SAME 100000, so anything
   * that permanently beats the panels also covers every modal, including
   * the media library the Image tool opens.
   *
   * So the region sits low by default and is raised only when a surface is
   * open, a drag is in flight, or it is a floating palette (which is meant
   * to sit over the panels).
   *
   * The MODAL veto deliberately is not decided here. This function runs off
   * the debounced mount observer, and making it also clear the class on a
   * modal put two owners on one decision, with a ~100ms lag at each edge —
   * a just-opened modal briefly covered, then the palette briefly stuck
   * behind the panels after the modal closed. Both were caught by an e2e
   * test asserting immediately, where a hand check seconds later looked
   * fine. So this owns only "does the rail want to be on top", and the
   * stylesheet vetoes it synchronously for modals with
   * `body:has(.components-modal__screen-overlay)`.
   */
  function syncLayer() {
    var region = document.getElementById('toolrail-region');
    if (!region) {
      return;
    }
    var wantsTop = settingsOpen || helpOpen || !!openFlyout || !!drag || position.dock === 'float';
    region.classList.toggle('is-raised', wantsTop);
  }

  /** Clamp + apply the floating offsets. No-op for a docked rail, whose
      geometry comes from the editor's flex layout instead. */
  /**
   * The area a floating palette may occupy, in the coordinates its `left`
   * and `top` are resolved against.
   *
   * An absolutely positioned element is laid out against its ancestor's
   * PADDING box, and clientWidth/clientHeight measure that same padding
   * box — so clamping to those alone lets the palette sit inside padding
   * the editor has deliberately reserved. Core reserves room for the
   * overlaying publish footer as a padding-bottom on __body, which is
   * exactly where a floating rail hangs: measured on a real editor, the
   * palette clamped to 849 while the footer covered 817..849, hiding 33px
   * of it. Subtracting the parent's own padding is what keeps it clear.
   *
   * @return {Object|null} {minX, minY, width, height} or null.
   */
  function floatBounds(region) {
    var parent = region && region.parentNode;
    if (!parent || !parent.clientHeight) {
      return null;
    }
    var cs = window.getComputedStyle(parent);
    var padTop = parseFloat(cs.paddingTop) || 0;
    var padBottom = parseFloat(cs.paddingBottom) || 0;
    var padLeft = parseFloat(cs.paddingLeft) || 0;
    var padRight = parseFloat(cs.paddingRight) || 0;
    return {
      minX: padLeft,
      minY: padTop,
      width: Math.max(0, parent.clientWidth - padLeft - padRight),
      height: Math.max(0, parent.clientHeight - padTop - padBottom)
    };
  }

  function applyFloatPosition() {
    var region = document.getElementById('toolrail-region');
    if (!region) {
      return;
    }
    if (position.dock !== 'float') {
      region.style.left = '';
      region.style.top = '';
      region.style.maxHeight = '';
      return;
    }

    var bounds = floatBounds(region);
    if (!bounds) {
      region.style.left = position.x + 'px';
      region.style.top = position.y + 'px';
      return;
    }

    // Cap BEFORE measuring: a rail carrying a dozen provider tools is
    // taller than the usable area, and offsetHeight has to reflect the cap
    // for the clamp below to be right.
    region.style.maxHeight = bounds.height + 'px';

    var maxX = bounds.minX + Math.max(0, bounds.width - region.offsetWidth);
    var maxY = bounds.minY + Math.max(0, bounds.height - region.offsetHeight);
    position.x = Math.min(Math.max(bounds.minX, position.x), maxX);
    position.y = Math.min(Math.max(bounds.minY, position.y), maxY);
    region.style.left = position.x + 'px';
    region.style.top = position.y + 'px';
  }

  /**
   * Move the rail to a dock. The region is rebuilt rather than restyled:
   * each dock hangs off a different node in the editor's skeleton, and the
   * rail's orientation, arrow keys and surface directions all change with
   * it.
   *
   * @param {string} dock One of DOCKS.
   * @param {Object} opts {x, y} for a float, {reopenSettings} to keep the
   *                      settings dialog open across the move.
   * @return {boolean} Whether the dock was applied.
   */
  function setDock(dock, opts) {
    if (DOCKS.indexOf(dock) === -1) {
      return false;
    }
    var options = opts || {};
    var reopen = !!options.reopenSettings;
    var previous = position.dock;

    position.dock = dock;

    // Probe the new dock BEFORE tearing the old one down. Each dock hangs
    // off a different node in the editor's skeleton, and a dock whose node
    // is not on the page would leave the rail unmounted with nothing but
    // an unrelated DOM mutation to bring it back.
    if (!dockPlacement()) {
      position.dock = previous;
      warn('cannot dock to "' + dock + '" — that part of the editor is not present.');
      return false;
    }

    if (dock === 'float') {
      if (typeof options.x === 'number') {
        position.x = options.x;
      }
      if (typeof options.y === 'number') {
        position.y = options.y;
      }
    }
    savePosition();

    closeFlyout(false);
    closeSettings(false);
    closeHelp(false);

    var existing = document.getElementById('toolrail-region');
    if (existing) {
      existing.remove();
    }
    mount();

    if (reopen) {
      var wrapper = document.getElementById('toolrail-region');
      if (wrapper) {
        openSettings(wrapper, 'input[data-dock="' + dock + '"]');
      }
    }

    window.dispatchEvent(new CustomEvent('toolrail:position-changed', {
      detail: { dock: dock, x: position.x, y: position.y }
    }));
    return true;
  }

  /**
   * Which edge a pointer at (x, y) would snap to, or 'float' if it is not
   * near one. Distances are measured against the editor body, so the snap
   * targets line up with where each dock actually lands.
   */
  function snapCandidate(clientX, clientY) {
    var body = skeletonBody();
    if (!body) {
      return 'float';
    }
    var r = body.getBoundingClientRect();
    if (clientX < r.left - SNAP_THRESHOLD || clientX > r.right + SNAP_THRESHOLD
      || clientY < r.top - SNAP_THRESHOLD || clientY > r.bottom + SNAP_THRESHOLD) {
      return 'float';
    }
    var distances = {
      left: Math.abs(clientX - r.left),
      right: Math.abs(r.right - clientX),
      top: Math.abs(clientY - r.top),
      bottom: Math.abs(r.bottom - clientY)
    };
    var best = 'float';
    var bestDistance = SNAP_THRESHOLD;
    ['left', 'right', 'top', 'bottom'].forEach(function (edge) {
      if (distances[edge] < bestDistance) {
        bestDistance = distances[edge];
        best = edge;
      }
    });
    return best;
  }

  /** Translucent band showing where a release would dock the rail. Fixed
      to the viewport so it never depends on the editor's own positioning. */
  function showSnapPreview(edge) {
    var el = document.getElementById('toolrail-snap-preview');
    var body = skeletonBody();
    if (edge === 'float' || !body) {
      if (el) {
        el.remove();
      }
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'toolrail-snap-preview';
      el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
    }
    var r = body.getBoundingClientRect();
    var box = { left: r.left, top: r.top, width: r.width, height: r.height };
    if (edge === 'left') {
      box.width = RAIL_BAND;
    } else if (edge === 'right') {
      box.left = r.right - RAIL_BAND;
      box.width = RAIL_BAND;
    } else if (edge === 'top') {
      box.height = RAIL_BAND;
    } else {
      box.top = r.bottom - RAIL_BAND;
      box.height = RAIL_BAND;
    }
    el.style.left = box.left + 'px';
    el.style.top = box.top + 'px';
    el.style.width = box.width + 'px';
    el.style.height = box.height + 'px';
  }

  var drag = null;

  function startDrag(e) {
    if (e.button !== 0) {
      return;
    }
    var region = document.getElementById('toolrail-region');
    if (!region) {
      return;
    }
    e.preventDefault();
    closeFlyout(false);
    closeSettings(false);
    closeHelp(false);

    var rect = region.getBoundingClientRect();
    drag = {
      startDock: position.dock,
      startX: position.x,
      startY: position.y,
      grabX: e.clientX - rect.left,
      grabY: e.clientY - rect.top,
      candidate: position.dock,
      torn: position.dock === 'float'
    };

    syncLayer();
    document.body.classList.add('toolrail-dragging');
    document.addEventListener('mousemove', onDragMove, true);
    document.addEventListener('mouseup', onDragEnd, true);
    document.addEventListener('keydown', onDragKey, true);
  }

  function onDragMove(e) {
    if (!drag) {
      return;
    }
    e.preventDefault();

    // Tear a docked rail off on first movement so it follows the pointer,
    // the way a docked Photoshop palette does.
    if (!drag.torn) {
      drag.torn = true;
      var parent = skeletonBody();
      var parentRect = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
      setDock('float', {
        x: e.clientX - parentRect.left - drag.grabX,
        y: e.clientY - parentRect.top - drag.grabY
      });
    }

    var region = document.getElementById('toolrail-region');
    var host = region && region.parentNode ? region.parentNode.getBoundingClientRect() : null;
    if (region && host) {
      position.x = e.clientX - host.left - drag.grabX;
      position.y = e.clientY - host.top - drag.grabY;
      applyFloatPosition();
    }

    drag.candidate = snapCandidate(e.clientX, e.clientY);
    showSnapPreview(drag.candidate);
  }

  function finishDrag() {
    showSnapPreview('float');
    document.body.classList.remove('toolrail-dragging');
    document.removeEventListener('mousemove', onDragMove, true);
    document.removeEventListener('mouseup', onDragEnd, true);
    document.removeEventListener('keydown', onDragKey, true);
    drag = null;
    syncLayer();
  }

  function onDragEnd() {
    if (!drag) {
      return;
    }
    var candidate = drag.candidate;
    var x = position.x;
    var y = position.y;
    finishDrag();
    setDock(candidate === 'float' ? 'float' : candidate, { x: x, y: y });
  }

  /** Escape abandons a drag and puts the rail back where it started. */
  function onDragKey(e) {
    if (e.key !== 'Escape' || !drag) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    var startDock = drag.startDock;
    var startX = drag.startX;
    var startY = drag.startY;
    finishDrag();
    setDock(startDock, { x: startX, y: startY });
  }

  // Keep a floating rail inside the editor when the window resizes.
  window.addEventListener('resize', function () {
    if (position.dock === 'float') {
      applyFloatPosition();
    }
  });

  // -------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------

  function toolTitle(tool) {
    return tool.hint ? tool.label + ' — ' + tool.hint : tool.label;
  }

  function buildToolButton(tool, wrapper) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toolrail-tool';
    btn.dataset.tool = tool.id;
    // The accessible NAME is the label alone; the how-to hint rides only
    // the pointer tooltip. Baking hints into aria-label made every button
    // read a wall of repeated instruction ("— click in the canvas to
    // insert…" a dozen times down the rail) to screen-reader users (owner
    // feedback 2026-08-26). Instructional copy belongs in the planned
    // help panel (private/roadmap.md), not in each button's name.
    btn.setAttribute('aria-label', tool.label);
    btn.setAttribute('aria-pressed', 'false');
    btn.title = toolTitle(tool);
    btn.tabIndex = -1;

    var icon = document.createElement('span');
    icon.className = 'toolrail-tool-icon';
    if (tool.pinnedBlock) {
      renderBlockIcon(icon, tool.blockIcon);
    } else if (tool.icon) {
      icon.innerHTML = tool.icon;
    } else {
      icon.innerHTML = ICONS.pin;
    }
    icon.setAttribute('aria-hidden', 'true');
    btn.appendChild(icon);

    // Visible only in wide mode (CSS). The accessible name stays the
    // aria-label above, which always contains this text.
    var labelSpan = document.createElement('span');
    labelSpan.className = 'toolrail-tool-label';
    labelSpan.textContent = tool.shortLabel || tool.label;
    btn.appendChild(labelSpan);

    if (tool.children && tool.children.length) {
      btn.setAttribute('aria-haspopup', 'true');
      btn.setAttribute('aria-expanded', 'false');
      var glyph = document.createElement('span');
      glyph.className = 'toolrail-flyout-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      btn.appendChild(glyph);
    }

    btn.addEventListener('click', function () {
      if (tool.children && tool.children.length && !isArmingTool(tool) && !tool.onActivate && !tool.select) {
        // A pure container (Shape): click opens the flyout.
        if (openFlyout && openFlyout.parentBtn === btn) {
          closeFlyout(true);
        } else {
          openFlyoutFor(btn, tool, wrapper);
        }
        return;
      }
      closeFlyout(false);
      if (tool.onActivate) {
        try {
          tool.onActivate();
        } catch (e) {
          warn('tool "' + tool.id + '" onActivate threw: ' + e.message);
        }
        syncPressed(true);
        return;
      }
      setActiveTool(tool.select ? 'select' : tool.id);
    });

    return btn;
  }

  function buildSeparator() {
    var sep = document.createElement('div');
    sep.className = 'toolrail-separator';
    sep.setAttribute('role', 'separator');
    return sep;
  }

  /**
   * The drag handle. Pointer-only sugar: it is aria-hidden and
   * unfocusable, because the keyboard and screen-reader path for
   * repositioning is the settings dialog's "Toolbar position" radio
   * group.
   */
  function buildGrip() {
    var grip = document.createElement('div');
    grip.className = 'toolrail-grip';
    grip.setAttribute('aria-hidden', 'true');
    grip.title = __('Drag to move the toolbar', 'toolrail');
    grip.addEventListener('mousedown', startDrag);
    return grip;
  }

  function buildRail(wrapper) {
    // The previous generation of pinned-icon React roots belongs to the
    // rail this one replaces — and so does its scroll observer.
    disposeIconRoots();
    if (railScrollObserver) {
      railScrollObserver.disconnect();
      railScrollObserver = null;
    }

    var rail = document.createElement('div');
    rail.id = 'toolrail-rail';
    rail.setAttribute('role', 'toolbar');
    rail.setAttribute('aria-orientation', isVertical() ? 'vertical' : 'horizontal');
    rail.setAttribute('aria-label', __('Tools', 'toolrail'));

    // The head shares the scroll/tail container grammar (and, crucially,
    // their cross-axis padding): the chevron is a .toolrail-tool, so
    // wide mode sizes it width:100% — as a DIRECT rail child it measured
    // 199px against 191px tool rows and its pressed edge bar rendered
    // outside the rail onto the editor (review 2026-08-27, finding 1).
    var head = document.createElement('div');
    head.className = 'toolrail-head';
    head.appendChild(buildGrip());

    // Wide-mode chevron, at the rail's head beside the grip — OPT-IN
    // via Toolbar settings (isWideToggleShown; owner decision
    // 2026-08-27: it spends prime toolbar space, and the settings
    // checkbox is the canonical path to wide mode). When shown it is a
    // REAL focusable button (the grip is pointer-only sugar; this must
    // not be): it joins the toolbar's roving tabindex via
    // .toolrail-tool, so Home lands on it and arrows reach it, keeping
    // the one-tab-stop contract. Vertical docks and the floating
    // palette only — a label-per-tool row makes a horizontal bar
    // unusably long, so the toggle does not render on top/bottom (V1
    // decision, roadmap R2).
    if (isVertical() && isWideToggleShown()) {
      var wideToggle = document.createElement('button');
      wideToggle.type = 'button';
      wideToggle.className = 'toolrail-tool toolrail-tool--wide-toggle';
      wideToggle.dataset.tool = 'wide-toggle';
      wideToggle.setAttribute('aria-label', __('Show tool names', 'toolrail'));
      wideToggle.title = __('Show tool names', 'toolrail');
      wideToggle.setAttribute('aria-pressed', isWide() ? 'true' : 'false');
      wideToggle.tabIndex = -1;
      var wideIcon = document.createElement('span');
      wideIcon.className = 'toolrail-tool-icon';
      wideIcon.innerHTML = ICONS.chevron;
      wideIcon.setAttribute('aria-hidden', 'true');
      wideToggle.appendChild(wideIcon);
      var wideLabel = document.createElement('span');
      wideLabel.className = 'toolrail-tool-label';
      // Contained in the accessible name "Show tool names" (2.5.3).
      wideLabel.textContent = __('Tool names', 'toolrail');
      wideToggle.appendChild(wideLabel);
      wideToggle.addEventListener('click', function () {
        // setWide owns the pressed-state paint (shared with the
        // settings checkbox).
        setWide(!isWide());
      });
      head.appendChild(wideToggle);
    }
    rail.appendChild(head);

    var model = railModel();

    // A rail carrying many provider tools and pins can be taller than
    // the editor, so the TOOLS live in their own scrolling section while
    // the head (grip, chevron) and the tail (Help, the gear) stay
    // pinned and visible at any height — before this split the whole
    // rail scrolled and the gear, the recovery path for everything, was
    // the first thing pushed below the fold (measured 2026-08-27 on a
    // 14-tool rail: content 833px in a 671px editor). Descendant sweeps
    // (roving tabindex, syncPressed, gearButton) are unaffected — they
    // query the rail, not its direct children.
    var scrollArea = document.createElement('div');
    scrollArea.className = 'toolrail-scroll';

    // Order (owner decision 2026-08-27): Select first; SECTION leads the
    // pinned group — it inserts the container the pinned blocks go into,
    // so it reads as part of that family; then the pinned slots
    // (Text/Heading/Image ship as defaults there); then the Section
    // overview behind a separator; then registered top-level tools. The
    // Shape tool is shelved with Phase 4 and does not render (see
    // BUILTIN_TOOLS).
    var builtinIds = {};
    var byId = {};
    BUILTIN_TOOLS.forEach(function (t) {
      builtinIds[t.id] = true;
    });
    model.tools.forEach(function (t) {
      byId[t.id] = t;
    });

    scrollArea.appendChild(buildToolButton(byId.select, wrapper));
    if (byId.section) {
      scrollArea.appendChild(buildToolButton(byId.section, wrapper));
    }

    model.slots.forEach(function (slot) {
      scrollArea.appendChild(buildToolButton(slot, wrapper));
    });

    scrollArea.appendChild(buildSeparator());
    if (byId.overview) {
      scrollArea.appendChild(buildToolButton(byId.overview, wrapper));
    }

    var registeredTop = model.tools.filter(function (t) {
      return !builtinIds[t.id];
    });
    if (registeredTop.length) {
      scrollArea.appendChild(buildSeparator());
      registeredTop.forEach(function (tool) {
        scrollArea.appendChild(buildToolButton(tool, wrapper));
      });
    }

    // The tools section hides its NATIVE scrollbars entirely (CSS): in a
    // 44px-wide column a classic Windows vertical scrollbar steals width
    // from the fixed-width tools, which then overflow sideways by a few
    // pixels and summon a horizontal scrollbar strip at the section's
    // foot (the owner's screenshot, 2026-08-27). These step buttons are
    // the visible affordance instead — each renders only while there is
    // more to scroll in its direction, Photoshop-style. Pointer sugar
    // like the grip (aria-hidden, unfocusable): wheel and touch scroll
    // the section directly, and the keyboard path is the arrow keys,
    // which scroll the focused tool into view.
    function buildScrollStep(dir) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toolrail-scrollbtn';
      btn.dataset.dir = dir;
      btn.setAttribute('aria-hidden', 'true');
      btn.tabIndex = -1;
      btn.title = __('Scroll the tools', 'toolrail');
      btn.hidden = true;
      // A real <button> takes focus on mousedown even at tabIndex -1 —
      // the grip never had this problem only because it is a <div>. An
      // aria-hidden element must never HOLD focus (it vanishes from the
      // accessibility tree while focused), so refuse the focus while
      // keeping the click (review 2026-08-27, finding 2).
      btn.addEventListener('mousedown', function (e) {
        e.preventDefault();
      });
      btn.addEventListener('click', function () {
        var delta = dir === 'prev' ? -1 : 1;
        // Instant, not smooth — a smooth scroll here would need the
        // triple motion-flatten; an instant step needs nothing.
        if (isVertical()) {
          scrollArea.scrollBy(0, delta * Math.max(88, scrollArea.clientHeight * 0.6));
        } else {
          // RTL x-scrolling runs NEGATIVE from the right edge, so
          // "forward through the tools" flips sign there.
          var rtl = getComputedStyle(scrollArea).direction === 'rtl';
          scrollArea.scrollBy((rtl ? -delta : delta) * Math.max(88, scrollArea.clientWidth * 0.6), 0);
        }
      });
      return btn;
    }
    var scrollPrev = buildScrollStep('prev');
    var scrollNext = buildScrollStep('next');

    function syncScrollSteps() {
      var vertical = isVertical();
      // abs() because RTL reports scrollLeft as 0..-max; the distance
      // from the start is what the buttons care about on either side.
      var pos = vertical ? scrollArea.scrollTop : Math.abs(scrollArea.scrollLeft);
      var max = vertical
        ? scrollArea.scrollHeight - scrollArea.clientHeight
        : scrollArea.scrollWidth - scrollArea.clientWidth;
      scrollPrev.hidden = pos <= 0;
      scrollNext.hidden = pos >= max - 1;
    }
    scrollArea.addEventListener('scroll', syncScrollSteps);
    if (window.ResizeObserver) {
      // The initial sync below runs before the rail is in the DOM (all
      // sizes read 0, so both buttons hide); the observer fires once
      // the section gets its real box after insertion, and again on any
      // editor resize — panel toggles included.
      railScrollObserver = new ResizeObserver(syncScrollSteps);
      railScrollObserver.observe(scrollArea);
    }
    syncScrollSteps();
    // Post-insertion pass: mount() inserts the rail synchronously after
    // buildRail returns, so this reads real sizes even in a browser
    // with no ResizeObserver — with native scrollbars hidden, the step
    // buttons are the ONLY scroll affordance and must not depend on the
    // observer alone.
    window.setTimeout(syncScrollSteps, 0);

    rail.appendChild(scrollPrev);
    rail.appendChild(scrollArea);
    rail.appendChild(scrollNext);

    // The always-visible tail. The help "?" sits last-but-one, beside
    // the gear — unless the author hid it (Toolbar settings), in which
    // case the panel stays reachable from the Help button inside that
    // dialog.
    var tail = document.createElement('div');
    tail.className = 'toolrail-tail';
    tail.appendChild(buildSeparator());
    if (!isHelpHidden()) {
      var help = document.createElement('button');
      help.type = 'button';
      help.className = 'toolrail-tool toolrail-tool--help';
      help.dataset.tool = 'help';
      help.setAttribute('aria-label', __('Toolbar help', 'toolrail'));
      help.title = __('Toolbar help', 'toolrail');
      help.setAttribute('aria-haspopup', 'dialog');
      help.setAttribute('aria-expanded', helpOpen ? 'true' : 'false');
      help.tabIndex = -1;
      var helpIcon = document.createElement('span');
      helpIcon.className = 'toolrail-tool-icon';
      helpIcon.innerHTML = ICONS.help;
      helpIcon.setAttribute('aria-hidden', 'true');
      help.appendChild(helpIcon);
      var helpLabel = document.createElement('span');
      helpLabel.className = 'toolrail-tool-label';
      helpLabel.textContent = __('Help', 'toolrail');
      help.appendChild(helpLabel);
      help.addEventListener('click', function () {
        openHelp(wrapper);
      });
      tail.appendChild(help);
    }

    // The settings gear is always the rail's last control.
    var gear = document.createElement('button');
    gear.type = 'button';
    gear.className = 'toolrail-tool toolrail-tool--settings';
    gear.dataset.tool = 'settings';
    gear.setAttribute('aria-label', __('Toolbar settings — choose which blocks show as quick-insert tools', 'toolrail'));
    gear.title = __('Toolbar settings', 'toolrail');
    gear.setAttribute('aria-haspopup', 'dialog');
    gear.setAttribute('aria-expanded', settingsOpen ? 'true' : 'false');
    gear.tabIndex = -1;
    var gearIcon = document.createElement('span');
    gearIcon.className = 'toolrail-tool-icon';
    gearIcon.innerHTML = ICONS.gear;
    gearIcon.setAttribute('aria-hidden', 'true');
    gear.appendChild(gearIcon);
    var gearLabel = document.createElement('span');
    gearLabel.className = 'toolrail-tool-label';
    gearLabel.textContent = __('Settings', 'toolrail');
    gear.appendChild(gearLabel);
    gear.addEventListener('click', function () {
      openSettings(wrapper);
    });
    tail.appendChild(gear);
    rail.appendChild(tail);

    // Roving tabindex: exactly one tab stop. The INITIAL stop is Select
    // (the primary tool), not whatever happens to render first — the
    // wide-mode chevron sits ahead of it in DOM order but is chrome, not
    // where entering the toolbar should land. Home/End and arrows still
    // reach every control, chevron included.
    var firstBtn = rail.querySelector('[data-tool="select"]') || rail.querySelector('.toolrail-tool');
    if (firstBtn) {
      firstBtn.tabIndex = 0;
    }

    // APG toolbar keys, following the rail's orientation: Up/Down move
    // along a vertical rail and ArrowRight opens a flyout, while a
    // horizontal rail moves on Left/Right and opens its flyouts with
    // ArrowDown. The move axis and the open key are never the same key.
    rail.addEventListener('keydown', function (e) {
      var vertical = isVertical();
      var nextKey = vertical ? 'ArrowDown' : 'ArrowRight';
      var prevKey = vertical ? 'ArrowUp' : 'ArrowLeft';
      var openKey = vertical ? 'ArrowRight' : 'ArrowDown';

      if ([nextKey, prevKey, openKey, 'Home', 'End'].indexOf(e.key) === -1) {
        return;
      }
      var btns = Array.prototype.slice.call(rail.querySelectorAll('.toolrail-tool'));
      var idx = btns.indexOf(document.activeElement);
      if (idx === -1) {
        return;
      }
      e.preventDefault();
      if (e.key === openKey) {
        var toolId = btns[idx].dataset.tool;
        var tool = findTool(toolId);
        if (tool && tool.children && tool.children.length) {
          openFlyoutFor(btns[idx], tool, wrapper);
        }
        return;
      }
      var next = e.key === nextKey ? (idx + 1) % btns.length
        : e.key === prevKey ? (idx - 1 + btns.length) % btns.length
          : e.key === 'Home' ? 0 : btns.length - 1;
      btns.forEach(function (b) { b.tabIndex = -1; });
      btns[next].tabIndex = 0;
      btns[next].focus();
    });

    return rail;
  }

  function buildWrapper() {
    var wrapper = document.createElement('div');
    wrapper.id = 'toolrail-region';
    // interface-navigable-region joins the editor's region-navigation cycle
    // (the Phase 0 gap: the theme rail was unreachable via that shortcut).
    wrapper.className = 'interface-navigable-region toolrail-region';
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', __('Tool rail', 'toolrail'));
    wrapper.tabIndex = -1;
    // Every dock-dependent style keys off this: rail orientation, which
    // border carries the edge, and which way surfaces open.
    wrapper.dataset.dock = position.dock;
    // Wide mode is persisted independently of the dock; the wide CSS is
    // keyed to vertical docks + float, so a stored wide state is simply
    // inert while the rail is horizontal.
    if (isWide()) {
      wrapper.dataset.wide = 'true';
    }
    applyAppearance(wrapper);

    wrapper.appendChild(buildRail(wrapper));

    // Drop target: pin a block type dragged from the inserter (or a canvas
    // block) onto the rail. Pointer sugar — the keyboard path is the block
    // menu's "Pin to toolbar" item.
    wrapper.addEventListener('dragover', function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'wp-blocks') !== -1) {
        e.preventDefault();
        wrapper.classList.add('is-drop-target');
      }
    });
    wrapper.addEventListener('dragleave', function () {
      wrapper.classList.remove('is-drop-target');
    });
    wrapper.addEventListener('drop', function (e) {
      wrapper.classList.remove('is-drop-target');
      if (!e.dataTransfer) {
        return;
      }
      var raw = e.dataTransfer.getData('wp-blocks');
      if (!raw) {
        return;
      }
      e.preventDefault();
      try {
        var data = JSON.parse(raw);
        var name = '';
        if (data && data.type === 'inserter' && Array.isArray(data.blocks) && data.blocks[0]) {
          name = data.blocks[0].name || '';
        } else if (data && Array.isArray(data.srcClientIds) && data.srcClientIds[0]) {
          name = wp.data.select('core/block-editor').getBlockName(data.srcClientIds[0]) || '';
        }
        if (name) {
          pinBlock(name);
        }
      } catch (err) {
        /* Unrecognized payload — ignore. */
      }
    });

    return wrapper;
  }

  // -------------------------------------------------------------------
  // Pressed-state painting, change-guarded (the Phase 1 lesson: the store
  // subscription fires on every keystroke, so bail before touching the DOM
  // when nothing relevant changed; a re-mount forces a repaint because
  // fresh buttons carry default state).
  // -------------------------------------------------------------------

  var lastPaintedSignature = false;

  function pressedSignature() {
    // The Section overview toggle is pressed state too — include it so
    // the change guard never suppresses (or stales) its repaint.
    var parts = [activeTool, 'ov:' + (overviewOpen ? '1' : '0')];
    registered.forEach(function (t) {
      if (t.isActive) {
        try {
          parts.push(t.id + ':' + (t.isActive() ? '1' : '0'));
        } catch (e) {
          parts.push(t.id + ':0');
        }
      }
    });
    return parts.join('|');
  }

  function syncPressed(force) {
    var rail = document.getElementById('toolrail-rail');
    if (!rail) {
      return;
    }
    var signature = pressedSignature();
    if (!force && signature === lastPaintedSignature) {
      return;
    }
    lastPaintedSignature = signature;

    var model = railModel();

    model.tools.concat(model.slots).forEach(function (tool) {
      var btn = rail.querySelector(toolSelector(tool.id));
      if (!btn) {
        return;
      }
      var pressed = false;
      if (tool.isActive) {
        try {
          pressed = !!tool.isActive();
        } catch (e) {
          pressed = false;
        }
      } else if (tool.select) {
        pressed = activeTool === 'select';
      } else if (tool.children && tool.children.length) {
        // A parent lights when one of its children is armed.
        pressed = tool.id === activeTool || tool.children.some(function (c) { return c.id === activeTool; });
      } else {
        pressed = tool.id === activeTool;
      }
      btn.setAttribute('aria-pressed', String(pressed));
    });
  }

  // -------------------------------------------------------------------
  // Mount machinery
  // -------------------------------------------------------------------

  function mount() {
    var place = dockPlacement();
    if (!place) {
      return false;
    }
    bindCanvas();

    var existing = document.getElementById('toolrail-region');
    if (existing) {
      // Re-home a rail that the editor's own re-render moved out from
      // under its dock, without rebuilding it.
      if (!isPlacedCorrectly(existing, place)) {
        place.parent.insertBefore(existing, place.before);
        applyFloatPosition();
        syncLayer();
      }
      return true;
    }

    closeFlyout(false);
    // A destroyed region takes the settings dialog with it, but not the
    // module state that says one is open — without this the rebuilt gear
    // renders aria-expanded="true" with no dialog behind it, and its
    // listeners outlive the node they were bound for. Same for the help
    // panel.
    closeSettings(false);
    closeHelp(false);

    place.parent.insertBefore(buildWrapper(), place.before);
    applyFloatPosition();
    syncLayer();
    // Force: a re-mounted rail carries brand-new buttons.
    syncPressed(true);
    maybeAutoOpenHelp();
    return true;
  }

  /**
   * Rebuild the rail in place (registry/slot changes). Focus moves to the
   * rail's first button only if focus was inside THE RAIL — the settings
   * dialog is a sibling inside the same region, so testing the region
   * would pull focus out of the dialog on every change made from it.
   */
  function rerender() {
    var wrapper = document.getElementById('toolrail-region');
    if (!wrapper) {
      return;
    }
    closeFlyout(false);
    var oldRail = document.getElementById('toolrail-rail');
    var hadFocus = !!(oldRail && oldRail.contains(document.activeElement));
    var newRail = buildRail(wrapper);
    if (oldRail) {
      wrapper.replaceChild(newRail, oldRail);
    } else {
      wrapper.appendChild(newRail);
    }
    syncPressed(true);
    if (hadFocus) {
      var first = newRail.querySelector('[data-tool="select"]') || newRail.querySelector('.toolrail-tool');
      if (first) {
        first.focus();
      }
    }
  }

  function start() {
    var tries = 0;
    var timer = window.setInterval(function () {
      tries++;
      if (mount() || tries > 100) {
        window.clearInterval(timer);
        observe();
      }
    }, 100);

    if (wp.data.subscribe) {
      // Wrapped, not passed by reference: a subscriber must never receive
      // an argument that could read as `force` and defeat the change guard.
      wp.data.subscribe(function () { syncPressed(); });
    }
  }

  function observe() {
    if (!window.MutationObserver) {
      return;
    }
    var pending = null;
    var observer = new MutationObserver(function () {
      if (pending) {
        return;
      }
      pending = window.setTimeout(function () {
        pending = null;
        mount();
        syncLayer();
        healOverview();
      }, 100);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  window.toolrail = {
    registerTool: registerTool,
    pinBlock: pinBlock,
    unpinBlock: unpinBlock,
    isPinned: isPinned,
    moveSlot: moveSlot,
    saveConfig: saveConfig,
    loadConfig: loadConfig,
    deleteConfig: deleteConfig,
    getConfigs: loadConfigs,
    exportConfig: exportConfig,
    importConfig: importConfigPayload,
    getActiveTool: function () { return activeTool; },
    setActiveTool: setActiveTool,
    getDock: function () { return position.dock; },
    setDock: function (dock) { return setDock(dock); },
    getPosition: function () { return { dock: position.dock, x: position.x, y: position.y }; }
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
        return el(wp.blockEditor.BlockSettingsMenuControls, null, function (fillProps) {
          var clientIds = (fillProps && fillProps.selectedClientIds) || [];
          if (clientIds.length !== 1) {
            return null;
          }
          var name = wp.data.select('core/block-editor').getBlockName(clientIds[0]);
          if (!name) {
            return null;
          }
          var pinned = isPinned(name);
          return el(wp.components.MenuItem, {
            onClick: function () {
              if (pinned) {
                unpinBlock(name);
              } else {
                pinBlock(name);
              }
              if (fillProps && fillProps.onClose) {
                fillProps.onClose();
              }
            }
          }, pinned ? __('Unpin from toolbar', 'toolrail') : __('Pin to toolbar', 'toolrail'));
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
   * migrateSlots()'s stamp missing again means a wipe happened. Redo the
   * migration (idempotent, and this time nothing is racing it) and
   * repaint. Once the stamp is confirmed to have survived a dispatch,
   * there is nothing left that could ever wipe it again this page load,
   * so the watcher unsubscribes itself.
   */
  function watchPersistenceAttach() {
    if (!wp.data || typeof wp.data.subscribe !== 'function' || !prefsSelect()) {
      return;
    }

    var repairing = false;

    var unsubscribe = wp.data.subscribe(function () {
      if (repairing) {
        return;
      }
      if (readKey(MIGRATED_KEY) !== null) {
        unsubscribe();
        return;
      }
      repairing = true;
      try {
        migrateLocalToPrefs();
        migrateSlots();
        var restored = loadPosition();
        position.dock = restored.dock;
        position.x = restored.x;
        position.y = restored.y;
        var existingRegion = document.getElementById('toolrail-region');
        if (existingRegion) {
          existingRegion.remove();
        }
        mount();
      } finally {
        repairing = false;
      }
      if (readKey(MIGRATED_KEY) !== null) {
        unsubscribe();
      }
    }, 'core/preferences');
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
    position = loadPosition();
    migrateSlots();
    // These writes can still lose a race with the preferences store's
    // own async attach — watchPersistenceAttach() catches and repairs
    // that if it happens.
    watchPersistenceAttach();
    registerPinMenuItem();
    start();
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
})(window.wp);
