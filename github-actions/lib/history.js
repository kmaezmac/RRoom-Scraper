const { RunError } = require('./config');

class HistoryStore {
  constructor(config, account, request = fetch) {
    this.url = config.supabaseUrl;
    this.key = config.supabaseKey;
    this.account = account.name;
    this.request = request;
  }
  async api(table, { method = 'GET', query = {}, body, prefer } = {}) {
    const headers = { apikey: this.key, 'Content-Type': 'application/json' };
    // New sb_secret keys use apikey only; legacy service_role JWTs also use Bearer.
    if (!this.key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${this.key}`;
    if (prefer) headers.Prefer = prefer;
    try {
      const response = await this.request(`${this.url}/rest/v1/${table}?${new URLSearchParams(query)}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('HTTP');
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } catch {
      throw new RunError('HISTORY_DB', '履歴DBの読み書きに失敗しました。接続設定・権限・SQL適用を確認してください（詳細非公開）');
    }
  }
  async state() {
    const rows = await this.api('room_candidate_state', { query: { account: `eq.${this.account}`, select: 'state' } });
    if (!Array.isArray(rows)) throw new RunError('HISTORY_FORMAT', '履歴DBの応答形式が不正です');
    return rows[0]?.state || null;
  }
  async saveState(state) {
    await this.api('room_candidate_state', { method: 'POST', query: { on_conflict: 'account' }, prefer: 'resolution=merge-duplicates,return=minimal', body: { account: this.account, state, updated_at: new Date().toISOString() } });
  }
  async known(items) {
    const codes = new Set();
    // Bounded batches avoid unbounded history downloads and URL length limits.
    for (let i = 0; i < items.length; i += 30) {
      const quoted = items.slice(i, i + 30).map(item => `"${item.itemCode.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',');
      const rows = await this.api('room_post_history', { query: { account: `eq.${this.account}`, item_code: `in.(${quoted})`, select: 'item_code' } });
      if (!Array.isArray(rows) || rows.some(row => typeof row.item_code !== 'string')) throw new RunError('HISTORY_FORMAT', '履歴DBの応答形式が不正です');
      rows.forEach(row => codes.add(row.item_code));
    }
    return codes;
  }
  async claim(item) {
    const rows = await this.api('room_post_history', { method: 'POST', query: { on_conflict: 'account,item_code' }, prefer: 'resolution=ignore-duplicates,return=representation', body: {
      account: this.account, item_code: item.itemCode, status: 'pending', genre_id: String(item.requestedGenreId || item.genreId || ''), updated_at: new Date().toISOString(),
    } });
    if (!Array.isArray(rows)) throw new RunError('HISTORY_FORMAT', '履歴DBの応答形式が不正です');
    return rows.length === 1;
  }
  async finish(item, status) {
    if (!['posted', 'duplicate'].includes(status)) throw new Error('Invalid history status');
    await this.api('room_post_history', { method: 'POST', query: { on_conflict: 'account,item_code' }, prefer: 'resolution=merge-duplicates,return=minimal', body: {
      account: this.account, item_code: item.itemCode, status, genre_id: String(item.requestedGenreId || item.genreId || ''), updated_at: new Date().toISOString(),
    } });
  }
}
module.exports = { HistoryStore };
