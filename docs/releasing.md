# Releasing Editor Tool Rail

How the plugin gets from a git commit to an installable zip. GitHub is the source of truth. WordPress.org is a future deploy target. The plugin is not listed yet, and nothing here touches wp.org.

## What runs where

| Trigger | Workflow | What happens |
|---|---|---|
| Push to `main`, any pull request | `.github/workflows/ci.yml` | Version check, PHPUnit, Playwright e2e on a wp-env WordPress, and a packaging proof (`npm run package` must succeed). |
| Actions → CI → Run workflow | `.github/workflows/ci.yml` | Same, plus `toolrail.zip` is kept as a build artifact for 7 days. Use this to get a test build of any branch. |
| A GitHub Release is **published** | `.github/workflows/release.yml` | Version guard against the tag, then `toolrail.zip` is attached to the Release. |

## Cut a release

1. Set the version in all four places. They must agree, or CI fails: `toolrail.php` header `Version:`, `TOOLRAIL_VERSION`, `readme.txt` `Stable tag:`, `package.json` `version`. Add a changelog entry to `readme.txt`.
2. Check locally: `node scripts/check-versions.js` and `npm run package`. Open the zip. Make sure that nothing from `private/`, `tests/` or `node_modules/` is in it.
3. Commit and push to `main`. Wait for CI to pass.
4. GitHub → Releases → Draft a new release. Create tag `vX.Y.Z` on `main`. Write the release notes. For a beta, tag `vX.Y.Z-beta.N` and select "Set as a pre-release". A beta keeps `Stable tag` at the last stable version, and the guard checks that.
5. Publish. The Release workflow attaches `toolrail.zip` in one or two minutes. Download it and install it on a clean site once.

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

## When the plugin is listed on WordPress.org

Add the wp.org deploy to `release.yml` for stable releases only: `10up/action-wordpress-plugin-deploy@stable` with `SLUG: toolrail`, the `SVN_USERNAME` / `SVN_PASSWORD` repository secrets, and a `.wordpress-org/` folder with the icon, banner and screenshots. The Typography Stylist repo's `release-deploy.yml` is the working reference.
