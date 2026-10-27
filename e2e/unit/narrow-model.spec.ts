import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import {
  DESKTOP_FEATURES,
  NARROW_EXPORT_FORMATS,
  NARROW_MAX_WIDTH,
  NARROW_QUERY,
  narrowExportAllowed,
  narrowExportFormat,
  narrowMediaFeature,
  togglePanel,
} from '../../apps/desktop/src/app/narrow-model.js';

/** The narrow layout's rules (ui-modules §0.6, §1): the width, the two panels, and what a narrow window leaves to a desktop. */

test('the width the markup reads is the width styles.css has its block at, and the desktop shell starts where it ends', () => {
  const css = readFileSync(new URL('../../apps/desktop/src/styles.css', import.meta.url), 'utf8');
  expect(NARROW_QUERY).toBe(`(max-width: ${NARROW_MAX_WIDTH}px)`);
  expect(css).toContain(`@media ${NARROW_QUERY} {`);
  // 960 px and above keeps the workspace's minimum, so the desktop shell is not touched by the narrow block.
  expect(css).toContain('  min-width: 960px;');
  expect(NARROW_MAX_WIDTH + 1).toBe(960);
});

test('a drawer and a sheet are never open together, and asking for the open one closes it', () => {
  expect(togglePanel(null, 'rail')).toBe('rail');
  expect(togglePanel('rail', 'rail')).toBeNull();
  expect(togglePanel('rail', 'inspector')).toBe('inspector');
  expect(togglePanel('inspector', 'rail')).toBe('rail');
  expect(togglePanel('inspector', 'inspector')).toBeNull();
});

test('a narrow window compiles Markdown and plain text, and starts any other recipe on Markdown', () => {
  expect(NARROW_EXPORT_FORMATS).toEqual(['md', 'txt']);
  expect(narrowExportAllowed('md')).toBe(true);
  expect(narrowExportAllowed('txt')).toBe(true);
  for (const format of ['docx', 'epub', 'fountain', 'fdx', 'pdf', 'ink-json', 'dialogue-csv', 'dialogue-xlsx', 'shot-list-csv', 'promptpack', 'coherence-md'] as const) {
    expect(narrowExportAllowed(format)).toBe(false);
    expect(narrowExportFormat(format)).toBe('md');
  }
  expect(narrowExportFormat('txt')).toBe('txt');
});

test('the storyboard and the dialogue container are desktop views, and the prose and screenplay scenes are not', () => {
  expect(narrowMediaFeature('storyboard')).toBe('storyboard');
  expect(narrowMediaFeature('dialogue')).toBe('dialogue');
  expect(narrowMediaFeature('screenplay')).toBeNull();
  expect(narrowMediaFeature(null)).toBeNull();
});

test('every desktop-only feature is named in words and says what is unchanged', () => {
  for (const [feature, note] of Object.entries(DESKTOP_FEATURES)) {
    expect(note.name, feature).not.toBe('');
    expect(note.detail.endsWith('.'), feature).toBe(true);
  }
  expect(Object.keys(DESKTOP_FEATURES).sort()).toEqual(['corkboard', 'dialogue', 'exports', 'mcp', 'screenplay-pages', 'storyboard']);
});
