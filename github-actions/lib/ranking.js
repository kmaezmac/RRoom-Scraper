const axios = require('axios');
const { RunError } = require('./config');
const ENDPOINT = 'https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchRanking(account, config, { get = axios.get, random = Math.random, wait = sleep } = {}) {
  // Windows版と同じランキング条件。
  const params = { applicationId: account.appId, age: [20, 30, 40][Math.floor(random() * 3)], sex: 1, carrier: 0, page: Math.floor(random() * 34) + 1 };
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await get(ENDPOINT, { params, headers: { accessKey: config.accessKey }, timeout: 30000 });
    } catch (error) {
      const status = error.response?.status;
      if ((!status || status === 429 || status >= 500) && attempt < 2) { await wait(2000 * (attempt + 1)); continue; }
      throw new RunError('RANKING_API', `楽天API取得失敗（HTTP ${Number(status) || '応答なし'}）。APIキー・許可IP/URL・利用上限を確認してください`);
    }
    if (!Array.isArray(response.data?.Items) || response.data.Items.length === 0) {
      throw new RunError('RANKING_EMPTY', '楽天APIからランキング商品を取得できませんでした');
    }
    const items = response.data.Items.map(entry => entry.Item);
    if (items.some(item => !item || typeof item.itemCode !== 'string' || !item.itemCode.includes(':'))) {
      throw new RunError('RANKING_FORMAT', '楽天APIの商品形式が想定と異なります');
    }
    return items.slice(0, config.maxItems);
  }
}
async function buildPostContent(item, config) {
  const { itemName = '', catchcopy = '', itemCaption = '' } = item;
  const fallback = itemName + catchcopy + itemCaption.substring(0, 200) + ' #あったら便利 #欲しいものリスト #ランキング #人気 #楽天市場';
  if (!config.useOpenAI) return fallback;
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: config.openaiKey, timeout: 30000, maxRetries: 1 });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: `楽天ROOMの投稿文を作成してください。\n商品名: ${itemName}\nキャッチコピー: ${catchcopy}\n商品説明: ${itemCaption.substring(0, 300)}\n\n条件:\n- 300文字以内\n- 魅力が伝わる自然な文章\n- 最後に関連するハッシュタグを5〜8個\n- 文章とハッシュタグのみ出力（説明不要）` }],
      max_tokens: 600,
    });
    return completion.choices[0].message.content.trim() || fallback;
  } catch { console.warn('OpenAI API失敗: 既存の定型文を使用します'); return fallback; }
}
module.exports = { fetchRanking, buildPostContent, sleep };
