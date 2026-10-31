/**
 * The P14 transient per-page review gate (pictures.md §8.4 step 3): the broker that holds one proposal at a
 * time and answers the harness's `PictureTranscriptionHost.review` (`src/app/transcription-review.ts`), the
 * pure helpers behind the dialog (approved text for the re-transcription diff, ghost highlight spans, the
 * validated answer in plan order — `src/media/transcription-review-model.ts`), and a static render of the
 * dialog itself (`src/media/TranscriptionReviewDialog.tsx`). No provider key, no DOM, no bus dispatch.
 */

import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  PictureTranscriptionHost,
  PictureTranscriptionPlan,
  PictureTranscriptionProposal,
  PictureTranscriptionReviewResult,
} from '@caotang/harness';
import type { AssetTranscription, ParagraphAnchor, ReadAssetLink, ReadAssetRecord } from '@caotang/pictures';
import { addDocument, createEmptyManifest, createProjectState, getBody, type ProjectState } from '@caotang/store';

import { TranscriptionReviewBroker } from '../src/app/transcription-review.js';
import type { ProjectSession } from '../src/app/session.js';
import { activateEnglish } from '../src/i18n/runtime.js';
import { TranscriptionReviewDialog } from '../src/media/TranscriptionReviewDialog.js';
import {
  answerOf,
  approvedTextFromSource,
  approvedTextOf,
  diffSpansOf,
  ghostSegmentsOf,
} from '../src/media/transcription-review-model.js';

const NOW = new Date('2026-10-30T09:00:00.000Z');
const P1 = 'a_PAGE00001';
const P2 = 'a_PAGE00002';
const P3 = 'a_PAGE00003';
const DOC = 'n_TRANSCRIP01';
const AT = '2026-01-01T00:00:00.000Z';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

type Into = PictureTranscriptionPlan['into'];

function planOf(ids: readonly string[], into: Into = 'new-document', expects?: readonly (AssetTranscription | null)[]): PictureTranscriptionPlan {
  return {
    kind: 'pictures.transcribe',
    into,
    language: 'en',
    vocabulary: [],
    pages: ids.map((assetId, index) => ({ assetId, file: `${assetId}.png`, bytes: 1000, expect: expects?.[index] ?? null })),
    batches: [{ pages: [...ids] }],
    estimate: { requests: 1, maxRequests: ids.length, promptTokens: 100, outputTokens: 100 },
    warnings: [],
  };
}

type Read = string | { readonly text: string; readonly secondText?: string };

function proposalOf(plan: PictureTranscriptionPlan, reads: readonly Read[]): PictureTranscriptionProposal {
  return {
    plan,
    draft: {
      pages: plan.pages.map((page, index) => {
        const read = reads[index];
        if (read === undefined) throw new Error('fixture: no read for a plan page');
        return typeof read === 'string'
          ? { assetId: page.assetId, text: read }
          : { assetId: page.assetId, text: read.text, ...(read.secondText === undefined ? {} : { secondText: read.secondText }) };
      }),
    },
  };
}

/** A `source`-role paragraph link, as `asset.transcribe` writes it for a new-document batch. */
function sourceLink(id: string, assetId: string, docId: string, anchor: ParagraphAnchor, order: number): ReadAssetLink {
  return { id, assetId, target: { kind: 'paragraph', nodeId: docId, anchor }, role: 'source', order };
}

function anchorAt(body: string, needle: string, ordinal: number): ParagraphAnchor {
  const from = body.indexOf(needle);
  if (from === -1) throw new Error(`fixture: "${needle}" is not in the body`);
  return {
    from,
    to: from + needle.length,
    exact: needle,
    prefix: body.slice(Math.max(0, from - 32), from),
    suffix: body.slice(from + needle.length, from + needle.length + 32),
    capturedRevision: 0,
    blockHash: '0'.repeat(16),
    ordinal,
  };
}

const BODY = 'First page text.\n\nSecond page text.';

/* ------------------------------------------------------------------ *
 * The broker
 * ------------------------------------------------------------------ */

describe('TranscriptionReviewBroker', () => {
  it('implements PictureTranscriptionHost’s review and holds one proposal at a time', async () => {
    const broker = new TranscriptionReviewBroker();
    const host: Pick<PictureTranscriptionHost, 'review'> = broker;
    expect(typeof host.review).toBe('function');

    const seen: (PictureTranscriptionProposal | null)[] = [];
    const unsubscribe = broker.subscribe((proposal) => seen.push(proposal));
    expect(broker.snapshot()).toBeNull();
    expect(seen).toEqual([null]); // the immediate call carries the current snapshot

    const first = proposalOf(planOf([P1]), ['read one']);
    const pendingFirst = broker.review(first);
    expect(broker.snapshot()).toBe(first);
    expect(seen).toEqual([null, first]);

    // A second review waits: only one is held at a time.
    const second = proposalOf(planOf([P2]), ['read two']);
    const pendingSecond = broker.review(second);
    expect(broker.snapshot()).toBe(first);

    const result: PictureTranscriptionReviewResult = { pages: [{ assetId: P1, text: 'read one edited' }] };
    broker.answer(result);
    await expect(pendingFirst).resolves.toEqual(result);
    expect(broker.snapshot()).toBe(second); // promoted once the first resolved
    expect(seen).toEqual([null, first, null, second]);

    broker.cancel();
    await expect(pendingSecond).resolves.toBeNull();
    expect(broker.snapshot()).toBeNull();
    unsubscribe();
    broker.answer(result); // nothing held: a no-op, not a throw
    expect(broker.snapshot()).toBeNull();
  });

  it('resolves null and clears the held state when the call’s signal aborts', async () => {
    const broker = new TranscriptionReviewBroker();
    const seen: (PictureTranscriptionProposal | null)[] = [];
    broker.subscribe((proposal) => seen.push(proposal));
    const controller = new AbortController();
    const proposal = proposalOf(planOf([P1]), ['x']);
    const pending = broker.review(proposal, controller.signal);
    expect(broker.snapshot()).toBe(proposal);
    controller.abort();
    await expect(pending).resolves.toBeNull();
    expect(broker.snapshot()).toBeNull();
    expect(seen).toEqual([null, proposal, null]);
    // A late answer after the abort changes nothing.
    broker.answer({ pages: [{ assetId: P1, text: 'x' }] });
    expect(broker.snapshot()).toBeNull();
  });

  it('resolves null immediately for an already-aborted signal and never holds', async () => {
    const broker = new TranscriptionReviewBroker();
    const controller = new AbortController();
    controller.abort();
    const pending = broker.review(proposalOf(planOf([P1]), ['x']), controller.signal);
    await expect(pending).resolves.toBeNull();
    expect(broker.snapshot()).toBeNull();
  });

  it('aborts a waiting review without disturbing the held one', async () => {
    const broker = new TranscriptionReviewBroker();
    const first = proposalOf(planOf([P1]), ['one']);
    const second = proposalOf(planOf([P2]), ['two']);
    const held = new AbortController();
    const queued = new AbortController();
    const pendingHeld = broker.review(first, held.signal);
    const pendingQueued = broker.review(second, queued.signal);
    expect(broker.snapshot()).toBe(first);
    queued.abort();
    await expect(pendingQueued).resolves.toBeNull();
    expect(broker.snapshot()).toBe(first); // still held, unanswered
    held.abort();
    await expect(pendingHeld).resolves.toBeNull();
    expect(broker.snapshot()).toBeNull();
  });

  it('cancel is answer(null): the held review resolves null and the gate closes', async () => {
    const broker = new TranscriptionReviewBroker();
    const pending = broker.review(proposalOf(planOf([P1, P2]), ['a', 'b']));
    expect(broker.snapshot()).not.toBeNull();
    broker.cancel();
    await expect(pending).resolves.toBeNull();
    expect(broker.snapshot()).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The approved text a re-transcription is diffed against
 * ------------------------------------------------------------------ */

describe('approvedTextOf', () => {
  const links: readonly ReadAssetLink[] = [
    sourceLink('l_LINK000001', P1, DOC, anchorAt(BODY, 'First page text.', 0), 10),
    sourceLink('l_LINK000002', P2, DOC, anchorAt(BODY, 'Second page text.', 1), 20),
    // A link of another role into the same document is not a section boundary.
    { id: 'l_LINK000003', assetId: P3, target: { kind: 'paragraph', nodeId: DOC, anchor: anchorAt(BODY, 'First', 0) }, role: 'reference', order: 30 },
  ];
  const expectFirst: AssetTranscription = { docId: DOC, anchor: anchorAt(BODY, 'First page text.', 0), at: AT };
  const expectSecond: AssetTranscription = { docId: DOC, anchor: anchorAt(BODY, 'Second page text.', 1), at: AT };

  it('uses expect.text for a searchable re-transcription', () => {
    expect(approvedTextOf(P1, { text: 'the approved searchable text', model: 'm', at: AT }, undefined, links)).toBe('the approved searchable text');
  });

  it('derives a new-document page’s section from its anchor start to the next source link’s start, else the body end', () => {
    expect(approvedTextOf(P1, expectFirst, BODY, links)).toBe('First page text.\n\n');
    expect(approvedTextOf(P2, expectSecond, BODY, links)).toBe('Second page text.');
  });

  it('falls back to the page’s own source link when the record’s transcription carries no anchor', () => {
    expect(approvedTextOf(P2, { docId: DOC, at: AT }, BODY, links)).toBe('Second page text.');
  });

  it('says there is no earlier text when there is honestly none', () => {
    expect(approvedTextOf(P1, null, BODY, links)).toBeNull();
    expect(approvedTextOf(P1, { docId: 'n_MISSING0001', anchor: anchorAt(BODY, 'First page text.', 0), at: AT }, undefined, links)).toBeNull();
    expect(approvedTextOf(P3, { docId: DOC, at: AT }, BODY, links)).toBeNull(); // no anchor and no source link of its own
    expect(approvedTextOf(P1, { docId: DOC, anchor: { ...anchorAt(BODY, 'First page text.', 0), from: 999 }, at: AT }, BODY, links)).toBeNull();
  });
});

describe('approvedTextFromSource against a project state with two pages', () => {
  function stateWithDocument(): ProjectState {
    const state = createProjectState(createEmptyManifest('Fixture', NOW));
    addDocument(state, { parentId: 'manuscript', title: 'Transcription', body: BODY, now: NOW, id: DOC });
    state.manifest.assetLinks = [
      sourceLink('l_LINK000001', P1, DOC, anchorAt(BODY, 'First page text.', 0), 10),
      sourceLink('l_LINK000002', P2, DOC, anchorAt(BODY, 'Second page text.', 1), 20),
    ];
    return state;
  }
  const sourceOf = (state: ProjectState) => ({ bodyOf: (docId: string) => getBody(state, docId), links: state.manifest.assetLinks });

  it('reads both pages’ current sections, and follows an edit of the body made after approval', () => {
    const state = stateWithDocument();
    const expectFirst: AssetTranscription = { docId: DOC, anchor: anchorAt(BODY, 'First page text.', 0), at: AT };
    const expectSecond: AssetTranscription = { docId: DOC, anchor: anchorAt(BODY, 'Second page text.', 1), at: AT };
    expect(approvedTextFromSource(P1, expectFirst, sourceOf(state))).toBe('First page text.\n\n');
    expect(approvedTextFromSource(P2, expectSecond, sourceOf(state))).toBe('Second page text.');

    // The writer edits the second page’s paragraph in the document after the approval: the section is read
    // from the body as it is now, so the new ghost is diffed against the edit, not over it.
    const record = state.documents.get(DOC);
    if (record === undefined) throw new Error('fixture: no document record');
    record.body = 'First page text.\n\nSecond page text, now edited.';
    expect(approvedTextFromSource(P2, expectSecond, sourceOf(state))).toBe('Second page text, now edited.');

    // And an edit inside the first page’s paragraph, with the next source link re-resolved as the store’s
    // anchor machinery does on edit, moves that page’s boundary with it.
    record.body = 'First page text, rewritten.\n\nSecond page text.';
    state.manifest.assetLinks = [
      sourceLink('l_LINK000001', P1, DOC, anchorAt(record.body, 'First page text, rewritten.', 0), 10),
      sourceLink('l_LINK000002', P2, DOC, anchorAt(record.body, 'Second page text.', 1), 20),
    ];
    expect(approvedTextFromSource(P1, expectFirst, sourceOf(state))).toBe('First page text, rewritten.\n\n');
  });
});

describe('diffSpansOf', () => {
  it('returns the spans into the approved text where the new read differs', () => {
    expect(diffSpansOf('the quick brown fox', 'the quick red fox')).toEqual([
      { start: 10, end: 15, secondStart: 10, secondEnd: 13, first: 'brown', second: 'red' },
    ]);
    expect(diffSpansOf('same on both reads', 'same on both reads')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The ghost’s highlight spans
 * ------------------------------------------------------------------ */

describe('ghostSegmentsOf', () => {
  it('marks [?word?] and [illegible] spans and leaves the rest plain', () => {
    const text = 'the [?quick?] brown [illegible] fox';
    const segments = ghostSegmentsOf(text);
    expect(segments.map((segment) => [segment.text, segment.mark])).toEqual([
      ['the ', null],
      ['[?quick?]', 'uncertain'],
      [' brown ', null],
      ['[illegible]', 'illegible'],
      [' fox', null],
    ]);
    expect(segments.map((segment) => segment.text).join('')).toBe(text);
  });

  it('marks second-read disagreement spans with the second word, without merging it', () => {
    const text = 'the quick brown fox';
    const segments = ghostSegmentsOf(text, diffSpansOf(text, 'the quick red fox'));
    expect(segments.map((segment) => [segment.text, segment.mark, segment.second])).toEqual([
      ['the quick ', null, undefined],
      ['brown', 'disagree', 'red'],
      [' fox', null, undefined],
    ]);
    expect(segments.map((segment) => segment.text).join('')).toBe(text);
  });

  it('lets an explicit ink mark win where a disagreement overlaps it', () => {
    const text = 'a [?word?] b';
    const segments = ghostSegmentsOf(text, [{ start: 2, end: 9, secondStart: 2, secondEnd: 6, first: '[?word?]', second: 'other' }]);
    expect(segments.map((segment) => [segment.text, segment.mark])).toEqual([
      ['a ', null],
      ['[?word?]', 'uncertain'],
      [' b', null],
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * The writer’s answer, validated and in the plan’s order
 * ------------------------------------------------------------------ */

describe('answerOf', () => {
  const plan = planOf([P1, P2, P3]);
  const pages = [
    { assetId: P1, text: 'read one', file: `${P1}.png` },
    { assetId: P2, text: 'read two', file: `${P2}.png` },
    { assetId: P3, text: 'read three', file: `${P3}.png` },
  ];

  it('defaults to every page included with its first-read text', () => {
    const answer = answerOf(plan, pages, new Map(), undefined);
    expect(answer).toEqual({
      ok: true,
      result: { pages: [{ assetId: P1, text: 'read one' }, { assetId: P2, text: 'read two' }, { assetId: P3, text: 'read three' }] },
    });
  });

  it('returns the selected pages in the plan’s order with their edits, however the edits were entered', () => {
    const edits = new Map([
      [P3, { text: 'read three edited' }],
      [P2, { included: false }],
    ]);
    const answer = answerOf(plan, pages, edits, '  My pages  ');
    expect(answer).toEqual({
      ok: true,
      result: { pages: [{ assetId: P1, text: 'read one' }, { assetId: P3, text: 'read three edited' }], title: 'My pages' },
    });
  });

  it('refuses a blank included page and zero selected pages, so Approve stays disabled', () => {
    expect(answerOf(plan, pages, new Map([[P1, { text: '   ' }]]), undefined)).toEqual({ ok: false, reason: 'blank-text', assetId: P1 });
    expect(answerOf(plan, [{ ...pages[0]!, text: '' }], new Map(), undefined)).toEqual({ ok: false, reason: 'blank-text', assetId: P1 });
    const none = new Map(plan.pages.map((page) => [page.assetId, { included: false }]));
    expect(answerOf(plan, pages, none, undefined)).toEqual({ ok: false, reason: 'no-pages-selected' });
  });

  it('takes the title only for a new-document plan', () => {
    const searchable = planOf([P1], 'searchable');
    const answer = answerOf(searchable, [pages[0]!], new Map(), 'Not allowed');
    expect(answer.ok).toBe(true);
    if (answer.ok) expect(answer.result).toEqual({ pages: [{ assetId: P1, text: 'read one' }] });
    const blank = answerOf(plan, pages, new Map(), '   ');
    expect(blank.ok).toBe(true);
    if (blank.ok) expect(blank.result['title']).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * The dialog, statically rendered
 * ------------------------------------------------------------------ */

describe('TranscriptionReviewDialog', () => {
  beforeEach(() => activateEnglish());

  const fakeSession = (state: ProjectState): ProjectSession =>
    ({
      state,
      assets: { readBytes: async () => null },
      assetsVersion: () => 0,
      subscribe: () => () => {},
      getVersion: () => 0,
    }) as unknown as ProjectSession;

  function stateWithPicture(): ProjectState {
    const state = createProjectState(createEmptyManifest('Fixture', NOW));
    const record = { id: P1, file: `${P1}.png`, mime: 'image/png', caption: 'Page one', sha256: '0'.repeat(64), bytes: 1000, createdAt: NOW.toISOString() } as unknown as ReadAssetRecord;
    state.manifest.assets = [record];
    return state;
  }

  const render = (node: ReactNode): string => renderToStaticMarkup(<I18nProvider i18n={i18n}>{node}</I18nProvider>);
  const wordsOf = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/[\u2066-\u2069]/g, '').replace(/\s+/g, ' ');

  it('renders no review content while the broker holds nothing', () => {
    const broker = new TranscriptionReviewBroker();
    const html = render(<TranscriptionReviewDialog session={fakeSession(stateWithPicture())} broker={broker} />);
    expect(html).not.toContain('Review the transcription');
  });

  it('shows the held page: editable first read, ink marks in the ghost, the caution, the diff against the approved text', () => {
    const state = stateWithPicture();
    const broker = new TranscriptionReviewBroker();
    const plan = planOf([P1], 'searchable', [{ text: 'old approved text', at: AT }]);
    const proposal = proposalOf(plan, [{ text: 'the [?quick?] brown fox', secondText: 'the quick red fox' }]);
    void broker.review(proposal);

    const html = render(<TranscriptionReviewDialog session={fakeSession(state)} broker={broker} />);
    const text = wordsOf(html);
    expect(text).toContain('Review the transcription');
    expect(text).toContain('Historical handwriting is easy to misread');
    expect(text).toContain('Page 1 of 1');
    expect(text).toContain('1 page to review');
    expect(text).toContain('1 page selected');
    expect(text).toContain('Include this page');
    // The editable text holds the first read only — the second read is never merged into it.
    expect(html).toContain('the [?quick?] brown fox');
    // The ghost marks the uncertain word and the disagreement beside the textarea.
    expect(html).toContain('data-mark="uncertain"');
    expect(html).toContain('data-mark="disagree"');
    expect(text).toContain('The second read differs on 1 word');
    // The re-transcription diff shows the approved searchable text.
    expect(text).toContain('Diff against the approved text');
    expect(text).toContain('old approved text');
    // Approve is enabled: one page selected with non-blank text.
    expect(html).toMatch(/data-testid="transcription-review-approve"/);
    expect(html).not.toMatch(/data-testid="transcription-review-approve"[^>]*disabled/);
  });

  it('derives the new-document diff section from the document and its source links', () => {
    const state = stateWithPicture();
    addDocument(state, { parentId: 'manuscript', title: 'Transcription', body: BODY, now: NOW, id: DOC });
    state.manifest.assetLinks = [
      sourceLink('l_LINK000001', P1, DOC, anchorAt(BODY, 'First page text.', 0), 10),
      sourceLink('l_LINK000002', P2, DOC, anchorAt(BODY, 'Second page text.', 1), 20),
    ];
    const broker = new TranscriptionReviewBroker();
    const plan = planOf([P1], 'new-document', [{ docId: DOC, anchor: anchorAt(BODY, 'First page text.', 0), at: AT }]);
    void broker.review(proposalOf(plan, ['a fresh read of the first page']));

    const text = wordsOf(render(<TranscriptionReviewDialog session={fakeSession(state)} broker={broker} />));
    expect(text).toContain('Diff against the approved text');
    expect(text).toContain('First page text');
    // A new-document review offers the optional title.
    expect(text).toContain('Title of the new document');
  });

  it('says honestly when no earlier approved text is available', () => {
    const broker = new TranscriptionReviewBroker();
    const plan = planOf([P1], 'new-document'); // expect: null — first transcription of the page
    void broker.review(proposalOf(plan, ['a first read']));
    const text = wordsOf(render(<TranscriptionReviewDialog session={fakeSession(stateWithPicture())} broker={broker} />));
    expect(text).toContain('No earlier approved text is available for this page');
    expect(text).not.toContain('Diff against the approved text');
  });
});
