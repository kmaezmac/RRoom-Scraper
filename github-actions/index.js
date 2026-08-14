const { chromium } = require('playwright');
require('dotenv').config({ path: '../.env' });
const axios = require('axios');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

function buildRakutenApiUrl(appId, sex, age, page) {
  return `https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601?applicationId=${appId}&age=${age}&sex=${sex}&carrier=0&page=${page}&accessKey=${process.env.ACCESS_TOKEN}`;
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

    // #collect-content とコレ済みモーダルのどちらが先に出るか待つ
    const appeared = await Promise.race([
      page.waitForSelector("#collect-content", { state: 'visible', timeout: 15000 }).then(() => 'content'),
      page.waitForSelector(".modal-dialog-container", { state: 'visible', timeout: 15000 }).then(() => 'modal'),
    ]);

    if (appeared === 'modal') {
      console.log("「すでにコレしている商品です」のためスキップ");
      await page.close();
      return;
    }

    // content が先に出た場合でもモーダルが続いて出ることがあるため追加チェック
    try {
      await page.waitForSelector(".modal-dialog-container", { state: 'visible', timeout: 1000 });
      console.log("「すでにコレしている商品です」のためスキップ");
      await page.close();
      return;
    } catch { }

    // 完了ボタンが有効になるまで待つ（商品データ読み込み完了の確認）
    try {
      await page.waitForFunction(
        () => {
          const btn = document.querySelector('.collect-btn');
          return btn && !btn.disabled;
        },
        { timeout: 10000 }
      );
    } catch {
      console.log('ボタン有効化待機タイムアウト、そのまま続行');
    }
    console.log("コレクト画面表示確認");

    const postContent = await buildPostContent(itemName, catchcopy, description);
    console.log(postContent);

    await page.fill('#collect-content', postContent);
    await page.click('.collect-btn', { force: true });
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

async function buildPostContent(itemName, catchcopy, description) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: `楽天ROOMの投稿文を作成してください。\n商品名: ${itemName}\nキャッチコピー: ${catchcopy}\n商品説明: ${description.substring(0, 300)}\n\n条件:\n- 300文字以内\n- 魅力が伝わる自然な文章\n- 最後に関連するハッシュタグを5〜8個\n- 文章とハッシュタグのみ出力（説明不要）`
        }
      ],
      max_completion_tokens: 600,
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error("OpenAI APIエラー、デフォルト文章を使用:", error.message);
    return itemName + catchcopy + description.substring(0, 200) + " #あったら便利 #欲しいものリスト #ランキング #人気 #楽天市場";
  }
}

async function processAccount(accountName, appId, userId, password) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext();

  try {
    console.log(`=== ${accountName}の処理を開始 ===`);

    const sexOptions = [0, 1, 2];
    const ageOptions = [10, 20, 30, 40, 50];
    const sex = sexOptions[Math.floor(Math.random() * sexOptions.length)];
    const age = ageOptions[Math.floor(Math.random() * ageOptions.length)];
    const page = Math.floor(Math.random() * 34) + 1;
    const sexLabel = ['全体', '女性', '男性'][sex];
    console.log(`性別: ${sexLabel}, 年代: ${age}代, ページ: ${page}`);
    const requestUrl = buildRakutenApiUrl(appId, sex, age, page);

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
