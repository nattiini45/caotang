/**
 * Write-confirm across the MCP boundary — extensibility.md §9, and the MRTR shape of
 * the 2026-07-28 revision.
 *
 * A write-confirm tool is run only after the user has accepted a confirmation in the
 * host's own dialog. The server cannot draw that dialog. It asks for one by returning
 * an `input_required` result with an embedded elicitation whose schema is exactly
 * `{ confirmed: boolean }`, and the host renders it. The host answers, and retries
 * the call with the answer in `inputResponses` and the server's `requestState` echoed
 * back. Three things make the retry safe to act on:
 *
 *   - **The state is sealed.** `requestState` is an HMAC-SHA256 envelope from the
 *     SDK's codec, with an expiry. The server verifies it before the handler runs,
 *     and a tampered or expired state is refused with `-32602`. It is signed, not
 *     encrypted, so it carries no secret: the tool, a digest of the arguments, the
 *     turn and call ids, and a nonce.
 *   - **The answer is bound to the arguments.** The state holds a digest of the
 *     tool name and arguments the confirmation was asked for. A retry that changes
 *     the arguments is asked again, and the old answer is not applied to them.
 *   - **A confirmed call runs once.** The nonce is remembered for the state's
 *     lifetime. A replay of an accepted retry returns the first answer and writes
 *     nothing again, so a host that resends a request cannot double a write.
 *
 * What the server cannot do is check that a human clicked accept. The answer is
 * whatever the calling host reports, and that is what the bearer token is for: it
 * is the boundary, and the dialog is the host's promise to the user. The README says
 * so, and the elicitation text names the change in words, so the dialog is honest.
 *
 * The confirmation text never carries a document body, a description or an alias: a summary
 * of the change, the titles and names it touches, and for a document import its title and word
 * count (extensibility §9: an elicitation form never carries long private content).
 */

import { createHash, randomBytes } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/server';
import { createRequestStateCodec, type RequestStateCodec } from '@modelcontextprotocol/server';
import { countBody, type ProjectState } from '@caotang/store';

/** The key the confirmation is requested under, and read back from `inputResponses`. */
export const CONFIRM_KEY = 'confirm';

/** How long a confirmation may stay open. A person answering a dialog is slower than a model. */
export const ROUND_TTL_SECONDS = 1800;

/** What the sealed `requestState` carries from one round of a confirmation to the next. */
export interface RoundState {
  readonly v: 1;
  readonly tool: string;
  readonly digest: string;
  readonly turnId: string;
  readonly callId: string;
  readonly nonce: string;
}

/** A canonical JSON text: object keys sorted at every depth, so one value has one spelling. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** The digest a confirmation is bound to: the tool name and its exact arguments. */
export function argsDigest(name: string, args: unknown): string {
  return createHash('sha256').update(stableJson({ name, args })).digest('base64url');
}

function clip(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The title of a node the change names, by its id, or `undefined` when the project does not hold it. */
export type TitleOf = (id: string) => string | undefined;

/** The title of a binder node in the project, for a confirmation that names a node. */
export function titleOfNode(state: ProjectState, id: string): string | undefined {
  return state.manifest.tree.find((node) => node.id === id)?.title;
}

/** How many items a confirmation lists before it says how many more there are. The dialog is short, and the list is for a glance. */
const LISTED = 3;

/** The first few items, joined, with how many more there are. */
function listedOf(items: readonly string[]): string {
  const shown = items.slice(0, LISTED);
  const more = items.length - shown.length;
  return more > 0 ? `${shown.join(', ')}, and ${more} more` : shown.join(', ');
}

/** A count and its noun, singular or plural. */
function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A value a confirmation quotes, clipped, or `undefined` when there is nothing to quote. */
function quotedOf(value: unknown, max = 60): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? `"${clip(value, max)}"` : undefined;
}

/** A list of records under a key, or none when the key holds no list. */
function recordsOf(params: Readonly<Record<string, unknown>>, key: string): Record<string, unknown>[] {
  return Array.isArray(params[key]) ? (params[key] as Record<string, unknown>[]) : [];
}

/** One binder operation, in words: what it does, and the node or parent it names by title. */
function binderOperationOf(op: Record<string, unknown>, named: (id: unknown) => string): string {
  if (op['action'] === 'create') {
    const kind = op['type'] === 'folder' ? 'folder' : 'document';
    const title = quotedOf(op['title']);
    return `add a ${kind}${title === undefined ? '' : ` ${title}`} under ${named(op['parent'])}`;
  }
  if (op['action'] === 'move') return `move ${named(op['node'])} under ${named(op['newParent'])}`;
  if (op['action'] === 'rename') return `rename ${named(op['node'])} to ${quotedOf(op['title']) ?? 'a new title'}`;
  return 'a binder change';
}

/**
 * One codex entry, in words: its name and type when it is made or imported, and its name when it is changed. An update names the entry
 * by its id, so the name comes from the project (`nameOfEntry`); an update that does not hold the id names the entry it repeats, if any.
 */
function codexEntryOf(entry: Record<string, unknown>, nameOfEntry: TitleOf): string {
  if (entry['action'] === 'update') {
    const id = typeof entry['id'] === 'string' ? entry['id'] : '';
    const held = nameOfEntry(id);
    return `change ${(held === undefined ? quotedOf(entry['name']) : quotedOf(held)) ?? 'an entry'}`;
  }
  const type = typeof entry['type'] === 'string' ? ` (${clip(entry['type'], 24)})` : '';
  return `add ${quotedOf(entry['name']) ?? 'an entry'}${type}`;
}

/** The name of a codex entry in the project, by its id, or `undefined` when the project does not hold it. */
export function codexEntryNameOf(state: ProjectState, id: string): string | undefined {
  return state.manifest.codex?.find((entry) => entry.id === id)?.name;
}

/**
 * The change, in words, for the dialog. It names what the change touches: the titles of the nodes and the names and types of the
 * entries, the first few of each, and the export's selection and format. It never carries a body, a description or an alias. A tool
 * it does not know gets its name, and nothing else. `titleOf` and `entryNameOf` look up a node's title and a codex entry's name by
 * id, so an update names the entry it changes.
 */
export function confirmationSummary(
  name: string,
  params: Readonly<Record<string, unknown>>,
  titleOf: TitleOf = () => undefined,
  entryNameOf: TitleOf = () => undefined,
): string {
  // An id the project holds is named by its title. One it does not hold is quoted as given, so the dialog never hides what it names.
  const named = (id: unknown): string => (typeof id === 'string' ? `"${clip(titleOf(id) ?? id, 60)}"` : 'an item');

  switch (name) {
    case 'doc.import': {
      const title = typeof params['title'] === 'string' ? clip(params['title']) : '';
      const parent = typeof params['parent'] === 'string' ? named(params['parent']) : '""';
      const words = typeof params['body'] === 'string' ? countBody(params['body']).words : 0;
      return `import "${title}" (${words} words) under ${parent}`;
    }
    case 'binder.restructure': {
      const ops = recordsOf(params, 'ops');
      const head = `apply ${counted(ops.length, 'binder operation', 'binder operations')}`;
      const described = ops.map((op) => binderOperationOf(op, named));
      return described.length === 0 ? head : `${head}: ${listedOf(described)}`;
    }
    case 'codex.write': {
      const entries = recordsOf(params, 'entries');
      const head = `write ${counted(entries.length, 'codex entry', 'codex entries')}`;
      const described = entries.map((entry) => codexEntryOf(entry, entryNameOf));
      return described.length === 0 ? head : `${head}: ${listedOf(described)}`;
    }
    case 'codex.import': {
      const entries = recordsOf(params, 'entries');
      const head = `import ${counted(entries.length, 'codex entry', 'codex entries')}`;
      const described = entries.map((entry) => codexEntryOf(entry, entryNameOf));
      return described.length === 0 ? head : `${head}: ${listedOf(described)}`;
    }
    case 'export.compile': {
      const format = typeof params['format'] === 'string' ? clip(params['format'], 16) : 'a file';
      const recipe = quotedOf(params['recipeName']);
      const withRecipe = recipe === undefined ? '' : ` with the recipe ${recipe}`;
      const selection = params['selection'] as { root?: unknown; includeSubtrees?: unknown } | undefined;
      if (selection === undefined) return `compile ${recipe === undefined ? 'the manuscript' : `the recipe ${recipe}`} to ${format}`;
      if (selection.root === 'manuscript') return `compile the manuscript to ${format}${withRecipe}`;
      const alone = selection.includeSubtrees === false ? ' alone' : ' with everything under it';
      return `compile ${named(selection.root)}${alone} to ${format}${withRecipe}`;
    }
    default:
      return `run ${clip(name, 64)}`;
  }
}

/**
 * The question a host shows. `waitSeconds` is how long a 2025-era connection holds the question open (server.ts,
 * LEGACY_ROUND_TIMEOUT_MS), given only when this server has such a deadline: the 2026-07-28 path holds nothing open.
 */
export function confirmationMessage(summary: string, waitSeconds?: number): string {
  const head = `Caotang needs your confirmation to ${summary}. Nothing changes unless you accept.`;
  if (waitSeconds === undefined) return head;
  return `${head} This question waits ${waitSeconds} seconds; after that the call fails, nothing changes, and the call can be made again.`;
}

/** The embedded form: one boolean, named in its own schema, so a host can render it as a plain yes or no. */
export const CONFIRMATION_SCHEMA = {
  type: 'object' as const,
  properties: {
    confirmed: {
      type: 'boolean' as const,
      title: 'Make this change',
      description: 'Accept to let Caotang make this change. Decline, or cancel, and the project stays as it is.',
    },
  },
  required: ['confirmed'],
};

/**
 * The answer to a confirmation the server has run or is running, kept for its nonce's lifetime so that a
 * replay gets that answer and no second write. What is kept is the answer's promise, stored before the
 * write's save is awaited: a second accept that arrives while the first is still being saved gets the same
 * answer (command-bus §6: a confirmed call runs once).
 */
export interface ConfirmLedger {
  recall(nonce: string, now: number): Promise<CallToolResult> | undefined;
  remember(nonce: string, answer: Promise<CallToolResult>, expiresAt: number, now: number): void;
}

export function createConfirmLedger(): ConfirmLedger {
  const entries = new Map<string, { readonly answer: Promise<CallToolResult>; readonly expiresAt: number }>();
  const sweep = (now: number): void => {
    for (const [nonce, entry] of entries) if (entry.expiresAt <= now) entries.delete(nonce);
  };
  return {
    recall(nonce, now) {
      sweep(now);
      return entries.get(nonce)?.answer;
    },
    remember(nonce, answer, expiresAt, now) {
      sweep(now);
      entries.set(nonce, { answer, expiresAt });
    },
  };
}

/**
 * The codec that seals the round state. The key is random per process: a server
 * restart ends every open confirmation, which is the safe failure, because a
 * confirmation the server cannot verify is never acted on.
 */
export function createRoundCodec(): RequestStateCodec<RoundState> {
  return createRequestStateCodec<RoundState>({ key: randomBytes(32), ttlSeconds: ROUND_TTL_SECONDS });
}
