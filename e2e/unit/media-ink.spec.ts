import { expect, test } from '@playwright/test';
import { withoutIsolates } from '../support.js';

import { mediaCreateItems, type MediaCreateSpec } from '../../apps/desktop/src/media/create-menu.js';
import {
  INK_IDLE_MS,
  addLineIds,
  addLineIdsLabel,
  addLineIdsSentence,
  confirmLineIdsSentence,
  importLineIdsSentence,
  linesMissingIds,
  textOnSave,
} from '../../apps/desktop/src/media/ink-model.js';
import { AUTOSAVE_DEBOUNCE_MS, type TreeNode } from '../../packages/store/src/index.js';

const INK = '=== start ===\nAlice: Hello.\n* [Wave] -> wave\n* [Leave] -> END\n\n=== wave ===\nAlice: Bye.\n-> END\n';
const ID_PATTERN = /# lineId: l_[0-9A-HJKMNP-TV-Z]{10}(?:_c)?/g;

/** A deterministic random source, so a test can name the ids a mint writes. */
function fixedBytes(seed: number) {
  let next = seed;
  return (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      next = (next * 1103515245 + 12345) & 0x7fffffff;
      out[i] = next & 0xff;
    }
    return out;
  };
}

test.describe('the Ink source rules', () => {
  test('the idle refresh is the autosave window itself, so the graph and the save move on one beat', () => {
    // Equal to the store's constant, not to a copy of its number: a change to the window moves the refresh with it.
    expect(INK_IDLE_MS).toBe(AUTOSAVE_DEBOUNCE_MS);
    expect(AUTOSAVE_DEBOUNCE_MS).toBe(800);
  });

  test('with autoLineIds off, a save keeps the writer\'s text as it is', () => {
    const kept = textOnSave(INK, false);
    expect(kept).toEqual({ text: INK, minted: 0, unplaceable: [] });
    expect(linesMissingIds(INK)).toBeGreaterThan(0);
  });

  test('with autoLineIds on, a save mints an id for each line that has none, and keeps the ids already there', () => {
    const first = textOnSave(INK, true, { randomBytes: fixedBytes(7) });
    expect(first.minted).toBe(linesMissingIds(INK));
    expect(first.text.match(ID_PATTERN)?.length).toBe(first.minted);
    expect(linesMissingIds(first.text)).toBe(0);

    // A second save of the same text mints nothing: the ids are stable per line (dialogue-narrative.md §2.2).
    const again = textOnSave(first.text, true, { randomBytes: fixedBytes(99) });
    expect(again).toEqual({ text: first.text, minted: 0, unplaceable: [] });
  });

  test('the confirmed action writes the same ids, and says how many it added', () => {
    const added = addLineIds(INK, { randomBytes: fixedBytes(7) });
    expect(added.minted).toBeGreaterThan(0);
    expect(addLineIdsSentence(added)).toBe(`Added ${added.minted} line ids to the Ink text.`);
    expect(addLineIdsSentence(addLineIds(added.text))).toBe('No line needed an id.');
  });

  test('a line that cannot take an id is named in the sentence, so the writer knows where to look', () => {
    const result = { text: INK, minted: 2, unplaceable: [{ line: 4, text: 'a', reason: 'divert' }] };
    expect(addLineIdsSentence(result)).toBe(
      'Added 2 line ids to the Ink text. 1 line (line 4) could not take one: move the choice or jump so the line has room for its id.',
    );
  });

  test('an import that minted says it was once, leaves the save setting alone, and names each stuck line with its container', () => {
    const base = { containers: [], minted: 4, unplaceable: [], duplicatesInSource: [], kept: [] };
    expect(importLineIdsSentence(base)).toBe('Added 4 line ids to the imported containers, once. "Add line ids on save" was left as it was.');
    expect(importLineIdsSentence({ ...base, minted: 0 })).toBe('No line needed an id.');
    expect(withoutIsolates(importLineIdsSentence({ ...base, unplaceable: [{ title: 'Gate', line: 3, text: 'Oh yes.' }] }))).toBe(
      'Added 4 line ids to the imported containers, once. "Add line ids on save" was left as it was. 1 line (Gate line 3) could not take one: move the choice or jump so the line has room for its id.',
    );
  });

  test('ids the source repeats are reported and kept, and a container left as written is named', () => {
    const base = { containers: [], minted: 0, unplaceable: [], duplicatesInSource: ['l_A', 'l_B', 'l_C', 'l_D'], kept: ['Gate'] };
    expect(withoutIsolates(importLineIdsSentence(base))).toBe(
      'No line needed an id. "Gate" kept the Ink as written, because the ids would have stopped it compiling. 4 ids (l_A, l_B, l_C and 1 more) already appear more than once in the source and were kept as written: the export refuses duplicates, so change them in the Ink.',
    );
  });

  test('the button and the confirm name the count, singular and plural', () => {
    expect(addLineIdsLabel(1)).toBe('Add 1 line id');
    expect(addLineIdsLabel(3)).toBe('Add 3 line ids');
  });

  test('the confirm step agrees its verb with the number of lines it writes to', () => {
    const tail = ' The ids stay with their lines when the text around them changes.';
    expect(confirmLineIdsSentence(1)).toBe(`This writes an id tag into 1 line that has none.${tail}`);
    expect(confirmLineIdsSentence(3)).toBe(`This writes an id tag into 3 lines that have none.${tail}`);
  });
});

test.describe('the binder menu for media nodes', () => {
  const node = (partial: Partial<TreeNode> & Pick<TreeNode, 'id' | 'type' | 'title'>): TreeNode => ({
    parentId: 'manuscript',
    order: 10,
    status: null,
    label: null,
    keywords: [],
    synopsis: '',
    notes: '',
    ...partial,
  });

  const labels = (items: ReturnType<typeof mediaCreateItems>): string[] => items.map((item) => item.label);

  test('a folder offers a screenplay scene, a storyboard and a dialogue container, and each create carries its kind', () => {
    const made: { parentId: string; spec: MediaCreateSpec }[] = [];
    const items = mediaCreateItems(node({ id: 'n_CHAPTER001', type: 'folder', title: 'Chapter 1' }), (parentId, spec) =>
      made.push({ parentId, spec }),
    );
    expect(labels(items)).toEqual(['New screenplay scene here', 'New storyboard here', 'New dialogue here', 'New comic here']);

    for (const item of items) item.onSelect();
    expect(made).toEqual([
      { parentId: 'n_CHAPTER001', spec: { type: 'document', kind: 'screenplay', title: 'Untitled scene' } },
      { parentId: 'n_CHAPTER001', spec: { type: 'folder', kind: 'storyboard', title: 'Storyboard' } },
      { parentId: 'n_CHAPTER001', spec: { type: 'dialogue', kind: 'branching', title: 'Untitled dialogue' } },
      { parentId: 'n_CHAPTER001', spec: { type: 'folder', kind: 'comic', title: 'Untitled comic' } },
    ]);
  });

  test('a storyboard offers a shot and nothing else, because a storyboard holds only shots', () => {
    const board = node({ id: 'n_BOARD00001', type: 'folder', title: 'Board', kind: 'storyboard' });
    expect(labels(mediaCreateItems(board, () => undefined))).toEqual(['New shot here']);
  });

  test('a document offers no media entry, because a document is not a container', () => {
    expect(mediaCreateItems(node({ id: 'n_SCENE00001', type: 'document', title: 'Scene' }), () => undefined)).toEqual([]);
  });

  // docs/decisions.md, "Chapterless documents": the media entries appear on chapters only.
  test('the manuscript, research and a folder that is not a chapter offer no media entry', () => {
    const none = (): void => undefined;
    expect(mediaCreateItems(node({ id: 'manuscript', parentId: 'root', type: 'folder', title: 'Manuscript' }), none)).toEqual([]);
    expect(mediaCreateItems(node({ id: 'research', parentId: 'root', type: 'folder', title: 'Research' }), none)).toEqual([]);
    expect(mediaCreateItems(node({ id: 'n_NOTES00001', parentId: 'research', type: 'folder', title: 'Notes' }), none)).toEqual([]);
    expect(mediaCreateItems(node({ id: 'n_INNER00001', parentId: 'n_CHAPTER001', type: 'folder', title: 'Inner' }), none)).toEqual([]);
  });
});
