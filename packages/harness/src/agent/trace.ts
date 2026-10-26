/**
 * The agent trace — [agent-harness §5.2](docs/architecture/agent-harness.md): what a turn sent, got back, ran and spent, in one
 * ordered record the writer can read and export.
 *
 * `caotang.trace/1` is JSON Lines, one record per line, ordered by `seq`. Two producers write it: the gateway's observer
 * (`traceGateway`: every model call, whoever made it) and the agent loop (the turn, its context, its tools, its cards). They meet at
 * `turnId` and `callIndex`. The model-call fields borrow OpenTelemetry's GenAI names (`gen_ai.request.model`,
 * `gen_ai.usage.input_tokens`) so a writer can map a trace into their own tooling; Caotang ships no exporter.
 *
 * A trace holds the prompts and the manuscript text they carry, which the request log never does, so it has rules of its own:
 *  - **Memory only.** `createTraceStore` keeps records in the tab. Nothing here writes to IndexedDB, a project, a bundle or the
 *    network; the only way out is `toJsonl`, which the writer asks for.
 *  - **Bounded.** The newest 25 turns and 16 MB of JSON, whole turns dropped oldest first. The turn being written is never dropped,
 *    and no record keeps more than 64 KB (the longest text in it is cut, and the record says by how much in `truncated`).
 *  - **Scrubbed, best-effort.** The gateway scrubs a call's own secrets before it tells the observer; the store runs the bearer and
 *    `sk-` pattern pass over every string it keeps. Headers are never recorded, and a provider's opaque reasoning payload is kept as
 *    its byte length only. This lowers the chance of a credential in the file. It does not make the file safe to share.
 *  - **Stored once.** A message is kept once per store under an ordinal id (`m1`, `m2`…), and a request lists the ids it was sent.
 *    The id is the position of the message's exact canonical form; there is no hash, so a short line cannot be guessed from it.
 *  - **Not readable by the model.** Nothing in the command bus, the agent's tools or the MCP server reaches a store.
 *
 * `omitText` makes an export that is safe to attach to a bug report: every text the writer or the model wrote becomes
 * `{omitted:{chars}}`, and structure, timing, tool names, risk, outcome, token counts and finish reasons stay.
 */

import { redactDeep, type ChatMessage, type ChatRole, type FinishReason, type GatewayTraceEvent, type TaskRole, type ThinkingLevel } from '@caotang/gateway';
import type { CommandError, Result } from '@caotang/bus';

import { canonicalJson, isRecord } from '../util.js';
import type { CardRecord, TraceEntry, TurnReport } from './events.js';

export const TRACE_FORMAT = 'caotang.trace/1' as const;
/** The record version every line carries. A reader refuses a trace whose major version it does not know. */
export const TRACE_VERSION = 1;
/** The group the calls made outside any turn (the coherence and encoding reviews) are kept in. */
export const TRACE_REVIEWS = 'reviews';
export const TRACE_MAX_TURNS = 25;
export const TRACE_MAX_BYTES = 16 * 1024 * 1024;
export const TRACE_RECORD_CAP = 64 * 1024;

/** What an `omitText` export leaves where a text was: only how long it was. */
export interface Omitted {
  readonly omitted: { readonly chars: number };
}
export type Text = string | Omitted;

/** A message as recorded: a reasoning block's provider payload is its byte length only. */
export interface TraceMessage {
  readonly role: ChatRole;
  readonly content: Text;
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly argumentsJson: Text }[];
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly reasoning?: readonly { readonly text: Text; readonly bytes?: number }[];
}

export interface TraceToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: Text;
}

export interface TraceTry {
  readonly attempt: number;
  readonly outcome: string;
  readonly status?: number;
  readonly errorKind?: string;
  readonly at: number;
}

interface Base {
  readonly v: typeof TRACE_VERSION;
  readonly seq: number;
  readonly at: number;
  readonly sessionId: string;
}

export interface HeaderRecord extends Base {
  readonly kind: 'header';
  readonly format: typeof TRACE_FORMAT;
  readonly app: string;
  readonly project: { readonly name: Text };
}
export interface TurnStartRecord extends Base {
  readonly kind: 'turn.start';
  readonly turnId: string;
  readonly intent: Text;
}
export interface MessageRecord extends Base {
  readonly kind: 'message';
  readonly id: string;
  readonly message: TraceMessage;
  readonly truncated?: { readonly chars: number };
}
export interface ModelRequestRecord extends Base {
  readonly kind: 'model.request';
  /** The gateway's own number for the call; a request and its response share it. */
  readonly callId: number;
  readonly turnId?: string;
  /** Which request of its turn this is (1-based), the key the loop's records use. Absent for a call made outside a turn. */
  readonly callIndex?: number;
  readonly agentPath?: string;
  readonly profileId: string;
  readonly preset?: string;
  readonly 'gen_ai.request.model': string;
  readonly role?: TaskRole;
  readonly thinking?: ThinkingLevel;
  /** The ids of the messages sent, in order (`message` records). */
  readonly messages: readonly string[];
  readonly tools?: readonly { readonly name: string }[];
  readonly responseFormat?: 'text' | 'json';
}
export interface ModelResponseRecord extends Base {
  readonly kind: 'model.response';
  readonly callId: number;
  readonly turnId?: string;
  readonly callIndex?: number;
  readonly agentPath?: string;
  readonly firstTokenAt?: number;
  readonly finishedAt: number;
  readonly attempts: number;
  readonly tries: readonly TraceTry[];
  readonly 'gen_ai.response.finish_reasons': readonly FinishReason[];
  readonly content: Text;
  readonly reasoningText?: Text;
  /** Opaque provider reasoning (signed thinking, encrypted content) is never kept, only how large it was. */
  readonly reasoningBlocks?: readonly { readonly bytes: number }[];
  readonly toolCalls?: readonly TraceToolCall[];
  readonly 'gen_ai.usage.input_tokens': number;
  readonly 'gen_ai.usage.output_tokens': number;
  /** Whether the tokens are the provider's or the local `ceil(chars/4)` estimate. */
  readonly usageSource: 'provider' | 'estimate';
  readonly error?: { readonly kind: string; readonly message: string };
  readonly truncated?: { readonly chars: number };
}
export interface ContextRecord extends Base {
  readonly kind: 'context';
  readonly turnId: string;
  /** The request this assembly was for. */
  readonly callIndex: number;
  readonly layers: readonly { readonly id: string; readonly tokens: number }[];
  readonly dropped: readonly Text[];
}
export interface ToolCallRecord extends Base {
  readonly kind: 'tool.call';
  readonly turnId: string;
  readonly callId: string;
  readonly tool: string;
  readonly risk: string;
  readonly agentPath?: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly truncated?: { readonly chars: number };
}
export interface ToolResultRecord extends Base {
  readonly kind: 'tool.result';
  readonly turnId: string;
  readonly callId: string;
  readonly outcome: TraceEntry['outcome'];
  readonly code?: CommandError['code'];
  readonly startedAt?: number;
  readonly finishedAt: number;
  /** The body the model was handed back. Absent for a call whose result went to a delegated agent. */
  readonly body?: unknown;
  readonly truncated?: { readonly chars: number };
}
export interface CardTraceRecord extends Base {
  readonly kind: 'card';
  readonly turnId: string;
  readonly card: CardRecord;
}
export interface LadderRecord extends Base {
  readonly kind: 'ladder';
  readonly turnId: string;
  readonly callId: string;
  readonly attempt: number;
  readonly reason: Text;
}
export interface TurnEndRecord extends Base {
  readonly kind: 'turn.end';
  readonly turnId: string;
  /** The report the turn returned. In an `omitText` export its texts are stubs. */
  readonly report: TurnReport | Readonly<Record<string, unknown>>;
  readonly truncated?: { readonly chars: number };
}

export type TraceRecord =
  | HeaderRecord
  | TurnStartRecord
  | MessageRecord
  | ModelRequestRecord
  | ModelResponseRecord
  | ContextRecord
  | ToolCallRecord
  | ToolResultRecord
  | CardTraceRecord
  | LadderRecord
  | TurnEndRecord;

export type TraceKind = TraceRecord['kind'];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Stamped = 'v' | 'seq' | 'sessionId';

/** What a producer hands the sink: a record without the fields the store stamps. A request carries its messages whole. */
export type TraceInput =
  | (Omit<ModelRequestRecord, Stamped | 'messages'> & { readonly messages: readonly ChatMessage[] })
  | DistributiveOmit<Exclude<TraceRecord, HeaderRecord | MessageRecord | ModelRequestRecord>, Stamped>;

export interface TraceSink {
  write(record: TraceInput): void;
}

export interface TraceTurn {
  /** The turn id, or {@link TRACE_REVIEWS} for the calls made outside a turn. */
  readonly turnId: string;
  readonly intent: string;
  readonly bytes: number;
  readonly records: number;
  readonly startedAt: number;
}

export interface TraceExportOptions {
  /** One turn (or {@link TRACE_REVIEWS}). Absent: every turn the store holds. */
  readonly turnId?: string;
  /** Texts become `{omitted:{chars}}`; structure, timing and counts stay. */
  readonly omitText?: boolean;
}

export interface TraceStore extends TraceSink {
  /** The turns held, oldest first, with the reviews group last when it has records. */
  turns(): readonly TraceTurn[];
  /** One turn's records in `seq` order, or every turn's. Messages are by id: see {@link TraceStore.message}. */
  records(turnId?: string): readonly TraceRecord[];
  /** A message a request lists. Absent when its turn was dropped. */
  message(id: string): TraceMessage | undefined;
  toJsonl(options?: TraceExportOptions): string;
  clear(): void;
  /** Serialised bytes held now. */
  readonly bytes: number;
  /** Told after every write and clear, so a view can redraw. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface TraceStoreOptions {
  readonly sessionId: string;
  readonly maxTurns?: number;
  readonly maxBytes?: number;
  readonly recordCap?: number;
  /** Named in the header of an export. */
  readonly app?: string;
  readonly project?: () => string;
}

/* ------------------------------------------------------------------ *
 * Redaction and the per-record cap
 * ------------------------------------------------------------------ */

const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text).length;

interface Leaf {
  readonly parent: Record<string, unknown> | unknown[];
  readonly key: string | number;
  readonly length: number;
}

function leavesOf(value: unknown, out: Leaf[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, key) => {
      if (typeof item === 'string') out.push({ parent: value, key, length: item.length });
      else leavesOf(item, out);
    });
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string') out.push({ parent: value, key, length: item.length });
      else leavesOf(item, out);
    }
  }
}

/** The text with `drop` characters cut from its end, never leaving half a surrogate pair. */
function cutEnd(text: string, drop: number): string {
  let end = Math.max(0, text.length - drop);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, Math.max(0, end));
}

/**
 * Cuts the longest texts of a record until it serialises within `cap`, and returns how many characters it cut. The record must be
 * one this module owns (a copy), since it is edited in place.
 */
function fit(record: Record<string, unknown>, cap: number): number {
  let size = bytesOf(JSON.stringify(record));
  if (size <= cap) return 0;
  const leaves: Leaf[] = [];
  leavesOf(record, leaves);
  leaves.sort((a, b) => b.length - a.length);
  let cut = 0;
  for (const leaf of leaves) {
    if (size <= cap) break;
    const parent = leaf.parent as Record<string | number, unknown>;
    const text = parent[leaf.key] as string;
    const next = cutEnd(text, size - cap);
    cut += text.length - next.length;
    size -= text.length - next.length;
    parent[leaf.key] = next;
  }
  return cut;
}

const utf8 = (value: unknown): number => bytesOf(JSON.stringify(value) ?? '');

/* ------------------------------------------------------------------ *
 * Omitting text
 * ------------------------------------------------------------------ */

const omit = (text: string): Omitted => ({ omitted: { chars: text.length } });
const omitAny = (value: unknown): Omitted => omit(typeof value === 'string' ? value : (JSON.stringify(value) ?? ''));
const omitText = (text: Text): Text => (typeof text === 'string' ? omit(text) : text);

function omitParams(params: Readonly<Record<string, unknown>>): Record<string, Omitted> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, omitAny(value)]));
}

function omitCalls(calls: readonly TraceToolCall[]): TraceToolCall[] {
  return calls.map((call) => ({ id: call.id, name: call.name, argumentsJson: omitText(call.argumentsJson) }));
}

/** A message with its texts left out. Exported for the tests. */
export function omitMessage(message: TraceMessage): TraceMessage {
  return {
    role: message.role,
    content: omitText(message.content),
    ...(message.toolCalls === undefined ? {} : { toolCalls: omitCalls(message.toolCalls) }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(message.isError === undefined ? {} : { isError: message.isError }),
    ...(message.reasoning === undefined ? {} : { reasoning: message.reasoning.map((block) => ({ text: omitText(block.text), ...(block.bytes === undefined ? {} : { bytes: block.bytes }) })) }),
  };
}

/**
 * The report with only its structure: statuses, tool names, outcomes, counts and the numbers of the meter. A report's texts
 * (reply, summary, step results, questions, notes) and every tool parameter value are stubs.
 */
function omitReport(report: TurnReport): Record<string, unknown> {
  return {
    turnId: report.turnId,
    status: report.status,
    summary: omit(report.summary),
    ...(report.text === undefined ? {} : { text: omit(report.text) }),
    steps: report.steps.map((step) => ({ index: step.index, tool: step.tool, status: step.status })),
    cards: report.cards,
    trace: report.trace.map((row) => ({
      tool: row.tool,
      callId: row.callId,
      outcome: row.outcome,
      ...(row.code === undefined ? {} : { code: row.code }),
      ...(row.agentPath === undefined ? {} : { agentPath: row.agentPath }),
      params: omitParams(row.params),
    })),
    ...(report.undoGroupId === undefined ? {} : { undoGroupId: report.undoGroupId }),
    ...(report.askBack === undefined ? {} : { askBack: omitAny(report.askBack) }),
    tokens: report.tokens,
    dropped: report.dropped.map(omit),
    modelCalls: report.modelCalls,
    ...(report.stop === undefined ? {} : { stop: report.stop }),
    ...(report.budgetStop === undefined ? {} : { budgetStop: report.budgetStop }),
    ...(report.spend === undefined ? {} : { spend: report.spend }),
    ...(report.steering === undefined ? {} : { steering: report.steering.map((note) => ({ noteId: note.noteId, text: omit(note.text), ...(note.deliveredAtCall === undefined ? {} : { deliveredAtCall: note.deliveredAtCall }) })) }),
    mode: report.mode,
    budgetUse: report.budgetUse,
    ...(report.heldSteps === undefined ? {} : { heldSteps: report.heldSteps.length }),
    ...(report.command === undefined ? {} : { command: report.command }),
  };
}

/** A record with its texts left out (see the module header for what stays). Exported for the tests. */
export function omitRecord(record: TraceRecord): TraceRecord {
  switch (record.kind) {
    case 'header':
      return { ...record, project: { name: omitText(record.project.name) } };
    case 'turn.start':
      return { ...record, intent: omitText(record.intent) };
    case 'message':
      return { ...record, message: omitMessage(record.message) };
    case 'model.response':
      return {
        ...record,
        content: omitText(record.content),
        ...(record.reasoningText === undefined ? {} : { reasoningText: omitText(record.reasoningText) }),
        ...(record.toolCalls === undefined ? {} : { toolCalls: omitCalls(record.toolCalls) }),
      };
    case 'context':
      return { ...record, dropped: record.dropped.map(omitText) };
    case 'tool.call':
      return { ...record, params: omitParams(record.params) };
    case 'tool.result': {
      const { body, ...rest } = record;
      return body === undefined ? record : { ...rest, body: omitAny(body) };
    }
    case 'ladder':
      return { ...record, reason: omitText(record.reason) };
    case 'turn.end':
      return { ...record, report: omitReport(record.report as TurnReport) };
    default:
      return record;
  }
}

/* ------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------ */

interface Bucket {
  readonly turnId: string;
  intent: string;
  readonly records: TraceRecord[];
  readonly messageIds: Set<string>;
  bytes: number;
  startedAt: number;
  lastSeq: number;
}

interface Stored {
  readonly record: MessageRecord;
  /** The canonical form it is found by. */
  readonly form: string;
  readonly bytes: number;
  refs: number;
}

const GROUP_RECORDS = (record: { readonly turnId?: string }): string => record.turnId ?? TRACE_REVIEWS;

function messageOf(message: ChatMessage): TraceMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls === undefined || message.toolCalls.length === 0
      ? {}
      : { toolCalls: message.toolCalls.map((call) => ({ id: call.id, name: call.name, argumentsJson: call.argumentsJson })) }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(message.isError === undefined ? {} : { isError: message.isError }),
    ...(message.reasoning === undefined || message.reasoning.length === 0
      ? {}
      : { reasoning: message.reasoning.map((block) => ({ text: block.text, ...(block.raw === undefined ? {} : { bytes: rawBytes(block.raw) }) })) }),
  };
}

function rawBytes(raw: unknown): number {
  try {
    return utf8(raw);
  } catch {
    return 0;
  }
}

export function createTraceStore(options: TraceStoreOptions): TraceStore {
  const maxTurns = options.maxTurns ?? TRACE_MAX_TURNS;
  const maxBytes = options.maxBytes ?? TRACE_MAX_BYTES;
  const recordCap = options.recordCap ?? TRACE_RECORD_CAP;
  const buckets = new Map<string, Bucket>();
  const messages = new Map<string, Stored>();
  const idsByForm = new Map<string, string>();
  const listeners = new Set<() => void>();
  let seq = 0;
  let total = 0;
  let nextMessage = 1;
  /** The turn most recently started: the one eviction never drops, so the latest turn is always viewable. */
  let current: string | undefined;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const bucketOf = (turnId: string, at: number): Bucket => {
    let bucket = buckets.get(turnId);
    if (bucket === undefined) {
      bucket = { turnId, intent: '', records: [], messageIds: new Set(), bytes: 0, startedAt: at, lastSeq: 0 };
      buckets.set(turnId, bucket);
    }
    return bucket;
  };

  const drop = (bucket: Bucket): void => {
    buckets.delete(bucket.turnId);
    total -= bucket.bytes;
    for (const id of bucket.messageIds) {
      const stored = messages.get(id);
      if (stored === undefined) continue;
      stored.refs -= 1;
      if (stored.refs <= 0) {
        messages.delete(id);
        idsByForm.delete(stored.form);
        total -= stored.bytes;
      }
    }
  };

  const evict = (): void => {
    while (buckets.size > maxTurns || total > maxBytes) {
      let oldest: Bucket | undefined;
      for (const bucket of buckets.values()) {
        if (bucket.turnId === current) continue;
        if (oldest === undefined || bucket.lastSeq < oldest.lastSeq) oldest = bucket;
      }
      if (oldest === undefined) return;
      drop(oldest);
    }
  };

  /** Stores a message once and returns its id. */
  const intern = (message: ChatMessage, at: number, bucket: Bucket): string => {
    const clean = redactDeep(messageOf(message));
    const form = canonicalJson(clean);
    let id = idsByForm.get(form);
    if (id === undefined) {
      id = `m${nextMessage}`;
      nextMessage += 1;
      seq += 1;
      const cut = fit(clean as unknown as Record<string, unknown>, recordCap);
      const record: MessageRecord = { v: TRACE_VERSION, seq, at, sessionId: options.sessionId, kind: 'message', id, message: clean, ...(cut > 0 ? { truncated: { chars: cut } } : {}) };
      const bytes = utf8(record);
      messages.set(id, { record, form, bytes, refs: 0 });
      idsByForm.set(form, id);
      total += bytes;
    }
    if (!bucket.messageIds.has(id)) {
      bucket.messageIds.add(id);
      const stored = messages.get(id);
      if (stored !== undefined) stored.refs += 1;
    }
    return id;
  };

  const write = (input: TraceInput): void => {
    const group = GROUP_RECORDS(input);
    const bucket = bucketOf(group, input.at);
    let draft: Record<string, unknown>;
    if (input.kind === 'model.request') {
      const ids = input.messages.map((message) => intern(message, input.at, bucket));
      draft = redactDeep({ ...input, messages: ids }) as Record<string, unknown>;
    } else {
      draft = redactDeep({ ...input }) as Record<string, unknown>;
    }
    if (input.kind === 'turn.start') {
      current = group;
      bucket.intent = String(draft['intent']);
      bucket.startedAt = input.at;
    }
    const cut = fit(draft, recordCap);
    seq += 1;
    const record = { v: TRACE_VERSION, seq, sessionId: options.sessionId, ...draft, ...(cut > 0 ? { truncated: { chars: cut } } : {}) } as unknown as TraceRecord;
    const bytes = utf8(record);
    bucket.records.push(record);
    bucket.bytes += bytes;
    bucket.lastSeq = seq;
    total += bytes;
    evict();
    notify();
  };

  const bucketsInOrder = (): Bucket[] => {
    const all = [...buckets.values()];
    return [...all.filter((bucket) => bucket.turnId !== TRACE_REVIEWS), ...all.filter((bucket) => bucket.turnId === TRACE_REVIEWS)];
  };

  const records = (turnId?: string): readonly TraceRecord[] => {
    const wanted = turnId === undefined ? bucketsInOrder() : [buckets.get(turnId)].filter((bucket): bucket is Bucket => bucket !== undefined);
    return wanted.flatMap((bucket) => bucket.records).sort((a, b) => a.seq - b.seq);
  };

  const toJsonl = (exportOptions: TraceExportOptions = {}): string => {
    const chosen = records(exportOptions.turnId);
    const lines: TraceRecord[] = [];
    const sent = new Set<string>();
    const first = chosen[0];
    lines.push({
      v: TRACE_VERSION,
      seq: 0,
      at: first?.at ?? 0,
      sessionId: options.sessionId,
      kind: 'header',
      format: TRACE_FORMAT,
      app: options.app ?? 'caotang',
      project: { name: options.project?.() ?? '' },
    });
    const referenced = new Map<string, Stored>();
    for (const record of chosen) {
      if (record.kind !== 'model.request') continue;
      for (const id of record.messages) {
        const stored = messages.get(id);
        if (stored !== undefined) referenced.set(id, stored);
      }
    }
    // A message goes out ahead of the first record that follows its own seq, so the file stays in seq order.
    const pending = [...referenced.values()].map((stored) => stored.record).sort((a, b) => a.seq - b.seq);
    for (const record of chosen) {
      while (pending.length > 0 && (pending[0] as MessageRecord).seq < record.seq) {
        const message = pending.shift() as MessageRecord;
        if (!sent.has(message.id)) lines.push(message);
        sent.add(message.id);
      }
      lines.push(record);
    }
    for (const message of pending) if (!sent.has(message.id)) lines.push(message);
    const body = exportOptions.omitText === true ? lines.map(omitRecord) : lines;
    return body.map((record) => `${JSON.stringify(record)}\n`).join('');
  };

  return {
    write,
    turns: () =>
      bucketsInOrder().map((bucket) => ({ turnId: bucket.turnId, intent: bucket.intent, bytes: bucket.bytes, records: bucket.records.length, startedAt: bucket.startedAt })),
    records,
    message: (id) => messages.get(id)?.record.message,
    toJsonl,
    clear: () => {
      buckets.clear();
      messages.clear();
      idsByForm.clear();
      total = 0;
      current = undefined;
      notify();
    },
    get bytes() {
      return total;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/* ------------------------------------------------------------------ *
 * The gateway's side
 * ------------------------------------------------------------------ */

/**
 * The observer to give `createGateway({ observe })`: it turns a call's events into `model.request` and `model.response` records.
 * The request is written when it is made, so a call still in flight is already in the trace; its response carries the attempts, the
 * time to first token and the usage. Cut off from the store by a `try`: a sink that throws cannot reach the gateway.
 */
export function traceGateway(sink: TraceSink): (event: GatewayTraceEvent) => void {
  interface Open {
    readonly turnId?: string;
    readonly callIndex?: number;
    readonly agentPath?: string;
    firstTokenAt?: number;
    readonly tries: TraceTry[];
  }
  const open = new Map<number, Open>();
  return (event) => {
    if (event.type === 'request') {
      const { req } = event;
      const call: Open = {
        ...(req.turnId === undefined ? {} : { turnId: req.turnId }),
        ...(req.callIndex === undefined ? {} : { callIndex: req.callIndex }),
        ...(req.agentPath === undefined ? {} : { agentPath: req.agentPath }),
        tries: [],
      };
      open.set(event.id, call);
      sink.write({
        kind: 'model.request',
        at: event.at,
        callId: event.id,
        ...(call.turnId === undefined ? {} : { turnId: call.turnId }),
        ...(call.callIndex === undefined ? {} : { callIndex: call.callIndex }),
        ...(call.agentPath === undefined ? {} : { agentPath: call.agentPath }),
        profileId: event.profileId,
        ...(event.preset === undefined ? {} : { preset: event.preset }),
        'gen_ai.request.model': event.model,
        ...(req.role === undefined ? {} : { role: req.role }),
        ...(req.thinking === undefined ? {} : { thinking: req.thinking }),
        messages: req.messages,
        ...(req.tools === undefined || req.tools.length === 0 ? {} : { tools: req.tools.map((tool) => ({ name: tool.name })) }),
        ...(req.responseFormat === undefined ? {} : { responseFormat: req.responseFormat === 'text' ? ('text' as const) : ('json' as const) }),
      });
      return;
    }
    const call = open.get(event.id);
    if (call === undefined) return;
    if (event.type === 'first-token') {
      call.firstTokenAt = event.at;
    } else if (event.type === 'attempt') {
      call.tries.push({ attempt: event.attempt, outcome: event.outcome, ...(event.status === undefined ? {} : { status: event.status }), ...(event.errorKind === undefined ? {} : { errorKind: event.errorKind }), at: event.at });
    } else {
      open.delete(event.id);
      sink.write({
        kind: 'model.response',
        at: event.at,
        callId: event.id,
        ...(call.turnId === undefined ? {} : { turnId: call.turnId }),
        ...(call.callIndex === undefined ? {} : { callIndex: call.callIndex }),
        ...(call.agentPath === undefined ? {} : { agentPath: call.agentPath }),
        ...(call.firstTokenAt === undefined ? {} : { firstTokenAt: call.firstTokenAt }),
        finishedAt: event.at,
        attempts: event.attempts,
        tries: call.tries,
        'gen_ai.response.finish_reasons': [event.finishReason],
        content: event.content,
        ...(event.reasoningText === '' ? {} : { reasoningText: event.reasoningText }),
        ...(event.reasoning === undefined || event.reasoning.length === 0 ? {} : { reasoningBlocks: event.reasoning.map((block) => ({ bytes: block.raw === undefined ? 0 : rawBytes(block.raw) })) }),
        ...(event.toolCalls === undefined || event.toolCalls.length === 0 ? {} : { toolCalls: event.toolCalls.map((tool) => ({ id: tool.id, name: tool.name, argumentsJson: tool.argumentsJson })) }),
        'gen_ai.usage.input_tokens': event.usage.promptTokens,
        'gen_ai.usage.output_tokens': event.usage.completionTokens,
        usageSource: event.usageSource,
        ...(event.error === undefined ? {} : { error: event.error }),
      });
    }
  };
}

/* ------------------------------------------------------------------ *
 * Reading a trace back
 * ------------------------------------------------------------------ */

const KINDS: readonly TraceKind[] = ['header', 'turn.start', 'message', 'model.request', 'model.response', 'context', 'tool.call', 'tool.result', 'card', 'ladder', 'turn.end'];

type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'text' | 'any';

/** The fields each kind must carry, and their types: what `trace.schema.json` lists as `required`. `text` is a string or an `omitted` stub. */
export const REQUIRED_FIELDS: Readonly<Record<TraceKind, Readonly<Record<string, FieldType>>>> = {
  header: { format: 'string', app: 'string', project: 'object' },
  'turn.start': { turnId: 'string', intent: 'text' },
  message: { id: 'string', message: 'object' },
  'model.request': { callId: 'number', profileId: 'string', 'gen_ai.request.model': 'string', messages: 'array' },
  'model.response': {
    callId: 'number',
    finishedAt: 'number',
    attempts: 'number',
    tries: 'array',
    'gen_ai.response.finish_reasons': 'array',
    content: 'text',
    'gen_ai.usage.input_tokens': 'number',
    'gen_ai.usage.output_tokens': 'number',
    usageSource: 'string',
  },
  context: { turnId: 'string', callIndex: 'number', layers: 'array', dropped: 'array' },
  'tool.call': { turnId: 'string', callId: 'string', tool: 'string', risk: 'string', params: 'object' },
  'tool.result': { turnId: 'string', callId: 'string', outcome: 'string', finishedAt: 'number' },
  card: { turnId: 'string', card: 'object' },
  ladder: { turnId: 'string', callId: 'string', attempt: 'number', reason: 'text' },
  'turn.end': { turnId: 'string', report: 'object' },
};

function typeOk(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'string':
    case 'number':
    case 'boolean':
      return typeof value === type;
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'text':
      return typeof value === 'string' || (isRecord(value) && isRecord(value['omitted']) && typeof value['omitted']['chars'] === 'number');
    default:
      return true;
  }
}

/**
 * Reads a trace file. The first line must be a header in a format this build reads: a different major version is refused, not guessed
 * at. A line of a kind this build does not know is skipped, so a newer minor version still opens; a line of a known kind that lacks
 * a field it must carry is an error, with its line number. Replay (#82) and the golden tasks (#83) read through here.
 */
export function parseTrace(jsonl: string): Result<readonly TraceRecord[], string> {
  const out: TraceRecord[] = [];
  let line = 0;
  let begin = 0;
  while (begin < jsonl.length) {
    let end = jsonl.indexOf('\n', begin);
    if (end < 0) end = jsonl.length;
    const text = jsonl.slice(begin, end).trim();
    begin = end + 1;
    line += 1;
    if (text === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, error: `line ${line} is not JSON` };
    }
    if (!isRecord(value) || typeof value['kind'] !== 'string') return { ok: false, error: `line ${line} is not a trace record` };
    if (out.length === 0) {
      if (value['kind'] !== 'header') return { ok: false, error: 'the first line is not a trace header' };
      if (value['v'] !== TRACE_VERSION || value['format'] !== TRACE_FORMAT) {
        return { ok: false, error: `this trace is ${String(value['format'])} (record version ${String(value['v'])}), and this build reads ${TRACE_FORMAT}` };
      }
    }
    const kind = value['kind'] as TraceKind;
    if (!KINDS.includes(kind)) continue;
    if (typeof value['seq'] !== 'number' || typeof value['at'] !== 'number' || typeof value['sessionId'] !== 'string') {
      return { ok: false, error: `line ${line} (${kind}) lacks seq, at or sessionId` };
    }
    for (const [field, type] of Object.entries(REQUIRED_FIELDS[kind])) {
      if (!typeOk(value[field], type)) return { ok: false, error: `line ${line} (${kind}) lacks ${field}, or it is not a ${type}` };
    }
    out.push(value as unknown as TraceRecord);
  }
  if (out.length === 0) return { ok: false, error: 'the trace is empty' };
  return { ok: true, value: out };
}
