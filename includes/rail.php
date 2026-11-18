<?php
/**
 * Rail asset registration + enqueue.
 *
 * Two hooks on enqueue_block_editor_assets, both screen-gated to the post
 * editor:
 *
 *   priority 1  — REGISTER the rail scripts and style, so providers
 *                 registering their own scripts at default priority can
 *                 declare `toolrail-editor-rail` as a dependency.
 *   priority 20 — ENQUEUE the rail + every validated provider's handles,
 *                 after providers have registered them.
 *
 * The rail's JavaScript is seven files with no build step (issue #102),
 * listed in toolrail_rail_scripts(). `toolrail-editor-rail` is the LAST of
 * them and depends on the other six, so a provider that depends only on
 * that handle still loads after the whole rail. Every rail handle must be
 * registered here, at priority 1: when a dependency is missing as the
 * scripts print, WordPress drops `toolrail-editor-rail` with no error, and
 * every provider script that depends on it goes too.
 *
 * @package Toolrail
 */

defined('ABSPATH') || exit;

/**
 * filemtime()-based cache-buster (a constant version ships stale assets
 * to browsers that cached the last build), falling back to the plugin
 * version when the file is missing.
 *
 * @param string $relative Path relative to the plugin root.
 * @return string|int
 */
function toolrail_asset_version($relative) {
    $file = TOOLRAIL_PLUGIN_DIR . ltrim($relative, '/');
    $time = is_readable($file) ? filemtime($file) : false;
    return false !== $time ? $time : TOOLRAIL_VERSION;
}

/**
 * Whether the current screen is the post editor.
 *
 * @return bool
 */
function toolrail_is_post_editor_screen() {
    if (!function_exists('get_current_screen')) {
        return true;
    }
    $screen = get_current_screen();
    return !$screen || 'post' === $screen->base;
}

/**
 * The rail's scripts, in load order: handle => file and dependencies.
 *
 * Each file is one closure that shares names with the others through the
 * private `window.toolrailInternal` object, which the first file creates.
 * A file can use a name from a file before it only when that file has
 * run, so each file depends on the rail files it uses; that makes a
 * chain, and the files print in this order. The first file carries the
 * WordPress dependencies for all of them. The last file,
 * `toolrail-editor-rail`, sets `window.toolrail` and boots the rail.
 *
 * @return array<string, array{file: string, deps: string[]}>
 */
function toolrail_rail_scripts() {
    return [
        'toolrail-editor-rail-core'     => [
            'file' => 'assets/editor-rail-core.js',
            // wp-preferences registers the core/preferences store the rail
            // persists its per-user state into (position, pins, saved sets).
            'deps' => ['wp-data', 'wp-preferences', 'wp-blocks', 'wp-i18n', 'wp-a11y', 'wp-element', 'wp-components', 'wp-plugins', 'wp-block-editor'],
        ],
        'toolrail-editor-rail-registry' => [
            'file' => 'assets/editor-rail-registry.js',
            'deps' => ['toolrail-editor-rail-core'],
        ],
        'toolrail-editor-rail-tools'    => [
            'file' => 'assets/editor-rail-tools.js',
            'deps' => ['toolrail-editor-rail-core', 'toolrail-editor-rail-registry'],
        ],
        'toolrail-editor-rail-settings' => [
            'file' => 'assets/editor-rail-settings.js',
            'deps' => ['toolrail-editor-rail-core', 'toolrail-editor-rail-registry', 'toolrail-editor-rail-tools'],
        ],
        'toolrail-editor-rail-overview' => [
            'file' => 'assets/editor-rail-overview.js',
            'deps' => ['toolrail-editor-rail-core', 'toolrail-editor-rail-tools', 'toolrail-editor-rail-settings'],
        ],
        'toolrail-editor-rail-dom'      => [
            'file' => 'assets/editor-rail-dom.js',
            'deps' => ['toolrail-editor-rail-core', 'toolrail-editor-rail-registry', 'toolrail-editor-rail-tools', 'toolrail-editor-rail-settings', 'toolrail-editor-rail-overview'],
        ],
        'toolrail-editor-rail'          => [
            'file' => 'assets/editor-rail.js',
            'deps' => ['toolrail-editor-rail-core', 'toolrail-editor-rail-registry', 'toolrail-editor-rail-tools', 'toolrail-editor-rail-settings', 'toolrail-editor-rail-overview', 'toolrail-editor-rail-dom'],
        ],
    ];
}

/**
 * Register the rail assets (priority 1 — see the file header).
 *
 * @return void
 */
function toolrail_register_rail_assets() {
    if (!toolrail_is_post_editor_screen()) {
        return;
    }

    foreach (toolrail_rail_scripts() as $handle => $script) {
        wp_register_script(
            $handle,
            TOOLRAIL_PLUGIN_URL . $script['file'],
            $script['deps'],
            toolrail_asset_version($script['file']),
            true
        );
    }

    wp_register_style(
        'toolrail-editor-rail',
        TOOLRAIL_PLUGIN_URL . 'assets/editor-rail.css',
        [],
        toolrail_asset_version('assets/editor-rail.css')
    );
}
add_action('enqueue_block_editor_assets', 'toolrail_register_rail_assets', 1);

/**
 * Enqueue the rail and its providers (priority 20 — see the file header).
 *
 * @return void
 */
function toolrail_enqueue_rail() {
    if (!toolrail_is_post_editor_screen()) {
        return;
    }

    wp_enqueue_script('toolrail-editor-rail');
    wp_enqueue_style('toolrail-editor-rail');
    wp_localize_script('toolrail-editor-rail', 'toolrailData', toolrail_get_editor_payload());

    foreach (toolrail_get_tool_providers() as $provider) {
        if (wp_script_is($provider['script_handle'], 'registered')) {
            wp_enqueue_script($provider['script_handle']);
        }
        if ('' !== $provider['style_handle'] && wp_style_is($provider['style_handle'], 'registered')) {
            wp_enqueue_style($provider['style_handle']);
        }
    }
}
add_action('enqueue_block_editor_assets', 'toolrail_enqueue_rail', 20);
