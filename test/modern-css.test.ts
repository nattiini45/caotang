/**
 * Modern's stylesheets keep to their two rules (modern-interface.md §5.2, §15.2, D7): every selector starts with
 * `:root[data-shell='modern']`, so Classic never matches a Modern rule even while the stylesheet stays loaded after a switch back, and
 * only logical properties are used (i18n.md §5.1), so the stage, the page and the ornaments mirror in a right-to-left interface.
 * Modern's code also formats through i18n/locale.ts, never `toLocaleString('en-US')` (§10).
 *
 * The rules run against written fixtures as well, so the guard is not vacuous.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanCss } from '../tools/logical-css.mjs';

const repoRoot = resolve(__dirname, '..');
const MODERN_DIR = resolve(repoRoot, 'apps/desktop/src/components/shell/modern');
// Every stylesheet in the Modern folder (each slot may bring its own), with the tokens.
const SHEETS = [
  resolve(repoRoot, 'apps/desktop/src/tokens/modern.css'),
  ...readdirSync(MODERN_DIR)
    .filter((file) => file.endsWith('.css'))
    .sort()
    .map((file) => join(MODERN_DIR, file)),
];
const PREFIX = ":root[data-shell='modern']";

/** Every selector in a stylesheet (split on top-level commas), with the at-rules around it. Comments are left out. */
function selectorsOf(css: string): { selector: string; context: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out: { selector: string; context: string }[] = [];
  const stack: ('at' | 'rule')[] = [];
  const contexts: string[] = [];
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === '{') {
      const prelude = text.slice(start, at).trim();
      if (prelude.startsWith('@')) {
        stack.push('at');
        contexts.push(prelude);
      } else {
        stack.push('rule');
        for (const selector of splitTopLevel(prelude)) out.push({ selector, context: contexts.join(' | ') });
      }
      start = at + 1;
    } else if (char === '}') {
      if (stack.pop() === 'at') contexts.pop();
      start = at + 1;
    } else if (char === ';') {
      start = at + 1;
    }
  }
  return out;
}

/** A selector list split on commas outside parentheses and brackets. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < list.length; at += 1) {
    const char = list[at];
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(list.slice(from, at).trim());
      from = at + 1;
    }
  }
  parts.push(list.slice(from).trim());
  return parts.filter((part) => part !== '');
}

/** The selectors that do not start with Modern's prefix. */
function unprefixed(css: string): string[] {
  return selectorsOf(css)
    .filter(({ selector }) => !selector.replace(/\s+/g, ' ').startsWith(PREFIX))
    .map(({ selector, context }) => (context === '' ? selector : `${context} | ${selector}`));
}

describe("Modern's stylesheets", () => {
  for (const sheet of SHEETS) {
    const css = readFileSync(sheet, 'utf8');
    const name = sheet.slice(repoRoot.length + 1);

    it(`${name}: every selector, inside at-rules too, starts with ${PREFIX}`, () => {
      expect(selectorsOf(css).length).toBeGreaterThan(3);
      expect(unprefixed(css)).toEqual([]);
    });

    it(`${name}: only logical properties`, () => {
      expect(scanCss(css, name)).toEqual([]);
    });
  }

  it('the guard catches a selector without the prefix, at the top and inside a media query, and a physical property', () => {
    const bad = `${PREFIX} .page { inset-inline-start: 0; }\n.page, ${PREFIX} .x { margin-left: 4px; }\n@media (forced-colors: active) { :root .page { color: red; } }`;
    expect(unprefixed(bad)).toEqual(['.page', '@media (forced-colors: active) | :root .page']);
    expect(scanCss(bad, 'bad.css').map((occurrence: { property: string }) => occurrence.property)).toEqual(['margin-left']);
  });

  it("Modern's code formats through i18n/locale.ts, never toLocaleString('en-US')", () => {
    const files = readdirSync(MODERN_DIR).filter((file) => /\.tsx?$/.test(file));
    expect(files.length).toBeGreaterThan(2);
    for (const file of files) expect(readFileSync(join(MODERN_DIR, file), 'utf8'), file).not.toMatch(/toLocale\w*String\(\s*['"]en-US/);
  });
});
