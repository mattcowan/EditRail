<?php
/**
 * Plugin Name:       Editor Tool Rail
 * Plugin URI:        https://mnc4.com/
 * Description:       A movable, Photoshop-familiar toolbar for the block editor — dock it to any edge or float it. Tools insert ordinary core blocks; other plugins and themes register their own tools through a small provider API.
 * Version:           0.1.18
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
    define('TOOLRAIL_VERSION', '0.1.18');
}
if (!defined('TOOLRAIL_PLUGIN_DIR')) {
    define('TOOLRAIL_PLUGIN_DIR', plugin_dir_path(__FILE__));
}
if (!defined('TOOLRAIL_PLUGIN_URL')) {
    define('TOOLRAIL_PLUGIN_URL', plugin_dir_url(__FILE__));
}

require_once TOOLRAIL_PLUGIN_DIR . 'includes/providers.php';
require_once TOOLRAIL_PLUGIN_DIR . 'includes/rail.php';
