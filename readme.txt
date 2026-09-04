=== Editor Tool Rail ===
Contributors: matthewneilcowan
Tags: block editor, toolbar, tools
Requires at least: 6.5
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.1.25
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

A movable, graphics-editor-style toolbar for the block editor. Click a tool, then click the canvas to insert a core block at that point.

== Description ==

Editor Tool Rail adds a toolbar to the post editor, docked to the left edge by default, movable to any edge or floating as a palette. Selecting a tool arms it: the next click in the canvas inserts that tool's block at the click point, then the rail returns to Select (Shift-click keeps the tool armed).

Everything the rail inserts is an ordinary core block. Deactivating this plugin changes nothing about how authored content renders or stays editable.

* Built-in tools: Select and Section overview. Group, Text, Heading and Image ship as ordinary pinned blocks, so you can reorder or remove them like anything else you pin. If you unpin the defaults, a "Restore default tools" button in Toolbar settings brings back the missing ones without touching your own pins.
* While a tool is armed, the editor's own "+" buttons (between blocks, and beside an empty block) are hidden, so your click goes to the armed tool. The drop line you see while you drag a block is not affected. A checkbox under "Inserting" in Toolbar settings turns this off.
* Drag a tool from the toolbar into the canvas to place its block where you drop it. Clicking a tool still arms it.
* Pin patterns too. Search under "Add a block or pattern" in Toolbar settings for your own patterns and the theme's and core's, or drag a pattern from the inserter onto the toolbar. An armed pattern inserts a fresh copy at the click point; a synced pattern inserts a reference, the same as the inserter does.
* Drop a block from the canvas onto the toolbar and choose: pin its block type, or save the block with its settings and contents as one of your patterns and pin that pattern. The same dialog opens from "Save as pattern and pin to toolbar…" in the block's options menu.
* Section overview: one tool zooms the canvas out and draws an outline around every top-level block, with a small name tag in the corner. Drag an outline to reorder it, or click it to reveal reorder controls inside the lines — arrows to move it, and a "Reorder inside" button to step into a section and reorder its blocks the same way, with a breadcrumb back out. Select several outlines at once — Shift+click for a range, Ctrl+click (Cmd on Mac) to add or remove one, or a rectangle dragged from empty space — and the arrows or a drag then move the whole group; locked blocks show a padlock and stay where they are. Zoom with the +/− buttons and pan long documents with the mouse wheel. Every move works by keyboard and is announced to screen readers — dragging is a shortcut, never the only way — and closing centers and selects the block you last picked, moved or stepped into (if you touched nothing, it returns you to where you were scrolled). Reordering is an ordinary editing action — the saved post is exactly what the List View would have written.
* Pin any block type as a quick-insert tool: search for it in Toolbar settings, drag it from the inserter onto the rail, or use "Pin to toolbar" in the block's options menu. Pins, the toolbar position and saved sets are saved to your user account on the site — set the toolbar up once and it follows you across browsers and devices.
* Save pinned arrangements as named sets, and move them between sites as small JSON files (Export/Import in Toolbar settings). A set may name blocks a site doesn't have — those stay in the set and appear when their plugin or theme is active.
* Move the toolbar where you want it: it starts on the left edge, and can dock to the right edge (past the settings side panel), to a full-width bar across the top or the bottom, or float free as a tool palette. Drag it by the grip and release near an edge to snap it there, or pick a position in Toolbar settings. Flyouts and panels open away from the docked edge — a top toolbar opens downward, a bottom one upward.
* Full keyboard operability: one tab stop, arrow keys, Home/End, Escape disarms. Toolbar settings and the tool flyouts close on Escape and when you tab past them, so they never sit open behind you. Arrow keys follow the toolbar's orientation — Up/Down along a vertical rail with ArrowRight opening a tool's flyout, Left/Right along a horizontal one with ArrowDown opening the flyout. Repositioning has a keyboard path of its own in Toolbar settings, so it never depends on dragging.
* Show tool names beside the icons: a "Tool names" checkbox in Toolbar settings widens a vertical or floating toolbar into icon + name rows. Icon-only toolbars ask you to learn the icons; this is the way around that. If you switch often, a second checkbox adds an expand/contract button to the toolbar itself.
* Pick the toolbar's colors: Dark (default), Light and Gray presets, or your own background + text pair. Every preset meets the WCAG contrast minimums, and with custom colors the focus ring and pressed markers are adjusted automatically so they stay visible.
* A Help panel ("?" next to the gear) explains inserting, pinning, moving the toolbar, the keyboard model, saved sets, and what a highlighted tool means. It never opens by itself; open it from the "?" or from Toolbar settings. You can hide the "?" from the toolbar — the panel stays available from Toolbar settings.
* Tools that need a canvas click are dimmed while the Section overview is open, with the reason in their tooltip. They stay in the keyboard order and keep their names for screen readers. Tools that open a panel stay available.
* Provider API for themes and plugins: PHP filter `toolrail_tool_providers` + JS `window.toolrail.registerTool()`. A tool can declare `supports: { canvas: true }` when its action needs a canvas click, so the toolbar dims it in any mode that captures the canvas.

== Frequently Asked Questions ==

= Where is the toolbar position saved? =

Against your user account on this site, the same as pinned blocks and saved sets — WordPress's own per-user editor preferences carry it, so a different browser or device shows the toolbar exactly where you left it once you log in. It is never site content and never affects other users. Preferences are per-site; to carry a pinned arrangement to a different site, export it as a set file and import it there.

= Can I put it back if I lose it? =

Yes. Open Toolbar settings from the gear at the end of the toolbar and choose a position under "Toolbar position".

= What does deleting the plugin remove? =

Its own preferences, and nothing else. The plugin stores no options and writes nothing into posts. Deleting it from the Plugins screen removes the pinned tools, toolbar position, saved sets and colors from every user account on the site. Deactivating it keeps them, so the toolbar comes back as you left it when you activate the plugin again. A browser can keep a local copy of the preferences from before the deletion; if you install the plugin again in the same browser, that copy comes back. To start clean in that browser, use "Restore default tools" in Toolbar settings.

== Changelog ==

= 0.1.25 =
* Deleting the plugin from the Plugins screen now removes its per-user preferences (pinned tools, toolbar position, saved sets, colors and the help and inserter toggles) from every user account on the site, and on every site of a network. Deactivating keeps them. Before this, a reinstall found the old pins still in place.

= 0.1.24 =
* Fix: the "Add to toolbar" dialog could open behind the editor's own panels (the Document Overview, the settings sidebar) with focus inside it. It now rises above them like the other toolbar surfaces.
* Fix: a pattern that is a single block with no children (a styled heading, a lone image) dragged from the inserter pinned the block type instead of the pattern. Every dropped pattern now pins the pattern. A block whose plain markup is identical to some pattern's whole content pins that pattern; the two cannot be told apart.
* Fix: a synced pattern dragged from the inserter before the site's pattern list had loaded pinned a broken reference. It now pins the pattern, which shows once the list loads.
* Fix: the dialog could say you cannot create patterns while the permission check was still running. It now waits for the answer, and a real refusal shows as the save's own error.
* Fix: a set file loaded or imported before the pattern list arrived reported its pattern pins as unavailable. They are counted only once the list has loaded.
* Fix: a toolbar rebuild during a drag from the toolbar could leave the toolbar refusing drops for the rest of the session.
* The "Block" tag on a search result is now part of the button's accessible name ("Pin the Quote block to the toolbar").

= 0.1.23 =
* Drag a tool from the toolbar into the canvas to place its block where you drop it, the way the editor's own inserter works. The drop line, the target and the insert are the editor's own. Clicking a tool still arms it, and the keyboard path is unchanged.
* Pin patterns as well as block types. The settings section is now "Pinned tools", and the search under "Add a block or pattern" lists your own patterns and the theme's and core's, each result tagged Block or Pattern. A pattern dragged from the inserter onto the toolbar pins that pattern. An armed pattern inserts a fresh copy at the click point; a synced pattern inserts a reference. Pattern pins travel in saved sets and stay hidden on a site that does not have the pattern.
* Drop a block from the canvas onto the toolbar to open a small "Add to toolbar" dialog: pin the block type, or give the block a name and save it, with its settings and contents, as one of your unsynced patterns, pinned to the toolbar. The same dialog opens from "Save as pattern and pin to toolbar…" in the block's options menu, for one block or several. The pin is a snapshot: editing an inserted copy never changes it.

= 0.1.22 =
* The Section tool is now the Group block, pinned by default at the head of the pinned blocks. Unpin it, move it, or put it in a saved set like any other pin. It inserts the Group block the same way the inserter does, so you pick a layout (Group, Row, Stack or Grid) after it lands. An account that already had the toolbar gets Group added once, ahead of its own pins; a toolbar you emptied stays empty. "Restore default tools" now restores Group too. A plugin that nests a tool under `section` now nests it under the pinned Group; if you unpin Group, that tool shows at the top level of the toolbar.
* Fix: with a tool armed, the editor's own "+" button between blocks (and at the foot of a Cover) took the click and opened the block picker instead of inserting the armed block. The "+" buttons are now hidden while a tool is armed; the drop line shown while you drag a block stays. A new checkbox under "Inserting" in Toolbar settings turns this off.
* Fix: an armed click in the gap between two blocks put the new block at the end of the document. It now goes between the two blocks, inside the same parent. In a Row, Grid or Columns layout the gap is read left to right (right to left in RTL), not top to bottom only.
* Fix: an armed click inside a block that does not accept the armed block (a Heading between two Columns, for example) inserted nothing and returned the toolbar to Select without a word. The block now lands right after that container, in the nearest parent that accepts it. If no parent accepts it, a message says so and the tool stays armed.
* The Help panel no longer opens by itself on your first visit. On a fresh account it opened under the editor's own "Welcome to the editor" guide, and the click that closed the guide closed the Help panel too. Open it from the "?" or from Toolbar settings.

= 0.1.21 =
* Two hooks for extension plugins: `window.toolrail.prefs` reads and writes per-user preferences under a `toolrail-ext:` key prefix, and `window.toolrail.getCanvasGeometry()` reports where the canvas is on screen, with its scale and pan. The first plugin that uses them is Toolrail Guides (rulers, guides and snap). A tool inside a flyout that turns something on and off now shows its state to screen readers as a checked menu item. Nothing else changes for authors.

= 0.1.20 =
* Section overview: select more than one block and move them as a group. Shift+click selects a range; Ctrl+click (Cmd on Mac) adds or removes one box; Alt+click removes one; a drag from empty space draws a rectangle that selects every box it touches. Each selected outline shows a tick mark, so you can see the full selection without color. The arrows and a drag on any selected box move the whole group — the blocks keep their order and land next to each other. Keyboard: Shift+Arrow extends the selection, Ctrl+Space (Cmd+Space) toggles the focused box, and every selection change and group move is announced with the count. Escape closes the overview, the same as the Done button; while you drag an outline or draw a rectangle, Escape cancels that first and says so.
* Locked blocks now show a padlock and the word "Locked". The marker stays visible when the block is part of a selection. A locked block stays where it is when the group moves, and the announcement says so. The group arrows stay available while any other block in the selection can move.
* A group whose blocks are not next to each other moves as more than one editing step, so undo can take more than one press for that move. A selection of neighboring blocks moves as one step — the same result List View writes.

= 0.1.19 =
* Closing the Section overview now takes you to the block you last picked, moved or stepped into: the overview fades out over a canvas already scrolled to that block — there is no scroll to watch — the block is selected, and the close announcement names it. With the "reduce motion" system preference set, the overview disappears at once instead of fading. If you touched nothing, closing still returns you to where you were scrolled, exactly as before.

= 0.1.18 =
* Tools that insert on a canvas click are dimmed while the Section overview is open. Before, they could be armed under the overview, showed as pressed, and could never insert. Dimmed tools stay in the arrow-key order and keep their names for screen readers; their tooltip says why. Select, Help, Toolbar settings, the overview itself, and tools that open a panel stay available. Opening the overview announces this once.
* The Help panel gains a section on what a highlighted tool means: an armed insert tool, Select when nothing is armed, or an open Section overview. The overview's tooltip says "open" while it is up.
* An open Section overview (or a plugin's open panel) now shows only the edge bar, not the filled highlight an armed tool has, so the two states no longer look the same. Help and Toolbar settings show the same bar while their panel is open.
* Provider API: a registered tool can declare `supports: { canvas: true }` (its action needs a canvas click) or `supports: { canvas: false }`. Without the field, tools that insert a block default to true and `onActivate` tools default to false. `window.toolrail.getMode()` returns the toolbar's mode, and the `toolrail:mode-changed` window event fires when it changes.
* Custom colors derive a dimmed-icon color that keeps at least 3:1 against the background; the Light and Gray presets carry one too.

= 0.1.17 =
* Fix: on a short post, opening the Section overview shrank the canvas to the height of the content, so the editor's gray background showed under the last block. The canvas now keeps at least the height it had before the overview opened; the zoom is unchanged.

= 0.1.16 =
* Fix: with the "There is an autosave" notice open, the Section overview fit the page to a space taller than the canvas really had — the bottom section sat below the edge and no amount of scrolling could reach it. The overview now measures the space below the notice, keeps the notice visible and clickable above the mode, and refits itself if the notice appears or is dismissed while the overview is open.
* Dragging a section sideways now works inside grids and columns: the drop marker turns into a vertical line between side-by-side blocks and follows the pointer across a row, instead of only up and down. Plain stacked sections drag exactly as before.

= 0.1.15 =
* "Reorder inside" now isolates the section you stepped into: it is centered in the viewport and everything outside it is veiled at 50%, so what you can move is the only thing at full strength.
* Fix: on entry the canvas background could visibly creep down the page for a second or more — the editor's own iframe transition was animating the overview's resize, and the measurement it was based on chased its own result. The zoom now sizes itself to the actual content, instantly, which also removes the dead space that could sit under the last section.

= 0.1.14 =
* Add Section overview: a toolbar tool that zooms the canvas out and outlines every top-level block, with a small name tag in the corner. Drag an outline to a new spot, or click it to reveal its reorder controls inside the lines — the content stays readable until you ask. Arrows move the block (fully keyboard-operable, every move announced; dragging is a shortcut, never the only way), "Reorder inside" steps into a section to reorder its blocks at their own zoom with a breadcrumb back out, +/− buttons zoom, and the mouse wheel pans long documents. While the overview is open, clicks cannot fall through to the document. Closing returns you to where you were scrolled. Reordering is an ordinary editing action, so the saved post is exactly what reordering in List View would produce — and deactivating the plugin still changes nothing about your content.
* The overview's zoom never shrinks a page's typical section below a usable size — on very long posts it stops at a floor computed from the content and lets the mouse wheel cover the rest, instead of fitting everything into one unreadable screen.
* Opening the overview sets aside the selected block (and its floating toolbar) for the mode's lifetime and restores the selection on close; the bar names the mode, and exiting is a labeled Done button with an Esc hint, inside a visible frame around the whole overview.
* Add "Restore default tools" to the Pinned blocks section of Toolbar settings: it re-pins whichever of Text, Heading and Image are missing, in their default order, and leaves every pin you chose exactly where it is. If nothing is missing, it says so; if the saved list cannot be read, nothing is changed and it says that instead.
* The Section tool now sits at the head of the pinned blocks, right after Select.
* The Shape tool is set aside until a later release; its spot on the toolbar is reserved.
* A block whose movement is locked shows disabled arrows in the overview instead of announcing a move that did not happen; the overview closes itself if the window becomes too narrow to show it.

= 0.1.12 =
* Wide mode is now controlled from Toolbar settings ("Tool names"), and the on-toolbar expand/contract button is opt-in from the same place — a permanent button at the toolbar's head cost space every author paid for a toggle few use often.
* Toolbar settings sections are separated by dividers, and Pinned blocks now sits directly above "Add a block" — the list you are managing and the search that adds to it read as one unit, with a new pin landing at the bottom of the list, right above the search.
* Fix: with custom colors, a pair measuring just under 4.5:1 could display as "4.5:1, below the 4.5:1 minimum". The shown value is now floored so it never contradicts the warning.
* Fix: a toolbar carrying more tools than the editor is tall scrolled as a whole, pushing Help and the settings gear below the fold — and its scrollbar stole width from the tools, which then showed a stray sideways scrollbar strip. Only the tools section scrolls now, with no native scrollbars: small step arrows appear when there is more to scroll, the grip and the Help/Settings tail stay visible at any height, and the mouse wheel, touch and keyboard all still scroll the tools directly.

= 0.1.11 =
* Add appearance settings: Dark (default), Light and Gray presets, or a custom background + text pair, in Toolbar settings. The presets meet the WCAG contrast minimums. With custom colors, the panel reports the pair's measured contrast in text and warns below 4.5:1; the pair still applies, and the focus ring and pressed markers are derived automatically so they never drop below 3:1.
* The drag snap preview keeps the editor's blue in every appearance — it draws on the editor, not on the toolbar.

= 0.1.10 =
* Add wide mode: a chevron at the head of a vertical or floating toolbar shows each tool's name beside its icon. The choice is saved to your account. Hidden on top and bottom toolbars, where a name per tool makes the bar too long.
* The toolbar keeps its one-tab-stop keyboard model in wide mode; the chevron joins the arrow-key order.

= 0.1.9 =
* Add a Help panel: a "?" button beside the settings gear explains inserting with a tool, pinning blocks, moving the toolbar, the keyboard model, and saved sets. It opens by itself once, the first time the toolbar appears for your account, and never again unless you open it.
* A checkbox in Toolbar settings hides the "?" from the toolbar; the panel stays reachable from a Help button inside Toolbar settings.

= 0.1.8 =
* Fix: the Toolbar settings note still said pinned blocks are "saved in this browser". They are saved to your account on this site since 0.1.6. The note, the integration doc, and stale code comments now say so.

= 0.1.7 =
* Fix: on an author's very first visit to the editor, the account-preferences attach could resolve after this plugin's own migration had already written the default pinned tools — silently wiping them the moment the attach landed.
* Fix: if the account-preferences store failed to save (storage quota, private browsing), the write appeared to succeed and reads kept returning the old value — unpinning a tool, for example, could silently fail to stick.
* Fix: an author's second browser could have its own real pins and position silently discarded during account-preferences migration, blocked by an unrelated stamp a first, empty-handed browser had already set.

= 0.1.6 =
* The toolbar position, pinned blocks and saved sets are now saved to your user account on the site (WordPress's own per-user editor preferences) instead of to one browser — set the toolbar up once and it follows you across browsers and devices. Anything you had already set up in this browser is carried over automatically the first time you open the editor.
* Preferences are per-site; set export/import remains the way to move a pinned arrangement between sites.

= 0.1.5 =
* Pinned blocks no longer show a hover × and the Delete key no longer unpins — accidental removal was one slip away, with recovery buried in settings. Removing a pinned block is now a deliberate act: the Unpin button in Toolbar settings, or "Unpin from toolbar" in the block's options menu.
* Screen readers now hear each tool's short name ("Heading (pinned block)") instead of a repeated wall of how-to instructions on every button; the instructions remain in the pointer tooltips.
* The upgrade step now seeds Text, Heading and Image for a browser whose slot list was emptied under an old build — back then they were fixed tools, so an empty list never meant choosing an empty toolbar. Removing them after this version still sticks.

= 0.1.4 =
* Fix: the focus outline on controls inside Toolbar settings still failed the contrast minimum after 0.1.3 — that panel was treated as a light surface when it is the same dark one as the toolbar. Every focus outline in the plugin now uses a single colour, checked against the surface it is actually drawn on.
* Fix: inserting two blocks in quick succession (the Shift-click repeat workflow) could delete the second one a moment after it appeared.
* Fix: switching back to Select immediately after an insert could delete the paragraph the click was meant to start.
* Fix: if browser storage started failing part-way through a session, pinned tools and saved sets could disappear until the page was reloaded.
* Fix: the upgrade step re-pinned Text, Heading and Image for authors who had deliberately removed all three.

= 0.1.3 =
* Fix: on upgrade, Text, Heading and Image silently disappeared from the toolbar for anyone who had already pinned a block or loaded a saved set. They are restored once, ahead of your own pins; removing them still sticks.
* Fix: clicking empty space below the content with a tool armed inserted the block you asked for AND left an empty paragraph above it.
* Fix: Tab moved out of the Toolbar settings panel and the flyout menus while they stayed open, and Escape then could not close them.
* Fix: import and saved-set results were shown on screen but never announced to screen readers.
* Fix: a set file listing the same block twice produced two toolbar buttons that could not be told apart.
* Fix: an import message could appear later, out of context, the next time Toolbar settings was opened.
* Fix: with browser storage unavailable (a private window, or site data blocked), unpinning appeared to work and the tool came straight back.
* Accessibility: the keyboard focus outline on the toolbar and flyouts now meets the WCAG contrast minimum for non-text (it measured 2.97:1 against the required 3:1). Controls inside Toolbar settings were missed and are fixed in 0.1.4.
* Accessibility: the "Remove" button under Pinned blocks is now labelled "Unpin", matching the name assistive tech reads out (WCAG 2.5.3 Label in Name).
* Accessibility: the toolbar keeps its pressed, focused and panel states visible in Windows High Contrast mode.
* Counts in messages now read correctly in the singular.

= 0.1.2 =
* Text, Heading and Image are now ordinary pinned blocks (reorder, remove, re-pin them like any other) instead of fixed built-ins. They seed as defaults the first time; removing them sticks.
* Export any saved set as a JSON file and import set files, including sets from other sites — blocks a site doesn't register are kept in the set and appear when their plugin or theme is active, with the outcome reported in text.
* Fix: a pinned core block (Cover, for example) showed an empty button — core block icons are viewBox-only SVGs with no intrinsic size, and nothing sized them.
* Tool flyouts now attach to pinned blocks too: a registered tool may name `parent: 'text'` (aliases the pinned Paragraph slot), a block name like `'core/paragraph'`, or a slot id.

= 0.1.1 =
* Add toolbar positioning: dock left (default), right, top or bottom, or float the toolbar. Drag by the grip to snap to an edge, or choose a position in Toolbar settings.
* Flyouts and the settings dialog now open away from the docked edge instead of always to the right.
* Toolbar arrow keys follow the toolbar's orientation, per the ARIA Authoring Practices for toolbars.
* Fix: focus could leave the settings dialog when reordering a pinned block to either end of the list.
* Fix: changes made inside the settings dialog moved focus to the toolbar.
* Fix: the settings gear could report an open dialog after the editor rebuilt the toolbar, taking two clicks to reopen.
* Fix: pinned-block icons leaked a React root on every toolbar rebuild.
* Fix: a half-typed saved-set name was discarded when the toolbar changed elsewhere.
* Fix: a saved set named `__proto__` reported success while storing nothing.
* Fix: `registerTool()` now refuses an id that cannot be used in a selector, instead of throwing.
* Fix: the toolbar's flyouts and settings panel could open behind the editor's side panels, including behind Document Overview in the default left position.
* Fix: a floating toolbar could be dropped underneath the publish bar at the bottom of the editor.
* The toolbar now steps aside for modal dialogs, so it never covers the media library or Preferences.

= 0.1.0 =
* Initial release: rail chrome, armed-tool insertion, quick slots, provider registration API.
