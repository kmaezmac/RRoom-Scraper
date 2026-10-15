// Keys are Rakuten Ichiba genre IDs, not a separate ROOM taxonomy.
const genreTags = {
  '100804': ['インテリア', '寝具', '収納'],
  '100533': ['キッズ', 'ベビー', 'マタニティ'],
  '215783': ['日用品雑貨', '文房具'],
  '216131': ['バッグ', 'ファッション小物'],
  '100371': ['レディースファッション'],
  '100227': ['食品'],
  '100316': ['スイーツ'],
  '558944': ['キッチン用品'],
  '100939': ['美容', 'コスメ'],
};
function parseGenres(value = '') {
  if (!value.trim()) return [];
  const ids = value.split(',').map(v => v.trim());
  if (ids.length > 10 || ids.some(id => !/^[1-9]\d{0,8}$/.test(id))) {
    const { RunError } = require('./config');
    throw new RunError('CONFIG', 'ACCOUNT_GENRESは楽天ジャンルIDをカンマ区切りで最大10個指定してください');
  }
  return [...new Set(ids)];
}
function tagsFor(item) {
  const id = String(item.requestedGenreId || item.genreId || '');
  const tags = genreTags[id];
  // Broad genre labels only; no claims about use, age, ingredients or benefits.
  return tags ? ` ${tags.map(tag => `#${tag}`).join(' ')} #楽天市場` : ' #楽天市場 #商品紹介';
}
module.exports = { parseGenres, tagsFor };
