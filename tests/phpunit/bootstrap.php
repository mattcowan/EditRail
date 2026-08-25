<?php
/**
 * Standalone PHPUnit bootstrap — no WordPress install required.
 *
 * The Background Candy convention: stub just enough of WordPress that the
 * plugin's files load and the PURE helpers are testable directly. Unlike the
 * theme's bootstrap, add_filter/apply_filters here are a WORKING minimal
 * hook system, because the provider registry's whole contract is "collect
 * what the filter returns and refuse the malformed parts" — a no-op filter
 * stub would make those tests vacuous.
 */

if (!defined('ABSPATH')) {
    define('ABSPATH', '/');
}
if (!defined('TOOLRAIL_VERSION')) {
    define('TOOLRAIL_VERSION', '0.0.0-test');
}
if (!defined('TOOLRAIL_PLUGIN_DIR')) {
    define('TOOLRAIL_PLUGIN_DIR', dirname(dirname(__DIR__)) . '/');
}
if (!defined('TOOLRAIL_PLUGIN_URL')) {
    define('TOOLRAIL_PLUGIN_URL', 'http://example.test/wp-content/plugins/toolrail/');
}

$GLOBALS['toolrail_test_filters'] = [];

if (!function_exists('add_filter')) {
    function add_filter($tag, $callback, $priority = 10, $accepted_args = 1) {
        $GLOBALS['toolrail_test_filters'][$tag][] = $callback;
        return true;
    }
}

if (!function_exists('add_action')) {
    function add_action($tag, $callback, $priority = 10, $accepted_args = 1) {
        return add_filter($tag, $callback, $priority, $accepted_args);
    }
}

if (!function_exists('apply_filters')) {
    function apply_filters($tag, $value, ...$args) {
        if (empty($GLOBALS['toolrail_test_filters'][$tag])) {
            return $value;
        }
        foreach ($GLOBALS['toolrail_test_filters'][$tag] as $callback) {
            $value = call_user_func($callback, $value, ...$args);
        }
        return $value;
    }
}

if (!function_exists('remove_all_filters')) {
    function remove_all_filters($tag) {
        unset($GLOBALS['toolrail_test_filters'][$tag]);
        return true;
    }
}

if (!function_exists('sanitize_key')) {
    function sanitize_key($key) {
        $key = strtolower((string) $key);
        return preg_replace('/[^a-z0-9_\-]/', '', $key);
    }
}

if (!function_exists('wp_list_pluck')) {
    function wp_list_pluck($input_list, $field) {
        $out = [];
        foreach ((array) $input_list as $item) {
            if (is_array($item) && array_key_exists($field, $item)) {
                $out[] = $item[$field];
            } elseif (is_object($item) && isset($item->$field)) {
                $out[] = $item->$field;
            }
        }
        return $out;
    }
}

if (!function_exists('__')) {
    function __($text, $domain = 'default') {
        return $text;
    }
}

if (!class_exists('WP_UnitTestCase')) {
    class WP_UnitTestCase extends \PHPUnit\Framework\TestCase {}
}

require_once TOOLRAIL_PLUGIN_DIR . 'includes/providers.php';
require_once TOOLRAIL_PLUGIN_DIR . 'includes/rail.php';
