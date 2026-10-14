const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { navigate, inspectPage, openCollect, postItem, performFollow, performLike } = require('../lib/room');
const { processAccount } = require('../index');
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const form = '<textarea id="collect-content"></textarea><button class="collect-btn" onclick="fetch(\'/test-submit\', {method:\'POST\'})">完了</button>';
const duplicate = '<div class="modal-dialog-container">すでにコレしている商品です</div>';
async function fixture(t, render) {
  const context = await browser.newContext();
  await context.route('**/*', async route => {
    const result = await render(new URL(route.request().url()), route.request());
    await route.fulfill(typeof result === 'string' ? { contentType: 'text/html; charset=utf-8', body: result } : result);
  });
  t.after(() => context.close());
  return context.newPage();
}
test('classifies duplicate specifically, never treats every modal as collected', async t => {
  const page = await fixture(t, () => '');
  for (const [html, expected] of [[duplicate, 'duplicate'], ['<div class="modal-dialog-container">エラーが発生しました</div>', 'modal'], ['<input autocomplete="one-time-code">', 'challenge'], [form, 'form']]) {
    await page.setContent(html); assert.equal(await page.evaluate(inspectPage), expected);
  }
});
test('headless posting is confirmed only by re-reading ROOM duplicate state', async t => {
  let submitted = 0;
  const page = await fixture(t, url => {
    if (url.pathname === '/test-submit') { submitted++; return 'ok'; }
    return submitted ? duplicate : form;
  });
  assert.equal(await postItem(page, { itemCode: 'shop:item' }, '投稿内容', {}), 'posted');
  assert.equal(submitted, 1);
  assert.equal(await postItem(page, { itemCode: 'shop:item' }, '投稿内容', {}), 'skipped');
  assert.equal(submitted, 1);
});
test('unknown modal and missing auth stop without a mutation', async t => {
  let writes = 0;
  const page = await fixture(t, (url, request) => {
    if (request.method() !== 'GET') writes++;
    if (url.hostname === 'room.rakuten.co.jp') return '<script>location.href="https://login.account.rakuten.com/"</script>';
    return '<input id="user_id"><button id="cta001">次へ</button>';
  });
  await assert.rejects(openCollect(page, 'shop:item', {}), error => error.code === 'AUTH_REQUIRED');
  assert.equal(writes, 0);
});
test('headless two-step login returns to collect form', async t => {
  let loggedIn = false;
  const page = await fixture(t, url => {
    if (url.pathname === '/finish') { loggedIn = true; return '<script>location.href="https://room.rakuten.co.jp/"</script>'; }
    if (url.hostname === 'room.rakuten.co.jp') return loggedIn ? form : '<script>location.href="https://login.account.rakuten.com/"</script>';
    return `<input id="user_id"><button id="cta001" onclick="document.getElementById('password_current').style.display='block'">次へ</button><input id="password_current" style="display:none"><button id="cta011" onclick="location.href='/finish'">ログイン</button>`;
  });
  assert.equal(await openCollect(page, 'shop:item', { userId: 'test', password: 'test' }), 'form');
});
test('follow and like preserve 20-operation targets and do not repeatedly click one item', async t => {
  let follows = 0, likes = 0;
  const page = await fixture(t, url => {
    if (url.pathname === '/follow') { follows++; return ''; }
    if (url.pathname === '/like') { likes++; return ''; }
    if (url.pathname.includes('recommendUsers')) return Array.from({ length: 22 }, () => '<button aria-label="フォローする" onclick="fetch(\'/follow\')">フォロー</button>').join('');
    return Array.from({ length: 22 }, () => '<a class="icon-like right" onclick="fetch(\'/like\')">いいね</a>').join('');
  });
  assert.equal(await performFollow(page), 20);
  assert.equal(await performLike(page), 20);
  assert.equal(follows, 20); assert.equal(likes, 20);
});
test('diagnostic runner verifies login and persists encrypted session without social/post writes', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rroom-browser-test-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const axios = require('axios'); const get = axios.get;
  axios.get = async () => ({ data: { Items: [{ Item: { itemCode: 'shop:item' } }] } });
  t.after(() => { axios.get = get; });
  let writes = 0, social = 0;
  const wrappedBrowser = { newContext: async options => {
    const context = await browser.newContext(options);
    await context.route('**/*', async route => {
      if (route.request().method() !== 'GET') writes++;
      if (route.request().url().includes('/discover/')) social++;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: form });
    });
    return context;
  }};
  const result = await processAccount(wrappedBrowser, { mode: 'diagnose', stateDir, key: 'ab'.repeat(32), accessKey: 'test', maxItems: 30 }, { name: 'account1', appId: 'test' });
  assert.equal(result.ok, true); assert.equal(result.posted, 0); assert.equal(writes, 0); assert.equal(social, 0);
  assert.ok((await fs.readFile(path.join(stateDir, 'account1.enc'), 'utf8')).length > 0);
});
test('an unconfirmed submission fails and is never clicked a second time', async t => {
  let submitted = 0;
  const page = await fixture(t, url => {
    if (url.pathname === '/test-submit') submitted++;
    return form; // Simulate accepted click but no saved post.
  });
  await assert.rejects(postItem(page, { itemCode: 'shop:item' }, '内容', {}), error => error.code === 'POST_UNCONFIRMED');
  assert.equal(submitted, 1);
  assert.equal(page.context().pages().length, 1); // verification tab was closed
});
test('CAPTCHA stops before credentials or posting', async t => {
  const page = await fixture(t, () => '<input autocomplete="one-time-code">');
  await assert.rejects(openCollect(page, 'shop:item', { userId: 'test', password: 'test' }), error => error.code === 'AUTH_CHALLENGE');
});

test('slow document and parser-blocking scripts get separate timeout budgets', async t => {
  const page = await fixture(t, async url => {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (url.pathname === '/slow.js') return { contentType: 'text/javascript', body: 'window.ready = true;' };
    return '<script src="/slow.js"></script><p>ready</p>';
  });
  const response = await navigate(page, 'https://room.rakuten.co.jp/', 800);
  assert.equal(response.status(), 200);
  assert.equal(await page.evaluate(() => window.ready), true);
});
