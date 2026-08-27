# Typography Stylist × Editor Tool Rail — integration handoff

**Audience:** the Typography Stylist work session. Editor Tool Rail's session never edits
Typography Stylist (session boundary); this doc + snippet is everything TS needs to land
its side. Degradation is graceful in both directions: TS without Toolrail changes nothing,
Toolrail without TS simply never shows the button.

## The zero-code lane already works — read this before writing anything

**Any user can put a Typography Stylist button on the rail today, with no TS-side code at
all**, because quick slots pin arbitrary block types: open **Toolbar settings** (the gear
at the end of the rail), search "Typography", and pin it — or drag it from the inserter
onto the rail, or use "Pin to toolbar" in the block's options menu. The pinned slot renders
the block's own icon, armed-inserts `typost/block` on canvas click, and rides the saved-sets
feature (named per-user configurations). Verified live on mnc4 2026-08-25: pin → slot with
the real TS icon → canvas click → a `typost/block` in the document.

So the `registerTool` integration below is **optional polish**, not a prerequisite. Ship it
only if TS wants something pinning can't give: a button present for every user by default
(pins are per-user preferences), nesting under the Text flyout, an `onActivate`
that opens TS UI instead of inserting, or a block preconfigured via `createBlock` attrs.
A separate "bridge" plugin between the two is not needed in either case — the provider API
below IS the bridge, and it lives in whichever plugin registers.

## What you get

A "Typography Stylist" tool nested in the rail's **Text** tool flyout (open with
ArrowRight on the Text button, or hover). Activating it arms the rail: the author's next
canvas click inserts a `typost/block` at the click point, then the rail returns to Select
(Shift-click keeps it armed). You can instead pass `onActivate` for fully custom behavior.

## The contract

**JS** — call once your editor script runs:

```js
window.toolrail.registerTool({
  id: 'typost-advanced-type',      // unique; duplicates are refused with a console warning
  label: 'Typography Stylist',     // accessible name (tooltip + aria-label)
  icon: '<svg …>…</svg>',          // inline SVG string, drawn at currentColor; optional
  parent: 'text',                  // nests in the Text flyout ('heading' also works)
  insertBlock: 'typost/block',     // armed insertion of your block
  // OR: onActivate: function () { … }  // run something instead of arming
  // OR: createBlock: function () { return wp.blocks.createBlock('typost/block', {…}); }
  // Optional: isActive: function () { return bool; }  // pressed-state callback
});
```

Descriptors, not React nodes — the rail owns the roving tabindex (deliberately the same
shape as your own `typost_editor_toolbar_buttons` filter). The registry fires
`toolrail:tools-updated` on `window` after each successful registration.

**About `parent` since 0.1.2:** Text/Heading/Image are pinned slots rather than fixed
built-ins, and `'text'` is an alias for the pinned Paragraph slot. A block name
(`'core/paragraph'`) or a slot id (`'pin:core/paragraph'`) also works — against ANY
pinned block, `typost/block` included. If the author has unpinned the parent, the tool
renders at top level instead of vanishing.

**PHP** — declare yourself a provider so Toolrail enqueues your script on post-editor
screens, ordered after the rail:

```php
// In your enqueue_block_editor_assets callback (default priority is fine —
// Toolrail registers its 'toolrail-editor-rail' handle at priority 1 and
// enqueues providers at priority 20):
wp_register_script(
    'typost-rail-tools',
    TYPOST_PLUGIN_URL . 'assets/js/rail-tools.js',
    array( 'toolrail-editor-rail', 'wp-blocks', 'wp-data' ),
    TYPOST_VERSION,
    true
);

add_filter( 'toolrail_tool_providers', function ( $providers ) {
    $providers[] = array(
        'slug'          => 'typography-stylist',
        'script_handle' => 'typost-rail-tools',
        // 'style_handle' => 'typost-rail-tools', // optional
    );
    return $providers;
} );
```

`rail-tools.js` is then just the `registerTool` call above, wrapped in your usual IIFE.

## Graceful degradation

- **Toolrail absent:** the `toolrail_tool_providers` filter never runs and
  `toolrail-editor-rail` is never a registered handle, so your `wp_register_script`
  dependency keeps the script from loading. Nothing to guard. If you'd rather register the
  filter unconditionally, that's also safe — an unconsumed filter is free.
- **Toolrail present, TS's JS decides not to register** (e.g. a capability your payload
  gates): simply don't call `registerTool`; the Text flyout then has no TS entry (Text
  itself stays a plain armed tool with no flyout glyph when it has no children).

## Validation rules (so failures are loud, not silent)

`registerTool` refuses (returns `false`, console-warns) descriptors that are not objects,
lack a non-empty string `id`, duplicate an existing id, or carry none of
`insertBlock` (string) / `createBlock` (function) / `onActivate` (function). The PHP
provider validator refuses entries without a `sanitize_key`-stable `slug` or a
`script_handle`; duplicate slugs keep the FIRST declaration.

## Verifying

With both plugins active on mnc4: open any post, focus the rail's Text button,
press ArrowRight — the flyout should list Typography Stylist; picking it and clicking the
canvas should insert `typost/block`. Toolrail's own E2E spec
(`tests/e2e/rail.spec.js`, "registration API" describe block) proves the identical path
with a fixture tool if you want a reference.
