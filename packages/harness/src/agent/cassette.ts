/**
 * Cassettes: recorded model responses, replayed through the mock gateway (agent-harness §9, provider-gateway §8).
 *
 * A cassette is line-delimited JSON: one `header` record, then one `exchange` record per model request, in the order the turn
 * made them. An exchange holds the request as Caotang sent it (messages, tools, response format; tool-call ids numbered
 * `call_<n>` by position) beside its `key`, and the response the model gave. Replay answers a request by its key and fails
 * with a readable diff when no recorded request matches, so a prompt, a tool description or a context change that alters what a
 * model would be sent is flagged, reviewed and re-recorded on purpose.
 *
 * The key is the sha256 of the canonical JSON of the request's messages, tools and response format. It leaves out the model, the
 * temperature, the turn id, the task role and every other knob, or re-pinning a model id would break every cassette.
 *
 * A cassette is data and is never executed. `parseCassette` checks a size cap, every record's shape and the key of every exchange,
 * and refuses an unknown record kind or anything that looks like a credential. `serializeCassette` scrubs the keys it is given
 * and the shape of a credential, then reads its own output back through `parseCassette`, so what it writes is what a load accepts.
 *
 * This module is the minimal, self-contained form of what #76 (the trace record format) and #82 (`requestKey`, cassette scripts)
 * will own: when they land, their key and format replace these, and the names here are the ones to absorb. Nothing outside tests
 * and eval tooling imports it, and it uses `node:crypto`, so it is not part of the app bundle.
 */

import { createHash } from 'node:crypto';

import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore, redact, type ChatRequest, type Gateway } from '@caotang/gateway';
import { createMockProvider, type MockResponse, type MockScript } from '@caotang/gateway/mock';

import { canonicalJson } from '../util.js';

export const CASSETTE_FORMAT = 'caotang.trace/1';

/** The most a cassette file may hold. A planner request is about 20 KB, so this is room for hundreds. */
export const CASSETTE_MAX_BYTES = 4 * 1024 * 1024;

export interface CassetteHeader {
  readonly kind: 'header';
  readonly format: typeof CASSETTE_FORMAT;
  /** The golden task this cassette belongs to. */
  readonly task: string;
  readonly preset: string;
  /** The model that answered, or `synthetic` for a hand-authored response. */
  readonly model: string;
  /** True for a response a person wrote, never a model's. Such a cassette proves the harness and the prompts, and says nothing about a model. */
  readonly synthetic?: true;
  readonly recordedAt: string;
  /** The sha256 of the prompt manifest the recording was made against. Informational: it is not checked on replay. */
  readonly promptManifest: string;
}

export interface CanonicalMessage {
  readonly role: string;
  readonly content: string;
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly argumentsJson: string }[];
  readonly toolCallId?: string;
  readonly isError?: true;
}

/** The part of a request that decides its key, with tool-call ids numbered by position. */
export interface CanonicalRequest {
  readonly messages: readonly CanonicalMessage[];
  readonly tools?: readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[];
  readonly responseFormat?: 'text' | { readonly jsonSchemaHint: unknown };
}

export interface CassetteResponse {
  readonly content: string;
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly argumentsJson: string }[];
  readonly finishReason?: 'stop' | 'length' | 'error' | 'tool_calls';
  /** A scripted failure the provider raised instead of answering. */
  readonly error?: { readonly kind: string; readonly status?: number; readonly detail?: string; readonly message?: string };
}

export interface CassetteExchange {
  readonly kind: 'exchange';
  readonly key: string;
  readonly request: CanonicalRequest;
  readonly response: CassetteResponse;
}

export interface Cassette {
  readonly header: CassetteHeader;
  readonly exchanges: readonly CassetteExchange[];
}

export class CassetteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CassetteError';
  }
}

/* ------------------------------------------------------------------ *
 * The key.
 * ------------------------------------------------------------------ */

/** A request reduced to what the key covers. Tool-call ids become `call_1`, `call_2`, ... in order of first appearance. */
export function canonicalRequest(request: ChatRequest): CanonicalRequest {
  const ids = new Map<string, string>();
  const named = (id: string): string => {
    let found = ids.get(id);
    if (found === undefined) {
      found = `call_${ids.size + 1}`;
      ids.set(id, found);
    }
    return found;
  };
  const messages = request.messages.map((message): CanonicalMessage => ({
    role: message.role,
    content: message.content,
    ...(message.toolCalls === undefined || message.toolCalls.length === 0
      ? {}
      : { toolCalls: message.toolCalls.map((call) => ({ id: named(call.id), name: call.name, argumentsJson: call.argumentsJson })) }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: named(message.toolCallId) }),
    ...(message.isError === true ? { isError: true as const } : {}),
  }));
  return {
    messages,
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }),
    ...(request.responseFormat === undefined ? {} : { responseFormat: request.responseFormat }),
  };
}

export const keyOfCanonical = (request: CanonicalRequest): string => createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');

/** The key of a request: stable across model, temperature, turn id, task role and the ids a provider gave its tool calls. */
export const requestKey = (request: ChatRequest): string => keyOfCanonical(canonicalRequest(request));

/* ------------------------------------------------------------------ *
 * Loading.
 * ------------------------------------------------------------------ */

const FINISH_REASONS: ReadonlySet<string> = new Set(['stop', 'length', 'error', 'tool_calls']);
const HEX64 = 64;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The keys of `value` that are not in `allowed`: a record with one is refused, so a cassette cannot smuggle fields past the schema. */
function stray(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

function isHex64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== HEX64) return false;
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
  }
  return true;
}

function callsOf(value: unknown, where: string): readonly { id: string; name: string; argumentsJson: string }[] {
  if (!Array.isArray(value)) throw new CassetteError(`${where}: toolCalls must be a list`);
  return value.map((call, index) => {
    if (!isObject(call) || typeof call['id'] !== 'string' || typeof call['name'] !== 'string' || typeof call['argumentsJson'] !== 'string' || stray(call, ['id', 'name', 'argumentsJson']) !== undefined) {
      throw new CassetteError(`${where}: tool call ${index + 1} must hold exactly an id, a name and argumentsJson as strings`);
    }
    return { id: call['id'], name: call['name'], argumentsJson: call['argumentsJson'] };
  });
}

function requestOf(value: unknown, where: string): CanonicalRequest {
  if (!isObject(value) || stray(value, ['messages', 'tools', 'responseFormat']) !== undefined || !Array.isArray(value['messages'])) {
    throw new CassetteError(`${where}: request must hold messages, and at most tools and responseFormat`);
  }
  const messages = value['messages'].map((message, index): CanonicalMessage => {
    const at = `${where}: message ${index + 1}`;
    if (!isObject(message) || typeof message['role'] !== 'string' || typeof message['content'] !== 'string') throw new CassetteError(`${at} must hold a role and content as strings`);
    const extra = stray(message, ['role', 'content', 'toolCalls', 'toolCallId', 'isError']);
    if (extra !== undefined) throw new CassetteError(`${at} holds an unknown field "${extra}"`);
    if (message['toolCallId'] !== undefined && typeof message['toolCallId'] !== 'string') throw new CassetteError(`${at}: toolCallId must be a string`);
    if (message['isError'] !== undefined && message['isError'] !== true) throw new CassetteError(`${at}: isError must be true when present`);
    return {
      role: message['role'],
      content: message['content'],
      ...(message['toolCalls'] === undefined ? {} : { toolCalls: callsOf(message['toolCalls'], at) }),
      ...(message['toolCallId'] === undefined ? {} : { toolCallId: message['toolCallId'] as string }),
      ...(message['isError'] === true ? { isError: true as const } : {}),
    };
  });
  let tools: CanonicalRequest['tools'];
  if (value['tools'] !== undefined) {
    if (!Array.isArray(value['tools'])) throw new CassetteError(`${where}: tools must be a list`);
    tools = value['tools'].map((tool, index) => {
      if (!isObject(tool) || typeof tool['name'] !== 'string' || typeof tool['description'] !== 'string' || stray(tool, ['name', 'description', 'parameters']) !== undefined) {
        throw new CassetteError(`${where}: tool ${index + 1} must hold a name, a description and parameters`);
      }
      return { name: tool['name'], description: tool['description'], parameters: tool['parameters'] };
    });
  }
  let responseFormat: CanonicalRequest['responseFormat'];
  if (value['responseFormat'] !== undefined) {
    const format = value['responseFormat'];
    if (format === 'text') responseFormat = 'text';
    else if (isObject(format) && 'jsonSchemaHint' in format && Object.keys(format).length === 1) responseFormat = { jsonSchemaHint: format['jsonSchemaHint'] };
    else throw new CassetteError(`${where}: responseFormat must be "text" or {jsonSchemaHint}`);
  }
  return { messages, ...(tools === undefined ? {} : { tools }), ...(responseFormat === undefined ? {} : { responseFormat }) };
}

function responseOf(value: unknown, where: string): CassetteResponse {
  if (!isObject(value) || typeof value['content'] !== 'string') throw new CassetteError(`${where}: response must hold content as a string`);
  const extra = stray(value, ['content', 'toolCalls', 'finishReason', 'error']);
  if (extra !== undefined) throw new CassetteError(`${where}: response holds an unknown field "${extra}"`);
  if (value['finishReason'] !== undefined && !FINISH_REASONS.has(String(value['finishReason']))) throw new CassetteError(`${where}: finishReason is not one of stop, length, error, tool_calls`);
  let error: CassetteResponse['error'];
  if (value['error'] !== undefined) {
    const raw = value['error'];
    if (!isObject(raw) || typeof raw['kind'] !== 'string' || stray(raw, ['kind', 'status', 'detail', 'message']) !== undefined) throw new CassetteError(`${where}: error must hold a kind, and at most status, detail and message`);
    for (const field of ['detail', 'message'] as const) if (raw[field] !== undefined && typeof raw[field] !== 'string') throw new CassetteError(`${where}: error ${field} must be a string`);
    if (raw['status'] !== undefined && typeof raw['status'] !== 'number') throw new CassetteError(`${where}: error status must be a number`);
    error = {
      kind: raw['kind'],
      ...(raw['status'] === undefined ? {} : { status: raw['status'] as number }),
      ...(raw['detail'] === undefined ? {} : { detail: raw['detail'] as string }),
      ...(raw['message'] === undefined ? {} : { message: raw['message'] as string }),
    };
  }
  return {
    content: value['content'],
    ...(value['toolCalls'] === undefined ? {} : { toolCalls: callsOf(value['toolCalls'], where) }),
    ...(value['finishReason'] === undefined ? {} : { finishReason: value['finishReason'] as NonNullable<CassetteResponse['finishReason']> }),
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * Reads a cassette, strictly. Refused, naming the line: a file over the size cap, a line that is not JSON, a first record that is not
 * the header, a second header, a record kind this reader does not know, a field outside the schema, an exchange whose key is not the
 * key of the request it holds, and any text that looks like a credential.
 */
export function parseCassette(text: string): Cassette {
  if (text.length > CASSETTE_MAX_BYTES) throw new CassetteError(`the cassette is over ${CASSETTE_MAX_BYTES} bytes`);
  if (redact(text) !== text) throw new CassetteError('the cassette holds something that looks like a credential (a bearer token or an sk- key): it is not loaded');
  let header: CassetteHeader | undefined;
  const exchanges: CassetteExchange[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    const where = `line ${index + 1}`;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new CassetteError(`${where}: not JSON`);
    }
    if (!isObject(record) || typeof record['kind'] !== 'string') throw new CassetteError(`${where}: a record must be an object with a kind`);
    if (record['kind'] === 'header') {
      if (header !== undefined || exchanges.length > 0) throw new CassetteError(`${where}: the header must be the first record, and only one`);
      const extra = stray(record, ['kind', 'format', 'task', 'preset', 'model', 'synthetic', 'recordedAt', 'promptManifest']);
      if (extra !== undefined) throw new CassetteError(`${where}: the header holds an unknown field "${extra}"`);
      if (record['format'] !== CASSETTE_FORMAT) throw new CassetteError(`${where}: format must be ${CASSETTE_FORMAT}`);
      for (const field of ['task', 'preset', 'model', 'recordedAt', 'promptManifest'] as const) {
        if (typeof record[field] !== 'string' || record[field] === '') throw new CassetteError(`${where}: the header needs ${field} as a non-empty string`);
      }
      if (record['synthetic'] !== undefined && record['synthetic'] !== true) throw new CassetteError(`${where}: synthetic must be true when present`);
      if (record['model'] === 'synthetic' && record['synthetic'] !== true) throw new CassetteError(`${where}: a cassette whose model is "synthetic" must say synthetic: true`);
      header = {
        kind: 'header',
        format: CASSETTE_FORMAT,
        task: record['task'] as string,
        preset: record['preset'] as string,
        model: record['model'] as string,
        ...(record['synthetic'] === true ? { synthetic: true as const } : {}),
        recordedAt: record['recordedAt'] as string,
        promptManifest: record['promptManifest'] as string,
      };
    } else if (record['kind'] === 'exchange') {
      if (header === undefined) throw new CassetteError(`${where}: an exchange comes before the header`);
      const extra = stray(record, ['kind', 'key', 'request', 'response']);
      if (extra !== undefined) throw new CassetteError(`${where}: the exchange holds an unknown field "${extra}"`);
      if (!isHex64(record['key'])) throw new CassetteError(`${where}: key must be 64 lowercase hex digits`);
      const request = requestOf(record['request'], where);
      if (keyOfCanonical(request) !== record['key']) throw new CassetteError(`${where}: the key is not the key of the request beside it: the file was edited by hand, or a credential was scrubbed out of a request`);
      exchanges.push({ kind: 'exchange', key: record['key'], request, response: responseOf(record['response'], where) });
    } else {
      throw new CassetteError(`${where}: unknown record kind "${record['kind']}"`);
    }
  }
  if (header === undefined) throw new CassetteError('the cassette has no header');
  return { header, exchanges };
}

/**
 * The cassette as the text of a file. The given secrets and the shape of a credential are scrubbed from the text, which is then read
 * back through `parseCassette`: a credential in a request changes its key and is refused, and one in a response body is replaced.
 */
export function serializeCassette(cassette: Cassette, secrets: readonly string[] = []): string {
  const text = `${[cassette.header, ...cassette.exchanges].map((record) => JSON.stringify(record)).join('\n')}\n`;
  const scrubbed = redact(text, secrets);
  parseCassette(scrubbed);
  return scrubbed;
}

/* ------------------------------------------------------------------ *
 * Authoring: record the answers of scripts a person wrote.
 * ------------------------------------------------------------------ */

/** The exchange a script's answer makes. Only a plain response can be recorded: a streamed one has no single body. */
function exchangeOf(request: ChatRequest, answer: MockResponse | AsyncIterable<unknown>): CassetteExchange {
  if (Symbol.asyncIterator in answer) throw new CassetteError('a script that streams chunks cannot be recorded: answer with a plain response');
  const response = answer as MockResponse;
  const canonical = canonicalRequest(request);
  return {
    kind: 'exchange',
    key: keyOfCanonical(canonical),
    request: canonical,
    response: {
      content: response.content,
      ...(response.toolCalls === undefined || response.toolCalls.length === 0
        ? {}
        : { toolCalls: response.toolCalls.map((call, index) => ({ id: `call_${index + 1}`, name: call.name, argumentsJson: call.argumentsJson })) }),
      ...(response.finishReason === undefined ? {} : { finishReason: response.finishReason }),
      ...(response.error === undefined
        ? {}
        : { error: { kind: response.error.kind, ...(response.error.status === undefined ? {} : { status: response.error.status }), ...(response.error.detail === undefined ? {} : { detail: response.error.detail }), ...(response.error.message === undefined ? {} : { message: response.error.message }) } }),
    },
  };
}

/** Wraps the scripts of a task so each answer they give is kept as an exchange, in the order the turn asked. */
export function recordScripts(scripts: readonly MockScript[]): { readonly scripts: MockScript[]; readonly exchanges: CassetteExchange[] } {
  const exchanges: CassetteExchange[] = [];
  return {
    exchanges,
    scripts: scripts.map((script) => ({
      match: script.match,
      respond: (request, callIndex) => {
        const answer = script.respond(request, callIndex);
        exchanges.push(exchangeOf(request, answer));
        return answer;
      },
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Replay.
 * ------------------------------------------------------------------ */

const WINDOW = 48;

/** The text around an offset, on one line, so a diff names the words and not a position alone. */
function around(text: string, at: number): string {
  return JSON.stringify(text.slice(Math.max(0, at - WINDOW / 2), at + WINDOW));
}

/** Where two texts first differ, as a sentence that quotes both sides. */
function textDiff(recorded: string, current: string): string {
  let at = 0;
  while (at < recorded.length && at < current.length && recorded[at] === current[at]) at += 1;
  return `at character ${at}: recorded ${around(recorded, at)}, sent now ${around(current, at)}`;
}

/** What differs between a recorded request and the one now sent, for the failure message. */
export function requestDiff(recorded: CanonicalRequest, current: CanonicalRequest): string {
  const count = Math.max(recorded.messages.length, current.messages.length);
  for (let index = 0; index < count; index += 1) {
    const was = recorded.messages[index];
    const now = current.messages[index];
    if (was === undefined) return `the request now has ${current.messages.length} messages, the recording ${recorded.messages.length}; message ${index + 1} (${now?.role}) is new`;
    if (now === undefined) return `the request now has ${current.messages.length} messages, the recording ${recorded.messages.length}; message ${index + 1} (${was.role}) is gone`;
    if (was.role !== now.role) return `message ${index + 1} was a ${was.role} message and is now a ${now.role} message`;
    if (was.content !== now.content) return `message ${index + 1} (${now.role}) changed ${textDiff(was.content, now.content)}`;
    if (canonicalJson(was.toolCalls) !== canonicalJson(now.toolCalls) || was.toolCallId !== now.toolCallId) return `the tool calls of message ${index + 1} (${now.role}) changed`;
  }
  if (canonicalJson(recorded.tools) !== canonicalJson(current.tools)) {
    const names = (request: CanonicalRequest): string[] => (request.tools ?? []).map((tool) => tool.name);
    const was = names(recorded);
    const now = names(current);
    const moved = now.filter((name) => !was.includes(name)).concat(was.filter((name) => !now.includes(name)));
    return moved.length > 0 ? `the declared tools changed: ${moved.join(', ')}` : `a declared tool's description or parameters changed`;
  }
  return 'the response format changed';
}

export interface ReplayOptions {
  /** The command that records this cassette again, named in a key-miss message. */
  readonly rerecord: string;
  /** The file or name of the cassette, for the message. */
  readonly name?: string;
}

export interface Replay {
  readonly script: MockScript;
  /** One message per request that matched nothing, in order. A run that is clean has none. */
  readonly misses: string[];
  /** The recorded exchanges the turn never asked for. A stale cassette has some. */
  unused(): readonly CassetteExchange[];
}

/**
 * A script that answers each request with the recorded response of the first unused exchange with the same key. A request that
 * matches none gets a protocol error that carries the diff against the exchange recorded at that position, and the miss is noted.
 */
export function replayScript(cassette: Cassette, options: ReplayOptions): Replay {
  const used = new Set<number>();
  const misses: string[] = [];
  const script: MockScript = {
    match: () => true,
    respond: (request): MockResponse => {
      const current = canonicalRequest(request);
      const key = keyOfCanonical(current);
      const found = cassette.exchanges.findIndex((exchange, index) => !used.has(index) && exchange.key === key);
      if (found !== -1) {
        used.add(found);
        const { response } = cassette.exchanges[found] as CassetteExchange;
        return {
          content: response.content,
          ...(response.toolCalls === undefined ? {} : { toolCalls: response.toolCalls }),
          ...(response.finishReason === undefined ? {} : { finishReason: response.finishReason }),
          ...(response.error === undefined ? {} : { error: response.error as NonNullable<MockResponse['error']> }),
        };
      }
      const position = used.size;
      const next = cassette.exchanges.findIndex((_, index) => !used.has(index));
      const recorded = cassette.exchanges[next === -1 ? position : next];
      const why =
        recorded === undefined
          ? `the turn made request ${position + 1}, and the cassette holds only ${cassette.exchanges.length}`
          : `request ${position + 1} differs from the recorded one: ${requestDiff(recorded.request, current)}`;
      const message = `${options.name ?? cassette.header.task}: ${why}. Revert the change, or record again with ${options.rerecord} and review the cassette like a golden.`;
      misses.push(message);
      return { content: '', error: { kind: 'protocol', message } };
    },
  };
  return { script, misses, unused: () => cassette.exchanges.filter((_, index) => !used.has(index)) };
}

/** A real gateway over in-memory stores with a mock profile active and the given scripts answering: the gateway the product uses for a mock profile. */
export async function scriptedGateway(scripts: readonly MockScript[]): Promise<Gateway> {
  const clock = createManualClock(0);
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  await profiles.create({ name: 'Mock', kind: 'mock', isActive: true });
  return createGateway({ profiles, keys, clock, mock: createMockProvider({ scripts: [...scripts] }) });
}
