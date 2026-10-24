import { expect, test } from '@playwright/test';

import type { LossWarningGroup } from '../../packages/editor/src/index.js';

import { describeLossGroup, reStyleSentence } from '../../apps/desktop/src/app/load-banner.js';

/** One group of load losses, as the editor groups them (editor-engine §3.3). */
function group(overrides: Partial<LossWarningGroup> & Pick<LossWarningGroup, 'code' | 'mdastType'>): LossWarningGroup {
  return { line: null, nodes: 1, warnings: [], ...overrides };
}

test('a group of losses names how many there are, what they are, what a save does to them, and the line', () => {
  expect(
    describeLossGroup(group({ code: 'unsupported-node', mdastType: 'html', nodes: 2, line: 4 }), 'en-US'),
  ).toBe('2 raw HTML blocks: kept as plain text (line 4).');
  expect(describeLossGroup(group({ code: 'lossy-structure', mdastType: 'table' }), 'en-US')).toBe('1 table: structure flattened.');
  expect(
    describeLossGroup(group({ code: 'lossy-attribute', mdastType: 'listItem', nodes: 3, line: 12 }), 'en-US'),
  ).toBe('3 task-list items: a detail not kept (line 12).');
  expect(describeLossGroup(group({ code: 'lossy-attribute', mdastType: 'code', line: 2 }), 'en-US')).toBe(
    '1 code block: a detail not kept (line 2).',
  );
});

test('a construct the list does not name is still said by its own type, rather than dropped', () => {
  expect(describeLossGroup(group({ code: 'unsupported-node', mdastType: 'math' }), 'en-US')).toBe(
    '1 math: kept as plain text.',
  );
});

test('the dialect notice says how many blocks a save re-styles, and that the words stay the same', () => {
  expect(reStyleSentence(1, 'en-US')).toBe('Saving will re-style 1 block to Caotang’s Markdown spelling. The words stay the same.');
  expect(reStyleSentence(3, 'en-US')).toBe('Saving will re-style 3 blocks to Caotang’s Markdown spelling. The words stay the same.');
  expect(reStyleSentence(1200, 'en-US')).toContain('re-style 1,200 blocks');
});

test('a loss count is grouped the way the formatter locale groups numbers', () => {
  expect(describeLossGroup(group({ code: 'lossy-structure', mdastType: 'table', nodes: 1200 }), 'en-US')).toContain('1,200 tables');
  expect(describeLossGroup(group({ code: 'lossy-structure', mdastType: 'table', nodes: 1200 }), 'de-DE')).toContain('1.200 tables');
  expect(reStyleSentence(1200, 'de-DE')).toContain('re-style 1.200 blocks');
});
