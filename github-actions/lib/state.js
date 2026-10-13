const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { RunError } = require('./config');

function encrypt(value, key, account) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(Buffer.from(account));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
function decrypt(text, key, account) {
  try {
    const data = Buffer.from(text.trim(), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), data.subarray(0, 12));
    decipher.setAAD(Buffer.from(account));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
  } catch {
    throw new RunError('SESSION_DECRYPT', 'セッションを復号できません。暗号鍵・アカウント・SESSION_VERSIONを確認してください');
  }
}
async function loadState(config, account) {
  let encrypted;
  try { encrypted = await fs.readFile(path.join(config.stateDir, `${account.name}.enc`), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  encrypted ||= account.session;
  if (!encrypted) return { cookies: [], origins: [] };
  const state = decrypt(encrypted, config.key, account.name);
  if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new RunError('SESSION_FORMAT', 'セッション形式が不正です');
  return state;
}
async function saveState(config, account, state) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(config.stateDir, `${account.name}.enc`);
  await fs.writeFile(`${file}.tmp`, encrypt(state, config.key, account.name), { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}
module.exports = { encrypt, decrypt, loadState, saveState };
