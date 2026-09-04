<?php
/**
 * Plugin Name:       Editor Tool Rail
 * Description:       A movable, graphics-editor-style toolbar for the block editor. Click a tool, then click the canvas to insert a core block at that point.
 * Version:           1.0.0
 * Requires at least: 6.5
 * Requires PHP:      7.4
 * Author:            Matthew Cowan
 * Author URI:        https://mnc4.com/
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       toolrail
 *
 * @package Toolrail
 */

defined('ABSPATH') || exit;

// Guarded so the standalone PHPUnit bootstrap can pre-define them.
if (!defined('TOOLRAIL_VERSION')) {
    define('TOOLRAIL_VERSION', '1.0.0');
}
if (!defined('TOOLRAIL_PLUGIN_DIR')) {
    define('TOOLRAIL_PLUGIN_DIR', plugin_dir_path(__FILE__));
}
if (!defined('TOOLRAIL_PLUGIN_URL')) {
    define('TOOLRAIL_PLUGIN_URL', plugin_dir_url(__FILE__));
}

require_once TOOLRAIL_PLUGIN_DIR . 'includes/providers.php';
require_once TOOLRAIL_PLUGIN_DIR . 'includes/rail.php';
