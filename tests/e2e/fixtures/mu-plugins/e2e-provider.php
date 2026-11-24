<?php
/**
 * Plugin Name: EditRail e2e provider (tests only)
 * Description: A tool provider for tests/e2e/script-loading.spec.js. Inert unless the toolrail_e2e_provider cookie is set.
 *
 * Loaded as a must-use plugin: .wp-env.json maps this folder to
 * wp-content/mu-plugins for CI, and a local test site copies the file there.
 * It never ships (.distignore excludes /tests).
 *
 * It does what an extension plugin does (README, "Extending"): it declares a
 * provider on `toolrail_tool_providers`, and registers a script whose only
 * dependency is `toolrail-editor-rail`. The script calls registerTool() while
 * it is first evaluated, before the toolbar mounts. The rail is seven files
 * (#102), so this checks that a provider still runs after all seven, with
 * the public API ready and the private one gone.
 *
 * Only a test that sets the cookie sees the tool, so the other specs run on
 * the toolbar they expect.
 */

if (!defined('ABSPATH')) {
    exit;
}

if (!isset($_COOKIE['toolrail_e2e_provider']) || '1' !== $_COOKIE['toolrail_e2e_provider']) {
    return;
}

add_filter('toolrail_tool_providers', function ($providers) {
    $providers[] = [
        'slug'          => 'e2e-provider',
        'script_handle' => 'toolrail-e2e-provider',
    ];
    return $providers;
});

add_action('enqueue_block_editor_assets', function () {
    // No file: WordPress prints the inline script in the handle's place,
    // after every dependency, as it would print a provider's own file.
    wp_register_script('toolrail-e2e-provider', false, ['toolrail-editor-rail'], null, true);
    wp_add_inline_script('toolrail-e2e-provider', <<<'JS'
(function () {
  var seen = {
    api: typeof window.toolrail,
    internal: typeof window.toolrailInternal,
    mounted: !!document.getElementById('toolrail-rail'),
    error: null
  };
  window.__toolrailE2EProvider = seen;
  try {
    window.toolrail.registerTool({
      id: 'e2e-provider-child',
      label: 'E2E Provider Child',
      parent: 'pin:core/paragraph',
      insertBlock: 'core/quote'
    });
  } catch (e) {
    seen.error = String((e && e.message) || e);
  }
})();
JS
    );
}, 5);
