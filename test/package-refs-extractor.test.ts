/**
 * The package-ref extractor (i18n.md §3.2, §8.2; I7): it reads a `MessageRef` object literal only
 * from a marked package file, and gives a message with values a translator comment.
 */
import { describe, expect, it } from 'vitest';

import { PACKAGE_REFS_MARKER, packageRefsExtractor } from '../tools/package-refs-extractor.js';

interface Extracted {
  readonly id: string;
  readonly message?: string;
  readonly comment?: string;
  readonly origin?: readonly [string, number, number?];
}

function extract(filename: string, code: string): Extracted[] {
  const out: Extracted[] = [];
  packageRefsExtractor.extract(filename, code, (message) => out.push(message as Extracted), {} as never);
  return out;
}

describe('the package-ref extractor', () => {
  it('matches package sources and leaves app sources and other packages to the default extractor', () => {
    expect(packageRefsExtractor.match('packages/coherence/src/checks/timeline.ts')).toBe(true);
    expect(packageRefsExtractor.match('packages/harness/src/agent/progress.ts')).toBe(true);
    expect(packageRefsExtractor.match('apps/desktop/src/i18n/language.ts')).toBe(false);
    expect(packageRefsExtractor.match('packages/exporter/src/index.ts')).toBe(false);
  });

  it('reads id, template, values and a translator comment from a marked file', () => {
    const code = `${PACKAGE_REFS_MARKER}
const ref = {
  id: 'coherence.timeline.orderDrift',
  message: '"{lateTitle}" comes before "{earlyTitle}"',
  values: { lateTitle: 'Opening', earlyTitle: 'Prologue' },
};`;
    const [message] = extract('packages/coherence/src/checks/timeline.ts', code);
    expect(message).toMatchObject({
      id: 'coherence.timeline.orderDrift',
      message: '"{lateTitle}" comes before "{earlyTitle}"',
      comment: 'Interpolated values: lateTitle, earlyTitle',
    });
  });

  it('ignores an object literal in a file without the marker, and gives a valueless message no comment', () => {
    const unmarked = `const ref = { id: 'not.extracted', message: 'No marker' };`;
    expect(extract('packages/bus/src/refusal.ts', unmarked)).toEqual([]);
    const marked = `${PACKAGE_REFS_MARKER}\nconst ref = { id: 'bus.permission.confirmRequired', message: 'A sentence.' };`;
    expect(extract('packages/bus/src/permission.ts', marked)).toEqual([
      { id: 'bus.permission.confirmRequired', message: 'A sentence.', origin: ['packages/bus/src/permission.ts', 2, 13] },
    ]);
  });
});
