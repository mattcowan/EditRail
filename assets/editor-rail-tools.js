/**
 * EditRail, part 3 of 7 (editor-rail-tools.js).
 *
 * Armed tools: the armed-tool state, availability (R9), insertion
 * into the canvas, and the flyouts.
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
    var region = document.getElementById('toolrail-region');
    if (region && region.contains(t)) {
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
    if (!insertOnKey(e)) {
      disarmOnEscape(e);
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
    var region = document.getElementById('toolrail-region');
    if (e && e.target && region && region.contains(e.target)) {
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
   * Bind the canvas handlers, and inject the armed-cursor style into the
   * canvas document (a style in the editor document cannot reach inside
   * the iframe). Re-run from the mount observer and cheap to repeat: it
   * returns at once unless the document IDENTITY changed, which is the
   * case that matters, because the editor replaces the iframe's document
   * after the element is inserted.
   */
  function bindCanvas() {
    var doc = canvasDoc();
    if (!doc || doc === boundDoc) {
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
    if (doc !== document && doc.head && !doc.getElementById('toolrail-canvas-style')) {
      var style = doc.createElement('style');
      style.id = 'toolrail-canvas-style';
      style.textContent = 'html.toolrail-armed, html.toolrail-armed * { cursor: crosshair !important; }';
      doc.head.appendChild(style);
    }
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
  // Flyouts (APG: parent button aria-haspopup; ArrowRight/click opens,
  // arrows move within, Escape returns focus to the parent)
  // -------------------------------------------------------------------

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
    T.syncLayer();
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

    if (T.position.dock === 'top') {
      node.style.top = 'calc(100% + 4px)';
      node.style.left = Math.max(0, anchorRect.left - wrapperRect.left) + 'px';
    } else if (T.position.dock === 'bottom') {
      node.style.bottom = 'calc(100% + 4px)';
      node.style.left = Math.max(0, anchorRect.left - wrapperRect.left) + 'px';
    } else if (T.position.dock === 'right') {
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

  /**
   * Open a tool's flyout menu beside the rail and move focus into it. The
   * menu is built fresh per open, placed by placeSurface(), and holds
   * document-level listeners for the whole time it is up.
   *
   * @param {HTMLElement} btn     The parent tool button.
   * @param {Object}      tool    Its railModel() entry.
   * @param {HTMLElement} wrapper The positioned region the menu lives in.
   * @return {void}
   */
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
    placeSurface(menu, btn, wrapper);
    btn.setAttribute('aria-expanded', 'true');
    T.openFlyout = { node: menu, parentBtn: btn };
    T.syncLayer();
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
  T.closeFlyout = closeFlyout;
  T.placeSurface = placeSurface;
  T.openFlyoutFor = openFlyoutFor;

  // This file ran to its end. The next file checks this number.
  T.loaded = 3;
})(window.wp);
