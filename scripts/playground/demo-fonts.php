<?php
/**
 * Plugin Name: Editor Tool Rail demo fonts
 * Description: Declares the Vollkorn @font-face from the active theme's own font files, for the Playground demo post. Not part of the plugin.
 *
 * Written into /wordpress/wp-content/mu-plugins/ by the Playground
 * blueprint (scripts/playground.js embeds this file). Twenty Twenty-Five
 * ships Vollkorn but loads it only in one of its typography style
 * variations, so the demo declares the face itself, from the theme's
 * files — no request leaves the site for a font.
 *
 * @package Toolrail
 */

add_action('enqueue_block_assets', function () {
    $faces = array(
        array('assets/fonts/vollkorn/Vollkorn-VariableFont_wght.woff2', 'normal'),
        array('assets/fonts/vollkorn/Vollkorn-Italic-VariableFont_wght.woff2', 'italic'),
    );
    $css = '';
    foreach ($faces as $face) {
        if (!file_exists(get_template_directory() . '/' . $face[0])) {
            continue;
        }
        $css .= sprintf(
            "@font-face{font-family:'Vollkorn';font-style:%s;font-weight:400 900;font-display:swap;src:url('%s') format('woff2');}",
            $face[1],
            esc_url(get_template_directory_uri() . '/' . $face[0])
        );
    }
    if ('' === $css) {
        return;
    }
    // Styles enqueued on this hook reach the editor's canvas iframe and
    // the front end alike.
    wp_register_style('toolrail-demo-fonts', false, array(), '1.0.1');
    wp_enqueue_style('toolrail-demo-fonts');
    wp_add_inline_style('toolrail-demo-fonts', $css);
});
