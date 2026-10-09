import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { checkBuildArtifact } from '../deploy/check-build-artifact.mjs';

test('artifact validation accepts runtime dependencies and rejects leaked generated data', async t => {
  const parent = path.resolve('codex-generated/review-fixes-20261009/server/test-data');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'artifact-')), build = path.join(directory, '.next');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(build, 'standalone/node_modules/next'), { recursive: true });
  await mkdir(path.join(build, 'server'), { recursive: true });
  await writeFile(path.join(build, 'standalone/server.js'), 'runtime');
  await writeFile(path.join(build, 'standalone/node_modules/next/package.json'), '{}');
  const trace = path.join(build, 'server/route.js.nft.json');
  await writeFile(trace, JSON.stringify({ files: ['../../node_modules/next/package.json'] }));
  assert.equal((await checkBuildArtifact(build)).manifests, 1);
  await writeFile(trace, JSON.stringify({ files: ['../../codex-generated/fixture.json'] }));
  await assert.rejects(checkBuildArtifact(build), /Non-runtime files.*\n.*fixture.json/);
  await writeFile(trace, JSON.stringify({ files: ['../../node_modules/next/package.json'] }));
  await mkdir(path.join(build, 'standalone/codex-generated'));
  await writeFile(path.join(build, 'standalone/codex-generated/fixture.json'), '{}');
  await assert.rejects(checkBuildArtifact(build), /standalone: codex-generated/);
});
