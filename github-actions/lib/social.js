const { sleep } = require('./ranking');
const ROOM = 'https://room.rakuten.co.jp';
// This function runs in the page; user identifiers never enter logs or the DB.
function scanSocial({ kind, mark = false }) {
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const text = [...document.querySelectorAll('[role="alert"], [role="dialog"], .modal-dialog-container, .dialog-container, .guidance-popup')].filter(visible).map(el => el.innerText).join(' ');
  if (/上限|一定時間.*(?:お待ち|できません)|時間をおいて|時間を空け|アクセスが制限/.test(text)) return { limited: true };
  const following = el => /フォロー中|フォロー解除|フォローを解除/.test(el.innerText + (el.getAttribute('aria-label') || '')) || el.classList.contains('following') || visible(el.querySelector('.active.icon-follow'));
  const controls = kind === 'follow'
    ? [...document.querySelectorAll('button[aria-label="フォローする"], .border-button, button')].filter(el => visible(el) && !el.disabled && !following(el) && (el.getAttribute('aria-label') === 'フォローする' || visible(el.querySelector('span.follow.icon-follow')) || /^フォロー(?:する)?$/.test(el.innerText.trim())))
    : [...document.querySelectorAll('a.icon-like.right:not(.isLiked)')].filter(visible);
  const el = controls.find(el => !el.dataset.rroomAttempted);
  if (!el) return { empty: true };
  const card = el.closest('li, article, .userInner') || el.parentElement;
  const link = card?.querySelector('a[href]');
  const key = link?.href || '';
  if (mark) { el.dataset.rroomAttempted = 'true'; el.dataset.rroomSelected = 'true'; }
  return { key };
}
function collectSources() {
  const skip = new Set(['discover','search','info','feature','campaign','settings','my-room','login']);
  return [...new Set([...document.querySelectorAll('a[href]')].flatMap(a => {
    try {
      const u = new URL(a.href); const parts = u.pathname.split('/').filter(Boolean);
      if (u.origin !== location.origin || parts.length !== 2 || parts[1] !== 'items' || skip.has(parts[0])) return [];
      return [`${u.origin}/${parts[0]}/followers`];
    } catch { return []; }
  }))].slice(0, 30);
}
async function scrollLists(page) {
  await page.evaluate(() => {
    // ROOM's follower dialog loads on its own scroll container, not window.
    const lists = [...document.querySelectorAll('[load-more], .modal-popup .body, .modal-popup .list')];
    for (const el of lists) if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  });
}
async function runSocial(page, kind, { navigate, target = 50, reserve, block, wait = sleep, timeout = 8 * 60000 } = {}) {
  const result = { attempted: 0, confirmed: 0, pages: 0, stop: 'candidates_exhausted' };
  const queue = [kind === 'follow' ? `${ROOM}/discover/recommendUsers` : `${ROOM}/discover/recommendItems`];
  if (kind === 'follow') queue.push(`${ROOM}/discover/recommendItems`);
  const visited = new Set(), seen = new Set();
  const deadline = Date.now() + timeout;
  while (queue.length && result.pages < 10 && result.attempted < target && Date.now() < deadline) {
    const url = queue.shift(); if (visited.has(url)) continue; visited.add(url);
    await navigate(page, url); result.pages++;
    await wait(3000);
    for (let idle = 0, scrolls = 0; idle < 3 && scrolls < 20 && result.attempted < target && Date.now() < deadline;) {
      if (new URL(page.url()).hostname !== 'room.rakuten.co.jp') { result.stop = 'auth'; return result; }
      if (kind === 'follow') for (const source of await page.evaluate(collectSources)) if (!visited.has(source) && !queue.includes(source) && queue.length < 30) queue.push(source);
      const candidate = await page.evaluate(scanSocial, { kind, mark: true });
      if (candidate.limited) { await block(true); result.stop = 'limited'; return result; }
      if (candidate.empty) { idle++; scrolls++; await scrollLists(page); await wait(2000); continue; }
      const selected = page.locator('[data-rroom-selected="true"]').first();
      if (candidate.key && seen.has(candidate.key)) { await selected.evaluate(el => delete el.dataset.rroomSelected); continue; }
      if (candidate.key) seen.add(candidate.key);
      if (!await reserve()) { result.stop = 'budget'; return result; }
      result.attempted++;
      try { await selected.click({ timeout: 5000 }); }
      catch { await block(false); result.stop = 'unconfirmed'; return result; }
      let confirmed = false;
      for (let checks = 0; checks < 10; checks++) {
        await wait(300);
        const state = await page.evaluate(scanSocial, { kind });
        if (state.limited) { await block(true); result.stop = 'limited'; return result; }
        confirmed = await selected.evaluate((el, kind) => kind === 'like' ? el.classList.contains('isLiked') :
          el.classList.contains('following') || /フォロー中|フォロー解除|フォローを解除/.test(el.innerText + (el.getAttribute('aria-label') || '')) ||
          [...el.querySelectorAll('.active.icon-follow')].some(n => !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length)), kind).catch(() => false);
        if (confirmed) break;
      }
      if (!confirmed) { await block(false); result.stop = 'unconfirmed'; return result; }
      result.confirmed++; idle = 0;
      await selected.evaluate(el => delete el.dataset.rroomSelected);
      await wait(3000);
    }
  }
  if (result.attempted >= target) result.stop = 'target';
  else if (Date.now() >= deadline) result.stop = 'time';
  return result;
}
module.exports = { runSocial };
