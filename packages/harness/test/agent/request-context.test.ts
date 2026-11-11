import { describe, expect, it } from 'vitest';
import { promptTokensOf, textOf, type ChatRequest, type ModelLimits } from '@caotang/gateway';
import { isPlannerCall, subagentScript, userTextOf, type MockScript } from '@caotang/gateway/mock';
import { setBody, type ProjectState } from '@caotang/store';
import { createAgentPorts, createAgentSession, createContextPort, createHarness, createMemoryRunLog, createPictureOutbox, mergePreviews, newRunRecord, parsePlan, parseRunEvents, planResume, RUN_LOG_VERSION, type AgentEvent, type AgentSessionOptions, type ContextOverrides, type Decision, type PendingCard, type RunEvent } from '../../src/index.js';
import { ENTRY, FRIEND, LANDING, STORM, clock, makeState } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { answer, prose, steps, transcript } from './scripts.js';

const INTENT = 'Check the storm.';
const PIN = { kind: 'codex' as const, id: ENTRY };
const READ = { tool: 'doc.read', params: { doc: STORM }, expect: 'The storm is read' };
const DRAFT = { tool: 'scene.draft', params: { doc: STORM, instruction: 'Elena returns.', mode: 'continue' }, expect: 'The storm continues' };
type MeterEvent = Extract<AgentEvent, { type: 'context-meter' }>;

async function fixture(scripts: readonly MockScript[], options: {
  state?: ProjectState;
  native?: boolean;
  limits?: ModelLimits;
  decide?: (card: PendingCard) => Promise<Decision>;
  log?: ReturnType<typeof createMemoryRunLog>;
  beforeStage?: AgentSessionOptions['beforeStage'];
  pictureOutbox?: AgentSessionOptions['pictureOutbox'];
  defaultContext?: boolean;
} = {}) {
  const state = options.state ?? makeState();
  const base = await mockGateway(scripts);
  const requests: ChatRequest[] = [];
  const meters: MeterEvent[] = [];
  const limitProfiles: (string | undefined)[] = [];
  const gateway = {
    ...base,
    modelCaps: (...args: Parameters<typeof base.modelCaps>) => ({ ...base.modelCaps(...args), tools: options.native === true }),
    modelLimits: (...args: Parameters<typeof base.modelLimits>) => {
      limitProfiles.push(args[0]);
      return options.limits === undefined ? base.modelLimits(...args) : { ...options.limits, ...(args[3]?.maxOutputTokens === undefined ? {} : { maxOutputTokens: args[3].maxOutputTokens }) };
    },
    complete: (request: ChatRequest, signal?: AbortSignal) => {
      requests.push(structuredClone(request));
      return base.complete(request, signal);
    },
  };
  const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now });
  const session = createAgentSession({
    harness, gateway, sessionId: 'context-test',
    ...(options.defaultContext === true ? {} : { context: createContextPort({ state, config: () => ({ model: gateway.modelLimits() }) }) }),
    decide: options.decide ?? (async () => ({ action: 'cancel' })),
    ...(options.beforeStage === undefined ? {} : { beforeStage: options.beforeStage }),
    ...(options.pictureOutbox === undefined ? {} : { pictureOutbox: options.pictureOutbox }),
    emit: (event) => { if (event.type === 'context-meter') meters.push(event); },
    ...(options.log === undefined ? {} : { runLog: { port: options.log, projectId: 'p_context' } }),
  });
  return { state, harness, session, requests, meters, gateway, limitProfiles };
}

describe('the typed planner preview', () => {
  it.each([false, true])('matches the actual first request without loading tools or sending a request (native=%s)', async (native) => {
    const state = makeState();
    state.agentFiles = { ...state.agentFiles, instructions: { path: 'CAOTANG.md', text: 'British spelling.' } };
    const run = await fixture([transcript(INTENT, [answer('Checked.')])], { state, native });
    const options = { languages: { ui: 'de', project: 'en' }, preload: ['scene.draft' as const], contextOverrides: { include: [PIN, { kind: 'doc' as const, id: LANDING }] } };
    const preview = run.session.previewRequest(INTENT, options);
    expect(run.requests).toHaveLength(0);
    expect(run.harness.loadedNativeTools()).toEqual([]);
    expect(run.session.reports()).toEqual([]);
    expect(run.session.previewRequest(INTENT, options)).toEqual(preview);
    expect((await run.session.submit(INTENT, options)).status).toBe('replied');
    expect(run.requests).toHaveLength(1);
    expect(preview.preview.payload).toEqual(run.requests[0]?.messages);
    expect(preview.meter.promptTokens).toBe(promptTokensOf(run.requests[0]!.messages));
    expect(run.meters[0]?.meter).toEqual(preview.meter);
    expect(run.meters[0]?.preview.payload).toEqual(preview.preview.payload);
  });

  it('does not share the mutable outgoing message objects with the preview', async () => {
    const run = await fixture([transcript(INTENT, [answer('Checked.')])]);
    const preview = run.session.previewRequest(INTENT);
    (preview.preview.payload[0] as { content: string }).content = 'Changed outside the harness.';
    await run.session.submit(INTENT);
    expect(run.requests[0]?.messages[0]?.content).not.toBe('Changed outside the harness.');
  });

  it('does not replace the limits of a turn waiting for its initial storage write', async () => {
    const log = createMemoryRunLog();
    let release = (): void => {};
    let created = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { created = resolve; });
    const run = await fixture([transcript(INTENT, [answer('Checked.')])], {
      defaultContext: true,
      log: { ...log, create: async (record) => { await log.create(record); created(); await held; } },
    });
    const other = await run.gateway.profiles.create({ name: 'Other mock', kind: 'mock', maxOutputTokens: 64 });
    const pending = run.session.submit(INTENT);
    await ready;
    run.session.previewRequest('Another request.', { profileId: other.id });
    const firstActual = run.limitProfiles.length;
    release();
    expect((await pending).status).toBe('replied');
    expect(run.limitProfiles.slice(firstActual)).not.toContain(other.id);
  });

  it('remeasures every outgoing planner call after replies and tool results', async () => {
    const state = makeState();
    setBody(state, STORM, 'Rain fell on the island. '.repeat(200));
    const run = await fixture([transcript(INTENT, [steps(READ), answer('Checked.')])], { state });
    await run.session.submit(INTENT);
    expect(run.requests).toHaveLength(2);
    expect(run.meters).toHaveLength(2);
    for (const [index, event] of run.meters.entries()) {
      expect(event.meter.promptTokens).toBe(promptTokensOf(run.requests[index]!.messages));
      expect(event.preview.payload).toEqual(run.requests[index]?.messages);
    }
    expect(run.meters[1]!.meter.promptTokens).toBeGreaterThan(run.meters[0]!.meter.promptTokens);
    expect(run.meters[1]!.meter.conversationTokens).toBeGreaterThan(0);
  });

  it('uses the raised output cap for the retry reserve and window state', async () => {
    const responses = [{ content: '{"steps":['.padEnd(80, ' '), finishReason: 'length' as const }, { content: answer('Checked.') }];
    const run = await fixture([{
      match: (request) => isPlannerCall(request) && userTextOf(request).includes(INTENT),
      respond: (request) => responses[Math.min(request.messages.filter((message) => message.role === 'assistant').length, 1)]!,
    }], { limits: { maxOutputTokens: 10, modelMaxOutputTokens: 40, contextWindow: 100_000, thinkingTokens: 5 } });
    await run.session.submit(INTENT);
    expect(run.requests).toHaveLength(2);
    expect(run.requests[1]?.maxOutputTokens).toBeGreaterThan(10);
    expect(run.meters[1]?.meter.reserveTokens).toBe(run.requests[1]!.maxOutputTokens! + 5 + 2_000);
    expect(run.meters[1]!.meter.reserveTokens).toBeGreaterThan(run.meters[0]!.meter.reserveTokens);
  });

  it('counts outgoing image parts but emits only placeholders in the live preview', async () => {
    const outbox = createPictureOutbox();
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    bytes[19] = 1;
    bytes[23] = 1;
    outbox.deliver('context-test.turn-1', [{ type: 'image', mime: 'image/png', bytes, hash: '0'.repeat(64), size: bytes.length }]);
    const run = await fixture([transcript(INTENT, [steps(READ), answer('Checked.')])], { pictureOutbox: outbox });
    await run.session.submit(INTENT);
    const sent = run.requests[1]!.messages;
    expect(sent.some((message) => typeof message.content !== 'string' && message.content.some((part) => part.type === 'image'))).toBe(true);
    const live = run.meters[1]!;
    expect(live.meter.promptTokens).toBe(promptTokensOf(sent));
    expect(live.preview.payload.every((message) => typeof message.content === 'string' || message.content.every((part) => part.type === 'text'))).toBe(true);
    expect(JSON.stringify(live)).not.toContain('"bytes":');
  });
});

describe('request choices on cards and in local recovery', () => {
  it('preserves every kept stable reference in a merged batch preview', () => {
    const port = createContextPort({ state: makeState() });
    const previews = [STORM, FRIEND].map((focus) => port.assemble({ task: { tool: 'scene.draft', instruction: 'Elena returns.', focus, mode: 'continue' }, role: 'Draft.' }).preview);
    const merged = mergePreviews(previews)!;
    for (const id of ['L2', 'L4']) {
      expect(merged.layers.find((layer) => layer.id === id)?.kept).toEqual(previews.flatMap((preview) => preview.layers.find((layer) => layer.id === id)?.kept ?? []));
    }
  });

  it.each([undefined, {}, { include: [PIN] }, { exclude: [PIN] }] as const)('does not move nonempty request choices into independent background tasks: %j', async (overrides) => {
    let offered = 0;
    const run = await fixture([transcript(INTENT, [steps(DRAFT, DRAFT, DRAFT, DRAFT, DRAFT)]), prose('Brief: Elena returns.', 'She returned.')], {
      beforeStage: async () => { offered += 1; return 'background'; },
    });
    const report = await run.session.submit(INTENT, overrides === undefined ? {} : { contextOverrides: overrides });
    const controlled = overrides !== undefined && Object.keys(overrides).length > 0;
    expect(offered).toBe(controlled ? 0 : 1);
    expect(report.status).toBe(controlled ? 'cancelled' : 'replied');
  });

  it('keeps the turn exclusion in a delegated context without changing its saved policy', async () => {
    const state = makeState();
    const entry = state.manifest.codex!.find((item) => item.id === ENTRY)!;
    entry.includePolicy = 'always';
    const delegate = { tool: 'agent.delegate', params: { agent: 'reader', brief: 'Check the storm.' }, expect: 'The reader returns notes' };
    const run = await fixture([transcript(INTENT, [steps(delegate), answer('Checked.')]), subagentScript(() => answer('Checked the storm.'))], { state });
    expect((await run.session.submit(INTENT, { contextOverrides: { exclude: [PIN] } })).status).toBe('replied');
    const children = run.requests.filter((request) => request.agentPath !== undefined);
    expect(children).toHaveLength(1);
    expect(children[0]!.messages.map((message) => textOf(message.content)).join('\n')).not.toContain('The keeper.');
    expect(entry.includePolicy).toBe('always');
  });

  it('redrafts an edited step with its exclusion and asks for fresh approval', async () => {
    const cards: PendingCard[] = [];
    const run = await fixture([transcript(INTENT, [steps(DRAFT)]), prose('Brief: Elena returns.', 'She returned.')], {
      decide: async (card) => {
        cards.push(card);
        return cards.length === 1 ? { action: 'edit', edits: [{ op: 'context', index: 0, overrides: { include: [PIN], exclude: [PIN] } }] } : { action: 'cancel' };
      },
    });
    const before = structuredClone(run.state);
    expect((await run.session.submit(INTENT, { contextOverrides: { include: [PIN] } })).status).toBe('cancelled');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.card.steps[0]!.context!.layers.find((layer) => layer.id === 'L2')?.kept?.map((item) => item.ref)).toContainEqual(PIN);
    expect(cards[1]!.card.steps[0]!.context!.layers.find((layer) => layer.id === 'L2')?.kept?.map((item) => item.ref) ?? []).not.toContainEqual(PIN);
    expect(cards[1]?.card.steps[0]?.contextOverrides?.exclude).toEqual([PIN]);
    expect(cards[1]!.card.revision).toBeGreaterThan(cards[0]!.card.revision);
    const drafts = run.requests.filter((request) => request.responseFormat === 'text');
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.messages.map((message) => textOf(message.content)).join('\n')).toContain('The keeper.');
    expect(drafts[1]!.messages.map((message) => textOf(message.content)).join('\n')).not.toContain('The keeper.');
    expect(run.state).toEqual(before);
  });

  it('snapshots choices before awaiting storage and logs only the IDs as new metadata', async () => {
    const log = createMemoryRunLog();
    const run = await fixture([transcript(INTENT, [answer('Checked.')])], { log });
    const choices: { include: typeof PIN[]; exclude: typeof PIN[] } = { include: [PIN], exclude: [PIN] };
    const pending = run.session.submit(INTENT, { contextOverrides: choices });
    choices.exclude.length = 0;
    await pending;
    const [record] = await log.open('p_context', { includeSettled: true });
    const parsed = parseRunEvents(await log.events(record!.runId));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.detail);
    const events = parsed.events;
    const start = events.find((event) => event.t === 'turn.start');
    expect(start).toMatchObject({ v: 3, contextOverrides: { include: [PIN], exclude: [PIN] } });
    const sent = events.filter((event) => event.t === 'messages').flatMap((event) => event.appended);
    expect(sent.map((message) => textOf(message.content)).join('\n')).not.toContain('The keeper.');
    expect(events.some((event) => (event as { t: string }).t === 'context-meter')).toBe(false);
    expect(run.requests[0]!.messages.map((message) => textOf(message.content)).join('\n')).not.toContain('The keeper.');
  });

  it('keeps an edited step exclusion when the model adjusts that same refused step', async () => {
    const first = { ...DRAFT, params: { ...DRAFT.params, doc: FRIEND, mode: 'draft' } };
    const corrected = { ...first, params: { ...first.params, mode: 'continue' } };
    const cards: PendingCard[] = [];
    const run = await fixture([transcript(INTENT, [steps(first, first), steps(corrected)]), prose('Brief: Elena returns.', 'She returned.')], {
      decide: async (card) => {
        cards.push(card);
        if (cards.length === 1) return { action: 'edit', edits: [{ op: 'context', index: 1, overrides: { include: [PIN], exclude: [PIN] } }] };
        return cards.length === 2 ? { action: 'approve' } : { action: 'cancel' };
      },
    });
    expect((await run.session.submit(INTENT, { contextOverrides: { include: [PIN] } })).status).toBe('cancelled');
    expect(cards).toHaveLength(3);
    expect(cards[2]?.card.steps[1]?.contextOverrides?.exclude).toEqual([PIN]);
    const drafts = run.requests.filter((request) => request.responseFormat === 'text');
    expect(drafts).toHaveLength(4);
    expect(drafts.at(-1)!.messages.map((message) => textOf(message.content)).join('\n')).not.toContain('The keeper.');
  });

  it('restores turn and edited-step choices, preserves old v3 logs, and refuses malformed metadata', () => {
    const choices: ContextOverrides = { include: [PIN], exclude: [PIN] };
    const start: RunEvent = { t: 'turn.start', v: RUN_LOG_VERSION, turnId: 'old', intent: INTENT, wire: 'plan', native: false, seq: 0, at: 1 };
    const card: RunEvent = { t: 'card.pending', turnId: 'old', kind: 'plan', steps: [{ ...DRAFT, contextOverrides: choices }], proposals: [null], revisions: [null], done: [], seq: 1, at: 1 };
    const old = planResume([start, { ...card, steps: [DRAFT] }], () => 0);
    expect(old.ok).toBe(true);
    if (old.ok) expect(old.replay.contextOverrides).toBeUndefined();
    expect(planResume([{ ...start, contextOverrides: choices }, card], () => 0)).toMatchObject({ ok: true, replay: { contextOverrides: choices, card: { steps: [{ contextOverrides: choices }] } } });
    for (const bad of [{ include: [{ kind: 'file', id: FRIEND }] }, { exclude: [{ kind: 'doc', id: '' }] }, { include: [PIN], title: 'Not recovery metadata' }]) {
      expect(parseRunEvents([{ ...start, contextOverrides: bad }]).ok).toBe(false);
      expect(parseRunEvents([start, { ...card, steps: [{ ...DRAFT, contextOverrides: bad }] }]).ok).toBe(false);
    }
    expect(parsePlan({ steps: [{ ...DRAFT, contextOverrides: choices }] }).ok).toBe(false);
  });

  it('resumes an edited card without dropping its context choices or carrying its approval', async () => {
    const log = createMemoryRunLog();
    const record = newRunRecord('run_context', { projectId: 'p_context', intent: INTENT, now: 1 });
    await log.create(record);
    const overrides = { include: [PIN], exclude: [PIN] };
    await log.append(record.runId, [
      { t: 'turn.start', v: 3, turnId: 'old', intent: INTENT, wire: 'plan', native: false, contextOverrides: overrides, seq: 0, at: 1 },
      { t: 'skills.loaded', turnId: 'old', skills: [], seq: 1, at: 1 },
      { t: 'card.pending', turnId: 'old', kind: 'plan', steps: [{ ...DRAFT, contextOverrides: overrides }], proposals: [null], revisions: [null], done: [], seq: 2, at: 1 },
    ], { status: 'interrupted' });
    const cards: PendingCard[] = [];
    const run = await fixture([prose('Brief: Elena returns.', 'She returned.')], { log, decide: async (card) => { cards.push(card); return cards.length === 1 ? { action: 'retry' } : { action: 'cancel' }; } });
    expect((await run.session.resume(record.runId)).status).toBe('cancelled');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.card.steps[0]?.contextOverrides).toEqual(overrides);
    expect(cards[1]!.card.steps[0]!.context!.layers.find((layer) => layer.id === 'L2')?.kept?.map((entry) => entry.ref) ?? []).not.toContainEqual(PIN);
    expect(run.requests.flatMap((request) => request.messages).map((message) => textOf(message.content)).join('\n')).not.toContain('The keeper.');
  });

  it('does not apply the next composer choices to an older run that had none', async () => {
    const log = createMemoryRunLog();
    const record = newRunRecord('run_old_context', { projectId: 'p_context', intent: INTENT, now: 1 });
    await log.create(record);
    const step = { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The friend is labelled' };
    await log.append(record.runId, [
      { t: 'turn.start', v: 3, turnId: 'old', intent: INTENT, wire: 'plan', native: false, seq: 0, at: 1 },
      { t: 'skills.loaded', turnId: 'old', skills: [], seq: 1, at: 1 },
      { t: 'card.pending', turnId: 'old', kind: 'plan', steps: [step], proposals: [null], revisions: [null], done: [], seq: 2, at: 1 },
    ], { status: 'interrupted' });
    const cards: PendingCard[] = [];
    const run = await fixture([], { log, decide: async (card) => { cards.push(card); return { action: 'cancel' }; } });
    expect((await run.session.resume(record.runId, { contextOverrides: { include: [PIN] } })).status).toBe('cancelled');
    expect(cards[0]?.card.steps[0]?.contextOverrides).toBeUndefined();
    expect(run.requests).toHaveLength(0);
  });
});
