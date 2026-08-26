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
  var sprintf = wp.i18n ? wp.i18n.sprintf : function (s) { return s; };

  var SLOTS_KEY = 'toolrail-quick-slots';
  var CONFIGS_KEY = 'toolrail-slot-configs';
  var POSITION_KEY = 'toolrail-position';
  var SHAPE_FILL = '#b9b9b9';

  // -------------------------------------------------------------------
  // Rail position — docked to an edge, or floating like a Photoshop
  // palette. A per-user browser preference, same as the quick slots.
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
  var RAIL_BAND = 52;

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
      var raw = window.localStorage.getItem(POSITION_KEY);
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

  var position = loadPosition();

  function savePosition() {
    try {
      window.localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    } catch (e) {
      /* Position just won't persist. */
    }
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
    pin: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 2.3L6 8.7v6.6l6 3.4 6-3.4V8.7l-6-3.4zM12 8l3.5 2v4L12 16l-3.5-2v-4L12 8z"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 9a3 3 0 110 6 3 3 0 010-6zm-1.7-6h3.4l.5 2.4c.6.2 1.1.5 1.6.9l2.3-.8 1.7 3-1.8 1.6a6.7 6.7 0 010 1.8l1.8 1.6-1.7 3-2.3-.8c-.5.4-1 .7-1.6.9l-.5 2.4h-3.4l-.5-2.4a6.6 6.6 0 01-1.6-.9l-2.3.8-1.7-3 1.8-1.6a6.7 6.7 0 010-1.8L4.2 8.5l1.7-3 2.3.8c.5-.4 1-.7 1.6-.9L10.3 3z"/></svg>'
  };

  // Every React root created for a pinned-block icon, so the previous
  // generation can be unmounted. A discarded root keeps its fiber tree
  // alive, and the rail rebuilds on every slot change (the ↑/↓ buttons in
  // the settings dialog rebuild it per click) — so these accumulate fast
  // unless they are disposed. buildRail() is the ONLY producer and always
  // creates a complete new set, which makes it the correct disposal point.
  var iconRoots = [];

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
      children: SHAPES
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
    var ids = [];
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
   * and saved-set–able like anything the author pins. They seed only while
   * the storage key has never been written: an author who removes all
   * three stays at an empty set, not a resurrected default.
   */
  var DEFAULT_SLOTS = ['core/paragraph', 'core/heading', 'core/image'];

  function loadSlots() {
    try {
      var raw = window.localStorage.getItem(SLOTS_KEY);
      if (null === raw) {
        return DEFAULT_SLOTS.slice();
      }
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(function (n) { return typeof n === 'string'; }) : [];
    } catch (e) {
      return DEFAULT_SLOTS.slice();
    }
  }

  function saveSlots(slots) {
    try {
      window.localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
    } catch (e) {
      /* Private windows etc. — pinning just won't persist. */
    }
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

  // Named quick-slot configurations — a per-user browser preference like
  // the slots themselves ({name: [blockNames]} in localStorage).
  //
  // The map is deliberately PROTOTYPE-LESS. A set named '__proto__' on a
  // plain object hits Object.prototype's inherited setter: the write is
  // swallowed, nothing is stored, and saveConfig still reports success.
  // With a null prototype every name is an ordinary data property.
  function loadConfigs() {
    var out = Object.create(null);
    try {
      var raw = window.localStorage.getItem(CONFIGS_KEY);
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
    try {
      window.localStorage.setItem(CONFIGS_KEY, JSON.stringify(map));
    } catch (e) {
      /* Private windows etc. */
    }
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
    saveSlots(map[name].filter(function (n) { return typeof n === 'string'; }));
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
          __('%s (pinned) — click in the canvas to insert; Delete unpins', 'toolrail'),
          type.title || name
        ),
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
    var topLevel = BUILTIN_TOOLS.map(function (t) {
      return {
        id: t.id,
        label: t.label,
        hint: t.hint || '',
        icon: t.icon,
        select: !!t.select,
        insertBlock: t.insertBlock || '',
        createBlock: t.createBlock || null,
        onActivate: null,
        isActive: null,
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

    dispatch.insertBlocks(block, index, rootClientId);

    if (!e.shiftKey) {
      setActiveTool('select');
    }
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
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeFlyout(true);
        return;
      }
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

    var first = menu.querySelector('.toolrail-flyout-item');
    if (first) {
      first.focus();
    }
  }

  // -------------------------------------------------------------------
  // Toolbar settings dialog — choose which blocks show as quick slots,
  // reorder them, and save/load named sets. All of it is a per-user
  // browser preference (localStorage), never site or post data.
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
    document.removeEventListener('mousedown', onSettingsMousedown, true);
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
  }

  /**
   * Position picker. Dragging the rail's grip is the pointer affordance;
   * this radio group is the equivalent keyboard and screen-reader path,
   * so repositioning never depends on a drag (the same split the pinned
   * slots use for their × button and the Delete key).
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

  // -------------------------------------------------------------------
  // Saved-set import/export. Sets travel as small JSON files so a set
  // built on one site works on another — including a site whose theme or
  // plugins don't register some of the blocks. Unavailable blocks are
  // KEPT in the set and simply don't render until their provider is
  // active (the same skip-not-delete rule the rail applies to slots).
  // -------------------------------------------------------------------

  /** WP block-name grammar: namespace/name, lowercase alnum + dashes. */
  var BLOCK_NAME_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

  /** One transient line for the settings dialog's role="status" region. */
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
    var blocks = parsed.blocks.filter(function (n) {
      return typeof n === 'string' && BLOCK_NAME_PATTERN.test(n);
    });
    var dropped = parsed.blocks.length - blocks.length;

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
      dropped: dropped
    };
  }

  function importStatusMessage(result) {
    var msg = sprintf(
      /* translators: 1: set name, 2: block count. */
      __('Imported "%1$s" (%2$d blocks).', 'toolrail'),
      result.name,
      result.total
    );
    if (result.missing > 0) {
      msg += ' ' + sprintf(
        /* translators: %d: count of blocks not registered on this site. */
        __('%d of them are not available on this site — they stay in the set and appear when their plugin or theme is active.', 'toolrail'),
        result.missing
      );
    }
    if (result.dropped > 0) {
      msg += ' ' + sprintf(
        /* translators: %d: count of invalid entries. */
        __('%d invalid entries were ignored.', 'toolrail'),
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
    note.textContent = __('Pinned blocks appear on the toolbar as quick-insert tools. They are saved in this browser, for you only.', 'toolrail');
    node.appendChild(note);

    node.appendChild(buildPositionControl());

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

    // --- Pinned blocks ---
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

      var remove = settingsButton(__('Remove', 'toolrail'), function () {
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

    // --- Saved sets ---
    var setsHead = settingsRow('h3', 'toolrail-settings-subtitle');
    setsHead.textContent = __('Saved sets', 'toolrail');
    node.appendChild(setsHead);

    // Import/load outcomes land here in TEXT (never color/glyph alone).
    // Rendered on every build so the region exists before it speaks;
    // the message itself is transient — shown once, cleared on render.
    var status = settingsRow('p', 'toolrail-settings-status');
    status.setAttribute('role', 'status');
    status.id = 'toolrail-settings-status';
    status.textContent = settingsStatus;
    settingsStatus = '';
    node.appendChild(status);

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
              __('Loaded "%1$s". %2$d pinned blocks are not available on this site and stay hidden until their plugin or theme is active.', 'toolrail'),
              cfg,
              missing
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
        settingsStatus = result.ok ? importStatusMessage(result) : result.error;
        refreshSettings('#toolrail-settings-import');
      }).catch(function () {
        settingsStatus = __('The file could not be read.', 'toolrail');
        refreshSettings('#toolrail-settings-import');
      });
    });
    node.appendChild(importInput);
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

    var node = settingsRow('div', 'toolrail-settings');
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-labelledby', 'toolrail-settings-title');
    node.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeSettings(true);
      }
    });

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
    var wantsTop = settingsOpen || !!openFlyout || !!drag || position.dock === 'float';
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
    btn.setAttribute('aria-label', toolTitle(tool));
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

    if (tool.pinnedBlock) {
      btn.classList.add('toolrail-tool--pinned');
      btn.addEventListener('keydown', function (e) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          var prev = btn.previousElementSibling;
          unpinBlock(tool.pinnedBlock);
          // rerender() replaced the rail; move focus somewhere sensible.
          var rail = document.getElementById('toolrail-rail');
          var fallback = rail && rail.querySelector('.toolrail-tool');
          var target = prev && prev.dataset && prev.dataset.tool && rail
            ? rail.querySelector(toolSelector(prev.dataset.tool)) : null;
          (target || fallback || btn).focus();
        }
      });

      // Pointer-only sugar; the keyboard paths are the Delete key here and
      // the block menu's Pin/Unpin item.
      var remove = document.createElement('span');
      remove.className = 'toolrail-slot-remove';
      remove.setAttribute('aria-hidden', 'true');
      remove.textContent = '×';
      remove.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        unpinBlock(tool.pinnedBlock);
      });
      btn.appendChild(remove);
    }

    return btn;
  }

  function buildSeparator() {
    var sep = document.createElement('div');
    sep.className = 'toolrail-separator';
    sep.setAttribute('role', 'separator');
    return sep;
  }

  /**
   * The drag handle. Pointer-only sugar, exactly like the pinned slots'
   * × button: it is aria-hidden and unfocusable, because the keyboard and
   * screen-reader path for repositioning is the settings dialog's
   * "Toolbar position" radio group.
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
    // rail this one replaces.
    disposeIconRoots();

    var rail = document.createElement('div');
    rail.id = 'toolrail-rail';
    rail.setAttribute('role', 'toolbar');
    rail.setAttribute('aria-orientation', isVertical() ? 'vertical' : 'horizontal');
    rail.setAttribute('aria-label', __('Tools', 'toolrail'));

    rail.appendChild(buildGrip());

    var model = railModel();

    // Order: Select, then the pinned slots (Text/Heading/Image ship as
    // defaults there), then the remaining built-ins (Shape, Section), then
    // registered top-level tools — so the default rail reads select · text
    // · heading · image exactly as it did when those were built-ins.
    rail.appendChild(buildToolButton(model.tools[0], wrapper));

    model.slots.forEach(function (slot) {
      rail.appendChild(buildToolButton(slot, wrapper));
    });

    rail.appendChild(buildSeparator());
    model.tools.slice(1, BUILTIN_TOOLS.length).forEach(function (tool) {
      rail.appendChild(buildToolButton(tool, wrapper));
    });

    var registeredTop = model.tools.slice(BUILTIN_TOOLS.length);
    if (registeredTop.length) {
      rail.appendChild(buildSeparator());
      registeredTop.forEach(function (tool) {
        rail.appendChild(buildToolButton(tool, wrapper));
      });
    }

    // The settings gear is always the rail's last control.
    rail.appendChild(buildSeparator());
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
    gear.addEventListener('click', function () {
      openSettings(wrapper);
    });
    rail.appendChild(gear);

    // Roving tabindex: the first button is the single tab stop.
    var firstBtn = rail.querySelector('.toolrail-tool');
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
    var parts = [activeTool];
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
    // listeners outlive the node they were bound for.
    closeSettings(false);

    place.parent.insertBefore(buildWrapper(), place.before);
    applyFloatPosition();
    syncLayer();
    // Force: a re-mounted rail carries brand-new buttons.
    syncPressed(true);
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
      var first = newRail.querySelector('.toolrail-tool');
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

  // -------------------------------------------------------------------
  // Boot. _wpLoadBlockEditor resolves when the editor has actually
  // initialized (more precise than domReady — the Phase 0 spike used it);
  // domReady stays as the fallback for editors without it.
  // -------------------------------------------------------------------

  function boot() {
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
