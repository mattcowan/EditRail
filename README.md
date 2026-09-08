# Editrail

A movable, graphics-editor-style toolbar for the WordPress block editor. Click a tool, then click the canvas to insert a core block at that point.

This file is for developers and for people who read the repository. The user guide is `readme.txt`, which is the WordPress.org listing. The full version history is in `CHANGELOG.md`.

## Why it exists

The block editor's inserter is a menu: open it, find the block, and it lands where the cursor is. A graphics editor works the other way. You pick a tool, and the next click puts the thing where you clicked. Editrail brings that model to the block editor.

Two things set it apart from other toolbar plugins:

- **Arm, then click.** A tool stays selected until the next click in the canvas. Shift-click keeps it selected for more inserts.
- **Only core blocks come out.** The toolbar inserts the same blocks the inserter does. Deactivate the plugin and nothing about the content changes. Delete the plugin and it removes its own preferences from each user account.

## Requirements

| Requirement | Version | Where it is declared |
| --- | --- | --- |
| WordPress | 6.5 or later | `editrail.php`, `Requires at least` |
| PHP | 7.4 or later | `editrail.php`, `Requires PHP` |

The PHP files use no feature above 7.4. The JavaScript is ES5 with no build step, so the files in `assets/` are the files that ship.

## Install

**From WordPress.org**

1. Open Plugins > Add New in wp-admin.
2. Search for "Editrail".
3. Install and activate it.

**From a GitHub release**

1. Open the Releases page of this repository.
2. Download `editrail.zip` from the release.
3. Open Plugins > Add New > Upload Plugin in wp-admin and upload the file.

**From a checkout**

1. Run `npm install`.
2. Run `npm run package`. This checks that every version number agrees, then writes `editrail.zip`.
3. Upload the zip as above, or copy the checkout into `wp-content/plugins/`.

`.distignore` decides what goes into the zip. A new production file ships without a change to any script. A new development-only file must be added to `.distignore`.

## Use

Open a post in the editor. The toolbar is on the left edge. `readme.txt` describes every control. In short:

- Click a tool, then click the canvas. The block lands at the click point.
- Drag a tool into the canvas to put its block where you drop it.
- Pin any block type or pattern as a tool. Open Toolbar settings from the gear, or drag a block from the inserter or the canvas onto the toolbar.
- Save pinned arrangements as named sets. Export a set as a JSON file and import it on a different site.
- Move the toolbar to any edge, or float it. Change its colors. Show tool names beside the icons.
- Open the Section overview to zoom out, outline every top-level block, and reorder blocks by drag or by keyboard.

Every action has a keyboard path, and screen readers hear every state change. A drag is a shortcut, never the only way.

## How it works

**The toolbar is plain DOM inside the editor's own layout.** `assets/editor-rail.js` inserts the toolbar into the editor's skeleton, so the canvas reflows around it and is not under it. The toolbar lives outside the React tree, and a debounced MutationObserver puts it back when the editor re-renders. That is why it survives the round trip through the code editor.

**A tool arms.** The active tool is a mode, not an action. The next click in the canvas resolves where the block goes, inserts it with the editor's own insert action, and returns the toolbar to Select. The saved post is what the inserter would have written.

**Preferences are per user, per site.** The toolbar position, pins, saved sets, colors and toggles go through the `core/preferences` store under the `toolrail` scope. WordPress persists that store to the user's account and preloads it into every editor page, so a setup follows the author across browsers and devices. The plugin writes no options and no post data. A localStorage fallback covers a browser whose storage fails mid-session.

**Delete removes the preferences.** `uninstall.php` strips the `toolrail` scope from every user's preferences on every site of a network. Each write is conditional on the value that was read, so a save from an open editor tab at the same moment survives. Deactivation keeps the preferences. The docblock of `includes/uninstall.php` gives the details.

**The plugin emits nothing for the front end.** It registers one script and one stylesheet, for the post editor only. It has no REST routes, no shortcodes, no blocks of its own, and no output on the public site.

## Extending

Another plugin or theme can add tools to the toolbar. The contract has a PHP half and a JavaScript half. The contract is stable from 1.0.0: a change that breaks it is a major version.

### 1. Declare a provider in PHP

```php
add_filter('toolrail_tool_providers', function ($providers) {
    $providers[] = [
        'slug'          => 'my-plugin',
        'script_handle' => 'my-plugin-rail-tools',
        'style_handle'  => 'my-plugin-rail-tools', // optional
    ];
    return $providers;
});
```

Register the script yourself on `enqueue_block_editor_assets`, with `toolrail-editor-rail` as a dependency. The rail enqueues the declared handles on post-editor screens after that. The rail drops a provider with a malformed slug and does not repair it. A second provider with the same slug cannot replace the first. `includes/providers.php` holds the validator, and `tests/phpunit/Test_Providers.php` pins its contract.

### 2. Register tools in JavaScript

```js
window.toolrail.registerTool({
  id: 'my-plugin/thing',        // required, unique, usable in a CSS selector
  label: 'Thing',               // accessible name
  icon: '<svg ...></svg>',      // inline SVG markup, optional
  parent: 'text',               // optional: nest in an existing tool's flyout
  insertBlock: 'my-plugin/thing', // or createBlock(), or onActivate()
  isActive: function () { return false; }, // optional pressed state
  supports: { canvas: true }    // the tool needs a canvas click
});
```

A tool gives one of three actions. `insertBlock` names a block type to insert at the click point. `createBlock` is a function that returns a block. `onActivate` is a function that runs at once, with no canvas click. A tool with `insertBlock` or `createBlock` defaults to `supports.canvas: true`. An `onActivate` tool defaults to `false`. While a mode captures the canvas, the rail dims every canvas tool, and the tool stays in the keyboard order.

`parent` accepts a slot id, a block name such as `core/paragraph`, or one of the aliases `text`, `heading`, `image` and `section`. Screen readers hear a flyout tool that has `isActive` as a checked menu item.

### 3. Read the toolbar's state

| Call or event | What it gives |
| --- | --- |
| `window.toolrail.getMode()` | The toolbar's mode. |
| `toolrail:mode-changed` window event | Fires when the mode changes, with `{ mode }` in `detail`. |
| `toolrail:tools-updated` window event | Fires when the tool registry or the pins change. |
| `toolrail:position-changed` window event | Fires when the toolbar docks or floats. |
| `window.toolrail.getDock()` | The current dock. |
| `window.toolrail.getCanvasGeometry()` | Where the canvas is on screen: `{ frameRect, scale, pan, scrollX, scrollY, mode }`. Use it to draw an overlay in the parent document that lines up with the canvas. |

### 4. Store per-user state

```js
await window.toolrail.prefs.ready;
var snap = window.toolrail.prefs.get('toolrail-ext:my-plugin:snap'); // string or null
window.toolrail.prefs.set('toolrail-ext:my-plugin:snap', '1');
```

Keys must start with `toolrail-ext:`. Values are strings. The store is the same per-user account store the rail uses, so the state follows the author. A read before `ready` resolves can return `null` for a key the author has. Read again after `ready`, or listen for the `toolrail:prefs-ready` window event.

`window.toolrail` also has calls for these. The header comment of `assets/editor-rail.js` documents each one.

- Pins: `pinBlock`, `unpinBlock`, `isPinned`, `moveSlot`.
- Saved sets: `saveConfig`, `loadConfig`, `deleteConfig`, `getConfigs`, `exportConfig`, `importConfig`.
- The active tool: `getActiveTool`, `setActiveTool`.
- The dock: `setDock`.

### Set files

A set file is JSON with this shape:

```json
{ "format": "toolrail-set", "version": 1, "name": "kit", "blocks": ["core/paragraph", "core/quote"] }
```

`blocks` lists slot ids. A block type is its block name. A pattern is `pattern:<name>`, or `pattern:user:<post id>` for one of the author's own patterns. A set may name a block or a pattern that a site does not have. The import keeps it, and it appears when its plugin or theme is active.

### Extensions that use this contract

Separate plugins by the same author use this contract and nothing else: rulers and guides, shapes, and shape dividers among them. `docs/integrations/typography-stylist.md` is a worked handoff for a third-party block plugin.

## Develop

| Command | What it does |
| --- | --- |
| `npm run test:php` | Runs the PHPUnit suite in `tests/phpunit/`. It needs no WordPress install. The bootstrap stubs the few WordPress functions the PHP uses. |
| `npm run test:e2e` | Runs the Playwright suite in `tests/e2e/` against a WordPress site. |
| `npm run check-versions` | Checks that all six version numbers agree. |
| `npm run package` | Runs the version check, then builds `editrail.zip`. |

To run the e2e suite on a disposable WordPress, start Docker and use wp-env:

```
npx wp-env start
TOOLRAIL_URL=http://localhost:8888 TOOLRAIL_ADMIN_PASS=password npm run test:e2e
npx wp-env stop
```

`docs/releasing.md` describes the CI workflows and the release procedure.

The e2e suite writes pins, positions and sets to the account it logs in with. It resets them to the defaults at the start of each test and at the end of the run. Do not point it at an account whose toolbar setup you want to keep.

## Data and privacy

The plugin stores per-user editor preferences and nothing else. They live in the `wp_persisted_preferences` user meta row that WordPress owns, under one `toolrail` key, next to the editor's own preferences. The plugin sends nothing to any external service. It has no telemetry. Deleting the plugin removes its key from every user's row.

## License

GPL-2.0-or-later. See the plugin header in `editrail.php`.
