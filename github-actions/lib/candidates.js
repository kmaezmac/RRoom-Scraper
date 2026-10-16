const { fetchRanking, limitPostContent } = require('./ranking');
const { RunError } = require('./config');
const { isRoomEligible } = require('./genres');
const TTL = 24 * 60 * 60 * 1000;

class Candidates {
  constructor(account, config, history, { ranking = fetchRanking, now = Date.now } = {}) {
    this.account = account; this.config = config; this.history = history;
    this.ranking = ranking; this.now = now; this.pages = 0; this.historySkipped = 0;
    this.seen = new Set();
  }
  async init() {
    const signature = JSON.stringify(this.account.genres || []);
    const previous = await this.history.state();
    if (previous && (previous.version !== 1 || !Array.isArray(previous.pool) || !previous.pages || typeof previous.pages !== 'object' || Array.isArray(previous.pages) || !Number.isSafeInteger(previous.turn) || previous.turn < 0 || previous.pool.some(entry => !entry?.item || typeof entry.item.itemCode !== 'string' || !entry.item.itemCode.includes(':')))) {
      throw new RunError('HISTORY_FORMAT', '候補状態の形式が不正です。候補状態テーブルを確認してください');
    }
    this.state = previous?.signature === signature ? previous : { version: 1, signature, turn: 0, pages: {}, pool: [] };
    this.state.pool = this.state.pool.filter(entry => Number.isFinite(entry.fetchedAt) && this.now() - entry.fetchedAt < TTL && entry.fetchedAt <= this.now());
    await this.filterKnown();
  }
  async filterKnown() {
    this.state.pool = this.state.pool.filter(entry => isRoomEligible(entry.item));
    const known = await this.history.known(this.state.pool.map(entry => entry.item));
    this.state.pool = this.state.pool.filter(entry => {
      if (known.has(entry.item.itemCode)) { this.historySkipped++; return false; }
      return true;
    });
  }
  acknowledge() { this.current = null; }
  restoreCurrent() {
    if (this.current) this.state.pool.unshift(this.current);
    this.current = null;
  }
  async save() { await this.history.saveState(this.state); }
  async next() {
    while (true) {
      while (this.state.pool.length) {
        const entry = this.state.pool.shift();
        const { item } = entry;
        if (this.seen.has(item.itemCode)) continue;
        this.seen.add(item.itemCode);
        this.current = entry;
        return item;
      }
      if (this.pages >= this.config.rankingPages) return null;
      const genres = this.account.genres?.length ? this.account.genres : [''];
      const genreId = genres[this.state.turn % genres.length];
      const key = genreId || 'legacy';
      const page = this.state.pages[key] || 1;
      if (!Number.isInteger(page) || page < 1 || page > 34) throw new RunError('HISTORY_FORMAT', '候補ページの形式が不正です');
      this.pages++;
      const items = await this.ranking(this.account, this.config, { genreId, page, fullPage: true, allowEmpty: true });
      this.state.turn++;
      this.state.pages[key] = items.length === 0 || page === 34 ? 1 : page + 1;
      this.state.pool = items.filter(item => isRoomEligible(item) && !this.seen.has(item.itemCode)).map(item => ({ item: {
        itemCode: item.itemCode, itemName: limitPostContent(item.itemName || ''), catchcopy: limitPostContent(item.catchcopy || ''),
        itemCaption: limitPostContent(item.itemCaption || '', 200), genreId: item.genreId, requestedGenreId: item.requestedGenreId, availability: item.availability,
      }, fetchedAt: this.now() }));
      await this.filterKnown();
      // Save the cursor AND candidates before browser work, including an empty page.
      await this.save();
    }
  }
}
module.exports = { Candidates, TTL };
