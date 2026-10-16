const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig, safeError } = require('../lib/config');
const { HistoryStore } = require('../lib/history');
const { Candidates, TTL } = require('../lib/candidates');
const { fetchRanking, buildPostContent } = require('../lib/ranking');
const base = { SESSION_ENCRYPTION_KEY: 'ab'.repeat(32), RAKUTEN_APP_ID: 'app', ACCESS_TOKEN: 'key' };
const item = id => ({ itemCode: `shop:${id}`, itemName: id });
function memoryHistory() {
  return {
    saved: null, codes: new Set(), saves: 0,
    async state() { return structuredClone(this.saved); },
    async saveState(state) { this.saved = structuredClone(state); this.saves++; },
    async known(items) { return new Set(items.filter(i => this.codes.has(i.itemCode)).map(i => i.itemCode)); },
  };
}
test('per-account multiple genres validate and preserve empty legacy selection', () => {
  const config = readConfig({ ...base, ACCOUNT_GENRES1: '100804, 100533,100804', ACCOUNT_GENRES3: '215783' });
  assert.deepEqual(config.accounts.map(a => a.genres), [['100804','100533'], [], ['215783']]);
  for (const value of ['abc', '0', '100804,', '1&token=secret']) assert.throws(() => readConfig({ ...base, ACCOUNT_GENRES1: value }));
  assert.throws(() => readConfig({ ...base, HISTORY_ENABLED: 'true' }));
  assert.throws(() => readConfig({ ...base, RANKING_PAGES_PER_RUN: '4' }));
  assert.equal(config.rankingPages, 1);
});
test('genre requests remove incompatible demographic filters and pace requests', async () => {
  const account = { appId: 'app', genres: ['100804','100533'] };
  const waits = [];
  const rows = await fetchRanking(account, { maxItems: 1 }, {
    genreId: '100533', page: 2, fullPage: true, wait: async ms => waits.push(ms),
    get: async (_, options) => {
      assert.equal(options.params.genreId, '100533'); assert.equal(options.params.page, 2);
      assert.ok(!('sex' in options.params)); assert.ok(!('age' in options.params));
      return { data: { Items: [item('a'),item('b')].map(Item => ({ Item })) } };
    },
  });
  assert.equal(rows.length, 2); assert.equal(rows[0].requestedGenreId, '100533');
  assert.deepEqual(waits, [1100]);
});
test('history skips all known candidates then advances page next run without request amplification', async () => {
  const history = memoryHistory();
  for (let i=0;i<30;i++) history.codes.add(`shop:${i}`);
  const calls = [];
  const ranking = async (_, __, options) => { calls.push(options); return options.page === 1 ? Array.from({length:30}, (_,i)=>item(String(i))) : [item('fresh')]; };
  const account = { genres: ['100804'] }, config = { rankingPages: 1 };
  const first = new Candidates(account, config, history, { ranking });
  await first.init(); assert.equal(await first.next(), null); assert.equal(first.historySkipped, 30); assert.equal(calls.length, 1);
  const second = new Candidates(account, config, history, { ranking });
  await second.init(); assert.equal((await second.next()).itemCode, 'shop:fresh');
  assert.deepEqual(calls.map(c=>c.page), [1,2]);
});
test('optional refill crosses genres in same run and persists unused candidates', async () => {
  const history = memoryHistory(); history.codes.add('shop:old'); const calls=[];
  const account = { genres: ['100804','100533'] }, config = { rankingPages: 2 };
  const ranking = async (_, __, options) => { calls.push(options.genreId); return options.genreId === '100804' ? [item('old')] : [item('new'),item('remaining')]; };
  const first = new Candidates(account, config, history, { ranking }); await first.init();
  assert.equal((await first.next()).itemCode, 'shop:new'); await first.save();
  assert.deepEqual(calls, ['100804','100533']);
  const second = new Candidates(account, config, history, { ranking }); await second.init();
  assert.equal((await second.next()).itemCode,'shop:remaining'); assert.equal(second.pages,0);
});
test('genre changes and stale candidates cannot leak old candidates into new themes', async () => {
  const history = memoryHistory();
  history.saved={version:1,signature:'["100804"]',turn:0,pages:{},pool:[{item:item('old'),fetchedAt:1}]};
  const account={genres:['100533']};
  const candidates = new Candidates(account,{rankingPages:1},history,{ranking:async()=>[item('new')],now:()=>TTL+2});
  await candidates.init(); assert.equal((await candidates.next()).itemCode,'shop:new');
  history.saved={version:1,signature:'["100533"]',turn:0,pages:{},pool:[{item:item('expired'),fetchedAt:1}]};
  const same = new Candidates(account,{rankingPages:1},history,{ranking:async()=>[item('fresh')],now:()=>TTL+2});
  await same.init(); assert.equal((await same.next()).itemCode,'shop:fresh');
});
test('empty pages are bounded and rotate to other genres without a browser attempt', async () => {
  const history=memoryHistory(); const calls=[];
  const candidates=new Candidates({genres:['1','2']},{rankingPages:2},history,{ranking:async(_,__,o)=>{calls.push(o.genreId);return [];}});
  await candidates.init(); assert.equal(await candidates.next(),null); assert.deepEqual(calls,['1','2']);
});
test('Supabase lookup scopes accounts, batches codes and does not disclose request secrets on failure', async () => {
  const requests=[]; const config={supabaseUrl:'https://example.supabase.co',supabaseKey:'sb_secret_private'};
  const store=new HistoryStore(config,{name:'account2'},async(url,options)=>{
    requests.push({url:new URL(url),options});return {ok:true,text:async()=>JSON.stringify([{item_code:'shop:1'}])};
  });
  const known=await store.known(Array.from({length:31},(_,i)=>item(String(i))));
  assert.equal(requests.length,2); assert.ok(known.has('shop:1'));
  assert.equal(requests[0].url.searchParams.get('account'),'eq.account2');
  assert.equal(requests[0].options.headers.Authorization,undefined);
  assert.equal(requests[0].options.headers.apikey,config.supabaseKey);
  const failing=new HistoryStore(config,{name:'account1'},async()=>{throw new Error(config.supabaseKey);});
  await assert.rejects(failing.state(), e=>safeError(e).startsWith('HISTORY_DB:')&&!safeError(e).includes('private'));
});
test('atomic claims do not overwrite an existing pending or posted record', async () => {
  const seen=new Set(); const store=new HistoryStore({supabaseUrl:'https://example.supabase.co',supabaseKey:'legacy.jwt'}, {name:'account1'}, async(_,options)=>{
    assert.equal(options.headers.Authorization,'Bearer legacy.jwt');
    assert.equal(options.headers.Prefer,'resolution=ignore-duplicates,return=representation');
    const row=JSON.parse(options.body); assert.equal(row.status,'pending');
    const rows=seen.has(row.item_code)?[]:[row];seen.add(row.item_code);return {ok:true,text:async()=>JSON.stringify(rows)};
  });
  assert.equal(await store.claim(item('a')),true);assert.equal(await store.claim(item('a')),false);
});
test('genre tags derive from selection and unknown genres use neutral fallback within 500 units', async () => {
  const text=await buildPostContent({...item('a'),requestedGenreId:'100804',itemCaption:'説明'.repeat(500)},{useOpenAI:false});
  assert.ok(text.includes('#インテリア'));assert.ok(text.includes('#ランキング'));assert.ok(text.length<=500);
  assert.ok((await buildPostContent({...item('b'),genreId:'99999'},{useOpenAI:false})).endsWith('#商品紹介 #あったら便利 #欲しいものリスト #ランキング #人気 #楽天市場 #お買い物メモ #おすすめ商品'));
});
test('short pages still advance because removed ranking entries may leave gaps', async () => {
  const history=memoryHistory(); const calls=[];
  const ranking=async(_,__,o)=>{calls.push(o.page);return [item('old')];};history.codes.add('shop:old');
  for(let n=0;n<2;n++){
    const candidates=new Candidates({genres:['100804']},{rankingPages:1},history,{ranking});
    await candidates.init();assert.equal(await candidates.next(),null);
  }
  assert.deepEqual(calls,[1,2]);
});
test('pending entries are excluded exactly like confirmed history on the next run', async () => {
  const request=async(url)=>{
    const table=new URL(url).pathname;
    return {ok:true,text:async()=>table.endsWith('room_candidate_state')?'[]':JSON.stringify([{item_code:'shop:uncertain'}])};
  };
  const history=new HistoryStore({supabaseUrl:'https://example.supabase.co',supabaseKey:'sb_secret_test'},{name:'account1'},request);
  const candidates=new Candidates({genres:[]},{rankingPages:1},history,{ranking:async()=>[item('uncertain'),item('fresh')]});
  await candidates.init();assert.equal((await candidates.next()).itemCode,'shop:fresh');assert.equal(candidates.historySkipped,1);
});
test('a pre-submit failure preserves the current candidate without refreshing its TTL', async () => {
  const history=memoryHistory();
  const candidates=new Candidates({genres:[]},{rankingPages:1},history,{now:()=>100,ranking:async()=>[item('retry'),item('next')]});
  await candidates.init();await candidates.next();candidates.restoreCurrent();await candidates.save();
  assert.equal(history.saved.pool[0].item.itemCode,'shop:retry');assert.equal(history.saved.pool[0].fetchedAt,100);
  const resumed=new Candidates({genres:[]},{rankingPages:1},history,{now:()=>200,ranking:()=>{throw new Error('extra API call');}});
  await resumed.init();assert.equal((await resumed.next()).itemCode,'shop:retry');resumed.acknowledge();resumed.restoreCurrent();await resumed.save();
  assert.equal(history.saved.pool[0].item.itemCode,'shop:next');
});
test('documented ranking not_found advances the cursor; auth and unexpected 404 remain fatal', async () => {
  const account={appId:'app',genres:['100804']};
  const fetchPage=data=>fetchRanking(account,{maxItems:30},{allowEmpty:true,wait:async()=>{},get:async()=>{throw {response:{status:404,data}};}});
  assert.deepEqual(await fetchPage({error:'not_found'}),[]);
  await assert.rejects(fetchPage({error:'other'}),/HTTP 404/);
  const history=memoryHistory();history.saved={version:1,signature:'["100804"]',turn:0,pages:{100804:2},pool:[]};
  const candidates=new Candidates(account,{rankingPages:1},history,{ranking:()=>fetchPage({error:'not_found'})});
  await candidates.init();assert.equal(await candidates.next(),null);assert.equal(history.saved.pages['100804'],1);
});
test('all supported catalog genres have tags and medicine rankings are rejected', () => {
  const { genreTags, tagsFor, parseGenres, isRoomEligible } = require('../lib/genres');
  assert.equal(Object.keys(genreTags).length, 36);
  for (const id of Object.keys(genreTags)) {
    assert.deepEqual(parseGenres(id), [id]);
    assert.ok(!tagsFor({requestedGenreId:id}).includes('#商品紹介'));
    const text = tagsFor({requestedGenreId:id});
    for (const tag of ['あったら便利','欲しいものリスト','ランキング','人気','楽天市場','お買い物メモ','おすすめ商品']) {
      assert.equal(text.split(' ').filter(word => word === `#${tag}`).length, 1);
    }
  }
  for (const id of ['551169','201541']) assert.throws(()=>parseGenres(id), /対象外/);
  for (const row of [
    {...item('drug'),itemName:'【第２類医薬品】かぜ薬'},
    {...item('drug'),itemName:'指定第2類医薬品'},
    {...item('drug'),genreId:201541},
    {itemCode:'rakutenkobo-ebooks:123',itemName:'本'},
    {itemCode:'book:123',itemName:'ソフト ダウンロード版'},
  ]) assert.equal(isRoomEligible(row), false);
  for (const name of ['医薬部外品 シャンプー','Kobo 電子書籍リーダー ケース','薬の歴史についての本','コンタクトレンズ']) {
    assert.equal(isRoomEligible({...item('allowed'),itemName:name}), true);
  }
});
test('excluded candidates advance raw page cursors without increasing the API budget', async () => {
  const history=memoryHistory(), calls=[];
  const ranking=async(_,__,o)=>{calls.push([o.genreId,o.page]);return [{...item('drug'),itemName:'第1類医薬品'}];};
  for(let n=0;n<4;n++) {
    const candidates=new Candidates({genres:['100804','100533']},{rankingPages:1},history,{ranking});
    await candidates.init(); assert.equal(await candidates.next(),null);
  }
  assert.deepEqual(calls,[['100804',1],['100533',1],['100804',2],['100533',2]]);
});
test('cached excluded items are removed before browser selection and eligible leftovers need no API', async () => {
  const history=memoryHistory();
  history.saved={version:1,signature:'[]',turn:0,pages:{},pool:[
    {item:{itemCode:'rakutenkobo-ebooks:1'},fetchedAt:100},
    {item:item('good'),fetchedAt:100},
  ]};
  const candidates=new Candidates({genres:[]},{rankingPages:1},history,{now:()=>200,ranking:()=>{throw new Error('extra API call');}});
  await candidates.init();assert.equal((await candidates.next()).itemCode,'shop:good');assert.equal(candidates.pages,0);
});
test('sold-out ranking rows are skipped before selection without extra API calls or history records', async () => {
  const { isRoomEligible } = require('../lib/genres');
  for (const availability of [0,'0']) assert.equal(isRoomEligible({...item('sold'),availability}),false);
  for (const availability of [1,'1',undefined,null]) assert.equal(isRoomEligible({...item('available'),availability}),true);
  const history=memoryHistory(); let calls=0;
  const candidates=new Candidates({genres:[]},{rankingPages:1},history,{ranking:async()=>{
    calls++;return [{...item('sold'),availability:0},{...item('available'),availability:1}];
  }});
  await candidates.init();assert.equal((await candidates.next()).itemCode,'shop:available');
  assert.equal(calls,1);assert.equal(history.codes.size,0);
  assert.equal(history.saved.pool.length,1);assert.equal(history.saved.pool[0].item.availability,1);
});
test('all-sold-out pages advance and saved sold-out candidates are removed', async () => {
  const history=memoryHistory(); const calls=[];
  history.saved={version:1,signature:'[]',turn:0,pages:{},pool:[{item:{...item('cached'),availability:0},fetchedAt:100}]};
  for(let n=0;n<2;n++) {
    const candidates=new Candidates({genres:[]},{rankingPages:1},history,{now:()=>200,ranking:async(_,__,o)=>{
      calls.push(o.page);return [{...item('sold'),availability:'0'}];
    }});
    await candidates.init();assert.equal(await candidates.next(),null);
  }
  assert.deepEqual(calls,[1,2]);assert.equal(history.saved.pool.length,0);
});
test('social reservations survive restarts and enforce rolling hourly/daily budgets', async () => {
  const { SocialBudget } = require('../lib/social-budget');
  let saved, now=100000000;
  const history={account:'account1',api:async(_,options)=>{if(options.method==='POST'){saved=structuredClone(options.body.state);return null;}return saved?[{state:structuredClone(saved)}]:[];}};
  const budget=new SocialBudget(history,()=>now);await budget.init();
  for(let i=0;i<50;i++)assert.equal(await budget.reserve('follow'),true);
  assert.equal(await budget.reserve('follow'),false);assert.equal(await budget.reserve('like'),true);
  const next=new SocialBudget(history,()=>now);await next.init();assert.equal(await next.reserve('follow'),false);
  now+=3600001;assert.equal(await next.reserve('follow'),true);
  next.state.follow=Array.from({length:450},()=>now-7200000);assert.equal(await next.reserve('follow'),false);
  await next.block('like',true);now+=3600001;assert.equal(await next.reserve('like'),false);
  now+=86400001;assert.equal(await next.reserve('like'),true);
});
