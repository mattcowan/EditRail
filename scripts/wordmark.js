/**
 * Render the WordPress.org icon and banner from scripts/wordmark/wordmark.html.
 *
 *   node scripts/wordmark.js
 *
 * Writes into .wordpress-org/:
 *   banner-1544x500.png, banner-772x250.png, icon-256x256.png, icon-128x128.png
 *
 * The page is designed at the large size and rendered again with CSS zoom
 * 0.5 for the small one, so both sizes come from one layout. The SVG icon
 * (.wordpress-org/icon.svg) is the same drawing and is committed by hand.
 * Needs Playwright's Chromium, which the e2e suite already installs.
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const rootDir = path.resolve(__dirname, '..');
const htmlFile = path.join(__dirname, 'wordmark', 'wordmark.html');
const outDir = path.join(rootDir, '.wordpress-org');

const JOBS = [
  { view: 'banner', zoom: 1, width: 1544, height: 500, file: 'banner-1544x500.png' },
  { view: 'banner', zoom: 0.5, width: 772, height: 250, file: 'banner-772x250.png' },
  { view: 'icon', zoom: 1, width: 256, height: 256, file: 'icon-256x256.png' },
  { view: 'icon', zoom: 0.5, width: 128, height: 128, file: 'icon-128x128.png' },
];

(async () => {
  if (!fs.existsSync(htmlFile)) {
    console.error(`x Missing ${path.relative(rootDir, htmlFile)}`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const job of JOBS) {
      const page = await browser.newPage({
        viewport: { width: job.width, height: job.height },
        deviceScaleFactor: 1,
      });
      const url = 'file:///' + htmlFile.split(path.sep).join('/') + `?view=${job.view}&zoom=${job.zoom}`;
      await page.goto(url);
      // Let the web font arrive; fall back to the system stack if it does not.
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const out = path.join(outDir, job.file);
      await page.screenshot({ path: out, type: 'png', clip: { x: 0, y: 0, width: job.width, height: job.height } });
      console.log(`ok  ${path.relative(rootDir, out)} (${job.width}x${job.height})`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
