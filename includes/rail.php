<?php
/**
 * Rail asset registration + enqueue.
 *
 * Two hooks on enqueue_block_editor_assets, both screen-gated to the post
 * editor:
 *
 *   priority 1  — REGISTER the rail script/style, so providers registering
 *                 their own scripts at default priority can declare
 *                 `toolrail-editor-rail` as a dependency.
 *   priority 20 — ENQUEUE the rail + every validated provider's handles,
 *                 after providers have registered them.
 *
 * @package Toolrail
 */

defined('ABSPATH') || exit;

/**
 * filemtime()-based cache-buster (the Background Candy lesson: a constant
 * version ships stale assets), falling back to the plugin version when the
 * file is missing.
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
 * Register the rail assets (priority 1 — see the file header).
 *
 * @return void
 */
function toolrail_register_rail_assets() {
    if (!toolrail_is_post_editor_screen()) {
        return;
    }

    wp_register_script(
        'toolrail-editor-rail',
        TOOLRAIL_PLUGIN_URL . 'assets/editor-rail.js',
        ['wp-data', 'wp-blocks', 'wp-i18n', 'wp-element', 'wp-components', 'wp-plugins', 'wp-block-editor'],
        toolrail_asset_version('assets/editor-rail.js'),
        true
    );

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
