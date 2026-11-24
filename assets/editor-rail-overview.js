/**
 * EditRail, part 5 of 7 (editor-rail-overview.js).
 *
 * The Section overview (R6), with drag to reorder and marquee select.
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
  if (!T || T.loaded !== 4) {
    return;
  }

  // From editor-rail-core.js.
  var __ = T.__;
  var _n = T._n;
  var sprintf = T.sprintf;
  var speak = T.speak;
  var mainToolbar = T.mainToolbar;
  var skeletonBody = T.skeletonBody;

  // From editor-rail-tools.js.
  var announceModeChange = T.announceModeChange;
  var setActiveTool = T.setActiveTool;
  var canvasDoc = T.canvasDoc;
  var closeFlyout = T.closeFlyout;

  // From editor-rail-settings.js.
  var settingsRow = T.settingsRow;
  var focusableIn = T.focusableIn;

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

  // Whether the overview is open. Kept OUT of the per-open state (`ov`,
  // below) on purpose: the rest of the rail reads it (railMode, the
  // tool's isActive, the key handlers, getCanvasGeometry), and every
  // callback that can run after a close checks it first.
  T.overviewOpen = false;
  // Padlock for the locked-box corner tag (visual only; the pick
  // button's accessible name carries the state to AT).
  var OVERVIEW_LOCK_ICON = '<svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 0 1 6 0v3H9z"/></svg>';
  // The selection mark's tick. A SHAPE on its own solid chip, because
  // the members of a group selection other than the active one show no
  // controls strip, and a border hue shift alone cannot carry the
  // state (MR review 2026-08-31, finding 1).
  var OVERVIEW_CHECK_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9.6 16.8 5 12.2l1.4-1.4 3.2 3.2 8-8L19 7.4z"/></svg>';
  /**
   * The state of ONE open overview, at its start values. openOverview()
   * starts from a fresh copy, and closeOverview() replaces the copy with a
   * fresh one AFTER it has released every observer, timer, frame and
   * listener the old copy holds. A new per-open value goes here, with its
   * start value, and the reset on close comes with it.
   *
   * A value that must outlive a close stays outside, with its reason (the
   * variables after `ov`). So does overviewOpen.
   *
   * The drag and marquee gestures live here too: no gesture can outlive
   * the overview, and closeOverview tears each one down (listeners
   * included) through finishOverviewDrag, cancelOverviewMarquee and
   * clearOverviewCancelLatch before the copy is replaced. A rebuild
   * stops them the same way, so they need no reset of their own.
   *
   * @return {Object} A fresh per-open state.
   */
  function newOverviewState() {
    return {
      // The current root ('' = top level).
      root: '',
      // The one box whose reorder controls are shown ('' = none). The v2
      // interaction (owner feedback 2026-08-27, from post 446): boxes are
      // OUTLINES around each block, and the commands appear only after
      // clicking/entering a box — the always-on chip bars obscured
      // content.
      selected: '',
      // Multi-selection (issue #21): every member's clientId, ALWAYS kept
      // in document order. ov.selected stays the ACTIVE box — the one
      // whose controls disclosure is open — and, whenever a
      // multi-selection exists, is one of its members; the controls then
      // act on the group.
      selectedIds: [],
      // The Shift-range anchor: set by a plain pick, a toggle-on, and the
      // keyboard toggle, so a later Shift+click / Shift+Arrow extends
      // from the box the author last acted on — the file-manager
      // convention.
      anchor: '',
      // In-flight marquee ({startX, startY, active, additive, baseIds,
      // prevActive}) — a drag from EMPTY overlay space that draws a
      // selection rectangle; every box it touches is selected on release.
      marquee: null,
      // True while the group-move engine is mid-sequence: a
      // non-contiguous group is moved as SEVERAL public dispatches (core's
      // reducer moves one contiguous run per action), and the store
      // subscription must not rebuild the overlay between them.
      groupMove: false,
      // Pan offset (visual px, ≥0) down the current root, and the
      // author's explicit zoom (0 = fit the current root). Together they
      // make a very long document SCROLLABLE in the overview instead of
      // shrinking it past legibility.
      pan: 0,
      userScale: 0,
      metrics: { k: 1, rootTop: 0, fitHeight: 0 },
      entryScroll: null,
      signature: '',
      unsubscribe: null,
      repositionTimer: null,
      panFrame: null,
      hadFrame: false,
      media: null,
      // Watches the visual editor's box while the overview is open:
      // editor chrome above the canvas (the autosave notice) appearing or
      // being dismissed resizes it with NO resize/scroll event fired, and
      // the viewport math reads that chrome's height.
      resizeObserver: null,
      // The node that observer is actually watching, so healOverview can
      // tell a React-replaced visual editor from the one observed at
      // open.
      resizeTarget: null,
      // Watches the canvas body's block DOM while the overview is open. A
      // reorder lands in the canvas when React flushes it, which can be
      // later than scheduleOverviewSettle's 220 ms pass on a slow
      // browser; the boxes then kept the old layout (#64). What it runs
      // reads the canvas and writes only to the overlay and the editor
      // document, so it cannot trigger the observer again.
      canvasObserver: null,
      // The canvas body that observer is watching (see resizeTarget).
      canvasTarget: null,
      // Watches the SIZE of the canvas's root block list while the
      // overview is open. An image or embed that loads, a web font, or a
      // style change can make the document taller with no childList
      // change, so the mutation observer alone never saw it (#64, PR #69
      // review).
      canvasSizeObserver: null,
      // The root block list that observer is watching.
      canvasSizeTarget: null,
      // The pending refit after a canvas change (a timer id, 0 for none).
      // At most one is pending, so a canvas that changes all the time
      // costs one refit per 220 ms, not one per frame.
      canvasRefitTimer: 0,
      // Content extent cache. The extent is re-measured only when marked
      // dirty (open, store change, viewport resize) — the settle/zoom/pan
      // paths reuse the cache, so no measurement can ever react to a
      // growth it caused.
      extent: 0,
      extentDirty: true,
      // In-flight box drag ({clientId, startX, startY, active, toIndex}).
      // Drag-to-reorder is POINTER SUGAR over the same public move the
      // arrows dispatch (owner ask 2026-08-27) — the keyboard path is the
      // arrows, and nothing here is reachable only by dragging.
      drag: null,
      // The one-shot mouseup listener that arms the click latch
      // (overviewDragConsumedClick) after Escape abandons a gesture (the
      // button is still down at that point).
      cancelLatchUp: null,
      // The block that was selected when the overview opened — its
      // floating toolbar stays alive over the zoomed canvas otherwise
      // (owner feedback 2026-08-27), so the selection is cleared for the
      // overview's lifetime and put back on close.
      priorSelection: '',
      // The block the author last PICKED, MOVED or DRILLED INTO during
      // this overview session (R11, issue #20). On close, this — not the
      // entry scroll — is where the author's attention is: the canvas
      // centers and selects it. '' means the author touched nothing, and
      // close falls back to the entry scroll + prior selection. Set by
      // selectOverviewBox, moveOverviewBlockTo (a verified move only) and
      // drillTo; cleared only on open/close — deselecting a box on the
      // way out must not forget it.
      lastTouched: ''
    };
  }

  // The open overview's state (see newOverviewState).
  T.ov = newOverviewState();

  // The values below stay OUTSIDE `ov`: each belongs to a frame or timer
  // that closeOverview does not cancel, so it can still run after the
  // close has replaced `ov`.
  //
  // One box reposition per frame, however many mutation batches arrive.
  // The frame that clears it is never canceled; a fresh `ov` would drop
  // the flag while that frame is still pending.
  var overviewCanvasSettlePending = false;
  // Latched for one tick after a completed drag so the click the
  // browser fires on the same button cannot ALSO toggle its controls.
  // The timer that clears it is never canceled.
  var overviewDragConsumedClick = false;
  // The close-centering re-apply (rAF id): one frame behind the close's
  // synchronous pre-scroll, belt for chrome that lands with the render.
  // It outlives closeOverview on purpose; reopening cancels it so it
  // cannot fight the fresh scroll-home.
  var overviewCloseScrollFrame = null;
  // The one corrective write scheduled behind that, for late-arriving
  // editor chrome (see centerBlockAfterClose) — cancelled on reopen.
  var overviewCloseScrollTimer = null;
  // The fading overlay's removal timer, and the frame that lifts the
  // body's toolrail-ov-closing stamp — both cleared on reopen so a
  // rapid close-then-reopen starts from a clean body and ONE overlay.
  var overviewFadeTimer = null;
  var overviewClosingFrame = null;

  /**
   * The editor skeleton's content region — the box holding the canvas, and
   * the positioning context the overview overlay lives in.
   *
   * @return {HTMLElement|null} The region, or null.
   */
  function contentRegion() {
    return document.querySelector('.interface-interface-skeleton__content');
  }

  /**
   * The editor canvas iframe, or null in a non-iframed editor.
   *
   * @return {HTMLIFrameElement|null} The iframe, or null.
   */
  function canvasFrame() {
    return document.querySelector('iframe[name="editor-canvas"]');
  }

  /**
   * The visual editor's own node inside the content region — the box the
   * overview measures its viewport against and observes for resizes.
   *
   * Both class names on purpose: the plugin declares Requires at least:
   * 6.5, and `edit-post-visual-editor` is the class that build may still
   * carry. This machine runs WP 7.1, so the 6.5 markup could not be
   * measured here — the second selector is insurance, not a measurement.
   */
  function visualEditorNode() {
    var content = contentRegion();
    return content
      ? content.querySelector('.editor-visual-editor, .edit-post-visual-editor')
      : null;
  }

  /**
   * Where the CANVAS actually starts inside the content region, as an
   * offset (px, ≥0) from the region's top. Editor notices — the "There
   * is an autosave" warning above all — render INSIDE the content
   * region, above the visual editor, and push the canvas down (measured
   * 88.7px on post 433). The scale host sits at the visual editor's
   * top, so every viewport the overview fits, pans, or clamps against
   * must start THERE, not at the region's top — the region's own
   * clientHeight overstates the room by exactly the notice height,
   * which is how the bottom block became unreachable. A rect
   * difference, not offsetTop: it needs no shared offsetParent, and no
   * transformed element sits between the two.
   */
  function overviewCanvasTop() {
    var content = contentRegion();
    var visual = visualEditorNode();
    if (!content || !visual) {
      return 0;
    }
    return Math.max(0, visual.getBoundingClientRect().top - content.getBoundingClientRect().top);
  }

  /** The vertical space actually available to the scaled canvas: the
      content region minus any chrome above the canvas, minus the 24px
      breathing margin every fit has always kept. */
  function overviewViewportHeight() {
    var content = contentRegion();
    if (!content) {
      return 0;
    }
    return Math.max(0, content.clientHeight - overviewCanvasTop() - 24);
  }

  /**
   * The open overview overlay, or null when it is closed.
   *
   * @return {HTMLElement|null} The overlay, or null.
   */
  function overviewNode() {
    return document.getElementById('toolrail-overview');
  }

  /**
   * The rail's Section overview toggle. Null before the rail is built.
   *
   * @return {HTMLElement|null} The button, or null.
   */
  function overviewButton() {
    var rail = document.getElementById(mainToolbar.railId);
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
    return custom || (type && type.title) || name || __('Block', 'editrail');
  }

  /** clientIds at the current root, in document order. */
  function overviewOrder() {
    var sel = wp.data.select('core/block-editor');
    return sel ? sel.getBlockOrder(T.ov.root) : [];
  }

  /**
   * A fingerprint of what the overview is showing: the current root plus
   * its child order. The store subscription compares this rather than
   * rebuilding on every editor change, so typing inside a block does not
   * tear down and rebuild the boxes.
   *
   * @return {string} The signature.
   */
  function overviewCurrentSignature() {
    return T.ov.root + '|' + overviewOrder().join(',');
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
   * The document's CONTENT height: the bottom edge of the lowest
   * top-level block, measured with the iframe at its NATURAL height.
   *
   * Never body.scrollHeight, and never measured while grown — anything
   * viewport-relative inside the canvas resolves against the iframe's
   * OWN height, so a grown-state measurement is a feedback loop. Two
   * confirmed sources (both 2026-08-27): the canvas's ~40vh
   * click-to-append tail (measured live: 3938 → 5191 over 1.2s — the
   * "background falls down the page" report), and a full-height (100vh)
   * Cover block re-inflating through the settle re-measure (review
   * finding 1 — the same mechanism, through a different door). Blanking
   * the height var for the measurement makes it growth-independent, so
   * every pass computes the same number.
   *
   * Known limitation, documented not fixed: a 100vh block has no
   * "natural" size that survives the grow — it fills whatever viewport
   * exists, so after growing it renders taller than measured and can
   * push content below it past the frame's bottom edge. Stable and
   * honest beats unbounded growth.
   */
  function measureOverviewExtent(doc) {
    var style = document.body.style;
    var grown = style.getPropertyValue('--toolrail-ov-frameh');
    if (grown) {
      style.removeProperty('--toolrail-ov-frameh');
    }
    var editorSel = wp.data.select('core/block-editor');
    var win = doc.defaultView;
    var extent = 0;
    (editorSel ? editorSel.getBlockOrder('') : []).forEach(function (id) {
      var el = doc.querySelector('[data-block="' + String(id).replace(/"/g, '') + '"]');
      if (el) {
        var r = el.getBoundingClientRect();
        extent = Math.max(extent, r.top + r.height + (win ? (win.scrollY || 0) : 0));
      }
    });
    if (grown) {
      style.setProperty('--toolrail-ov-frameh', grown);
    }
    return extent;
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

    if (T.ov.extentDirty) {
      var measured = measureOverviewExtent(doc);
      if (measured > 0) {
        T.ov.extent = measured;
        T.ov.extentDirty = false;
      }
    }
    if (T.ov.extent <= 0) {
      // Nothing measurable yet (blocks not mounted after a heal, or an
      // emptied canvas): leave NO stale scale/height/translate applied
      // (review 2026-08-27, finding 3) — the next dirty pass refits.
      clearOverviewScale();
      return;
    }
    var docHeight = Math.ceil(T.ov.extent) + 32;
    var fitHeight = docHeight;
    // The iframe is sized to the CONTENT extent so a long document can
    // render whole -- but a SHORT document's extent is less than the
    // space the canvas already had, and shrinking the iframe to it
    // exposed the editor's gray background under the canvas (owner
    // report 2026-08-28, post 2826: 486px of content in a 671px
    // canvas; the theme's background "crept up" to the last block).
    // Never size the frame below the canvas area it fills at rest; the
    // FIT still uses the content extent, so the zoom is unchanged.
    var canvasArea = Math.max(0, content.clientHeight - overviewCanvasTop());
    var frameHeight = Math.max(docHeight, canvasArea);
    var rootTop = 0;
    if (T.ov.root) {
      var rootEl = doc.querySelector('[data-block="' + String(T.ov.root).replace(/"/g, '') + '"]');
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
    var viewport = overviewViewportHeight();
    var k = T.ov.userScale;
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
    var centerOffset = T.ov.root && maxPan === 0
      ? Math.max(0, (viewport - fitHeight * k) / 2)
      : 0;
    T.ov.metrics = { k: k, rootTop: rootTop, fitHeight: fitHeight, centerOffset: centerOffset };
    T.ov.pan = Math.min(Math.max(0, T.ov.pan), maxPan);

    var style = document.body.style;
    style.setProperty('--toolrail-overview-scale', String(k));
    style.setProperty('--toolrail-ov-frameh', frameHeight + 'px');
    // Keeps the scale-container's layout footprint at the VISUAL size,
    // for any build whose wrappers do size from their children.
    style.setProperty('--toolrail-ov-mb', (-(1 - k) * frameHeight) + 'px');
    style.setProperty('--toolrail-ov-ty', (-(rootTop * k + T.ov.pan) + centerOffset) + 'px');
    updateOverviewZoomLabel();
  }

  /** Pan the overview (visual px from the current root's top), clamped
      to the content that exists. Box repositioning rides one rAF so a
      wheel burst costs one layout pass per frame, not per event. */
  function setOverviewPan(next) {
    var viewport = overviewViewportHeight();
    var maxPan = Math.max(0, T.ov.metrics.fitHeight * T.ov.metrics.k - viewport);
    // Centered means it fits — centering and panning NEVER combine.
    // Recomputing maxPan from live viewport while metrics are a beat
    // stale could otherwise allow both at once (review 2026-08-27,
    // finding 4); a centered view pins the pan at zero until the next
    // refit decides otherwise.
    if (T.ov.metrics.centerOffset) {
      maxPan = 0;
    }
    T.ov.pan = Math.min(Math.max(0, next), maxPan);
    document.body.style.setProperty(
      '--toolrail-ov-ty',
      (-(T.ov.metrics.rootTop * T.ov.metrics.k + T.ov.pan) + (T.ov.metrics.centerOffset || 0)) + 'px'
    );
    if (!T.ov.panFrame) {
      T.ov.panFrame = window.requestAnimationFrame(function () {
        T.ov.panFrame = null;
        positionOverviewBoxes();
      });
    }
  }

  var OVERVIEW_MIN_SCALE = 0.15;

  /** The default zoom never renders the median block at the current
      root below this on-screen height — the content-derived floor. */
  var OVERVIEW_MIN_BLOCK_PX = 48;

  /**
   * Set the author's zoom, clamped between OVERVIEW_MIN_SCALE and 1:1, and
   * repaint. The announcement is opt-in because a wheel or slider gesture
   * produces a burst of these and only the gesture's end is worth saying.
   *
   * @param {number}  nextK      Requested scale.
   * @param {boolean} announceIt Speak the resulting percentage.
   * @return {void}
   */
  function setOverviewZoom(nextK, announceIt) {
    T.ov.userScale = Math.min(1, Math.max(OVERVIEW_MIN_SCALE, nextK));
    applyOverviewScale();
    positionOverviewBoxes();
    if (announceIt) {
      speak(sprintf(
        /* translators: %d: zoom percentage. */
        __('Zoom %d%%.', 'editrail'),
        Math.round(T.ov.metrics.k * 100)
      ));
    }
  }

  /**
   * Repaint the zoom percentage in the overview bar. Reads the EFFECTIVE
   * scale, not the author's requested one — the fit can hold it below what
   * was asked for.
   *
   * Writes only a changed value. Assigning the same text is still a
   * childList mutation; the body observer answered it with healOverview,
   * which repaints this label again, so an idle open overview rewrote it
   * about every 110 ms (#64).
   */
  function updateOverviewZoomLabel() {
    var label = document.querySelector('#toolrail-overview .toolrail-ov-zoomlabel');
    var text = Math.round(T.ov.metrics.k * 100) + '%';
    if (label && label.textContent !== text) {
      label.textContent = text;
    }
  }

  /**
   * Take the canvas out of scaled mode: drop every scale custom property,
   * then sweep EVERY scale host off the page. A sweep rather than the
   * current frame's parent, because the editor can have replaced the
   * iframe and its wrapper while the overview was open, which would strand
   * the class on a detached node's replacement.
   */
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

  /** Size the overlay to the CANVAS AREA's layout box: the content
      region's box (offsets are unaffected by the transform, unlike
      getBoundingClientRect), shifted down past any editor chrome above
      the canvas — the autosave notice stays visible AND clickable above
      the mode, instead of being covered by an overlay that fenced it
      off while drawing the bar over it. Starting the overlay where the
      scaled canvas starts also makes its rect THE viewport: box
      clipping (overflow: hidden), the veil, and the focus pan-into-view
      window all read the same edges the fit and pan math use. Chip
      positions are computed viewport-rect-minus-overlay-rect, so this
      only defines coverage, not precision. */
  function placeOverviewOverlay() {
    var overlay = overviewNode();
    var content = contentRegion();
    if (!overlay || !content) {
      return;
    }
    var canvasTop = overviewCanvasTop();
    overlay.style.left = content.offsetLeft + 'px';
    overlay.style.top = (content.offsetTop + canvasTop) + 'px';
    overlay.style.width = content.offsetWidth + 'px';
    overlay.style.height = Math.max(0, content.offsetHeight - canvasTop) + 'px';
  }

  /**
   * Size each outline box to its block's on-screen rect, in document
   * order. Boxes ARE the blocks now (v2) — no overlap-avoid needed,
   * because blocks don't overlap. A short block keeps a 24px hit floor;
   * a block with no DOM element yet simply hides until the next pass.
   * The one thing that CAN overlap a neighbor is the picked box's
   * reorder strip, so it is seated last (placeOverviewControls).
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
    placeOverviewControls(oRect);
  }

  /**
   * Put the visible reorder strip where it obstructs no other box.
   *
   * The strip is a child of the picked box and by default sits inside
   * its top-left corner, which is right for a box the strip fits in. A
   * short NARROW box is another matter — a theme that sizes a one-line
   * paragraph to its content, a button, a small image: the strip is
   * about 213×58px, so it spills down over the next box in the column
   * and swallows that box's pick button. A Shift+click on the neighbor
   * then lands on the strip. A theme can cause this without meaning
   * to: editor styles that make the canvas body a column flex container
   * turn the root block list into a flex item, which shrinks to fit its
   * content, so a one-word paragraph becomes a box about 74px wide.
   *
   * The strip only wins the click it overlaps if it paints on top, so
   * the box that holds it carries .is-active and a higher z-index than
   * the other selected boxes (each selected box is its own stacking
   * context, and a later one would otherwise cover the strip).
   *
   * Candidates, in order: inside (the CSS default), to the right, to
   * the left, above. The first that fits inside the overlay, stays
   * clear of the bar and obstructs no other box wins. "Obstructs" means
   * covering a box's center or more than half its area — a strip that
   * merely clips the top few pixels of a tall neighbor stays inside,
   * where it always was, so an ordinary document looks unchanged. When
   * every candidate obstructs something, the one covering the least
   * area wins. The result rides on data-placement for the specs.
   *
   * @param {DOMRect} oRect The overlay's viewport rect, already measured.
   * @return {void}
   */
  function placeOverviewControls(oRect) {
    var overlay = overviewNode();
    if (!overlay) {
      return;
    }
    var controls = overlay.querySelector('.toolrail-ov-controls:not([hidden])');
    var box = controls && controls.closest ? controls.closest('.toolrail-ov-box') : null;
    if (!controls || !box || box.style.display === 'none') {
      return;
    }
    var rel = function (el) {
      var r = el.getBoundingClientRect();
      return { left: r.left - oRect.left, top: r.top - oRect.top, width: r.width, height: r.height };
    };
    // Measure the strip at its natural place (the CSS default, inside
    // the box's border), not wherever the last pass left it. The
    // measured rect, not the stylesheet's 4px, is the inside
    // candidate: the box's border shifts the strip too, and 2px was
    // the difference between clearing a neighbor's center and sitting
    // on it.
    controls.style.left = '';
    controls.style.top = '';
    var own = rel(box);
    var natural = rel(controls);
    var w = natural.width;
    var h = natural.height;
    if (!w || !h) {
      return;
    }
    // Inline left/top are measured from the box's padding edge.
    var origin = { left: own.left + box.clientLeft, top: own.top + box.clientTop };
    var others = Array.prototype.slice.call(overlay.querySelectorAll('.toolrail-ov-box'))
      .filter(function (b) {
        return b !== box && b.style.display !== 'none';
      })
      .map(rel);
    var bar = overlay.querySelector('.toolrail-ov-bar');
    var barRect = bar ? rel(bar) : null;
    var GAP = 8;
    var candidates = [
      { name: 'inside', left: natural.left, top: natural.top },
      { name: 'right', left: own.left + own.width + GAP, top: own.top },
      { name: 'left', left: own.left - GAP - w, top: own.top },
      { name: 'above', left: natural.left, top: own.top - GAP - h }
    ];
    var overlap = function (a, b) {
      var x = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
      var y = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
      return x > 0 && y > 0 ? x * y : 0;
    };
    var coversCenter = function (a, b) {
      var cx = b.left + b.width / 2;
      var cy = b.top + b.height / 2;
      return cx >= a.left && cx <= a.left + a.width && cy >= a.top && cy <= a.top + a.height;
    };
    var chosen = null;
    var least = null;
    var leastArea = Infinity;
    candidates.some(function (c) {
      var strip = { left: c.left, top: c.top, width: w, height: h };
      // Inside is the status quo and always allowed; the others must
      // fit in the overlay and stay out from under the bar.
      if (c.name !== 'inside') {
        if (strip.left < 0 || strip.top < 0 || strip.left + w > oRect.width || strip.top + h > oRect.height) {
          return false;
        }
        if (barRect && overlap(strip, barRect) > 0) {
          return false;
        }
      }
      var area = 0;
      var obstructs = false;
      others.forEach(function (o) {
        var a = overlap(strip, o);
        area += a;
        if (a > 0 && (coversCenter(strip, o) || a > (o.width * o.height) / 2)) {
          obstructs = true;
        }
      });
      if (!obstructs) {
        chosen = c;
        return true;
      }
      if (area < leastArea) {
        leastArea = area;
        least = c;
      }
      return false;
    });
    var use = chosen || least;
    controls.dataset.placement = use.name;
    if (use.name !== 'inside') {
      controls.style.left = (use.left - origin.left) + 'px';
      controls.style.top = (use.top - origin.top) + 'px';
    }
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
    var rect = T.ov.root ? overviewBlockViewportRect(T.ov.root) : null;
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

  /**
   * The overlay box for one block, or null when it is not on screen — a
   * block at another root, or one whose box has not been built yet.
   *
   * @param {string} clientId The block's client id.
   * @return {HTMLElement|null} The box, or null.
   */
  function overviewBoxFor(clientId) {
    var overlay = overviewNode();
    return overlay
      ? overlay.querySelector('.toolrail-ov-box[data-clientid="' + String(clientId).replace(/"/g, '') + '"]')
      : null;
  }

  /** Paint the selection state onto every box: is-selected for the
      active box AND every multi-selection member; aria-expanded and the
      controls strip stay keyed to the ACTIVE box alone (one disclosure
      at a time — it is the group's strip when a multi-selection
      exists). Membership is ALSO carried on the pick button's
      accessible name (the base name is stashed at build time). The
      boxes stay plain buttons on purpose: role=listbox/aria-selected
      needs option children, and an option may not contain the nested
      controls strip; aria-pressed beside aria-expanded would
      double-book the button's toggle semantics. */
  function syncOverviewSelection() {
    var overlay = overviewNode();
    if (!overlay) {
      return;
    }
    Array.prototype.slice.call(overlay.querySelectorAll('.toolrail-ov-box')).forEach(function (box) {
      var id = box.dataset.clientid;
      var isActive = id === T.ov.selected;
      var isMember = T.ov.selectedIds.indexOf(id) !== -1;
      box.classList.toggle('is-selected', isActive || isMember);
      // The box holding the visible strip must paint above the other
      // selected members — see .toolrail-ov-box.is-active in the CSS.
      box.classList.toggle('is-active', isActive);
      var pick = box.querySelector('[data-ov-action="pick"]');
      if (pick) {
        pick.setAttribute('aria-expanded', isActive ? 'true' : 'false');
        var base = pick.dataset.baseLabel;
        if (base) {
          pick.setAttribute('aria-label', isMember && T.ov.selectedIds.length > 1
            ? sprintf(
              /* translators: %s: the pick button's base accessible name. */
              __('%s — selected', 'editrail'),
              base
            )
            : base);
        }
      }
      var controls = box.querySelector('.toolrail-ov-controls');
      if (controls) {
        controls.hidden = !isActive;
      }
    });
    // The strip just shown may belong to a different box than before —
    // seat it before the author's next click.
    placeOverviewControls(overlay.getBoundingClientRect());
  }

  /** Open a box's reorder controls and move focus to the first usable
      one. The controls are a DISCLOSURE on the box's pick button —
      the outline stays clean until the author asks. */
  function selectOverviewBox(clientId) {
    T.ov.selected = clientId;
    // A plain pick collapses any multi-selection to this one box and
    // re-anchors the Shift range here (the file-manager convention).
    T.ov.selectedIds = [clientId];
    T.ov.anchor = clientId;
    T.ov.lastTouched = clientId;
    // REBUILD, not just repaint: the controls strip's content (label,
    // arrow wiring, disabled states) is baked per build and varies
    // with the selection — a strip built in group mode must not
    // survive into a single pick. Focus lands on the first usable
    // control, the original disclosure contract.
    var boxSel = '.toolrail-ov-box[data-clientid="' + clientId + '"] ';
    buildOverviewContent([
      boxSel + '[data-ov-action="down"]',
      boxSel + '[data-ov-action="up"]',
      boxSel + '[data-ov-action="enter"]',
      boxSel + '[data-ov-action="pick"]'
    ]);
  }

  /**
   * Close the active box's disclosure. Rebuilds rather than repaints for
   * the same reason selecting does: the controls strip's content is baked
   * per build and has to track the selection.
   *
   * @param {boolean} refocusPick Put focus back on that box's pick button;
   *                              otherwise the rebuild re-derives it.
   * @return {void}
   */
  function deselectOverviewBox(refocusPick) {
    if (!T.ov.selected) {
      return;
    }
    var id = T.ov.selected;
    T.ov.selected = '';
    // Rebuild for the same reason selectOverviewBox does: the strip's
    // baked content must track the selection. Without refocusPick the
    // rebuild re-derives focus from wherever it is (or leaves it).
    buildOverviewContent(refocusPick
      ? ['.toolrail-ov-box[data-clientid="' + id + '"] [data-ov-action="pick"]']
      : undefined);
  }

  /** The multi-selection's members in document order. */
  function overviewSelectionInOrder() {
    return overviewOrder().filter(function (id) {
      return T.ov.selectedIds.indexOf(id) !== -1;
    });
  }

  /** canMoveBlocks, guarded: the selector is newer than this plugin's
      floor, so its absence (or a throw) means "assume movable" — the
      verify in the move engines still guards every announcement. */
  function overviewCanMove(clientId) {
    var sel = wp.data.select('core/block-editor');
    if (sel && typeof sel.canMoveBlocks === 'function') {
      try {
        return !!sel.canMoveBlocks([clientId], T.ov.root);
      } catch (e) {
        return true;
      }
    }
    return true;
  }

  /** Normalize and store the multi-selection (document order), keep the
      active-box invariant, and repaint. activeId: undefined leaves the
      active box alone; '' closes the disclosure; an id opens it there. */
  function setOverviewSelection(ids, activeId) {
    var members = {};
    ids.forEach(function (id) {
      members[id] = true;
    });
    T.ov.selectedIds = overviewOrder().filter(function (id) {
      return members[id];
    });
    if (activeId !== undefined) {
      T.ov.selected = activeId || '';
    }
    if (T.ov.selected && T.ov.selectedIds.length
        && T.ov.selectedIds.indexOf(T.ov.selected) === -1) {
      T.ov.selected = T.ov.selectedIds[0];
    }
    syncOverviewSelection();
  }

  /** Select the inclusive range between the anchor and the target and
      make the target the active box. A missing anchor re-anchors at
      the target. */
  function setOverviewRange(fromId, toId) {
    var order = overviewOrder();
    var a = order.indexOf(fromId);
    var b = order.indexOf(toId);
    if (b === -1) {
      return;
    }
    if (a === -1) {
      a = b;
      fromId = toId;
    }
    T.ov.anchor = fromId;
    setOverviewSelection(order.slice(Math.min(a, b), Math.max(a, b) + 1), toId);
  }

  /**
   * Add or remove one box from the multi-selection. Toggling onto a lone
   * PICKED box adds to it rather than replacing it: the pick was a
   * selection of one, and the modifier means "and this one too".
   *
   * @param {string} clientId The block's client id.
   * @return {void}
   */
  function toggleOverviewSelectionId(clientId) {
    if (T.ov.selectedIds.indexOf(clientId) !== -1) {
      removeOverviewSelectionId(clientId);
      return;
    }
    var ids = T.ov.selectedIds.slice();
    // Toggling onto a lone picked box ADDS to it — the pick was a
    // selection of one, and Ctrl+click means "and this one too".
    if (!ids.length && T.ov.selected && T.ov.selected !== clientId) {
      ids.push(T.ov.selected);
    }
    ids.push(clientId);
    T.ov.anchor = clientId;
    setOverviewSelection(ids, clientId);
  }

  /** Drop one box from the selection (Alt+click, and toggle-off). If it
      was the active box, the disclosure moves to the nearest remaining
      member — by document distance — or closes when none remain. */
  function removeOverviewSelectionId(clientId) {
    var ids = T.ov.selectedIds.filter(function (id) {
      return id !== clientId;
    });
    var nextActive;
    if (T.ov.selected === clientId) {
      nextActive = '';
      var order = overviewOrder();
      var from = order.indexOf(clientId);
      var bestDist = Infinity;
      ids.forEach(function (id) {
        var d = Math.abs(order.indexOf(id) - from);
        if (d < bestDist) {
          bestDist = d;
          nextActive = id;
        }
      });
    }
    setOverviewSelection(ids, nextActive);
  }

  /**
   * Drop the multi-selection and its anchor, then repaint. The ACTIVE box
   * is left alone — clearing a group does not close the disclosure.
   */
  function clearOverviewMultiSelection() {
    T.ov.selectedIds = [];
    T.ov.anchor = '';
    syncOverviewSelection();
  }

  /** ONE composed speak() per completed selection gesture: the count,
      plus how many of the members are locked — said HERE so a keyboard
      user learns before asking for a move, not after (the move engine
      repeats it as its "stays where it is" suffix). */
  function announceOverviewSelection() {
    var n = T.ov.selectedIds.length;
    if (!n) {
      speak(__('Selection cleared.', 'editrail'));
      return;
    }
    var lockedCount = T.ov.selectedIds.filter(function (id) {
      return !overviewCanMove(id);
    }).length;
    var message = sprintf(
      /* translators: %d: number of selected blocks. */
      _n('%d block selected.', '%d blocks selected.', n, 'editrail'),
      n
    );
    if (lockedCount) {
      message += ' ' + sprintf(
        /* translators: %d: number of locked blocks in the selection. */
        _n('%d is locked and cannot move.', '%d are locked and cannot move.', lockedCount, 'editrail'),
        lockedCount
      );
    }
    speak(message);
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
    if (e.button !== 0 || T.ov.drag) {
      return;
    }
    var groupIds = null;
    if (T.ov.selectedIds.length > 1 && T.ov.selectedIds.indexOf(clientId) !== -1) {
      // Dragging any member drags the whole selection. The FULL
      // ordered selection goes to the move engine — locked members
      // included — because the engine is what excludes them AND what
      // composes the "stays where it is" note. Filtering them out here
      // made a mixed group's DRAG announce only the moved count and
      // never say what stayed, while the arrows (which pass the whole
      // selection) said it correctly (MR review 2026-09-02).
      // canMoveBlocks decides only whether the drag may START.
      groupIds = overviewSelectionInOrder();
      var anyMovable = groupIds.some(function (id) {
        return overviewCanMove(id);
      });
      if (!anyMovable) {
        return;
      }
    } else if (!overviewCanMove(clientId)) {
      return;
    }
    T.ov.drag = { clientId: clientId, ids: groupIds, startX: e.clientX, startY: e.clientY, active: false, toIndex: -1, gap: -1 };
    document.addEventListener('mousemove', onOverviewDragMove, true);
    document.addEventListener('mouseup', onOverviewDragEnd, true);
  }

  /**
   * Track a press into a drag: nothing happens until it passes a 5px
   * threshold, which is what keeps an ordinary click on a box working as
   * the controls disclosure. Once active it dims every box the release
   * would move and repaints the drop line.
   *
   * @param {MouseEvent} e The document mousemove.
   * @return {void}
   */
  function onOverviewDragMove(e) {
    if (!T.ov.drag) {
      return;
    }
    if (!T.ov.drag.active) {
      if (Math.abs(e.clientX - T.ov.drag.startX) < 5 && Math.abs(e.clientY - T.ov.drag.startY) < 5) {
        return;
      }
      T.ov.drag.active = true;
      document.body.classList.add('toolrail-ov-dragging');
      // A group drag dims EVERY box it will move.
      (T.ov.drag.ids || [T.ov.drag.clientId]).forEach(function (id) {
        var box = overviewBoxFor(id);
        if (box) {
          box.classList.add('is-dragging');
        }
      });
    }
    e.preventDefault();
    updateOverviewDropline(e.clientX, e.clientY);
  }

  /** True when the CANVAS is laid out right to left. The boxes are
      painted from block rects read inside the iframe, so the admin
      document's own direction is the wrong one to ask — and a direction
      set by a stylesheet leaves no `dir` attribute to read, which is why
      this is computed style and not an attribute (review 2026-08-28,
      finding 3). A cross-origin canvas falls back to the admin
      document. */
  function overviewIsRtl() {
    try {
      var doc = canvasDoc() || document;
      return window.getComputedStyle(doc.documentElement).direction === 'rtl';
    } catch (e) {
      return window.getComputedStyle(document.documentElement).direction === 'rtl';
    }
  }

  /** Place the drop line at the gap the pointer is over, and remember
      the move index a release would dispatch.

      Two-dimensional on purpose (owner report 2026-08-28: horizontal
      drags across a grid weren't seamless — the old index came from Y
      midpoints alone, so side-by-side boxes could never be targeted
      sideways). Boxes are grouped into visual ROWS in document order
      (a row-mate overlaps the row's band vertically by half AND sits
      beside it horizontally — grid, columns and gallery children all
      flow row-major, so document order within a row IS the visual
      order, mirrored under RTL). The pointer's Y picks the row; inside
      a multi-box row the pointer's X picks the gap, marked by a
      VERTICAL drop line spanning the row's band. A single-box row
      keeps the original midpoint-Y semantics and the horizontal line,
      so plain stacks behave exactly as they always did. */
  function updateOverviewDropline(clientX, clientY) {
    var overlay = overviewNode();
    if (!overlay || !T.ov.drag) {
      return;
    }
    var order = overviewOrder();
    var idx = order.indexOf(T.ov.drag.clientId);
    var rtl = overviewIsRtl();

    // Visible boxes in document order, each with its order index —
    // boxes with no DOM yet take no part, exactly as before.
    var entries = [];
    order.forEach(function (id, i) {
      var box = overviewBoxFor(id);
      var r = box && box.style.display !== 'none' ? box.getBoundingClientRect() : null;
      if (r) {
        entries.push({ index: i, rect: r });
      }
    });

    var line = overlay.querySelector('.toolrail-ov-dropline');
    if (!line) {
      line = document.createElement('div');
      line.className = 'toolrail-ov-dropline';
      line.setAttribute('aria-hidden', 'true');
      overlay.appendChild(line);
    }
    if (!entries.length) {
      T.ov.drag.toIndex = 0;
      line.style.display = 'none';
      return;
    }
    line.style.display = '';

    // A row-mate must overlap the row's band vertically AND sit beside
    // it horizontally. The second test is load-bearing: these are the
    // PAINTED boxes, which positionOverviewBoxes floors at 24px tall,
    // so at low zoom (the 0.25 auto floor, the 0.15 manual floor) a
    // stack of short blocks — separators, spacers — overlaps its
    // neighbors vertically and a vertical-only test would cascade the
    // whole column into one "row" and hand vertical drags to the X
    // math (review 2026-08-28, finding 1). Stacked boxes share their
    // horizontal span; side-by-side cells never do, in either writing
    // direction.
    var rows = [];
    entries.forEach(function (en) {
      var row = rows[rows.length - 1];
      if (row) {
        var overlapY = Math.min(row.bottom, en.rect.bottom) - Math.max(row.top, en.rect.top);
        var overlapX = Math.min(row.right, en.rect.right) - Math.max(row.left, en.rect.left);
        if (overlapY >= Math.min(en.rect.height, row.bottom - row.top) / 2 && overlapX <= 1) {
          row.entries.push(en);
          row.top = Math.min(row.top, en.rect.top);
          row.bottom = Math.max(row.bottom, en.rect.bottom);
          row.left = Math.min(row.left, en.rect.left);
          row.right = Math.max(row.right, en.rect.right);
          return;
        }
      }
      rows.push({
        top: en.rect.top,
        bottom: en.rect.bottom,
        left: en.rect.left,
        right: en.rect.right,
        entries: [en]
      });
    });

    // The row the pointer is in (or heading toward); past the last one
    // the insertion is "after everything". A multi-box row claims the
    // pointer anywhere above its band's bottom (X then picks the gap).
    // A single-box row claims it only above its MIDPOINT — the original
    // "passed once the pointer is below the middle" rule, which is what
    // keeps a stack of floored, mutually overlapping boxes targeting the
    // box under the pointer instead of one two slots up (the bottoms of
    // several overlapping boxes all sit below the pointer at once).
    var row = null;
    for (var r = 0; r < rows.length; r++) {
      var claim = rows[r].entries.length > 1
        ? rows[r].bottom
        : (rows[r].top + rows[r].bottom) / 2;
      if (clientY < claim) {
        row = rows[r];
        break;
      }
    }

    var oRect = overlay.getBoundingClientRect();
    var insertIndex;
    // How many of the row's boxes the pointer has already passed —
    // also the position WITHIN the row, which the drop line needs.
    var passed = 0;
    if (!row) {
      insertIndex = entries[entries.length - 1].index + 1;
    } else if (row.entries.length > 1) {
      row.entries.forEach(function (en) {
        var cx = en.rect.left + en.rect.width / 2;
        if (rtl ? cx > clientX : cx < clientX) {
          passed++;
        }
      });
      // A row's entries are NOT guaranteed to carry contiguous order
      // indices — `entries` skips any box whose element is hidden or not
      // yet mounted — so the index has to come off the entry the
      // insertion actually lands on, never off the row's first index
      // plus a count (review 2026-08-28, finding 2).
      insertIndex = passed < row.entries.length
        ? row.entries[passed].index
        : row.entries[row.entries.length - 1].index + 1;
    } else {
      // A single-box row only claimed the pointer above its midpoint,
      // so the insertion is always BEFORE it.
      insertIndex = row.entries[0].index;
    }
    // The RAW insertion gap (0..n in the current order) — the group
    // move engine does its own moving-members adjustment; the single
    // path keeps the original already-adjusted index below.
    T.ov.drag.gap = insertIndex;
    T.ov.drag.toIndex = insertIndex > idx ? insertIndex - 1 : insertIndex;

    if (row && row.entries.length > 1) {
      // Vertical line at the gap: the leading edge of the box the
      // insertion lands before, or the trailing edge of the row's last.
      var x;
      if (passed < row.entries.length) {
        var before = row.entries[passed].rect;
        x = rtl ? before.right + 1 : before.left - 4;
      } else {
        var after = row.entries[row.entries.length - 1].rect;
        x = rtl ? after.left - 4 : after.right + 1;
      }
      line.classList.add('is-vertical');
      // The overlay clips at overflow:hidden, so the -4px lead-in at a
      // row's first box (and the +1 past its last) would put the marker
      // out of sight exactly where a drop needs it most (review
      // 2026-08-28, finding 6). 5 = the marker's own 3px width plus the
      // 2px inset kept at the other edge.
      line.style.left = Math.min(Math.max(2, x - oRect.left), oRect.width - 5) + 'px';
      line.style.top = (row.top - oRect.top) + 'px';
      line.style.height = (row.bottom - row.top) + 'px';
    } else {
      line.classList.remove('is-vertical');
      line.style.left = '';
      line.style.height = '';
      var atEntry = null;
      entries.forEach(function (en) {
        if (!atEntry && en.index >= insertIndex) {
          atEntry = en;
        }
      });
      var y = atEntry
        ? atEntry.rect.top - 4 - oRect.top
        : entries[entries.length - 1].rect.bottom + 2 - oRect.top;
      line.style.top = y + 'px';
    }
  }

  /**
   * Escape abandons a gesture while the mouse button is still DOWN.
   * The release that follows fires a click on the nearest common
   * ancestor of the press and the release — which IS the originating
   * pick button when the pointer came back to it — so that box's
   * disclosure would toggle after the cancel had already been
   * announced. finishOverviewDrag removes the drag's own mouseup
   * handler, so nothing was left to set the usual latch; arm it on the
   * next release instead (MR review 2026-09-02).
   *
   * Tracked so closeOverview can drop it: a release that happens
   * outside the document never arrives, and a stale one-shot listener
   * would otherwise swallow a later, legitimate click.
   */
  function latchOverviewCancelClick() {
    clearOverviewCancelLatch();
    T.ov.cancelLatchUp = function (e) {
      clearOverviewCancelLatch();
      // A fresh PRESS means the release this was waiting for happened
      // somewhere unobservable — outside the document, or the pointer
      // was cancelled — so the latch is stale and must be dropped, not
      // spent on a click the author actually meant. Without this the
      // listener stayed armed for the rest of the overview session and
      // silently ate the next real click (MR review 2026-09-02).
      // mousedown always precedes the click it belongs to, so clearing
      // here is enough; closeOverview covers leaving the mode entirely.
      if (e && e.type === 'mousedown') {
        return;
      }
      overviewDragConsumedClick = true;
      // Cleared next tick, exactly as a completed drag's latch is:
      // long enough to swallow the click this release produces, short
      // enough to leave the next real one alone.
      window.setTimeout(function () {
        overviewDragConsumedClick = false;
      }, 0);
    };
    document.addEventListener('mouseup', T.ov.cancelLatchUp, true);
    document.addEventListener('mousedown', T.ov.cancelLatchUp, true);
  }

  /**
   * Release the click-swallowing latch a canceled drag left armed. Left
   * in place it stayed armed for the rest of the overview session and ate
   * the next real click.
   */
  function clearOverviewCancelLatch() {
    if (T.ov.cancelLatchUp) {
      document.removeEventListener('mouseup', T.ov.cancelLatchUp, true);
      document.removeEventListener('mousedown', T.ov.cancelLatchUp, true);
      T.ov.cancelLatchUp = null;
    }
  }

  /**
   * Tear the drag down: remove the drop line, undim the boxes, release the
   * document listeners, and forget the drag. Shared by the completed and
   * canceled paths, so neither can leave half of it behind.
   */
  function finishOverviewDrag() {
    if (!T.ov.drag) {
      return;
    }
    var line = document.querySelector('#toolrail-overview .toolrail-ov-dropline');
    if (line) {
      line.remove();
    }
    document.body.classList.remove('toolrail-ov-dragging');
    Array.prototype.slice.call(document.querySelectorAll('#toolrail-overview .toolrail-ov-box.is-dragging'))
      .forEach(function (box) {
        box.classList.remove('is-dragging');
      });
    document.removeEventListener('mousemove', onOverviewDragMove, true);
    document.removeEventListener('mouseup', onOverviewDragEnd, true);
    T.ov.drag = null;
  }

  /**
   * Complete a drag: dispatch the move the drop line was showing, for the
   * group or the single block. A release that never passed the drag
   * threshold is left alone as an ordinary click. A real drag latches the
   * click the browser is about to fire on the button under the pointer, so
   * the release cannot also toggle that box's controls.
   *
   * @param {MouseEvent} e The document mouseup.
   * @return {void}
   */
  function onOverviewDragEnd(e) {
    if (!T.ov.drag) {
      return;
    }
    var wasActive = T.ov.drag.active;
    var clientId = T.ov.drag.clientId;
    var to = T.ov.drag.toIndex;
    var gap = T.ov.drag.gap;
    var groupIds = T.ov.drag.ids;
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
    if (groupIds) {
      if (gap !== -1) {
        moveOverviewBlocksTo(groupIds, gap, null);
      }
    } else if (to !== -1) {
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
      if (T.overviewOpen) {
        positionOverviewBoxes();
      }
    });
    window.setTimeout(function () {
      if (!T.overviewOpen) {
        return;
      }
      // Refit too, not just reposition: the canvas flush after a reorder
      // (or any content change a dispatch made) can change the document
      // height the scale and pan clamp were computed from. The extent is
      // re-measured only when it is marked dirty; the store subscription
      // marks it, but measures inside the dispatch, before the canvas
      // flush. On the iframed canvas, observeOverviewCanvas marks it dirty
      // again after the canvas has changed, and refits then.
      applyOverviewScale();
      positionOverviewBoxes();
    }, 220);
  }

  /**
   * The canvas changed while the overview is open: follow it, however
   * late a reorder flushes or a block grows (#64). The timed passes above
   * guess at that delay; a slow browser can outlast them.
   *
   * A reorder also SLIDES the moved blocks into place: the block editor
   * writes an inline transform on each frame (useMovingAnimation, about
   * 300-450 ms for a long move) and clears it at the end. Rects include
   * the transform, so the boxes follow the slide through these style
   * changes, and the last one puts them where the blocks end. Before,
   * the boxes kept the position the 220 ms pass measured mid-slide, a
   * few pixels off — enough at floor zoom to stand out of order (#78).
   *
   * Two steps, each rate-limited: the boxes reposition on the next frame
   * (at most once per frame), and the document extent is re-measured and
   * refit 220 ms later (at most one pending at a time). The refit is what
   * catches a late HEIGHT change, which the store subscription measured
   * too early to see.
   *
   * Everything here reads the canvas and writes only to the overlay and
   * the editor document. A refit can change the frame's height, and
   * viewport-relative content then resizes the root block list once; the
   * extent is measured with the frame at its natural height
   * (measureOverviewExtent), so that second refit computes the same
   * height and the size observer stops.
   */
  function onOverviewCanvasChange() {
    if (!T.overviewOpen) {
      return;
    }
    // React can replace the root block list inside the same body; the
    // size observer must follow it (the mutation observer sees the swap).
    watchOverviewCanvasRoot();
    if (!overviewCanvasSettlePending) {
      overviewCanvasSettlePending = true;
      window.requestAnimationFrame(function () {
        overviewCanvasSettlePending = false;
        if (T.overviewOpen) {
          positionOverviewBoxes();
        }
      });
    }
    if (!T.ov.canvasRefitTimer) {
      T.ov.canvasRefitTimer = window.setTimeout(function () {
        T.ov.canvasRefitTimer = 0;
        if (!T.overviewOpen) {
          return;
        }
        T.ov.extentDirty = true;
        applyOverviewScale();
        positionOverviewBoxes();
      }, 220);
    }
  }

  /** Point the size observer at the current root block list, if it moved. */
  function watchOverviewCanvasRoot() {
    if (!T.ov.canvasSizeObserver || !T.ov.canvasTarget) {
      return;
    }
    var root = T.ov.canvasTarget.querySelector('.is-root-container');
    if (root && root !== T.ov.canvasSizeTarget) {
      T.ov.canvasSizeObserver.disconnect();
      T.ov.canvasSizeObserver.observe(root);
      T.ov.canvasSizeTarget = root;
    }
  }

  /**
   * Watch the canvas while the overview is open: its block DOM and inline
   * styles (a MutationObserver on the body) and its size (a
   * ResizeObserver on the root block list). Both call
   * onOverviewCanvasChange. Nothing the overview does writes an inline
   * style inside the canvas, so watching styles cannot loop. Safe to call
   * again: it creates the observers once, and moves them to a new canvas
   * body when the editor replaced the iframe. Returns whether it attached
   * to a body it was not watching before, so the caller knows the extent
   * it applied came from the old canvas.
   *
   * Only for the iframed canvas. Without an iframe the canvas body is the
   * editor's own body, which holds the overlay this rebuilds; the timed
   * passes still cover that editor.
   *
   * @return {boolean} True when it attached to a new canvas body.
   */
  function observeOverviewCanvas() {
    if (typeof window.MutationObserver !== 'function') {
      return false;
    }
    var doc = canvasDoc();
    if (!doc || doc === document || !doc.body) {
      return false;
    }
    if (doc.body === T.ov.canvasTarget) {
      return false;
    }
    if (!T.ov.canvasObserver) {
      T.ov.canvasObserver = new window.MutationObserver(onOverviewCanvasChange);
    }
    T.ov.canvasObserver.disconnect();
    T.ov.canvasObserver.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style']
    });
    T.ov.canvasTarget = doc.body;
    if (!T.ov.canvasSizeObserver && typeof window.ResizeObserver === 'function') {
      T.ov.canvasSizeObserver = new window.ResizeObserver(onOverviewCanvasChange);
    }
    T.ov.canvasSizeTarget = null;
    watchOverviewCanvasRoot();
    return true;
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
    // A rebuild replaces every box a drag or marquee is measuring —
    // abandon both.
    finishOverviewDrag();
    cancelOverviewMarquee(false);
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
    modeTitle.textContent = __('Section overview', 'editrail');
    bar.appendChild(modeTitle);

    var crumbs = document.createElement('nav');
    crumbs.className = 'toolrail-ov-crumbs';
    crumbs.setAttribute('aria-label', __('Overview level', 'editrail'));

    var chain = [];
    var id = T.ov.root;
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
        __('Go to %s', 'editrail'),
        label
      ));
      btn.addEventListener('click', function () {
        drillTo(targetRoot);
      });
      crumbs.appendChild(btn);
    };

    addCrumb(__('All sections', 'editrail'), '', chain.length === 0);
    chain.forEach(function (cid, i) {
      addCrumb(overviewBlockLabel(cid), cid, i === chain.length - 1);
    });
    bar.appendChild(crumbs);

    if (T.ov.root) {
      var up = document.createElement('button');
      up.type = 'button';
      up.className = 'toolrail-ov-btn toolrail-ov-uplevel';
      up.dataset.ovAction = 'up-level';
      up.textContent = __('Up one level', 'editrail');
      up.addEventListener('click', function () {
        drillTo((sel && sel.getBlockRootClientId(T.ov.root)) || '');
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
    zoomOut.setAttribute('aria-label', __('Zoom out', 'editrail'));
    zoomOut.addEventListener('click', function () {
      setOverviewZoom(T.ov.metrics.k / 1.25, true);
    });
    bar.appendChild(zoomOut);

    var zoomLabel = settingsRow('span', 'toolrail-ov-zoomlabel');
    zoomLabel.setAttribute('aria-hidden', 'true');
    zoomLabel.textContent = Math.round(T.ov.metrics.k * 100) + '%';
    bar.appendChild(zoomLabel);

    var zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'toolrail-ov-btn toolrail-ov-zoom';
    zoomIn.dataset.ovAction = 'zoom-in';
    zoomIn.textContent = '+';
    zoomIn.setAttribute('aria-label', __('Zoom in', 'editrail'));
    zoomIn.addEventListener('click', function () {
      setOverviewZoom(T.ov.metrics.k * 1.25, true);
    });
    bar.appendChild(zoomIn);

    var escHint = settingsRow('span', 'toolrail-ov-esc');
    escHint.textContent = __('Esc exits', 'editrail');
    bar.appendChild(escHint);

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toolrail-ov-btn toolrail-ov-close';
    close.dataset.ovAction = 'close';
    // A labeled exit, not a bare × — the visible text IS the accessible
    // name, so speech input's "click Done" just works.
    close.textContent = __('Done', 'editrail');
    close.addEventListener('click', function () {
      closeOverview(true);
    });
    bar.appendChild(close);
    // The bar stays FIRST in DOM order, where it is drawn: Tab order and
    // the visual order agree, and Shift+Tab from the first section
    // reaches Done. Keeping focus inside the overlay is the keydown
    // handler's job (SR-3, QA 2026-09-11; review 2026-09-13, finding 3).
    overlay.appendChild(bar);

    // --- Outline boxes, one per block, DOM order = document order.
    // A box is lines around the block plus a small corner tag; the
    // reorder controls appear only after the box is picked (owner
    // feedback 2026-08-27: the always-on chip bars obscured content). ---
    var order = overviewOrder();
    if (!order.length) {
      var empty = settingsRow('p', 'toolrail-ov-empty');
      empty.textContent = __('Nothing to reorder here.', 'editrail');
      bar.appendChild(empty);
    }
    if (T.ov.selected && order.indexOf(T.ov.selected) === -1) {
      T.ov.selected = '';
    }
    // Prune the multi-selection too — members can vanish between
    // rebuilds (deleted blocks, a root change) — and keep the
    // active-box invariant (the active box, when a multi-selection
    // exists, is one of its members).
    if (T.ov.selectedIds.length) {
      if (T.ov.selected && T.ov.selectedIds.indexOf(T.ov.selected) === -1) {
        T.ov.selectedIds.push(T.ov.selected);
      }
      // eslint-disable-next-line no-shadow -- the outer `id` is the breadcrumb loop's scratch value, finished before this line.
      T.ov.selectedIds = order.filter(function (id) {
        return T.ov.selectedIds.indexOf(id) !== -1;
      });
    }
    if (T.ov.anchor && order.indexOf(T.ov.anchor) === -1) {
      T.ov.anchor = '';
    }

    // Drilled in, everything OUTSIDE the root gets a 50% veil (owner
    // feedback 2026-08-27): four strips punched around the root's rect,
    // so what can be reordered is the only thing at full strength. Pure
    // overlay chrome — the canvas document is untouched, and removing
    // the overlay removes the veil. Appended BEFORE the boxes so DOM
    // order stacks the boxes above it; the bar carries its own z-index.
    if (T.ov.root) {
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
      var isActive = clientId === T.ov.selected;
      var isMember = T.ov.selectedIds.indexOf(clientId) !== -1;
      var groupSize = T.ov.selectedIds.length;
      // Group mode: the active member's controls strip acts on the
      // whole selection (issue #21).
      var groupActive = isActive && isMember && groupSize > 1;
      var movable = overviewCanMove(clientId);
      var li = document.createElement('li');
      li.className = 'toolrail-ov-box'
        + (isActive || isMember ? ' is-selected' : '')
        + (isActive ? ' is-active' : '')
        + (movable ? '' : ' is-locked');
      li.dataset.clientid = clientId;

      // The whole box is one focusable disclosure: click it (or press
      // Enter on it) and the reorder controls appear inside the lines.
      var pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'toolrail-ov-selectbtn';
      pick.dataset.ovAction = 'pick';
      pick.setAttribute('aria-expanded', isActive ? 'true' : 'false');
      var pickLabel = sprintf(
        /* translators: 1: block title, 2: its position, 3: count. */
        __('%1$s, position %2$d of %3$d — show reorder controls', 'editrail'),
        label,
        i + 1,
        order.length
      );
      if (!movable) {
        pickLabel = sprintf(
          /* translators: %s: the pick button's accessible name. */
          __('%s — locked, cannot be moved', 'editrail'),
          pickLabel
        );
      }
      // The base name is stashed so syncOverviewSelection can append
      // (and drop) the membership suffix without a rebuild.
      pick.dataset.baseLabel = pickLabel;
      pick.setAttribute('aria-label', isMember && groupSize > 1
        ? sprintf(
          /* translators: %s: the pick button's base accessible name. */
          __('%s — selected', 'editrail'),
          pickLabel
        )
        : pickLabel);
      pick.addEventListener('mousedown', function (e) {
        startOverviewDrag(e, clientId);
      });
      pick.addEventListener('click', function (e) {
        // A completed drag's (or marquee's) release fires a click on
        // this same button; the latch keeps it from also toggling the
        // controls.
        if (overviewDragConsumedClick) {
          return;
        }
        // Modifier clicks build the multi-selection (issue #21) and
        // never run the plain disclosure toggle. Cmd is first-class:
        // macOS gives Ctrl+click to the context menu.
        if (e.shiftKey) {
          T.ov.lastTouched = clientId;
          setOverviewRange(T.ov.anchor || T.ov.selected || clientId, clientId);
          // Rebuild after every selection gesture: the active strip's
          // content is baked per build (focus re-derives to this pick).
          buildOverviewContent();
          announceOverviewSelection();
          return;
        }
        if (e.ctrlKey || e.metaKey) {
          T.ov.lastTouched = clientId;
          toggleOverviewSelectionId(clientId);
          buildOverviewContent();
          announceOverviewSelection();
          return;
        }
        if (e.altKey) {
          removeOverviewSelectionId(clientId);
          buildOverviewContent();
          announceOverviewSelection();
          return;
        }
        if (T.ov.selected === clientId) {
          clearOverviewMultiSelection();
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

      // Selection mark: a tick on its own chip, at the corner opposite
      // the name tag. Built for every box and revealed by CSS on
      // .is-selected, so the marquee's live class toggles need no
      // rebuild. It is the non-colour cue 1.4.11 wants — the
      // #3858e9 → #1d35b4 border shift measures 1.68:1, and forced
      // colours flatten it away entirely (MR review 2026-08-31,
      // finding 1). aria-hidden: the pick button's name carries the
      // state to AT.
      var mark = settingsRow('span', 'toolrail-ov-selectmark');
      mark.setAttribute('aria-hidden', 'true');
      mark.innerHTML = OVERVIEW_CHECK_ICON;
      li.appendChild(mark);

      if (!movable) {
        // Visible lock annotation (plan review 2026-08-31): before
        // this, a locked box looked like any other until its arrows
        // came up disabled. A DIRECT child of the box, never part of
        // the name tag — the tag is hidden while a box is selected,
        // which took the lock marker away at exactly the moment the
        // author was deciding whether to press the group arrow (MR
        // review 2026-08-31, finding 2). aria-hidden: the pick
        // button's name carries "locked" to AT.
        var lockTag = settingsRow('span', 'toolrail-ov-locktag');
        lockTag.setAttribute('aria-hidden', 'true');
        lockTag.innerHTML = OVERVIEW_LOCK_ICON + ' ';
        lockTag.appendChild(document.createTextNode(__('Locked', 'editrail')));
        li.appendChild(lockTag);
      }

      var controls = settingsRow('div', 'toolrail-ov-controls');
      controls.hidden = !isActive;

      var name = settingsRow('span', 'toolrail-ov-label');
      name.textContent = groupActive
        ? sprintf(
          /* translators: %d: number of selected blocks. */
          _n('%d block selected', '%d blocks selected', groupSize, 'editrail'),
          groupSize
        )
        : label;
      controls.appendChild(name);

      var pos = settingsRow('span', 'toolrail-ov-pos');
      pos.textContent = sprintf(
        /* translators: 1: position, 2: count. */
        __('%1$d of %2$d', 'editrail'),
        i + 1,
        order.length
      );
      controls.appendChild(pos);

      // canMoveBlocks (via overviewCanMove, computed above): the arrows
      // must not offer a move core will silently refuse — announcing an
      // unperformed move would lie to a screen-reader user (review
      // 2026-08-27, finding 1). In group mode the arrows stay enabled
      // while ANY member is movable; the move engine excludes the
      // locked members and the announcement says so.
      var groupMembers = groupActive ? overviewSelectionInOrder() : [];
      // The edge tests run against the MOVABLE members, never the
      // extreme members: a locked block sitting at a document edge
      // inside the selection stays where it is, so testing against it
      // vetoed a move that is perfectly legal for the rest — both
      // arrows could go dead while the strip said "3 blocks selected"
      // and nothing was announced (MR review 2026-08-31, finding 3).
      // eslint-disable-next-line no-shadow -- the outer `id` is the breadcrumb loop's scratch value, finished before this line.
      var groupMovable = groupMembers.filter(function (id) {
        return overviewCanMove(id);
      });
      var firstMovableAt = groupMovable.length ? order.indexOf(groupMovable[0]) : -1;
      var lastMovableAt = groupMovable.length ? order.indexOf(groupMovable[groupMovable.length - 1]) : -1;

      var upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'toolrail-ov-btn toolrail-ov-move';
      upBtn.dataset.ovAction = 'up';
      upBtn.textContent = '↑';
      upBtn.setAttribute('aria-label', groupActive
        ? sprintf(
          /* translators: %d: number of selected blocks. */
          _n('Move %d selected block up', 'Move %d selected blocks up', groupSize, 'editrail'),
          groupSize
        )
        : sprintf(
          /* translators: 1: block title, 2: its position. */
          __('Move %1$s, position %2$d, up', 'editrail'),
          label,
          i + 1
        ));
      upBtn.disabled = groupActive
        ? (!groupMovable.length || firstMovableAt <= 0)
        : (i === 0 || !movable);
      upBtn.addEventListener('click', function () {
        if (groupActive) {
          moveOverviewGroupStep(-1, 'up');
        } else {
          moveOverviewBlock(clientId, -1);
        }
      });
      controls.appendChild(upBtn);

      var downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'toolrail-ov-btn toolrail-ov-move';
      downBtn.dataset.ovAction = 'down';
      downBtn.textContent = '↓';
      downBtn.setAttribute('aria-label', groupActive
        ? sprintf(
          /* translators: %d: number of selected blocks. */
          _n('Move %d selected block down', 'Move %d selected blocks down', groupSize, 'editrail'),
          groupSize
        )
        : sprintf(
          /* translators: 1: block title, 2: its position. */
          __('Move %1$s, position %2$d, down', 'editrail'),
          label,
          i + 1
        ));
      downBtn.disabled = groupActive
        ? (!groupMovable.length || lastMovableAt >= order.length - 1)
        : (i === order.length - 1 || !movable);
      downBtn.addEventListener('click', function () {
        if (groupActive) {
          moveOverviewGroupStep(1, 'down');
        } else {
          moveOverviewBlock(clientId, 1);
        }
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
        enter.textContent = __('Reorder inside', 'editrail');
        // The name is group-scoped in group mode, like both arrows —
        // otherwise a browse-mode pass reads "2 blocks selected", two
        // group-scoped arrows, then a single-block "Reorder inside
        // Group, position 2" (MR review 2026-09-01). The visible text
        // still LEADS the accessible name either way (WCAG 2.5.3),
        // and the group form states why the button is disabled.
        enter.setAttribute('aria-label', groupActive
          ? sprintf(
            /* translators: %d: number of selected blocks. */
            _n(
              'Reorder inside — not available while %d block is selected',
              'Reorder inside — not available while %d blocks are selected',
              groupSize,
              'editrail'
            ),
            groupSize
          )
          : sprintf(
            /* translators: 1: block title, 2: its position. */
            __('Reorder inside %1$s, position %2$d', 'editrail'),
            label,
            i + 1
          ));
        // Stepping INTO a section is a single-block action: the root
        // change would clear the selection the author just built, and
        // "inside WHICH of them?" has no answer while several blocks
        // are selected. Disabled in group mode rather than silently
        // dropping the selection (owner decision 2026-09-01).
        // Revisited for contiguous selections in the follow-up issue —
        // see the R12 note in private/roadmap.md.
        enter.disabled = groupActive;
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
    wp.data.dispatch('core/block-editor').moveBlocksToPosition([clientId], T.ov.root, T.ov.root, to);

    // VERIFY before announcing: core's action has its own canMoveBlocks
    // guard and returns early — silently — for a locked block. The
    // arrows are disabled (and the drag refused) for those, but
    // belt-and-braces: never tell a screen-reader user a move happened
    // when the order did not change (review 2026-08-27, finding 1).
    if (overviewOrder()[to] !== clientId) {
      speak(sprintf(
        /* translators: %s: block title. */
        __('%s cannot be moved.', 'editrail'),
        overviewBlockLabel(clientId)
      ));
      return;
    }
    T.ov.signature = overviewCurrentSignature();
    // Only a move that VERIFIED counts as touched — a refused move must
    // not make close center a block the author never actually moved.
    T.ov.lastTouched = clientId;

    if (focusAction) {
      T.ov.selected = clientId;
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
      __('Moved %1$s to position %2$d of %3$d.', 'editrail'),
      overviewBlockLabel(clientId),
      to + 1,
      order.length
    ));
  }

  /**
   * Move one block up (-1) or down (+1) among its siblings — what the
   * box's arrow controls call. The index work, the permission check and
   * the announcement all live in moveOverviewBlockTo.
   *
   * @param {string} clientId The block's client id.
   * @param {number} delta    -1 or +1.
   * @return {void}
   */
  function moveOverviewBlock(clientId, delta) {
    var idx = overviewOrder().indexOf(clientId);
    if (idx === -1) {
      return;
    }
    moveOverviewBlockTo(clientId, idx + delta, delta < 0 ? 'up' : 'down');
  }

  /**
   * Contiguous runs of `ids` in the current order, as [{start, ids}] in
   * document order. The group-move engine folds these together.
   */
  function overviewContiguousRuns(ids) {
    var runs = [];
    var last = -2;
    overviewOrder().forEach(function (id, i) {
      if (ids.indexOf(id) === -1) {
        return;
      }
      if (i === last + 1 && runs.length) {
        runs[runs.length - 1].ids.push(id);
      } else {
        runs.push({ start: i, ids: [id] });
      }
      last = i;
    });
    return runs;
  }

  /**
   * Move the selection as a GROUP to an insertion gap (issue #21): the
   * members land next to each other, in document order, where the gap
   * falls among the blocks that are not moving.
   *
   * Same public dispatch as the single path — but core's same-root
   * reducer moves ONE contiguous slice per action (moveTo from the
   * first id's index), so a non-contiguous selection is moved as a
   * SEQUENCE: every later run is folded up against the first
   * (compaction never reorders the non-members, nor the members among
   * themselves), then one dispatch places the now-contiguous group. A
   * contiguous selection — the only kind List View can even express —
   * is exactly one dispatch, byte-identical to the same move made
   * there. Undo cost: one step per dispatch. The single-step
   * alternative (__unstableMarkNextChangeAsNotPersistent) is an
   * unstable API and R6 is public-APIs-only — a documented trade, not
   * an oversight.
   *
   * Locked members are EXCLUDED and stay where they are — the issue's
   * contract — and the one composed announcement says so. The store
   * subscription is fenced off for the sequence (ov.groupMove);
   * the final order is VERIFIED before any success is announced.
   *
   * @param {string[]}    ids         Selection members (any order).
   * @param {number}      gap         Insertion gap in the CURRENT
   *                                  order (0..length), e.g. from the
   *                                  drop line — NOT a post-removal
   *                                  index.
   * @param {string|null} focusAction 'up'/'down' from the arrows
   *                                  (focus stays on that arrow); null
   *                                  from a drag.
   */
  function moveOverviewBlocksTo(ids, gap, focusAction) {
    var order = overviewOrder();
    var members = order.filter(function (id) {
      return ids.indexOf(id) !== -1;
    });
    if (!members.length) {
      return;
    }
    var movable = members.filter(function (id) {
      return overviewCanMove(id);
    });
    var locked = members.filter(function (id) {
      return movable.indexOf(id) === -1;
    });
    var lockedSuffix = '';
    if (locked.length === 1) {
      lockedSuffix = ' ' + sprintf(
        /* translators: %s: block title. */
        __('%s is locked and stays where it is.', 'editrail'),
        overviewBlockLabel(locked[0])
      );
    } else if (locked.length) {
      lockedSuffix = ' ' + sprintf(
        /* translators: %d: number of locked blocks. */
        _n(
          '%d locked block stays where it is.',
          '%d locked blocks stay where they are.',
          locked.length,
          'editrail'
        ),
        locked.length
      );
    }
    if (!movable.length) {
      // One block names itself (reusing the single path's string);
      // more than one counts. Both _n forms carry the same
      // placeholder — a locale whose plural rule picks the first form
      // for n≠1 must still be able to insert the count (MR review
      // 2026-08-31, finding 4).
      speak(members.length === 1
        ? sprintf(
          /* translators: %s: block title. */
          __('%s cannot be moved.', 'editrail'),
          overviewBlockLabel(members[0])
        )
        : sprintf(
          /* translators: %d: number of selected blocks. */
          _n(
            'The %d selected block is locked and cannot be moved.',
            'The %d selected blocks are locked and cannot be moved.',
            members.length,
            'editrail'
          ),
          members.length
        ));
      return;
    }
    gap = Math.min(Math.max(0, gap), order.length);
    if (movable.length === 1 && !locked.length) {
      // One movable block is the existing, fully verified single path.
      var idx = order.indexOf(movable[0]);
      moveOverviewBlockTo(movable[0], gap > idx ? gap - 1 : gap, focusAction);
      return;
    }

    // Where the group lands: its final start index = how many
    // NON-MOVING blocks sit before the gap. Non-members never reorder
    // during the sequence, so this is invariant through compaction.
    var insertAt = 0;
    for (var i = 0; i < gap; i++) {
      if (movable.indexOf(order[i]) === -1) {
        insertAt++;
      }
    }
    var others = order.filter(function (id) {
      return movable.indexOf(id) === -1;
    });
    var desired = others.slice(0, insertAt).concat(movable, others.slice(insertAt));
    if (desired.join(',') === order.join(',')) {
      // Dropping the group where it already sits — like the single
      // path's to === idx: nothing to do, nothing to announce.
      return;
    }

    var dispatcher = wp.data.dispatch('core/block-editor');
    T.ov.groupMove = true;
    try {
      // COMPACT: fold run 2 up against run 1 until one run remains.
      // Folding a LATER run never shifts the first run's indices, and
      // the reducer's index is the moved slice's FINAL start. Runs are
      // recomputed from the live order after every dispatch; a refused
      // dispatch (a lock landing mid-sequence) leaves the count
      // unchanged and breaks out — the verify below fails safe.
      var runs = overviewContiguousRuns(movable);
      var guard = runs.length + 1;
      while (runs.length > 1 && guard-- > 0) {
        dispatcher.moveBlocksToPosition(
          runs[1].ids, T.ov.root, T.ov.root,
          runs[0].start + runs[0].ids.length
        );
        var next = overviewContiguousRuns(movable);
        if (next.length >= runs.length) {
          break;
        }
        runs = next;
      }
      // PLACE: one dispatch drops the contiguous group at its final
      // start. Skipped if compaction broke out — the verify announces
      // the honest result either way.
      if (runs.length === 1) {
        dispatcher.moveBlocksToPosition(movable, T.ov.root, T.ov.root, insertAt);
      }
    } finally {
      T.ov.groupMove = false;
    }

    // VERIFY before announcing — the moveOverviewBlockTo discipline:
    // never tell a screen-reader user a move happened when the final
    // order says otherwise.
    var finalOrder = overviewOrder();
    var ok = movable.every(function (id, at) {
      return finalOrder[insertAt + at] === id;
    });
    T.ov.signature = overviewCurrentSignature();
    if (ok) {
      T.ov.lastTouched = T.ov.selected && movable.indexOf(T.ov.selected) !== -1
        ? T.ov.selected
        : movable[0];
    }
    if (focusAction) {
      if (!T.ov.selected || members.indexOf(T.ov.selected) === -1) {
        T.ov.selected = movable[0];
      }
      var boxSel = '.toolrail-ov-box[data-clientid="' + T.ov.selected + '"] ';
      buildOverviewContent([
        boxSel + '[data-ov-action="' + focusAction + '"]',
        boxSel + '[data-ov-action="' + (focusAction === 'up' ? 'down' : 'up') + '"]'
      ]);
    } else {
      buildOverviewContent();
    }
    scheduleOverviewSettle();

    if (ok) {
      speak(sprintf(
        /* translators: 1: number of moved blocks, 2: new position of the first, 3: count. */
        _n(
          'Moved %1$d block to position %2$d of %3$d.',
          'Moved %1$d blocks to position %2$d of %3$d.',
          movable.length,
          'editrail'
        ),
        movable.length,
        insertAt + 1,
        finalOrder.length
      ) + lockedSuffix);
    } else {
      speak(__('The move could not be completed.', 'editrail'));
    }
  }

  /** The group arrows: one step past the neighbor. Everything before
      the FIRST member is a non-member by definition, so "the nearest
      non-selected block before it" is simply the one at first−1; the
      mirror holds for down. At an edge the arrows are disabled, so
      returning early here is belt only. */
  function moveOverviewGroupStep(delta, focusAction) {
    var order = overviewOrder();
    var members = overviewSelectionInOrder();
    if (!members.length) {
      return;
    }
    // Step past the nearest block OUTSIDE the movable set. The edge
    // test must use the movable members, not the extreme members —
    // the same defect as the arrows' disabled state (MR review
    // 2026-08-31, finding 3), and the half of it the review did not
    // name: fixing only the button would have left the arrow live and
    // the click a silent no-op, which is worse than a dead arrow.
    var movable = members.filter(function (id) {
      return overviewCanMove(id);
    });
    if (!movable.length) {
      // Nothing can move — the engine owns the "all locked" message.
      moveOverviewBlocksTo(members, 0, focusAction);
      return;
    }
    var gap;
    if (delta < 0) {
      var first = order.indexOf(movable[0]);
      if (first <= 0) {
        return;
      }
      gap = first - 1;
    } else {
      var last = order.indexOf(movable[movable.length - 1]);
      if (last === -1 || last >= order.length - 1) {
        return;
      }
      gap = last + 2;
    }
    moveOverviewBlocksTo(members, gap, focusAction);
  }

  // -------------------------------------------------------------------
  // Marquee select — a drag from EMPTY overlay space draws a rectangle;
  // every box it touches is selected on release (issue #21). Pointer
  // sugar like the box drag: the keyboard's path to the same selection
  // is Shift+Arrow / Ctrl+Space in onOverviewKeydown. Coordinates are
  // viewport-space, so a wheel-pan mid-marquee just changes which boxes
  // the fixed rectangle touches — the next mousemove re-hit-tests.
  // -------------------------------------------------------------------

  function startOverviewMarquee(e) {
    T.ov.marquee = {
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      // With a modifier held the marquee ADDS to the selection instead
      // of replacing it.
      additive: !!(e.ctrlKey || e.metaKey || e.shiftKey),
      baseIds: T.ov.selectedIds.slice(),
      prevActive: T.ov.selected
    };
    document.addEventListener('mousemove', onOverviewMarqueeMove, true);
    document.addEventListener('mouseup', onOverviewMarqueeEnd, true);
  }

  /** Tear the marquee down. restore=true (Escape) puts the selection
      back the way the mousedown found it; false lets the caller own
      what happens next. */
  function cancelOverviewMarquee(restore) {
    if (!T.ov.marquee) {
      return;
    }
    var m = T.ov.marquee;
    T.ov.marquee = null;
    var rect = document.querySelector('#toolrail-overview .toolrail-ov-marquee');
    if (rect) {
      rect.remove();
    }
    document.removeEventListener('mousemove', onOverviewMarqueeMove, true);
    document.removeEventListener('mouseup', onOverviewMarqueeEnd, true);
    if (restore && m.active) {
      setOverviewSelection(m.baseIds, m.prevActive);
    }
  }

  /**
   * Draw the marquee rectangle and paint the selection it touches, live,
   * so the author sees the group build. Any positive overlap on both axes
   * counts as a hit; the announcement waits for the release, because a
   * gesture deserves one message, not one per frame. Nothing happens until
   * the press passes a 5px threshold.
   *
   * @param {MouseEvent} e The document mousemove.
   * @return {void}
   */
  function onOverviewMarqueeMove(e) {
    if (!T.ov.marquee) {
      return;
    }
    if (!T.ov.marquee.active) {
      if (Math.abs(e.clientX - T.ov.marquee.startX) < 5 && Math.abs(e.clientY - T.ov.marquee.startY) < 5) {
        return;
      }
      T.ov.marquee.active = true;
      // The rectangle replaces the disclosure: a marquee starts on
      // empty space, and empty-space presses have always collapsed the
      // open controls.
      T.ov.selected = '';
    }
    e.preventDefault();
    var overlay = overviewNode();
    if (!overlay) {
      return;
    }
    var oRect = overlay.getBoundingClientRect();
    var x1 = Math.min(Math.max(Math.min(e.clientX, T.ov.marquee.startX), oRect.left), oRect.right);
    var x2 = Math.min(Math.max(Math.max(e.clientX, T.ov.marquee.startX), oRect.left), oRect.right);
    var y1 = Math.min(Math.max(Math.min(e.clientY, T.ov.marquee.startY), oRect.top), oRect.bottom);
    var y2 = Math.min(Math.max(Math.max(e.clientY, T.ov.marquee.startY), oRect.top), oRect.bottom);
    var rect = overlay.querySelector('.toolrail-ov-marquee');
    if (!rect) {
      rect = document.createElement('div');
      rect.className = 'toolrail-ov-marquee';
      rect.setAttribute('aria-hidden', 'true');
      overlay.appendChild(rect);
    }
    rect.style.left = (x1 - oRect.left) + 'px';
    rect.style.top = (y1 - oRect.top) + 'px';
    rect.style.width = (x2 - x1) + 'px';
    rect.style.height = (y2 - y1) + 'px';

    // "Every box the rectangle touches": any positive overlap on both
    // axes. Live-painted so the author sees the selection build; the
    // announcement waits for the release (one speak per gesture).
    var hits = [];
    Array.prototype.slice.call(overlay.querySelectorAll('.toolrail-ov-box')).forEach(function (box) {
      if (box.style.display === 'none') {
        return;
      }
      var b = box.getBoundingClientRect();
      if (b.left < x2 && b.right > x1 && b.top < y2 && b.bottom > y1) {
        hits.push(box.dataset.clientid);
      }
    });
    setOverviewSelection(T.ov.marquee.additive ? T.ov.marquee.baseIds.concat(hits) : hits, '');
  }

  /**
   * Complete a marquee: make its first member the active box, rebuild so
   * that member's strip becomes the group's, and announce the selection
   * once. A press that never became a marquee is the plain empty-space
   * click it has always been — collapse the controls and clear the group.
   *
   * @param {MouseEvent} e The document mouseup.
   * @return {void}
   */
  function onOverviewMarqueeEnd(e) {
    var m = T.ov.marquee;
    cancelOverviewMarquee(false);
    if (!m) {
      return;
    }
    if (!m.active) {
      // The plain empty-space click this always was: collapse the open
      // controls and clear any multi-selection.
      clearOverviewMultiSelection();
      deselectOverviewBox(false);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // Released over a box, the browser still fires click on its pick
    // button — the drag latch keeps that from toggling the disclosure.
    overviewDragConsumedClick = true;
    window.setTimeout(function () {
      overviewDragConsumedClick = false;
    }, 0);
    var members = overviewSelectionInOrder();
    if (members.length) {
      T.ov.selected = members[0];
      T.ov.anchor = members[0];
      T.ov.lastTouched = members[0];
    }
    // Rebuild: the active member's strip becomes the group's strip.
    buildOverviewContent();
    announceOverviewSelection();
  }

  /**
   * Re-root the overview ('' = top level) — the drill-in machinery. The
   * SAME chips reorder children inside a section; the root change is
   * announced, and the zoom refits to the new root.
   */
  function drillTo(root, announcePrefix) {
    // A root change ALWAYS drops the selection (each level owns its
    // own), so the "it went away and nothing said so" fix belongs
    // HERE, not at the doors. Three callers can reach this with a
    // group selected — the breadcrumb, "Up one level", and the forced
    // climb when the drilled-into block is deleted — and guarding them
    // one at a time is how the fourth gets missed. "Reorder inside"
    // is the one door that refuses instead of announcing, because
    // "inside which of them?" has no answer (MR review 2026-09-01).
    var hadGroup = T.ov.selectedIds.length > 1;
    T.ov.root = root || '';
    // Drilling INTO a section is touching it; climbing back to the top
    // level ('') is not — the last touched child stays the landing spot.
    if (T.ov.root) {
      T.ov.lastTouched = T.ov.root;
    }
    // Each level gets its own zoom, pan and selection.
    T.ov.selected = '';
    T.ov.selectedIds = [];
    T.ov.anchor = '';
    T.ov.pan = 0;
    T.ov.userScale = 0;
    T.ov.signature = overviewCurrentSignature();
    applyOverviewScale();
    buildOverviewContent(OVERVIEW_FOCUS_CANDIDATES);
    scheduleOverviewSettle();

    var count = overviewOrder().length;
    var message;
    if (T.ov.root) {
      message = sprintf(
        /* translators: 1: block title, 2: number of blocks inside it. */
        _n('Viewing inside %1$s — %2$d block.', 'Viewing inside %1$s — %2$d blocks.', count, 'editrail'),
        overviewBlockLabel(T.ov.root),
        count
      );
    } else {
      message = sprintf(
        /* translators: %d: number of top-level sections. */
        _n('Viewing all sections — %d section.', 'Viewing all sections — %d sections.', count, 'editrail'),
        count
      );
    }
    // wp.a11y.speak REPLACES the region's text, so a forced root change
    // (the drilled-into block was deleted) composes its reason into ONE
    // message instead of racing two — and so does the dropped
    // selection, as a suffix, the way the group move composes its
    // locked-member note.
    speak((announcePrefix ? announcePrefix + ' ' : '')
      + message
      + (hadGroup ? ' ' + __('Selection cleared.', 'editrail') : ''));
  }

  /**
   * Escape has TWO outcomes (owner decision 2026-09-01): a pointer
   * gesture in flight is abandoned, and otherwise the overview CLOSES
   * in one press — the same thing "Done" does, which is what the bar's
   * "Esc exits" hint promises. It no longer clears the selection,
   * collapses the controls, or climbs a level; climbing has its own
   * visible controls ("Up one level" and the breadcrumbs).
   *
   * It acts ONLY when focus is inside the overlay (the help panel
   * lesson: an Escape aimed at the inserter or a sidebar must never be
   * hijacked) or a pointer gesture is in flight (its mousedown took no
   * focus, and it must still be cancellable).
   *
   * Shift+Arrow extends the selection from the focused box and
   * Ctrl+Space (Cmd+Space) toggles it (issue #21) — both live here so
   * the pick buttons need no per-box key handlers.
   */
  function onOverviewKeydown(e) {
    if (!T.overviewOpen) {
      return;
    }
    var overlay = overviewNode();
    if (!overlay) {
      return;
    }
    var inOverlay = overlay.contains(document.activeElement);

    // Tab stays inside the overlay while it is open (SR-3, QA
    // 2026-09-11): the sections were the last focusable things in the
    // document, so one Tab too many left the page for the browser's own
    // toolbar with the overview still covering the canvas. The overlay
    // already owns the canvas for its lifetime; owning Tab is the same
    // promise. Last → first and first → last, over the visible controls
    // (a picked box's arrows count once they are shown).
    if (e.key === 'Tab' && inOverlay) {
      var stops = Array.prototype.filter.call(
        overlay.querySelectorAll('button, [tabindex="0"]'),
        function (el) { return !el.disabled && el.offsetParent !== null; }
      );
      if (!stops.length) {
        return;
      }
      var first = stops[0];
      var last = stops[stops.length - 1];
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
      return;
    }

    if (e.key === 'Escape') {
      if (!inOverlay && !T.ov.drag && !T.ov.marquee) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      // TWO outcomes, not a ladder (owner decision 2026-09-01): an
      // in-flight pointer gesture is abandoned, and Escape otherwise
      // EXITS — the same thing "Done" does, which is what the bar's
      // "Esc exits" hint has always promised.
      //
      // The gesture rung is not a nicety. Escape during a drag must
      // abort the drag, because the pending mouseup is still armed and
      // closing the mode instead would let it commit the very move the
      // author is trying to abandon.
      //
      // Both outcomes ANNOUNCE, and the quiet one says what the next
      // Escape will do. With only two outcomes and very different
      // consequences, a silent cancel would leave a screen-reader user
      // unable to tell whether they had left the mode. One composed
      // speak() per press — wp.a11y.speak replaces the region's text.
      // Nothing here is lost by exiting: moves are already in the
      // store, the close lands on the last touched block, and the
      // selection and drill level are view state. Climbing a level
      // keeps "Up one level" and the breadcrumbs; clearing a selection
      // without leaving is Enter on the active box.
      if (T.ov.marquee) {
        // Abandon the rectangle; the selection goes back as found.
        cancelOverviewMarquee(true);
        latchOverviewCancelClick();
        speak(__('Selection rectangle canceled. Press Escape again to close the overview.', 'editrail'));
      } else if (T.ov.drag) {
        // Abandon an in-flight drag; nothing moves.
        finishOverviewDrag();
        latchOverviewCancelClick();
        speak(__('Move canceled. Press Escape again to close the overview.', 'editrail'));
      } else {
        closeOverview(true);
      }
      return;
    }

    // The selection keys act on the FOCUSED box's pick button only.
    if (!inOverlay) {
      return;
    }
    var active = document.activeElement;
    if (!active || !active.dataset || active.dataset.ovAction !== 'pick') {
      return;
    }
    var box = active.closest ? active.closest('.toolrail-ov-box') : null;
    var clientId = box ? box.dataset.clientid : '';
    if (!clientId) {
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === ' ' || e.key === 'Spacebar')) {
      // preventDefault on KEYDOWN: buttons click on Space keyup, and
      // the toggle must not also flip the disclosure.
      e.preventDefault();
      e.stopPropagation();
      T.ov.lastTouched = clientId;
      toggleOverviewSelectionId(clientId);
      // Rebuild (strip content tracks the selection), focus kept on
      // this same pick button.
      buildOverviewContent(['.toolrail-ov-box[data-clientid="' + clientId + '"] [data-ov-action="pick"]']);
      announceOverviewSelection();
      return;
    }

    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      var rtl = overviewIsRtl();
      var delta = 0;
      if (e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) {
        delta = 1;
      } else if (e.key === 'ArrowUp' || e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) {
        delta = -1;
      }
      if (!delta) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      var order = overviewOrder();
      var at = order.indexOf(clientId);
      var neighbor = at === -1 ? '' : order[at + delta];
      if (!neighbor) {
        return;
      }
      if (!T.ov.anchor || order.indexOf(T.ov.anchor) === -1) {
        T.ov.anchor = clientId;
      }
      setOverviewRange(T.ov.anchor, neighbor);
      T.ov.lastTouched = neighbor;
      // Rebuild (strip content tracks the selection) with focus on the
      // neighbor's pick — the focusin handler pans it into view free.
      buildOverviewContent(['.toolrail-ov-box[data-clientid="' + neighbor + '"] [data-ov-action="pick"]']);
      announceOverviewSelection();
    }
  }

  /** Scroll/resize only REPOSITION (debounced); the store subscription
      below owns rebuilds. Also the self-heal hook: the editor replacing
      its content region (code-editor round trip) closes the overview
      cleanly rather than leaving a scaled ghost. */
  function onOverviewViewportChange() {
    if (!T.overviewOpen || T.ov.repositionTimer) {
      return;
    }
    T.ov.repositionTimer = window.setTimeout(function () {
      T.ov.repositionTimer = null;
      if (!T.overviewOpen) {
        return;
      }
      if (!contentRegion() || (T.ov.hadFrame && !canvasFrame())) {
        closeOverview(false);
        return;
      }
      placeOverviewOverlay();
      // A viewport change can resize viewport-relative content — the
      // one legitimate reason to re-measure the extent.
      T.ov.extentDirty = true;
      applyOverviewScale();
      positionOverviewBoxes();
    }, 50);
  }

  /** Change-guarded store subscription (the syncPressed pattern): bail
      on the cached signature before touching the DOM; a deleted root
      climbs to the top level rather than stranding the overview. */
  function onOverviewStoreChange() {
    if (!T.overviewOpen) {
      return;
    }
    if (T.ov.groupMove) {
      // Mid-sequence dispatches from the group-move engine; it writes
      // the final signature and rebuilds once, after its verify.
      return;
    }
    var sel = wp.data.select('core/block-editor');
    if (T.ov.root && sel && !sel.getBlock(T.ov.root)) {
      // A forced root change is a root change like any other — announce
      // it (review 2026-08-27, finding 5), composed with the reason.
      drillTo('', __('The section you were viewing was removed.', 'editrail'));
      return;
    }
    var sig = overviewCurrentSignature();
    if (sig === T.ov.signature) {
      return;
    }
    T.ov.signature = sig;
    // Refit as well as rebuild: content changes move the document
    // height the scale and pan clamp were computed from (review
    // 2026-08-27, finding 6 — the overlay now captures pointer events,
    // so canvas edits mid-overview are rare, but dispatches from other
    // code are not).
    T.ov.extentDirty = true;
    applyOverviewScale();
    buildOverviewContent();
    scheduleOverviewSettle();
  }

  /**
   * Build the overview overlay and wire the three gestures the MODE owns:
   * the wheel pans, an empty-space press starts a marquee (or, if it never
   * moves, collapses the controls), and focusing a box pans it into view —
   * the keyboard's only route to off-screen content. The overlay captures
   * every pointer event over the canvas, which is what stops a click from
   * falling through and editing the zoomed-out document underneath.
   *
   * @param {HTMLElement} body The editor skeleton's body.
   * @return {HTMLElement} The overlay.
   */
  function createOverviewOverlay(body) {
    var overlay = document.createElement('div');
    overlay.id = 'toolrail-overview';
    overlay.setAttribute('role', 'region');
    overlay.setAttribute('aria-label', __('Section overview', 'editrail'));

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
      setOverviewPan(T.ov.pan + delta);
    }, { passive: false });

    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay || (e.target.classList && e.target.classList.contains('toolrail-ov-list'))) {
        // Empty space: a LEFT press may become a marquee (issue #21) —
        // the clear/collapse this always did now runs on the RELEASE
        // of a press that never crossed the threshold, so a plain
        // click behaves exactly as before.
        if (e.button === 0 && !T.ov.drag && !T.ov.marquee) {
          startOverviewMarquee(e);
        } else if (!T.ov.marquee) {
          clearOverviewMultiSelection();
          deselectOverviewBox(false);
        }
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
        setOverviewPan(T.ov.pan - (topEdge - bRect.top));
      } else if (bRect.bottom > oRect.bottom - 8) {
        setOverviewPan(T.ov.pan + Math.min(bRect.bottom - (oRect.bottom - 8), bRect.top - topEdge));
      }
    });

    body.appendChild(overlay);
    placeOverviewOverlay();
    return overlay;
  }

  /**
   * Leave the mode when the viewport drops below the admin small-screen
   * breakpoint. Both the rail and the overlay are display:none there, so
   * staying open would strand the author in a scaled canvas with no
   * surface left to close it from.
   *
   * @param {MediaQueryListEvent} e The breakpoint change.
   * @return {void}
   */
  function onOverviewMediaChange(e) {
    // Below the admin small-screen breakpoint the rail AND the overlay
    // are display:none — without this, the author would be stranded in
    // a scaled canvas with no Escape surface left (review 2026-08-27,
    // finding 2). Close cleanly instead.
    if (e.matches) {
      closeOverview(false);
    }
  }

  /**
   * Open or close the Section overview — what the rail's toggle calls.
   * Closing from the toggle returns focus to it.
   */
  function toggleOverview() {
    if (T.overviewOpen) {
      closeOverview(true);
    } else {
      openOverview();
    }
  }

  /**
   * Enter the Section overview: reset the mode's state, scale the canvas
   * down, and build the overlay over it. Refuses below the small-screen
   * breakpoint, where the overlay cannot render and there would be no way
   * back out. Disarms any armed tool first — a canvas insertion must never
   * stay live under the overlay.
   */
  function openOverview() {
    if (T.overviewOpen) {
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
    if (T.activeTool !== 'select') {
      setActiveTool('select');
    }

    T.overviewOpen = true;
    // Every per-open value starts from its start value: top level, no
    // selection, no pan, the fitted zoom, a dirty extent.
    T.ov = newOverviewState();
    // A close still winding down — its re-apply/corrective scrolls, the
    // fading overlay, the body's closing stamp — must not leak into a
    // fresh open: cancel the scroll writes (they would fight the
    // scroll-home below), remove a fading overlay NOW (overviewNode()
    // finds the first #toolrail-overview, and two of them would strand
    // the new build's boxes on the dying one), and lift the stamp.
    if (overviewCloseScrollFrame) {
      window.cancelAnimationFrame(overviewCloseScrollFrame);
      overviewCloseScrollFrame = null;
    }
    if (overviewCloseScrollTimer) {
      window.clearTimeout(overviewCloseScrollTimer);
      overviewCloseScrollTimer = null;
    }
    if (overviewFadeTimer) {
      window.clearTimeout(overviewFadeTimer);
      overviewFadeTimer = null;
    }
    if (overviewClosingFrame) {
      window.cancelAnimationFrame(overviewClosingFrame);
      overviewClosingFrame = null;
    }
    var lingering = document.getElementById('toolrail-overview');
    if (lingering) {
      lingering.remove();
    }
    document.body.classList.remove('toolrail-ov-closing');
    // The canvas scrolls INSIDE its iframe on iframed editors (measured:
    // the parent content region never overflows) — that scroll position
    // is what "exiting restores where you were" means. Growing the
    // iframe clamps it to 0 for the overview's lifetime.
    var frame = canvasFrame();
    if (frame && frame.contentWindow) {
      try {
        T.ov.entryScroll = frame.contentWindow.scrollY || 0;
      } catch (e) {
        T.ov.entryScroll = 0;
      }
    } else {
      T.ov.entryScroll = content.scrollTop;
    }
    T.ov.hadFrame = !!frame;
    // A selected block keeps its floating toolbar alive over the zoomed
    // canvas — clear the selection for the overview's lifetime (the
    // reorder chrome is the only chrome this mode shows) and put it
    // back on close. Selection is editor state, not content: neither
    // direction dirties the post.
    var editorSel = wp.data.select('core/block-editor');
    T.ov.priorSelection = editorSel && typeof editorSel.getSelectedBlockClientId === 'function'
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
    T.ov.signature = overviewCurrentSignature();
    buildOverviewContent(OVERVIEW_FOCUS_CANDIDATES);
    scheduleOverviewSettle();

    document.addEventListener('keydown', onOverviewKeydown, true);
    document.addEventListener('scroll', onOverviewViewportChange, true);
    window.addEventListener('resize', onOverviewViewportChange);
    // The window resize listener cannot see editor chrome appearing
    // INSIDE the content region (the autosave notice arrives via React
    // with no window event) — observe the visual editor's own box for
    // that. The refit this schedules re-applies the same custom
    // properties when nothing changed, so the observer settles after
    // one debounced pass rather than looping on its own writes.
    if (typeof window.ResizeObserver === 'function') {
      var visual = visualEditorNode();
      if (visual) {
        T.ov.resizeObserver = new window.ResizeObserver(onOverviewViewportChange);
        T.ov.resizeObserver.observe(visual);
        T.ov.resizeTarget = visual;
      }
    }
    observeOverviewCanvas();
    if (window.matchMedia) {
      T.ov.media = window.matchMedia('(max-width: 782px)');
      if (typeof T.ov.media.addEventListener === 'function') {
        T.ov.media.addEventListener('change', onOverviewMediaChange);
      }
    }
    if (wp.data && typeof wp.data.subscribe === 'function') {
      T.ov.unsubscribe = wp.data.subscribe(onOverviewStoreChange, 'core/block-editor');
    }
    T.syncPressed(true);
    announceModeChange();

    var count = overviewOrder().length;
    // ONE line covers the dimmed tools (R9) — announcing each would be a
    // dozen announcements on open. Folded into the same speak() call:
    // wp.a11y.speak replaces the live region's text, so a second call
    // this close behind would clobber the first.
    speak(sprintf(
      /* translators: %d: number of top-level sections. */
      _n(
        'Section overview — %d section. Choose a section to show its reorder controls; Escape closes the overview. Insert tools are unavailable until you close the overview.',
        'Section overview — %d sections. Choose a section to show its reorder controls; Escape closes the overview. Insert tools are unavailable until you close the overview.',
        count,
        'editrail'
      ),
      count
    ));
  }

  /**
   * Center a block in the restored canvas viewport — the close's
   * landing (R11, issue #20). Runs AFTER clearOverviewScale(), the only
   * time the rects are true again, and INSIDE the close's
   * toolrail-ov-closing window, so the un-grown layout is already final
   * when the goal is measured. Pre-positioning, not animation (owner
   * feedback 2026-08-31, replacing the first cut's ~260ms glide): the
   * author never watches a scroll — the block is in place on the first
   * painted frame, for everyone, so prefers-reduced-motion needs no
   * branch here (it gates only the overlay fade in closeOverview).
   * Every write re-derives the goal from a fresh rect — the 0.1.15
   * lesson. Scroll only — never DOM focus, and nothing here writes
   * content.
   *
   * @return {boolean} true if a scroll target existed (the caller skips
   *                   the entry-scroll restore); false to fall back.
   */
  function centerBlockAfterClose(clientId) {
    var doc = canvasDoc();
    if (!doc) {
      return false;
    }
    var el = doc.querySelector('[data-block="' + String(clientId).replace(/"/g, '') + '"]');
    if (!el) {
      return false;
    }
    var frame = canvasFrame();
    var readPos, writePos, goal;
    if (frame && frame.contentWindow && doc !== document) {
      var win = frame.contentWindow;
      readPos = function () {
        try {
          return win.scrollY || 0;
        } catch (e) {
          return null;
        }
      };
      writePos = function (y) {
        try {
          win.scrollTo(0, y);
        } catch (e) {
          /* Cross-origin surprise — stop writing. */
        }
      };
      goal = function () {
        var r = el.getBoundingClientRect();
        var vh = win.innerHeight || doc.documentElement.clientHeight;
        var max = Math.max(0, doc.documentElement.scrollHeight - vh);
        // A block taller than the viewport centers to its TOP —
        // (vh - height)/2 would push its start off-screen upward.
        return Math.min(max, Math.max(0, (win.scrollY || 0) + r.top - Math.max(0, (vh - r.height) / 2)));
      };
    } else {
      var scroller = contentRegion();
      if (!scroller) {
        return false;
      }
      readPos = function () {
        return scroller.scrollTop;
      };
      writePos = function (y) {
        scroller.scrollTop = y;
      };
      goal = function () {
        var r = el.getBoundingClientRect();
        var s = scroller.getBoundingClientRect();
        var max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        return Math.min(max, Math.max(0, scroller.scrollTop + (r.top - s.top) - Math.max(0, (scroller.clientHeight - r.height) / 2)));
      };
    }
    var start = readPos();
    if (start === null) {
      return false;
    }
    var lastWritten = start;
    var writeGoal = function () {
      lastWritten = goal();
      writePos(lastWritten);
    };
    // Synchronous: with the shrink instant (the toolrail-ov-closing
    // stamp), the scroll range exists right now and this write is what
    // the first post-close frame paints. The rAF re-apply and the ONE
    // corrective write behind it are belt for chrome that lands with
    // the render (an arriving notice resizes the viewport the goal was
    // measured against); the correction is skipped when the author has
    // scrolled away in the meantime — their hand on the wheel outranks
    // it.
    writeGoal();
    if (typeof window.requestAnimationFrame === 'function') {
      overviewCloseScrollFrame = window.requestAnimationFrame(function () {
        overviewCloseScrollFrame = null;
        writeGoal();
      });
    }
    overviewCloseScrollTimer = window.setTimeout(function () {
      overviewCloseScrollTimer = null;
      var now = readPos();
      if (now !== null && Math.abs(now - lastWritten) < 2) {
        writeGoal();
      }
    }, 250);
    return true;
  }

  /**
   * Leave the Section overview: unscale the canvas, tear the overlay down,
   * and scroll the editor to the block the author last picked, moved or
   * drilled into — captured BEFORE the mode state resets. Nothing touched
   * means the entry scroll and the prior selection are restored instead.
   *
   * @param {boolean} refocus Return focus to the overview toggle.
   * @return {void}
   */
  function closeOverview(refocus) {
    if (!T.overviewOpen) {
      return;
    }
    T.overviewOpen = false;
    // Where to land (R11, issue #20): the block the author last picked,
    // moved or drilled into; a block deleted mid-session falls through
    // to the drilled root; nothing touched means '' — today's entry
    // scroll + prior selection. Captured BEFORE the state resets below.
    var closeSel = wp.data.select('core/block-editor');
    var landing = '';
    [T.ov.lastTouched, T.ov.root].some(function (id) {
      if (id && closeSel && closeSel.getBlock(id)) {
        landing = id;
        return true;
      }
      return false;
    });
    finishOverviewDrag();
    cancelOverviewMarquee(false);
    clearOverviewCancelLatch();
    // Order matters here (owner feedback 2026-08-31 — no visible
    // scroll-to on close):
    //  1. Stamp toolrail-ov-closing FIRST: it keeps core's 0.4s iframe
    //     transition suppressed through the un-grow, so the shrink is
    //     instant and the scroll range exists in this same task (a
    //     still-grown iframe clamps every scrollTo to 0).
    //  2. Hand the canvas back and pre-scroll it (below).
    //  3. Let the overlay FADE rather than vanish: what it reveals is
    //     already the finished document, so nothing moves under it.
    //     Reduced motion removes it at once instead; either way it is
    //     hidden from AT and the pointer immediately.
    // The stamp lifts two frames later — the styles it suppressed have
    // painted by then, and lifting it re-triggers nothing.
    document.body.classList.add('toolrail-ov-closing');
    var overlay = overviewNode();
    if (overlay) {
      var reduceClose = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      if (reduceClose) {
        overlay.remove();
      } else {
        overlay.classList.add('toolrail-ov-fadeout');
        overlay.setAttribute('aria-hidden', 'true');
        overviewFadeTimer = window.setTimeout(function () {
          overviewFadeTimer = null;
          overlay.remove();
        }, 200);
      }
    }
    document.body.classList.remove('toolrail-overview-on');
    clearOverviewScale();
    // Land on the touched block, centered; otherwise restore the
    // pre-entry scroll position — the iframe's own window on iframed
    // editors (its viewport just shrank back, so the scroll range
    // exists again), the content region otherwise. The centering can
    // come up empty (no DOM element for the block yet) — then the
    // entry restore runs as if nothing was touched.
    var landed = landing ? centerBlockAfterClose(landing) : false;
    if (!landed && T.ov.entryScroll !== null) {
      var frame = canvasFrame();
      if (frame && frame.contentWindow) {
        try {
          frame.contentWindow.scrollTo(0, T.ov.entryScroll);
        } catch (e) {
          /* Cross-origin surprise — nothing to restore. */
        }
      } else {
        var content = contentRegion();
        if (content) {
          content.scrollTop = T.ov.entryScroll;
        }
      }
    }
    // Lift the closing stamp two frames on: the transition-suppressed
    // styles have painted by then, and core's own iframe transition is
    // the editor's to keep — the stamp must never outlive the close.
    if (typeof window.requestAnimationFrame === 'function') {
      overviewClosingFrame = window.requestAnimationFrame(function () {
        overviewClosingFrame = window.requestAnimationFrame(function () {
          overviewClosingFrame = null;
          document.body.classList.remove('toolrail-ov-closing');
        });
      });
    } else {
      window.setTimeout(function () {
        document.body.classList.remove('toolrail-ov-closing');
      }, 100);
    }
    // Release what this overview holds, in this order, THEN replace its
    // state with a fresh copy — the replacement is the reset. The prior
    // selection is copied out first, for the reselect below.
    document.removeEventListener('keydown', onOverviewKeydown, true);
    document.removeEventListener('scroll', onOverviewViewportChange, true);
    window.removeEventListener('resize', onOverviewViewportChange);
    if (T.ov.resizeObserver) {
      T.ov.resizeObserver.disconnect();
    }
    if (T.ov.canvasObserver) {
      T.ov.canvasObserver.disconnect();
    }
    if (T.ov.canvasSizeObserver) {
      T.ov.canvasSizeObserver.disconnect();
    }
    if (T.ov.canvasRefitTimer) {
      window.clearTimeout(T.ov.canvasRefitTimer);
    }
    if (T.ov.media) {
      if (typeof T.ov.media.removeEventListener === 'function') {
        T.ov.media.removeEventListener('change', onOverviewMediaChange);
      }
    }
    if (T.ov.unsubscribe) {
      T.ov.unsubscribe();
    }
    if (T.ov.repositionTimer) {
      window.clearTimeout(T.ov.repositionTimer);
    }
    if (T.ov.panFrame) {
      window.cancelAnimationFrame(T.ov.panFrame);
    }
    var priorSelection = T.ov.priorSelection;
    T.ov = newOverviewState();
    // Select the landing block — or, when nothing was touched, restore
    // the selection the overview cleared on open, if the block is still
    // there. A dispatched selectBlock takes no DOM focus itself, but
    // EITHER dispatch re-renders editor chrome a frame later (the
    // selected block's toolbar mounts), which is why the refocus below
    // re-asserts for both (review 2026-08-31, finding 1 — the first
    // guard covered only the landing path and left the
    // restored-selection close with the same steal).
    var reselected = '';
    if (landing) {
      wp.data.dispatch('core/block-editor').selectBlock(landing);
      reselected = landing;
    } else if (priorSelection) {
      var editorSel = wp.data.select('core/block-editor');
      if (editorSel && editorSel.getBlock(priorSelection)) {
        wp.data.dispatch('core/block-editor').selectBlock(priorSelection);
        reselected = priorSelection;
      }
    }
    T.syncPressed(true);
    announceModeChange();
    if (refocus) {
      var btn = overviewButton();
      if (btn) {
        btn.focus();
      }
      // Any selectBlock above re-renders editor chrome (the selected
      // block's toolbar mounts), and that render can land focus off
      // the rail AFTER this frame — measured: the keyboard-only e2e's
      // Escape-close left activeElement off the tool. Focus on the
      // overview button is issue #20's "must keep", so re-assert it
      // once the render settles — fresh queries both times (a heal may
      // have rebuilt the rail). The guard skips only when focus
      // already sits inside the rail; a focus the author moved OUTSIDE
      // the rail during this ~2-frame window WOULD be pulled back —
      // accepted, because the window is ~32ms behind a close gesture
      // aimed at the rail itself (review 2026-08-31, finding 4: the
      // guard protects the rail's own focus, nothing more).
      if (reselected && typeof window.requestAnimationFrame === 'function') {
        var reassertFocus = function () {
          var rail = document.getElementById(mainToolbar.railId);
          var fresh = overviewButton();
          if (fresh && (!rail || !rail.contains(document.activeElement))) {
            fresh.focus();
          }
        };
        window.requestAnimationFrame(function () {
          reassertFocus();
          window.requestAnimationFrame(reassertFocus);
        });
      }
    }
    // The close announcement names the landing block (issue #20's "must
    // keep") — one speak() call, because a second this close behind
    // would clobber the first.
    if (landing) {
      speak(sprintf(
        /* translators: %s: block title. */
        __('Section overview closed. %s is selected.', 'editrail'),
        overviewBlockLabel(landing)
      ));
    } else {
      speak(__('Section overview closed.', 'editrail'));
    }
  }

  /** Re-create the overlay if a React re-render swept it away while the
      overview was open — the rail's own self-heal, for the overlay. Runs
      from the mount observer. */
  function healOverview() {
    if (!T.overviewOpen) {
      return;
    }
    var content = contentRegion();
    var body = skeletonBody();
    if (!content || !body || (T.ov.hadFrame && !canvasFrame())) {
      closeOverview(false);
      return;
    }
    // Re-assert the scale even when the overlay survived: a React
    // re-render can replace the iframe's wrapper, taking the
    // scale-host class with it.
    applyOverviewScale();
    // Same reasoning for the resize observer: it holds the NODE it was
    // given at open time, and a replaced visual editor leaves it
    // watching a detached box that never resizes again (review
    // 2026-08-28, finding 5).
    if (T.ov.resizeObserver) {
      var visual = visualEditorNode();
      if (visual && visual !== T.ov.resizeTarget) {
        T.ov.resizeObserver.disconnect();
        T.ov.resizeObserver.observe(visual);
        T.ov.resizeTarget = visual;
      }
    }
    // A replaced canvas iframe has a new body; watch that one instead. A
    // canvas that had no body yet at open time gets its observers now.
    // applyOverviewScale above used the OLD canvas's extent, and an
    // already-rendered new body may never change again, so refit against
    // it now (PR #69 review).
    if (observeOverviewCanvas()) {
      onOverviewCanvasChange();
    }
    if (!overviewNode()) {
      createOverviewOverlay(body);
      buildOverviewContent();
      scheduleOverviewSettle();
    }
  }

  // Shared with the other files of the rail (see editor-rail-core.js).
  T.contentRegion = contentRegion;
  T.canvasFrame = canvasFrame;
  T.toggleOverview = toggleOverview;
  T.healOverview = healOverview;

  // This file ran to its end. The next file checks this number.
  T.loaded = 5;
})(window.wp);
