const KNOWN_MESSAGES = ["既にこの商品はROOMから削除されています", "商品情報がありません", "登録上限に達しました。他の商品を削除してからコレ！してください。", "既にこの商品は楽天市場から削除されています", "すでにコレ[[!]]している商品です", "編集できない情報です", "既にこのコーディネートはROOMから削除されています", "登録上限に達しました。他のコレクションを削除してから登録してください。", "この商品は削除されたか、表示できません。", "ご利用ができない文字列を含むため、登録できません。", "登録に失敗しました。", "興味設定に失敗しました。"];
// Temporary read-only probe: no post, follow or like clicks.
const { chromium } = require('playwright');
const { readConfig, safeError } = require('./lib/config');
const { loadState } = require('./lib/state');
const { fetchRanking, buildPostContent } = require('./lib/ranking');
const { openCollect, prepareCollect, diagnoseSocial } = require('./lib/room');
const { snapshot } = require('./lib/diagnostics');
async function main() {
  const config = readConfig({ ...process.env, RUN_ACCOUNT: 'account3', RUN_MODE: 'diagnose', MAX_ITEMS: '1' });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const account of config.accounts) {
      let context, page;
      try {
        context = await browser.newContext({ storageState: await loadState(config, account), locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1365, height: 900 } });
        context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(30000);
        page = await context.newPage();
        const [item] = await fetchRanking(account, config, { random: () => 0.5 });
        await openCollect(page, item.itemCode, account);
        // Short read-only reproduction for the same ranking item.

        const state = await openCollect(page, item.itemCode, account);
        if (state === 'duplicate') { console.log(`${account.name}: コレ済みのためクリック診断省略`); continue; }
        await prepareCollect(page, await buildPostContent(item, { ...config, useOpenAI: false }));
        await page.locator('button.collect-btn:visible, input.collect-btn[type="submit"]:visible').click({ trial: true, timeout: 5000 });
        console.log(`${account.name}: 一覧スクロール後の投稿ボタンtrial成功（未送信）`);
      } catch (error) {
        console.error(`${account.name}: ${safeError(error)}`);
        console.error(`${account.name}: UI ${JSON.stringify(page ? await snapshot(page) : { screen: 'unavailable' })}`);
        if (page) {
          const modal = await page.evaluate(known => {
            const normalize = value => value.replace(/<[^>]*>/g, '').replace(/[\s!！\[\]]/g, '');
            const captions = [...document.querySelectorAll('.dialog-container .caption')].filter(el => el.getClientRects().length).map(el => normalize(el.innerText));
            return { visibleCaptions: captions.length, knownMessages: known.map((message, index) => ({ message, index })).filter(({message}) => message.length > 5 && captions.some(caption => caption.startsWith(normalize(message)))).map(({index}) => index), duplicateText: /すでにコレ[\s!！\[\]]*(?:している|してい|済み|されています)/.test(document.body?.innerText || '') };
          }, KNOWN_MESSAGES);
          console.log(`${account.name}: MODAL ${JSON.stringify(modal)}`);
        }
        process.exitCode = 1;
        if (page) {
          await page.setViewportSize({ width: 1365, height: 1600 });
          try {
            await page.locator('button.collect-btn:visible, input.collect-btn[type="submit"]:visible').click({ trial: true, timeout: 5000 });
            console.log(`${account.name}: 高さ1600でtrial成功（未送信）`);
          } catch (next) {
            console.error(`${account.name}: 高さ1600でも ${safeError(next)}`);
            console.error(`${account.name}: UI ${JSON.stringify(await snapshot(page))}`);
          }
        }
      } finally { await context?.close(); }
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
