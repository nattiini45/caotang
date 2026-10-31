/**
 * `asset.transcribe`'s apply (`packages/store/src/commands-transcription.ts`) — [pictures.md §2.4 / §8.4](docs/architecture/pictures.md),
 * run directly against a project state with the undo capture the bus would keep, the way `calendar.test.ts` runs
 * `project.setCalendar`: the descriptor's tests live in `packages/bus/test/transcription.test.ts`, and this file pins
 * what the apply writes and what one undo restores.
 *
 * Pinned here: `searchable` publishes a fresh `{text, model?, at}` on each named record and creates nothing, and one
 * undo restores the records exactly, pre-existing transcriptions included; `new-document` creates one document under
 * the Research root with the pages in order separated by blank lines, one `role: 'source'` paragraph link per page at
 * the first paragraph of that page's own text (real `captureParagraphAnchor` offsets, blank leading paragraphs snapped
 * safely), and each record's transcription pointing back `{docId, anchor}` — one undo restores the lists, the tree, the
 * document and its word count together; a stale guard, a repeated picture or an unknown picture refuses the whole batch
 * with nothing written; selected pages only touch their own records; re-transcribing creates another document and
 * leaves the old one untouched.
 */

import { describe, expect, it } from 'vitest';
import { ApplyRefusal, type ApplyContext, type CommandError } from '@caotang/bus';
import { blockHashOf, captureParagraphAnchor, checkParagraphAnchor, paragraphBlocks, type ParagraphAnchor } from '@caotang/pictures';

import { addDocument, createEmptyManifest, createProjectState, type ProjectState } from '../src/index.js';
import { applyAssetTranscribe, type TranscribeParams } from '../src/commands-transcription.js';

const NOW = new Date('2026-10-09T09:00:00.000Z');
const STAMP = '2026-10-09T10:00:00.000Z';
const clock = { now: () => Date.parse(STAMP) };

const LANDING = 'n_7K2QX9M4A1';
const ONE = 'a_7K2QX9M4A1';
const TWO = 'a_3W8RN2TQ6C';
const THREE = 'a_5T4RW9KZB2';

const PREEXISTING = {
  docId: 'n_OLD00000001',
  anchor: { from: 0, to: 4, exact: 'Old ', prefix: '', suffix: 'text', capturedRevision: 2 },
  at: '2026-10-01T08:00:00.000Z',
};

function record(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    file: `${id}.png`,
    mime: 'image/png' as const,
    sha256: '0123456789abcdef'.repeat(4),
    bytes: 100,
    createdAt: NOW.toISOString(),
    ...extra,
  };
}

function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW, { uuid: () => '3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d', locale: 'en-US' }));
  addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'The ferry was late.', now: NOW, id: LANDING });
  state.manifest.assets = [record(ONE), record(TWO, { transcription: PREEXISTING }), record(THREE)];
  state.manifest.assetLinks = [
    { id: 'l_1AAAAAAAAA', assetId: ONE, target: { kind: 'node' as const, nodeId: LANDING }, role: 'reference' as const, order: 10, note: 'Arrival' },
  ];
  return state;
}

/** The apply's context, with the compensation the bus would register and the report it would log. */
interface Run {
  readonly state: ProjectState;
  readonly context: ApplyContext;
  readonly restores: { label: string; restore: () => void }[];
  readonly reports: { affected: unknown; summary: string }[];
}

function run(state: ProjectState = project()): Run {
  const restores: { label: string; restore: () => void }[] = [];
  const reports: { affected: unknown; summary: string }[] = [];
  const context = {
    commandId: 'cmd_TRANS000001',
    name: 'asset.transcribe',
    issuedBy: 'user',
    undo: {
      kind: 'compensable',
      inverse: () => {
        throw new Error('asset.transcribe is compensable, not inverse');
      },
      compensate: (label: string, restore: () => void) => {
        restores.push({ label, restore });
      },
      captured: () => {
        const last = restores.at(-1);
        return last === undefined ? undefined : { kind: 'compensable' as const, label: last.label, restore: last.restore };
      },
    },
    report: (report: { affected: unknown; summary: string }) => {
      reports.push(report);
    },
  } as unknown as ApplyContext;
  return { state, context, restores, reports };
}

type ApplyResult = { into: string; assetIds: string[]; docId?: string; linkIds?: string[] };

function apply(r: Run, params: TranscribeParams): ApplyResult {
  return applyAssetTranscribe(clock)(r.state, params, r.context) as ApplyResult;
}

function refusal(r: Run, params: TranscribeParams): CommandError {
  try {
    applyAssetTranscribe(clock)(r.state, params, r.context);
  } catch (error) {
    if (error instanceof ApplyRefusal) return error.error;
    throw error;
  }
  throw new Error('expected a refusal');
}

/** The one undo the apply registered. */
function undo(r: Run): void {
  const last = r.restores.pop();
  if (last === undefined) throw new Error('nothing to undo');
  last.restore();
}

const snapshotOf = (state: ProjectState) =>
  JSON.parse(
    JSON.stringify({
      tree: state.manifest.tree,
      assets: state.manifest.assets,
      assetLinks: state.manifest.assetLinks,
      documents: [...state.documents].map(([id, document]) => [id, document.body, document.revision]),
      wordCounts: state.manifest.derived.wordCounts,
    }),
  ) as unknown;

const recordOf = (state: ProjectState, assetId: string) => state.manifest.assets?.find((candidate) => candidate.id === assetId);
const linksOf = (state: ProjectState) => state.manifest.assetLinks ?? [];

describe('asset.transcribe, into searchable', () => {
  it('publishes a fresh {text, model?, at} on each named record, creates nothing, and one undo restores the records exactly', () => {
    const r = run();
    const before = snapshotOf(r.state);
    const result = apply(r, {
      into: 'searchable',
      pages: [
        { assetId: ONE, text: 'Dear Elena,\nthe ferry was late.', model: 'vision-a', expect: null },
        { assetId: TWO, text: 'The letter, rewritten.', expect: PREEXISTING },
      ],
    });
    expect(result).toEqual({ into: 'searchable', assetIds: [ONE, TWO] });
    expect(recordOf(r.state, ONE)?.transcription).toEqual({ text: 'Dear Elena,\nthe ferry was late.', model: 'vision-a', at: STAMP });
    expect(recordOf(r.state, ONE)?.updatedAt).toBe(STAMP);
    // A pre-existing transcription is replaced by the fresh one, and the guard made that explicit.
    expect(recordOf(r.state, TWO)?.transcription).toEqual({ text: 'The letter, rewritten.', at: STAMP });
    // No document, no link, no tree change.
    expect(r.state.manifest.tree).toHaveLength(4);
    expect(r.state.documents.size).toBe(1);
    expect(linksOf(r.state)).toHaveLength(1);
    expect(r.reports[0]?.summary).toContain('no document was created');
    expect(r.restores).toHaveLength(1);

    undo(r);
    expect(snapshotOf(r.state)).toEqual(before);
    expect(recordOf(r.state, TWO)?.transcription).toEqual(PREEXISTING);
  });

  it('leaves a picture the batch does not name untouched', () => {
    const r = run();
    apply(r, { into: 'searchable', pages: [{ assetId: THREE, text: 'Third page.', expect: null }] });
    expect(recordOf(r.state, THREE)?.transcription).toEqual({ text: 'Third page.', at: STAMP });
    expect(recordOf(r.state, ONE)).not.toHaveProperty('transcription');
    expect(recordOf(r.state, TWO)?.transcription).toEqual(PREEXISTING);
  });
});

describe('asset.transcribe, into new-document', () => {
  it('creates one Research document with the pages in order, one source link per page, and reciprocal {docId, anchor} records, all in one undo group', () => {
    const r = run();
    const before = snapshotOf(r.state);
    const pages = [
      { assetId: ONE, text: 'The Landing, transcribed.\nSecond line of page one.', expect: null },
      { assetId: TWO, text: 'The letter.\nWith two lines.', model: 'vision-b', expect: PREEXISTING },
    ] as TranscribeParams['pages'];
    const result = apply(r, { into: 'new-document', pages });
    expect(result.into).toBe('new-document');
    expect(result.assetIds).toEqual([ONE, TWO]);
    const docId = result.docId;
    expect(typeof docId).toBe('string');
    expect(result.linkIds).toHaveLength(2);

    // The document: under Research, titled from the first page's first non-empty line, pages joined by a blank line.
    const node = r.state.manifest.tree.find((candidate) => candidate.id === docId);
    expect(node).toMatchObject({ parentId: 'research', type: 'document', title: 'The Landing, transcribed.' });
    const body = 'The Landing, transcribed.\nSecond line of page one.\n\nThe letter.\nWith two lines.';
    expect(r.state.documents.get(docId ?? '')?.body).toBe(body);
    expect(r.state.documents.get(docId ?? '')?.revision).toBe(0);
    expect(r.state.manifest.derived.wordCounts[docId ?? '']).toBeGreaterThan(0);

    // One source paragraph link per page, at the first paragraph of that page's own text, in order.
    const sourceLinks = linksOf(r.state).filter((link) => link.role === 'source');
    expect(sourceLinks.map((link) => link.assetId)).toEqual([ONE, TWO]);
    expect(sourceLinks.map((link) => link.order)).toEqual([10, 20]);
    expect(sourceLinks[0]?.target).toMatchObject({ kind: 'paragraph', nodeId: docId });
    const firstAnchor = captureParagraphAnchor(body, 0, 0) as ParagraphAnchor;
    const secondAnchor = captureParagraphAnchor(body, 'The Landing, transcribed.\nSecond line of page one.'.length + 2, 0) as ParagraphAnchor;
    expect(sourceLinks[0]?.target).toMatchObject({ anchor: firstAnchor });
    expect(sourceLinks[1]?.target).toMatchObject({ anchor: secondAnchor });
    for (const link of sourceLinks) {
      const anchor = (link.target as { anchor: ParagraphAnchor }).anchor;
      expect(checkParagraphAnchor(body, anchor)).toEqual({ quote: true, block: true, ordinal: true });
    }
    // The pre-existing link keeps its place and its note.
    expect(linksOf(r.state)).toHaveLength(3);
    expect(linksOf(r.state).find((link) => link.id === 'l_1AAAAAAAAA')).toMatchObject({ order: 10, note: 'Arrival' });

    // The records point back: {docId, anchor, model?, at}, the anchor being the link's text anchor.
    const oneRecord = recordOf(r.state, ONE);
    expect(oneRecord?.transcription?.docId).toBe(docId);
    expect(oneRecord?.transcription?.at).toBe(STAMP);
    expect(oneRecord?.transcription?.anchor).toEqual({
      from: firstAnchor.from,
      to: firstAnchor.to,
      exact: firstAnchor.exact,
      prefix: firstAnchor.prefix,
      suffix: firstAnchor.suffix,
      capturedRevision: firstAnchor.capturedRevision,
    });
    expect(oneRecord?.transcription).not.toHaveProperty('blockHash');
    const twoRecord = recordOf(r.state, TWO);
    expect(twoRecord?.transcription).toEqual({ docId, anchor: { from: secondAnchor.from, to: secondAnchor.to, exact: secondAnchor.exact, prefix: secondAnchor.prefix, suffix: secondAnchor.suffix, capturedRevision: secondAnchor.capturedRevision }, model: 'vision-b', at: STAMP });
    expect(r.reports[0]?.affected).toEqual([{ nodeId: docId, title: 'The Landing, transcribed.' }]);
    expect(r.restores).toHaveLength(1);

    undo(r);
    expect(snapshotOf(r.state)).toEqual(before);
  });

  it('takes an explicit title, and snaps a page that starts with blank lines to its first real paragraph', () => {
    const r = run();
    const pages = [
      { assetId: ONE, text: '\n\n\nAlpha starts here.\nMore of alpha.', expect: null },
      { assetId: THREE, text: 'Beta page.', expect: null },
    ] as TranscribeParams['pages'];
    const result = apply(r, { into: 'new-document', title: 'Field notes', pages });
    const docId = result.docId ?? '';
    const node = r.state.manifest.tree.find((candidate) => candidate.id === docId);
    expect(node?.title).toBe('Field notes');
    const body = r.state.documents.get(docId)?.body ?? '';
    expect(body).toBe('\n\n\nAlpha starts here.\nMore of alpha.\n\nBeta page.');
    const blocks = paragraphBlocks(body);
    expect(blocks.map((block) => block.text)).toEqual(['Alpha starts here.\nMore of alpha.', 'Beta page.']);
    const links = linksOf(r.state).filter((link) => link.role === 'source');
    expect(links).toHaveLength(2);
    const firstAnchor = (links[0]?.target as { anchor: ParagraphAnchor }).anchor;
    // The page's own start offset sits in the blank run; the capture snaps to the page's first paragraph, not the previous page's.
    expect(firstAnchor.from).toBe(body.indexOf('Alpha starts here.'));
    expect(firstAnchor.exact).toBe('Alpha starts here.\nMore of alpha.');
    expect(firstAnchor.ordinal).toBe(0);
    expect(firstAnchor.blockHash).toBe(blockHashOf(blocks[0]?.text ?? ''));
    const secondAnchor = (links[1]?.target as { anchor: ParagraphAnchor }).anchor;
    expect(secondAnchor.from).toBe(body.indexOf('Beta page.'));
    expect(secondAnchor.exact).toBe('Beta page.');
    expect(secondAnchor.ordinal).toBe(1);
    for (const link of links) {
      const anchor = (link.target as { anchor: ParagraphAnchor }).anchor;
      expect(checkParagraphAnchor(body, anchor)).toEqual({ quote: true, block: true, ordinal: true });
    }
    // The reciprocal records name the same anchors.
    expect(recordOf(r.state, ONE)?.transcription?.anchor?.from).toBe(firstAnchor.from);
    expect(recordOf(r.state, THREE)?.transcription?.anchor?.from).toBe(secondAnchor.from);
  });

  it('refuses the whole batch, with nothing written, on a stale guard, a repeated picture or an unknown picture', () => {
    const stale = run();
    const beforeStale = snapshotOf(stale.state);
    const staleError = refusal(stale, {
      into: 'new-document',
      pages: [
        { assetId: ONE, text: 'Fresh text.', expect: null },
        { assetId: TWO, text: 'Also fresh.', expect: null }, // TWO holds PREEXISTING, so this guard is stale
      ],
    });
    expect(staleError).toMatchObject({ code: 'revision-conflict' });
    expect(snapshotOf(stale.state)).toEqual(beforeStale);
    expect(stale.restores).toHaveLength(0);
    expect(stale.reports).toHaveLength(0);

    const duplicate = run();
    const beforeDuplicate = snapshotOf(duplicate.state);
    expect(
      refusal(duplicate, {
        into: 'searchable',
        pages: [
          { assetId: ONE, text: 'x', expect: null },
          { assetId: ONE, text: 'y', expect: null },
        ],
      }),
    ).toMatchObject({ code: 'invalid-params' });
    expect(snapshotOf(duplicate.state)).toEqual(beforeDuplicate);

    const unknown = run();
    const beforeUnknown = snapshotOf(unknown.state);
    expect(refusal(unknown, { into: 'searchable', pages: [{ assetId: 'a_ZZZZZZZZZZ', text: 'x', expect: null }] })).toMatchObject({ code: 'not-found' });
    expect(snapshotOf(unknown.state)).toEqual(beforeUnknown);
  });

  it('transcribes only the pages the batch names', () => {
    const r = run();
    const result = apply(r, {
      into: 'new-document',
      pages: [
        { assetId: ONE, text: 'Page one.', expect: null },
        { assetId: THREE, text: 'Page three.', expect: null },
      ],
    });
    expect(result.assetIds).toEqual([ONE, THREE]);
    expect(recordOf(r.state, ONE)?.transcription?.docId).toBe(result.docId);
    expect(recordOf(r.state, THREE)?.transcription?.docId).toBe(result.docId);
    expect(recordOf(r.state, TWO)?.transcription).toEqual(PREEXISTING);
    expect(linksOf(r.state).filter((link) => link.role === 'source').map((link) => link.assetId)).toEqual([ONE, THREE]);
  });

  it('pins a three-page fixture at each page’s own first paragraph', () => {
    const r = run();
    const texts = ['Alpha line one.\nAlpha line two.', '\n\nBeta starts here.', 'Gamma.'];
    const result = apply(r, {
      into: 'new-document',
      pages: texts.map((text, index) => ({ assetId: [ONE, TWO, THREE][index] ?? ONE, text, expect: index === 1 ? PREEXISTING : null })),
    });
    const docId = result.docId ?? '';
    const body = r.state.documents.get(docId)?.body ?? '';
    expect(body).toBe(texts.join('\n\n'));
    const links = linksOf(r.state).filter((link) => link.role === 'source');
    expect(links).toHaveLength(3);
    const offsets = [0, (texts[0]?.length ?? 0) + 2, (texts[0]?.length ?? 0) + 2 + (texts[1]?.length ?? 0) + 2];
    links.forEach((link, index) => {
      const expected = captureParagraphAnchor(body, offsets[index] ?? 0, 0) as ParagraphAnchor;
      const anchor = (link.target as { anchor: ParagraphAnchor }).anchor;
      expect(anchor).toEqual(expected);
      expect(anchor.from).toBeGreaterThanOrEqual(offsets[index] ?? 0);
      expect(checkParagraphAnchor(body, anchor)).toEqual({ quote: true, block: true, ordinal: true });
      // The reciprocal record names the same anchor's text half.
      expect(recordOf(r.state, link.assetId)?.transcription?.anchor).toEqual({
        from: anchor.from,
        to: anchor.to,
        exact: anchor.exact,
        prefix: anchor.prefix,
        suffix: anchor.suffix,
        capturedRevision: anchor.capturedRevision,
      });
    });
    // Each page's anchor is a different paragraph: the second page's leading blanks snap to "Beta starts here.".
    expect((links[1]?.target as { anchor: ParagraphAnchor }).anchor.exact).toBe('Beta starts here.');
    expect((links[2]?.target as { anchor: ParagraphAnchor }).anchor.exact).toBe('Gamma.');
    expect((links[0]?.target as { anchor: ParagraphAnchor }).anchor.exact).toBe('Alpha line one.\nAlpha line two.');
  });

  it('re-transcribing creates another document and leaves the old one untouched, and the guard makes the race a conflict', () => {
    const r = run();
    const first = apply(r, { into: 'new-document', pages: [{ assetId: ONE, text: 'First read.', expect: null }] });
    const firstDocId = first.docId ?? '';
    const firstBody = r.state.documents.get(firstDocId)?.body;
    expect(firstBody).toBe('First read.');
    expect(recordOf(r.state, ONE)?.transcription?.docId).toBe(firstDocId);

    // A racing batch built on the pre-transcription state is refused outright.
    const beforeRace = snapshotOf(r.state);
    expect(
      refusal(r, { into: 'new-document', pages: [{ assetId: ONE, text: 'Racing read.', expect: null }] }),
    ).toMatchObject({ code: 'revision-conflict' });
    expect(snapshotOf(r.state)).toEqual(beforeRace);

    // A batch built on what the record holds now lands as a second document.
    const current = recordOf(r.state, ONE)?.transcription ?? null;
    const second = apply(r, { into: 'new-document', pages: [{ assetId: ONE, text: 'Second read.', expect: current }] });
    const secondDocId = second.docId ?? '';
    expect(secondDocId).not.toBe(firstDocId);
    expect(r.state.manifest.tree.filter((node) => node.parentId === 'research')).toHaveLength(2);
    expect(r.state.documents.get(firstDocId)?.body).toBe('First read.');
    expect(r.state.documents.get(secondDocId)?.body).toBe('Second read.');
    expect(recordOf(r.state, ONE)?.transcription?.docId).toBe(secondDocId);
    expect(linksOf(r.state).filter((link) => link.role === 'source')).toHaveLength(2);

    // Undoing the second restores the record to the first document and removes only the second document.
    undo(r);
    expect(recordOf(r.state, ONE)?.transcription?.docId).toBe(firstDocId);
    expect(r.state.documents.has(secondDocId)).toBe(false);
    expect(r.state.documents.get(firstDocId)?.body).toBe('First read.');
    expect(linksOf(r.state).filter((link) => link.role === 'source')).toHaveLength(1);
    expect(linksOf(r.state).find((link) => link.role === 'source')?.target).toMatchObject({ nodeId: firstDocId });
  });
});
