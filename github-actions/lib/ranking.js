const axios = require('axios');
const { RunError } = require('./config');
const { tagsFor } = require('./genres');
const ENDPOINT = 'https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// ROOM's browser validator counts UTF-16 units (String.length), not code points.
// Iterate code points so trimming does not leave half of a surrogate pair.
function limitPostContent(text, limit = 500) {
  let output = '';
  for (const character of text) {
    if (output.length + character.length > limit) break;
    output += character;
  }
  return output;
}

async function fetchRanking(account, config, { get = axios.get, random = Math.random, wait = sleep, genreId, page, fullPage = false, allowEmpty = false, beforeRequest = () => wait(1100) } = {}) {
  // Windows版と同じランキング条件。
  const params = { applicationId: account.appId, age: [20, 30, 40][Math.floor(random() * 3)], sex: 1, carrier: 0, page: Math.floor(random() * 34) + 1 };
  const selectedGenre = genreId || account.genres?.[Math.floor(random() * account.genres.length)];
  if (selectedGenre) { params.genreId = selectedGenre; delete params.age; delete params.sex; params.page = page || 1; }
  else if (page) params.page = page;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      await beforeRequest();
      response = await get(ENDPOINT, { params, headers: { accessKey: config.accessKey }, timeout: 30000 });
    } catch (error) {
      const status = error.response?.status;
      if (allowEmpty && status === 404 && error.response?.data?.error === 'not_found') return [];
      if ((!status || status === 429 || status >= 500) && attempt < 2) { await wait(2000 * (attempt + 1)); continue; }
      throw new RunError('RANKING_API', `楽天API取得失敗（HTTP ${Number(status) || '応答なし'}）。APIキー・許可IP/URL・利用上限を確認してください`);
    }
    if (!Array.isArray(response.data?.Items) || response.data.Items.length === 0) {
      if (allowEmpty && Array.isArray(response.data?.Items)) return [];
      throw new RunError('RANKING_EMPTY', '楽天APIからランキング商品を取得できませんでした');
    }
    const items = response.data.Items.map(entry => entry.Item);
    if (items.some(item => !item || typeof item.itemCode !== 'string' || !item.itemCode.includes(':') || item.itemCode.length > 256)) {
      throw new RunError('RANKING_FORMAT', '楽天APIの商品形式が想定と異なります');
    }
    return items.slice(0, fullPage ? 30 : config.maxItems).map(item => selectedGenre ? { ...item, requestedGenreId: selectedGenre } : item);
  }
}
async function buildPostContent(item, config) {
  const { itemName = '', catchcopy = '', itemCaption = '' } = item;
  const tags = tagsFor(item);
  const body = itemName + catchcopy + limitPostContent(itemCaption, 200);
  const fallback = limitPostContent(body, 500 - tags.length) + tags;
  if (!config.useOpenAI) return fallback;
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: config.openaiKey, timeout: 30000, maxRetries: 1 });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: `楽天ROOMの投稿文を作成してください。\n商品名: ${itemName}\nキャッチコピー: ${catchcopy}\n商品説明: ${itemCaption.substring(0, 300)}\n\n条件:\n- 300文字以内\n- 魅力が伝わる自然な文章\n- 最後に関連するハッシュタグを5〜8個\n- 文章とハッシュタグのみ出力（説明不要）` }],
      max_tokens: 600,
    });
    return limitPostContent(completion.choices[0].message.content.trim()) || fallback;
  } catch { console.warn('OpenAI API失敗: 既存の定型文を使用します'); return fallback; }
}
module.exports = { fetchRanking, buildPostContent, limitPostContent, sleep };
