import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

async function availablePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function checkStandaloneRuntime(directory = process.cwd(), { timeoutMs = 30000, temporaryRoot = process.platform === 'win32' ? path.resolve('codex-generated/standalone-check') : os.tmpdir() } = {}) {
  const artifact = path.resolve(directory), root = path.resolve(temporaryRoot);
  await access(path.join(artifact, 'server.js'));
  await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(path.join(root, 'duo-runtime-'));
  let child, exited, childError, output = '';
  let closed = Promise.resolve();
  try {
    const data = path.join(temporary, 'data'), identityId = 'standalone-fixture', secret = randomUUID();
    await mkdir(data);
    await writeFile(path.join(data, 'identities.json'), JSON.stringify({ version: 1, users: { [identityId]: { nickname: 'Fixture', updatedAt: new Date().toISOString() } } }), { mode: 0o600 });
    await writeFile(path.join(data, 'chat-messages.json'), JSON.stringify({ version: 1, messages: [] }), { mode: 0o600 });
    const boundary = path.join(temporary, 'module-boundary.cjs');
    // A local standalone directory can otherwise silently borrow ancestor
    // node_modules. Enforce the same dependency boundary as the runner image.
    await writeFile(boundary, `const Module = require('node:module');
const path = require('node:path');
const root = ${JSON.stringify(artifact)};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (...args) {
  const filename = resolve.apply(this, args);
  if (path.isAbsolute(filename)) {
    const relative = path.relative(root, filename);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('Standalone dependency resolved outside artifact: ' + args[0]);
    }
  }
  return filename;
};
`, { mode: 0o600 });
    const port = await availablePort(), origin = `http://127.0.0.1:${port}`;
    // Do not pass account credentials, Node preload options or provider
    // settings from the machine performing the check to the fixture server.
    const environment = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(environment, {
      NODE_ENV: 'production', NODE_PATH: '', NODE_OPTIONS: '', NEXT_TELEMETRY_DISABLED: '1', HOSTNAME: '127.0.0.1', PORT: String(port),
      DATA_DIR: data, AUTH_SESSION_SECRET: secret, SITE_PASSWORD: secret, IDENTITY_CODE_HASHES: '{}',
      TICKTICK_STORAGE_SECRET: secret, TICKTICK_COOKIE_SECRET: secret,
      TASK_SYNC_DISABLED: '1', TASK_SYNC_ORIGIN: origin, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '',
    });
    child = spawn(process.execPath, ['--require', boundary, path.join(artifact, 'server.js')], { cwd: artifact, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const capture = chunk => { output = (output + chunk.toString()).slice(-32768); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.on('error', error => { childError = error; });
    closed = new Promise(resolve => child.once('close', (code, signal) => { exited = { code, signal }; resolve(); }));
    const deadline = Date.now() + timeoutMs;
    let accessResponse;
    while (Date.now() < deadline) {
      if (childError) throw childError;
      if (exited) throw new Error(`Standalone server exited before readiness (${exited.code ?? exited.signal})`);
      try {
        accessResponse = await fetch(`${origin}/access`, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, Math.min(3000, deadline - Date.now()))) });
      } catch { await delay(100); continue; }
      if (accessResponse.status !== 200) throw new Error(`/access returned HTTP ${accessResponse.status}`);
      break;
    }
    if (!accessResponse) throw new Error('Standalone server startup timed out');
    if (!(accessResponse.headers.get('content-type') || '').includes('text/html') || !(await accessResponse.text()).includes('<')) throw new Error('/access did not return HTML');
    const requestJSON = async (pathname, headers = {}) => {
      const response = await fetch(origin + pathname, { headers, redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (response.status !== 200) throw new Error(`${pathname} returned HTTP ${response.status}`);
      if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error(`${pathname} did not return JSON`);
      try { return await response.json(); } catch { throw new Error(`${pathname} returned invalid JSON`); }
    };
    const runtime = await requestJSON('/api/access/runtime');
    if (!runtime || typeof runtime.instanceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(runtime.instanceId) || runtime.active !== false || runtime.running !== false || runtime.lastRunAt !== null) throw new Error('/api/access/runtime returned an invalid or active fixture runtime');
    const payload = `${identityId}.${Math.floor(Date.now() / 1000) + 600}`;
    const cookie = `ss_access=${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
    const chat = await requestJSON('/api/chat/messages', { Cookie: cookie });
    if (!chat || !Array.isArray(chat.messages) || chat.messages.length !== 0 || chat.cursor !== 0 || chat.nextCursor !== null) throw new Error('/api/chat/messages did not return the empty fixture history');
    return { checks: ['/access', '/api/access/runtime', '/api/chat/messages'], runtime: { active: runtime.active, running: runtime.running } };
  } catch (error) {
    throw new Error(`${error.message}${output ? '\nStandalone server output:\n' + output : ''}`, { cause: error });
  } finally {
    if (child && !exited) {
      child.kill('SIGTERM');
      await Promise.race([closed, delay(2000)]);
      if (!exited) { child.kill('SIGKILL'); await closed; }
    }
    if (path.dirname(temporary) !== root) throw new Error('Invalid standalone fixture cleanup target');
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await checkStandaloneRuntime(process.argv[2] || process.cwd());
  console.log(`Standalone runtime passed: ${result.checks.join(', ')}`);
}
