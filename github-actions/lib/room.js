const { RunError } = require('./config');
const { sleep, limitPostContent } = require('./ranking');
const { step, readWhileNavigating, inspectControls } = require('./diagnostics');
const ROOM = 'https://room.rakuten.co.jp';
// ROOM's legacy query reader does not URL-decode itemcode. Encoding ':' makes
// its product lookup request a literal %3A code and leaves the item empty.
const mixUrl = code => `${ROOM}/mix?itemcode=${encodeURIComponent(code).replace(/%3A/gi, ':')}&scid=we_room_upc60`;

// Runs inside Chromium. Never returns page text, cookies or input values to logs.
function inspectPage() {
  const visible = el => el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const text = document.body?.innerText || '';
  if (/すでにコレ[\s!！\[\]]*(?:している|してい|済み|されています)/.test(text)) return 'duplicate';
  if (/アクセスが制限|Access Denied|アクセスを拒否/.test(text)) return 'blocked';
  if ([...document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], input[autocomplete="one-time-code"], input[name*="otp"]')].some(visible)
      || /認証コードを入力|ワンタイムパスワード|画像に表示されている文字/.test(text)) return 'challenge';
  if (visible(document.querySelector('#user_id'))) return 'user';
  if (visible(document.querySelector('#password_current'))) return 'password';
  // A dialog can cover a still-visible form. Do not mistake the underlying
  // textarea for an actionable posting screen.
  if ([...document.querySelectorAll('.dialog-container, .guidance-popup, [role="alert"], [role="dialog"]')].some(el => visible(el) && !el.querySelector('#collect-content'))) return 'modal';
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
  if (state === 'form') {
    await step('collect.item', async () => {
      try {
        await page.waitForFunction(() => {
          if (/すでにコレ[\s!！\[\]]*(?:している|してい|済み|されています)/.test(document.body?.innerText || '')) return true;
          return [...document.querySelectorAll('.collect-form .item-name')].some(el =>
            !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && el.textContent.trim() && !el.textContent.includes('{{'));
        }, undefined, { timeout: 30000 });
      } catch { throw new RunError('COLLECT_ITEM_NOT_READY', '投稿対象の商品情報を読み込めません。入力欄だけの状態では送信しません'); }
    });
    state = await readWhileNavigating(() => page.evaluate(inspectPage));
    checkState(state);
    if (!['form', 'duplicate'].includes(state)) throw new RunError('COLLECT_ITEM_NOT_READY', '商品情報の読み込み後に投稿画面を確認できません');
  }
  return state;
}

async function prepareCollect(page, content) {
  await step('collect.fill', async () => {
    const fields = page.locator('#collect-content:visible');
    if (await fields.count() !== 1) throw new RunError('COLLECT_FIELD_COUNT', '表示中の投稿入力欄が1個ではありません');
    await fields.fill(limitPostContent(content));
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
  let state = await readWhileNavigating(() => page.evaluate(inspectPage));
  if (state === 'duplicate') return 'duplicate';
  checkState(state);
  try {
    // Playwright's trial checks scrolling, stability and pointer interception
    // without clicking. diagnose must test these same conditions as run.
    await step('collect.actionable', () => page.locator('button.collect-btn:visible, input.collect-btn[type="submit"]:visible').click({ trial: true, timeout: 15000 }));
  } catch (error) {
    state = await readWhileNavigating(() => page.evaluate(inspectPage));
    if (state === 'duplicate') return 'duplicate';
    checkState(state);
    throw error;
  }
  return 'form';
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

async function postItem(page, item, content, account, { beforeSubmit = async () => true } = {}) {
  const state = await openCollect(page, item.itemCode, account);
  if (state === 'duplicate') return 'skipped';
  const text = typeof content === 'function' ? await content() : content;
  if (await prepareCollect(page, text) === 'duplicate') return 'skipped';
  // Product/duplicate dialogs may arrive after the item title or input appears.
  const submitState = await readWhileNavigating(() => page.evaluate(inspectPage));
  if (submitState === 'duplicate') return 'skipped';
  checkState(submitState);
  // Persist a unique pending record before any possible mutation.
  if (!await beforeSubmit()) return 'deferred';
  // Observe the UI's own request. Never print its URL, payload or response body.
  const responsePromise = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.hostname === 'room.rakuten.co.jp' && url.pathname === '/api/collect' && response.request().method() === 'POST';
  }, { timeout: 30000 }).catch(() => null);
  let requestSent = false;
  const observeRequest = request => {
    const url = new URL(request.url());
    if (url.hostname === 'room.rakuten.co.jp' && url.pathname === '/api/collect' && request.method() === 'POST') requestSent = true;
  };
  page.on('request', observeRequest);
  // Only the visible, actual submit button; a styled wrapper is not a button.
  let clickError;
  try { await step('collect.submit', () => page.locator('button.collect-btn:visible, input.collect-btn[type="submit"]:visible').click({ timeout: 15000 })); }
  catch (error) { clickError = error; }
  finally { page.off('request', observeRequest); }
  // The click can time out while waiting for navigation AFTER sending. Check
  // the existing request and saved result instead of either resending or
  // prematurely reporting that nothing was posted.
  if (clickError && !requestSent) {
    const state = await readWhileNavigating(() => page.evaluate(inspectPage));
    if (state === 'duplicate') return 'skipped';
    checkState(state);
    throw clickError;
  }
  const response = await responsePromise;
  if (response) {
    const body = await response.json().catch(() => null);
    const messages = {
      R133: 'すでにコレ済みの商品です',
      R122: '投稿数が楽天ROOMの上限に達しています',
      R119: '商品が削除されています', R120: '商品が削除されています', R143: '商品が削除されています',
      R145: '投稿文に楽天ROOMで使用できない文字列が含まれています',
      R106: '投稿文に楽天ROOMで使用できない文字・記号が含まれています',
    };
    if (body?.msg_code === 'R133') return 'skipped';
    await step('collect.submit', async () => {
      if (Object.hasOwn(messages, body?.msg_code)) throw new RunError(`POST_${body.msg_code}`, messages[body.msg_code]);
      if (response.status() >= 400) throw new RunError('POST_HTTP', `楽天ROOMが送信を拒否しました（HTTP ${response.status()}）`);
      if (body?.status === 'error' || body?.status === 'fail' || body?.msg_code) throw new RunError('POST_REJECTED', '楽天ROOMが送信エラーを返しました（本文は非公開）');
    });
  }
  // A click alone does not prove persistence. Reopen this product and require
  // ROOM's own duplicate acknowledgement. Never retry an uncertain submission.
  let verification;
  try {
    await sleep(3000);
    // Keep the submitting page alive so navigation cannot abort its request.
    verification = await page.context().newPage();
    await navigate(verification, mixUrl(item.itemCode));
    await verification.waitForFunction(() => /すでにコレ[\s!！\[\]]*(?:している|してい|済み|されています)/.test(document.body?.innerText || ''), undefined, { timeout: 15000 });
    return 'posted';
  } catch {
    const error = new RunError('POST_UNCONFIRMED', '投稿結果を確認できません。重複送信を避けるため、このアカウントを停止します。ROOMで直近の投稿を確認してください');
    error.operation = 'collect.verify';
    throw error;
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
