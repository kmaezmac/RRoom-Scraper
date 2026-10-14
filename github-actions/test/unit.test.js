const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readConfig, safeError } = require('../lib/config');
const { encrypt, decrypt, saveState, loadState } = require('../lib/state');
const { fetchRanking, buildPostContent, limitPostContent } = require('../lib/ranking');
const { assessRun, renderSummary } = require('../lib/report');
const base = { SESSION_ENCRYPTION_KEY: 'ab'.repeat(32), RAKUTEN_APP_ID: 'app', ACCESS_TOKEN: 'key' };

test('confirmed posts followed by HTTP 503 keep the job successful and the error visible', () => {
  const account = { skipped: 0, followAttempts: 0, likeAttempts: 20, warnings: [] };
  const result = assessRun('run', [
    { ...account, account: 'account1', ok: false, stage: 'post', posted: 6, skipped: 4, operation: 'collect.submit', error: 'POST_HTTP: HTTP 503' },
    { ...account, account: 'account2', ok: true, stage: 'complete', posted: 7, skipped: 22 },
    { ...account, account: 'account3', ok: true, stage: 'complete', posted: 2, skipped: 28 },
  ]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'warning');
  assert.equal(result.posted, 15);
  assert.equal(result.results[0].status, 'warning');
  assert.equal(result.results[0].ok, false);
  const markdown = renderSummary({ mode: 'run', elapsedSeconds: 4280, ...result });
  assert.match(markdown, /警告あり（ジョブ成功）/);
  assert.match(markdown, /account1 \| 警告あり \| post \| 6/);
  assert.match(markdown, /collect.submit \/ POST_HTTP: HTTP 503/);
});
test('zero-post failures stay fatal; posting on another account does not hide failed accounts', () => {
  const failed = { account: 'account1', ok: false, posted: 0, stage: 'login', error: 'AUTH_FAILED', warnings: [] };
  const skipped = { account: 'account2', ok: true, posted: 0, skipped: 30, stage: 'complete', warnings: [] };
  assert.equal(assessRun('run', [failed, skipped]).exitCode, 1);
  const partial = assessRun('run', [failed, { ...skipped, posted: 1 }]);
  assert.equal(partial.exitCode, 0);
  assert.equal(partial.status, 'warning');
  assert.equal(partial.results[0].status, 'failure');
  assert.equal(assessRun('run', []).exitCode, 1);
});
test('all duplicates are successful; social-only warnings are nonfatal; diagnostics remain strict', () => {
  const complete = { ok: true, posted: 0, skipped: 30, stage: 'complete', warnings: [] };
  const warning = { ...complete, ok: false, stage: 'partial', warnings: ['follow / SOCIAL_NOT_READY'] };
  assert.equal(assessRun('run', [complete]).status, 'success');
  assert.equal(assessRun('run', [warning]).status, 'warning');
  assert.equal(assessRun('run', [warning]).exitCode, 0);
  assert.equal(assessRun('diagnose', [warning]).exitCode, 1);
  assert.equal(assessRun('diagnose', [{ ...complete, posted: 0 }]).exitCode, 0);
  const uncertain = { ...complete, ok: false, stage: 'post', error: 'POST_UNCONFIRMED' };
  assert.equal(assessRun('run', [uncertain]).exitCode, 1);
  assert.equal(assessRun('run', [{ ...uncertain, posted: 1 }]).status, 'warning');
});

test('defaults retain three accounts and no paid generator; diagnostic is default', () => {
  const config = readConfig(base);
  assert.deepEqual(config.accounts.map(a => a.name), ['account1', 'account2', 'account3']);
  assert.equal(config.mode, 'diagnose'); assert.equal(config.useOpenAI, false); assert.equal(config.maxItems, 30);
  assert.equal(config.maxPosts, 30);
  assert.equal(readConfig({ ...base, MAX_ITEMS: '30', MAX_POSTS: '1' }).maxPosts, 1);
  assert.equal(readConfig({ ...base, RUN_ACCOUNT: 'account3', RAKUTEN_APP_ID3: 'third' }).accounts[0].appId, 'third');
});
test('invalid configuration fails before browser launch', () => {
  for (const env of [{}, { ...base, RUN_ACCOUNT: 'typo' }, { ...base, RUN_MODE: 'typo' }, { ...base, MAX_ITEMS: '0' }, { ...base, MAX_ITEMS: '31' }, { ...base, MAX_POSTS: '0' }, { ...base, MAX_POSTS: '31' }, { ...base, MAX_POSTS: 'NaN' }, { ...base, USE_OPENAI: 'true' }]) assert.throws(() => readConfig(env));
});
test('session authenticated encryption rejects wrong keys, account swaps and tampering', () => {
  const state = { cookies: [{ value: 'private-cookie' }], origins: [] };
  const encrypted = encrypt(state, base.SESSION_ENCRYPTION_KEY, 'account1');
  assert.ok(!encrypted.includes('private-cookie'));
  assert.deepEqual(decrypt(encrypted, base.SESSION_ENCRYPTION_KEY, 'account1'), state);
  assert.throws(() => decrypt(encrypted, 'cd'.repeat(32), 'account1'));
  assert.throws(() => decrypt(encrypted, base.SESSION_ENCRYPTION_KEY, 'account2'));
  const damaged = Buffer.from(encrypted, 'base64'); damaged[30] ^= 1;
  assert.throws(() => decrypt(damaged.toString('base64'), base.SESSION_ENCRYPTION_KEY, 'account1'));
});
test('rotated cached session takes priority over bootstrap secret', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rroom-test-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const config = { stateDir, key: base.SESSION_ENCRYPTION_KEY };
  const old = { cookies: [{ value: 'old' }], origins: [] };
  const fresh = { cookies: [{ value: 'new' }], origins: [] };
  const account = { name: 'account1', session: encrypt(old, config.key, 'account1') };
  assert.deepEqual(await loadState(config, account), old);
  await saveState(config, account, fresh);
  assert.deepEqual(await loadState(config, account), fresh);
  assert.ok(!(await fs.readFile(path.join(stateDir, 'account1.enc'), 'utf8')).includes('new'));
});
test('ranking preserves Windows filters; puts access key in header, not URL', async () => {
  const config = readConfig(base); let calls = 0;
  const items = await fetchRanking(config.accounts[0], config, { random: () => 0.99, get: async (url, options) => {
    calls++; assert.equal(new URL(url).search, ''); assert.equal(options.params.sex, 1);
    assert.equal(options.params.age, 40); assert.equal(options.params.page, 34);
    assert.equal(options.headers.accessKey, 'key'); assert.equal(options.timeout, 30000);
    return { data: { Items: [{ Item: { itemCode: 'shop:item' } }] } };
  }});
  assert.equal(calls, 1); assert.equal(items[0].itemCode, 'shop:item');
});
test('read-only API retries temporary errors but fails 403 without retry or secrets', async () => {
  const config = readConfig(base); let attempts = 0;
  await assert.rejects(fetchRanking(config.accounts[0], config, { get: async () => { attempts++; throw { response: { status: 403 }, message: 'secret URL' }; } }), /HTTP 403/);
  assert.equal(attempts, 1); attempts = 0;
  await assert.rejects(fetchRanking(config.accounts[0], config, { wait: async () => {}, get: async () => { attempts++; throw { response: { status: 429 } }; } }), /HTTP 429/);
  assert.equal(attempts, 3);
});
test('empty or malformed rankings do not count as success', async () => {
  const config = readConfig(base);
  for (const data of [{}, { Items: [] }, { Items: [{}] }]) await assert.rejects(fetchRanking(config.accounts[0], config, { get: async () => ({ data }) }));
});
test('fallback content does not require OpenAI credentials', async () => {
  assert.equal(await buildPostContent({ itemName: '商品', catchcopy: '便利', itemCaption: '説明' }, { useOpenAI: false }), '商品便利説明 #あったら便利 #欲しいものリスト #ランキング #人気 #楽天市場');
  assert.ok(!safeError(new Error('password secretCookie')).includes('secretCookie'));
});
test('long product text fits ROOM UTF-16 limit, keeps hashtags, and preserves surrogate pairs', async () => {
  const text = await buildPostContent({ itemName: '長い商品名'.repeat(120), catchcopy: '説明'.repeat(200), itemCaption: '😀'.repeat(200) }, { useOpenAI: false });
  assert.equal(text.length, 500);
  assert.ok(text.endsWith(' #あったら便利 #欲しいものリスト #ランキング #人気 #楽天市場'));
  assert.equal(limitPostContent('あ'.repeat(499) + '😀'), 'あ'.repeat(499));
  assert.equal(limitPostContent('😀'.repeat(251)), '😀'.repeat(250));
  assert.equal(limitPostContent('短い文章'), '短い文章');
});
test('CLI configuration failure exits nonzero without leaking environment values', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'index.js'), '--check-config'], {
    env: { ...process.env, ...base, RUN_ACCOUNT: 'account1', RUN_MODE: 'invalid', RAKUTEN_PASSWORD: 'secret-do-not-print' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CONFIG/);
  assert.ok(!result.stderr.includes('secret-do-not-print'));
});
test('browser errors are classified without exposing URL, ID, DOM or credentials', async () => {
  const { step, operationOf, readWhileNavigating } = require('../lib/diagnostics');
  const secret = 'https://room.rakuten.co.jp/room_private/?token=secret-user';
  for (const [message, code] of [
    [`strict mode violation: ${secret}`, 'LOCATOR_AMBIGUOUS'],
    [`Execution context was destroyed ${secret}`, 'PAGE_NAVIGATING'],
    [`Target page, context or browser has been closed ${secret}`, 'BROWSER_CLOSED'],
    [`Element is not an input, textarea or contenteditable element ${secret}`, 'FORM_NOT_EDITABLE'],
    [`${secret} intercepts pointer events`, 'CLICK_OBSTRUCTED'],
    [`element is outside of the viewport ${secret}`, 'CLICK_OUTSIDE_VIEWPORT'],
    [`element is not stable ${secret}`, 'CLICK_UNSTABLE'],
  ]) {
    const result = safeError(new Error(message));
    assert.ok(result.startsWith(code)); assert.ok(!result.includes(secret)); assert.ok(!result.includes('room_private'));
  }
  let clicks = 0;
  await assert.rejects(step('collect.submit', () => { clicks++; throw new Error(`Execution context was destroyed ${secret}`); }), error => operationOf(error) === 'collect.submit');
  assert.equal(clicks, 1); // Never retry mutation after an ambiguous error.
  let reads = 0;
  assert.equal(await readWhileNavigating(() => { if (++reads === 1) throw new Error('Execution context was destroyed'); return 'ready'; }), 'ready');
  assert.equal(operationOf({ operation: secret }), 'unknown');
});
test('ROOM product query keeps the literal colon required by its legacy parser', () => {
  const { mixUrl } = require('../lib/room');
  const url = new URL(mixUrl('shop:12345'));
  const legacyValue = url.search.slice(1).split('&').find(part => part.startsWith('itemcode=')).split('=')[1];
  assert.equal(legacyValue, 'shop:12345');
  assert.equal(new URL(mixUrl('shop:item&extra=value')).searchParams.has('extra'), false);
});
