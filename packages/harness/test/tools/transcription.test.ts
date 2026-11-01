/**
 * `pictures.transcribe`'s harness side (pictures.md §8.4, #146): the params, the staged plan and its guards,
 * and the async port that runs the review gate and dispatches one `asset.transcribe`. The tests drive the port
 * with a direct fake `PortContext` and host, so no registry wiring of `asset.transcribe` is needed here.
 */

import { err, ok, type CommandError, type CommandName, type ExecutionOutcome, type Result } from '@caotang/bus';
import { tokensForChars } from '@caotang/codex';
import type { ReadAssetRecord } from '@caotang/pictures';
import { createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import type { ParamSpec } from '../../src/schema.js';
import type { CallParams, PortContext } from '../../src/types.js';
import {
  TRANSCRIPTION_LARGE_BATCH_PAGES,
  TRANSCRIPTION_OUTPUT_TOKENS_PER_PAGE,
  TRANSCRIPTION_SECOND_READ_MODEL_MAX,
  TRANSCRIPTION_SECOND_READ_PROFILE_MAX,
  reviewPagesOf,
  stageTranscriptionPlan,
  transcriptionParams,
  transcriptionPort,
  transcriptionPreview,
  type PictureTranscriptionGeneration,
  type PictureTranscriptionHost,
  type PictureTranscriptionProposal,
  type PictureTranscriptionReviewResult,
  type PictureTranscriptionReviewedPage,
} from '../../src/tools/transcription.js';
import { buildTranscriptionPrompt } from '../../src/tools/transcription-model.js';

const OPENED = new Date('2026-10-08T09:00:00.000Z');

const valueOf = <T>(result: Result<T, CommandError>): T => {
  if (!result.ok) throw new Error(`expected success, got refusal: ${result.error.code}: ${result.error.message}`);
  return result.value;
};

const refusalOf = <T>(result: Result<T, CommandError>): CommandError => {
  if (result.ok) throw new Error('expected a refusal, got success');
  return result.error;
};

const idAt = (ids: readonly string[], index: number): string => {
  const value = ids[index];
  if (value === undefined) throw new Error(`no id at ${index}`);
  return value;
};

let seq = 0;

function makeState(): ProjectState {
  return createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
}

/** Adds one PNG record (`a_` + ten digits) and returns its id. */
function addPicture(state: ProjectState, over: Record<string, unknown> = {}): string {
  seq += 1;
  const id = `a_${String(seq).padStart(10, '0')}`;
  const record = {
    id,
    file: `${id}.png`,
    mime: 'image/png',
    sha256: '0'.repeat(64),
    bytes: 500_000,
    width: 1000,
    height: 2000,
    caption: `page ${id}`,
    createdAt: OPENED.toISOString(),
    ...over,
  } as unknown as ReadAssetRecord;
  state.manifest.assets = [...(state.manifest.assets ?? []), record];
  return id;
}

function addCodex(state: ProjectState): void {
  state.manifest.codex = [
    { id: 'c_ELENA00001', name: 'Elena', aliases: ['Ellie'], type: 'character', description: 'The keeper.', includePolicy: 'detected', caseSensitive: false, exclude: [], attachments: [], keywords: [], origin: 'manual', sources: [] },
    { id: 'c_KSTREL0001', name: 'Kestrel', aliases: [], type: 'other', description: 'The bird.', includePolicy: 'detected', caseSensitive: false, exclude: [], attachments: [], keywords: [], origin: 'manual', sources: [] },
  ];
}

function scenario(pictureCount: number): { state: ProjectState; ids: string[] } {
  const state = makeState();
  // Pin the project language so warning assertions do not depend on the machine's locale.
  state.manifest.project.language = 'en';
  const ids: string[] = [];
  for (let index = 0; index < pictureCount; index++) ids.push(addPicture(state));
  return { state, ids };
}

type ReviewAnswer = PictureTranscriptionReviewResult | null;

/** A host fake: `vision` is fixed, `review` records its call and answers with the given answer. */
function fakeHost(answer: ReviewAnswer, vision = true): { host: PictureTranscriptionHost; calls: PictureTranscriptionProposal[] } {
  const calls: PictureTranscriptionProposal[] = [];
  const host: PictureTranscriptionHost = {
    vision: () => vision,
    review: (draft) => {
      calls.push(draft);
      return Promise.resolve(answer);
    },
  };
  return { host, calls };
}

interface FakeContext {
  readonly context: PortContext;
  readonly dispatched: { name: string; params: CallParams }[];
  readonly inherited: { name: string; params: CallParams }[];
  readonly effectCount: () => number;
}

/** A direct fake `PortContext`: dispatch records what the port sent and answers with a canned outcome. */
function fakeContext(state: ProjectState, proposal?: unknown, options: { resultOf?: (params: CallParams) => unknown; failDispatch?: CommandError } = {}): FakeContext {
  const dispatched: { name: string; params: CallParams }[] = [];
  const inherited: { name: string; params: CallParams }[] = [];
  let effects = 0;
  const makeOutcome = (name: CommandName, params: CallParams): ExecutionOutcome => ({
    commandId: 'cmd_test',
    name,
    params,
    result: options.resultOf?.(params) ?? {
      into: params['into'],
      assetIds: (params['pages'] as readonly { assetId: string }[]).map((page) => page.assetId),
      docId: 'n_TRANSCR001',
      linkIds: ['l_TRANSCR001'],
    },
    grant: { risk: 'write-confirm', via: 'confirm-card', requiresUserConfirm: true },
    affected: [{ nodeId: 'n_TRANSCR001', title: 'Transcription' }],
    undoGroupId: 'ug_test',
    postconditions: [],
  });
  const context: PortContext = {
    state,
    turnId: 'turn-transcription',
    dispatch: (name, params) => {
      dispatched.push({ name, params });
      if (options.failDispatch !== undefined) return err(options.failDispatch);
      return ok(makeOutcome(name, params));
    },
    dispatchInherited: (name, params) => {
      inherited.push({ name, params });
      return err({ code: 'internal', message: 'not used in this test' });
    },
    dispatchAsync: async (name, params) => {
      dispatched.push({ name, params });
      if (options.failDispatch !== undefined) return err(options.failDispatch);
      return ok(makeOutcome(name, params));
    },
    proposal,
    recordEffect: () => {
      effects += 1;
    },
    logRow: () => {},
  };
  return { context, dispatched, inherited, effectCount: () => effects };
}

const paramsOf = (ids: readonly string[], over: Record<string, unknown> = {}): CallParams => ({ assetIds: [...ids], ...over });

describe('transcriptionParams', () => {
  it('declares the §8.4 surface: assetIds 1..100 unique, into defaulting to new-document, language, secondRead', () => {
    expect(transcriptionParams.kind).toBe('object');
    expect(transcriptionParams.required).toEqual(['assetIds']);
    expect(Object.keys(transcriptionParams.properties).sort()).toEqual(['assetIds', 'into', 'language', 'secondRead']);
    expect(transcriptionParams.properties['assetIds']).toMatchObject({ kind: 'array', minItems: 1, maxItems: 100, unique: true });
    expect(transcriptionParams.properties['into']).toMatchObject({ kind: 'enum', values: ['new-document', 'searchable'], default: 'new-document' });
    expect(transcriptionParams.properties['language']?.kind).toBe('string');
    // secondRead is a closed object naming the other vision route, not a boolean.
    const secondRead = transcriptionParams.properties['secondRead'] as Extract<ParamSpec, { kind: 'object' }> | undefined;
    expect(secondRead?.kind).toBe('object');
    expect(secondRead?.required).toEqual(['profileId']);
    expect(Object.keys(secondRead?.properties ?? {}).sort()).toEqual(['model', 'profileId']);
    expect((secondRead?.properties ?? {})['profileId']).toMatchObject({ kind: 'string', nonBlank: true, maxLength: TRANSCRIPTION_SECOND_READ_PROFILE_MAX });
    expect((secondRead?.properties ?? {})['model']).toMatchObject({ kind: 'string', nonBlank: true, maxLength: TRANSCRIPTION_SECOND_READ_MODEL_MAX });
  });
});

describe('stageTranscriptionPlan', () => {
  it('builds the plan in the selected order, with record fields, the language hint and the codex vocabulary', () => {
    const state = makeState();
    state.manifest.project.language = 'de';
    addCodex(state);
    const p1 = addPicture(state);
    const p2 = addPicture(state, { transcription: { text: 'old text', model: 'm-0', at: '2026-01-01T00:00:00.000Z' } });
    const p3 = addPicture(state, { caption: undefined, width: undefined, height: undefined });
    const plan = valueOf(stageTranscriptionPlan({ assetIds: [p3, p2, p1] }, state, fakeHost(null).host));

    expect(plan.kind).toBe('pictures.transcribe');
    expect(plan.into).toBe('new-document');
    expect(plan.language).toBe('de');
    expect(plan.secondRead).toBeUndefined();
    expect(plan.vocabulary).toEqual(['Elena', 'Ellie', 'Kestrel']);
    expect(plan.pages.map((page) => page.assetId)).toEqual([p3, p2, p1]);
    expect(plan.pages[0]).toMatchObject({ assetId: p3, file: `${p3}.png`, bytes: 500_000, expect: null });
    expect(plan.pages[0]?.caption).toBeUndefined();
    expect(plan.pages[0]?.width).toBeUndefined();
    expect(plan.pages[1]?.expect).toEqual({ text: 'old text', model: 'm-0', at: '2026-01-01T00:00:00.000Z' });
    expect(plan.pages[2]).toMatchObject({ assetId: p1, width: 1000, height: 2000, caption: `page ${p1}` });
    // The project language is de, so the plan warns non-english.
    expect(plan.warnings).toEqual(['non-english']);
  });

  it('takes the language override, else the project language, else en', () => {
    const state = makeState();
    const id = addPicture(state);
    const host = fakeHost(null).host;
    expect(valueOf(stageTranscriptionPlan({ assetIds: [id], language: 'fr' }, state, host)).language).toBe('fr');
    // A project that predates the language slot (or holds a blank one) falls back to en.
    state.manifest.project.language = undefined;
    expect(valueOf(stageTranscriptionPlan({ assetIds: [id] }, state, host)).language).toBe('en');
    state.manifest.project.language = 'cy';
    expect(valueOf(stageTranscriptionPlan({ assetIds: [id] }, state, host)).language).toBe('cy');
  });

  it('warns non-english when the effective language hint is not English (conservative en/en-* check only)', () => {
    const state = makeState();
    const id = addPicture(state);
    const host = fakeHost(null).host;
    const warningsOf = (language: string | undefined, project: string | undefined): readonly string[] => {
      state.manifest.project.language = project;
      const params: CallParams = language === undefined ? { assetIds: [id] } : { assetIds: [id], language };
      return valueOf(stageTranscriptionPlan(params, state, host)).warnings;
    };
    expect(warningsOf('en', 'de')).toEqual([]);
    expect(warningsOf('EN', undefined)).toEqual([]);
    expect(warningsOf('en-GB', undefined)).toEqual([]);
    expect(warningsOf('en_US', undefined)).toEqual([]); // underscore read as hyphen
    expect(warningsOf('fr', 'en')).toContain('non-english');
    expect(warningsOf('de', 'en')).toContain('non-english');
    expect(warningsOf('eng', 'en')).toContain('non-english'); // not en-…: conservative
    expect(warningsOf(undefined, 'cy')).toContain('non-english');
    expect(warningsOf(undefined, undefined)).toEqual([]); // absent language falls back to en
  });

  it('plans 13 pages as 6 + 6 + 1 and estimates the calls from the exact prompt text and the image rule', () => {
    const { state, ids } = scenario(13);
    const plan = valueOf(stageTranscriptionPlan({ assetIds: ids }, state, fakeHost(null).host));
    expect(plan.batches.map((batch) => batch.pages.length)).toEqual([6, 6, 1]);
    expect(plan.batches.flatMap((batch) => batch.pages)).toEqual(ids);
    expect(plan.estimate.requests).toBe(3);
    expect(plan.estimate.maxRequests).toBe(13);
    expect(plan.estimate.outputTokens).toBe(13 * TRANSCRIPTION_OUTPUT_TOKENS_PER_PAGE);

    // The prompt tokens are the exact buildTranscriptionPrompt text per batch plus the conservative image rule
    // (known 1000x2000 px: the larger of the pixel rule and the tile rule).
    const imageTokens = Math.max(Math.ceil((1000 * 2000) / 750), 85 + 170 * Math.ceil(1000 / 512) * Math.ceil(2000 / 512));
    let expected = 0;
    for (const batch of plan.batches) {
      expected += tokensForChars(buildTranscriptionPrompt({ pages: batch.pages, language: 'en', vocabulary: [] }).length);
      expected += batch.pages.length * imageTokens;
    }
    expect(plan.estimate.promptTokens).toBe(expected);
  });

  it('doubles the estimate when a second-read route is selected, and uses the byte rule when the dimensions are unknown', () => {
    const { state, ids } = scenario(13);
    const twice = valueOf(stageTranscriptionPlan({ assetIds: ids, secondRead: { profileId: 'p_second' } }, state, fakeHost(null).host));
    const once = valueOf(stageTranscriptionPlan({ assetIds: ids }, state, fakeHost(null).host));
    expect(twice.secondRead).toEqual({ profileId: 'p_second' });
    expect(once.secondRead).toBeUndefined();
    expect(twice.estimate.requests).toBe(6);
    expect(twice.estimate.maxRequests).toBe(26);
    expect(twice.estimate.outputTokens).toBe(26 * TRANSCRIPTION_OUTPUT_TOKENS_PER_PAGE);
    expect(twice.estimate.promptTokens).toBe(2 * once.estimate.promptTokens);

    const withModel = valueOf(stageTranscriptionPlan({ assetIds: ids, secondRead: { profileId: 'p_second', model: 'vision-b' } }, state, fakeHost(null).host));
    expect(withModel.secondRead).toEqual({ profileId: 'p_second', model: 'vision-b' });
    expect(withModel.estimate.requests).toBe(6);

    const bare = addPicture(state, { width: undefined, height: undefined, bytes: 500_000 });
    const single = valueOf(stageTranscriptionPlan({ assetIds: [bare] }, state, fakeHost(null).host));
    const prompt = buildTranscriptionPrompt({ pages: [bare], language: 'en', vocabulary: [] });
    expect(single.estimate.promptTokens).toBe(tokensForChars(prompt.length) + Math.ceil(500_000 / 64));
  });

  it('warns on a large batch, a re-transcription into a document, and searchable over existing text', () => {
    const { state, ids } = scenario(TRANSCRIPTION_LARGE_BATCH_PAGES + 1);
    const host = fakeHost(null).host;
    expect(valueOf(stageTranscriptionPlan({ assetIds: ids }, state, host)).warnings).toEqual(['large-batch']);
    expect(valueOf(stageTranscriptionPlan({ assetIds: ids.slice(0, 20) }, state, host)).warnings).toEqual([]);

    const doc = addPicture(state, { transcription: { docId: 'n_OLD00001', at: 't' } });
    expect(valueOf(stageTranscriptionPlan({ assetIds: [doc] }, state, host)).warnings).toEqual(['new-document']);

    const txt = addPicture(state, { transcription: { text: 'old', at: 't' } });
    expect(valueOf(stageTranscriptionPlan({ assetIds: [txt], into: 'searchable' }, state, host)).warnings).toEqual(['searchable']);
    const fresh = addPicture(state);
    expect(valueOf(stageTranscriptionPlan({ assetIds: [fresh], into: 'searchable' }, state, host)).warnings).toEqual([]);
  });

  it('refuses malformed, duplicate, unknown and absent ids, over-limit batches and bad option values', () => {
    const state = makeState();
    const id = addPicture(state);
    const host = fakeHost(null).host;

    expect(refusalOf(stageTranscriptionPlan({ assetIds: [] }, state, host)).code).toBe('invalid-params');
    const dup = refusalOf(stageTranscriptionPlan({ assetIds: [id, id] }, state, host));
    expect(dup.code).toBe('invalid-params');
    expect(dup.message).toContain('more than once');
    const malformed = refusalOf(stageTranscriptionPlan({ assetIds: ['nope'] }, state, host));
    expect(malformed.code).toBe('invalid-params');
    expect(malformed.target).toBe('assetIds[0]');
    const unknown = refusalOf(stageTranscriptionPlan({ assetIds: ['a_ZZZZZZZZZZ'] }, state, host));
    expect(unknown.code).toBe('not-found');
    expect(unknown.message).toContain('no picture "a_ZZZZZZZZZZ"');
    const many = Array.from({ length: 101 }, (_, index) => `a_${String(index).padStart(10, '0')}`);
    expect(refusalOf(stageTranscriptionPlan({ assetIds: many }, state, host)).code).toBe('limit-exceeded');
    expect(refusalOf(stageTranscriptionPlan({ assetIds: [id], into: 'nowhere' }, state, host)).code).toBe('invalid-params');
    expect(refusalOf(stageTranscriptionPlan({ assetIds: [id], language: '   ' }, state, host)).code).toBe('invalid-params');
    // secondRead is a closed { profileId, model? } object: shape, closed keys and both length caps.
    expect(refusalOf(stageTranscriptionPlan({ assetIds: [id], secondRead: 'yes' }, state, host)).code).toBe('invalid-params');
    expect(refusalOf(stageTranscriptionPlan({ assetIds: [id], secondRead: {} }, state, host)).code).toBe('invalid-params');
    expect(refusalOf(stageTranscriptionPlan({ assetIds: [id], secondRead: { profileId: '   ' } }, state, host)).code).toBe('invalid-params');
    const secondReadExtra = refusalOf(stageTranscriptionPlan({ assetIds: [id], secondRead: { profileId: 'p', extra: 1 } }, state, host));
    expect(secondReadExtra.code).toBe('invalid-params');
    expect(secondReadExtra.message).toContain('"extra"');
    expect(refusalOf(stageTranscriptionPlan({ assetIds: [id], secondRead: { profileId: 'x'.repeat(TRANSCRIPTION_SECOND_READ_PROFILE_MAX + 1) } }, state, host)).code).toBe('limit-exceeded');
    expect(refusalOf(stageTranscriptionPlan({ assetIds: [id], secondRead: { profileId: 'p', model: 'm'.repeat(TRANSCRIPTION_SECOND_READ_MODEL_MAX + 1) } }, state, host)).code).toBe('limit-exceeded');
    expect(refusalOf(stageTranscriptionPlan({ assetIds: [id], secondRead: { profileId: 'p', model: '' } }, state, host)).code).toBe('invalid-params');
    const extra = refusalOf(stageTranscriptionPlan({ assetIds: [id], extra: 1 }, state, host));
    expect(extra.code).toBe('invalid-params');
    expect(extra.message).toContain('"extra"');
  });

  it('refuses up front when the active model has no vision, naming the setting', () => {
    const state = makeState();
    const id = addPicture(state);
    const { host, calls } = fakeHost(null, false);
    const error = refusalOf(stageTranscriptionPlan({ assetIds: [id] }, state, host));
    expect(error.code).toBe('invalid-params');
    expect(error.message).toContain('does not accept images');
    expect(error.correctiveHint).toContain('vision');
    expect(calls).toEqual([]);
  });

  it('freezes the staged expect against later record mutation, in both directions', () => {
    const state = makeState();
    const id = addPicture(state, { transcription: { text: 'first read', at: 't0' } });
    const plan = valueOf(stageTranscriptionPlan({ assetIds: [id] }, state, fakeHost(null).host));
    expect(plan.pages[0]?.expect).toEqual({ text: 'first read', at: 't0' });

    const record = (state.manifest.assets ?? []).find((candidate) => candidate.id === id);
    if (record === undefined) throw new Error('record missing');
    record.transcription = { text: 'changed later', at: 't1' };
    expect(plan.pages[0]?.expect).toEqual({ text: 'first read', at: 't0' });

    const frozen = plan.pages[0]?.expect;
    if (frozen === null || frozen === undefined) throw new Error('expect missing');
    frozen.text = 'hacked';
    expect(record.transcription?.text).toBe('changed later');
  });
});

describe('transcriptionPort', () => {
  it('dispatches exactly one asset.transcribe with the reviewed subset, the edited text, the plan expect and the draft model', async () => {
    const { state, ids } = scenario(3);
    const p1 = idAt(ids, 0);
    const p3 = idAt(ids, 2);
    const secondRead = { profileId: 'p_second', model: 'vision-b' };
    const plan = valueOf(stageTranscriptionPlan({ assetIds: ids, secondRead }, state, fakeHost(null).host));
    const draft: PictureTranscriptionGeneration = {
      pages: ids.map((assetId, index) => ({ assetId, text: `read ${index + 1}`, expect: { text: 'forged in draft', at: 'x' } } as unknown as PictureTranscriptionGeneration['pages'][number])),
      model: 'vision-1',
    };
    const proposal: PictureTranscriptionProposal = { plan, draft };
    // The review tries to smuggle its own expect in; the port must not read it.
    const forgedReview = {
      pages: [
        { assetId: p1, text: 'read 1 edited', expect: { text: 'forged in review', at: 'x' } } as unknown as PictureTranscriptionReviewedPage,
        { assetId: p3, text: 'read 3' },
      ],
      title: 'My pages',
    } as unknown as PictureTranscriptionReviewResult;
    const { host, calls } = fakeHost(forgedReview);
    const { context, dispatched, inherited, effectCount } = fakeContext(state, proposal);

    const result = await transcriptionPort(host)(paramsOf(ids, { secondRead }), context);
    if (!result.ok) throw new Error(result.error.message);

    expect(calls).toHaveLength(1);
    // The review got the staged plan and the validated draft — the forged expect keys are not read through.
    expect(calls[0]?.plan).toEqual(proposal.plan);
    expect(calls[0]?.draft.pages.map((page) => page.assetId)).toEqual(ids);
    expect(calls[0]?.draft.model).toBe('vision-1');
    expect(JSON.stringify(calls[0]?.draft)).not.toContain('forged');
    expect(dispatched).toHaveLength(1);
    expect(inherited).toHaveLength(0);
    expect(effectCount()).toBe(0);

    const command = dispatched[0];
    expect(command?.name).toBe('asset.transcribe');
    expect(command?.params['into']).toBe('new-document');
    expect(command?.params['title']).toBe('My pages');
    expect(command?.params['pages']).toEqual([
      { assetId: p1, text: 'read 1 edited', model: 'vision-1', expect: plan.pages[0]?.expect },
      { assetId: p3, text: 'read 3', model: 'vision-1', expect: plan.pages[2]?.expect },
    ]);

    expect(result.value.data).toMatchObject({ into: 'new-document', pages: 2, assetIds: [p1, p3], docId: 'n_TRANSCR001', model: 'vision-1', secondRead });
    expect(result.value.summary).toContain('published 2 reviewed pages');
    expect(result.value.affected).toEqual([{ nodeId: 'n_TRANSCR001', title: 'Transcription' }]);
    expect(result.value.undoGroupId).toBe('ug_test');
  });

  it('publishes into searchable without a title and without a docId', async () => {
    const { state, ids } = scenario(2);
    const p1 = idAt(ids, 0);
    const plan = valueOf(stageTranscriptionPlan({ assetIds: ids, into: 'searchable' }, state, fakeHost(null).host));
    const proposal: PictureTranscriptionProposal = { plan, draft: { pages: ids.map((assetId, index) => ({ assetId, text: `t${index}` })) } };
    const { host } = fakeHost({ pages: [{ assetId: p1, text: 't0 final' }] });
    const { context, dispatched } = fakeContext(state, proposal, {
      resultOf: (params) => ({ into: params['into'], assetIds: (params['pages'] as readonly { assetId: string }[]).map((page) => page.assetId) }),
    });

    const result = await transcriptionPort(host)({ assetIds: ids, into: 'searchable' }, context);
    if (!result.ok) throw new Error(result.error.message);

    const command = dispatched[0];
    expect(command?.name).toBe('asset.transcribe');
    expect(command?.params).toEqual({
      into: 'searchable',
      pages: [{ assetId: p1, text: 't0 final', expect: plan.pages[0]?.expect }],
    });
    expect(result.value.data).toMatchObject({ into: 'searchable', pages: 1, assetIds: [p1] });
    expect(result.value.data['docId']).toBeUndefined();
    expect(result.value.summary).toContain('searchable');
  });

  it('treats a cancelled review as a refusal with nothing dispatched', async () => {
    const { state, ids } = scenario(2);
    const plan = valueOf(stageTranscriptionPlan({ assetIds: ids }, state, fakeHost(null).host));
    const proposal: PictureTranscriptionProposal = { plan, draft: { pages: ids.map((assetId) => ({ assetId, text: 't' })) } };
    const { host, calls } = fakeHost(null);
    const { context, dispatched, effectCount } = fakeContext(state, proposal);

    const result = await transcriptionPort(host)(paramsOf(ids), context);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('permission-denied');
    expect(result.error.message).toContain('cancelled');
    expect(calls).toHaveLength(1);
    expect(dispatched).toEqual([]);
    expect(effectCount()).toBe(0);
  });

  it('refuses malformed reviews — unknown, duplicate, out-of-order or blank pages, or none at all — and writes nothing', async () => {
    const { state, ids } = scenario(3);
    const p1 = idAt(ids, 0);
    const p2 = idAt(ids, 1);
    const p3 = idAt(ids, 2);
    const plan = valueOf(stageTranscriptionPlan({ assetIds: ids }, state, fakeHost(null).host));
    const draft: PictureTranscriptionGeneration = { pages: ids.map((assetId) => ({ assetId, text: 't' })) };

    const bad: readonly [string, unknown][] = [
      ['an unknown id', { pages: [{ assetId: 'a_ZZZZZZZZZZ', text: 'x' }] }],
      ['a duplicate id', { pages: [{ assetId: p1, text: 'a' }, { assetId: p1, text: 'b' }] }],
      ['out-of-order ids', { pages: [{ assetId: p3, text: 'a' }, { assetId: p1, text: 'b' }] }],
      ['a blank text', { pages: [{ assetId: p2, text: '   ' }] }],
      ['no pages at all', { pages: [] }],
      ['a non-page entry', { pages: ['nope'] }],
    ];
    for (const [name, answer] of bad) {
      const { host, calls } = fakeHost(answer as PictureTranscriptionReviewResult);
      const { context, dispatched, effectCount } = fakeContext(state, { plan, draft });
      const result = await transcriptionPort(host)(paramsOf(ids), context);
      if (result.ok) throw new Error(`expected a refusal for ${name}`);
      expect(result.error.code, name).toBe('invalid-params');
      expect(calls, name).toHaveLength(1);
      expect(dispatched, name).toEqual([]);
      expect(effectCount(), name).toBe(0);
    }
  });

  it('refuses a title on a searchable transcription before dispatching', async () => {
    const { state, ids } = scenario(1);
    const p1 = idAt(ids, 0);
    const plan = valueOf(stageTranscriptionPlan({ assetIds: ids, into: 'searchable' }, state, fakeHost(null).host));
    const proposal: PictureTranscriptionProposal = { plan, draft: { pages: [{ assetId: p1, text: 't' }] } };
    const { host } = fakeHost({ pages: [{ assetId: p1, text: 'x' }], title: 'T' });
    const { context, dispatched } = fakeContext(state, proposal);
    const result = await transcriptionPort(host)({ assetIds: ids, into: 'searchable' }, context);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('invalid-params');
    expect(result.error.message).toContain('title');
    expect(dispatched).toEqual([]);
  });

  it('requires a well-formed staged proposal and never reads one from the model’s params', async () => {
    const { state, ids } = scenario(2);
    const p1 = idAt(ids, 0);
    const plan = valueOf(stageTranscriptionPlan({ assetIds: ids }, state, fakeHost(null).host));
    const draft: PictureTranscriptionGeneration = { pages: ids.map((assetId) => ({ assetId, text: 't' })) };
    const answer: PictureTranscriptionReviewResult = { pages: [{ assetId: p1, text: 'x' }] };

    // No proposal staged at all.
    const none = fakeContext(state, undefined);
    let result = await transcriptionPort(fakeHost(answer).host)(paramsOf(ids), none.context);
    expect(refusalOf(result).code).toBe('invalid-params');
    expect(none.dispatched).toEqual([]);

    // Proposal without a draft, and a draft that does not cover the plan.
    const noDraft = fakeContext(state, { plan });
    result = await transcriptionPort(fakeHost(answer).host)(paramsOf(ids), noDraft.context);
    expect(refusalOf(result).code).toBe('invalid-params');
    expect(noDraft.dispatched).toEqual([]);

    const shortDraft = fakeContext(state, { plan, draft: { pages: [{ assetId: p1, text: 't' }] } });
    result = await transcriptionPort(fakeHost(answer).host)(paramsOf(ids), shortDraft.context);
    expect(refusalOf(result).code).toBe('invalid-params');
    expect(shortDraft.dispatched).toEqual([]);

    // A staged plan whose pages do not match this call’s params.
    const reordered = fakeContext(state, { plan: { ...plan, pages: [...plan.pages].reverse() }, draft });
    result = await transcriptionPort(fakeHost(answer).host)(paramsOf(ids), reordered.context);
    expect(refusalOf(result).message).toContain('does not match');
    expect(reordered.dispatched).toEqual([]);

    // A proposal smuggled in through the params is an unknown key, not a proposal.
    const smuggled = fakeContext(state, undefined);
    result = await transcriptionPort(fakeHost(answer).host)({ assetIds: ids, proposal: { plan, draft } }, smuggled.context);
    expect(refusalOf(result).code).toBe('invalid-params');
    expect(smuggled.dispatched).toEqual([]);

    // In every case the review never ran.
    for (const fake of [none, noDraft, shortDraft, reordered, smuggled]) expect(fake.dispatched).toEqual([]);
  });

  it('refuses before the review when the active model has no vision, and re-validates the params at apply time', async () => {
    const { state, ids } = scenario(1);
    const plan = valueOf(stageTranscriptionPlan({ assetIds: ids }, state, fakeHost(null).host));
    const proposal: PictureTranscriptionProposal = { plan, draft: { pages: [{ assetId: idAt(ids, 0), text: 't' }] } };

    const { host, calls } = fakeHost(null, false);
    const noVision = fakeContext(state, proposal);
    const refused = await transcriptionPort(host)(paramsOf(ids), noVision.context);
    expect(refusalOf(refused).code).toBe('invalid-params');
    expect(refusalOf(refused).message).toContain('does not accept images');
    expect(calls).toEqual([]);
    expect(noVision.dispatched).toEqual([]);

    const { host: visionHost, calls: visionCalls } = fakeHost(null);
    const unknownId = fakeContext(state, proposal);
    const missing = await transcriptionPort(visionHost)({ assetIds: ['a_ZZZZZZZZZZ'] }, unknownId.context);
    expect(refusalOf(missing).code).toBe('not-found');
    expect(visionCalls).toEqual([]);
    expect(unknownId.dispatched).toEqual([]);
  });

  it('reports the bus refusal unchanged when the command refuses (a stale expect)', async () => {
    const { state, ids } = scenario(1);
    const plan = valueOf(stageTranscriptionPlan({ assetIds: ids }, state, fakeHost(null).host));
    const proposal: PictureTranscriptionProposal = { plan, draft: { pages: [{ assetId: idAt(ids, 0), text: 't' }] } };
    const stale: CommandError = { code: 'revision-conflict', message: 'the picture changed since its transcription was read', target: 'params.pages[0].expect' };
    const { host } = fakeHost({ pages: [{ assetId: idAt(ids, 0), text: 't' }] });
    const { context, dispatched, effectCount } = fakeContext(state, proposal, { failDispatch: stale });
    const result = await transcriptionPort(host)(paramsOf(ids), context);
    expect(refusalOf(result)).toEqual(stale);
    expect(dispatched).toHaveLength(1);
    expect(effectCount()).toBe(0);
  });
});

describe('the review and card helpers', () => {
  it('builds the review pages with the second read’s word-level disagreement spans', () => {
    const { state, ids } = scenario(2);
    const plan = valueOf(stageTranscriptionPlan({ assetIds: ids, secondRead: { profileId: 'p_second' } }, state, fakeHost(null).host));
    const proposal: PictureTranscriptionProposal = {
      plan,
      draft: {
        pages: [
          { assetId: idAt(ids, 0), text: 'the quick brown fox', secondText: 'the quick red fox' },
          { assetId: idAt(ids, 1), text: 'same on both reads', secondText: 'same on both reads' },
        ],
      },
    };
    const pages = reviewPagesOf(proposal);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.disagreements).toEqual([{ start: 10, end: 15, secondStart: 10, secondEnd: 13, first: 'brown', second: 'red' }]);
    expect(pages[0]?.secondText).toBe('the quick red fox');
    expect(pages[0]?.file).toBe(`${idAt(ids, 0)}.png`);
    expect(pages[0]?.caption).toBe(`page ${idAt(ids, 0)}`);
    expect(pages[1]?.disagreements).toEqual([]);
  });

  it('previews the plan for the agent card without the expect guards', () => {
    const { state, ids } = scenario(TRANSCRIPTION_LARGE_BATCH_PAGES + 1);
    const plan = valueOf(stageTranscriptionPlan({ assetIds: ids }, state, fakeHost(null).host));
    const preview = transcriptionPreview(plan);
    expect(preview.kind).toBe('pictures.transcribe');
    expect(preview.batchSizes).toEqual([6, 6, 6, 3]);
    expect(preview.pages).toHaveLength(TRANSCRIPTION_LARGE_BATCH_PAGES + 1);
    expect(preview.pages[0]).not.toHaveProperty('expect');
    expect(preview.warnings).toEqual(['large-batch']);
    expect(preview.estimate.requests).toBe(4);
    expect(preview.estimate.maxRequests).toBe(TRANSCRIPTION_LARGE_BATCH_PAGES + 1);
  });
});
