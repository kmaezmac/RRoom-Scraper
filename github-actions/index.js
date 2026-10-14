const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('node:fs/promises');
const { chromium } = require('playwright');
const { readConfig, safeError } = require('./lib/config');
const { loadState, saveState } = require('./lib/state');
const { fetchRanking, buildPostContent, sleep } = require('./lib/ranking');
const { openCollect, prepareCollect, diagnoseSocial, postItem, performFollow, performLike } = require('./lib/room');
const { snapshot, operationOf } = require('./lib/diagnostics');

async function processAccount(browser, config, account) {
  const result = { account: account.name, mode: config.mode, stage: 'session', posted: 0, skipped: 0, followAttempts: 0, likeAttempts: 0, warnings: [], ok: false };
  let context;
  let page;
  let authenticated = false;
  try {
    const storageState = await loadState(config, account);
    context = await browser.newContext({ storageState, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1365, height: 900 } });
    context.setDefaultTimeout(30000);
    context.setDefaultNavigationTimeout(30000);
    page = await context.newPage();
    result.stage = 'ranking';
    const items = await fetchRanking(account, config);
    result.rankingItems = items.length;
    console.log(`${account.name}: ランキング取得 ${items.length}件`);
    result.stage = 'login';
    const initialState = await openCollect(page, items[0].itemCode, account);
    authenticated = true;
    await saveState(config, account, await context.storageState({ indexedDB: true }));
    if (config.mode === 'diagnose') {
      result.stage = 'collect-preflight';
      if (initialState === 'form') {
        result.collectReady = await prepareCollect(page, await buildPostContent(items[0], { ...config, useOpenAI: false })) !== 'duplicate';
      } else {
        result.collectReady = false;
      }
      if (!result.collectReady) {
        result.warnings.push('DIAGNOSE_DUPLICATE: コレ済み商品のため入力・送信ボタンは未検証です');
      }
      result.stage = 'social-check';
      result.social = await diagnoseSocial(page);
      console.log(`${account.name}: フォロー候補 ${result.social.followCandidates}件 / いいね候補 ${result.social.likeCandidates}件（未操作）`);
      console.log(`${account.name}: ${result.collectReady ? 'API・認証・投稿入力欄・送信ボタン・一覧を確認' : 'API・認証・一覧を確認（コレ済みのため入力欄・送信ボタンは未検証）'}（投稿/フォロー/いいね未実行）`);
    } else {
      result.stage = 'follow';
      try { result.followAttempts = await performFollow(page); }
      catch (error) { result.warnings.push(`follow / ${operationOf(error)} / ${safeError(error)}`); console.warn(`${account.name}: ${result.warnings.at(-1)}`); }
      result.stage = 'like';
      try { result.likeAttempts = await performLike(page); }
      catch (error) { result.warnings.push(`like / ${operationOf(error)} / ${safeError(error)}`); console.warn(`${account.name}: ${result.warnings.at(-1)}`); }
      console.log(`${account.name}: フォロー操作 ${result.followAttempts}件 / いいね操作 ${result.likeAttempts}件`);
      result.stage = 'post';
      for (const item of items) {
        // Generate text only after ROOM confirms the product is not collected.
        const outcome = await postItem(page, item, () => buildPostContent(item, config), account);
        result[outcome]++;
        console.log(`${account.name}: 投稿確認 ${result.posted}件 / コレ済み ${result.skipped}件`);
        if (result.posted >= config.maxPosts) break;
        await sleep(5000);
      }
    }
    result.stage = result.warnings.length ? 'partial' : 'complete';
    result.ok = result.warnings.length === 0;
  } catch (error) {
    result.error = safeError(error);
    result.operation = operationOf(error);
    result.ui = page ? await snapshot(page) : { screen: 'unavailable' };
    console.error(`${account.name} [${result.stage}/${result.operation}] ${result.error}`);
    console.error(`${account.name}: UI ${JSON.stringify(result.ui)}`);
  } finally {
    if (context) {
      try { if (authenticated) await saveState(config, account, await context.storageState({ indexedDB: true })); }
      catch (error) { result.ok = false; result.stage = 'session-save'; result.error = safeError(error); }
      try { await context.close(); } catch { result.ok = false; result.error ||= 'BROWSER_CLOSE: ブラウザの終了に失敗しました'; }
    }
  }
  return result;
}
async function main() {
  const config = readConfig({ ...process.env, RUN_MODE: process.argv.includes('--diagnose') ? 'diagnose' : process.env.RUN_MODE });
  if (process.argv.includes('--check-config')) { console.log('設定チェック成功'); return; }
  const started = Date.now();
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    // Sequential execution keeps the existing account order and API pacing.
    for (const account of config.accounts) results.push(await processAccount(browser, config, account));
  } finally { await browser.close(); }
  const summary = { mode: config.mode, elapsedSeconds: Math.round((Date.now() - started) / 1000), results };
  const reportDir = path.join(__dirname, 'reports');
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, 'summary.json'), JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map(r => `| ${r.account} | ${r.ok ? '成功' : '失敗'} | ${r.stage} | ${r.posted} | ${r.skipped} | ${r.followAttempts} | ${r.likeAttempts} | ${[r.operation, r.error, ...r.warnings].filter(Boolean).join(' / ')} |`);
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `\nモード: ${config.mode} / 所要時間: ${summary.elapsedSeconds}秒\n\n| Account | 結果 | 段階 | 投稿確認 | コレ済み | フォロー操作 | いいね操作 | エラー |\n|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`);
  }
  if (results.some(result => !result.ok)) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
module.exports = { processAccount, main };
