/**
 * The model-facing half of `pictures.transcribe` (pictures.md §8.4, #146 / C3): how a batch of handwritten pages is
 * split into model requests, the temperature-0 prompt that asks for a verbatim transcription, the page-section wire
 * format the reply must use and its strict parser, and the word-level comparison the opt-in second read highlights.
 *
 * Pure: no provider call, no bus write, no DOM and no import — the tool row (when it lands) plans its requests with
 * these helpers and sends what they build. This file imports nothing, so the registry table can join it without a
 * cycle, the way `timeline-model.ts` is joined.
 */

// i18n: model-facing

/** pictures.md §8.4 step 2: up to 6 pages go in one request, so the pages share context. */
export const TRANSCRIPTION_PAGES_PER_REQUEST = 6;

/** pictures.md §8.4 step 2: transcription runs at temperature 0. */
export const TRANSCRIPTION_TEMPERATURE = 0;

/** One model request: the page asset ids it carries, in the order the writer selected them. */
export interface TranscriptionRequestBatch {
  readonly pages: readonly string[];
}

/**
 * Split the selected page asset ids into requests of at most {@link TRANSCRIPTION_PAGES_PER_REQUEST} pages, keeping
 * the original order. `maxImagesPerRequest` is the route's own image limit (gateway `imageLimitsFor`): a lower
 * positive value is honoured — that is the page-by-page fallback of §8.4 step 2 — and a higher one is capped at 6.
 * Anything that is not a positive whole number is refused.
 */
export function planTranscriptionBatches(
  assetIds: readonly string[],
  maxImagesPerRequest: number = TRANSCRIPTION_PAGES_PER_REQUEST,
): readonly TranscriptionRequestBatch[] {
  const pages = checkedPageIds(assetIds, 'assetIds');
  if (!Number.isInteger(maxImagesPerRequest) || maxImagesPerRequest < 1) {
    throw new RangeError(`maxImagesPerRequest must be a positive whole number, got ${String(maxImagesPerRequest)}`);
  }
  const perRequest = Math.min(maxImagesPerRequest, TRANSCRIPTION_PAGES_PER_REQUEST);
  const batches: TranscriptionRequestBatch[] = [];
  for (let index = 0; index < pages.length; index += perRequest) {
    batches.push({ pages: pages.slice(index, index + perRequest) });
  }
  return batches;
}

/**
 * A failed batch's page-by-page fallback: one request per page. Flattened over a plan, the attempts cover every
 * original page exactly once, in order — no duplicates, no omissions.
 */
export function fallbackAttemptsOf(batch: TranscriptionRequestBatch): readonly TranscriptionRequestBatch[] {
  return batch.pages.map((page) => ({ pages: [page] }));
}

/** What the transcription prompt is built from. */
export interface TranscriptionPromptInput {
  /** The batch's page asset ids, in request order; the prompt lists them and the reply must head each section with one. */
  readonly pages: readonly string[];
  /** Optional language override for the pages; the project language is only a hint (§8.4 step 2). */
  readonly language?: string;
  /** Optional codex vocabulary (entry names and aliases), offered as context only. */
  readonly vocabulary?: readonly string[];
}

/**
 * The temperature-0 transcription prompt (§8.4 step 2): verbatim transcription, line breaks kept, no normalising of
 * spelling or punctuation, `[illegible]` for unreadable passages, `[?word?]` for uncertain words, and the wire format
 * of {@link formatTranscriptionSections} the reply must use. Model-facing text, so it carries the `i18n: model-facing`
 * marker above and no Lingui message.
 */
export function buildTranscriptionPrompt(input: TranscriptionPromptInput): string {
  const pages = checkedPageIds(input.pages, 'input.pages');
  const lines: string[] = [
    'Transcribe the handwritten pages sent with this request. Answer with one section per page and nothing else.',
    '',
    'For every page:',
    '- Transcribe verbatim: exactly the words the ink shows. Never normalise, modernise or correct spelling, punctuation, capitalisation or grammar, and never rewrite what the writer wrote.',
    '- Keep the page’s line breaks: each line of handwriting is one line of your answer. Do not reflow, join or split lines.',
    '- If a passage is unreadable, write [illegible] in its place.',
    '- If you are unsure of one word, mark it [?word?]: a question mark, your best reading of the word, a question mark, no spaces — for example [?recieve?].',
  ];
  const language = input.language?.trim();
  if (language !== undefined && language !== '') {
    lines.push(`- The pages are written in ${language}. That is a hint about the language only; it never permits correcting the text.`);
  }
  const vocabulary = (input.vocabulary ?? []).map((term) => term.trim()).filter((term) => term !== '');
  if (vocabulary.length > 0) {
    lines.push(
      '',
      'The story’s codex uses these names and spellings:',
      ...vocabulary.map((term) => `- ${term}`),
      '- Prefer these spellings when the ink supports them. The vocabulary is context only: never change what the ink says to match it.',
    );
  }
  lines.push(
    '',
    'Answer in exactly this wire format — one section per page, in the order the pages are listed below, each section headed by that page’s asset id:',
    transcriptionSectionOpen('a_XXXXXXXXXX'),
    'the page’s text, line for line',
    transcriptionSectionClose('a_XXXXXXXXXX'),
    'Do not add commentary, headings or any text outside the sections. Every page listed below must have exactly one section, and every section must carry its own closing marker.',
    '',
    'Pages in this request, in order:',
    ...pages.map((assetId, index) => `${index + 1}. ${assetId}`),
  );
  return `${lines.join('\n')}\n`;
}

/** One page of a reply: the asset id its section was headed with, and the verbatim text between the markers. */
export interface TranscriptionPageSection {
  readonly assetId: string;
  readonly text: string;
}

/** The opening marker of a page section: `<<<page a_…>>>`. */
export const TRANSCRIPTION_SECTION_OPEN_PREFIX = '<<<page ';
/** The closing marker of a page section: `<<<end a_…>>>`. */
export const TRANSCRIPTION_SECTION_CLOSE_PREFIX = '<<<end ';
/** What both markers end with. */
export const TRANSCRIPTION_SECTION_MARKER_SUFFIX = '>>>';

/** The opening marker line for one page. */
export function transcriptionSectionOpen(assetId: string): string {
  return `${TRANSCRIPTION_SECTION_OPEN_PREFIX}${assetId}${TRANSCRIPTION_SECTION_MARKER_SUFFIX}`;
}

/** The closing marker line for one page. */
export function transcriptionSectionClose(assetId: string): string {
  return `${TRANSCRIPTION_SECTION_CLOSE_PREFIX}${assetId}${TRANSCRIPTION_SECTION_MARKER_SUFFIX}`;
}

/**
 * Serialize pages into the wire format the prompt demands: each page's text framed by its markers on their own
 * lines, sections separated by one blank line. Parsing the result with the same ids round-trips the texts exactly,
 * internal line breaks included.
 */
export function formatTranscriptionSections(pages: readonly TranscriptionPageSection[]): string {
  const blocks = pages.map(
    (page) => `${transcriptionSectionOpen(page.assetId)}\n${page.text}\n${transcriptionSectionClose(page.assetId)}`,
  );
  return blocks.length === 0 ? '' : `${blocks.join('\n')}\n`;
}

/** Why a reply was refused. `assetId` names the page for the four page-level kinds. */
export type TranscriptionParseError =
  | { readonly kind: 'unknown-page'; readonly assetId: string }
  | { readonly kind: 'duplicate-page'; readonly assetId: string }
  | { readonly kind: 'missing-page'; readonly assetId: string }
  | { readonly kind: 'empty-page'; readonly assetId: string }
  | { readonly kind: 'malformed'; readonly detail: string };

export type TranscriptionParseResult =
  | { readonly ok: true; readonly pages: readonly TranscriptionPageSection[] }
  | { readonly ok: false; readonly error: TranscriptionParseError };

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const OPEN_MARKER_RE = new RegExp(
  `^${escapeRegExp(TRANSCRIPTION_SECTION_OPEN_PREFIX)}([^\\s>]+)${escapeRegExp(TRANSCRIPTION_SECTION_MARKER_SUFFIX)}\\r?$`,
);
const CLOSE_MARKER_RE = new RegExp(
  `^${escapeRegExp(TRANSCRIPTION_SECTION_CLOSE_PREFIX)}([^\\s>]+)${escapeRegExp(TRANSCRIPTION_SECTION_MARKER_SUFFIX)}\\r?$`,
);

/**
 * Parse a transcription reply against the known asset ids of the request. The parser is strict: a section is refused
 * when its id is unknown, when one id appears twice, when a known id has no section, or when a section's text is
 * empty; framing that does not open and close cleanly, or any text outside the sections, is `malformed`. Only the
 * separator framing is removed — each page's text keeps its internal line breaks (line endings are read as `\n`).
 * On success the pages come back in the known ids' order, each with its text untouched.
 */
export function parseTranscriptionReply(reply: string, knownAssetIds: readonly string[]): TranscriptionParseResult {
  const known = new Set(checkedPageIds(knownAssetIds, 'knownAssetIds'));
  const sections = new Map<string, string>();
  const lines = reply.split('\n');
  let current: { readonly assetId: string; readonly bodyStart: number } | undefined;
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (current === undefined) {
      const open = OPEN_MARKER_RE.exec(line);
      if (open !== null) {
        const assetId = open[1] ?? '';
        if (!known.has(assetId)) return { ok: false, error: { kind: 'unknown-page', assetId } };
        if (sections.has(assetId)) return { ok: false, error: { kind: 'duplicate-page', assetId } };
        current = { assetId, bodyStart: index + 1 };
        continue;
      }
      const close = CLOSE_MARKER_RE.exec(line);
      if (close !== null) {
        return { ok: false, error: { kind: 'malformed', detail: `a closing marker for ${close[1] ?? ''} appears with no section open` } };
      }
      if (line.trim() !== '') {
        return { ok: false, error: { kind: 'malformed', detail: 'the reply carries text outside a page section' } };
      }
      continue;
    }
    const close = CLOSE_MARKER_RE.exec(line);
    if (close !== null) {
      if (close[1] !== current.assetId) {
        return { ok: false, error: { kind: 'malformed', detail: `section ${current.assetId} is closed by a marker for ${close[1] ?? ''}` } };
      }
      const body = lines
        .slice(current.bodyStart, index)
        .map((bodyLine) => (bodyLine.endsWith('\r') ? bodyLine.slice(0, -1) : bodyLine))
        .join('\n');
      if (body.trim() === '') return { ok: false, error: { kind: 'empty-page', assetId: current.assetId } };
      sections.set(current.assetId, body);
      current = undefined;
      continue;
    }
    if (OPEN_MARKER_RE.exec(line) !== null) {
      return { ok: false, error: { kind: 'malformed', detail: `a new section opens inside section ${current.assetId}` } };
    }
    // Any other line is the open section's text, line breaks and blank lines included.
  }
  if (current !== undefined) {
    return { ok: false, error: { kind: 'malformed', detail: `section ${current.assetId} is never closed` } };
  }
  for (const assetId of knownAssetIds) {
    if (!sections.has(assetId)) return { ok: false, error: { kind: 'missing-page', assetId } };
  }
  return {
    ok: true,
    pages: knownAssetIds.map((assetId) => ({ assetId, text: sections.get(assetId) ?? '' })),
  };
}

/**
 * One word-level disagreement between two reads of the same page, as an inline review mark wants it. `start`/`end`
 * are UTF-16 code-unit offsets into the first read (what the editor and JavaScript strings use), `secondStart`/
 * `secondEnd` the same into the second read, so `firstRead.slice(start, end)` is always `first`. A word present in
 * only one read gives a zero-width span on the other side. The first read is never replaced or rewritten here.
 */
export interface TranscriptionDisagreement {
  readonly start: number;
  readonly end: number;
  readonly secondStart: number;
  readonly secondEnd: number;
  readonly first: string;
  readonly second: string;
}

/** Letters, numbers and combining marks run together as one word; every Han character is a word of its own, so Han text diffs per character. */
const WORD_RUN_RE = /[\p{L}\p{N}\p{M}]+/gu;
const HAN_CHAR_RE = /\p{Script=Han}/u;

interface WordToken {
  readonly text: string;
  /** UTF-16 offset of the token's first code unit. */
  readonly start: number;
  /** UTF-16 offset just past the token's last code unit. */
  readonly end: number;
}

function wordTokensOf(text: string): readonly WordToken[] {
  const tokens: WordToken[] = [];
  for (const match of text.matchAll(WORD_RUN_RE)) {
    const raw = match[0];
    const base = match.index;
    let run = '';
    let runStart = base;
    let offset = base;
    for (const char of raw) {
      if (HAN_CHAR_RE.test(char)) {
        if (run !== '') {
          tokens.push({ text: run, start: runStart, end: offset });
          run = '';
        }
        tokens.push({ text: char, start: offset, end: offset + char.length });
      } else {
        if (run === '') runStart = offset;
        run += char;
      }
      offset += char.length;
    }
    if (run !== '') tokens.push({ text: run, start: runStart, end: offset });
  }
  return tokens;
}

/** Above this many alignment cells the comparison degrades to one span over the whole differing region. */
const MAX_DIFF_CELLS = 25_000_000;

/**
 * The second read of §8.4 step 3: compare two reads of one page word by word and return the disagreement spans,
 * ascending, for the review to highlight. Whitespace-only differences are not disagreements — the spans cover
 * words, and slicing the original text at a span's offsets returns the span's text exactly, whatever the script:
 * Unicode words, Han characters and right-to-left text all index by UTF-16 code unit, so offsets never corrupt.
 */
export function compareTranscriptionReads(firstRead: string, secondRead: string): readonly TranscriptionDisagreement[] {
  const a = wordTokensOf(firstRead);
  const b = wordTokensOf(secondRead);
  // A shared prefix or suffix never disagrees; trimming it keeps the alignment table small.
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo]?.text === b[lo]?.text) lo++;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1]?.text === b[hiB - 1]?.text) {
    hiA--;
    hiB--;
  }
  const midA = a.slice(lo, hiA);
  const midB = b.slice(lo, hiB);
  const n = midA.length;
  const m = midB.length;
  if (n === 0 && m === 0) return [];
  const firstPoint = (): number => {
    if (n > 0) return midA[0]?.start ?? 0;
    return lo > 0 ? (a[lo - 1]?.end ?? 0) : 0;
  };
  const firstTail = (): number => {
    if (n > 0) return midA[n - 1]?.end ?? firstPoint();
    return lo > 0 ? (a[lo - 1]?.end ?? 0) : 0;
  };
  const secondPoint = (): number => {
    if (m > 0) return midB[0]?.start ?? 0;
    return lo > 0 ? (b[lo - 1]?.end ?? 0) : 0;
  };
  const secondTail = (): number => {
    if (m > 0) return midB[m - 1]?.end ?? secondPoint();
    return lo > 0 ? (b[lo - 1]?.end ?? 0) : 0;
  };
  if (n * m > MAX_DIFF_CELLS) {
    // Degrade to one span over the whole differing region rather than build a huge table.
    const start = firstPoint();
    const end = firstTail();
    const secondStart = secondPoint();
    const secondEnd = secondTail();
    return [
      {
        start,
        end,
        secondStart,
        secondEnd,
        first: firstRead.slice(start, end),
        second: secondRead.slice(secondStart, secondEnd),
      },
    ];
  }
  // Suffix LCS table: cell (i, j) is the LCS length of midA[i..] against midB[j..].
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  const cell = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const ai = midA[i];
      const bj = midB[j];
      table[i * width + j] =
        ai !== undefined && bj !== undefined && ai.text === bj.text
          ? cell(i + 1, j + 1) + 1
          : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }
  const disagreements: TranscriptionDisagreement[] = [];
  let i = 0;
  let j = 0;
  let aStart: number | undefined;
  let aEnd: number | undefined;
  let bStart: number | undefined;
  let bEnd: number | undefined;
  const firstInsertionAt = (): number => {
    if (i < n) return midA[i]?.start ?? 0;
    if (i > 0) return midA[i - 1]?.end ?? 0;
    return lo > 0 ? (a[lo - 1]?.end ?? 0) : 0;
  };
  const secondInsertionAt = (): number => {
    if (j < m) return midB[j]?.start ?? 0;
    if (j > 0) return midB[j - 1]?.end ?? 0;
    return lo > 0 ? (b[lo - 1]?.end ?? 0) : 0;
  };
  const flush = (): void => {
    if (aStart === undefined && bStart === undefined) return;
    const start = aStart ?? firstInsertionAt();
    const end = aEnd ?? start;
    const secondStart = bStart ?? secondInsertionAt();
    const secondEnd = bEnd ?? secondStart;
    disagreements.push({
      start,
      end,
      secondStart,
      secondEnd,
      first: firstRead.slice(start, end),
      second: secondRead.slice(secondStart, secondEnd),
    });
    aStart = undefined;
    aEnd = undefined;
    bStart = undefined;
    bEnd = undefined;
  };
  while (i < n || j < m) {
    const ai = midA[i];
    const bj = midB[j];
    if (ai !== undefined && bj !== undefined && ai.text === bj.text) {
      flush();
      i++;
      j++;
      continue;
    }
    const skipA = i < n ? cell(i + 1, j) : 0;
    const skipB = j < m ? cell(i, j + 1) : 0;
    if (ai !== undefined && (bj === undefined || skipA >= skipB)) {
      if (aStart === undefined) aStart = ai.start;
      aEnd = ai.end;
      i++;
    } else if (bj !== undefined) {
      if (bStart === undefined) bStart = bj.start;
      bEnd = bj.end;
      j++;
    }
  }
  flush();
  return disagreements;
}

/** The shared input check: page ids are non-empty strings and never repeat (the batch command refuses a repeat too). */
function checkedPageIds(ids: readonly string[], what: string): readonly string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TypeError(`${what} must contain only non-empty asset id strings`);
    }
    if (seen.has(id)) throw new Error(`${what} lists ${id} twice`);
    seen.add(id);
  }
  return ids;
}
