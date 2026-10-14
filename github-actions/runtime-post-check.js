// Temporary, authorized one-item check. No follow or like operations.
const fs = require('node:fs/promises');
const { chromium } = require('playwright');
const { readConfig, safeError } = require('./lib/config');
const { loadState, saveState } = require('./lib/state');
const { fetchRanking, buildPostContent } = require('./lib/ranking');
const { openCollect, postItem } = require('./lib/room');
const { operationOf, snapshot } = require('./lib/diagnostics');
async function main() {
  const config = readConfig({ ...process.env, RUN_ACCOUNT: 'account1', RUN_MODE: 'run', MAX_ITEMS: '1' });
  const account = config.accounts[0];
  const browser = await chromium.launch({ headless: true });
  let context, page, authenticated = false;
  const result = { account: 'account1', mode: 'run', followAttempts: 0, likeAttempts: 0, posted: 0, skipped: 0, ok: false };
  try {
    context = await browser.newContext({ storageState: await loadState(config, account), locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1365, height: 900 } });
    page = await context.newPage();
    const [item] = await fetchRanking(account, config);
    await openCollect(page, item.itemCode, account);
    authenticated = true;
    const outcome = await postItem(page, item, () => buildPostContent(item, config), account);
    result[outcome]++; result.ok = true;
    console.log(`account1: 投稿確認 ${result.posted}件 / コレ済み ${result.skipped}件（フォロー・いいねの再実行なし）`);
  } catch (error) {
    result.error = safeError(error); result.operation = operationOf(error); result.ui = page ? await snapshot(page) : { screen: 'unavailable' };
    console.error(`account1 [${result.operation}] ${result.error}`);
    console.error(`account1: UI ${JSON.stringify(result.ui)}`);
    process.exitCode = 1;
  } finally {
    if (authenticated) await saveState(config, account, await context.storageState({ indexedDB: true }));
    await browser.close();
    await fs.mkdir('reports', { recursive: true });
    await fs.writeFile('reports/summary.json', JSON.stringify(result));
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `\naccount1: 投稿確認 ${result.posted} / コレ済み ${result.skipped}\n\n${result.error || '確認完了'}\n`);
  }
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
