// Match internally, return fixed codes only. Never forward message, stack or URL.
function errorKind(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/strict mode violation/i.test(message)) return 'LOCATOR_AMBIGUOUS';
  if (/execution context was destroyed|cannot find context|JSHandle.*disposed/i.test(message)) return 'PAGE_NAVIGATING';
  if (/target.*(?:page|context|browser).*closed|browser has been closed/i.test(message)) return 'BROWSER_CLOSED';
  if (/not.*(?:input|textarea|contenteditable)|not editable/i.test(message)) return 'FORM_NOT_EDITABLE';
  if (/intercepts pointer events/i.test(message)) return 'CLICK_OBSTRUCTED';
  if (/element is outside of the viewport/i.test(message)) return 'CLICK_OUTSIDE_VIEWPORT';
  if (/element is not stable/i.test(message)) return 'CLICK_UNSTABLE';
  if (error?.name === 'TimeoutError') return 'TIMEOUT';
  if (error?.name === 'TypeError') return 'TYPE_ERROR';
  return 'UNEXPECTED';
}
const STEPS = new Set(['collect.open', 'collect.state', 'collect.item', 'login.user', 'login.next', 'login.password', 'login.submit', 'login.return', 'collect.fill', 'collect.ready', 'collect.actionable', 'collect.submit', 'collect.verify', 'follow.ready', 'like.ready']);
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
  const button = buttons.length === 1 ? buttons[0] : null;
  const rect = button?.getBoundingClientRect();
  const inViewport = !!rect && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
  const hit = inViewport ? document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2))) : null;
  let screen = 'other';
  if (location.hostname === 'room.rakuten.co.jp') {
    screen = location.pathname === '/mix' ? 'collect' : location.pathname.startsWith('/discover/') ? 'discover' : 'room';
  } else if (['login.account.rakuten.com', 'grp01.id.rakuten.co.jp'].includes(location.hostname)) screen = 'login';
  return {
    screen,
    submitInViewport: inViewport,
    submitReceivesPointer: !!hit && (hit === button || button.contains(hit)),
    pointerBlocker: !hit || hit === button || button?.contains(hit) ? 'none' : ['DIV', 'IFRAME', 'IMG', 'BUTTON', 'A', 'SPAN', 'BODY', 'HTML'].includes(hit.tagName) ? hit.tagName.toLowerCase() : 'other',
    blockerKinds: hit && button && !button.contains(hit) ? ['.background', '.modal-dialog-container', '.dialog-container', '.modal-popup', '.guidance-popup', '.header', '.footer', '.collect-form', '.loadingCircle'].filter(selector => hit.closest(selector)) : [],
    submitBounds: rect ? [rect.top, rect.bottom, rect.left, rect.right].map(Math.round) : [],
    visibleDialogs: count('.dialog-container, .guidance-popup, [role="dialog"]'),
    loadedItemNames: [...document.querySelectorAll('.collect-form .item-name')].filter(el => visible(el) && el.textContent.trim() && !el.textContent.includes('{{')).length,
    collectFields: fields.length,
    contentOverLimit: fields.some(el => (el.value || '').length > 500),
    contentLengthError: [...document.querySelectorAll('.collect-contents .warning')].some(el => visible(el) && el.textContent.trim() === '文字数オーバーです'),
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
