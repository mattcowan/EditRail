/**
 * EditRail, part 4 of 7 (editor-rail-settings.js).
 *
 * The Toolbar settings dialog with its Shared sets list, saved-set
 * import and export, and the Help panel.
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
  if (!T || T.loaded !== 3) {
    return;
  }

  // From editor-rail-core.js.
  var __ = T.__;
  var _n = T._n;
  var sprintf = T.sprintf;
  var speak = T.speak;
  var SLOTS_KEY = T.SLOTS_KEY;
  var HELP_HIDDEN_KEY = T.HELP_HIDDEN_KEY;
  var HIDE_CORE_INSERTER_KEY = T.HIDE_CORE_INSERTER_KEY;
  var WIDE_TOGGLE_KEY = T.WIDE_TOGGLE_KEY;
  var SETS_BUTTON_HIDDEN_KEY = T.SETS_BUTTON_HIDDEN_KEY;
  var TOOLBARS_BUTTON_HIDDEN_KEY = T.TOOLBARS_BUTTON_HIDDEN_KEY;
  var MAX_TOOLBARS = T.MAX_TOOLBARS;
  var readKey = T.readKey;
  var writeKey = T.writeKey;
  var DOCKS = T.DOCKS;
  var DOCK_LABELS = T.DOCK_LABELS;
  var mainToolbar = T.mainToolbar;
  var TOOLBAR_NAME_MAX = T.TOOLBAR_NAME_MAX;
  var toolbarById = T.toolbarById;
  var toolbarLabel = T.toolbarLabel;
  var disarmedMessage = T.disarmedMessage;
  var joinMessages = T.joinMessages;
  var addToolbar = T.addToolbar;
  var renameToolbar = T.renameToolbar;
  var deleteToolbar = T.deleteToolbar;
  var setToolbarHidden = T.setToolbarHidden;
  var canvasNarrowMessage = T.canvasNarrowMessage;
  var renderCustomIcon = T.renderCustomIcon;
  var isWide = T.isWide;
  var isWideToggleShown = T.isWideToggleShown;
  var setWide = T.setWide;
  var SIDEBAR_DEFAULT_WIDTH = T.SIDEBAR_DEFAULT_WIDTH;
  var SIDEBAR_MAX_WIDTH = T.SIDEBAR_MAX_WIDTH;
  var SIDEBAR_BIG_STEP = T.SIDEBAR_BIG_STEP;
  var isSidebarResizeOn = T.isSidebarResizeOn;
  var setSidebarResize = T.setSidebarResize;
  var sidebarMaxWidth = T.sidebarMaxWidth;
  var sidebarWidth = T.sidebarWidth;
  var sidebarWidthText = T.sidebarWidthText;
  var setSidebarWidth = T.setSidebarWidth;
  var applyTypedSidebarWidth = T.applyTypedSidebarWidth;
  var setStepButtonInert = T.setStepButtonInert;
  var isStepButtonInert = T.isStepButtonInert;
  var APPEARANCE_MODES = T.APPEARANCE_MODES;
  var APPEARANCE_LABELS = T.APPEARANCE_LABELS;
  var hexToRgb = T.hexToRgb;
  var contrastRatio = T.contrastRatio;
  var deriveAppearanceTokens = T.deriveAppearanceTokens;
  var loadAppearance = T.loadAppearance;
  var saveAppearance = T.saveAppearance;
  var applyAppearance = T.applyAppearance;

  // From editor-rail-registry.js.
  var attrValue = T.attrValue;
  var DEFAULT_SLOTS = T.DEFAULT_SLOTS;
  var normalizeSlots = T.normalizeSlots;
  var loadSlots = T.loadSlots;
  var saveSlots = T.saveSlots;
  var pinBlock = T.pinBlock;
  var unpinBlock = T.unpinBlock;
  var moveSlot = T.moveSlot;
  var rerenderToolbars = T.rerenderToolbars;
  var PIN_META_LIMITS = T.PIN_META_LIMITS;
  var DASHICON_NAMES = T.DASHICON_NAMES;
  var isValidPinIcon = T.isValidPinIcon;
  var normalizePinMeta = T.normalizePinMeta;
  var hasAuthorFields = T.hasAuthorFields;
  var getPinMeta = T.getPinMeta;
  var setPinMeta = T.setPinMeta;
  var loadConfigMeta = T.loadConfigMeta;
  var normalizeSetMeta = T.normalizeSetMeta;
  var setConfigMeta = T.setConfigMeta;
  var loadConfigs = T.loadConfigs;
  var persistConfigs = T.persistConfigs;
  var saveConfig = T.saveConfig;
  var loadConfig = T.loadConfig;
  var deleteConfig = T.deleteConfig;
  var configLoadedMessage = T.configLoadedMessage;
  var toolbarShownMessage = T.toolbarShownMessage;
  var isSetSlotName = T.isSetSlotName;
  var refreshSharedSets = T.refreshSharedSets;
  var ownSharedCopy = T.ownSharedCopy;
  var listedSharedSets = T.listedSharedSets;
  var ownSetShareControls = T.ownSetShareControls;
  var buildSharedSetRow = T.buildSharedSetRow;
  var PATTERN_SLOT_PREFIX = T.PATTERN_SLOT_PREFIX;
  var isPatternSlot = T.isPatternSlot;
  var allPatterns = T.allPatterns;
  var findPattern = T.findPattern;
  var patternCatalogReady = T.patternCatalogReady;

  // From editor-rail-tools.js.
  var hidesCoreInserterWhileArmed = T.hidesCoreInserterWhileArmed;
  var markCanvasArmed = T.markCanvasArmed;
  var closeFlyout = T.closeFlyout;
  var placeSurface = T.placeSurface;

  // -------------------------------------------------------------------
  // Toolbar settings dialog — choose which blocks show as quick slots,
  // reorder them, and save/load named sets. All of it is a per-user
  // account preference, never site-wide settings or post data. The one
  // exception is a shared set (#98): the plugin's own record on the site,
  // never an authored post (see the "Shared sets" block).
  // -------------------------------------------------------------------

  T.settingsOpen = false;
  // The id of the toolbar the dialog's toolbar sections act on: its pins,
  // its position, its tool names, and the saved set that loads into it
  // (#95). Module state like editingSlot, so a rebuild keeps the choice.
  // It goes back to the first toolbar when the chosen one is deleted.
  T.settingsToolbarId = 'main';
  // The pinned slot whose inline Edit form is open ('' = none). Module
  // state, not DOM state, so a rebuild from elsewhere (a drag onto the
  // rail while the form is open) re-renders the form instead of
  // discarding it — refreshSettings preserves the typed values too.
  var editingSlot = '';
  // The open Edit form's refused-icon message ('' = none). Module state
  // for the same reason: a rebuild re-renders the form, and a field that
  // was just refused must come back still marked, with its message — not
  // looking accepted with the same bad value in it (PR review 2026-09-04,
  // finding 5). Cleared when the author edits the field or the form closes.
  var editFormError = '';
  // The Icon field's Dashicon browser: open or not, and its search text.
  // Module state like the form itself, so a rebuild re-renders the
  // browser with the same query instead of dropping it.
  var iconBrowserOpen = false;
  var iconBrowserQuery = '';
  // How many chips the browser draws at once. All 349 icons as buttons
  // are cheap to build but not to read; past this the count line asks
  // the author to narrow the search.
  var ICON_BROWSER_LIMIT = 72;

  /**
   * Every block type the author may pin. Parent-restricted types are left
   * out: armed insertion lands at the document root, where a block like a
   * column cannot go, so pinning one would only produce a tool that always
   * refuses.
   *
   * @return {Array<Object>} Block type objects.
   */
  function insertableBlockTypes() {
    return wp.blocks.getBlockTypes().filter(function (t) {
      // Parent-restricted blocks (core/column etc.) can't insert at the
      // document root, which is where armed insertion lands them.
      return t && t.title && !t.parent && (!t.supports || t.supports.inserter !== false);
    });
  }

  /**
   * The open settings dialog, or null when it is closed.
   *
   * @return {HTMLElement|null} The dialog node, or null.
   */
  function settingsNode() {
    return document.querySelector('.toolrail-settings');
  }

  /**
   * The toolbar the dialog's toolbar sections act on (settingsToolbarId).
   *
   * @return {Object} The toolbar; the first toolbar when the id is gone.
   */
  function settingsToolbar() {
    return toolbarById(T.settingsToolbarId) || mainToolbar;
  }

  /**
   * Place each open dialog again. The dialogs open past every toolbar on
   * the first toolbar's edge (placeSurface's pastStack), so a different
   * toolbar that arrives on that edge, leaves it, or changes width moves
   * where they must sit. They hang in the first toolbar's region, which
   * that change does not rebuild, so nothing else places them (#95).
   *
   * @return {void}
   */
  function placeOpenDialogs() {
    var wrapper = document.getElementById(mainToolbar.regionId);
    if (!wrapper) {
      return;
    }
    var settings = T.settingsOpen ? settingsNode() : null;
    if (settings && !settings.classList.contains('toolrail-adddialog')) {
      placeSurface(mainToolbar, settings, gearButton(), wrapper, true);
    }
    var help = T.helpOpen ? helpNode() : null;
    if (help) {
      placeSurface(mainToolbar, help, helpButton() || gearButton(), wrapper, true);
    }
    var add = T.addDialogOpen ? T.addDialogNode() : null;
    if (add) {
      placeSurface(mainToolbar, add, gearButton(), wrapper, true);
    }
  }

  /**
   * The rail's settings button — the dialog's anchor and its focus-return
   * target. Null before the rail is built.
   *
   * @return {HTMLElement|null} The button, or null.
   */
  function gearButton() {
    var rail = document.getElementById(mainToolbar.railId);
    return rail ? rail.querySelector('[data-tool="settings"]') : null;
  }

  /** Keep an open dialog truthful when slots change OUTSIDE it (a drag
      onto the rail, the block menu's pin item). Its own buttons refresh
      explicitly with a focus target, which runs after this and wins. */
  function onToolsUpdatedWhileOpen() {
    if (T.settingsOpen) {
      refreshSettings();
    }
  }

  /**
   * Close the settings dialog and unwind everything it owns: the inline
   * Edit form, the icon browser, the three document listeners, the tools
   * subscription, and every transient status message. The messages are
   * dropped deliberately — an in-flight file read that resolved after the
   * dialog closed used to surface its message, out of context, the next
   * time settings opened.
   *
   * @param {boolean} refocusGear Return focus to the gear button.
   * @return {void}
   */
  function closeSettings(refocusGear) {
    var node = settingsNode();
    if (node) {
      node.remove();
    }
    T.settingsOpen = false;
    editingSlot = '';
    editFormError = '';
    iconBrowserOpen = false;
    iconBrowserQuery = '';
    T.syncLayers();
    // Drop any message that never got rendered — closing the dialog
    // before an in-flight file read resolves used to strand it here, and
    // it then surfaced out of context the NEXT time settings was opened.
    // The appearance section's transient follows the same rule.
    T.settingsStatus = '';
    appearanceStatus = '';
    pinnedStatus = '';
    toolbarsStatus = '';
    // The next open starts on the first toolbar, whose gear opened it. A
    // control that opens the dialog for a different toolbar chooses it
    // itself (openSettingsFor).
    T.settingsToolbarId = mainToolbar.id;
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

  /**
   * Dismiss the dialog on a press outside it and outside the gear.
   *
   * @param {MouseEvent} e The document mousedown.
   * @return {void}
   */
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

  /**
   * Escape unwinds ONE level per press, the way nested disclosures are
   * expected to: the icon browser first, then the Edit form, then the
   * dialog. Bound to the DOCUMENT rather than the dialog node, because a
   * single Tab can put focus in the canvas and Escape still has to reach.
   *
   * @param {KeyboardEvent} e The document keydown.
   * @return {void}
   */
  function onSettingsKeydown(e) {
    if (e.key !== 'Escape' || !T.settingsOpen) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // Escape unwinds ONE level per press, the way nested disclosures are
    // expected to: focus inside the Icon field's browser closes the
    // browser (focus back on Browse icons); inside the Edit form, closes
    // the form (focus back on Edit); anywhere else, closes the dialog.
    var form = editingSlot ? document.getElementById('toolrail-editform') : null;
    if (form && form.contains(e.target)) {
      // The browser is the innermost open disclosure of the form, so it
      // goes first wherever in the form focus is — on the Browse icons
      // button that opened it included (PR review 2026-09-05, finding 8).
      if (iconBrowserOpen) {
        closeIconBrowser();
        return;
      }
      closeEditForm();
      return;
    }
    closeSettings(true);
  }

  /** Close the inline Edit form and return focus to the row's Edit button. */
  function closeEditForm() {
    var name = editingSlot;
    editingSlot = '';
    editFormError = '';
    iconBrowserOpen = false;
    iconBrowserQuery = '';
    refreshSettings(pinnedRowSelector(name) + '.toolrail-settings-edit');
  }

  /**
   * Close the Icon field's Dashicon browser. Focus goes to the control
   * named, or to Browse icons — the button that opened it.
   */
  function closeIconBrowser(focusSelector) {
    iconBrowserOpen = false;
    iconBrowserQuery = '';
    refreshSettings(focusSelector || '.toolrail-settings-iconbrowse');
  }

  /**
   * A selector prefix for one pinned row in the dialog, used to aim focus
   * at a control inside that row after a rebuild. The trailing space is
   * load-bearing — callers append a descendant class.
   *
   * @param {string} name The slot name.
   * @return {string} The selector prefix.
   */
  function pinnedRowSelector(name) {
    return '.toolrail-settings-pinnedrow[data-block="' + attrValue(name) + '"] ';
  }

  /**
   * Close the dialog once focus genuinely leaves it — the Tab case the
   * outside-press listener cannot see. Focus is NOT pulled back: the
   * author is going somewhere on purpose. The rebuild guard matters,
   * because refreshSettings empties and refills the body and that focus
   * churn is the rail's own, not the author leaving.
   *
   * @param {FocusEvent} e The document focusin.
   * @return {void}
   */
  function onSettingsFocusin(e) {
    // refreshSettings empties and rebuilds the body; the focus churn in
    // between is ours, not the author leaving.
    if (!T.settingsOpen || refreshingSettings) {
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

  /**
   * A bare element with an optional class — the dialog builds a lot of
   * these, and the helper keeps each section readable.
   *
   * @param {string} tag       Element name.
   * @param {string} className Optional class.
   * @return {HTMLElement} The element.
   */
  function settingsRow(tag, className) {
    var el = document.createElement(tag);
    if (className) {
      el.className = className;
    }
    return el;
  }

  /**
   * A dialog push button. type="button" is explicit: these live inside a
   * form element, where the default would submit it.
   *
   * @param {string}   label     Visible text, which is also the name.
   * @param {Function} onClick   Click handler.
   * @param {string}   className Optional extra class.
   * @return {HTMLButtonElement} The button.
   */
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
   * Rebuild the dialog's content, preserving its text fields, and hand
   * focus to the first candidate in `focusSelectors` that survives the
   * rebuild in a focusable state, then to the control that had focus, then
   * to the dialog itself when it had focus (search field as the last
   * resort).
   *
   * @param {string|string[]} focusSelectors Ordered focus candidates.
   */
  function refreshSettings(focusSelectors) {
    var node = settingsNode();
    if (!node) {
      return;
    }

    // Every text field carries unsaved typing: an update triggered
    // elsewhere (pinning from the search results, a drag onto the rail)
    // must not discard a half-typed set name — or a half-edited pin
    // name, description or icon in the open Edit form.
    var preserved = {};
    var textFields = [
      '#toolrail-settings-search',
      '#toolrail-settings-setname',
      '#toolrail-settings-sidebarwidth-input',
      '#toolrail-settings-toolbarname',
      '#toolrail-editform-title',
      '#toolrail-editform-description',
      '#toolrail-editform-icon'
    ];
    textFields.forEach(function (sel) {
      var field = node.querySelector(sel);
      // The toolbar Name field belongs to one toolbar (data-toolbar). When
      // the author chose a different toolbar, its typing is not carried
      // into the next toolbar's field (#95).
      if (field && (!field.dataset.toolbar || field.dataset.toolbar === T.settingsToolbarId)) {
        preserved[sel] = field.value;
      }
    });

    // Where the author IS: a rebuild caused by something else (a drag
    // onto the rail while they type a description) must hand focus back
    // to the same control, caret included — not to the search box, which
    // is where the next keystrokes used to land (PR review 2026-09-04,
    // finding 2). Only an explicit focus target from the dialog's own
    // buttons outranks it.
    var active = document.activeElement;
    var activeSelector = active && node.contains(active) && active.id ? '#' + active.id : null;
    var caret = null;
    if (activeSelector && typeof active.selectionStart === 'number') {
      caret = { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection };
    }

    refreshingSettings = true;
    node.textContent = '';
    buildSettingsContent(node, preserved['#toolrail-settings-search'] || '');

    textFields.slice(1).forEach(function (sel) {
      var field = node.querySelector(sel);
      if (field && preserved[sel] !== undefined) {
        field.value = preserved[sel];
        // A field with a derived view (the Icon field's preview) redraws
        // it from the restored value; see buildPinEditForm.
        if (typeof field.toolrailAfterRestore === 'function') {
          field.toolrailAfterRestore();
        }
      }
    });

    var candidates = Array.isArray(focusSelectors) ? focusSelectors.slice() : [focusSelectors];
    if (activeSelector) {
      candidates.push(activeSelector);
    }
    var target = null;
    candidates.some(function (sel) {
      target = focusableIn(node, sel);
      return !!target;
    });
    // The dialog itself had focus (a click on its text, or on a control in
    // a browser that does not focus controls on click; see openSettings).
    // The node survives the rebuild, so focus stays on it.
    if (!target && active === node) {
      target = node;
    }
    if (!target) {
      target = focusableIn(node, '#toolrail-settings-search');
    }
    if (target) {
      target.focus();
      if (caret && activeSelector && target === node.querySelector(activeSelector) && typeof target.setSelectionRange === 'function') {
        try {
          target.setSelectionRange(caret.start, caret.end, caret.direction || 'none');
        } catch (e) {
          /* Not a text-selection control after all — focus alone is right. */
        }
      }
    }
    refreshingSettings = false;
  }

  /**
   * Position picker. Dragging the rail's grip is the pointer affordance;
   * this radio group is the equivalent keyboard and screen-reader path,
   * so repositioning never depends on a drag.
   *
   * @param {function(string): string} scoped Adds the chosen toolbar's
   *                                          name to a heading (#95).
   * @return {HTMLElement} The fieldset.
   */
  function buildPositionControl(scoped) {
    // The chosen toolbar's position (#95).
    var tb = settingsToolbar();
    var fieldset = document.createElement('fieldset');
    fieldset.className = 'toolrail-settings-position';

    var legend = document.createElement('legend');
    legend.className = 'toolrail-settings-label';
    legend.textContent = scoped(__('Toolbar position', 'editrail'));
    fieldset.appendChild(legend);

    DOCKS.forEach(function (dock) {
      var row = settingsRow('label', 'toolrail-settings-positionrow');
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'toolrail-dock';
      input.value = dock;
      input.checked = tb.position.dock === dock;
      input.dataset.dock = dock;
      input.addEventListener('change', function () {
        if (!input.checked) {
          return;
        }
        // The dock change rebuilds the region, so the dialog is reopened
        // with focus back on the radio the author just chose. A refused
        // dock leaves the radio showing a position the rail is not in, so
        // repaint the dialog from the real state instead. An extra
        // toolbar's region does not hold the dialog, so its move leaves
        // the dialog open (setDock), and a repaint places it again.
        var moved = T.setDock(tb, dock, { reopenSettings: true });
        // A move can leave the canvas too narrow; the status line says so
        // (owner decision 2026-11-16). After setDock: the first
        // toolbar's move reopened the dialog, which clears the status.
        toolbarsStatus = moved ? canvasNarrowMessage() : '';
        if (!moved || tb !== mainToolbar || toolbarsStatus) {
          refreshSettings('input[data-dock="' + tb.position.dock + '"]');
        }
      });
      row.appendChild(input);
      var text = settingsRow('span', '');
      text.textContent = DOCK_LABELS[dock];
      row.appendChild(text);
      fieldset.appendChild(row);
    });

    var hint = settingsRow('p', 'toolrail-settings-empty');
    hint.textContent = __('You can also drag the toolbar by the grip at its end; releasing near an edge snaps it there.', 'editrail');
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
   *
   * @param {function(string): string} scoped Adds the chosen toolbar's
   *                                          name to a heading (#95).
   * @return {HTMLElement|DocumentFragment} The fieldset; with several
   *                                        toolbars, the fieldset and
   *                                        the expand/contract row.
   */
  function buildWideControl(scoped) {
    var fieldset = document.createElement('fieldset');
    fieldset.className = 'toolrail-settings-widegroup';

    var legend = document.createElement('legend');
    legend.className = 'toolrail-settings-label';
    legend.textContent = scoped(__('Tool names', 'editrail'));
    fieldset.appendChild(legend);

    var wideRow = settingsRow('label', 'toolrail-settings-positionrow');
    var wideInput = document.createElement('input');
    wideInput.type = 'checkbox';
    wideInput.id = 'toolrail-settings-wide';
    // Wide mode is one setting for each toolbar (#95): this checkbox is
    // the chosen toolbar's.
    var tb = settingsToolbar();
    wideInput.checked = isWide(tb);
    wideInput.addEventListener('change', function () {
      setWide(tb, wideInput.checked);
      // An extra toolbar on the first toolbar's edge just changed width.
      placeOpenDialogs();
      // A wider toolbar can leave the canvas too narrow (owner decision
      // 2026-11-16); the status line says so. Nothing else to rebuild.
      toolbarsStatus = wideInput.checked ? canvasNarrowMessage() : '';
      if (toolbarsStatus) {
        refreshSettings('#toolrail-settings-wide');
      }
    });
    var wideText = settingsRow('span', '');
    wideText.textContent = __('Show tool names beside the icons (wide toolbar)', 'editrail');
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
      // rail). One setting for every toolbar, and each has a chevron.
      rerenderToolbars();
    });
    var toggleText = settingsRow('span', '');
    // One setting for every toolbar (#95), so with several it says so.
    toggleText.textContent = T.toolbars.length > 1
      ? __('Show an expand/contract button on each toolbar', 'editrail')
      : __('Show an expand/contract button on the toolbar', 'editrail');
    toggleRow.appendChild(toggleInput);
    toggleRow.appendChild(toggleText);

    // Both preferences persist on every dock; the effect shows where
    // wide mode applies. Stated rather than disabling the controls —
    // a disabled checkbox hides its state.
    var hint = settingsRow('p', 'toolrail-settings-empty');
    hint.textContent = __('Tool names show on left, right and floating toolbars.', 'editrail');

    if (T.toolbars.length < 2) {
      fieldset.appendChild(toggleRow);
      fieldset.appendChild(hint);
      return fieldset;
    }
    // With several toolbars the legend names the chosen toolbar, and the
    // expand/contract checkbox is one setting for every toolbar, so it
    // goes after the group, not inside it (review 2026-11-16, finding 7).
    fieldset.appendChild(hint);
    var out = document.createDocumentFragment();
    out.appendChild(fieldset);
    out.appendChild(toggleRow);
    return out;
  }

  /**
   * Settings sidebar width (issue #28). The on/off checkbox and, while it
   * is on, the width in text, a width field, Narrower and Wider buttons,
   * and Reset. The field and the buttons are the ways to set a width
   * without the drag handle on the sidebar's edge (WCAG 2.5.7). They and
   * Reset update the section in place; see syncSidebarWidthControls().
   */
  function buildSidebarWidthControl() {
    var group = document.createElement('div');
    group.className = 'toolrail-settings-sidebarwidth';

    var head = settingsRow('h3', 'toolrail-settings-subtitle');
    head.textContent = __('Settings sidebar width', 'editrail');
    group.appendChild(head);

    var onRow = settingsRow('label', 'toolrail-settings-positionrow');
    var onInput = document.createElement('input');
    onInput.type = 'checkbox';
    onInput.id = 'toolrail-settings-sidebarresize';
    onInput.checked = isSidebarResizeOn();
    onInput.addEventListener('change', function () {
      setSidebarResize(onInput.checked);
      // The width and reset rows show only while it is on.
      refreshSettings('#toolrail-settings-sidebarresize');
    });
    var onText = settingsRow('span', '');
    onText.textContent = __('Let me make the settings sidebar wider', 'editrail');
    onRow.appendChild(onInput);
    onRow.appendChild(onText);
    group.appendChild(onRow);

    if (!isSidebarResizeOn()) {
      var offHint = settingsRow('p', 'toolrail-settings-empty');
      offHint.textContent = __('Adds a handle to the inner edge of the editor\'s settings sidebar (the Post and Block tabs). Off, the sidebar is the editor\'s own.', 'editrail');
      group.appendChild(offHint);
      return group;
    }

    var current = settingsRow('p', '');
    current.id = 'toolrail-settings-sidebarwidth-value';
    current.textContent = sprintf(
      /* translators: %s: the width, such as "400 pixels". */
      __('Width: %s.', 'editrail'),
      sidebarWidthText(sidebarWidth())
    );
    group.appendChild(current);

    // Ways to set the width without a drag (WCAG 2.5.7): type it, or step
    // it with the buttons. They also make the 8px handle an equivalent
    // control under 2.5.8. Both update the dialog in place through
    // syncSidebarWidthControls(): the field applies on change, which also
    // fires as Tab leaves it, and a rebuild there would pull focus back.
    var fieldLabel = settingsRow('label', 'toolrail-settings-label');
    fieldLabel.setAttribute('for', 'toolrail-settings-sidebarwidth-input');
    fieldLabel.textContent = __('Width in pixels', 'editrail');
    group.appendChild(fieldLabel);

    var widthRow = settingsRow('div', 'toolrail-settings-saverow');
    var field = document.createElement('input');
    field.type = 'number';
    field.id = 'toolrail-settings-sidebarwidth-input';
    field.className = 'toolrail-settings-search';
    field.min = String(SIDEBAR_DEFAULT_WIDTH);
    field.max = String(sidebarMaxWidth());
    field.step = '1';
    field.value = String(sidebarWidth());
    field.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyTypedSidebarWidth(field);
      }
    });
    field.addEventListener('change', function () {
      applyTypedSidebarWidth(field);
    });
    widthRow.appendChild(field);

    var narrower = settingsButton(__('Narrower', 'editrail'), function () {
      if (isStepButtonInert(narrower)) {
        return;
      }
      setSidebarWidth(sidebarWidth() - SIDEBAR_BIG_STEP, true);
    }, '');
    narrower.id = 'toolrail-settings-sidebarwidth-narrower';
    narrower.setAttribute('aria-describedby', current.id);
    widthRow.appendChild(narrower);

    var wider = settingsButton(__('Wider', 'editrail'), function () {
      if (isStepButtonInert(wider)) {
        return;
      }
      setSidebarWidth(sidebarWidth() + SIDEBAR_BIG_STEP, true);
    }, '');
    wider.id = 'toolrail-settings-sidebarwidth-wider';
    wider.setAttribute('aria-describedby', current.id);
    widthRow.appendChild(wider);
    group.appendChild(widthRow);
    setStepButtonInert(narrower, sidebarWidth() <= SIDEBAR_DEFAULT_WIDTH);
    setStepButtonInert(wider, sidebarWidth() >= sidebarMaxWidth());

    var row = settingsRow('div', 'toolrail-settings-helprow');
    var reset = settingsButton(__('Reset to default width', 'editrail'), function () {
      // In place, like the field and the buttons: no rebuild, so focus
      // stays on this button.
      setSidebarWidth(SIDEBAR_DEFAULT_WIDTH, true);
    }, '');
    reset.id = 'toolrail-settings-sidebarwidth-reset';
    reset.setAttribute('aria-describedby', current.id);
    row.appendChild(reset);
    group.appendChild(row);

    var hint = settingsRow('p', 'toolrail-settings-empty');
    hint.textContent = sprintf(
      /* translators: %d: the step of the Narrower and Wider buttons, in pixels. */
      __('Type a width and press Enter, or use Narrower and Wider (%d pixels a step). You can also drag the inner edge of the settings sidebar, or Tab to the edge (the first stop in the sidebar) and use the Left and Right arrow keys. Double-click the edge to reset it.', 'editrail'),
      SIDEBAR_BIG_STEP
    );
    group.appendChild(hint);

    return group;
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
        __('These colors measure %s, below the 4.5:1 minimum for text. They are applied anyway; the focus ring and pressed markers are adjusted automatically and stay at 3:1 or better.', 'editrail'),
        formatted
      );
    }
    return sprintf(
      /* translators: %s: measured contrast ratio, e.g. "12.6:1". */
      __('Custom colors applied. Text contrast is %s.', 'editrail'),
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
   * The Toolbar section's transient outcome line (#95): a toolbar added,
   * renamed, deleted, shown or hidden, or a refusal. Same contract as
   * pinnedStatus.
   */
  var toolbarsStatus = '';

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
    legend.textContent = __('Appearance', 'editrail');
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
      { key: 'bg', id: 'toolrail-settings-appearance-bg', label: __('Background color', 'editrail') },
      { key: 'fg', id: 'toolrail-settings-appearance-fg', label: __('Text color', 'editrail') }
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
  T.settingsStatus = '';

  /**
   * How many of these slots this site cannot render right now. A pattern
   * slot counts only once the catalog has actually loaded: before that,
   * "not found" means "not fetched yet", and an import or set load that
   * ran first announced patterns as unavailable that were on their way
   * (review 2026-09-03, finding 6).
   */
  function missingBlockCount(blocks) {
    var catalogReady = patternCatalogReady();
    return blocks.filter(function (name) {
      if (isPatternSlot(name)) {
        return catalogReady && !findPattern(name);
      }
      return !wp.blocks.getBlockType(name);
    }).length;
  }

  /**
   * Write one saved set out as a JSON download. The set's label snapshot
   * rides along keyed by slot name, so a set moved to another site keeps
   * its labels; the key is ABSENT when the set has none, which keeps a
   * plain set file byte-for-byte what it was before 1.0.1.
   *
   * @param {string} name Set name.
   * @return {boolean} True when the set existed and the download started.
   */
  function exportConfig(name) {
    var map = loadConfigs();
    if (!Object.prototype.hasOwnProperty.call(map, name)) {
      return false;
    }
    downloadSetFile(setFilePayload(name, map[name], loadConfigMeta()[name]));
    return true;
  }

  /**
   * The set file object for one set. One builder for an export, a shared
   * set's export and a share (#98), so a shared set exports to the same
   * file as the author's own.
   *
   * @param {string}      name   Set name.
   * @param {Array}       blocks The set's slots.
   * @param {Object|null} labels The set's label snapshot, or null.
   * @return {Object} The payload.
   */
  function setFilePayload(name, blocks, labels) {
    var payload = {
      format: 'toolrail-set',
      version: 1,
      name: name,
      blocks: blocks
    };
    // The set's label snapshot (saveConfig / importConfigPayload) rides
    // along, keyed by slot name, so a set moved to another site keeps
    // its labels. The key is absent when the set has none, so a plain
    // set file is byte-for-byte what it was before 1.0.1.
    if (labels) {
      var meta = {};
      Object.keys(labels).forEach(function (slot) {
        meta[slot] = labels[slot];
      });
      payload.meta = meta;
    }
    return payload;
  }

  /**
   * Start the download of one set file.
   *
   * @param {Object} payload A setFilePayload() result.
   * @return {void}
   */
  function downloadSetFile(payload) {
    var name = payload.name;
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
  }

  /**
   * Validate + store a parsed import. Returns a result object; never
   * throws. Entries that are neither a block name nor a pattern slot are
   * dropped (they could not be looked up or rendered anyway); a name
   * collision gets a " (2)" suffix rather than silently overwriting the
   * author's existing set.
   */
  function importConfigPayload(parsed) {
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.blocks)) {
      return { ok: false, error: __('Not an EditRail set file — expected JSON with a "blocks" array.', 'editrail') };
    }
    var valid = parsed.blocks.filter(isSetSlotName);
    var dropped = parsed.blocks.length - valid.length;
    // A set file is hand-editable and hand-writable, so it can repeat a
    // block name. Two slots sharing one `pin:<name>` tool id break the
    // rail (see normalizeSlots), so collapse them here and report the
    // collapse separately from genuinely invalid entries.
    var blocks = normalizeSlots(valid);
    var duplicates = valid.length - blocks.length;

    var base = typeof parsed.name === 'string' && parsed.name.trim() !== ''
      ? parsed.name.trim()
      : __('Imported set', 'editrail');
    var map = loadConfigs();
    var name = base;
    var n = 2;
    while (Object.prototype.hasOwnProperty.call(map, name)) {
      name = base + ' (' + n + ')';
      n++;
    }

    map[name] = blocks;
    persistConfigs(map);

    // Labels for the set's OWN blocks only (a file cannot label a pin it
    // does not list), each through the same gate stored entries pass —
    // stored WITH THE SET, not on the pins: nothing the author sees
    // changes until they load the set (loadConfig applies them then).
    // The count reported is of pins with an author-visible label; an
    // entry that carries only extension data is not "a name, description
    // or icon" (PR review 2026-09-05, finding 5).
    var setLabels = normalizeSetMeta(parsed.meta, blocks);
    setConfigMeta(name, setLabels);
    var labeled = setLabels
      ? Object.keys(setLabels).filter(function (slot) { return hasAuthorFields(setLabels[slot]); }).length
      : 0;

    return {
      ok: true,
      name: name,
      total: blocks.length,
      missing: missingBlockCount(blocks),
      dropped: dropped,
      duplicates: duplicates,
      labels: labeled
    };
  }

  /**
   * One sentence per thing the author needs to know about an import: what
   * came in, what this site cannot render yet, what was collapsed or
   * ignored, and whether labels came with the file. Assembled from whole
   * translatable sentences rather than fragments, so each one can be
   * translated with its own plural rules.
   *
   * @param {Object} result An importConfigPayload() success result.
   * @return {string} The message.
   */
  function importStatusMessage(result) {
    var msg = sprintf(
      /* translators: 1: set name, 2: block count. */
      _n('Imported "%1$s" (%2$d block).', 'Imported "%1$s" (%2$d blocks).', result.total, 'editrail'),
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
          'editrail'
        ),
        result.missing
      );
    }
    if (result.duplicates > 0) {
      msg += ' ' + sprintf(
        /* translators: %d: count of repeated block names collapsed to one. */
        _n('%d repeated block was listed once.', '%d repeated blocks were listed once.', result.duplicates, 'editrail'),
        result.duplicates
      );
    }
    if (result.dropped > 0) {
      msg += ' ' + sprintf(
        /* translators: %d: count of invalid entries. */
        _n('%d invalid entry was ignored.', '%d invalid entries were ignored.', result.dropped, 'editrail'),
        result.dropped
      );
    }
    if (result.labels > 0) {
      msg += ' ' + sprintf(
        /* translators: %d: count of pins whose custom name, description or icon came with the file. */
        _n(
          'The set carries a custom name, description or icon for %d pin, applied when you load it.',
          'The set carries a custom name, description or icon for %d pins, applied when you load it.',
          result.labels,
          'editrail'
        ),
        result.labels
      );
    }
    return msg;
  }

  /**
   * The inline Edit form for one pinned tool: the author's own name,
   * description and icon (see the Pin metadata block). Rendered INSIDE
   * the row's list item, under the buttons, as a fieldset — not as a
   * nested dialog. The settings dialog is a popover with no focus trap,
   * and a modal inside it would need one of its own; a fieldset in the
   * same dialog keeps one Escape/Tab model. Escape with focus in the
   * form closes the form and returns focus to Edit (onSettingsKeydown);
   * Save, Reset and Cancel do the same through closeEditForm.
   *
   * Every field has a visible label. Empty fields mean "the block's
   * own", and the help line says so, so the author never has to guess
   * what clearing a field does. An invalid icon is refused with the rule
   * spelled out in text, aria-invalid on the field, and focus kept
   * there (WCAG 3.3.1, 3.3.3).
   *
   * @param {string}      name      The slot name.
   * @param {string}      baseTitle The block's or pattern's own title.
   * @param {Object|null} meta      The stored entry, if any.
   * @return {HTMLElement}
   */
  function buildPinEditForm(name, baseTitle, meta) {
    var current = meta || { title: '', description: '', icon: '' };
    var form = document.createElement('form');
    form.className = 'toolrail-settings-editform';
    form.id = 'toolrail-editform';
    form.noValidate = true;

    var fieldset = document.createElement('fieldset');
    fieldset.className = 'toolrail-settings-editfields';
    var legend = document.createElement('legend');
    legend.className = 'toolrail-settings-label';
    legend.textContent = sprintf(
      /* translators: %s: the block's or pattern's own title. */
      __('Edit the %s tool', 'editrail'),
      baseTitle
    );
    fieldset.appendChild(legend);

    var help = settingsRow('p', 'toolrail-settings-empty');
    help.id = 'toolrail-editform-help';
    help.textContent = __('Give this tool your own name, description and icon. Empty fields use the block\'s own. Only your toolbar changes.', 'editrail');
    fieldset.appendChild(help);

    /**
     * Append a labeled control to the fieldset and return it, so the caller
     * can go on to set the type and value. Every field is explicitly
     * labeled and has autocomplete off — these are toolbar settings, not
     * anything a form filler should offer to complete.
     *
     * @param {string}      id          Control id, tied to its label.
     * @param {string}      labelText   Visible label.
     * @param {HTMLElement} control     The input or textarea.
     * @param {string}      describedBy Optional aria-describedby ids.
     * @return {HTMLElement} The control.
     */
    function field(id, labelText, control, describedBy) {
      var lbl = settingsRow('label', 'toolrail-settings-label');
      lbl.setAttribute('for', id);
      lbl.textContent = labelText;
      fieldset.appendChild(lbl);
      control.id = id;
      control.className = 'toolrail-settings-search';
      control.setAttribute('autocomplete', 'off');
      if (describedBy) {
        control.setAttribute('aria-describedby', describedBy);
      }
      fieldset.appendChild(control);
      return control;
    }

    var titleInput = field('toolrail-editform-title', __('Name', 'editrail'), document.createElement('input'), 'toolrail-editform-help');
    titleInput.type = 'text';
    titleInput.maxLength = PIN_META_LIMITS.title;
    titleInput.value = current.title;

    var descInput = field('toolrail-editform-description', __('Description', 'editrail'), document.createElement('textarea'), 'toolrail-editform-help');
    descInput.rows = 2;
    descInput.maxLength = PIN_META_LIMITS.description;
    descInput.className += ' toolrail-settings-textarea';
    descInput.value = current.description;

    // The Icon field sits in a row with a live preview of its value and
    // the Browse icons disclosure; the browser panel renders under the
    // row while it is open.
    var iconLabel = settingsRow('label', 'toolrail-settings-label');
    iconLabel.setAttribute('for', 'toolrail-editform-icon');
    iconLabel.textContent = __('Icon', 'editrail');
    fieldset.appendChild(iconLabel);
    var iconRow = settingsRow('div', 'toolrail-settings-iconrow');
    var iconInput = document.createElement('input');
    iconInput.type = 'text';
    iconInput.id = 'toolrail-editform-icon';
    iconInput.className = 'toolrail-settings-search';
    iconInput.setAttribute('autocomplete', 'off');
    iconInput.setAttribute('aria-describedby', 'toolrail-editform-iconhelp toolrail-editform-status');
    iconInput.value = current.icon;
    iconRow.appendChild(iconInput);
    // The preview is decorative: the field's text IS the value for AT.
    var preview = settingsRow('span', 'toolrail-settings-iconpreview');
    preview.setAttribute('aria-hidden', 'true');
    iconRow.appendChild(preview);
    /**
     * Redraw the icon preview from the field's current text. Decorative:
     * aria-hidden, because the field's own text IS the value for assistive
     * technology. An invalid value simply draws nothing.
     */
    function renderPreview() {
      preview.className = 'toolrail-settings-iconpreview';
      preview.textContent = '';
      var value = iconInput.value.trim();
      if (value !== '' && isValidPinIcon(value)) {
        renderCustomIcon(preview, value);
      }
    }
    renderPreview();
    // refreshSettings restores a preserved value AFTER this form is
    // built, so the preview drawn above is of the STORED value; the
    // restore path calls this hook so the preview follows the field.
    iconInput.toolrailAfterRestore = renderPreview;
    var browse = settingsButton(__('Browse icons', 'editrail'), function () {
      if (iconBrowserOpen) {
        closeIconBrowser();
        return;
      }
      iconBrowserOpen = true;
      refreshSettings('#toolrail-iconbrowser-search');
    }, 'toolrail-settings-iconbrowse');
    browse.setAttribute('aria-expanded', iconBrowserOpen ? 'true' : 'false');
    if (iconBrowserOpen) {
      browse.setAttribute('aria-controls', 'toolrail-iconbrowser');
    }
    iconRow.appendChild(browse);
    fieldset.appendChild(iconRow);
    var iconHelp = settingsRow('p', 'toolrail-settings-empty');
    iconHelp.id = 'toolrail-editform-iconhelp';
    iconHelp.textContent = sprintf(
      /* translators: %d: maximum number of characters. */
      __('Up to %d characters, such as Aa or a symbol, or a Dashicon. Browse icons lists every Dashicon.', 'editrail'),
      PIN_META_LIMITS.icon
    );
    fieldset.appendChild(iconHelp);
    if (iconBrowserOpen) {
      fieldset.appendChild(buildIconBrowser(iconInput));
    }
    iconInput.addEventListener('input', function () {
      editFormError = '';
      iconInput.removeAttribute('aria-invalid');
      status.textContent = '';
      renderPreview();
    });

    // The form's own outcome line, for a refused icon. Visible text under
    // the field it describes; speak() announces it. Saved outcomes go to
    // the section's pinnedStatus instead, because saving closes the form.
    // Rendered from editFormError so a rebuild keeps the refusal visible.
    var status = settingsRow('p', 'toolrail-settings-status');
    status.id = 'toolrail-editform-status';
    status.textContent = editFormError;
    if (editFormError) {
      iconInput.setAttribute('aria-invalid', 'true');
    }
    fieldset.appendChild(status);

    var actions = settingsRow('div', 'toolrail-settings-helprow');
    var save = document.createElement('button');
    save.type = 'submit';
    save.className = 'toolrail-settings-btn toolrail-settings-editsave';
    save.textContent = __('Save', 'editrail');
    actions.appendChild(save);
    if (meta) {
      actions.appendChild(settingsButton(__('Reset', 'editrail'), function () {
        setPinMeta(name, null);
        pinnedStatus = sprintf(
          /* translators: %s: the block's or pattern's own title. */
          __('%s uses its own name, description and icon again.', 'editrail'),
          baseTitle
        );
        closeEditForm();
      }, 'toolrail-settings-editreset'));
    }
    actions.appendChild(settingsButton(__('Cancel', 'editrail'), function () {
      closeEditForm();
    }, 'toolrail-settings-editcancel'));
    fieldset.appendChild(actions);
    form.appendChild(fieldset);

    // Enter in a text field submits, like any form; the textarea keeps
    // Enter for a line break (collapsed to a space on save).
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var iconValue = iconInput.value.trim();
      if (iconValue !== '' && !isValidPinIcon(iconValue)) {
        editFormError = sprintf(
          /* translators: %d: maximum number of characters. */
          __('The icon must be up to %d characters, or the name of a Dashicon. Use Browse icons to pick one.', 'editrail'),
          PIN_META_LIMITS.icon
        );
        status.textContent = editFormError;
        iconInput.setAttribute('aria-invalid', 'true');
        speak(status.textContent);
        iconInput.focus();
        return;
      }
      var entry = normalizePinMeta({ title: titleInput.value, description: descInput.value, icon: iconValue });
      if (!setPinMeta(name, entry)) {
        // Unpinned from elsewhere while the form was open: nothing to
        // store, and the rebuild below drops the row and the form.
        closeEditForm();
        return;
      }
      pinnedStatus = entry
        ? sprintf(
          /* translators: %s: the tool's name as it now reads. */
          __('Saved your changes to %s.', 'editrail'),
          entry.title || baseTitle
        )
        : sprintf(
          /* translators: %s: the block's or pattern's own title. */
          __('%s uses its own name, description and icon again.', 'editrail'),
          baseTitle
        );
      closeEditForm();
    });

    return form;
  }

  /**
   * The Icon field's Dashicon browser: a search field and the matching
   * icons as icon-plus-name chips. Choosing one writes its name into the
   * Icon field, announces it, closes the browser and puts focus in the
   * field, so the author can read what was set and go on to Save. A
   * disclosure under the field, not a popup: the same Escape-per-level
   * model as the form it lives in (onSettingsKeydown).
   *
   * Each chip is a button whose visible text is the icon's name, with
   * the icon itself aria-hidden — so the accessible name is the name the
   * field will hold, and Label in Name holds. The chip for the value
   * already in the field is aria-pressed, and styled from that.
   *
   * @param {HTMLInputElement} iconInput The Icon field to fill.
   * @return {HTMLElement}
   */
  function buildIconBrowser(iconInput) {
    var panel = settingsRow('div', 'toolrail-settings-iconbrowser');
    panel.id = 'toolrail-iconbrowser';
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-labelledby', 'toolrail-iconbrowser-title');

    var title = settingsRow('h4', 'toolrail-settings-label');
    title.id = 'toolrail-iconbrowser-title';
    title.textContent = __('Dashicons', 'editrail');
    panel.appendChild(title);

    var searchLabel = settingsRow('label', 'toolrail-settings-label');
    searchLabel.setAttribute('for', 'toolrail-iconbrowser-search');
    searchLabel.textContent = __('Search icons', 'editrail');
    panel.appendChild(searchLabel);
    var search = document.createElement('input');
    search.type = 'search';
    search.id = 'toolrail-iconbrowser-search';
    search.className = 'toolrail-settings-search';
    search.setAttribute('autocomplete', 'off');
    search.setAttribute('aria-describedby', 'toolrail-iconbrowser-count');
    search.value = iconBrowserQuery;
    panel.appendChild(search);

    // Result count as text. aria-describedby on the search field reads it
    // on focus; the typing case is announced through speak() from the
    // input handler below — a described-by relation is not a live
    // region (WCAG 4.1.3; PR review 2026-09-05, finding 4).
    var count = settingsRow('p', 'toolrail-settings-empty');
    count.id = 'toolrail-iconbrowser-count';
    panel.appendChild(count);
    var grid = settingsRow('div', 'toolrail-settings-icongrid');
    panel.appendChild(grid);

    /**
     * Dashicon names matching the search. The 'dashicons-' prefix is
     * stripped from the QUERY, because the Icon field shows a full
     * 'dashicons-star-filled' value and pasting that back must still find
     * the icon; dashes also match spaces, so "star filled" works.
     *
     * @param {string} query The raw search text.
     * @return {Array<string>} Matching names, unprefixed.
     */
    function matches(query) {
      // The field shows 'dashicons-star-filled'; pasting that back into
      // the search must find star-filled, so the prefix is not part of
      // the query (PR review 2026-09-05, finding 3).
      var q = query.trim().toLowerCase().replace(/^dashicons-/, '').replace(/\s+/g, ' ');
      if (q === '') {
        return DASHICON_NAMES;
      }
      return DASHICON_NAMES.filter(function (name) {
        return name.indexOf(q) !== -1 || name.replace(/-/g, ' ').indexOf(q) !== -1;
      });
    }

    /**
     * Draw the icon grid and its count line for the current query, capped at
     * ICON_BROWSER_LIMIT chips — all 349 icons are cheap to build but not to
     * read, so past the cap the count line asks the author to narrow the
     * search instead. Each chip carries a pressed state for the icon the
     * field currently holds.
     */
    function render() {
      var hits = matches(iconBrowserQuery);
      var shown = hits.slice(0, ICON_BROWSER_LIMIT);
      grid.textContent = '';
      if (!hits.length) {
        count.textContent = sprintf(
          /* translators: %s: the search text. */
          __('No icon matches "%s".', 'editrail'),
          iconBrowserQuery.trim()
        );
        return;
      }
      count.textContent = shown.length < hits.length
        ? sprintf(
          /* translators: 1: icons shown, 2: icons matching. */
          __('Showing the first %1$d of %2$d icons. Type to narrow the list.', 'editrail'),
          shown.length,
          hits.length
        )
        : sprintf(
          /* translators: %d: number of icons. */
          _n('%d icon.', '%d icons.', hits.length, 'editrail'),
          hits.length
        );
      var currentValue = iconInput.value.trim();
      shown.forEach(function (name) {
        var value = 'dashicons-' + name;
        var chip = settingsButton('', function () {
          iconInput.value = value;
          // The field's own input handler clears a refusal and redraws
          // the preview; fire it the way typing would.
          iconInput.dispatchEvent(new Event('input', { bubbles: true }));
          speak(sprintf(
            /* translators: %s: Dashicon name. */
            __('Icon set to %s.', 'editrail'),
            name
          ));
          closeIconBrowser('#toolrail-editform-icon');
        }, 'toolrail-settings-iconresult');
        var glyph = document.createElement('span');
        glyph.className = 'dashicons ' + value;
        glyph.setAttribute('aria-hidden', 'true');
        chip.appendChild(glyph);
        var label = document.createElement('span');
        label.textContent = name;
        chip.appendChild(label);
        chip.setAttribute('aria-pressed', currentValue === value ? 'true' : 'false');
        chip.dataset.icon = name;
        grid.appendChild(chip);
      });
    }

    // Announce the count once typing pauses, not per keystroke: speak()
    // replaces the live region's text, so a burst would still read only
    // the last count, but a screen reader mid-sentence would be cut off
    // on every key.
    var announceTimer = null;
    search.addEventListener('input', function () {
      iconBrowserQuery = search.value;
      render();
      window.clearTimeout(announceTimer);
      announceTimer = window.setTimeout(function () {
        speak(count.textContent);
      }, 400);
    });
    render();
    return panel;
  }

  /**
   * Fill the settings dialog: the heading, the position, wide-mode and
   * appearance sections, then pinned tools and the add-a-block search,
   * then saved sets. Called for the first open and again for every
   * refresh, so it must be able to rebuild from stored state alone —
   * the search text is passed back in because it is the one thing that
   * lives only in the DOM.
   *
   * @param {HTMLElement} node        The dialog body, already emptied.
   * @param {string}      searchValue The search text to restore.
   * @return {void}
   */
  /**
   * The Toolbar section (#95), shown while more than one toolbar exists:
   * the chooser that decides which toolbar the sections below change, and
   * for an extra toolbar its Name, Show and Delete controls. It comes
   * before the sections it scopes, so reading order gives the scope first.
   *
   * @return {HTMLElement} The section.
   */
  function buildToolbarSection() {
    var tb = settingsToolbar();
    var section = settingsRow('div', 'toolrail-settings-toolbars');

    var label = settingsRow('label', 'toolrail-settings-label');
    label.setAttribute('for', 'toolrail-settings-toolbar');
    label.textContent = __('Toolbar', 'editrail');
    section.appendChild(label);
    var select = document.createElement('select');
    select.id = 'toolrail-settings-toolbar';
    select.className = 'toolrail-settings-search';
    select.setAttribute('aria-describedby', 'toolrail-settings-toolbar-hint');
    T.toolbars.forEach(function (other) {
      var option = document.createElement('option');
      option.value = other.id;
      option.textContent = other.hidden
        ? sprintf(
          /* translators: %s: the toolbar's name. */
          __('%s (hidden)', 'editrail'),
          toolbarLabel(other)
        )
        : toolbarLabel(other);
      option.selected = other === tb;
      select.appendChild(option);
    });
    select.addEventListener('change', function () {
      T.settingsToolbarId = select.value;
      // The Edit form is for a pin of the toolbar that was chosen.
      editingSlot = '';
      editFormError = '';
      iconBrowserOpen = false;
      iconBrowserQuery = '';
      refreshSettings('#toolrail-settings-toolbar');
    });
    section.appendChild(select);
    var hint = settingsRow('p', 'toolrail-settings-empty');
    hint.id = 'toolrail-settings-toolbar-hint';
    hint.textContent = __('Pinned tools, position, tool names and saved sets below apply to this toolbar.', 'editrail');
    section.appendChild(hint);

    if (tb !== mainToolbar) {
      var nameLabel = settingsRow('label', 'toolrail-settings-label');
      nameLabel.setAttribute('for', 'toolrail-settings-toolbarname');
      nameLabel.textContent = __('Toolbar name', 'editrail');
      section.appendChild(nameLabel);
      var nameRow = settingsRow('div', 'toolrail-settings-saverow');
      var nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.id = 'toolrail-settings-toolbarname';
      nameInput.className = 'toolrail-settings-search';
      nameInput.maxLength = TOOLBAR_NAME_MAX;
      nameInput.value = tb.name;
      // refreshSettings keeps typing only for the toolbar it was typed for.
      nameInput.dataset.toolbar = tb.id;
      nameInput.setAttribute('aria-describedby', 'toolrail-settings-toolbars-status');
      nameRow.appendChild(nameInput);
      var rename = function () {
        var before = tb.name;
        var result = renameToolbar(tb, nameInput.value);
        if (result === 'renamed') {
          toolbarsStatus = sprintf(
            /* translators: 1: the old name, 2: the new name. */
            __('Renamed the %1$s toolbar to %2$s.', 'editrail'),
            before, tb.name
          );
        } else if (result === 'same') {
          toolbarsStatus = sprintf(
            /* translators: %s: the toolbar's name. */
            __('The toolbar is already called %s.', 'editrail'),
            tb.name
          );
        } else if (result === 'empty') {
          toolbarsStatus = __('Type a name for the toolbar.', 'editrail');
        } else {
          toolbarsStatus = __('A different toolbar has that name. Type a different name.', 'editrail');
        }
        refreshSettings('#toolrail-settings-toolbarname');
      };
      nameInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          rename();
        }
      });
      nameRow.appendChild(settingsButton(__('Rename', 'editrail'), rename, 'toolrail-settings-renametoolbar'));
      section.appendChild(nameRow);

      // Show or hide (step 3). The same state as the Toolbars menu's
      // checked item on the first toolbar.
      var shownRow = settingsRow('label', 'toolrail-settings-positionrow');
      var shown = document.createElement('input');
      shown.type = 'checkbox';
      shown.id = 'toolrail-settings-toolbarshown';
      shown.checked = !tb.hidden;
      shown.addEventListener('change', function () {
        var result = setToolbarHidden(tb, !shown.checked);
        // One message: the show or hide, a disarm it caused, a canvas
        // that is now too narrow (review 2026-11-16, finding 2).
        toolbarsStatus = joinMessages([
          toolbarShownMessage(tb),
          result && result.disarmed ? disarmedMessage() : '',
          tb.hidden ? '' : canvasNarrowMessage()
        ]);
        refreshSettings('#toolrail-settings-toolbarshown');
      });
      var shownText = settingsRow('span', '');
      shownText.textContent = __('Show this toolbar', 'editrail');
      shownRow.appendChild(shown);
      shownRow.appendChild(shownText);
      section.appendChild(shownRow);

      var deleteRow = settingsRow('div', 'toolrail-settings-helprow');
      var del = settingsButton(__('Delete this toolbar', 'editrail'), function () {
        var name = tb.name;
        var count = tb.slots.length;
        var result = deleteToolbar(tb);
        if (!result) {
          return;
        }
        // Its pins go with it (owner decision 2026-11-14), so say so, and
        // a disarm it caused in the same message.
        toolbarsStatus = joinMessages([count
          ? sprintf(
            /* translators: 1: the toolbar's name, 2: number of pinned tools. */
            _n(
              'Deleted the %1$s toolbar and its %2$d pinned tool.',
              'Deleted the %1$s toolbar and its %2$d pinned tools.',
              count,
              'editrail'
            ),
            name,
            count
          )
          : sprintf(
            /* translators: %s: the toolbar's name. */
            __('Deleted the %s toolbar.', 'editrail'),
            name
          ), result.disarmed ? disarmedMessage() : '']);
        refreshSettings(['#toolrail-settings-toolbar', '.toolrail-settings-addtoolbar']);
      }, 'toolrail-settings-deletetoolbar');
      del.setAttribute('aria-label', sprintf(
        /* translators: %s: the toolbar's name. */
        __('Delete the %s toolbar', 'editrail'),
        tb.name
      ));
      deleteRow.appendChild(del);
      section.appendChild(deleteRow);
    }

    section.appendChild(buildToolbarsStatus());
    return section;
  }

  /**
   * The Toolbar section's outcome line (toolbarsStatus): rendered as text
   * where the controls are, and spoken. Built in the Toolbar section when
   * it shows, else under "Add a toolbar".
   *
   * @return {HTMLElement} The line.
   */
  function buildToolbarsStatus() {
    var status = settingsRow('p', 'toolrail-settings-status');
    status.id = 'toolrail-settings-toolbars-status';
    status.textContent = toolbarsStatus;
    if (toolbarsStatus) {
      speak(toolbarsStatus);
    }
    toolbarsStatus = '';
    return status;
  }

  /**
   * "Add a toolbar", and the checkbox for the first toolbar's Toolbars
   * button (#95). Under the position group: where the toolbars are is
   * what the author arranges there.
   *
   * @param {boolean} withStatus Build the outcome line here, because the
   *                             Toolbar section is not shown.
   * @return {HTMLElement} The group.
   */
  function buildToolbarAddRow(withStatus) {
    var group = settingsRow('div', 'toolrail-settings-addtoolbarrow');
    var row = settingsRow('div', 'toolrail-settings-helprow');
    row.appendChild(settingsButton(__('Add a toolbar', 'editrail'), function () {
      var tb = addToolbar();
      if (!tb) {
        toolbarsStatus = sprintf(
          /* translators: %d: the largest number of toolbars. */
          __('You have %d toolbars, which is the most there can be. Delete a toolbar to add a different one.', 'editrail'),
          MAX_TOOLBARS
        );
        refreshSettings('.toolrail-settings-addtoolbar');
        return;
      }
      // Choose the new toolbar, so the author can name it and pin to it
      // at once.
      T.settingsToolbarId = tb.id;
      toolbarsStatus = joinMessages([sprintf(
        /* translators: %s: the new toolbar's name. */
        __('Added the %s toolbar beside the main toolbar. It is chosen below, and it has no tools yet.', 'editrail'),
        tb.name
      ), canvasNarrowMessage()]);
      refreshSettings('#toolrail-settings-toolbarname');
    }, 'toolrail-settings-addtoolbar'));
    group.appendChild(row);

    var buttonRow = settingsRow('label', 'toolrail-settings-positionrow');
    var buttonToggle = document.createElement('input');
    buttonToggle.type = 'checkbox';
    buttonToggle.id = 'toolrail-settings-toolbarsbutton';
    buttonToggle.checked = readKey(TOOLBARS_BUTTON_HIDDEN_KEY) !== '1';
    buttonToggle.addEventListener('change', function () {
      writeKey(TOOLBARS_BUTTON_HIDDEN_KEY, buttonToggle.checked ? '0' : '1');
      // Focus stays on this checkbox: rerender() only moves focus when it
      // was in the rail.
      T.rerender(mainToolbar);
    });
    var buttonText = settingsRow('span', '');
    buttonText.textContent = __('Show a Toolbars button on the main toolbar when you have more than one toolbar', 'editrail');
    buttonRow.appendChild(buttonToggle);
    buttonRow.appendChild(buttonText);
    group.appendChild(buttonRow);

    if (withStatus) {
      group.appendChild(buildToolbarsStatus());
    }
    return group;
  }

  function buildSettingsContent(node, searchValue) {
    var head = settingsRow('div', 'toolrail-settings-head');
    var title = settingsRow('h2', 'toolrail-settings-title');
    title.textContent = __('Toolbar settings', 'editrail');
    title.id = 'toolrail-settings-title';
    head.appendChild(title);
    var close = settingsButton('×', function () { closeSettings(true); }, 'toolrail-settings-close');
    close.setAttribute('aria-label', __('Close toolbar settings', 'editrail'));
    head.appendChild(close);
    node.appendChild(head);

    var note = settingsRow('p', 'toolrail-settings-note');
    note.textContent = __('Pinned tools appear on the toolbar as quick-insert tools: any block type, and any pattern. They are saved to your account on this site, for you only.', 'editrail');
    node.appendChild(note);

    // The toolbar the sections below change (#95). With more than one
    // toolbar the chooser comes first, and each scoped heading names the
    // chosen toolbar, so a screen-reader user hears which toolbar a
    // control changes. With one toolbar the dialog reads as before.
    var tb = settingsToolbar();
    var several = T.toolbars.length > 1;
    var scoped = function (text) {
      return several
        ? sprintf(
          /* translators: 1: a section heading, 2: the toolbar's name. */
          __('%1$s: %2$s', 'editrail'),
          text,
          toolbarLabel(tb)
        )
        : text;
    };
    if (several) {
      node.appendChild(buildToolbarSection());
    }

    // Pinned tools + Add a block come FIRST, directly under the note that
    // introduces them, and the position / tool names / appearance groups
    // follow (QA 2026-09-11, C2; owner decision the same day). Focus
    // opens in the search field, and the dialog closes when Tab leaves
    // it, so whatever sits ABOVE the search is reachable only backwards:
    // with the three groups first, six Tabs closed the dialog and 27 of
    // its 34 controls were behind the caret.

    // --- Pinned blocks, THEN Add a block (one section, this order on
    // purpose: the list shows what is already on the toolbar, the
    // search below adds to it, and a new pin lands at the BOTTOM of the
    // list — right above the search that added it, owner decision
    // 2026-08-27) ---
    var pinnedHead = settingsRow('h3', 'toolrail-settings-subtitle');
    pinnedHead.textContent = scoped(__('Pinned tools', 'editrail'));
    node.appendChild(pinnedHead);

    var pinnedList = settingsRow('ul', 'toolrail-settings-pinned');
    // The chosen toolbar's pins (#95).
    var slots = loadSlots(tb);
    if (!slots.length) {
      var empty = settingsRow('p', 'toolrail-settings-empty');
      empty.textContent = __('Nothing pinned yet.', 'editrail');
      node.appendChild(empty);
    }
    slots.forEach(function (name, i) {
      var isPattern = isPatternSlot(name);
      var pattern = isPattern ? findPattern(name) : null;
      var type = isPattern ? null : wp.blocks.getBlockType(name);
      var li = settingsRow('li', 'toolrail-settings-pinnedrow');
      var label = settingsRow('span', 'toolrail-settings-pinnedname');
      // The block's or pattern's own title, and the author's name for the
      // pin when one is set (Pin metadata). The row shows the author's;
      // the Edit form's legend names the block, so the two never blur.
      var meta = getPinMeta(name);
      var available = isPattern ? !!pattern : !!type;
      var baseTitle = isPattern
        ? (pattern ? pattern.title : name.slice(PATTERN_SLOT_PREFIX.length))
        : (type ? type.title : name);
      var shownTitle = meta && meta.title ? meta.title : baseTitle;
      label.textContent = available ? shownTitle : shownTitle + ' ' + __('(inactive)', 'editrail');
      li.appendChild(label);
      if (isPattern) {
        // The kind, visible, OUTSIDE the name span — so the arrow and
        // Unpin names below stay "Move <title> up" / "Unpin <title>".
        var kindTag = settingsRow('span', 'toolrail-settings-tag');
        kindTag.textContent = __('Pattern', 'editrail');
        li.appendChild(kindTag);
      }
      if (meta) {
        // Text, never a mark alone: this pin carries the author's own
        // name, description or icon.
        var customTag = settingsRow('span', 'toolrail-settings-tag');
        customTag.textContent = __('Custom', 'editrail');
        li.appendChild(customTag);
      }

      // Reaching either end disables the arrow that was just clicked, so
      // each handler offers the opposite arrow on the same row as its
      // second choice — focus stays on the row the author is moving.
      var row = pinnedRowSelector(name);

      // Move, Unpin and the search results below each set pinnedStatus:
      // the row rebuild moves nothing a screen reader hears, and focus
      // stays (or returns to the search), so without a message a blind
      // author had no way to know the action took (QA 2026-09-11, C4).
      var up = settingsButton('↑', function () {
        if (moveSlot(tb, name, -1)) {
          pinnedStatus = sprintf(
            /* translators: 1: tool title, 2: new position, 3: number of pinned tools. */
            __('%1$s moved to position %2$d of %3$d.', 'editrail'),
            label.textContent, i, slots.length
          );
          refreshSettings([row + '.toolrail-settings-up', row + '.toolrail-settings-down']);
        }
      }, 'toolrail-settings-up');
      up.setAttribute('aria-label', sprintf(__('Move %s up', 'editrail'), label.textContent));
      up.disabled = i === 0;
      li.appendChild(up);

      var down = settingsButton('↓', function () {
        if (moveSlot(tb, name, 1)) {
          pinnedStatus = sprintf(
            /* translators: 1: tool title, 2: new position, 3: number of pinned tools. */
            __('%1$s moved to position %2$d of %3$d.', 'editrail'),
            label.textContent, i + 2, slots.length
          );
          refreshSettings([row + '.toolrail-settings-down', row + '.toolrail-settings-up']);
        }
      }, 'toolrail-settings-down');
      down.setAttribute('aria-label', sprintf(__('Move %s down', 'editrail'), label.textContent));
      down.disabled = i === slots.length - 1;
      li.appendChild(down);

      // Edit opens the inline form for this pin's own name, description
      // and icon (Pin metadata). A disclosure, not a dialog: aria-expanded
      // says whether the form below the row is open, and the button's
      // accessible name "Edit <title>" contains its visible "Edit".
      var isEditing = editingSlot === name;
      var edit = settingsButton(__('Edit', 'editrail'), function () {
        if (editingSlot === name) {
          closeEditForm();
          return;
        }
        editingSlot = name;
        refreshSettings('#toolrail-editform-title');
      }, 'toolrail-settings-edit');
      edit.setAttribute('aria-label', sprintf(__('Edit %s', 'editrail'), label.textContent));
      edit.setAttribute('aria-expanded', isEditing ? 'true' : 'false');
      if (isEditing) {
        edit.setAttribute('aria-controls', 'toolrail-editform');
      }
      li.appendChild(edit);

      // Visible text is "Unpin", not "Remove", so that it is contained in
      // the accessible name "Unpin <block>" (WCAG 2.5.3 Label in Name).
      // With "Remove" on screen and "Unpin Paragraph" as the name, a
      // speech-input user saying "click Remove" matched nothing. It also
      // matches the wording of the block menu's own Unpin item.
      var remove = settingsButton(__('Unpin', 'editrail'), function () {
        unpinBlock(tb, name);
        pinnedStatus = tb === mainToolbar
          ? sprintf(
            /* translators: %s: tool title. */
            __('%s unpinned from the toolbar.', 'editrail'),
            label.textContent
          )
          : sprintf(
            /* translators: 1: tool title, 2: the toolbar's name. */
            __('%1$s unpinned from the %2$s toolbar.', 'editrail'),
            label.textContent, tb.name
          );
        refreshSettings('#toolrail-settings-search');
      }, 'toolrail-settings-remove');
      remove.setAttribute('aria-label', sprintf(__('Unpin %s', 'editrail'), label.textContent));
      li.appendChild(remove);

      if (isEditing) {
        li.appendChild(buildPinEditForm(name, baseTitle, meta));
      }

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
    //
    // The first toolbar's only (#95): the defaults are what a new account
    // gets on that toolbar, and the corrupt-list check below reads its
    // key. An extra toolbar starts empty and has no defaults to restore.
    var restoreRow = settingsRow('div', 'toolrail-settings-restorerow');
    restoreRow.appendChild(settingsButton(__('Restore default tools', 'editrail'), function () {
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
          pinnedStatus = __('Your saved pinned list could not be read, so nothing was changed. Pin a block or load a saved set to start a fresh list.', 'editrail');
          refreshSettings('.toolrail-settings-restore');
          return;
        }
      }
      var current = loadSlots(mainToolbar);
      var missing = DEFAULT_SLOTS.filter(function (name) {
        return current.indexOf(name) === -1;
      });
      if (!missing.length) {
        // Say so rather than silently no-op'ing.
        pinnedStatus = __('All default tools are already pinned.', 'editrail');
        refreshSettings('.toolrail-settings-restore');
        return;
      }
      saveSlots(mainToolbar, current.concat(missing));
      window.dispatchEvent(new CustomEvent('toolrail:tools-updated'));
      T.rerender(mainToolbar);
      pinnedStatus = sprintf(
        /* translators: %d: number of default tools restored. */
        _n('Restored %d default tool.', 'Restored %d default tools.', missing.length, 'editrail'),
        missing.length
      );
      refreshSettings('.toolrail-settings-restore');
    }, 'toolrail-settings-restore'));
    if (tb === mainToolbar) {
      node.appendChild(restoreRow);
    }

    // --- Add a block ---
    var searchLabel = settingsRow('label', 'toolrail-settings-label');
    searchLabel.setAttribute('for', 'toolrail-settings-search');
    searchLabel.textContent = __('Add a block or pattern', 'editrail');
    node.appendChild(searchLabel);

    var search = document.createElement('input');
    search.type = 'search';
    search.id = 'toolrail-settings-search';
    search.className = 'toolrail-settings-search';
    search.placeholder = __('Search block types and patterns…', 'editrail');
    search.value = searchValue || '';
    node.appendChild(search);

    var results = settingsRow('div', 'toolrail-settings-results');
    results.id = 'toolrail-settings-results';
    node.appendChild(results);

    /**
     * Draw the add-a-block results for the current search: up to 12 block
     * types, then up to 12 patterns, with anything already pinned left out.
     * An empty search shows the prompt rather than the whole catalog.
     */
    function renderResults() {
      results.textContent = '';
      var term = search.value.trim().toLowerCase();
      var pinned = loadSlots(tb);
      // eslint-disable-next-line no-shadow -- `title` is the candidate's title; this helper never reads the dialog heading.
      var hits = function (title, name) {
        return String(title).toLowerCase().indexOf(term) !== -1 || String(name).toLowerCase().indexOf(term) !== -1;
      };
      var blockMatches = term ? insertableBlockTypes().filter(function (t) {
        return pinned.indexOf(t.name) === -1 && hits(t.title, t.name);
      }).slice(0, 12) : [];
      // Patterns after blocks, under the same cap: the author's own
      // first (the catalog lists them first), then the theme's and core's.
      var patternMatches = term ? allPatterns().filter(function (p) {
        return pinned.indexOf(p.id) === -1 && hits(p.title, p.name);
      }).slice(0, 12) : [];

      if (!term) {
        var hint = settingsRow('p', 'toolrail-settings-empty');
        hint.textContent = __('Type to search the available block types and patterns.', 'editrail');
        results.appendChild(hint);
        return;
      }
      if (!blockMatches.length && !patternMatches.length) {
        var none = settingsRow('p', 'toolrail-settings-empty');
        none.textContent = __('No matching blocks or patterns.', 'editrail');
        results.appendChild(none);
        return;
      }
      // Visible text is the title plus a kind tag; the accessible name
      // (aria-label) contains the title, so Label in Name holds.
      // eslint-disable-next-line no-shadow -- `title` is the result's title; this helper never reads the dialog heading.
      var resultButton = function (title, kindLabel, ariaLabel, onPin) {
        var btn = settingsButton(title, function () {
          onPin();
          pinnedStatus = tb === mainToolbar
            ? sprintf(
              /* translators: %s: block or pattern title. */
              __('%s pinned to the toolbar.', 'editrail'),
              title
            )
            : sprintf(
              /* translators: 1: block or pattern title, 2: the toolbar's name. */
              __('%1$s pinned to the %2$s toolbar.', 'editrail'),
              title, tb.name
            );
          refreshSettings('#toolrail-settings-search');
        }, 'toolrail-settings-result');
        btn.setAttribute('aria-label', ariaLabel);
        var tag = settingsRow('span', 'toolrail-settings-tag');
        tag.textContent = kindLabel;
        btn.appendChild(tag);
        return btn;
      };
      blockMatches.forEach(function (t) {
        var btn = resultButton(t.title, __('Block', 'editrail'), sprintf(
          /* translators: %s: block title. */
          __('Pin the %s block to the toolbar', 'editrail'),
          t.title
        ), function () { pinBlock(tb, t.name); });
        btn.dataset.block = t.name;
        results.appendChild(btn);
      });
      patternMatches.forEach(function (p) {
        var btn = resultButton(p.title, __('Pattern', 'editrail'), sprintf(
          /* translators: %s: pattern title. */
          __('Pin the %s pattern to the toolbar', 'editrail'),
          p.title
        ), function () { pinBlock(tb, p.id); });
        btn.dataset.pattern = p.id;
        results.appendChild(btn);
      });
    }
    search.addEventListener('input', renderResults);
    renderResults();

    // --- Toolbar position, tool names, appearance ---
    node.appendChild(settingsDivider());
    node.appendChild(buildPositionControl(scoped));
    node.appendChild(buildToolbarAddRow(!several));
    node.appendChild(settingsDivider());
    node.appendChild(buildWideControl(scoped));
    node.appendChild(settingsDivider());
    node.appendChild(buildAppearanceControl());
    node.appendChild(settingsDivider());
    node.appendChild(buildSidebarWidthControl());

    // --- Saved sets ---
    node.appendChild(settingsDivider());
    var setsHead = settingsRow('h3', 'toolrail-settings-subtitle');
    setsHead.textContent = __('Saved sets', 'editrail');
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
    status.textContent = T.settingsStatus;
    node.appendChild(status);
    if (T.settingsStatus) {
      speak(T.settingsStatus);
    }
    T.settingsStatus = '';

    var saveRow = settingsRow('div', 'toolrail-settings-saverow');
    var nameLabel = settingsRow('label', 'toolrail-settings-label');
    nameLabel.setAttribute('for', 'toolrail-settings-setname');
    // A set is one toolbar's pins (#95): with several, the label names it.
    nameLabel.textContent = several
      ? sprintf(
        /* translators: %s: the toolbar's name. */
        __('Save the pins of %s as a set named', 'editrail'),
        toolbarLabel(tb)
      )
      : __('Save the current set as', 'editrail');
    node.appendChild(nameLabel);

    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'toolrail-settings-setname';
    nameInput.className = 'toolrail-settings-search';
    saveRow.appendChild(nameInput);
    // Save announces its outcome either way (QA 2026-09-11, C4/C7): an
    // empty name used to re-focus the field and say nothing, which read
    // as a dead button; Enter in the field now saves too, the way a
    // one-field form is expected to.
    var saveSet = function () {
      var trimmed = nameInput.value.trim();
      if (saveConfig(trimmed, tb)) {
        T.settingsStatus = sprintf(
          /* translators: %s: set name. */
          __('Saved the set "%s".', 'editrail'),
          trimmed
        );
      } else {
        T.settingsStatus = __('Type a name for the set.', 'editrail');
      }
      refreshSettings('#toolrail-settings-setname');
    };
    nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveSet();
      }
    });
    saveRow.appendChild(settingsButton(__('Save set', 'editrail'), saveSet, 'toolrail-settings-saveset'));
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
        // The user's own shared copy of this set (#98), if any. Text,
        // never a mark alone: "Shared" beside the name.
        var copy = ownSharedCopy(cfg);
        if (copy) {
          var sharedTag = settingsRow('span', 'toolrail-settings-tag');
          sharedTag.textContent = __('Shared', 'editrail');
          li.appendChild(sharedTag);
        }
        var shareControls = ownSetShareControls(cfg, copy);
        if (shareControls.length) {
          // The extra buttons do not fit on one line in the dialog's
          // width; this row may wrap.
          li.classList.add('toolrail-settings-wraprow');
        }
        var load = settingsButton(__('Load', 'editrail'), function () {
          // Into the chosen toolbar (#95). A stored change can delete it
          // while the dialog is open: then the first toolbar, and the
          // message says which, as the block-menu pin does (PR #126 review).
          var into = T.toolbars.indexOf(tb) === -1 ? mainToolbar : tb;
          loadConfig(cfg, into);
          T.settingsStatus = configLoadedMessage(cfg, into);
          refreshSettings('#toolrail-settings-search');
        }, 'toolrail-settings-load');
        load.setAttribute('aria-label', several
          ? sprintf(
            /* translators: 1: set name, 2: the toolbar's name. */
            __('Load the set %1$s into %2$s', 'editrail'),
            cfg,
            toolbarLabel(tb)
          )
          : sprintf(__('Load the set %s', 'editrail'), cfg));
        li.appendChild(load);
        var exp = settingsButton(__('Export', 'editrail'), function () {
          exportConfig(cfg);
        }, 'toolrail-settings-export');
        exp.setAttribute('aria-label', sprintf(__('Export the set %s as a file', 'editrail'), cfg));
        li.appendChild(exp);
        shareControls.forEach(function (btn) {
          li.appendChild(btn);
        });
        var del = settingsButton(__('Delete', 'editrail'), function () {
          deleteConfig(cfg);
          T.settingsStatus = sprintf(
            /* translators: %s: set name. */
            __('Deleted the set "%s".', 'editrail'),
            cfg
          );
          if (copy) {
            // A delete removes the author's own set only; the shared copy
            // is the site's, and now shows under "Shared sets" (#98).
            T.settingsStatus += ' ' + __('Its shared copy stays shared until you stop sharing it.', 'editrail');
          }
          refreshSettings('#toolrail-settings-setname');
        }, 'toolrail-settings-delset');
        del.setAttribute('aria-label', sprintf(__('Delete the set %s', 'editrail'), cfg));
        li.appendChild(del);
        li.dataset.config = cfg;
        setList.appendChild(li);
      });
      node.appendChild(setList);
    }

    // --- Shared sets (#98): what other users share, and the user's own
    // copies whose set they have deleted. Absent when there is none, so
    // a site with no shared set shows the dialog it showed before.
    var listed = listedSharedSets();
    if (listed.length) {
      var sharedHead = settingsRow('h4', 'toolrail-settings-label');
      sharedHead.id = 'toolrail-settings-shared-head';
      sharedHead.textContent = __('Shared sets', 'editrail');
      node.appendChild(sharedHead);
      var sharedList = settingsRow('ul', 'toolrail-settings-sets');
      sharedList.setAttribute('aria-labelledby', 'toolrail-settings-shared-head');
      listed.forEach(function (item, i) {
        var neighbors = [];
        if (listed[i + 1]) {
          neighbors.push(listed[i + 1].id);
        }
        if (listed[i - 1]) {
          neighbors.push(listed[i - 1].id);
        }
        sharedList.appendChild(buildSharedSetRow(item, neighbors, tb));
      });
      node.appendChild(sharedList);
    }

    // --- Import ---
    var importLabel = settingsRow('label', 'toolrail-settings-label');
    importLabel.setAttribute('for', 'toolrail-settings-import');
    importLabel.textContent = __('Import a set file', 'editrail');
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
      if (!T.settingsOpen || !settingsNode()) {
        speak(message);
        return;
      }
      T.settingsStatus = message;
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
          result = { ok: false, error: __('That file is not valid JSON.', 'editrail') };
        }
        reportImport(result.ok ? importStatusMessage(result) : result.error);
      }).catch(function () {
        reportImport(__('The file could not be read.', 'editrail'));
      });
    });
    node.appendChild(importInput);

    // The Saved sets button on the rail (#93). Shown by default; it only
    // appears once a set exists, so an author with no sets sees nothing
    // new. Same checkbox shape as "Hide the Help button".
    var setsButtonRow = settingsRow('label', 'toolrail-settings-positionrow');
    var setsButtonToggle = document.createElement('input');
    setsButtonToggle.type = 'checkbox';
    setsButtonToggle.id = 'toolrail-settings-setsbutton';
    setsButtonToggle.checked = readKey(SETS_BUTTON_HIDDEN_KEY) !== '1';
    setsButtonToggle.addEventListener('change', function () {
      writeKey(SETS_BUTTON_HIDDEN_KEY, setsButtonToggle.checked ? '0' : '1');
      // Focus stays on this checkbox: rerender() only moves focus when
      // it was in the rail.
      T.rerender(mainToolbar);
    });
    var setsButtonText = settingsRow('span', '');
    // A shared set shows the button too (#98). The longer text only when
    // there is one, so the dialog is unchanged on a site with none.
    setsButtonText.textContent = listed.length
      ? __('Show a Saved sets button on the toolbar when you have a saved set or another user shares one', 'editrail')
      : __('Show a Saved sets button on the toolbar when you have a saved set', 'editrail');
    setsButtonRow.appendChild(setsButtonToggle);
    setsButtonRow.appendChild(setsButtonText);
    node.appendChild(setsButtonRow);

    // --- Inserting ---
    node.appendChild(settingsDivider());
    var insertHead = settingsRow('h3', 'toolrail-settings-subtitle');
    insertHead.textContent = __('Inserting', 'editrail');
    node.appendChild(insertHead);

    var hideInserterRow = settingsRow('label', 'toolrail-settings-positionrow');
    var hideInserter = document.createElement('input');
    hideInserter.type = 'checkbox';
    hideInserter.id = 'toolrail-settings-hideinserter';
    hideInserter.checked = hidesCoreInserterWhileArmed();
    hideInserter.addEventListener('change', function () {
      writeKey(HIDE_CORE_INSERTER_KEY, hideInserter.checked ? '1' : '0');
      // Takes effect on the next arm — or now, if a tool is armed.
      markCanvasArmed();
    });
    var hideInserterText = settingsRow('span', '');
    hideInserterText.textContent = __('While a tool is armed, hide the editor\'s own "+" buttons (between blocks, and beside an empty block)', 'editrail');
    hideInserterRow.appendChild(hideInserter);
    hideInserterRow.appendChild(hideInserterText);
    node.appendChild(hideInserterRow);

    var hideInserterHint = settingsRow('p', 'toolrail-settings-empty');
    hideInserterHint.textContent = __('With this off, the "+" can take the click that was meant for the armed tool.', 'editrail');
    node.appendChild(hideInserterHint);

    // --- Help ---
    node.appendChild(settingsDivider());
    var helpHead = settingsRow('h3', 'toolrail-settings-subtitle');
    helpHead.textContent = __('Help', 'editrail');
    node.appendChild(helpHead);

    var helpRow = settingsRow('div', 'toolrail-settings-helprow');
    helpRow.appendChild(settingsButton(__('Open toolbar help', 'editrail'), function () {
      // openHelp closes this dialog on purpose — the panel and the
      // dialog are sibling surfaces anchored to the same rail.
      var wrapper = document.getElementById(mainToolbar.regionId);
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
      T.rerender(mainToolbar);
    });
    var hideHelpText = settingsRow('span', '');
    hideHelpText.textContent = __('Hide the Help button from the toolbar (help stays available here)', 'editrail');
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
    if (T.settingsOpen) {
      closeSettings(true);
      return;
    }
    // The dialog always hangs in the FIRST toolbar's region, whichever
    // toolbar's button opened it: its gear is the focus-return target,
    // and a rebuild of an extra toolbar must not take the dialog with it
    // (#95).
    wrapper = document.getElementById(mainToolbar.regionId) || wrapper;
    closeFlyout(false);
    closeHelp(false);

    var node = settingsRow('div', 'toolrail-settings');
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-labelledby', 'toolrail-settings-title');
    // Focusable but not a Tab stop, like the help panel: a click on text
    // in the dialog (a label, a heading), or on any control in a browser
    // that does not focus buttons and checkboxes on click, then focuses
    // the dialog itself. Without it the focus went to the rail region,
    // outside the dialog, and onSettingsFocusin closed the dialog.
    node.tabIndex = -1;

    buildSettingsContent(node, '');
    wrapper.appendChild(node);
    T.settingsOpen = true;
    T.syncLayers();

    var gear = gearButton();
    if (gear) {
      gear.setAttribute('aria-expanded', 'true');
    }
    placeSurface(mainToolbar, node, gear, wrapper, true);
    document.addEventListener('mousedown', onSettingsMousedown, true);
    document.addEventListener('keydown', onSettingsKeydown, true);
    document.addEventListener('focusin', onSettingsFocusin, true);
    window.addEventListener('toolrail:tools-updated', onToolsUpdatedWhileOpen);
    // Shared sets may have changed since the list last came (#98). Not
    // awaited: the dialog is complete without it, and it redraws only
    // when the list did change.
    refreshSharedSets();

    if (focusSelector) {
      var initial = focusableIn(node, focusSelector);
      if (initial) {
        initial.focus();
        return;
      }
    }
    node.querySelector('#toolrail-settings-search').focus();
  }

  /**
   * Open Toolbar settings with a toolbar chosen, or choose it in the open
   * dialog. For the controls that act on one toolbar from outside the
   * dialog: an empty extra toolbar's "Add tools" button and the Toolbars
   * menu (#95). openSettings() alone would CLOSE an open dialog.
   *
   * @param {Object} tb            The toolbar to choose.
   * @param {string} focusSelector The control to focus.
   * @return {void}
   */
  function openSettingsFor(tb, focusSelector) {
    T.settingsToolbarId = tb.id;
    if (T.settingsOpen) {
      refreshSettings(focusSelector);
      return;
    }
    var wrapper = document.getElementById(mainToolbar.regionId);
    if (wrapper) {
      openSettings(wrapper, focusSelector);
    }
  }

  // -------------------------------------------------------------------
  // Help panel — the how-to copy that 0.1.5 moved out of every button's
  // accessible name, given a home a first-time user can find. Same
  // surface machinery as the settings dialog (placeSurface, syncLayer,
  // Escape returns focus, click-outside close). Static content only —
  // nothing here goes through the status machinery, because none of it
  // is a status.
  // -------------------------------------------------------------------

  T.helpOpen = false;

  /**
   * The open help panel, or null when it is closed.
   *
   * @return {HTMLElement|null} The panel node, or null.
   */
  function helpNode() {
    return document.querySelector('.toolrail-help');
  }

  /**
   * The rail's "?" button. Null when the author has hidden it, or before
   * the rail is built.
   *
   * @return {HTMLElement|null} The button, or null.
   */
  function helpButton() {
    var rail = document.getElementById(mainToolbar.railId);
    return rail ? rail.querySelector('[data-tool="help"]') : null;
  }

  /**
   * Whether the author has taken the "?" tool off the rail. The panel is
   * still reachable from Toolbar settings when it is hidden.
   *
   * @return {boolean} True when hidden.
   */
  function isHelpHidden() {
    return readKey(HELP_HIDDEN_KEY) === '1';
  }

  /** Where Escape sends focus back: the "?" tool when it renders, the
      gear when the author has hidden it (the settings dialog's own Help
      button cannot take it — that dialog closes when the panel opens). */
  function helpOpenerButton() {
    return helpButton() || gearButton();
  }

  /**
   * Close the help panel and release its three document listeners.
   *
   * @param {boolean} refocusOpener Return focus to the "?" tool, or to the
   *                                gear when the "?" is hidden.
   * @return {void}
   */
  function closeHelp(refocusOpener) {
    var node = helpNode();
    if (node) {
      node.remove();
    }
    T.helpOpen = false;
    T.syncLayers();
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

  /**
   * Dismiss the panel on a press outside it and outside its button.
   *
   * @param {MouseEvent} e The document mousedown.
   * @return {void}
   */
  function onHelpMousedown(e) {
    var node = helpNode();
    var btn = helpButton();
    if (node && !node.contains(e.target) && e.target !== btn && !(btn && btn.contains(e.target))) {
      closeHelp(false);
    }
  }

  /**
   * Escape closes the panel — but it only CLAIMS the key when focus is
   * actually in the panel or on its button. The auto-opened panel never
   * takes focus, so an Escape pressed then belongs to whatever the author
   * is really in; swallowing it left the inserter open and teleported the
   * caret.
   *
   * @param {KeyboardEvent} e The document keydown.
   * @return {void}
   */
  function onHelpKeydown(e) {
    if (e.key !== 'Escape' || !T.helpOpen) {
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

  /**
   * Close the panel once focus leaves it, without pulling focus back.
   *
   * @param {FocusEvent} e The document focusin.
   * @return {void}
   */
  function onHelpFocusin(e) {
    if (!T.helpOpen) {
      return;
    }
    var node = helpNode();
    var btn = helpButton();
    if (!node || node.contains(e.target) || e.target === btn || (btn && btn.contains(e.target))) {
      return;
    }
    closeHelp(false);
  }

  /**
   * The panel's copy, as titled sections of paragraphs. Built on each open
   * rather than held as a constant so the strings are translated after the
   * editor's locale data has loaded, and so a section can key off state
   * (the last one names whichever button the author can actually see).
   *
   * @return {Array<{title: string, body: Array<string>}>} The sections.
   */
  function helpSections() {
    return [
      {
        title: __('Inserting with a tool', 'editrail'),
        body: [
          __('Select a tool, then click in the canvas. The tool\'s block is inserted at the click point and the toolbar returns to Select. You can also drag a tool from the toolbar into the canvas and drop it where you want it.', 'editrail'),
          __('Shift-click in the canvas to keep the tool armed for repeat inserts. Press Escape to return to Select at any time.', 'editrail'),
          __('With the keyboard: press Enter on a tool to arm it, then press Ctrl+Enter (Cmd+Enter on a Mac), on the toolbar or in the canvas. The block goes after the selected block, or at the end of the post when no block is selected. A selected empty paragraph is replaced. Ctrl+Shift+Enter keeps the tool armed.', 'editrail'),
          __('While a tool is armed, the editor\'s own "+" buttons are hidden, so your click goes to the tool. A checkbox under "Inserting" in Toolbar settings turns this off.', 'editrail')
        ]
      },
      {
        title: __('Selecting several blocks', 'editrail'),
        body: [
          __('While Select is active, drag from empty canvas space to draw a rectangle: the space beside the content, around the title, or below the last block. Every block the rectangle touches is selected. A drag that starts in a block\'s text selects text, as before.', 'editrail'),
          __('Ctrl+click (Cmd+click on a Mac) adds or removes one block, and Alt+click removes one. With the keyboard: select a block and press Ctrl+Space to add it or to remove it, then move to a different block and press Ctrl+Space again.', 'editrail'),
          __('Some operating systems use Ctrl+Space for a different function, and the editor does not get the key. In that case, use "Add to selection" or "Remove from selection" in the block\'s options menu. It does the same thing as Ctrl+Space.', 'editrail'),
          __('When the selected blocks have a gap between them, they get a dashed outline, and a bar under the canvas has Move up, Move down, Duplicate, Group, Delete and Clear selection. While no tool is armed, press Ctrl+Enter (Cmd+Enter on a Mac) to go to the bar, and Escape to go back to the canvas. Each action is one undo step, and a locked block stays where it is.', 'editrail'),
          __('Escape in the canvas clears the selection. So does a click on a block or on empty space.', 'editrail')
        ]
      },
      {
        title: __('Pinning tools', 'editrail'),
        body: [
          __('Pin any block type or pattern as a quick-insert tool: search under "Add a block or pattern" in Toolbar settings, drag a block or pattern from the inserter onto the toolbar, or choose "Pin to toolbar" in a block\'s options menu.', 'editrail'),
          __('Drop a block from the canvas onto the toolbar to pin its type, or to save it as a pattern with its settings and contents and pin that. "Save as pattern and pin to toolbar…" in the block\'s options menu does the same.', 'editrail'),
          // More than one toolbar (#128).
          __('When more than one toolbar is shown, that dialog starts with a "Toolbar" choice. It selects the toolbar that you dropped the block on, or the main toolbar when you open the dialog from the block\'s options menu. To pin to a different toolbar, choose it there first.', 'editrail'),
          __('Remove a pin with Unpin in Toolbar settings, or "Unpin from toolbar" in the block\'s options menu.', 'editrail'),
          __('Edit, beside a pinned tool in Toolbar settings, gives that tool your own name, description or icon — useful when you pin several patterns. Empty fields use the block\'s own.', 'editrail')
        ]
      },
      {
        title: __('Section overview', 'editrail'),
        body: [
          __('The Section overview tool zooms the canvas out and outlines every top-level block. Click an outline to show its reorder controls — arrows to move it, "Reorder inside" to step into a section — or simply drag an outline to a new spot. Zoom with the +/− buttons and pan long documents with the mouse wheel.', 'editrail'),
          __('Select several outlines at once: Shift+click for a range, Ctrl+click (Cmd on Mac) to add or remove one, Alt+click to remove one, or drag a rectangle from empty space. Shift+Arrow extends the selection from the focused outline and Ctrl+Space toggles it. The arrows or a drag then move the whole group; a locked block shows a padlock and stays where it is.', 'editrail'),
          __('Escape closes the overview, the same as the Done button. While you drag an outline or draw a selection rectangle, Escape cancels that first and keeps the overview open. To leave a level without closing, use "Up one level" or the breadcrumb. Closing centers and selects the block you last picked, moved or stepped into; if you touched nothing, it returns you to where you were scrolled.', 'editrail')
        ]
      },
      {
        title: __('Moving the toolbar', 'editrail'),
        body: [
          __('Drag the toolbar by its grip and release near an edge to dock it there, or let go anywhere to float it over the editor.', 'editrail'),
          __('The keyboard path: pick a position under "Toolbar position" in Toolbar settings.', 'editrail'),
          // More than one toolbar (#95).
          __('To add a toolbar, use "Add a toolbar" in Toolbar settings. Each toolbar has its own name, pinned tools and position. To change a toolbar, choose it under "Toolbar" at the top of Toolbar settings. The Toolbars button on the main toolbar shows or hides each added toolbar.', 'editrail')
        ]
      },
      {
        title: __('Settings sidebar width', 'editrail'),
        body: [
          sprintf(
            /* translators: %d: the widest the settings sidebar can be, in pixels. */
            __('Turn on "Let me make the settings sidebar wider" in Toolbar settings. Then type a width there, use its Narrower and Wider buttons, or drag the inner edge of the editor\'s settings sidebar. The width goes up to %d pixels or half the window, whichever is less, and it is saved to your account.', 'editrail'),
            SIDEBAR_MAX_WIDTH
          ),
          sprintf(
            /* translators: %d: the default settings sidebar width, in pixels. */
            __('With the keyboard: Tab to the edge, the first stop in the sidebar, and use the Left and Right arrow keys. Shift takes bigger steps, and Home and End go to the narrowest and widest. Double-click the edge, or use "Reset to default width" in Toolbar settings, to go back to %d pixels.', 'editrail'),
            SIDEBAR_DEFAULT_WIDTH
          )
        ]
      },
      {
        title: __('Keyboard', 'editrail'),
        body: [
          __('The toolbar is one Tab stop. Arrow keys move between tools, following the toolbar\'s orientation; Home and End jump to the ends.', 'editrail'),
          // More than one toolbar (#95).
          __('Each toolbar that you add is one more Tab stop. Arrow keys stay inside one toolbar.', 'editrail'),
          __('ArrowRight opens a tool\'s flyout on a vertical toolbar; ArrowDown opens it on a horizontal one. Escape closes any open panel.', 'editrail'),
          __('Enter arms an insert tool, and a second Enter disarms it. While a tool is armed, Ctrl+Enter (Cmd+Enter on a Mac) inserts its block after the selected block.', 'editrail')
        ]
      },
      {
        title: __('Saved sets', 'editrail'),
        body: [
          __('Save the current pinned arrangement as a named set in Toolbar settings, and load a set to switch arrangements.', 'editrail'),
          __('When you have a saved set, the Saved sets button on the toolbar opens a list of your sets. Choose a set to load it. A check mark shows the set that matches the toolbar now. You can hide the button in Toolbar settings.', 'editrail'),
          __('Export a set as a small JSON file and import it on another site. Blocks the site does not have stay in the set and appear when their plugin or theme is active.', 'editrail'),
          // #98. Says "if you can share", because a Contributor cannot.
          __('Share a set with the other users of this site with Share beside the set in Toolbar settings, if your role can publish posts. Sets that other users share show under "Shared sets" and in the Saved sets list, with the name of the user who shared them. A load changes only your own toolbar.', 'editrail')
        ]
      },
      {
        // R10: the three kinds of "blue" on the rail, named. STE.
        title: __('What a highlighted tool means', 'editrail'),
        body: [
          __('A highlighted insert tool is armed: your next click in the canvas, or Ctrl+Enter, inserts its block. Select is highlighted whenever no tool is armed.', 'editrail'),
          __('A highlighted Section overview means that view is open, not that a tool is armed. Tools that need a canvas click are dimmed while the overview is open, and become available again when you close it.', 'editrail')
        ]
      }
    ];
  }

  /**
   * @param {HTMLElement} wrapper The region to hang the panel in.
   * @param {Object}      opts    {takeFocus: false} opens without moving
   *                              focus (no caller since the first-run
   *                              auto-open went in 0.1.22; kept for a
   *                              programmatic opener). Explicit opens
   *                              move focus into the panel so Escape and
   *                              Tab behave like the settings dialog.
   */
  function openHelp(wrapper, opts) {
    if (T.helpOpen) {
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
    title.textContent = __('Toolbar help', 'editrail');
    title.id = 'toolrail-help-title';
    head.appendChild(title);
    var close = settingsButton('×', function () { closeHelp(true); }, 'toolrail-settings-close');
    close.setAttribute('aria-label', __('Close toolbar help', 'editrail'));
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
    T.helpOpen = true;
    T.syncLayers();

    var btn = helpButton();
    if (btn) {
      btn.setAttribute('aria-expanded', 'true');
    }
    placeSurface(mainToolbar, node, btn || gearButton(), wrapper, true);
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

  // The Help panel never opens by itself. 0.1.9–0.1.21 auto-opened it
  // once per account; on a fresh account that collided with core's own
  // "Welcome to the editor" guide — the panel is light-dismiss, so the
  // click that closed the guide closed the help, unread, and the
  // one-time stamp was already spent. Owner decision 2026-09-02: two
  // first-run surfaces is one too many. The "?" tool and Toolbar
  // settings are the ways in; the old `toolrail-help-seen` stamp is
  // simply never read again.

  // Shared with the other files of the rail (see editor-rail-core.js).
  T.settingsNode = settingsNode;
  T.settingsToolbar = settingsToolbar;
  T.placeOpenDialogs = placeOpenDialogs;
  T.gearButton = gearButton;
  T.closeSettings = closeSettings;
  T.settingsRow = settingsRow;
  T.settingsButton = settingsButton;
  T.focusableIn = focusableIn;
  T.refreshSettings = refreshSettings;
  T.BLOCK_NAME_PATTERN = BLOCK_NAME_PATTERN;
  T.missingBlockCount = missingBlockCount;
  T.exportConfig = exportConfig;
  T.setFilePayload = setFilePayload;
  T.downloadSetFile = downloadSetFile;
  T.importConfigPayload = importConfigPayload;
  T.openSettings = openSettings;
  T.openSettingsFor = openSettingsFor;
  T.isHelpHidden = isHelpHidden;
  T.closeHelp = closeHelp;
  T.openHelp = openHelp;

  // This file ran to its end. The next file checks this number.
  T.loaded = 4;
})(window.wp);
