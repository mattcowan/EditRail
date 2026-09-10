/**
 * Record a short screen clip of EditRail's two drag gestures.
 *
 * Stage 1 — a block dragged out of the core inserter and dropped on the
 * toolbar pins it as a new tool. Stage 2 — that new tool dragged off the
 * toolbar and dropped between two blocks inserts its block there.
 *
 * Both legs are REAL HTML5 drags driven through Playwright's mouse API
 * (mouse.down, many small mouse.move steps, mouse.up), not synthetic
 * DragEvent dispatch: a synthetic event shows nothing on camera.
 *
 * Playwright's recorder does not draw the pointer, so the script injects
 * a fake cursor into the top document and moves it from real pointer
 * events (mousemove in the top document, dragover while a drag is in
 * flight, and the same pair inside the editor-canvas iframe, offset by
 * the iframe's own position). The clip therefore shows a pointer that
 * tracks the drag across the iframe boundary.
 *
 * The post is NEVER saved: autosave REST calls are aborted at the route
 * level and the browser closes as soon as the last beat ends.
 *
 * Usage (from the plugin root):
 *   NODE_PATH="$PWD/node_modules" node scripts/record-drag.js [outDir]
 *
 * Environment:
 *   EDITRAIL_URL    site root          (default http://127.0.0.1:9400)
 *   EDITRAIL_POST   post ID to open    (default 2026)
 *   EDITRAIL_USER   admin login        (default admin)
 *   EDITRAIL_PASS   admin password     (default password)
 *
 * The script writes <outDir>/raw/*.webm plus <outDir>/record-drag.json,
 * which carries `trimSeconds` (how much setup to cut off the front) and
 * `actionSeconds` (how long the clip itself runs). Convert with those two
 * numbers. Playwright's OWN bundled ffmpeg CANNOT do this: it ships with
 * png and VP8 encoders only, and with no mp4 or gif muxer. Use a full
 * build. MP4 (one line):
 *
 *   ffmpeg -ss <trimSeconds> -t <actionSeconds> -i raw/<file>.webm
 *     -r 30 -c:v libx264 -preset slow -crf 20 -profile:v high
 *     -pix_fmt yuv420p -movflags +faststart -an editrail-drag-to-pin.mp4
 *
 * GIF, in two passes so the palette is built from the real frames:
 *
 *   ffmpeg -i editrail-drag-to-pin.mp4
 *     -vf "scale=960:600:flags=lanczos,palettegen=max_colors=192:stats_mode=diff"
 *     palette.png
 *   ffmpeg -i editrail-drag-to-pin.mp4 -i palette.png
 *     -lavfi "scale=960:600:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle"
 *     -r 15 -loop 0 editrail-drag-to-pin.gif
 */
// @playwright/test is the declared dependency; `playwright` only happens to
// be hoisted next to it, and a stricter package manager would not hoist it.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE = process.env.EDITRAIL_URL || 'http://127.0.0.1:9400';
const POST_ID = process.env.EDITRAIL_POST || '2026';
const USER = process.env.EDITRAIL_USER || 'admin';
const PASS = process.env.EDITRAIL_PASS || 'password';
const BLOCK = 'typost/block';
const SEARCH_TERM = 'Typography';

const OUT_DIR = process.argv[2] || path.join(__dirname, '..', 'private', 'video');
const VIDEO_DIR = path.join(OUT_DIR, 'raw');

const VIEWPORT = { width: 1440, height: 900 };

/** Ease in and out, so a drag starts and stops the way a hand does. */
function ease(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

/** The fake cursor: markup, styles and the listeners that move it. */
const CURSOR_SCRIPT = () => {
  if (window.__editrailCursor) {
    return;
  }
  const style = document.createElement('style');
  style.textContent =
    '#editrail-fake-cursor{position:fixed;left:0;top:0;width:26px;height:30px;' +
    'z-index:2147483647;pointer-events:none;will-change:transform;' +
    'transition:none;transform:translate(-100px,-100px)}' +
    '#editrail-fake-cursor .ring{position:absolute;left:-9px;top:-9px;width:34px;' +
    'height:34px;border-radius:50%;background:rgba(37,99,235,.35);' +
    'box-shadow:0 0 0 2px rgba(37,99,235,.55);opacity:0;transform:scale(.5);' +
    'transition:opacity .12s ease,transform .12s ease}' +
    '#editrail-fake-cursor[data-press="1"] .ring{opacity:1;transform:scale(1)}';
  document.documentElement.appendChild(style);

  const el = document.createElement('div');
  el.id = 'editrail-fake-cursor';
  el.innerHTML =
    '<span class="ring"></span>' +
    '<svg width="26" height="30" viewBox="0 0 26 30" fill="none" ' +
    'xmlns="http://www.w3.org/2000/svg" style="position:relative;' +
    'filter:drop-shadow(0 2px 3px rgba(0,0,0,.55))">' +
    '<path d="M3 2 L3 23 L8.6 17.8 L12.3 26.4 L16.4 24.6 L12.8 16.2 L20.4 15.6 Z" ' +
    'fill="#ffffff" stroke="#111111" stroke-width="1.8" stroke-linejoin="round"/></svg>';
  document.documentElement.appendChild(el);

  window.__editrailCursor = el;
  window.__curSet = function (x, y) {
    el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  };
  window.__curPress = function (on) {
    el.dataset.press = on ? '1' : '0';
  };

  const TYPES = ['mousemove', 'dragover', 'dragenter', 'drag', 'mousedown', 'mouseup', 'drop'];
  TYPES.forEach(function (t) {
    document.addEventListener(
      t,
      function (e) {
        if (e.clientX || e.clientY) {
          window.__curSet(e.clientX, e.clientY);
        }
      },
      true
    );
  });

  // The canvas is an iframe: its pointer events never reach this
  // document, so mirror them up, offset by where the iframe sits.
  window.__curFrameHook = setInterval(function () {
    const frame = document.querySelector('iframe[name="editor-canvas"]');
    if (!frame) {
      return;
    }
    let doc = null;
    try {
      doc = frame.contentDocument;
    } catch (err) {
      return;
    }
    if (!doc || doc.__editrailCursorBound) {
      return;
    }
    doc.__editrailCursorBound = true;
    TYPES.forEach(function (t) {
      doc.addEventListener(
        t,
        function (e) {
          const r = frame.getBoundingClientRect();
          window.__curSet(e.clientX + r.left, e.clientY + r.top);
        },
        true
      );
    });
  }, 400);
};

/**
 * Record the clip: log in, open the demo post, unpin the block, drag it
 * from the inserter onto the toolbar, then drag the new tool into the
 * canvas. Writes the raw webm and record-drag.json (trim numbers) to the
 * output directory; the conversions are in the header.
 */
async function main() {
  fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
  fs.mkdirSync(VIDEO_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    args: ['--window-position=0,0', '--force-device-scale-factor=1'],
  });

  // Log in in a throwaway context so the login never reaches the video.
  const setupCtx = await browser.newContext({ viewport: VIEWPORT });
  const setupPage = await setupCtx.newPage();
  await setupPage.goto(BASE + '/wp-login.php');
  await setupPage.fill('#user_login', USER);
  await setupPage.fill('#user_pass', PASS);
  await setupPage.click('#wp-submit');
  await setupPage.waitForURL(/wp-admin/, { timeout: 30000 });
  const storageState = await setupCtx.storageState();
  await setupCtx.close();

  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    storageState,
    recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
  });

  // Never write to the post.
  await context.route('**/wp-json/wp/v2/posts/**/autosaves**', (route) => route.abort());
  await context.route('**/rest_route=**autosaves**', (route) => route.abort());

  const page = await context.newPage();
  const t0 = Date.now();

  // Parked on the document bar, not the canvas: resting the pointer over
  // the canvas makes core draw its own "+" insertion line in frame one.
  const cursor = { x: 620, y: 63 };

  /** Show the fake pointer pressed (button down) or released. */
  async function press(on) {
    await page.evaluate((v) => window.__curPress(v), on);
  }

  /** Move the real pointer, in eased steps; the fake cursor follows. */
  async function glide(x, y, opts) {
    const steps = (opts && opts.steps) || 34;
    const gap = (opts && opts.gap) || 12;
    const from = { x: cursor.x, y: cursor.y };
    for (let i = 1; i <= steps; i += 1) {
      const p = ease(i / steps);
      const nx = from.x + (x - from.x) * p;
      const ny = from.y + (y - from.y) * p;
      await page.mouse.move(nx, ny);
      await page.waitForTimeout(gap);
    }
    cursor.x = x;
    cursor.y = y;
  }

  /**
   * A full drag with the real mouse: press, glide to (x, y) in eased
   * steps, hold, release. opts: steps, gap (ms per step), hold (ms).
   */
  async function dragTo(x, y, opts) {
    await press(true);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await glide(x, y, { steps: (opts && opts.steps) || 55, gap: (opts && opts.gap) || 16 });
    await page.waitForTimeout((opts && opts.hold) || 450);
    await page.mouse.up();
    await press(false);
  }

  // ---------------------------------------------------------------
  // Setup — everything here is trimmed off the front of the clip.
  // ---------------------------------------------------------------
  await page.goto(BASE + '/wp-admin/post.php?post=' + POST_ID + '&action=edit');
  await page.waitForSelector('#toolrail-rail', { timeout: 60000 });
  await page.waitForTimeout(2500);

  const guideClose = page.locator('.components-modal__header button[aria-label="Close"]');
  if (await guideClose.count()) {
    await guideClose.first().click();
    await page.waitForTimeout(400);
  }

  const closeSidebar = page.locator('button[aria-label="Close Settings"]');
  if (await closeSidebar.count()) {
    await closeSidebar.first().click();
    await page.waitForTimeout(600);
  }

  // Start with the tool NOT on the toolbar. Unpinning also clears the
  // slot's author metadata (title, description, icon) AND any extension
  // data stored on the pin, so keep a copy of the whole entry and put it
  // back in the `finally` below — whether the clip made it or a wait
  // threw halfway. The site this runs against renames the slot for its
  // own demo, and a failed run must not eat that.
  const savedPin = await page.evaluate((name) => {
    const meta = window.toolrail.getPinMeta(name);
    // setPinMeta keeps only title/description/icon; extension data lives
    // under `ext` in the raw preference and is restored with setPinData.
    let ext = null;
    try {
      const raw = window.wp.data.select('core/preferences').get('toolrail', 'toolrail-pin-meta');
      const map = raw ? JSON.parse(raw) : {};
      ext = map[name] && map[name].ext ? map[name].ext : null;
    } catch (err) {
      ext = null;
    }
    return { meta: meta || null, ext };
  }, BLOCK);
  await page.evaluate((name) => window.toolrail.unpinBlock(name), BLOCK);
  await page.waitForSelector('#toolrail-rail [data-tool="pin:' + BLOCK + '"]', { state: 'detached' });

  let names = [];
  let tStart = 0;
  let tEnd = 0;
  try {

    // Top of the document, so the display headline leads the shot.
    await page
      .frameLocator('iframe[name="editor-canvas"]')
      .locator('body')
      .evaluate((body) => {
        body.ownerDocument.documentElement.scrollTop = 0;
      });

    await page.evaluate(CURSOR_SCRIPT);
    await page.mouse.move(cursor.x, cursor.y);
    await page.waitForTimeout(600);

    tStart = Date.now();

    // ---------------------------------------------------------------
    // 1. Open the inserter and search.
    // ---------------------------------------------------------------
    const inserterToggle = page.locator('button.editor-document-tools__inserter-toggle');
    const tb = await inserterToggle.boundingBox();
    await glide(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 30, gap: 14 });
    await page.waitForTimeout(220);
    await press(true);
    await inserterToggle.click();
    await page.waitForTimeout(140);
    await press(false);
    await page.waitForTimeout(550);

    const search = page.locator('.block-editor-inserter__menu input[type="search"], .block-editor-inserter__menu input[placeholder]').first();
    await search.waitFor({ timeout: 15000 });
    const sb = await search.boundingBox();
    await glide(sb.x + 40, sb.y + sb.height / 2, { steps: 22, gap: 13 });
    await press(true);
    await search.click();
    await page.waitForTimeout(120);
    await press(false);
    await search.type(SEARCH_TERM, { delay: 65 });

    const item = page
      .locator('.block-editor-block-types-list__item.editor-block-list-item-typost-block')
      .first();
    await item.waitFor({ timeout: 15000 });
    // The unfiltered list stays on screen for a moment after the last
    // keystroke, so measure only once the query has settled to one result.
    await page.waitForFunction(
      () => document.querySelectorAll('.block-editor-block-types-list__item').length === 1,
      null,
      { timeout: 15000 }
    );
    await page.waitForTimeout(450);

    // ---------------------------------------------------------------
    // 2. Drag it out of the inserter and drop it on the toolbar.
    // ---------------------------------------------------------------
    const ib = await item.boundingBox();
    await glide(ib.x + ib.width / 2, ib.y + ib.height / 2, { steps: 26, gap: 14 });
    await page.waitForTimeout(150);

    const region = await page.locator('#toolrail-region').boundingBox();
    const lastPin = await page.locator('#toolrail-rail [data-tool^="pin:"]').last().boundingBox();
    await dragTo(region.x + region.width / 2, lastPin.y + lastPin.height + 26, {
      steps: 58,
      gap: 17,
      hold: 520,
    });

    const newTool = page.locator('#toolrail-rail [data-tool="pin:' + BLOCK + '"]');
    await newTool.waitFor({ timeout: 15000 });
    await page.waitForTimeout(550);

    // Close the inserter so the whole toolbar and the new tool are seen.
    await glide(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 26, gap: 13 });
    await press(true);
    await inserterToggle.click();
    await page.waitForTimeout(140);
    await press(false);
    await page.waitForTimeout(600);

    // Rest on the new tool for a beat. The arrow is drawn DOWN and RIGHT of
    // its tip, so putting the tip below and right of the icon center keeps
    // the new tool readable under the pointer.
    const nb = await newTool.boundingBox();
    await glide(nb.x + nb.width * 0.68, nb.y + nb.height * 0.72, { steps: 22, gap: 14 });
    await page.waitForTimeout(850);

    // ---------------------------------------------------------------
    // 3. Drag the new tool into the canvas, between two blocks.
    // ---------------------------------------------------------------
    const canvas = page.frameLocator('iframe[name="editor-canvas"]');
    const target = canvas.locator('[data-type="' + BLOCK + '"]').first();
    const tgb = await target.boundingBox();
    await dragTo(tgb.x + tgb.width / 2, tgb.y + tgb.height * 0.88, {
      steps: 62,
      gap: 17,
      hold: 620,
    });

    await page.waitForTimeout(1300);

    names = await page.evaluate(() =>
      window.wp.data.select('core/block-editor').getBlocks().map((b) => b.name)
    );
    tEnd = Date.now();
  } finally {
    // After the last frame that matters (or after a failure): the rerender
    // it causes is past the trim point, so it never reaches the clip. The
    // pin has to exist before its metadata can be written back, and a
    // restore error must not mask the error that got us here.
    if (savedPin && (savedPin.meta || savedPin.ext)) {
      await page
        .evaluate((args) => {
          const [name, saved] = args;
          if (!window.toolrail.isPinned(name)) {
            window.toolrail.pinBlock(name);
          }
          if (saved.meta) {
            window.toolrail.setPinMeta(name, saved.meta);
          }
          if (saved.ext && typeof window.toolrail.setPinData === 'function') {
            Object.keys(saved.ext).forEach((ns) => {
              window.toolrail.setPinData(name, ns, saved.ext[ns]);
            });
          }
        }, [BLOCK, savedPin])
        .catch(() => {});
      // Let the preferences store's debounced REST write land.
      await page.waitForTimeout(2500).catch(() => {});
    }
  }

  await context.close();
  const raw = fs.readdirSync(VIDEO_DIR).filter((f) => f.endsWith('.webm'));
  await browser.close();

  const result = {
    video: raw.length ? path.join(VIDEO_DIR, raw[0]) : null,
    trimSeconds: Math.max(0, (tStart - t0) / 1000 - 0.35),
    actionSeconds: (tEnd - tStart) / 1000,
    blocks: names,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'record-drag.json'), JSON.stringify(result, null, 2));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
