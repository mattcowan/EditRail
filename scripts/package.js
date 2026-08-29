/**
 * Build the distributable plugin zip: toolrail.zip
 *
 * The file set is driven ENTIRELY by .distignore (gitignore syntax): every
 * file not excluded there is shipped. A WordPress.org deploy action reads
 * the same file, so the zip built here matches what a deploy would push to
 * SVN trunk. To change what ships, edit .distignore — never this script.
 *
 * Usage:
 *   node scripts/package.js          # build zip, remove the staging dir
 *   node scripts/package.js --keep   # keep build/toolrail/ for inspection
 *
 * There is no build step: the plugin ships its source JS/CSS as-is (no
 * minification, no bundling), so a clean checkout is already packageable.
 */
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const ignore = require('ignore');

const pluginSlug = 'toolrail';
const rootDir = path.join(__dirname, '..');
const buildDir = path.join(rootDir, 'build');
const distDir = path.join(buildDir, pluginSlug);
const zipFile = path.join(rootDir, `${pluginSlug}.zip`);
const keepStaging = process.argv.includes('--keep');

const distignorePath = path.join(rootDir, '.distignore');
if (!fs.existsSync(distignorePath)) {
  console.error('Cannot package: .distignore not found at repo root.');
  process.exit(1);
}
const ig = ignore().add(fs.readFileSync(distignorePath, 'utf8'));

// Preflight: the main file does an unconditional require_once on the
// includes, and enqueues the two assets — a zip without any of these
// fatals on activation or mounts nothing.
const requiredFiles = [
  'toolrail.php',
  'readme.txt',
  'includes/providers.php',
  'includes/rail.php',
  'assets/editor-rail.js',
  'assets/editor-rail.css',
];
const missing = requiredFiles.filter((rel) => !fs.existsSync(path.join(rootDir, rel)));
if (missing.length > 0) {
  console.error('Cannot package: required files are missing:');
  missing.forEach((rel) => console.error(`  - ${rel}`));
  process.exit(1);
}
const excluded = requiredFiles.filter((rel) => ig.ignores(rel));
if (excluded.length > 0) {
  console.error('Cannot package: .distignore excludes files the plugin cannot run without:');
  excluded.forEach((rel) => console.error(`  - ${rel}`));
  process.exit(1);
}

console.log('Cleaning previous build...');
if (fs.existsSync(buildDir)) {
  fs.rmSync(buildDir, { recursive: true, force: true });
}
if (fs.existsSync(zipFile)) {
  fs.unlinkSync(zipFile);
}

console.log('Staging production files (.distignore-driven)...');
let fileCount = 0;
copyTree(rootDir, '');
console.log(`Staged ${fileCount} files`);

console.log('Creating zip...');
const output = fs.createWriteStream(zipFile);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', function () {
  console.log(`Package created: ${pluginSlug}.zip (${archive.pointer()} bytes)`);
  if (keepStaging) {
    console.log(`Staging dir kept: ${distDir}`);
  } else {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
  console.log('Packaging complete.');
});

archive.on('error', function (err) {
  console.error('Error creating zip:', err.message);
  process.exit(1);
});

archive.pipe(output);
// Top-level folder inside the zip = the plugin slug, like wp.org zips.
archive.directory(distDir, pluginSlug, { mode: 0o755 });
archive.finalize();

/**
 * Recursively copy everything under rootDir/relBase not excluded by
 * .distignore into the staging dir.
 */
function copyTree(absDir, relBase) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (ig.ignores(rel) || ig.ignores(`${rel}/`)) {
        continue;
      }
      copyTree(path.join(absDir, entry.name), rel);
    } else {
      if (ig.ignores(rel)) {
        continue;
      }
      const destPath = path.join(distDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(path.join(absDir, entry.name), destPath);
      fileCount++;
    }
  }
}
