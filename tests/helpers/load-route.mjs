import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Execute the actual route body with authentication and I/O fault injection;
// no production build or running Next server is needed for these failure paths.
export async function loadRoute(filename, replacements = {}) {
  const source = await readFile(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: String(filename),
  });
  const require = createRequire(filename), exports = {};
  new Function('require', 'exports', outputText)(name => Object.hasOwn(replacements, name) ? replacements[name] : require(name), exports);
  return exports;
}
