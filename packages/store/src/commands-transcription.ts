/**
 * `asset.transcribe`'s apply — [pictures.md §2.4 and §8.4](docs/architecture/pictures.md), tabulated in
 * [command-bus.md §9](docs/architecture/command-bus.md). The descriptor is the bus's
 * (`packages/bus/src/descriptors-transcription.ts`, `assetTranscribeDescriptor`); this module is wired into the store's
 * registry by the change that adds the name to the bus's closed set.
 *
 * One batch is one undo group and is all or nothing: every guard (each picture exists, no picture is named twice, each
 * `expect` still equals the record's complete current `transcription`) is re-checked against the live state **before
 * any write**, so a refusal leaves the project untouched. `searchable` replaces each record's transcription with a fresh
 * `{text, model?, at}` and creates nothing else. `new-document` creates one document under the Research root with the
 * pages' texts in order separated by blank lines, adds one `role: 'source'` paragraph link per page at the first
 * paragraph of that page's own text (captured with the real `captureParagraphAnchor` semantics, so leading blank
 * paragraphs snap to the page's first real paragraph), and points each record's transcription back to
 * `{docId, anchor, model?, at}`. The undo capture is a minimal before-image of everything the command changed — the
 * `assets[]` and `assetLinks[]` lists (order included), the tree, the new document's record and its word-count entry —
 * so one undo restores all of it, pre-existing transcriptions included. Re-transcribing creates another document and
 * leaves the old one untouched.
 */

import { ApplyRefusal, type ApplyContext, type AssetTranscribePage, type AssetTranscribeParams, type CommandApply } from '@caotang/bus';
import { newId } from '@caotang/ids';
import {
  addLink,
  captureParagraphAnchor,
  validateAssetRecord,
  type AssetLink,
  type AssetTranscription,
  type ParagraphAnchor,
  type ReadAssetLink,
  type ReadAssetRecord,
  type TextAnchor,
} from '@caotang/pictures';

import type { ApplyClock } from './commands-project.js';
import { linksOf, recordsOf, replaceList, undoList } from './picture-registry.js';
import type { UndoRetentionLedger } from './picture-retention.js';
import { addDocument, nodeById, type ProjectState } from './state.js';

/** The validated params, re-exported for the direct apply tests and the registry wiring. */
export type TranscribePage = AssetTranscribePage;
export type TranscribeParams = AssetTranscribeParams;

/** The most pages one batch publishes (pictures.md §2.4: 1–100), re-checked here so a direct apply is total too. */
const TRANSCRIBE_PAGES_MAX = 100;

type PictureApply<P> = CommandApply<P, ProjectState>;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The `expect` guard's comparison, as the descriptor's check compares: the complete value, or `null` for none. */
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The document's title: the given one, else the trimmed first non-empty line of the first page, else `Transcription` (§2.4). */
function transcribeTitle(title: string | undefined, firstPageText: string): string {
  if (title !== undefined) return title;
  for (const line of firstPageText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return 'Transcription';
}

/** The offset in the joined body at which each page's own text starts; the pages are separated by one blank line. */
function pageOffsets(pages: readonly { text: string }[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const page of pages) {
    offsets.push(at);
    at += page.text.length + 2;
  }
  return offsets;
}

/** The anchor a record's `transcription.anchor` carries: the text anchor, without the link's paragraph tie-breakers. */
function textAnchorOf(anchor: ParagraphAnchor): TextAnchor {
  const { blockHash: _blockHash, ordinal: _ordinal, ...textAnchor } = anchor;
  return textAnchor;
}

interface GuardedPage {
  readonly page: TranscribePage;
  readonly record: ReadAssetRecord;
}

/**
 * Every guard, checked before any write. The descriptor checked the same things against its snapshot; the apply
 * re-checks them against the live state, so a direct caller gets the same all-or-nothing refusal — a stale guard is a
 * `revision-conflict`, and nothing has been written when one is thrown.
 */
function guardPages(state: ProjectState, pages: readonly TranscribePage[]): GuardedPage[] {
  if (pages.length === 0) {
    throw new ApplyRefusal({
      code: 'invalid-params',
      message: 'params.pages must hold at least one page, so nothing was published',
      target: 'pages',
      correctiveHint: 'pass one entry per transcribed page: {assetId, text, expect}',
    });
  }
  if (pages.length > TRANSCRIBE_PAGES_MAX) {
    throw new ApplyRefusal({
      code: 'limit-exceeded',
      message: `params.pages has ${pages.length} entries, limit ${TRANSCRIBE_PAGES_MAX}, so nothing was published`,
      target: 'pages',
      correctiveHint: `send at most ${TRANSCRIBE_PAGES_MAX} pages at once`,
    });
  }
  const records = recordsOf(state);
  const seen = new Set<string>();
  const guarded: GuardedPage[] = [];
  for (const page of pages) {
    if (seen.has(page.assetId)) {
      throw new ApplyRefusal({
        code: 'invalid-params',
        message: `the batch names the picture "${page.assetId}" more than once, so nothing was published`,
        target: 'pages',
        correctiveHint: 'give each picture one page',
      });
    }
    seen.add(page.assetId);
    const record = records.find((candidate) => candidate.id === page.assetId);
    if (record === undefined) {
      throw new ApplyRefusal({
        code: 'not-found',
        message: `there is no picture "${page.assetId}", so nothing was published`,
        target: 'pages',
        correctiveHint: 'choose pictures from the library',
      });
    }
    const rawPage: Record<string, unknown> = page;
    if (!('expect' in rawPage)) {
      throw new ApplyRefusal({
        code: 'invalid-params',
        message: `the page of "${page.assetId}" carries no expect guard, so nothing was published`,
        target: 'pages',
        correctiveHint: 'send the record’s complete current transcription, or null',
      });
    }
    if (!sameValue(record.transcription ?? null, page.expect ?? null)) {
      throw new ApplyRefusal({
        code: 'revision-conflict',
        message: `the picture "${page.assetId}" changed since its transcription was read, so nothing was published`,
        target: 'pages',
        correctiveHint: 'read the picture again and resend the batch against what its record holds now',
      });
    }
    guarded.push({ page, record });
  }
  return guarded;
}

/** A refusal for a defect the guards let through — the apply's own "the project changed" path, nothing written yet. */
function refused(message: string, target: string, correctiveHint: string): ApplyRefusal {
  return new ApplyRefusal({ code: 'invalid-params', message, target, correctiveHint });
}

/** The record with a fresh transcription, validated before it is written. */
function transcribedRecord(record: ReadAssetRecord, transcription: AssetTranscription, stamp: string): ReadAssetRecord {
  const next = { ...record, transcription, updatedAt: stamp };
  const checked = validateAssetRecord(next);
  if (!checked.ok) throw new Error(`the transcribed record for ${record.id} is not valid: ${checked.issues.map((issue) => issue.message).join('; ')}`);
  return next as ReadAssetRecord;
}

/** `into: 'searchable'`: the text goes onto the records and nothing else is created (§8.4 step 5). */
function applySearchable(
  state: ProjectState,
  guarded: readonly GuardedPage[],
  stamp: string,
  context: ApplyContext,
  ledger: UndoRetentionLedger | undefined,
): { into: 'searchable'; assetIds: string[] } {
  const byId = new Map(guarded.map((entry) => [entry.page.assetId, entry]));
  const nextRecords = recordsOf(state).map((record) => {
    const entry = byId.get(record.id);
    if (entry === undefined) return record;
    return transcribedRecord(record, { text: entry.page.text, ...(entry.page.model === undefined ? {} : { model: entry.page.model }), at: stamp }, stamp);
  });
  const assetIds = guarded.map((entry) => entry.page.assetId);
  const undo = replaceList(state, 'assets', nextRecords, assetIds);
  ledger?.note(context.commandId, assetIds, 'a transcription capture');
  context.undo.compensate(`put the transcription of ${plural(assetIds.length, 'picture', 'pictures')} back as it was`, () => undoList(state, undo));
  context.report({
    affected: [],
    summary: `published the reviewed transcription of ${plural(guarded.length, 'page', 'pages')} on the picture records; no document was created`,
  });
  return { into: 'searchable', assetIds };
}

/** `into: 'new-document'`: one Research document, one `source` paragraph link per page, and the reciprocal references (§8.4 step 4). */
function applyNewDocument(
  state: ProjectState,
  guarded: readonly GuardedPage[],
  title: string | undefined,
  stamp: string,
  now: Date,
  context: ApplyContext,
  ledger: UndoRetentionLedger | undefined,
): { into: 'new-document'; assetIds: string[]; docId: string; linkIds: string[] } {
  const research = nodeById(state, 'research');
  if (research === undefined) {
    throw new ApplyRefusal({
      code: 'not-found',
      message: 'the Research folder is not in the project, so nothing was published',
      target: 'into',
      correctiveHint: 'publish the batch as searchable text instead, or restore the Research folder',
    });
  }

  // Everything that can refuse is computed before the first write: the body, the title, the new document's id, each
  // page's paragraph anchor (the new document is born at revision 0), the new links and the new records.
  const body = guarded.map((entry) => entry.page.text).join('\n\n');
  const documentTitle = transcribeTitle(title, guarded[0]?.page.text ?? '');
  const docId = newId('n', { taken: new Set(state.manifest.tree.map((node) => node.id)) });
  const offsets = pageOffsets(guarded.map((entry) => entry.page));
  const anchors: ParagraphAnchor[] = [];
  for (const [index, entry] of guarded.entries()) {
    const anchor = captureParagraphAnchor(body, offsets[index] ?? 0, 0);
    if (anchor === undefined) {
      throw refused(`the page of "${entry.page.assetId}" holds no paragraph to pin, so nothing was published`, 'pages', 'send the page’s reviewed text');
    }
    anchors.push(anchor);
  }
  let links: readonly (AssetLink | ReadAssetLink)[] = linksOf(state);
  const linkIds: string[] = [];
  for (const [index, entry] of guarded.entries()) {
    const anchor = anchors[index];
    if (anchor === undefined) throw new Error('a guarded page has no anchor');
    const added = addLink(links, {
      assetId: entry.page.assetId,
      target: { kind: 'paragraph', nodeId: docId, anchor },
      role: 'source',
    });
    if (!added.ok) {
      throw refused(
        `the source link for "${entry.page.assetId}" could not be made (${added.issues.map((issue) => issue.message).join('; ')}), so nothing was published`,
        'pages',
        'read the pictures again and resend the batch',
      );
    }
    links = added.value.links;
    linkIds.push(added.value.link.id);
  }
  const byId = new Map(guarded.map((entry, index) => [entry.page.assetId, { entry, anchor: anchors[index] } as const]));
  const nextRecords = recordsOf(state).map((record) => {
    const found = byId.get(record.id);
    if (found === undefined) return record;
    const anchor = found.anchor;
    if (anchor === undefined) throw new Error('a guarded page has no anchor');
    return transcribedRecord(
      record,
      { docId, anchor: textAnchorOf(anchor), ...(found.entry.page.model === undefined ? {} : { model: found.entry.page.model }), at: stamp },
      stamp,
    );
  });

  // The before-images, captured before the first write: the tree, and the one word-count entry the new document adds.
  const treeBefore = structuredClone(state.manifest.tree);
  const wordCounts = state.manifest.derived.wordCounts;
  const hadCount = Object.prototype.hasOwnProperty.call(wordCounts, docId);
  const countBefore: number | undefined = wordCounts[docId];

  // The writes: the document (tree, body record, word count), then the two lists.
  addDocument(state, { parentId: research.id, title: documentTitle, body, now, id: docId });
  const assetIds = guarded.map((entry) => entry.page.assetId);
  const recordsUndo = replaceList(state, 'assets', nextRecords, assetIds);
  const linksUndo = replaceList(state, 'assetLinks', links, linkIds);
  ledger?.note(context.commandId, assetIds, 'a transcription capture');
  context.undo.compensate(`remove the transcription document and put the ${plural(assetIds.length, 'picture record', 'picture records')} back`, () => {
    undoList(state, linksUndo);
    undoList(state, recordsUndo);
    state.manifest.tree = treeBefore;
    state.documents.delete(docId);
    if (hadCount && countBefore !== undefined) wordCounts[docId] = countBefore;
    else delete wordCounts[docId];
  });
  context.report({
    affected: [{ nodeId: docId, title: documentTitle }],
    summary: `created "${documentTitle}" under Research with the ${plural(guarded.length, 'transcribed page', 'transcribed pages')}, and linked each page’s picture to its paragraph`,
  });
  return { into: 'new-document', assetIds, docId, linkIds };
}

/**
 * The apply for `asset.transcribe`, narrowed to the registry's state type so the wiring is one map entry
 * (`apply: applyAssetTranscribe(options.clock, ledger)`). The clock stamps the records' `transcription.at` and `updatedAt`.
 */
export function applyAssetTranscribe(clock: ApplyClock, ledger?: UndoRetentionLedger): CommandApply<TranscribeParams, unknown> {
  const apply: PictureApply<TranscribeParams> = (state, params, context) => {
    if (params.into !== 'searchable' && params.into !== 'new-document') {
      throw new ApplyRefusal({
        code: 'invalid-params',
        message: `params.into must be "new-document" or "searchable", got ${JSON.stringify(params.into)}`,
        target: 'into',
        correctiveHint: 'choose where the reviewed pages go',
      });
    }
    const stamp = new Date(clock.now()).toISOString();
    const guarded = guardPages(state, params.pages);
    if (params.into === 'searchable') return applySearchable(state, guarded, stamp, context, ledger);
    return applyNewDocument(state, guarded, params.title, stamp, new Date(clock.now()), context, ledger);
  };
  return apply as CommandApply<TranscribeParams, unknown>;
}
