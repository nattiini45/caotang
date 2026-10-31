import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The grep half of #268's CSP criterion (the other half is e2e/import-read-worker.spec.ts, which runs the readers under the app's
 * policy and asserts no `securitypolicyviolation`). The app's policy is `script-src 'self'; worker-src 'self'` with no
 * `'unsafe-eval'`, no `'wasm-unsafe-eval'` and no `blob:`, and the readers must run in a Worker and in Node, so none of the
 * constructs below may appear in their source.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const files = readdirSync(SRC).filter((name) => name.endsWith('.ts'));
const sources = files.map((name) => ({ name, text: readFileSync(SRC + name, 'utf8') }));

/** Each source with its comments taken out, so a sentence that names a forbidden construct is not a hit. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

describe('the import readers stay inside the app policy', () => {
  it('has the source files the test expects', () => {
    expect(files.sort()).toEqual(['index.ts', 'xml.ts', 'zip.ts']);
  });

  const forbidden: Array<[string, RegExp]> = [
    ['eval', /\beval\s*\(/],
    ['new Function', /\bnew\s+Function\b|\bFunction\s*\(/],
    ['WebAssembly', /\bWebAssembly\b/],
    ['a blob: URL', /createObjectURL|\bblob:/],
    ['a Worker of its own', /\bnew\s+Worker\b/],
    ['DOMParser', /\bDOMParser\b/],
    ['the DOM', /\bdocument\.|\bwindow\./],
    ['a Node built-in', /from\s+['"]node:/],
  ];
  for (const [what, pattern] of forbidden) {
    it(`does not use ${what}`, () => {
      for (const { name, text } of sources) expect(code(text), name).not.toMatch(pattern);
    });
  }

  it('loads fflate only from fflate/browser, only on first use, and calls only unzipSync from it', () => {
    const zip = code(sources.find((s) => s.name === 'zip.ts')?.text ?? '');
    // A type import is erased; the one value import is dynamic.
    expect(zip).not.toMatch(/^import\s+(?!type)[^;]*from\s+['"]fflate/m);
    expect([...zip.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])).toEqual(['fflate/browser']);
    expect([...zip.matchAll(/\)\)\.(\w+)/g)].map((m) => m[1])).toEqual(['unzipSync']);
    for (const name of [' unzip(', ' inflate(', 'new Unzip', 'AsyncUnzipInflate', ' gunzip(']) expect(zip).not.toContain(name);
    expect(code(sources.find((s) => s.name === 'xml.ts')?.text ?? '')).not.toMatch(/import\s*\(|from\s+['"]/);
  });
});
