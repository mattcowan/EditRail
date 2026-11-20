# EditRail

A movable, graphics-editor-style toolbar for the WordPress block editor. Click a tool, then click the canvas to insert a core block at that point.

This file is for developers and for people who read the repository. The user guide is `readme.txt`, which is the WordPress.org listing. The full version history is in `CHANGELOG.md`.

## Why it exists

The block editor's inserter is a menu: open it, find the block, and it lands where the cursor is. A graphics editor works the other way. You pick a tool, and the next click puts the thing where you clicked. EditRail brings that model to the block editor.

Two things set it apart from other toolbar plugins:

- **Arm, then click.** A tool stays selected until the next click in the canvas, or until Ctrl+Enter inserts its block. Shift-click or Ctrl+Shift+Enter keeps it selected for more inserts.
- **Only core blocks come out.** The toolbar inserts the same blocks the inserter does. Deactivate the plugin and nothing about the content changes. Delete the plugin and it removes its own preferences from each user account, and the sets that users shared.

## Requirements

| Requirement | Version | Where it is declared |
| --- | --- | --- |
| WordPress | 6.5 or later | `editrail.php`, `Requires at least` |
| PHP | 7.4 or later | `editrail.php`, `Requires PHP` |

The PHP files use no feature above 7.4. The JavaScript is ES5 with no build step, so the files in `assets/` are the files that ship.

## Install

**From WordPress.org**

1. Open Plugins > Add New in wp-admin.
2. Search for "EditRail".
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

## Try it in Playground

`npm run playground` starts a throwaway WordPress in the [Playground CLI](https://wordpress.github.io/wordpress-playground/developers/local-development/wp-playground-cli) with this checkout as the plugin, Typography Stylist installed and pinned to the toolbar, and a demo post open in the editor. `scripts/playground/README.md` describes the blueprint and how it is built. The same blueprint is the plugin's Live Preview on WordPress.org once the plugin is listed.

## Use

Open a post in the editor. The toolbar is on the left edge. `readme.txt` describes every control. In short:

- Click a tool, then click the canvas. The block lands at the click point.
- With the keyboard, press Enter on a tool to arm it, then Ctrl+Enter (Cmd+Enter on a Mac). The block goes after the selected block, or at the end of the post when no block is selected. Ctrl+Shift+Enter keeps the tool armed.
- Drag a tool into the canvas to put its block where you drop it.
- Pin any block type or pattern as a tool. Open Toolbar settings from the gear, or drag a block from the inserter or the canvas onto the toolbar.
- Give a pinned tool your own name, description or icon with Edit beside it in Toolbar settings.
- Save pinned arrangements as named sets. Export a set as a JSON file and import it on a different site.
- Switch between saved sets from the Saved sets button on the toolbar. It appears when you have a saved set.
- Share a saved set with the other users of the site: Share beside the set in Toolbar settings. Users who can edit posts see it in Toolbar settings and in the Saved sets menu, with the name of the user who shared it, and can load or export it.
- Move the toolbar to any edge, or float it. Change its colors. Show tool names beside the icons.
- Add up to three more toolbars in Toolbar settings. Each toolbar has its own name, pinned tools, position and tool names. Two toolbars can dock on the same edge, side by side. Show or hide each one from the Toolbars button on the main toolbar, or in Toolbar settings. After you add, show or move a toolbar, or turn on its tool names, the toolbar says so if the content area is narrower than 600 pixels (`MIN_CANVAS_WIDTH`, core's small breakpoint) and two or more toolbars are shown. It refuses nothing. With only the main toolbar shown, it gives no notice.
- Optional, off by default: turn on "Let me make the settings sidebar wider" in Toolbar settings. Then type a width in Toolbar settings, use its Narrower and Wider buttons (50px a step), or drag the inner edge of the editor's settings sidebar. The width goes up to 640px or half the window, whichever is less. The edge is also a keyboard separator: the Left and Right arrow keys change the width. A double-click, or a button in Toolbar settings, resets it to 280px.
- Open the Section overview to zoom out, outline every top-level block, and reorder blocks by drag or by keyboard.
- Select several blocks in the canvas. With Select active, drag a rectangle from empty canvas space, or use Ctrl+click (Cmd+click on a Mac) to add or remove one block and Alt+click to remove one. With the keyboard, press Ctrl+Space on a selected block. If the operating system uses Ctrl+Space, use "Add to selection" or "Remove from selection" in the block's options menu. Blocks with a gap between them get an outline and a bar with group actions: move, duplicate, group and delete.

Every action has a keyboard path, and screen readers hear every state change. Dragging actions are available as a shortcut but not the only way to perform an action.

## How it works

**The toolbar is plain DOM inside the editor's own layout.** `assets/editor-rail.js` inserts the toolbar into the editor's skeleton, so the canvas reflows around it and is not under it. The toolbar lives outside the React tree, and a debounced MutationObserver puts it back when the editor re-renders. That is why it survives the round trip through the code editor.

**Each toolbar is one region in that layout.** On a shared edge the main toolbar is against the edge, and each added toolbar is nearer the canvas. The order in the document is the order on screen, so the Tab order follows it. The places of all toolbars are set in one pass. Two toolbars that each want to be the last child of the same parent would otherwise move each other on every observer pass. The main toolbar keeps its old preference keys. The added toolbars are one value, `toolrail-toolbars`, so data from an older version shows the same single toolbar. A second new key, `toolrail-toolbars-button-hidden`, holds the choice to hide the Toolbars button.

**A tool arms.** The active tool is a mode, not an action. The next click in the canvas resolves where the block goes, inserts it with the editor's own insert action, and returns the toolbar to Select. The saved post is what the inserter would have written. Ctrl+Enter is the keyboard form of the click. It puts the block after the selected block, which is where the inserter puts it. Like the inserter, it replaces a selected empty paragraph.

**A selection is WordPress's own when WordPress can hold it.** WordPress holds a selection as one start block and one end block, so it cannot hold blocks with a gap between them or blocks at two levels. A rectangle or a Ctrl+click that selects neighbors at one level sets the WordPress selection, and the block toolbar, copy and drag act on it as usual. For any other set, the toolbar keeps the list of blocks in memory, marks each block's element in the editor with an attribute that a stylesheet in the canvas outlines, and shows a bar with group actions. Each action is one of the editor's own actions (`moveBlocksToPosition`, `duplicateBlocks`, `replaceBlocks`, `removeBlocks`) and one undo step. The list is not stored in preferences or in the post.

**Preferences are per user, per site.** The position and pins of each toolbar, saved sets, colors, toggles and the settings sidebar width go through the `core/preferences` store under the `toolrail` scope. WordPress persists that store to the user's account and preloads it into every editor page, so a setup follows the author across browsers and devices. The plugin writes no options, and it writes nothing into authored posts. A localStorage fallback covers a browser whose storage fails mid-session.

**A shared set is a copy in the plugin's own private post type.** When an author shares a saved set, the plugin keeps a copy of it as a post of the type `editrail_set`: the set name and the set file contents, and the author of the post is the user who shared it. The type has no admin screens, no front-end URLs, and no default REST routes. The plugin's own routes are `GET` and `POST` on `/editrail/v1/sets` (list, share) and `GET` and `DELETE` on `/editrail/v1/sets/<id>` (one set, stop sharing). They answer only logged-in users who can edit posts. WordPress's post capabilities decide who can do what. A user with `edit_posts` (Contributor and up) can see and load shared sets. A user with `publish_posts` (Author and up) can share. The author can stop sharing their own set, and a user with `delete_others_posts` (Editor and up) can stop sharing any set. Nobody can change a set that another user shared. A share of a set name that the author already shares replaces that copy. A later change to the author's own set does not change the copy until the author shares the set again. A load copies the set into one toolbar of the user, the same as Load for the user's own set: in Toolbar settings the toolbar chosen under "Toolbar", and from the Saved sets button the main toolbar. The server checks each set against the set file rules and size limits when it saves the set and again when it reads it. `includes/shared-sets.php` gives the details.

**Delete removes the preferences and the shared sets.** `uninstall.php` deletes the `editrail_set` posts and strips the `toolrail` scope from every user's preferences, on every site of a network. Each preference write is conditional on the value that was read, so a save from an open editor tab at the same moment survives. Deactivation keeps the preferences and the shared sets: while the plugin is inactive, nothing shows the shared sets, and they come back when you activate it again. The docblock of `includes/uninstall.php` gives the details.

**The sidebar width is an opt-in stylesheet override.** It is off until the author turns it on in Toolbar settings; while it is off there is no handle and no override. The handle sits in the sidebar region of the editor's skeleton, next to the canvas. A width other than core's 280px sets one custom property and one body class, and the stylesheet overrides the sidebar's width from there. At 280px, and below the 782px breakpoint where core shows the sidebar full screen, nothing is overridden. The canvas and a docked toolbar are in the same flex row, so they take the space that is left.

**The plugin emits nothing for the front end.** It registers one script and one stylesheet, for the post editor only. It has no shortcodes, no blocks of its own, and no output on the public site. Its only REST routes are the shared-set routes, and they refuse a visitor who is not logged in.

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

A tool gives one of three actions. `insertBlock` names a block type to insert at the click point, or after the selected block on Ctrl+Enter. `createBlock` is a function that returns a block. `onActivate` is a function that runs at once, with no canvas click. A tool with `insertBlock` or `createBlock` defaults to `supports.canvas: true`. An `onActivate` tool defaults to `false`. While a mode captures the canvas, the rail dims every canvas tool, and the tool stays in the keyboard order.

`parent` accepts a slot id, a block name such as `core/paragraph`, or one of the aliases `text`, `heading`, `image` and `section`. Screen readers hear a flyout tool that has `isActive` as a checked menu item.

A tool with no `parent` is on the main toolbar. A tool whose `parent` is a pinned slot is in the flyout of that slot on each toolbar that shows the slot.

### 3. Read the toolbar's state

| Call or event | What it gives |
| --- | --- |
| `window.toolrail.getMode()` | The toolbar's mode. |
| `toolrail:mode-changed` window event | Fires when the mode changes, with `{ mode }` in `detail`. |
| `toolrail:tools-updated` window event | Fires when the tool registry or the pins change. |
| `toolrail:position-changed` window event | Fires when the main toolbar docks or floats, and when a different toolbar is added, removed, moved, shown or hidden. Each of these can move the canvas. `detail` is always the main toolbar's `{ dock, x, y }`. |
| `toolrail:toolbars-changed` window event | Fires after `toolrail:position-changed` and when a toolbar is renamed, with `{ toolbar, change }` in `detail`. `toolbar` is the toolbar's id. `change` is `added`, `removed`, `renamed`, `position`, `shown`, `hidden` or `synced`. For `synced`, the stored list changed outside the page and `toolbar` is empty. |
| `window.toolrail.getDock(id)` | The dock of a toolbar. Without `id`, the main toolbar's dock. |
| `window.toolrail.getPosition(id)` | `{ dock, x, y }` of a toolbar. Without `id`, the main toolbar's. |
| `window.toolrail.getToolbars()` | Every toolbar, the main toolbar first: `[{ id, name, dock, x, y, hidden }]`. The main toolbar's id is `main`. |
| `window.toolrail.getCanvasGeometry()` | Where the canvas is on screen: `{ frameRect, scale, pan, scrollX, scrollY, mode }`. Use it to draw an overlay in the parent document that lines up with the canvas. |
| `window.toolrail.refresh()` | Repaints the pressed state of every tool. Call it when your `isActive()` result changes for a reason the editor's data stores do not see, such as a pick mode you cancel yourself or a sidebar section held in React state. The toolbar repaints itself on every store change, so you do not need this for state that lives in a store. It is cheap to call more often than necessary. |

### 4. Store per-user state

```js
await window.toolrail.prefs.ready;
var snap = window.toolrail.prefs.get('toolrail-ext:my-plugin:snap'); // string or null
window.toolrail.prefs.set('toolrail-ext:my-plugin:snap', '1');
```

Keys must start with `toolrail-ext:`. Values are strings. The store is the same per-user account store the rail uses, so the state follows the author. A read before `ready` resolves can return `null` for a key the author has. Read again after `ready`, or listen for the `toolrail:prefs-ready` window event. The event can fire more than once: it fires again each time the toolbar repairs preferences that the editor reset. Make your listener safe to run more than once.

`window.toolrail` also has calls for these. The header comment of `assets/editor-rail.js` documents each one.

- Pins: `pinBlock`, `unpinBlock`, `isPinned`, `moveSlot`. Each takes a toolbar id as an optional last argument. Without it, `pinBlock` pins to the main toolbar and refuses a slot that a shown toolbar has, `unpinBlock` unpins from every shown toolbar, `isPinned` is true when a shown toolbar has the slot, and `moveSlot` moves the slot on the first shown toolbar that has it. The pins of a hidden toolbar do not count, and these calls do not change them. With an id, each call acts on that toolbar, also when it is hidden. An unknown id makes the call return false.
- A pin's own name, description and icon: `getPinMeta(slot)`, `setPinMeta(slot, { title, description, icon })`. Text only. The icon is the name of a Dashicon WordPress ships (`dashicons-star-filled`) or up to three characters.
- Your extension's data on a pin: `getPinData(slot, namespace)`, `setPinData(slot, namespace, value)`. The namespace is your short name in lowercase: a lowercase letter or a digit, then lowercase letters, digits and hyphens, up to 40 characters. An uppercase letter makes `setPinData` return false. The value is plain JSON, up to 2,048 characters once serialized; `null` removes it. The rail stores it and nothing more. The data belongs to the slot on all toolbars, and a hidden toolbar counts too. The rail removes it when no toolbar has the pin any more: an unpin, a loaded set that does not name the pin, or a deleted toolbar can cause this. It is saved with sets, carried in set files, and applied when a set is loaded, one namespace at a time, so a namespace the set does not carry stays as it is. Give it meaning with a tool registered under the pin, `parent: 'pin:<slot>'`, whose `createBlock` reads it. The `toolrail:pin-meta-changed` window event fires with `{ slot }` in `detail` on every change to a pin's entry.
- Saved sets: `saveConfig`, `loadConfig`, `deleteConfig`, `getConfigs`, `exportConfig`, `importConfig`. A set holds the pins of one toolbar. `saveConfig(name, id)` saves the pins of a toolbar, and `loadConfig(name, id)` loads a set into a toolbar. Without `id`, both use the main toolbar.
- The active tool: `getActiveTool`, `setActiveTool`. One tool is armed at a time, on all toolbars.
- The dock: `setDock(dock, id)`. Without `id`, it moves the main toolbar.

### Set files

A set file is JSON with this shape:

```json
{ "format": "toolrail-set", "version": 1, "name": "kit", "blocks": ["core/paragraph", "core/quote"] }
```

`blocks` lists slot ids. A block type is its block name. A pattern is `pattern:<name>`, or `pattern:user:<post id>` for one of the author's own patterns. A set may name a block or a pattern that a site does not have. The import keeps it, and it appears when its plugin or theme is active.

A set file can also carry the author's own name, description and icon for its blocks, in an optional `meta` object keyed by slot id: `"meta": { "core/quote": { "title": "Testimonial", "icon": "“" } }`. The import keeps these with the set and ignores entries for blocks the set does not list. Loading the set applies them to its pins. Saving a set records the labels its pins have at that time.

A shared set uses the same format. The server stores the set file of the shared set, and a shared set exports to the same file as the author's own set.

### Extensions that use this contract

Separate plugins by the same author use this contract and nothing else: rulers and guides, shapes, and shape dividers among them. `docs/integrations/typography-stylist.md` is a worked handoff for a third-party block plugin.

## Develop

| Command | What it does |
| --- | --- |
| `npm run test:php` | Runs the PHPUnit suite in `tests/phpunit/`. It needs no WordPress install. The bootstrap stubs the few WordPress functions the PHP uses. |
| `npm run test:e2e` | Runs the Playwright suite in `tests/e2e/` against a WordPress site. |
| `npm run test:sr` | Runs the NVDA screen-reader journeys in `tests/e2e-sr/` against a WordPress site. Windows only. It drives a headed Firefox with Guidepup's portable NVDA, and it takes the keyboard for several minutes. Do not type while it runs. |
| `npm run lint` | Runs ESLint on `assets/`, `tests/` and `scripts/`, and stylelint on `assets/`. ESLint reports undeclared, unused and shadowed names, and unsafe syntax. In `assets/`, it also reports syntax above ES5. `eslint.config.js` and `stylelint.config.js` give the rules. |
| `composer lint` | Runs PHPCS on `editrail.php`, `uninstall.php` and `includes/`. It reports security problems, PHP features above 7.4, and incorrect use of WordPress functions. `phpcs.xml.dist` gives the rules. |
| `npm run check-versions` | Checks that all six version numbers agree. |
| `npm run package` | Runs the version check, then builds `editrail.zip`. |

To run the e2e suite on a disposable WordPress, start Docker and use wp-env. The suite uses the wp-env site and its login by default:

```
npx wp-env start
npm run test:e2e
npx wp-env stop
```

To use your own WordPress site, copy `.env.example` to `.env` and set `TOOLRAIL_URL`, `TOOLRAIL_ADMIN_USER` and `TOOLRAIL_ADMIN_PASS`. A variable set on the command line wins over `.env`. `docs/releasing.md` lists every variable.

The screen-reader journeys need more setup. Do these three steps once on the machine:

```
npx @guidepup/setup setup
npx @guidepup/setup install nvda
npx playwright install firefox
```

Then copy `.env.example` to `.env` and set `WP_USERNAME` and `WP_PASSWORD`. Set `WP_BASE_URL` too if your site is not the wp-env one. `docs/releasing.md` lists the variables.

CI runs both lint commands on each pull request and each push to `main`. A finding fails the job. Fix the finding, or suppress it with a comment that gives the reason. Do not rename a `--toolrail-*` custom property or a selector to satisfy a rule: extensions read them.

`docs/releasing.md` describes the CI workflows and the release procedure.

The e2e suite writes pins, positions and sets to the account it logs in with. It resets them to the defaults at the start of each test and at the end of the run. It also turns off the editor's welcome guide for that account. Do not point it at an account whose toolbar setup you want to keep. `tests/e2e/shared-sets.spec.js` also creates one user for each role, with a random password, and deletes these users, their shared sets and their patterns at the end, also when a test fails.

## Data and privacy

The plugin stores two things. Per-user editor preferences live in the `wp_persisted_preferences` user meta row that WordPress owns, under one `toolrail` key, next to the editor's own preferences. Another user never sees them. Shared sets are posts of the plugin's private `editrail_set` type, one for each set that a user shares. Each holds the set name and the set file contents, and nothing else of the user who shared it. Logged-in users who can edit posts on that site see the shared sets and the display name of the user who shared each one. The plugin sends nothing to any external service. It has no telemetry. Deleting the plugin removes its key from every user's row and deletes the shared sets.

## License

GPL-2.0-or-later. See the plugin header in `editrail.php`.
