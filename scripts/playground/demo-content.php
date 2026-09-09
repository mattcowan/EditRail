<?php
/**
 * Playground demo content for EditRail.
 *
 * This file is the SOURCE of the blueprint's `runPHP` step. `node
 * scripts/playground.js build` embeds it, verbatim, into
 * .wordpress-org/blueprints/blueprint.json, so it is a real PHP file
 * that a linter can read, not a JSON string. The wp-load guard below
 * also lets `wp eval-file` run it on a development site that has both
 * plugins active — for a look at the demo post. It is written for a
 * FRESH site: it edits user 1's editor preferences (merging, see
 * toolrail_demo_seed_preferences) and refuses to run when post ID
 * TOOLRAIL_DEMO_POST_ID belongs to another post. Do not run it on a
 * site whose admin has a toolbar arrangement worth keeping.
 *
 * What it does, once, on a fresh Playground site:
 *   1. Seeds the admin's editor preferences so the editor opens clean:
 *      no welcome guide, the four default tools plus the Typography
 *      Stylist block pinned, and that pin carrying a custom name and
 *      description (the 1.0.1 pin-metadata feature) — so the toolbar
 *      itself says the tool was added by the demo.
 *   2. Registers EB Garamond in the WordPress Font Library (the
 *      companion mu-plugin adds it to theme.json) and ADOPTS it through
 *      Typography Stylist's own Font Library bridge, so the font has a
 *      real font_id and shows as the selected font in the block's
 *      picker, the way a font an author picked would.
 *   3. Publishes one demo post, with a fixed ID the blueprint's
 *      landingPage points at: Typography Stylist blocks for the
 *      headline, the tagline, every section heading and two pull
 *      quotes, all in EB Garamond by that font_id, then core blocks
 *      that explain the toolbar and give the Section overview
 *      something to outline. If the post cannot be created, the script
 *      FAILS (an uncaught exception), so the blueprint step fails
 *      instead of landing on "Invalid post ID".
 *
 * Every OpenType claim in the copy was checked against the fonts' GSUB
 * tables (scripts/playground/README.md). The italic's swash feature
 * (swsh) substitutes every capital A–Z, so the HEADLINE and the PULL
 * QUOTES are set in the italic with swashes on their capitals; the
 * first pull quote adds ss01, which sets the lowercase in petite
 * capitals, and the second adds the italic's discretionary ligatures
 * (ck, ch). The TAGLINE and the section headings are upright with the
 * standard ligatures only; the upright's discretionary ct and st
 * ligatures were tried on the tagline and read as a distraction.
 *
 * @package Toolrail
 */

if (!function_exists('add_action')) {
    require_once '/wordpress/wp-load.php';
}

// Fixed so the blueprint's landingPage can name it. Free on a fresh
// install (core seeds posts 1–3); if another post already owns it,
// toolrail_demo_create_post() throws, so the blueprint step fails
// instead of landing on a different ID.
define('TOOLRAIL_DEMO_POST_ID', 2026);

/**
 * Serialize block attributes the way Gutenberg's serializeAttributes()
 * does: JSON with `--`, `<`, `>`, `&` and `\"` escaped as \uXXXX, in
 * that order, so the comment delimiter can never appear inside the
 * payload and the editor parses the attributes it was given.
 *
 * @param array $attrs Block attributes.
 * @return string
 */
function toolrail_demo_attrs(array $attrs) {
    $json = wp_json_encode($attrs, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $json = str_replace('--', '\\u002d\\u002d', $json);
    $json = str_replace('<', '\\u003c', $json);
    $json = str_replace('>', '\\u003e', $json);
    $json = str_replace('&', '\\u0026', $json);
    $json = str_replace('\\"', '\\u0022', $json);
    return $json;
}

/**
 * A number the way JavaScript's String(Number) prints it. save.js builds
 * the responsive clamp() in a template literal, and block validation is
 * a byte comparison, so PHP must print the same digits. json_encode with
 * serialize_precision=-1 (the PHP default) uses the same shortest
 * round-trip algorithm; only the ".0" it adds to whole floats differs.
 *
 * @param float $value Number.
 * @return string
 */
function toolrail_demo_js_number($value) {
    $out = json_encode((float) $value);
    return '.0' === substr($out, -2) ? substr($out, 0, -2) : $out;
}

/**
 * One typost/block, serialized exactly as the block's save() renders it
 * (Typography Stylist 2.2.3), with the font given by its font_id: the
 * shape the block's own picker writes, so the editor shows the font as
 * selected and the plugin's --font-N variable carries the family.
 *
 * Style order is save.js buildStyle()'s: features, font-family,
 * font-weight, font-style, line-height, font-size, text-align. React
 * joins "prop:value" pairs with ";" and no trailing ";".
 *
 * @param string $content  Inner HTML of the visual heading.
 * @param string $tag      h1–h6 or p.
 * @param array  $features OpenType feature tags to turn on.
 * @param array  $args     fontId (required), fontFamily (the adopted
 *                         entry's font_family; default EB Garamond),
 *                         fontStyle ('italic'), fontWeight, lineHeight,
 *                         fontSizeMin/Preferred/Max, textAlign.
 * @return string Block markup.
 */
function toolrail_demo_typost($content, $tag, array $features, array $args) {
    $font_id = (int) $args['fontId'];
    $family  = isset($args['fontFamily']) ? $args['fontFamily'] : '"EB Garamond", serif';
    $style   = isset($args['fontStyle']) ? $args['fontStyle'] : '';
    $weight  = isset($args['fontWeight']) ? (string) $args['fontWeight'] : '400';
    $line    = isset($args['lineHeight']) ? (float) $args['lineHeight'] : 0;
    $min     = (int) $args['fontSizeMin'];
    $pref    = (int) $args['fontSizePreferred'];
    $max     = (int) $args['fontSizeMax'];
    $align   = isset($args['textAlign']) ? $args['textAlign'] : '';

    $css = array();
    if ($features) {
        // Inside a style ATTRIBUTE React writes the feature tag's quotes
        // as &quot; — a raw quote ends the attribute early, and the
        // editor's byte comparison then sees an empty style (verified in
        // Playground: "Expected attribute style … saw font-feature-settings:").
        $css[] = 'font-feature-settings:' . implode(', ', array_map(
            static function ($f) {
                return '&quot;' . $f . '&quot; 1';
            },
            $features
        ));
    }
    $css[] = 'font-family:var(--font-' . $font_id . ')';
    $css[] = 'font-weight:' . $weight;
    if ($style) {
        $css[] = 'font-style:' . $style;
    }
    if ($line) {
        $css[] = 'line-height:' . toolrail_demo_js_number($line);
    }
    $css[] = sprintf(
        'font-size:clamp(%dpx, %srem + %svw, %dpx)',
        $min,
        toolrail_demo_js_number($pref / 16),
        toolrail_demo_js_number((($max - $min) / (1920 - 320)) * 100),
        $max
    );
    if ($align) {
        $css[] = 'text-align:' . $align;
    }

    $attrs = array('content' => $content);
    if ('h2' !== $tag) {
        $attrs['tagName'] = $tag;
    }
    if ($features) {
        $attrs['features'] = array_values($features);
    }
    // Both the id and the family string, the way the picker writes them
    // when an author chooses a Library font. The released block's edit
    // view gates its font-family on the string (fixed in the plugin's
    // source since); save() prefers the id either way, so the saved
    // markup is identical apart from the data-font attribute.
    $attrs['fontId']     = $font_id;
    $attrs['fontFamily'] = $family;
    if ($style) {
        $attrs['fontStyle'] = $style;
    }
    $attrs['fontSize']          = 'responsive';
    $attrs['fontSizeMin']       = $min;
    $attrs['fontSizePreferred'] = $pref;
    $attrs['fontSizeMax']       = $max;
    if ('400' !== $weight) {
        $attrs['fontWeight'] = $weight;
    }
    if ($align) {
        $attrs['textAlign'] = $align;
    }
    if ($line) {
        $attrs['lineHeight'] = $line;
    }

    // save.js: <br> becomes a space, then every tag is stripped, for the
    // screen-reader twin that keeps the heading in the outline.
    $clean = preg_replace('/<br\b[^>]*>/i', ' ', $content);
    $clean = preg_replace('/<[^>]*>/', '', $clean);

    return '<!-- wp:typost/block ' . toolrail_demo_attrs($attrs) . ' -->' . "\n"
        . '<div class="wp-block-typost">'
        . '<' . $tag . ' class="visually-hidden">' . $clean . '</' . $tag . '>'
        . '<' . $tag . ' style="' . implode(';', $css) . '" class="typost-styled" aria-hidden="true" data-font="' . esc_attr($family) . '" data-font-id="' . $font_id . '">' . $content . '</' . $tag . '>'
        . '</div>' . "\n"
        . '<!-- /wp:typost/block -->';
}

/**
 * A core paragraph block.
 *
 * @param string $html Inner HTML.
 * @return string Block markup.
 */
function toolrail_demo_paragraph($html) {
    return "<!-- wp:paragraph -->\n<p>" . $html . "</p>\n<!-- /wp:paragraph -->";
}

/**
 * A core heading block; level 2 is the block default and gets no attribute.
 *
 * @param int    $level 1–6.
 * @param string $text  Inner HTML.
 * @return string Block markup.
 */
function toolrail_demo_heading($level, $text) {
    $tag = 'h' . (int) $level;
    $attrs = 2 === (int) $level ? '' : ' ' . toolrail_demo_attrs(array('level' => (int) $level));
    return '<!-- wp:heading' . $attrs . ' -->' . "\n"
        . '<' . $tag . ' class="wp-block-heading">' . $text . '</' . $tag . '>' . "\n"
        . '<!-- /wp:heading -->';
}

/**
 * A core list block with one list-item block per entry.
 *
 * @param string[] $items Inner HTML of each item.
 * @return string Block markup.
 */
function toolrail_demo_list(array $items) {
    $out = "<!-- wp:list -->\n<ul class=\"wp-block-list\">";
    foreach ($items as $item) {
        $out .= "<!-- wp:list-item -->\n<li>" . $item . "</li>\n<!-- /wp:list-item -->\n\n";
    }
    return rtrim($out) . "</ul>\n<!-- /wp:list -->";
}

/**
 * The demo post's blocks.
 *
 * Typography Stylist blocks carry the headline, the tagline, every
 * section heading and the two pull quotes, all in EB Garamond by the
 * adopted font_id; the headline and the quotes are the italic with its
 * swash capitals. The rest is core: paragraphs, a list, a group with a
 * heading and two paragraphs (so the Section overview has something to
 * outline and step into), a separator. Structure and copy owner-edited
 * 2026-09-09: the Section overview and the extension API come before
 * the pinning instructions, so the toolbar reads as more than a block
 * inserter; and wherever the copy describes what the toolbar inserts,
 * it says core blocks, theme and plugin blocks, and patterns, never
 * "core blocks" alone, because pinning custom blocks is the point.
 *
 * @return string Post content.
 */
function toolrail_demo_content() {
    $id = toolrail_demo_font_id();
    $blocks = array();

    // Section headings: upright, standard ligatures only.
    $heading = static function ($text) use ($id) {
        return toolrail_demo_typost($text, 'h2', array('liga'), array(
            'fontId'            => $id,
            'lineHeight'        => 1.3,
            'fontSizeMin'       => 20,
            'fontSizePreferred' => 28,
            'fontSizeMax'       => 40,
        ));
    };

    // Headline: the italic's swash capitals (swsh substitutes every
    // capital A–Z) draw the E and the R with their flourished forms.
    $blocks[] = toolrail_demo_typost('EditRail', 'h2', array('swsh'), array(
        'fontId'            => $id,
        'fontStyle'         => 'italic',
        'fontWeight'        => '500',
        'lineHeight'        => 1.05,
        'fontSizeMin'       => 48,
        'fontSizePreferred' => 80,
        'fontSizeMax'       => 120,
    ));

    // Tagline, upright, standard ligatures only: the upright's
    // discretionary ligatures (ct, st) were tried and read as a
    // distraction at this size (owner call, 2026-09-09).
    $blocks[] = toolrail_demo_typost(
        'A graphics-editor-style toolbar for rapid content creation.',
        'p',
        array('liga'),
        array(
            'fontId'            => $id,
            'lineHeight'        => 1.3,
            'fontSizeMin'       => 20,
            'fontSizePreferred' => 28,
            'fontSizeMax'       => 40,
        )
    );

    $blocks[] = toolrail_demo_paragraph(
        'EditRail puts a graphics-editor toolbar in the block editor. It docks to the left edge by default, and it can be dragged to any edge or floated as a palette. Every setting is per user, so each author keeps the arrangement that suits them.'
    );
    $blocks[] = toolrail_demo_paragraph(
        'The toolbar adds nothing of its own to a post. What it inserts is whatever you pinned: a core block, a block from your theme or from any plugin, or a pattern, saved exactly as the editor&#8217;s own inserter would save it. Deactivate the plugin and this post reads and edits exactly as before. The toolbar is a way of working, not a format.'
    );

    $blocks[] = $heading('More than a block inserter');
    $blocks[] = toolrail_demo_paragraph(
        'The tools at the top of the toolbar are pins: blocks and patterns you chose, from core, from your theme, or from any plugin. They work the way a drawing tool does: select one, then click or drag in the canvas where it should go. It lands at that point and the toolbar returns to Select. Hold Shift while you click to keep the tool armed. Below the pins sit tools that are not blocks at all: the Section overview, and any tool another plugin adds.'
    );

    $blocks[] = $heading('The Section overview');
    $blocks[] = toolrail_demo_paragraph(
        'The <strong>Section overview</strong> zooms the canvas out and outlines every top-level block, with a name tag in the corner: a way to find your place in a long document and to reorganize it. Drag an outline to move it, or click it for arrow buttons. <strong>Reorder inside</strong> steps into one section, such as the group below, and reorders its blocks the same way. Every move works by keyboard and is announced to screen readers.'
    );

    $blocks[] = '<!-- wp:group ' . toolrail_demo_attrs(array('layout' => array('type' => 'constrained'))) . ' -->' . "\n"
        . '<div class="wp-block-group">'
        . toolrail_demo_heading(3, 'A group to step into')
        . "\n\n"
        . toolrail_demo_paragraph('Open the Section overview, click this group&#8217;s outline, then choose Reorder inside. The heading and this paragraph get outlines of their own.')
        . "\n\n"
        . toolrail_demo_paragraph('Move them with the arrows, or drag them. Up one level takes you back out.')
        . '</div>' . "\n"
        . '<!-- /wp:group -->';

    $blocks[] = $heading('Pin your own tools');
    $blocks[] = toolrail_demo_paragraph(
        'Pin anything the editor can drag: core blocks, your theme&#8217;s blocks, blocks from any plugin, and patterns, your own or the theme&#8217;s. Drag it onto the toolbar from the editor&#8217;s own inserter (the <strong>+</strong> at the top left), from the List View, or from the canvas, or search for it in Toolbar settings. A block dragged from the canvas can also be saved as a pattern, with its settings and contents, and pinned as that.'
    );

    // Pull quote, italic: swash capitals on every capital, and ss01 sets
    // the lowercase in the italic's petite capitals, a title-page
    // pairing the two features were drawn for. Sits right under the
    // pinning paragraph it sums up (owner call, 2026-09-09).
    $blocks[] = '<!-- wp:quote -->' . "\n"
        . '<blockquote class="wp-block-quote">'
        . toolrail_demo_typost('Any Block Can Be Added To The Toolbar', 'p', array('swsh', 'ss01'), array(
            'fontId'            => $id,
            'fontStyle'         => 'italic',
            'lineHeight'        => 1.15,
            'fontSizeMin'       => 28,
            'fontSizePreferred' => 40,
            'fontSizeMax'       => 56,
        ))
        . '</blockquote>' . "\n"
        . '<!-- /wp:quote -->';
    $blocks[] = toolrail_demo_paragraph(
        'A pinned tool can carry your own name, description and icon. Open <strong>Toolbar settings</strong> from the gear at the end of the toolbar, find the tool under <strong>Pinned tools</strong>, and choose <strong>Edit</strong>. Empty fields use the block&#8217;s own. Only your toolbar changes.'
    );
    $blocks[] = toolrail_demo_paragraph(
        'The Typography Stylist block on this toolbar is pinned as <strong>Typography Stylist (added by this demo)</strong>. That name, and the description in its tooltip, are the demo&#8217;s, not the block&#8217;s. Click it, then click in the canvas, to add a block of your own. The headings and the pull quotes in this post are Typography Stylist blocks set in EB Garamond: the headline and the quotes use the italic&#8217;s swash capitals, the first quote sets its lowercase in petite capitals, and the second adds the italic&#8217;s discretionary ligatures.'
    );

    $blocks[] = $heading('Built to be extended');
    $blocks[] = toolrail_demo_paragraph(
        'Other plugins can put their own tools on the toolbar. One PHP filter declares a plugin as a provider, and a small JavaScript API registers each tool: its icon, its flyout, and what happens when it is armed, including tools that are modes rather than blocks, such as picking a block on the canvas. A plugin can also keep its own settings on a pinned tool; they travel with saved sets and go when the tool is unpinned. Whatever a tool inserts, from any plugin, is saved the way that block or pattern is always saved, so the post never depends on the toolbar.'
    );

    $blocks[] = $heading('Try it now');
    $blocks[] = toolrail_demo_list(array(
        'Click <strong>Text</strong> on the toolbar, then click below this list. A paragraph appears where you clicked.',
        'Drag a tool from the toolbar into the canvas. The editor&#8217;s own drop line shows where it will land.',
        'Open the editor&#8217;s block inserter (the <strong>+</strong> button at the top left), then drag any block or pattern from that list onto the toolbar. It is pinned as a new tool.',
        'Drag a block from the canvas onto the toolbar to pin its type, or to save it as a pattern and pin that.',
        'Open the <strong>Section overview</strong> and drag this list above the heading before it.',
        'Press Escape at any time to return to Select.',
    ));

    // Pull quote, italic: a swash on every capital of the title case, and
    // the italic's discretionary ligatures on ck (Pick) and ch (Reach).
    $blocks[] = '<!-- wp:quote -->' . "\n"
        . '<blockquote class="wp-block-quote">'
        . toolrail_demo_typost('Pick What You Reach For. Move The Toolbar Where Your Hand Wants It.', 'p', array('swsh', 'dlig'), array(
            'fontId'            => $id,
            'fontStyle'         => 'italic',
            'lineHeight'        => 1.2,
            'fontSizeMin'       => 26,
            'fontSizePreferred' => 36,
            'fontSizeMax'       => 52,
        ))
        . '<cite>What the toolbar is for</cite>'
        . '</blockquote>' . "\n"
        . '<!-- /wp:quote -->';

    $blocks[] = "<!-- wp:separator -->\n<hr class=\"wp-block-separator has-alpha-channel-opacity\"/>\n<!-- /wp:separator -->";

    $blocks[] = toolrail_demo_paragraph(
        'More in the Help panel: the <strong>?</strong> next to the gear explains inserting, pinning, moving the toolbar, the keyboard model, saved sets, and what a highlighted tool means. Nothing in this Playground is saved anywhere but this browser tab.'
    );

    return implode("\n\n", $blocks);
}

/**
 * Seed the admin's per-user editor preferences.
 *
 * Both plugins keep their state in core's `{prefix}persisted_preferences`
 * user meta: one PHP array of scopes. The rail's scope is `toolrail`,
 * every value a string (its readKey/writeKey contract). Both lift
 * stamps are set so the rail's one-time migrations never run against
 * this seeded list. `_modified` is bumped so a stale browser copy of
 * the array (Playground tabs are fresh, but the rule is the rule) loses
 * the comparison core's persistence layer makes.
 *
 * MERGES, never replaces: on a fresh site the result is the four
 * defaults plus the Typography Stylist pin; on a site with an existing
 * arrangement the pin is appended, its label added, and every other
 * key in the scope (dock, saved sets, colors, the sibling plugins'
 * `toolrail-ext:*` keys) is left as it was.
 *
 * The write is verified by reading the row back, not by update_user_meta()'s
 * return value: that is false both when the write fails AND when the stored
 * value is already identical, and this script may run twice on one site
 * (idempotent by design), where a same-second re-run stores the same array.
 *
 * @param int $user_id The admin.
 * @return void
 * @throws RuntimeException When the seeded scope does not read back.
 */
function toolrail_demo_seed_preferences($user_id) {
    global $wpdb;
    $meta_key = $wpdb->get_blog_prefix() . 'persisted_preferences';
    $prefs = get_user_meta($user_id, $meta_key, true);
    if (!is_array($prefs)) {
        $prefs = array();
    }
    // The editor's welcome guide, under the scope each editor build uses.
    $prefs['core']['welcomeGuide'] = false;
    $prefs['core/edit-post']['welcomeGuide'] = false;

    $scope = isset($prefs['toolrail']) && is_array($prefs['toolrail']) ? $prefs['toolrail'] : array();

    $slots = isset($scope['toolrail-quick-slots']) ? json_decode($scope['toolrail-quick-slots'], true) : null;
    if (!is_array($slots)) {
        $slots = array('core/group', 'core/paragraph', 'core/heading', 'core/image');
    }
    if (!in_array('typost/block', $slots, true)) {
        $slots[] = 'typost/block';
    }

    $meta = isset($scope['toolrail-pin-meta']) ? json_decode($scope['toolrail-pin-meta'], true) : null;
    if (!is_array($meta)) {
        $meta = array();
    }
    $meta['typost/block'] = array(
        'title'       => 'Typography Stylist (added by this demo)',
        'description' => 'This demo pinned the Typography Stylist block for you and gave it this name. Click it, then click in the canvas. Change or remove it under Pinned tools in Toolbar settings.',
    );

    $scope['toolrail-quick-slots']    = wp_json_encode(array_values($slots), JSON_UNESCAPED_SLASHES);
    $scope['toolrail-slots-migrated'] = '1';
    $scope['toolrail-group-seeded']   = '1';
    $scope['toolrail-pin-meta']       = wp_json_encode($meta, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

    $prefs['toolrail']  = $scope;
    $prefs['_modified'] = gmdate('Y-m-d\TH:i:s') . '.000Z';
    update_user_meta($user_id, $meta_key, $prefs);
    wp_cache_delete($user_id, 'user_meta');
    $stored = get_user_meta($user_id, $meta_key, true);
    if (!is_array($stored) || !isset($stored['toolrail']) || $stored['toolrail'] !== $scope) {
        throw new RuntimeException(sprintf(
            'EditRail demo: the toolbar preferences did not persist to %s for user %d.',
            $meta_key,
            $user_id
        ));
    }
}

/**
 * EB Garamond's Typography Stylist font_id, adopting the font on first use.
 *
 * The companion mu-plugin registers EB Garamond in theme.json, which is
 * where Typography Stylist's Font Library bridge reads Library fonts
 * from. Adopting it is what the block's picker does when an author
 * chooses a Library font: it allocates a numeric font_id, and the
 * plugin then emits `--font-N` for it (aliased to the WordPress preset
 * variable). Blocks saved by that id are byte-identical to picked ones,
 * so the editor shows EB Garamond as the selected font. The editor's
 * font list is cached per user for an hour; the cache is cleared so the
 * first editor load sees the adoption.
 *
 * @return int The font_id.
 * @throws RuntimeException When Typography Stylist or the font is missing.
 */
function toolrail_demo_font_id() {
    static $font_id = null;
    if (null !== $font_id) {
        return $font_id;
    }
    if (!class_exists('Typost')) {
        throw new RuntimeException('EditRail demo: Typography Stylist is not active; the demo post needs its block.');
    }
    $entry = Typost::get_instance()->font_library_bridge()->adopt_library_font('eb-garamond');
    if (!is_array($entry) || empty($entry['font_id'])) {
        throw new RuntimeException('EditRail demo: EB Garamond is not in the Font Library; the demo fonts mu-plugin did not register it.');
    }
    delete_transient('typost_editor_data_1');
    $font_id = (int) $entry['font_id'];
    return $font_id;
}

/**
 * Publish the demo post at the fixed ID, once.
 *
 * Runs with the admin as the current user and kses lifted: the
 * blueprint's runPHP has no user, and kses would otherwise strip the
 * Typography Stylist block's font-feature-settings (not on kses's safe
 * CSS list) and invalidate the block in the editor.
 *
 * Idempotent: the demo post already at that ID is left alone. Any other
 * outcome that leaves landingPage pointing at nothing — the ID taken by
 * another post, or wp_insert_post() refusing — THROWS, so the blueprint
 * step fails with the reason instead of the preview opening on
 * "Invalid post ID" (PR review 2026-09-04, finding 4).
 *
 * @param int $user_id The admin.
 * @return int The post ID.
 * @throws RuntimeException When the post cannot be created at TOOLRAIL_DEMO_POST_ID.
 */
function toolrail_demo_create_post($user_id) {
    $existing = get_post(TOOLRAIL_DEMO_POST_ID);
    if ($existing) {
        if ('editrail-demo' === $existing->post_name) {
            return (int) $existing->ID;
        }
        throw new RuntimeException(sprintf(
            'EditRail demo: post ID %d is already used by "%s"; the blueprint landing page needs it.',
            TOOLRAIL_DEMO_POST_ID,
            $existing->post_title
        ));
    }
    wp_set_current_user($user_id);
    kses_remove_filters();
    $id = wp_insert_post(wp_slash(array(
        'import_id'      => TOOLRAIL_DEMO_POST_ID,
        'post_type'      => 'post',
        'post_status'    => 'publish',
        'post_author'    => $user_id,
        'post_title'     => 'Try EditRail',
        'post_name'      => 'editrail-demo',
        'post_content'   => toolrail_demo_content(),
        'comment_status' => 'closed',
        'ping_status'    => 'closed',
    )), true);
    kses_init_filters();
    if (is_wp_error($id)) {
        throw new RuntimeException('EditRail demo: the demo post could not be created: ' . $id->get_error_message());
    }
    if ((int) $id !== TOOLRAIL_DEMO_POST_ID) {
        throw new RuntimeException(sprintf(
            'EditRail demo: the demo post landed at ID %d, not %d; the blueprint landing page would miss it.',
            $id,
            TOOLRAIL_DEMO_POST_ID
        ));
    }
    return (int) $id;
}

toolrail_demo_seed_preferences(1);
toolrail_demo_create_post(1);
