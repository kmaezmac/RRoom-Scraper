// One-time bridge from the existing accountN.bat Chrome sessions.
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { chromium } = require('playwright');
const { saveState } = require('./lib/state');
const { RunError, safeError } = require('./lib/config');
(async () => {
  const id = Number(process.argv[2]);
  if (![1, 2, 3].includes(id)) throw new RunError('CONFIG', 'node export-session.js 1（または2, 3）で実行してください');
  const key = process.env.SESSION_ENCRYPTION_KEY || '';
  if (!/^[a-f\d]{64}$/i.test(key)) throw new RunError('CONFIG', '.env に SESSION_ENCRYPTION_KEY（64桁16進数）が必要です');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${9221 + id}`);
  try {
    const context = browser.contexts()[0];
    const state = await context.storageState({ indexedDB: true });
    // Do not export unrelated tabs' cookies or local storage.
    state.cookies = state.cookies.filter(cookie => /(^|\.)rakuten\.(co\.jp|com)$/.test(cookie.domain.replace(/^\./, '')));
    state.origins = state.origins.filter(origin => /(^|\.)rakuten\.(co\.jp|com)$/.test(new URL(origin.origin).hostname));
    if (!state.cookies.length) throw new RunError('SESSION_EMPTY', '楽天のCookieがありません。対象アカウントで手動ログインしてください');
    await saveState({ key, stateDir: path.join(__dirname, '.state') }, { name: `account${id}` }, state);
    console.log(`.state/account${id}.enc を作成しました。その内容をGitHub Secret RAKUTEN_SESSION${id === 1 ? '' : id} に登録してください`);
  } finally {
    // For a connected browser, close disconnects this client; it does not quit Chrome.
    await browser.close();
  }
})().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
