const puppeteer = require("puppeteer-core");
require('dotenv').config();
const axios = require('axios');

const USE_PLAYWRIGHT = process.env.USE_PLAYWRIGHT === 'true';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function logError(context, error) {
  console.error(`=== ${context}エラー ===`);
  console.error("エラーメッセージ:", error.message);
  if (error.response) {
    console.error("ステータスコード:", error.response.status);
    console.error("レスポンスデータ:", JSON.stringify(error.response.data, null, 2));
    console.error("レスポンスヘッダー:", JSON.stringify(error.response.headers, null, 2));
  } else if (error.request) {
    console.error("リクエストが送信されましたが、レスポンスがありません");
    console.error("リクエスト情報:", error.request);
  } else {
    console.error("エラー詳細:", error);
  }
  console.error("========================");
}

function buildRakutenApiUrl(appId, age, page) {
  return `https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601?applicationId=${appId}&age=${age}&sex=1&carrier=0&page=${page}&accessKey=${process.env.ACCESS_TOKEN}`;
}

function buildPostContent(itemName, catchcopy, description) {
  return itemName + catchcopy + description.substring(0, 200) + " #あったら便利 #欲しいものリスト #ランキング #人気 #楽天市場";
}

// =====================
// puppeteer-core モード（既存・動作確認済み）
// =====================

async function fetchRakutenRankingItems(requestUrl, browserPort) {
  console.log(requestUrl);
  console.log("使用ブラウザポート:", browserPort);

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
        console.log(item.itemCaption);

        await postItemToRakutenRoom(item.itemCode, item.itemCaption, item.itemName, item.catchcopy, browserPort);
        console.log("完了");
        await sleep(5000);
      }
    }
  } catch (error) {
    logError("APIリクエスト", error);
  }
}

async function postItemToRakutenRoom(itemCode, description, itemName, catchcopy, browserPort = 9222) {
  let page = null;

  try {
    const browser = await puppeteer.connect({
      browserURL: `http://localhost:${browserPort}`,
      defaultViewport: null
    });

    page = await browser.newPage();
    const url = `https://room.rakuten.co.jp/mix?itemcode=${itemCode}&scid=we_room_upc60`;

    console.log("ページに移動中");
    console.log(url);

    await page.setDefaultNavigationTimeout(30000);
    await page.goto(url);
    console.log("ページ読み込み完了");

    await page.waitForSelector("#collect-content", { visible: true });
    console.log("コレクト画面表示確認");

    if (await isAlreadyCollected(page)) {
      console.log("「すでにコレしている商品です」のため処理を終了");
      await page.close();
      return;
    }

    const postContent = buildPostContent(itemName, catchcopy, description);
    console.log(postContent);

    await submitCollectForm(page, postContent);
    await page.close();
  } catch (error) {
    console.error("=== Puppeteer処理エラー ===");
    console.error("商品コード:", itemCode);
    console.error("エラーメッセージ:", error.message);
    console.error("エラー詳細:", error);
    console.error("========================");

    if (page) {
      try { await page.close(); } catch (closeError) {}
    }
  }
}

async function isAlreadyCollected(page) {
  try {
    await page.waitForSelector(".modal-dialog-container", { visible: true, timeout: 500 });
    return await page.$(".modal-dialog-container") !== null;
  } catch (error) {
    return false;
  }
}

async function submitCollectForm(page, content) {
  await page.waitForSelector("#collect-content", { visible: true });
  await page.click("#collect-content");
  await page.evaluate((text) => {
    const element = document.querySelector("#collect-content");
    element.value = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, content);

  await page.waitForSelector("button", { visible: true });
  await page.click('xpath=//*[@id="scroller"]/div[4]/div[6]/div[1]/button', { visible: true });
}

async function processAccount(accountName, appId, browserPort) {
  try {
    console.log(`=== ${accountName}の処理を開始 ===`);

    const ages = [20, 30, 40];
    const age = ages[Math.floor(Math.random() * ages.length)];
    const page = Math.floor(Math.random() * 34) + 1;
    const requestUrl = buildRakutenApiUrl(appId, age, page);

    await fetchRakutenRankingItems(requestUrl, browserPort);
    console.log(`=== ${accountName}の処理完了 ===`);
  } catch (error) {
    logError(accountName, error);
  }
}

// =====================
// Playwright モード（USE_PLAYWRIGHT=true で有効）
// =====================

async function fetchRakutenRankingItemsPw(requestUrl, context, userId, password) {
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

        await postItemToRakutenRoomPw(item.itemCode, item.itemCaption, item.itemName, item.catchcopy, context, userId, password);
        console.log("完了");
        await sleep(5000);
      }
    }
  } catch (error) {
    logError("APIリクエスト", error);
  }
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
  await sleep(3000); // 商品データの非同期取得を待つ
}

async function postItemToRakutenRoomPw(itemCode, description, itemName, catchcopy, context, userId, password) {
  const page = await context.newPage();

  try {
    const url = `https://room.rakuten.co.jp/mix?itemcode=${itemCode}&scid=we_room_upc60`;

    console.log("ページに移動中");
    console.log(url);

    await page.goto(url, { waitUntil: 'domcontentloaded' });

    await handleLoginIfRedirected(page, userId, password, url);

    console.log("ページ読み込み完了");

    // #collect-content とコレ済みモーダルのどちらが先に出るか待つ
    const appeared = await Promise.race([
      page.waitForSelector("#collect-content", { state: 'visible', timeout: 15000 }).then(() => 'content'),
      page.waitForSelector(".modal-dialog-container", { state: 'visible', timeout: 15000 }).then(() => 'modal'),
    ]);

    if (appeared === 'modal') {
      console.log("「すでにコレしている商品です」のため処理を終了");
      await page.close();
      return;
    }

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

    const postContent = buildPostContent(itemName, catchcopy, description);
    console.log(postContent);

    page.on('request', req => {
      if (req.method() === 'POST') {
        console.log('  [POST]', req.url());
        console.log('  [POST body]', req.postData());
      }
    });

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

async function processAccountPw(accountName, appId, userId, password) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  try {
    console.log(`=== ${accountName}の処理を開始 ===`);

    const ages = [20, 30, 40];
    const age = ages[Math.floor(Math.random() * ages.length)];
    const page = Math.floor(Math.random() * 34) + 1;
    const requestUrl = buildRakutenApiUrl(appId, age, page);

    await fetchRakutenRankingItemsPw(requestUrl, context, userId, password);
    console.log(`=== ${accountName}の処理完了 ===`);
  } catch (error) {
    logError(accountName, error);
  } finally {
    await browser.close();
  }
}

// =====================
// エントリーポイント
// =====================

(async () => {
  if (USE_PLAYWRIGHT) {
    console.log("=== Playwright モードで実行 ===");
    await processAccountPw("アカウント1", process.env.RAKUTEN_APP_ID, process.env.RAKUTEN_USER_ID, process.env.RAKUTEN_PASSWORD);
    await processAccountPw("アカウント2", process.env.RAKUTEN_APP_ID2, process.env.RAKUTEN_USER_ID2, process.env.RAKUTEN_PASSWORD2);
  } else {
    console.log("=== puppeteer-core モードで実行 ===");
    await processAccount("アカウント1", process.env.RAKUTEN_APP_ID, 9222);
    await processAccount("アカウント2", process.env.RAKUTEN_APP_ID2, 9223);
  }
})();
