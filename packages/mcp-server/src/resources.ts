/**
 * The project, as MCP resources — extensibility.md §9.
 *
 * A tool result is something the host's model asked for, so it is capped for a model's context. A resource is something the writer
 * attached on purpose (`@caotang:caotang://doc/…` in Claude Code, the resource picker in Cursor), so it carries the whole body and
 * the host's own limits apply. Resources are read-only in every mode: a read never saves the folder (decisions.md, "A read never
 * saves the project folder"), and it logs no row, as `doc.read` logs none.
 *
 * Each read goes through the harness's own lookups (`readBody`, `readNotes`, `readCodexEntry`) or the read tool itself
 * (`project.overview`, `binder.read_tree`), so a node is resolved, and a refusal worded, exactly as the tools do. What a resource
 * does not do is cut: a body over {@linkcode RESOURCE_MAX_BYTES} is refused with its size, never trimmed. The pictures are the one
 * binary resource: `caotang://asset/{id}` is a blob with the record's type, refused with its size when it is over what one message
 * carries, because this server cannot shrink a picture (pictures.md §6.4.1).
 *
 * Results are cached privately and not at all (`ttlMs` 0): a manuscript must not sit in a shared cache, and the folder can change.
 */

import { newId } from '@caotang/ids';
import { codexInOrder, descendantsOf, readBody, readCodexEntry, readNotes, refusalSentence } from '@caotang/harness';
import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
  type ReadResourceResult,
} from '@modelcontextprotocol/server';
import type { CommandError } from '@caotang/bus';
import { PictureReadError, pictureRegistryOf, readPictureFile } from '@caotang/sdk/folder';
import { getBody, type CodexEntry, type ProjectState, type TreeNode } from '@caotang/store';

import { PICTURE_MAX_SENT_BYTES } from './pictures.js';
import type { ToolRuntime } from './tools.js';
import {
  ASSETS_URI,
  ASSET_TEMPLATE,
  BINDER_URI,
  CODEX_ENTRY_TEMPLATE,
  CODEX_URI,
  DOC_TEMPLATE,
  NOTES_TEMPLATE,
  PROJECT_URI,
  TIMELINE_CSV_URI,
  TIMELINE_URI,
  assetUri,
  codexEntryUri,
  docUri,
  hasBody,
} from './uris.js';

export {
  ASSETS_URI,
  RESOURCE_SCHEME,
  assetUri,
  changeOf,
  codexEntryUri,
  docUri,
  notesUri,
  TIMELINE_CSV_URI,
  TIMELINE_URI,
  type CaotangResourceUri,
} from './uris.js';

/** Hard ceiling for one resource body; refused above it, never trimmed. */
export const RESOURCE_MAX_BYTES = 2 * 1024 * 1024;

const MARKDOWN = 'text/markdown';
const JSON_TYPE = 'application/json';
const CSV_TYPE = 'text/csv';
const COMPLETION_LIMIT = 100;

/** The cache hint of every read: nothing is shared, and nothing is kept (the folder can change under a host that holds on). */
const NO_SHARED_CACHE = { ttlMs: 0, cacheScope: 'private' } as const;

/** What a node's body is written in: Fountain for a screenplay, Ink for a dialogue container, Markdown otherwise. */
export function mimeTypeOf(node: Pick<TreeNode, 'type' | 'kind'>): string {
  if (node.type === 'dialogue') return 'text/plain';
  return node.kind === 'screenplay' ? 'text/x-fountain' : MARKDOWN;
}

/** The refusal of a lookup, as the error a resource read answers with: `-32602`, in the harness's words. */
function notFound(uri: string, error: CommandError): ResourceNotFoundError {
  return new ResourceNotFoundError(uri, refusalSentence(error.message, error.correctiveHint));
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}

/** One text resource, or the refusal when the text is over the ceiling. A resource is never cut to fit. */
function contentsOf(uri: string, title: string, text: string, mimeType: string): ReadResourceResult {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > RESOURCE_MAX_BYTES) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      `"${title}" is ${sizeLabel(bytes)} (${bytes} bytes), over the ${sizeLabel(RESOURCE_MAX_BYTES)} (${RESOURCE_MAX_BYTES} bytes) a resource carries, so it was not sent, and it is never cut. ` +
        'Read it in pieces with doc.read and its range, or split the document in Caotang.',
      { uri, bytes, limit: RESOURCE_MAX_BYTES },
    );
  }
  return { contents: [{ uri, mimeType, text }] };
}

/**
 * The refusal of a picture read, as the error a resource read answers with. An id that is no picture, or a picture whose file is
 * gone, is `-32602` like any unknown id; a picture too large to send, or whose file is not the type recorded, is a refusal that
 * carries its numbers. The remedy is in the words the SDK's port wrote, and none of them claims the picture was shrunk.
 */
function pictureRefusal(uri: string, error: unknown): unknown {
  if (!(error instanceof PictureReadError)) return error;
  if (error.code === 'bad-id' || error.code === 'unknown-picture' || error.code === 'missing-file') {
    return new ResourceNotFoundError(uri, error.message);
  }
  return new ProtocolError(ProtocolErrorCode.InvalidRequest, error.message, { uri, code: error.code, ...(error.detail ?? {}) });
}

/** The registry as JSON, or the refusal when it is over the ceiling: a resource is never cut, so a project with that many pictures is read in parts. */
function registryContents(uri: string, text: string): ReadResourceResult {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > RESOURCE_MAX_BYTES) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      `The picture registry is ${sizeLabel(bytes)} (${bytes} bytes), over the ${sizeLabel(RESOURCE_MAX_BYTES)} (${RESOURCE_MAX_BYTES} bytes) a resource carries, so it was not sent, and it is never cut. ` +
        'Read the pictures in parts with pictures.list and its target or tag.',
      { uri, bytes, limit: RESOURCE_MAX_BYTES },
    );
  }
  return { contents: [{ uri, mimeType: JSON_TYPE, text }] };
}

/** The variable `{id}` of a template match, as one string. */
function idOf(variables: Record<string, string | string[]>): string {
  const value = variables['id'];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** The documents and dialogue containers, in binder order: manuscript, then research. */
function bodiesInOrder(state: ProjectState): TreeNode[] {
  return descendantsOf(state, 'root').filter(hasBody);
}

/** Whether any of the texts (a title, a name, an id) contains what was typed, ignoring case. Nothing typed matches everything. */
function matches(typed: string, ...texts: readonly string[]): boolean {
  const needle = typed.trim().toLowerCase();
  return needle === '' || texts.some((text) => text.toLowerCase().includes(needle));
}

/** The notes resource: the inspector's synopsis, notes and keywords, under the node's title. */
export function notesMarkdown(read: { readonly title: string; readonly synopsis: string; readonly notes: string; readonly keywords: readonly string[] }): string {
  const sections = [
    read.synopsis.trim() === '' ? undefined : `## Synopsis\n\n${read.synopsis}`,
    read.notes.trim() === '' ? undefined : `## Notes\n\n${read.notes}`,
    read.keywords.length === 0 ? undefined : `## Keywords\n\n${read.keywords.join(', ')}`,
  ].filter((section): section is string => section !== undefined);
  return `# ${read.title}\n\n${sections.length === 0 ? 'No synopsis, notes or keywords.' : sections.join('\n\n')}\n`;
}

/** An entry loaded from a folder may lack its optional lists (the codex read treats an absent field as empty). */
const aliasesOf = (entry: CodexEntry): readonly string[] => entry.aliases ?? [];

/** The codex resource: the entry's fields as `codex.read` returns them, and its description whole. */
export function codexMarkdown(entry: CodexEntry): string {
  const facts = [
    `- Type: ${entry.type}`,
    `- Include policy: ${entry.includePolicy}`,
    ...(aliasesOf(entry).length === 0 ? [] : [`- Aliases: ${aliasesOf(entry).join(', ')}`]),
    ...((entry.attachments ?? []).length === 0 ? [] : [`- Attached to: ${(entry.attachments ?? []).join(', ')}`]),
  ];
  return `# ${entry.name}\n\n${facts.join('\n')}\n\n${entry.description}\n`;
}

interface OverviewRow {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly children?: readonly OverviewRow[];
}

/** The overview as Markdown: the title and totals, then the binder's first two levels with the ids a host reads a document by. */
function overviewMarkdown(summary: string, notes: readonly string[] | undefined, tree: readonly OverviewRow[]): string {
  const lines = tree.flatMap((part) => [
    `- ${part.title} (${part.type}, ${part.id})`,
    ...(part.children ?? []).map((child) => `  - ${child.title} (${child.type}, ${child.id})`),
  ]);
  const aside = notes === undefined || notes.length === 0 ? '' : `\n${notes.join('\n')}\n`;
  return `# ${summary}\n${aside}\n## Binder\n\n${lines.join('\n')}\n\nRead a document at caotang://doc/{id}, its notes at caotang://notes/{id}, and the codex at caotang://codex.\n`;
}

/** A read tool, run as an external caller: the same call, cap and wording a host's tool call gets. */
async function runRead(runtime: ToolRuntime, uri: string, name: string, params: Record<string, unknown>) {
  const outcome = await runtime.session.callDirect(name, newId('cmd'), params, newId('cmd'));
  if (!outcome.ok) throw notFound(uri, outcome.error);
  return outcome.value;
}

/**
 * Registers the project's resources on `server`: the overview, the binder and the codex index as fixed URIs, and a template each for
 * a document's body, a node's notes and a codex entry. Returns the names registered. Only documents and codex entries are listed;
 * notes are read by the id of a node that is listed.
 */
export function registerCaotangResources(server: McpServer, runtime: ToolRuntime): readonly string[] {
  const { session } = runtime;
  const stateNow = (): ProjectState => session.state;

  server.registerResource(
    'project',
    PROJECT_URI,
    {
      title: 'Project overview',
      description: 'The project’s title, size and binder, with the ids to read each document by.',
      mimeType: MARKDOWN,
      cacheHint: NO_SHARED_CACHE,
    },
    async (uri) => {
      const value = await runRead(runtime, uri.href, 'project.overview', {});
      const data = value.data as { tree?: readonly OverviewRow[] };
      return contentsOf(uri.href, 'The project overview', overviewMarkdown(value.summary, value.notes, data.tree ?? []), MARKDOWN);
    },
  );

  server.registerResource(
    'binder',
    BINDER_URI,
    {
      title: 'Binder',
      description: 'The binder as JSON: every node with its id, parent, order, status, label and word count.',
      mimeType: JSON_TYPE,
      cacheHint: NO_SHARED_CACHE,
    },
    async (uri) => {
      const value = await runRead(runtime, uri.href, 'binder.read_tree', { root: 'root', depth: 3, include: 'counts' });
      return contentsOf(uri.href, 'The binder', JSON.stringify(value.data, null, 2), JSON_TYPE);
    },
  );

  server.registerResource(
    'codex',
    CODEX_URI,
    {
      title: 'Codex index',
      description: 'The codex entries as JSON: id, name, type, aliases and include policy. Read one at caotang://codex/{id}.',
      mimeType: JSON_TYPE,
      cacheHint: NO_SHARED_CACHE,
    },
    (uri) => {
      const entries = codexInOrder(stateNow()).map((entry) => ({ id: entry.id, name: entry.name, type: entry.type, aliases: aliasesOf(entry), includePolicy: entry.includePolicy }));
      return contentsOf(uri.href, 'The codex index', JSON.stringify({ entries }, null, 2), JSON_TYPE);
    },
  );

  server.registerResource(
    'timeline',
    TIMELINE_URI,
    {
      title: 'Timeline',
      description:
        'The story timeline as JSON: every scene with its part, day, duration, mode, POV, folder, reading index and open findings, the part zones and folds, the lanes, the unscheduled shelf, the connectors, in canonical logical order — parts included. Read-only.',
      mimeType: JSON_TYPE,
      cacheHint: NO_SHARED_CACHE,
    },
    (uri) => {
      const model = runtime.session.timeline();
      return contentsOf(uri.href, 'The timeline', JSON.stringify(model, null, 2), JSON_TYPE);
    },
  );

  server.registerResource(
    'timeline-csv',
    TIMELINE_CSV_URI,
    {
      title: 'Timeline (CSV)',
      description:
        'The timeline as CSV, the same file the timeline-csv compile format writes: one row per scene in canonical order (part, day, reading index; undated last per part), with reading index, part, title, folder path, day, duration days, end day, day label, mode, POV, expected present, after, threads, open findings, picture ids and picture alt text. Days are signed decimals, so a spreadsheet cannot read one as a formula. The part zones are in the JSON resource. Read-only.',
      mimeType: CSV_TYPE,
      cacheHint: NO_SHARED_CACHE,
    },
    (uri) => contentsOf(uri.href, 'The timeline as CSV', runtime.session.timelineCsv(), CSV_TYPE),
  );

  server.registerResource(
    'assets',
    ASSETS_URI,
    {
      title: 'Pictures',
      description:
        'The picture registry as JSON: every picture with its id, type, size in bytes and pixels, caption, alt text, tags, source, transcription and creation time, and every link placing a picture on the project, a binder item or a paragraph (the quote it is pinned to), in the manifest’s order. Read a picture’s bytes at caotang://asset/{id}. Read-only.',
      mimeType: JSON_TYPE,
      cacheHint: NO_SHARED_CACHE,
    },
    (uri) => registryContents(uri.href, JSON.stringify(pictureRegistryOf(stateNow()), null, 2)),
  );

  server.registerResource(
    'doc',
    new ResourceTemplate(DOC_TEMPLATE, {
      list: () => ({
        resources: bodiesInOrder(stateNow()).map((node) => ({
          uri: docUri(node.id),
          name: node.title,
          title: node.title,
          mimeType: mimeTypeOf(node),
          size: Buffer.byteLength(getBody(stateNow(), node.id), 'utf8'),
        })),
      }),
      complete: {
        id: (typed) =>
          bodiesInOrder(stateNow())
            .filter((node) => matches(typed, node.title, node.id))
            .map((node) => node.id)
            .slice(0, COMPLETION_LIMIT),
      },
    }),
    {
      title: 'Document',
      description: 'A document’s whole text: Markdown, Fountain for a screenplay, Ink for a dialogue container.',
      cacheHint: NO_SHARED_CACHE,
    },
    (uri, variables) => {
      const read = readBody(stateNow(), idOf(variables));
      if (!read.ok) throw notFound(uri.href, read.error);
      return contentsOf(uri.href, read.value.title, read.value.text, mimeTypeOf(read.value));
    },
  );

  server.registerResource(
    'notes',
    new ResourceTemplate(NOTES_TEMPLATE, {
      list: undefined,
      complete: {
        id: (typed) =>
          stateNow()
            .manifest.tree.filter((node) => node.type !== 'root' && matches(typed, node.title, node.id))
            .map((node) => node.id)
            .slice(0, COMPLETION_LIMIT),
      },
    }),
    {
      title: 'Notes',
      description: 'A node’s synopsis, notes and keywords, as Markdown.',
      mimeType: MARKDOWN,
      cacheHint: NO_SHARED_CACHE,
    },
    (uri, variables) => {
      const read = readNotes(stateNow(), idOf(variables));
      if (!read.ok) throw notFound(uri.href, read.error);
      return contentsOf(uri.href, read.value.title, notesMarkdown(read.value), MARKDOWN);
    },
  );

  server.registerResource(
    'codex-entry',
    new ResourceTemplate(CODEX_ENTRY_TEMPLATE, {
      list: () => ({
        resources: codexInOrder(stateNow()).map((entry) => ({
          uri: codexEntryUri(entry.id),
          name: entry.name,
          title: entry.name,
          mimeType: MARKDOWN,
        })),
      }),
      complete: {
        id: (typed) =>
          codexInOrder(stateNow())
            .filter((entry) => matches(typed, entry.name, entry.id) || aliasesOf(entry).some((alias) => matches(typed, alias)))
            .map((entry) => entry.id)
            .slice(0, COMPLETION_LIMIT),
      },
    }),
    {
      title: 'Codex entry',
      description: 'A codex entry: its type, aliases, include policy and whole description, as Markdown.',
      mimeType: MARKDOWN,
      cacheHint: NO_SHARED_CACHE,
    },
    (uri, variables) => {
      const read = readCodexEntry(stateNow(), idOf(variables));
      if (!read.ok) throw notFound(uri.href, read.error);
      return contentsOf(uri.href, read.value.name, codexMarkdown(read.value), MARKDOWN);
    },
  );

  server.registerResource(
    'asset',
    new ResourceTemplate(ASSET_TEMPLATE, {
      list: () => ({
        resources: pictureRegistryOf(stateNow()).pictures.map((picture) => ({
          uri: assetUri(picture.id),
          name: picture.id,
          title: picture.caption ?? picture.alt ?? picture.id,
          mimeType: picture.mime,
          size: picture.bytes,
        })),
      }),
      complete: {
        id: (typed) =>
          pictureRegistryOf(stateNow())
            .pictures.filter((picture) => matches(typed, picture.id, picture.caption ?? '', picture.alt ?? '', ...(picture.tags ?? [])))
            .map((picture) => picture.id)
            .slice(0, COMPLETION_LIMIT),
      },
    }),
    {
      title: 'Picture',
      description:
        'A picture’s stored bytes, as a blob with the type its record names (PNG, JPEG or WebP). This server cannot resize, so a picture over the size one message carries is refused with its size, never shrunk. Read-only.',
      cacheHint: NO_SHARED_CACHE,
    },
    async (uri, variables) => {
      try {
        const read = await readPictureFile(session.fs, stateNow(), idOf(variables), { maxBytes: PICTURE_MAX_SENT_BYTES });
        return { contents: [{ uri: uri.href, mimeType: read.mime, blob: Buffer.from(read.bytes).toString('base64') }] };
      } catch (error) {
        throw pictureRefusal(uri.href, error);
      }
    },
  );

  return ['project', 'binder', 'codex', 'timeline', 'timeline-csv', 'assets', 'doc', 'notes', 'codex-entry', 'asset'];
}
