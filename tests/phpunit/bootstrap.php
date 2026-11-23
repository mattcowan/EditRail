<?php
/**
 * Standalone PHPUnit bootstrap — no WordPress install required.
 *
 * Stub just enough of WordPress that the plugin's files load and the PURE
 * helpers are testable directly. add_filter/apply_filters here are a WORKING
 * minimal
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
    /** Record a filter callback; priority and argument count are ignored. */
    function add_filter($tag, $callback, $priority = 10, $accepted_args = 1) {
        $GLOBALS['toolrail_test_filters'][$tag][] = $callback;
        return true;
    }
}

if (!function_exists('add_action')) {
    /** Same as add_filter(): the tests never distinguish the two. */
    function add_action($tag, $callback, $priority = 10, $accepted_args = 1) {
        return add_filter($tag, $callback, $priority, $accepted_args);
    }
}

if (!function_exists('apply_filters')) {
    /** Run the recorded callbacks for a tag in the order they were added. */
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
    /** Forget every callback recorded for a tag. */
    function remove_all_filters($tag) {
        unset($GLOBALS['toolrail_test_filters'][$tag]);
        return true;
    }
}

if (!function_exists('sanitize_key')) {
    /** Lowercase and strip to [a-z0-9_-], like core. */
    function sanitize_key($key) {
        $key = strtolower((string) $key);
        return preg_replace('/[^a-z0-9_\-]/', '', $key);
    }
}

if (!function_exists('wp_list_pluck')) {
    /** One field from every array or object in a list, like core. */
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
    /** Return the string untranslated. */
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
    /** No cache in the tests; always true. */
    function wp_cache_delete($key, $group = '') {
        return true;
    }
}

if (!function_exists('is_multisite')) {
    /** Whether the test pretends to be a network install. */
    function is_multisite() {
        return !empty($GLOBALS['toolrail_test_multisite']);
    }
}

if (!function_exists('get_sites')) {
    /** The test's site IDs; the query is recorded for assertions. */
    function get_sites($args = []) {
        $GLOBALS['toolrail_test_last_site_query'] = $args;
        return $GLOBALS['toolrail_test_site_ids'];
    }
}

if (!function_exists('get_users')) {
    /** IDs of test users that have the requested meta key; the query is recorded. */
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
    /** Read the in-memory user meta store, single or all rows. */
    function get_user_meta($user_id, $key = '', $single = false) {
        $meta = $GLOBALS['toolrail_test_user_meta'][$user_id] ?? [];
        if (empty($meta[$key])) {
            return $single ? '' : [];
        }
        return $single ? $meta[$key][0] : $meta[$key];
    }
}

if (!function_exists('update_user_meta')) {
    /** Write the in-memory user meta store the way core does, including the previous-value match and the false return when nothing matched. */
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

// --- Shared-set uninstall stubs (#98): a fake posts store keyed by TABLE
// name ('wp_posts', 'wp_2_posts') => [ID => ['post_type' => …, 'post_status'
// => …]], so each network site has its own table the way the real install
// does. switch_to_blog() changes the current site and $wpdb->posts with it;
// get_col() answers the one query the uninstall pass makes (IDs of one post
// type in one table) and records it; wp_delete_post() records the call and
// removes the row from the CURRENT site's table only.
$GLOBALS['toolrail_test_posts']         = [];
$GLOBALS['toolrail_test_blog_id']       = 1;
$GLOBALS['toolrail_test_blog_stack']    = [];
$GLOBALS['toolrail_test_switches']      = [];
$GLOBALS['toolrail_test_deleted_posts'] = [];
$GLOBALS['toolrail_test_queries']       = [];

if (!class_exists('Toolrail_Test_WPDB')) {
    class Toolrail_Test_WPDB {
        /** The current site's posts table, like core's $wpdb->posts. */
        public $posts = 'wp_posts';

        /** wp_ for site 1, wp_N_ for any other site, like core. */
        public function get_blog_prefix($blog_id = null) {
            return ($blog_id === null || (int) $blog_id === 1) ? 'wp_' : 'wp_' . (int) $blog_id . '_';
        }

        /** Quote each %s argument the way core does, enough for the fake get_col(). */
        public function prepare($query, ...$args) {
            return vsprintf(str_replace('%s', "'%s'", $query), $args);
        }

        /** IDs of one post type in one fake table, for the uninstall query only. */
        public function get_col($query) {
            $GLOBALS['toolrail_test_queries'][] = $query;
            if (!preg_match("/FROM (\\S+) WHERE post_type = '([^']*)'/", $query, $m)) {
                return [];
            }
            $ids = [];
            foreach ($GLOBALS['toolrail_test_posts'][$m[1]] ?? [] as $id => $row) {
                if ($row['post_type'] === $m[2]) {
                    $ids[] = (string) $id;
                }
            }
            return $ids;
        }
    }
}
if (!isset($GLOBALS['wpdb'])) {
    $GLOBALS['wpdb'] = new Toolrail_Test_WPDB();
}

if (!function_exists('switch_to_blog')) {
    /** Make another fake site current; $wpdb->posts follows. */
    function switch_to_blog($blog_id) {
        $GLOBALS['toolrail_test_blog_stack'][] = $GLOBALS['toolrail_test_blog_id'];
        $GLOBALS['toolrail_test_switches'][]   = (int) $blog_id;
        $GLOBALS['toolrail_test_blog_id']      = (int) $blog_id;
        $GLOBALS['wpdb']->posts                = $GLOBALS['wpdb']->get_blog_prefix($blog_id) . 'posts';
        return true;
    }
}

if (!function_exists('restore_current_blog')) {
    /** Go back to the site before the last switch_to_blog(). */
    function restore_current_blog() {
        $blog_id                          = array_pop($GLOBALS['toolrail_test_blog_stack']);
        $GLOBALS['toolrail_test_blog_id'] = (int) $blog_id;
        $GLOBALS['wpdb']->posts           = $GLOBALS['wpdb']->get_blog_prefix($blog_id) . 'posts';
        return true;
    }
}

if (!function_exists('wp_delete_post')) {
    /** Remove a row from the current site's fake table; false when it is not there. */
    function wp_delete_post($post_id, $force_delete = false) {
        $table = $GLOBALS['wpdb']->posts;
        $GLOBALS['toolrail_test_deleted_posts'][] = [$table, (int) $post_id, $force_delete];
        if (!isset($GLOBALS['toolrail_test_posts'][$table][(int) $post_id])) {
            return false;
        }
        $row = $GLOBALS['toolrail_test_posts'][$table][(int) $post_id];
        unset($GLOBALS['toolrail_test_posts'][$table][(int) $post_id]);
        return (object) $row;
    }
}

if (!function_exists('wp_json_encode')) {
    /** Core's wrapper; json_decode() output is always valid UTF-8, so plain json_encode() is enough here. */
    function wp_json_encode($data, $options = 0, $depth = 512) {
        return json_encode($data, $options, $depth);
    }
}

// --- Asset registration stubs (#102): record what rail.php registers, in
// order, so a test can check that every rail script is registered and that
// each dependency is registered before the script that needs it.
$GLOBALS['toolrail_test_scripts'] = [];
$GLOBALS['toolrail_test_styles']  = [];

if (!function_exists('wp_register_script')) {
    /** Record a script registration; the last one for a handle wins. */
    function wp_register_script($handle, $src, $deps = [], $ver = false, $in_footer = false) {
        $GLOBALS['toolrail_test_scripts'][$handle] = [
            'src'       => $src,
            'deps'      => $deps,
            'ver'       => $ver,
            'in_footer' => $in_footer,
        ];
        return true;
    }
}

if (!function_exists('wp_register_style')) {
    /** Record a style registration; the last one for a handle wins. */
    function wp_register_style($handle, $src, $deps = [], $ver = false, $media = 'all') {
        $GLOBALS['toolrail_test_styles'][$handle] = [
            'src'  => $src,
            'deps' => $deps,
            'ver'  => $ver,
        ];
        return true;
    }
}

require_once TOOLRAIL_PLUGIN_DIR . 'includes/providers.php';
require_once TOOLRAIL_PLUGIN_DIR . 'includes/rail.php';
require_once TOOLRAIL_PLUGIN_DIR . 'includes/shared-sets.php';
require_once TOOLRAIL_PLUGIN_DIR . 'includes/uninstall.php';
