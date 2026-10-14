// Match internally, return fixed codes only. Never forward message, stack or URL.
function errorKind(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/strict mode violation/i.test(message)) return 'LOCATOR_AMBIGUOUS';
  if (/execution context was destroyed|cannot find context|JSHandle.*disposed/i.test(message)) return 'PAGE_NAVIGATING';
  if (/target.*(?:page|context|browser).*closed|browser has been closed/i.test(message)) return 'BROWSER_CLOSED';
  if (/not.*(?:input|textarea|contenteditable)|not editable/i.test(message)) return 'FORM_NOT_EDITABLE';
  if (error?.name === 'TimeoutError') return 'TIMEOUT';
  if (error?.name === 'TypeError') return 'TYPE_ERROR';
  return 'UNEXPECTED';
}
const STEPS = new Set(['collect.open', 'collect.state', 'collect.item', 'login.user', 'login.next', 'login.password', 'login.submit', 'login.return', 'collect.fill', 'collect.ready', 'collect.submit', 'collect.verify', 'follow.ready', 'like.ready']);
async function step(name, action) {
  try { return await action(); }
  catch (error) {
    if (error && typeof error === 'object' && !error.operation && STEPS.has(name)) error.operation = name;
    throw error;
  }
}
function operationOf(error) { return STEPS.has(error?.operation) ? error.operation : 'unknown'; }

// Executed inside Chromium. Only enum labels, booleans and counts leave the page.
function inspectControls() {
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const count = selector => [...document.querySelectorAll(selector)].filter(visible).length;
  const fields = [...document.querySelectorAll('#collect-content')].filter(visible);
  const buttons = [...document.querySelectorAll('button.collect-btn, input.collect-btn[type="submit"]')].filter(visible);
  let screen = 'other';
  if (location.hostname === 'room.rakuten.co.jp') {
    screen = location.pathname === '/mix' ? 'collect' : location.pathname.startsWith('/discover/') ? 'discover' : 'room';
  } else if (['login.account.rakuten.com', 'grp01.id.rakuten.co.jp'].includes(location.hostname)) screen = 'login';
  return {
    screen,
    loadedItemNames: [...document.querySelectorAll('.collect-form .item-name')].filter(el => visible(el) && el.textContent.trim() && !el.textContent.includes('{{')).length,
    collectFields: fields.length,
    editableFields: fields.filter(el => el.matches('textarea,input,[contenteditable="true"]') && !el.disabled && !el.readOnly).length,
    submitButtons: buttons.length,
    enabledSubmitButtons: buttons.filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true').length,
    userFields: count('#user_id'), passwordFields: count('#password_current'),
    followCandidates: [...document.querySelectorAll('button[aria-label="フォローする"], .border-button')].filter(el => visible(el) && !el.disabled && (el.matches('button') || el.querySelector('span.follow.icon-follow:not(.ng-hide)'))).length,
    followControls: count('button[aria-label="フォローする"], button[aria-label="フォロー中"], .border-button'),
    likeCandidates: count('a.icon-like.right:not(.isLiked)'),
    likeControls: count('a.icon-like.right'),
  };
}
async function snapshot(page) {
  try { return await page.evaluate(inspectControls); }
  catch { return { screen: 'unavailable' }; }
}
async function readWhileNavigating(action, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { return await action(); }
    catch (error) {
      if (errorKind(error) !== 'PAGE_NAVIGATING' || Date.now() >= end) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}
module.exports = { errorKind, step, operationOf, inspectControls, snapshot, readWhileNavigating };
