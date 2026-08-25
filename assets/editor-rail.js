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
 * inserted as the FIRST CHILD of .interface-interface-skeleton__body so it
 * participates in the editor's flex layout; a debounced MutationObserver
 * re-mounts it across React re-renders (it survives the code-editor
 * round-trip, where the whole visual editor unmounts). Vanilla DOM on
 * purpose: the rail lives OUTSIDE the React tree it observes, so React never
 * reconciles it away.
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
  var SHAPE_FILL = '#b9b9b9';

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
    pin: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 2.3L6 8.7v6.6l6 3.4 6-3.4V8.7l-6-3.4zM12 8l3.5 2v4L12 16l-3.5-2v-4L12 8z"/></svg>'
  };

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

  var BUILTIN_TOOLS = [
    {
      id: 'select',
      label: __('Select', 'toolrail'),
      icon: ICONS.select,
      select: true
    },
    {
      id: 'text',
      label: __('Text', 'toolrail'),
      hint: __('click in the canvas to insert a paragraph; Shift-click keeps the tool active', 'toolrail'),
      icon: ICONS.text,
      insertBlock: 'core/paragraph'
    },
    {
      id: 'heading',
      label: __('Heading', 'toolrail'),
      hint: __('click in the canvas to insert a heading; Shift-click keeps the tool active', 'toolrail'),
      icon: ICONS.heading,
      insertBlock: 'core/heading'
    },
    {
      id: 'image',
      label: __('Image', 'toolrail'),
      hint: __('click in the canvas to insert an image placeholder with its media library controls', 'toolrail'),
      icon: ICONS.image,
      insertBlock: 'core/image'
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

  function loadSlots() {
    try {
      var raw = window.localStorage.getItem(SLOTS_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(function (n) { return typeof n === 'string'; }) : [];
    } catch (e) {
      return [];
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
        dashicon: typeof type.icon === 'string' ? type.icon
          : (type.icon && typeof type.icon.src === 'string' ? type.icon.src : ''),
        insertBlock: name,
        pinnedBlock: name
      };
    }).filter(Boolean);
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

    registered.forEach(function (t) {
      if (t.parent) {
        var host = null;
        topLevel.forEach(function (candidate) {
          if (candidate.id === t.parent) {
            host = candidate;
          }
        });
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

    return { tools: topLevel, slots: slotTools() };
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

    var wrapperRect = wrapper.getBoundingClientRect();
    var btnRect = btn.getBoundingClientRect();
    menu.style.top = Math.max(0, btnRect.top - wrapperRect.top) + 'px';

    wrapper.appendChild(menu);
    btn.setAttribute('aria-expanded', 'true');
    openFlyout = { node: menu, parentBtn: btn };
    document.addEventListener('mousedown', onDocMousedown, true);

    var first = menu.querySelector('.toolrail-flyout-item');
    if (first) {
      first.focus();
    }
  }

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
    if (tool.dashicon) {
      icon.className += ' dashicons dashicons-' + tool.dashicon;
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
            ? rail.querySelector('[data-tool="' + prev.dataset.tool + '"]') : null;
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

  function buildRail(wrapper) {
    var rail = document.createElement('div');
    rail.id = 'toolrail-rail';
    rail.setAttribute('role', 'toolbar');
    rail.setAttribute('aria-orientation', 'vertical');
    rail.setAttribute('aria-label', __('Tools', 'toolrail'));

    var model = railModel();

    model.tools.forEach(function (tool, i) {
      // Separate the built-in set from registered top-level tools.
      if (i === BUILTIN_TOOLS.length && registered.length) {
        rail.appendChild(buildSeparator());
      }
      rail.appendChild(buildToolButton(tool, wrapper));
    });

    if (model.slots.length) {
      rail.appendChild(buildSeparator());
      model.slots.forEach(function (slot) {
        rail.appendChild(buildToolButton(slot, wrapper));
      });
    }

    // Roving tabindex: the first button is the single tab stop.
    var firstBtn = rail.querySelector('.toolrail-tool');
    if (firstBtn) {
      firstBtn.tabIndex = 0;
    }

    // APG toolbar keys. ArrowRight opens a flyout on parents.
    rail.addEventListener('keydown', function (e) {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight'].indexOf(e.key) === -1) {
        return;
      }
      var btns = Array.prototype.slice.call(rail.querySelectorAll('.toolrail-tool'));
      var idx = btns.indexOf(document.activeElement);
      if (idx === -1) {
        return;
      }
      e.preventDefault();
      if (e.key === 'ArrowRight') {
        var toolId = btns[idx].dataset.tool;
        var tool = findTool(toolId);
        if (tool && tool.children && tool.children.length) {
          openFlyoutFor(btns[idx], tool, wrapper);
        }
        return;
      }
      var next = e.key === 'ArrowDown' ? (idx + 1) % btns.length
        : e.key === 'ArrowUp' ? (idx - 1 + btns.length) % btns.length
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
      var btn = rail.querySelector('[data-tool="' + tool.id + '"]');
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
    var body = document.querySelector('.interface-interface-skeleton__body');
    if (!body) {
      return false;
    }
    bindCanvas();
    if (document.getElementById('toolrail-region')) {
      return true;
    }
    closeFlyout(false);
    body.insertBefore(buildWrapper(), body.firstChild);
    // Force: a re-mounted rail carries brand-new buttons.
    syncPressed(true);
    return true;
  }

  /**
   * Rebuild the rail in place (registry/slot changes). Focus moves to the
   * rail's first button only if focus was inside the rail.
   */
  function rerender() {
    var wrapper = document.getElementById('toolrail-region');
    if (!wrapper) {
      return;
    }
    var hadFocus = wrapper.contains(document.activeElement);
    closeFlyout(false);
    var oldRail = document.getElementById('toolrail-rail');
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
    getActiveTool: function () { return activeTool; },
    setActiveTool: setActiveTool
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
