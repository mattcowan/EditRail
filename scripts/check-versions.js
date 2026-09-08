/**
 * Version-consistency guard. Zero dependencies.
 *
 * The plugin's version lives in SIX places that must always agree:
 *   1. editrail.php  — plugin header `Version:`
 *   2. editrail.php  — `define('TOOLRAIL_VERSION', '...')`
 *   3. readme.txt    — `Stable tag:`
 *   4. package.json  — `version`
 *   5+6. package-lock.json — root `version` and `packages[""].version`
 *
 * Modes:
 *   node scripts/check-versions.js
 *     Consistency mode (CI, every push, and `npm run package`): header,
 *     constant and package.json must match each other; Stable tag must
 *     equal them or be lower (the beta-in-preparation state).
 *
 *   node scripts/check-versions.js v0.1.17
 *     Tag mode (release workflow): all six must equal the tag (leading
 *     "v" stripped). Stops a GitHub Release tagged v0.1.17 from packaging
 *     files that still say 0.1.16.
 *
 *   node scripts/check-versions.js v0.2.0-beta.1 --prerelease
 *     Pre-release mode: header/constant/package.json must equal the BASE
 *     version (0.2.0) and Stable tag must be LOWER than it, so a beta never
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
const tagArg = args.find((a) => !a.startsWith('--')) ?? null;

/** Compare two dotted numeric versions: <0, 0, >0. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function extract(pattern, text, label, file) {
  const m = text.match(pattern);
  if (!m) {
    console.error(`x Could not find ${label} in ${file}`);
    process.exit(1);
  }
  return m[1].trim();
}

const mainPhp = read('editrail.php');
const readmeTxt = read('readme.txt');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

const versions = {
  'plugin header (editrail.php)': extract(/^\s*\*\s*Version:\s*(.+)$/m, mainPhp, 'plugin header Version', 'editrail.php'),
  'TOOLRAIL_VERSION (editrail.php)': extract(/define\(\s*'TOOLRAIL_VERSION'\s*,\s*'([^']+)'/, mainPhp, 'TOOLRAIL_VERSION', 'editrail.php'),
  'Stable tag (readme.txt)': extract(/^Stable tag:\s*(.+)$/m, readmeTxt, 'Stable tag', 'readme.txt'),
  'version (package.json)': String(pkg.version || ''),
  // The lockfile carries the root version twice; npm does not fail on a
  // mismatch, so it drifts silently (review 2026-08-29) - guard it too.
  'version (package-lock.json)': String(lock.version || ''),
  'packages[""].version (package-lock.json)': String((lock.packages && lock.packages[''] && lock.packages[''].version) || ''),
};

function table(expectedByKey) {
  const width = Math.max(...Object.keys(versions).map((k) => k.length));
  for (const [key, value] of Object.entries(versions)) {
    const expected = expectedByKey ? expectedByKey[key] : null;
    let marker = '';
    if (expected === 'must-be-lower') {
      marker = compareVersions(value, expectedByKey.base) < 0 ? '  ok' : `  x must be lower than ${expectedByKey.base}`;
    } else if (expected) {
      marker = value === expected ? '  ok' : `  x expected ${expected}`;
    }
    console.log(`  ${key.padEnd(width)}  ${value}${marker}`);
  }
}

let failed = false;

// `=== null`, not `!tagArg`: an empty-string tag must reach tag mode and
// fail there, never fall through to consistency mode and exit 0.
if (tagArg === null) {
  // Header, constant and package.json must agree. Stable tag must equal
  // them OR be lower: a beta in preparation keeps Stable tag at the last
  // stable release on purpose (see pre-release mode), and this check
  // runs on every push and inside `npm run package`, so it must accept
  // that state or no beta could ever be built. A HIGHER Stable tag is
  // always wrong. The stable-release tag guard is the hard gate where
  // all six must equal the tag.
  const stable = versions['Stable tag (readme.txt)'];
  const others = Object.entries(versions)
    .filter(([k]) => !k.startsWith('Stable tag'))
    .map(([, v]) => v);
  console.log('Version consistency check:');
  table(null);
  if (!others.every((v) => v === others[0])) {
    console.error('\nx Version mismatch - plugin header, TOOLRAIL_VERSION, package.json and package-lock.json must agree.');
    failed = true;
  } else if (stable === others[0]) {
    console.log(`\nok All version sources agree: ${others[0]}`);
  } else if (/^\d+(\.\d+)*$/.test(stable) && compareVersions(stable, others[0]) < 0) {
    console.log(`\nok Code is at ${others[0]}; Stable tag stays at ${stable} (pre-release state - a stable release must move it).`);
  } else {
    console.error(`\nx Stable tag is ${stable} but the code is at ${others[0]} - Stable tag may equal the code version or be lower, never higher.`);
    failed = true;
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
      expected[key] = key.startsWith('Stable tag') ? 'must-be-lower' : base;
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
    if (!/^\d+(\.\d+)*$/.test(stable) || compareVersions(stable, base) >= 0) {
      console.error(`\nx Stable tag is ${stable} - during a beta it must be a plain version LOWER than ${base}, the last STABLE release.`);
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
