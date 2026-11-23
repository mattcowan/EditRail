/**
 * EditRail, part 3 of 7 (editor-rail-tools.js).
 *
 * Armed tools: the armed-tool state, availability (R9), insertion
 * into the canvas, canvas selection (#14) and the flyouts.
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
  if (!T || T.loaded !== 2) {
    return;
  }

  // From editor-rail-core.js.
  var __ = T.__;
  var _n = T._n;
  var sprintf = T.sprintf;
  var speak = T.speak;
  var HIDE_CORE_INSERTER_KEY = T.HIDE_CORE_INSERTER_KEY;
  var readKey = T.readKey;
  var isVertical = T.isVertical;

  // From editor-rail-registry.js.
  var warn = T.warn;
  var findTool = T.findTool;

  // -------------------------------------------------------------------
  // Armed-tool state + canvas insertion
  // -------------------------------------------------------------------

  // The armed tool. One for the page, not one for each toolbar (see
  // newToolbar): an armed tool is a mode of the CANVAS — the next canvas
  // click inserts its block — and the canvas has one mode at a time.
  T.activeTool = 'select';

  /**
   * Whether selecting this tool ARMS the rail — the next canvas click
   * inserts its block. The arm-then-click behavior is the rail's whole
   * point, so this test gates the cursor, the announcement and the
   * canvas handlers.
   *
   * @param {Object} tool A railModel() entry or a flyout child.
   * @return {boolean}
   */
  function isArmingTool(tool) {
    return !!(tool && (tool.insertBlock || tool.createBlock));
  }

  /** A toggle: an onActivate tool that reports its own open/closed
      state (Section overview, a provider's side panel). Pressed on a
      toggle means "this tool's surface is open", not "armed" (R10). */
  function isToggleTool(tool) {
    return !!(tool && tool.onActivate && tool.isActive);
  }

  // -------------------------------------------------------------------
  // Availability (R9). A tool declares what it NEEDS via
  // `supports.canvas`; the rail knows which of its modes capture the
  // canvas. Availability is the product of the two, so a provider never
  // has to know the rail's mode names (R5 will add more) and a new mode
  // never needs a hand-kept list of tools to disable.
  // -------------------------------------------------------------------

  /**
   * Does activating this tool need a click in the canvas to complete?
   * Declared `supports.canvas` wins; otherwise arming tools do and
   * everything else (Select, toggles, onActivate actions) does not.
   *
   * @param {Object} tool A railModel() entry or a flyout child.
   * @return {boolean}
   */
  function needsCanvas(tool) {
    if (tool && tool.supports && typeof tool.supports.canvas === 'boolean') {
      return tool.supports.canvas;
    }
    return isArmingTool(tool);
  }

  /**
   * The rail's current mode. 'edit' is the ordinary editor; 'overview'
   * is the Section overview, whose overlay captures every canvas
   * pointer event for its lifetime. Future modes (R5) join here and in
   * modeCapturesCanvas().
   *
   * @return {string} 'edit' | 'overview'
   */
  function railMode() {
    return T.overviewOpen ? 'overview' : 'edit';
  }

  /**
   * Whether a mode takes the canvas for itself, which is what makes every
   * canvas tool unavailable while it runs. Kept separate from railMode()
   * so a future mode declares this fact once.
   *
   * @param {string} mode A railMode() value.
   * @return {boolean}
   */
  function modeCapturesCanvas(mode) {
    return mode === 'overview';
  }

  /**
   * Can this tool be activated right now? Only its OWN action is judged
   * here — a container's children are judged one by one by the caller,
   * because a flyout with one live child must still open.
   *
   * @param {Object} tool
   * @return {boolean}
   */
  function toolAvailable(tool) {
    if (!tool) {
      return false;
    }
    return !(modeCapturesCanvas(railMode()) && needsCanvas(tool));
  }

  /** The tooltip suffix that tells a pointer user WHY a tool is dimmed. */
  function unavailableReason() {
    return railMode() === 'overview'
      ? __('not available in Section overview', 'editrail')
      : __('not available now', 'editrail');
  }

  /**
   * A top-level button's availability: its own action OR any child's.
   * A parent whose children are ALL unavailable dims as a unit; a mixed
   * flyout stays live and dims its children individually.
   */
  function buttonAvailable(tool) {
    if (toolAvailable(tool)) {
      return true;
    }
    return !!(tool.children && tool.children.some(toolAvailable));
  }

  /**
   * Tell extensions the mode changed, so a provider can re-read
   * availability without knowing how the rail decides it.
   */
  function announceModeChange() {
    window.dispatchEvent(new CustomEvent('toolrail:mode-changed', {
      detail: { mode: railMode() }
    }));
  }

  /**
   * Make one tool current: record it, move the pressed state onto its
   * button, and put the canvas into (or out of) the armed cursor state.
   *
   * @param {string} id Tool id.
   * @return {void}
   */
  function setActiveTool(id) {
    T.activeTool = id;
    T.syncPressed(true);
    markCanvasArmed();
  }

  /**
   * The block(s) a tool inserts, always as an array: a createBlock tool
   * may return one block or — a pattern — several. Empty when the tool
   * cannot build anything right now.
   *
   * @param {Object} tool A railModel() entry or a flyout child.
   * @return {Object[]}
   */
  function makeBlocksFor(tool) {
    var made = null;
    try {
      if (tool.createBlock) {
        made = tool.createBlock();
      } else if (tool.insertBlock && wp.blocks.getBlockType(tool.insertBlock)) {
        made = wp.blocks.createBlock(tool.insertBlock);
      }
    } catch (e) {
      warn('tool "' + tool.id + '" failed to create its block: ' + e.message);
      made = null;
    }
    return [].concat(made || []).filter(function (b) {
      return b && typeof b.name === 'string';
    });
  }

  /**
   * Where an armed click lands, as {rootClientId, index}. (Flow-document
   * position — x/y freeform layout is a later phase.)
   *
   * ON a block: above its vertical midpoint inserts before it, below
   * inserts after — inside that block's own parent, so a click on a
   * block nested in a Group stays in the Group.
   *
   * In the GAP between blocks the click reaches the block list itself
   * (the root container, or a Group's inner list), not a block, and the
   * old resolution fell through to "append at the end of the document":
   * a click plainly between paragraphs two and three put the block at
   * the bottom. It rarely showed because core's between-block "+"
   * popover, in the EDITOR document, caught most such clicks first —
   * once that is hidden while armed (markCanvasArmed) the fall-through
   * is the whole experience, so the gap now resolves against the list's
   * own children in READING order: a child is before the pointer when
   * the pointer is below it, or level with it and past its horizontal
   * midpoint in the list's writing direction. A stacked list reduces to
   * the y rule; a Row, Grid or Columns gets the x rule for the row the
   * pointer is on (a y-only count put the block at an arbitrary index
   * in a Row, where every child shares one midpoint — review
   * 2026-09-02, finding 3). Above-the-first (0) and below-the-last
   * (append) fall out of the same count.
   *
   * Empty canvas below everything, or a click that reaches no list at
   * all, still appends at the end of the document — except a click ABOVE
   * the root list (the post title), which is the top. A click on an
   * EMPTY container that accepts the block goes inside it.
   *
   * @param {MouseEvent} e          The canvas click.
   * @param {Object}     sel        The core/block-editor selectors.
   * @param {string[]}   blockNames The top-level block names the tool
   *                                inserts; decides whether an empty
   *                                container under the pointer takes them.
   * @return {{rootClientId: string, index: number}}
   */
  function resolveInsertionPoint(e, sel, blockNames) {
    var target = e.target && e.target.closest ? e.target : null;
    var blockEl = target ? target.closest('[data-block]') : null;
    var listEl = target ? target.closest('.block-editor-block-list__layout') : null;

    // A block list nested INSIDE the nearest block means the pointer is
    // in that block's inner gap, not on the block. No block at all means
    // the root list's gap (or the empty space under it).
    if (listEl && (!blockEl || blockEl.contains(listEl))) {
      var rtl = false;
      try {
        rtl = listEl.ownerDocument.defaultView.getComputedStyle(listEl).direction === 'rtl';
      } catch (err) {
        rtl = false;
      }
      var before = 0;
      Array.prototype.forEach.call(listEl.children, function (el) {
        if (!el.hasAttribute || !el.hasAttribute('data-block')) {
          return;
        }
        var r = el.getBoundingClientRect();
        if (e.clientY > r.bottom) {
          before += 1;
          return;
        }
        if (e.clientY >= r.top) {
          var midX = r.left + r.width / 2;
          if (rtl ? e.clientX < midX : e.clientX > midX) {
            before += 1;
          }
        }
      });
      return {
        rootClientId: blockEl ? blockEl.getAttribute('data-block') : '',
        index: before
      };
    }

    if (blockEl) {
      var clientId = blockEl.getAttribute('data-block');
      // An EMPTY container (a Group showing its layout placeholder) has
      // no inner list to hit, so the before/after rule below could only
      // put the block BESIDE it. When the container accepts the block,
      // a click inside it means "inside" (QA 2026-09-11, C6; owner
      // decision the same day). canInsertBlockType is the discriminator:
      // it is false for a paragraph, an image or an empty Cover, true
      // for an empty Group (measured on WP 7.1).
      if (blockNames && blockNames.length
        && typeof sel.canInsertBlockType === 'function'
        && sel.getBlockCount(clientId) === 0
        && blockNames.every(function (name) { return sel.canInsertBlockType(name, clientId); })) {
        return { rootClientId: clientId, index: 0 };
      }
      var index = sel.getBlockIndex(clientId);
      var rect = blockEl.getBoundingClientRect();
      if (e.clientY > rect.top + rect.height / 2) {
        index += 1;
      }
      return { rootClientId: sel.getBlockRootClientId(clientId) || '', index: index };
    }

    // Nothing under the pointer: the empty space BELOW the content, or
    // ABOVE it — the post title. Above the root list is the top of the
    // document (QA 2026-09-11, C5; owner decision the same day): a click
    // on the title used to land the block at the bottom and scroll there.
    var rootList = target ? target.ownerDocument.querySelector('.is-root-container') : null;
    if (rootList && e.clientY < rootList.getBoundingClientRect().top) {
      return { rootClientId: '', index: 0 };
    }
    return { rootClientId: '', index: sel.getBlockCount('') };
  }

  /**
   * Walk an insertion point up until a parent accepts the block, or
   * return null when the root refuses it too.
   *
   * insertBlocks() silently drops a block its target parent refuses
   * (Columns takes only Column, Buttons only Button — verified in
   * core's action, which filters through canInsertBlockType and
   * dispatches nothing when the list comes back empty), and the click
   * had already disarmed the tool: "the tool did nothing", with no
   * reason. The click meant "near here", so a point inside a refusing
   * container becomes the slot right after that container in ITS
   * parent — before it when the click was above the container's first
   * child — and so on up. Review 2026-09-02, finding 2: the on-block
   * path had the same hole, so both paths come through here.
   *
   * @param {Object}   sel        The core/block-editor selectors.
   * @param {string[]} blockNames Every top-level block the tool inserts
   *                              (a pattern may have several); a parent
   *                              must accept all of them.
   * @param {Object}   point      {rootClientId, index} from resolveInsertionPoint.
   * @return {Object|null}
   */
  function climbToAllowedParent(sel, blockNames, point) {
    if (typeof sel.canInsertBlockType !== 'function') {
      return point;
    }
    var rootClientId = point.rootClientId;
    var index = point.index;
    var allowedIn = function (root) {
      return blockNames.every(function (name) {
        return sel.canInsertBlockType(name, root);
      });
    };
    while (!allowedIn(rootClientId)) {
      if (!rootClientId) {
        return null;
      }
      var containerIndex = sel.getBlockIndex(rootClientId);
      index = index === 0 ? containerIndex : containerIndex + 1;
      rootClientId = sel.getBlockRootClientId(rootClientId) || '';
    }
    return { rootClientId: rootClientId, index: index };
  }

  /**
   * Tell the author an armed click could not insert: a snackbar when
   * core's notices store is reachable (it announces itself), else the
   * live region alone.
   *
   * @param {string} label The block or pattern title that had no legal home.
   * @return {void}
   */
  function notifyCannotInsert(label) {
    var message = sprintf(
      /* translators: %s: block or pattern title. */
      __('%s cannot be inserted here.', 'editrail'),
      label
    );
    try {
      var notices = wp.data.dispatch('core/notices');
      if (notices && typeof notices.createInfoNotice === 'function') {
        notices.createInfoNotice(message, { type: 'snackbar', id: 'toolrail-cannot-insert' });
        return;
      }
    } catch (err) {
      /* No notices store — the live region below still speaks. */
    }
    speak(message);
  }

  /** What to call the thing a tool inserts, in a message. */
  function toolInsertLabel(tool, blocks) {
    if (tool.pinnedPattern) {
      return tool.shortLabel || tool.label;
    }
    var type = blocks[0] ? wp.blocks.getBlockType(blocks[0].name) : null;
    if (type && type.title) {
      return type.title;
    }
    return blocks[0] ? blocks[0].name : tool.label;
  }

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

  /**
   * Snapshot the canvas before the browser reacts to the gesture, so the
   * stray-block sweep can tell what core appends during this click from
   * what the author already had. The generation bump comes first and
   * unconditionally: a Select gesture still has to invalidate a sweep left
   * pending by the previous armed click, because core's append IS the
   * author's intent under Select.
   */
  function handleCanvasPointerdown() {
    // Bump FIRST and unconditionally: a gesture with Select active still
    // has to invalidate a pending sweep from the previous armed click,
    // because core's append is the author's intent under Select.
    gestureGeneration++;

    if (T.activeTool === 'select') {
      preGestureIds = null;
      return;
    }
    var ids = Object.create(null);
    wp.data.select('core/block-editor').getBlocks().forEach(function (b) {
      ids[b.clientId] = true;
    });
    preGestureIds = ids;
  }

  /**
   * The armed click: build the tool's blocks, find an insertion point that
   * will accept them, insert, then reclaim the empty paragraph core
   * appended on the way past. Shift keeps the tool armed; anything else
   * returns the rail to Select. When no parent up the tree accepts the
   * block the rail says so and STAYS armed — a silent disarm reads as the
   * tool having done nothing.
   *
   * @param {MouseEvent} e The canvas click.
   * @return {void}
   */
  function handleCanvasClick(e) {
    if (T.activeTool === 'select') {
      return;
    }
    // A non-iframed editor (the Code editor, or a block of an older API
    // version) binds this to the top document, so it also sees clicks on
    // the toolbars, the header and the sidebars. Only the canvas inserts:
    // a click on another tool must reach that tool (PR #126 review).
    var t = e.target;
    if (t && t.ownerDocument === document
      && !(t.closest && t.closest('.editor-styles-wrapper'))) {
      return;
    }
    var tool = findTool(T.activeTool);
    if (!isArmingTool(tool)) {
      setActiveTool('select');
      return;
    }

    var blocks = makeBlocksFor(tool);
    if (!blocks.length) {
      setActiveTool('select');
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    var sel = wp.data.select('core/block-editor');
    var dispatch = wp.data.dispatch('core/block-editor');
    var blockNames = blocks.map(function (b) { return b.name; });
    var point = climbToAllowedParent(sel, blockNames, resolveInsertionPoint(e, sel, blockNames));

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

    if (!point) {
      // No parent on the way up accepts this block. Say so and STAY
      // armed — a silent disarm read as "the tool did nothing". Core's
      // empty-space append is NOT swept here: with nothing of ours to
      // take the selection, removing that paragraph (the only, selected
      // block) hands focus back to core's appender, which inserts
      // another one ~60ms later (measured 2026-09-02) — the sweep would
      // only churn clientIds. So the click leaves what a Select click
      // there leaves.
      notifyCannotInsert(toolInsertLabel(tool, blocks));
      return;
    }

    var insertedIds = Object.create(null);
    blocks.forEach(function (b) { insertedIds[b.clientId] = true; });
    dispatch.insertBlocks(blocks, point.index, point.rootClientId);
    sweepStrayDefaultBlock(knownIds, insertedIds, blocks[0].clientId);

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
   * @param {Object} knownIds    clientIds present before the insert.
   * @param {Object} insertedIds clientIds of the tool's own block(s), as a map.
   * @param {string} primaryId   The block to select once the stray is gone.
   * @return {void}
   */
  function sweepStrayDefaultBlock(knownIds, insertedIds, primaryId) {
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
        return !insertedIds[b.clientId]
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
      if (primaryId && sel.getBlock(primaryId)) {
        wp.data.dispatch('core/block-editor').selectBlock(primaryId);
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

  /**
   * Escape returns the rail to Select from ANYWHERE: the canvas, the rail
   * itself, the block toolbar, the sidebar. Until 1.0.2 only the canvas
   * document had a handler, so the keyboard author who had just armed a
   * tool with Enter — focus on the rail — had no Escape at all, while the
   * help panel promised "at any time" (QA 2026-09-11, C1). Surfaces that
   * own Escape themselves keep it: a flyout, the settings/help/add
   * dialogs and the overview each close one level per press, and their
   * handlers run on the same document keydown.
   *
   * @param {KeyboardEvent} e A keydown from the canvas or the top document.
   * @return {boolean} Whether a tool was disarmed.
   */
  function disarmOnEscape(e) {
    if (e.key !== 'Escape' || T.activeTool === 'select') {
      return false;
    }
    if (T.openFlyout || T.settingsOpen || T.helpOpen || T.addDialogOpen || T.overviewOpen) {
      return false;
    }
    setActiveTool('select');
    speak(__('Tool disarmed. Select is active.', 'editrail'));
    return true;
  }

  /**
   * The selected block a keyboard insert REPLACES, or null. Core's inserter
   * replaces a lone selected block that is an unmodified default block
   * (the empty paragraph Enter leaves behind) instead of inserting after it
   * (block-editor's onInsertBlocks, measured on WP 7.1). The keyboard
   * insert anchors on the selection the same way, so it does the same
   * (review 2026-10-01, owner decision the same day). The armed click does
   * not: it anchors on the pointer, not the selection.
   *
   * Only when the empty block's parent accepts every block — core's
   * replaceBlocks() silently does nothing otherwise — and when the block
   * may be removed, so a template lock is never broken; either way the
   * caller falls back to inserting after it.
   *
   * @param {Object}   sel        The core/block-editor selectors.
   * @param {string[]} blockNames The top-level block names the tool inserts.
   * @return {string|null} The clientId to replace.
   */
  function replaceableSelection(sel, blockNames) {
    var block = typeof sel.getSelectedBlock === 'function' ? sel.getSelectedBlock() : null;
    if (!block || typeof wp.blocks.isUnmodifiedDefaultBlock !== 'function'
      || !wp.blocks.isUnmodifiedDefaultBlock(block, 'content')) {
      return null;
    }
    if (typeof sel.canRemoveBlock === 'function' && !sel.canRemoveBlock(block.clientId)) {
      return null;
    }
    var root = sel.getBlockRootClientId(block.clientId) || '';
    if (typeof sel.canInsertBlockType === 'function'
      && !blockNames.every(function (name) { return sel.canInsertBlockType(name, root); })) {
      return null;
    }
    return block.clientId;
  }

  /**
   * Where a keyboard insert lands, as {rootClientId, index}: right after
   * the selected block (the last one of a multi-selection), inside that
   * block's own parent — the slot core's own inserter uses (an empty
   * default block is replaced instead; replaceableSelection). With nothing
   * selected, the end of the document, the same as core's inserter and an
   * armed click on the empty canvas (owner decision 2026-09-30, #37).
   *
   * @param {Object} sel The core/block-editor selectors.
   * @return {{rootClientId: string, index: number}}
   */
  function keyboardInsertionPoint(sel) {
    var ids = typeof sel.getSelectedBlockClientIds === 'function'
      ? sel.getSelectedBlockClientIds()
      : [];
    var last = ids.length ? ids[ids.length - 1] : sel.getSelectedBlockClientId();
    if (last && sel.getBlock(last)) {
      return {
        rootClientId: sel.getBlockRootClientId(last) || '',
        index: sel.getBlockIndex(last) + 1
      };
    }
    return { rootClientId: '', index: sel.getBlockCount('') };
  }

  /**
   * Whether a keydown came from a place the insert key belongs to: the
   * rail's own region, the canvas, or nowhere (focus fell to the body).
   * Anywhere else — the sidebar, the block toolbar, a modal — keeps its
   * own Ctrl+Enter; core's Notes form submits on it.
   *
   * @param {KeyboardEvent} e The keydown.
   * @return {boolean}
   */
  function insertKeyTargetAllowed(e) {
    var t = e.target;
    if (!t || !t.ownerDocument) {
      return false;
    }
    if (t.ownerDocument !== document) {
      return true;
    }
    if (t === document.body || t === document.documentElement) {
      return true;
    }
    if (t.closest && t.closest('.toolrail-region')) {
      return true;
    }
    // A non-iframed editor keeps the canvas in the top document.
    return !!(t.closest && t.closest('.editor-styles-wrapper'));
  }

  /**
   * The keyboard insert (#37): while a tool is armed, Ctrl+Enter (Cmd+Enter
   * on a Mac) inserts its block after the selected block, from the rail or
   * from the canvas. Before this the only insert was the canvas click, so
   * a tool armed with Enter was a dead end for a keyboard or screen-reader
   * user. An explicit key, not a keyboard-vs-pointer guess on the arming
   * press: screen readers in browse mode send synthetic clicks, and Enter
   * on the armed tool is already "disarm".
   *
   * Otherwise the armed click's contract: Shift keeps the tool armed, and
   * a block no parent accepts is announced while the tool STAYS armed.
   * The insert is announced too; core's insertBlocks() says nothing.
   *
   * @param {KeyboardEvent} e A keydown from the canvas or the top document.
   * @return {boolean} Whether the key was taken.
   */
  function insertOnKey(e) {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.altKey) {
      return false;
    }
    // A non-iframed canvas IS the top document, so this can be bound to one
    // document twice; the first handler to take the key wins.
    if (e.defaultPrevented || e.repeat || e.isComposing || T.activeTool === 'select') {
      return false;
    }
    if (T.openFlyout || T.settingsOpen || T.helpOpen || T.addDialogOpen || T.overviewOpen) {
      return false;
    }
    if (!insertKeyTargetAllowed(e)) {
      return false;
    }
    var tool = findTool(T.activeTool);
    if (!isArmingTool(tool) || !toolAvailable(tool)) {
      return false;
    }

    // Taken from here on: without preventDefault, Ctrl+Enter on a rail
    // button would also click it — and a click on the armed tool disarms.
    e.preventDefault();
    e.stopPropagation();

    var blocks = makeBlocksFor(tool);
    if (!blocks.length) {
      setActiveTool('select');
      speak(__('Tool disarmed. Select is active.', 'editrail'));
      return true;
    }

    var sel = wp.data.select('core/block-editor');
    var blockNames = blocks.map(function (b) { return b.name; });
    var replaceId = replaceableSelection(sel, blockNames);
    var point = replaceId ? null : climbToAllowedParent(sel, blockNames, keyboardInsertionPoint(sel));
    var label = toolInsertLabel(tool, blocks);
    if (!replaceId && !point) {
      notifyCannotInsert(label);
      return true;
    }

    // A new gesture: a sweep still pending from an earlier armed click
    // must not judge this insert — a pinned Paragraph is an unmodified
    // default block, absent from that click's snapshot.
    gestureGeneration++;
    preGestureIds = null;
    var dispatch = wp.data.dispatch('core/block-editor');
    if (replaceId) {
      dispatch.replaceBlocks(replaceId, blocks);
    } else {
      dispatch.insertBlocks(blocks, point.index, point.rootClientId);
    }

    if (e.shiftKey) {
      speak(sprintf(
        /* translators: %s: block or pattern title. */
        __('%s inserted. The tool stays armed.', 'editrail'),
        label
      ));
      return true;
    }
    setActiveTool('select');
    speak(sprintf(
      /* translators: %s: block or pattern title. */
      __('%s inserted. Select is active.', 'editrail'),
      label
    ));
    return true;
  }

  /**
   * The canvas keys: Ctrl+Enter inserts the armed tool's block, and Escape
   * disarms, so the author never has to go back to the rail for either.
   *
   * @param {KeyboardEvent} e The canvas keydown.
   * @return {void}
   */
  function handleCanvasKeydown(e) {
    if (!insertOnKey(e) && disarmOnEscape(e)) {
      // One thing per Escape: the press that disarmed a tool does not
      // also clear the canvas selection (handleCanvasSelectKeydown).
      csel.escapeEvent = e;
    }
  }

  /**
   * A press inside the canvas is an "outside click" for every popover the
   * rail owns. The dialogs' own mousedown listeners sit on the top
   * document, which never sees an event from inside the editor iframe, so
   * a click into a paragraph left Toolbar settings parked open with the
   * gear still saying aria-expanded="true" (QA 2026-09-11, C3).
   *
   * Bound to POINTERDOWN, not mousedown: a real click on the canvas body
   * fires pointerdown and click but no mousedown at all (measured on WP
   * 7.1 — something in the canvas cancels the pointerdown, which by the
   * Pointer Events spec suppresses the compatibility mouse events), so a
   * mousedown listener here never ran.
   *
   * The target IS checked: canvasDoc() falls back to the top document
   * when the editor has no iframe (the Code editor, for one), and then
   * this listener sees every press in wp-admin — including one on a
   * control inside the very surface it would close (review 2026-09-13,
   * finding 1). Anything inside the rail's own region is not "outside".
   *
   * @param {PointerEvent} e The canvas (or, iframe-less, document) pointerdown.
   * @return {void}
   */
  function handleCanvasPointerdownClose(e) {
    if (e && e.target && e.target.closest && e.target.closest('.toolrail-region')) {
      return;
    }
    if (T.openFlyout) {
      closeFlyout(false);
    }
    if (T.settingsOpen) {
      T.closeSettings(false);
    }
    if (T.helpOpen) {
      T.closeHelp(false);
    }
    if (T.addDialogOpen) {
      T.closeAddDialog('');
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
  var documentEscapeBound = false;
  var documentInsertKeyBound = false;

  /**
   * Remove the canvas handlers from a document bindCanvas() bound earlier.
   *
   * @param {Document} doc The previously bound document.
   * @return {void}
   */
  function unbindCanvas(doc) {
    doc.removeEventListener('pointerdown', handleCanvasPointerdown, true);
    doc.removeEventListener('pointerdown', handleCanvasPointerdownClose, true);
    doc.removeEventListener('click', handleCanvasClick, true);
    doc.removeEventListener('keydown', handleCanvasKeydown, true);
    unbindCanvasSelect(doc);
  }

  /**
   * The document the canvas actually lives in: the editor iframe's, or the
   * content region's for a non-iframed editor. Null while the iframe has
   * no document, or when it is cross-origin.
   *
   * @return {Document|null} The canvas document, or null.
   */
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

  /**
   * Put the rail's stylesheet into the canvas document if it is not
   * there: the armed cursor, and the canvas selection's outline and
   * rectangle-drag rules (CANVAS_SELECT_CSS, issue #14). A style in the
   * editor document cannot reach inside the iframe.
   *
   * Checked on EVERY call, not once per document. Until #14 the style was
   * injected only when bindCanvas saw a new document, and the editor can
   * fill the canvas <head> again after that without changing the
   * document's identity: the element was then gone for the rest of the
   * page load, and nothing put it back (measured 2026-11-14 on WordPress
   * 7.1.3: two loads of the same page, one with 47 head children and the
   * style, one with 46 and none, the listeners intact in both). The armed
   * crosshair went missing the same way.
   *
   * @param {Document|null} doc The canvas document.
   * @return {void}
   */
  function ensureCanvasStyle(doc) {
    if (!doc || doc === document || !doc.head || doc.getElementById('toolrail-canvas-style')) {
      return;
    }
    var style = doc.createElement('style');
    style.id = 'toolrail-canvas-style';
    style.textContent = 'html.toolrail-armed, html.toolrail-armed * { cursor: crosshair !important; } '
      + CANVAS_SELECT_CSS;
    doc.head.appendChild(style);
  }

  /**
   * Bind the canvas handlers, and inject the rail's style into the canvas
   * document (ensureCanvasStyle). Re-run from the mount observer and
   * cheap to repeat: apart from the style check, it returns at once
   * unless the document IDENTITY changed, which is the case that matters
   * for the handlers, because the editor replaces the iframe's document
   * after the element is inserted.
   */
  function bindCanvas() {
    var doc = canvasDoc();
    if (!doc) {
      return;
    }
    if (doc === boundDoc) {
      ensureCanvasStyle(doc);
      return;
    }
    // The canvas document changes identity (the iframe is replaced, or
    // the editor goes iframe-less in the Code editor and back). Listeners
    // bound to the OLD document are removed first, or the top document
    // keeps a set of canvas handlers forever after one round trip through
    // the Code editor (review 2026-09-13, finding 1).
    if (boundDoc) {
      unbindCanvas(boundDoc);
    }
    boundDoc = doc;
    doc.addEventListener('pointerdown', handleCanvasPointerdown, true);
    doc.addEventListener('pointerdown', handleCanvasPointerdownClose, true);
    doc.addEventListener('click', handleCanvasClick, true);
    doc.addEventListener('keydown', handleCanvasKeydown, true);
    // Canvas selection (#14) binds after the handlers above, so its
    // Escape runs after the disarm.
    bindCanvasSelect(doc);
    // The top document gets the same Escape once, in the CAPTURE phase
    // so it runs before the surface handlers (settings, help, add dialog,
    // flyout) that open later and clear their own flag on the same press:
    // in the bubble phase it saw every flag already false and disarmed on
    // the Escape that closed the help panel (review 2026-09-13, finding
    // 4). Keydowns inside the iframe never bubble out, so the canvas
    // handler and this one never double-handle.
    if (!documentEscapeBound && doc !== document) {
      documentEscapeBound = true;
      document.addEventListener('keydown', disarmOnEscape, true);
    }
    // The insert key (#37) reaches the rail through the top document. It is
    // bound even when the canvas IS the top document; insertOnKey skips a
    // key another binding already took, so the two never double-insert.
    if (!documentInsertKeyBound) {
      documentInsertKeyBound = true;
      document.addEventListener('keydown', insertOnKey, true);
    }

    // Armed-cursor style lives INSIDE the canvas document.
    ensureCanvasStyle(doc);
    markCanvasArmed();
  }

  /** Whether core's between-block "+" stays hidden while a tool is armed
      (Toolbar settings; on unless the author turned it off). */
  function hidesCoreInserterWhileArmed() {
    return readKey(HIDE_CORE_INSERTER_KEY) !== '0';
  }

  /**
   * Reflect the armed state where CSS can see it: the crosshair cursor on
   * the canvas document, and — unless the author turned it off — a body
   * class that hides core's between-block "+". That "+" is a popover in
   * the EDITOR document sitting on top of the iframe, so without this an
   * armed click in the gap between two blocks lands on core's inserter and
   * the tool never fires.
   */
  function markCanvasArmed() {
    var armed = T.activeTool !== 'select';
    var doc = boundDoc || canvasDoc();
    if (doc && doc.documentElement) {
      if (armed) {
        // The class is worth nothing without the rule it switches on.
        ensureCanvasStyle(doc);
      }
      doc.documentElement.classList.toggle('toolrail-armed', armed);
    }
    // Core's between-block inserter is a popover in the EDITOR document,
    // not in the canvas: hovering the gap between two blocks (or the
    // foot of a Cover) raises a "+" that sits on top of the iframe, so
    // an armed click there lands on core's inserter instead of the
    // rail's canvas handler — the tool never fires and core's block
    // picker opens (observed on a fresh install, 2026-09-02). While a
    // tool is armed the click IS the insertion, so the "+" has nothing
    // to offer; this body class hides it (editor-rail.css) — the "+"
    // itself, and the empty-block side "+", NOT the popover shell, which
    // also carries the drop line a drag shows — and the click falls
    // through to the canvas. On by default, with a Toolbar settings
    // checkbox to turn it off (owner decision).
    if (document.body) {
      document.body.classList.toggle('toolrail-hides-inserter', armed && hidesCoreInserterWhileArmed());
    }
  }

  // -------------------------------------------------------------------
  // Canvas selection (issue #14) — select several blocks in the editing
  // canvas: a rectangle dragged from empty canvas space, Ctrl+click
  // (Cmd+click on a Mac) to add or remove one block, Alt+click to remove
  // one, and Ctrl+Space as the keyboard form of the toggle.
  //
  // THE MENU ITEM. Ctrl+Space and Cmd+Space can be taken by the operating
  // system before the browser sees them (a search shortcut, the switch
  // between input sources, an input method for East Asian scripts). So
  // the block Options menu has the same toggle as an item, "Add to
  // selection" or "Remove from selection" (canvasSelectMenuAction, shown
  // by registerPinMenuItem). That menu opens from the block toolbar in
  // every browser, so the keyboard path cannot be taken away (owner
  // decision 2026-11-16). Ctrl+Space stays as it is.
  //
  // WHO HOLDS THE SELECTION (owner decision 2026-11-13, "hybrid"). When
  // the selected blocks are neighbors at one level, WordPress can hold
  // them, so the rail sets them as the WordPress selection (selectBlock /
  // multiSelect) and the block toolbar, copy and drag act on them as on
  // any selection. When the set has a gap, or blocks at two levels,
  // WordPress cannot hold it (getMultiSelectedBlockClientIds reads one
  // start and one end; checked on WordPress 7.1.3): the rail KEEPS the
  // set in csel.ids, outlines each member, and shows a small bar with the
  // group actions it can do with core's own actions. The kept set is
  // editor-session state. Nothing about it is stored in a preference or
  // in the post.
  //
  // EMPTY CANVAS SPACE is exactly this: a primary-button press whose
  // target IS the canvas <html> or <body>, the root block list
  // (.is-root-container) or the post title wrapper, and is not on a
  // scrollbar. Never a block, and never an element inside one. Measured
  // on WordPress 7.1.3, in three browsers (2026-11-13):
  //   inside a block's text       core places the caret; a drag selects
  //                               text, and past the block's edge core's
  //                               own drag selection takes over
  //   a block's non-text surface  core selects the block; a drag is
  //                               core's own block drag (every movable
  //                               block is draggable="true")
  //   the gap between two blocks  core's "+" popover, in the EDITOR
  //                               document, takes the press there; the
  //                               canvas never sees it
  //   beside the content, around  core clears its selection on the
  //   the title                   press; a drag starts a native text
  //                               selection that core may turn into a
  //                               block selection
  //   below the last block        core appends an empty paragraph AT
  //                               POINTERDOWN and cancels the event
  // So only the last two start a rectangle, and a press that does not
  // move 5px is left to core untouched. Nothing is prevented or stopped
  // before the threshold. Once the drag IS a rectangle, the rail removes
  // the empty paragraph core appended for that press (the
  // sweepStrayDefaultBlock rule: new in this gesture, the default block,
  // unmodified), clears the native selection, and swallows the one click
  // that follows (see handleCanvasSelectClick for why that one stop is
  // needed).
  //
  // THE LEVEL RULE. The rectangle selects siblings at ONE level. It
  // starts at the top level and takes every block it touches there. When
  // it touches exactly one block, does not enclose it, and touches
  // blocks inside it, it goes into that block and applies the same rule
  // to its children. So a rectangle over part of a Group selects the
  // touched blocks inside the Group, and a rectangle around the whole
  // Group selects the Group. A selection never holds a block together
  // with its own ancestor: a block added inside (or around) a member
  // replaces that member.
  //
  // WHEN THE KEPT SET ENDS. A plain press on a block or on empty space,
  // Escape in the canvas, a WordPress selection of several blocks made
  // any other way, the Section overview opening, or the code editor.
  // Members that leave the document are dropped at once. A WordPress
  // selection of ONE block does not end it: that is the block cursor,
  // and moving it is how a keyboard user reaches the next block to add
  // (Ctrl+Space). The outlines and the bar stay on screen for as long as
  // the set exists, so it cannot be forgotten.
  //
  // Everything here uses the canvas plumbing above (boundDoc,
  // bindCanvas). The feature is off while a tool is armed for the
  // pointer gestures, while a mode captures the canvas, when the rail is
  // not displayed, and in an editor with no canvas iframe (not measured
  // there).
  // -------------------------------------------------------------------

  // The attribute that marks a kept member on its block wrapper IN THE
  // EDITOR DOM. The stylesheet in the canvas document outlines it. It is
  // an attribute, not a class: React rewrites the wrapper's whole class
  // attribute on its next render, and leaves an attribute it does not
  // know alone. It never reaches the post, because the post is
  // serialized from block attributes, not from this DOM.
  var CANVAS_SELECT_ATTR = 'data-toolrail-selected';

  // Styles for the canvas document. The editor stylesheet cannot reach
  // inside the canvas iframe (core copies only styles it was given for
  // the content), so ensureCanvasStyle puts these in the same injected
  // <style> that carries the armed cursor. A DASHED outline: core's own
  // selection is a solid line, so the difference is a shape and not only
  // a color, and it survives forced colors, where the color is replaced.
  // Drawn inside the block's box so that a clipping ancestor cannot cut
  // it off. No transition or animation, so reduced motion needs no rule.
  var CANVAS_SELECT_CSS = '[' + CANVAS_SELECT_ATTR + '] { outline: 2px dashed #3858e9 !important; outline-offset: -2px !important; }'
    + ' html.toolrail-marquee, html.toolrail-marquee * { cursor: crosshair !important; -webkit-user-select: none !important; user-select: none !important; }'
    + ' @media (forced-colors: active) { [' + CANVAS_SELECT_ATTR + '] { outline-color: Highlight !important; } }';

  // The bar's buttons, in order. The ids are the data-csel-action values.
  var CANVAS_SELECT_ACTIONS = ['up', 'down', 'duplicate', 'group', 'delete', 'clear'];

  /**
   * The state of canvas selection, at its start values. One object, made
   * once: nothing here outlives the page, and the parts that belong to
   * one gesture (marquee) are replaced per gesture.
   *
   * @return {Object} The state.
   */
  function newCanvasSelectState() {
    return {
      // The KEPT selection: clientIds in document order, never a block
      // together with its ancestor. Empty means the rail keeps nothing
      // and the selection is WordPress's own.
      ids: [],
      // Keep the set even while WordPress can hold it. Set by the
      // keyboard toggle and by the bar's actions, where the author goes on
      // working with the set; a pointer gesture clears it, so a set that
      // WordPress can hold is handed over and the rail keeps nothing.
      pinned: false,
      // The in-flight rectangle, or null (see startCanvasMarquee).
      marquee: null,
      // True while the rail itself dispatches to the block editor store,
      // so the store subscription does not read its own change as the
      // author's.
      applying: false,
      // Latched by a finished or canceled rectangle so the click the
      // browser fires next is swallowed; any new press clears it.
      swallowClick: false,
      // The Escape keydown that disarmed a tool. That press has done its
      // one thing, so it does not also clear the selection.
      escapeEvent: null,
      // The data registry, from the rail's one React island. Its batch()
      // makes a move of several blocks ONE undo step.
      registry: null,
      // Watches the canvas for block elements React makes again, so the
      // outline attribute is put back. Only while a set is kept.
      domObserver: null,
      domTarget: null,
      repaintFrame: 0,
      // Follows the canvas box so the bar stays under it. Only while the
      // bar is shown.
      barObserver: null,
      // Where focus was in the canvas when the author went to the bar.
      returnFocus: null,
      // The bar button that has the one Tab stop.
      barAction: 'up',
      // Counts up each time the author acts (a key in the bar, a press in
      // the canvas, a return to the canvas); a pending focus retry from
      // before that stands down (keepCanvasSelectBarFocus).
      focusHold: 0,
      // The last key pressed in the bar, and, once that key has sent
      // focus to the canvas, the key whose auto-repeat the canvas must
      // not act on (handleCanvasSelectKeydown).
      barKey: '',
      guardKey: '',
      // True while a bar action runs that a POINTER click started (see
      // keepCanvasSelectionAfterAction).
      pointerAction: false,
      // References from the last store read; the subscription returns at
      // once while both are unchanged.
      lastBlocks: null,
      lastSelected: null,
      // Whether the mode-change listener is bound (once per page).
      modeBound: false
    };
  }

  // Canvas selection's state (see newCanvasSelectState).
  var csel = newCanvasSelectState();

  /**
   * Whether the pointer's toggle modifier is Cmd and not Ctrl. On a Mac,
   * Ctrl+click is the context menu, so the click toggle is Cmd there.
   *
   * @return {boolean}
   */
  function canvasSelectIsMac() {
    var platform = (window.navigator && (window.navigator.platform || window.navigator.userAgent)) || '';
    return /Mac|iPhone|iPad|iPod/.test(platform);
  }

  /**
   * Whether the canvas selection gestures are live: Select is the active
   * tool, no mode has the canvas, the canvas is an iframe the rail has
   * bound, and the rail is on screen (below the admin small-screen
   * breakpoint the rail is display:none, and its features go with it).
   *
   * @return {boolean}
   */
  function canvasSelectEnabled() {
    if (T.activeTool !== 'select' || modeCapturesCanvas(railMode())) {
      return false;
    }
    if (!boundDoc || boundDoc === document) {
      return false;
    }
    var region = document.getElementById('toolrail-region');
    return !!(region && region.getClientRects().length);
  }

  /**
   * Whether a press is on EMPTY CANVAS SPACE (the definition is in this
   * section's banner). The press must be on the element itself, not on a
   * descendant. A press on the canvas's own scrollbar reports <html> as
   * its target, so it is excluded by position.
   *
   * @param {PointerEvent} e   The canvas pointerdown.
   * @param {Document}     doc The canvas document.
   * @return {boolean}
   */
  function canvasSelectIsEmptySpace(e, doc) {
    var target = e.target;
    if (!target || target.nodeType !== 1) {
      return false;
    }
    var root = doc.documentElement;
    if (e.clientX >= root.clientWidth || e.clientY >= root.clientHeight) {
      return false;
    }
    if (target === root || target === doc.body) {
      return true;
    }
    var list = target.classList;
    return !!list && (list.contains('is-root-container')
      || list.contains('editor-visual-editor__post-title-wrapper')
      || list.contains('edit-post-visual-editor__post-title-wrapper'));
  }

  /**
   * The block under a canvas node: the innermost one.
   *
   * @param {Node} target A node in the canvas.
   * @return {string} Its clientId, or '' when the node is in no block.
   */
  function canvasSelectBlockAt(target) {
    var el = target && target.closest ? target.closest('[data-block]') : null;
    var id = el ? el.getAttribute('data-block') : '';
    return id && wp.data.select('core/block-editor').getBlockName(id) ? id : '';
  }

  /**
   * Whether a node is a control with its own meaning for a modified
   * click: a link (Ctrl+click opens it in a new tab in some browsers), a
   * button, or a form field. The click toggle leaves those alone.
   *
   * @param {Node} target A node in the canvas.
   * @return {boolean}
   */
  function canvasSelectIsControl(target) {
    return !!(target && target.closest
      && target.closest('a[href], button, input, textarea, select, summary, label, [role="button"], [role="link"]'));
  }

  /**
   * Whether the author can select this block at all. A block whose
   * editing mode is "disabled" (a locked template part, a pattern that
   * is not being edited) is inert in the canvas, and stays out.
   *
   * @param {Object} sel The core/block-editor selectors.
   * @param {string} id  A clientId.
   * @return {boolean}
   */
  function canvasSelectSelectable(sel, id) {
    if (!id || !sel.getBlockName(id)) {
      return false;
    }
    if (typeof sel.getBlockEditingMode === 'function') {
      try {
        return sel.getBlockEditingMode(id) !== 'disabled';
      } catch (err) {
        return true;
      }
    }
    return true;
  }

  /**
   * A block's position in the document as its index at each level, the
   * top level first. Sorting by this is document order.
   *
   * @param {Object} sel The core/block-editor selectors.
   * @param {string} id  A clientId.
   * @return {number[]}
   */
  function canvasSelectPath(sel, id) {
    var path = [];
    var guard = 0;
    while (id && guard++ < 64) {
      path.unshift(sel.getBlockIndex(id));
      id = sel.getBlockRootClientId(id);
    }
    return path;
  }

  /**
   * Whether one of two blocks is the other, or contains it.
   *
   * @param {Object} sel The core/block-editor selectors.
   * @param {string} a   A clientId.
   * @param {string} b   A clientId.
   * @return {boolean}
   */
  function canvasSelectRelated(sel, a, b) {
    return a === b
      || sel.getBlockParents(a).indexOf(b) !== -1
      || sel.getBlockParents(b).indexOf(a) !== -1;
  }

  /**
   * Make a list of clientIds a legal selection: only blocks that exist
   * and can be selected, each once, none together with its own ancestor
   * (the outer one stays), in document order.
   *
   * @param {string[]} ids ClientIds in any order.
   * @return {string[]}
   */
  function canvasSelectNormalize(ids) {
    var sel = wp.data.select('core/block-editor');
    var seen = Object.create(null);
    var list = [];
    (ids || []).forEach(function (id) {
      if (!seen[id] && canvasSelectSelectable(sel, id)) {
        seen[id] = true;
        list.push({ id: id, path: canvasSelectPath(sel, id) });
      }
    });
    list = list.filter(function (item) {
      return !sel.getBlockParents(item.id).some(function (parent) { return seen[parent]; });
    });
    list.sort(function (a, b) {
      var n = Math.min(a.path.length, b.path.length);
      for (var i = 0; i < n; i++) {
        if (a.path[i] !== b.path[i]) {
          return a.path[i] - b.path[i];
        }
      }
      return a.path.length - b.path.length;
    });
    return list.map(function (item) { return item.id; });
  }

  /**
   * Add blocks to a selection. A new block that is inside a member, or
   * around one, REPLACES that member: the newest choice wins, and the
   * selection never holds a block with its own ancestor.
   *
   * @param {string[]} base  The selection so far.
   * @param {string[]} added The blocks to add.
   * @return {string[]} The merged list (not yet normalized).
   */
  function canvasSelectMerge(base, added) {
    var sel = wp.data.select('core/block-editor');
    var kept = base.filter(function (id) {
      return !added.some(function (other) {
        return other !== id && canvasSelectRelated(sel, id, other);
      });
    });
    return kept.concat(added.filter(function (id) { return kept.indexOf(id) === -1; }));
  }

  /**
   * Whether WordPress can hold this selection: every block has the same
   * parent, and they are next to each other with no gap.
   *
   * @param {string[]} ids ClientIds in document order.
   * @return {boolean}
   */
  function canvasSelectHoldable(ids) {
    if (!ids.length) {
      return false;
    }
    var sel = wp.data.select('core/block-editor');
    var root = sel.getBlockRootClientId(ids[0]);
    var prev = sel.getBlockIndex(ids[0]);
    for (var i = 1; i < ids.length; i++) {
      if (sel.getBlockRootClientId(ids[i]) !== root || sel.getBlockIndex(ids[i]) !== prev + 1) {
        return false;
      }
      prev += 1;
    }
    return true;
  }

  /** Whether two id lists hold the same blocks, in any order. */
  function canvasSelectSameSet(a, b) {
    return a.length === b.length && a.every(function (id) { return b.indexOf(id) !== -1; });
  }

  /**
   * The selection the next gesture builds on: the kept set, or, when the
   * rail keeps nothing, the WordPress selection.
   *
   * @return {string[]}
   */
  function canvasSelectEffective() {
    if (csel.ids.length) {
      return csel.ids.slice();
    }
    return wp.data.select('core/block-editor').getSelectedBlockClientIds().slice();
  }

  /**
   * Announce the selection after a completed gesture: ONE composed
   * message (speak() replaces the region's text, so two would race).
   *
   * The hint names the key that works from where focus is. After the
   * Options menu item, core returns focus to the Options button in the
   * block toolbar, where Ctrl+Enter does nothing (the key is bound in the
   * canvas only), so that hint says Escape first.
   *
   * @param {number}  count    How many blocks are selected now.
   * @param {boolean} hint     Add where the group actions are. Said once,
   *                           when the bar appears.
   * @param {boolean} fromMenu The change came from the Options menu item.
   * @return {void}
   */
  function announceCanvasSelection(count, hint, fromMenu) {
    if (!count) {
      speak(__('Selection cleared.', 'editrail'));
      return;
    }
    var message = sprintf(
      /* translators: %d: number of selected blocks. */
      _n('%d block selected.', '%d blocks selected.', count, 'editrail'),
      count
    );
    if (hint && fromMenu) {
      /* translators: Said after "Add to selection" in the block options menu, while focus is on the menu's button. Escape and Control+Enter are key names. */
      message += ' ' + __('Press Escape to go back to the block, then press Control+Enter for the selection actions.', 'editrail');
    } else if (hint) {
      message += ' ' + __('Press Control+Enter for the selection actions.', 'editrail');
    }
    speak(message);
  }

  /**
   * Make a list of blocks THE selection, after a completed gesture. The
   * one place that decides who holds it (the banner's hybrid rule), sets
   * or clears the WordPress selection to match, repaints, and announces.
   *
   * origin 'pointer': a set WordPress can hold is handed over and the
   * rail keeps nothing; a set it cannot hold is kept, and the WordPress
   * selection is cleared so no toolbar or Delete key acts on a part of
   * it. origin 'keyboard': the set is kept either way, because the
   * author needs it to stay while the block cursor moves to the next
   * block to add; the WordPress selection is the cursor and is only
   * widened to the whole set when the cursor is inside it. origin 'menu'
   * (the block Options menu item): exactly as 'keyboard', except for the
   * announcement's hint. origin 'action' (leaving the bar after a Move):
   * kept, and mirrored when WordPress can hold it and has nothing else
   * selected.
   *
   * @param {string[]} ids    The blocks, in any order.
   * @param {string}   origin 'pointer' | 'keyboard' | 'menu' | 'action'.
   * @param {boolean}  quiet  Skip the announcement (the caller composes
   *                          its own).
   * @return {void}
   */
  function commitCanvasSelection(ids, origin, quiet) {
    var sel = wp.data.select('core/block-editor');
    var dispatch = wp.data.dispatch('core/block-editor');
    var hadBar = csel.ids.length > 0;
    var current = sel.getSelectedBlockClientIds();
    var coreSpoke = false;
    ids = canvasSelectNormalize(ids);
    var holdable = canvasSelectHoldable(ids);
    var keep = origin !== 'pointer';
    var inside = current.every(function (id) { return ids.indexOf(id) !== -1; });
    var mirror = holdable && (origin === 'pointer'
      || (inside && (origin === 'action' || current.length > 0)));

    csel.applying = true;
    try {
      csel.ids = ids.length && (keep || !holdable) ? ids : [];
      csel.pinned = csel.ids.length > 0 && keep;
      if (mirror) {
        if (!canvasSelectSameSet(current, ids)) {
          if (ids.length === 1) {
            dispatch.selectBlock(ids[0]);
          } else {
            // Core's multiSelect announces the count itself.
            dispatch.multiSelect(ids[0], ids[ids.length - 1]);
            coreSpoke = canvasSelectSameSet(sel.getSelectedBlockClientIds(), ids);
          }
        }
      } else if (origin === 'pointer' && current.length) {
        dispatch.clearSelectedBlock();
      }
    } finally {
      csel.applying = false;
    }

    // A set the rail keeps with nothing selected in WordPress: take
    // focus out of the block the author was in, so typing cannot go to a
    // block that no longer shows as selected.
    if (csel.ids.length && origin === 'pointer' && boundDoc && boundDoc.body) {
      try {
        boundDoc.defaultView.getSelection().removeAllRanges();
        boundDoc.body.focus({ preventScroll: true });
      } catch (err) {
        /* Focus is a convenience here; the selection is already set. */
      }
    }

    refreshCanvasSelectUi();
    if (!quiet && !coreSpoke) {
      announceCanvasSelection(ids.length, csel.ids.length > 0 && !hadBar, origin === 'menu');
    }
  }

  /**
   * End the kept selection and leave the WordPress selection alone.
   *
   * @param {boolean} announce Say "Selection cleared."
   * @return {void}
   */
  function endCanvasSelection(announce) {
    if (!csel.ids.length) {
      return;
    }
    csel.ids = [];
    csel.pinned = false;
    refreshCanvasSelectUi();
    if (announce) {
      announceCanvasSelection(0, false);
    }
  }

  /**
   * Clear selection, from the bar. When WordPress holds the same blocks
   * (a Move mirrored a range there), its selection is cleared too, or
   * the blocks would still show as selected after "Selection cleared".
   * Any other WordPress selection, such as the block cursor, is the
   * author's own and stays (PR #124 review). With nothing selected,
   * focus goes to the canvas body, as it does for several blocks.
   *
   * @return {void}
   */
  function clearCanvasSelectionFromBar() {
    var current = wp.data.select('core/block-editor').getSelectedBlockClientIds();
    if (current.length > 1 && canvasSelectSameSet(current, csel.ids)) {
      csel.applying = true;
      try {
        wp.data.dispatch('core/block-editor').clearSelectedBlock();
      } finally {
        csel.applying = false;
      }
    }
    endCanvasSelection(true);
  }

  /**
   * The selection a toggle builds on. The click builds on what is
   * selected now ("and this one too"). The key and the menu item build on
   * the KEPT set only: their targets ARE the WordPress selection, so
   * against that they would always read as "all in".
   *
   * @param {string} origin 'pointer' | 'keyboard' | 'menu'.
   * @return {string[]} A copy.
   */
  function canvasSelectToggleBase(origin) {
    return origin === 'pointer' ? canvasSelectEffective() : csel.ids.slice();
  }

  /**
   * Whether a toggle removes: every target is in the base already.
   *
   * @param {string[]} targets ClientIds.
   * @param {string[]} base    From canvasSelectToggleBase.
   * @return {boolean}
   */
  function canvasSelectAllIn(targets, base) {
    return targets.every(function (id) { return base.indexOf(id) !== -1; });
  }

  /**
   * Add or remove blocks: the click toggle, the keyboard toggle and the
   * Options menu item. When every target is already selected they are
   * removed; otherwise the ones that are missing are added.
   *
   * @param {string[]} targets The block (or, from the keyboard, every
   *                           block of the WordPress selection; from the
   *                           menu, every block the menu belongs to).
   * @param {string}   origin  'pointer' | 'keyboard' | 'menu' (the menu
   *                           item is the keyboard toggle in another
   *                           place; only its announcement differs).
   * @return {void}
   */
  function toggleCanvasSelection(targets, origin) {
    var base = canvasSelectToggleBase(origin);
    var allIn = canvasSelectAllIn(targets, base);
    var next = allIn
      ? base.filter(function (id) { return targets.indexOf(id) === -1; })
      : canvasSelectMerge(base, targets);
    commitCanvasSelection(next, origin, false);
  }

  /**
   * The block Options menu item: the same toggle as Ctrl+Space, for the
   * blocks the menu belongs to (see THE MENU ITEM in the banner). Read
   * when the menu renders, which is when it opens, so the label matches
   * the kept set at that moment.
   *
   * The item is offered only while the gestures are live
   * (canvasSelectEnabled): with a tool armed, the overview open, a narrow
   * screen or no canvas iframe, the author cannot use the result. It IS
   * offered for one selected block with nothing kept yet, because that is
   * how a keyboard user starts a set, the same as the first Ctrl+Space.
   * It is not offered when no target can be selected at all
   * (canvasSelectSelectable): the toggle would drop such a block, so the
   * item would do nothing.
   *
   * The targets are the menu's own clientIds, copied now, and not the
   * WordPress selection when the item runs: the menu belongs to those
   * blocks, and closing it can change the selection.
   *
   * @param {string[]} clientIds The blocks the menu belongs to.
   * @return {?Object} { remove: boolean, run: function } or null.
   */
  function canvasSelectMenuAction(clientIds) {
    if (!clientIds || !clientIds.length || !canvasSelectEnabled()) {
      return null;
    }
    var sel = wp.data.select('core/block-editor');
    var targets = clientIds.slice();
    if (!targets.some(function (id) { return canvasSelectSelectable(sel, id); })) {
      return null;
    }
    return {
      remove: canvasSelectAllIn(targets, canvasSelectToggleBase('menu')),
      run: function () {
        // Read again: the menu can stay open while the state changes.
        if (canvasSelectEnabled()) {
          toggleCanvasSelection(targets, 'menu');
        }
      }
    };
  }

  /**
   * Put the outline attribute on exactly the given blocks' wrappers.
   * Called after every change, and again when the canvas re-renders.
   *
   * @param {string[]} preview The blocks to mark instead of the kept
   *                           set (the live rectangle); omit for the set.
   * @return {void}
   */
  function paintCanvasSelection(preview) {
    var doc = boundDoc;
    if (!doc || !doc.querySelectorAll) {
      return;
    }
    var want = Object.create(null);
    var ids = preview || csel.ids;
    if (ids.length) {
      // The attribute is worth nothing without the rule that draws it.
      ensureCanvasStyle(doc);
    }
    ids.forEach(function (id) { want[id] = true; });
    var have = Object.create(null);
    Array.prototype.forEach.call(doc.querySelectorAll('[' + CANVAS_SELECT_ATTR + ']'), function (el) {
      var id = el.getAttribute('data-block');
      if (id && want[id]) {
        have[id] = true;
      } else {
        el.removeAttribute(CANVAS_SELECT_ATTR);
      }
    });
    ids.forEach(function (id) {
      if (have[id]) {
        return;
      }
      var el = doc.getElementById('block-' + id);
      if (el) {
        el.setAttribute(CANVAS_SELECT_ATTR, '');
      }
    });
  }

  /** The observer's callback: one repaint per frame, however many
      mutation batches arrive. */
  function scheduleCanvasSelectRepaint() {
    if (csel.repaintFrame) {
      return;
    }
    csel.repaintFrame = window.requestAnimationFrame(function () {
      csel.repaintFrame = 0;
      if (csel.marquee && csel.marquee.active) {
        return;
      }
      paintCanvasSelection();
    });
  }

  /**
   * Watch the canvas for block elements that React makes again (a block
   * moved to another parent, the visual editor mounted again), which
   * come back without the outline attribute. Only while a set is kept,
   * and childList only: the repaint writes attributes, which this does
   * not observe, so it cannot trigger itself. With nothing kept there is
   * no observer and no work.
   *
   * @return {void}
   */
  function watchCanvasSelectDom() {
    var body = csel.ids.length && boundDoc && boundDoc !== document ? boundDoc.body : null;
    if (csel.domObserver && csel.domTarget !== body) {
      csel.domObserver.disconnect();
      csel.domObserver = null;
      csel.domTarget = null;
    }
    if (!body || csel.domObserver || typeof window.MutationObserver !== 'function') {
      return;
    }
    csel.domObserver = new window.MutationObserver(scheduleCanvasSelectRepaint);
    csel.domObserver.observe(body, { childList: true, subtree: true });
    csel.domTarget = body;
  }

  /**
   * What each group action can act on right now. Locks are read the way
   * overviewCanMove reads them, through core's own selectors, so a
   * locked block and a content-only container are respected without a
   * rule of our own.
   *
   * @return {Object} { ids, sameLevel, root, order, movable, removable,
   *                    groupable, duplicable, groupName }
   */
  function canvasSelectInfo() {
    var sel = wp.data.select('core/block-editor');
    // Read fresh, in document order, and only blocks that still exist:
    // an action must never act on a stale id or a stale order.
    var ids = canvasSelectNormalize(csel.ids);
    var root = ids.length ? (sel.getBlockRootClientId(ids[0]) || '') : '';
    var sameLevel = ids.every(function (id) { return (sel.getBlockRootClientId(id) || '') === root; });
    var guarded = function (name, args) {
      if (typeof sel[name] !== 'function') {
        return true;
      }
      try {
        return !!sel[name].apply(sel, args);
      } catch (err) {
        return true;
      }
    };
    var canMove = function (id) { return guarded('canMoveBlocks', [[id], root]); };
    var canRemove = function (id) { return guarded('canRemoveBlock', [id, sel.getBlockRootClientId(id) || '']); };
    var groupName = typeof wp.blocks.getGroupingBlockName === 'function' ? wp.blocks.getGroupingBlockName() : '';
    var canGroupHere = !!groupName && sameLevel && typeof wp.blocks.switchToBlockType === 'function'
      && guarded('canInsertBlockType', [groupName, root]);
    return {
      ids: ids,
      sameLevel: sameLevel,
      root: root,
      order: sameLevel ? sel.getBlockOrder(root) : [],
      movable: sameLevel ? ids.filter(canMove) : [],
      removable: ids.filter(canRemove),
      groupable: canGroupHere ? ids.filter(function (id) { return canMove(id) && canRemove(id); }) : [],
      duplicable: sameLevel ? ids.filter(function (id) {
        var name = sel.getBlockName(id);
        return wp.blocks.hasBlockSupport(name, 'multiple', true) && guarded('canInsertBlockType', [name, root]);
      }) : [],
      groupName: groupName
    };
  }

  /**
   * Why a group action cannot run now, as a sentence for the tooltip and
   * the live region; '' when it can.
   *
   * Move, Duplicate and Group are OFF for blocks at two levels. Each of
   * core's actions behind them works in one parent (moveBlocksToPosition
   * takes one source parent, duplicateBlocks and replaceBlocks put their
   * result in the first block's parent), so "move up", "the copies go
   * after the last one" and "one Group around them" have no single
   * meaning there. Delete has one at any level, and stays on.
   *
   * @param {string} action A CANVAS_SELECT_ACTIONS id.
   * @param {Object} info   From canvasSelectInfo().
   * @return {string}
   */
  function canvasSelectUnavailable(action, info) {
    if (action === 'clear') {
      return '';
    }
    if (action === 'delete') {
      return info.removable.length ? '' : __('The selected blocks are locked and cannot be deleted.', 'editrail');
    }
    if (!info.sameLevel) {
      return __('Not available: the selected blocks are at different levels.', 'editrail');
    }
    if (action === 'duplicate') {
      return info.duplicable.length ? '' : __('The selected blocks cannot be duplicated here.', 'editrail');
    }
    if (action === 'group') {
      return info.groupable.length ? '' : __('The selected blocks cannot be grouped here.', 'editrail');
    }
    if (!info.movable.length) {
      return __('The selected blocks are locked and cannot be moved.', 'editrail');
    }
    if (action === 'up') {
      return info.order.indexOf(info.movable[0]) > 0 ? '' : __('The selection is at the top.', 'editrail');
    }
    return info.order.indexOf(info.movable[info.movable.length - 1]) < info.order.length - 1
      ? ''
      : __('The selection is at the bottom.', 'editrail');
  }

  /** A bar button's visible text, which is also its accessible name. */
  function canvasSelectActionLabel(action) {
    switch (action) {
      case 'up':
        return __('Move up', 'editrail');
      case 'down':
        return __('Move down', 'editrail');
      case 'duplicate':
        return __('Duplicate', 'editrail');
      case 'group':
        return __('Group', 'editrail');
      case 'delete':
        return __('Delete', 'editrail');
      default:
        return __('Clear selection', 'editrail');
    }
  }

  /** The "stays where it is" note for members an action left out. */
  function canvasSelectLockedSuffix(count) {
    if (!count) {
      return '';
    }
    return ' ' + sprintf(
      /* translators: %d: number of locked blocks. */
      _n(
        '%d locked block stays where it is.',
        '%d locked blocks stay where they are.',
        count,
        'editrail'
      ),
      count
    );
  }

  /**
   * Run several dispatches as ONE undo step. The editor makes an undo
   * level each time it hears the block store change, and the registry's
   * batch() holds the listeners until the callback returns (measured on
   * WordPress 7.1.3: three moves in a batch are one undo step, and two
   * moves outside one are two). batch() is on the registry, which
   * wp.data does not export, so the rail's React island hands it over
   * (registerPinMenuItem). Without it the dispatches still run, as one
   * undo step each.
   *
   * @param {Function} run The dispatches.
   * @return {void}
   */
  function runCanvasSelectBatch(run) {
    if (csel.registry && typeof csel.registry.batch === 'function') {
      csel.registry.batch(run);
      return;
    }
    run();
  }

  /**
   * Move the kept set one step up or down as a group: the members that
   * can move close up, in document order, and pass the nearest block
   * that is not one of them. The Section overview's group move is the
   * model. A locked member stays where it is, and the message says so.
   *
   * Only MEMBERS are moved, one block per dispatch and each straight to
   * its final index, so a locked neighbor never has to move for the
   * group to pass it. Up places the first member first and down the
   * last member first: each block then comes from the far side of the
   * ones already placed, and does not shift them.
   *
   * @param {number} delta -1 (up) or +1 (down).
   * @return {void}
   */
  function moveCanvasSelection(delta) {
    var info = canvasSelectInfo();
    var reason = canvasSelectUnavailable(delta < 0 ? 'up' : 'down', info);
    if (reason) {
      speak(reason);
      return;
    }
    var sel = wp.data.select('core/block-editor');
    var dispatch = wp.data.dispatch('core/block-editor');
    var movable = info.movable;
    var count = movable.length;
    var insertAt = delta < 0
      ? info.order.indexOf(movable[0]) - 1
      : info.order.indexOf(movable[count - 1]) + 2 - count;
    var place = function (i) {
      if (sel.getBlockOrder(info.root)[insertAt + i] !== movable[i]) {
        dispatch.moveBlocksToPosition([movable[i]], info.root, info.root, insertAt + i);
      }
    };

    csel.applying = true;
    try {
      runCanvasSelectBatch(function () {
        var i;
        if (delta < 0) {
          for (i = 0; i < count; i++) {
            place(i);
          }
        } else {
          for (i = count - 1; i >= 0; i--) {
            place(i);
          }
        }
      });
    } finally {
      csel.applying = false;
    }

    // VERIFY before announcing (the moveOverviewBlockTo discipline).
    var after = sel.getBlockOrder(info.root);
    var ok = movable.every(function (id, i) { return after[insertAt + i] === id; });
    // The members are now next to each other, so WordPress COULD hold
    // the set. It is not handed over here, and focus is not touched:
    // keepCanvasSelectionAfterAction has the reason.
    keepCanvasSelectionAfterAction(info.ids);
    if (!ok) {
      speak(__('The move could not be completed.', 'editrail'));
      return;
    }
    speak(sprintf(
      /* translators: 1: number of moved blocks, 2: new position of the first, 3: count. */
      _n(
        'Moved %1$d block to position %2$d of %3$d.',
        'Moved %1$d blocks to position %2$d of %3$d.',
        count,
        'editrail'
      ),
      count,
      insertAt + 1,
      after.length
    ) + canvasSelectLockedSuffix(info.ids.length - count));
  }

  /**
   * Put focus on a bar button from the canvas (Ctrl+Enter), and
   * try again a moment later if it did not take: a focus() call made
   * from a canvas key handler does not always take while the iframe has
   * focus (the focusFromEvent note, issue #74). Focus is only taken from
   * the canvas or from the body, never from a place the author has
   * moved it to in the meantime.
   *
   * @param {Element|null} btn The bar button.
   * @return {void}
   */
  function keepCanvasSelectBarFocus(btn) {
    var bar = document.getElementById('toolrail-csel-bar');
    if (!btn || !bar || !bar.contains(btn)) {
      return;
    }
    // The author's next key or press ends the hold (csel.focusHold): a
    // late retry must never undo a move of focus they made themselves.
    // Without this, Escape in the bar sent focus to the canvas and the
    // 80 ms retry brought it back (seen in the e2e run, 2026-11-14).
    var hold = ++csel.focusHold;
    var restore = function () {
      var active = document.activeElement;
      if (hold !== csel.focusHold || active === btn || bar.hidden || !btn.isConnected) {
        return;
      }
      if (!active || active === document.body || active === T.canvasFrame()) {
        btn.focus();
      }
    };
    // Each pass is a no-op once focus is on the button.
    restore();
    window.setTimeout(restore, 0);
    window.setTimeout(restore, 80);
    // Core can also take focus BACK a moment later: after an arrow key
    // it moves focus from the block's text to the canvas body, from a
    // selectionchange handler, at no fixed time (one e2e run in three
    // lost the bar this way, 2026-11-14). For a short while, a blur on
    // the button is answered the same way.
    var onBlur = function () {
      window.setTimeout(restore, 0);
    };
    btn.addEventListener('blur', onBlur);
    window.setTimeout(function () {
      btn.removeEventListener('blur', onBlur);
    }, 600);
  }

  /**
   * Make the result of a bar action the kept set, and leave everything
   * else alone: the WordPress selection and, above all, focus.
   *
   * No action hands its result to WordPress by itself. Selecting several
   * blocks makes core focus the canvas, and the author's next Enter,
   * meant for the bar button they just pressed, would then go to the
   * canvas, where core replaces a selection of several blocks with an
   * empty paragraph (measured in one browser engine, 2026-11-14: the
   * second Enter on "Move down" deleted both moved blocks, and focus()
   * could not bring focus back to the bar). So while the bar exists,
   * focus stays on it, and the set stays the rail's own until the author
   * goes back to the canvas (leaveCanvasSelectBar) or pressed the button
   * with the pointer (runCanvasSelectAction). With nothing left to keep,
   * the bar goes, and syncCanvasSelectBar sends focus to the canvas.
   *
   * @param {string[]} ids The blocks the action left selected.
   * @return {void}
   */
  function keepCanvasSelectionAfterAction(ids) {
    csel.ids = canvasSelectNormalize(ids);
    csel.pinned = csel.ids.length > 0;
    if (!csel.ids.length) {
      csel.returnFocus = null;
    }
    refreshCanvasSelectUi();
    // A pointer click (onCanvasSelectBarClick) has no next key press to
    // protect, so its result goes to WordPress at once. Here, before the
    // caller's message: core announces a selection of several blocks
    // itself, and the action's own message must be the last one said.
    if (csel.pointerAction) {
      handOverCanvasSelection();
    }
  }

  /**
   * Delete the kept set with ONE removeBlocks, which is one undo step at
   * any mix of levels. A member that cannot be removed stays selected,
   * and the message says so. When nothing is left, core selects the block
   * before the first one removed, the same as its own Delete, so a
   * keyboard user lands on a block.
   *
   * @return {void}
   */
  function deleteCanvasSelection() {
    var info = canvasSelectInfo();
    var reason = canvasSelectUnavailable('delete', info);
    if (reason) {
      speak(reason);
      return;
    }
    var rest = info.ids.filter(function (id) { return info.removable.indexOf(id) === -1; });
    csel.applying = true;
    try {
      wp.data.dispatch('core/block-editor').removeBlocks(info.removable, !rest.length);
    } finally {
      csel.applying = false;
    }
    var sel = wp.data.select('core/block-editor');
    var gone = info.removable.filter(function (id) { return !sel.getBlockName(id); }).length;
    keepCanvasSelectionAfterAction(info.ids);
    if (!gone) {
      speak(__('The blocks could not be deleted.', 'editrail'));
      return;
    }
    speak(sprintf(
      /* translators: %d: number of deleted blocks. */
      _n('%d block deleted.', '%d blocks deleted.', gone, 'editrail'),
      gone
    ) + canvasSelectLockedSuffix(info.ids.length - gone));
  }

  /**
   * Duplicate the kept set with core's duplicateBlocks: the copies land
   * together after the last selected block, in document order. One
   * dispatch, one undo step. The copies become the kept set, as core
   * selects the copies after its own Duplicate.
   *
   * @return {void}
   */
  function duplicateCanvasSelection() {
    var info = canvasSelectInfo();
    var reason = canvasSelectUnavailable('duplicate', info);
    if (reason) {
      speak(reason);
      return;
    }
    var sel = wp.data.select('core/block-editor');
    var before = Object.create(null);
    sel.getBlockOrder(info.root).forEach(function (id) { before[id] = true; });
    csel.applying = true;
    try {
      // updateSelection false: see keepCanvasSelectionAfterAction.
      wp.data.dispatch('core/block-editor').duplicateBlocks(info.duplicable, false);
    } finally {
      csel.applying = false;
    }
    var copies = sel.getBlockOrder(info.root).filter(function (id) { return !before[id]; });
    if (!copies.length) {
      keepCanvasSelectionAfterAction(info.ids);
      speak(__('The blocks could not be duplicated.', 'editrail'));
      return;
    }
    keepCanvasSelectionAfterAction(copies);
    var skipped = info.ids.length - info.duplicable.length;
    speak(sprintf(
      /* translators: %d: number of duplicated blocks. */
      _n('%d block duplicated.', '%d blocks duplicated.', copies.length, 'editrail'),
      copies.length
    ) + (skipped ? ' ' + sprintf(
      /* translators: %d: number of blocks that were not duplicated. */
      _n('%d block cannot be duplicated here.', '%d blocks cannot be duplicated here.', skipped, 'editrail'),
      skipped
    ) : ''));
  }

  /**
   * Group the kept set the way the block toolbar's Group button does:
   * switchToBlockType makes the grouping block, and ONE replaceBlocks
   * puts it where the first member was and takes the other members out
   * of their places. One undo step. A member that is locked against
   * moving or removal stays where it is, outside the Group. The new
   * Group becomes the kept set.
   *
   * @return {void}
   */
  function groupCanvasSelection() {
    var info = canvasSelectInfo();
    var reason = canvasSelectUnavailable('group', info);
    if (reason) {
      speak(reason);
      return;
    }
    var sel = wp.data.select('core/block-editor');
    var made;
    try {
      made = wp.blocks.switchToBlockType(sel.getBlocksByClientId(info.groupable), info.groupName);
    } catch (err) {
      made = null;
    }
    if (!made || !made.length) {
      speak(__('The selected blocks cannot be grouped here.', 'editrail'));
      return;
    }
    csel.applying = true;
    try {
      // initialPosition null: when a replaced block was the WordPress
      // selection, core selects the new block, and null keeps it from
      // also moving focus there (see keepCanvasSelectionAfterAction).
      wp.data.dispatch('core/block-editor').replaceBlocks(info.groupable, made, undefined, null);
    } finally {
      csel.applying = false;
    }
    if (!sel.getBlockName(made[0].clientId)) {
      keepCanvasSelectionAfterAction(info.ids);
      speak(__('The blocks could not be grouped.', 'editrail'));
      return;
    }
    keepCanvasSelectionAfterAction([made[0].clientId]);
    speak(sprintf(
      /* translators: %d: number of grouped blocks. */
      _n('%d block grouped.', '%d blocks grouped.', info.groupable.length, 'editrail'),
      info.groupable.length
    ) + canvasSelectLockedSuffix(info.ids.length - info.groupable.length));
  }

  /**
   * Put focus in the canvas: on the element it came from (Escape in the
   * bar), else on the first block of the WordPress selection, else on
   * the canvas body.
   *
   * @param {boolean} preferReturn Use the remembered element if it is
   *                               still there.
   * @return {void}
   */
  function focusCanvasFromBar(preferReturn) {
    var doc = boundDoc;
    var frame = T.canvasFrame();
    if (!doc || !frame || doc === document) {
      return;
    }
    var target = null;
    if (preferReturn && csel.returnFocus && csel.returnFocus.isConnected
      && csel.returnFocus.ownerDocument === doc) {
      target = csel.returnFocus;
    }
    if (!target) {
      // One selected block takes focus itself. With several, focus
      // belongs on the canvas body, where core puts it: focus on one of
      // the blocks collapsed the selection to that block (seen in the
      // e2e run, 2026-11-14).
      var selected = wp.data.select('core/block-editor').getSelectedBlockClientIds();
      target = selected.length === 1 ? doc.getElementById('block-' + selected[0]) : null;
    }
    csel.returnFocus = null;
    csel.focusHold++;
    // The key that sent focus here may still be down.
    csel.guardKey = csel.barKey;
    csel.barKey = '';
    try {
      frame.contentWindow.focus();
      (target || doc.body).focus({ preventScroll: !target });
    } catch (err) {
      /* A canvas that cannot take focus leaves it where the browser put it. */
    }
  }

  /**
   * The bar with the group actions: a toolbar (one Tab stop, Left and
   * Right arrows inside it) in the EDITOR document, under the canvas's
   * bottom edge. Built once and kept in the body; shown only while a
   * set is kept.
   *
   * @return {HTMLElement} The bar.
   */
  function canvasSelectBar() {
    var bar = document.getElementById('toolrail-csel-bar');
    if (bar) {
      return bar;
    }
    bar = document.createElement('div');
    bar.id = 'toolrail-csel-bar';
    bar.className = 'toolrail-csel-bar';
    bar.hidden = true;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', __('Selection actions', 'editrail'));
    var count = document.createElement('span');
    count.className = 'toolrail-csel-count';
    bar.appendChild(count);
    CANVAS_SELECT_ACTIONS.forEach(function (action) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toolrail-csel-btn';
      btn.setAttribute('data-csel-action', action);
      btn.textContent = canvasSelectActionLabel(action);
      btn.tabIndex = action === csel.barAction ? 0 : -1;
      bar.appendChild(btn);
    });
    bar.addEventListener('click', onCanvasSelectBarClick);
    bar.addEventListener('keydown', onCanvasSelectBarKeydown);
    bar.addEventListener('focusin', function (e) {
      var action = e.target && e.target.getAttribute ? e.target.getAttribute('data-csel-action') : '';
      if (!action) {
        return;
      }
      // The focused button takes the one Tab stop.
      csel.barAction = action;
      Array.prototype.forEach.call(bar.querySelectorAll('[data-csel-action]'), function (btn) {
        btn.tabIndex = btn === e.target ? 0 : -1;
      });
    });
    document.body.appendChild(bar);
    return bar;
  }

  /**
   * The window changed size while the bar is shown. Below the admin
   * small-screen breakpoint the rail is display:none and the gestures are
   * off (canvasSelectEnabled), and the stylesheet hides the bar. A kept
   * set would then stay outlined with no way to act on it or to reach the
   * bar, so it ends there, and says so (PR #124 review).
   *
   * @return {void}
   */
  function onCanvasSelectResize() {
    var region = document.getElementById('toolrail-region');
    if (csel.ids.length && !(region && region.getClientRects().length)) {
      endCanvasSelection(true);
      return;
    }
    placeCanvasSelectBar();
  }

  /**
   * Put the bar under the middle of the canvas's bottom edge.
   *
   * @return {void}
   */
  function placeCanvasSelectBar() {
    var bar = document.getElementById('toolrail-csel-bar');
    var geo = T.getCanvasGeometry();
    if (!bar || bar.hidden || !geo) {
      return;
    }
    var rect = geo.frameRect;
    var bottom = Math.min(rect.top + rect.height, window.innerHeight);
    bar.style.left = Math.round(rect.left + rect.width / 2) + 'px';
    bar.style.bottom = Math.max(8, Math.round(window.innerHeight - bottom + 16)) + 'px';
    bar.style.maxWidth = Math.max(160, Math.round(rect.width - 16)) + 'px';
  }

  /**
   * Show, update or hide the bar to match the kept set: the count, and
   * each button's availability (aria-disabled with the reason in its
   * tooltip, never the disabled attribute, so a dimmed button stays in
   * the arrow order and keeps its name — the rail's R9 pattern). When
   * the bar goes while focus is in it, focus goes to the canvas.
   *
   * @return {void}
   */
  function syncCanvasSelectBar() {
    var existing = document.getElementById('toolrail-csel-bar');
    if (!csel.ids.length) {
      if (existing && !existing.hidden) {
        var hadFocus = existing.contains(document.activeElement);
        existing.hidden = true;
        if (csel.barObserver) {
          csel.barObserver.disconnect();
          csel.barObserver = null;
        }
        window.removeEventListener('resize', onCanvasSelectResize);
        if (hadFocus) {
          focusCanvasFromBar(false);
        }
      }
      return;
    }
    var bar = existing || canvasSelectBar();
    var info = canvasSelectInfo();
    bar.querySelector('.toolrail-csel-count').textContent = sprintf(
      /* translators: %d: number of selected blocks. */
      _n('%d block selected.', '%d blocks selected.', csel.ids.length, 'editrail'),
      csel.ids.length
    );
    Array.prototype.forEach.call(bar.querySelectorAll('[data-csel-action]'), function (btn) {
      var action = btn.getAttribute('data-csel-action');
      var reason = canvasSelectUnavailable(action, info);
      var title = reason ? canvasSelectActionLabel(action) + ' — ' + reason : '';
      if (reason) {
        btn.setAttribute('aria-disabled', 'true');
      } else {
        btn.removeAttribute('aria-disabled');
      }
      if (btn.title !== title) {
        btn.title = title;
      }
    });
    if (bar.hidden) {
      bar.hidden = false;
      window.addEventListener('resize', onCanvasSelectResize);
      // The sidebar opening or closing moves the canvas with no window
      // resize; the content region's own box changes then.
      var content = T.contentRegion();
      if (content && typeof window.ResizeObserver === 'function' && !csel.barObserver) {
        csel.barObserver = new window.ResizeObserver(placeCanvasSelectBar);
        csel.barObserver.observe(content);
      }
    }
    placeCanvasSelectBar();
  }

  /**
   * Bring every surface in line with the kept set: outlines, bar, and
   * the canvas observer. Also remembers the store references the
   * subscription compares.
   *
   * @return {void}
   */
  function refreshCanvasSelectUi() {
    var sel = wp.data.select('core/block-editor');
    csel.lastBlocks = sel.getBlocks();
    csel.lastSelected = sel.getSelectedBlockClientIds();
    paintCanvasSelection();
    syncCanvasSelectBar();
    watchCanvasSelectDom();
  }

  /**
   * Run one bar action. A dimmed button says why instead.
   *
   * @param {string} action A CANVAS_SELECT_ACTIONS id.
   * @return {void}
   */
  function runCanvasSelectAction(action) {
    switch (action) {
      case 'up':
        moveCanvasSelection(-1);
        break;
      case 'down':
        moveCanvasSelection(1);
        break;
      case 'duplicate':
        duplicateCanvasSelection();
        break;
      case 'group':
        groupCanvasSelection();
        break;
      case 'delete':
        deleteCanvasSelection();
        break;
      case 'clear':
        clearCanvasSelectionFromBar();
        break;
      default:
        break;
    }
  }

  /**
   * A click on a bar button, or Enter / Space on it (the browser turns
   * those into a click with detail 0).
   *
   * After a POINTER click the result is handed to WordPress at once when
   * WordPress can hold it. The reason the keyboard path waits
   * (keepCanvasSelectionAfterAction) is the author's next key press, and
   * a pointer click has none.
   *
   * @param {MouseEvent} e The bar click.
   * @return {void}
   */
  function onCanvasSelectBarClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-csel-action]') : null;
    if (!btn) {
      return;
    }
    csel.pointerAction = e.detail > 0;
    try {
      runCanvasSelectAction(btn.getAttribute('data-csel-action'));
    } finally {
      csel.pointerAction = false;
    }
  }

  /**
   * Make the kept set the WordPress selection when WordPress can hold it
   * by now (a Move put the members next to each other; the copies of a
   * Duplicate; the one Group). The set stays kept as well, so the bar
   * stays. Not when WordPress has some other block selected: that is the
   * block cursor, and it stays where the author left it.
   *
   * @return {boolean} Whether the WordPress selection was set.
   */
  function handOverCanvasSelection() {
    var current = wp.data.select('core/block-editor').getSelectedBlockClientIds();
    var ids = canvasSelectNormalize(csel.ids);
    var inside = current.every(function (id) { return ids.indexOf(id) !== -1; });
    if (!ids.length || !inside || !canvasSelectHoldable(ids) || canvasSelectSameSet(current, ids)) {
      return false;
    }
    commitCanvasSelection(ids, 'action', true);
    return true;
  }

  /**
   * Go back from the bar to the canvas (Escape), with the selection
   * kept. This is where the keyboard path hands a set that WordPress can
   * hold to WordPress: focus is on its way into the canvas anyway, so
   * core's own focus() on a selection of several blocks takes nothing
   * from the author.
   *
   * @return {void}
   */
  function leaveCanvasSelectBar() {
    focusCanvasFromBar(!handOverCanvasSelection());
  }

  /**
   * The bar's keys: Left / Right / Home / End move between the buttons
   * (the toolbar pattern), and Escape goes back to the canvas with the
   * selection kept. Escape does ONE thing here; "Clear selection" is the
   * button that ends the set.
   *
   * @param {KeyboardEvent} e The bar keydown.
   * @return {void}
   */
  function onCanvasSelectBarKeydown(e) {
    var bar = e.currentTarget;
    csel.focusHold++;
    csel.barKey = e.key;
    if (e.repeat && (e.key === 'Enter' || e.key === ' ')) {
      // A held key is one decision. Without this, the Ctrl+Enter that
      // brought focus here would, held a moment too long, press the
      // button it landed on, and a held Enter on Delete would repeat.
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      leaveCanvasSelectBar();
      return;
    }
    var buttons = Array.prototype.slice.call(bar.querySelectorAll('[data-csel-action]'));
    var at = buttons.indexOf(document.activeElement);
    var rtl = window.getComputedStyle(bar).direction === 'rtl';
    var next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      var step = (e.key === 'ArrowRight') === !rtl ? 1 : -1;
      next = (at + step + buttons.length) % buttons.length;
    } else if (e.key === 'Home') {
      next = 0;
    } else if (e.key === 'End') {
      next = buttons.length - 1;
    }
    if (next !== -1 && buttons[next]) {
      e.preventDefault();
      buttons[next].focus();
    }
  }

  /**
   * Move focus from the canvas to the bar (Ctrl+Enter), and
   * remember where it was.
   *
   * @return {void}
   */
  function focusCanvasSelectBar() {
    var bar = document.getElementById('toolrail-csel-bar');
    if (!bar || bar.hidden) {
      return;
    }
    csel.returnFocus = boundDoc ? boundDoc.activeElement : null;
    var btn = bar.querySelector('[data-csel-action="' + csel.barAction + '"]')
      || bar.querySelector('[data-csel-action]');
    if (btn) {
      // Not focusFromEvent: its retry stands down when focus has moved
      // INSIDE the canvas since the first try, and core does move it
      // there a moment after an arrow key (from the block's text to the
      // canvas body). One run in three then left focus in the canvas
      // (measured 2026-11-14). The author asked for the bar, so the
      // retry only checks that focus is still in the canvas.
      keepCanvasSelectBarFocus(btn);
    }
  }

  /**
   * Keep the kept set true to the document and to the WordPress
   * selection. Runs on every store change, and returns at once while
   * nothing is kept or neither the blocks nor the selection moved.
   *
   *   a member left the document    it is dropped (undo, another plugin,
   *                                 a remote edit, a switched post)
   *   several blocks are selected   the author made a new selection in
   *   in WordPress, not this set    WordPress; the kept set ends
   *   the editor left visual mode   the kept set ends
   *   the members became neighbors  WordPress can hold them now, so a
   *                                 set the rail did not pin is handed
   *                                 over
   *
   * A selection of one block, or none, leaves the set alone (the block
   * cursor; see the banner).
   *
   * @return {void}
   */
  function onCanvasSelectStoreChange() {
    if (csel.applying || !csel.ids.length) {
      return;
    }
    var sel = wp.data.select('core/block-editor');
    var blocks = sel.getBlocks();
    var selected = sel.getSelectedBlockClientIds();
    var editor = wp.data.select('core/editor');
    var visual = !(editor && typeof editor.getEditorMode === 'function') || editor.getEditorMode() === 'visual';
    if (blocks === csel.lastBlocks && selected === csel.lastSelected && visual) {
      return;
    }
    csel.lastBlocks = blocks;
    csel.lastSelected = selected;

    if (!visual) {
      // Silent: core announces the editor it switched to, and a message
      // from here would replace that or be replaced by it.
      endCanvasSelection(false);
      return;
    }
    // Normalized again, not only filtered: a move made elsewhere can
    // change the members' document order, or put one member inside
    // another, and the actions rely on both rules.
    var alive = canvasSelectNormalize(csel.ids);
    if (selected.length > 1 && !canvasSelectSameSet(selected, alive)) {
      // Core announces its own selection; a second message would only
      // replace it.
      endCanvasSelection(false);
      return;
    }
    var dropped = alive.length !== csel.ids.length;
    if (!csel.pinned && alive.length && canvasSelectHoldable(alive)) {
      commitCanvasSelection(alive, 'pointer', false);
      return;
    }
    csel.ids = alive;
    if (dropped) {
      csel.pinned = csel.pinned && alive.length > 0;
      refreshCanvasSelectUi();
      announceCanvasSelection(alive.length, false);
      return;
    }
    // Same members: a move may have changed what the actions can do.
    paintCanvasSelection();
    syncCanvasSelectBar();
  }

  /** A mode that captures the canvas (the Section overview) ends the
      kept set: its outlines and bar have no place under the overlay. */
  function onCanvasSelectModeChange() {
    if (modeCapturesCanvas(railMode())) {
      cancelCanvasMarquee();
      endCanvasSelection(false);
    }
  }

  /**
   * The block rectangles of one level, in canvas DOCUMENT coordinates,
   * measured once per rectangle drag and kept for its lifetime. The
   * pointer moves many times a second; with the rectangles cached, each
   * move is arithmetic, with no layout read. Measured 2026-11-13 on a
   * document of 300 top-level blocks: 19.5 ms for the move that starts
   * the rectangle (it measures the level), then 0.2 ms median and 0.6 ms
   * at the 95th percentile for each later move, and 4.6 ms for a move
   * that changes the outline on all 300.
   *
   * @param {Object} m    The marquee state.
   * @param {string} root The parent's clientId ('' = top level).
   * @return {Object[]} [{id, left, top, right, bottom}]
   */
  function canvasMarqueeRects(m, root) {
    if (m.rects[root]) {
      return m.rects[root];
    }
    var sel = wp.data.select('core/block-editor');
    var win = m.doc.defaultView;
    var sx = win.scrollX || win.pageXOffset || 0;
    var sy = win.scrollY || win.pageYOffset || 0;
    var list = [];
    sel.getBlockOrder(root).forEach(function (id) {
      var el = m.doc.getElementById('block-' + id);
      if (!el || !canvasSelectSelectable(sel, id)) {
        return;
      }
      var r = el.getBoundingClientRect();
      if (!r.width && !r.height) {
        return;
      }
      list.push({ id: id, left: r.left + sx, top: r.top + sy, right: r.right + sx, bottom: r.bottom + sy });
    });
    m.rects[root] = list;
    return list;
  }

  /**
   * The rectangle from the press to the pointer, in canvas DOCUMENT
   * coordinates.
   *
   * @param {Object} m The marquee state.
   * @return {Object} {left, top, right, bottom}
   */
  function canvasMarqueeBox(m) {
    var win = m.doc.defaultView;
    var sx = win.scrollX || win.pageXOffset || 0;
    var sy = win.scrollY || win.pageYOffset || 0;
    return {
      left: Math.min(m.docX, m.lastX + sx),
      right: Math.max(m.docX, m.lastX + sx),
      top: Math.min(m.docY, m.lastY + sy),
      bottom: Math.max(m.docY, m.lastY + sy)
    };
  }

  /**
   * The blocks a rectangle selects, by the level rule in the banner.
   *
   * @param {Object} m   The marquee state.
   * @param {Object} box {left, top, right, bottom} in document coordinates.
   * @return {string[]} Sibling clientIds, in document order.
   */
  function canvasMarqueeHits(m, box) {
    var touches = function (b) {
      return b.left < box.right && b.right > box.left && b.top < box.bottom && b.bottom > box.top;
    };
    var root = '';
    for (var depth = 0; depth < 32; depth++) {
      var hits = canvasMarqueeRects(m, root).filter(touches);
      if (hits.length !== 1) {
        return hits.map(function (b) { return b.id; });
      }
      var only = hits[0];
      var encloses = box.left <= only.left && box.right >= only.right
        && box.top <= only.top && box.bottom >= only.bottom;
      if (encloses || !canvasMarqueeRects(m, only.id).some(touches)) {
        return [only.id];
      }
      root = only.id;
    }
    return [];
  }

  /**
   * A press on empty canvas space: remember it, and wait. Nothing is
   * prevented here, so a press that never moves is exactly today's
   * click.
   *
   * @param {PointerEvent} e        The canvas pointerdown.
   * @param {boolean}      additive The toggle modifier is held: the
   *                                rectangle adds to the selection.
   * @return {void}
   */
  function startCanvasMarquee(e, additive) {
    var doc = boundDoc;
    var win = doc.defaultView;
    var known = Object.create(null);
    // The top-level blocks before core reacts to this press: what core
    // appends for it is found against this (see activateCanvasMarquee).
    wp.data.select('core/block-editor').getBlockOrder('').forEach(function (id) {
      known[id] = true;
    });
    csel.marquee = {
      doc: doc,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      // The anchor in DOCUMENT coordinates, so the corner stays on the
      // content when the canvas scrolls under the pointer.
      docX: e.clientX + (win.scrollX || win.pageXOffset || 0),
      docY: e.clientY + (win.scrollY || win.pageYOffset || 0),
      active: false,
      additive: additive,
      baseIds: additive ? canvasSelectEffective() : [],
      known: known,
      rects: Object.create(null),
      hits: [],
      painted: ''
    };
    doc.addEventListener('pointermove', onCanvasMarqueeMove, true);
    doc.addEventListener('pointerup', onCanvasMarqueeUp, true);
    doc.addEventListener('pointercancel', cancelCanvasMarquee, true);
    doc.addEventListener('selectstart', onCanvasMarqueeSelectStart, true);
    win.addEventListener('scroll', onCanvasMarqueeScroll, true);
    // A release over the editor document (the pointer left the canvas
    // and the capture below was refused) ends the gesture too.
    document.addEventListener('pointerup', onCanvasMarqueeUp, true);
  }

  /** Remove every listener and visual a rectangle drag owns. */
  function stopCanvasMarquee(m) {
    var doc = m.doc;
    var win = doc.defaultView;
    doc.removeEventListener('pointermove', onCanvasMarqueeMove, true);
    doc.removeEventListener('pointerup', onCanvasMarqueeUp, true);
    doc.removeEventListener('pointercancel', cancelCanvasMarquee, true);
    doc.removeEventListener('selectstart', onCanvasMarqueeSelectStart, true);
    if (win) {
      win.removeEventListener('scroll', onCanvasMarqueeScroll, true);
    }
    document.removeEventListener('pointerup', onCanvasMarqueeUp, true);
    if (m.active) {
      if (doc.documentElement) {
        doc.documentElement.classList.remove('toolrail-marquee');
        try {
          doc.documentElement.releasePointerCapture(m.pointerId);
        } catch (err) {
          /* Not captured, or already released by the browser. */
        }
      }
      document.body.classList.remove('toolrail-canvas-marquee');
      var rect = document.getElementById('toolrail-canvas-marquee');
      if (rect) {
        rect.remove();
      }
    }
  }

  /**
   * The press has moved past the threshold: it is a rectangle now, and
   * the rail takes the gesture over.
   *
   *  - Core's appended paragraph goes. A press below the last block made
   *    core append an empty paragraph at pointerdown, before anyone
   *    could know this was a drag. The same narrow rule as
   *    sweepStrayDefaultBlock: a top-level block that is new since the
   *    press, is the default block type, and is unmodified.
   *  - The native selection the browser started on the press is
   *    cleared, and the canvas gets user-select: none for the drag, or
   *    the drag would also select text across the blocks it passes
   *    (which core then turns into a block selection of its own).
   *  - The pointer is captured, so the release reaches this document
   *    when it happens over a popover in the editor document or outside
   *    the canvas.
   *
   * @param {Object} m The marquee state.
   * @return {boolean} False when the gesture was given up instead.
   */
  function activateCanvasMarquee(m) {
    var sel = wp.data.select('core/block-editor');
    // Core has started a gesture of its own, or the rail is not in
    // Select any more: this press is not ours.
    if (!canvasSelectEnabled() || m.doc !== boundDoc
      || (typeof sel.isMultiSelecting === 'function' && sel.isMultiSelecting())
      || (typeof sel.isDraggingBlocks === 'function' && sel.isDraggingBlocks())) {
      csel.marquee = null;
      stopCanvasMarquee(m);
      return false;
    }
    m.active = true;

    var defaultName = typeof wp.blocks.getDefaultBlockName === 'function' ? wp.blocks.getDefaultBlockName() : '';
    if (defaultName && typeof wp.blocks.isUnmodifiedDefaultBlock === 'function') {
      var strays = sel.getBlocks().filter(function (b) {
        return !m.known[b.clientId] && b.name === defaultName && wp.blocks.isUnmodifiedDefaultBlock(b);
      }).map(function (b) { return b.clientId; });
      if (strays.length) {
        csel.applying = true;
        try {
          wp.data.dispatch('core/block-editor').removeBlocks(strays, false);
        } finally {
          csel.applying = false;
        }
      }
    }

    try {
      m.doc.defaultView.getSelection().removeAllRanges();
    } catch (err) {
      /* No selection object: nothing to clear. */
    }
    ensureCanvasStyle(m.doc);
    m.doc.documentElement.classList.add('toolrail-marquee');
    // Core's between-block "+" is a popover in the editor document; it
    // would rise under the pointer as the drag crosses a gap.
    document.body.classList.add('toolrail-canvas-marquee');
    try {
      m.doc.documentElement.setPointerCapture(m.pointerId);
    } catch (err) {
      /* No capture: the editor-document pointerup listener covers it. */
    }
    return true;
  }

  /**
   * Draw the rectangle and mark the blocks it selects, live. The
   * rectangle is drawn in the EDITOR document, over the canvas, through
   * the canvas geometry, so nothing is added to the canvas body. The
   * outlines are the same attribute the kept set uses. The WordPress
   * selection is not touched until the release.
   *
   * @param {Object} m The marquee state.
   * @return {void}
   */
  function updateCanvasMarquee(m) {
    var win = m.doc.defaultView;
    var sx = win.scrollX || win.pageXOffset || 0;
    var sy = win.scrollY || win.pageYOffset || 0;
    var box = canvasMarqueeBox(m);
    m.hits = canvasMarqueeHits(m, box);
    var shown = m.additive ? canvasSelectMerge(m.baseIds, m.hits) : m.hits;
    var signature = shown.join(',');
    if (signature !== m.painted) {
      m.painted = signature;
      paintCanvasSelection(shown);
    }

    var geo = T.getCanvasGeometry();
    if (!geo) {
      return;
    }
    var frame = geo.frameRect;
    var clampX = function (x) { return Math.min(Math.max(x, frame.left), frame.left + frame.width); };
    var clampY = function (y) { return Math.min(Math.max(y, frame.top), frame.top + frame.height); };
    var x1 = clampX(frame.left + (box.left - sx) * geo.scale);
    var x2 = clampX(frame.left + (box.right - sx) * geo.scale);
    var y1 = clampY(frame.top + (box.top - sy) * geo.scale);
    var y2 = clampY(frame.top + (box.bottom - sy) * geo.scale);
    var rect = document.getElementById('toolrail-canvas-marquee');
    if (!rect) {
      rect = document.createElement('div');
      rect.id = 'toolrail-canvas-marquee';
      rect.className = 'toolrail-canvas-marquee';
      rect.setAttribute('aria-hidden', 'true');
      document.body.appendChild(rect);
    }
    rect.style.left = x1 + 'px';
    rect.style.top = y1 + 'px';
    rect.style.width = (x2 - x1) + 'px';
    rect.style.height = (y2 - y1) + 'px';
  }

  /**
   * The pointer moved during a press on empty space. Below 5px (the
   * overview drag's threshold) nothing happens.
   *
   * @param {PointerEvent} e The canvas pointermove.
   * @return {void}
   */
  function onCanvasMarqueeMove(e) {
    var m = csel.marquee;
    if (!m || e.pointerId !== m.pointerId) {
      return;
    }
    if (e.buttons === 0) {
      // The button went up where no listener saw it.
      cancelCanvasMarquee();
      return;
    }
    m.lastX = e.clientX;
    m.lastY = e.clientY;
    if (!m.active) {
      if (Math.abs(e.clientX - m.startX) < 5 && Math.abs(e.clientY - m.startY) < 5) {
        return;
      }
      if (!activateCanvasMarquee(m)) {
        return;
      }
    }
    e.preventDefault();
    updateCanvasMarquee(m);
  }

  /** The canvas scrolled under a held pointer: the far corner is still
      at the pointer, so the rectangle is worked out again. */
  function onCanvasMarqueeScroll() {
    if (csel.marquee && csel.marquee.active) {
      updateCanvasMarquee(csel.marquee);
    }
  }

  /** No native selection may start while the rectangle is drawn. */
  function onCanvasMarqueeSelectStart(e) {
    if (csel.marquee && csel.marquee.active) {
      e.preventDefault();
    }
  }

  /**
   * The release. A press that never became a rectangle is the click it
   * always was: core has handled it, and the kept set ends with it (a
   * click on empty space clears a selection). A rectangle becomes the
   * selection, announced once.
   *
   * @param {PointerEvent} e The pointerup, from the canvas or the editor
   *                         document.
   * @return {void}
   */
  function onCanvasMarqueeUp(e) {
    var m = csel.marquee;
    if (!m || (e.pointerId !== undefined && e.pointerId !== m.pointerId)) {
      return;
    }
    csel.marquee = null;
    stopCanvasMarquee(m);
    if (!m.active) {
      if (!m.additive) {
        endCanvasSelection(true);
      }
      return;
    }
    e.preventDefault();
    csel.swallowClick = true;
    window.setTimeout(function () {
      csel.swallowClick = false;
    }, 0);
    // The rectangles were measured once for the drag. A block can move
    // during it (an image loads above it), so the hits are worked out
    // again on fresh measurements before they are committed (PR #124
    // review).
    m.rects = Object.create(null);
    m.hits = canvasMarqueeHits(m, canvasMarqueeBox(m));
    commitCanvasSelection(m.additive ? canvasSelectMerge(m.baseIds, m.hits) : m.hits, 'pointer', false);
  }

  /**
   * Give a rectangle up (Escape, a canceled pointer, a mode change): the
   * selection stays as the press found it.
   *
   * After Escape the button is still down, and its release fires a click
   * nobody made: that one click is swallowed (buttonDown). The latch ends
   * just after the release. Every other way here has no click to come (a
   * canceled pointer, a button that went up unseen, a mode change, the
   * canvas unbound), so it sets no latch: a latch left set stopped the
   * next keyboard click in the canvas, such as Enter on a link (PR #124
   * review).
   *
   * @param {boolean} [buttonDown] True only from the Escape key, while the
   *                               button is still held. A listener passes
   *                               its event here, which does not count.
   * @return {void}
   */
  function cancelCanvasMarquee(buttonDown) {
    var m = csel.marquee;
    if (!m) {
      return;
    }
    csel.marquee = null;
    stopCanvasMarquee(m);
    if (m.active) {
      paintCanvasSelection();
      if (buttonDown === true) {
        csel.swallowClick = true;
        var doc = boundDoc;
        var release = function () {
          doc.removeEventListener('pointerup', release, true);
          doc.removeEventListener('pointercancel', release, true);
          // After the click that follows the release, which is sent
          // before this timer runs.
          window.setTimeout(function () {
            csel.swallowClick = false;
          }, 0);
        };
        if (doc) {
          doc.addEventListener('pointerup', release, true);
          doc.addEventListener('pointercancel', release, true);
        }
      }
    }
  }

  /**
   * The canvas pointerdown, for the selection gestures. Bound in the
   * capture phase with the rail's other canvas handlers, and polite: it
   * leaves alone an event another listener has already canceled, never
   * stops propagation, and prevents the default only for a click it
   * turns into a toggle.
   *
   *   empty space                 may become a rectangle (Ctrl / Cmd
   *                               held: it adds to the selection)
   *   Ctrl / Cmd on a block       adds or removes that block
   *   Alt on a selected block     removes it
   *   a plain press               ends the kept set; core does the rest
   *   Shift                       never ours: core's range selection
   *
   * preventDefault() on a POINTERDOWN also suppresses the mouse events
   * that follow it (the Pointer Events rule the padding appender relies
   * on), so core's mousedown handlers do not run for a toggle: no caret
   * moves, no block drag starts, and core's click selection — which
   * collapses a selection of several blocks on ANY unshifted mousedown
   * without reading defaultPrevented — never sees it. That is why no
   * stopPropagation is needed here.
   *
   * @param {PointerEvent} e The canvas pointerdown.
   * @return {void}
   */
  function handleCanvasSelectPointerdown(e) {
    csel.swallowClick = false;
    csel.focusHold++;
    if (csel.marquee) {
      // A second press during a gesture (another button, another
      // pointer): the first one is over.
      cancelCanvasMarquee();
      csel.swallowClick = false;
    }
    if (e.defaultPrevented || e.button !== 0 || e.isPrimary === false || e.pointerType === 'touch') {
      return;
    }
    if (!canvasSelectEnabled() || e.shiftKey) {
      return;
    }
    var mac = canvasSelectIsMac();
    if (mac && e.ctrlKey) {
      // The context menu on a Mac.
      return;
    }
    var toggleKey = mac ? e.metaKey : (e.ctrlKey && !e.metaKey);
    var doc = boundDoc;

    if (canvasSelectIsEmptySpace(e, doc)) {
      if (!e.altKey) {
        startCanvasMarquee(e, toggleKey);
      }
      return;
    }

    var id = canvasSelectBlockAt(e.target);
    var sel = wp.data.select('core/block-editor');
    if (toggleKey && !e.altKey) {
      if (!id || canvasSelectIsControl(e.target) || !canvasSelectSelectable(sel, id)) {
        return;
      }
      e.preventDefault();
      toggleCanvasSelection([id], 'pointer');
      return;
    }
    if (e.altKey && !toggleKey) {
      if (!id || canvasSelectIsControl(e.target)) {
        return;
      }
      // The selected block under the pointer: the block itself, or the
      // selected block that contains it. With none, the press is not
      // ours and core handles it as a plain click.
      var base = canvasSelectEffective();
      var member = base.filter(function (other) {
        return other === id || sel.getBlockParents(id).indexOf(other) !== -1;
      })[0];
      if (!member || base.length < 2) {
        return;
      }
      e.preventDefault();
      commitCanvasSelection(base.filter(function (other) { return other !== member; }), 'pointer', false);
      return;
    }
    if (!toggleKey && !e.altKey) {
      // A plain press selects something else, the way a plain click
      // replaces a selection anywhere. Core does the selecting.
      endCanvasSelection(true);
    }
  }

  /**
   * Swallow the ONE click that follows a rectangle. The browser fires it
   * on the nearest common ancestor of the press and the release, which
   * for a rectangle is the root block list or the canvas body, and core
   * has click handlers on the canvas body that act on exactly that
   * target and do not read defaultPrevented: in the template-locked
   * rendering mode, useSelectNearestEditableBlock selects the block
   * nearest the pointer, which would replace the selection the
   * rectangle just made (editor.js, WordPress 7.1.3; read, not measured
   * — the test site renders posts in post-only mode, where that handler
   * is off). So this one event is stopped in the capture phase. It is a
   * click nobody made: the gesture was a drag.
   *
   * @param {MouseEvent} e The canvas click.
   * @return {void}
   */
  function handleCanvasSelectClick(e) {
    if (!csel.swallowClick) {
      return;
    }
    csel.swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  }

  /**
   * The canvas keys for the selection. Bound after handleCanvasKeydown,
   * so an Escape that disarmed a tool is already marked.
   *
   *   Ctrl+Space (Cmd+Space)      add the selected block(s) to the kept
   *                               set, or remove them: the keyboard form
   *                               of Ctrl+click
   *   Ctrl+Enter (Cmd+Enter)      while a set is kept and no tool is
   *                               armed: go to the bar with the group
   *                               actions
   *   Escape                      cancel a rectangle in flight; else
   *                               clear the kept set
   *
   * The operating system can take Ctrl+Space (and Cmd+Space) before the
   * page sees it; the block Options menu item is the same toggle for
   * that case (canvasSelectMenuAction).
   *
   * Extending a selection to the next block is core's own Shift+Arrow,
   * and clearing a WordPress selection is core's own Escape; neither is
   * touched. Checked on WordPress 7.1.3 against the shortcuts in the
   * core/keyboard-shortcuts store (every category), the rich-text
   * shortcuts the format library registers (Ctrl+B, I, U, K,
   * Ctrl+Shift+K, the two access-key formats, and Ctrl+Shift+Space for a
   * non-breaking space) and the rail's own canvas keys: none uses
   * Ctrl+Space, and Ctrl+Enter is the rail's own key, live only while a
   * tool is armed (insertOnKey takes it first, and stops it).
   *
   * The bar key was Ctrl+Shift+Space for a day. That is core's
   * non-breaking space, which the shortcuts store does not list; it
   * showed up as an e2e test that lost the bar one run in three
   * (2026-11-14). With no tool armed, core treats Ctrl+Enter as a plain
   * Enter, so the only thing given up is a second way to split a block,
   * and only while a set is kept.
   *
   * Ctrl+Enter is STOPPED as well as prevented, as insertOnKey does: with
   * a block's wrapper focused, core's selected-block handler inserts a
   * paragraph after the block on any Enter without reading
   * defaultPrevented (useEventHandlers in block-editor.js).
   *
   * @param {KeyboardEvent} e The canvas keydown.
   * @return {void}
   */
  function handleCanvasSelectKeydown(e) {
    if (csel.guardKey) {
      // A key held on a bar button (Enter on Delete, say) moved focus
      // into the canvas, and its auto-repeat now arrives HERE, where
      // Enter splits a block and Escape would clear the selection. A
      // repeat is not a new decision, so it is stopped; the first fresh
      // key ends the guard.
      if (e.repeat && e.key === csel.guardKey) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      csel.guardKey = '';
    }
    if (e.defaultPrevented || e.isComposing) {
      return;
    }
    if (e.key === 'Escape') {
      if (csel.marquee && csel.marquee.active) {
        // The drag is the rail's own gesture: this Escape ends it and
        // does nothing else.
        e.preventDefault();
        e.stopPropagation();
        cancelCanvasMarquee(true);
        return;
      }
      if (csel.escapeEvent === e) {
        csel.escapeEvent = null;
        return;
      }
      if (canvasSelectEnabled()) {
        endCanvasSelection(true);
      }
      return;
    }
    var isEnter = e.key === 'Enter';
    if (!isEnter && e.key !== ' ' && e.code !== 'Space') {
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.repeat || !canvasSelectEnabled()) {
      return;
    }
    if (isEnter) {
      if (csel.ids.length) {
        e.preventDefault();
        e.stopPropagation();
        focusCanvasSelectBar();
      }
      return;
    }
    var selected = wp.data.select('core/block-editor').getSelectedBlockClientIds();
    if (!selected.length) {
      return;
    }
    e.preventDefault();
    toggleCanvasSelection(selected.slice(), 'keyboard');
  }

  /**
   * Bind the selection handlers to a canvas document (from bindCanvas),
   * and bring the outlines and the bar back after the canvas document
   * was replaced.
   *
   * @param {Document} doc The canvas document.
   * @return {void}
   */
  function bindCanvasSelect(doc) {
    doc.addEventListener('pointerdown', handleCanvasSelectPointerdown, true);
    doc.addEventListener('click', handleCanvasSelectClick, true);
    doc.addEventListener('keydown', handleCanvasSelectKeydown, true);
    if (!csel.modeBound) {
      csel.modeBound = true;
      window.addEventListener('toolrail:mode-changed', onCanvasSelectModeChange);
    }
    if (csel.ids.length) {
      refreshCanvasSelectUi();
    }
  }

  /**
   * Remove the selection handlers from a canvas document bindCanvasSelect
   * bound earlier, and end any rectangle that was in flight on it.
   *
   * @param {Document} doc The previously bound document.
   * @return {void}
   */
  function unbindCanvasSelect(doc) {
    cancelCanvasMarquee();
    csel.swallowClick = false;
    doc.removeEventListener('pointerdown', handleCanvasSelectPointerdown, true);
    doc.removeEventListener('click', handleCanvasSelectClick, true);
    doc.removeEventListener('keydown', handleCanvasSelectKeydown, true);
  }

  // -------------------------------------------------------------------
  // Flyouts (APG: parent button aria-haspopup; ArrowRight/click opens,
  // arrows move within, Escape returns focus to the parent)
  // -------------------------------------------------------------------

  // The open flyout: {node, parentBtn, toolbar}, or null. One for the
  // page, not one for each toolbar (see newToolbar): a flyout takes focus
  // when it opens and closes when focus leaves it, so two cannot be open
  // together, and its three document listeners are single functions that
  // read this one record. The record names the toolbar the menu hangs
  // in.
  T.openFlyout = null;

  /**
   * Close the open flyout, release its three document listeners, and reset
   * the parent button's expanded state.
   *
   * @param {boolean} refocusParent Return focus to the parent button —
   *                                true for a keyboard dismissal, false
   *                                when focus has already moved elsewhere.
   * @return {void}
   */
  function closeFlyout(refocusParent) {
    if (!T.openFlyout) {
      return;
    }
    var parentBtn = T.openFlyout.parentBtn;
    T.openFlyout.node.remove();
    document.removeEventListener('mousedown', onDocMousedown, true);
    document.removeEventListener('keydown', onFlyoutKeydown, true);
    document.removeEventListener('focusin', onFlyoutFocusin, true);
    parentBtn.setAttribute('aria-expanded', 'false');
    T.openFlyout = null;
    T.syncLayers();
    if (refocusParent) {
      parentBtn.focus();
    }
  }

  /**
   * Dismiss the flyout on a press outside it. Without refocus: the press
   * is taking focus somewhere itself.
   *
   * @param {MouseEvent} e The document mousedown.
   * @return {void}
   */
  function onDocMousedown(e) {
    if (T.openFlyout && !T.openFlyout.node.contains(e.target) && e.target !== T.openFlyout.parentBtn) {
      closeFlyout(false);
    }
  }

  // Same contract as the settings dialog, for the same reason: menu items
  // are tabIndex -1, so one Tab walked out of the flyout and left it open
  // with the parent still reporting aria-expanded="true" — and Escape,
  // bound to the menu node, could no longer reach it. Both listeners sit
  // on the document for as long as the flyout is open.
  function onFlyoutKeydown(e) {
    if (e.key !== 'Escape' || !T.openFlyout) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    closeFlyout(true);
  }

  /**
   * Close the flyout once focus leaves it — the Tab case the Escape
   * listener above cannot catch, since a menu item is tabIndex -1 and Tab
   * walks straight out of the menu.
   *
   * @param {FocusEvent} e The document focusin.
   * @return {void}
   */
  function onFlyoutFocusin(e) {
    if (!T.openFlyout) {
      return;
    }
    if (T.openFlyout.node.contains(e.target) || e.target === T.openFlyout.parentBtn) {
      return;
    }
    closeFlyout(false);
  }

  /**
   * Activate a flyout item: run its action, or arm it. A dimmed item is
   * inert here only — it keeps its place in the arrow order and still
   * announces, so the menu never changes shape under a screen reader.
   *
   * @param {Object} child A flyout child descriptor.
   * @return {void}
   */
  function activateChild(child) {
    if (!toolAvailable(child)) {
      // Dimmed (aria-disabled) items stay in the menu's arrow order and
      // keep announcing; only the action is inert.
      return;
    }
    if (child.onActivate) {
      // No refocus: the action may move focus itself (a panel it opens).
      closeFlyout(false);
      try {
        child.onActivate();
      } catch (e) {
        warn('tool "' + child.id + '" onActivate threw: ' + e.message);
      }
      T.syncPressed(true);
      return;
    }
    // Arming: focus goes back to the button that opened the menu. Without
    // it, removing the menu dropped focus to the page body, so the keyboard
    // author who armed a flyout tool had lost their place (#37).
    closeFlyout(true);
    setActiveTool(child.id);
  }

  /**
   * How far the other toolbars on a toolbar's edge reach past its own
   * region toward the canvas, in px. 0 when it has the edge to itself,
   * and for a floating toolbar.
   *
   * @param {Object}  tb          The toolbar.
   * @param {DOMRect} wrapperRect Its region's rect.
   * @return {number} The distance, 0 or more.
   */
  function stackExtent(tb, wrapperRect) {
    var dock = tb.position.dock;
    var extent = 0;
    if (dock === 'float') {
      return 0;
    }
    T.toolbars.forEach(function (other) {
      var region = other !== tb && other.position.dock === dock ? document.getElementById(other.regionId) : null;
      if (!region) {
        return;
      }
      var r = region.getBoundingClientRect();
      var reach = dock === 'top' ? r.bottom - wrapperRect.bottom
        : dock === 'bottom' ? wrapperRect.top - r.top
          : dock === 'right' ? wrapperRect.left - r.left
            : r.right - wrapperRect.right;
      extent = Math.max(extent, Math.round(reach));
    });
    return extent;
  }

  /**
   * Place a floating surface (a flyout, or the settings dialog) beside the
   * rail, opening AWAY from the docked edge: to the right of a left rail,
   * to the left of a right rail, DOWN from a top rail, UP from a bottom
   * one. A flyout with no room on that side in the window opens on the
   * other side of its toolbar instead. The surface must already be in
   * the DOM — the overflow clamp measures it.
   *
   * @param {Object}      tb      The toolbar the surface belongs to; its
   *                              dock gives the direction.
   * @param {HTMLElement} node    The surface.
   * @param {HTMLElement} anchor  Button to align with (falls back to the rail).
   * @param {HTMLElement} wrapper The positioned region the surface lives in.
   * @param {boolean}     pastStack Open past every toolbar on this edge
   *                              (the dialogs), not only past this one.
   */
  function placeSurface(tb, node, anchor, wrapper, pastStack) {
    var wrapperRect = wrapper.getBoundingClientRect();
    var anchorRect = anchor ? anchor.getBoundingClientRect() : wrapperRect;

    node.style.top = '';
    node.style.right = '';
    node.style.bottom = '';
    node.style.left = '';

    // 4px clear of the region. A dialog also clears the other toolbars on
    // the same edge (pastStack): it stays open while the author changes
    // them, so it must not cover them. A flyout opens next to its own
    // toolbar; a menu far from its button is worse than a menu over a
    // neighbor for a moment.
    var gap = 'calc(100% + ' + (4 + (pastStack ? stackExtent(tb, wrapperRect) : 0)) + 'px)';
    if (tb.position.dock === 'top') {
      node.style.top = gap;
      node.style.left = Math.max(0, anchorRect.left - wrapperRect.left) + 'px';
    } else if (tb.position.dock === 'bottom') {
      node.style.bottom = gap;
      node.style.left = Math.max(0, anchorRect.left - wrapperRect.left) + 'px';
    } else if (tb.position.dock === 'right') {
      node.style.right = gap;
      node.style.top = Math.max(0, anchorRect.top - wrapperRect.top) + 'px';
    } else {
      node.style.left = gap;
      node.style.top = Math.max(0, anchorRect.top - wrapperRect.top) + 'px';
    }

    // Pull back anything that would run off the viewport. Horizontal docks
    // clamp sideways, vertical docks clamp downward.
    var rect = node.getBoundingClientRect();
    if (isVertical(tb)) {
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

    var maxRight = window.innerWidth - 8;
    var maxBottom = window.innerHeight - 8;
    var dock = tb.position.dock;
    // Whether a box runs off the window on the dock's own axis.
    var offAxis = function (box) {
      return dock === 'right' ? box.left < 8
        : dock === 'top' ? box.bottom > maxBottom
          : dock === 'bottom' ? box.top < 8
            : box.right > maxRight;
    };

    // A flyout on the innermost of a stack of toolbars can open beyond
    // the window: four wide toolbars on the left take 800px, and focus
    // went into a menu off screen. It flips to the other side of its own
    // toolbar, still next to its button, over the toolbars nearer the
    // edge (PR #126 review, CodeRabbit). When that side does not fit
    // either, it goes back and the pull-back below applies.
    rect = node.getBoundingClientRect();
    if (!pastStack && offAxis(rect)) {
      var flipGap = 'calc(100% + 4px)';
      var side = dock === 'right' ? ['right', 'left']
        : dock === 'top' ? ['top', 'bottom']
          : dock === 'bottom' ? ['bottom', 'top']
            : ['left', 'right'];
      node.style[side[0]] = '';
      node.style[side[1]] = flipGap;
      var flipped = node.getBoundingClientRect();
      var flipOff = dock === 'right' ? flipped.right > maxRight
        : dock === 'top' ? flipped.top < 8
          : dock === 'bottom' ? flipped.bottom > maxBottom
            : flipped.left < 8;
      if (flipOff) {
        node.style[side[1]] = '';
        node.style[side[0]] = gap;
      }
    }

    // A dialog that opens past a stack of toolbars can start beyond the
    // window: four wide toolbars on the left take 800px. The dialog is the
    // way to undo that layout, so it is pulled back into the window on
    // the dock's own axis too, over part of the stack when it must
    // (PR #126 review, CodeRabbit). A flyout that fits on neither side of
    // its toolbar gets the same pull-back.
    rect = node.getBoundingClientRect();
    if (offAxis(rect)) {
      if (dock === 'right') {
        node.style.left = '';
        node.style.right = Math.round(wrapperRect.right - 8 - rect.width) + 'px';
      } else if (dock === 'top') {
        node.style.bottom = '';
        node.style.top = Math.round(maxBottom - rect.height - wrapperRect.top) + 'px';
      } else if (dock === 'bottom') {
        node.style.top = '';
        node.style.bottom = Math.round(wrapperRect.bottom - 8 - rect.height) + 'px';
      } else {
        node.style.right = '';
        node.style.left = Math.round(Math.max(8, maxRight - rect.width) - wrapperRect.left) + 'px';
      }
    }
  }

  /**
   * Open a tool's flyout menu beside the rail and move focus into it. The
   * menu is built fresh per open, placed by placeSurface(), and holds
   * document-level listeners for the whole time it is up.
   *
   * @param {Object}      tb      The toolbar the button is in.
   * @param {HTMLElement} btn     The parent tool button.
   * @param {Object}      tool    Its railModel() entry.
   * @param {HTMLElement} wrapper The positioned region the menu lives in.
   * @return {void}
   */
  function openFlyoutFor(tb, btn, tool, wrapper) {
    closeFlyout(false);
    if (!tool.children.length) {
      return;
    }

    var menu = document.createElement('div');
    menu.className = 'toolrail-flyout';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', tool.label);

    tool.children.forEach(function (child) {
      if (child.separatorBefore) {
        var sep = document.createElement('div');
        sep.className = 'toolrail-flyout-separator';
        sep.setAttribute('role', 'separator');
        menu.appendChild(sep);
      }
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'toolrail-flyout-item';
      // A pick-one child (a saved set in the Saved sets menu, #93) is a
      // radio item: exactly one choice is current, or none.
      if (child.radio) {
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', child.checked ? 'true' : 'false');
      // A toggle child (onActivate + isActive — a provider's "Snap to
      // guides") is a checkbox item, so its state is perceivable: a
      // plain menuitem has no way to say "on". The flyout closes on
      // activation, so the state is read once, here, per open.
      } else if (isToggleTool(child)) {
        item.setAttribute('role', 'menuitemcheckbox');
        var checked;
        try {
          checked = !!child.isActive();
        } catch (err) {
          checked = false;
        }
        item.setAttribute('aria-checked', String(checked));
      } else {
        item.setAttribute('role', 'menuitem');
      }
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
      if (!toolAvailable(child)) {
        // aria-disabled, never `disabled`: a natively disabled menuitem
        // drops out of the arrow order and stops announcing its name.
        item.setAttribute('aria-disabled', 'true');
        item.title = child.label + ' — ' + unavailableReason();
      }
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
    placeSurface(tb, menu, btn, wrapper);
    btn.setAttribute('aria-expanded', 'true');
    T.openFlyout = { node: menu, parentBtn: btn, toolbar: tb };
    T.syncLayers();
    document.addEventListener('mousedown', onDocMousedown, true);
    document.addEventListener('keydown', onFlyoutKeydown, true);
    document.addEventListener('focusin', onFlyoutFocusin, true);

    var first = menu.querySelector('.toolrail-flyout-item');
    if (first) {
      first.focus();
    }
  }

  // Shared with the other files of the rail (see editor-rail-core.js).
  T.isArmingTool = isArmingTool;
  T.isToggleTool = isToggleTool;
  T.railMode = railMode;
  T.toolAvailable = toolAvailable;
  T.unavailableReason = unavailableReason;
  T.buttonAvailable = buttonAvailable;
  T.announceModeChange = announceModeChange;
  T.setActiveTool = setActiveTool;
  T.makeBlocksFor = makeBlocksFor;
  T.canvasDoc = canvasDoc;
  T.bindCanvas = bindCanvas;
  T.hidesCoreInserterWhileArmed = hidesCoreInserterWhileArmed;
  T.markCanvasArmed = markCanvasArmed;
  T.csel = csel;
  T.canvasSelectMenuAction = canvasSelectMenuAction;
  T.onCanvasSelectStoreChange = onCanvasSelectStoreChange;
  T.closeFlyout = closeFlyout;
  T.placeSurface = placeSurface;
  T.openFlyoutFor = openFlyoutFor;

  // This file ran to its end. The next file checks this number.
  T.loaded = 3;
})(window.wp);
