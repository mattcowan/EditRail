# Releasing EditRail

How the plugin gets from a git commit to WordPress.org. GitHub is the source of truth. WordPress.org SVN (`https://plugins.svn.wordpress.org/editrail`) is a deploy target that only GitHub Actions writes to. Nobody commits to SVN by hand.

## What runs where

| Trigger | Workflow | What happens |
|---|---|---|
| Any pull request (each push to it) | `.github/workflows/ci.yml` | Version check, PHPUnit, Playwright e2e on a wp-env WordPress, the blueprint check, and a packaging proof (`npm run package` must succeed). Approve a PR only when this is green. |
| Push to `main` (the merge) | `.github/workflows/ci.yml` | Version check, PHPUnit, blueprint check and the packaging proof only. The e2e suite is skipped: the merged code passed it on the PR. |
| Actions → CI → Run workflow | `.github/workflows/ci.yml` | The full set, plus `editrail.zip` is kept as a build artifact for 7 days. Use this to get a test build of any branch. |
| A GitHub Release is **published**, pre-release unchecked | `.github/workflows/release.yml` | Version guard against the tag, then deploy to WordPress.org: SVN `trunk`, `tags/X.Y.Z`, and `assets/` from `.wordpress-org/`. The zip the action built is attached to the Release. |
| A GitHub Release is **published**, pre-release checked | `.github/workflows/release.yml` | Version guard, then `editrail.zip` is attached to the Release. WordPress.org is not touched. |
| Actions → WP.org Readme/Assets Sync → Run workflow | `.github/workflows/wporg-assets.yml` | Pushes `readme.txt` and `.wordpress-org/` to WordPress.org without a release. Use it for a "Tested up to" bump, a readme fix, or new screenshots. |

## One-time setup

The two workflows that write to SVN need two repository secrets (GitHub → Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `SVN_USERNAME` | The WordPress.org username that owns the plugin. |
| `SVN_PASSWORD` | The SVN password from the WordPress.org profile (Account → Edit → SVN password). This is not the login password. |

Before the first stable release, publish a pre-release once (`v1.0.1-beta.1` with "Set as a pre-release" checked) to prove the workflow runs. A pre-release never touches SVN.

## Cut a release

1. Set the version in all six places: `editrail.php` header `Version:`, `TOOLRAIL_VERSION`, `readme.txt` `Stable tag:`, `package.json` `version`, and the two `version` entries at the top of `package-lock.json` (or run `npm install --package-lock-only` after `package.json`). All but `Stable tag` must agree, or CI fails. `Stable tag` must equal them for a stable release. For a beta, leave `Stable tag` at the last stable version (lower than the code version); CI accepts that state. Add a changelog entry to `readme.txt` and, if the release needs one, an upgrade notice of 300 characters or fewer.
2. Check locally: `node scripts/check-versions.js` and `npm run package`. Open the zip. Make sure that nothing from `private/`, `tests/` or `node_modules/` is in it.
3. Commit and push to `main`. Wait for CI to pass.
4. GitHub → Releases → Draft a new release. Create tag `vX.Y.Z` on `main`. Write the release notes. For a beta, tag `vX.Y.Z-beta.N` and select "Set as a pre-release". A beta keeps `Stable tag` at the last stable version, which is lower than the beta's base version, and the guard checks that.
5. Publish. The Release workflow deploys in a few minutes. Check the plugin page on WordPress.org: the version, the changelog, and the assets. Install the release from WordPress.org on a clean site once.

## What ships

`.distignore` decides. Everything not listed there goes into the zip and into SVN `trunk`. A new production file ships automatically. A new dev-only file must be added to `.distignore`. `scripts/package.js` refuses to build if a file the plugin needs to run is excluded. The deploy action reads the same file, so the zip and trunk always agree.

There is no build step. The plugin ships its source JS and CSS unchanged.

## Listing assets

`.wordpress-org/` holds everything that goes to SVN `assets/`, which is the listing, not the plugin:

| File | What it is |
|---|---|
| `icon-128x128.png`, `icon-256x256.png`, `icon.svg` | The plugin icon. |
| `banner-772x250.png`, `banner-1544x500.png` | The header image on the plugin page. |
| `screenshot-1.png` … | The screenshots. Their captions are the numbered list under `== Screenshots ==` in `readme.txt`; the numbers must match. |
| `blueprints/blueprint.json` | The Live Preview blueprint. Generated; see below. |

`node scripts/screenshots.js` regenerates the screenshots against a local site (defaults to `http://typographystylist.local`; see the script header for the variables). `node scripts/wordmark.js` regenerates the icon and banner from `scripts/wordmark/wordmark.html`. Removing a file from `.wordpress-org/` removes it from WordPress.org on the next sync.

## Run the e2e tests against wp-env locally

`.wp-env.json` maps this checkout in as the plugin. With Docker running:

```
npx wp-env start
TOOLRAIL_URL=http://localhost:8888 TOOLRAIL_ADMIN_PASS=password npm run test:e2e
npx wp-env stop
```

Without those variables the suite targets `http://mnc4.local` with `admin` / `pass`, the local development site.

## The Playground blueprint

`.wordpress-org/blueprints/blueprint.json` is the WordPress.org Live Preview: it installs Twenty Twenty-Five, Typography Stylist and this plugin by slug, seeds the admin's editor preferences (no welcome guide; the default tools plus the Typography Stylist block pinned, with a custom name), publishes a demo post, logs in, and opens that post in the editor. It is generated. Do not edit it by hand.

1. Edit `scripts/playground/demo-content.php` (the `runPHP` step) or `scripts/playground/demo-fonts.php` (the fonts must-use plugin).
2. Run `npm run playground:build`. Commit the PHP and the blueprint together. CI runs `npm run playground:check` and fails when they disagree.
3. Test it: `npm run playground` runs the demo against this checkout in the Playground CLI and prints a local URL. Open the demo post and check that no block shows an "invalid content" notice.

`npm run playground:url` prints a playground.wordpress.net link that installs the plugin from the latest GitHub Release zip. It works only while the repository is public, because the zip must be reachable without authentication. Pass `--zip=<url>` to use another public zip.

The blueprint reaches WordPress.org with every stable release. A committer turns the Live Preview on from the plugin's Advanced view on WordPress.org.
