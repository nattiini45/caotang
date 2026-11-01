/**
 * `asset.transcribe`'s descriptor — the [pictures.md §2.4 and §8.4](docs/architecture/pictures.md) row, tabulated in
 * [command-bus.md §9](docs/architecture/command-bus.md). The apply is the store's (`packages/store/src/commands-transcription.ts`).
 *
 * The command publishes one reviewed transcription batch (§8.4's approval step): each page names its picture, the
 * reviewed non-blank text, the optional model that read it, and an `expect` guard holding the record's **complete**
 * current `transcription` or `null`. A repeated picture or a guard that no longer matches refuses the whole batch
 * before anything is written; the apply re-checks the same guards against the live state, so a direct caller gets the
 * same all-or-nothing refusal.
 */

import { isAssetId, PICTURE_LIMITS, type AssetTranscription } from '@caotang/pictures';

import type { CommandDescriptor } from './command.js';
import {
  invalid,
  isRecord,
  limitExceeded,
  notFound,
  requireDeclaredParams,
  requireNonBlankString,
  requireString,
  showValue,
} from './params.js';
import { err, ok, type CommandError, type Result } from './result.js';

/* ------------------------------------------------------------------ *
 * Param shapes
 * ------------------------------------------------------------------ */

/** The two ways a reviewed batch is published (pictures.md §8.4 steps 4–5). */
export type AssetTranscribeInto = 'new-document' | 'searchable';

export const ASSET_TRANSCRIBE_INTO: readonly AssetTranscribeInto[] = ['new-document', 'searchable'];

/** The most pages one `asset.transcribe` batch publishes (pictures.md §2.4: 1–100). */
export const ASSET_TRANSCRIBE_PAGES_MAX = 100;

/** One reviewed page: its picture, the reviewed text, the model that read it, and the guard on the record. */
export type AssetTranscribePage = {
  assetId: string;
  /** The reviewed, non-blank transcription of the page. */
  text: string;
  model?: string;
  /** Required: the record's complete current `transcription` value, or `null` when it holds none. */
  expect: AssetTranscription | null;
};

export type AssetTranscribeParams = {
  into: AssetTranscribeInto;
  pages: AssetTranscribePage[];
  /** Only for `into: 'new-document'`; absent, the title comes from the first page's first non-empty line. */
  title?: string;
};

/** The keys of one page: `{assetId, text, model?, expect}`. */
const PAGE_KEYS: readonly string[] = ['assetId', 'text', 'model', 'expect'];

/* ------------------------------------------------------------------ *
 * Shared readers
 * ------------------------------------------------------------------ */

/** The `expect` guard's comparison, as the picture commands' own `expect` checks compare: the complete value, or `null` for none. */
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/* ------------------------------------------------------------------ *
 * The descriptor
 * ------------------------------------------------------------------ */

export const assetTranscribeDescriptor: CommandDescriptor<AssetTranscribeParams> = {
  mutates: 'project',
  // The batch publishes reviewed model output into the project, so the writer confirms it (§2.4's write-confirm row).
  agentRisk: 'write-confirm',
  // One undo group restores the document, the links and the records together; the capture is a before-image, not an inverse command.
  undo: 'compensable',
  validate: (params, snapshot): Result<AssetTranscribeParams, CommandError> => {
    const p = requireDeclaredParams('asset.transcribe', params);
    if (!p.ok) return p;
    const into = p.value['into'];
    if (typeof into !== 'string' || !(ASSET_TRANSCRIBE_INTO as readonly string[]).includes(into)) {
      return invalid(
        `params.into must be one of ${ASSET_TRANSCRIBE_INTO.join(', ')}, got ${showValue(into)}`,
        'choose where the reviewed pages go: a new document, or searchable text on the pictures themselves',
        'into',
      );
    }
    let title: string | undefined;
    if (p.value['title'] !== undefined) {
      if (into !== 'new-document') {
        return invalid(
          'params.title belongs to a new-document transcription, so it cannot be sent with into "searchable"',
          'drop title, or publish the batch into a new document',
          'title',
        );
      }
      const given = requireNonBlankString(p.value, 'title', { blankHint: 'give the new document a title, or leave title out to take it from the first line' });
      if (!given.ok) return given;
      title = given.value;
    }
    const list = p.value['pages'];
    if (!Array.isArray(list) || list.length === 0) {
      return invalid(
        `params.pages must be a non-empty array of pages, got ${showValue(list)}`,
        'pass one entry per transcribed page: {assetId, text, expect}',
        'pages',
      );
    }
    if (list.length > ASSET_TRANSCRIBE_PAGES_MAX) {
      return limitExceeded(
        `params.pages has ${list.length} entries, limit ${ASSET_TRANSCRIBE_PAGES_MAX}`,
        `send at most ${ASSET_TRANSCRIBE_PAGES_MAX} pages at once`,
        'pages',
      );
    }
    const pages: AssetTranscribePage[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of list.entries()) {
      const at = `params.pages[${index}]`;
      if (!isRecord(entry)) {
        return invalid(`${at} must be an object with assetId, text and expect, got ${showValue(entry)}`, 'a page carries only assetId, text, model and expect', at);
      }
      for (const key of Object.keys(entry)) {
        if (!PAGE_KEYS.includes(key)) {
          return invalid(`${at}.${key} is not a key of a transcribed page`, 'a page carries only assetId, text, model and expect', `${at}.${key}`);
        }
      }
      const assetId = requireNonBlankString(entry, 'assetId', { maxChars: 64 });
      if (!assetId.ok) {
        return assetId.error.code === 'limit-exceeded'
          ? limitExceeded(`${at}: ${assetId.error.message}`, assetId.error.correctiveHint, `${at}.assetId`)
          : invalid(`${at}: ${assetId.error.message}`, assetId.error.correctiveHint, `${at}.assetId`);
      }
      if (!isAssetId(assetId.value)) {
        return invalid(`${at}.assetId must be a picture id (a_…), got ${showValue(assetId.value)}`, 'choose pictures from the library', `${at}.assetId`);
      }
      if (seen.has(assetId.value)) {
        return invalid(`params.pages names the picture "${assetId.value}" more than once, so the batch would publish it twice`, 'give each picture one page', `${at}.assetId`);
      }
      const record = (snapshot.manifest.assets ?? []).find((candidate) => candidate.id === assetId.value);
      if (record === undefined) {
        return notFound(`${at} names the picture "${assetId.value}", which the project does not hold`, 'choose pictures from the library', `${at}.assetId`);
      }
      if (!('text' in entry)) {
        return invalid(`${at}.text is required`, 'send the page’s reviewed transcription', `${at}.text`);
      }
      const text = requireString(entry, 'text');
      if (!text.ok) return invalid(`${at}: ${text.error.message}`, text.error.correctiveHint, `${at}.text`);
      if (text.value.trim().length === 0) {
        return invalid(`${at}.text is blank, and a reviewed page is never blank`, 'send the page’s reviewed text, or leave the page out of the batch', `${at}.text`);
      }
      let model: string | undefined;
      if (entry['model'] !== undefined) {
        const given = requireString(entry, 'model', PICTURE_LIMITS.label);
        if (!given.ok) {
          return given.error.code === 'limit-exceeded'
            ? limitExceeded(`${at}: ${given.error.message}`, given.error.correctiveHint, `${at}.model`)
            : invalid(`${at}: ${given.error.message}`, given.error.correctiveHint, `${at}.model`);
        }
        model = given.value;
      }
      if (!('expect' in entry)) {
        return invalid(
          `${at}.expect is required: the record’s complete current transcription, or null when it holds none`,
          'read the picture again and send what its record holds now',
          `${at}.expect`,
        );
      }
      const rawExpect = entry['expect'];
      if (rawExpect !== null && rawExpect !== undefined && !isRecord(rawExpect)) {
        return invalid(`${at}.expect must be the record’s transcription object or null, got ${showValue(rawExpect)}`, undefined, `${at}.expect`);
      }
      const expect = (rawExpect ?? null) as AssetTranscription | null;
      if (!sameValue(record.transcription ?? null, expect)) {
        return err({
          code: 'revision-conflict',
          message: `the picture "${assetId.value}" changed since its transcription was read, so nothing was published`,
          target: `${at}.expect`,
          correctiveHint: 'read the picture again and resend the batch against what its record holds now',
        });
      }
      seen.add(assetId.value);
      pages.push({ assetId: assetId.value, text: text.value, ...(model === undefined ? {} : { model }), expect });
    }
    return ok({ into: into as AssetTranscribeInto, pages, ...(title === undefined ? {} : { title }) });
  },
};
