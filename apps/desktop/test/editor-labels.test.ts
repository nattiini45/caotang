/**
 * The editor's own words reach `@caotang/editor/tiptap` in the interface language (i18n.md §3.4), the footnote marker's and
 * note's accessible names among them, while the package's defaults stay the English source for the CLI and the MCP server.
 */
import { DEFAULT_EDITOR_LABELS } from '@caotang/editor/tiptap';
import { afterEach, describe, expect, it } from 'vitest';

import { editorLabels } from '../src/components/editor-labels.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';

afterEach(() => activateEnglish());

describe('the editor labels the app hands the editor', () => {
  it('are the package’s English defaults in English', () => {
    activateEnglish();
    const labels = editorLabels();
    expect(labels.footnoteReference('2')).toBe(DEFAULT_EDITOR_LABELS.footnoteReference('2'));
    expect(labels.footnoteNote('2')).toBe(DEFAULT_EDITOR_LABELS.footnoteNote('2'));
    expect(labels.footnoteReference('2')).toBe('Footnote 2');
    expect(labels.ghostRegion).toBe('Agent preview');
  });

  it('name a footnote marker and its note in German', async () => {
    await activateCatalogue('de');
    const labels = editorLabels();
    expect(labels.footnoteReference('2')).toBe('Fußnote 2');
    expect(labels.footnoteNote('b')).toBe('Fußnote b');
    // The package's own defaults do not follow the interface language.
    expect(DEFAULT_EDITOR_LABELS.footnoteReference('2')).toBe('Footnote 2');
  });
});
