<?php
/**
 * Pins the rail's script registration (#102). The rail's JavaScript is
 * several files, and WordPress drops a script with no error when one of
 * its dependencies is not registered as the scripts print, so every rail
 * file must be registered, each dependency before the script that needs
 * it, and `toolrail-editor-rail` must come last and depend on all the
 * others, because providers depend on that handle alone.
 *
 * These tests read what tests/phpunit/bootstrap.php's stubs of
 * wp_register_script() and wp_register_style() record. The stubs exist
 * only when WordPress is not loaded. Under the real WordPress test
 * library the record stays empty and every test here fails on a missing
 * key: read the registrations from wp_scripts() there instead.
 */
class Test_Rail extends WP_UnitTestCase {

    protected function setUp(): void {
        parent::setUp();
        $GLOBALS['toolrail_test_scripts'] = [];
        $GLOBALS['toolrail_test_styles']  = [];
        $GLOBALS['toolrail_test_script_translations'] = [];
        toolrail_register_rail_assets();
    }

    protected function tearDown(): void {
        $GLOBALS['toolrail_test_scripts'] = [];
        $GLOBALS['toolrail_test_styles']  = [];
        $GLOBALS['toolrail_test_script_translations'] = [];
        parent::tearDown();
    }

    public function test_every_rail_script_is_registered_from_an_existing_file() {
        $scripts = toolrail_rail_scripts();
        $this->assertCount(7, $scripts);
        foreach ($scripts as $handle => $script) {
            $this->assertArrayHasKey($handle, $GLOBALS['toolrail_test_scripts'], $handle . ' is not registered');
            $file = TOOLRAIL_PLUGIN_DIR . $script['file'];
            $this->assertFileExists($file);
            $registered = $GLOBALS['toolrail_test_scripts'][$handle];
            $this->assertSame(TOOLRAIL_PLUGIN_URL . $script['file'], $registered['src']);
            // Each file has its own filemtime() version.
            $this->assertSame(filemtime($file), $registered['ver'], $handle . ' version');
            $this->assertTrue($registered['in_footer'], $handle . ' in footer');
        }
    }

    public function test_the_public_handle_is_last_and_depends_on_every_other_rail_script() {
        $handles = array_keys($GLOBALS['toolrail_test_scripts']);
        $this->assertSame('toolrail-editor-rail', end($handles));
        $main = $GLOBALS['toolrail_test_scripts']['toolrail-editor-rail'];
        $this->assertSame(TOOLRAIL_PLUGIN_URL . 'assets/editor-rail.js', $main['src']);
        foreach (array_slice($handles, 0, -1) as $handle) {
            $this->assertContains($handle, $main['deps'], 'toolrail-editor-rail must depend on ' . $handle);
        }
    }

    public function test_each_rail_dependency_is_registered_before_the_script_that_needs_it() {
        $seen = [];
        foreach ($GLOBALS['toolrail_test_scripts'] as $handle => $script) {
            foreach ($script['deps'] as $dep) {
                if (0 === strpos($dep, 'toolrail-')) {
                    $this->assertContains($dep, $seen, $handle . ' depends on ' . $dep . ', which is not registered before it');
                }
            }
            $seen[] = $handle;
        }
    }

    public function test_each_rail_script_after_the_first_depends_on_the_one_before_it() {
        // The files share one namespace object and run their top-level code
        // in the original order, so the print order must be the list order.
        $handles = array_keys($GLOBALS['toolrail_test_scripts']);
        for ($i = 1; $i < count($handles); $i++) {
            $this->assertContains($handles[$i - 1], $GLOBALS['toolrail_test_scripts'][$handles[$i]]['deps'], $handles[$i]);
        }
    }

    public function test_the_first_rail_script_carries_the_wordpress_dependencies() {
        $first = reset($GLOBALS['toolrail_test_scripts']);
        foreach (['wp-data', 'wp-preferences', 'wp-blocks', 'wp-i18n', 'wp-a11y', 'wp-element', 'wp-components', 'wp-plugins', 'wp-block-editor'] as $dep) {
            $this->assertContains($dep, $first['deps']);
        }
    }

    public function test_every_rail_script_that_holds_strings_loads_its_translations() {
        // A language pack cannot translate a file's strings unless its
        // handle calls wp_set_script_translations() (#120). Read each file
        // for a string in the 'editrail' text domain, so a new file with
        // strings and no call fails here.
        $with_strings = 0;
        foreach (toolrail_rail_scripts() as $handle => $script) {
            $source = file_get_contents(TOOLRAIL_PLUGIN_DIR . $script['file']);
            if (!preg_match("/'editrail'\s*\)/", $source)) {
                continue;
            }
            $with_strings++;
            $this->assertArrayHasKey($handle, $GLOBALS['toolrail_test_script_translations'], $handle . ' holds strings but loads no translations');
            $this->assertSame('editrail', $GLOBALS['toolrail_test_script_translations'][$handle]['domain'], $handle . ' text domain');
            $this->assertSame('', $GLOBALS['toolrail_test_script_translations'][$handle]['path'], $handle . ' must read the language pack folder');
        }
        // Proves that the search above works, with a file known to hold
        // strings. A later file with no strings needs no call, so the count
        // is not tied to the number of rail files.
        $this->assertGreaterThan(0, $with_strings);
        $this->assertArrayHasKey('toolrail-editor-rail-settings', $GLOBALS['toolrail_test_script_translations']);
    }

    public function test_the_style_keeps_the_public_handle() {
        $this->assertArrayHasKey('toolrail-editor-rail', $GLOBALS['toolrail_test_styles']);
        $this->assertSame(TOOLRAIL_PLUGIN_URL . 'assets/editor-rail.css', $GLOBALS['toolrail_test_styles']['toolrail-editor-rail']['src']);
    }
}
