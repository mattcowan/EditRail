/**
 * Version-consistency guard. Zero dependencies.
 *
 * The plugin's version lives in FOUR places that must always agree:
 *   1. toolrail.php  — plugin header `Version:`
 *   2. toolrail.php  — `define('TOOLRAIL_VERSION', '...')`
 *   3. readme.txt    — `Stable tag:`
 *   4. package.json  — `version`
 *
 * Modes:
 *   node scripts/check-versions.js
 *     Consistency mode (CI, every push): all four must match each other.
 *
 *   node scripts/check-versions.js v0.1.17
 *     Tag mode (release workflow): all four must equal the tag (leading
 *     "v" stripped). Stops a GitHub Release tagged v0.1.17 from packaging
 *     files that still say 0.1.16.
 *
 *   node scripts/check-versions.js v0.2.0-beta.1 --prerelease
 *     Pre-release mode: header/constant/package.json must equal the BASE
 *     version (0.2.0) and Stable tag must NOT equal it, so a beta never
 *     moves the tag WordPress.org would serve.
 *
 * Also warns (never fails) when `Tested up to:` carries a patch version —
 * the wp.org convention is major.minor.
 */
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(rootDir, f), 'utf8');

const args = process.argv.slice(2);
const prerelease = args.includes('--prerelease');
const tagArg = args.find((a) => !a.startsWith('--')) || null;

function extract(pattern, text, label, file) {
  const m = text.match(pattern);
  if (!m) {
    console.error(`x Could not find ${label} in ${file}`);
    process.exit(1);
  }
  return m[1].trim();
}

const mainPhp = read('toolrail.php');
const readmeTxt = read('readme.txt');
const pkg = JSON.parse(read('package.json'));

const versions = {
  'plugin header (toolrail.php)': extract(/^\s*\*\s*Version:\s*(.+)$/m, mainPhp, 'plugin header Version', 'toolrail.php'),
  'TOOLRAIL_VERSION (toolrail.php)': extract(/define\(\s*'TOOLRAIL_VERSION'\s*,\s*'([^']+)'/, mainPhp, 'TOOLRAIL_VERSION', 'toolrail.php'),
  'Stable tag (readme.txt)': extract(/^Stable tag:\s*(.+)$/m, readmeTxt, 'Stable tag', 'readme.txt'),
  'version (package.json)': String(pkg.version || ''),
};

function table(expectedByKey) {
  const width = Math.max(...Object.keys(versions).map((k) => k.length));
  for (const [key, value] of Object.entries(versions)) {
    const expected = expectedByKey ? expectedByKey[key] : null;
    let marker = '';
    if (expected === 'must-differ') {
      marker = value !== expectedByKey.base ? '  ok' : `  x must NOT be ${expectedByKey.base}`;
    } else if (expected) {
      marker = value === expected ? '  ok' : `  x expected ${expected}`;
    }
    console.log(`  ${key.padEnd(width)}  ${value}${marker}`);
  }
}

let failed = false;

if (!tagArg) {
  const values = Object.values(versions);
  console.log('Version consistency check:');
  table(null);
  if (!values.every((v) => v === values[0])) {
    console.error('\nx Version mismatch - the four version sources must agree.');
    failed = true;
  } else {
    console.log(`\nok All version sources agree: ${values[0]}`);
  }
} else {
  const tag = tagArg.replace(/^v/, '');
  if (!prerelease) {
    console.log(`Release version check against tag ${tagArg}:`);
    const expected = {};
    for (const key of Object.keys(versions)) expected[key] = tag;
    table(expected);
    if (!Object.values(versions).every((v) => v === tag)) {
      console.error(`\nx One or more version sources do not match release tag ${tagArg}.`);
      failed = true;
    } else {
      console.log(`\nok All version sources match release tag ${tagArg}`);
    }
  } else {
    const base = tag.replace(/[-+].*$/, '');
    if (base === tag) {
      console.error(`x --prerelease given but tag ${tagArg} has no pre-release suffix (expected e.g. v0.2.0-beta.1).`);
      process.exit(1);
    }
    console.log(`Pre-release version check against tag ${tagArg} (base ${base}):`);
    const expected = { base };
    for (const key of Object.keys(versions)) {
      expected[key] = key.startsWith('Stable tag') ? 'must-differ' : base;
    }
    table(expected);
    const stable = versions['Stable tag (readme.txt)'];
    const others = Object.entries(versions)
      .filter(([k]) => !k.startsWith('Stable tag'))
      .map(([, v]) => v);
    if (!others.every((v) => v === base)) {
      console.error(`\nx Plugin header / TOOLRAIL_VERSION / package.json must equal the base version ${base} for a pre-release.`);
      failed = true;
    }
    if (stable === base) {
      console.error(`\nx Stable tag equals ${base} - during a beta the Stable tag must keep pointing at the last STABLE release.`);
      failed = true;
    }
    if (!failed) {
      console.log(`\nok Pre-release versions OK (Stable tag stays at ${stable})`);
    }
  }
}

const testedUpTo = readmeTxt.match(/^Tested up to:\s*(.+)$/m);
if (testedUpTo && /^\d+\.\d+\.\d+/.test(testedUpTo[1].trim())) {
  console.warn(`! Tested up to: ${testedUpTo[1].trim()} - wp.org convention is major.minor.`);
}

process.exit(failed ? 1 : 0);
