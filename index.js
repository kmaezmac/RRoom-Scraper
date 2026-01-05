const puppeteer = require("puppeteer-core");
const express = require("express");
require('dotenv').config();
const axios = require('axios');

var fs   = require('fs');

async function test(requestUrl, browserPort) {
  console.log(requestUrl);
  console.log("使用ブラウザポート:", browserPort);
  await axios.get(requestUrl, {
  }).then(async (response) => {
    if (response.status !== 201) {
      for (var i = 0; i < response.data.Items.length; i++) {
        var itemCode = response.data.Items[i].Item.itemCode;
        var itemName = response.data.Items[i].Item.itemName;
        var catchcopy = response.data.Items[i].Item.catchcopy;
        var description = response.data.Items[i].Item.itemCaption;
        console.log((i + 1).toString() + "件目スタート");
        console.log(itemCode);
        console.log(description);
        await post(itemCode, description, itemName, catchcopy, browserPort);
        console.log("完了");
        await sleep(5000)
        // break
      }
    }
  }).catch((error) => {
    console.log(error);
    return;
  });
}

// test(20);
var args = [
  20,
  30,
  40
]
var age = args[Math.floor(Math.random()* args.length)];
(async () => {
  // アカウント1の処理（ポート9222）
  try {
    console.log("=== アカウント1の処理を開始 ===");
    var random = Math.floor(Math.random() * 34) + 1;
    var requestUrl = "https://app.rakuten.co.jp/services/api/IchibaItem/Ranking/20220601?applicationId=" + process.env.RAKUTEN_APP_ID
    + "&age=" + age + "&sex=1&carrier=0&page=" + random;
    await test(requestUrl, 9222); // ポート9222を指定
    console.log("=== アカウント1の処理完了 ===");
  } catch (error) {
    // ブラウザに接続できない場合は何もしない（スキップ）
  }

  // アカウント2の処理（ポート9223）
  try {
    console.log("=== アカウント2の処理を開始 ===");
    var random2 = Math.floor(Math.random() * 34) + 1;
    var requestUrl2 = "https://app.rakuten.co.jp/services/api/IchibaItem/Ranking/20220601?applicationId=" + process.env.RAKUTEN_APP_ID2
    + "&age=" + age + "&sex=1&carrier=0&page=" + random2;
    await test(requestUrl2, 9223); // ポート9223を指定
    console.log("=== アカウント2の処理完了 ===");
  } catch (error) {
    // ブラウザに接続できない場合は何もしない（スキップ）
  }
})();




// test(40);


// function delay(time) {
//   return new Promise(function(resolve) { 
//       setTimeout(resolve, time)
//   });
// }
const sleep = milliseconds =>
  new Promise(resolve =>
    setTimeout(resolve, milliseconds)
  );

async function post(itemCode, description, itemName, catchcopy, browserPort = 9222) {
  try {
    // 既存のブラウザに接続（指定されたポートに接続）
    const browser = await puppeteer.connect({
      browserURL: `http://localhost:${browserPort}`,
      defaultViewport: null
    });

    const page = await browser.newPage();

    const url = `https://room.rakuten.co.jp/mix?itemcode=${itemCode}&scid=we_room_upc60`;
    console.log("ページに移動中");
    console.log(url);

    await page.setDefaultNavigationTimeout(30000);
    await page.goto(url);

    console.log("ページ読み込み完了");

    // ログイン処理は削除（既にログイン済みを前提）
    // コレクト画面の読み込みを待つ
    await page.waitForSelector("#collect-content", {
      visible: true,
    });
    console.log("コレクト画面表示確認");

    // コレ！済みの場合は、処理を終了
    let modalElement = null;
    try {
      await page.waitForSelector(".modal-dialog-container", {
        visible: true,
        timeout: 500,
      });
      modalElement = await page.$(".modal-dialog-container");
      console.log("おおおお");
    } catch (error) { }
    if (modalElement) {
      console.log("「すでにコレしている商品です」のため処理を終了");
      await page.close();
      return;
    }
    console.log("かかかか");
    var descriptionCut = itemName + catchcopy + description.substring(0, 200) + " #あったら便利 #欲しいものリスト #ランキング #人気 #楽天市場";
    console.log(descriptionCut);
    //　投稿処理
    await page.waitForSelector("#collect-content", {
      visible: true,
    });
    await page.click("#collect-content");
    await page.evaluate((text) => {
      const element = document.querySelector("#collect-content");
      element.value = text;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, descriptionCut);

    await page.waitForSelector("button", { visible: true });
    console.log("きききき");
    await page.click('xpath=//*[@id="scroller"]/div[4]/div[6]/div[1]/button', {
      visible: true,
    });

    // ページだけを閉じて、ブラウザは開いたままにする
    await page.close();
  } catch (error) {
    console.log(error);
    return;
  }


}


// const app = express();

// app.get("/", (req, res) => {
//     try {
//         test()
//         console.log("ログ定期実行")

//     } catch (err) {
//         console.log(err);
//     }
//     res.send('get');
// });


// const PORT = process.env.PORT || 3000;
// app.listen(PORT);