/**
 * `pictures.transcribe` (pictures.md §8.4, #146 / C3): the tool's params, the plan the agent stages before its card,
 * and the async port that publishes the writer-reviewed pages through exactly one `asset.transcribe` command.
 *
 * The split is the one §8.4 draws: `stageTranscriptionPlan` is pure — it reads the records and the codex, plans the
 * batches and the estimate, and freezes each page's `expect` guard — and never calls a model or reads a file.
 * The generation (the vision reads) happens in the agent loop with its budgeted model call — the second read, when
 * one is selected, on its own pinned route as a separate budgeted call — which stages a `{plan, draft}` proposal on
 * the call; the port here only runs the host's review gate and dispatches what the writer approved. The port never takes a proposal from the model's params, never reads `expect` from the draft or the
 * review, and writes only through the bus.
 *
 * The metadata/table registry exposes the deferred tool, and the product harness wires this port when the host
 * supplies vision capability and a review gate.
 */

// i18n: model-facing

import { ASSET_TRANSCRIBE_INTO, ASSET_TRANSCRIBE_PAGES_MAX, err, ok, refusal, type CommandError, type ExecutionOutcome, type Result } from '@caotang/bus';
import { tokensForChars } from '@caotang/codex';
import { assetFileName, isAssetId, type AssetTranscription, type PictureMime, type ReadAssetRecord } from '@caotang/pictures';
import type { ProjectState } from '@caotang/store';

import { invalidParams, limitExceeded, notFound } from '../errors.js';
import { param, type ObjectSpec } from '../schema.js';
import type { AsyncToolPort, CallParams } from '../types.js';
import {
  buildTranscriptionPrompt,
  compareTranscriptionReads,
  planTranscriptionBatches,
  type TranscriptionDisagreement,
  type TranscriptionRequestBatch,
} from './transcription-model.js';

/** pictures.md §8.4 step 1: more than 20 selected pages is a warning on the plan card. */
export const TRANSCRIPTION_LARGE_BATCH_PAGES = 20;

/** The output estimate per page per read (§8.4's "one vision call per page, ×2 with a second read"). */
export const TRANSCRIPTION_OUTPUT_TOKENS_PER_PAGE = 1200;

/** The second read's route: a provider profile id of at most this many characters. */
export const TRANSCRIPTION_SECOND_READ_PROFILE_MAX = 128;

/** The second read's optional model name: at most this many characters. */
export const TRANSCRIPTION_SECOND_READ_MODEL_MAX = 200;

/** `pictures.transcribe`'s params (pictures.md §8.4: `{assetIds[], into?, language?, secondRead?}`). */
export const transcriptionParams: ObjectSpec = param.object(
  'The handwritten pages to transcribe, and where the reviewed text goes.',
  {
    assetIds: param.list(
      `One to ${ASSET_TRANSCRIBE_PAGES_MAX} picture ids (a_…), each page named once.`,
      param.string('One picture id.', { nonBlank: true, maxLength: 64 }),
      { minItems: 1, maxItems: ASSET_TRANSCRIBE_PAGES_MAX, unique: true },
    ),
    into: param.choice('Where the reviewed pages go once approved: a new Research document, or searchable text on the picture records.', [...ASSET_TRANSCRIBE_INTO], { default: 'new-document' }),
    language: param.string('The language of the handwriting, overriding the project language. A hint only: the transcription never corrects the text to match it.', { nonBlank: true, maxLength: 64 }),
    secondRead: param.object(
      'A second read on another vision route, to highlight the word-level disagreements for review. Omit it for one read. The agent loop checks this route’s vision capability and runs it as its own pinned, budgeted model call; nothing is merged automatically.',
      {
        profileId: param.string('The provider profile the second read runs on.', { nonBlank: true, maxLength: TRANSCRIPTION_SECOND_READ_PROFILE_MAX }),
        model: param.string('A model on that profile. Omit for the profile’s default.', { nonBlank: true, maxLength: TRANSCRIPTION_SECOND_READ_MODEL_MAX }),
      },
      ['profileId'],
    ),
  },
  ['assetIds'],
);

/** Where a reviewed batch is published (pictures.md §8.4 steps 4–5). */
export type TranscriptionInto = (typeof ASSET_TRANSCRIBE_INTO)[number];

/**
 * The second read's route (the P14 appendix, grounded-pine-eel.md §6): an explicitly selected other vision
 * profile, never a silent repeat of the first read. The loop checks this route's vision capability and builds its
 * separately pinned budgeted model call, so staging validates the shape only, never the route's capabilities.
 */
export interface TranscriptionSecondRead {
  readonly profileId: string;
  readonly model?: string;
}

/** The plan card's typed warnings (pictures.md §8.4 step 1, the re-transcription rules of steps 4–6, and the language hint). */
export type TranscriptionWarning = 'large-batch' | 'new-document' | 'searchable' | 'non-english';

/** One page of the staged plan: what the card shows and what the command's `expect` guard is frozen from. */
export interface PictureTranscriptionPagePlan {
  readonly assetId: string;
  /** The stored file name (`a_….png`), as the record names it. */
  readonly file: string;
  readonly caption?: string;
  readonly width?: number;
  readonly height?: number;
  readonly bytes: number;
  /** A deep copy of the record's complete current `transcription`, or `null` when it holds none. */
  readonly expect: AssetTranscription | null;
}

/**
 * The plan card's cost estimate. An estimate, never a provider guarantee: the prompt tokens come from the exact
 * `buildTranscriptionPrompt` text plus the conservative image rule below, the output from a per-page figure.
 */
export interface TranscriptionEstimate {
  /** Model requests at the planned batching: batch requests × reads. */
  readonly requests: number;
  /** Worst case when every batch fails and falls back to one page per request: pages × reads. */
  readonly maxRequests: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
}

/** The plan the agent stages for `pictures.transcribe` before its card is shown. */
export interface PictureTranscriptionPlan {
  readonly kind: 'pictures.transcribe';
  readonly into: TranscriptionInto;
  /** The language hint for the prompt: the override, else the project language, else `'en'`. */
  readonly language: string;
  /** The second read's route, or absent for one read; `reads` is 1 without it and 2 with it. */
  readonly secondRead?: TranscriptionSecondRead;
  /** The codex vocabulary (entry names and aliases) the prompt offers as context only. */
  readonly vocabulary: readonly string[];
  /** The pages in the order the writer selected them. */
  readonly pages: readonly PictureTranscriptionPagePlan[];
  /** The model requests, from `planTranscriptionBatches` at the §8.4 cap of 6 pages. */
  readonly batches: readonly TranscriptionRequestBatch[];
  readonly estimate: TranscriptionEstimate;
  readonly warnings: readonly TranscriptionWarning[];
}

/** One page of the loop's generation: the first read, and the second read when `secondRead` ran. */
export interface PictureTranscriptionGenerationPage {
  readonly assetId: string;
  readonly text: string;
  readonly secondText?: string;
}

/** What the app/loop generates after the plan is approved, with its budgeted model call. */
export interface PictureTranscriptionGeneration {
  readonly pages: readonly PictureTranscriptionGenerationPage[];
  readonly model?: string;
}

/**
 * What the loop stages on the call (`PortContext.proposal`): the approved plan plus the generated draft. Never
 * model-written params — the runtime only fills `proposal` from what the loop staged.
 */
export interface PictureTranscriptionProposal {
  readonly plan: PictureTranscriptionPlan;
  readonly draft: PictureTranscriptionGeneration;
}

/** One page as the review gate shows it: both reads and the word-level spans between them. */
export interface PictureTranscriptionReviewPage {
  readonly assetId: string;
  readonly text: string;
  readonly secondText?: string;
  /** UTF-16 spans into `text` where the second read disagrees, for inline review marks. Absent without a second read. */
  readonly disagreements?: readonly TranscriptionDisagreement[];
  readonly caption?: string;
  readonly file?: string;
}

/** One page the writer approved, with its final text. */
export interface PictureTranscriptionReviewedPage {
  readonly assetId: string;
  readonly text: string;
}

/** The host review's answer: the approved subset in plan order, and a title for the new document. */
export interface PictureTranscriptionReviewResult {
  readonly pages: readonly PictureTranscriptionReviewedPage[];
  readonly title?: string;
}

/**
 * What `pictures.transcribe` needs from the host. The harness has no model and no UI: the loop generates the draft
 * with its budgeted model call, and the host shows the review gate and waits for the writer.
 */
export interface PictureTranscriptionHost {
  /** Whether the active model for this turn accepts image parts (the route's `caps.vision`). */
  readonly vision: () => boolean;
  /**
   * Shows the draft beside the plan and waits for the writer. Answers the approved pages — a subset, in the plan's
   * order, each text possibly edited — or `null` when the writer cancelled. No model call lives here.
   */
  readonly review: (draft: PictureTranscriptionProposal, signal?: AbortSignal) => Promise<PictureTranscriptionReviewResult | null>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A deep copy of the `expect` guard, so a later mutation of the record cannot alter the staged plan. */
const copyOfExpect = (transcription: AssetTranscription | undefined): AssetTranscription | null =>
  transcription === undefined ? null : (JSON.parse(JSON.stringify(transcription)) as AssetTranscription);

/**
 * The conservative per-image token rule, matching the gateway's `imageTokens` on an unknown route
 * (gateway parts.ts): with known display dimensions, the larger of the per-pixel rule `ceil(w·h/750)` and the tile
 * rule `85 + 170·ceil(w/512)·ceil(h/512)`; without dimensions, `ceil(bytes/64)`.
 */
function imageTokensEstimate(page: PictureTranscriptionPagePlan): number {
  if (page.width !== undefined && page.height !== undefined) {
    return Math.max(
      Math.ceil((page.width * page.height) / 750),
      85 + 170 * Math.ceil(page.width / 512) * Math.ceil(page.height / 512),
    );
  }
  return Math.ceil(page.bytes / 64);
}

function estimateOf(
  pages: readonly PictureTranscriptionPagePlan[],
  batches: readonly TranscriptionRequestBatch[],
  language: string,
  vocabulary: readonly string[],
  reads: number,
): TranscriptionEstimate {
  const byId = new Map(pages.map((page) => [page.assetId, page]));
  let promptTokens = 0;
  for (const batch of batches) {
    // The exact prompt text the request carries, plus each page's image estimate.
    promptTokens += tokensForChars(buildTranscriptionPrompt({ pages: batch.pages, language, vocabulary }).length);
    for (const assetId of batch.pages) {
      promptTokens += imageTokensEstimate(byId.get(assetId) ?? { assetId, file: '', bytes: 0, expect: null });
    }
  }
  promptTokens *= reads;
  return {
    requests: batches.length * reads,
    maxRequests: pages.length * reads,
    promptTokens,
    outputTokens: pages.length * TRANSCRIPTION_OUTPUT_TOKENS_PER_PAGE * reads,
  };
}

const DECLARED_KEYS: readonly string[] = ['assetIds', 'into', 'language', 'secondRead'];

/**
 * A conservative English check for the `non-english` warning: only `en` or `en-…` counts (BCP-47, with `_` read
 * as `-`); every other tag warns. No age or script is inferred from the tag.
 */
const isEnglishHint = (language: string): boolean => {
  const tag = language.trim().toLowerCase().replace(/_/g, '-');
  return tag === 'en' || tag.startsWith('en-');
};

/**
 * Stage the plan for a `pictures.transcribe` call. Pure and synchronous: it validates the params robustly (even
 * before any registry preflight), reads the records and the codex, and freezes the `expect` guards — no model call,
 * no file read, nothing written. A non-vision route is refused up front, naming the setting (pictures.md §8.4 step 1).
 */
export function stageTranscriptionPlan(
  params: CallParams,
  state: ProjectState,
  host: PictureTranscriptionHost,
): Result<PictureTranscriptionPlan, CommandError> {
  for (const key of Object.keys(params)) {
    if (!DECLARED_KEYS.includes(key)) {
      return err(
        invalidParams(
          `pictures.transcribe takes no param "${key}" — it accepts only: ${DECLARED_KEYS.join(', ')}`,
          `drop "${key}" and resend`,
          key,
        ),
      );
    }
  }

  const rawIds = params['assetIds'];
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return err(invalidParams('assetIds must name at least one page to transcribe', 'pass one picture id per page, from pictures.list', 'assetIds'));
  }
  if (rawIds.length > ASSET_TRANSCRIBE_PAGES_MAX) {
    return err(
      limitExceeded(`assetIds has ${rawIds.length} entries, limit ${ASSET_TRANSCRIBE_PAGES_MAX}`, `send at most ${ASSET_TRANSCRIBE_PAGES_MAX} pages at once`, 'assetIds'),
    );
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawIds.entries()) {
    const at = `assetIds[${index}]`;
    if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 64) {
      return err(invalidParams(`${at} must be a picture id string, at most 64 characters`, 'read the ids with pictures.list', at));
    }
    if (!isAssetId(raw)) {
      return err(invalidParams(`${at} must be a picture id (a_…), got "${raw}"`, 'choose pictures from the library', at));
    }
    if (seen.has(raw)) {
      return err(invalidParams(`${at} names the picture "${raw}" more than once`, 'give each picture one page', at));
    }
    seen.add(raw);
    ids.push(raw);
  }

  const rawInto = params['into'];
  if (rawInto !== undefined && !(ASSET_TRANSCRIBE_INTO as readonly string[]).includes(rawInto as string)) {
    return err(
      invalidParams(`params.into must be one of ${ASSET_TRANSCRIBE_INTO.join(', ')}, got ${JSON.stringify(rawInto)}`, 'choose where the reviewed pages go: a new document, or searchable text on the pictures', 'into'),
    );
  }
  const into = (rawInto as TranscriptionInto | undefined) ?? 'new-document';

  const rawLanguage = params['language'];
  if (rawLanguage !== undefined && (typeof rawLanguage !== 'string' || rawLanguage.trim() === '' || rawLanguage.length > 64)) {
    return err(invalidParams('params.language must be a non-blank string, at most 64 characters', 'name the language of the handwriting, or leave it out for the project language', 'language'));
  }
  const rawSecondRead = params['secondRead'];
  let secondRead: TranscriptionSecondRead | undefined;
  if (rawSecondRead !== undefined) {
    if (!isRecord(rawSecondRead)) {
      return err(
        invalidParams('params.secondRead must be an object naming the second read’s route: { profileId, model? }', 'name the provider profile the second read runs on, or omit secondRead for one read', 'secondRead'),
      );
    }
    for (const key of Object.keys(rawSecondRead)) {
      if (key !== 'profileId' && key !== 'model') {
        return err(
          invalidParams(`params.secondRead takes no key "${key}" — it accepts only profileId and model`, `drop "${key}" and resend`, `secondRead.${key}`),
        );
      }
    }
    const profileId = rawSecondRead['profileId'];
    if (typeof profileId !== 'string' || profileId.trim() === '') {
      return err(
        invalidParams('params.secondRead.profileId must be a non-blank string naming a provider profile', 'name the profile the second read runs on, or omit secondRead for one read', 'secondRead.profileId'),
      );
    }
    if (profileId.length > TRANSCRIPTION_SECOND_READ_PROFILE_MAX) {
      return err(
        limitExceeded(`params.secondRead.profileId is ${profileId.length} characters, limit ${TRANSCRIPTION_SECOND_READ_PROFILE_MAX}`, `name the profile in at most ${TRANSCRIPTION_SECOND_READ_PROFILE_MAX} characters`, 'secondRead.profileId'),
      );
    }
    const rawModel = rawSecondRead['model'];
    if (rawModel !== undefined && (typeof rawModel !== 'string' || rawModel.trim() === '')) {
      return err(
        invalidParams('params.secondRead.model must be a non-blank string when present', 'name a model on that profile, or omit model for the profile’s default', 'secondRead.model'),
      );
    }
    if (typeof rawModel === 'string' && rawModel.length > TRANSCRIPTION_SECOND_READ_MODEL_MAX) {
      return err(
        limitExceeded(`params.secondRead.model is ${rawModel.length} characters, limit ${TRANSCRIPTION_SECOND_READ_MODEL_MAX}`, `name the model in at most ${TRANSCRIPTION_SECOND_READ_MODEL_MAX} characters`, 'secondRead.model'),
      );
    }
    secondRead = { profileId, ...(typeof rawModel === 'string' ? { model: rawModel } : {}) };
  }

  if (!host.vision()) {
    return err(
      refusal('invalid-params', 'the active model does not accept images, so it cannot read handwriting', {
        target: 'assetIds',
        correctiveHint: 'choose a model with vision for the Drafting role in Settings › Providers, then call pictures.transcribe again',
      }),
    );
  }

  const records = (state.manifest.assets ?? []) as readonly ReadAssetRecord[];
  const pages: PictureTranscriptionPagePlan[] = [];
  for (const [index, id] of ids.entries()) {
    const found = records.find((candidate) => candidate.id === id);
    if (found === undefined) {
      return err(notFound(`there is no picture "${id}" in the project`, 'read the ids with pictures.list', `assetIds[${index}]`));
    }
    pages.push({
      assetId: id,
      file: assetFileName(id, found.mime as PictureMime),
      ...(found.caption === undefined ? {} : { caption: found.caption }),
      ...(found.width === undefined ? {} : { width: found.width }),
      ...(found.height === undefined ? {} : { height: found.height }),
      bytes: found.bytes,
      expect: copyOfExpect(found.transcription),
    });
  }

  const projectLanguage =
    typeof state.manifest.project.language === 'string' && state.manifest.project.language.trim() !== ''
      ? state.manifest.project.language.trim()
      : 'en';
  const language = typeof rawLanguage === 'string' ? rawLanguage.trim() : projectLanguage;

  const vocabulary: string[] = [];
  const seenTerms = new Set<string>();
  for (const entry of state.manifest.codex ?? []) {
    for (const term of [entry.name, ...(entry.aliases ?? [])]) {
      const trimmed = term.trim();
      if (trimmed !== '' && !seenTerms.has(trimmed)) {
        seenTerms.add(trimmed);
        vocabulary.push(trimmed);
      }
    }
  }

  const batches = planTranscriptionBatches(ids);
  const reads = secondRead === undefined ? 1 : 2;

  const warnings: TranscriptionWarning[] = [];
  if (pages.length > TRANSCRIPTION_LARGE_BATCH_PAGES) warnings.push('large-batch');
  if (into === 'new-document' && pages.some((page) => page.expect?.docId !== undefined)) warnings.push('new-document');
  if (into === 'searchable' && pages.some((page) => page.expect?.text !== undefined)) warnings.push('searchable');
  if (!isEnglishHint(language)) warnings.push('non-english');

  return ok({
    kind: 'pictures.transcribe',
    into,
    language,
    ...(secondRead === undefined ? {} : { secondRead }),
    vocabulary,
    pages,
    batches,
    estimate: estimateOf(pages, batches, language, vocabulary, reads),
    warnings,
  });
}

/** The review gate's pages for a proposal: each read, and the second read's word-level disagreements beside it. */
export function reviewPagesOf(proposal: PictureTranscriptionProposal): readonly PictureTranscriptionReviewPage[] {
  const byId = new Map(proposal.plan.pages.map((page) => [page.assetId, page]));
  return proposal.draft.pages.map((page) => {
    const planPage = byId.get(page.assetId);
    return {
      assetId: page.assetId,
      text: page.text,
      ...(page.secondText === undefined ? {} : { secondText: page.secondText }),
      ...(page.secondText === undefined ? {} : { disagreements: compareTranscriptionReads(page.text, page.secondText) }),
      ...(planPage?.caption === undefined ? {} : { caption: planPage.caption }),
      ...(planPage === undefined ? {} : { file: planPage.file }),
    };
  });
}

/** One page of the agent card's preview, without the `expect` guard (the card shows what will run, not the guard). */
export interface TranscriptionPreviewPage {
  readonly assetId: string;
  readonly file: string;
  readonly caption?: string;
  readonly width?: number;
  readonly height?: number;
  readonly bytes: number;
}

/** The agent card's data for a staged plan. */
export interface TranscriptionPreview {
  readonly kind: 'pictures.transcribe';
  readonly into: TranscriptionInto;
  readonly language: string;
  readonly secondRead?: TranscriptionSecondRead;
  readonly batchSizes: readonly number[];
  readonly warnings: readonly TranscriptionWarning[];
  readonly estimate: TranscriptionEstimate;
  readonly pages: readonly TranscriptionPreviewPage[];
}

/** The plan card's data: counts, batch sizes, warnings and the estimate, with the pages minus their guards. */
export function transcriptionPreview(plan: PictureTranscriptionPlan): TranscriptionPreview {
  return {
    kind: plan.kind,
    into: plan.into,
    language: plan.language,
    ...(plan.secondRead === undefined ? {} : { secondRead: plan.secondRead }),
    batchSizes: plan.batches.map((batch) => batch.pages.length),
    warnings: [...plan.warnings],
    estimate: { ...plan.estimate },
    pages: plan.pages.map((page) => ({
      assetId: page.assetId,
      file: page.file,
      ...(page.caption === undefined ? {} : { caption: page.caption }),
      ...(page.width === undefined ? {} : { width: page.width }),
      ...(page.height === undefined ? {} : { height: page.height }),
      bytes: page.bytes,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Reading the staged proposal back (the runtime fills `proposal` from
 * what the loop staged; the port still checks the shape before using it)
 * ------------------------------------------------------------------ */

const WARNING_KINDS: readonly string[] = ['large-batch', 'new-document', 'searchable', 'non-english'];

function readPlan(value: unknown): PictureTranscriptionPlan | undefined {
  if (!isRecord(value) || value['kind'] !== 'pictures.transcribe') return undefined;
  const into = value['into'];
  if (typeof into !== 'string' || !(ASSET_TRANSCRIBE_INTO as readonly string[]).includes(into)) return undefined;
  const language = value['language'];
  if (typeof language !== 'string' || language === '') return undefined;
  const rawSecondRead = value['secondRead'];
  let secondRead: TranscriptionSecondRead | undefined;
  if (rawSecondRead !== undefined) {
    if (!isRecord(rawSecondRead) || typeof rawSecondRead['profileId'] !== 'string' || rawSecondRead['profileId'] === '') return undefined;
    const secondModel = rawSecondRead['model'];
    if (secondModel !== undefined && typeof secondModel !== 'string') return undefined;
    secondRead = { profileId: rawSecondRead['profileId'], ...(typeof secondModel === 'string' ? { model: secondModel } : {}) };
  }
  if (!Array.isArray(value['vocabulary']) || value['vocabulary'].some((term) => typeof term !== 'string')) return undefined;
  if (!Array.isArray(value['pages'])) return undefined;
  const pages: PictureTranscriptionPagePlan[] = [];
  for (const raw of value['pages']) {
    if (!isRecord(raw)) return undefined;
    const assetId = raw['assetId'];
    if (typeof assetId !== 'string' || !isAssetId(assetId)) return undefined;
    if (typeof raw['file'] !== 'string' || typeof raw['bytes'] !== 'number') return undefined;
    const expect = raw['expect'];
    if (expect !== null && !isRecord(expect)) return undefined;
    pages.push({
      assetId,
      file: raw['file'],
      bytes: raw['bytes'],
      ...(typeof raw['caption'] === 'string' ? { caption: raw['caption'] } : {}),
      ...(typeof raw['width'] === 'number' ? { width: raw['width'] } : {}),
      ...(typeof raw['height'] === 'number' ? { height: raw['height'] } : {}),
      expect: expect as AssetTranscription | null,
    });
  }
  if (!Array.isArray(value['batches']) || value['batches'].some((batch) => !isRecord(batch) || !Array.isArray(batch['pages']) || batch['pages'].some((page) => typeof page !== 'string'))) {
    return undefined;
  }
  const estimate = value['estimate'];
  if (!isRecord(estimate) || !['requests', 'maxRequests', 'promptTokens', 'outputTokens'].every((key) => typeof estimate[key] === 'number')) return undefined;
  if (!Array.isArray(value['warnings']) || value['warnings'].some((warning) => !WARNING_KINDS.includes(warning as string))) return undefined;
  return {
    kind: 'pictures.transcribe',
    into: into as TranscriptionInto,
    language,
    ...(secondRead === undefined ? {} : { secondRead }),
    vocabulary: value['vocabulary'] as readonly string[],
    pages,
    batches: value['batches'] as readonly TranscriptionRequestBatch[],
    estimate: {
      requests: estimate['requests'] as number,
      maxRequests: estimate['maxRequests'] as number,
      promptTokens: estimate['promptTokens'] as number,
      outputTokens: estimate['outputTokens'] as number,
    },
    warnings: value['warnings'] as readonly TranscriptionWarning[],
  };
}

function readGeneration(value: unknown): PictureTranscriptionGeneration | undefined {
  if (!isRecord(value) || !Array.isArray(value['pages'])) return undefined;
  const pages: PictureTranscriptionGenerationPage[] = [];
  for (const raw of value['pages']) {
    if (!isRecord(raw)) return undefined;
    const assetId = raw['assetId'];
    const text = raw['text'];
    if (typeof assetId !== 'string' || typeof text !== 'string' || text.trim() === '') return undefined;
    const secondText = raw['secondText'];
    if (secondText !== undefined && (typeof secondText !== 'string' || secondText.trim() === '')) return undefined;
    pages.push({ assetId, text, ...(typeof secondText === 'string' ? { secondText } : {}) });
  }
  const model = value['model'];
  if (model !== undefined && typeof model !== 'string') return undefined;
  return { pages, ...(typeof model === 'string' ? { model } : {}) };
}

function readProposal(value: unknown): PictureTranscriptionProposal | undefined {
  if (!isRecord(value)) return undefined;
  const plan = readPlan(value['plan']);
  const draft = readGeneration(value['draft']);
  if (plan === undefined || draft === undefined) return undefined;
  return { plan, draft };
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/* ------------------------------------------------------------------ *
 * The port
 * ------------------------------------------------------------------ */

/**
 * The async port for `pictures.transcribe`. It re-validates the call's params against the project as it stands,
 * requires the loop-staged `{plan, draft}` proposal, runs the host's review gate, and on a valid review dispatches
 * exactly one `asset.transcribe` with the approved pages — each page's `expect` taken from the staged plan, never
 * from the draft or the review. A cancelled review is a refusal with nothing dispatched; the write itself goes
 * through the bus, so there is no `recordEffect` here.
 */
export function transcriptionPort(host: PictureTranscriptionHost): AsyncToolPort {
  return async (params, context) => {
    const staged = stageTranscriptionPlan(params, context.state, host);
    if (!staged.ok) return err(staged.error);
    const plan = staged.value;

    const proposal = readProposal(context.proposal);
    if (proposal === undefined) {
      return err(
        invalidParams(
          'pictures.transcribe has no staged proposal: the agent loop stages the plan and the generated draft before the call runs, and none was staged for this call',
          'run the step through the agent, which plans and drafts it before its card is approved',
          'pictures.transcribe',
        ),
      );
    }
    if (proposal.plan.into !== plan.into || !sameIds(proposal.plan.pages.map((page) => page.assetId), plan.pages.map((page) => page.assetId))) {
      return err(
        invalidParams('the staged proposal does not match this call’s params, so it cannot be applied', 'stage the plan again from this call’s assetIds', 'pictures.transcribe'),
      );
    }
    if (!sameIds(proposal.draft.pages.map((page) => page.assetId), plan.pages.map((page) => page.assetId))) {
      return err(
        invalidParams('the staged draft does not cover the plan’s pages in order, so it cannot be reviewed', 'generate one read per page of the plan, in order', 'pictures.transcribe'),
      );
    }

    const reviewed = await host.review({ plan: proposal.plan, draft: proposal.draft }, context.signal);
    if (reviewed === null) {
      return err(
        refusal('permission-denied', 'the writer cancelled the transcription review, so nothing was published', {
          target: 'pictures.transcribe',
          correctiveHint: 'nothing was written; call pictures.transcribe again to review the pages again',
        }),
      );
    }
    if (!isRecord(reviewed) || !Array.isArray(reviewed['pages'])) {
      return err(invalidParams('the review result is malformed: it must answer with a pages list', 'review the pages again in the app', 'pictures.transcribe'));
    }
    const rawTitle = reviewed['title'];
    if (rawTitle !== undefined && (typeof rawTitle !== 'string' || rawTitle.trim() === '')) {
      return err(invalidParams('the review’s title must be a non-blank string', 'name the new document, or leave the title out to take it from the first line', 'title'));
    }
    if (rawTitle !== undefined && plan.into !== 'new-document') {
      return err(invalidParams('a title belongs to a new-document transcription, so it cannot be sent with into "searchable"', 'drop the title, or publish the batch into a new document', 'title'));
    }

    const rawPages = reviewed['pages'] as readonly unknown[];
    if (rawPages.length === 0) {
      return err(invalidParams('the review selected no pages, so there is nothing to publish', 'approve at least one page, or cancel', 'pictures.transcribe'));
    }
    // The approved plan's pages carry the expect guards frozen at stage time; the re-staged plan only pins the
    // order and the target. The draft and the review are never read for expect.
    const approvedById = new Map(proposal.plan.pages.map((page) => [page.assetId, page]));
    const planOrder = new Map(plan.pages.map((page, index) => [page.assetId, index]));
    const seen = new Set<string>();
    let lastIndex = -1;
    const commandPages: Record<string, unknown>[] = [];
    for (const [index, raw] of rawPages.entries()) {
      const at = `review.pages[${index}]`;
      if (!isRecord(raw)) {
        return err(invalidParams(`${at} must be an object with assetId and text`, 'approve the pages as the review shows them', at));
      }
      const assetId = raw['assetId'];
      const text = raw['text'];
      if (typeof assetId !== 'string' || !planOrder.has(assetId)) {
        return err(invalidParams(`${at} names ${JSON.stringify(assetId)}, which is not a page of this plan`, 'approve only the pages the plan lists', at));
      }
      if (seen.has(assetId)) {
        return err(invalidParams(`${at} approves the picture "${assetId}" twice`, 'approve each page once', at));
      }
      if (typeof text !== 'string' || text.trim() === '') {
        return err(invalidParams(`${at}.text is blank, and a reviewed page is never blank`, 'send the page’s reviewed text, or leave the page out of the batch', `${at}.text`));
      }
      const order = planOrder.get(assetId) ?? 0;
      if (order < lastIndex) {
        return err(invalidParams(`${at} approves "${assetId}" out of the plan’s order`, 'approve the pages in the order the plan lists them', at));
      }
      lastIndex = order;
      seen.add(assetId);
      const approved = approvedById.get(assetId);
      commandPages.push({
        assetId,
        text,
        ...(proposal.draft.model === undefined ? {} : { model: proposal.draft.model }),
        expect: approved?.expect ?? null,
      });
    }

    const command: CallParams = {
      into: plan.into,
      pages: commandPages,
      ...(typeof rawTitle === 'string' ? { title: rawTitle } : {}),
    };
    const applied = context.dispatch('asset.transcribe', command);
    if (!applied.ok) return err(applied.error);
    const outcome: ExecutionOutcome = applied.value;
    const result = isRecord(outcome.result) ? outcome.result : {};
    const assetIds = Array.isArray(result['assetIds']) ? result['assetIds'] : commandPages.map((page) => page['assetId']);
    const docId = typeof result['docId'] === 'string' ? result['docId'] : undefined;
    const linkIds = Array.isArray(result['linkIds']) ? result['linkIds'] : undefined;
    const count = commandPages.length;
    return ok({
      data: {
        into: plan.into,
        pages: count,
        assetIds,
        ...(docId === undefined ? {} : { docId }),
        ...(linkIds === undefined ? {} : { linkIds }),
        ...(proposal.draft.model === undefined ? {} : { model: proposal.draft.model }),
        ...(plan.secondRead === undefined ? {} : { secondRead: plan.secondRead }),
      },
      summary:
        plan.into === 'new-document'
          ? `published ${count} reviewed ${count === 1 ? 'page' : 'pages'} as the new document ${docId ?? '(id not reported)'}; one undo restores the document, links and records together`
          : `published ${count} reviewed ${count === 1 ? 'page' : 'pages'} as searchable text on the picture records; no document was created`,
      affected: [...outcome.affected],
      ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
    });
  };
}
