/**
 * A step routes on its own (provider-gateway §2, agent-harness §6): the planner of a turn is the plan step and a scene draft is the
 * draft step, so a writer who names a destination for drafts sends the draft there while the planning stays on the role's own. The
 * draft is also assembled for the model that will write it — its context is the step's window, not the role's — and the wire carries
 * the step's model, so a draft profile with a small window gets a brief that fits it rather than a cut-off one.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createGateway,
  createKeyStore,
  createManualClock,
  createMemoryVaultPort,
  createProfileStore,
  type FetchLike,
  type Gateway,
  type NewProfile,
  type ProfileView,
  type RoleTarget,
} from '@caotang/gateway';

import {
  createAgentPorts,
  createAgentSession,
  createBudgetMeter,
  createContextPort,
  createHarness,
  type AgentSession,
  type ContextPort,
  type ContextRequest,
} from '../../src/index.js';
import { clock, makeState } from '../fixtures.js';

const KEY = 'test-key';
const DRAFT_TEXT = 'Rain came sideways off the sea.';

const chunk = (delta: object, finish: string | null, usage?: object): string =>
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) })}\n\n`;

const sse = (body: string): Response => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

/** A planner reply that plans one step. */
const planning = (tool: string, params: object, promptTokens = 30) => (): Response =>
  sse(chunk({ role: 'assistant', content: JSON.stringify({ steps: [{ tool, params, expect: 'drafted' }] }) }, null) + chunk({}, 'stop', { prompt_tokens: promptTokens, completion_tokens: 6 }) + 'data: [DONE]\n\n');

/** A planner reply that plans several steps in one turn. */
const planningAll = (steps: readonly object[], promptTokens = 30) => (): Response =>
  sse(chunk({ role: 'assistant', content: JSON.stringify({ steps }) }, null) + chunk({}, 'stop', { prompt_tokens: promptTokens, completion_tokens: 6 }) + 'data: [DONE]\n\n');

const limited = (): Response => new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json' } });

/** The prose a draft answers with: the draft call reads raw text, since the draft is the text. */
const drafted = (text: string, promptTokens = 40) => (): Response =>
  sse(chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop', { prompt_tokens: promptTokens, completion_tokens: 8 }) + 'data: [DONE]\n\n');

const endpoint = (name: string, host: string, maxOutputTokens: number): NewProfile => ({
  name,
  kind: 'endpoint',
  preset: 'generic',
  baseUrl: `https://${host}/v1`,
  apiKey: KEY,
  defaultModel: `${name.toLowerCase()}-model`,
  maxOutputTokens,
  pricePer1k: { prompt: 0.01, completion: 0.01 },
});

interface Route {
  readonly gateway: Gateway;
  readonly chat: ProfileView;
  readonly drafts: ProfileView;
  readonly spare: ProfileView;
  /** Every request body that reached a profile, in order, with the host it went to. */
  readonly calls: { readonly host: string; readonly body: Record<string, unknown> }[];
  /** The limits each context assembly named for the destination it was assembled for, in order. */
  readonly built: { tool: string; limits: ContextRequest['limits'] | undefined }[];
  readonly session: AgentSession;
}

/**
 * A gateway whose chat role is `chat`, with a `drafts` destination named for the draft step only, over two endpoint profiles. The
 * resolver follows the app's rule: a step the role names a destination for resolves it, every other step resolves the role's own.
 */
async function routed(replies: (() => Response)[], windows: { readonly chat: number; readonly drafts: number }, options: { readonly follow?: boolean } = {}): Promise<Route> {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const calls: { host: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    calls.push({ host: new URL(String(url)).host, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return (replies.shift() ?? drafted('Answered.'))();
  });
  const chatView = await profiles.create(endpoint('Chat', 'a.example', 4_096));
  const draftsView = await profiles.create(endpoint('Drafts', 'b.example', 2_048));
  const spareView = await profiles.create(endpoint('Spare', 'c.example', 4_096));
  const stepTarget: RoleTarget = { profileId: draftsView.id, model: draftsView.defaultModel };
  const ownTarget: RoleTarget = { profileId: chatView.id, model: chatView.defaultModel };
  const base = createGateway({
    profiles,
    keys,
    clock: createManualClock(0),
    fetch,
    retry: { maxRetries: 0, delaysMs: [0], jitter: 0 },
    roles: {
      resolve: (role, step) => {
        if (role !== 'chat') return undefined;
        const routed = options.follow !== true && step === 'draft';
        return { ...(routed ? stepTarget : ownTarget), fallbacks: [{ profileId: spareView.id, model: spareView.defaultModel }] };
      },
      allowed: (role) => (role === 'chat' ? [chatView.id, draftsView.id, spareView.id] : []),
    },
  });
  // The planner answers in the JSON envelope rather than native calls: which wire brought the step does not change its route, and the
  // envelope is what makes the scripted plan below the whole answer.
  const gateway: Gateway = {
    ...base,
    modelCaps: (...args: Parameters<typeof base.modelCaps>) => ({ ...base.modelCaps(...args), tools: false }),
    modelLimits: (...args: Parameters<typeof base.modelLimits>) => {
      // The window follows the destination the request is for: a pin may name one, and otherwise the step's route decides it.
      const destination = args[0] ?? (options.follow !== true && args[3]?.step === 'draft' ? draftsView.id : chatView.id);
      return { ...base.modelLimits(...args), contextWindow: destination === draftsView.id ? windows.drafts : windows.chat };
    },
  };
  const built: { tool: string; limits: ContextRequest['limits'] | undefined }[] = [];
  const inner = createContextPort({ state: makeState() });
  const context: ContextPort = {
    ...inner,
    assemble: (request: ContextRequest) => {
      built.push({ tool: request.task.tool, limits: request.limits });
      return inner.assemble(request);
    },
  };
  const session = createAgentSession({
    harness: createHarness({ state: makeState(), ports: createAgentPorts(), clock: clock.now }),
    gateway,
    context,
    decide: async () => ({ action: 'approve' }),
    emit: () => {},
    meter: createBudgetMeter({}, { clock: createManualClock(1_000_000) }),
    role: 'chat',
    sessionId: 'role-steps',
  });
  return { gateway, chat: chatView, drafts: draftsView, spare: spareView, calls, built, session };
}

const hostsOf = (route: Route): string[] => route.calls.map((call) => call.host);

const MODELS = (route: Route): unknown[] => route.calls.map((call) => call.body['model']);

describe('a step routes on its own (provider-gateway §2)', () => {
  it('sends the planner to the chat role’s own destination and the draft to the step’s, on the step’s model', async () => {
    // The writer named a drafts destination and left planning on the role. One turn, two calls: the plan is the plan step, and the
    // draft it plans is the draft step, so the second call must leave for the profiles the writer authorised for it — with the model
    // it named, not the role's.
    const route = await routed(
      [planning('scene.draft', { doc: 'The Friend', instruction: 'Open it.', mode: 'draft' }), drafted(DRAFT_TEXT)],
      { chat: 200_000, drafts: 16_000 },
    );

    const report = await route.session.submit('Open The Friend.');
    expect(report.status).toBe('applied');
    expect(hostsOf(route)).toEqual(['a.example', 'b.example']);
    expect(MODELS(route)).toEqual(['chat-model', 'drafts-model']);
  });

  it('assembles the draft for the step’s destination, so the brief carries the window of the model that writes it', async () => {
    // The draft is a request the drafts profile will be sent, so its context is assembled and fitted to that profile's window rather
    // than the chat role's much larger one. The assembly names the destination's limits, and the panel's meter describes the same
    // window, so the writer sees what the draft call was actually held to.
    const route = await routed(
      [planning('scene.draft', { doc: 'The Friend', instruction: 'Open it.', mode: 'draft' }), drafted(DRAFT_TEXT)],
      { chat: 200_000, drafts: 16_000 },
    );

    const report = await route.session.submit('Open The Friend.');
    expect(report.status).toBe('applied');
    // Only the draft assembles with a destination of its own; the plan's assembly stays the port's config.
    expect(route.built.filter((row) => row.tool === 'scene.draft').map((row) => row.limits?.contextWindow)).toEqual([16_000]);
  });

  it('remembers a step that moved, so the rest of that step’s turn follows it', async () => {
    // A plan with two drafts: the first is rate-limited on the drafts profile and answered by its fallback, so the second draft
    // must start there — that step's route has already moved once in this turn, and the failed destination is not tried again.
    // The memory is the step's, so it never becomes a destination another step's route did not name.
    const route = await routed(
      [
        planningAll([
          { tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open it.', mode: 'draft' }, expect: 'opened' },
          { tool: 'scene.draft', params: { doc: 'The Storm', instruction: 'Carry on.', mode: 'continue' }, expect: 'carried on' },
        ]),
        limited,
        drafted(DRAFT_TEXT),
        drafted('The lamp failed again.'),
      ],
      { chat: 200_000, drafts: 16_000 },
    );

    const report = await route.session.submit('Open two scenes.');
    expect(report.status).toBe('applied');
    expect(hostsOf(route)).toEqual(['a.example', 'b.example', 'c.example', 'c.example']);
    expect(MODELS(route)).toEqual(['chat-model', 'drafts-model', 'spare-model', 'spare-model']);
  });

  it('follows the role for a step the role names nothing for, so a writer who named no steps sees one destination', async () => {
    // The same plan, with the step override withdrawn: the draft step resolves the chat role's own destination, so both calls leave
    // for it, at its model. A step row is a choice, never a second route the writer did not ask for.
    const route = await routed(
      [planning('scene.draft', { doc: 'The Friend', instruction: 'Open it.', mode: 'draft' }), drafted(DRAFT_TEXT)],
      { chat: 200_000, drafts: 16_000 },
      { follow: true },
    );

    const report = await route.session.submit('Open The Friend.');
    expect(report.status).toBe('applied');
    expect(hostsOf(route)).toEqual(['a.example', 'a.example']);
    expect(MODELS(route)).toEqual(['chat-model', 'chat-model']);
  });
});
