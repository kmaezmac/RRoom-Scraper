// Public network check only; no credentials, cookies, or account mutations.
const { chromium } = require('playwright');
const { inspectPage } = require('./lib/room');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: 'ja-JP' });
    const response = await page.goto('https://room.rakuten.co.jp/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(JSON.stringify({ check: 'public-room', status: response?.status(), host: new URL(page.url()).hostname }));
    if (response?.status() !== 200) throw new Error('ROOM returned non-200 status');
    const login = page.getByRole('link', { name: /ログイン/ }).first();
    if (await login.isVisible()) {
      await login.click();
      await page.waitForLoadState('domcontentloaded');
      await page.locator('#user_id').waitFor({ state: 'visible', timeout: 15000 });
      console.log(JSON.stringify({ check: 'login-page', host: new URL(page.url()).hostname, state: await page.evaluate(inspectPage) }));
    } else {
      console.log('ログインリンク未検出。認証の診断にはSecrets登録後のdiagnoseを使用してください');
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(`公開ページ確認失敗: ${error.name}`); process.exitCode = 1; });
