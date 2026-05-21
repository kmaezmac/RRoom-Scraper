const puppeteer = require("puppeteer");
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

async function loginToRakuten(browser, userId, password) {
  const page = await browser.newPage();
  try {
    console.log(`  ログイン開始: ${userId}`);
    const loginUrl = 'https://login.account.rakuten.com/sso/authorize?client_id=rakuten_room_web&redirect_uri=https://room.rakuten.co.jp/common/callback&scope=openid&response_type=code';
    await page.goto(loginUrl, { waitUntil: 'load' });

    // ユーザーID入力
    await page.waitForSelector('#user_id');
    await page.type('#user_id', userId);
    await page.click('#cta001');

    // パスワード入力
    await page.waitForSelector('#password_current');
    await page.type('#password_current', password);

    // 次へボタン押下 → ログイン完了まで待機
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load' }),
      page.click('#cta011'),
    ]);

    console.log(`  ログイン完了: ${userId}`);
  } finally {
    await page.close();
  }
}

async function fetchRakutenRankingItems(requestUrl, browser) {
  console.log("APIリクエストURL:", requestUrl);

  try {
    const response = await axios.get(requestUrl, {
      headers: {
        'Authorization': `Bearer ${process.env.ACCESS_TOKEN}`
      }
    });

    if (response.status !== 201 && response.data.Items) {
      for (let i = 0; i < response.data.Items.length; i++) {
        const item = response.data.Items[i].Item;
        console.log(`\n[${i + 1}/${response.data.Items.length}] 商品の投稿を開始`);
        console.log(`商品コード: ${item.itemCode}`);

        await postItemToRakutenRoom(item.itemCode, item.itemCaption, item.itemName, item.catchcopy, browser);
        console.log(`[${i + 1}/${response.data.Items.length}] 完了`);
        await sleep(5000);
      }
    }
  } catch (error) {
    logError("APIリクエスト", error);
  }
}

async function postItemToRakutenRoom(itemCode, description, itemName, catchcopy, browser) {
  let page = null;

  try {
    page = await browser.newPage();
    const url = `https://room.rakuten.co.jp/mix?itemcode=${itemCode}&scid=we_room_upc60`;

    console.log("  ページに移動中:", url);
    await page.setDefaultNavigationTimeout(30000);
    await page.goto(url);
    console.log("  ページ読み込み完了");

    await page.waitForSelector("#collect-content", { visible: true });
    console.log("  コレクト画面表示確認");

    if (await isAlreadyCollected(page)) {
      console.log("  スキップ: すでにコレ済みの商品です");
      await page.close();
      return;
    }

    const postContent = buildPostContent(itemName, catchcopy, description);
    await submitCollectForm(page, postContent);
    console.log("  投稿完了");
    await page.close();
  } catch (error) {
    console.error("=== Puppeteer処理エラー ===");
    console.error("商品コード:", itemCode);
    console.error("エラーメッセージ:", error.message);
    console.error("エラー詳細:", error);
    console.error("========================");

    if (page) {
      try { await page.close(); } catch (e) {}
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

function buildPostContent(itemName, catchcopy, description) {
  return itemName + catchcopy + description.substring(0, 200) + " #あったら便利 #欲しいものリスト #ランキング #人気 #楽天市場";
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

async function processAccount(accountName, userId, password, appId) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    console.log(`=== ${accountName}の処理を開始 ===`);

    await loginToRakuten(browser, userId, password);

    const ages = [20, 30, 40];
    const age = ages[Math.floor(Math.random() * ages.length)];
    const page = Math.floor(Math.random() * 34) + 1;
    const requestUrl = buildRakutenApiUrl(appId, age, page);

    await fetchRakutenRankingItems(requestUrl, browser);
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
    await processAccount("アカウント1", process.env.RAKUTEN_USER_ID, process.env.RAKUTEN_PASSWORD, process.env.RAKUTEN_APP_ID);
  }
  if (runAccount === 'both' || runAccount === 'account2') {
    await processAccount("アカウント2", process.env.RAKUTEN_USER_ID2, process.env.RAKUTEN_PASSWORD2, process.env.RAKUTEN_APP_ID2);
  }
})();
