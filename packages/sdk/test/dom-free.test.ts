/**
 * `@caotang/sdk` runs in Node. The root ESLint config gives every TypeScript file the browser's globals, so the SDK's source has a
 * rule of its own (eslint.config.js) that refuses the ones tying code to a page or to the browser's storage. This runs the repository's
 * config over the SDK as a person would, so the rule is proved to fire, and the source is proved to pass it.
 */

import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const FILE = 'packages/sdk/src/probe.ts';

/**
 * The budget for every lint below — explicit and per-test, never `vitest.config.ts`'s default.
 *
 * The first lint in this file loads the repository's ESLint config and its TypeScript parser for
 * the first time; every later one reuses what that load cached. Measured on one development
 * machine: the cold load took **2 712 ms** and the remaining lints **28–143 ms** each. Under the
 * full suite's worker pool the cold load exceeded **5 000 ms**, so the default was never a budget
 * for a claim here: the assertions are about which rule fires, not about how fast ESLint starts.
 * 30 000 ms clears the recorded figures with headroom and still fails a hang. Raising the config
 * default instead would move every other test's budget, which the timeout decision in
 * `packages/editor/test/dialect.test.ts` rules out.
 */
const LINT_TIMEOUT = 30_000;

async function lint(source: string, filePath: string = FILE): Promise<string[]> {
  const eslint = new ESLint({ cwd: REPO });
  const [result] = await eslint.lintText(source, { filePath });
  return (result?.messages ?? []).map((message) => `${message.ruleId ?? 'parse'}: ${message.message}`);
}

describe('the SDK imports and calls nothing that touches the page', () => {
  it.each(['window', 'document', 'indexedDB', 'localStorage', 'sessionStorage', 'navigator'])('refuses %s', async (name) => {
    const messages = await lint(`export const reach = (): unknown => ${name};\n`);
    expect(messages.some((message) => message.startsWith('no-restricted-globals'))).toBe(true);
  }, LINT_TIMEOUT);

  it.each(['window', 'document', 'indexedDB', 'localStorage'])('refuses globalThis.%s, the same reach by another route', async (name) => {
    const messages = await lint(`export const reach = (): unknown => globalThis.${name};\n`);
    expect(messages.some((message) => message.startsWith('no-restricted-properties'))).toBe(true);
  }, LINT_TIMEOUT);

  it('leaves the same source alone outside the SDK, where the app is a browser', async () => {
    expect(await lint('export const reach = (): unknown => window;\n', 'packages/store/src/probe.ts')).toEqual([]);
  }, LINT_TIMEOUT);

  it('passes over everything the SDK ships', async () => {
    const eslint = new ESLint({ cwd: REPO });
    const results = await eslint.lintFiles(['packages/sdk/src/**/*.ts']);
    expect(results.length).toBeGreaterThan(5);
    expect(results.flatMap((result) => result.messages.map((message) => `${result.filePath}: ${message.message}`))).toEqual([]);
  }, LINT_TIMEOUT);
});
