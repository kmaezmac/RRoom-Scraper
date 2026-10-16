// Keys are Rakuten Ichiba genre IDs, not a separate ROOM taxonomy.
const genreTags = {
  '100804': ['インテリア', '寝具', '収納'],
  '100533': ['キッズ', 'ベビー', 'マタニティ'],
  '215783': ['日用品雑貨', '文房具'],
  '216131': ['バッグ', 'ファッション小物'],
  '100371': ['レディースファッション'],
  '100227': ['食品'],
  '100316': ['飲料'],
  '551167': ['スイーツ', 'お菓子'],
  '558944': ['キッチン用品'],
  '100939': ['美容', 'コスメ'],
  '551177': ['メンズファッション'],
  '558885': ['靴'],
  '100433': ['インナー', 'ルームウェア'],
  '216129': ['ジュエリー', 'アクセサリー'],
  '558929': ['腕時計'],
  '510915': ['ビール', '洋酒'],
  '510901': ['日本酒', '焼酎'],
  '564500': ['スマートフォン', 'タブレット'],
  '100026': ['パソコン', '周辺機器'],
  '211742': ['オーディオ', 'カメラ'],
  '562637': ['家電'],
  '565004': ['通信サービス'],
  '100938': ['健康グッズ'],
  '101070': ['スポーツ', 'アウトドア'],
  '100005': ['ガーデニング', 'DIY'],
  '566382': ['おもちゃ'],
  '112493': ['楽器', '音響機器'],
  '101164': ['ホビー'],
  '101205': ['テレビゲーム'],
  '101240': ['CD', 'DVD'],
  '503190': ['車用品', 'バイク用品'],
  '101213': ['ペット用品'],
  '101077': ['ゴルフ'],
  '200162': ['本', '読書'],
  '101438': ['サービス', 'リフォーム'],
  '101381': ['ギフト', 'チケット'],
};
// Conservative app selection rule, not a claim that all contact lenses/care are prohibited.
const excludedGenres = new Set(['551169', '201541']);
// ROOM help: https://room.rakuten.co.jp/info/help/collect/08.html
// Only information already returned by ranking is used; no per-item API calls.
function isRoomEligible(item) {
  // Ranking returns availability; it has no availability input filter.
  // Missing flags in older cached candidates mean unknown, not sold out.
  if (item.availability === 0 || item.availability === '0') return false;
  if (excludedGenres.has(String(item.genreId)) || excludedGenres.has(String(item.requestedGenreId))) return false;
  const shop = String(item.itemCode || '').split(':')[0];
  if (shop === 'rakutenkobo-ebooks') return false;
  const title = `${item.itemName || ''} ${item.catchcopy || ''}`.normalize('NFKC');
  if (/第\s*[123一二三]\s*類医薬品|要指導医薬品|医療用医薬品|動物用医薬品/.test(title)) return false;
  if (shop === 'book' && /ダウンロード版|ダウンロード商品|電子書籍/.test(title)) return false;
  return true;
}
function parseGenres(value = '') {
  if (!value.trim()) return [];
  const ids = value.split(',').map(v => v.trim());
  if (ids.length > 10 || ids.some(id => !/^[1-9]\d{0,8}$/.test(id))) {
    const { RunError } = require('./config');
    throw new RunError('CONFIG', 'ACCOUNT_GENRESは楽天ジャンルIDをカンマ区切りで最大10個指定してください');
  }
  // These broad rankings mix medicines with otherwise eligible products.
  if (ids.some(id => excludedGenres.has(id))) {
    const { RunError } = require('./config');
    throw new RunError('CONFIG', '医薬品を含むジャンル551169・201541は自動投稿の対象外です。別ジャンルを選んでください');
  }
  return [...new Set(ids)];
}
// Shared discovery labels; not claims of purchase, use, discounts or original photos.
const commonTags = ['あったら便利', '欲しいものリスト', 'ランキング', '人気', '楽天市場', 'お買い物メモ', 'おすすめ商品'];
function tagsFor(item) {
  const id = String(item.requestedGenreId || item.genreId || '');
  const tags = [...new Set([...(genreTags[id] || ['商品紹介']), ...commonTags])];
  return ` ${tags.map(tag => `#${tag}`).join(' ')}`;
}
module.exports = { parseGenres, tagsFor, genreTags, isRoomEligible };
