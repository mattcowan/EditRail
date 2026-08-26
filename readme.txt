=== Editor Tool Rail ===
Contributors: matthewneilcowan
Tags: block editor, toolbar, tools
Requires at least: 6.5
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.1.6
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

A movable, Photoshop-familiar toolbar for the block editor. Dock it to any edge or float it. Tools can insert ordinary core blocks, and a small provider API allows insertion of custom buttons from themes and plugins.

== Description ==

Editor Tool Rail adds a toolbar to the post editor, docked to the left edge by default, movable to any edge or floating as a palette. Selecting a tool arms it: the next click in the canvas inserts that tool's block at the click point, then the rail returns to Select (Shift-click keeps the tool armed).

Everything the rail inserts is an ordinary core block. Deactivating this plugin changes nothing about how authored content renders or stays editable.

* Built-in tools: Select, Shape (circle, rounded rectangle, hexagon, star), Section. Text, Heading and Image ship as ordinary pinned blocks, so you can reorder or remove them like anything else you pin.
* Pin any block type as a quick-insert tool: search for it in Toolbar settings, drag it from the inserter onto the rail, or use "Pin to toolbar" in the block's options menu. Pins, the toolbar position and saved sets are saved to your user account on the site — set the toolbar up once and it follows you across browsers and devices.
* Save pinned arrangements as named sets, and move them between sites as small JSON files (Export/Import in Toolbar settings). A set may name blocks a site doesn't have — those stay in the set and appear when their plugin or theme is active.
* Move the toolbar where you want it: it starts on the left edge, and can dock to the right edge (past the settings side panel), to a full-width bar across the top or the bottom, or float free as a Photoshop-style palette. Drag it by the grip and release near an edge to snap it there, or pick a position in Toolbar settings. Flyouts and panels open away from the docked edge — a top toolbar opens downward, a bottom one upward.
* Full keyboard operability: one tab stop, arrow keys, Home/End, Escape disarms. Toolbar settings and the tool flyouts close on Escape and when you tab past them, so they never sit open behind you. Arrow keys follow the toolbar's orientation — Up/Down along a vertical rail with ArrowRight opening a tool's flyout, Left/Right along a horizontal one with ArrowDown opening the flyout. Repositioning has a keyboard path of its own in Toolbar settings, so it never depends on dragging.
* Provider API for themes and plugins: PHP filter `toolrail_tool_providers` + JS `window.toolrail.registerTool()`.

== Frequently Asked Questions ==

= Where is the toolbar position saved? =

Against your user account on this site, the same as pinned blocks and saved sets — WordPress's own per-user editor preferences carry it, so a different browser or device shows the toolbar exactly where you left it once you log in. It is never site content and never affects other users. Preferences are per-site; to carry a pinned arrangement to a different site, export it as a set file and import it there.

= Can I put it back if I lose it? =

Yes. Open Toolbar settings from the gear at the end of the toolbar and choose a position under "Toolbar position".

== Changelog ==

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
