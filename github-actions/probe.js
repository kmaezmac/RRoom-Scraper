// Public network check only: no dotenv, credentials, stored sessions or mutations.
const { chromium } = require('playwright');
const { inspectPage } = require('./lib/room');
const TARGET = 'https://room.rakuten.co.jp/';
const code = error => error?.message?.match(/net::[A-Z_]+/)?.[0] || error?.cause?.code || error?.name || 'UNKNOWN';
async function probe() {
  const start = Date.now();
  try {
    const response = await fetch(TARGET, { signal: AbortSignal.timeout(20000) });
    console.log(JSON.stringify({ check: 'http-document', status: response.status, elapsedMs: Date.now() - start }));
    await response.body?.cancel();
  } catch (error) { console.log(JSON.stringify({ check: 'http-document', error: code(error), elapsedMs: Date.now() - start })); }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: 'ja-JP' });
    const failedHosts = new Set();
    const pending = new Map();
    page.on('request', request => pending.set(request, { host: new URL(request.url()).hostname, type: request.resourceType() }));
    page.on('requestfinished', request => pending.delete(request));
    page.on('requestfailed', request => { pending.delete(request); failedHosts.add(new URL(request.url()).hostname); });
    page.on('response', response => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        console.log(JSON.stringify({ check: 'browser-document', status: response.status(), host: new URL(response.url()).hostname }));
      }
    });
    // Separate initial document connectivity from parser-blocking subresources.
    const response = await page.goto(TARGET, { waitUntil: 'commit', timeout: 30000 });
    if (response?.status() !== 200) throw new Error('HTTP_STATUS');
    try { await page.waitForLoadState('domcontentloaded', { timeout: 30000 }); }
    catch (error) {
      console.log(JSON.stringify({ check: 'dom-ready', error: code(error), pending: [...pending.values()].slice(0, 15), failedHosts: [...failedHosts].slice(0, 15) }));
      throw error;
    }
    console.log(JSON.stringify({ check: 'public-room', status: response.status(), state: await page.evaluate(inspectPage), failedHosts: [...failedHosts].slice(0, 15) }));
  } finally { await browser.close(); }
}
probe().catch(error => { console.error(`公開ページ確認失敗: ${code(error)}`); process.exitCode = 1; });
