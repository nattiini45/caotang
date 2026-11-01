/**
 * Runs of formatted text → Caotang-dialect Markdown (editor-engine.md §5): `**` bold, `*` italic, `~~` strike, inline links and
 * images, `[^n]` footnote references, and a backslash hard break for RTF's `\line`. Emphasis is written with a mark stack, so a
 * change of marks in the middle of a word closes and opens only what changed (`**a*b***`), and whitespace is moved outside the
 * delimiters, where CommonMark would otherwise not read them as emphasis. Text is escaped only where Markdown would read it as
 * syntax, so a writer's ampersands and underscores in names stay as they were typed.
 */

export interface Marks {
  readonly b: boolean;
  readonly i: boolean;
  readonly s: boolean;
}

export type Run =
  | { readonly kind: 'text'; readonly text: string; readonly marks: Marks }
  /** Markdown written as is: a footnote reference, an image, a hard break. `text` is its plain-text contribution. */
  | { readonly kind: 'raw'; readonly md: string; readonly text: string; readonly marks: Marks; readonly image?: { readonly ref: string; readonly alt: string } }
  | { readonly kind: 'link'; readonly href: string; readonly runs: readonly Run[] };

export const NO_MARKS: Marks = Object.freeze({ b: false, i: false, s: false });

const ORDER = ['s', 'b', 'i'] as const;
type Mark = (typeof ORDER)[number];
const DELIM: Readonly<Record<Mark, string>> = { s: '~~', b: '**', i: '*' };

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Escapes what Markdown would read as inline syntax. Line-start syntax is handled per line by {@link escapeLineStarts}. */
export function escapeInline(text: string): string {
  let out = '';
  for (let k = 0; k < text.length; k += 1) {
    const ch = text[k] as string;
    const prev = text[k - 1];
    const next = text[k + 1];
    switch (ch) {
      case '\\':
      case '*':
      case '`':
      case '[':
      case ']':
        out += `\\${ch}`;
        break;
      case '_':
        out += isWordChar(prev) && isWordChar(next) ? ch : `\\${ch}`;
        break;
      case '~':
        out += prev === '~' || next === '~' ? `\\${ch}` : ch;
        break;
      case '<':
        out += next !== undefined && /[A-Za-z/!?]/.test(next) ? `\\${ch}` : ch;
        break;
      case '&':
        out += /^&#?[A-Za-z0-9]+;/.test(text.slice(k, k + 34)) ? `\\${ch}` : ch;
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/** A line that Markdown would read as a heading, a quote, a list item or a setext underline gets its first mark escaped. */
export function escapeLineStarts(md: string): string {
  return md
    .split('\n')
    .map((line) => {
      if (/^ {0,3}(=+|-+)[ \t]*$/.test(line)) return line.replace(/^( {0,3})/, '$1\\');
      const ordered = /^( {0,3}\d{1,9})([.)])(?=[ \t]|$)/.exec(line);
      if (ordered !== null) return `${ordered[1]}\\${line.slice((ordered[1] ?? '').length)}`;
      return line.replace(/^( {0,3})(#{1,6}(?=[ \t]|$)|>|[+-](?=[ \t]|$))/, '$1\\$2');
    })
    .join('\n');
}

function marksOf(run: Run): Marks {
  return run.kind === 'link' ? NO_MARKS : run.marks;
}

/** Inline Markdown for a list of runs. The caller applies {@link escapeLineStarts} to the paragraph it builds. */
export function renderRuns(runs: readonly Run[]): string {
  let out = '';
  const open: Mark[] = [];
  const closeAll = (): void => {
    for (let k = open.length - 1; k >= 0; k -= 1) out += DELIM[open[k] as Mark];
    open.length = 0;
  };
  for (const run of runs) {
    if (run.kind === 'link') {
      closeAll();
      out += `[${renderRuns(run.runs)}](${linkTarget(run.href)})`;
      continue;
    }
    const raw = run.kind === 'raw' ? run.md : escapeInline(run.text);
    // Whitespace at the edges sits outside the delimiters, where CommonMark reads them as emphasis.
    const lead = run.kind === 'text' ? (/^\s*/.exec(raw)?.[0] ?? '') : '';
    const body = run.kind === 'text' ? raw.slice(lead.length).trimEnd() : raw;
    const trail = run.kind === 'text' ? raw.slice(lead.length + body.length) : '';
    if (body.length === 0) {
      closeAll();
      out += lead + trail;
      continue;
    }
    const want = marksOf(run);
    // Close from the top of the stack down to the first mark that should no longer be open.
    const firstStale = open.findIndex((m) => !want[m]);
    if (firstStale >= 0) {
      // Marks above it that stay on are closed too and opened again below, so the delimiters nest.
      for (let k = open.length - 1; k >= firstStale; k -= 1) out += DELIM[open[k] as Mark];
      open.length = firstStale;
    }
    if (lead.length > 0) closeAll();
    out += lead;
    for (const m of ORDER) {
      if (want[m] && !open.includes(m)) {
        out += DELIM[m];
        open.push(m);
      }
    }
    out += body;
    if (trail.length > 0) {
      closeAll();
      out += trail;
    }
  }
  closeAll();
  return out;
}

/** A link target in angle brackets when it holds a space or a parenthesis, so the Markdown link stays one link. */
function linkTarget(href: string): string {
  return /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, (c) => encodeURIComponent(c))}>` : href;
}

/** The plain text of runs: link text kept, footnote references left out, hard breaks as newlines. */
export function plainOf(runs: readonly Run[]): string {
  let out = '';
  for (const run of runs) out += run.kind === 'link' ? plainOf(run.runs) : run.text;
  return out;
}

/**
 * A link target a book may carry: `http`, `https` or `mailto`, or a reference with no scheme. The rule is the editor's paste rule
 * (`isSafeLinkTarget` in packages/editor/src/tiptap/paste.ts), repeated here because this package may not depend on the editor.
 */
export function isSafeLinkTarget(href: string): boolean {
  const target = href.replace(/[\t\n\r]/g, '').trim();
  if (/^(https?:|mailto:)/i.test(target)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(target);
}
