/**
 * The user-facing "not in this build" lists name only what is missing. Each list is prose a writer reads, and nothing
 * else checks it, so a feature that ships (visual references, the dialogue table's character limit, the demo's continuity
 * findings in the Findings tab, weekly and monthly goals, the engine target and locale in dialogue exports, the Source
 * tab's element menu) can stay on the list after it is built. These tests read the three lists and fail when one of them
 * names a built feature as missing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..');

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

/** The text under a heading, up to the next heading of the same or a higher level. */
function sectionUnder(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, `the heading "${heading}" is missing`).toBeGreaterThanOrEqual(0);
  const body = text.slice(start + heading.length);
  const next = body.search(/\n#{1,2} /);
  return next < 0 ? body : body.slice(0, next);
}

/** Built features that no list may name as missing. Each pattern is one feature, in the words the lists used. */
const BUILT_FEATURES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'codex visual references', pattern: /visual references?/i },
  { name: 'the dialogue table character limit', pattern: /character limit/i },
  { name: 'the continuity check reporting outside the Findings tab', pattern: /continuity check/i },
  { name: 'weekly and monthly goals', pattern: /weekly|monthly/i },
  { name: 'goals counted in characters', pattern: /characters, are not|counted in characters/i },
  { name: 'the engine target and locale in dialogue exports', pattern: /engine target|dialogue export settings|locale in exports/i },
  { name: 'the Source tab element menu', pattern: /element menu/i },
];

describe('the not-in-this-build lists name only what is missing', () => {
  it('the user guide’s last section names no built feature', () => {
    const section = sectionUnder(read('docs/USER-GUIDE.md'), '## What is not in this build yet');
    for (const feature of BUILT_FEATURES) expect(section, `names ${feature.name} as missing`).not.toMatch(feature.pattern);
  });

  it('the changelog’s known limits name no built feature, in any of its bullets', () => {
    // The whole section is read, not only the "Not in this build" bullet: the stale continuity-check claim was a bullet of its own.
    const limits = sectionUnder(read('CHANGELOG.md'), '### Known limits');
    expect(limits.split('\n').some((line) => line.startsWith('- **Not in this build:**')), 'the changelog has a "Not in this build" line').toBe(true);
    for (const feature of BUILT_FEATURES) expect(limits, `names ${feature.name} as missing`).not.toMatch(feature.pattern);
  });

  it('the readme’s not-yet list names no built feature', () => {
    const readme = read('README.md');
    const line = readme.split('\n').find((text) => text.startsWith('Not in this build yet:')) ?? '';
    expect(line, 'the readme has a "Not in this build yet" line').not.toBe('');
    for (const feature of BUILT_FEATURES) expect(line, `names ${feature.name} as missing`).not.toMatch(feature.pattern);
  });

  it('the media notes do not say a codex entry’s visual references cannot be set from the app', () => {
    const media = read('apps/desktop/src/media/README.md');
    expect(sectionUnder(media, '## What is not wired')).not.toMatch(/visual references/i);
    // The panel sets them and the pack names them; the wired-behaviour list says so.
    expect(media).toMatch(/The codex panel's \*Visual references\* section sets them/);
  });
});
