import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The RTF reader runs on the main thread, in a `'self'` Worker and in Node, under the app's policy (`script-src 'self';
 * worker-src 'self'`, no `'unsafe-eval'`, no `'wasm-unsafe-eval'`, no `blob:`), so none of these constructs may appear in it.
 * It depends on nothing at run time: `@caotang/import-read` is imported for types only.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const files = readdirSync(SRC).filter((name) => name.endsWith('.ts'));
const sources = files.map((name) => ({ name, text: readFileSync(SRC + name, 'utf8') }));

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

describe('the RTF reader stays inside the app policy', () => {
  it('has the source files the test expects', () => {
    expect(files.sort()).toEqual(['codepage.ts', 'index.ts', 'markdown.ts', 'model.ts', 'rtf.ts', 'rtfd.ts', 'scan.ts']);
  });

  const forbidden: Array<[string, RegExp]> = [
    ['eval', /\beval\s*\(/],
    ['new Function', /\bnew\s+Function\b|\bFunction\s*\(/],
    ['WebAssembly', /\bWebAssembly\b/],
    ['a blob: URL', /createObjectURL|\bblob:/],
    ['a Worker of its own', /\bnew\s+Worker\b/],
    ['DOMParser', /\bDOMParser\b/],
    ['the DOM', /(?<![.\w])(?:document|window|self)\./],
    ['a Node built-in', /from\s+['"]node:/],
    ['a dynamic import', /\bimport\s*\(/],
  ];
  for (const [what, pattern] of forbidden) {
    it(`does not use ${what}`, () => {
      for (const { name, text } of sources) expect(code(text), name).not.toMatch(pattern);
    });
  }

  it('imports only its own files, and the shared readers for types', () => {
    for (const { name, text } of sources) {
      for (const m of code(text).matchAll(/^(import|export)\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
        const [, , typeOnly, from] = m;
        if (from?.startsWith('./')) continue;
        expect(`${name}: ${from}`, 'a value import from another package').toBe(`${name}: ${typeOnly !== undefined ? from : '(type only)'}`);
      }
    }
  });
});
