import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const excluded = new Set(['codex-generated', 'tests', '.data', '.music-test-data', '.git', '.wrangler', '.vinext', 'dist', 'outputs', 'work']);
async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* files(filename);
    else yield filename;
  }
}
const firstSegment = relative => relative.split(/[\\/]/)[0];

export async function checkBuildArtifact(buildDirectory = path.resolve('.next')) {
  const project = path.dirname(buildDirectory), standalone = path.join(buildDirectory, 'standalone');
  await access(path.join(standalone, 'server.js'));
  await access(path.join(standalone, 'node_modules/next/package.json'));
  const violations = [];
  const routeRuntimes = new Set();
  let manifests = 0;
  for await (const filename of files(path.join(buildDirectory, 'server'))) {
    if (filename.endsWith('.js')) {
      const source = await readFile(filename, 'utf8');
      for (const match of source.matchAll(/["'](next\/dist\/compiled\/next-server\/[\w.-]+\.js)["']/g)) routeRuntimes.add(match[1]);
    }
    if (!filename.endsWith('.nft.json')) continue;
    manifests++;
    const trace = JSON.parse(await readFile(filename, 'utf8'));
    for (const entry of trace.files) {
      const relative = path.relative(project, path.resolve(path.dirname(filename), entry));
      if (excluded.has(firstSegment(relative))) violations.push(`${path.relative(project, filename)}: ${relative}`);
    }
  }
  if (!manifests) throw new Error('No server file-tracing manifests found');
  for (const runtime of routeRuntimes) {
    await access(path.join(standalone, 'node_modules', runtime)).catch(() => { throw new Error(`Missing standalone runtime: ${runtime}`); });
  }
  for await (const filename of files(standalone)) {
    const relative = path.relative(standalone, filename);
    if (excluded.has(firstSegment(relative))) violations.push(`standalone: ${relative}`);
  }
  if (violations.length) throw new Error(`Non-runtime files in build artifact:\n${violations.slice(0, 20).join('\n')}`);
  return { manifests };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await checkBuildArtifact();
  console.log(`Checked ${result.manifests} server traces and standalone files`);
}
