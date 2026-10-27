/**
 * `tool.search` — [extensibility.md §5](../../../docs/architecture/extensibility.md), the Tier-2
 * meta-tool: search-then-load. The search runs over the tools of healthy, enabled servers and
 * returns excerpts; the matched tools are loaded into the current turn, and only a loaded tool
 * can be called (see `invoke.ts`).
 *
 * This file exports the tool in the harness registry entry shape (`packages/harness/src/types.ts`),
 * as `packages/coherence/src/tools.ts` does for its three tools: a metadata row, a parameter
 * spec, and a handler. The JSON Schema is derived from `params` by the harness's own
 * `toJsonSchema` at registration, so this package does not import the harness.
 *
 * Determinism (§5, eval 2): the index lists the harness's deferred native rows first, in registry order, then servers in
 * their configured order and tools by name, so the same configuration gives the same answer on every run. There is no fuzzy
 * or semantic layer. Substring matching over the name, the description and a native row's keywords is adequate at this size.
 *
 * Deferral is about context, not trust (agent-harness §3): a native match is loaded for the turn so the planner declares it,
 * and an external match is loaded under its candidate hash, which is where its pin is bound.
 */

import type { CommandError, Result } from '@caotang/bus';
import { err, ok, param, type ObjectSpec } from '@caotang/bus';

import type { ExternalToolDescriptor, IndexedTools } from './client.js';
import { clipChars, hasOwn, isRecord } from './util.js';

export const TOOL_SEARCH_NAME = 'tool.search' as const;

/** §5: the excerpt cap. Shrinks the ambient poisoning surface; the full text still appears in the approval card. */
export const EXCERPT_CHARS = 200;

/** §5: the default and the ceiling for `limit`. */
export const SEARCH_LIMIT_DEFAULT = 8;
export const SEARCH_LIMIT_MAX = 20;

/** The longest query a call may carry. A query is a short phrase, not a document. */
export const QUERY_MAX = 200;

/** The mirror of the harness's `ToolMetadata` row, for a tool outside its closed `ToolName` set. */
export interface ExtensionToolMeta {
  readonly name: typeof TOOL_SEARCH_NAME;
  readonly risk: 'read';
  readonly undoable: false;
  readonly response_token_cap: number;
  readonly descriptionVersion: number;
  readonly description: string;
  readonly surface: 'extension';
  /** The gateway is always declared: the planner must always be able to search. */
  readonly load: 'core';
}

export const TOOL_SEARCH_META: ExtensionToolMeta = {
  name: TOOL_SEARCH_NAME,
  risk: 'read',
  undoable: false,
  response_token_cap: 2000,
  descriptionVersion: 2,
  description:
    "Search the tools that are not listed up front: Caotang's own deferred tools by name, and the tools of connected external servers that are enabled and reviewed. Read-only. A matched tool is loaded for this turn and can then be called by its name (an external tool by its qualified name). Caotang's own tools come first. An empty query lists the first matches in a fixed order. At most 20 matches per call, each with a short excerpt.",
  surface: 'extension',
  load: 'core',
};

/**
 * The parameter spec, in the subset of the harness's `ParamSpec` this tool uses (the same mirror
 * `coherence/src/tools.ts` declares). The harness reads it as-is at registration.
 */
export type ToolParamSpec =
  | { readonly kind: 'string'; readonly description: string; readonly nonBlank?: boolean; readonly maxLength?: number }
  | { readonly kind: 'integer'; readonly description: string; readonly minimum?: number; readonly maximum?: number }
  | { readonly kind: 'enum'; readonly description: string; readonly values: readonly string[] }
  | {
      readonly kind: 'object';
      readonly description: string;
      readonly properties: Readonly<Record<string, ToolParamSpec>>;
      readonly required: readonly string[];
    };

export type ToolParamsObject = Extract<ToolParamSpec, { kind: 'object' }>;

/**
 * The entry the harness reads, in the shape `coherence/src/tools.ts` uses for its port tools: a
 * `port` kind, because `tool.search` has no commands of its own, and the handler is {@link toolSearch}.
 * The port name joins the harness's closed set at integration.
 */
export interface ToolSearchEntry {
  readonly kind: 'port';
  readonly meta: ExtensionToolMeta;
  readonly params: ToolParamsObject;
  readonly port: typeof TOOL_SEARCH_NAME;
  /** What `data` holds on success. Closed: the gateway's answer is the one result the model reads in every turn that searches. */
  readonly result: ObjectSpec;
  readonly resultClosed: true;
}

export const TOOL_SEARCH_PARAMS: ToolParamsObject = {
  kind: 'object',
  description: 'What to search for.',
  properties: {
    query: {
      kind: 'string',
      description: 'A word or phrase to match against tool names, descriptions and topics. Empty lists the first matches.',
      maxLength: QUERY_MAX,
    },
    server: {
      kind: 'string',
      description: 'Limit the search to one external server, by its key (the s_ form shown in the server list). Native tools are then left out.',
      nonBlank: true,
    },
    risk: {
      kind: 'enum',
      description: "Limit to 'read' tools (run without a confirmation) or 'write' tools (each call asks the user).",
      values: ['read', 'write'],
    },
    limit: {
      kind: 'integer',
      description: `How many matches to return, from 1 to ${SEARCH_LIMIT_MAX}. Defaults to ${SEARCH_LIMIT_DEFAULT}.`,
      minimum: 1,
      maximum: SEARCH_LIMIT_MAX,
    },
  },
  required: ['query'],
};

/** What a search answers (`ToolSearchValue.data`): the matches, and the names the turn may now call. */
export const TOOL_SEARCH_RESULT = param.object(
  'The matches, and the names they surfaced.',
  {
    matches: param.list(
      "The matches, Caotang's own tools first.",
      param.object(
        'One match.',
        {
          source: param.choice('Whether the match is a Caotang tool or an external one.', ['native', 'external']),
          name: param.string('The registry name of a native match, the qualified name of an external one.'),
          serverKey: param.string('The key of the external server.'),
          serverName: param.string('The name of the external server.'),
          toolName: param.string('The name of the tool on its server.'),
          excerpt: param.string('A short excerpt of the description.'),
          risk: param.choice('Whether a call runs without a confirmation (read) or asks the user (write).', ['read', 'write']),
        },
        ['source', 'name', 'excerpt', 'risk'],
      ),
    ),
    surfaced: param.list('The names loaded for this turn.', param.string('A tool name.')),
  },
  ['matches', 'surfaced'],
);

/** The registry entry for `tool.search`, in the shape the harness reads. */
export const TOOL_SEARCH_ENTRY: ToolSearchEntry = {
  kind: 'port',
  meta: TOOL_SEARCH_META,
  params: TOOL_SEARCH_PARAMS,
  port: TOOL_SEARCH_NAME,
  result: TOOL_SEARCH_RESULT,
  resultClosed: true,
};

/**
 * A loaded tool. An external tool is loaded with the candidate hash it was shown under, so the call that follows can be bound
 * to the definition the turn saw (extensibility §4 rule 3, §6 `expectedPins`); a name loaded alone has none. A native row
 * is loaded by its registry name and has no pin: it is trusted code behind the same bus gate.
 */
export type LoadedTool =
  | { readonly source?: 'external'; readonly qualifiedName: string; readonly candidateHash?: string }
  | { readonly source: 'native'; readonly name: string };

const loadedKey = (tool: LoadedTool): string => (tool.source === 'native' ? tool.name : tool.qualifiedName);

/** Which tools a turn has loaded. One active turn at a time; `beginTurn` clears the set, as a turn ends with `endTurn`. */
export interface LoadedTools {
  beginTurn(turnId: string): void;
  endTurn(): void;
  /**
   * Loads tools for the turn. A search passes each external match with the hash it showed, and each native match as a native
   * entry; a bare string loads an external name without a hash. A name loaded again takes the newer entry, and a bare name
   * keeps the hash it already has.
   */
  load(tools: readonly (LoadedTool | string)[]): void;
  isLoaded(name: string): boolean;
  /** The candidate hash the tool was shown under when it was loaded, or undefined when it was loaded by name alone (or is native). */
  hashOf(name: string): string | undefined;
  /** The loaded tools, native and external, sorted by name. */
  entries(): readonly LoadedTool[];
  /** The loaded names, native and external, sorted. */
  names(): readonly string[];
  /** The registry names of the native rows loaded, sorted. */
  nativeNames(): readonly string[];
  readonly turnId: string | undefined;
}

export function createLoadedTools(): LoadedTools {
  let turn: string | undefined;
  let loaded = new Map<string, LoadedTool>();
  const sorted = (): LoadedTool[] => [...loaded.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, tool]) => tool);
  return {
    beginTurn(turnId) {
      turn = turnId;
      loaded = new Map();
    },
    endTurn() {
      turn = undefined;
      loaded = new Map();
    },
    load(tools) {
      for (const tool of tools) {
        const entry: LoadedTool = typeof tool === 'string' ? { qualifiedName: tool } : tool;
        const key = loadedKey(entry);
        const previous = loaded.get(key);
        const bare = entry.source !== 'native' && entry.candidateHash === undefined;
        loaded.set(key, bare && previous !== undefined ? previous : entry);
      }
    },
    isLoaded: (name) => loaded.has(name),
    hashOf(name) {
      const tool = loaded.get(name);
      return tool === undefined || tool.source === 'native' ? undefined : tool.candidateHash;
    },
    entries: sorted,
    names: () => sorted().map(loadedKey),
    nativeNames: () => sorted().flatMap((tool) => (tool.source === 'native' ? [tool.name] : [])),
    get turnId() {
      return turn;
    },
  };
}

/** The one-line L0 addendum (context-assembly §2) naming the tools loaded this turn. Undefined when none are. */
export function loadedAddendum(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  return `Tools loaded this turn, callable by name: ${names.join(', ')}.`;
}

export type SearchSource = 'native' | 'external';

/** A deferred native row as the index sees it: the harness builds these from its registry, so this package does not import it. */
export interface NativeIndexRow {
  readonly source: 'native';
  /** The registry name, e.g. `shots.derive`. No `mcp__` prefix. */
  readonly name: string;
  readonly description: string;
  /** The row's extra search terms (its module, synonyms). Matched, never shown. */
  readonly keywords: readonly string[];
  /** The same badge {@link riskBadge} gives an external tool. */
  readonly risk: 'read' | 'write';
}

export interface SearchMatch {
  readonly source: SearchSource;
  /** The registry name of a native match, the qualified name of an external one. */
  readonly name: string;
  readonly serverKey?: string;
  readonly serverName?: string;
  readonly toolName?: string;
  readonly excerpt: string;
  readonly risk: 'read' | 'write';
}

export interface ToolSearchValue {
  /** The JSON the model reads: the matches and the names surfaced. */
  readonly data: { readonly matches: readonly SearchMatch[]; readonly surfaced: readonly string[] };
  readonly summary: string;
  readonly notes: readonly string[];
  /**
   * The full descriptors of the external matches (§5). They are the loaded set's entries, and the harness reads them back from
   * the index (`loadedExternalTools`) to put each one's name, description and schema in front of the model for this turn. A
   * native match is read back from the registry (`loadedNativeTools`).
   */
  readonly surfaced: readonly ExternalToolDescriptor[];
}

export interface ToolSearchContext {
  readonly index: () => IndexedTools;
  /** The deferred native rows that can be called now, in registry order. Absent: none, so only external tools are searched. */
  readonly native?: () => readonly NativeIndexRow[];
  readonly loaded: LoadedTools;
}

type Candidate =
  | { readonly source: 'native'; readonly row: NativeIndexRow }
  | { readonly source: 'external'; readonly tool: ExternalToolDescriptor };

/** The handler. Refusals are `invalid-params`; an empty result, a server that is off, and an unhealthy server are results with notes. */
export function toolSearch(params: unknown, context: ToolSearchContext): Result<ToolSearchValue, CommandError> {
  const parsed = parseParams(params);
  if (!parsed.ok) return parsed;
  const { query, server, risk, limit } = parsed.value;

  const index = context.index();
  // Fixed order (§5, eval 2): native rows in registry order, then servers in connect order, then tool name. A server filter
  // names an external server, so it leaves the native rows out.
  const natives = server === undefined ? (context.native?.() ?? []) : [];
  let candidates: Candidate[] = [
    ...natives.map((row): Candidate => ({ source: 'native', row })),
    ...index.tools.filter((tool) => server === undefined || tool.serverKey === server).map((tool): Candidate => ({ source: 'external', tool })),
  ];
  if (risk !== undefined) candidates = candidates.filter((item) => (item.source === 'native' ? item.row.risk : riskBadge(item.tool)) === risk);
  const needle = query.trim().toLowerCase();
  if (needle !== '') {
    // Every word of the query must appear somewhere in the name, the description or a native row's keywords.
    const words = needle.split(/\s+/);
    candidates = candidates.filter((item) => {
      const haystack = (item.source === 'native' ? [item.row.name, item.row.description, ...item.row.keywords] : [item.tool.qualifiedName, item.tool.toolName, item.tool.description])
        .join('\n')
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }

  const picked = candidates.slice(0, limit);
  const notes: string[] = [...index.notes];
  if (candidates.length > picked.length) {
    notes.push(`${candidates.length - picked.length} more matched; narrow the query, or raise limit up to ${SEARCH_LIMIT_MAX}`);
  }
  if (server !== undefined && candidates.length === 0) {
    notes.push(`no searchable tool on server ${server}`);
  }

  // An external match is loaded under the candidate hash it is shown with, so a call that follows is bound to this definition.
  // A native match is loaded by its registry name.
  context.loaded.load(
    picked.map((item): LoadedTool => (item.source === 'native' ? { source: 'native', name: item.row.name } : { qualifiedName: item.tool.qualifiedName, candidateHash: item.tool.candidateHash })),
  );
  const matches: SearchMatch[] = picked.map((item) =>
    item.source === 'native'
      ? { source: 'native', name: item.row.name, excerpt: clipChars(item.row.description, EXCERPT_CHARS), risk: item.row.risk }
      : {
          source: 'external',
          name: item.tool.qualifiedName,
          serverKey: item.tool.serverKey,
          serverName: item.tool.serverName,
          toolName: item.tool.toolName,
          excerpt: clipChars(item.tool.description, EXCERPT_CHARS),
          risk: riskBadge(item.tool),
        },
  );
  const surfaced = matches.map((match) => match.name);

  const summary =
    picked.length === 0
      ? `no tool matched${needle === '' ? '' : ` '${query.trim()}'`}; re-search with terms from the task`
      : `loaded ${picked.length} tool${picked.length === 1 ? '' : 's'} for this turn: ${surfaced.join(', ')}`;

  return ok({
    data: { matches, surfaced },
    summary,
    notes,
    surfaced: picked.flatMap((item) => (item.source === 'external' ? [item.tool] : [])),
  });
}

/** The badge a model or a person reads: `read` for an auto-run tool, `write` for one that asks first. */
export function riskBadge(tool: Pick<ExternalToolDescriptor, 'effectiveRisk'>): 'read' | 'write' {
  return tool.effectiveRisk === 'read-auto' ? 'read' : 'write';
}

interface SearchParams {
  readonly query: string;
  readonly server: string | undefined;
  readonly risk: 'read' | 'write' | undefined;
  readonly limit: number;
}

const ACCEPTED_PARAMS = ['query', 'server', 'risk', 'limit'];

function parseParams(params: unknown): Result<SearchParams, CommandError> {
  const refuse = (message: string, correctiveHint: string): Result<never, CommandError> =>
    err({ code: 'invalid-params', message, target: TOOL_SEARCH_NAME, correctiveHint });
  if (!isRecord(params)) return refuse('tool.search takes an object of named parameters', 'send { "query": "…" }');
  const extra = Object.keys(params).find((key) => !ACCEPTED_PARAMS.includes(key));
  if (extra !== undefined) {
    return refuse(`"${extra}" is not a parameter of tool.search`, `accepted parameters: ${ACCEPTED_PARAMS.join(', ')}`);
  }
  if (!hasOwn(params, 'query') || typeof params['query'] !== 'string') {
    return refuse('"query" is required and must be a string', 'pass an empty string to list the first matches');
  }
  const query = params['query'];
  if (query.length > QUERY_MAX) return refuse(`"query" is longer than ${QUERY_MAX} characters`, 'search for fewer, shorter terms');
  let server: string | undefined;
  if (params['server'] !== undefined) {
    if (typeof params['server'] !== 'string' || params['server'].trim() === '') return refuse('"server" must be a server key', 'use the s_ key from the server list');
    server = params['server'];
  }
  let risk: 'read' | 'write' | undefined;
  if (params['risk'] !== undefined) {
    if (params['risk'] !== 'read' && params['risk'] !== 'write') return refuse('"risk" must be "read" or "write"', 'omit it to search both');
    risk = params['risk'];
  }
  let limit = SEARCH_LIMIT_DEFAULT;
  if (params['limit'] !== undefined) {
    const value = params['limit'];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > SEARCH_LIMIT_MAX) {
      return refuse(`"limit" must be an integer from 1 to ${SEARCH_LIMIT_MAX}`, `use a number from 1 to ${SEARCH_LIMIT_MAX}, or omit it`);
    }
    limit = value;
  }
  return ok({ query, server, risk, limit });
}
