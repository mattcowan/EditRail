# Playground blueprint sources

`../playground.js` builds `.wordpress-org/blueprints/blueprint.json` from the two PHP files here. Edit the PHP, then run `npm run playground:build` and commit both. CI runs `npm run playground:check`.

| File | Becomes |
|---|---|
| `demo-content.php` | The blueprint's `runPHP` step. Seeds the admin's editor preferences (no welcome guide; the four default tools plus the Typography Stylist block pinned, with a custom name and description) and publishes the demo post at ID 2026, which `landingPage` opens in the editor. |
| `demo-fonts.php` | A must-use plugin the blueprint writes into `wp-content/mu-plugins/`. Registers EB Garamond (upright and italic, SIL OFL 1.1, from the google/fonts repository) in theme.json, which is the WordPress Font Library, and declares the same two faces as inline `@font-face` for the editor canvas. |

## The font is picked the way an author would pick it

Typography Stylist's picker lists fonts from the WordPress Font Library, and choosing one "adopts" it: the plugin allocates a numeric `font_id`, and the block then saves `fontId` plus `font-family:var(--font-N)`. A block that only carries a family string renders, but the picker does not know it. So the `runPHP` step adopts EB Garamond through the plugin's own bridge (`Typography_Stylist::get_instance()->font_library_bridge()->adopt_library_font('eb-garamond')`), and every demo block is saved by that id, with `fontStyle: italic` where the italic is wanted. The editor shows EB Garamond as the selected font, and the plugin emits `--font-N` aliased to `--wp--preset--font-family--eb-garamond`. The editor's font list is cached per user for an hour; the step clears that cache.

## Try it

- `npm run playground` runs the demo against this checkout in the Playground CLI (Node 20.18+). Open the URL it prints.
- `npm run playground:url` prints a playground.wordpress.net link that installs the plugin from the latest GitHub Release zip. The zip must be public: the URL only works while the repository is public, or with `--zip=<other public url>`.
- The committed `blueprint.json` installs the plugin by its WordPress.org slug. That resolves only once the plugin is listed. WordPress.org syncs `.wordpress-org/` into the plugin's SVN assets; a committer then turns the Live Preview on from the plugin's Advanced view.

## The font claims are verified, not assumed

The demo post's copy names OpenType features. Each was checked against the GSUB tables of the google/fonts files `ofl/ebgaramond/EBGaramond[wght].ttf` and `EBGaramond-Italic[wght].ttf` (fontTools 4.63, 2026-09-09). These are the full variable fonts; the Google Fonts CSS service strips features, which is why the mu-plugin loads the repository files and not the service.

| Feature | Upright | Italic |
|---|---|---|
| `swsh` | Q only | every capital A–Z |
| `dlig` | Qy, Th, ch, ck, ct, fb, ff, ffb, ffh, ffi, ffj, ffk, ffl, fft, fh, fj, fk, ft, st, tt | Qy, Th, as, ch, ck, ct, es, fb, ffb, ffh, ffj, ffk, fft, fh, fj, fk, ft, gg, gj, gy, is, sk, sp, ss, st, tt, us |
| `liga` | ff, ffi, ffl, fi, fl | ff, ffi, ffl, fi, fl |
| `ss01` | a–z become petite capitals | a–z become petite capitals |

So the headline "EditRail" is set in the italic with `swsh`, which draws the E and the R with swashes. The tagline and the section headings are upright with `liga` only; the upright's `dlig` pairs (ct, st, ck) were tried on the tagline and read as a distraction at that size, so they stay off. The first pull quote, "Every Block Stays A Core Block", is italic with `swsh` and `ss01`: a swash on each capital, petite capitals for the rest. The second, "Pick What You Reach For. Move The Toolbar Where Your Hand Wants It.", is italic with `swsh` and `dlig`: a swash on every capital, and the ligatures on Pi**ck** and Rea**ch**. A caption that claims a feature the letters cannot show is worse than none, so change the copy and the feature list together.

## Block validity

The Typography Stylist block is serialized by hand in `demo-content.php` to match the block's `save()` byte for byte: attribute JSON escaped like `serializeAttributes()`, `wp_slash()` around the insert, style properties in `buildStyle()`'s order, and numbers printed the way JavaScript prints them. Open the demo post in the editor after any change to that function: an invalid block shows the "This block contains unexpected or invalid content" notice.
