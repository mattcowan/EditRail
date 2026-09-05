<?php
/**
 * Pins the uninstall contract: deleting the plugin strips the `toolrail`
 * scope out of every user's persisted-preferences row, on every site of a
 * network, and touches nothing else in that row — core's own preferences
 * share it. A user without the scope is left alone (no `_modified` bump),
 * the bump on a stripped row is the ISO stamp core's persistence layer
 * compares against its localStorage copy, and every write is conditional
 * on the value that was read, so a concurrent editor write is never
 * overwritten with a stale copy.
 *
 * The fake usermeta store holds a LIST of row values per key, the way the
 * real table can (see bootstrap.php).
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
        $GLOBALS['toolrail_test_last_site_query'] = null;
        $GLOBALS['toolrail_test_before_update']   = null;
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

    private function rows($user_id, $key = 'wp_persisted_preferences') {
        return $GLOBALS['toolrail_test_user_meta'][$user_id][$key];
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
            1 => ['wp_persisted_preferences' => [$this->row_with_toolrail()]],
            2 => ['wp_persisted_preferences' => [$clean]],
            3 => ['wp_persisted_preferences' => ['not-an-array']],
            4 => ['some_other_meta' => ['x']],
        ];

        $count = toolrail_uninstall_scrub_site('wp_persisted_preferences', self::NOW);

        $this->assertSame(1, $count);
        $this->assertArrayNotHasKey('toolrail', $this->rows(1)[0]);
        $this->assertSame(self::NOW, $this->rows(1)[0]['_modified']);
        // Untouched rows keep their old stamp and value exactly.
        $this->assertSame([$clean], $this->rows(2));
        $this->assertSame(['not-an-array'], $this->rows(3));
        $this->assertSame(['some_other_meta' => ['x']], $GLOBALS['toolrail_test_user_meta'][4]);
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

    // --- conditional writes ------------------------------------------

    public function test_scrub_does_not_overwrite_a_concurrent_write() {
        $GLOBALS['toolrail_test_user_meta'] = [
            1 => ['wp_persisted_preferences' => [$this->row_with_toolrail()]],
        ];
        // An open editor tab lands its debounced write between the
        // runner's read and its write: a core preference changes and the
        // stamp moves on. Fire once, on the first write only.
        $fired = 0;
        $GLOBALS['toolrail_test_before_update'] = function ($user_id, $key) use (&$fired) {
            if ($fired++ > 0) {
                return;
            }
            $row                       = $GLOBALS['toolrail_test_user_meta'][$user_id][$key][0];
            $row['core']['editorMode'] = 'text';
            $row['_modified']          = '2026-09-04T14:59:59.000Z';
            $GLOBALS['toolrail_test_user_meta'][$user_id][$key][0] = $row;
        };

        $count = toolrail_uninstall_scrub_user(1, 'wp_persisted_preferences', self::NOW);

        // Refused once, re-read, landed on the second attempt — and the
        // tab's change survived while the scope still went.
        $this->assertSame(1, $count);
        $this->assertSame(2, $fired);
        $row = $this->rows(1)[0];
        $this->assertArrayNotHasKey('toolrail', $row);
        $this->assertSame('text', $row['core']['editorMode']);
        $this->assertSame(self::NOW, $row['_modified']);
    }

    public function test_scrub_gives_up_after_three_collisions_rather_than_clobber() {
        $GLOBALS['toolrail_test_user_meta'] = [
            1 => ['wp_persisted_preferences' => [$this->row_with_toolrail()]],
        ];
        // A writer that beats the runner every single time. Not a real
        // shape (the writer is debounced), but it pins the bound: the
        // runner must stop, and must never fall back to an unconditional
        // write that would throw the writer's data away.
        $fired = 0;
        $GLOBALS['toolrail_test_before_update'] = function ($user_id, $key) use (&$fired) {
            $fired++;
            $row              = $GLOBALS['toolrail_test_user_meta'][$user_id][$key][0];
            $row['_modified'] = '2026-09-04T14:59:' . str_pad((string) $fired, 2, '0', STR_PAD_LEFT) . '.000Z';
            $GLOBALS['toolrail_test_user_meta'][$user_id][$key][0] = $row;
        };

        $count = toolrail_uninstall_scrub_user(1, 'wp_persisted_preferences', self::NOW);

        $this->assertSame(0, $count);
        $this->assertSame(3, $fired);
        $row = $this->rows(1)[0];
        $this->assertArrayHasKey('toolrail', $row);
        $this->assertSame('2026-09-04T14:59:03.000Z', $row['_modified']);
    }

    public function test_scrub_strips_each_duplicate_row_on_its_own() {
        $second                          = $this->row_with_toolrail();
        $second['core']['editorMode']    = 'text';
        $second['_modified']             = '2026-08-31T10:00:00.000Z';
        $GLOBALS['toolrail_test_user_meta'] = [
            1 => ['wp_persisted_preferences' => [$this->row_with_toolrail(), $second]],
        ];

        $count = toolrail_uninstall_scrub_user(1, 'wp_persisted_preferences', self::NOW);

        // Two distinct rows, two conditional updates: each keeps its OWN
        // core preferences, where an unconditional update_user_meta()
        // would have stamped the first row's stripped copy over both.
        $this->assertSame(2, $count);
        $rows = $this->rows(1);
        $this->assertCount(2, $rows);
        $this->assertArrayNotHasKey('toolrail', $rows[0]);
        $this->assertArrayNotHasKey('toolrail', $rows[1]);
        $this->assertSame('visual', $rows[0]['core']['editorMode']);
        $this->assertSame('text', $rows[1]['core']['editorMode']);
    }

    public function test_scrub_handles_duplicate_rows_with_the_same_value() {
        $GLOBALS['toolrail_test_user_meta'] = [
            1 => ['wp_persisted_preferences' => [$this->row_with_toolrail(), $this->row_with_toolrail()]],
        ];

        $count = toolrail_uninstall_scrub_user(1, 'wp_persisted_preferences', self::NOW);

        // One conditional update matches both rows (update_metadata's WHERE
        // is on the value); the second attempt at that value matches
        // nothing, reads as a collision, and the re-read finds no work.
        $this->assertSame(1, $count);
        foreach ($this->rows(1) as $row) {
            $this->assertArrayNotHasKey('toolrail', $row);
            $this->assertSame(self::NOW, $row['_modified']);
        }
    }

    // --- the runner ----------------------------------------------------

    public function test_uninstall_single_site_uses_the_blog_prefixed_key() {
        $GLOBALS['toolrail_test_user_meta'] = [
            1 => ['wp_persisted_preferences' => [$this->row_with_toolrail()]],
        ];

        $total = toolrail_uninstall();

        $this->assertSame(1, $total);
        $row = $this->rows(1)[0];
        $this->assertArrayNotHasKey('toolrail', $row);
        // The stamp is the shape core writes from JS (toISOString), so the
        // persistence layer's Date.parse() comparison sees a real date.
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $row['_modified']);
        $this->assertGreaterThan('2026-08-30T10:00:00.000Z', $row['_modified']);
        // And it sits one hour AHEAD of the server clock: the browser's
        // own stamp comes from the browser's clock, and core keeps the
        // local copy whenever it is newer than the server's.
        $stamp = strtotime($row['_modified']);
        $this->assertGreaterThanOrEqual(time() + 3600 - 5, $stamp);
        $this->assertLessThanOrEqual(time() + 3600 + 5, $stamp);
    }

    public function test_uninstall_multisite_asks_for_every_site_not_the_first_hundred() {
        $GLOBALS['toolrail_test_multisite'] = true;
        $GLOBALS['toolrail_test_site_ids']  = [1];

        toolrail_uninstall();

        // WP_Site_Query defaults `number` to 100 and only emits a LIMIT
        // when it is truthy; 0 is the documented "all sites".
        $query = $GLOBALS['toolrail_test_last_site_query'];
        $this->assertSame('ids', $query['fields']);
        $this->assertSame(0, $query['number']);
    }

    public function test_uninstall_single_site_never_queries_the_network() {
        toolrail_uninstall();
        $this->assertNull($GLOBALS['toolrail_test_last_site_query']);
    }

    public function test_uninstall_multisite_visits_every_site_key() {
        $GLOBALS['toolrail_test_multisite'] = true;
        $GLOBALS['toolrail_test_site_ids']  = [1, 2];
        $GLOBALS['toolrail_test_user_meta'] = [
            1 => [
                'wp_persisted_preferences'   => [$this->row_with_toolrail()],
                'wp_2_persisted_preferences' => [$this->row_with_toolrail()],
                // A site not in the network listing is not visited.
                'wp_3_persisted_preferences' => [$this->row_with_toolrail()],
            ],
            2 => [
                'wp_2_persisted_preferences' => [$this->row_with_toolrail()],
            ],
        ];

        $total = toolrail_uninstall();

        $this->assertSame(3, $total);
        $this->assertArrayNotHasKey('toolrail', $this->rows(1)[0]);
        $this->assertArrayNotHasKey('toolrail', $this->rows(1, 'wp_2_persisted_preferences')[0]);
        $this->assertArrayHasKey('toolrail', $this->rows(1, 'wp_3_persisted_preferences')[0]);
        $this->assertArrayNotHasKey('toolrail', $this->rows(2, 'wp_2_persisted_preferences')[0]);
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
