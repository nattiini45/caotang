/**
 * The provider gateway — [provider-gateway.md §3](docs/architecture/provider-gateway.md).
 *
 * This file is the router and the accountant. It picks the profile a request targets,
 * sends a mock profile to the mock and an endpoint profile through the transport, and
 * records what each request cost in the ledger. It does not talk HTTP and it does not
 * touch key bytes beyond the single `reveal` it makes for a request it is about to send.
 *
 * The order of operations is fixed, and each step is there for a reason:
 *  1. resolve the target profile (an unknown id is an error, not a fallback);
 *  2. run the egress check against the URL, before the key is decrypted, so a refused
 *     request never touches key material;
 *  3. reveal the key, then send;
 *  4. record usage in `finally`, so an abandoned, failed, or aborted request is still
 *     counted for the requests it made.
 */

import { systemClock, type Clock } from './clock.js';
import { hostOf, originOf } from './base-url.js';
import { type ProfileStore } from './profiles.js';
import { EgressDeniedError, ProfileError, ProviderError, providerMessages } from './errors.js';
import type { KeyStore } from './keys/key-store.js';
import { UsageLedger } from './ledger.js';
import { createMockProvider, type MockProvider } from './mock/mock-provider.js';
import { collectOnce } from './once.js';
import { redactDeep } from './redact.js';
import { RequestLog, type RequestLogEntry, type RequestOutcome } from './request-log.js';
import { DEFAULT_RETRY, DEFAULT_TIMEOUTS, type RetryPolicy, type TransportTimeouts } from './retry.js';
import {
  assertEgress,
  probeJsonObject,
  requestJson,
  streamChat,
  type CallSpec,
  type FetchLike,
  type StreamStats,
  type TransportDeps,
} from './transport.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './profiles.js';
import { usageFor } from './tokens.js';
import { adapterFor } from './adapters/index.js';
import { effectiveOutput, nominalThinkingTokens } from './adapters/effort.js';
import { modelRowFor, presetFor, resolveRoute } from './presets/index.js';
import type { AdapterContext, CallSecrets, ProviderAdapter } from './adapters/types.js';
import type {
  ChatChunk,
  ChatRequest,
  FinishReason,
  ReasoningBlock,
  ToolCall,
  ModelCaps,
  ModelInfo,
  ModelLimits,
  ProfileView,
  ProviderGateway,
  RoleResolver,
  ThinkingLevel,
  Usage,
  UsageAttribution,
} from './types.js';

export interface Gateway extends ProviderGateway {
  readonly profiles: ProfileStore;
  readonly ledger: UsageLedger;
  readonly requestLog: RequestLog;
  /**
   * The limits and prices of a model, for the caller to fill context-assembly's model config (context-assembly
   * §5). The profile is the one named, else the active one; the model is the one named, else the profile's.
   * Synchronous, so an assembly can call it: it reads what `listModels` last reported for the profile, and
   * takes the documented default for anything that report did not state (see {@link ModelLimits}). With no
   * profile at all it is the defaults, since there is then no request to limit. A `thinking` level adds
   * `thinkingTokens`: what one call at that level may spend on thinking, for a cost estimate.
   */
  modelLimits(profileId?: string, model?: string, thinking?: ThinkingLevel): ModelLimits;
  /**
   * The capability row for a model on a profile's route: whether it takes native
   * tools, images, a JSON-schema response format, and which thinking levels the UI
   * may offer (provider-gateway §5). Absent fields mean "not supported". An endpoint
   * profile answers from the preset registry, or from the generic route's conservative
   * empty row when it has no preset, or one the registry does not know; a mock profile
   * answers with the mock's own row.
   */
  modelCaps(profileId?: string, model?: string): ModelCaps;
  /**
   * §5: asks the endpoint once whether it accepts `response_format: json_object`, and
   * caches the answer on the profile. The settings screen calls this at save time. Until
   * it has run, structured requests carry the schema in a system message and no
   * `response_format`. Returns the answer; a probe that cannot get one from the endpoint
   * rejects and caches nothing. A mock profile answers `true` locally, and a route that
   * cannot carry the field answers `false` without a request; when a request is made, it
   * goes to the profile it is pointed at, on that profile's own origin and key, whether or
   * not it is the active one (§4).
   */
  probeResponseFormat(profileId?: string): Promise<boolean>;
  /**
   * Attaches the trace observer (`GatewayOptions.observe`) from the next call on, or detaches it with `undefined`. A call with no
   * observer gathers nothing: the app detaches it when the writer turns traces off.
   */
  setObserver(observe: ((event: GatewayTraceEvent) => void) | undefined): void;
}

/**
 * One provider call's lifecycle, as the in-tab trace sees it (agent-harness §5.2). `id` is the gateway's own counter and joins the
 * events of one call; `req.turnId` and `req.callIndex` join them to the harness's records. Every string in an event has the call's
 * secrets scrubbed before the observer is told, and the events carry no header.
 */
export type GatewayTraceEvent =
  /** The request after role routing, so the resolved profile, model and thinking level are known. */
  | { readonly type: 'request'; readonly id: number; readonly req: ChatRequest; readonly profileId: string; readonly preset?: string; readonly model: string; readonly at: number }
  /** The first delta of text or reasoning reached the caller. */
  | { readonly type: 'first-token'; readonly id: number; readonly at: number }
  /** One attempt ended, with the outcome its request-log line carries. A retry is an attempt of its own. */
  | { readonly type: 'attempt'; readonly id: number; readonly attempt: number; readonly outcome: RequestOutcome; readonly status?: number; readonly errorKind?: string; readonly note?: string; readonly at: number }
  /** The call ended: what it delivered, or why it failed. `usageSource` says whether the usage is the provider's or the local estimate. */
  | {
      readonly type: 'response';
      readonly id: number;
      readonly finishReason: FinishReason;
      readonly content: string;
      readonly reasoningText: string;
      readonly reasoning?: readonly ReasoningBlock[];
      readonly toolCalls?: readonly ToolCall[];
      readonly usage: Usage;
      readonly usageSource: 'provider' | 'estimate';
      readonly attempts: number;
      readonly error?: { readonly kind: string; readonly message: string };
      readonly at: number;
    };

export interface GatewayOptions {
  profiles: ProfileStore;
  keys: KeyStore;
  clock?: Clock;
  /** the jitter source; defaults to `Math.random`, and tests pin it */
  random?: () => number;
  /** the network; defaults to `globalThis.fetch`, and tests substitute a scripted one */
  fetch?: FetchLike;
  timeouts?: Partial<TransportTimeouts>;
  retry?: Partial<RetryPolicy>;
  /** Whether `fetch` takes `targetAddressSpace`; defaults to detecting it in the running browser. Tests say so. */
  supportsAddressSpace?: () => boolean;
  /** The browser's `loopback-network` permission state; defaults to asking the browser. Tests say so. */
  loopbackPermission?: () => Promise<string | undefined>;
  ledger?: UsageLedger;
  requestLog?: RequestLog;
  /** the mock used for mock profiles; defaults to the shipped script library */
  mock?: MockProvider;
  /**
   * §6's task-role routing. A request that names a `role` and no `profileId` resolves through this; a request
   * that names neither keeps the active-profile rule. Absent means no routing: roles ride the ledger only.
   */
  roles?: RoleResolver;
  /**
   * Told of each provider call's lifecycle (see {@link GatewayTraceEvent}). It sees bodies, which the request log never holds, so
   * its consumer must keep them in memory only. Display and debugging: whatever it throws is swallowed, and a call behaves the
   * same with or without it. Absent, nothing is gathered.
   */
  observe?: (event: GatewayTraceEvent) => void;
}

const ZERO: Usage = { promptTokens: 0, completionTokens: 0 };
const PROBE_PROMPT = 'Reply with the JSON object {"ok": true}.';
/** The output cap the format probe asks for; the request log line records it like any other cap. */
const PROBE_MAX_TOKENS = 16;

export function createGateway(options: GatewayOptions): Gateway {
  const { profiles, keys } = options;
  const clock = options.clock ?? systemClock;
  const ledger = options.ledger ?? new UsageLedger(clock);
  const requestLog = options.requestLog ?? new RequestLog();
  const mock = options.mock ?? createMockProvider();
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  let calls = 0;
  let observer = options.observe;

  const deps: TransportDeps = {
    fetch: fetchImpl,
    clock,
    random: options.random ?? Math.random,
    timeouts: { ...DEFAULT_TIMEOUTS, ...options.timeouts },
    retry: { ...DEFAULT_RETRY, ...options.retry },
    log: requestLog,
    ...(options.supportsAddressSpace === undefined ? {} : { supportsAddressSpace: options.supportsAddressSpace }),
    ...(options.loopbackPermission === undefined ? {} : { loopbackPermission: options.loopbackPermission }),
    // The egress pin is the profile a request resolved to, read live from the store, so
    // a key can only ever reach the origin it was entered for — never another profile's.
    profileOrigin: (profileId) => {
      const profile = profiles.get(profileId);
      return profile !== undefined && profile.kind === 'endpoint' ? originOf(profile.baseUrl) : undefined;
    },
  };

  /**
   * What a call to a model server on this computer adds: the address space to declare, its preset's deadlines (the
   * gateway's own settings still win), and the words for a failure. Nothing for any other profile.
   */
  const localCall = (profile: ProfileView): Pick<CallSpec, 'addressSpace' | 'timeouts' | 'local'> | Record<string, never> => {
    const preset = presetFor(profile.preset);
    if (profile.kind !== 'endpoint' || preset?.local === undefined) return {};
    return {
      addressSpace: 'loopback',
      local: { product: preset.local.product, corsFix: preset.local.corsFix },
      ...(preset.timeouts === undefined ? {} : { timeouts: { ...preset.timeouts, ...options.timeouts } }),
    };
  };

  /** The profile a request targets: the one named, else the active one. Never a silent fallback. */
  const targetOf = (profileId: string | undefined): ProfileView => {
    if (profileId !== undefined) {
      const found = profiles.get(profileId);
      if (found === undefined) throw new ProfileError('not-found', `No provider profile has the id ${profileId}.`);
      return found;
    }
    const active = profiles.active();
    if (active === undefined) throw new ProfileError('no-active', 'No provider profile is active. Add one in Settings.');
    return active;
  };

  /**
   * Opens the sealed payload for one call: the API key and any custom headers, plus
   * every value the transport must redact. Only reached after the egress check has
   * passed, so a refused request never touches key material.
   */
  const secretsFor = async (profile: ProfileView): Promise<{ secrets: CallSecrets; redact: string[] }> => {
    if (profile.kind === 'mock') return { secrets: {}, redact: [] };
    const payload = await keys.revealPayload(profile.id);
    if (payload === undefined) {
      if (profile.hasKey) throw new ProfileError('key-unreadable', providerMessages.missingKey(profile.name));
      return { secrets: {}, redact: [] };
    }
    const apiKey = payload.apiKey === '' ? undefined : payload.apiKey;
    if (apiKey === undefined && profile.hasKey) {
      throw new ProfileError('key-unreadable', providerMessages.missingKey(profile.name));
    }
    const headers = Object.entries(payload.customHeaders ?? {}).map(([name, value]) => ({ name, value }));
    const redact = [apiKey, ...headers.map((h) => h.value)].filter((v): v is string => v !== undefined && v !== '');
    return {
      secrets: { ...(apiKey === undefined ? {} : { apiKey }), ...(headers.length === 0 ? {} : { headers }) },
      redact,
    };
  };

  /**
   * The route a (profile, model) pair speaks: the preset's adapter, overridden by the
   * preset's per-model route map (OpenCode), with the model's capability row. A
   * profile with no preset resolves to the generic OpenAI-Chat route.
   */
  const routeOf = (profile: ProfileView, model: string): { adapter: ProviderAdapter; ctx: AdapterContext } => {
    const spec = resolveRoute({ preset: profile.preset, baseUrl: profile.baseUrl }, model);
    return {
      adapter: adapterFor(spec.adapter),
      ctx: {
        baseUrl: profile.baseUrl,
        model,
        quirks: spec.quirks,
        caps: spec.caps,
        ...(spec.modelMaxOutput === undefined ? {} : { modelMaxOutput: spec.modelMaxOutput }),
      },
    };
  };

  const chatSpec = (
    profile: ProfileView,
    req: ChatRequest,
    route: { adapter: ProviderAdapter; ctx: AdapterContext },
    jsonObject: boolean,
    revealed: { secrets: CallSecrets; redact: string[] },
    onAttempt?: (entry: RequestLogEntry) => void,
  ): CallSpec => {
    const { adapter, ctx } = route;
    const effective = effectiveOutput({
      cap: req.maxOutputTokens ?? profile.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(req.thinking === undefined ? {} : { level: req.thinking }),
      ...(req.reasoningBudget === undefined ? {} : { budget: req.reasoningBudget }),
      caps: ctx.caps,
      ...(ctx.modelMaxOutput === undefined ? {} : { modelMaxOutput: ctx.modelMaxOutput }),
      ...(adapter.id === 'anthropic-messages' ? { style: ctx.caps.effortStyle ?? 'anthropic' } : {}),
    });
    const body = adapter.buildBody({
      req,
      ctx,
      temperature: req.temperature ?? profile.temperature ?? 0.7,
      effective,
      jsonObject,
    });
    const path = adapter.completePath(ctx.model);
    return {
      profileId: profile.id,
      model: ctx.model,
      host: hostOf(profile.baseUrl),
      baseUrl: profile.baseUrl,
      path,
      url: `${profile.baseUrl}${path}`,
      method: 'POST',
      accept: 'text/event-stream',
      body: JSON.stringify(body),
      maxTokens: effective.maxTokens,
      headers: adapter.headers(ctx, revealed.secrets, 'complete'),
      secrets: revealed.redact,
      createParser: () => adapter.createStreamParser(ctx),
      promptTokens: usageFor(req.messages, '').promptTokens,
      ...(onAttempt === undefined ? {} : { onAttempt }),
      ...localCall(profile),
    };
  };

  /**
   * The observer's view of one call (`GatewayOptions.observe`). Every event is scrubbed with the secrets known when it is told,
   * and a throwing observer is swallowed, so nothing here can change what the caller gets. `request` is told once the key
   * is revealed, so a call refused before that still reports a request, with nothing to scrub.
   */
  function startTrace(observe: (event: GatewayTraceEvent) => void, req: ChatRequest, profile: ProfileView, model: string) {
    calls += 1;
    const id = calls;
    let secrets: readonly string[] = [];
    let requested = false;
    let first = false;
    let responded = false;
    let content = '';
    let reasoningText = '';
    let failure: { kind: string; message: string } | undefined;
    const tell = (event: GatewayTraceEvent): void => {
      try {
        observe(redactDeep(event, secrets));
      } catch {
        // display only: the call is the writer's, the trace is not
      }
    };
    const request = (revealed: readonly string[]): void => {
      if (requested) return;
      requested = true;
      secrets = revealed;
      tell({ type: 'request', id, req, profileId: profile.id, ...(profile.preset === undefined ? {} : { preset: profile.preset }), model, at: clock.now() });
    };
    const respond = (stats: StreamStats, terminal: ChatChunk | undefined, signal: AbortSignal | undefined): void => {
      if (responded) return;
      responded = true;
      request([]);
      const finishReason: FinishReason = terminal?.finishReason ?? 'error';
      if (profile.kind === 'mock') {
        const outcome: RequestOutcome = finishReason !== 'error' ? 'ok' : signal?.aborted === true ? 'cancelled' : 'failed';
        tell({ type: 'attempt', id, attempt: 0, outcome, at: clock.now() });
      }
      if (failure === undefined && finishReason === 'error') {
        failure =
          signal?.aborted === true
            ? { kind: 'cancelled', message: 'The call was stopped.' }
            : terminal === undefined
              ? { kind: 'abandoned', message: 'The caller stopped reading before the reply finished.' }
              : { kind: 'error', message: 'The reply ended with an error.' };
      }
      tell({
        type: 'response',
        id,
        finishReason,
        content,
        reasoningText,
        ...(terminal?.reasoning === undefined ? {} : { reasoning: terminal.reasoning }),
        ...(terminal?.toolCalls === undefined ? {} : { toolCalls: terminal.toolCalls }),
        usage: terminal?.usage ?? stats.usage ?? ZERO,
        usageSource: stats.usageSource ?? 'estimate',
        attempts: stats.attempts,
        ...(failure === undefined ? {} : { error: failure }),
        at: clock.now(),
      });
    };
    return {
      request,
      attempt: (entry: RequestLogEntry): void =>
        tell({
          type: 'attempt',
          id,
          attempt: entry.attempt,
          outcome: entry.outcome,
          ...(entry.status === undefined ? {} : { status: entry.status }),
          ...(entry.errorKind === undefined ? {} : { errorKind: entry.errorKind }),
          ...(entry.note === undefined ? {} : { note: entry.note }),
          at: entry.at,
        }),
      chunk: (chunk: ChatChunk, stats: StreamStats, signal: AbortSignal | undefined): void => {
        const text = (chunk.delta ?? '') + (chunk.reasoningDelta ?? '');
        if (!first && text !== '') {
          first = true;
          tell({ type: 'first-token', id, at: clock.now() });
        }
        content += chunk.delta ?? '';
        reasoningText += chunk.reasoningDelta ?? '';
        if (chunk.finishReason !== undefined) respond(stats, chunk, signal);
      },
      fail: (error: unknown): void => {
        failure = {
          kind: error instanceof ProviderError ? error.kind : error instanceof Error ? error.name : 'error',
          message: error instanceof Error ? error.message : String(error),
        };
      },
      end: (stats: StreamStats, signal: AbortSignal | undefined): void => respond(stats, undefined, signal),
    };
  }

  async function* complete(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatChunk, void, undefined> {
    // §6: a request that names a role and no profile resolves through the injected router. The answer is the
    // profile it sends through, and the model and thinking level become the defaults the request's own fields
    // still beat. A resolver with no answer leaves the named-or-active rule in place, as a roleless request.
    let routed: { profileId: string; model?: string; thinking?: ThinkingLevel } | undefined;
    if (req.role !== undefined && req.profileId === undefined && options.roles !== undefined) {
      routed = options.roles.resolve(req.role);
      // The role-referenced set is the egress allow-list for a routed request: a role may only ever send
      // through a profile the resolver names for it. This refusal lands before any profile lookup or key reveal.
      if (routed !== undefined && !options.roles.allowed(req.role).includes(routed.profileId)) {
        throw new EgressDeniedError(`Refused a request under the "${req.role}" role: it resolved to a profile that role may not use.`);
      }
    }
    const profile = targetOf(routed?.profileId ?? req.profileId);
    const model = req.model ?? routed?.model ?? profile.defaultModel;
    const sent: ChatRequest =
      req.thinking === undefined && routed?.thinking !== undefined ? { ...req, thinking: routed.thinking } : req;
    const startedAt = clock.now();
    const stats: StreamStats = { attempts: 0, usage: undefined };
    const trace = observer === undefined ? undefined : startTrace(observer, sent, profile, model);

    try {
      if (profile.kind === 'mock') {
        stats.attempts = 1;
        trace?.request([]);
        for await (const chunk of mock.complete(sent, signal)) {
          if (chunk.usage !== undefined) {
            stats.usage = chunk.usage;
            stats.usageSource = 'estimate';
          }
          trace?.chunk(chunk, stats, signal);
          yield chunk;
        }
        return;
      }

      const route = routeOf(profile, model);
      // The §5 probe answer governs, and a capability row that names jsonObject false
      // can refuse it — but a row that says nothing leaves the probe to decide.
      const jsonObject =
        sent.responseFormat !== undefined &&
        sent.responseFormat !== 'text' &&
        profile.responseFormat?.supportsJsonObject === true &&
        route.ctx.caps.jsonObject !== false;
      assertEgress(deps, `${profile.baseUrl}${route.adapter.completePath(model)}`, profile.id);
      const revealed = await secretsFor(profile);
      trace?.request(revealed.redact);
      const spec = { ...chatSpec(profile, sent, route, jsonObject, revealed, trace?.attempt), signal };
      for await (const chunk of streamChat(deps, spec, stats)) {
        trace?.chunk(chunk, stats, signal);
        yield chunk;
      }
    } catch (error) {
      trace?.fail(error);
      throw error;
    } finally {
      trace?.end(stats, signal);
      if (stats.attempts > 0) {
        ledger.record(
          { profileId: profile.id, model, turnId: req.turnId, agentPath: req.agentPath, role: req.role, at: startedAt },
          stats.usage ?? ZERO,
          stats.attempts,
        );
      }
    }
  }

  /** What `listModels` last reported, per profile. The limits an assembly reads come from here, so they are as fresh as that listing. */
  const reported = new Map<string, readonly ModelInfo[]>();

  async function listModels(profileId: string): Promise<ModelInfo[]> {
    const profile = targetOf(profileId);
    if (profile.kind === 'mock') {
      const models = await mock.listModels(profile.id);
      reported.set(profile.id, models);
      return models;
    }

    const { adapter, ctx } = routeOf(profile, profile.defaultModel);
    // A preset with no listing route (Cohere's compatibility layer) answers from its
    // table; an adapter may also return null for a route without one.
    const preset = presetFor(profile.preset);
    const modelsPath = preset?.noModelsRoute === true ? null : adapter.modelsPath(ctx);
    if (modelsPath === null) {
      // The route has no listing endpoint: the preset's table is the catalogue.
      const models: ModelInfo[] = (preset?.models ?? [])
        .filter((row) => !row.pattern.includes('*'))
        .map((row) => ({
          id: row.pattern,
          ...(row.contextWindow === undefined ? {} : { contextWindow: row.contextWindow }),
          ...(row.maxOutputTokens === undefined ? {} : { maxOutputTokens: row.maxOutputTokens }),
          ...(row.pricePer1k === undefined ? {} : { pricePer1k: { ...row.pricePer1k } }),
        }));
      reported.set(profile.id, models);
      return models;
    }
    const url = `${profile.baseUrl}${modelsPath}`;
    assertEgress(deps, url, profile.id);
    const revealed = await secretsFor(profile);
    const json = await requestJson(deps, {
      profileId: profile.id,
      model: profile.defaultModel,
      host: hostOf(profile.baseUrl),
      baseUrl: profile.baseUrl,
      path: modelsPath,
      url,
      method: 'GET',
      accept: 'application/json',
      headers: adapter.headers(ctx, revealed.secrets, 'models'),
      secrets: revealed.redact,
      promptTokens: 0,
      ...localCall(profile),
    }).catch((error: unknown) => {
      // A preset the sweep found reachable from a browser can still have one route the page may not read (provider-gateway §9).
      // "Could not reach the host, check your connection" would be false for that route and send the writer to the wrong setting.
      if (error instanceof ProviderError && error.rejected && preset?.cors === 'ok') {
        throw new ProviderError('network', providerMessages.modelListUnreadable(hostOf(profile.baseUrl)), {
          ...(error.detail === undefined ? {} : { detail: error.detail }),
          rejected: true,
        });
      }
      throw error;
    });
    const models = adapter.parseModels(json);
    if (models === undefined) {
      throw new ProviderError('protocol', providerMessages.protocol(hostOf(profile.baseUrl), 'the model list had no data array'));
    }
    reported.set(profile.id, models);
    return models;
  }

  function modelLimits(profileId?: string, model?: string, thinking?: ThinkingLevel): ModelLimits {
    const profile = profileId === undefined ? profiles.active() : profiles.get(profileId);
    if (profile === undefined) return { maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS };
    const modelId = model ?? profile.defaultModel;
    const info = reported.get(profile.id)?.find((item) => item.id === modelId);
    // The preset's capability row fills what the live listing did not report.
    const preset = presetFor(profile.preset);
    const row = preset === undefined ? undefined : modelRowFor(preset, modelId);
    const price = profile.pricePer1k ?? info?.pricePer1k ?? row?.pricePer1k;
    const contextWindow = info?.contextWindow ?? row?.contextWindow;
    const maxOutputTokens = profile.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    let thinkingTokens: number | undefined;
    if (thinking !== undefined && row !== undefined) {
      const spec = resolveRoute({ preset: profile.preset, baseUrl: profile.baseUrl }, modelId);
      const settled = effectiveOutput({
        cap: maxOutputTokens,
        level: thinking,
        caps: spec.caps,
        ...(spec.modelMaxOutput === undefined ? {} : { modelMaxOutput: spec.modelMaxOutput }),
        ...(spec.adapter === 'anthropic-messages' ? { style: spec.caps.effortStyle ?? 'anthropic' } : {}),
      });
      if (settled.level !== undefined && settled.level !== 'off') thinkingTokens = settled.budget ?? nominalThinkingTokens(settled.level);
    }
    return {
      ...(contextWindow === undefined ? {} : { contextWindow }),
      maxOutputTokens,
      ...(thinkingTokens === undefined ? {} : { thinkingTokens }),
      ...(price === undefined ? {} : { pricePer1k: { prompt: price.prompt, completion: price.completion } }),
    };
  }

  async function probeResponseFormat(profileId?: string): Promise<boolean> {
    const profile = targetOf(profileId);
    if (profile.kind === 'mock') {
      profiles.recordProbe(profile.id, { supportsJsonObject: true, probedAt: clock.now() });
      return true;
    }

    // `response_format` is a Chat Completions concept: only an openai-chat route can
    // carry it, so other routes answer false without spending a request.
    const route = routeOf(profile, profile.defaultModel);
    if (route.adapter.id !== 'openai-chat') {
      profiles.recordProbe(profile.id, { supportsJsonObject: false, probedAt: clock.now() });
      return false;
    }

    const path = route.adapter.completePath(profile.defaultModel);
    const url = `${profile.baseUrl}${path}`;
    assertEgress(deps, url, profile.id);
    const revealed = await secretsFor(profile);
    const body = JSON.stringify({
      model: profile.defaultModel,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      [route.ctx.quirks.maxTokensField ?? 'max_tokens']: PROBE_MAX_TOKENS,
      stream: false,
      response_format: { type: 'json_object' },
    });
    const supported = await probeJsonObject(deps, {
      profileId: profile.id,
      model: profile.defaultModel,
      host: hostOf(profile.baseUrl),
      baseUrl: profile.baseUrl,
      path,
      url,
      method: 'POST',
      accept: 'application/json',
      body,
      maxTokens: PROBE_MAX_TOKENS,
      headers: route.adapter.headers(route.ctx, revealed.secrets, 'models'),
      secrets: revealed.redact,
      promptTokens: usageFor([{ role: 'user', content: PROBE_PROMPT }], '').promptTokens,
      ...localCall(profile),
    });
    profiles.recordProbe(profile.id, { supportsJsonObject: supported, probedAt: clock.now() });
    ledger.record({ profileId: profile.id, model: profile.defaultModel, at: clock.now() }, ZERO, 1);
    return supported;
  }

  function modelCaps(profileId?: string, model?: string): ModelCaps {
    const profile = profileId === undefined ? profiles.active() : profiles.get(profileId);
    if (profile === undefined) return {};
    // A mock profile has no route of its own: its row is the mock's, as the mock says it.
    if (profile.kind === 'mock') return mock.modelCaps(profile.id, model);
    return routeOf(profile, model ?? profile.defaultModel).ctx.caps;
  }

  function accountTokens(usage: Usage, by: UsageAttribution): void {
    ledger.record(
      { profileId: by.profileId, model: by.model, turnId: by.turnId, agentPath: by.agentPath, role: by.role, at: by.at ?? clock.now() },
      usage,
      1,
    );
  }

  return {
    profiles,
    ledger,
    requestLog,
    complete: (req, signal) => complete(req, signal),
    completeOnce: (req, signal) => collectOnce(complete(req, signal), signal),
    listModels,
    modelLimits,
    modelCaps,
    accountTokens,
    probeResponseFormat,
    setObserver: (observe) => {
      observer = observe;
    },
  };
}
