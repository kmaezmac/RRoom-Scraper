// Keep this version and both workflow container tags aligned with package-lock.json.
const expected = '1.60.0';
const { version } = require('playwright/package.json');
const { chromium } = require('playwright');
(async () => {
  if (version !== expected) {
    console.error('Playwright version mismatch: update the workflow container tags and runtime check together');
    process.exitCode = 1;
    return;
  }
  const browser = await chromium.launch({ headless: true, timeout: 30000 });
  try {
    const page = await browser.newPage();
    await page.setContent('<p>browser ready</p>');
    if (await page.textContent('p') !== 'browser ready') throw new Error('Browser check failed');
    console.log('Bundled Chromium version and launch verified');
  } finally { await browser.close(); }
})().catch(() => {
  console.error('Bundled Chromium could not start; posting has not started');
  process.exitCode = 1;
});
