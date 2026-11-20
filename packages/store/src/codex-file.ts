/**
 * Codex redundancy-file codec — [codex.md §3](docs/architecture/codex.md).
 *
 * codex.md §3 is normative and unambiguous about the file: "`codex/<id>.md` —
 * YAML front matter `{id, name, type, includePolicy, caseSensitive, aliases,
 * exclude, attachments, keywords}` + body = `description` Markdown. Written on
 * every entry save via the same atomic write path as documents."
 *
 * That is the whole point of the file. The codex is the knowledge base an agent
 * maintains for a long book, and codex.md §3 calls this redundancy "the direct
 * countermeasure to the Manuskript corpus (single-asset corruption = unreadable
 * project)". A recovery pass that scans for files the write path never produced
 * is not a recovery pass, so this codec and the writer that uses it are built
 * together.
 *
 * The shape is the same front-matter-plus-body shape as a document file, with a
 * different key set — which is why the parser itself is shared with
 * {@link parseFrontMatter} and only the *interpretation* of the fields lives
 * here. Note that `description` is the body, not a key: codex.md §3 puts it
 * there so the entry reads as prose in any Markdown viewer.
 */

import { emitFlowSequence, emitScalar, parseFrontMatterFields, FrontMatterError } from './frontmatter.js';
import { isCodexDetailObject } from '@caotang/bus';
import { jsonValueProblem } from './json-value.js';
import type { CodexIncludePolicy, CodexSource } from './manifest.js';
// §2's coercions live in one module and both surfaces call it.
// Before this, `coercePolicy`/`coerceType` were private to this file and the
// manifest path had its own (none) — the two-records-of-one-fact shape, one
// package apart.
import {
  CODEX_INCLUDE_POLICIES,
  CODEX_ORIGINS,
  citationOffsetProblem,
  coerceIncludePolicy,
  coerceOrigin,
  coerceType,
  type CodexOrigin,
} from './codex-fields.js';
import { CODEX_DIR } from './paths.js';
import { composeFile, fenceLineEnding, readBody } from './file-body.js';

export interface CodexFrontMatter {
  id: string;
  name: string;
  type: string;
  includePolicy: CodexIncludePolicy;
  caseSensitive: boolean;
  aliases: string[];
  exclude: string[];
  attachments: string[];
  keywords: string[];
  /** video-prompt-pack.md §3: the entry's visual reference asset ids. Absent reads as none, and the key is written only when there are some. */
  visualRefs?: string[];
  details?: Record<string, unknown>;
  references?: unknown[];
  relations?: unknown[];
  /**
   * codex.md §10 K4: the entry's provenance. The writer always passes it; a file
   * written before K4 has no key, and the reader reads that absence as `'manual'`
   * (project-format §2), so the field is optional here only for those files.
   */
  origin?: CodexOrigin;
  /**
   * codex.md §10 K4: the citations behind the entry (codex.md §2's `EntrySource`).
   * Written only when there are some, and absent reads as none.
   */
  sources?: CodexSource[];
}

export interface ParsedCodexFile {
  /** What the file held. `origin` and `sources` are always set on a parsed file. */
  frontMatter: CodexFrontMatter & { origin: CodexOrigin; sources: CodexSource[] };
  /** The entry description — the AI-facing payload, Markdown, verbatim. */
  description: string;
  /**
   * One line per value a closed enum changed on the way in, worded as the manifest
   * path words the same coercion (codex.md §2). Empty for a clean file. The codec
   * has no notice channel, so the load that reads the file raises these.
   */
  coercions: string[];
}

/**
 * codex.md §3's key order, then codex.md §10 K4's two provenance keys. The front
 * matter is a fixed-order contract like the manifest's.
 */
const KEY_ORDER = [
  'id',
  'name',
  'type',
  'includePolicy',
  'caseSensitive',
  'aliases',
  'exclude',
  'attachments',
  'keywords',
  'visualRefs',
  'origin',
  'sources',
  'details',
  'references',
  'relations',
] as const;

/**
 * codex.md §2's closed `includePolicy` and `type` enums are **not** re-declared
 * here. `coerceIncludePolicy` and `coerceType` in `./codex-fields.ts` are the one
 * implementation of each, and `validate.ts` calls the same two for the manifest
 * path — so a redundancy file and a manifest entry carrying the same unknown
 * value are read the same way, which is the only way §3's "manifest wins" can
 * mean anything when the loser is also a source of entries.
 *
 * They are called for their `.value` only: the file path has nowhere to put a
 * warning (a `codex/<id>.md` is parsed without a notice channel, and §3 says the
 * redundancy file's contents are kept), and the manifest path wants the
 * `.coerced` flag to know whether to say so.
 */

const FENCE_RE = /^---[ \t]*\r?\n/;

/**
 * Split a `codex/<id>.md` file into its front matter and description.
 *
 * Byte-for-byte the same split as a document file: the body is sliced by offset
 * so the description's own line endings and trailing whitespace survive. An
 * entry whose description is a haiku with a trailing space must not come back
 * from recovery subtly edited.
 */
export function parseCodexFile(raw: string): ParsedCodexFile {
  const openMatch = raw.match(FENCE_RE);
  if (!openMatch) {
    throw new FrontMatterError('codex entry does not start with a `---` front matter fence');
  }
  const rest = raw.slice(openMatch[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m;
  closing.lastIndex = rest.length;
  const closingMatch = closing.exec(rest);
  if (!closingMatch) {
    throw new FrontMatterError('codex entry has no closing `---` front matter fence');
  }

  const fields = parseFrontMatterFields(rest.slice(0, closingMatch.index));
  // The envelope is the same one a document body is written in (file-body.ts).
  const body = readBody(rest.slice(closingMatch.index + closingMatch[0].length), fenceLineEnding(openMatch[0]));

  if (!fields.has('id')) throw new FrontMatterError('codex entry front matter has no `id`');
  if (!fields.has('name')) throw new FrontMatterError('codex entry front matter has no `name`');

  const scalar = (key: string): string | null | undefined => fields.get(key)?.scalar;
  const list = (key: string): string[] => fields.get(key)?.inline ?? [];

  const rawPolicy = scalar('includePolicy');
  const policy = coerceIncludePolicy(rawPolicy);
  const coercions: string[] = [];
  if (policy.coerced) {
    const shown = rawPolicy === undefined ? 'missing' : JSON.stringify(rawPolicy);
    coercions.push(
      `front matter includePolicy ${shown} is not a codex policy; read as "${policy.value}" (valid: ${CODEX_INCLUDE_POLICIES.join(', ')})`,
    );
  }

  // codex.md §10 K4. A key that is absent is a pre-K4 file, and its origin is
  // 'manual' by stated default (project-format §2) — a default, not a coercion, so it
  // raises no note. A key that is present but not an origin is coerced to 'agent' and
  // noted, the same rule the manifest path applies (codex.md §2).
  const rawOrigin = scalar('origin');
  let origin: CodexOrigin = 'manual';
  if (rawOrigin !== undefined && rawOrigin !== null) {
    const coerced = coerceOrigin(rawOrigin);
    origin = coerced.value;
    if (coerced.coerced) {
      coercions.push(
        `front matter origin ${JSON.stringify(rawOrigin)} is not a codex origin; read as "${coerced.value}" (valid: ${CODEX_ORIGINS.join(', ')})`,
      );
    }
  }
  const sources = parseSources(scalar('sources'), coercions);
  let details: Record<string, unknown> | undefined;
  if (fields.has('details')) {
    const rawDetails = scalar('details');
    try {
      const parsed: unknown = JSON.parse(rawDetails ?? 'null');
      if (isCodexDetailObject(parsed) && jsonValueProblem(parsed, 'details') === undefined) details = parsed;
    } catch {
      details = undefined;
    }
    if (details === undefined) coercions.push('front matter details must be a JSON object; details were not recovered');
  }
  let references: unknown[] | undefined;
  if (fields.has('references')) {
    try {
      const parsed: unknown = JSON.parse(scalar('references') ?? 'null');
      if (Array.isArray(parsed) && jsonValueProblem(parsed, 'references') === undefined) references = parsed;
    } catch {
      references = undefined;
    }
    if (references === undefined) coercions.push('front matter references must be a JSON list; references were not recovered');
  }
  let relations: unknown[] | undefined;
  if (fields.has('relations')) {
    try {
      const parsed: unknown = JSON.parse(scalar('relations') ?? 'null');
      if (Array.isArray(parsed) && jsonValueProblem(parsed, 'relations') === undefined) relations = parsed;
    } catch {
      relations = undefined;
    }
    if (relations === undefined) coercions.push('front matter relations must be a JSON list; entry relations were not recovered');
  }

  return {
    frontMatter: {
      id: scalar('id') ?? '',
      name: scalar('name') ?? '',
      type: coerceType(scalar('type')).value,
      includePolicy: policy.value,
      caseSensitive: scalar('caseSensitive') === 'true',
      aliases: list('aliases'),
      exclude: list('exclude'),
      attachments: list('attachments'),
      keywords: list('keywords'),
      // Present only when the file names some, so a file written before visual references reads with the key absent.
      ...(fields.has('visualRefs') ? { visualRefs: list('visualRefs') } : {}),
      ...(details === undefined ? {} : { details }),
      ...(references === undefined ? {} : { references }),
      ...(relations === undefined ? {} : { relations }),
      origin,
      sources,
    },
    description: body,
    coercions,
  };
}

/**
 * The `sources` key's citations. Written as a JSON list in one double-quoted scalar,
 * because the front-matter subset this codec shares with document files has no
 * nested structure (frontmatter.ts), and JSON is the one nested form it can carry
 * exactly. An absent key, or the empty inline list `[]`, reads as none.
 *
 * A malformed citation is dropped with a note, not kept: the entry still loads, and
 * a citation the reader cannot read is the one loss a note is for (codex.md §2 keeps
 * `sources` as display data; it is not a load-blocking field).
 */
function parseSources(raw: string | null | undefined, coercions: string[]): CodexSource[] {
  if (raw === undefined || raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    coercions.push('front matter sources is not a JSON list of citations; citations dropped');
    return [];
  }
  if (!Array.isArray(parsed)) {
    coercions.push('front matter sources is not a list of citations; citations dropped');
    return [];
  }
  const kept: CodexSource[] = [];
  parsed.forEach((item: unknown, i: number) => {
    const where = `front matter sources[${i}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      coercions.push(`${where} is not an object; citation dropped`);
      return;
    }
    const candidate = item as Record<string, unknown>;
    const docId = candidate['docId'];
    const quote = candidate['quote'];
    if (typeof docId !== 'string' || docId === '') {
      coercions.push(`${where} needs a docId; citation dropped`);
      return;
    }
    if (typeof quote !== 'string') {
      coercions.push(`${where} needs a quote; citation dropped`);
      return;
    }
    const problem = citationOffsetProblem(candidate);
    if (problem !== undefined) {
      coercions.push(`${where} ${problem}; citation dropped`);
      return;
    }
    // Built field by field, in the spec's order, so an unknown key a writer added is
    // not carried into the entry, and an absent optional stays absent. The offsets
    // and timestamp were type-checked by citationOffsetProblem above.
    const citation: CodexSource = { docId, quote };
    const { from, to, extractedAt } = candidate;
    if (from !== undefined) citation.from = from as number;
    if (to !== undefined) citation.to = to as number;
    if (extractedAt !== undefined) citation.extractedAt = extractedAt as string;
    kept.push(citation);
  });
  return kept;
}

export interface SerializeCodexOptions {
  /** Line ending for the fence block; the description is never touched. */
  newline?: '\n' | '\r\n';
}

/** Render the fenced front matter block, in codex.md §3's key order, then K4's keys. */
export function formatCodexFrontMatter(fm: CodexFrontMatter): string {
  const values: Partial<Record<(typeof KEY_ORDER)[number], string>> = {
    id: emitScalar(fm.id),
    name: emitScalar(fm.name),
    type: emitScalar(fm.type),
    includePolicy: emitScalar(fm.includePolicy),
    caseSensitive: emitScalar(fm.caseSensitive),
    aliases: emitFlowSequence(fm.aliases),
    exclude: emitFlowSequence(fm.exclude),
    attachments: emitFlowSequence(fm.attachments),
    keywords: emitFlowSequence(fm.keywords),
  };
  // origin is written whenever the writer knows it; sources only when there are some,
  // so a manual entry with no citations keeps the file it had before K4.
  if (fm.origin !== undefined) values.origin = emitScalar(fm.origin);
  if (fm.sources !== undefined && fm.sources.length > 0) values.sources = emitSources(fm.sources);
  if (fm.visualRefs !== undefined && fm.visualRefs.length > 0) values.visualRefs = emitFlowSequence(fm.visualRefs);
  if (fm.details !== undefined) values.details = JSON.stringify(JSON.stringify(fm.details));
  if (fm.references !== undefined && fm.references.length > 0) values.references = JSON.stringify(JSON.stringify(fm.references));
  if (fm.relations !== undefined && fm.relations.length > 0) values.relations = JSON.stringify(JSON.stringify(fm.relations));
  const lines = KEY_ORDER.flatMap((key) => {
    const value = values[key];
    return value === undefined ? [] : [`${key}: ${value}`];
  });
  return `---\n${lines.join('\n')}\n---\n`;
}

/** The citations as one double-quoted scalar holding their JSON (see `parseSources`). */
function emitSources(sources: readonly CodexSource[]): string {
  return JSON.stringify(JSON.stringify(sources));
}

export function serializeCodexFile(
  frontMatter: CodexFrontMatter,
  description: string,
  options: SerializeCodexOptions = {},
): string {
  const nl = options.newline ?? '\n';
  const block = formatCodexFrontMatter(frontMatter).replace(/\n/g, nl);
  return composeFile(block, description, nl);
}

export function codexFile(id: string): string {
  return `${CODEX_DIR}/${id}.md`;
}

export { FrontMatterError };
