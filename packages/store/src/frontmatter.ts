/**
 * Document front matter — [project-format.md §3](docs/architecture/project-format.md).
 *
 * Front matter is *redundancy insurance*, not a second source of truth: the
 * manifest is structural truth (§2), the file body is the irreplaceable
 * content. It deliberately carries node-local facts only —
 * `id`, `title`, `status`, `label`, `keywords`, `synopsis` — and never
 * `parentId`/`order`, because duplicating structure would force a doc-file
 * rewrite on every drag (spec §3, rejected alternative).
 *
 * The subset implemented here is exactly the subset the spec writes. It is a
 * codec, not a YAML engine: a plain scalar, a flow sequence, and a block
 * scalar. The parser is deliberately tolerant of what real editors and other
 * tools produce (`|`, `>`, quoted scalars, CRLF line endings) so that a
 * hand-edited file still loads.
 */

export interface DocumentFrontMatter {
  id: string;
  title: string;
  status: string | null;
  label: string | null;
  keywords: string[];
  /** ≤ 2000 chars per §2; may contain newlines. */
  synopsis: string;
}

export class FrontMatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontMatterError';
  }
}

const FENCE = '---';

/** YAML indicator characters that make a plain scalar ambiguous or invalid. */
const NEEDS_QUOTING = /^[-?:,[\]{}#&*!|>'"%@`]|:\s|\s#|^\s|\s$|^$/;

const RESERVED_PLAIN = new Set(['null', '~', 'true', 'false', 'yes', 'no', 'on', 'off']);

/** Numbers/bools that a plain scalar would be re-read as, not as our string. */
const NUMBER_LIKE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function quote(value: string): string {
  return JSON.stringify(value);
}

function emitScalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (NEEDS_QUOTING.test(value) || RESERVED_PLAIN.has(value) || NUMBER_LIKE.test(value)) {
    return quote(value);
  }
  return value;
}

function emitFlowSequence(values: readonly string[]): string {
  if (values.length === 0) return '[]';
  return `[${values.map((v) => (NEEDS_QUOTING.test(v) ? quote(v) : v)).join(', ')}]`;
}

/**
 * Scalar and flow-sequence emitters, shared with the codex redundancy codec.
 *
 * Two front-matter shapes are spec'd (project-format §3 for documents, codex.md
 * §3 for codex entries) and both need to decide the same questions about the
 * same subset of YAML — does this string need quotes, is this empty list `[]`,
 * is this a block scalar. A second emitter would be a second thing to keep
 * honest, so the question is answered once here.
 */
export { emitScalar, emitFlowSequence };

/**
 * Block-scalar choice.
 *
 * The spec calls for `>-` (folded) so synopses diff minimally. A folded scalar
 * joins its lines with a space, so it can only round-trip a synopsis that is a
 * single line with no leading/trailing whitespace. Everything else is written
 * as a literal `|-` block, which preserves newlines exactly. Lossiness is not
 * an option: `synopsis` is author data.
 */
function blockStyle(value: string): 'folded' | 'literal' | null {
  if (value === '') return null;
  if (value.includes('\n') || value.includes('\r')) return 'literal';
  // A leading or trailing space is a "more-indented first line" to a YAML
  // reader, which changes the folding rules — not something to gamble on.
  if (value !== value.trim()) return 'literal';
  return 'folded';
}

/**
 * Render the front matter block, including the `---` fences and the blank line
 * that §3's example puts between the fences and the body.
 */
export function formatFrontMatter(fm: DocumentFrontMatter): string {
  const lines: string[] = [`id: ${emitScalar(fm.id)}`, `title: ${emitScalar(fm.title)}`];
  lines.push(`status: ${fm.status === null ? 'null' : emitScalar(fm.status)}`);
  lines.push(`label: ${fm.label === null ? 'null' : emitScalar(fm.label)}`);
  lines.push(`keywords: ${emitFlowSequence(fm.keywords)}`);

  const style = blockStyle(fm.synopsis);
  if (style === null) {
    lines.push(`synopsis: ''`);
  } else if (style === 'folded') {
    lines.push('synopsis: >-', `  ${fm.synopsis}`);
  } else {
    lines.push('synopsis: |-');
    for (const line of fm.synopsis.split(/\r\n|\r|\n/)) {
      lines.push(line === '' ? '' : `  ${line}`);
    }
  }

  return `${FENCE}\n${lines.join('\n')}\n${FENCE}\n`;
}

export interface FrontMatterField {
  /** The decoded scalar; `null` for `null`/`~`/empty, absent for a sequence. */
  scalar?: string | null;
  block?: 'folded' | 'literal';
  /** Flow-sequence items, when the value was `[a, b]`. */
  inline?: string[];
}

/** Accept either the bare block or the `---`-fenced form. */
function stripFences(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/^---[ \t]*\n/, '')
    .replace(/\n---[ \t]*\n?$/, '');
}

function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return JSON.parse(raw) as string;
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

function parseFlowSequence(raw: string): string[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') return [];
  const items: string[] = [];
  let current = '';
  let quoteChar: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i] as string;
    if (quoteChar) {
      current += ch;
      if (ch === quoteChar) quoteChar = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      items.push(unquote(current.trim()));
      current = '';
      continue;
    }
    current += ch;
  }
  items.push(unquote(current.trim()));
  return items;
}

function parseScalar(raw: string): string | null {
  const value = raw.trim();
  if (value === '' || value === 'null' || value === '~') return null;
  return unquote(value);
}

function parseBlockScalar(indicator: string, blockLines: readonly string[]): string {
  const folded = indicator.startsWith('>');
  const chomp = indicator.includes('+') ? 'keep' : indicator.includes('-') ? 'strip' : 'clip';
  // Strip the block's own indentation: the common indent of non-blank lines.
  const indents = blockLines
    .filter((l) => l.trim() !== '')
    .map((l) => (/^\s*/.exec(l)?.[0].length ?? 0) as number);
  const base = indents.length > 0 ? Math.min(...indents) : 0;
  const content = blockLines.map((l) => l.slice(base).trimEnd());

  while (content.length > 0 && content[content.length - 1] === '') content.pop();

  let value: string;
  if (folded) {
    // Folding joins consecutive non-empty lines with a space and turns a blank
    // line into a single newline — the standard YAML rule, in miniature.
    const parts: string[] = [];
    for (const line of content) {
      if (line === '') {
        parts.push('\n');
        continue;
      }
      if (parts.length > 0 && !parts[parts.length - 1]?.endsWith('\n')) parts.push(' ');
      parts.push(line);
    }
    // Every line is already trimmed and a joining space only ever precedes a line,
    // so no space can stand before a newline here.
    value = parts.join('');
  } else {
    value = content.join('\n');
  }

  if (chomp === 'clip' && value !== '') value += '\n';
  return value;
}

/**
 * Parse a front matter block into its fields, without deciding what a *shape*
 * of front matter means.
 *
 * The tolerance lives here rather than in either caller: a block scalar written
 * `|` by one tool and `>-` by another, a quoted scalar, CRLF endings and `#`
 * comments all decode to the same field map. The two spec'd shapes —
 * project-format §3's document front matter and codex.md §3's codex entry
 * front matter — differ only in which keys they require, so sharing the parser
 * is the difference between one YAML subset implementation and two.
 *
 * Throws {@link FrontMatterError} on a malformed block.
 */
export function parseFrontMatterFields(input: string): ReadonlyMap<string, FrontMatterField> {
  const yaml = stripFences(input);
  const lines = yaml.replace(/\r\n/g, '\n').split('\n');
  const fields = new Map<string, FrontMatterField>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] as string).replace(/\s+$/, '');
    if (line === '' || line === FENCE || line.startsWith('#')) continue;

    const blockMatch = /^(\w[\w-]*):\s*([>|][+-]?)\s*$/.exec(line);
    if (blockMatch) {
      const key = blockMatch[1] as string;
      const indicator = blockMatch[2] as string;
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const next = (lines[j] as string).replace(/\r$/, '');
        if (next.trim() === '') {
          body.push('');
          continue;
        }
        if (!/^\s/.test(next)) break;
        body.push(next);
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      fields.set(key, {
        block: indicator.startsWith('>') ? 'folded' : 'literal',
        scalar: parseBlockScalar(indicator, body),
      });
      i = j - 1;
      continue;
    }

    const pair = /^(\w[\w-]*):\s?(.*)$/.exec(line);
    if (!pair) throw new FrontMatterError(`malformed front matter line: ${JSON.stringify(line)}`);
    const key = pair[1] as string;
    const value = (pair[2] as string).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      fields.set(key, { inline: parseFlowSequence(value) });
    } else {
      // Store the *decoded* value: a quoted scalar must come back unquoted,
      // and `null`/`~`/empty must come back as null rather than as those words.
      fields.set(key, { scalar: parseScalar(value) });
    }
  }

  return fields;
}

/**
 * Parse a document front matter block ([project-format §3](docs/architecture/project-format.md)).
 * The text may be the bare block or the full `---`-fenced form, so the codec is
 * usable on its own as well as through {@link parseDocumentFile}. Throws
 * {@link FrontMatterError} on a malformed block or a missing `id`/`title`.
 */
export function parseFrontMatter(input: string): DocumentFrontMatter {
  const raw = parseFrontMatterFields(input);

  const value = (key: string): string | null | undefined => raw.get(key)?.scalar;
  const str = (key: string): string => value(key) ?? '';
  const nullable = (key: string): string | null => value(key) ?? null;

  if (!raw.has('id')) throw new FrontMatterError('front matter has no `id`');
  if (!raw.has('title')) throw new FrontMatterError('front matter has no `title`');

  return {
    id: str('id'),
    title: str('title'),
    status: nullable('status'),
    label: nullable('label'),
    keywords: raw.get('keywords')?.inline ?? [],
    synopsis: str('synopsis'),
  };
}
