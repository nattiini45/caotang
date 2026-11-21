/**
 * Replay — agent-harness.md §8.1: a recorded model call, a recorded turn, or a recorded turn answered by its cassette, run
 * against another destination on a scratch copy of the project.
 *
 * Three modes share one engine and one rule: nothing reaches the writer's project. The scratch copy is `cloneProjectState` of a
 * pre-turn snapshot, so a replay's writes land in a state nobody else holds and the real project's bytes, undo store and activity
 * log gain nothing. Adopting a result is a later, ordinary turn through `submitPlan`, never something this module does.
 *
 * - **call**: one recorded request, its messages sent as they were recorded, to the target profile and model. No tool runs, so
 *   nothing outside the model can change. Tool definitions are not part of a recording (a trace names the tools it declared), so
 *   a call replay sends the messages and the response format and declares no tools; the spec says so.
 * - **turn**: the recording's intent through a fresh session pinned to the target, with the recorded card decisions re-applied
 *   where the new card matches. A card whose tools differ stops the replay for the caller to decide, and no MCP server is ever
 *   wired, so an external step is refused rather than repeated.
 * - **cassette**: the same turn, with the recorded responses answering through the mock provider, so a bug report reproduces
 *   without a key and a real turn becomes a regression test. A request that differs from the recording ends the turn with the
 *   first differing message named, the way a cassette miss does in the eval tooling (cassette.ts).
 *
 * The engine compares what a writer can act on: the steps, their params, the usage of both sides and the replay's own trace. Two
 * drafts' words are the dialog's to diff, because the original text lives in the panel and not in the engine's hands (§8.1).
 */

import {
  createGateway,
  createKeyStore,
  createManualClock,
  createMemoryVaultPort,
  createProfileStore,
  textOf,
  type ChatMessage,
  type ChatRequest,
  type Gateway,
  type ModelLimits,
  type ThinkingLevel,
  type Usage,
} from '@caotang/gateway';
import { LAYER_NAMES } from '@caotang/context';
import { createMockProvider, type MockResponse, type MockScript } from '@caotang/gateway/mock';
import { cloneProjectState, countBody, nodeById, type ProjectState } from '@caotang/store';

import { createHarness, type HarnessOptions } from '../runtime.js';
import { canonicalJson } from '../util.js';
import { createContextPort } from './context.js';
import { DEFAULT_MAX_MODEL_CALLS, type CardRecord, type Decision, type PendingCard, type TurnReport } from './events.js';
import { projectBytes } from './bytes.js';
import { createAgentSession } from './loop.js';
import { createAgentPorts } from './ports.js';
import { traceGateway } from './trace.js';
import type {
  ModelRequestRecord,
  ModelResponseRecord,
  Text,
  ToolCallRecord,
  TraceInput,
  TraceMessage,
  TraceRecord,
  TraceSink,
} from './trace.js';

export type ReplayMode = 'call' | 'turn' | 'cassette';

/** How many replays this process has started: a call replay's ledger id carries it, so two never share one. */
let replays = 0;

/** Where a replay is sent: a saved profile, with the model and level the writer picked on it. */
export interface ReplayTarget {
  readonly profileId: string;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
}

/**
 * A recording to replay: one store's records, or the records of an imported file. `TraceStore` is one; `indexTrace` makes one of
 * a parsed file's records.
 */
export interface ReplaySource {
  records(turnId?: string): readonly TraceRecord[];
  message(id: string): TraceMessage | undefined;
}

/** An indexed recording: a `TraceStore`, or an imported file's records, read the same way. */
export function indexTrace(records: readonly TraceRecord[]): ReplaySource {
  const messages = new Map<string, TraceMessage>();
  for (const record of records) if (record.kind === 'message') messages.set(record.id, record.message);
  return {
    records: (turnId?: string): readonly TraceRecord[] =>
      turnId === undefined ? records : records.filter((record) => 'turnId' in record && record.turnId === turnId),
    message: (id: string): TraceMessage | undefined => messages.get(id),
  };
}

/** Why a replay could not be offered, said plainly to the caller. */
export type ReplayRefusalCode = 'no-call' | 'no-intent' | 'no-snapshot' | 'no-target' | 'text-omitted' | 'no-schema' | 'withheld-text' | 'mid-session';

export class ReplayRefusal extends Error {
  constructor(readonly code: ReplayRefusalCode, message: string) {
    super(message);
    this.name = 'ReplayRefusal';
  }
}

/** One recorded request with the messages it sent and the reply it got. */
export interface RecordedCall {
  readonly request: ModelRequestRecord;
  readonly response?: ModelResponseRecord;
  readonly messages: readonly ChatMessage[];
}

function plain(text: Text, what: string): string {
  if (typeof text === 'string') return text;
  throw new ReplayRefusal('text-omitted', `${what} was left out of this recording, so it cannot be replayed; export the trace with its text to replay it.`);
}

function chatMessageOf(message: TraceMessage): ChatMessage {
  return {
    role: message.role,
    content: plain(message.content, `A ${message.role} message's text`),
    ...(message.toolCalls === undefined
      ? {}
      : {
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            argumentsJson: plain(call.argumentsJson, `The arguments of ${call.name}`),
          })),
        }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(message.isError === undefined ? {} : { isError: message.isError }),
    // A provider's reasoning payload is never kept, only its size, so a replay starts its reasoning fresh (§8.1).
  };
}

/** The model requests one turn made, in the order it made them, each with its messages and its reply. */
export function recordedCalls(source: ReplaySource, turnId: string): RecordedCall[] {
  const records = source.records(turnId);
  const responses = new Map<number, ModelResponseRecord>();
  for (const record of records) if (record.kind === 'model.response') responses.set(record.callId, record);
  const calls: RecordedCall[] = [];
  for (const record of records) {
    if (record.kind !== 'model.request') continue;
    const messages: ChatMessage[] = [];
    let whole = true;
    for (const id of record.messages) {
      const message = source.message(id);
      // A message its turn no longer holds makes the call un-replayable; say so rather than send a shorter prompt.
      if (message === undefined) {
        whole = false;
        break;
      }
      messages.push(chatMessageOf(message));
    }
    if (!whole) continue;
    const response = responses.get(record.callId);
    calls.push({ request: record, messages, ...(response === undefined ? {} : { response }) });
  }
  return calls;
}

/** The decisions the writer made on the recording's cards, in order. */
export function recordedDecisions(source: ReplaySource, turnId: string): CardRecord[] {
  return source
    .records(turnId)
    .filter((record): record is TraceRecord & { kind: 'card' } => record.kind === 'card')
    .map((record) => record.card);
}

export interface ReplayEstimateRequest {
  readonly mode: ReplayMode;
  readonly source: ReplaySource;
  readonly turnId: string;
  readonly callIndex?: number;
  readonly target?: ReplayTarget;
  /** The most model calls the replayed turn may make. Absent, the recording's own count bounds the estimate. */
  readonly maxModelCalls?: number;
}

/** What a replay would cost before it is run: the recording's own input tokens, the target's output cap, and its price. */
export interface ReplayEstimate {
  readonly promptTokens: number;
  readonly maxCompletionTokens: number;
  readonly modelCalls: number;
  /** Absent when the target's model has no price row. */
  readonly costUsd?: number;
}

/**
 * The estimate a writer confirms before a replay spends anything (§8.1). Prompt tokens are the recording's own provider-reported
 * input tokens for the calls that would run, which is what the same request costs again; the output bound is the target's cap per
 * call, thinking included, as the review's estimate is.
 */
export function estimateReplay(
  input: ReplayEstimateRequest,
  limits: (profileId?: string, model?: string, thinking?: ThinkingLevel) => ModelLimits,
): ReplayEstimate {
  const calls = callsToRun(input);
  const target = input.target;
  const model = limits(target?.profileId, target?.model, target?.thinking);
  if (target === undefined && input.mode !== 'cassette') {
    throw new ReplayRefusal('no-target', 'Choose the profile to replay on first: a replay is sent to a saved profile of the writer’s.');
  }
  const promptTokens = calls.reduce((sum, call) => sum + (call.response?.['gen_ai.usage.input_tokens'] ?? 0), 0);
  const cap = model.maxOutputTokens + (model.thinkingTokens ?? 0);
  // A turn's worst case is its own allowance, not the recording's call count: a model that plans more steps spends more, and the
  // number a writer confirms is a maximum, so it is the session's bound.
  const allowance = input.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS;
  const calls2 = input.mode === 'call' ? calls.length : allowance;
  const maxCompletionTokens = cap * calls2;
  const price = model.pricePer1k;
  return {
    promptTokens,
    maxCompletionTokens,
    modelCalls: calls2,
    ...(price === undefined
      ? {}
      : { costUsd: (promptTokens / 1000) * price.prompt + (maxCompletionTokens / 1000) * price.completion }),
  };
}

function callsToRun(input: ReplayEstimateRequest): readonly RecordedCall[] {
  const calls = recordedCalls(input.source, input.turnId);
  if (input.mode !== 'call') return calls;
  const call = callAt(calls, input.callIndex);
  return [call];
}

function callAt(calls: readonly RecordedCall[], callIndex: number | undefined): RecordedCall {
  if (calls.length === 0) throw new ReplayRefusal('no-call', 'This recording holds no model call to replay.');
  const found = callIndex === undefined ? calls[0] : calls.find((call) => call.request.callIndex === callIndex);
  if (found === undefined) throw new ReplayRefusal('no-call', `This recording has no model call ${callIndex ?? 1}.`);
  return found;
}

/** One document's text as each side left it, for the side-by-side the dialog draws (§8.1). */
export interface DraftDiff {
  readonly docId: string;
  readonly title: string;
  /** `body` is the document's prose; `synopsis` is the binder's synopsis line. */
  readonly field: 'body' | 'synopsis';
  readonly original: string;
  readonly replay: string;
  readonly words: { readonly original: number; readonly replay: number };
}

/** A step as either side ran it. */
export interface StepDiff {
  readonly index: number;
  readonly original?: { readonly tool: string; readonly params: Readonly<Record<string, unknown>> };
  readonly replay?: { readonly tool: string; readonly params: Readonly<Record<string, unknown>> };
  /** The params that differ, by name, or `['tool']` when the step names another tool. */
  readonly changedParams: readonly string[];
}

export interface UsageSummary {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly modelCalls: number;
  readonly costUsd?: number;
}

/** What a replay ran into, named for the caller: a card it would not decide, an external step, a cassette that did not match. */
export interface ReplayStop {
  readonly reason: 'decision-mismatch' | 'external-tool' | 'cassette-miss';
  readonly detail: string;
}

export interface ReplayRequest {
  readonly mode: ReplayMode;
  readonly source: ReplaySource;
  /** The turn being replayed. */
  readonly turnId: string;
  /** Which request of the turn, for mode `call`. Absent: the turn's first. */
  readonly callIndex?: number;
  /** Where to replay; required for `call` and `turn`, absent for `cassette`, which answers from the recording. */
  readonly target?: ReplayTarget;
  /** The project as it was when the turn started; required for `turn` and `cassette`, which run on a copy of it. */
  readonly snapshot?: ProjectState;
  /** The gateway the turn's calls go through, for `call` and `turn`. */
  readonly gateway?: Gateway;
  /**
   * Asked when a card cannot be decided from the recording: the new card's tools differ from the recorded one's, so nobody has
   * approved the like of it. Absent, such a card cancels the turn and the result says which card it was.
   */
  readonly decide?: (pending: PendingCard, recorded: CardRecord | undefined) => Promise<Decision>;
  readonly signal?: AbortSignal;
  /** Names the replay's own session and turn, so its ledger rows never fold into the original's. */
  readonly sessionId?: string;
  /** The most model calls the replayed turn may make, so the estimate's bound and the run's bound are the same number. */
  readonly maxModelCalls?: number;
  /**
   * The project's own rules (agent-harness §4), as the app passes them: a read-deny keeps its nodes out of the replay's requests too,
   * so a replay can never send text the writer withheld.
   */
  readonly rules?: HarnessOptions['rules'];
  readonly clock?: () => number;
}

export interface ReplayResult {
  readonly mode: ReplayMode;
  /** The replayed turn. Absent for mode `call`. */
  readonly report?: TurnReport;
  /** The target's answer, for mode `call`. */
  readonly reply?: { readonly content: string; readonly toolCalls?: readonly unknown[] };
  readonly steps: readonly StepDiff[];
  readonly usage: { readonly original: UsageSummary; readonly replay: UsageSummary };
  /** The texts that differ between the project the turn started on and the one the replay left, for `turn` and `cassette`. */
  readonly drafts: readonly DraftDiff[];
  /** The scratch project's bytes after the replay, for `turn` and `cassette`: what "Use this version" would stage. */
  readonly projectBytes?: string;
  readonly stoppedAt?: ReplayStop;
}

function recordedRequest(call: RecordedCall, target: ReplayTarget, turnId: string): ChatRequest {
  return {
    messages: call.messages.map((message) => ({ ...message })),
    profileId: target.profileId,
    ...(target.model === undefined ? {} : { model: target.model }),
    ...(target.thinking === undefined ? {} : { thinking: target.thinking }),
    // The instruction the recording carried, never one made up here: a `json` request keeps the schema it was sent with, and a
    // recording that predates the hint cannot be replayed truthfully, so it says so.
    ...(call.request.responseFormat === undefined
      ? {}
      : call.request.responseFormat === 'text'
        ? { responseFormat: 'text' as const }
        : call.request.responseFormatHint === undefined
          ? (() => {
              throw new ReplayRefusal(
                'no-schema',
                'This recording asked for JSON without keeping the schema it asked for, so a call replay would send a different instruction; replay the whole turn instead, or record again.',
              );
            })()
          : { responseFormat: { jsonSchemaHint: call.request.responseFormatHint as object } }),
    turnId,
  };
}

function usageSummary(usage: Usage, modelCalls: number, costUsd?: number): UsageSummary {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    modelCalls,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function recordedUsage(calls: readonly RecordedCall[], report?: TurnReport): UsageSummary {
  if (report !== undefined) {
    return {
      promptTokens: report.tokens.promptTokens,
      completionTokens: report.tokens.completionTokens,
      modelCalls: report.modelCalls,
      ...(report.costUsd === undefined ? {} : { costUsd: report.costUsd }),
    };
  }
  let promptTokens = 0;
  let completionTokens = 0;
  let modelCalls = 0;
  for (const call of calls) {
    if (call.response === undefined) continue;
    promptTokens += call.response['gen_ai.usage.input_tokens'];
    completionTokens += call.response['gen_ai.usage.output_tokens'];
    modelCalls += 1;
  }
  return { promptTokens, completionTokens, modelCalls };
}

function recordedReport(source: ReplaySource, turnId: string): TurnReport | undefined {
  for (const record of source.records(turnId)) {
    if (record.kind === 'turn.end') return record.report as TurnReport;
  }
  return undefined;
}

function toolCallsOf(records: readonly (TraceRecord | TraceInput)[]): readonly ToolCallRecord[] {
  return records.filter((record): record is ToolCallRecord => record.kind === 'tool.call');
}

/** The recorded turn's steps against the replay's, by position, with the params that moved. */
export function stepDiffs(
  original: readonly ToolCallRecord[],
  replayed: readonly ToolCallRecord[],
): StepDiff[] {
  const count = Math.max(original.length, replayed.length);
  const diffs: StepDiff[] = [];
  for (let index = 0; index < count; index += 1) {
    const was = original[index];
    const now = replayed[index];
    const changed: string[] = [];
    if (was !== undefined && now !== undefined) {
      if (was.tool !== now.tool) changed.push('tool');
      else {
        const names = new Set([...Object.keys(was.params), ...Object.keys(now.params)]);
        for (const name of names) {
          if (canonicalJson(was.params[name]) !== canonicalJson(now.params[name])) changed.push(name);
        }
      }
    }
    diffs.push({
      index,
      ...(was === undefined ? {} : { original: { tool: was.tool, params: was.params } }),
      ...(now === undefined ? {} : { replay: { tool: now.tool, params: now.params } }),
      changedParams: changed.sort(),
    });
  }
  return diffs.filter((diff) => diff.original !== undefined || diff.replay !== undefined);
}

/**
 * The texts the two projects disagree about, so a writer can read what the other model would have written (§8.1). A turn's drafts are
 * its writes, and a write is only visible as the text it left: a document's body, or the synopsis the binder now holds. The comparison
 * is between the snapshot the turn started on and the scratch copy the replay changed, and a node either side has and the other does
 * not is reported too, with an empty text on the side that lacks it.
 */
export function draftDiffs(before: ProjectState, after: ProjectState): DraftDiff[] {
  const diffs: DraftDiff[] = [];
  const ids = new Set([...before.documents.keys(), ...after.documents.keys()]);
  for (const id of [...ids].sort()) {
    const original = before.documents.get(id)?.body ?? '';
    const replay = after.documents.get(id)?.body ?? '';
    if (original === replay) continue;
    const title = nodeById(after, id)?.title ?? nodeById(before, id)?.title ?? id;
    diffs.push({ docId: id, title, field: 'body', original, replay, words: { original: countBody(original).words, replay: countBody(replay).words } });
  }
  for (const node of after.manifest.tree) {
    if (!('synopsis' in node)) continue;
    const original = synopsisOf(before, node.id);
    if (original === node.synopsis) continue;
    diffs.push({ docId: node.id, title: node.title, field: 'synopsis', original, replay: node.synopsis, words: { original: countBody(original).words, replay: countBody(node.synopsis).words } });
  }
  return diffs;
}

/** A node's synopsis in a state, or `''` when the node or its synopsis is not there. */
function synopsisOf(state: ProjectState, id: string): string {
  const node = state.manifest.tree.find((candidate) => candidate.id === id);
  return node !== undefined && 'synopsis' in node ? node.synopsis : '';
}

function sameTools(recorded: readonly string[], card: PendingCard): boolean {
  const now = card.card.steps.map((step) => step.tool).sort();
  const then = [...recorded].sort();
  return now.length === then.length && now.every((tool, index) => tool === then[index]);
}

/** A recorded reply, as the mock provider answers it. */
function mockResponseOf(response: ModelResponseRecord): MockResponse {
  return {
    content: typeof response.content === 'string' ? response.content : '',
    ...(response.toolCalls === undefined
      ? {}
      : {
          toolCalls: response.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            argumentsJson: typeof call.argumentsJson === 'string' ? call.argumentsJson : '{}',
          })),
        }),
    ...(response['gen_ai.response.finish_reasons'][0] === undefined
      ? {}
      : { finishReason: response['gen_ai.response.finish_reasons'][0] }),
    ...(response.error === undefined
      ? {}
      : { error: { kind: response.error.kind as MockResponse['error'] extends { kind: infer K } ? K : never, message: plain(response.error.message, 'A model error') } }),
  };
}

/**
 * The recording's replies as mock scripts: the turn's requests answered in the order they were made (§8.1). A request whose
 * messages differ from the recorded one ends the turn with the first difference named, so a prompt change shows up as a diff and
 * not as a wrong answer. Tool definitions are not compared: a trace names the tools it declared and not their descriptions.
 */
export function cassetteScripts(source: ReplaySource, turnId: string): MockScript[] {
  const calls = recordedCalls(source, turnId);
  let at = 0;
  const script: MockScript = {
    match: () => true,
    respond: (request: ChatRequest): MockResponse => {
      const call = calls[at];
      at += 1;
      if (call?.response === undefined) {
        return {
          content: '',
          error: { kind: 'protocol', message: `The turn made request ${at}, and the recording holds ${calls.length}.` },
        };
      }
      const difference = firstDifference(call.messages, request.messages);
      if (difference !== undefined) {
        return { content: '', error: { kind: 'protocol', message: `Request ${at} differs from the recorded one: ${difference}.` } };
      }
      return mockResponseOf(call.response);
    },
  };
  return [script];
}

/**
 * The mock gateway a cassette answers through: one in-memory profile and the recording's scripts. Built here rather than borrowed from
 * `cassette.ts`, whose request key hashes with `node:crypto`: the app loads this module through the harness's index, and a Node-only
 * import anywhere on that path stops the browser build (the replay engine itself is tree-shaken out, but only a module the bundler can
 * read is).
 */
async function cassetteGateway(scripts: readonly MockScript[], tools: boolean): Promise<Gateway> {
  const clock = createManualClock(0);
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  await profiles.create({ name: 'Cassette', kind: 'mock', isActive: true });
  // The recorded wire is the mock's capability too: a trace from a real provider is a native-tools recording, and the harness picks
  // its wire — and so its planner system text — from the capability row. Answering a native recording on the JSON wire would report a
  // prompt change nobody made.
  return createGateway({ profiles, keys, clock, mock: createMockProvider({ scripts: [...scripts], capsTools: tools }) });
}

/** Whether a recording was made on the native-tools wire, which is the one that declares tools on a request (agent-harness §2). */
function recordedNative(calls: readonly RecordedCall[]): boolean {
  return calls.some((call) => (call.request.tools?.length ?? 0) > 0);
}

/** Where two texts first differ, as a sentence that quotes both sides, so a prompt change reads as the words that moved. */
function textDiff(recorded: string, sent: string): string {
  let at = 0;
  while (at < recorded.length && at < sent.length && recorded[at] === sent[at]) at += 1;
  const around = (text: string): string => JSON.stringify(text.slice(Math.max(0, at - 24), at + 24));
  return `at character ${at}: recorded ${around(recorded)}, sent now ${around(sent)}`;
}

/**
 * The text with every untrusted envelope's id masked. The id is a digest of the turn id (context `nonceFor`), and a replay is a turn
 * of its own, so two ids always differ without any prompt having changed: the comparison reads every other word, and the mask keeps
 * each side's length so a reported offset still lands where it did.
 */
const ENVELOPE_ID = /(<<\\?\/?untrusted\b[^\n]*?)\sid="([A-Za-z0-9]*)"/g;
function withoutEnvelopeIds(text: string): string {
  return text.replace(ENVELOPE_ID, (_marker, lead: string, id: string) => `${lead} id="${'*'.repeat(id.length)}"`);
}

/** Where two requests' messages first differ, as a sentence naming the message and what changed. */
function firstDifference(recorded: readonly ChatMessage[], sent: readonly ChatMessage[]): string | undefined {
  const count = Math.max(recorded.length, sent.length);
  for (let index = 0; index < count; index += 1) {
    const was = recorded[index];
    const now = sent[index];
    if (was === undefined) return `message ${index + 1} (${now?.role}) is new`;
    if (now === undefined) return `message ${index + 1} (${was.role}) is gone`;
    if (was.role !== now.role) return `message ${index + 1} was a ${was.role} message and is now a ${now.role} message`;
    const before = withoutEnvelopeIds(textOf(was.content));
    const after = withoutEnvelopeIds(textOf(now.content));
    if (before !== after) return `message ${index + 1} (${now.role}) changed ${textDiff(before, after)}`;
    if (canonicalJson(was.toolCalls ?? []) !== canonicalJson(now.toolCalls ?? [])) return `the tool calls of message ${index + 1} changed`;
  }
  return undefined;
}

/** Runs a recording against another destination, on a scratch copy where the mode has a turn to run. */
export async function replay(request: ReplayRequest): Promise<ReplayResult> {
  const calls = recordedCalls(request.source, request.turnId);
  if (calls.length === 0) throw new ReplayRefusal('no-call', 'This recording holds no model call to replay.');
  if (request.mode === 'call') return callReplay(request, calls);
  return turnReplay(request, calls);
}

async function callReplay(request: ReplayRequest, calls: readonly RecordedCall[]): Promise<ReplayResult> {
  const target = request.target;
  if (target === undefined) throw new ReplayRefusal('no-target', 'Choose the profile to replay on first: a replay is sent to a saved profile of the writer’s.');
  const gateway = request.gateway;
  if (gateway === undefined) throw new ReplayRefusal('no-target', 'A call replay needs the gateway to send through.');
  // A call replay sends a prompt that was rendered when it was recorded, so a rule the writer added since cannot be applied to it:
  // what can be done is to refuse when the project withholds anything at all, and say which way to replay instead.
  if (request.rules !== undefined) {
    if (request.snapshot === undefined) {
      throw new ReplayRefusal('no-snapshot', 'This project has rules, and a call replay cannot check a rendered prompt against them; replay the turn instead, which is assembled again under the rules.');
    }
    const guarded = createHarness({ state: cloneProjectState(request.snapshot), ports: createAgentPorts(), rules: request.rules });
    if (guarded.withheldAnywhere().size > 0) {
      throw new ReplayRefusal(
        'withheld-text',
        'This project withholds some of its text from the model, and a recorded prompt cannot be filtered: replay the whole turn instead, which is assembled again under the project’s rules.',
      );
    }
  }
  const call = callAt(calls, request.callIndex);
  // Its own ledger id for every call: the gateway's ledger accumulates rows per turn id, so two replays of one recording on one
  // gateway would otherwise report each other's tokens.
  replays += 1;
  const turnId = `${request.sessionId ?? `replay-${request.turnId}`}.call-${call.request.callIndex ?? 1}-${replays}`;
  const message = await gateway.completeOnce(recordedRequest(call, target, turnId), request.signal);
  const totals = gateway.ledger.turnTotals(turnId);
  return {
    mode: 'call',
    reply: {
      content: textOf(message.content),
      ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
    },
    steps: [],
    // A call replay runs no tool, so no document can differ.
    drafts: [],
    usage: {
      original: recordedUsage([call]),
      replay: usageSummary({ promptTokens: totals.promptTokens, completionTokens: totals.completionTokens }, 1, totals.costUsd),
    },
  };
}

async function turnReplay(request: ReplayRequest, calls: readonly RecordedCall[]): Promise<ReplayResult> {
  const snapshot = request.snapshot;
  if (snapshot === undefined) {
    throw new ReplayRefusal(
      'no-snapshot',
      'A turn replay runs on the project as it was when the turn started, and this recording was made without one. Replay one of its model calls instead.',
    );
  }
  const intent = intentOf(request.source, request.turnId);
  if (intent === undefined) throw new ReplayRefusal('no-intent', 'This recording does not hold the turn’s instruction, so the turn cannot be re-run.');
  const target = request.target;
  if (request.mode === 'turn' && target === undefined) {
    throw new ReplayRefusal('no-target', 'Choose the profile to replay on first: a replay is sent to a saved profile of the writer’s.');
  }
  if (request.mode === 'cassette' && (earlierTurns(request.source, request.turnId) || carriedConversation(calls))) {
    throw new ReplayRefusal(
      'mid-session',
      'This turn is not the first of its session, and a cassette replay starts a fresh session: the recording’s earlier conversation is not rebuilt, so its first request could not match. Replay the session’s first turn as a cassette, or replay this turn against a provider.',
    );
  }
  const gateway =
    request.mode === 'cassette' ? await cassetteGateway(cassetteScripts(request.source, request.turnId), recordedNative(calls)) : request.gateway;
  if (gateway === undefined) throw new ReplayRefusal('no-target', 'A turn replay needs the gateway to send through.');
  // A cassette answers from the mock's own profile store, so pinning the caller's target there would name a profile it does not hold:
  // the mode's destination is the recording itself, and the target is not used (§8.1).
  const pinned = request.mode === 'cassette' ? undefined : target;

  const scratch = cloneProjectState(snapshot);
  const harness = createHarness({
    state: scratch,
    ports: createAgentPorts(),
    ...(request.clock === undefined ? {} : { clock: request.clock }),
    ...(request.rules === undefined ? {} : { rules: request.rules }),
  });
  const decisions = recordedDecisions(request.source, request.turnId);
  const collected: TraceInput[] = [];
  const sink: TraceSink = { write: (record) => { collected.push(record); } };
  // A cassette's gateway is the replay's own, so its calls join the replay's trace: that is how a miss is found. A turn replay
  // leaves the caller's observer alone, since the app's own trace store is behind it.
  if (request.mode === 'cassette') gateway.setObserver?.(traceGateway(sink));
  let taken = 0;
  let stop: ReplayStop | undefined;
  const decide = async (pending: PendingCard): Promise<Decision> => {
    const recorded = decisions[taken];
    taken += 1;
    if (recorded !== undefined && sameTools(recorded.tools, pending)) {
      return recorded.decision === 'cancelled' ? { action: 'cancel' } : { action: 'approve' };
    }
    if (request.decide !== undefined) return request.decide(pending, recorded);
    stop ??= {
      reason: 'decision-mismatch',
      detail:
        recorded === undefined
          ? 'The replay asked for a card the recording does not have, so nobody has approved the like of it.'
          : `The replay proposed ${pending.card.steps.map((step) => step.tool).join(', ') || 'no steps'} where the recording had ${recorded.tools.join(', ') || 'no steps'}.`,
    };
    return { action: 'cancel' };
  };

  replays += 1;
  const session = createAgentSession({
    harness,
    gateway,
    // The project's read-deny withholds its nodes from this assembly too, as the app's port does.
    context: createContextPort({ state: scratch, config: {}, withheld: (tool) => harness.withheld(tool) }),
    decide,
    ...(pinned === undefined ? {} : { profileId: pinned.profileId, ...(pinned.model === undefined ? {} : { model: pinned.model }), ...(pinned.thinking === undefined ? {} : { thinking: pinned.thinking }) }),
    // Its own name, so a replay's ledger rows never fold into the original turn's, nor into an earlier replay's (§8.1).
    sessionId: `${request.sessionId ?? `replay-${request.turnId}`}-${replays}`,
    ...(request.maxModelCalls === undefined ? {} : { maxModelCalls: request.maxModelCalls }),
    ...(request.clock === undefined ? {} : { clock: request.clock }),
    trace: sink,
  });
  const report = await session.submit(intent, request.signal === undefined ? {} : { signal: request.signal });

  const replayed = toolCallsOf(collected);
  const external = replayed.find((call) => call.tool.startsWith('mcp__'));
  if (external !== undefined) {
    stop ??= {
      reason: 'external-tool',
      detail: `${external.tool} is an external tool: a replay never re-runs one, because its side effects are not Caotang’s to repeat or undo.`,
    };
  }
  const miss = firstProtocolError(collected);
  if (miss !== undefined) stop ??= { reason: 'cassette-miss', detail: miss };

  return {
    mode: request.mode,
    report,
    steps: stepDiffs(toolCallsOf(request.source.records(request.turnId)), replayed),
    usage: {
      original: recordedUsage(calls, recordedReport(request.source, request.turnId)),
      replay: usageSummary(
        { promptTokens: report.tokens.promptTokens, completionTokens: report.tokens.completionTokens },
        report.modelCalls,
        report.costUsd,
      ),
    },
    drafts: draftDiffs(snapshot, scratch),
    projectBytes: projectBytes(scratch),
    ...(stop === undefined ? {} : { stoppedAt: stop }),
  };
}

/** Whether the recording holds a turn before this one, which a cassette replay cannot reproduce without its conversation. */
/**
 * Whether the recording's own requests carry the conversation block (L6). A turn exported on its own holds one `turn.start`, so the turn
 * list cannot say whether it was the first of its session; the block says it, and a cassette cannot rebuild what it held.
 */
function carriedConversation(calls: readonly RecordedCall[]): boolean {
  const heading = `# ${LAYER_NAMES.L6}`;
  return calls.some((call) => call.messages.some((message) => message.role === 'user' && textOf(message.content).includes(heading)));
}

function earlierTurns(source: ReplaySource, turnId: string): boolean {
  const turns = source.records().filter((record): record is Extract<TraceRecord, { kind: 'turn.start' }> => record.kind === 'turn.start');
  const at = turns.findIndex((turn) => turn.turnId === turnId);
  return at > 0;
}

function intentOf(source: ReplaySource, turnId: string): string | undefined {
  for (const record of source.records(turnId)) {
    if (record.kind !== 'turn.start') continue;
    return typeof record.intent === 'string' ? record.intent : undefined;
  }
  return undefined;
}

/** The cassette miss, when the replay's own trace says a request differed from the recording. */
function firstProtocolError(collected: readonly TraceInput[]): string | undefined {
  for (const record of collected) {
    if (record.kind !== 'model.response' || record.error?.kind !== 'protocol') continue;
    if (typeof record.error.message !== 'string') continue;
    return record.error.message;
  }
  return undefined;
}
