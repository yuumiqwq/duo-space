import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkStandaloneRuntime } from '../deploy/check-standalone-runtime.mjs';

const fixtureRoot = path.resolve('codex-generated/review-fixes-20261009/server/standalone-fixtures');
const inherited = {
  DATA_DIR: path.join(fixtureRoot, 'production-data-must-not-be-used'),
  AUTH_SESSION_SECRET: 'production-secret-must-not-be-used',
  SITE_PASSWORD: 'production-password-must-not-be-used',
  TASK_SYNC_ENABLED: '1',
  TASK_SYNC_DISABLED: '0',
  VAPID_PUBLIC_KEY: 'production-public-key-must-not-be-used',
  VAPID_PRIVATE_KEY: 'production-private-key-must-not-be-used',
};

async function fixture(t, scenario = 'success') {
  await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(path.join(fixtureRoot, 'runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const record = path.join(directory, 'audit.json');
  const temporaryRoot = path.join(directory, 'temporary');
  await mkdir(temporaryRoot);
  await mkdir(path.join(directory, 'node_modules/runtime-fixture'), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  await writeFile(path.join(directory, 'node_modules/runtime-fixture/index.js'), 'module.exports = "bundled-runtime-ok";');
  await writeFile(path.join(directory, 'server.js'), `
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const scenario = ${JSON.stringify(scenario)}, record = ${JSON.stringify(record)};
const audit = { pid: process.pid, dataDirectory: process.env.DATA_DIR, requests: [] };
const save = () => fs.writeFileSync(record, JSON.stringify(audit));
save();
assert.equal(require('runtime-fixture'), 'bundled-runtime-ok');
assert.throws(() => require.resolve('typescript'), /Cannot find module|Standalone dependency resolved outside artifact/);
assert.notEqual(process.env.TASK_SYNC_ENABLED, '1');
assert.equal(process.env.TASK_SYNC_DISABLED, '1');
assert.equal(process.env.VAPID_PUBLIC_KEY, '');
assert.equal(process.env.VAPID_PRIVATE_KEY, '');
assert.ok(process.env.AUTH_SESSION_SECRET);
assert.notEqual(process.env.AUTH_SESSION_SECRET, ${JSON.stringify(inherited.AUTH_SESSION_SECRET)});
assert.notEqual(process.env.DATA_DIR, ${JSON.stringify(inherited.DATA_DIR)});
const relativeData = path.relative(${JSON.stringify(temporaryRoot)}, path.resolve(process.env.DATA_DIR));
assert.ok(relativeData && relativeData !== '..' && !relativeData.startsWith('..' + path.sep) && !path.isAbsolute(relativeData));
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.DATA_DIR, 'fixture-state.json'), '{}');
const server = http.createServer((request, response) => {
  audit.requests.push({ path: request.url, authenticated: Boolean(request.headers.cookie) });
  save();
  if (request.url === '/access') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><html><body><button>Access</button></body></html>');
    return;
  }
  if (request.url === '/api/access/runtime') {
    if (scenario === 'status') {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'fixture failure' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (scenario === 'invalid-json') { response.end('{invalid-json'); return; }
    response.end(JSON.stringify({ instanceId: 'c070219e-c839-42b6-bf6a-8dfafdf21c55', active: false, running: false, lastRunAt: null }));
    return;
  }
  if (request.url === '/api/chat/messages') {
    const token = /(?:^|;\\s*)ss_access=([^;]+)/.exec(request.headers.cookie || '')?.[1];
    const [identity, expires, signature] = (token || '').split('.');
    const payload = identity + '.' + expires;
    const expected = createHmac('sha256', process.env.AUTH_SESSION_SECRET).update(payload).digest('base64url');
    if (!identity || !/^\\d+$/.test(expires || '') || Number(expires) <= Date.now() / 1000 || signature !== expected) {
      response.writeHead(401); response.end('Fixture session missing or invalid'); return;
    }
    audit.fixtureIdentity = identity; save();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ messages: [], cursor: 0, nextCursor: null }));
    return;
  }
  response.writeHead(404); response.end();
});
server.listen(Number(process.env.PORT), process.env.HOSTNAME || '127.0.0.1', () => {
  audit.port = server.address().port; save();
});
`);
  return { directory, record, temporaryRoot, originalFiles: await readdir(directory) };
}

async function withUnsafeInheritedEnvironment(work) {
  const previous = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, inherited);
    return await work();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function assertCleaned(f) {
  const audit = JSON.parse(await readFile(f.record, 'utf8'));
  assert.throws(() => process.kill(audit.pid, 0), { code: 'ESRCH' }, 'the fixture server must have exited before the check settles');
  assert.notEqual(audit.dataDirectory, inherited.DATA_DIR);
  await assert.rejects(readFile(path.join(audit.dataDirectory, 'fixture-state.json')), { code: 'ENOENT' }, 'isolated fixture data must be removed');
  assert.deepEqual(await readdir(f.temporaryRoot), [], 'the temporary runtime root must be empty');
  assert.deepEqual((await readdir(f.directory)).sort(), [...f.originalFiles, 'audit.json'].sort(), 'no temporary runtime or data directory should remain');
  return audit;
}

test('standalone runtime checks use bundled modules, isolated data and a signed fixture session', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const result = await withUnsafeInheritedEnvironment(() => checkStandaloneRuntime(f.directory, { timeoutMs: 5000, temporaryRoot: f.temporaryRoot }));
  assert.deepEqual(result.checks, [
    '/access',
    '/api/access/runtime',
    '/api/chat/messages',
  ]);
  const audit = await assertCleaned(f);
  assert.ok(audit.fixtureIdentity, 'the chat request must have a verifiable fixture session');
  assert.ok(audit.requests.some(request => request.path === '/api/chat/messages' && request.authenticated));
});

for (const scenario of ['status', 'invalid-json']) {
  test(`standalone runtime rejects ${scenario} responses and cleans the child and fixture data`, { timeout: 15000 }, async t => {
    const f = await fixture(t, scenario);
    await withUnsafeInheritedEnvironment(async () => {
      await assert.rejects(checkStandaloneRuntime(f.directory, { timeoutMs: 5000, temporaryRoot: f.temporaryRoot }),
        scenario === 'status' ? /(?:500|\/api\/access\/runtime)/ : /(?:JSON|json|\/api\/access\/runtime)/);
    });
    const audit = await assertCleaned(f);
    assert.ok(audit.requests.some(request => request.path === '/api/access/runtime'));
    assert.equal(audit.requests.some(request => request.path === '/api/chat/messages'), false, 'failed runtime checks must stop before subsequent checks');
  });
}
