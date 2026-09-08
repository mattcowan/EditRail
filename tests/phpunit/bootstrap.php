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
    define('TOOLRAIL_PLUGIN_URL', 'http://example.test/wp-content/plugins/editrail/');
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

// --- Uninstall stubs: a fake usermeta store keyed [user_id][meta_key] =>
// LIST of row values (usermeta allows several rows per key), a single-site
// default, and just enough of $wpdb for get_blog_prefix(). The uninstall
// runner is a loop over these calls and nothing else, so faking them here
// makes the whole runner testable, not only its pure helper. The update
// stub honors $prev_value the way update_metadata() does — every row whose
// value matches is rewritten, and no match returns false — and
// `toolrail_test_before_update` is a hook a test can use to slip a
// concurrent write in between the runner's read and its write.
$GLOBALS['toolrail_test_user_meta']     = [];
$GLOBALS['toolrail_test_multisite']     = false;
$GLOBALS['toolrail_test_site_ids']      = [1];
$GLOBALS['toolrail_test_before_update'] = null;

if (!function_exists('wp_cache_delete')) {
    function wp_cache_delete($key, $group = '') {
        return true;
    }
}

if (!function_exists('is_multisite')) {
    function is_multisite() {
        return !empty($GLOBALS['toolrail_test_multisite']);
    }
}

if (!function_exists('get_sites')) {
    function get_sites($args = []) {
        $GLOBALS['toolrail_test_last_site_query'] = $args;
        return $GLOBALS['toolrail_test_site_ids'];
    }
}

if (!function_exists('get_users')) {
    function get_users($args = []) {
        $GLOBALS['toolrail_test_last_user_query'] = $args;
        $ids = [];
        foreach ($GLOBALS['toolrail_test_user_meta'] as $user_id => $meta) {
            if (isset($args['meta_key']) && !array_key_exists($args['meta_key'], $meta)) {
                continue;
            }
            $ids[] = $user_id;
        }
        return $ids;
    }
}

if (!function_exists('get_user_meta')) {
    function get_user_meta($user_id, $key = '', $single = false) {
        $meta = $GLOBALS['toolrail_test_user_meta'][$user_id] ?? [];
        if (empty($meta[$key])) {
            return $single ? '' : [];
        }
        return $single ? $meta[$key][0] : $meta[$key];
    }
}

if (!function_exists('update_user_meta')) {
    function update_user_meta($user_id, $key, $value, $prev_value = '') {
        if (is_callable($GLOBALS['toolrail_test_before_update'])) {
            call_user_func($GLOBALS['toolrail_test_before_update'], $user_id, $key);
        }
        $rows = $GLOBALS['toolrail_test_user_meta'][$user_id][$key] ?? [];
        if ($rows === []) {
            $GLOBALS['toolrail_test_user_meta'][$user_id][$key] = [$value];
            return true;
        }
        $matched = 0;
        foreach ($rows as $i => $row) {
            if ($prev_value !== '' && $row !== $prev_value) {
                continue;
            }
            $rows[$i] = $value;
            $matched++;
        }
        if ($matched === 0) {
            return false;
        }
        $GLOBALS['toolrail_test_user_meta'][$user_id][$key] = $rows;
        return true;
    }
}

if (!class_exists('Toolrail_Test_WPDB')) {
    class Toolrail_Test_WPDB {
        public function get_blog_prefix($blog_id = null) {
            return ($blog_id === null || (int) $blog_id === 1) ? 'wp_' : 'wp_' . (int) $blog_id . '_';
        }
    }
}
if (!isset($GLOBALS['wpdb'])) {
    $GLOBALS['wpdb'] = new Toolrail_Test_WPDB();
}

require_once TOOLRAIL_PLUGIN_DIR . 'includes/providers.php';
require_once TOOLRAIL_PLUGIN_DIR . 'includes/rail.php';
require_once TOOLRAIL_PLUGIN_DIR . 'includes/uninstall.php';
