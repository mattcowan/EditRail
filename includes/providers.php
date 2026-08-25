<?php
/**
 * Tool provider registry — the PHP half of the registration contract.
 *
 * A provider is a plugin or theme that contributes tools to the rail. It
 * declares itself through the `toolrail_tool_providers` filter:
 *
 *     add_filter('toolrail_tool_providers', function ($providers) {
 *         $providers[] = [
 *             'slug'          => 'my-plugin',
 *             'script_handle' => 'my-plugin-rail-tools', // registered by the provider
 *             'style_handle'  => 'my-plugin-rail-tools', // optional
 *         ];
 *         return $providers;
 *     });
 *
 * The provider registers its own script (with `toolrail-editor-rail` as a
 * dependency, on `enqueue_block_editor_assets` at default priority — the rail
 * registers its handle at priority 1 so it exists by then); that script calls
 * `window.toolrail.registerTool()` on load. Toolrail enqueues the declared
 * handles on post-editor screens at priority 20, after providers have
 * registered them.
 *
 * The validator is a PURE helper with the checks enforced INSIDE it — not
 * only at the enqueue boundary — so it is directly testable (the theme's
 * Test_Editor_Design_Suite convention).
 *
 * @package Toolrail
 */

defined('ABSPATH') || exit;

/**
 * Validate one provider declaration.
 *
 * Requirements: `slug` (non-empty, sanitize_key-stable so it is safe in HTML
 * attributes and event payloads) and `script_handle` (non-empty string).
 * `style_handle` is optional. Anything else is dropped, never "fixed up" —
 * a provider with a mangled slug would silently collide with another.
 *
 * @param mixed $provider Raw entry from the filter.
 * @return array|null Normalized ['slug','script_handle','style_handle'] or null.
 */
function toolrail_sanitize_provider($provider) {
    if (!is_array($provider)) {
        return null;
    }

    $slug = isset($provider['slug']) && is_string($provider['slug']) ? $provider['slug'] : '';
    if ('' === $slug || sanitize_key($slug) !== $slug) {
        return null;
    }

    $script = isset($provider['script_handle']) && is_string($provider['script_handle'])
        ? trim($provider['script_handle'])
        : '';
    if ('' === $script) {
        return null;
    }

    $style = isset($provider['style_handle']) && is_string($provider['style_handle'])
        ? trim($provider['style_handle'])
        : '';

    return [
        'slug'          => $slug,
        'script_handle' => $script,
        'style_handle'  => $style,
    ];
}

/**
 * Collect the validated provider list.
 *
 * A filter returning a non-array yields [], and duplicate slugs keep the
 * FIRST declaration (a later add_filter cannot hijack an existing provider's
 * slot by re-declaring its slug).
 *
 * @return array[] Validated provider declarations, keyed numerically.
 */
function toolrail_get_tool_providers() {
    $raw = apply_filters('toolrail_tool_providers', []);
    if (!is_array($raw)) {
        return [];
    }

    $providers = [];
    $seen      = [];
    foreach ($raw as $entry) {
        $provider = toolrail_sanitize_provider($entry);
        if (null === $provider || isset($seen[$provider['slug']])) {
            continue;
        }
        $seen[$provider['slug']] = true;
        $providers[]             = $provider;
    }

    return $providers;
}

/**
 * Build the payload localized onto the rail script.
 *
 * Data only — which tools render is decided by what providers register
 * client-side, and each provider gates its OWN tools by shipping (or not
 * shipping) them in its own capability-gated payload. The core rail's
 * built-in tools are all block-insertion tools, which need no capability
 * beyond editing the post the author is already editing.
 *
 * @return array
 */
function toolrail_get_editor_payload() {
    return [
        'version'   => TOOLRAIL_VERSION,
        'providers' => wp_list_pluck(toolrail_get_tool_providers(), 'slug'),
    ];
}
