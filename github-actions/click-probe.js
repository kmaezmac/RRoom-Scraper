// Temporary read-only probe: no post, follow or like clicks.
const { chromium } = require('playwright');
const { readConfig, safeError } = require('./lib/config');
const { loadState } = require('./lib/state');
const { fetchRanking, buildPostContent } = require('./lib/ranking');
const { openCollect, prepareCollect, diagnoseSocial } = require('./lib/room');
const { snapshot } = require('./lib/diagnostics');
async function main() {
  const config = readConfig({ ...process.env, RUN_MODE: 'diagnose', MAX_ITEMS: '1' });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const account of config.accounts) {
      let context, page;
      try {
        context = await browser.newContext({ storageState: await loadState(config, account), locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1365, height: 900 } });
        context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(30000);
        page = await context.newPage();
        const [item] = await fetchRanking(account, config);
        await openCollect(page, item.itemCode, account);
        await diagnoseSocial(page);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        const state = await openCollect(page, item.itemCode, account);
        if (state === 'duplicate') { console.log(`${account.name}: コレ済みのためクリック診断省略`); continue; }
        await prepareCollect(page, await buildPostContent(item, { ...config, useOpenAI: false }));
        await page.locator('button.collect-btn:visible, input.collect-btn[type="submit"]:visible').click({ trial: true, timeout: 15000 });
        console.log(`${account.name}: 一覧スクロール後の投稿ボタンtrial成功（未送信）`);
      } catch (error) {
        console.error(`${account.name}: ${safeError(error)}`);
        console.error(`${account.name}: UI ${JSON.stringify(page ? await snapshot(page) : { screen: 'unavailable' })}`);
        process.exitCode = 1;
      } finally { await context?.close(); }
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
