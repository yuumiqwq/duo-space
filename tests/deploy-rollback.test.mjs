import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const unix = value => value.replaceAll('\\', '/').replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`);
async function bashExecutable() {
  if (process.platform !== 'win32') return 'bash';
  for (const candidate of [process.env.BASH_PATH, 'E:/Git/bin/bash.exe', 'C:/Program Files/Git/bin/bash.exe'].filter(Boolean)) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error('Git Bash is required for the isolated rollback regression test');
}

for (const scenario of ['target-start', 'target-health', 'public-health', 'restore-start', 'restore-health', 'candidate-start', 'candidate-health', 'success']) {
  test(`rollback ${scenario} preserves or updates state only after verification`, { timeout: 15000 }, async t => {
    const parent = path.resolve('codex-generated/review-fixes-20261009/server/test-data');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, 'rollback-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const before = 'CURRENT_IMAGE=ghcr.io/yuumiqwq/11scat-web:current\nPREVIOUS_IMAGE=ghcr.io/yuumiqwq/11scat-web:previous\nCURRENT_VERSION=fixture\n';
    const filename = path.join(directory, 'deploy-state'), log = path.join(directory, 'commands.log');
    await writeFile(filename, before);
    await writeFile(log, '');
    const mocks = path.join(directory, 'mocks.sh');
    // Shell functions take precedence over PATH even if a test is interrupted.
    // Every Docker and curl invocation remains synthetic, including public URLs.
    await writeFile(mocks, `docker() {
printf 'docker %s\\n' "$*" >> "$SIMULATION_LOG"
if [[ "$1" == run ]]; then
  local image
  for image in "$@"; do :; done
  if [[ "$*" == *'--name 11scat-web-candidate '* ]]; then
    [[ "$SCENARIO" != candidate-start ]] || return 125
  else
    if [[ "$image" == *':previous' && "$SCENARIO" == target-start ]]; then return 125; fi
    if [[ "$image" == *':current' ]]; then
      : > "$APP_DIR/restored"
      [[ "$SCENARIO" != restore-start ]] || return 125
    fi
  fi
fi
return 0
}
curl() {
printf 'curl %s\\n' "$*" >> "$SIMULATION_LOG"
if [[ "$*" == *'3101/access'* ]]; then [[ "$SCENARIO" != candidate-health ]]; return; fi
if [[ -f "$APP_DIR/restored" ]]; then [[ "$SCENARIO" != restore-health ]]; return; fi
if [[ "$*" == *'https://'* ]]; then [[ "$SCENARIO" != public-health ]]; return; fi
case "$SCENARIO" in target-health|restore-start|restore-health) return 22;; esac
return 0
}
sleep() { :; }
`);
    const bash = await bashExecutable();
    const outcome = await new Promise((resolve, reject) => {
      const child = spawn(bash, ['-c', 'source "$1"; source "$2"', 'fixture', unix(mocks), unix(path.resolve('deploy/rollback.sh'))], {
        windowsHide: true,
        env: { ...process.env, APP_DIR: unix(directory), ENV_FILE: unix(path.join(directory, 'fixture.env')), DATA_DIR: unix(directory), SIMULATION_LOG: unix(log), SCENARIO: scenario },
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stderr }));
    });
    const commands = await readFile(log, 'utf8');
    const restored = /docker run .*--name 11scat-web .*:current/.test(commands);
    const candidateFailure = scenario.startsWith('candidate');
    assert.equal(restored, !candidateFailure && scenario !== 'success');
    if (candidateFailure) assert.ok(!commands.includes('stop --time 20 11scat-web'));
    const saved = await readFile(filename, 'utf8');
    if (scenario === 'success') {
      assert.equal(outcome.code, 0);
      assert.match(saved, /CURRENT_IMAGE=ghcr.io\/yuumiqwq\/11scat-web:previous/);
      assert.match(saved, /PREVIOUS_IMAGE=ghcr.io\/yuumiqwq\/11scat-web:current/);
    } else {
      assert.notEqual(outcome.code, 0);
      assert.equal(saved, before);
      if (scenario.startsWith('restore')) { assert.equal(outcome.code, 5); assert.match(outcome.stderr, /manual recovery is required/); }
      else if (!candidateFailure) assert.equal(outcome.code, 4);
    }
  });
}
