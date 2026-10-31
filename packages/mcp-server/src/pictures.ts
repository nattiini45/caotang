/**
 * The project's pictures over MCP, read-only — [pictures.md §8.2](../../../docs/architecture/pictures.md), with the host rules of §6.4.1.
 *
 * `pictures.list` and `pictures.view` are registered on the server itself, beside the harness's tools, as `timeline.read` is: the
 * harness registry has no picture rows yet (C2), and this server must serve the pictures it holds now. Both read through the
 * SDK's picture port over the session's state and folder, so the tools, `caotang://assets`, `caotang://asset/{id}` and the app
 * see the same registry. Both are reads in every mode: listed with and without `--allow-writes`, never reaching the bus, never saving
 * the folder, logging no row. There is no picture write over MCP yet (`pictures.annotate`, `pictures.attach`): a call for one is the
 * SDK's "not found", and the guard's read-only refusal covers the harness's write tools as before. `asset.sweep` has no tool anywhere.
 *
 * **This server cannot resize.** Its only decoder is the contact-sheet WebP path (pictures.md §6.4.1), so it sends the stored bytes
 * as they are or sends nothing. A picture whose stored bytes, or whose long edge, are over what one message and a host's image
 * limit carry is refused before anything is sent, naming its size and the remedy, and the refusal never says it was shrunk.
 *
 * A tool result is what a host's model asked for, so `pictures.list` is capped (~8k tokens, at whole records, saying what was left
 * out). The resources carry the whole registry and the whole file instead, because the writer attached them on purpose.
 */

import { err, type CommandError, type CommandErrorCode, type JsonSchema } from '@caotang/bus';
import { PictureReadError, pictureListOf, pictureSummaryOf, readPictureFile, type PictureFile } from '@caotang/sdk/folder';
import type { CallToolResult, ImageContent, McpServer, TextContent } from '@modelcontextprotocol/server';

import { advertisedSchema, toCallResult, type Structured, type ToolRuntime } from './tools.js';

export const PICTURES_LIST = 'pictures.list';
export const PICTURES_VIEW = 'pictures.view';

/**
 * The most one message may carry, in bytes, as this server sizes it: the 4 MiB a request may be (server.ts `MAX_BODY_BYTES`).
 * A host's own limit on what it reads back may be lower, and the host says so; this is the most this server will put in one.
 */
export const MESSAGE_MAX_BYTES = 4 * 1024 * 1024;

/** The room a message keeps for its envelope: the JSON around the data, the URI, the type, the text blocks. */
const ENVELOPE_BYTES = 64 * 1024;

/**
 * The largest picture, in stored bytes, this server sends: the most whose base64 still fits one message with the envelope's room
 * left over. Base64 is four characters for every three bytes, so this is under three quarters of {@link MESSAGE_MAX_BYTES}.
 */
export const PICTURE_MAX_SENT_BYTES = Math.floor((MESSAGE_MAX_BYTES - ENVELOPE_BYTES) / 4) * 3;

/** The long edge, in pixels, a model host's image input takes without shrinking the picture itself (pictures.md §6.4.1). */
export const VIEW_MAX_EDGE = 1568;

/** The most pictures one `pictures.view` takes (pictures.md §8.1). */
export const VIEW_MAX_PICTURES = 4;

/** §5.1's cap on `pictures.list`, in tokens, counted in characters while the records are built. */
export const PICTURES_LIST_TOKEN_CAP = 8_000;
const CHARS_PER_TOKEN = 4;
const LIST_BUDGET_CHARS = PICTURES_LIST_TOKEN_CAP * CHARS_PER_TOKEN;

export const PICTURES_LIST_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string', description: "'project', or the id of a binder item: only the pictures placed on it (or on one of its paragraphs). Absent lists every picture." },
    tag: { type: 'string', description: 'Only the pictures carrying this tag, ignoring case.' },
  },
};

export const PICTURES_VIEW_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['assetIds'],
  properties: {
    assetIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: VIEW_MAX_PICTURES, description: `The ids of one to ${VIEW_MAX_PICTURES} pictures, as pictures.list gives them.` },
    maxPx: { type: 'integer', minimum: 1, description: 'Accepted and not applied: this server cannot resize, so a picture is sent as it is stored, or refused.' },
  },
};

// i18n: model-facing
export const PICTURES_LIST_DESCRIPTION =
  'List the project’s pictures: each one’s id, type, size in bytes and pixels, caption, alt text, tags, source and transcription, where it is placed (its links, with the quote a paragraph link is pinned to), and what else uses it (a cover, a shot, a codex entry, an inline image in a document). Text only: no picture is sent. Read-only: it changes nothing and saves nothing. Parameters: target, \'project\' or a binder item id, for only the pictures placed there; tag, for only the pictures with that tag. A long answer is cut at whole pictures and says how many were left out; narrow it with target or tag. The whole registry is attached as the caotang://assets resource.';

// i18n: model-facing
export const PICTURES_VIEW_DESCRIPTION = `Look at one to ${VIEW_MAX_PICTURES} pictures of the project by id: the stored picture is returned as an image, with its caption, alt text and transcription as text. Read-only: it changes nothing and saves nothing. This server cannot resize a picture, so it sends one only when its stored bytes are at most ${PICTURE_MAX_SENT_BYTES} and its long edge is at most ${VIEW_MAX_EDGE} px, and it refuses a larger one, before sending anything, with its size and what to do: open the project in the Caotang app and store a working copy, or import a smaller copy. maxPx is accepted and not applied. Read the ids with pictures.list.`;

const LIST_PARAMS = ['target', 'tag'] as const;
const VIEW_PARAMS = ['assetIds', 'maxPx'] as const;

function kib(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}

function refused(tool: string, code: CommandErrorCode, message: string, correctiveHint: string): CallToolResult {
  const error: CommandError = { code, message, correctiveHint, target: tool };
  return toCallResult(err(error));
}

/** The command-error code a failed picture read is answered with, so a model reads it as it reads the harness's refusals. */
function codeOf(error: PictureReadError): CommandErrorCode {
  switch (error.code) {
    case 'bad-id':
    case 'unknown-target':
      return 'invalid-params';
    case 'unknown-picture':
    case 'missing-file':
      return 'not-found';
    case 'too-large':
      return 'limit-exceeded';
    default:
      return 'io-error';
  }
}

function hintOf(error: PictureReadError): string {
  switch (error.code) {
    case 'bad-id':
    case 'unknown-picture':
    case 'unknown-target':
      return 'read the ids with pictures.list, then pass one';
    case 'too-large':
      return 'open the project in the Caotang app and store a working copy of the picture, or import a smaller copy, then ask again';
    default:
      return 'open the project in the Caotang app to repair the picture, then ask again';
  }
}

function readRefusal(tool: string, error: PictureReadError): CallToolResult {
  return refused(tool, codeOf(error), error.message, hintOf(error));
}

function unknownKey(tool: string, params: Structured, allowed: readonly string[]): CallToolResult | undefined {
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) {
      return refused(tool, 'invalid-params', `"${key}" is not a parameter of ${tool}; the parameters are ${allowed.join(', ')}.`, `send only ${allowed.join(', ')}`);
    }
  }
  return undefined;
}

/** What `pictures.list` answers with, one picture whole. */
interface ListedRecord extends Record<string, unknown> {
  readonly id: string;
}

function listBody(runtime: ToolRuntime, params: Structured): CallToolResult {
  const bad = unknownKey(PICTURES_LIST, params, LIST_PARAMS);
  if (bad !== undefined) return bad;
  for (const key of LIST_PARAMS) {
    const value = params[key];
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      return refused(PICTURES_LIST, 'invalid-params', `${key} must be a non-blank string, and "${String(value)}" is not.`, `pass a ${key}, or leave it out to list every picture`);
    }
  }
  const { state } = runtime.session;
  let listed: ReturnType<typeof pictureListOf>;
  try {
    listed = pictureListOf(state, {
      ...(typeof params['target'] === 'string' ? { target: params['target'].trim() } : {}),
      ...(typeof params['tag'] === 'string' ? { tag: params['tag'] } : {}),
    });
  } catch (error) {
    if (error instanceof PictureReadError) return readRefusal(PICTURES_LIST, error);
    throw error;
  }
  const pictures: ListedRecord[] = [];
  let used = 0;
  for (const entry of listed) {
    const record: ListedRecord = { ...entry.picture, links: entry.links, uses: entry.uses };
    used += JSON.stringify(record).length;
    if (used > LIST_BUDGET_CHARS && pictures.length > 0) break;
    pictures.push(record);
  }
  const omitted = listed.length - pictures.length;
  const name = state.manifest.project.name;
  const total = (state.manifest.assets ?? []).length;
  const narrowed = params['target'] !== undefined || params['tag'] !== undefined;
  const summary =
    `The pictures of “${name}”: ${listed.length} ${narrowed ? `of ${total} ` : ''}listed.` +
    (omitted > 0 ? ` ${omitted} were left out over the ${PICTURES_LIST_TOKEN_CAP.toLocaleString('en')}-token cap; narrow it with target or tag.` : '');
  const body = { summary, data: { pictures, total: listed.length, omitted: omitted === 0 ? null : omitted } };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
}

/** The ids a view names: one to four, each a string, repeats read once. */
function viewIdsOf(params: Structured): string[] | CallToolResult {
  const raw = params['assetIds'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((id) => typeof id !== 'string')) {
    return refused(PICTURES_VIEW, 'invalid-params', 'assetIds must be a list of one to four picture ids.', 'read the ids with pictures.list, then pass them as assetIds');
  }
  const ids = [...new Set(raw as string[])];
  if (ids.length > VIEW_MAX_PICTURES) {
    return refused(PICTURES_VIEW, 'invalid-params', `${PICTURES_VIEW} takes at most ${VIEW_MAX_PICTURES} pictures at a time, and ${ids.length} were named.`, `ask for ${VIEW_MAX_PICTURES} or fewer, then ask again for the rest`);
  }
  return ids;
}

function longEdgeOf(read: PictureFile): number | undefined {
  const width = read.display?.width ?? read.record.width;
  const height = read.display?.height ?? read.record.height;
  return width === undefined || height === undefined ? undefined : Math.max(width, height);
}

function textBlock(text: string): TextContent {
  return { type: 'text', text };
}

function imageBlock(read: PictureFile): ImageContent {
  return { type: 'image', data: Buffer.from(read.bytes).toString('base64'), mimeType: read.mime };
}

async function viewBody(runtime: ToolRuntime, params: Structured): Promise<CallToolResult> {
  const bad = unknownKey(PICTURES_VIEW, params, VIEW_PARAMS);
  if (bad !== undefined) return bad;
  const maxPx = params['maxPx'];
  if (maxPx !== undefined && (typeof maxPx !== 'number' || !Number.isInteger(maxPx) || maxPx < 1)) {
    return refused(PICTURES_VIEW, 'invalid-params', `maxPx must be a whole number of pixels, at least 1, and ${JSON.stringify(maxPx)} is not.`, 'pass a whole number, or leave maxPx out');
  }
  const ids = viewIdsOf(params);
  if (!Array.isArray(ids)) return ids;

  const { session } = runtime;
  const reads: PictureFile[] = [];
  let total = 0;
  for (const id of ids) {
    let read: PictureFile;
    try {
      read = await readPictureFile(session.fs, session.state, id, { maxBytes: PICTURE_MAX_SENT_BYTES });
    } catch (error) {
      if (error instanceof PictureReadError) return readRefusal(PICTURES_VIEW, error);
      throw error;
    }
    const edge = longEdgeOf(read);
    if (edge === undefined) {
      return refused(
        PICTURES_VIEW,
        'limit-exceeded',
        `The size of picture ${id} could not be read from the file, so it could not be checked against the ${VIEW_MAX_EDGE} px long edge this server sends, and it was not sent. This server cannot shrink a picture.`,
        'open the project in the Caotang app to check the picture, or import a copy of it, then ask again',
      );
    }
    if (edge > VIEW_MAX_EDGE) {
      return refused(
        PICTURES_VIEW,
        'limit-exceeded',
        `Picture ${id} is ${read.display?.width ?? read.record.width} × ${read.display?.height ?? read.record.height} px, and its long edge of ${edge} px is over the ${VIEW_MAX_EDGE} px this server sends, so it was not sent. This server cannot shrink a picture.`,
        `open the project in the Caotang app and store a working copy of it at or below ${VIEW_MAX_EDGE} px, or import a copy that size, then view it again`,
      );
    }
    total += read.bytes.length;
    reads.push(read);
  }
  if (total > PICTURE_MAX_SENT_BYTES) {
    return refused(
      PICTURES_VIEW,
      'limit-exceeded',
      `These ${reads.length} pictures are ${kib(total)} (${total} bytes) together, over the ${kib(PICTURE_MAX_SENT_BYTES)} (${PICTURE_MAX_SENT_BYTES} bytes) this server sends in one message, so none was sent.`,
      'view them one or two at a time',
    );
  }

  const pictures = reads.map((read) => ({ ...pictureSummaryOf(read.record), bytes: read.bytes.length }));
  const notes = maxPx === undefined ? undefined : [`maxPx ${String(maxPx)} was not applied: this server does not resize, so each picture is sent as it is stored.`];
  const body = {
    summary: `${reads.length === 1 ? 'One picture' : `${reads.length} pictures`} of “${session.state.manifest.project.name}”, sent as stored: ${kib(total)}.`,
    data: { pictures },
    ...(notes === undefined ? {} : { notes }),
  };
  return { content: [textBlock(JSON.stringify(body)), ...reads.map(imageBlock)], structuredContent: body };
}

/**
 * Registers the read-only picture tools on `server`. They are listed in every mode, because a read is: they run against the
 * session's in-memory state and its folder, and never call the bus, so they cannot write, whatever `--allow-writes` says. Returns
 * the names registered.
 */
export function registerPictureTools(server: McpServer, runtime: ToolRuntime): readonly string[] {
  server.registerTool(
    PICTURES_LIST,
    {
      description: PICTURES_LIST_DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: advertisedSchema(PICTURES_LIST_SCHEMA),
    },
    (args: Structured): CallToolResult => listBody(runtime, args ?? {}),
  );
  server.registerTool(
    PICTURES_VIEW,
    {
      description: PICTURES_VIEW_DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: advertisedSchema(PICTURES_VIEW_SCHEMA),
    },
    (args: Structured): Promise<CallToolResult> => viewBody(runtime, args ?? {}),
  );
  return [PICTURES_LIST, PICTURES_VIEW];
}
