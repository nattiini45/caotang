/**
 * `pictures.transcribe` end to end in the real agent loop (pictures.md §8.4): the planner's step is staged into a
 * card that shows the pages, the batches, both routes and their cost before any generation call; approval runs the
 * two reads as budgeted model calls, each pinned to its own route; the host's review gate answers; and exactly one
 * `asset.transcribe` publishes the batch in one undo group. A second read on the same route, or one without vision,
 * refuses before generation and writes nothing, as do a primary route without vision, a cancelled review and a failed
 * generation. Each test drives the real session on the real harness and the store's real registry; only the host
 * (vision check + review gate) and the generation runner are fakes, the two seams the app supplies.
 */

import { describe, expect, it } from 'vitest';

import { err, ok, type CommandError, type Result } from '@caotang/bus';
import {
  createGateway,
  createKeyStore,
  createManualClock,
  createMemoryVaultPort,
  createProfileStore,
  type ChatRequest,
  type Gateway,
} from '@caotang/gateway';
import { createMockProvider, userTextOf, type MockProvider, type MockScript } from '@caotang/gateway/mock';
import type { ReadAssetRecord } from '@caotang/pictures';
import type { ProjectState } from '@caotang/store';

import type { TranscriptionGenerationInput, TranscriptionRouteInfo } from '../../src/agent/loop.js';
import {
  createAgentSession,
  createContextPort,
  refusal,
  type AgentEvent,
  type AgentSession,
  type Decision,
  type Harness,
  type ModelCall,
  type PendingCard,
  type PictureTranscriptionGeneration,
  type PictureTranscriptionHost,
  type PictureTranscriptionProposal,
  type PictureTranscriptionReviewResult,
  type TurnReport,
} from '../../src/index.js';
import { makeHarness, makeState, snapshotOf } from '../fixtures.js';
import { answer, steps, transcript } from './scripts.js';

const INTENT = 'Transcribe the three handwritten pages.';

const PAGE_ONE = 'a_0000000001';
const PAGE_TWO = 'a_0000000002';
const PAGE_THREE = 'a_0000000003';
const IDS = [PAGE_ONE, PAGE_TWO, PAGE_THREE] as const;

const OPENED = new Date('2026-10-08T09:00:00.000Z');

/** One PNG record (`a_` + ten digits) in the project's picture library. */
function addPicture(state: ProjectState, id: string): void {
  const record = {
    id,
    file: `${id}.png`,
    mime: 'image/png',
    sha256: '0'.repeat(64),
    bytes: 500_000,
    width: 1000,
    height: 2000,
    source: { kind: 'import' },
    createdAt: OPENED.toISOString(),
  } as unknown as ReadAssetRecord;
  state.manifest.assets = [...(state.manifest.assets ?? []), record];
}

interface RunnerLog {
  readonly inputs: TranscriptionGenerationInput[];
}

/**
 * The app-supplied generation runner. Both reads go through the loop's budgeted model-call site, each pinned to
 * its own route, so the mock provider's call history shows the two routes.
 */
function generationRunner(log: RunnerLog, failure?: CommandError) {
  return async (input: TranscriptionGenerationInput): Promise<Result<PictureTranscriptionGeneration, CommandError>> => {
    log.inputs.push(input);
    if (failure !== undefined) return err(failure);
    const read = async (call: ModelCall | undefined, marker: string): Promise<string> => {
      if (call === undefined) return '';
      const request: ChatRequest = {
        messages: [{ role: 'user', content: `TRANSCRIBE-READ ${marker}` }],
        ...(call.profileId === undefined ? {} : { profileId: call.profileId }),
        ...(call.model === undefined ? {} : { model: call.model }),
      };
      let delivered = '';
      for await (const chunk of call.gateway.complete(request)) delivered += chunk.delta ?? '';
      return delivered;
    };
    const first = await read(input.model, 'primary');
    const second = await read(input.secondModel, 'second');
    expect(first).toBe('read');
    expect(second).toBe('read');
    return ok({
      model: input.model.model ?? 'mock',
      pages: input.plan.pages.map((page) => ({
        assetId: page.assetId,
        text: `First read of ${page.file}.`,
        ...(input.secondModel === undefined ? {} : { secondText: `Second read of ${page.file}.` }),
      })),
    });
  };
}

interface Rig {
  readonly state: ProjectState;
  readonly harness: Harness;
  readonly session: AgentSession;
  readonly report: TurnReport;
  readonly pending: PendingCard[];
  readonly runner: RunnerLog;
  readonly reviews: PictureTranscriptionProposal[];
  readonly mock: MockProvider;
  readonly primaryId: string;
  readonly secondId: string;
  readonly seen: ChatRequest[];
  readonly atDecision: { runnerCalls: number; modelRequests: number };
  readonly before: string;
}

let turnSeq = 0;

/**
 * One turn whose planner proposes a `pictures.transcribe` step with the params `params` builds. The gateway is the
 * real one over two priced vision-capable mock profiles; the session runs on the first, so the primary route is
 * pinned and the second read names the second profile explicitly.
 */
async function transcribeTurn(args: {
  readonly params: (routes: { primaryId: string; secondId: string }) => Record<string, unknown>;
  readonly decision: Decision;
  /** The host's vision answer for the primary route. Default true. */
  readonly vision?: boolean;
  /** The review gate's answer. Default: approve every page, editing the first one's text, into a new document. */
  readonly review?: PictureTranscriptionReviewResult | null;
  /** A generation failure the runner returns instead of reading. */
  readonly failure?: CommandError;
  /** Whether the resolver reports vision for the second profile's route. Default true. */
  readonly secondRouteVision?: boolean;
}): Promise<Rig> {
  const state = makeState();
  // Pin the project language so the card's language does not depend on the machine's locale.
  state.manifest.project.language = 'en';
  for (const id of IDS) addPicture(state, id);

  const reviews: PictureTranscriptionProposal[] = [];
  const host: PictureTranscriptionHost = {
    vision: () => args.vision ?? true,
    review: (proposal) => {
      reviews.push(proposal);
      const answer: PictureTranscriptionReviewResult | null =
        args.review === undefined
          ? {
              title: 'Handwritten pages',
              pages: proposal.plan.pages.map((page, index) => ({
                assetId: page.assetId,
                text: index === 0 ? `Reviewed text of ${page.file}.` : `First read of ${page.file}.`,
              })),
            }
          : args.review;
      return Promise.resolve(answer);
    },
  };
  const harness = makeHarness({ transcription: host }, state);
  const runner: RunnerLog = { inputs: [] };

  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const primary = await profiles.create({ name: 'Primary', kind: 'mock', isActive: true, pricePer1k: { prompt: 3, completion: 6 } });
  const second = await profiles.create({ name: 'Second', kind: 'mock', pricePer1k: { prompt: 1, completion: 2 } });
  const primaryId = primary.id;
  const secondId = second.id;
  const params = args.params({ primaryId, secondId });

  const seen: ChatRequest[] = [];
  const scripts: readonly MockScript[] = [
    transcript(INTENT, [steps({ tool: 'pictures.transcribe', params, expect: 'the pages are transcribed' }), answer('Done.')], seen),
    { match: () => true, respond: () => ({ content: 'read' }) },
  ];
  const mock = createMockProvider({ scripts: [...scripts], capsVision: true });
  const gateway: Gateway = createGateway({ profiles, keys, clock: createManualClock(0), mock });

  const pending: PendingCard[] = [];
  const events: AgentEvent[] = [];
  let atDecision = { runnerCalls: -1, modelRequests: -1 };
  turnSeq += 1;
  const session = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state }),
    profileId: primaryId,
    model: 'mock/primary',
    transcribe: generationRunner(runner, args.failure),
    ...(args.secondRouteVision === undefined
      ? {}
      : {
          transcriptionRoute: (profileId: string | undefined, model: string | undefined): TranscriptionRouteInfo => ({
            profileId: profileId ?? '',
            model: model ?? '',
            label: model ?? profileId ?? 'active model',
            vision: profileId === secondId ? args.secondRouteVision === true : true,
          }),
        }),
    decide: async (card) => {
      pending.push(card);
      atDecision = { runnerCalls: runner.inputs.length, modelRequests: mock.calls.length };
      return args.decision;
    },
    emit: (event) => events.push(event),
    sessionId: `picture-transcribe-${turnSeq}`,
  });
  const before = snapshotOf(state);
  const report = await session.submit(INTENT);
  return { state, harness, session, report, pending, runner, reviews, mock, primaryId, secondId, seen, atDecision, before };
}

/** The card's preview, as the shape `previewFor` builds for a staged transcription plan. */
interface PreviewShape {
  readonly kind: string;
  readonly into: string;
  readonly language: string;
  readonly secondRead?: { profileId: string; model?: string };
  readonly batchSizes: readonly number[];
  readonly warnings: readonly string[];
  readonly estimate: { requests: number; maxRequests: number; promptTokens: number; outputTokens: number };
  readonly pages: readonly { assetId: string; file: string; width?: number; height?: number; bytes: number }[];
  readonly routes?: { primary: { label: string; model: string }; second?: { label: string; model: string } };
  readonly routeCosts?: { primary?: StepCostShape; second?: StepCostShape };
}

interface StepCostShape {
  readonly promptUsd: number;
  readonly completionUsd: number;
  readonly totalUsd: number;
}

const transcribeCommandsOf = (harness: Harness) => harness.log.entries().filter((entry) => entry.command === 'asset.transcribe');

const undoGroupsOf = (harness: Harness) =>
  harness.undo.groups().filter((group) => group.entries.some((entry) => entry.name === 'asset.transcribe'));

describe('pictures.transcribe in the agent loop', () => {
  it('shows pages, batches, both routes and their cost on the card before any generation call, then publishes one asset.transcribe in one undo group after approval', async () => {
    const rig = await transcribeTurn({
      params: ({ secondId }) => ({ assetIds: [...IDS], secondRead: { profileId: secondId, model: 'mock/second' } }),
      decision: { action: 'approve' },
    });
    const { report, pending, runner, reviews, mock, harness, state, atDecision, primaryId, secondId } = rig;

    // The card was decided before the runner ran or any generation call was sent: one planner request, no reads yet.
    expect(pending).toHaveLength(1);
    expect(atDecision).toEqual({ runnerCalls: 0, modelRequests: 1 });
    const card = pending[0]?.card;
    expect(card?.kind).toBe('confirm');
    const step = card?.steps[0];
    expect(step?.tool).toBe('pictures.transcribe');
    const preview = step?.preview as unknown as PreviewShape;
    expect(preview.kind).toBe('pictures.transcribe');
    expect(preview.into).toBe('new-document');
    expect(preview.language).toBe('en');
    expect(preview.secondRead).toEqual({ profileId: secondId, model: 'mock/second' });
    expect(preview.batchSizes).toEqual([3]);
    expect(preview.warnings).toEqual([]);
    expect(preview.estimate).toMatchObject({ requests: 2, maxRequests: 6, outputTokens: 7200 });
    expect(preview.estimate.promptTokens).toBeGreaterThan(0);
    expect(preview.pages).toEqual(IDS.map((id) => ({ assetId: id, file: `${id}.png`, width: 1000, height: 2000, bytes: 500_000 })));
    // Both explicitly selected routes, labelled, priced separately, before anything was sent.
    expect(preview.routes).toEqual({
      primary: { label: 'mock/primary', model: 'mock/primary' },
      second: { label: 'mock/second', model: 'mock/second' },
    });
    expect(preview.routeCosts?.primary?.completionUsd).toBeCloseTo(21.6, 6);
    expect(preview.routeCosts?.second?.completionUsd).toBeCloseTo(7.2, 6);
    const cost = step?.cost as unknown as StepCostShape | undefined;
    expect(cost?.totalUsd).toBeCloseTo((preview.routeCosts?.primary?.totalUsd ?? 0) + (preview.routeCosts?.second?.totalUsd ?? 0), 10);

    // The approved card ran: the turn applied, the step is done.
    expect(report.status).toBe('applied');
    const done = report.steps.find((entry) => entry.tool === 'pictures.transcribe');
    expect(done?.status).toBe('done');
    expect(report.trace.map((row) => [row.tool, row.outcome])).toEqual([['pictures.transcribe', 'ok']]);
    expect(report.modelCalls).toBe(3);

    // The two reads ran through the loop's budgeted model-call site, each pinned to its own route.
    expect(runner.inputs).toHaveLength(1);
    const input = runner.inputs[0];
    expect(input?.plan.pages.map((page) => page.assetId)).toEqual([...IDS]);
    expect(input?.model.profileId).toBe(primaryId);
    expect(input?.model.model).toBe('mock/primary');
    expect(input?.secondModel?.profileId).toBe(secondId);
    expect(input?.secondModel?.model).toBe('mock/second');
    const reads = mock.calls.filter((call) => userTextOf(call).includes('TRANSCRIBE-READ'));
    expect(reads.map((call) => [call.profileId, call.model])).toEqual([
      [primaryId, 'mock/primary'],
      [secondId, 'mock/second'],
    ]);

    // The review gate saw both reads of every page, in plan order.
    expect(reviews).toHaveLength(1);
    const proposal = reviews[0];
    expect(proposal?.plan.secondRead).toEqual({ profileId: secondId, model: 'mock/second' });
    expect(proposal?.draft.pages.map((page) => [page.assetId, page.text, page.secondText])).toEqual(
      IDS.map((id) => [id, `First read of ${id}.png.`, `Second read of ${id}.png.`]),
    );

    // Exactly one asset.transcribe, in exactly one undo group.
    expect(transcribeCommandsOf(harness)).toHaveLength(1);
    expect(harness.log.length).toBe(1);
    const groups = undoGroupsOf(harness);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('agent-turn');
    expect(groups[0]?.turnId).toBe(report.turnId);

    // The published result: one Research document with the reviewed texts, one source link per page, records stamped.
    const data = done?.data as { into?: string; pages?: number; assetIds?: string[]; docId?: string; linkIds?: string[] } | undefined;
    expect(data?.into).toBe('new-document');
    expect(data?.pages).toBe(3);
    expect(data?.assetIds).toEqual([...IDS]);
    const docId = data?.docId ?? '';
    expect(docId).toMatch(/^n_/);
    expect(data?.linkIds).toHaveLength(3);
    expect(state.manifest.tree.some((node) => node.id === docId && node.parentId === 'research' && node.title === 'Handwritten pages')).toBe(true);
    expect(state.documents.get(docId)?.body).toBe(
      IDS.map((id, index) => (index === 0 ? `Reviewed text of ${id}.png.` : `First read of ${id}.png.`)).join('\n\n'),
    );
    for (const id of IDS) {
      const record = state.manifest.assets?.find((candidate) => candidate.id === id);
      expect(record?.transcription?.docId).toBe(docId);
      expect(record?.transcription?.model).toBe('mock/primary');
      expect(record?.transcription?.text).toBeUndefined();
    }
    const links = (state.manifest.assetLinks ?? []).filter((link) => (IDS as readonly string[]).includes(link.assetId));
    expect(links).toHaveLength(3);
    expect(links.every((link) => link.role === 'source' && link.target.kind === 'paragraph' && link.target.nodeId === docId)).toBe(true);

    // The async write reaches the turn checkpoint, so Restore reverses its one group exactly.
    const group = groups[0];
    expect(group).toBeDefined();
    expect(rig.report.undoGroupId).toBe(group?.id);
    const restored = rig.session.restore(rig.report.turnId);
    expect(restored.ok).toBe(true);
    expect(snapshotOf(state)).toBe(rig.before);
  });

  it('refuses a second read on the same route as the primary before any generation call or write', async () => {
    const rig = await transcribeTurn({
      params: ({ primaryId }) => ({ assetIds: [...IDS], secondRead: { profileId: primaryId, model: 'mock/primary' } }),
      decision: { action: 'approve' },
    });
    // No card was shown: the staged plan refused the step, so the refusal went back to the planner instead.
    expect(rig.pending).toHaveLength(0);
    expect(rig.runner.inputs).toHaveLength(0);
    expect(rig.reviews).toHaveLength(0);
    expect(rig.report.status).toBe('replied');
    expect(rig.report.modelCalls).toBe(2);
    expect(transcribeCommandsOf(rig.harness)).toHaveLength(0);
    expect(rig.harness.undo.groups()).toHaveLength(0);
    expect(snapshotOf(rig.state)).toBe(rig.before);
    const followUp = rig.seen[1];
    expect(followUp).toBeDefined();
    expect(userTextOf(followUp as ChatRequest)).toContain('the second read names the same route as the first');
  });

  it('refuses a second read on a route without vision before any generation call or write', async () => {
    const rig = await transcribeTurn({
      params: ({ secondId }) => ({ assetIds: [...IDS], secondRead: { profileId: secondId, model: 'mock/second' } }),
      decision: { action: 'approve' },
      secondRouteVision: false,
    });
    expect(rig.pending).toHaveLength(0);
    expect(rig.runner.inputs).toHaveLength(0);
    expect(rig.reviews).toHaveLength(0);
    expect(rig.report.status).toBe('replied');
    expect(rig.report.modelCalls).toBe(2);
    expect(transcribeCommandsOf(rig.harness)).toHaveLength(0);
    expect(rig.harness.undo.groups()).toHaveLength(0);
    expect(snapshotOf(rig.state)).toBe(rig.before);
    const followUp = rig.seen[1];
    expect(followUp).toBeDefined();
    expect(userTextOf(followUp as ChatRequest)).toContain('does not accept pictures');
  });

  it('refuses at the plan when the primary route has no vision, before any card, generation or write', async () => {
    const rig = await transcribeTurn({
      params: () => ({ assetIds: [...IDS] }),
      decision: { action: 'approve' },
      vision: false,
    });
    expect(rig.pending).toHaveLength(0);
    expect(rig.runner.inputs).toHaveLength(0);
    expect(rig.reviews).toHaveLength(0);
    expect(rig.report.status).toBe('replied');
    expect(rig.report.modelCalls).toBe(2);
    expect(transcribeCommandsOf(rig.harness)).toHaveLength(0);
    expect(rig.harness.undo.groups()).toHaveLength(0);
    expect(snapshotOf(rig.state)).toBe(rig.before);
    const followUp = rig.seen[1];
    expect(followUp).toBeDefined();
    expect(userTextOf(followUp as ChatRequest)).toContain('does not accept images');
  });

  it('writes nothing when the writer cancels the review after generation', async () => {
    const rig = await transcribeTurn({
      params: ({ secondId }) => ({ assetIds: [...IDS], secondRead: { profileId: secondId, model: 'mock/second' } }),
      decision: { action: 'approve' },
      review: null,
    });
    // The card was shown and approved, and both reads ran, but the review answered cancel.
    expect(rig.pending).toHaveLength(1);
    expect(rig.atDecision).toEqual({ runnerCalls: 0, modelRequests: 1 });
    expect(rig.runner.inputs).toHaveLength(1);
    expect(rig.reviews).toHaveLength(1);
    expect(rig.report.modelCalls).toBe(3);
    const step = rig.report.steps.find((entry) => entry.tool === 'pictures.transcribe');
    expect(step?.status).toBe('failed');
    const trace = rig.report.trace.find((row) => row.tool === 'pictures.transcribe');
    expect(trace?.outcome).toBe('refused');
    expect(trace?.code).toBe('permission-denied');
    // Nothing was dispatched, logged or grouped.
    expect(transcribeCommandsOf(rig.harness)).toHaveLength(0);
    expect(rig.harness.log.length).toBe(0);
    expect(rig.harness.undo.groups()).toHaveLength(0);
    expect(snapshotOf(rig.state)).toBe(rig.before);
  });

  it('writes nothing when generation fails, and never opens the review', async () => {
    const rig = await transcribeTurn({
      params: ({ secondId }) => ({ assetIds: [...IDS], secondRead: { profileId: secondId, model: 'mock/second' } }),
      decision: { action: 'approve' },
      failure: refusal('internal', 'the vision provider returned no reply', { correctiveHint: 'try the transcription again', target: 'pictures.transcribe' }),
    });
    expect(rig.pending).toHaveLength(1);
    expect(rig.runner.inputs).toHaveLength(1);
    expect(rig.reviews).toHaveLength(0);
    expect(rig.report.modelCalls).toBe(1);
    const step = rig.report.steps.find((entry) => entry.tool === 'pictures.transcribe');
    expect(step?.status).toBe('failed');
    const trace = rig.report.trace.find((row) => row.tool === 'pictures.transcribe');
    expect(trace?.outcome).toBe('refused');
    expect(trace?.code).toBe('internal');
    expect(transcribeCommandsOf(rig.harness)).toHaveLength(0);
    expect(rig.harness.log.length).toBe(0);
    expect(rig.harness.undo.groups()).toHaveLength(0);
    expect(snapshotOf(rig.state)).toBe(rig.before);
  });
});
