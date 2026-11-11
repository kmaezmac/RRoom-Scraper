const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/install-browser.sh');
function run(t, stage, failures, code = 100) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-install-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'npx'), `#!/bin/bash
count=0
if [[ -f "$TEST_DIR/count" ]]; then read -r count < "$TEST_DIR/count"; fi
count=$((count + 1))
echo "$count" > "$TEST_DIR/count"
echo "$*" >> "$TEST_DIR/commands"
if (( count <= FAILURES )); then exit "$FAIL_CODE"; fi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'sleep'), '#!/bin/bash\necho "$1" >> "$TEST_DIR/delays"\n', { mode: 0o755 });
  const result = spawnSync('bash', [script, stage], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TEST_DIR: dir, FAILURES: String(failures), FAIL_CODE: String(code) } });
  const read = name => fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n') : [];
  return { ...result, commands: read('commands'), delays: read('delays') };
}
test('successful OS setup does not retry', t => {
  const r = run(t, 'deps', 0); assert.equal(r.status, 0);
  assert.deepEqual(r.commands, ['--no-install playwright install-deps chromium']); assert.deepEqual(r.delays, []);
});
test('temporary OS download failure recovers with bounded backoff', t => {
  const r = run(t, 'deps', 2); assert.equal(r.status, 0); assert.equal(r.commands.length, 3); assert.deepEqual(r.delays, ['20', '40']);
});
test('permanent failure remains fatal after three attempts', t => {
  const r = run(t, 'deps', 10); assert.equal(r.status, 100); assert.equal(r.commands.length, 3); assert.deepEqual(r.delays, ['20', '40']);
});
test('browser retries do not reinstall OS dependencies', t => {
  const r = run(t, 'browser', 1); assert.equal(r.status, 0);
  assert.deepEqual(r.commands, Array(2).fill('--no-install playwright install chromium --only-shell'));
});
test('cancellation and invalid stages are not retried', t => {
  for (const code of [130, 143]) { const r = run(t, 'deps', 3, code); assert.equal(r.status, code); assert.equal(r.commands.length, 1); assert.deepEqual(r.delays, []); }
  const r = run(t, 'invalid', 0); assert.equal(r.status, 2); assert.deepEqual(r.commands, []);
});
