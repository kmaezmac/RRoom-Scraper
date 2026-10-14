const { RunError } = require('./config');
const { sleep } = require('./ranking');
const { step, readWhileNavigating, inspectControls } = require('./diagnostics');
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

// On hosted runners the document and its blocking scripts can each take
// 10–25 seconds. Give each phase its own bounded timeout.
async function navigate(page, url, timeout = 30000) {
  let response;
  try { response = await page.goto(url, { waitUntil: 'commit', timeout }); }
  catch { throw new RunError('NAVIGATION_CONNECT', 'ページ本体への接続が失敗・時間切れになりました'); }
  if (response && response.status() >= 400) {
    throw new RunError('NAVIGATION_HTTP', `ページ取得失敗（HTTP ${response.status()}）。アクセス制限・メンテナンス等を確認してください`);
  }
  try { await page.waitForLoadState('domcontentloaded', { timeout }); }
  catch { throw new RunError('NAVIGATION_DOM', 'ページ本体は応答しましたが、スクリプト等の読み込みが時間切れになりました'); }
  return response;
}

async function waitForState(page, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const state = await readWhileNavigating(() => page.evaluate(inspectPage), Math.max(1, end - Date.now()));
    if (state) return state;
    await sleep(200);
  }
  throw new RunError('ROOM_NOT_READY', '投稿画面・ログイン画面の表示を確認できませんでした');
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
  await step('collect.open', () => navigate(page, mixUrl(itemCode)));
  let state = await step('collect.state', () => waitForState(page));
  checkState(state);
  if (state === 'user' || state === 'password') {
    if (!account.userId || !account.password) throw new RunError('AUTH_REQUIRED', '有効なセッション、または楽天ID/パスワードを設定してください');
    assertLoginHost(page);
    if (state === 'user') {
      await step('login.user', () => page.locator('#user_id:visible').fill(account.userId));
      await step('login.next', () => page.locator('#cta001:visible').click());
      try { await page.locator('#password_current:visible').waitFor({ state: 'visible', timeout: 15000 }); }
      catch { checkState(await readWhileNavigating(() => page.evaluate(inspectPage))); const error = new RunError('AUTH_USER_STEP', 'パスワード画面に進めません。ID・追加認証を確認してください'); error.operation = 'login.next'; throw error; }
    }
    assertLoginHost(page);
    await step('login.password', () => page.locator('#password_current:visible').fill(account.password));
    await step('login.submit', () => page.locator('#cta011:visible').click());
    try { await step('login.return', async () => {
      await page.waitForURL(url => url.hostname === 'room.rakuten.co.jp', { timeout: 60000, waitUntil: 'commit' });
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    }); }
    catch { checkState(await readWhileNavigating(() => page.evaluate(inspectPage))); const error = new RunError('AUTH_RETURN', '送信後にROOMへの復帰を確認できません。認証情報・追加認証・接続状態を確認してください'); error.operation = 'login.return'; throw error; }
    await navigate(page, mixUrl(itemCode));
    state = await waitForState(page);
    checkState(state);
  }
  if (new URL(page.url()).hostname !== 'room.rakuten.co.jp' || !['form', 'duplicate'].includes(state)) {
    throw new RunError('AUTH_FAILED', 'ログイン済みの投稿画面を確認できませんでした');
  }
  // The duplicate modal may be populated after the form appears.
  if (state === 'form') { await sleep(1000); state = await readWhileNavigating(() => page.evaluate(inspectPage)); checkState(state); }
  if (!['form', 'duplicate'].includes(state)) {
    state = await waitForState(page);
    checkState(state);
    if (!['form', 'duplicate'].includes(state)) throw new RunError('AUTH_EXPIRED', '投稿画面の読み込み中にログイン状態が変わりました');
  }
  return state;
}

async function prepareCollect(page, content) {
  await step('collect.fill', async () => {
    const fields = page.locator('#collect-content:visible');
    if (await fields.count() !== 1) throw new RunError('COLLECT_FIELD_COUNT', '表示中の投稿入力欄が1個ではありません');
    await fields.fill(content);
  });
  await step('collect.ready', async () => {
    try {
      await page.waitForFunction(() => {
        const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
        const buttons = [...document.querySelectorAll('button.collect-btn, input.collect-btn[type="submit"]')].filter(visible);
        return buttons.length === 1 && !buttons[0].disabled && buttons[0].getAttribute('aria-disabled') !== 'true';
      }, undefined, { timeout: 15000 });
    } catch { throw new RunError('COLLECT_BUTTON_NOT_READY', '表示中の送信ボタンが1個かつ有効な状態になりませんでした'); }
  });
}

async function waitForSocial(page, kind, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await ensureSocialPage(page);
    const controls = await readWhileNavigating(() => page.evaluate(inspectControls));
    if (controls[kind === 'follow' ? 'followControls' : 'likeControls'] > 0) return controls;
    await sleep(300);
  }
  throw new RunError('SOCIAL_NOT_READY', '一覧の操作ボタンを確認できません。読み込み未完了・未ログイン・画面変更の可能性があります');
}

async function diagnoseSocial(page) {
  await navigate(page, `${ROOM}/discover/recommendUsers`);
  const follow = await step('follow.ready', () => waitForSocial(page, 'follow'));
  await navigate(page, `${ROOM}/discover/recommendItems`);
  const like = await step('like.ready', () => waitForSocial(page, 'like'));
  return { followCandidates: follow.followCandidates, likeCandidates: like.likeCandidates };
}

async function postItem(page, item, content, account) {
  const state = await openCollect(page, item.itemCode, account);
  if (state === 'duplicate') return 'skipped';
  const text = typeof content === 'function' ? await content() : content;
  await prepareCollect(page, text);
  // Only the visible, actual submit button; a styled wrapper is not a button.
  await step('collect.submit', () => page.locator('button.collect-btn:visible, input.collect-btn[type="submit"]:visible').click({ timeout: 15000 }));
  // A click alone does not prove persistence. Reopen this product and require
  // ROOM's own duplicate acknowledgement. Never retry an uncertain submission.
  let verification;
  try {
    await sleep(3000);
    // Keep the submitting page alive so navigation cannot abort its request.
    verification = await page.context().newPage();
    await navigate(verification, mixUrl(item.itemCode));
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
  const state = await readWhileNavigating(() => page.evaluate(inspectPage));
  checkState(state);
  if (state === 'user' || state === 'password') throw new RunError('AUTH_EXPIRED', 'ログイン状態が失効しました');
}
async function performFollow(page) {
  await navigate(page, `${ROOM}/discover/recommendUsers`);
  await step('follow.ready', () => waitForSocial(page, 'follow'));
  let count = await followFromCurrentPage(page, 20);
  if (count < 20) {
    await navigate(page, `${ROOM}/discover/recommendUsers`);
    await step('follow.ready', () => waitForSocial(page, 'follow'));
    const name = page.locator('.name.ng-binding').first();
    try { await name.waitFor({ state: 'visible', timeout: 10000 }); }
    catch { return count; }
    await name.click();
    await page.waitForURL(url => url.pathname.includes('/room_'), { waitUntil: 'commit' });
    const url = new URL(page.url());
    url.pathname = url.pathname.replace(/\/[^/]*$/, '/followers');
    await navigate(page, url.toString());
    await step('follow.ready', () => waitForSocial(page, 'follow'));
    count += await followFromCurrentPage(page, 20 - count);
  }
  return count;
}
async function performLike(page) {
  await navigate(page, `${ROOM}/discover/recommendItems`);
  await step('like.ready', () => waitForSocial(page, 'like'));
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
module.exports = { prepareCollect, diagnoseSocial, waitForSocial, navigate, inspectPage, openCollect, postItem, performFollow, performLike, mixUrl };
