const { RunError } = require('./config');
const HOUR = 3600000, DAY = 24 * HOUR;
// Application limits, not published ROOM limits. A reservation counts even if
// the browser crashes: uncertainty must never increase the remaining budget.
class SocialBudget {
  constructor(history, now = Date.now) { this.history = history; this.now = now; }
  async init() {
    const rows = await this.history.api('room_social_state', { query: { account: `eq.${this.history.account}`, select: 'state' } });
    this.state = rows[0]?.state || { follow: [], like: [], blocked: {} };
    if (!['follow','like'].every(k => Array.isArray(this.state[k]) && this.state[k].every(Number.isFinite)) || !this.state.blocked || typeof this.state.blocked !== 'object') throw new RunError('SOCIAL_STATE', '交流操作の履歴形式を確認してください');
  }
  async save() {
    await this.history.api('room_social_state', { method: 'POST', query: { on_conflict: 'account' }, prefer: 'resolution=merge-duplicates,return=minimal', body: { account: this.history.account, state: this.state, updated_at: new Date(this.now()).toISOString() } });
  }
  async reserve(kind) {
    const now = this.now();
    this.state[kind] = this.state[kind].filter(t => now - t < DAY);
    if (this.state.blocked[kind] > now || this.state[kind].length >= 450 || this.state[kind].filter(t => now - t < HOUR).length >= 50) return false;
    this.state[kind].push(now);
    await this.save();
    return true;
  }
  async block(kind, limited) {
    this.state.blocked[kind] = this.now() + (limited ? DAY : HOUR);
    await this.save();
  }
}
module.exports = { SocialBudget };
