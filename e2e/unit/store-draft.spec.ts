/**
 * The draft of a field that edits a value the store holds (store-draft.ts).
 *
 * The rule the field keeps: **it shows what the project holds, not what it held before**, and the
 * text the writer typed is theirs until it is committed.
 */

import { expect, test } from '@playwright/test';

import { syncDraft } from '../../apps/desktop/src/components/store-draft.js';

test.describe('the draft of a field that edits a value the store holds', () => {
  test('a draft that is the store’s own text follows the store when the store moves', () => {
    // The field committed "7", so its draft is the store's text. An undo takes the value back, and
    // the draft must not keep the number the project no longer holds.
    expect(syncDraft('7', '7', '')).toBeNull();
  });

  test('the text the writer typed is kept, because the store does not hold it', () => {
    expect(syncDraft('8', '7', '')).toBe('8');
  });

  test('a field that shows the store’s value keeps showing it', () => {
    expect(syncDraft(null, '7', '')).toBeNull();
  });

  test('a store that has not moved leaves the draft alone', () => {
    expect(syncDraft('8', '7', '7')).toBe('8');
  });

  test('a change the writer did not make does not take the writer’s text', () => {
    // The writer typed "8" against "7"; the project moved to "9" on its own, and the text the
    // writer typed is still theirs.
    expect(syncDraft('8', '7', '9')).toBe('8');
  });

  test('a draft the writer typed against the value it replaced is kept when the store comes back', () => {
    // The writer typed "8" against "7"; the store came back to "7" on its own. The text the writer
    // typed is not in the store, so it is kept.
    expect(syncDraft('8', '7', '7')).toBe('8');
  });
});
