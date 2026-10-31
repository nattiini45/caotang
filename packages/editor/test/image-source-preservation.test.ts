// @vitest-environment jsdom
/**
 * Inline pictures keep the Markdown the writer wrote (editor-engine §3.4, pictures.md §2.2).
 *
 * The schema has no node for a link definition and none for "this image was a reference", so the load keeps each reference's and each
 * definition's written source in the document's provenance, and a save writes it back while the node is untouched. Every case here
 * is measured against bytes: the body that went in, the body a save writes, and the body after one edit.
 *
 * The controls are the directions this can fail. A save that reuses a stale spelling writes the old target over a new edit, so each
 * edit below is checked for the edited placement and for its untouched neighbours. A save that drops a definition nothing references
 * is a loss the writer cannot see, so a definitions-only body is a case of its own.
 */
import { history, undo, redo } from '@tiptap/pm/history';
import { EditorState } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import type { Node as PmNode } from '@tiptap/pm/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePlacementTitle, encodePlacementTitle } from '@caotang/pictures';

import { buildProjectionMap, caotangSchema, parse, parseWithDiagnostics, serialize } from '../src/index.js';
import { readProvenance, withProvenance } from '../src/source-provenance.js';
import { provenancePlugin } from '../src/tiptap/provenance-plugin.js';
import type { HistoryJournal, TiptapEditorInstance } from '../src/tiptap/index.js';
import { mountInto } from './tiptap-harness.js';

const load = async (body: string): Promise<PmNode> => (await parseWithDiagnostics(body)).doc;

const stateOf = (doc: PmNode): EditorState => EditorState.create({ doc, plugins: [history(), provenancePlugin()] });

/** The body after one transaction, built from the state's own document. */
const after = (state: EditorState, build: (tr: Transaction) => Transaction): { state: EditorState; body: string } => {
  const next = state.apply(build(state.tr));
  return { state: next, body: serialize(next.doc) };
};

interface Found {
  readonly node: PmNode;
  readonly pos: number;
}

const imagesOf = (doc: PmNode): Found[] => {
  const found: Found[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'image') found.push({ node, pos });
  });
  return found;
};

/** Writes the placement the way the popover does: through the codec, and with the provenance id cleared. */
const place = (tr: Transaction, target: Found, input: { caption: string; size?: 'full' | 'half' | 'inline'; decorative?: boolean }): Transaction =>
  tr.setNodeMarkup(target.pos, undefined, {
    ...target.node.attrs,
    title: encodePlacementTitle(input),
    prov: undefined,
  });

/** The text the first paragraph reads at, for inserting inside it. */
const endOfFirstTextblock = (doc: PmNode): number => {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at === -1 && node.isTextblock) at = pos + 1 + node.content.size;
    return at === -1;
  });
  return at;
};

const FULL = '![Logo][logo]\n\n[logo]: ../assets/logo.png "The logo"\n';
const COLLAPSED = '![logo][]\n\n[logo]: ../assets/logo.png\n';
const SHORTCUT = '![logo]\n\n[logo]: ../assets/logo.png\n';
const SHARED = ['![First][d]', '', 'Between the two.', '', 'Then ![Second][d] and ![Third][d] in a line.', '', '[d]: ../assets/shared.png', ''].join('\n');

describe('a reference image or link is written back as it was written', () => {
  it.each([
    ['full', FULL],
    ['collapsed', COLLAPSED],
    ['shortcut', SHORTCUT],
    ['a full link', 'See [the docs][d] now.\n\n[d]: https://example.test/docs "Docs"\n'],
    ['a collapsed link', 'See [docs][] now.\n\n[docs]: https://example.test/docs\n'],
    ['a shortcut link', 'See [docs] now.\n\n[docs]: https://example.test/docs\n'],
    ['a definition between blocks', 'One.\n\n[d]: https://example.test/\n\nTwo with [a link][d].\n'],
    ['a definition before every block', '[d]: https://example.test/\n\nOne [a][d].\n'],
    ['definitions written on adjacent lines', 'Text [a][x] and [b][y].\n\n[x]: https://example.test/x\n[y]: https://example.test/y "Y"\n'],
    ['definitions separated by a blank line', 'Text [a][x].\n\n[x]: https://example.test/x\n\nMore.\n\n[y]: https://example.test/y\n'],
    ['a label whose case differs from its definition', '![Logo][LOGO]\n\n[logo]: ../assets/logo.png\n'],
  ])('%s', async (_name, body) => {
    const { doc, warnings } = await parseWithDiagnostics(body);
    expect(warnings).toEqual([]);
    expect(serialize(doc)).toBe(body);
  });

  it('shows the resolved target, and keeps the written source out of the visible text', async () => {
    const doc = await load(FULL);
    const [image] = imagesOf(doc);
    expect(image!.node.attrs).toMatchObject({ src: '../assets/logo.png', alt: 'Logo', title: 'The logo' });
    expect(doc.textContent).toBe('');
    const withText = await load('See [the docs][d] now.\n\n[d]: https://example.test/docs\n');
    expect(withText.textContent).toBe('See the docs now.');
  });

  it('survives a second load and a second save unchanged', async () => {
    const once = serialize(await load(SHARED));
    const twice = serialize(await load(once));
    expect(twice).toBe(once);
    expect(once).toBe(SHARED);
  });

  it('a reference to a definition that does not exist is not a reference, and the load changes nothing about that', async () => {
    const body = 'An ![alt][nowhere] and a [text][nowhere].\n';
    const { doc, warnings } = await parseWithDiagnostics(body);
    expect(warnings).toEqual([]);
    expect(imagesOf(doc)).toHaveLength(0);
    const saved = serialize(doc);
    expect(serialize(await load(saved))).toBe(saved);
  });

  it('a definition nothing references is kept', async () => {
    const body = 'Just text.\n\n[unused]: https://example.test/unused "Never used"\n';
    expect(serialize(await load(body))).toBe(body);
  });
});

describe('a body that is only definitions', () => {
  const BODY = '[a]: ../assets/a.png\n[b]: https://example.test/b "B"\n';

  it('loads as the empty document, warns nothing and saves byte for byte', async () => {
    const { doc, warnings } = await parseWithDiagnostics(BODY);
    expect(warnings).toEqual([]);
    expect(doc.textContent).toBe('');
    expect(serialize(doc)).toBe(BODY);
  });

  it('keeps its definitions when the writer types the first words', async () => {
    const state = stateOf(await load(BODY));
    const typed = after(state, (tr) => tr.insertText('Opening line.', 1));
    expect(typed.body).toBe(`${'[a]: ../assets/a.png\n[b]: https://example.test/b "B"'}\n\nOpening line.\n`);
  });

  it('keeps its definitions when an image that uses one is inserted', async () => {
    const doc = await load(BODY);
    const state = stateOf(doc);
    const image = caotangSchema.nodes.image!.create({ src: '../assets/a.png', alt: 'A', title: null });
    const inserted = after(state, (tr) => tr.insert(1, image));
    expect(inserted.body).toBe(`${BODY}\n![A](../assets/a.png)\n`);
  });

  it('is the same after a trip through JSON', async () => {
    const doc = await load(BODY);
    const again = caotangSchema.nodeFromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(serialize(again)).toBe(BODY);
  });
});

describe('a definition that was removed or changed no longer vouches for the reference', () => {
  it('a reference whose definition is gone saves as a direct image', async () => {
    const doc = await load(FULL);
    const provenance = readProvenance(doc.attrs['provenance'])!;
    const stripped = withProvenance(doc, { ...provenance, defs: [] });
    expect(serialize(stripped)).toBe('![Logo](../assets/logo.png "The logo")\n');
  });

  it('a reference whose definition now points elsewhere saves as a direct image to the node\'s own target', async () => {
    const doc = await load(FULL);
    const provenance = readProvenance(doc.attrs['provenance'])!;
    const moved = withProvenance(doc, { ...provenance, defs: provenance.defs.map((d) => ({ ...d, url: '../assets/other.png' })) });
    expect(serialize(moved)).toBe('![Logo](../assets/logo.png "The logo")\n\n[logo]: ../assets/logo.png "The logo"\n');
  });
});

describe('edits that do not touch a reference leave it alone', () => {
  it('typing in another paragraph', async () => {
    const state = stateOf(await load(SHARED));
    // The first paragraph is the picture alone (3 positions), so the second paragraph's text starts at 4.
    const typed = after(state, (tr) => tr.insertText(' More words.', 4 + 'Between the two.'.length));
    expect(typed.body).toContain('Between the two. More words.');
    expect(typed.body).toContain('![First][d]');
    expect(typed.body).toContain('![Second][d] and ![Third][d]');
    expect(typed.body.endsWith('[d]: ../assets/shared.png\n')).toBe(true);
  });

  it('typing before and after a reference link in the same paragraph', async () => {
    const body = 'Read [the docs][d] today.\n\n[d]: https://example.test/docs\n';
    const doc = await load(body);
    const state = stateOf(doc);
    const typed = after(state, (tr) => tr.insertText('Please. ', 1));
    expect(typed.body).toBe('Please. Read [the docs][d] today.\n\n[d]: https://example.test/docs\n');
    const tail = after(typed.state, (tr) => tr.insertText(' Thanks.', endOfFirstTextblock(typed.state.doc)));
    expect(tail.body).toBe('Please. Read [the docs][d] today. Thanks.\n\n[d]: https://example.test/docs\n');
  });

  it('adding a paragraph above a definition moves the definition with the text around it', async () => {
    const body = 'A.\n\n[d]: https://example.test/\n\nB [x][d].\n';
    const state = stateOf(await load(body));
    const paragraph = caotangSchema.nodes.paragraph!.create(null, caotangSchema.text('New.'));
    const inserted = after(state, (tr) => tr.insert(0, paragraph));
    expect(inserted.body).toBe('New.\n\nA.\n\n[d]: https://example.test/\n\nB [x][d].\n');
  });

  it('a definition at the end of the body stays at the end when text is added there', async () => {
    const body = 'A.\n\n[d]: https://example.test/\n';
    const state = stateOf(await load(body));
    const paragraph = caotangSchema.nodes.paragraph!.create(null, caotangSchema.text('Last.'));
    const inserted = after(state, (tr) => tr.insert(tr.doc.content.size, paragraph));
    expect(inserted.body).toBe('A.\n\nLast.\n\n[d]: https://example.test/\n');
  });
});

describe('a placement edit converts that placement and nothing else', () => {
  it('writes only the edited image as a direct image, and the other two keep the reference', async () => {
    const state = stateOf(await load(SHARED));
    const [first, second, third] = imagesOf(state.doc);
    expect(third).toBeDefined();
    const edited = after(state, (tr) => place(tr, second!, { caption: 'Half and captioned', size: 'half' }));
    expect(edited.body).toBe(
      [
        '![First][d]',
        '',
        'Between the two.',
        '',
        'Then ![Second](../assets/shared.png "Half and captioned [caotang-image v1;size=half]") and ![Third][d] in a line.',
        '',
        '[d]: ../assets/shared.png',
        '',
      ].join('\n'),
    );
    expect(first).toBeDefined();
  });

  it('the shared definition stays when every placement that used it has been edited', async () => {
    let state = stateOf(await load(SHARED));
    for (let index = 0; index < 3; index += 1) {
      const target = imagesOf(state.doc)[index]!;
      state = after(state, (tr) => place(tr, target, { caption: `Caption ${index}`, decorative: true })).state;
    }
    const body = serialize(state.doc);
    expect(body).toContain('![First](../assets/shared.png "Caption 0 [caotang-image v1;decorative]")');
    expect(body).toContain('![Third](../assets/shared.png "Caption 2 [caotang-image v1;decorative]")');
    expect(body.endsWith('[d]: ../assets/shared.png\n')).toBe(true);
  });

  it('changing only the alt text is also a placement edit', async () => {
    const state = stateOf(await load(FULL));
    const [image] = imagesOf(state.doc);
    const edited = after(state, (tr) => tr.setNodeMarkup(image!.pos, undefined, { ...image!.node.attrs, alt: 'A new alt' }));
    expect(edited.body).toBe('![A new alt](../assets/logo.png "The logo")\n\n[logo]: ../assets/logo.png "The logo"\n');
  });

  it('does not reuse a stale spelling for text typed into a reference link', async () => {
    const state = stateOf(await load('Read [the docs][d] today.\n\n[d]: https://example.test/docs\n'));
    const at = 1 + 'Read the'.length;
    const typed = after(state, (tr) => tr.insertText('X', at));
    expect(typed.body).toBe('Read [theX docs](https://example.test/docs) today.\n\n[d]: https://example.test/docs\n');
  });

  it('writes repeated placements of one picture independently, in document order', async () => {
    const body = ['![A](../assets/x.png "One")', '', '![A](../assets/x.png "Two")', '', '![A](../assets/x.png "Three")', ''].join('\n');
    const state = stateOf(await load(body));
    const images = imagesOf(state.doc);
    const edited = after(state, (tr) => place(tr, images[1]!, { caption: 'Two', size: 'inline' }));
    expect(edited.body).toBe(
      ['![A](../assets/x.png "One")', '', '![A](../assets/x.png "Two [caotang-image v1;size=inline]")', '', '![A](../assets/x.png "Three")', ''].join('\n'),
    );
  });
});

describe('a title is one opaque string to the save, whatever it holds', () => {
  it.each([
    ['a v1 suffix', '![A](../assets/x.png "Cap [caotang-image v1;size=half;decorative]")\n'],
    ['a suffix version this build does not decode', '![A](../assets/x.png "Cap [caotang-image v9;future=1]")\n'],
    ['a title that is only a suffix', '![A](../assets/x.png "[caotang-image v1;decorative]")\n'],
    ['an unknown entry the format preserves', '![A](../assets/x.png "Cap [caotang-image v1;mood=calm]")\n'],
  ])('%s', async (_name, body) => {
    expect(serialize(await load(body))).toBe(body);
  });

  it.each([
    ['a literal marker escaped in the caption', '![A](../assets/x.png "Say \\[caotang-image  aloud")\n'],
    ['quotes and backslashes', '![A](../assets/x.png "She said \\"hi\\" and left \\\\ now")\n'],
  ])('%s: the spelling may normalize but the title value is unchanged', async (_name, body) => {
    const first = await load(body);
    const saved = serialize(first);
    const titleOf = (loaded: Awaited<ReturnType<typeof load>>) => imagesOf(stateOf(loaded).doc)[0]!.node.attrs['title'];
    expect(titleOf(await load(saved))).toBe(titleOf(first));
  });

  it('a caption with a literal marker and quotes survives a placement edit that changes only the size', async () => {
    const caption = 'He said "stop [caotang-image  now" \\ and stopped';
    const start = encodePlacementTitle({ caption });
    const body = `![A](../assets/x.png ${JSON.stringify(start)})\n`;
    const decoded = decodePlacementTitle((imagesOf(await load(body))[0]!.node.attrs['title'] as string));
    expect(decoded).toMatchObject({ kind: 'placement', caption });
    const state = stateOf(await load(body));
    const edited = after(state, (tr) => place(tr, imagesOf(state.doc)[0]!, { caption, size: 'half' }));
    const reloaded = imagesOf(await load(edited.body))[0]!.node.attrs['title'] as string;
    expect(decodePlacementTitle(reloaded)).toMatchObject({ kind: 'placement', caption, size: 'half' });
  });
});

describe('moving or deleting a reference', () => {
  it('deleting the paragraph that holds the only reference keeps the definition', async () => {
    const state = stateOf(await load('![A][d]\n\nText.\n\n[d]: ../assets/a.png\n'));
    const first = state.doc.child(0);
    const deleted = after(state, (tr) => tr.delete(0, first.nodeSize));
    expect(deleted.body).toBe('Text.\n\n[d]: ../assets/a.png\n');
  });

  it('deleting the block before a definition moves the definition up', async () => {
    const state = stateOf(await load('A.\n\n[d]: https://example.test/\n\nB [x][d].\n'));
    const deleted = after(state, (tr) => tr.delete(0, state.doc.child(0).nodeSize));
    expect(deleted.body).toBe('[d]: https://example.test/\n\nB [x][d].\n');
  });

  it('moving a reference to another paragraph keeps its spelling', async () => {
    const state = stateOf(await load('Lead![A][d]\n\nText.\n\n[d]: ../assets/a.png\n'));
    const [image] = imagesOf(state.doc);
    // The second paragraph's text ends after "Text." and, once the picture is taken out of the first, one position earlier.
    const textEnd = state.doc.child(0).nodeSize + 1 + 'Text.'.length - 1;
    const moved = after(state, (tr) => tr.delete(image!.pos, image!.pos + 1).insert(textEnd, image!.node));
    expect(moved.body).toBe('Lead\n\nText.![A][d]\n\n[d]: ../assets/a.png\n');
  });

  it('deleting a reference that shares its definition leaves the other reference and the definition', async () => {
    const state = stateOf(await load(SHARED));
    const [first] = imagesOf(state.doc);
    const deleted = after(state, (tr) => tr.delete(first!.pos, first!.pos + 1));
    expect(deleted.body).toContain('![Second][d] and ![Third][d]');
    expect(deleted.body.endsWith('[d]: ../assets/shared.png\n')).toBe(true);
  });
});

describe('undo and redo', () => {
  it('undo of a placement edit restores the reference spelling and the definition', async () => {
    const state = stateOf(await load(SHARED));
    const edited = after(state, (tr) => place(tr, imagesOf(state.doc)[1]!, { caption: 'Edited', size: 'half' }));
    expect(edited.body).not.toBe(SHARED);
    let undone: EditorState | null = null;
    undo(edited.state, (tr) => {
      undone = edited.state.apply(tr);
    });
    expect(undone).not.toBeNull();
    expect(serialize((undone as unknown as EditorState).doc)).toBe(SHARED);
  });

  it('undo of an edit that moved a definition puts it back, and redo moves it again', async () => {
    const body = 'A.\n\n[d]: https://example.test/\n\nB.\n';
    const state = stateOf(await load(body));
    const paragraph = caotangSchema.nodes.paragraph!.create(null, caotangSchema.text('New.'));
    const inserted = after(state, (tr) => tr.insert(0, paragraph));
    let back: EditorState | null = null;
    undo(inserted.state, (tr) => {
      back = inserted.state.apply(tr);
    });
    expect(serialize((back as unknown as EditorState).doc)).toBe(body);
    let forward: EditorState | null = null;
    redo(back as unknown as EditorState, (tr) => {
      forward = (back as unknown as EditorState).apply(tr);
    });
    expect(serialize((forward as unknown as EditorState).doc)).toBe(inserted.body);
  });
});

describe('the provenance map is not part of the text or of the offsets', () => {
  it('leaves definitions out of every run and out of the doc text', async () => {
    const body = 'A.\n\n[d]: https://example.test/\n\nB [x][d] end.\n';
    const doc = await load(body);
    expect(doc.textContent).toBe('A.B x end.');
    const map = buildProjectionMap(doc);
    expect(map.body).toBe(serialize(doc));
    for (const run of map.runs) {
      expect(map.body.slice(run.bodyStart, run.bodyEnd)).toBe(doc.textBetween(run.pmFrom, run.pmTo));
    }
    const leaf = map.runs.find((run) => doc.textBetween(run.pmFrom, run.pmTo) === 'A.');
    expect(map.body.slice(leaf!.bodyStart, leaf!.bodyEnd)).toBe('A.');
    const end = map.runs.find((run) => doc.textBetween(run.pmFrom, run.pmTo) === ' end.');
    expect(map.body.slice(end!.bodyStart, end!.bodyEnd)).toBe(' end.');
  });

  it('an undefined reference produces the same document as before', async () => {
    const doc = await parse('![alt][nowhere]\n');
    expect(doc.attrs['provenance']).toBeUndefined();
  });
});

describe('the editor keeps the map across edits, history and a reload (journal recovery)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T10:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const BODY = 'Opening ![A][d] line.\n\nSecond.\n\n[d]: ../assets/a.png "The A"\n';

  const persisted = (journal: HistoryJournal | null): HistoryJournal => {
    if (journal === null) throw new Error('the editor kept no journal');
    return JSON.parse(JSON.stringify(journal)) as HistoryJournal;
  };

  const typeAtStart = (instance: TiptapEditorInstance, text: string): void => {
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection(text);
  };

  it('a live edit keeps every reference and definition in the saved body', async () => {
    const { instance } = await mountInto(BODY);
    expect(instance.getContent()).toBe(BODY);
    typeAtStart(instance, 'Prefix. ');
    expect(instance.getContent()).toBe('Prefix. Opening ![A][d] line.\n\nSecond.\n\n[d]: ../assets/a.png "The A"\n');
  });

  it('undo after a reload returns the body, definitions and all, byte for byte', async () => {
    const { instance } = await mountInto(BODY);
    typeAtStart(instance, 'Prefix. ');
    const journal = persisted(instance.historyJournal());
    const body = instance.getContent();
    instance.destroy();
    const { instance: reopened } = await mountInto(body, { history: { journal, onChange: () => undefined } });
    expect(reopened.getContent()).toBe(body);
    expect(reopened.undo()).toBe(true);
    expect(reopened.getContent()).toBe(BODY);
  });

  it('a replacement from the store brings its own definitions, and drops the old ones', async () => {
    const { instance } = await mountInto(BODY);
    await instance.setContent('Plain text.\n\n[other]: https://example.test/\n', { historyExcluded: true });
    expect(instance.getContent()).toBe('Plain text.\n\n[other]: https://example.test/\n');
    await instance.setContent('No definitions here.\n', { historyExcluded: true });
    expect(instance.getContent()).toBe('No definitions here.\n');
  });
});
