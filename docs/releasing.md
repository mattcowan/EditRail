# Releasing Editrail

How the plugin gets from a git commit to an installable zip. GitHub is the source of truth. WordPress.org is a future deploy target. The plugin is not listed yet, and nothing here touches wp.org.

## What runs where

| Trigger | Workflow | What happens |
|---|---|---|
| Any pull request (each push to it) | `.github/workflows/ci.yml` | Version check, PHPUnit, Playwright e2e on a wp-env WordPress, and a packaging proof (`npm run package` must succeed). Approve a PR only when this is green. |
| Push to `main` (the merge) | `.github/workflows/ci.yml` | Version check, PHPUnit and the packaging proof only. The e2e suite is skipped: the merged code passed it on the PR. |
| Actions → CI → Run workflow | `.github/workflows/ci.yml` | The full set, plus `editrail.zip` is kept as a build artifact for 7 days. Use this to get a test build of any branch. |
| A GitHub Release is **published** | `.github/workflows/release.yml` | Version guard against the tag, then `editrail.zip` is attached to the Release. |

## Cut a release

1. Set the version in all six places: `editrail.php` header `Version:`, `TOOLRAIL_VERSION`, `readme.txt` `Stable tag:`, `package.json` `version`, and the two `version` entries at the top of `package-lock.json` (or run `npm install --package-lock-only` after `package.json`). All but `Stable tag` must agree, or CI fails. `Stable tag` must equal them for a stable release. For a beta, leave `Stable tag` at the last stable version (lower than the code version); CI accepts that state. Add a changelog entry to `readme.txt`.
2. Check locally: `node scripts/check-versions.js` and `npm run package`. Open the zip. Make sure that nothing from `private/`, `tests/` or `node_modules/` is in it.
3. Commit and push to `main`. Wait for CI to pass.
4. GitHub → Releases → Draft a new release. Create tag `vX.Y.Z` on `main`. Write the release notes. For a beta, tag `vX.Y.Z-beta.N` and select "Set as a pre-release". A beta keeps `Stable tag` at the last stable version, which is lower than the beta's base version, and the guard checks that.
5. Publish. The Release workflow attaches `editrail.zip` in one or two minutes. Download it and install it on a clean site once.

## What ships

`.distignore` decides. Everything not listed there goes into the zip. A new production file ships automatically. A new dev-only file must be added to `.distignore`. `scripts/package.js` refuses to build if a file the plugin needs to run is excluded.

There is no build step. The plugin ships its source JS and CSS unchanged.

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

The slug install in the committed blueprint resolves only once the plugin is listed. The deploy action syncs `.wordpress-org/` into the plugin's SVN assets, and a committer turns the preview on from the plugin's Advanced view on WordPress.org.

## When the plugin is listed on WordPress.org

Add the wp.org deploy to `release.yml` for stable releases only: `10up/action-wordpress-plugin-deploy@stable` with `SLUG: editrail`, the `SVN_USERNAME` / `SVN_PASSWORD` repository secrets, and a `.wordpress-org/` folder with the icon, banner and screenshots. The Typography Stylist repo's `release-deploy.yml` is the working reference.
