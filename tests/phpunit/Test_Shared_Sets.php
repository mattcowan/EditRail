<?php
/**
 * Pins the shared-set contract (#98) at its pure helpers: what the post
 * type lets each role do, how private the type is, and what the server
 * accepts as a set. The validator is the same grammar the rail's
 * importConfigPayload() applies to a set file, plus the caps; its output is
 * re-encoded from clean values and must come back byte-identical for a set
 * the rail wrote, quotes, backslashes, markup characters, emoji and
 * non-Latin text included, because a shared set must export to the same
 * file as the author's own.
 *
 * The REST routes and the capability checks themselves need WordPress; the
 * e2e spec tests/e2e/shared-sets.spec.js proves those against a real site.
 */
class Test_Shared_Sets extends WP_UnitTestCase {

    /** A set exactly as the rail sends it: JSON.stringify of a set file. */
    private function set_json(array $overrides = []) {
        $set = array_merge([
            'format'  => 'toolrail-set',
            'version' => 1,
            'name'    => 'Product page',
            'blocks'  => ['core/paragraph', 'core/heading', 'pattern:user:42'],
        ], $overrides);
        return json_encode($set, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    private function ok($raw) {
        $result = toolrail_shared_set_normalize($raw);
        $this->assertTrue($result['ok'], isset($result['message']) ? $result['message'] : 'normalize refused');
        return $result;
    }

    private function refused($raw, $code) {
        $result = toolrail_shared_set_normalize($raw);
        $this->assertFalse($result['ok']);
        $this->assertSame($code, $result['code']);
        $this->assertIsString($result['message']);
        $this->assertNotSame('', $result['message']);
    }

    // --- capabilities and privacy -------------------------------------

    public function test_capabilities_map_reading_sharing_and_editing() {
        $caps = toolrail_shared_set_capabilities();
        // Reading a published set needs edit_posts (Contributor and up), as
        // core's wp_block does; core's default `read` is every Subscriber.
        $this->assertSame('edit_posts', $caps['read']);
        // A share is a published post: a Contributor cannot share.
        $this->assertSame('publish_posts', $caps['create_posts']);
        // Nobody edits another user's set; deleting one stays on core's
        // delete_others_posts (not overridden here).
        $this->assertSame('do_not_allow', $caps['edit_others_posts']);
        $this->assertArrayNotHasKey('delete_others_posts', $caps);
        $this->assertArrayNotHasKey('delete_published_posts', $caps);
    }

    public function test_post_type_is_private_on_every_axis() {
        $args = toolrail_shared_set_post_type_args();
        foreach (['public', 'publicly_queryable', 'show_ui', 'show_in_menu', 'show_in_nav_menus', 'show_in_admin_bar', 'show_in_rest', 'has_archive', 'rewrite', 'query_var', 'can_export', 'hierarchical'] as $key) {
            $this->assertFalse($args[$key], $key);
        }
        $this->assertTrue($args['exclude_from_search']);
        $this->assertTrue($args['map_meta_cap']);
        $this->assertTrue($args['delete_with_user']);
        $this->assertSame('post', $args['capability_type']);
        $this->assertSame(toolrail_shared_set_capabilities(), $args['capabilities']);
        // No editor, no revisions, no custom fields: nothing but the copy.
        $this->assertSame(['title', 'author'], $args['supports']);
        $this->assertSame('editrail_set', TOOLRAIL_SHARED_SET_TYPE);
    }

    // --- the guard ------------------------------------------------------

    public function test_guard_refuses_writes_of_the_type_outside_the_routes() {
        $this->assertFalse(toolrail_shared_set_writing());
        $this->assertTrue(toolrail_shared_set_guard_insert(false, ['post_type' => 'editrail_set']));
        // Other types keep core's own answer.
        $this->assertFalse(toolrail_shared_set_guard_insert(false, ['post_type' => 'post']));
        $this->assertTrue(toolrail_shared_set_guard_insert(true, ['post_type' => 'post']));

        toolrail_shared_set_writing(true);
        try {
            $this->assertFalse(toolrail_shared_set_guard_insert(false, ['post_type' => 'editrail_set']));
        } finally {
            toolrail_shared_set_writing(false);
        }
        $this->assertTrue(toolrail_shared_set_guard_insert(false, ['post_type' => 'editrail_set']));
    }

    // --- the grammar ----------------------------------------------------

    public function test_a_set_the_rail_wrote_comes_back_byte_identical() {
        $raw = $this->set_json([
            // Quotes, a backslash before a zero (kses deletes that run),
            // markup, an ampersand, emoji and non-Latin text.
            'name'   => "Kit \"A\" \\0 <img src=x onerror=alert(1)> & 😀 日本語 Ελληνικά",
            'blocks' => ['core/paragraph', 'pattern:theme/hero', 'pattern:user:7'],
            'meta'   => [
                'core/paragraph' => [
                    'title'       => 'Intro </script> & "q"',
                    'description' => 'Back\\slash ✓',
                    'icon'        => '👍🏽',
                    'ext'         => ['presets' => (object) [], 'list' => [], 'n' => 1.5, 'deep' => ['a' => ['b' => null]]],
                ],
                'pattern:user:7' => ['icon' => 'dashicons-star-filled'],
            ],
        ]);

        $result = $this->ok($raw);

        $this->assertSame($raw, $result['json']);
        $this->assertSame("Kit \"A\" \\0 <img src=x onerror=alert(1)> & 😀 日本語 Ελληνικά", $result['name']);
        // An empty object stays an object, not an array.
        $this->assertStringContainsString('"presets":{}', $result['json']);
        $this->assertStringContainsString('"list":[]', $result['json']);
    }

    public function test_entries_are_dropped_and_collapsed_like_a_set_file_import() {
        $raw = json_encode([
            'format' => 'toolrail-set',
            'name'   => 'dupes',
            'blocks' => ['core/quote', 'core/quote', 'not a block name', 7, null, 'Core/Quote', "core/quote\n", 'pattern:user:12', 'pattern:user:x', 'pattern:Theme/Hero'],
            'extra'  => 'dropped',
        ]);

        $out = json_decode($this->ok($raw)['json'], true);

        $this->assertSame(['core/quote', 'pattern:user:12', 'pattern:Theme/Hero'], $out['blocks']);
        // Only the set file's own fields survive, in its own order.
        $this->assertSame(['format', 'version', 'name', 'blocks'], array_keys($out));
    }

    public function test_labels_are_kept_only_for_the_sets_own_slots_and_cleaned() {
        $long = str_repeat('é', 90);
        $raw  = json_encode([
            'name'   => 'labels',
            'blocks' => ['core/paragraph', 'core/heading'],
            'meta'   => [
                'core/paragraph' => [
                    'title'       => "  a\n\tb\u{00A0}\u{3000}c  ",
                    'description' => $long,
                    'icon'        => 'abcd',
                    'colour'      => 'dropped',
                    'ext'         => [
                        'Bad-Name' => ['x' => 1],
                        'ok'       => ['x' => 1],
                        'none'     => null,
                        'big'      => str_repeat('x', 2100),
                    ],
                ],
                'core/heading'   => ['title' => '   ', 'icon' => ''],
                'core/image'     => ['title' => 'not in the set'],
            ],
        ]);

        $out = json_decode($this->ok($raw)['json'], true);

        $this->assertSame(['core/paragraph'], array_keys($out['meta']));
        $entry = $out['meta']['core/paragraph'];
        $this->assertSame(['title', 'description', 'ext'], array_keys($entry));
        $this->assertSame('a b c', $entry['title']);
        $this->assertSame($long, $entry['description']);
        $this->assertSame(['ok' => ['x' => 1]], $entry['ext']);

        $over = json_decode($this->ok(json_encode([
            'name'   => 'cut',
            'blocks' => ['core/paragraph'],
            'meta'   => ['core/paragraph' => ['title' => str_repeat('ж', 81), 'description' => str_repeat('😀', 241)]],
        ]))['json'], true);
        // Cut at 80 and 240 code points, as the rail cuts.
        $this->assertSame(str_repeat('ж', 80), $over['meta']['core/paragraph']['title']);
        $this->assertSame(str_repeat('😀', 240), $over['meta']['core/paragraph']['description']);
    }

    public function test_icon_rules() {
        $icon = function ($value) {
            $out = json_decode(toolrail_shared_set_normalize(json_encode([
                'name'   => 'i',
                'blocks' => ['core/paragraph'],
                'meta'   => ['core/paragraph' => ['icon' => $value]],
            ]))['json'], true);
            return isset($out['meta']['core/paragraph']['icon']) ? $out['meta']['core/paragraph']['icon'] : null;
        };
        $this->assertSame('Aa', $icon(' Aa '));
        $this->assertSame('¶', $icon('¶'));
        // One grapheme cluster of two code points.
        $this->assertSame('👍🏽', $icon('👍🏽'));
        $this->assertSame('dashicons-star-filled', $icon('dashicons-star-filled'));
        $this->assertNull($icon('abcd'));
        $this->assertNull($icon('dashicons-<b>'));
        $this->assertNull($icon(7));
    }

    public function test_an_empty_set_is_a_set() {
        $out = json_decode($this->ok(json_encode(['name' => 'empty', 'blocks' => []]))['json'], true);
        $this->assertSame([], $out['blocks']);
        $this->assertArrayNotHasKey('meta', $out);
    }

    public function test_the_name_is_trimmed_like_javascript_and_never_changed_otherwise() {
        $this->assertSame('Kit', $this->ok(json_encode(['name' => "\u{00A0} Kit \u{FEFF}", 'blocks' => []]))['name']);
        $this->assertSame('a  b', $this->ok(json_encode(['name' => 'a  b', 'blocks' => []]))['name']);
    }

    public function test_refusals() {
        $this->refused(null, 'toolrail_set_missing');
        $this->refused('', 'toolrail_set_missing');
        $this->refused(['blocks' => []], 'toolrail_set_missing');
        $this->refused('not json', 'toolrail_set_invalid');
        $this->refused('[]', 'toolrail_set_invalid');
        $this->refused(json_encode(['name' => 'x']), 'toolrail_set_invalid');
        $this->refused(json_encode(['name' => 'x', 'blocks' => 'core/paragraph']), 'toolrail_set_invalid');
        $this->refused(json_encode(['name' => 'x', 'blocks' => ['a' => 'core/paragraph']]), 'toolrail_set_invalid');
        $this->refused(json_encode(['blocks' => []]), 'toolrail_set_name_missing');
        $this->refused(json_encode(['name' => " \u{3000} ", 'blocks' => []]), 'toolrail_set_name_missing');
        $this->refused(json_encode(['name' => 7, 'blocks' => []]), 'toolrail_set_name_missing');
        $this->refused(json_encode(['name' => "a\nb", 'blocks' => []]), 'toolrail_set_name_invalid');
        $this->refused(json_encode(['name' => "a\u{2028}b", 'blocks' => []]), 'toolrail_set_name_invalid');
        $this->refused(json_encode(['name' => "a\u{0085}b", 'blocks' => []]), 'toolrail_set_name_invalid');
        // A lone surrogate is not valid JSON text for PHP.
        $this->refused('{"name":"\ud800","blocks":[]}', 'toolrail_set_invalid');
    }

    public function test_name_length_counts_code_points() {
        $this->ok(json_encode(['name' => str_repeat('😀', 100), 'blocks' => []]));
        $this->refused(json_encode(['name' => str_repeat('😀', 101), 'blocks' => []]), 'toolrail_set_name_too_long');
    }

    public function test_size_caps() {
        $limits = toolrail_shared_set_limits();
        $slots  = [];
        for ($i = 0; $i < $limits['slots']; $i++) {
            $slots[] = 'core/b' . $i;
        }
        $this->ok(json_encode(['name' => 'max', 'blocks' => $slots]));
        $slots[] = 'core/one-more';
        $this->refused(json_encode(['name' => 'over', 'blocks' => $slots]), 'toolrail_set_too_many_slots');

        $this->refused(str_repeat(' ', $limits['request_bytes'] + 1), 'toolrail_set_too_large');

        // Under the request cap, over the stored cap: 200 slots of long
        // pattern names, each with a full label.
        $slots = [];
        $meta  = [];
        for ($i = 0; $i < 200; $i++) {
            $slot          = 'pattern:theme/' . str_repeat('p', 40) . $i;
            $slots[]       = $slot;
            $meta[ $slot ] = ['title' => str_repeat('t', 80), 'description' => str_repeat('d', 240)];
        }
        $raw = json_encode(['name' => 'huge', 'blocks' => $slots, 'meta' => $meta]);
        $this->assertLessThan($limits['request_bytes'], strlen($raw));
        $this->refused($raw, 'toolrail_set_too_large');
    }

    // --- storage ----------------------------------------------------------

    public function test_pack_and_unpack_round_trip_and_revalidate() {
        $json   = $this->ok($this->set_json(['name' => "a\\0b <b>&amp;"]))['json'];
        $packed = toolrail_shared_set_pack($json);

        $this->assertMatchesRegularExpression('/^[A-Za-z0-9+\/]+=*$/', $packed);
        $this->assertSame($json, toolrail_shared_set_unpack($packed)['json']);

        $this->assertNull(toolrail_shared_set_unpack(''));
        $this->assertNull(toolrail_shared_set_unpack(null));
        $this->assertNull(toolrail_shared_set_unpack('not base64 !'));
        // Valid base64 of something that is not a set.
        $this->assertNull(toolrail_shared_set_unpack(base64_encode('{"hello":"world"}')));
        // A row written past the routes is cleaned on the way out.
        $dirty = base64_encode(json_encode(['name' => 'x', 'blocks' => ['core/quote', 'bad name'], 'secret' => 'y']));
        $this->assertSame('{"format":"toolrail-set","version":1,"name":"x","blocks":["core/quote"]}', toolrail_shared_set_unpack($dirty)['json']);
    }

    public function test_slug_is_per_author_and_name_and_says_nothing() {
        $a = toolrail_shared_set_slug(2, 'Kit');
        $this->assertMatchesRegularExpression('/^set-[0-9a-f]{32}$/', $a);
        $this->assertSame($a, toolrail_shared_set_slug(2, 'Kit'));
        $this->assertNotSame($a, toolrail_shared_set_slug(3, 'Kit'));
        $this->assertNotSame($a, toolrail_shared_set_slug(2, 'Kit 2'));
    }

    // --- text helpers -------------------------------------------------------

    public function test_text_helpers_count_like_javascript() {
        $this->assertSame(1, toolrail_shared_set_length('😀'));
        $this->assertSame(2, toolrail_shared_set_utf16_length('😀'));
        $this->assertSame(3, toolrail_shared_set_utf16_length('a😀'));
        $this->assertSame('ab', toolrail_shared_set_cut('ab😀', 2));
        $this->assertSame('ab😀', toolrail_shared_set_cut('ab😀', 3));
        $this->assertSame('x', toolrail_shared_set_trim("\u{2000}\u{205F}x\u{1680}\t"));
        $this->assertTrue(toolrail_shared_set_is_slot('core/paragraph'));
        $this->assertTrue(toolrail_shared_set_is_slot('pattern:user:12'));
        $this->assertFalse(toolrail_shared_set_is_slot("core/paragraph\n"));
        $this->assertFalse(toolrail_shared_set_is_slot('Core/paragraph'));
        $this->assertFalse(toolrail_shared_set_is_slot(['core/paragraph']));
    }
}
