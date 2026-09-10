/**
 * The WordPress Playground blueprint: one source, three uses.
 *
 * The blueprint that ships to WordPress.org's Live Preview is
 * .wordpress-org/blueprints/blueprint.json. It is GENERATED from this
 * file plus the two PHP files in scripts/playground/ (the demo content
 * and the fonts mu-plugin), because a blueprint's runPHP step wants its
 * code as one JSON string and nobody should maintain PHP inside a JSON
 * string. Edit the PHP, run `build`, commit both.
 *
 *   node scripts/playground.js build
 *     Write .wordpress-org/blueprints/blueprint.json (the wp.org Live
 *     Preview: installs the plugin BY SLUG, which resolves only once the
 *     plugin is listed; wp.org syncs .wordpress-org/ into the plugin's
 *     SVN assets, and a committer turns the preview on from the plugin's
 *     Advanced view).
 *
 *   node scripts/playground.js check
 *     Fail if the committed blueprint.json is not what `build` would
 *     write (CI runs this).
 *
 *   node scripts/playground.js local [--port=9400]
 *     Run the same demo against THIS checkout with the Playground CLI:
 *     the checkout is mounted as the plugin and activated in place of
 *     the slug install. Needs Node 20.18+; downloads WordPress once.
 *
 *   node scripts/playground.js url [--zip=<url>]
 *     Print a playground.wordpress.net link that installs the plugin
 *     from a public zip URL instead of the slug (default: the latest
 *     GitHub Release asset). The blueprint rides in the URL fragment,
 *     so nothing has to be hosted — but the zip must be reachable
 *     WITHOUT authentication, which for a GitHub Release means a public
 *     repository. Playground fetches it directly and falls back to its
 *     CORS proxy, so a GitHub Release asset URL works as-is.
 *
 * Every file this script writes is under build/ (gitignored) except the
 * blueprint itself.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const blueprintFile = path.join(rootDir, '.wordpress-org', 'blueprints', 'blueprint.json');
const demoContentFile = path.join(__dirname, 'playground', 'demo-content.php');
const demoFontsFile = path.join(__dirname, 'playground', 'demo-fonts.php');

// Must match TOOLRAIL_DEMO_POST_ID in demo-content.php.
const DEMO_POST_ID = 2026;
const RELEASE_ZIP = 'https://github.com/mattcowan/editor-tool-rail/releases/latest/download/editrail.zip';

const [command = 'build', ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(
  rest.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v = 'true'] = a.slice(2).split('=');
    return [k, v];
  })
);

/** The blueprint's runPHP code: the PHP source with wp-load bootstrapped first. */
function demoContentCode() {
  const src = fs.readFileSync(demoContentFile, 'utf8').replace(/\r\n/g, '\n');
  if (!src.startsWith('<?php')) {
    throw new Error(`${path.relative(rootDir, demoContentFile)} must start with <?php`);
  }
  // runPHP runs the string as a PHP file; the source's own guard then
  // sees add_action() defined and skips its require.
  return "<?php require_once '/wordpress/wp-load.php';\n" + src.slice('<?php'.length);
}

/**
 * The shared steps, with the plugin install left as a placeholder the
 * three variants fill in differently.
 *
 * @param {Object} pluginStep The installPlugin (or activatePlugin) step for Toolrail.
 * @return {Object} Blueprint.
 */
function blueprint(pluginStep) {
  return {
    $schema: 'https://playground.wordpress.net/blueprint-schema.json',
    landingPage: `/wp-admin/post.php?post=${DEMO_POST_ID}&action=edit`,
    preferredVersions: { php: '8.2', wp: 'latest' },
    steps: [
      // Twenty Twenty-Five is the look the demo post was designed on;
      // installing it by slug keeps the demo the same whatever the
      // current default theme is.
      {
        step: 'installTheme',
        themeData: { resource: 'wordpress.org/themes', slug: 'twentytwentyfive' },
        options: { activate: true },
      },
      {
        step: 'installPlugin',
        pluginData: { resource: 'wordpress.org/plugins', slug: 'typography-stylist' },
        options: { activate: true },
      },
      pluginStep,
      { step: 'mkdir', path: '/wordpress/wp-content/mu-plugins' },
      {
        step: 'writeFile',
        path: '/wordpress/wp-content/mu-plugins/toolrail-demo-fonts.php',
        data: fs.readFileSync(demoFontsFile, 'utf8').replace(/\r\n/g, '\n'),
      },
      { step: 'runPHP', code: demoContentCode() },
      { step: 'login', username: 'admin' },
    ],
  };
}

const wporgStep = {
  step: 'installPlugin',
  pluginData: { resource: 'wordpress.org/plugins', slug: 'editrail' },
  options: { activate: true },
};

/** The blueprint as committed: two-space JSON with a trailing newline. */
function render(bp) {
  return JSON.stringify(bp, null, 2) + '\n';
}

/** Write .wordpress-org/blueprints/blueprint.json from the sources. */
function build() {
  fs.mkdirSync(path.dirname(blueprintFile), { recursive: true });
  fs.writeFileSync(blueprintFile, render(blueprint(wporgStep)));
  console.log(`Wrote ${path.relative(rootDir, blueprintFile)}`);
}

/**
 * Fail (exit 1) when the committed blueprint differs from what build()
 * would write, so a hand edit or a forgotten rebuild cannot ship.
 */
function check() {
  const expected = render(blueprint(wporgStep));
  const actual = fs.existsSync(blueprintFile) ? fs.readFileSync(blueprintFile, 'utf8').replace(/\r\n/g, '\n') : '';
  if (actual !== expected) {
    console.error(`x ${path.relative(rootDir, blueprintFile)} is out of date. Run: node scripts/playground.js build`);
    process.exit(1);
  }
  console.log('ok  blueprint.json matches its sources');
}

/**
 * Run the demo against this checkout in the Playground CLI: write a local
 * blueprint variant that activates the mounted plugin, then start the
 * server on --port (default 9400) and print its URL.
 */
function local() {
  // The port is the one value from the command line that reaches the
  // shell (npx is a .cmd on Windows, so spawnSync runs through cmd.exe,
  // which parses metacharacters in arguments). An integer or nothing.
  const port = flags.port === undefined ? 9400 : Number(flags.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('x --port must be a whole number from 1 to 65535.');
    process.exit(1);
  }
  const bp = blueprint({ step: 'activatePlugin', pluginPath: 'editrail/editrail.php' });
  const outDir = path.join(rootDir, 'build', 'playground');
  fs.mkdirSync(outDir, { recursive: true });
  const localFile = path.join(outDir, 'blueprint.local.json');
  fs.writeFileSync(localFile, render(bp));
  // Paths RELATIVE to the repo root, with the root as the working
  // directory: the CLI splits --mount on ":", so an absolute Windows
  // path ("C:\...") reads as a drive letter and nothing, and a path with
  // spaces would need shell quoting on Windows (where npx is a .cmd and
  // needs a shell).
  const args = [
    '-y',
    '@wp-playground/cli@latest',
    'server',
    `--blueprint=${path.relative(rootDir, localFile).split(path.sep).join('/')}`,
    '--mount=.:/wordpress/wp-content/plugins/editrail',
    `--port=${port}`,
  ];
  console.log('npx ' + args.join(' '));
  const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exit(result.status === null ? 1 : result.status);
}

/**
 * Print a playground.wordpress.net link that carries the blueprint and
 * installs the plugin from a public zip (--zip, default: the latest
 * GitHub Release).
 */
function url() {
  const zip = flags.zip || RELEASE_ZIP;
  const bp = blueprint({
    step: 'installPlugin',
    pluginData: { resource: 'url', url: zip },
    options: { activate: true },
  });
  const encoded = Buffer.from(JSON.stringify(bp), 'utf8').toString('base64');
  console.log(`https://playground.wordpress.net/#${encoded}`);
}

const commands = { build, check, local, url };
if (!commands[command]) {
  console.error(`Unknown command "${command}". Use: build | check | local | url`);
  process.exit(1);
}
commands[command]();
