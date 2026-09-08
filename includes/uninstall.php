<?php
/**
 * Uninstall helpers: what deleting the plugin removes, and how.
 *
 * The plugin writes nothing of its own to the database: no options, no
 * transients, no post meta, no tables. Its whole footprint is the per-user
 * editor preferences (pinned tools and their custom names, descriptions and
 * icons, toolbar position, saved sets, appearance, the help and inserter
 * toggles) that `core/preferences` persists under the
 * `toolrail` scope of core's OWN user-meta row, `{blog prefix}persisted_preferences`
 * (wp-includes/script-loader.php builds that key with $wpdb->get_blog_prefix()).
 * That row is one PHP-serialized array per user which also holds core's
 * editor preferences, so uninstall cannot delete a row: it strips ONE key
 * out of each user's array and writes the rest back untouched.
 *
 * `_modified` is bumped on every stripped row. Core's persistence layer
 * (wp-includes/js/dist/preferences-persistence.js) keeps a localStorage
 * copy of the same array and, on the next editor load, uses the server copy
 * only when server._modified >= local._modified. The local stamp is the
 * BROWSER's clock at its last write and this one is the SERVER's, so the
 * bump carries a one-hour forward margin: a browser running a few minutes
 * ahead of the server still loses the comparison, and the margin is
 * harmless because the browser's next write replaces the stamp with its
 * own. The plugin's own `toolrail-*` localStorage fallback keys are out of
 * PHP's reach. Only four of them are ever lifted back into the account
 * (position, pins, saved sets, migration stamp — migrateLocalToPrefs in
 * assets/editor-rail.js; colors and the help/inserter toggles stay gone),
 * and since 0.1.25 the rail deletes a browser's copy of those four the
 * first time it boots against an account that already holds them, so a
 * browser in regular use has nothing left to lift after a delete +
 * reinstall. What remains is a browser that had a fallback-session write
 * (Storage threw) and has not booted since: that copy comes back once.
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
 * @param mixed  $prefs One stored meta value: normally an array; anything
 *                      else (a corrupt row, '' from a single-value miss) is
 *                      left alone.
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
 * Strip the scope from one user's row(s) without clobbering a concurrent write.
 *
 * An editor tab still open during the uninstall can land its debounced REST
 * write between this function's read and its write. A plain update_user_meta()
 * would then overwrite that newer row with a stripped copy of the OLD one and
 * lose whatever core preference the tab had just changed. So every write is
 * conditional: update_metadata() with a $prev_value adds `meta_value = <the
 * serialized value that was read>` to its WHERE and returns false when no row
 * matched — i.e. someone else wrote first. On false, drop the cached copy,
 * re-read and go again, a bounded number of times (the writer is debounced at
 * 2.5s; three collisions in a row do not happen).
 *
 * Reading every value (not `$single`) also covers a duplicate-row key. Core
 * registers this meta as single and writes it through update_metadata(), so
 * duplicates are not expected — but with $prev_value each distinct value is
 * stripped on its own, where an unconditional update would have stamped one
 * row's stripped copy over all of them. Two duplicates with the SAME value are
 * updated by one call (that is how update_metadata() works); the loop's second
 * attempt at that value then matches nothing, which reads as a collision and
 * costs one harmless re-read.
 *
 * @param int    $user_id  The user.
 * @param string $meta_key The site's persisted-preferences meta key.
 * @param string $now      ISO-8601 UTC stamp to store as `_modified`.
 * @return int             Number of conditional updates that landed.
 */
function toolrail_uninstall_scrub_user($user_id, $meta_key, $now) {
    $count = 0;
    for ($attempt = 0; $attempt < 3; $attempt++) {
        // update_metadata() only clears this cache on a SUCCESSFUL write, so a
        // re-read after a refused one would otherwise see the stale copy.
        wp_cache_delete($user_id, 'user_meta');
        $collided = false;
        $pending  = false;
        foreach ((array) get_user_meta($user_id, $meta_key, false) as $value) {
            $stripped = toolrail_uninstall_strip_preferences($value, $now);
            if ($stripped === null) {
                continue;
            }
            $pending = true;
            if (update_user_meta($user_id, $meta_key, $stripped, $value)) {
                $count++;
            } else {
                $collided = true;
            }
        }
        if (!$pending || !$collided) {
            break;
        }
    }
    return $count;
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
        $count += toolrail_uninstall_scrub_user($user_id, $meta_key, $now);
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

    // Same shape core writes from JS: new Date().toISOString(). One hour
    // ahead, so a browser whose clock runs ahead of the server's still sees
    // the stripped server copy as the newer one (see the file docblock).
    $now      = gmdate('Y-m-d\TH:i:s', time() + 3600) . '.000Z';
    $site_ids = is_multisite() ? get_sites(['fields' => 'ids', 'number' => 0]) : [null];
    $total    = 0;
    foreach ((array) $site_ids as $site_id) {
        $meta_key = $wpdb->get_blog_prefix($site_id) . 'persisted_preferences';
        $total   += toolrail_uninstall_scrub_site($meta_key, $now);
    }
    return $total;
}
