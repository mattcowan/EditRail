=== Editor Tool Rail ===
Contributors: matthewneilcowan
Tags: block editor, toolbar, tools, accessibility
Requires at least: 6.5
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.2.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

A Photoshop-familiar left toolbar for the block editor. Tools insert ordinary core blocks; other plugins register their own tools through a small provider API.

== Description ==

Editor Tool Rail adds a vertical toolbar to the post editor's left edge. Selecting a tool arms it: the next click in the canvas inserts that tool's block at the click point, then the rail returns to Select (Shift-click keeps the tool armed).

Everything the rail inserts is an ordinary core block — deactivating this plugin changes nothing about how authored content renders or stays editable.

* Baseline tools: Select, Text, Heading, Image, Shape (circle, rounded rectangle, hexagon, star), Section.
* Pin any block type as a quick-insert tool: drag it from the inserter onto the rail, or use "Pin to toolbar" in the block's options menu. Pins are a per-user browser preference.
* Move the toolbar where you want it: it starts on the left edge, and can dock to the right edge (past the settings side panel), to a full-width bar across the top or the bottom, or float free as a Photoshop-style palette. Drag it by the grip and release near an edge to snap it there, or pick a position in Toolbar settings. Flyouts and panels open away from the docked edge — a top toolbar opens downward, a bottom one upward.
* Full keyboard operability: one tab stop, arrow keys, Home/End, Escape disarms. Arrow keys follow the toolbar's orientation — Up/Down along a vertical rail with ArrowRight opening a tool's flyout, Left/Right along a horizontal one with ArrowDown opening the flyout. Repositioning has a keyboard path of its own in Toolbar settings, so it never depends on dragging.
* Provider API for themes and plugins: PHP filter `toolrail_tool_providers` + JS `window.toolrail.registerTool()`.

== Frequently Asked Questions ==

= Where is the toolbar position saved? =

In your browser, for you only — the same as pinned blocks and saved sets. It is not site content and not stored against your user account, so a different browser or a private window starts again at the default left edge.

= Can I put it back if I lose it? =

Yes. Open Toolbar settings from the gear at the end of the toolbar and choose a position under "Toolbar position".

== Changelog ==

= 0.2.0 =
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
