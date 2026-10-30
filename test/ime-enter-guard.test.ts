/**
 * Issue #188 (i18n §7.3): the Enter that confirms an input method's candidate arrives as a `keydown` while the composition is
 * still active, and a handler that acts on it commits, saves, blurs or sends half-typed text. Every Enter handler in the app
 * asks `isImeEnter` first, and the keymap reads a `composing` fact that every caller of `resolveKey` passes.
 *
 * A new handler written without the guard reintroduces the bug for every Chinese, Japanese and Korean writer, and nothing
 * else catches it, so this test reads the app's source and fails on a file that checks for Enter without the guard.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..');
const appSource = resolve(repoRoot, 'apps/desktop/src');

/** Every .ts and .tsx file under the app's source, as a path from the repo root and its text. */
function sources(dir: string = appSource): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [{ path: relative(repoRoot, full).replaceAll('\\', '/'), text: readFileSync(full, 'utf8') }];
  });
}

/** A comparison against the Enter key, in any of the spellings the app uses. */
const ENTER_CHECK = /\bkey\s*[!=]==?\s*['"]Enter['"]/;

/** The keymap reads plain facts, not an event: its guard is the `composing` fact, checked before any key. */
const KEYMAP = 'apps/desktop/src/app/keymap.ts';

describe('Enter handlers leave a composing input method alone (#188)', () => {
  const files = sources();

  it('finds the handlers it guards, so a moved source tree does not pass this test by finding nothing', () => {
    const checks = files.reduce((count, file) => count + (file.text.match(new RegExp(ENTER_CHECK.source, 'g'))?.length ?? 0), 0);
    expect(checks).toBeGreaterThanOrEqual(20);
  });

  it('every Enter check has its own isImeEnter call, so a second handler in a guarded file is not covered by the first', () => {
    const count = (text: string, pattern: RegExp): number => text.match(new RegExp(pattern.source, 'g'))?.length ?? 0;
    const unguarded = files
      .filter((file) => file.path !== KEYMAP && count(file.text, /\bisImeEnter\(/) < count(file.text, ENTER_CHECK))
      .map((file) => `${file.path}: ${count(file.text, ENTER_CHECK)} Enter checks, ${count(file.text, /\bisImeEnter\(/)} isImeEnter calls`);
    expect(unguarded).toEqual([]);
  });

  it('the keymap returns no action while a composition is active, before it reads the key', () => {
    const keymap = files.find((file) => file.path === KEYMAP);
    expect(keymap).toBeDefined();
    const text = keymap?.text ?? '';
    const body = text.slice(text.indexOf('export function resolveKey('));
    const guard = body.indexOf('if (facts.composing === true) return null;');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(body.indexOf("'Enter'"));
  });

  it('every caller of resolveKey passes the composing fact', () => {
    const callers = files.filter((file) => file.path !== KEYMAP && /\bresolveKey\(/.test(file.text));
    expect(callers.length).toBeGreaterThanOrEqual(4);
    for (const file of callers) {
      const calls = file.text.split(/\bresolveKey\(/).length - 1;
      const facts = file.text.split('composing: isImeEnter(event)').length - 1;
      expect(facts, `${file.path} calls resolveKey without composing: isImeEnter(event)`).toBe(calls);
    }
  });
});
