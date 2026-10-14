const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readConfig, safeError } = require('../lib/config');
const { encrypt, decrypt, saveState, loadState } = require('../lib/state');
const { fetchRanking, buildPostContent } = require('../lib/ranking');
const base = { SESSION_ENCRYPTION_KEY: 'ab'.repeat(32), RAKUTEN_APP_ID: 'app', ACCESS_TOKEN: 'key' };

test('defaults retain three accounts and no paid generator; diagnostic is default', () => {
  const config = readConfig(base);
  assert.deepEqual(config.accounts.map(a => a.name), ['account1', 'account2', 'account3']);
  assert.equal(config.mode, 'diagnose'); assert.equal(config.useOpenAI, false); assert.equal(config.maxItems, 30);
  assert.equal(readConfig({ ...base, RUN_ACCOUNT: 'account3', RAKUTEN_APP_ID3: 'third' }).accounts[0].appId, 'third');
});
test('invalid configuration fails before browser launch', () => {
  for (const env of [{}, { ...base, RUN_ACCOUNT: 'typo' }, { ...base, RUN_MODE: 'typo' }, { ...base, MAX_ITEMS: '0' }, { ...base, MAX_ITEMS: '31' }, { ...base, USE_OPENAI: 'true' }]) assert.throws(() => readConfig(env));
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
