<?php
/**
 * Pins the provider-registry contract: the validator refuses malformed
 * declarations INSIDE the pure helper (not only at the enqueue boundary),
 * a garbage filter yields [], and duplicate slugs cannot hijack an earlier
 * provider's slot.
 */
class Test_Providers extends WP_UnitTestCase {

    protected function setUp(): void {
        parent::setUp();
        $GLOBALS['toolrail_test_filters'] = [];
    }

    protected function tearDown(): void {
        $GLOBALS['toolrail_test_filters'] = [];
        parent::tearDown();
    }

    private function valid_provider($slug = 'my-plugin') {
        return [
            'slug'          => $slug,
            'script_handle' => $slug . '-rail-tools',
        ];
    }

    public function test_valid_provider_passes_and_is_normalized() {
        $out = toolrail_sanitize_provider($this->valid_provider());
        $this->assertSame(
            ['slug' => 'my-plugin', 'script_handle' => 'my-plugin-rail-tools', 'style_handle' => ''],
            $out
        );
    }

    public function test_style_handle_is_kept_when_declared() {
        $provider                 = $this->valid_provider();
        $provider['style_handle'] = 'my-plugin-rail-style';
        $out                      = toolrail_sanitize_provider($provider);
        $this->assertSame('my-plugin-rail-style', $out['style_handle']);
    }

    public function test_non_array_entry_is_dropped() {
        $this->assertNull(toolrail_sanitize_provider('my-plugin'));
        $this->assertNull(toolrail_sanitize_provider(null));
        $this->assertNull(toolrail_sanitize_provider(42));
    }

    public function test_missing_or_unstable_slug_is_dropped() {
        $this->assertNull(toolrail_sanitize_provider(['script_handle' => 'h']));
        $this->assertNull(toolrail_sanitize_provider(['slug' => '', 'script_handle' => 'h']));
        // Not sanitize_key-stable: would silently change identity, so refuse.
        $this->assertNull(toolrail_sanitize_provider(['slug' => 'My Plugin', 'script_handle' => 'h']));
        $this->assertNull(toolrail_sanitize_provider(['slug' => 'my/plugin', 'script_handle' => 'h']));
    }

    public function test_missing_script_handle_is_dropped() {
        $this->assertNull(toolrail_sanitize_provider(['slug' => 'my-plugin']));
        $this->assertNull(toolrail_sanitize_provider(['slug' => 'my-plugin', 'script_handle' => '  ']));
        $this->assertNull(toolrail_sanitize_provider(['slug' => 'my-plugin', 'script_handle' => 42]));
    }

    public function test_filter_returning_non_array_yields_empty_list() {
        add_filter('toolrail_tool_providers', function () {
            return 'garbage';
        });
        $this->assertSame([], toolrail_get_tool_providers());
    }

    public function test_no_registered_providers_yields_empty_list() {
        $this->assertSame([], toolrail_get_tool_providers());
    }

    public function test_malformed_entries_are_dropped_and_valid_ones_kept() {
        $valid = $this->valid_provider();
        add_filter('toolrail_tool_providers', function ($providers) use ($valid) {
            $providers[] = 'not-an-array';
            $providers[] = ['slug' => 'no-handle'];
            $providers[] = $valid;
            return $providers;
        });
        $out = toolrail_get_tool_providers();
        $this->assertCount(1, $out);
        $this->assertSame('my-plugin', $out[0]['slug']);
    }

    public function test_duplicate_slug_keeps_the_first_declaration() {
        add_filter('toolrail_tool_providers', function ($providers) {
            $providers[] = ['slug' => 'my-plugin', 'script_handle' => 'first-handle'];
            $providers[] = ['slug' => 'my-plugin', 'script_handle' => 'hijack-handle'];
            return $providers;
        });
        $out = toolrail_get_tool_providers();
        $this->assertCount(1, $out);
        $this->assertSame('first-handle', $out[0]['script_handle']);
    }

    public function test_editor_payload_shape() {
        add_filter('toolrail_tool_providers', function ($providers) {
            $providers[] = ['slug' => 'alpha', 'script_handle' => 'alpha-tools'];
            $providers[] = ['slug' => 'beta', 'script_handle' => 'beta-tools'];
            return $providers;
        });
        $payload = toolrail_get_editor_payload();
        $this->assertSame(TOOLRAIL_VERSION, $payload['version']);
        $this->assertSame(['alpha', 'beta'], $payload['providers']);
    }
}
