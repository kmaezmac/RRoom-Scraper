const path = require('node:path');
const { parseGenres } = require('./genres');

class RunError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function readConfig(env = process.env) {
  const selection = env.RUN_ACCOUNT || 'all';
  const ids = { all: [1, 2, 3], both: [1, 2], account1: [1], account2: [2], account3: [3] }[selection];
  if (!ids) throw new RunError('CONFIG', 'RUN_ACCOUNT は all / account1 / account2 / account3 を指定してください');
  const mode = env.RUN_MODE || 'diagnose';
  if (!['diagnose', 'run'].includes(mode)) throw new RunError('CONFIG', 'RUN_MODE は diagnose / run を指定してください');
  const maxItems = Number(env.MAX_ITEMS || 30);
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 30) throw new RunError('CONFIG', 'MAX_ITEMS は1〜30です');
  const maxPosts = Number(env.MAX_POSTS || maxItems);
  if (!Number.isInteger(maxPosts) || maxPosts < 1 || maxPosts > 30) throw new RunError('CONFIG', 'MAX_POSTS は1〜30です');
  const key = env.SESSION_ENCRYPTION_KEY || '';
  if (!/^[a-f\d]{64}$/i.test(key)) throw new RunError('CONFIG', 'SESSION_ENCRYPTION_KEY に64桁の16進数を設定してください');
  const accounts = ids.map(id => {
    const suffix = id === 1 ? '' : String(id);
    const account = {
      id, name: `account${id}`, genres: parseGenres(env[`ACCOUNT_GENRES${id}`] || ''),
      appId: env[`RAKUTEN_APP_ID${suffix}`] || env.RAKUTEN_APP_ID,
      userId: env[`RAKUTEN_USER_ID${suffix}`], password: env[`RAKUTEN_PASSWORD${suffix}`],
      session: env[`RAKUTEN_SESSION${suffix}`],
    };
    if (!account.appId) throw new RunError('CONFIG', `RAKUTEN_APP_ID${suffix} または共通の RAKUTEN_APP_ID が必要です`);
    return account;
  });
  if (!env.ACCESS_TOKEN) throw new RunError('CONFIG', 'ACCESS_TOKEN（楽天API accessKey）が必要です');
  if (env.USE_OPENAI === 'true' && !env.OPENAI_API_KEY) throw new RunError('CONFIG', 'USE_OPENAI=true には OPENAI_API_KEY が必要です');
  const historyEnabled = env.HISTORY_ENABLED === 'true';
  const supabaseUrl = (env.SUPABASE_URL || '').replace(/\/$/, '');
  const supabaseKey = env.SUPABASE_SECRET_KEY || '';
  if (historyEnabled && (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl) || !supabaseKey)) {
    throw new RunError('CONFIG', '履歴管理にはSUPABASE_URLとサーバー用SUPABASE_SECRET_KEYが必要です');
  }
  const rankingPages = Number(env.RANKING_PAGES_PER_RUN || 1);
  if (!Number.isInteger(rankingPages) || rankingPages < 1 || rankingPages > 3) throw new RunError('CONFIG', 'RANKING_PAGES_PER_RUNは1〜3です');
  return {
    historyEnabled, supabaseUrl, supabaseKey, rankingPages,
    accounts, mode, maxItems, maxPosts, key, accessKey: env.ACCESS_TOKEN,
    useOpenAI: env.USE_OPENAI === 'true', openaiKey: env.OPENAI_API_KEY,
    stateDir: path.resolve(env.STATE_DIR || path.join(__dirname, '..', '.state')),
  };
}

// Playwright/Axios errors may contain credentials, request URLs, or DOM text.
// Only our fixed messages and error codes are written to public Actions logs.
function safeError(error) {
  if (error instanceof RunError) return `${error.code}: ${error.message}`;
  const { errorKind } = require('./diagnostics');
  const kind = errorKind(error);
  const messages = {
    LOCATOR_AMBIGUOUS: '操作対象が複数見つかりました',
    PAGE_NAVIGATING: '画面遷移中に読み取りが中断されました',
    BROWSER_CLOSED: 'ブラウザまたはページが閉じられました',
    FORM_NOT_EDITABLE: '対象の入力欄は編集できません',
    CLICK_OBSTRUCTED: '別の画面要素がボタンへのクリックを遮っています',
    CLICK_OUTSIDE_VIEWPORT: 'ボタンが画面内に収まらずクリックできません',
    CLICK_UNSTABLE: 'ボタンの位置が動いておりクリックできません',
    TYPE_ERROR: '処理に必要なデータ型が想定と異なります',
    TIMEOUT: 'ページの読込または要素の確認が時間切れです',
    UNEXPECTED: '未分類のエラーです（操作名とUI件数を確認してください）',
  };
  return `${kind}: ${messages[kind]}`;
}
module.exports = { readConfig, RunError, safeError };
