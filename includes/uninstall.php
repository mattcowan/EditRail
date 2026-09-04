<?php
/**
 * Uninstall helpers: what deleting the plugin removes, and how.
 *
 * The plugin writes nothing of its own to the database: no options, no
 * transients, no post meta, no tables. Its whole footprint is the per-user
 * editor preferences (pinned tools, toolbar position, saved sets, appearance,
 * the help and inserter toggles) that `core/preferences` persists under the
 * `toolrail` scope of core's OWN user-meta row, `{blog prefix}persisted_preferences`
 * (wp-includes/script-loader.php builds that key with $wpdb->get_blog_prefix()).
 * That row is one PHP-serialized array per user which also holds core's
 * editor preferences, so uninstall cannot delete a row: it strips ONE key
 * out of each user's array and writes the rest back untouched.
 *
 * `_modified` is bumped on every stripped row. Core's persistence layer
 * (wp-includes/js/dist/preferences-persistence.js) keeps a localStorage
 * copy of the same array and, on the next editor load, uses the server copy
 * only when server._modified >= local._modified. Bumping the stamp makes
 * the server copy win outright, so a reinstall in the same browser does not
 * resurrect the pins from core's browser cache. The plugin's own `toolrail-*`
 * localStorage fallback keys are out of PHP's reach; a reinstall in the same
 * browser migrates those back into the account (see migrateLocalToPrefs in
 * assets/editor-rail.js). Accepted, owner decision 2026-09-04: a browser-local
 * mirror is not site data, and the row is clean for every other browser.
 *
 * Kept apart from the root uninstall.php so the helpers load in the
 * standalone PHPUnit bootstrap, which never defines WP_UNINSTALL_PLUGIN.
 *
 * @package Toolrail
 */

defined('ABSPATH') || exit;

/**
 * Strip the `toolrail` scope out of one user's persisted-preferences array.
 *
 * Pure: no WordPress calls. Returns the array to write back, or null when
 * there is nothing to do, so a user who never opened the rail (no `toolrail`
 * key) is left alone and does not get a `_modified` bump for nothing.
 *
 * @param mixed  $prefs The stored meta value: an array, or '' / anything else
 *                      when the user has no row (get_user_meta's single-value
 *                      miss is '').
 * @param string $now   ISO-8601 UTC stamp to store as `_modified`.
 * @return array|null   The stripped array, or null when nothing changes.
 */
function toolrail_uninstall_strip_preferences($prefs, $now) {
    if (!is_array($prefs) || !array_key_exists('toolrail', $prefs)) {
        return null;
    }
    unset($prefs['toolrail']);
    $prefs['_modified'] = (string) $now;
    return $prefs;
}

/**
 * Strip the scope from every user's row under one site's meta key.
 *
 * `blog_id => 0` lifts WP_User_Query's default "members of the current site"
 * clause, because on a network a user removed from a site keeps the meta
 * row that site's key wrote.
 *
 * @param string $meta_key The site's persisted-preferences meta key.
 * @param string $now      ISO-8601 UTC stamp to store as `_modified`.
 * @return int             Number of rows rewritten.
 */
function toolrail_uninstall_scrub_site($meta_key, $now) {
    $count    = 0;
    $user_ids = get_users([
        'fields'   => 'ids',
        'meta_key' => $meta_key, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key -- one-time uninstall pass, keyed lookup on usermeta.
        'blog_id'  => 0,
    ]);
    foreach ((array) $user_ids as $user_id) {
        $stripped = toolrail_uninstall_strip_preferences(get_user_meta($user_id, $meta_key, true), $now);
        if ($stripped === null) {
            continue;
        }
        update_user_meta($user_id, $meta_key, $stripped);
        $count++;
    }
    return $count;
}

/**
 * Remove the plugin's per-user preferences from every user, on every site.
 *
 * Plugin files are shared across a network, so WordPress runs uninstall once
 * for the whole network; every site's meta key is visited here. Site ids go
 * straight to get_blog_prefix(), so no switch_to_blog() is needed.
 *
 * @return int Number of user rows rewritten across all sites.
 */
function toolrail_uninstall() {
    global $wpdb;

    // Same shape core writes from JS: new Date().toISOString().
    $now      = gmdate('Y-m-d\TH:i:s') . '.000Z';
    $site_ids = is_multisite() ? get_sites(['fields' => 'ids', 'number' => 0]) : [null];
    $total    = 0;
    foreach ((array) $site_ids as $site_id) {
        $meta_key = $wpdb->get_blog_prefix($site_id) . 'persisted_preferences';
        $total   += toolrail_uninstall_scrub_site($meta_key, $now);
    }
    return $total;
}
