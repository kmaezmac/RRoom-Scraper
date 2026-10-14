const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { prepareCollect, waitForSocial, navigate, inspectPage, openCollect, postItem, performFollow, performLike } = require('../lib/room');
const { processAccount } = require('../index');
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const form = '<div class="collect-form"><div class="item-name">テスト商品</div><textarea id="collect-content"></textarea><button class="collect-btn" onclick="fetch(\'/api/collect\', {method:\'POST\'})">完了</button></div>';
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
  for (const [html, expected] of [[duplicate, 'duplicate'], ['<div class="modal-dialog-container">すでにコレ！している商品です</div>', 'duplicate'], ['<div class="modal-dialog-container">すでにコレ[[!]]している商品です</div>', 'duplicate'], ['<div class="modal-dialog-container">エラーが発生しました</div>', 'modal'], ['<input autocomplete="one-time-code">', 'challenge'], [form, 'form']]) {
    await page.setContent(html); assert.equal(await page.evaluate(inspectPage), expected);
  }
});
test('headless posting is confirmed only by re-reading ROOM duplicate state', async t => {
  let submitted = 0;
  const page = await fixture(t, url => {
    if (url.pathname === '/api/collect') { submitted++; return 'ok'; }
    return submitted ? '<div class="modal-dialog-container">すでにコレ！している商品です</div>' : form;
  });
  assert.equal(await postItem(page, { itemCode: 'shop:item' }, '投稿内容', {}), 'posted');
  assert.equal(submitted, 1);
  assert.equal(await postItem(page, { itemCode: 'shop:item' }, '投稿内容', {}), 'skipped');
  assert.equal(submitted, 1);
});
test('a click timeout after sending still verifies the saved result without resending', async t => {
  let submitted = 0;
  const page = await fixture(t, url => {
    if (url.pathname === '/api/collect') { submitted++; return 'ok'; }
    return submitted ? duplicate : form;
  });
  const locator = page.locator.bind(page);
  page.locator = (...args) => {
    const target = locator(...args);
    if (args[0] === 'button.collect-btn:visible, input.collect-btn[type="submit"]:visible') {
      const click = target.click.bind(target);
      target.click = async options => {
        if (options?.trial) return click(options);
        await click(options);
        await page.waitForFunction(() => document.readyState === 'complete');
        const error = new Error('private-url waiting for scheduled navigations to finish');
        error.name = 'TimeoutError';
        throw error;
      };
    }
    return target;
  };
  assert.equal(await postItem(page, { itemCode: 'shop:item' }, '内容', {}), 'posted');
  assert.equal(submitted, 1);
});
test('long content is shortened before ROOM validates and disables its submit button', async t => {
  let submitted = 0, length = 0;
  const page = await fixture(t, (url, request) => {
    if (url.pathname === '/api/collect') { submitted++; length = request.postData().length; return 'ok'; }
    return submitted ? duplicate : `<div class="collect-form"><div class="item-name">商品</div>
      <textarea id="collect-content" oninput="document.querySelector('button').disabled=this.value.length>500"></textarea>
      <button class="collect-btn" disabled onclick="fetch('/api/collect',{method:'POST',body:document.querySelector('textarea').value})">完了</button></div>`;
  });
  assert.equal(await postItem(page, { itemCode: 'shop:item' }, 'あ'.repeat(700), {}), 'posted');
  assert.equal(submitted, 1);
  assert.equal(length, 500);
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
test('a duplicate dialog arriving after form input skips without a submit click', async t => {
  let submitted = 0;
  const page = await fixture(t, url => {
    if (url.pathname === '/api/collect') { submitted++; return 'ok'; }
    return form + `<script>document.querySelector('textarea').addEventListener('input', () => {
      const dialog = document.createElement('div');
      dialog.className = 'dialog-container';
      dialog.style = 'position:fixed;inset:0;z-index:99999;background:white';
      dialog.textContent = 'すでにコレ！している商品です';
      document.body.append(dialog);
    });</script>`;
  });
  assert.equal(await postItem(page, { itemCode: 'shop:item' }, '内容', {}), 'skipped');
  assert.equal(submitted, 0);
});
test('an unknown dialog covering a visible form stops before input or submission', async t => {
  const page = await fixture(t, () => form + '<div class="dialog-container">private-user private-message</div>');
  await assert.rejects(openCollect(page, 'shop:item', {}), error => error.code === 'ROOM_MODAL' && !error.message.includes('private'));
});
test('collect waits for product data even when the input and button are already visible', async t => {
  const page = await fixture(t, () => form.replace('テスト商品', '') + '<script>setTimeout(()=>document.querySelector(".item-name").textContent="商品読込完了",1500)</script>');
  assert.equal(await openCollect(page, 'shop:item', {}), 'form');
  assert.equal(await page.locator('.item-name').textContent(), '商品読込完了');
});
test('ROOM submission rejection is classified without response text or retries', async t => {
  let submitted = 0;
  const page = await fixture(t, url => {
    if (url.pathname === '/api/collect') {
      submitted++;
      return { status: 400, contentType: 'application/json', body: JSON.stringify({ msg_code: 'R145', message: 'private-caption private-user https://private.invalid' }) };
    }
    return form;
  });
  await assert.rejects(postItem(page, { itemCode: 'shop:item' }, '内容', {}), error => {
    assert.equal(error.code, 'POST_R145');
    assert.equal(error.operation, 'collect.submit');
    assert.ok(!error.message.includes('private'));
    return true;
  });
  assert.equal(submitted, 1);
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
      const url = route.request().url();
      const body = url.includes('recommendUsers') ? '<button aria-label="フォローする">フォロー</button>'
        : url.includes('recommendItems') ? '<a class="icon-like right">いいね</a>' : form;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });
    return context;
  }};
  const result = await processAccount(wrappedBrowser, { mode: 'diagnose', stateDir, key: 'ab'.repeat(32), accessKey: 'test', maxItems: 30 }, { name: 'account1', appId: 'test' });
  assert.equal(result.ok, true); assert.equal(result.posted, 0); assert.equal(writes, 0); assert.equal(social, 2);
  assert.ok((await fs.readFile(path.join(stateDir, 'account1.enc'), 'utf8')).length > 0);
});
test('normal run skips a late duplicate, posts the next item, and respects the new-post limit', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rroom-run-test-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const axios = require('axios'); const get = axios.get;
  axios.get = async () => ({ data: { Items: ['existing', 'new', 'unused'].map(id => ({ Item: { itemCode: `shop:${id}` } })) } });
  t.after(() => { axios.get = get; });
  let posts = 0, unusedReads = 0;
  const wrappedBrowser = { newContext: async options => {
    const context = await browser.newContext(options);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      let body = form;
      if (url.pathname === '/api/collect') { posts++; body = 'ok'; }
      else if (url.pathname.includes('recommendUsers')) body = '<button aria-label="フォロー中">フォロー中</button>';
      else if (url.pathname.includes('recommendItems')) body = '<a class="icon-like right isLiked">いいね済み</a>';
      else if (url.searchParams.get('itemcode') === 'shop:existing') body = form + `<script>document.querySelector('textarea').oninput = () => {
        const dialog = document.createElement('div'); dialog.className = 'dialog-container';
        dialog.textContent = 'すでにコレ！している商品です'; document.body.append(dialog);
      };</script>`;
      else if (url.searchParams.get('itemcode') === 'shop:new' && posts) body = duplicate;
      else if (url.searchParams.get('itemcode') === 'shop:unused') unusedReads++;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });
    return context;
  }};
  const result = await processAccount(wrappedBrowser, { mode: 'run', stateDir, key: 'ab'.repeat(32), accessKey: 'test', maxItems: 3, maxPosts: 1 }, { name: 'account1', appId: 'test' });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 1);
  assert.equal(result.posted, 1);
  assert.equal(posts, 1);
  assert.equal(unusedReads, 0);
});
test('an unconfirmed submission fails and is never clicked a second time', async t => {
  let submitted = 0;
  const page = await fixture(t, url => {
    if (url.pathname === '/api/collect') submitted++;
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
test('collect ignores hidden duplicates and styled wrappers without choosing arbitrary buttons', async t => {
  const page = await fixture(t, () => `<textarea id="collect-content" style="display:none"></textarea><div class="collect-btn"><textarea id="collect-content"></textarea><button class="collect-btn">完了</button></div><button class="collect-btn" style="display:none">完了</button>`);
  await page.goto('https://room.rakuten.co.jp/mix');
  await prepareCollect(page, '入力のみ');
  assert.equal(await page.locator('textarea:visible').inputValue(), '入力のみ');
  await page.setContent('<textarea id="collect-content"></textarea><textarea id="collect-content"></textarea>');
  await assert.rejects(prepareCollect(page, '内容'), error => error.code === 'COLLECT_FIELD_COUNT');
});
test('social readiness waits for asynchronous lists and fails clearly on missing controls', async t => {
  const page = await fixture(t, () => '<script>setTimeout(()=>{document.body.innerHTML=\'<button aria-label="フォローする">フォロー</button>\'},500)</script>');
  await page.goto('https://room.rakuten.co.jp/discover/recommendUsers');
  assert.equal((await waitForSocial(page, 'follow', 3000)).followCandidates, 1);
  await page.setContent('<p>empty</p>');
  await assert.rejects(waitForSocial(page, 'like', 50), error => error.code === 'SOCIAL_NOT_READY');
});
test('UI diagnostics emit only predefined labels and counts, never user data', async t => {
  const { snapshot } = require('../lib/diagnostics');
  const page = await fixture(t, () => '<input id="user_id" value="secret-user"><a href="/room_private/items">private-name</a><textarea id="collect-content">private-caption</textarea>');
  await page.goto('https://room.rakuten.co.jp/mix?itemcode=private-product');
  const data = await snapshot(page);
  assert.equal(data.screen, 'collect'); assert.equal(data.collectFields, 1);
  const output = JSON.stringify(data);
  for (const value of ['secret-user', 'private-name', 'room_private', 'private-product', 'private-caption', 'https://']) assert.ok(!output.includes(value));
});
test('UI diagnostics distinguish an enabled button from an obstructed click without leaking overlay content', async t => {
  const { snapshot } = require('../lib/diagnostics');
  const page = await fixture(t, () => form + '<div id="private-account" style="position:fixed;inset:0;z-index:99999;background:white">private-caption https://private.invalid</div>');
  await page.goto('https://room.rakuten.co.jp/mix');
  let data = await snapshot(page);
  assert.equal(data.enabledSubmitButtons, 1);
  assert.equal(data.submitInViewport, true);
  assert.equal(data.submitReceivesPointer, false);
  assert.equal(data.pointerBlocker, 'div');
  assert.ok(!JSON.stringify(data).includes('private'));
  await page.locator('#private-account').evaluate(el => el.remove());
  data = await snapshot(page);
  assert.equal(data.submitReceivesPointer, true);
  assert.equal(data.pointerBlocker, 'none');
});
