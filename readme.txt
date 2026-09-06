=== Editor Tool Rail ===
Contributors: matthewneilcowan
Tags: block editor, toolbar, tools
Requires at least: 6.5
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 1.0.1
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

A movable, graphics-editor-style toolbar for the block editor. Click a tool, then click the canvas to insert a core block at that point.

== Description ==

Editor Tool Rail adds a toolbar to the post editor, docked to the left edge by default, movable to any edge or floating as a palette. Selecting a tool arms it: the next click in the canvas inserts that tool's block at the click point, then the rail returns to Select (Shift-click keeps the tool armed).

Everything the rail inserts is an ordinary core block. Deactivating this plugin changes nothing about how authored content renders or stays editable.

* Pin any block type as a quick-insert tool: search for it in Toolbar settings, drag it from the inserter onto the rail, or use "Pin to toolbar" in the block's options menu. Pins, the toolbar position and saved sets are saved to your user account on the site — set the toolbar up once and it follows you across browsers and devices.
* Give a pinned tool your own name, description or icon: use Edit beside the tool under "Pinned tools" in Toolbar settings. Empty fields use the block's own. This helps when you pin several patterns, or when a site sets up a tool for you. The icon is up to three characters, or a Dashicon picked from a searchable list. Saved sets keep them, and set files carry them along.
* Built-in tools: Select and Section overview. Group, Text, Heading and Image are ordinary pinned blocks, so you can reorder or remove them like anything else you pin. If you unpin the defaults, a "Restore default tools" button in Toolbar settings brings back the missing ones without touching your own pins.
* While a tool is armed, the editor's own "+" buttons (between blocks, and beside an empty block) are hidden, so your click goes to the armed tool. The drop line you see while you drag a block is not affected. A checkbox under "Inserting" in Toolbar settings turns this off.
* Drag a tool from the toolbar into the canvas to place its block where you drop it. Clicking a tool still arms it.
* Pin patterns too. Search under "Add a block or pattern" in Toolbar settings for your own patterns and the theme's and core's, or drag a pattern from the inserter onto the toolbar. An armed pattern inserts a fresh copy at the click point; a synced pattern inserts a reference, the same as the inserter does.
* Drop a block from the canvas onto the toolbar and choose: pin its block type, or save the block with its settings and contents as one of your patterns and pin that pattern. The same dialog opens from "Save as pattern and pin to toolbar…" in the block's options menu.
* Section overview: one tool zooms the canvas out and draws an outline around every top-level block, with a small name tag in the corner. Drag an outline to reorder it, or click it to reveal reorder controls inside the lines — arrows to move it, and a "Reorder inside" button to step into a section and reorder its blocks the same way, with a breadcrumb back out. Select several outlines at once — Shift+click for a range, Ctrl+click (Cmd on Mac) to add or remove one, or a rectangle dragged from empty space — and the arrows or a drag then move the whole group; locked blocks show a padlock and stay where they are. Zoom with the +/− buttons and pan long documents with the mouse wheel. Every move works by keyboard and is announced to screen readers — dragging is a shortcut, never the only way — and closing centers and selects the block you last picked, moved or stepped into (if you touched nothing, it returns you to where you were scrolled). Reordering is an ordinary editing action — the saved post is exactly what the List View would have written.
* Save pinned arrangements as named sets, and move them between sites as small JSON files (Export/Import in Toolbar settings). A set may name blocks a site doesn't have — those stay in the set and appear when their plugin or theme is active.
* Move the toolbar where you want it: it starts on the left edge, and can dock to the right edge (past the settings side panel), to a full-width bar across the top or the bottom, or float free as a tool palette. Drag it by the grip and release near an edge to snap it there, or pick a position in Toolbar settings. Flyouts and panels open away from the docked edge — a top toolbar opens downward, a bottom one upward.
* Full keyboard operability: one tab stop, arrow keys, Home/End, Escape disarms. Toolbar settings and the tool flyouts close on Escape and when you tab past them, so they never sit open behind you. Arrow keys follow the toolbar's orientation — Up/Down along a vertical rail with ArrowRight opening a tool's flyout, Left/Right along a horizontal one with ArrowDown opening the flyout. Repositioning has a keyboard path of its own in Toolbar settings, so it never depends on dragging.
* Show tool names beside the icons: a "Tool names" checkbox in Toolbar settings widens a vertical or floating toolbar into icon + name rows. Icon-only toolbars ask you to learn the icons; this is the way around that. If you switch often, a second checkbox adds an expand/contract button to the toolbar itself.
* Pick the toolbar's colors: Dark (default), Light and Gray presets, or your own background + text pair. Every preset meets the WCAG contrast minimums, and with custom colors the focus ring and pressed markers are adjusted automatically so they stay visible.
* A Help panel ("?" next to the gear) explains inserting, pinning, moving the toolbar, the keyboard model, saved sets, and what a highlighted tool means. It never opens by itself; open it from the "?" or from Toolbar settings. You can hide the "?" from the toolbar — the panel stays available from Toolbar settings.
* Tools that need a canvas click are dimmed while the Section overview is open, with the reason in their tooltip. They stay in the keyboard order and keep their names for screen readers. Tools that open a panel stay available.
* Provider API for themes and plugins: PHP filter `toolrail_tool_providers` + JS `window.toolrail.registerTool()`. A tool can declare `supports: { canvas: true }` when its action needs a canvas click, so the toolbar dims it in any mode that captures the canvas. A plugin can nest its tools under a pinned tool and keep its own settings on that pin. The settings are removed when the pin is unpinned, and come back when you load a saved set that has them.

== Frequently Asked Questions ==

= Where is the toolbar position saved? =

Against your user account on this site, the same as pinned blocks and saved sets. WordPress's own per-user editor preferences carry it, so a different browser or device shows the toolbar exactly where you left it once you log in. It is never site content and never affects other users. Preferences are per-site; to carry a pinned arrangement to a different site, export it as a set file and import it there.

= Can I put it back if I lose it? =

Yes. Open Toolbar settings from the gear at the end of the toolbar and choose a position under "Toolbar position".

= What does deleting the plugin remove? =

Its own preferences, and nothing else. The plugin stores no options and writes nothing into posts. Deleting it from the Plugins screen removes the pinned tools, toolbar position, saved sets and colors from every user account on the site. Deactivating it keeps them, so the toolbar comes back as you left it when you activate the plugin again. In rare cases a browser holds an older local copy of the pins, the toolbar position or the saved sets (from a session where the browser's storage failed, or from a version before 0.1.6). If you install the plugin again in that browser, that copy comes back one time. Unpin what you do not want; it does not return again.

== Changelog ==

= 1.0.1 =
* Edit a pinned tool's name, description and icon from Toolbar settings. Pick the icon from a searchable list of Dashicons, or type up to three characters. Saved sets keep these, and set files carry them along.
* Plugins can keep their own settings on a pinned tool. The settings are removed when the tool is unpinned, and travel in saved sets.

= 1.0.0 =
* First public release.
