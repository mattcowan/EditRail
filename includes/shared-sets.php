<?php
/**
 * Shared sets (#98): an author shares one of their saved sets with the
 * other users of the same site.
 *
 * A saved set is otherwise a per-user preference (the `toolrail` scope of
 * core's persisted-preferences user meta; see includes/uninstall.php). A
 * shared set is the plugin's own record, kept apart from every user's
 * preferences: one post of the private post type `editrail_set` per author
 * and set name. The post holds a COPY of the set, in the set file format,
 * and the set name. Nothing else: no pins, position, colors or other
 * settings of the author, and nothing of the user who loads it. A later
 * change to the author's own set does not reach the copy until the author
 * shares the set again, which updates the same post in place.
 *
 * WHY A POST TYPE. Core's post capabilities then answer "who may": sharing
 * is creating a published post (`publish_posts`: Author and up), reading
 * is `edit_posts` (Contributor and up, the same rule core's own `wp_block`
 * patterns use), deleting your own is `delete_published_posts`, deleting
 * another user's is `delete_others_posts` (Editor and up), and editing
 * another user's set is never allowed. See toolrail_shared_set_capabilities().
 *
 * WHY NO DEFAULT REST ROUTES. The type is registered with show_in_rest
 * FALSE, and this file adds routes of its own under `editrail/v1`: GET and
 * POST on /sets (list, share), GET and DELETE on /sets/<id> (one set, stop
 * sharing).
 * The default posts controller would publish every published post of the
 * type to anyone, logged out included (WP_REST_Posts_Controller::
 * check_read_permission returns true for any `publish` post), and core's
 * users controller lists, to logged-out visitors, every user who has a
 * published post of ANY show_in_rest type (class-wp-rest-users-controller.php,
 * check_read_permission and the has_published_posts default in get_items;
 * read on WordPress 7.1.3, 2026-11-13). So a user whose only content is a
 * shared set would become visible to the public. The routes below answer
 * only to logged-in users with `edit_posts`, and return only the fields a
 * set file holds, the sharer's display name and two flags.
 *
 * WHY BASE64 IN post_content. wp_insert_post() runs `content_save_pre`,
 * which is kses for a user without `unfiltered_html` (Authors, and every
 * user on a multisite network except super admins). kses strips tags, and
 * its wp_kses_no_null() removes every backslash run followed by a zero, so
 * a set named `a\0b` or `<b>` did not survive a JSON round trip there. The
 * title filter is kses too. The canonical JSON is stored base64-encoded,
 * which no content filter changes, and the title holds only a plain-text
 * copy of the name for a person who reads the table. The name that counts
 * is the one inside the JSON.
 *
 * TRUST. The server never trusts the payload: every write goes through
 * toolrail_shared_set_normalize() (the grammar importConfigPayload() in
 * assets/editor-rail.js enforces on a set file, plus size, name and count
 * caps), and every read goes through it again, so a row written by any
 * other path (a database edit, an import) is checked before a browser sees
 * it. toolrail_shared_set_guard_insert() refuses every insert or update of
 * the type that does not come from these routes (XML-RPC, a CLI, an
 * importer), so the caps hold too.
 *
 * DEACTIVATION keeps the posts: nothing registers the type or the routes,
 * so nothing shows them, and they come back when the plugin is active
 * again. A delete of the plugin removes them on every site
 * (toolrail_uninstall_delete_shared_sets() in includes/uninstall.php).
 *
 * The pure helpers (no WordPress calls) take the checks inside them, so the
 * PHPUnit suite tests them directly; see tests/phpunit/Test_Shared_Sets.php.
 *
 * @package Toolrail
 */

defined('ABSPATH') || exit;

/**
 * The post type that holds shared sets. Stored in every row: a rename is a
 * migration.
 */
const TOOLRAIL_SHARED_SET_TYPE = 'editrail_set';

/**
 * The REST namespace and base of the shared-set routes.
 */
const TOOLRAIL_SHARED_SET_REST_NAMESPACE = 'editrail/v1';
const TOOLRAIL_SHARED_SET_REST_BASE      = 'sets';

/**
 * The caps a shared set must stay within.
 *
 * - name_length: characters (Unicode code points, as the rail counts) in a
 *   set name. A longer name is refused, not cut: the name is how the
 *   author's own set and its shared copy find each other.
 * - slots: pinned tools in one set, after duplicates are collapsed.
 * - json_bytes: the canonical JSON that is stored.
 * - request_bytes: the JSON a browser sends, before it is parsed.
 * - per_author: shared sets one user can have on a site. Every share is a
 *   post and every editor load lists them all, so one account (or a script
 *   with its cookie) must not be able to fill the table.
 * - list: the most sets one list response holds. Past it, the newest are
 *   kept and the oldest are left out.
 *
 * Pure.
 *
 * @return array<string,int>
 */
function toolrail_shared_set_limits() {
    return [
        'name_length'   => 100,
        'slots'         => 200,
        'json_bytes'    => 65536,
        'request_bytes' => 262144,
        'per_author'    => 25,
        'list'          => 500,
    ];
}

/**
 * The type's capabilities: core's post capabilities, with three changes.
 *
 * - `read` => edit_posts: core maps read_post on a published post to the
 *   type's `read`, which is plain `read` (every Subscriber) by default.
 *   Core's wp_block type makes the same change (wp-includes/post.php).
 * - `create_posts` => publish_posts: a share IS a published post, so a
 *   user who cannot publish (a Contributor) cannot share.
 * - `edit_others_posts` => do_not_allow: nobody changes another user's
 *   shared set. has_cap() refuses do_not_allow even to a super admin.
 *   Deleting another user's set still maps to delete_others_posts.
 *
 * Every other key comes from capability_type 'post' through core's
 * get_post_type_capabilities(). Pure.
 *
 * @return array<string,string>
 */
function toolrail_shared_set_capabilities() {
    return [
        'read'              => 'edit_posts',
        'create_posts'      => 'publish_posts',
        'edit_others_posts' => 'do_not_allow',
    ];
}

/**
 * The register_post_type() arguments. Private on every axis: no admin
 * screens, no front end (not queryable, no query var, no rewrite, no
 * archive, out of search and sitemaps), no default REST routes (see the
 * file docblock), not in a WordPress export file, and deleted with the user
 * who shared it unless their content goes to another user. Pure.
 *
 * @return array
 */
function toolrail_shared_set_post_type_args() {
    return [
        'labels'              => [
            'name'          => __('Shared sets', 'editrail'),
            'singular_name' => __('Shared set', 'editrail'),
        ],
        'description'         => __('Toolbar sets that EditRail users share on this site.', 'editrail'),
        'public'              => false,
        'publicly_queryable'  => false,
        'exclude_from_search' => true,
        'show_ui'             => false,
        'show_in_menu'        => false,
        'show_in_nav_menus'   => false,
        'show_in_admin_bar'   => false,
        'show_in_rest'        => false,
        'has_archive'         => false,
        'rewrite'             => false,
        'query_var'           => false,
        'can_export'          => false,
        'delete_with_user'    => true,
        'hierarchical'        => false,
        'supports'            => ['title', 'author'],
        'capability_type'     => 'post',
        'capabilities'        => toolrail_shared_set_capabilities(),
        'map_meta_cap'        => true,
    ];
}

/**
 * Register the post type on every request, so the capabilities map for
 * the REST routes and for uninstall's wp_delete_post().
 *
 * @return void
 */
function toolrail_register_shared_set_type() {
    register_post_type(TOOLRAIL_SHARED_SET_TYPE, toolrail_shared_set_post_type_args());
}
add_action('init', 'toolrail_register_shared_set_type');

// --- Pure helpers: the set grammar ---------------------------------------

/**
 * The characters JavaScript's String.prototype.trim() and `\s` treat as
 * white space, as a PCRE class body. PHP's trim() and a plain `\s` know
 * only ASCII, and the rail normalizes with the JavaScript set.
 */
const TOOLRAIL_SHARED_SET_SPACE = '\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}';

/**
 * Trim the way JavaScript's trim() does. Pure.
 *
 * @param string $text UTF-8 text.
 * @return string
 */
function toolrail_shared_set_trim($text) {
    $out = preg_replace('/^[' . TOOLRAIL_SHARED_SET_SPACE . ']+|[' . TOOLRAIL_SHARED_SET_SPACE . ']+\z/u', '', (string) $text);
    return null === $out ? '' : $out;
}

/**
 * Unicode code points in a UTF-8 string (JavaScript's Array.from(s).length).
 * PCRE only, so it needs no mbstring. Pure.
 *
 * @param string $text UTF-8 text.
 * @return int
 */
function toolrail_shared_set_length($text) {
    $count = preg_match_all('/./su', (string) $text);
    return false === $count ? 0 : $count;
}

/**
 * UTF-16 code units in a UTF-8 string (JavaScript's String.length): one per
 * code point, and one more for each code point above U+FFFF. Pure.
 *
 * @param string $text UTF-8 text.
 * @return int
 */
function toolrail_shared_set_utf16_length($text) {
    $astral = preg_match_all('/[\x{10000}-\x{10FFFF}]/u', (string) $text);
    return toolrail_shared_set_length($text) + (false === $astral ? 0 : $astral);
}

/**
 * The first $max code points of a UTF-8 string. Pure.
 *
 * @param string $text UTF-8 text.
 * @param int    $max  Code points to keep.
 * @return string
 */
function toolrail_shared_set_cut($text, $max) {
    $chars = preg_split('//u', (string) $text, -1, PREG_SPLIT_NO_EMPTY);
    return false === $chars ? '' : implode('', array_slice($chars, 0, $max));
}

/**
 * Whether a string is a slot the rail can pin: a block name, or a pattern
 * slot. The same two expressions as BLOCK_NAME_PATTERN and
 * PATTERN_SLOT_PATTERN in assets/editor-rail.js, with \z for $: PHP's $
 * also matches before a final line break, JavaScript's does not. Pure.
 *
 * @param mixed $slot Candidate slot.
 * @return bool
 */
function toolrail_shared_set_is_slot($slot) {
    if (!is_string($slot)) {
        return false;
    }
    return 1 === preg_match('/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\z/', $slot)
        || 1 === preg_match('/^pattern:(user:[0-9]+|[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)\z/i', $slot);
}

/**
 * The JSON flags for every encode: the output is UTF-8 text that the rail
 * parses again, so nothing needs escaping that JSON does not require.
 */
const TOOLRAIL_SHARED_SET_JSON_FLAGS = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_LINE_TERMINATORS;

/**
 * One pin's label entry, cleaned the way normalizePinMeta() in
 * assets/editor-rail.js cleans it: title and description with white-space
 * runs collapsed, trimmed and cut to 80 and 240 characters; an icon that is
 * a Dashicon name or at most three characters (grapheme clusters); and
 * extension data in namespaces of [a-z0-9-], each plain JSON of at most
 * 2048 UTF-16 code units. Objects stay stdClass so that `{}` does not come
 * back as `[]`. The field order is the rail's, so a set exports to the same
 * bytes after a trip through the server. Pure.
 *
 * The rail checks a Dashicon name against the list of names it ships; this
 * accepts any name of that shape, and the rail drops an unknown one when
 * the set loads.
 *
 * @param mixed $raw A decoded entry.
 * @return stdClass|null The clean entry, or null when nothing is left.
 */
function toolrail_shared_set_normalize_entry($raw) {
    if (!($raw instanceof stdClass)) {
        return null;
    }
    $out = new stdClass();
    foreach (['title' => 80, 'description' => 240] as $field => $max) {
        if (isset($raw->$field) && is_string($raw->$field)) {
            $text = toolrail_shared_set_trim((string) preg_replace('/[' . TOOLRAIL_SHARED_SET_SPACE . ']+/u', ' ', $raw->$field));
            if ('' !== $text) {
                $out->$field = toolrail_shared_set_cut($text, $max);
            }
        }
    }
    if (isset($raw->icon) && is_string($raw->icon)) {
        $icon = toolrail_shared_set_trim($raw->icon);
        $dashicon = 1 === preg_match('/^dashicons-[a-z0-9-]{1,54}\z/', $icon);
        $clusters = preg_match_all('/\X/u', $icon);
        if ('' !== $icon && ($dashicon || (false !== $clusters && $clusters <= 3))) {
            $out->icon = $icon;
        }
    }
    if (isset($raw->ext) && $raw->ext instanceof stdClass) {
        $ext = new stdClass();
        foreach (get_object_vars($raw->ext) as $namespace => $data) {
            $namespace = (string) $namespace;
            if (1 !== preg_match('/^[a-z0-9][a-z0-9-]{0,39}\z/', $namespace) || null === $data) {
                continue;
            }
            $json = wp_json_encode($data, TOOLRAIL_SHARED_SET_JSON_FLAGS);
            if (false === $json || toolrail_shared_set_utf16_length($json) > 2048) {
                continue;
            }
            $ext->$namespace = $data;
        }
        if (count(get_object_vars($ext))) {
            $out->ext = $ext;
        }
    }
    return count(get_object_vars($out)) ? $out : null;
}

/**
 * A failure result for toolrail_shared_set_normalize().
 *
 * @param string $code    Machine-readable code.
 * @param string $message Text for the author, in their language.
 * @return array
 */
function toolrail_shared_set_refuse($code, $message) {
    return [
        'ok'      => false,
        'code'    => $code,
        'message' => $message,
    ];
}

/**
 * Validate and normalize one set, as the JSON text of a set file.
 *
 * The same grammar importConfigPayload() in assets/editor-rail.js applies
 * to a set file: an object with a `blocks` array; entries that are not a
 * block name or a pattern slot are dropped; repeats are collapsed to the
 * first; labels are kept only for the set's own slots, each through
 * toolrail_shared_set_normalize_entry(). Added here: the name must be a
 * non-empty string with no control or line-break characters and at most
 * `name_length` characters (refused, never changed: the name is the key),
 * the set can hold at most `slots` tools, and the request and the result
 * have byte caps. Anything else in the payload is dropped.
 *
 * The result is re-encoded from the clean values, never passed through.
 * Pure (wp_json_encode() falls back to json_encode() in the tests).
 *
 * @param mixed $raw The JSON text a browser sent, or a stored row.
 * @return array ['ok' => true, 'name' => string, 'json' => string] or a
 *               toolrail_shared_set_refuse() result.
 */
function toolrail_shared_set_normalize($raw) {
    $limits = toolrail_shared_set_limits();
    if (!is_string($raw) || '' === $raw) {
        return toolrail_shared_set_refuse('toolrail_set_missing', __('The request does not contain a set.', 'editrail'));
    }
    if (strlen($raw) > $limits['request_bytes']) {
        return toolrail_shared_set_refuse('toolrail_set_too_large', __('The set is too large to share.', 'editrail'));
    }
    $data = json_decode($raw, false);
    if (!($data instanceof stdClass) || !isset($data->blocks) || !is_array($data->blocks)) {
        return toolrail_shared_set_refuse('toolrail_set_invalid', __('The set is not valid. A set must be JSON with a "blocks" array.', 'editrail'));
    }

    $name = isset($data->name) && is_string($data->name) ? toolrail_shared_set_trim($data->name) : '';
    if ('' === $name) {
        return toolrail_shared_set_refuse('toolrail_set_name_missing', __('The set has no name.', 'editrail'));
    }
    if (1 === preg_match('/[\x{0}-\x{1F}\x{7F}-\x{9F}\x{2028}\x{2029}]/u', $name)) {
        return toolrail_shared_set_refuse('toolrail_set_name_invalid', __('The set name contains a control character or a line break.', 'editrail'));
    }
    if (toolrail_shared_set_length($name) > $limits['name_length']) {
        return toolrail_shared_set_refuse(
            'toolrail_set_name_too_long',
            sprintf(
                /* translators: %d: maximum number of characters in a set name. */
                __('The set name is too long to share. Use %d characters or fewer.', 'editrail'),
                $limits['name_length']
            )
        );
    }

    $blocks = [];
    $seen   = [];
    foreach ($data->blocks as $slot) {
        if (!toolrail_shared_set_is_slot($slot) || isset($seen[$slot])) {
            continue;
        }
        $seen[$slot] = true;
        $blocks[]    = $slot;
    }
    if (count($blocks) > $limits['slots']) {
        return toolrail_shared_set_refuse(
            'toolrail_set_too_many_slots',
            sprintf(
                /* translators: %d: maximum number of tools in a shared set. */
                __('The set has too many tools to share. Use %d tools or fewer.', 'editrail'),
                $limits['slots']
            )
        );
    }

    $meta = new stdClass();
    if (isset($data->meta) && $data->meta instanceof stdClass) {
        foreach (get_object_vars($data->meta) as $slot => $entry) {
            $slot = (string) $slot;
            if (!isset($seen[$slot])) {
                continue;
            }
            $clean = toolrail_shared_set_normalize_entry($entry);
            if (null !== $clean) {
                $meta->$slot = $clean;
            }
        }
    }

    // The set file's own field order (exportConfig in assets/editor-rail.js).
    $set = (object) [
        'format'  => 'toolrail-set',
        'version' => 1,
        'name'    => $name,
        'blocks'  => $blocks,
    ];
    if (count(get_object_vars($meta))) {
        $set->meta = $meta;
    }
    $json = wp_json_encode($set, TOOLRAIL_SHARED_SET_JSON_FLAGS);
    if (false === $json) {
        return toolrail_shared_set_refuse('toolrail_set_invalid', __('The set is not valid. A set must be JSON with a "blocks" array.', 'editrail'));
    }
    if (strlen($json) > $limits['json_bytes']) {
        return toolrail_shared_set_refuse('toolrail_set_too_large', __('The set is too large to share.', 'editrail'));
    }
    return [
        'ok'   => true,
        'name' => $name,
        'json' => $json,
    ];
}

/**
 * The post_content form of a normalized set: base64, so no content filter
 * changes it (see the file docblock). Pure.
 *
 * @param string $json Canonical JSON from toolrail_shared_set_normalize().
 * @return string
 */
function toolrail_shared_set_pack($json) {
    return base64_encode((string) $json);
}

/**
 * Read a stored set back: decode, then validate and normalize again.
 * Pure.
 *
 * @param mixed $content A post_content value.
 * @return array|null The toolrail_shared_set_normalize() success result,
 *                    or null when the row is not a valid set.
 */
function toolrail_shared_set_unpack($content) {
    if (!is_string($content) || '' === $content) {
        return null;
    }
    $json = base64_decode($content, true);
    if (false === $json) {
        return null;
    }
    $result = toolrail_shared_set_normalize($json);
    return $result['ok'] ? $result : null;
}

/**
 * The post_name of one author's shared copy of one set: a hash, so that it
 * is unique without core's numbered-suffix loop (one query per taken
 * suffix) and says nothing about the set. It is a name for the row, not
 * the way a row is found: toolrail_shared_set_find_own() matches the
 * stored set name, because a row can carry a different slug. Pure.
 *
 * @param int    $user_id The author.
 * @param string $name    The normalized set name.
 * @return string
 */
function toolrail_shared_set_slug($user_id, $name) {
    return 'set-' . md5((int) $user_id . "\n" . $name);
}

// --- Writes only through the routes ----------------------------------------

/**
 * Whether the shared-set routes are writing a post now. While false, every
 * insert or update of the type is refused (toolrail_shared_set_guard_insert).
 *
 * @param bool|null $set True or false to change the state; null to read it.
 * @return bool The state.
 */
function toolrail_shared_set_writing($set = null) {
    static $writing = false;
    if (null !== $set) {
        $writing = (bool) $set;
    }
    return $writing;
}

/**
 * Refuse an insert or update of a shared set that does not come from the
 * routes below: XML-RPC (wp.newPost / wp.editPost let an Author write their
 * own posts of any type), a CLI, an importer. Those would skip the
 * validation and the per-author cap. `wp_insert_post_empty_content` is the
 * one filter that can stop wp_insert_post(); it reports the refusal as
 * empty content.
 *
 * wp_insert_post() fills in post_type before the filter runs, and
 * wp_update_post() merges the stored post first, so the type is always in
 * $postarr here.
 *
 * @param bool  $maybe_empty Whether core already found the post empty.
 * @param array $postarr     The post data, slashed.
 * @return bool True to refuse the write.
 */
function toolrail_shared_set_guard_insert($maybe_empty, $postarr) {
    $type = is_array($postarr) && isset($postarr['post_type']) ? $postarr['post_type'] : '';
    if (TOOLRAIL_SHARED_SET_TYPE === $type && !toolrail_shared_set_writing()) {
        return true;
    }
    return $maybe_empty;
}
add_filter('wp_insert_post_empty_content', 'toolrail_shared_set_guard_insert', 10, 2);

// --- REST routes -------------------------------------------------------------

/**
 * Register the routes: GET and POST on /editrail/v1/sets, GET and DELETE on
 * /editrail/v1/sets/<id>. There is no route that changes a set by ID: a
 * share of the same name by the same author updates that author's own copy,
 * and nothing else can change it.
 *
 * @return void
 */
function toolrail_register_shared_set_routes() {
    register_rest_route(
        TOOLRAIL_SHARED_SET_REST_NAMESPACE,
        '/' . TOOLRAIL_SHARED_SET_REST_BASE,
        [
            [
                'methods'             => 'GET',
                'callback'            => 'toolrail_rest_list_shared_sets',
                'permission_callback' => 'toolrail_rest_can_read_shared_sets',
            ],
            [
                'methods'             => 'POST',
                'callback'            => 'toolrail_rest_share_set',
                'permission_callback' => 'toolrail_rest_can_share_set',
                'args'                => [
                    'set' => [
                        'type'     => 'string',
                        'required' => true,
                    ],
                ],
            ],
        ]
    );
    register_rest_route(
        TOOLRAIL_SHARED_SET_REST_NAMESPACE,
        '/' . TOOLRAIL_SHARED_SET_REST_BASE . '/(?P<id>[\d]+)',
        [
            [
                'methods'             => 'GET',
                'callback'            => 'toolrail_rest_get_shared_set',
                'permission_callback' => 'toolrail_rest_can_read_shared_sets',
            ],
            [
                'methods'             => 'DELETE',
                'callback'            => 'toolrail_rest_delete_shared_set',
                'permission_callback' => 'toolrail_rest_can_delete_shared_set',
            ],
        ]
    );
}
add_action('rest_api_init', 'toolrail_register_shared_set_routes');

/**
 * The type object, or null when it is not registered (it always is while
 * the plugin is active; the check keeps a broken state from fataling).
 *
 * @return WP_Post_Type|null
 */
function toolrail_shared_set_type_object() {
    $type = get_post_type_object(TOOLRAIL_SHARED_SET_TYPE);
    return $type ? $type : null;
}

/**
 * A REST refusal with core's status convention: 401 for a visitor who is
 * not logged in, 403 for a logged-in user.
 *
 * @param string $message Text for the user.
 * @return WP_Error
 */
function toolrail_rest_refusal($message) {
    return new WP_Error('rest_forbidden', $message, ['status' => rest_authorization_required_code()]);
}

/**
 * Read permission: a logged-in user with the type's `read` capability
 * (edit_posts). A visitor or a Subscriber is refused before any query runs,
 * so an ID that does not exist and one that does answer the same.
 *
 * @return true|WP_Error
 */
function toolrail_rest_can_read_shared_sets() {
    $type = toolrail_shared_set_type_object();
    if (!$type || !is_user_logged_in() || !current_user_can($type->cap->read)) {
        return toolrail_rest_refusal(__('Sorry, you are not allowed to see shared sets.', 'editrail'));
    }
    return true;
}

/**
 * Share permission: the type's `create_posts` (publish_posts).
 *
 * @return true|WP_Error
 */
function toolrail_rest_can_share_set() {
    $type = toolrail_shared_set_type_object();
    if (!$type || !is_user_logged_in() || !current_user_can($type->cap->create_posts)) {
        return toolrail_rest_refusal(__('Sorry, you are not allowed to share sets.', 'editrail'));
    }
    return true;
}

/**
 * One published shared set by ID, or null.
 *
 * @param int $id Post ID.
 * @return WP_Post|null
 */
function toolrail_shared_set_post($id) {
    $post = get_post((int) $id);
    if (!$post || TOOLRAIL_SHARED_SET_TYPE !== $post->post_type || 'publish' !== $post->post_status) {
        return null;
    }
    return $post;
}

/**
 * Delete permission: read permission first (a visitor learns nothing about
 * IDs), then the set must exist, then core's delete_post map decides: the
 * author for their own set, a user with delete_others_posts for anyone's.
 *
 * @param WP_REST_Request $request The request.
 * @return true|WP_Error
 */
function toolrail_rest_can_delete_shared_set($request) {
    $can_read = toolrail_rest_can_read_shared_sets();
    if (true !== $can_read) {
        return $can_read;
    }
    $post = toolrail_shared_set_post($request['id']);
    if (!$post) {
        return new WP_Error('rest_post_invalid_id', __('The shared set does not exist.', 'editrail'), ['status' => 404]);
    }
    if (!current_user_can('delete_post', $post->ID)) {
        return toolrail_rest_refusal(__('Sorry, you are not allowed to stop sharing this set.', 'editrail'));
    }
    return true;
}

/**
 * One set as the routes return it. `set` is the canonical set-file JSON as
 * text, so the browser parses exactly what was stored; `author` is the
 * sharer's display name and nothing else about them.
 *
 * @param WP_Post $post A shared-set post.
 * @return array|null Null when the row is not a valid set.
 */
function toolrail_shared_set_response($post) {
    $set = toolrail_shared_set_unpack($post->post_content);
    if (null === $set) {
        return null;
    }
    $author_id = (int) $post->post_author;
    $author    = $author_id ? get_the_author_meta('display_name', $author_id) : '';
    return [
        'id'         => (int) $post->ID,
        'set'        => $set['json'],
        // Core stores a display name with its special characters as HTML
        // entities (the pre_user_display_name filters end in
        // _wp_specialchars), and the rail shows this value as TEXT, never as
        // markup: without the decode, "Ann & Bob" read "Ann &amp; Bob" in
        // every label and accessible name (review 2026-11-14).
        'author'     => is_string($author) ? wp_specialchars_decode($author, ENT_QUOTES) : '',
        'mine'       => get_current_user_id() === $author_id,
        'can_delete' => current_user_can('delete_post', $post->ID),
    ];
}

/**
 * GET /editrail/v1/sets: the valid shared sets on this site (the newest
 * `list` of them), oldest first,
 * and whether the current user can share.
 *
 * @return WP_REST_Response
 */
function toolrail_rest_list_shared_sets() {
    $limits = toolrail_shared_set_limits();
    $type   = toolrail_shared_set_type_object();
    $posts  = get_posts([
        'post_type'              => TOOLRAIL_SHARED_SET_TYPE,
        'post_status'            => 'publish',
        'posts_per_page'         => $limits['list'],
        'orderby'                => 'ID',
        // The NEWEST `list` sets, so that past the cap a new share still
        // shows and the oldest drop out (PR #123 review). They are put
        // back in oldest-first order below, which is the order the rail
        // lists them in.
        'order'                  => 'DESC',
        'no_found_rows'          => true,
        'update_post_meta_cache' => false,
        'update_post_term_cache' => false,
    ]);
    $sets = [];
    foreach (array_reverse($posts) as $post) {
        $item = toolrail_shared_set_response($post);
        if (null !== $item) {
            $sets[] = $item;
        }
    }
    return rest_ensure_response([
        'can_share' => $type ? current_user_can($type->cap->create_posts) : false,
        'sets'      => $sets,
    ]);
}

/**
 * GET /editrail/v1/sets/<id>: one shared set.
 *
 * @param WP_REST_Request $request The request.
 * @return WP_REST_Response|WP_Error
 */
function toolrail_rest_get_shared_set($request) {
    $post = toolrail_shared_set_post($request['id']);
    $item = $post && current_user_can('read_post', $post->ID) ? toolrail_shared_set_response($post) : null;
    if (null === $item) {
        return new WP_Error('rest_post_invalid_id', __('The shared set does not exist.', 'editrail'), ['status' => 404]);
    }
    return rest_ensure_response($item);
}

/**
 * The current user's published copy of one set name, or null: the oldest
 * of toolrail_shared_set_own_copies().
 *
 * @param int    $user_id The author.
 * @param string $name    The normalized set name.
 * @return WP_Post|null
 */
function toolrail_shared_set_find_own($user_id, $name) {
    $copies = toolrail_shared_set_own_copies($user_id, $name);
    return $copies ? $copies[0] : null;
}

/**
 * Every published copy of one set name by one author, oldest first. There
 * is normally one. Two parallel first shares can make two, and the share
 * route then keeps the oldest and deletes the rest.
 *
 * @param int    $user_id The author.
 * @param string $name    The normalized set name.
 * @return WP_Post[]
 */
function toolrail_shared_set_own_copies($user_id, $name) {
    // Every published set of the author, oldest first, matched by the
    // STORED name and not by the slug. The slug can differ from this
    // author's hash in two cases, and a search by slug then missed the row,
    // so a share of the same name made a second copy that no later share
    // could reach (PR #123 review): two parallel first shares (core gives
    // the second a "-2" suffix), and a set that core moved to this author
    // when its first author was deleted with "attribute all content to".
    // The list is small: the per-author cap, plus such strays.
    $limits = toolrail_shared_set_limits();
    $posts  = get_posts([
        'post_type'              => TOOLRAIL_SHARED_SET_TYPE,
        'post_status'            => 'publish',
        'author'                 => (int) $user_id,
        'posts_per_page'         => $limits['per_author'] + 25,
        'orderby'                => 'ID',
        'order'                  => 'ASC',
        'no_found_rows'          => true,
        'update_post_meta_cache' => false,
        'update_post_term_cache' => false,
    ]);
    $copies = [];
    foreach ($posts as $post) {
        $set = toolrail_shared_set_unpack($post->post_content);
        if (null !== $set && $set['name'] === $name) {
            $copies[] = $post;
        }
    }
    return $copies;
}

/**
 * How many shared sets a user has on this site, up to $limit + 1.
 *
 * @param int $user_id The author.
 * @param int $limit   The cap.
 * @return int
 */
function toolrail_shared_set_count_own($user_id, $limit) {
    return count(get_posts([
        'post_type'              => TOOLRAIL_SHARED_SET_TYPE,
        'post_status'            => 'publish',
        'author'                 => (int) $user_id,
        'fields'                 => 'ids',
        'posts_per_page'         => $limit + 1,
        'no_found_rows'          => true,
        'update_post_meta_cache' => false,
        'update_post_term_cache' => false,
    ]));
}

/**
 * POST /editrail/v1/sets: share a set, as `set`, the JSON text of a set
 * file. A first share creates the author's copy (201); a share of a name
 * the author already shares replaces that copy in place (200), so other
 * users see the new version under the same ID.
 *
 * @param WP_REST_Request $request The request.
 * @return WP_REST_Response|WP_Error
 */
function toolrail_rest_share_set($request) {
    $result = toolrail_shared_set_normalize($request['set']);
    if (!$result['ok']) {
        return new WP_Error($result['code'], $result['message'], ['status' => 400]);
    }
    $user_id  = get_current_user_id();
    $existing = toolrail_shared_set_find_own($user_id, $result['name']);
    if ($existing && !current_user_can('edit_post', $existing->ID)) {
        return toolrail_rest_refusal(__('Sorry, you are not allowed to share this set again.', 'editrail'));
    }
    if (!$existing) {
        $limits = toolrail_shared_set_limits();
        if (toolrail_shared_set_count_own($user_id, $limits['per_author']) >= $limits['per_author']) {
            return new WP_Error(
                'toolrail_set_limit',
                sprintf(
                    /* translators: %d: maximum number of shared sets for one user. */
                    __('You share the maximum of %d sets. Stop sharing a set first.', 'editrail'),
                    $limits['per_author']
                ),
                ['status' => 400]
            );
        }
    }

    $postarr = [
        'post_type'      => TOOLRAIL_SHARED_SET_TYPE,
        'post_status'    => 'publish',
        'post_author'    => $user_id,
        'post_title'     => sanitize_text_field($result['name']),
        'post_name'      => toolrail_shared_set_slug($user_id, $result['name']),
        'post_content'   => toolrail_shared_set_pack($result['json']),
        'comment_status' => 'closed',
        'ping_status'    => 'closed',
    ];
    if ($existing) {
        $postarr['ID'] = $existing->ID;
    }
    toolrail_shared_set_writing(true);
    try {
        // wp_insert_post() unslashes its input.
        $id = $existing
            ? wp_update_post(wp_slash($postarr), true)
            : wp_insert_post(wp_slash($postarr), true);
    } finally {
        toolrail_shared_set_writing(false);
    }
    if (is_wp_error($id)) {
        return new WP_Error('toolrail_set_not_saved', __('The set could not be shared. Try again.', 'editrail'), ['status' => 500]);
    }
    $post = toolrail_shared_set_post($id);
    $item = $post ? toolrail_shared_set_response($post) : null;
    if (null === $item) {
        return new WP_Error('toolrail_set_not_saved', __('The set could not be shared. Try again.', 'editrail'), ['status' => 500]);
    }
    // Two parallel first shares of one name can leave two copies. Keep the
    // one just written and delete the others, so other users never see two
    // sets with one name and one of them stale (PR #123 review).
    foreach (toolrail_shared_set_own_copies($user_id, $result['name']) as $copy) {
        if ((int) $copy->ID !== (int) $id && current_user_can('delete_post', $copy->ID)) {
            wp_delete_post($copy->ID, true);
        }
    }
    $response = rest_ensure_response($item);
    $response->set_status($existing ? 200 : 201);
    return $response;
}

/**
 * DELETE /editrail/v1/sets/<id>: stop sharing a set. The post is deleted,
 * not trashed: the type has no admin screen that could restore it, and
 * wp_delete_post() with $force_delete also removes its meta.
 *
 * @param WP_REST_Request $request The request.
 * @return WP_REST_Response|WP_Error
 */
function toolrail_rest_delete_shared_set($request) {
    $id = (int) $request['id'];
    if (!wp_delete_post($id, true)) {
        return new WP_Error('toolrail_set_not_deleted', __('The set could not be removed. Try again.', 'editrail'), ['status' => 500]);
    }
    return rest_ensure_response([
        'deleted' => true,
        'id'      => $id,
    ]);
}
