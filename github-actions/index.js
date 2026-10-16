const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('node:fs/promises');
const { chromium } = require('playwright');
const { readConfig, safeError } = require('./lib/config');
const { loadState, saveState } = require('./lib/state');
const { fetchRanking, buildPostContent, sleep } = require('./lib/ranking');
const { openCollect, prepareCollect, diagnoseSocial, postItem, performFollow, performLike } = require('./lib/room');
const { snapshot, operationOf } = require('./lib/diagnostics');
const { assessRun, renderSummary } = require('./lib/report');
const { HistoryStore } = require('./lib/history');
const { isRoomEligible } = require('./lib/genres');
const { Candidates } = require('./lib/candidates');

async function processAccount(browser, config, account, { history = config.historyEnabled ? new HistoryStore(config, account) : null, ranking = fetchRanking, wait = sleep } = {}) {
  const result = { account: account.name, mode: config.mode, stage: 'session', posted: 0, skipped: 0, historySkipped: 0, deferred: 0, rankingPages: 0, followAttempts: 0, likeAttempts: 0, warnings: [], ok: false };
  let context;
  let page;
  let authenticated = false;
  let candidates;
  try {
    result.stage = 'ranking';
    let items;
    let firstItem;
    if (history && config.mode === 'run') {
      candidates = new Candidates(account, config, history, { ranking });
      await candidates.init();
      firstItem = await candidates.next();
      if (!firstItem) {
        result.warnings.push('CANDIDATES_EXHAUSTED: 取得上限内に未投稿候補がありません。次回は続きのページ・ジャンルを取得します');
        result.stage = 'partial';
        return result;
      }
    } else {
      if (history) await history.state(); // Diagnose DB access without writing history/cursors.
      items = (await ranking(account, config)).filter(isRoomEligible);
      result.rankingItems = items.length;
      result.rankingPages = 1;
      firstItem = items[0];
      if (!firstItem) {
        result.warnings.push('CANDIDATES_EXHAUSTED: 投稿対象の候補がありません');
        result.stage = 'partial';
        return result;
      }
    }
    const storageState = await loadState(config, account);
    context = await browser.newContext({ storageState, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1365, height: 900 } });
    context.setDefaultTimeout(30000);
    context.setDefaultNavigationTimeout(30000);
    page = await context.newPage();
    result.stage = 'login';
    const initialState = await openCollect(page, firstItem.itemCode, account);
    authenticated = true;
    await saveState(config, account, await context.storageState({ indexedDB: true }));
    if (config.mode === 'diagnose') {
      result.stage = 'collect-preflight';
      if (initialState === 'form') {
        result.collectReady = await prepareCollect(page, await buildPostContent(firstItem, { ...config, useOpenAI: false })) !== 'duplicate';
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
      let attempts = 0;
      let item = firstItem;
      while (item && attempts < config.maxItems) {
        const outcome = await postItem(page, item, () => buildPostContent(item, config), account,
          { beforeSubmit: () => history ? history.claim(item) : true });
        result[outcome]++;
        if (history && outcome !== 'deferred') await history.finish(item, outcome === 'posted' ? 'posted' : 'duplicate');
        candidates?.acknowledge();
        attempts++;
        console.log(`${account.name}: 投稿確認 ${result.posted}件 / コレ済み ${result.skipped}件 / 履歴競合 ${result.deferred}件`);
        if (result.posted >= config.maxPosts || attempts >= config.maxItems) break;
        await wait(5000);
        item = candidates ? await candidates.next() : items[attempts];
      }
      if (candidates && result.posted < config.maxPosts) {
        result.warnings.push('CANDIDATES_LIMIT: 候補または操作上限に達しました。投稿済み候補を再送せず次回へ進みます');
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
    if (candidates?.state) {
      if (result.error) candidates.restoreCurrent();
      result.historySkipped = candidates.historySkipped;
      result.rankingPages = candidates.pages;
      try { await candidates.save(); }
      catch (error) { result.ok = false; result.stage = 'history-save'; result.error = safeError(error); }
    }
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
  const summary = { mode: config.mode, elapsedSeconds: Math.round((Date.now() - started) / 1000), ...assessRun(config.mode, results) };
  const reportDir = path.join(__dirname, 'reports');
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, 'summary.json'), JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, renderSummary(summary));
  }
  if (summary.status === 'warning') console.warn('一部の処理にエラー・警告があります。投稿結果と詳細はSummaryを確認してください（ジョブは成功扱い）');
  process.exitCode = summary.exitCode;
}
if (require.main === module) main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
module.exports = { processAccount, main };
