const { chromium } = require('playwright');
require('dotenv').config({ path: '../.env' });
const axios = require('axios');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function logError(context, error) {
  console.error(`=== ${context}エラー ===`);
  console.error("エラーメッセージ:", error.message);
  if (error.response) {
    console.error("ステータスコード:", error.response.status);
    console.error("レスポンスデータ:", JSON.stringify(error.response.data, null, 2));
  } else if (error.request) {
    console.error("リクエストが送信されましたが、レスポンスがありません");
  } else {
    console.error("エラー詳細:", error);
  }
  console.error("========================");
}

function buildRakutenApiUrl(appId, age, page) {
  return `https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601?applicationId=${appId}&age=${age}&sex=1&carrier=0&page=${page}&accessKey=${process.env.ACCESS_TOKEN}`;
}

async function handleLoginIfRedirected(page, userId, password, returnUrl) {
  if (!page.url().includes('login.account.rakuten.com')) return;

  console.log('  ログイン画面を検出、ログインを実行します');

  await page.fill('#user_id', userId);
  await page.click('#cta001');
  await page.fill('#password_current', password);
  await page.click('#cta011');
  await page.waitForURL('**/room.rakuten.co.jp/**', { timeout: 30000 });
  await sleep(2000);
  console.log('  ログイン完了');

  await page.goto(returnUrl, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
}

async function fetchRakutenRankingItems(requestUrl, context, userId, password) {
  console.log(requestUrl);

  try {
    const response = await axios.get(requestUrl, {
      headers: {
        'Authorization': `Bearer ${process.env.ACCESS_TOKEN}`
      }
    });

    if (response.status !== 201 && response.data.Items) {
      for (let i = 0; i < response.data.Items.length; i++) {
        const item = response.data.Items[i].Item;
        console.log((i + 1).toString() + "件目スタート");
        console.log(item.itemCode);

        await postItemToRakutenRoom(item.itemCode, item.itemCaption, item.itemName, item.catchcopy, context, userId, password);
        console.log("完了");
        await sleep(5000);
      }
    }
  } catch (error) {
    logError("APIリクエスト", error);
  }
}

async function postItemToRakutenRoom(itemCode, description, itemName, catchcopy, context, userId, password) {
  const page = await context.newPage();

  try {
    const url = `https://room.rakuten.co.jp/mix?itemcode=${itemCode}&scid=we_room_upc60`;

    console.log("ページに移動中");
    console.log(url);

    await page.goto(url, { waitUntil: 'domcontentloaded' });

    await handleLoginIfRedirected(page, userId, password, url);

    console.log("ページ読み込み完了");

    await page.waitForSelector("#collect-content", { state: 'visible' });
    // item_keyがセットされるまで待つ（商品データの非同期取得完了を確認）
    try {
      await page.waitForFunction(
        () => {
          const el = document.querySelector('input[name="item_key"]');
          return el && el.value !== '';
        },
        { timeout: 10000 }
      );
    } catch {
      console.log('item_key待機タイムアウト、そのまま続行');
    }
    console.log("コレクト画面表示確認");

    if (await isAlreadyCollected(page)) {
      console.log("「すでにコレしている商品です」のため処理を終了");
      await page.close();
      return;
    }

    const postContent = buildPostContent(itemName, catchcopy, description);
    console.log(postContent);

    await page.fill('#collect-content', postContent);
    await page.click('.collect-btn');
    await sleep(3000);
    console.log("投稿完了");
    await page.close();
  } catch (error) {
    console.error("=== Playwright処理エラー ===");
    console.error("商品コード:", itemCode);
    console.error("エラーメッセージ:", error.message);
    console.error("========================");
    try { await page.close(); } catch (e) {}
  }
}

async function isAlreadyCollected(page) {
  try {
    await page.waitForSelector(".modal-dialog-container", { state: 'visible', timeout: 500 });
    return true;
  } catch {
    return false;
  }
}

function buildPostContent(itemName, catchcopy, description) {
  return itemName + catchcopy + description.substring(0, 200) + " #あったら便利 #欲しいものリスト #ランキング #人気 #楽天市場";
}

async function processAccount(accountName, appId, userId, password) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext();

  try {
    console.log(`=== ${accountName}の処理を開始 ===`);

    const ages = [20, 30, 40];
    const age = ages[Math.floor(Math.random() * ages.length)];
    const page = Math.floor(Math.random() * 34) + 1;
    const requestUrl = buildRakutenApiUrl(appId, age, page);

    await fetchRakutenRankingItems(requestUrl, context, userId, password);
    console.log(`=== ${accountName}の処理完了 ===`);
  } catch (error) {
    logError(accountName, error);
  } finally {
    await browser.close();
  }
}

(async () => {
  const runAccount = process.env.RUN_ACCOUNT || 'both';

  if (runAccount === 'both' || runAccount === 'account1') {
    await processAccount("アカウント1", process.env.RAKUTEN_APP_ID, process.env.RAKUTEN_USER_ID, process.env.RAKUTEN_PASSWORD);
  }
  if (runAccount === 'both' || runAccount === 'account2') {
    await processAccount("アカウント2", process.env.RAKUTEN_APP_ID2, process.env.RAKUTEN_USER_ID2, process.env.RAKUTEN_PASSWORD2);
  }
})();
