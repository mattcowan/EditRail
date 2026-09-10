<?php
/**
 * Plugin Name: EditRail demo fonts
 * Description: Registers EB Garamond in the WordPress Font Library for the Playground demo post, from the font's own repository. Not part of the plugin.
 *
 * Written into /wordpress/wp-content/mu-plugins/ by the Playground
 * blueprint (scripts/playground.js embeds this file).
 *
 * EB Garamond (SIL Open Font License 1.1, the EB Garamond Project
 * Authors, https://github.com/octaviopardo/EBGaramond12) is served from
 * the google/fonts repository, which sends Access-Control-Allow-Origin: *
 * so the browser can load it cross-origin. These are the full variable
 * files, not the Google Fonts CSS service, which strips OpenType
 * features the demo depends on (swsh, dlig, ss01).
 *
 * Two registrations, on purpose:
 *
 * 1. theme.json (settings.typography.fontFamilies). This is what puts
 *    the font in the WordPress Font Library, and the Library is where
 *    Typography Stylist's font picker reads fonts from. The demo's
 *    runPHP step then adopts the font through the plugin's own bridge,
 *    so it has a font_id and the demo post's blocks show it as the
 *    selected font. WordPress also prints @font-face for the faces
 *    declared here, on the front end and in the editor.
 * 2. An inline @font-face on enqueue_block_assets, the same two faces.
 *    A belt for the braces: it reaches the editor's canvas iframe and
 *    the front end whatever WordPress decides to print for a theme
 *    font a plugin added, and a duplicate face costs nothing.
 *
 * @package Toolrail
 */

define('TOOLRAIL_DEMO_FONT_BASE', 'https://raw.githubusercontent.com/google/fonts/main/ofl/ebgaramond/');

/**
 * The two faces, in theme.json's fontFace shape.
 *
 * @return array[]
 */
function toolrail_demo_font_faces() {
    return array(
        array(
            'fontFamily' => 'EB Garamond',
            'fontStyle'  => 'normal',
            'fontWeight' => '400 800',
            'src'        => array(TOOLRAIL_DEMO_FONT_BASE . 'EBGaramond%5Bwght%5D.ttf'),
        ),
        array(
            'fontFamily' => 'EB Garamond',
            'fontStyle'  => 'italic',
            'fontWeight' => '400 800',
            'src'        => array(TOOLRAIL_DEMO_FONT_BASE . 'EBGaramond-Italic%5Bwght%5D.ttf'),
        ),
    );
}

// Append to the theme's font families rather than replace them: the
// theme's own fonts (Manrope for the body) must survive, and a bare
// update_with() would swap the whole preset.
//
// SHAPE MATTERS. Inside WP_Theme_JSON the preset is keyed by origin:
// ['theme' => [family, family, …]]. The new family has to go INSIDE that
// list. Appending it beside the 'theme' key ([ 'theme' => […], 0 => family ])
// still renders on the front end (PHP merges it anyway) but crashes the
// block editor, which iterates the origins and finds a family where it
// expects a list ("s[c] is not iterable", observed 2026-09-09).
add_filter('wp_theme_json_data_theme', function ($theme_json) {
    $data     = $theme_json->get_data();
    $families = isset($data['settings']['typography']['fontFamilies'])
        ? $data['settings']['typography']['fontFamilies']
        : array();
    $entry = array(
        'name'       => 'EB Garamond',
        'slug'       => 'eb-garamond',
        'fontFamily' => '"EB Garamond", serif',
        'fontFace'   => toolrail_demo_font_faces(),
    );
    $by_origin = is_array($families) && (isset($families['theme']) || isset($families['custom']) || isset($families['default']));
    $list = $by_origin
        ? (isset($families['theme']) && is_array($families['theme']) ? $families['theme'] : array())
        : (is_array($families) ? $families : array());
    foreach ($list as $family) {
        if (isset($family['slug']) && 'eb-garamond' === $family['slug']) {
            return $theme_json;
        }
    }
    $list[] = $entry;
    if ($by_origin) {
        $families['theme'] = $list;
    } else {
        $families = $list;
    }
    return $theme_json->update_with(array(
        'version'  => isset($data['version']) ? $data['version'] : 3,
        'settings' => array('typography' => array('fontFamilies' => $families)),
    ));
});

// The same two faces as an inline @font-face for the editor canvas and
// the front end (registration 2 in the header).
add_action('enqueue_block_assets', function () {
    $css = '';
    foreach (toolrail_demo_font_faces() as $face) {
        $css .= sprintf(
            "@font-face{font-family:'%s';font-style:%s;font-weight:%s;font-display:swap;src:url('%s') format('truetype');}",
            $face['fontFamily'],
            $face['fontStyle'],
            $face['fontWeight'],
            esc_url($face['src'][0])
        );
    }
    // Styles enqueued on this hook reach the editor's canvas iframe and
    // the front end alike.
    wp_register_style('toolrail-demo-fonts', false, array(), '1.0.1');
    wp_enqueue_style('toolrail-demo-fonts');
    wp_add_inline_style('toolrail-demo-fonts', $css);
});
