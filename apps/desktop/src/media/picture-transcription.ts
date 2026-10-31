// i18n: model-facing

/**
 * The app's half of the transcription generation (pictures.md §8.4 step 2): once the loop has approved a
 * `pictures.transcribe` plan, this runner sends the plan's exact batches to the loop's budgeted model calls —
 * one user message per request, the temperature-0 prompt text followed by the batch's images in order — and
 * reads the page-section wire replies back. It never dispatches a bus command and never writes anything: the
 * generated pages stay transient until the port's review gate publishes what the writer approved.
 *
 * A failed batch — a provider throw, a `cut` reply, or a malformed or incomplete parse — falls back to one
 * request per page (`fallbackAttemptsOf`), and a page that still fails on its own request refuses the whole
 * generation, so no partial draft is ever returned. The opt-in second read runs the same schedule on its own
 * pinned route (`secondModel`), never on the primary call, and only fills each page's `secondText`.
 *
 * Each selected file is read through `assets.readBytes` from `assets/<planPage.file>` and checked against the
 * current record (sniffed type, byte count, header size); a missing or damaged file refuses before any request
 * is sent. A page over {@link TRANSCRIPTION_MAX_EDGE} on its long edge is resized transiently when a resize port
 * is supplied — the stored bytes are never modified — and without a port the stored bytes are sent, after a
 * conservative route-byte precheck that refuses an oversized request with `limit-exceeded` instead of sending it.
 *
 * Image bytes travel only inside the one request that carries them: they never reach an error, a log or the
 * result. Each image part carries the real hash and size of the bytes sent, and the result holds texts only.
 *
 * `ProjectSession.transcribePictures` closes this over the session's `state`, `assets` and browser resize.
 */

import { err, ok, refusal, type CommandError, type Result } from '@caotang/bus';
import { IMAGE_MIMES, imageLimitsFor, type ChatMessage, type ContentPart, type ImagePart, type RouteImageLimits } from '@caotang/gateway';
import {
  ASSETS_DIR,
  readPictureHeader,
  sha256Hex,
  sniffPicture,
  type PictureBytes,
  type ReadAssetRecord,
} from '@caotang/pictures';
import type { ProjectState } from '@caotang/store';
import {
  buildTranscriptionPrompt,
  complete,
  fallbackAttemptsOf,
  parseTranscriptionReply,
  TRANSCRIPTION_TEMPERATURE,
  TurnStopped,
  type ModelCall,
  type PictureTranscriptionGeneration,
  type PictureTranscriptionGenerationPage,
  type PictureTranscriptionPlan,
  type TranscriptionRequestBatch,
} from '@caotang/harness';

import type { ProjectAssets } from '../app/project-assets.js';

/** pictures.md §8.1's long-edge cap: a page is sent at most this many pixels on its long side when the host can resize. */
export const TRANSCRIPTION_MAX_EDGE = 1568;

/**
 * The resize port the app supplies when its browser can decode pictures: `resizePictureInBrowser`. It returns a
 * transient copy; the stored bytes are never modified.
 */
export type PictureResizePort = (picture: PictureBytes, longEdge: number) => Promise<PictureBytes>;

/**
 * What {@link runPictureTranscription} needs: the approved plan, the loop's budgeted model calls, and read-only
 * access to the project. There is deliberately no dispatch surface — the runner only generates.
 */
export interface PictureTranscriptionRunInput {
  /** The plan the loop approved; its exact batches, vocabulary and language are used as staged. */
  readonly plan: PictureTranscriptionPlan;
  /** The primary route's budgeted call. */
  readonly model: ModelCall;
  /** The second read's own pinned call; required exactly when the plan names a `secondRead`. */
  readonly secondModel?: ModelCall;
  /** The project state, read for the current asset records. */
  readonly state: ProjectState;
  /** Reads one stored asset file (`assets/<file>`); `null` when no place holds it. Never written to. */
  readonly assets: Pick<ProjectAssets, 'readBytes'>;
  /** Transient resize to at most {@link TRANSCRIPTION_MAX_EDGE} on the long edge. Absent: stored bytes are sent as they are. */
  readonly resize?: PictureResizePort;
}

const kib = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

const DAMAGED_HINT = 'the file is damaged or was replaced outside the app: ask the writer to import the page again in the Pictures board, then stage the plan again';

/** The current record of one planned page, from the manifest the state holds now. */
const recordOf = (state: ProjectState, assetId: string): ReadAssetRecord | undefined =>
  (state.manifest.assets ?? []).find((candidate) => candidate.id === assetId);

/**
 * Reads one planned page's stored file and turns it into the image part its requests carry. Refuses missing or
 * damaged files (against the current record) and oversized bytes before anything is sent; resizes transiently
 * when a port is supplied and the page is over {@link TRANSCRIPTION_MAX_EDGE}.
 */
async function preparePage(
  page: PictureTranscriptionPlan['pages'][number],
  state: ProjectState,
  assets: Pick<ProjectAssets, 'readBytes'>,
  resize: PictureResizePort | undefined,
  limits: RouteImageLimits,
): Promise<Result<ImagePart, CommandError>> {
  const record = recordOf(state, page.assetId);
  if (record === undefined) {
    return err(
      refusal('not-found', `there is no picture "${page.assetId}" in the project any more, so its page was not sent`, {
        target: page.assetId,
        correctiveHint: 'the plan is stale: read the ids with pictures.list and stage pictures.transcribe again',
      }),
    );
  }
  const stored = await assets.readBytes(`${ASSETS_DIR}/${page.file}`);
  if (stored === null) {
    return err(
      refusal('not-found', `the file of ${page.assetId} (assets/${page.file}) is missing from the project’s assets, so its page was not sent`, {
        target: page.assetId,
        correctiveHint: 'ask the writer to relink or re-import the picture in the Pictures board, then stage the plan again',
      }),
    );
  }
  const sniffed = sniffPicture(stored);
  if (!sniffed.ok) {
    return err(
      refusal('io-error', `the bytes of ${page.assetId} in assets/${page.file} are not a readable PNG, JPEG or WebP picture (${sniffed.reason}), so its page was not sent`, {
        target: page.assetId,
        correctiveHint: DAMAGED_HINT,
      }),
    );
  }
  if (sniffed.mime !== record.mime) {
    return err(
      refusal('io-error', `the bytes of ${page.assetId} are ${sniffed.mime}, not the ${record.mime} its record says, so its page was not sent`, {
        target: page.assetId,
        correctiveHint: DAMAGED_HINT,
      }),
    );
  }
  if (stored.length !== record.bytes) {
    return err(
      refusal('io-error', `assets/${page.file} holds ${stored.length} bytes, but the record of ${page.assetId} says ${record.bytes}, so the file changed after it was recorded and its page was not sent`, {
        target: page.assetId,
        correctiveHint: DAMAGED_HINT,
      }),
    );
  }
  const header = readPictureHeader(stored, sniffed.mime);
  if (!header.ok) {
    return err(
      refusal('io-error', `the size of ${page.assetId} could not be read from its file, so its page was not sent`, {
        target: page.assetId,
        correctiveHint: DAMAGED_HINT,
      }),
    );
  }
  if (
    (record.width !== undefined && record.width !== header.displayWidth) ||
    (record.height !== undefined && record.height !== header.displayHeight)
  ) {
    return err(
      refusal(
        'io-error',
        `assets/${page.file} is ${header.displayWidth} × ${header.displayHeight} px, but the record of ${page.assetId} says ${record.width ?? '?'} × ${record.height ?? '?'} px, so the file was replaced and its page was not sent`,
        { target: page.assetId, correctiveHint: DAMAGED_HINT },
      ),
    );
  }

  let shown = { bytes: stored, mime: sniffed.mime, width: header.displayWidth, height: header.displayHeight };
  const edge = Math.max(header.displayWidth, header.displayHeight);
  if (resize !== undefined && edge > TRANSCRIPTION_MAX_EDGE) {
    let shrunk: PictureBytes;
    try {
      shrunk = await resize({ bytes: stored, mime: sniffed.mime, width: header.displayWidth, height: header.displayHeight }, TRANSCRIPTION_MAX_EDGE);
    } catch (failure) {
      return err(
        refusal('io-error', `the page ${page.assetId} could not be resized for sending: ${failure instanceof Error ? failure.message : String(failure)}`, {
          target: page.assetId,
          correctiveHint: 'generate again, or import a working copy of the page at or below 1568 px on its long side',
        }),
      );
    }
    if (Math.max(shrunk.width, shrunk.height) > TRANSCRIPTION_MAX_EDGE || !IMAGE_MIMES.includes(shrunk.mime)) {
      return err(
        refusal('io-error', `the resize of ${page.assetId} came back at ${shrunk.width} × ${shrunk.height} px, over the ${TRANSCRIPTION_MAX_EDGE} px a page may be sent at, so its page was not sent`, {
          target: page.assetId,
          correctiveHint: 'import a working copy of the page at or below 1568 px on its long side',
        }),
      );
    }
    const resniffed = sniffPicture(shrunk.bytes);
    if (!resniffed.ok || resniffed.mime !== shrunk.mime) {
      return err(
        refusal('io-error', `the resize of ${page.assetId} returned bytes that are not a readable ${shrunk.mime} picture, so its page was not sent`, {
          target: page.assetId,
          correctiveHint: DAMAGED_HINT,
        }),
      );
    }
    shown = { bytes: shrunk.bytes, mime: shrunk.mime, width: shrunk.width, height: shrunk.height };
  }

  if (shown.bytes.length > limits.maxImageBytes) {
    return err(
      refusal(
        'limit-exceeded',
        `${page.assetId} is ${kib(shown.bytes.length)} (${shown.bytes.length} bytes) as it would be sent, over the ${kib(limits.maxImageBytes)} one picture may carry on this route, so nothing was sent`,
        {
          target: page.assetId,
          correctiveHint:
            resize === undefined
              ? 'open the project in the Caotang app, which resizes pages before sending, or import a copy within the limit'
              : 'import a smaller copy of the page',
        },
      ),
    );
  }

  return ok({ type: 'image', mime: shown.mime, bytes: shown.bytes, hash: await sha256Hex(shown.bytes), size: shown.bytes.length, caption: page.assetId });
}

/** One request's outcome: the parsed page sections, or why the request counts as failed. */
type Attempt =
  | { readonly ok: true; readonly pages: readonly { readonly assetId: string; readonly text: string }[] }
  | { readonly ok: false; readonly why: string };

/**
 * One request of the schedule: a single user message with the prompt text and the batch's images in order, at
 * temperature 0 through the loop's budgeted `complete`. A provider throw, a `cut` reply or a malformed or
 * incomplete parse is a failed attempt; the writer's Stop (`TurnStopped`) propagates instead.
 */
async function attemptBatch(
  call: ModelCall,
  plan: PictureTranscriptionPlan,
  batch: TranscriptionRequestBatch,
  prepared: ReadonlyMap<string, ImagePart>,
): Promise<Attempt> {
  const parts: ImagePart[] = [];
  for (const assetId of batch.pages) {
    const part = prepared.get(assetId);
    if (part === undefined) return { ok: false, why: `the page ${assetId} was not prepared for sending` };
    parts.push(part);
  }
  const prompt = buildTranscriptionPrompt({ pages: batch.pages, language: plan.language, vocabulary: plan.vocabulary });
  const content: readonly ContentPart[] = [{ type: 'text', text: prompt }, ...parts];
  const messages: readonly ChatMessage[] = [{ role: 'user', content }];
  let reply: Awaited<ReturnType<typeof complete>>;
  try {
    reply = await complete(call, messages, undefined, { temperature: TRANSCRIPTION_TEMPERATURE });
  } catch (error) {
    if (error instanceof TurnStopped) throw error;
    return { ok: false, why: `the provider call failed (${error instanceof Error ? error.message : String(error)})` };
  }
  if (reply.cut) return { ok: false, why: 'the reply was cut off at the model’s output limit' };
  const parsed = parseTranscriptionReply(reply.text, batch.pages);
  if (!parsed.ok) {
    const problem = parsed.error;
    const detail = problem.kind === 'malformed' ? `malformed framing: ${problem.detail}` : `${problem.kind} ${problem.assetId}`;
    return { ok: false, why: `the reply was not a complete wire answer (${detail})` };
  }
  return { ok: true, pages: parsed.pages };
}

/**
 * One route's whole schedule: each planned batch in order, with a failed batch retried page by page through
 * `fallbackAttemptsOf`. A page that still fails on its own request refuses the whole run — no partial draft —
 * naming the page and the remedy.
 */
async function runSchedule(
  call: ModelCall,
  plan: PictureTranscriptionPlan,
  prepared: ReadonlyMap<string, ImagePart>,
): Promise<Result<ReadonlyMap<string, string>, CommandError>> {
  const texts = new Map<string, string>();
  for (const batch of plan.batches) {
    const attempted = await attemptBatch(call, plan, batch, prepared);
    if (attempted.ok) {
      for (const page of attempted.pages) texts.set(page.assetId, page.text);
      continue;
    }
    for (const single of fallbackAttemptsOf(batch)) {
      const pageId = single.pages[0] ?? '';
      const one = await attemptBatch(call, plan, single, prepared);
      if (!one.ok) {
        return err(
          refusal(
            'internal',
            `the page ${pageId} could not be transcribed even on its own request (${one.why}), so the whole generation was refused and nothing was written`,
            {
              target: pageId,
              correctiveHint: 'run pictures.transcribe again with the same pages — if the provider keeps failing, check the route in Settings › Providers',
            },
          ),
        );
      }
      for (const page of one.pages) texts.set(page.assetId, page.text);
    }
  }
  return ok(texts);
}

/**
 * Generates the transcription draft for an approved plan. Reads and checks every planned file first (and
 * prechecks the conservative route byte limits), so a missing, damaged or oversized page refuses before any
 * request is sent. Returns the pages in the plan's order with their exact parsed texts — the first read, and the
 * second read's `secondText` when the plan names one — or a refusal; it never dispatches a command and never
 * writes. Cancellation (`TurnStopped`) propagates as a rejection, never as a partial success.
 */
export async function runPictureTranscription(input: PictureTranscriptionRunInput): Promise<Result<PictureTranscriptionGeneration, CommandError>> {
  const { plan, model, secondModel, state, assets, resize } = input;
  if (plan.kind !== 'pictures.transcribe') {
    return err(
      refusal('invalid-params', `the plan is a "${plan.kind}" plan, not a pictures.transcribe plan, so no page was sent`, {
        target: 'plan',
        correctiveHint: 'stage the plan with pictures.transcribe and generate from the approved plan',
      }),
    );
  }
  if (plan.pages.length === 0 || plan.batches.length === 0) {
    return err(
      refusal('invalid-params', 'the plan holds no pages, so there is nothing to transcribe', {
        target: 'assetIds',
        correctiveHint: 'select at least one handwritten page',
      }),
    );
  }
  const secondRead = plan.secondRead;
  const secondCall = secondRead === undefined ? undefined : secondModel;
  if (secondRead !== undefined && secondCall === undefined) {
    return err(
      refusal('invalid-params', 'the plan names a second read, but no second model call was supplied, so no page was sent on either route', {
        target: 'secondRead',
        correctiveHint: 'pin the second read’s route and generate again, or remove secondRead from the plan',
      }),
    );
  }

  // The conservative route-agnostic row: the most restrictive image caps a route can carry (gateway parts.ts).
  const limits: RouteImageLimits = imageLimitsFor(undefined);

  const prepared = new Map<string, ImagePart>();
  for (const page of plan.pages) {
    const ready = await preparePage(page, state, assets, resize, limits);
    if (!ready.ok) return err(ready.error);
    prepared.set(page.assetId, ready.value);
  }

  // Precheck every planned request's size before anything is sent: an oversized request is refused, not sent.
  for (const batch of plan.batches) {
    if (batch.pages.length > limits.maxImages) {
      return err(
        refusal('limit-exceeded', `a request of ${batch.pages.length} pages is over the ${limits.maxImages} images one request may carry, so nothing was sent`, {
          target: 'assetIds',
          correctiveHint: 'transcribe fewer pages at once',
        }),
      );
    }
    let total = 0;
    for (const assetId of batch.pages) total += prepared.get(assetId)?.size ?? 0;
    if (total > limits.maxTotalBytes) {
      return err(
        refusal(
          'limit-exceeded',
          `one request of ${batch.pages.length} pages would carry ${kib(total)} (${total} bytes) of images, over the ${kib(limits.maxTotalBytes)} one message may carry on this route, so nothing was sent`,
          {
            target: 'assetIds',
            correctiveHint: 'transcribe fewer pages at once, or open the project in the app so the pages are resized before sending',
          },
        ),
      );
    }
  }

  const first = await runSchedule(model, plan, prepared);
  if (!first.ok) return err(first.error);

  let second: ReadonlyMap<string, string> | undefined;
  if (secondCall !== undefined) {
    const ran = await runSchedule(secondCall, plan, prepared);
    if (!ran.ok) return err(ran.error);
    second = ran.value;
  }

  const pages: PictureTranscriptionGenerationPage[] = [];
  for (const page of plan.pages) {
    const text = first.value.get(page.assetId);
    if (text === undefined) {
      return err(
        refusal('internal', `the page ${page.assetId} came back from the schedule with no text, so the whole generation was refused`, {
          target: page.assetId,
          correctiveHint: 'run pictures.transcribe again',
        }),
      );
    }
    const secondText = second?.get(page.assetId);
    pages.push({ assetId: page.assetId, text, ...(secondText === undefined ? {} : { secondText }) });
  }

  const label = (model.model ?? '').trim();
  return ok({ pages, model: label === '' ? 'default' : label });
}
