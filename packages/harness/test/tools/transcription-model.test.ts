/**
 * The model-facing helpers of `pictures.transcribe` (pictures.md §8.4, #146 / C3), all pure:
 * request batching and its page-by-page fallback, the temperature-0 prompt, the page-section
 * wire format with its strict parser, and the second read's word-level disagreement spans.
 */

import { describe, expect, it } from 'vitest';

import type { TranscriptionRequestBatch } from '../../src/tools/transcription-model.js';
import {
  TRANSCRIPTION_PAGES_PER_REQUEST,
  TRANSCRIPTION_TEMPERATURE,
  buildTranscriptionPrompt,
  compareTranscriptionReads,
  fallbackAttemptsOf,
  formatTranscriptionSections,
  parseTranscriptionReply,
  planTranscriptionBatches,
  transcriptionSectionClose,
  transcriptionSectionOpen,
} from '../../src/tools/transcription-model.js';

/** `a_` and ten digits: the asset-id shape of `ASSET_ID_PATTERN`, as unique as the count. */
const pageIds = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `a_${String(index + 1).padStart(10, '0')}`);

const sizesOf = (batches: readonly TranscriptionRequestBatch[]): number[] =>
  batches.map((batch) => batch.pages.length);

const section = (assetId: string, text: string): string =>
  `${transcriptionSectionOpen(assetId)}\n${text}\n${transcriptionSectionClose(assetId)}`;

describe('planTranscriptionBatches (pictures.md §8.4 step 2: up to 6 pages per request)', () => {
  it('splits 13 pages into 6 + 6 + 1 and 7 pages into 6 + 1, keeping the original order', () => {
    const thirteen = pageIds(13);
    const batches = planTranscriptionBatches(thirteen);
    expect(sizesOf(batches)).toEqual([6, 6, 1]);
    expect(batches.flatMap((batch) => batch.pages)).toEqual(thirteen);

    const seven = pageIds(7);
    const sevenBatches = planTranscriptionBatches(seven);
    expect(sizesOf(sevenBatches)).toEqual([6, 1]);
    expect(sevenBatches.flatMap((batch) => batch.pages)).toEqual(seven);
  });

  it('never puts more than TRANSCRIPTION_PAGES_PER_REQUEST pages in one request, and caps a higher route limit at 6', () => {
    expect(TRANSCRIPTION_PAGES_PER_REQUEST).toBe(6);
    expect(sizesOf(planTranscriptionBatches(pageIds(6)))).toEqual([6]);
    expect(sizesOf(planTranscriptionBatches(pageIds(1)))).toEqual([1]);
    expect(planTranscriptionBatches([])).toEqual([]);
    expect(sizesOf(planTranscriptionBatches(pageIds(13), 20))).toEqual([6, 6, 1]);
  });

  it('honours a lower positive image limit, down to one page per request', () => {
    const thirteen = pageIds(13);
    expect(sizesOf(planTranscriptionBatches(thirteen, 4))).toEqual([4, 4, 4, 1]);
    expect(sizesOf(planTranscriptionBatches(thirteen, 2))).toEqual([2, 2, 2, 2, 2, 2, 1]);
    const singles = planTranscriptionBatches(thirteen, 1);
    expect(sizesOf(singles)).toEqual(Array.from({ length: 13 }, () => 1));
    expect(singles.flatMap((batch) => batch.pages)).toEqual(thirteen);
  });

  it('refuses a limit that is not a positive whole number', () => {
    for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => planTranscriptionBatches(pageIds(3), bad)).toThrow(RangeError);
    }
  });

  it('refuses an empty id or a repeated page', () => {
    expect(() => planTranscriptionBatches(['a_0000000001', ''])).toThrow(TypeError);
    expect(() => planTranscriptionBatches(['a_0000000001', 'a_0000000001'])).toThrow(/twice/);
  });
});

describe('fallbackAttemptsOf (a failed batch retries page by page)', () => {
  it('covers a 13-page plan exactly once per page, in order, with no duplicates or omissions', () => {
    const thirteen = pageIds(13);
    const attempts = planTranscriptionBatches(thirteen).flatMap(fallbackAttemptsOf);
    expect(attempts).toHaveLength(13);
    expect(attempts.every((attempt) => attempt.pages.length === 1)).toBe(true);
    expect(attempts.flatMap((attempt) => attempt.pages)).toEqual(thirteen);
    expect(new Set(attempts.flatMap((attempt) => attempt.pages)).size).toBe(13);
  });

  it('falls back a single failed batch to its own pages only', () => {
    const second = planTranscriptionBatches(pageIds(13)).at(1);
    if (second === undefined) throw new Error('expected a second batch');
    expect(fallbackAttemptsOf(second).flatMap((attempt) => attempt.pages)).toEqual(pageIds(13).slice(6, 12));
  });
});

describe('buildTranscriptionPrompt (§8.4 step 2, temperature 0)', () => {
  it('runs at temperature 0', () => {
    expect(TRANSCRIPTION_TEMPERATURE).toBe(0);
  });

  it('asks for verbatim transcription that keeps line breaks, never normalises, and marks [illegible] and [?word?]', () => {
    const prompt = buildTranscriptionPrompt({ pages: pageIds(2) });
    expect(prompt).toContain('verbatim');
    expect(prompt).toContain('Never normalise, modernise or correct spelling, punctuation');
    expect(prompt).toContain('line breaks');
    expect(prompt).toContain('[illegible]');
    expect(prompt).toContain('[?word?]');
    expect(prompt).toContain(transcriptionSectionOpen('a_XXXXXXXXXX'));
    expect(prompt).toContain(transcriptionSectionClose('a_XXXXXXXXXX'));
  });

  it('lists every page of the batch and demands one section per page and nothing else', () => {
    const pages = pageIds(3);
    const prompt = buildTranscriptionPrompt({ pages });
    for (const [index, assetId] of pages.entries()) expect(prompt).toContain(`${index + 1}. ${assetId}`);
    expect(prompt).toContain('one section per page and nothing else');
  });

  it('takes a language override as a hint about the language only', () => {
    const withLanguage = buildTranscriptionPrompt({ pages: pageIds(1), language: 'fr' });
    expect(withLanguage).toContain('written in fr');
    expect(withLanguage).toContain('hint about the language only');
    expect(buildTranscriptionPrompt({ pages: pageIds(1) })).not.toContain('written in');
  });

  it('offers the codex vocabulary as context only, preferring the spellings when the ink supports them', () => {
    const prompt = buildTranscriptionPrompt({ pages: pageIds(1), vocabulary: ['Mara Voss', 'the Old Harbour', '   '] });
    expect(prompt).toContain('Mara Voss');
    expect(prompt).toContain('the Old Harbour');
    expect(prompt).toContain('Prefer these spellings when the ink supports them');
    expect(prompt).toContain('context only');
    expect(buildTranscriptionPrompt({ pages: pageIds(1) })).not.toContain('codex');
    expect(buildTranscriptionPrompt({ pages: pageIds(1), vocabulary: [] })).not.toContain('codex');
  });
});

describe('the page-section wire format', () => {
  it('round-trips multiline pages with [illegible] and [?word?] intact, in the known ids’ order', () => {
    const pages = [
      { assetId: 'a_0000000001', text: 'Dear Mara,\n\nthe [illegible] was [?recieve?d] yesterday.\n\n— T' },
      { assetId: 'a_0000000002', text: 'second page\n\nwith a blank line' },
    ];
    const parsed = parseTranscriptionReply(formatTranscriptionSections(pages), pages.map((page) => page.assetId));
    expect(parsed).toEqual({ ok: true, pages });
  });

  it('returns the pages in the known ids’ order even when the reply lists the sections in another order', () => {
    const wire = formatTranscriptionSections([
      { assetId: 'a_0000000002', text: 'two' },
      { assetId: 'a_0000000001', text: 'one' },
    ]);
    expect(parseTranscriptionReply(wire, ['a_0000000001', 'a_0000000002'])).toEqual({
      ok: true,
      pages: [
        { assetId: 'a_0000000001', text: 'one' },
        { assetId: 'a_0000000002', text: 'two' },
      ],
    });
  });

  it('removes only the separator framing and keeps internal line breaks, blank lines included', () => {
    const wire = `${transcriptionSectionOpen('a_0000000001')}\nline one\n\nline three\n${transcriptionSectionClose('a_0000000001')}\n`;
    expect(parseTranscriptionReply(wire, ['a_0000000001'])).toEqual({
      ok: true,
      pages: [{ assetId: 'a_0000000001', text: 'line one\n\nline three' }],
    });
  });
});

describe('parseTranscriptionReply refusals', () => {
  const id1 = 'a_0000000001';
  const id2 = 'a_0000000002';

  it('refuses a missing section', () => {
    expect(parseTranscriptionReply(section(id1, 'text'), [id1, id2])).toEqual({
      ok: false,
      error: { kind: 'missing-page', assetId: id2 },
    });
  });

  it('refuses a duplicate section', () => {
    expect(parseTranscriptionReply(`${section(id1, 'one')}\n${section(id1, 'two')}`, [id1])).toEqual({
      ok: false,
      error: { kind: 'duplicate-page', assetId: id1 },
    });
  });

  it('refuses an unknown section', () => {
    expect(parseTranscriptionReply(section('a_0000000099', 'text'), [id1])).toEqual({
      ok: false,
      error: { kind: 'unknown-page', assetId: 'a_0000000099' },
    });
  });

  it('refuses an empty section, a whitespace-only body included', () => {
    expect(parseTranscriptionReply(`${transcriptionSectionOpen(id1)}\n${transcriptionSectionClose(id1)}`, [id1])).toEqual({
      ok: false,
      error: { kind: 'empty-page', assetId: id1 },
    });
    expect(
      parseTranscriptionReply(`${transcriptionSectionOpen(id1)}\n   \n${transcriptionSectionClose(id1)}`, [id1]),
    ).toEqual({ ok: false, error: { kind: 'empty-page', assetId: id1 } });
  });

  it('refuses malformed framing: text outside sections, an unclosed section, a stray close, a mismatched close, a nested open', () => {
    const malformed = (reply: string, known: string[]) =>
      expect(parseTranscriptionReply(reply, known)).toMatchObject({ ok: false, error: { kind: 'malformed' } });
    malformed(`hello\n${section(id1, 'x')}`, [id1]);
    malformed(`${transcriptionSectionOpen(id1)}\ntext\n`, [id1]);
    malformed(`${transcriptionSectionClose(id1)}\n`, [id1]);
    malformed(`${transcriptionSectionOpen(id1)}\ntext\n${transcriptionSectionClose(id2)}\n`, [id1, id2]);
    malformed(
      `${transcriptionSectionOpen(id1)}\n${transcriptionSectionOpen(id2)}\ntext\n${transcriptionSectionClose(id2)}\n${transcriptionSectionClose(id1)}\n`,
      [id1, id2],
    );
  });

  it('ignores blank lines between sections', () => {
    expect(parseTranscriptionReply(`\n${section(id1, 'one')}\n\n${section(id2, 'two')}\n\n`, [id1, id2])).toEqual({
      ok: true,
      pages: [
        { assetId: id1, text: 'one' },
        { assetId: id2, text: 'two' },
      ],
    });
  });
});

describe('compareTranscriptionReads (the second read, §8.4 step 3)', () => {
  it('finds no disagreement between identical reads, or where only whitespace and line breaks differ', () => {
    const first = 'The quick brown fox.\nIt ran.';
    expect(compareTranscriptionReads(first, first)).toEqual([]);
    expect(compareTranscriptionReads(first, 'The quick brown fox. It ran.')).toEqual([]);
  });

  it('returns a word-level span whose offsets slice the first read exactly', () => {
    const first = 'The quick brown fox';
    const second = 'The quick red fox';
    const spans = compareTranscriptionReads(first, second);
    expect(spans).toEqual([{ start: 10, end: 15, secondStart: 10, secondEnd: 13, first: 'brown', second: 'red' }]);
    expect(first.slice(spans[0]?.start ?? 0, spans[0]?.end ?? 0)).toBe('brown');
    expect(second.slice(spans[0]?.secondStart ?? 0, spans[0]?.secondEnd ?? 0)).toBe('red');
  });

  it('groups consecutive differing words into one span, the whitespace inside it included', () => {
    const first = 'a b c d';
    const second = 'a x y d';
    const spans = compareTranscriptionReads(first, second);
    expect(spans).toEqual([{ start: 2, end: 5, secondStart: 2, secondEnd: 5, first: 'b c', second: 'x y' }]);
  });

  it('marks a word only in one read as a zero-width span on the other side', () => {
    const first = 'alpha omega';
    const inserted = compareTranscriptionReads(first, 'alpha beta omega');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.first).toBe('');
    expect(inserted[0]?.second).toBe('beta');
    expect(inserted[0]?.start).toBe(inserted[0]?.end);
    expect('alpha beta omega'.slice(inserted[0]?.secondStart ?? 0, inserted[0]?.secondEnd ?? 0)).toBe('beta');

    const deleted = compareTranscriptionReads('alpha beta omega', first);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.first).toBe('beta');
    expect(deleted[0]?.second).toBe('');
    expect('alpha beta omega'.slice(deleted[0]?.start ?? 0, deleted[0]?.end ?? 0)).toBe('beta');
  });

  it('diffs Han text per character without corrupting the offsets around it', () => {
    expect(compareTranscriptionReads('他走了', '她走了')).toEqual([
      { start: 0, end: 1, secondStart: 0, secondEnd: 1, first: '他', second: '她' },
    ]);

    const first = 'note: 漢字 test';
    const second = 'note: 漢子 test';
    const spans = compareTranscriptionReads(first, second);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.first).toBe('字');
    expect(spans[0]?.second).toBe('子');
    expect(first.slice(spans[0]?.start ?? 0, spans[0]?.end ?? 0)).toBe('字');
    expect(second.slice(spans[0]?.secondStart ?? 0, spans[0]?.secondEnd ?? 0)).toBe('子');
  });

  it('keeps UTF-16 offsets intact across right-to-left text', () => {
    const first = 'الكتاب جديد';
    const second = 'الكتاب قديم';
    const spans = compareTranscriptionReads(first, second);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.first).toBe('جديد');
    expect(spans[0]?.second).toBe('قديم');
    expect(first.slice(spans[0]?.start ?? 0, spans[0]?.end ?? 0)).toBe('جديد');
    expect(second.slice(spans[0]?.secondStart ?? 0, spans[0]?.secondEnd ?? 0)).toBe('قديم');
  });

  it('counts a surrogate pair as the two UTF-16 units it is', () => {
    expect(compareTranscriptionReads('x 🐉 y', 'x 🐲 z')).toEqual([
      { start: 5, end: 6, secondStart: 5, secondEnd: 6, first: 'y', second: 'z' },
    ]);
  });

  it('treats the [?word?] and [illegible] markers as the words inside them', () => {
    const spans = compareTranscriptionReads('I saw [?recieve?] it', 'I saw receive it');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.first).toBe('recieve');
    expect(spans[0]?.second).toBe('receive');
  });

  it('returns ascending spans that each slice their own text out of the unchanged original reads', () => {
    const first = 'The quick brown fox\njumped [illegible] 漢字 away';
    const second = 'The quick red fox jumped over 漢子 away';
    const spans = compareTranscriptionReads(first, second);
    expect(spans.length).toBeGreaterThan(1);
    for (const span of spans) {
      expect(first.slice(span.start, span.end)).toBe(span.first);
      expect(second.slice(span.secondStart, span.secondEnd)).toBe(span.second);
    }
    for (let index = 1; index < spans.length; index++) {
      expect(spans[index]?.start).toBeGreaterThanOrEqual(spans[index - 1]?.end ?? 0);
    }
  });
});
