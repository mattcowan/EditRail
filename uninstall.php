<?php
/**
 * Runs once when the plugin is DELETED from the Plugins screen. Deactivation
 * does not run it, so an author's toolbar survives a deactivate/activate.
 * What it removes, and why it works the way it does: includes/uninstall.php.
 *
 * @package Toolrail
 */

defined('WP_UNINSTALL_PLUGIN') || exit;

require_once __DIR__ . '/includes/uninstall.php';

toolrail_uninstall();
