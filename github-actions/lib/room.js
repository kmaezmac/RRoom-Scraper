const { RunError } = require('./config');
const { sleep } = require('./ranking');
const ROOM = 'https://room.rakuten.co.jp';
const mixUrl = code => `${ROOM}/mix?${new URLSearchParams({ itemcode: code, scid: 'we_room_upc60' })}`;

// Runs inside Chromium. Never returns page text, cookies or input values to logs.
function inspectPage() {
  const visible = el => el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const text = document.body?.innerText || '';
  if (/すでにコレ(?:している|してい|！?済み|！?されています)/.test(text)) return 'duplicate';
  if (/アクセスが制限|Access Denied|アクセスを拒否/.test(text)) return 'blocked';
  if ([...document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], input[autocomplete="one-time-code"], input[name*="otp"]')].some(visible)
      || /認証コードを入力|ワンタイムパスワード|画像に表示されている文字/.test(text)) return 'challenge';
  if (visible(document.querySelector('#user_id'))) return 'user';
  if (visible(document.querySelector('#password_current'))) return 'password';
  if (visible(document.querySelector('#collect-content'))) return 'form';
  if ([...document.querySelectorAll('.modal-dialog-container, [role="alert"]')].some(el => visible(el) && el.innerText.trim())) return 'modal';
  return null;
}

async function waitForState(page, timeout = 30000) {
  const handle = await page.waitForFunction(inspectPage, undefined, { timeout });
  try { return await handle.jsonValue(); } finally { await handle.dispose(); }
}
function checkState(state) {
  if (state === 'challenge') throw new RunError('AUTH_CHALLENGE', '追加認証/CAPTCHAが必要です。手動ログイン後のセッションを登録してください');
  if (state === 'blocked') throw new RunError('ACCESS_BLOCKED', '楽天側でアクセスが拒否されています。クラウドIPからの利用可否を確認してください');
  if (state === 'modal') throw new RunError('ROOM_MODAL', 'コレ済み以外のメッセージが表示されました。楽天ROOM上で確認してください');
}
function assertLoginHost(page) {
  if (!['login.account.rakuten.com', 'grp01.id.rakuten.co.jp'].includes(new URL(page.url()).hostname)) {
    throw new RunError('AUTH_HOST', '想定外のログイン先のため停止しました');
  }
}

async function openCollect(page, itemCode, account) {
  await page.goto(mixUrl(itemCode), { waitUntil: 'domcontentloaded' });
  let state = await waitForState(page);
  checkState(state);
  if (state === 'user' || state === 'password') {
    if (!account.userId || !account.password) throw new RunError('AUTH_REQUIRED', '有効なセッション、または楽天ID/パスワードを設定してください');
    assertLoginHost(page);
    if (state === 'user') {
      await page.locator('#user_id').fill(account.userId);
      await page.locator('#cta001').click();
      try { await page.locator('#password_current').waitFor({ state: 'visible', timeout: 15000 }); }
      catch { checkState(await page.evaluate(inspectPage)); throw new RunError('AUTH_FAILED', 'パスワード画面に進めません。ID・追加認証を確認してください'); }
    }
    assertLoginHost(page);
    await page.locator('#password_current').fill(account.password);
    await page.locator('#cta011').click();
    try { await page.waitForURL(url => url.hostname === 'room.rakuten.co.jp', { timeout: 30000 }); }
    catch { checkState(await page.evaluate(inspectPage)); throw new RunError('AUTH_FAILED', 'ログインできません。ID/パスワード・追加認証・クラウドIP制限を確認してください'); }
    await page.goto(mixUrl(itemCode), { waitUntil: 'domcontentloaded' });
    state = await waitForState(page);
    checkState(state);
  }
  if (new URL(page.url()).hostname !== 'room.rakuten.co.jp' || !['form', 'duplicate'].includes(state)) {
    throw new RunError('AUTH_FAILED', 'ログイン済みの投稿画面を確認できませんでした');
  }
  // The duplicate modal may be populated after the form appears.
  if (state === 'form') { await sleep(1000); state = await page.evaluate(inspectPage); checkState(state); }
  return state;
}

async function postItem(page, item, content, account) {
  const state = await openCollect(page, item.itemCode, account);
  if (state === 'duplicate') return 'skipped';
  const text = typeof content === 'function' ? await content() : content;
  await page.locator('#collect-content').fill(text);
  // A disabled button is a real failure, never force a click through it.
  await page.locator('.collect-btn').click({ timeout: 15000 });
  // A click alone does not prove persistence. Reopen this product and require
  // ROOM's own duplicate acknowledgement. Never retry an uncertain submission.
  let verification;
  try {
    await sleep(3000);
    // Keep the submitting page alive so navigation cannot abort its request.
    verification = await page.context().newPage();
    await verification.goto(mixUrl(item.itemCode), { waitUntil: 'domcontentloaded' });
    await verification.waitForFunction(() => /すでにコレ(?:している|してい|！?済み|！?されています)/.test(document.body?.innerText || ''), undefined, { timeout: 15000 });
    return 'posted';
  } catch {
    throw new RunError('POST_UNCONFIRMED', '投稿結果を確認できません。重複送信を避けるため、このアカウントを停止します。ROOMで直近の投稿を確認してください');
  } finally {
    await verification?.close();
  }
}

async function followFromCurrentPage(page, target) {
  let followed = 0;
  await sleep(3000);
  for (let scrolls = 0; followed < target && scrolls < 20;) {
    const clicked = await page.evaluate(() => {
      const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const modern = [...document.querySelectorAll('button[aria-label="フォローする"]')].find(el => visible(el) && !el.disabled && !el.dataset.rroomAttempted);
      const old = [...document.querySelectorAll('.border-button')].find(el => {
        const span = el.querySelector('span.follow.icon-follow');
        return visible(el) && !el.dataset.rroomAttempted && span && !span.classList.contains('ng-hide');
      });
      const el = modern || old;
      if (!el) return false;
      el.dataset.rroomAttempted = 'true'; el.click(); return true;
    });
    if (clicked) { followed++; await sleep(800); }
    else {
      scrolls++;
      const before = await page.evaluate(() => document.body.scrollHeight);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(2500);
      if (await page.evaluate(() => document.body.scrollHeight) === before) break;
    }
  }
  return followed;
}
async function ensureSocialPage(page) {
  if (new URL(page.url()).hostname !== 'room.rakuten.co.jp') throw new RunError('AUTH_EXPIRED', 'ログイン状態が失効しました');
  const state = await page.evaluate(inspectPage);
  checkState(state);
  if (state === 'user' || state === 'password') throw new RunError('AUTH_EXPIRED', 'ログイン状態が失効しました');
}
async function performFollow(page) {
  await page.goto(`${ROOM}/discover/recommendUsers`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  await ensureSocialPage(page);
  let count = await followFromCurrentPage(page, 20);
  if (count < 20) {
    await page.goto(`${ROOM}/discover/recommendUsers`, { waitUntil: 'domcontentloaded' });
    const name = page.locator('.name.ng-binding').first();
    try { await name.waitFor({ state: 'visible', timeout: 10000 }); }
    catch { return count; }
    await name.click();
    await page.waitForURL(url => url.pathname.includes('/room_'));
    const url = new URL(page.url());
    url.pathname = url.pathname.replace(/\/[^/]*$/, '/followers');
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await ensureSocialPage(page);
    count += await followFromCurrentPage(page, 20 - count);
  }
  return count;
}
async function performLike(page) {
  await page.goto(`${ROOM}/discover/recommendItems`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  await ensureSocialPage(page);
  let count = 0;
  for (let scrolls = 0; count < 20 && scrolls < 20;) {
    const clicked = await page.evaluate(() => {
      const el = [...document.querySelectorAll('a.icon-like.right:not(.isLiked)')].find(el => !el.dataset.rroomAttempted && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      if (!el) return false;
      el.dataset.rroomAttempted = 'true'; el.click(); return true;
    });
    if (clicked) { count++; await sleep(500); }
    else {
      scrolls++;
      const before = await page.evaluate(() => document.body.scrollHeight);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(2000);
      if (await page.evaluate(() => document.body.scrollHeight) === before) break;
    }
  }
  return count;
}
module.exports = { inspectPage, openCollect, postItem, performFollow, performLike, mixUrl };
