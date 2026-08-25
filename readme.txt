=== Editor Tool Rail ===
Contributors: matthewneilcowan
Tags: block editor, toolbar, tools, accessibility
Requires at least: 6.5
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

A Photoshop-familiar left toolbar for the block editor. Tools insert ordinary core blocks; other plugins register their own tools through a small provider API.

== Description ==

Editor Tool Rail adds a vertical toolbar to the post editor's left edge. Selecting a tool arms it: the next click in the canvas inserts that tool's block at the click point, then the rail returns to Select (Shift-click keeps the tool armed).

Everything the rail inserts is an ordinary core block — deactivating this plugin changes nothing about how authored content renders or stays editable.

* Baseline tools: Select, Text, Heading, Image, Shape (circle, rounded rectangle, hexagon, star), Section.
* Pin any block type as a quick-insert tool: drag it from the inserter onto the rail, or use "Pin to toolbar" in the block's options menu. Pins are a per-user browser preference.
* Full keyboard operability: one tab stop, arrow keys, Home/End, ArrowRight opens a tool's flyout, Escape disarms.
* Provider API for themes and plugins: PHP filter `toolrail_tool_providers` + JS `window.toolrail.registerTool()`.

== Changelog ==

= 0.1.0 =
* Initial release: rail chrome, armed-tool insertion, quick slots, provider registration API.
