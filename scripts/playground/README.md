# Playground blueprint sources

`../playground.js` builds `.wordpress-org/blueprints/blueprint.json` from the two PHP files here. Edit the PHP, then run `npm run playground:build` and commit both. CI runs `npm run playground:check`.

| File | Becomes |
|---|---|
| `demo-content.php` | The blueprint's `runPHP` step. Seeds the admin's editor preferences (no welcome guide; the four default tools plus the Typography Stylist block pinned, with a custom name and description) and publishes the demo post at ID 2026, which `landingPage` opens in the editor. |
| `demo-fonts.php` | A must-use plugin the blueprint writes into `wp-content/mu-plugins/`. Declares Vollkorn from Twenty Twenty-Five's own font files, for the two Typography Stylist blocks in the demo post. |

## Try it

- `npm run playground` runs the demo against this checkout in the Playground CLI (Node 20.18+). Open the URL it prints.
- `npm run playground:url` prints a playground.wordpress.net link that installs the plugin from the latest GitHub Release zip. The zip must be public: the URL only works while the repository is public, or with `--zip=<other public url>`.
- The committed `blueprint.json` installs the plugin by its WordPress.org slug. That resolves only once the plugin is listed. WordPress.org syncs `.wordpress-org/` into the plugin's SVN assets; a committer then turns the Live Preview on from the plugin's Advanced view.

## The font claims are verified, not assumed

The demo post's copy names OpenType features. Each was checked against the GSUB table of Twenty Twenty-Five's `assets/fonts/vollkorn/Vollkorn-VariableFont_wght.woff2` (fontTools, 2026-09-04):

| Feature | Substitutions with plain letters |
|---|---|
| `dlig` | Th, ch, ct, fb, fh, fk, fty, st, ty, www |
| `liga` | ff, ffi, ffj, ffl, fft, fi, fj, fl, ft |
| `ss01` | &, M, N, Q, a, g, j, y |
| `calt` | R (contextual) |

"Editrail" contains none of the ligature pairs, so the headline block turns on `ss01` (the alternate "a" in "Editrail") and the tagline carries the ligatures: "**Th**e ar**ch**ite**ct**'s toolbar. Pick a tool **fi**r**st**, then click the canvas; every block **st**ays a core block." A caption that claims a feature the letters cannot show is worse than none, so change the copy and the feature list together.

## Block validity

The Typography Stylist block is serialized by hand in `demo-content.php` to match the block's `save()` byte for byte: attribute JSON escaped like `serializeAttributes()`, `wp_slash()` around the insert, style properties in `buildStyle()`'s order, and numbers printed the way JavaScript prints them. Open the demo post in the editor after any change to that function: an invalid block shows the "This block contains unexpected or invalid content" notice.
