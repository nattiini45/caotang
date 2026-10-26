/**
 * The agent's files in a project: the writer's `CAOTANG.md` and the agent's `memory/` folder — [project-format.md §1](docs/architecture/project-format.md),
 * [context-assembly.md §2](docs/architecture/context-assembly.md) (layer LI).
 *
 * Plain Markdown at the project root, versionable beside the manuscript. `CAOTANG.md` is the writer's standing instructions. If it is absent
 * and `AGENTS.md` exists, that file is read instead, and never both. `memory/` is the agent's: `memory/MEMORY.md` is an index with one line per
 * topic file, and `memory/<slug>.md` is one topic with front matter (`type`, `title`, `modified`, `origin`, `sourceTurn`). A topic file that does
 * not parse is kept whole as declined text: a load never deletes or rewrites one.
 *
 * This module is the pure half: the codec and the in-memory shape. The folder I/O is `agent-files-fs.ts`, the browser store keeps the texts on the
 * project row (`ProjectRow.agentFiles`), and the bundle carries them at its root (zip.ts).
 */

import { emitScalar, parseFrontMatterFields, FrontMatterError } from './frontmatter.js';
import { composeFile, fenceLineEnding, readBody } from './file-body.js';

export const INSTRUCTIONS_FILE = 'CAOTANG.md';
export const INSTRUCTIONS_FALLBACK = 'AGENTS.md';
export const MEMORY_DIR = 'memory';
export const MEMORY_INDEX = 'memory/MEMORY.md';

export const MEMORY_TYPES = ['style', 'preference', 'process', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** A topic's body, in characters (the `memory.write` cap). */
export const MEMORY_BODY_MAX_CHARS = 4_000;
export const MEMORY_TITLE_MAX_CHARS = 120;
export const MEMORY_SLUG_MAX_CHARS = 64;
/** How many topic files a project holds. Past it `memory.write` is refused and the writer prunes. */
export const MEMORY_MAX_FILES = 200;
/** `CAOTANG.md`, in characters. The layer sends far less (its token cap); this bounds what a project keeps. */
export const INSTRUCTIONS_MAX_CHARS = 50_000;

export interface MemoryFile {
  /** Lowercase, hyphenated; the file is `memory/<slug>.md`. */
  readonly slug: string;
  readonly type: MemoryType;
  readonly title: string;
  readonly body: string;
  /** ISO-8601, set by the app on write. Never rendered into the prompt (purity). */
  readonly modified: string;
  readonly origin: 'agent' | 'writer';
  readonly sourceTurn?: string;
}

export interface AgentFiles {
  readonly instructions?: { readonly path: typeof INSTRUCTIONS_FILE | typeof INSTRUCTIONS_FALLBACK; readonly text: string };
  /** The index text as stored; the app regenerates it from `memory` on each `memory.write`. */
  readonly index?: string;
  readonly memory: readonly MemoryFile[];
  /** Topic files that did not parse, by path: the text as found. Kept as they are and never rewritten. */
  readonly declined: ReadonlyMap<string, string>;
  /** Agent files the load could not read as text (not UTF-8), by path. They stay on disk untouched and no command writes over them. */
  readonly unreadable: readonly string[];
}

export function emptyAgentFiles(): AgentFiles {
  return { memory: [], declined: new Map(), unreadable: [] };
}

export const memoryPath = (slug: string): string => `${MEMORY_DIR}/${slug}.md`;

/** A slug: lowercase letters and digits in hyphen-separated runs. Scanned, not matched by a backtracking pattern. */
export function isMemorySlug(value: string): boolean {
  if (value.length === 0 || value.length > MEMORY_SLUG_MAX_CHARS) return false;
  for (const part of value.split('-')) {
    if (part.length === 0) return false;
    for (const char of part) {
      const code = char.charCodeAt(0);
      const digit = code >= 48 && code <= 57;
      const lower = code >= 97 && code <= 122;
      if (!digit && !lower) return false;
    }
  }
  return true;
}

/** A slug derived from a title: lowercase, anything else a hyphen, runs collapsed. Empty when the title has no letter or digit. */
export function slugOf(title: string): string {
  let out = '';
  let pending = false;
  for (const char of title.toLowerCase()) {
    const code = char.charCodeAt(0);
    const word = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (word) {
      if (pending && out !== '') out += '-';
      out += char;
      pending = false;
    } else {
      pending = true;
    }
    if (out.length >= MEMORY_SLUG_MAX_CHARS) break;
  }
  return out.endsWith('-') ? out.slice(0, -1) : out;
}

/** The slug a `memory/<slug>.md` path names, or `undefined` for any other path (including the index). */
export function memorySlugOfPath(path: string): string | undefined {
  const prefix = `${MEMORY_DIR}/`;
  if (!path.startsWith(prefix) || !path.endsWith('.md')) return undefined;
  const slug = path.slice(prefix.length, -3);
  return isMemorySlug(slug) ? slug : undefined;
}

/** Whether `path` is one of the agent files: the instructions, the fallback, the index or a topic file. */
export function isAgentFilePath(path: string): boolean {
  return path === INSTRUCTIONS_FILE || path === INSTRUCTIONS_FALLBACK || path === MEMORY_INDEX || memorySlugOfPath(path) !== undefined;
}

const isMemoryType = (value: string | null | undefined): value is MemoryType => (MEMORY_TYPES as readonly string[]).includes(value ?? '');

export type MemoryParse = { readonly ok: true; readonly file: Omit<MemoryFile, 'slug'> } | { readonly ok: false; readonly reason: string };

const FENCE_RE = /^---[ \t]*\r?\n/;

/** Reads a topic file. A file without a valid front matter block, or with an unknown type or no title, is a refusal and is kept as declined. */
export function parseMemoryFile(raw: string): MemoryParse {
  const open = FENCE_RE.exec(raw);
  if (open === null) return { ok: false, reason: 'it does not start with a `---` front matter fence' };
  const rest = raw.slice(open[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (closing === null) return { ok: false, reason: 'its front matter has no closing `---` fence' };
  let fields;
  try {
    fields = parseFrontMatterFields(rest.slice(0, closing.index));
  } catch (cause) {
    return { ok: false, reason: cause instanceof FrontMatterError ? cause.message : 'its front matter cannot be read' };
  }
  const scalar = (key: string): string | null | undefined => fields.get(key)?.scalar;
  const type = scalar('type');
  if (!isMemoryType(type)) return { ok: false, reason: `its type is not one of ${MEMORY_TYPES.join(', ')}` };
  const title = scalar('title');
  if (typeof title !== 'string' || title.trim() === '') return { ok: false, reason: 'it has no title' };
  const originText = scalar('origin');
  const sourceTurn = scalar('sourceTurn');
  const modified = scalar('modified');
  const body = readBody(rest.slice(closing.index + closing[0].length), fenceLineEnding(open[0]));
  return {
    ok: true,
    file: {
      type,
      title,
      body,
      modified: typeof modified === 'string' ? modified : '',
      origin: originText === 'agent' ? 'agent' : 'writer',
      ...(typeof sourceTurn === 'string' && sourceTurn !== '' ? { sourceTurn } : {}),
    },
  };
}

/** The topic file's text: front matter in a fixed key order, then the body. */
export function serializeMemoryFile(file: MemoryFile): string {
  const lines = [
    `type: ${emitScalar(file.type)}`,
    `title: ${emitScalar(file.title)}`,
    `modified: ${emitScalar(file.modified)}`,
    `origin: ${emitScalar(file.origin)}`,
    ...(file.sourceTurn === undefined ? [] : [`sourceTurn: ${emitScalar(file.sourceTurn)}`]),
  ];
  return composeFile(`---\n${lines.join('\n')}\n---\n`, file.body, '\n');
}

/** The first non-blank line of a body, cut at 100 characters: the hook the index line carries. */
function hookOf(body: string): string {
  for (const line of body.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    return text.length > 100 ? `${text.slice(0, 99).trimEnd()}…` : text;
  }
  return '';
}

/** The index text for a set of topics: one line each, in slug order. It carries no date, so the same topics give the same bytes. */
export function memoryIndexOf(memory: readonly MemoryFile[]): string {
  const lines = [...memory]
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((file) => {
      const title = file.title.replace(/[[\]\n\r]/g, ' ').trim();
      const hook = hookOf(file.body);
      return `- [${title}](${file.slug}.md) (${file.type})${hook === '' ? '' : `: ${hook}`}`;
    });
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** What parsing the texts found: the state, and a sentence for each topic file that was kept as declined. */
export interface ParsedAgentFiles {
  readonly files: AgentFiles;
  readonly notices: readonly { readonly path: string; readonly message: string; readonly say: string }[];
}

/**
 * The agent files from their texts, by path (`CAOTANG.md`, `AGENTS.md`, `memory/MEMORY.md`, `memory/<slug>.md`). `CAOTANG.md` wins over
 * `AGENTS.md`. A path that is not an agent file is ignored. `unreadable` is the paths the caller could not read as text.
 */
export function parseAgentFiles(texts: Readonly<Record<string, string>>, unreadable: readonly string[] = []): ParsedAgentFiles {
  const notices: { path: string; message: string; say: string }[] = [];
  const memory: MemoryFile[] = [];
  const declined = new Map<string, string>();
  for (const path of Object.keys(texts).sort()) {
    const slug = memorySlugOfPath(path);
    if (slug === undefined) continue;
    const text = texts[path] as string;
    const parsed = parseMemoryFile(text);
    if (parsed.ok) {
      memory.push({ slug, ...parsed.file });
    } else {
      declined.set(path, text);
      notices.push({
        path,
        message: `the memory file “${path}” cannot be read (${parsed.reason}); it is kept as it is and the agent does not see it`,
        say: `The memory note “${slug}” could not be read, so it is kept as it is and not sent to the agent. Open Agent instructions to fix it.`,
      });
    }
  }
  const primary = texts[INSTRUCTIONS_FILE];
  const fallback = texts[INSTRUCTIONS_FALLBACK];
  // CAOTANG.md wins, and when it is there but unreadable the fallback is not used in its place.
  const instructions: AgentFiles['instructions'] =
    primary !== undefined && !unreadable.includes(INSTRUCTIONS_FILE)
      ? { path: INSTRUCTIONS_FILE, text: primary }
      : primary === undefined && fallback !== undefined && !unreadable.includes(INSTRUCTIONS_FALLBACK)
        ? { path: INSTRUCTIONS_FALLBACK, text: fallback }
        : undefined;
  const index = texts[MEMORY_INDEX];
  return {
    files: {
      ...(instructions === undefined ? {} : { instructions }),
      ...(index === undefined ? {} : { index }),
      memory,
      declined,
      unreadable: [...unreadable],
    },
    notices,
  };
}

/**
 * The texts a state holds, by path: what the row stores and what a bundle or a folder gets. `CAOTANG.md` and `AGENTS.md` appear as the path the
 * instructions came from. Declined text is included, so it travels. The index is the stored one, or is built from the topics when the state
 * has topics and none.
 */
export function agentFileTexts(files: AgentFiles): Record<string, string> {
  const out: Record<string, string> = {};
  if (files.instructions !== undefined) out[files.instructions.path] = files.instructions.text;
  for (const file of files.memory) out[memoryPath(file.slug)] = serializeMemoryFile(file);
  for (const [path, text] of files.declined) out[path] = text;
  const index = files.index ?? (files.memory.length > 0 ? memoryIndexOf(files.memory) : undefined);
  if (index !== undefined) out[MEMORY_INDEX] = index;
  return out;
}

/** Whether a state holds any agent file at all. A project with none writes nothing, so its folder is as it was before these files existed. */
export function hasAgentFiles(files: AgentFiles): boolean {
  return files.instructions !== undefined || files.index !== undefined || files.memory.length > 0 || files.declined.size > 0;
}

/** A copy that shares nothing mutable with `files`. */
export function cloneAgentFiles(files: AgentFiles): AgentFiles {
  return {
    ...(files.instructions === undefined ? {} : { instructions: { ...files.instructions } }),
    ...(files.index === undefined ? {} : { index: files.index }),
    memory: files.memory.map((file) => ({ ...file })),
    declined: new Map(files.declined),
    unreadable: [...files.unreadable],
  };
}
