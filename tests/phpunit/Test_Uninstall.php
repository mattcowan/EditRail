<?php
/**
 * Pins the uninstall contract: deleting the plugin strips the `toolrail`
 * scope out of every user's persisted-preferences row, on every site of a
 * network, and touches nothing else in that row — core's own preferences
 * share it. A user without the scope is left alone (no `_modified` bump),
 * and the bump on a stripped row is the ISO stamp core's persistence layer
 * compares against its localStorage copy.
 */
class Test_Uninstall extends WP_UnitTestCase {

    private const NOW = '2026-09-04T15:00:00.000Z';

    protected function setUp(): void {
        parent::setUp();
        $this->reset_store();
    }

    protected function tearDown(): void {
        $this->reset_store();
        parent::tearDown();
    }

    private function reset_store() {
        $GLOBALS['toolrail_test_user_meta']       = [];
        $GLOBALS['toolrail_test_multisite']       = false;
        $GLOBALS['toolrail_test_site_ids']        = [1];
        $GLOBALS['toolrail_test_last_user_query'] = null;
    }

    /** A row shaped like the real one on mnc4: core scopes plus ours. */
    private function row_with_toolrail() {
        return [
            'core'           => ['editorMode' => 'visual', 'welcomeGuide' => false],
            'core/edit-post' => ['welcomeGuide' => false],
            'toolrail'       => [
                'toolrail-quick-slots' => '["core/paragraph","core/cover"]',
                'toolrail-position'    => 'right',
            ],
            '_modified'      => '2026-08-30T10:00:00.000Z',
        ];
    }

    // --- pure helper ---------------------------------------------------

    public function test_strip_returns_null_for_a_missing_row() {
        // get_user_meta's single-value miss is ''.
        $this->assertNull(toolrail_uninstall_strip_preferences('', self::NOW));
        $this->assertNull(toolrail_uninstall_strip_preferences(null, self::NOW));
        $this->assertNull(toolrail_uninstall_strip_preferences('garbage', self::NOW));
    }

    public function test_strip_returns_null_when_the_scope_is_absent() {
        $row = $this->row_with_toolrail();
        unset($row['toolrail']);
        $this->assertNull(toolrail_uninstall_strip_preferences($row, self::NOW));
    }

    public function test_strip_removes_only_the_toolrail_scope_and_bumps_modified() {
        $out = toolrail_uninstall_strip_preferences($this->row_with_toolrail(), self::NOW);

        $this->assertIsArray($out);
        $this->assertArrayNotHasKey('toolrail', $out);
        $this->assertSame(self::NOW, $out['_modified']);
        $this->assertSame(['editorMode' => 'visual', 'welcomeGuide' => false], $out['core']);
        $this->assertSame(['welcomeGuide' => false], $out['core/edit-post']);
        $this->assertSame(['core', 'core/edit-post', '_modified'], array_keys($out));
    }

    public function test_strip_adds_modified_when_the_row_had_none() {
        $row = $this->row_with_toolrail();
        unset($row['_modified']);
        $out = toolrail_uninstall_strip_preferences($row, self::NOW);
        $this->assertSame(self::NOW, $out['_modified']);
    }

    // --- per-site scrub ------------------------------------------------

    public function test_scrub_rewrites_only_users_who_have_the_scope() {
        $clean = $this->row_with_toolrail();
        unset($clean['toolrail']);
        $GLOBALS['toolrail_test_user_meta'] = [
            1 => ['wp_persisted_preferences' => $this->row_with_toolrail()],
            2 => ['wp_persisted_preferences' => $clean],
            3 => ['wp_persisted_preferences' => 'not-an-array'],
            4 => ['some_other_meta' => 'x'],
        ];

        $count = toolrail_uninstall_scrub_site('wp_persisted_preferences', self::NOW);

        $this->assertSame(1, $count);
        $store = $GLOBALS['toolrail_test_user_meta'];
        $this->assertArrayNotHasKey('toolrail', $store[1]['wp_persisted_preferences']);
        $this->assertSame(self::NOW, $store[1]['wp_persisted_preferences']['_modified']);
        // Untouched rows keep their old stamp and value exactly.
        $this->assertSame($clean, $store[2]['wp_persisted_preferences']);
        $this->assertSame('not-an-array', $store[3]['wp_persisted_preferences']);
        $this->assertSame(['some_other_meta' => 'x'], $store[4]);
    }

    public function test_scrub_queries_by_meta_key_across_the_whole_network() {
        // blog_id 0 lifts WP_User_Query's "members of the current site"
        // clause; without it a user removed from a network site keeps the
        // row that site's key wrote.
        toolrail_uninstall_scrub_site('wp_7_persisted_preferences', self::NOW);

        $query = $GLOBALS['toolrail_test_last_user_query'];
        $this->assertSame('ids', $query['fields']);
        $this->assertSame('wp_7_persisted_preferences', $query['meta_key']);
        $this->assertSame(0, $query['blog_id']);
    }

    // --- the runner ----------------------------------------------------

    public function test_uninstall_single_site_uses_the_blog_prefixed_key() {
        $GLOBALS['toolrail_test_user_meta'] = [
            1 => ['wp_persisted_preferences' => $this->row_with_toolrail()],
        ];

        $total = toolrail_uninstall();

        $this->assertSame(1, $total);
        $row = $GLOBALS['toolrail_test_user_meta'][1]['wp_persisted_preferences'];
        $this->assertArrayNotHasKey('toolrail', $row);
        // The stamp is the shape core writes from JS (toISOString), so the
        // persistence layer's Date.parse() comparison sees a real date.
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $row['_modified']);
        $this->assertGreaterThan('2026-08-30T10:00:00.000Z', $row['_modified']);
    }

    public function test_uninstall_multisite_visits_every_site_key() {
        $GLOBALS['toolrail_test_multisite'] = true;
        $GLOBALS['toolrail_test_site_ids']  = [1, 2];
        $GLOBALS['toolrail_test_user_meta'] = [
            1 => [
                'wp_persisted_preferences'   => $this->row_with_toolrail(),
                'wp_2_persisted_preferences' => $this->row_with_toolrail(),
                // A site not in the network listing is not visited.
                'wp_3_persisted_preferences' => $this->row_with_toolrail(),
            ],
            2 => [
                'wp_2_persisted_preferences' => $this->row_with_toolrail(),
            ],
        ];

        $total = toolrail_uninstall();

        $this->assertSame(3, $total);
        $store = $GLOBALS['toolrail_test_user_meta'];
        $this->assertArrayNotHasKey('toolrail', $store[1]['wp_persisted_preferences']);
        $this->assertArrayNotHasKey('toolrail', $store[1]['wp_2_persisted_preferences']);
        $this->assertArrayHasKey('toolrail', $store[1]['wp_3_persisted_preferences']);
        $this->assertArrayNotHasKey('toolrail', $store[2]['wp_2_persisted_preferences']);
    }

    public function test_uninstall_with_nothing_to_do_returns_zero() {
        $this->assertSame(0, toolrail_uninstall());
    }

    public function test_root_uninstall_file_is_a_guarded_runner() {
        // WordPress defines WP_UNINSTALL_PLUGIN before including the root
        // file; nothing else may run it. The guard is the first statement,
        // and the file only delegates — the helpers live in includes/.
        $src = file_get_contents(TOOLRAIL_PLUGIN_DIR . 'uninstall.php');
        $this->assertStringContainsString("defined('WP_UNINSTALL_PLUGIN') || exit;", $src);
        $this->assertStringContainsString("require_once __DIR__ . '/includes/uninstall.php';", $src);
        $this->assertStringContainsString('toolrail_uninstall();', $src);
        $this->assertLessThan(
            strpos($src, 'require_once'),
            strpos($src, "defined('WP_UNINSTALL_PLUGIN')"),
            'the guard must come before the require'
        );
    }
}
