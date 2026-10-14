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
    page.on('response', async response => {
      try {
        const url = new URL(response.url());
        if (url.hostname !== 'room.rakuten.co.jp' || url.pathname !== '/api/collect' || response.request().method() !== 'POST') return;
        const params = new URLSearchParams(response.request().postData() || '');
        const body = await response.json().catch(() => null);
        const serialized = JSON.stringify(body || {});
        const known = ['content', 'item_key', 'name', 'pictures', 'bu', 'csrf_tkn'];
        const facts = {
          http: response.status(), json: !!body,
          requestContentLength: (params.get('content') || '').length,
          requestNameLength: (params.get('name') || '').length,
          itemKeyPresent: !!params.get('item_key'), csrfPresent: url.searchParams.has('csrf_tkn') || params.has('csrf_tkn'),
          codePresent: typeof body?.msg_code === 'string',
          validationFields: known.filter(key => Object.hasOwn(body?.message || {}, key) || Object.hasOwn(body?.errors || {}, key)),
          requiredError: /required|必須|必要/i.test(serialized),
          lengthError: /length|文字数|長すぎ|長過ぎ/i.test(serialized),
          csrfError: /csrf|token|トークン/i.test(serialized),
          invalidError: /invalid|不正/i.test(serialized),
          blockedError: /blocked|denied|制限|拒否/i.test(serialized),
        };
        console.log('account1: POST検証 ' + JSON.stringify(facts));
      } catch { console.log('account1: POST検証 unavailable'); }
    });
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
