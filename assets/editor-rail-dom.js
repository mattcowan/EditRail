/**
 * EditRail, part 6 of 7 (editor-rail-dom.js).
 *
 * The rail itself: moving it (dock changes, floating placement, drag
 * and snap), the DOM build, drag between the rail and the canvas, the
 * "Add to toolbar" dialog, pressed-state painting and the mount
 * machinery.
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
  if (!T || T.loaded !== 5) {
    return;
  }

  // From editor-rail-core.js.
  var __ = T.__;
  var sprintf = T.sprintf;
  var speak = T.speak;
  var focusFromEvent = T.focusFromEvent;
  var SETS_TOOL_ID = T.SETS_TOOL_ID;
  var TOOLBAR_LIST_TOOL_ID = T.TOOLBAR_LIST_TOOL_ID;
  var ADD_TOOLS_TOOL_ID = T.ADD_TOOLS_TOOL_ID;
  var DOCKS = T.DOCKS;
  var SNAP_THRESHOLD = T.SNAP_THRESHOLD;
  var RAIL_BAND = T.RAIL_BAND;
  var mainToolbar = T.mainToolbar;
  var savePosition = T.savePosition;
  var announceToolbarsChange = T.announceToolbarsChange;
  var canvasNarrowMessage = T.canvasNarrowMessage;
  var regionLabel = T.regionLabel;
  var isVertical = T.isVertical;
  var skeletonBody = T.skeletonBody;
  var dockParent = T.dockParent;
  var placeToolbarRegions = T.placeToolbarRegions;
  var ICONS = T.ICONS;
  var disposeIconRoots = T.disposeIconRoots;
  var renderBlockIcon = T.renderBlockIcon;
  var renderCustomIcon = T.renderCustomIcon;
  var isWide = T.isWide;
  var isWideToggleShown = T.isWideToggleShown;
  var setWide = T.setWide;
  var syncSidebarWidth = T.syncSidebarWidth;
  var onSidebarStoreChange = T.onSidebarStoreChange;
  var applyAppearance = T.applyAppearance;

  // From editor-rail-registry.js.
  var BUILTIN_TOOLS = T.BUILTIN_TOOLS;
  var registered = T.registered;
  var warn = T.warn;
  var attrValue = T.attrValue;
  var toolSelector = T.toolSelector;
  var isPinnedOn = T.isPinnedOn;
  var pinBlock = T.pinBlock;
  var isSetsButtonShown = T.isSetsButtonShown;
  var setsMenuTool = T.setsMenuTool;
  var isToolbarsButtonShown = T.isToolbarsButtonShown;
  var toolbarsMenuTool = T.toolbarsMenuTool;
  var USER_PATTERN_SLOT_PREFIX = T.USER_PATTERN_SLOT_PREFIX;
  var coreSelect = T.coreSelect;
  var sessionUserPatterns = T.sessionUserPatterns;
  var userPatternDescriptor = T.userPatternDescriptor;
  var allPatterns = T.allPatterns;
  var railModel = T.railModel;
  var modelTool = T.modelTool;

  // From editor-rail-tools.js.
  var isArmingTool = T.isArmingTool;
  var isToggleTool = T.isToggleTool;
  var railMode = T.railMode;
  var toolAvailable = T.toolAvailable;
  var unavailableReason = T.unavailableReason;
  var buttonAvailable = T.buttonAvailable;
  var setActiveTool = T.setActiveTool;
  var makeBlocksFor = T.makeBlocksFor;
  var canvasDoc = T.canvasDoc;
  var bindCanvas = T.bindCanvas;
  var onCanvasSelectStoreChange = T.onCanvasSelectStoreChange;
  var closeFlyout = T.closeFlyout;
  var placeSurface = T.placeSurface;
  var openFlyoutFor = T.openFlyoutFor;

  // From editor-rail-settings.js.
  var placeOpenDialogs = T.placeOpenDialogs;
  var gearButton = T.gearButton;
  var closeSettings = T.closeSettings;
  var settingsRow = T.settingsRow;
  var settingsButton = T.settingsButton;
  var openSettings = T.openSettings;
  var openSettingsFor = T.openSettingsFor;
  var isHelpHidden = T.isHelpHidden;
  var closeHelp = T.closeHelp;
  var openHelp = T.openHelp;

  // From editor-rail-overview.js.
  var healOverview = T.healOverview;

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
   *
   * @param {Object} tb The toolbar.
   * @return {void}
   */
  function syncLayer(tb) {
    var region = document.getElementById(tb.regionId);
    if (!region) {
      return;
    }
    // Only the toolbar that OWNS the open surface or the drag is raised
    // for it. The three dialogs hang in the first toolbar's region. A
    // floating toolbar is always raised: it sits over the side panels,
    // and lowered it went under the settings sidebar while a dialog was
    // open (review 2026-11-16, finding 1).
    var owner = T.openFlyout ? T.openFlyout.toolbar
      : (T.settingsOpen || T.helpOpen || T.addDialogOpen) ? mainToolbar
        : T.drag ? T.drag.toolbar : null;
    var owns = owner === tb || (!!T.drag && T.drag.toolbar === tb);
    region.classList.toggle('is-raised', owns || tb.position.dock === 'float');
    // Two raised regions tie at the same z-index, and the later one in
    // the document paints over the other's flyout or dialog. So the
    // owner takes one level more (has-surface, in the stylesheet, under
    // the same modal veto). Only when a different toolbar is on the page:
    // with one toolbar there is nothing to beat, and the region keeps
    // exactly the classes it had before #95.
    var others = T.toolbars.some(function (other) {
      return other !== tb && !!document.getElementById(other.regionId);
    });
    region.classList.toggle('has-surface', owns && others);
  }

  /** syncLayer for every toolbar: one surface or drag decides them all. */
  function syncLayers() {
    T.toolbars.forEach(syncLayer);
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

  /**
   * Paint a floating palette's offsets, clamped inside its host's padding
   * box so it can never be dragged (or resized, or widened) out of reach.
   * The height cap is applied BEFORE the clamp measures: a rail carrying a
   * dozen provider tools is taller than the usable area, and offsetHeight
   * has to already reflect the cap for the clamp to be right. A no-op for
   * every docked position, which clears the inline styles instead.
   *
   * @param {Object} tb The toolbar.
   * @return {void}
   */
  function applyFloatPosition(tb) {
    var position = tb.position;
    var region = document.getElementById(tb.regionId);
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
   * @param {Object} tb   The toolbar to move.
   * @param {string} dock One of DOCKS.
   * @param {Object} opts {x, y} for a float, {reopenSettings} to keep the
   *                      settings dialog open across the move, {save: false}
   *                      to move the toolbar without a write to the stored
   *                      position (a grip drag saves only on release, #129).
   * @return {boolean} Whether the dock was applied.
   */
  function setDock(tb, dock, opts) {
    if (DOCKS.indexOf(dock) === -1) {
      return false;
    }
    var position = tb.position;
    var options = opts || {};
    var reopen = !!options.reopenSettings;
    var previous = position.dock;

    position.dock = dock;

    // Probe the new dock BEFORE tearing the old one down. Each dock hangs
    // off a different node in the editor's skeleton, and a dock whose node
    // is not on the page would leave the rail unmounted with nothing but
    // an unrelated DOM mutation to bring it back.
    if (!dockParent(tb)) {
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
    if (options.save !== false) {
      savePosition(tb);
    }

    closeFlyout(false);
    // The three dialogs hang in the FIRST toolbar's region, so only its
    // rebuild takes them down. An extra toolbar's move from Toolbar
    // settings leaves the dialog open; it is placed again below, because
    // the stack on the first toolbar's edge can have changed (#95).
    if (tb === mainToolbar) {
      closeSettings(false);
      closeHelp(false);
    }

    var existing = document.getElementById(tb.regionId);
    if (existing) {
      existing.remove();
    }
    mount(tb);

    if (reopen && tb === mainToolbar) {
      var wrapper = document.getElementById(tb.regionId);
      if (wrapper) {
        openSettings(wrapper, 'input[data-dock="' + dock + '"]');
      }
    }
    if (tb !== mainToolbar) {
      placeOpenDialogs();
    }

    // toolrail:position-changed, then toolrail:toolbars-changed.
    announceToolbarsChange(tb.id, 'position');
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

  /**
   * The room the docked toolbars on an edge take, counting only those
   * BEFORE a toolbar in toolbar order, or only those AFTER it. Each later
   * toolbar sits between the one before it and the canvas
   * (placeToolbarRegions), so the snap preview can show where a toolbar
   * lands (#95).
   *
   * @param {Object}  tb    The toolbar being dragged.
   * @param {string}  edge  'left', 'right', 'top' or 'bottom'.
   * @param {boolean} after Count the toolbars after tb, not before it.
   * @return {number} The size in px, 0 or more.
   */
  function edgeOffset(tb, edge, after) {
    var offset = 0;
    var index = T.toolbars.indexOf(tb);
    T.toolbars.forEach(function (other, i) {
      var counts = after ? i > index : i < index;
      var region = counts && other.position.dock === edge ? document.getElementById(other.regionId) : null;
      if (region) {
        var r = region.getBoundingClientRect();
        offset += edge === 'top' || edge === 'bottom' ? r.height : r.width;
      }
    });
    return offset;
  }

  /** Translucent band showing where a release would dock the rail. Fixed
      to the viewport so it never depends on the editor's own positioning.
      @param {string}      edge The edge, or 'float' to remove the band.
      @param {Object|null} tb   The toolbar being dragged. */
  function showSnapPreview(edge, tb) {
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
    // The left and right docks hang INSIDE __body, so its edge is the
    // editor's edge and the toolbars before tb push the band inward. The
    // top and bottom docks hang OUTSIDE __body, in __editor, so its edge
    // is already past every docked bar there: tb lands next to __body,
    // past only the bars that come AFTER it in toolbar order (PR #126
    // review, CodeRabbit: counting the ones before it put the band one
    // bar too far).
    if (edge === 'left') {
      box.left = r.left + (tb ? edgeOffset(tb, edge, false) : 0);
      box.width = RAIL_BAND;
    } else if (edge === 'right') {
      box.left = r.right - RAIL_BAND - (tb ? edgeOffset(tb, edge, false) : 0);
      box.width = RAIL_BAND;
    } else if (edge === 'top') {
      // At __body's top, where the bar lands as __body moves down for it
      // (the band as it was with one toolbar), above the later bars.
      box.top = r.top - (tb ? edgeOffset(tb, edge, true) : 0);
      box.height = RAIL_BAND;
    } else {
      // The publish footer overlays the bottom of __body, which core keeps
      // clear with a padding-bottom there. The first bar on the bottom
      // edge takes the same room as a margin below itself (the
      // stylesheet's .has-footer rule), so it lands above the footer, not
      // at __body's edge. A bar already on the bottom edge holds that
      // margin outside __body, so it is not counted twice (PR #126
      // review, CodeRabbit).
      var footerRoom = 0;
      var bottomTaken = T.toolbars.some(function (other) {
        return other.position.dock === 'bottom' && !!document.getElementById(other.regionId);
      });
      if (!bottomTaken) {
        footerRoom = parseFloat(window.getComputedStyle(body).paddingBottom) || 0;
      }
      box.top = r.bottom - RAIL_BAND - footerRoom + (tb ? edgeOffset(tb, edge, true) : 0);
      box.height = RAIL_BAND;
    }
    el.style.left = box.left + 'px';
    el.style.top = box.top + 'px';
    el.style.width = box.width + 'px';
    el.style.height = box.height + 'px';
  }

  // The toolbar drag in flight: {toolbar, startDock, startX, startY,
  // grabX, grabY, candidate, torn}, or null. One for the page, not one
  // for each toolbar (see newToolbar): there is one pointer, so one drag,
  // and its three document listeners are single functions that read this
  // one record. The record names the toolbar that is moving.
  T.drag = null;

  /**
   * Begin a rail drag from the grip: close every open surface, record the
   * grab offset and the dock to return to on Escape, then listen for the
   * move, the release and the cancel.
   *
   * @param {Object}     tb The toolbar the grip belongs to.
   * @param {MouseEvent} e  The grip mousedown.
   * @return {void}
   */
  function startDrag(tb, e) {
    if (e.button !== 0) {
      return;
    }
    var position = tb.position;
    var region = document.getElementById(tb.regionId);
    if (!region) {
      return;
    }
    e.preventDefault();
    closeFlyout(false);
    closeSettings(false);
    closeHelp(false);

    var rect = region.getBoundingClientRect();
    T.drag = {
      toolbar: tb,
      startDock: position.dock,
      startX: position.x,
      startY: position.y,
      grabX: e.clientX - rect.left,
      grabY: e.clientY - rect.top,
      candidate: position.dock,
      torn: position.dock === 'float'
    };

    syncLayers();
    document.body.classList.add('toolrail-dragging');
    document.addEventListener('mousemove', onDragMove, true);
    document.addEventListener('mouseup', onDragEnd, true);
    document.addEventListener('keydown', onDragKey, true);
  }

  /**
   * Follow the pointer, tearing a DOCKED rail off on the first movement so
   * it moves the way a docked palette in a graphics editor does, then show
   * the snap preview for whichever edge the pointer is near.
   *
   * @param {MouseEvent} e The document mousemove.
   * @return {void}
   */
  function onDragMove(e) {
    if (!T.drag) {
      return;
    }
    e.preventDefault();
    var tb = T.drag.toolbar;

    // Tear a docked rail off on first movement so it follows the pointer,
    // the way a docked palette in a graphics editor does.
    if (!T.drag.torn) {
      T.drag.torn = true;
      var parent = skeletonBody();
      var parentRect = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
      // No save: the release saves, and Escape must find the stored
      // position as it was before the drag (#129).
      setDock(tb, 'float', {
        x: e.clientX - parentRect.left - T.drag.grabX,
        y: e.clientY - parentRect.top - T.drag.grabY,
        save: false
      });
    }

    var region = document.getElementById(tb.regionId);
    var host = region && region.parentNode ? region.parentNode.getBoundingClientRect() : null;
    if (region && host) {
      tb.position.x = e.clientX - host.left - T.drag.grabX;
      tb.position.y = e.clientY - host.top - T.drag.grabY;
      applyFloatPosition(tb);
    }

    T.drag.candidate = snapCandidate(e.clientX, e.clientY);
    showSnapPreview(T.drag.candidate, tb);
  }

  /**
   * Tear the drag down: clear the snap preview and the dragging class, and
   * release all three document listeners. Shared by the release and the
   * Escape path, so neither can leave the rail stuck in drag state.
   */
  function finishDrag() {
    showSnapPreview('float');
    document.body.classList.remove('toolrail-dragging');
    document.removeEventListener('mousemove', onDragMove, true);
    document.removeEventListener('mouseup', onDragEnd, true);
    document.removeEventListener('keydown', onDragKey, true);
    T.drag = null;
    syncLayers();
  }

  /**
   * Release the rail into the dock the snap preview was showing, or leave
   * it floating at the position it was dragged to.
   */
  function onDragEnd() {
    if (!T.drag) {
      return;
    }
    var tb = T.drag.toolbar;
    var candidate = T.drag.candidate;
    var x = tb.position.x;
    var y = tb.position.y;
    finishDrag();
    setDock(tb, candidate === 'float' ? 'float' : candidate, { x: x, y: y });
    // A drop on an edge can leave the canvas too narrow (owner decision
    // 2026-11-16). The drag says nothing else.
    var narrow = canvasNarrowMessage();
    if (narrow) {
      speak(narrow);
    }
  }

  /**
   * Escape abandons a drag and puts the rail back where it started. It
   * saves nothing (#129). The start values are the PAINTED offsets, which
   * applyFloatPosition() clamps into a narrow window. A save here would
   * write that clamp over the place the author chose.
   */
  function onDragKey(e) {
    if (e.key !== 'Escape' || !T.drag) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    var tb = T.drag.toolbar;
    var startDock = T.drag.startDock;
    var startX = T.drag.startX;
    var startY = T.drag.startY;
    finishDrag();
    setDock(tb, startDock, { x: startX, y: startY, save: false });
  }

  // Keep a floating rail inside the editor when the window resizes, and
  // re-clamp the settings sidebar, whose maximum follows the window.
  // Nothing until start() runs: when editor-rail.js does not load, the
  // rail never starts, and a resize must leave the editor alone.
  var railStarted = false;
  window.addEventListener('resize', function () {
    if (!railStarted) {
      return;
    }
    T.toolbars.forEach(function (tb) {
      if (tb.position.dock === 'float') {
        applyFloatPosition(tb);
      }
    });
    syncSidebarWidth();
  });

  // -------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------

  function toolTitle(tool) {
    return tool.hint ? tool.label + ' — ' + tool.hint : tool.label;
  }

  /**
   * Build one tool button. The accessible NAME is the label alone, and
   * the tooltip carries only an author-written description (or the
   * "not available" reason while dimmed): a generic how-to in either
   * place is read on every stop down the rail — in aria-label as the
   * name, in `title` as the description (SR-1, QA 2026-09-11). The help
   * panel holds the how-to. An arming tool is also draggable into the
   * canvas, carrying the payload core's own inserter sends so core's drop
   * zone owns the rest; the keyboard path stays arm, then Ctrl+Enter.
   *
   * @param {Object}      tb      The toolbar the button is built for.
   * @param {Object}      tool    A railModel() entry.
   * @param {HTMLElement} wrapper The positioned region, for flyout placing.
   * @return {HTMLButtonElement} The button.
   */
  function buildToolButton(tb, tool, wrapper) {
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
    // A description the AUTHOR wrote for a pinned tool (Edit in Toolbar
    // settings) is set as the accessible description explicitly. The
    // how-to hint rides only the title attribute below, which assistive
    // tech MAY read as a fallback description; the author's text should
    // not depend on that fallback.
    if (tool.description) {
      btn.setAttribute('aria-description', tool.description);
    }
    btn.setAttribute('aria-pressed', 'false');
    btn.title = toolTitle(tool);
    btn.tabIndex = -1;
    // What kind of button this is (R10): 'toggle' = pressed means "this
    // tool's surface is open"; 'arming' = pressed means "armed, the next
    // canvas click inserts"; 'select' = pressed means "nothing armed".
    // No ARIA change — aria-pressed is right for all three — but a hook
    // for the stylesheet to draw toggles differently from armed tools.
    btn.dataset.kind = tool.select ? 'select'
      : isToggleTool(tool) ? 'toggle'
        : tool.onActivate ? 'action'
          : isArmingTool(tool) ? 'arming' : 'container';

    var icon = document.createElement('span');
    icon.className = 'toolrail-tool-icon';
    if (tool.customIcon) {
      renderCustomIcon(icon, tool.customIcon);
    } else if (tool.pinnedBlock) {
      renderBlockIcon(tb, icon, tool.blockIcon);
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

    // Pointer sugar (0.1.23): an arming tool can also be DRAGGED into
    // the canvas, the way core's inserter items can. The payload is the
    // one core's inserter sends, so core's drop zone owns the rest —
    // the drop line, the target, the insert — and nothing arms. The
    // keyboard and screen-reader path stays arm, then Ctrl+Enter
    // (insertOnKey).
    if (isArmingTool(tool)) {
      btn.draggable = true;
      btn.addEventListener('dragstart', function (e) {
        onToolDragStart(e, tool, tb);
      });
      btn.addEventListener('dragend', function () {
        railDragActive = false;
        railDragToolbar = null;
      });
    }

    btn.addEventListener('click', function () {
      var pureContainer = tool.children && tool.children.length && !isArmingTool(tool) && !tool.onActivate && !tool.select;
      // R9: an unavailable tool whose flyout still has a live child
      // behaves as a container — the click opens the flyout instead of
      // arming; a fully dimmed button is inert (aria-disabled).
      if (pureContainer || (!toolAvailable(tool) && buttonAvailable(tool))) {
        if (T.openFlyout && T.openFlyout.parentBtn === btn) {
          closeFlyout(true);
        } else {
          openFlyoutFor(tb, btn, tool, wrapper);
        }
        return;
      }
      if (!toolAvailable(tool)) {
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
      // A second press on the ARMED tool disarms it — a pressed button
      // that stays pressed when pressed again reads as stuck, and it was
      // the keyboard author's only way back besides Select (QA
      // 2026-09-11, C8; owner decision the same day). A parent shows as
      // pressed while one of its flyout children is armed (syncPressed),
      // so a press on it disarms too: arming a child returns focus here,
      // and the press used to arm the parent instead, silently (review
      // 2026-10-01, owner decision the same day).
      var childArmed = !!(tool.children && tool.children.some(function (c) { return c.id === T.activeTool; }));
      if (!tool.select && (T.activeTool === tool.id || childArmed)) {
        setActiveTool('select');
        speak(__('Tool disarmed. Select is active.', 'editrail'));
        return;
      }
      setActiveTool(tool.select ? 'select' : tool.id);
    });

    return btn;
  }

  /**
   * A separator between groups of rail buttons.
   *
   * @return {HTMLElement} The separator.
   */
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
   *
   * @param {Object} tb The toolbar the grip moves.
   * @return {HTMLElement} The grip.
   */
  function buildGrip(tb) {
    var grip = document.createElement('div');
    grip.className = 'toolrail-grip';
    grip.setAttribute('aria-hidden', 'true');
    grip.title = __('Drag to move the toolbar', 'editrail');
    grip.addEventListener('mousedown', function (e) {
      startDrag(tb, e);
    });
    return grip;
  }

  /**
   * The one button of an extra toolbar that has no pinned tool yet: it
   * opens Toolbar settings with that toolbar chosen, at the search that
   * pins to it. Rail chrome with a reserved id (allToolIds).
   *
   * @param {Object} tb An extra toolbar.
   * @return {Object} The tool descriptor.
   */
  function addToolsTool(tb) {
    return {
      id: ADD_TOOLS_TOOL_ID,
      label: sprintf(
        /* translators: %s: the toolbar's name. */
        __('Add tools to %s', 'editrail'),
        tb.name
      ),
      shortLabel: __('Add tools', 'editrail'),
      icon: ICONS.add,
      supports: { canvas: false },
      onActivate: function () {
        openSettingsFor(tb, '#toolrail-settings-search');
      }
    };
  }

  /**
   * Build the whole toolbar: the head (grip and optional expander), the
   * scrolling tools section with its step buttons, and the always-visible
   * tail (help and settings). Owns the roving tabindex — one stop for the
   * toolbar, arrows within — and disposes the previous generation's icon
   * roots and scroll observer, since it is their only producer.
   *
   * @param {Object}      tb      The toolbar to build.
   * @param {HTMLElement} wrapper The positioned region.
   * @return {HTMLElement} The rail.
   */
  function buildRail(tb, wrapper) {
    // The previous generation of pinned-icon React roots belongs to the
    // rail this one replaces — and so does its scroll observer.
    disposeIconRoots(tb);
    if (tb.scrollObserver) {
      tb.scrollObserver.disconnect();
      tb.scrollObserver = null;
    }

    var rail = document.createElement('div');
    rail.id = tb.railId;
    // The stylesheet styles every rail by this class. The id is the
    // toolbar's own, so it cannot carry rules that each toolbar needs.
    rail.className = 'toolrail-rail';
    rail.setAttribute('role', 'toolbar');
    rail.setAttribute('aria-orientation', isVertical(tb) ? 'vertical' : 'horizontal');
    // An extra toolbar's accessible name is the name the author gave it.
    // The first toolbar's stays "Tools" (owner decision 2026-11-14, #95).
    var first = tb === mainToolbar;
    rail.setAttribute('aria-label', first ? __('Tools', 'editrail') : tb.name);

    // The head shares the scroll/tail container grammar (and, crucially,
    // their cross-axis padding): the chevron is a .toolrail-tool, so
    // wide mode sizes it width:100% — as a DIRECT rail child it measured
    // 199px against 191px tool rows and its pressed edge bar rendered
    // outside the rail onto the editor (review 2026-08-27, finding 1).
    var head = document.createElement('div');
    head.className = 'toolrail-head';
    head.appendChild(buildGrip(tb));

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
    if (isVertical(tb) && isWideToggleShown()) {
      var wideToggle = document.createElement('button');
      wideToggle.type = 'button';
      wideToggle.className = 'toolrail-tool toolrail-tool--wide-toggle';
      wideToggle.dataset.tool = 'wide-toggle';
      wideToggle.setAttribute('aria-label', __('Show tool names', 'editrail'));
      wideToggle.title = __('Show tool names', 'editrail');
      wideToggle.setAttribute('aria-pressed', isWide(tb) ? 'true' : 'false');
      // A toggle (pressed = "names are showing"), so it takes the R10
      // bar-only treatment — built inline, it would otherwise miss the
      // data-kind buildToolButton stamps (review 2026-08-29).
      wideToggle.dataset.kind = 'toggle';
      wideToggle.tabIndex = -1;
      var wideIcon = document.createElement('span');
      wideIcon.className = 'toolrail-tool-icon';
      wideIcon.innerHTML = ICONS.chevron;
      wideIcon.setAttribute('aria-hidden', 'true');
      wideToggle.appendChild(wideIcon);
      var wideLabel = document.createElement('span');
      wideLabel.className = 'toolrail-tool-label';
      // Contained in the accessible name "Show tool names" (2.5.3).
      wideLabel.textContent = __('Tool names', 'editrail');
      wideToggle.appendChild(wideLabel);
      wideToggle.addEventListener('click', function () {
        // setWide owns the pressed-state paint (shared with the
        // settings checkbox). Each toolbar's chevron widens that toolbar
        // (#95).
        setWide(tb, !isWide(tb));
        // A wider toolbar on the first toolbar's edge moves where the
        // dialogs must sit.
        placeOpenDialogs();
        // And it can leave the canvas too narrow (owner decision
        // 2026-11-16). The chevron says nothing else, so this is the
        // one message.
        var narrow = isWide(tb) ? canvasNarrowMessage() : '';
        if (narrow) {
          speak(narrow);
        }
      });
      head.appendChild(wideToggle);
    }
    rail.appendChild(head);

    var model = railModel(tb);

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

    // An extra toolbar has no built-in tools (#95): its model is its pins
    // and the provider tools nested under them.
    if (byId.select) {
      scrollArea.appendChild(buildToolButton(tb, byId.select, wrapper));
    }
    if (byId.section) {
      scrollArea.appendChild(buildToolButton(tb, byId.section, wrapper));
    }

    model.slots.forEach(function (slot) {
      scrollArea.appendChild(buildToolButton(tb, slot, wrapper));
    });

    // An extra toolbar with no pins would have no button at all: no Tab
    // stop, and an empty role="toolbar". It shows one button that opens
    // Toolbar settings for it, until its first pin.
    if (!first && !model.slots.length) {
      scrollArea.appendChild(buildToolButton(tb, addToolsTool(tb), wrapper));
    }

    if (first) {
      scrollArea.appendChild(buildSeparator());
    }
    if (byId.overview) {
      scrollArea.appendChild(buildToolButton(tb, byId.overview, wrapper));
    }

    var registeredTop = model.tools.filter(function (t) {
      return !builtinIds[t.id];
    });
    if (registeredTop.length) {
      scrollArea.appendChild(buildSeparator());
      registeredTop.forEach(function (tool) {
        scrollArea.appendChild(buildToolButton(tb, tool, wrapper));
      });
    }

    // The tools section hides its NATIVE scrollbars entirely (CSS): in a
    // 44px-wide column a classic Windows vertical scrollbar steals width
    // from the fixed-width tools, which then overflow sideways by a few
    // pixels and summon a horizontal scrollbar strip at the section's
    // foot (the owner's screenshot, 2026-08-27). These step buttons are
    // the visible affordance instead — each renders only while there is
    // more to scroll in its direction, as in a graphics editor. Pointer sugar
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
      btn.title = __('Scroll the tools', 'editrail');
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
        if (isVertical(tb)) {
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

    /**
     * Show each scroll step button only when there is something that way.
     * Distance is read as an absolute, because a right-to-left rail reports
     * scrollLeft as 0 down to -max and the buttons care about the distance
     * from the start on either side.
     */
    function syncScrollSteps() {
      var vertical = isVertical(tb);
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
      tb.scrollObserver = new ResizeObserver(syncScrollSteps);
      tb.scrollObserver.observe(scrollArea);
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

    // Only the first toolbar has a tail: Saved sets, Toolbars, Help and
    // Toolbar settings are one each for the page (owner decision
    // 2026-11-14, #95), and each dialog returns focus to its button here.
    if (first) {
      rail.appendChild(buildRailTail(tb, wrapper));
    }

    // Roving tabindex: exactly one tab stop. The INITIAL stop is Select
    // (the primary tool), not whatever happens to render first — the
    // wide-mode chevron sits ahead of it in DOM order but is chrome, not
    // where entering the toolbar should land. Home/End and arrows still
    // reach every control, chevron included. An extra toolbar has no
    // Select; its first tool is the stop, for the same reason.
    var firstBtn = rail.querySelector('[data-tool="select"]')
      || scrollArea.querySelector('.toolrail-tool')
      || rail.querySelector('.toolrail-tool');
    if (firstBtn) {
      firstBtn.tabIndex = 0;
    }

    bindRailKeys(tb, rail, wrapper);
    return rail;
  }

  /**
   * The first toolbar's always-visible tail: the Saved sets and Toolbars
   * buttons when they show, Help, and the settings gear last.
   *
   * @param {Object}      tb      The first toolbar.
   * @param {HTMLElement} wrapper Its region.
   * @return {HTMLElement} The tail.
   */
  function buildRailTail(tb, wrapper) {
    // The always-visible tail. The help "?" sits last-but-one, beside
    // the gear — unless the author hid it (Toolbar settings), in which
    // case the panel stays reachable from the Help button inside that
    // dialog.
    var tail = document.createElement('div');
    tail.className = 'toolrail-tail';
    tail.appendChild(buildSeparator());
    // Saved sets (#93): first in the tail, so the switch sits with the
    // other toolbar-level controls and stays visible however many tools
    // scroll above it.
    if (isSetsButtonShown()) {
      tail.appendChild(buildToolButton(tb, setsMenuTool(wrapper), wrapper));
    }
    // Toolbars (#95): shows or hides each extra toolbar. Only while an
    // extra toolbar exists; see isToolbarsButtonShown().
    if (isToolbarsButtonShown()) {
      tail.appendChild(buildToolButton(tb, toolbarsMenuTool(), wrapper));
    }
    if (!isHelpHidden()) {
      var help = document.createElement('button');
      help.type = 'button';
      help.className = 'toolrail-tool toolrail-tool--help';
      help.dataset.tool = 'help';
      help.setAttribute('aria-label', __('Toolbar help', 'editrail'));
      help.title = __('Toolbar help', 'editrail');
      help.setAttribute('aria-haspopup', 'dialog');
      help.setAttribute('aria-expanded', T.helpOpen ? 'true' : 'false');
      help.tabIndex = -1;
      var helpIcon = document.createElement('span');
      helpIcon.className = 'toolrail-tool-icon';
      helpIcon.innerHTML = ICONS.help;
      helpIcon.setAttribute('aria-hidden', 'true');
      help.appendChild(helpIcon);
      var helpLabel = document.createElement('span');
      helpLabel.className = 'toolrail-tool-label';
      helpLabel.textContent = __('Help', 'editrail');
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
    gear.setAttribute('aria-label', __('Toolbar settings — choose which blocks show as quick-insert tools', 'editrail'));
    gear.title = __('Toolbar settings', 'editrail');
    gear.setAttribute('aria-haspopup', 'dialog');
    gear.setAttribute('aria-expanded', T.settingsOpen ? 'true' : 'false');
    gear.tabIndex = -1;
    var gearIcon = document.createElement('span');
    gearIcon.className = 'toolrail-tool-icon';
    gearIcon.innerHTML = ICONS.gear;
    gearIcon.setAttribute('aria-hidden', 'true');
    gear.appendChild(gearIcon);
    var gearLabel = document.createElement('span');
    gearLabel.className = 'toolrail-tool-label';
    gearLabel.textContent = __('Settings', 'editrail');
    gear.appendChild(gearLabel);
    gear.addEventListener('click', function () {
      openSettings(wrapper);
    });
    tail.appendChild(gear);
    return tail;
  }

  /**
   * Bind a rail's two keyboard listeners: the roving tab stop follows
   * focus, and the APG toolbar keys move it. Each rail gets its own pair,
   * so arrow keys stay inside one toolbar (#95).
   *
   * @param {Object}      tb      The toolbar.
   * @param {HTMLElement} rail    Its rail.
   * @param {HTMLElement} wrapper Its region.
   * @return {void}
   */
  function bindRailKeys(tb, rail, wrapper) {
    // The tab stop follows FOCUS, not only the arrow keys. A mouse click,
    // or a screen reader that moves focus onto the button it activates,
    // puts focus on a tool without the keydown handler below; the stop
    // then stayed on the last arrowed-to tool, and Tab from the focused
    // tool went to that stop when it sat later in the DOM — Toolbar
    // settings after End — instead of leaving the toolbar (QA 2026-09-11,
    // SR-2, traced 2026-09-22). The APG toolbar pattern keeps the stop on
    // the focused item.
    rail.addEventListener('focusin', function (e) {
      var target = e.target;
      if (!target || !target.classList || !target.classList.contains('toolrail-tool') || target.tabIndex === 0) {
        return;
      }
      Array.prototype.slice.call(rail.querySelectorAll('.toolrail-tool')).forEach(function (b) {
        b.tabIndex = -1;
      });
      target.tabIndex = 0;
    });

    // APG toolbar keys, following the rail's orientation: Up/Down move
    // along a vertical rail and ArrowRight opens a flyout, while a
    // horizontal rail moves on Left/Right and opens its flyouts with
    // ArrowDown. The move axis and the open key are never the same key.
    rail.addEventListener('keydown', function (e) {
      var vertical = isVertical(tb);
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
        // The Saved sets and Toolbars buttons are rail chrome, not
        // registered tools, so findTool() does not know them.
        // A tool is looked up in THIS toolbar's model: the same pin can
        // have a different flyout on two toolbars (a provider child can
        // nest under a provider tool on the first toolbar and under the
        // pin on an extra one), and the page-wide findTool() returns the
        // first toolbar's (PR #126 review, CodeRabbit).
        var tool = toolId === SETS_TOOL_ID ? setsMenuTool(wrapper)
          : toolId === TOOLBAR_LIST_TOOL_ID ? toolbarsMenuTool()
            : modelTool(tb, toolId);
        // Same gate as the click path: a fully dimmed container offers
        // no flyout by keyboard either (review 2026-08-29).
        if (tool && tool.children && tool.children.length && buttonAvailable(tool)) {
          openFlyoutFor(tb, btns[idx], tool, wrapper);
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
  }

  /**
   * Build the positioned region the rail lives in: the dock and wide-mode
   * stamps every style keys off, the appearance tokens, and the drop
   * target. It joins the editor's region-navigation cycle, so the rail is
   * reachable by that shortcut like any other editor region.
   *
   * @param {Object} tb The toolbar to build.
   * @return {HTMLElement} The region.
   */
  function buildWrapper(tb) {
    var wrapper = document.createElement('div');
    wrapper.id = tb.regionId;
    // interface-navigable-region joins the editor's region-navigation cycle
    // (the Phase 0 gap: the theme rail was unreachable via that shortcut).
    wrapper.className = 'interface-navigable-region toolrail-region';
    wrapper.setAttribute('role', 'region');
    // "Tool rail" for the first toolbar, "Tool rail: <name>" for an extra
    // one, so each landmark in the region cycle says which toolbar it is.
    wrapper.setAttribute('aria-label', regionLabel(tb));
    wrapper.tabIndex = -1;
    // Which toolbar this region is: 'main' or an extra toolbar's id (#95).
    wrapper.dataset.toolbar = tb.id;
    // Every dock-dependent style keys off this: rail orientation, which
    // border carries the edge, and which way surfaces open.
    wrapper.dataset.dock = tb.position.dock;
    // Wide mode is persisted independently of the dock; the wide CSS is
    // keyed to vertical docks + float, so a stored wide state is simply
    // inert while the rail is horizontal. One for each toolbar (#95).
    if (isWide(tb)) {
      wrapper.dataset.wide = 'true';
    }
    applyAppearance(wrapper);

    wrapper.appendChild(buildRail(tb, wrapper));

    // Drop target: a block type or a pattern dragged from the inserter
    // pins at once; a block dragged out of the canvas opens the
    // add-to-toolbar dialog (see handleRailDrop). Pointer sugar — the
    // keyboard paths are the block menu's "Pin to toolbar" and "Save as
    // pattern and pin to toolbar…" items and the settings search.
    //
    // A drag that started on one of the rail's own tools is refused
    // HERE, and only here: without preventDefault on dragover the browser
    // never fires drop on the rail at all, so a drop-side guard would be
    // dead code — and could not work anyway, since the document-level
    // capture listener clears railDragActive before any bubble-phase
    // handler reads it (review 2026-09-03, second round, finding 6).
    wrapper.addEventListener('dragover', function (e) {
      if (!railDragActive && e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'wp-blocks') !== -1) {
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
        handleRailDrop(tb, JSON.parse(raw), wrapper);
      } catch (err) {
        /* Unrecognized payload — ignore. */
      }
    });

    return wrapper;
  }

  // -------------------------------------------------------------------
  // Drag between the rail and the canvas (0.1.23)
  // -------------------------------------------------------------------

  /**
   * True while one of the rail's own tools is mid-drag.
   *
   * The button that started the drag may be gone by dragend — a rerender
   * mid-drag (a catalog change, a tools-updated event) rebuilds every
   * button, and a detached source's dragend never reaches the document —
   * which left the flag stuck and the rail refusing drops for the rest
   * of the page (review 2026-09-03, finding 7). So the flag also clears
   * on every rerender (the worst that can follow is a no-op re-pin of a
   * tool that is already pinned) and on any dragend or drop the editor
   * document sees.
   *
   * One for the page, not one for each toolbar (see newToolbar): the
   * browser runs one drag at a time, and the flag says where that drag
   * STARTED, which is what a region's dragover asks.
   *
   * With several toolbars (#95), only a rebuild of the toolbar the drag
   * started on clears it (railDragToolbar): that rebuild is what can
   * detach the source. A rebuild of a different toolbar left the drag
   * unguarded, and a drop on a third toolbar then pinned the tool there
   * (PR #126 review, CodeRabbit).
   */
  var railDragActive = false;
  // The toolbar whose tool is mid-drag, or null.
  var railDragToolbar = null;

  /**
   * Clear the tool-drag guard when the drag started on this toolbar. For
   * a path that takes the toolbar's buttons out of the document without
   * rerender(): a hide, a delete, a stored change that rebuilds it, a
   * move to a new dock. The removed source node gets the drag's dragend,
   * but a node out of the document does not pass it on to the document's
   * listeners, so the guard stayed set and the next drag from the
   * inserter was refused (PR #126 review, Claude).
   *
   * @param {Object} tb The toolbar whose buttons go.
   * @return {void}
   */
  function releaseToolDragOf(tb) {
    if (railDragToolbar === tb) {
      railDragActive = false;
      railDragToolbar = null;
    }
  }

  document.addEventListener('dragend', function () {
    railDragActive = false;
    railDragToolbar = null;
  }, true);
  document.addEventListener('drop', function () {
    railDragActive = false;
    railDragToolbar = null;
  }, true);

  /**
   * Start dragging a tool into the canvas, with the payload core's
   * inserter sends so core's own drop zone does the insert. Refuses a tool
   * that is unavailable or cannot build anything, and marks the drag as
   * the rail's own so the rail refuses its own drop.
   *
   * @param {DragEvent} e    The dragstart.
   * @param {Object}    tool The tool's model entry.
   * @param {Object}    tb   The toolbar the tool's button is on.
   * @return {void}
   */
  function onToolDragStart(e, tool, tb) {
    if (!e.dataTransfer || !toolAvailable(tool)) {
      e.preventDefault();
      return;
    }
    var blocks = makeBlocksFor(tool);
    if (!blocks.length) {
      e.preventDefault();
      return;
    }
    closeFlyout(false);
    railDragActive = true;
    railDragToolbar = tb || null;
    try {
      e.dataTransfer.setData('wp-blocks', JSON.stringify({ type: 'inserter', blocks: blocks }));
      e.dataTransfer.effectAllowed = 'copy';
    } catch (err) {
      railDragActive = false;
      railDragToolbar = null;
      e.preventDefault();
    }
  }

  /** Whitespace-insensitive markup, for matching a dropped pattern. */
  function normalizedMarkup(blocks) {
    try {
      return wp.blocks.serialize(blocks).replace(/\s+/g, ' ').trim();
    } catch (e) {
      return '';
    }
  }

  /**
   * Each pattern's own normalized markup, parsed once and reused across
   * drops (core memoizes this same parse in its inserter; unmemoized it
   * re-parsed a 50–150 pattern catalog on the main thread per drop —
   * review 2026-09-03, finding 5). Keyed by slot id plus a HASH of the
   * content, not its length: the catalog signature deliberately never
   * reads content, so a user pattern edited to the same byte length (an
   * h2 made an h3) kept its stale parse, missed the match, and fell
   * through to a type pin — the bug the match exists to prevent
   * (review 2026-09-03, second round, finding 2). Hashing is one pass
   * over each pattern's content per drop, and drops are rare; the
   * per-keystroke signature stays cheap. A 32-bit collision on same id,
   * same length, different content would serve a stale parse; that is
   * a non-event. The whole map is dropped whenever the signature
   * changes (watchPatternCatalog), which bounds it to the live catalog.
   */
  T.patternMarkupCache = Object.create(null);

  /** djb2 over a string, as base 36. */
  function contentHash(text) {
    var h = 5381;
    for (var i = 0; i < text.length; i++) {
      h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  /**
   * One pattern's own markup, round-tripped through the parser and cached.
   * The key carries a hash of the content, not just its length: a user
   * pattern edited to the same byte length would otherwise keep its stale
   * parse and miss the drop match this exists to make.
   *
   * @param {Object} p A pattern descriptor.
   * @return {string} Normalized markup, or '' when it cannot be parsed.
   */
  function patternMarkup(p) {
    var content = p.content || '';
    var key = p.id + '#' + content.length + '#' + contentHash(content);
    if (!(key in T.patternMarkupCache)) {
      var own;
      try {
        own = normalizedMarkup(wp.blocks.parse(p.content || ''));
      } catch (e) {
        own = '';
      }
      T.patternMarkupCache[key] = own;
    }
    return T.patternMarkupCache[key];
  }

  /**
   * Which pattern a set of dropped blocks came from. Core's inserter
   * drags a pattern as its parsed blocks and nothing else — the payload
   * carries no pattern name (verified in this WordPress: the transfer
   * data is {type: 'inserter', blocks}) — so the only identity left is
   * the content: serialize the drop and compare with each pattern's own
   * round trip. Parsed by the same parser, the two agree apart from
   * whitespace. A synced user pattern never gets here: it drags as one
   * reference block and is recognized by its ref instead.
   *
   * @param {Object[]} blocks The dropped payload's blocks.
   * @return {Object|null} A pattern descriptor, or null.
   */
  function matchPattern(blocks) {
    var wanted = normalizedMarkup(blocks);
    if (!wanted) {
      return null;
    }
    var found = null;
    allPatterns().forEach(function (p) {
      if (found || p.synced) {
        return;
      }
      var own = patternMarkup(p);
      if (own && own === wanted) {
        found = p;
      }
    });
    return found;
  }

  /**
   * A 'wp-blocks' payload dropped on the rail.
   *
   * From the inserter ({type: 'inserter', blocks}): a synced user
   * pattern arrives as one reference block and pins by its ref. Every
   * other drop is tried as a pattern FIRST — a pattern that is a single
   * block with no children (a styled heading, a lone image) drags
   * exactly like a block type and must still pin as the pattern — and
   * only an unmatched drop pins its first block's type, at once, with
   * nothing to ask. The cost of pattern-first: a bare block whose
   * default markup equals some registered pattern's entire content (a
   * lone Separator, an empty Spacer) pins that pattern instead of the
   * type. The two payloads are byte-identical, so nothing can tell them
   * apart; the pattern IS that one block, and unpinning is one click.
   *
   * From the canvas ({srcClientIds}): opens the add-to-toolbar dialog —
   * pin the type, or save the block as a pattern (settings, contents
   * and all) and pin that (owner decision 2026-09-02).
   *
   * A drop pins to the toolbar it landed on (#95).
   *
   * @param {Object}      tb      The toolbar the drop landed on.
   * @param {Object}      data    The parsed payload.
   * @param {HTMLElement} wrapper The rail region.
   * @return {void}
   */
  function handleRailDrop(tb, data, wrapper) {
    if (!data) {
      return;
    }
    if (data.type === 'inserter' && Array.isArray(data.blocks) && data.blocks.length) {
      var blocks = data.blocks;
      var first = blocks[0] || {};
      // A synced user pattern: pin it by its ref even before the
      // wp_block list has landed — the slot renders when it does, like
      // any pin whose source is not here yet — and never let a bare
      // core/block through to the type path: a pinned "Block" type
      // would insert a reference to nothing (review 2026-09-03,
      // finding 3).
      if (first.name === 'core/block') {
        var ref = first.attributes && first.attributes.ref;
        if (ref && /^[0-9]+$/.test(String(ref))) {
          pinBlock(tb, USER_PATTERN_SLOT_PREFIX + ref);
        }
        return;
      }
      // Pattern first, whatever the shape (review 2026-09-03, finding
      // 2): the match is by content and memoized per pattern, so a plain
      // block-type drop costs one serialize and a map of compares.
      var pattern = matchPattern(blocks);
      if (pattern) {
        pinBlock(tb, pattern.id);
        return;
      }
      if (typeof first.name === 'string' && first.name) {
        pinBlock(tb, first.name);
      }
      return;
    }
    if (Array.isArray(data.srcClientIds) && data.srcClientIds.length) {
      openAddToToolbar(data.srcClientIds, wrapper);
    }
  }

  // -------------------------------------------------------------------
  // "Add to toolbar" dialog (0.1.23): a block dropped from the canvas
  // onto the rail, or "Save as pattern and pin to toolbar…" in a block's
  // options menu (the keyboard path to the same dialog).
  //
  // Two offers: pin the block's TYPE (a plain quick-insert, like the
  // inserter drop), or save the block — settings, inner blocks and all —
  // as one of the author's own UNSYNCED patterns and pin that. Core
  // stores the pattern (a wp_block post), so it is also usable outside
  // the rail; the pin is a snapshot, never a reference: editing an
  // inserted copy never changes the pin.
  //
  // A popover like the settings dialog: no focus trap; Escape, an
  // outside click and a Tab out all dismiss it.
  // -------------------------------------------------------------------

  T.addDialogOpen = false;

  /**
   * The open add-to-toolbar dialog, or null when it is closed.
   *
   * @return {HTMLElement|null} The dialog node, or null.
   */
  function addDialogNode() {
    return document.querySelector('.toolrail-adddialog');
  }

  /**
   * @param {string} refocusClientId Canvas block to hand focus back to
   *                                 (the keyboard path came from its
   *                                 menu), or '' to leave focus alone.
   */
  function closeAddDialog(refocusClientId) {
    var node = addDialogNode();
    if (node) {
      node.remove();
    }
    T.addDialogOpen = false;
    syncLayers();
    document.removeEventListener('mousedown', onAddDialogMousedown, true);
    document.removeEventListener('keydown', onAddDialogKeydown, true);
    document.removeEventListener('focusin', onAddDialogFocusin, true);
    if (refocusClientId) {
      var doc = canvasDoc();
      var el = doc ? doc.querySelector('[data-block="' + attrValue(refocusClientId) + '"]') : null;
      if (el && typeof el.focus === 'function') {
        el.focus();
      }
    }
  }

  /**
   * Dismiss the dialog on a press outside it, leaving focus where the
   * press puts it.
   *
   * @param {MouseEvent} e The document mousedown.
   * @return {void}
   */
  function onAddDialogMousedown(e) {
    var node = addDialogNode();
    if (node && !node.contains(e.target)) {
      closeAddDialog('');
    }
  }

  /**
   * Escape closes the dialog. It only CLAIMS the key when focus is inside
   * — the same rule the help panel learned: this dialog can open from a
   * canvas drop without taking focus, and an Escape pressed then belongs
   * to whatever the author is really in. Closing from inside hands focus
   * back to the block the dialog came from.
   *
   * @param {KeyboardEvent} e The document keydown.
   * @return {void}
   */
  function onAddDialogKeydown(e) {
    if (e.key !== 'Escape' || !T.addDialogOpen) {
      return;
    }
    var node = addDialogNode();
    if (node && node.contains(document.activeElement)) {
      e.preventDefault();
      e.stopPropagation();
      closeAddDialog(node.dataset.clientId || '');
      return;
    }
    // Aimed elsewhere (the help panel's lesson): close quietly, claim
    // nothing, move no focus.
    closeAddDialog('');
  }

  /**
   * Close the dialog once focus leaves it, without pulling focus back.
   *
   * @param {FocusEvent} e The document focusin.
   * @return {void}
   */
  function onAddDialogFocusin(e) {
    if (!T.addDialogOpen) {
      return;
    }
    var node = addDialogNode();
    if (!node || node.contains(e.target)) {
      return;
    }
    closeAddDialog('');
  }

  /**
   * Can this author create patterns (wp_block posts)? true, false, or
   * null while core's capability check is still in flight: canUser
   * reads a cache and returns undefined until its OPTIONS request lands
   * (verified in core's selector), and "unknown" must not read as
   * "denied" — the dialog told authors they lacked permission before
   * the check had run (review 2026-09-03, finding 4). Callers treat
   * null as "go ahead"; a real refusal then surfaces as the save's own
   * error. The entity form is WordPress 6.7+; when it has finished
   * resolving to nothing (6.5 and 6.6), the resource-name form is the
   * one that core knows. No store, or a selector that throws, is also
   * "cannot tell", never "denied" (second round, finding 3): the save
   * itself reports a store that is missing.
   *
   * @return {boolean|null}
   */
  function canCreatePatterns() {
    var sel = coreSelect();
    if (!sel || typeof sel.canUser !== 'function') {
      return null;
    }
    try {
      var entityArgs = ['create', { kind: 'postType', name: 'wp_block' }];
      var can = sel.canUser.apply(null, entityArgs);
      if (typeof can === 'boolean') {
        return can;
      }
      var finished = typeof sel.hasFinishedResolution === 'function'
        && sel.hasFinishedResolution('canUser', entityArgs);
      if (!finished) {
        return null;
      }
      can = sel.canUser('create', 'blocks');
      return typeof can === 'boolean' ? can : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Save blocks as one of the author's unsynced patterns. Resolves to
   * the pattern's descriptor; rejects with an Error carrying core's
   * message when the save fails.
   *
   * @param {string}   name   Pattern title.
   * @param {Object[]} blocks The canvas blocks to snapshot.
   * @return {Promise<Object>}
   */
  function savePatternFromBlocks(name, blocks) {
    return new Promise(function (resolve, reject) {
      var disp;
      try {
        disp = wp.data.dispatch('core');
      } catch (e) {
        disp = null;
      }
      if (!disp || typeof disp.saveEntityRecord !== 'function') {
        reject(new Error(__('The editor\'s data store is not available.', 'editrail')));
        return;
      }
      var record = {
        title: name,
        content: wp.blocks.serialize(blocks),
        status: 'publish',
        meta: { wp_pattern_sync_status: 'unsynced' }
      };
      Promise.resolve(disp.saveEntityRecord('postType', 'wp_block', record, { throwOnError: true })).then(function (saved) {
        if (!saved || !saved.id) {
          reject(new Error(__('WordPress did not return the saved pattern.', 'editrail')));
          return;
        }
        // Keep OUR markup as the content: the record core returns may
        // carry only the rendered form, and the catalog needs the raw
        // block markup to parse.
        var normalized = {
          id: saved.id,
          title: name,
          content: record.content,
          wp_pattern_sync_status: 'unsynced'
        };
        sessionUserPatterns.push(normalized);
        resolve(userPatternDescriptor(normalized));
      }, function (err) {
        reject(err instanceof Error ? err : new Error(String(err && err.message ? err.message : err)));
      });
    });
  }

  /**
   * The pins go to the toolbar whose region the block was dropped on, and
   * to the first toolbar from the block menu. The dialog hangs in the
   * first toolbar's region either way, like the other two dialogs (#95).
   *
   * @param {string[]}    clientIds The canvas block(s) to add.
   * @param {HTMLElement} wrapper   The rail region the block was dropped
   *                                on (defaults to the first toolbar's).
   * @return {boolean} Whether the dialog opened.
   */
  function openAddToToolbar(clientIds, wrapper) {
    var target = mainToolbar;
    T.toolbars.forEach(function (tb) {
      if (wrapper && wrapper.id === tb.regionId) {
        target = tb;
      }
    });
    wrapper = document.getElementById(mainToolbar.regionId) || wrapper;
    var sel = wp.data.select('core/block-editor');
    var ids = Array.isArray(clientIds) ? clientIds.filter(function (id) { return !!sel.getBlock(id); }) : [];
    if (!wrapper || !ids.length) {
      return false;
    }
    closeFlyout(false);
    closeSettings(false);
    closeHelp(false);
    closeAddDialog('');

    var blocks = sel.getBlocksByClientId(ids);
    var single = blocks.length === 1 ? blocks[0] : null;
    var singleType = single ? wp.blocks.getBlockType(single.name) : null;
    var singleTitle = singleType && singleType.title ? singleType.title : (single ? single.name : '');

    var node = settingsRow('div', 'toolrail-settings toolrail-adddialog');
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-labelledby', 'toolrail-adddialog-title');
    // Keeps a click on the dialog's text inside the dialog; see openSettings().
    node.tabIndex = -1;
    node.dataset.clientId = ids[0];

    var head = settingsRow('div', 'toolrail-settings-head');
    var title = settingsRow('h2', 'toolrail-settings-title');
    title.id = 'toolrail-adddialog-title';
    title.textContent = __('Add to toolbar', 'editrail');
    head.appendChild(title);
    var close = settingsButton('×', function () { closeAddDialog(ids[0]); }, 'toolrail-settings-close');
    close.setAttribute('aria-label', __('Close', 'editrail'));
    head.appendChild(close);
    node.appendChild(head);

    var status = settingsRow('p', 'toolrail-settings-status');
    status.id = 'toolrail-adddialog-status';

    // --- The block type (one block only; several blocks are a pattern
    // or nothing) ---
    if (single) {
      var typeHead = settingsRow('h3', 'toolrail-settings-subtitle');
      typeHead.textContent = __('Block type', 'editrail');
      node.appendChild(typeHead);
      var typeNote = settingsRow('p', 'toolrail-settings-empty');
      if (isPinnedOn(target, single.name)) {
        typeNote.textContent = sprintf(
          /* translators: %s: block title. */
          __('The %s block type is already pinned.', 'editrail'),
          singleTitle
        );
        node.appendChild(typeNote);
      } else {
        typeNote.textContent = __('A plain quick-insert tool for this block type, without this block\'s settings.', 'editrail');
        node.appendChild(typeNote);
        var pinRow = settingsRow('div', 'toolrail-settings-helprow');
        pinRow.appendChild(settingsButton(
          sprintf(
            /* translators: %s: block title. */
            __('Pin the %s block type', 'editrail'),
            singleTitle
          ),
          function () {
            // A stored change can delete the toolbar while the dialog is
            // open; a pin on a deleted object is lost in silence. Pin to
            // the first toolbar then, and the message says which, the
            // same rule as the pattern save below (PR #126 review,
            // CodeRabbit).
            if (T.toolbars.indexOf(target) === -1) {
              target = mainToolbar;
            }
            // The toolbar it falls back to can have the pin already, and
            // a stored change can add it while the dialog is open: then
            // nothing was pinned, and the message says so (PR #126
            // review, CodeRabbit).
            if (!pinBlock(target, single.name)) {
              speak(target === mainToolbar
                ? sprintf(
                  /* translators: %s: block title. */
                  __('%s is already pinned on the main toolbar.', 'editrail'),
                  singleTitle
                )
                : sprintf(
                  /* translators: 1: block title, 2: the toolbar's name. */
                  __('%1$s is already pinned on the %2$s toolbar.', 'editrail'),
                  singleTitle, target.name
                ));
              closeAddDialog(ids[0]);
              return;
            }
            speak(target === mainToolbar
              ? sprintf(
                /* translators: %s: block title. */
                __('%s pinned to the toolbar.', 'editrail'),
                singleTitle
              )
              : sprintf(
                /* translators: 1: block or pattern title, 2: the toolbar's name. */
                __('%1$s pinned to the %2$s toolbar.', 'editrail'),
                singleTitle, target.name
              ));
            closeAddDialog(ids[0]);
          },
          'toolrail-adddialog-pintype'
        ));
        node.appendChild(pinRow);
      }
    }

    // --- Save as a pattern and pin it ---
    var patHead = settingsRow('h3', 'toolrail-settings-subtitle');
    patHead.textContent = __('Pattern', 'editrail');
    node.appendChild(patHead);
    var patNote = settingsRow('p', 'toolrail-settings-empty');
    if (canCreatePatterns() === false) {
      patNote.textContent = __('You cannot create patterns on this site, so this block cannot be saved as one.', 'editrail');
      node.appendChild(patNote);
    } else {
      patNote.textContent = single
        ? __('Saves this block with its settings and contents as one of your patterns, and pins that pattern. The pin is a snapshot: editing an inserted copy never changes it.', 'editrail')
        : __('Saves these blocks with their settings and contents as one of your patterns, and pins that pattern. The pin is a snapshot: editing an inserted copy never changes it.', 'editrail');
      node.appendChild(patNote);

      var nameLabel = settingsRow('label', 'toolrail-settings-label');
      nameLabel.setAttribute('for', 'toolrail-adddialog-name');
      nameLabel.textContent = __('Pattern name', 'editrail');
      node.appendChild(nameLabel);
      var nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.id = 'toolrail-adddialog-name';
      nameInput.className = 'toolrail-settings-search';
      nameInput.value = single ? singleTitle : __('Pattern', 'editrail');
      nameInput.setAttribute('aria-describedby', 'toolrail-adddialog-status');
      node.appendChild(nameInput);

      var saveRow = settingsRow('div', 'toolrail-settings-helprow');
      var saveBtn = settingsButton(__('Save pattern and pin it', 'editrail'), function () {
        var name = nameInput.value.trim();
        if (!name) {
          status.textContent = __('Give the pattern a name first.', 'editrail');
          speak(status.textContent);
          nameInput.focus();
          return;
        }
        saveBtn.disabled = true;
        status.textContent = __('Saving…', 'editrail');
        savePatternFromBlocks(name, blocks).then(function (pattern) {
          // The save is async: a toolbar deleted meanwhile has no pins.
          if (T.toolbars.indexOf(target) === -1) {
            target = mainToolbar;
          }
          pinBlock(target, pattern.id);
          speak(target === mainToolbar
            ? sprintf(
              /* translators: %s: pattern name. */
              __('Saved "%s" as a pattern and pinned it to the toolbar.', 'editrail'),
              pattern.title
            )
            : sprintf(
              /* translators: 1: pattern name, 2: the toolbar's name. */
              __('Saved "%1$s" as a pattern and pinned it to the %2$s toolbar.', 'editrail'),
              pattern.title, target.name
            ));
          closeAddDialog(ids[0]);
        }, function (err) {
          saveBtn.disabled = false;
          status.textContent = err && err.message
            ? sprintf(
              /* translators: %s: error message. */
              __('The pattern could not be saved: %s', 'editrail'),
              err.message
            )
            : __('The pattern could not be saved.', 'editrail');
          speak(status.textContent);
        });
      }, 'toolrail-adddialog-savepattern');
      saveRow.appendChild(saveBtn);
      node.appendChild(saveRow);
      nameInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveBtn.click();
        }
      });
    }

    node.appendChild(status);
    wrapper.appendChild(node);
    T.addDialogOpen = true;
    syncLayers();
    placeSurface(mainToolbar, node, gearButton(), wrapper, true);
    document.addEventListener('mousedown', onAddDialogMousedown, true);
    document.addEventListener('keydown', onAddDialogKeydown, true);
    document.addEventListener('focusin', onAddDialogFocusin, true);
    var first = node.querySelector('#toolrail-adddialog-name') || node.querySelector('.toolrail-adddialog-pintype') || close;
    // A drop from the canvas runs this while the canvas holds focus.
    focusFromEvent(first);
    return true;
  }

  // -------------------------------------------------------------------
  // Pressed-state painting, change-guarded (the Phase 1 lesson: the store
  // subscription fires on every keystroke, so bail before touching the DOM
  // when nothing relevant changed; a re-mount forces a repaint because
  // fresh buttons carry default state).
  // -------------------------------------------------------------------

  // One for the page, not one for each toolbar (see newToolbar): the
  // signature is built from the armed tool, the mode and each registered
  // tool's own state, and none of those belongs to one toolbar.
  var lastPaintedSignature = false;

  /**
   * Everything the pressed/availability paint depends on, as one string:
   * the armed tool, the overview toggle, the rail's mode, and each
   * registered tool's own reported state. The store subscription fires on
   * every keystroke, so this is what lets syncPressed bail before touching
   * the DOM.
   *
   * @return {string} The signature.
   */
  function pressedSignature() {
    // The Section overview toggle is pressed state too — include it so
    // the change guard never suppresses (or stales) its repaint. The
    // MODE is in the signature for the same reason: availability (R9)
    // is painted by the same pass.
    var parts = [T.activeTool, 'ov:' + (T.overviewOpen ? '1' : '0'), 'mode:' + railMode()];
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

  /**
   * Paint pressed state, availability and tooltips across the rail, and
   * bail early when the signature has not moved. Unavailable buttons get
   * aria-disabled, never the disabled attribute: a natively disabled
   * button drops out of the roving tabindex and the arrow order and stops
   * announcing its name, where a dimmed one stays reachable and announced.
   *
   * @param {boolean} force Repaint even when nothing changed — a rebuild
   *                       hands over fresh buttons carrying default state.
   * @return {void}
   */
  function syncPressed(force) {
    var built = T.toolbars.some(function (tb) {
      return !!document.getElementById(tb.railId);
    });
    if (!built) {
      return;
    }
    var signature = pressedSignature();
    if (!force && signature === lastPaintedSignature) {
      return;
    }
    lastPaintedSignature = signature;
    T.toolbars.forEach(paintPressed);
  }

  /**
   * The paint of syncPressed for ONE toolbar's rail. syncPressed owns the
   * change guard: the signature is one for the page, so a guard here
   * would let the first toolbar's paint stop the second's.
   *
   * @param {Object} tb The toolbar.
   * @return {void}
   */
  function paintPressed(tb) {
    var rail = document.getElementById(tb.railId);
    if (!rail) {
      return;
    }
    var model = railModel(tb);

    model.tools.concat(model.slots).forEach(function (tool) {
      var btn = rail.querySelector(toolSelector(tool.id));
      if (!btn) {
        return;
      }
      var pressed;
      if (tool.isActive) {
        try {
          pressed = !!tool.isActive();
        } catch (e) {
          pressed = false;
        }
      } else if (tool.select) {
        pressed = T.activeTool === 'select';
      } else if (tool.children && tool.children.length) {
        // A parent lights when one of its children is armed.
        pressed = tool.id === T.activeTool || tool.children.some(function (c) { return c.id === T.activeTool; });
      } else {
        pressed = tool.id === T.activeTool;
      }
      btn.setAttribute('aria-pressed', String(pressed));

      // Availability (R9), painted in the same change-guarded pass.
      // aria-disabled, NOT the disabled attribute: a natively disabled
      // button drops out of the roving tabindex and the APG arrow order
      // and stops announcing its name; aria-disabled keeps it reachable
      // and announced as dimmed, and the click handler bails on it.
      var available = buttonAvailable(tool);
      if (available) {
        btn.removeAttribute('aria-disabled');
      } else {
        btn.setAttribute('aria-disabled', 'true');
      }

      // Tooltip (R9 + R10): the reason while dimmed, "open" while a
      // toggle's surface is up — so a pointer user learns why a button
      // is gray, and which kind of blue an open toggle is.
      var title = toolTitle(tool);
      if (!available) {
        title += ' — ' + unavailableReason();
      } else if (pressed && isToggleTool(tool)) {
        title += ' — ' + __('open', 'editrail');
      }
      if (btn.title !== title) {
        btn.title = title;
      }
    });
  }

  // -------------------------------------------------------------------
  // Mount machinery
  // -------------------------------------------------------------------

  /**
   * Put a toolbar's region where its dock hangs: build it when it is not
   * in the document, and move it back when the editor's re-render moved
   * it.
   *
   * @param {Object} tb The toolbar.
   * @return {boolean} False when the editor chrome for the dock is not on
   *                   the page yet.
   */
  function mount(tb) {
    // A hidden toolbar has no region at all (#95), so there is nothing
    // to build or to put back. That is a success, not "not yet".
    if (tb.hidden) {
      return true;
    }
    if (!dockParent(tb)) {
      return false;
    }
    bindCanvas();

    var existing = document.getElementById(tb.regionId);
    if (existing) {
      // Re-home a rail that the editor's own re-render moved out from
      // under its dock, without rebuilding it.
      placeToolbarRegions(null, null).forEach(function (moved) {
        applyFloatPosition(moved);
        syncLayer(moved);
      });
      return true;
    }

    // Only a flyout of THIS toolbar hangs off the buttons a new region
    // replaces.
    if (T.openFlyout && T.openFlyout.toolbar === tb) {
      closeFlyout(false);
    }
    // A destroyed region takes the settings dialog with it, but not the
    // module state that says one is open — without this the rebuilt gear
    // renders aria-expanded="true" with no dialog behind it, and its
    // listeners outlive the node they were bound for. Same for the help
    // panel. The dialogs hang in the first toolbar's region only (#95).
    if (tb === mainToolbar) {
      closeSettings(false);
      closeHelp(false);
    }
    // A new region means new buttons: a tool drag from the old ones has
    // lost its source node (setDock, or the editor's re-render removed
    // the region).
    releaseToolDragOf(tb);

    placeToolbarRegions(tb, buildWrapper(tb));
    applyFloatPosition(tb);
    syncLayer(tb);
    // Force: a re-mounted rail carries brand-new buttons.
    syncPressed(true);
    return true;
  }

  /**
   * mount() for every toolbar.
   *
   * @return {boolean} False when a toolbar could not be mounted yet.
   */
  function mountToolbars() {
    var mounted = true;
    T.toolbars.forEach(function (tb) {
      if (!mount(tb)) {
        mounted = false;
      }
    });
    return mounted;
  }

  /**
   * Rebuild the rail in place (registry/slot changes). Focus is handled
   * only if it was inside THE RAIL — the settings dialog is a sibling
   * inside the same region, so testing the region would pull focus out of
   * the dialog on every change made from it. Then focus goes to the
   * rebuilt copy of the button that had it, by its data-tool id, and to
   * Select only when that button is gone. Focus on an open flyout's item
   * counts as focus on the flyout's parent button. Before, every rebuild sent
   * focus to Select, so a rebuild the author did not start (an extension
   * registering a tool, a set import finishing) moved them off their
   * place in the toolbar (PR #97 review).
   *
   * @param {Object} tb The toolbar to rebuild.
   * @return {void}
   */
  function rerender(tb) {
    var wrapper = document.getElementById(tb.regionId);
    if (!wrapper) {
      return;
    }
    // Only this toolbar's rebuild can detach the drag source (see
    // railDragActive). With no recorded source, as before #95.
    if (!railDragToolbar || railDragToolbar === tb) {
      railDragActive = false;
      railDragToolbar = null;
    }
    var oldRail = document.getElementById(tb.railId);
    var hadFocus = !!(oldRail && oldRail.contains(document.activeElement));
    var focusedTool = hadFocus && document.activeElement.dataset
      ? document.activeElement.dataset.tool || ''
      : '';
    // A flyout is a sibling of the rail, not inside it. When focus is on
    // one of its items, the rebuild removes the menu and focus would fall
    // to the page; send it to the menu's rebuilt parent button instead
    // (PR #97 review). Read before closeFlyout(), which clears the state.
    var ownsFlyout = !!T.openFlyout && T.openFlyout.toolbar === tb;
    if (!hadFocus && ownsFlyout && T.openFlyout.node.contains(document.activeElement)) {
      hadFocus = true;
      focusedTool = T.openFlyout.parentBtn.dataset.tool || '';
    }
    // A flyout of a different toolbar hangs off a button this rebuild
    // does not replace, so it stays open.
    if (ownsFlyout) {
      closeFlyout(false);
    }
    var newRail = buildRail(tb, wrapper);
    if (oldRail) {
      wrapper.replaceChild(newRail, oldRail);
    } else {
      wrapper.appendChild(newRail);
    }
    syncPressed(true);
    if (hadFocus) {
      var target = (focusedTool && newRail.querySelector(toolSelector(focusedTool)))
        || newRail.querySelector('[data-tool="select"]')
        || newRail.querySelector('.toolrail-tool');
      if (target) {
        // The rail's focusin handler moves the one Tab stop here.
        target.focus();
      }
    }
  }

  /**
   * Bring the rail up: poll for the editor chrome until mount() succeeds
   * (or 10 seconds pass), then hand over to the mutation observer, and
   * subscribe to the store for pressed-state repaints. The subscriber is
   * wrapped rather than passed by reference, so a store argument can never
   * read as syncPressed's `force` and defeat the change guard.
   */
  function start() {
    var tries = 0;
    railStarted = true;
    var timer = window.setInterval(function () {
      tries++;
      if (mountToolbars() || tries > 100) {
        window.clearInterval(timer);
        observe();
      }
    }, 100);

    if (wp.data.subscribe) {
      // Wrapped, not passed by reference: a subscriber must never receive
      // an argument that could read as `force` and defeat the change guard.
      wp.data.subscribe(function () {
        syncPressed();
        onSidebarStoreChange();
        onCanvasSelectStoreChange();
      });
    }
    syncSidebarWidth();
  }

  /**
   * Re-mount the rail across the editor's React re-renders. The rail lives
   * outside the React tree it watches, so nothing else would put it back
   * after a re-render removes its host — the code-editor round trip
   * unmounts the whole visual editor. Debounced to 100ms: the editor
   * mutates constantly and each pass does real DOM work.
   */
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
        mountToolbars();
        syncLayers();
        healOverview();
        syncSidebarWidth();
      }, 100);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Shared with the other files of the rail (see editor-rail-core.js).
  T.syncLayers = syncLayers;
  T.applyFloatPosition = applyFloatPosition;
  T.setDock = setDock;
  T.finishDrag = finishDrag;
  T.releaseToolDragOf = releaseToolDragOf;
  T.addDialogNode = addDialogNode;
  T.closeAddDialog = closeAddDialog;
  T.canCreatePatterns = canCreatePatterns;
  T.openAddToToolbar = openAddToToolbar;
  T.syncPressed = syncPressed;
  T.mount = mount;
  T.mountToolbars = mountToolbars;
  T.rerender = rerender;
  T.start = start;

  // This file ran to its end. The next file checks this number.
  T.loaded = 6;
})(window.wp);
