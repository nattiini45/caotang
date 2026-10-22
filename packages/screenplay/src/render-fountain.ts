/**
 * The Fountain renderer — [screenplay.md §5.1](../../../docs/architecture/screenplay.md), the identity
 * renderer: the stored file is already Fountain, so the output is the blocks laid end to end.
 *
 * It consumes the exporter's flattened block list (exporter.md §2, stage 2):
 * - `chapter` becomes a `# <title>` section line (sections are never emitted otherwise);
 * - `scene` becomes the scene's own Fountain text, with its `=` line regenerated from the
 *   manifest synopsis when the caller passes `synopses`;
 * - `separator` adds nothing, because every block already ends with a blank line, and
 *   screenplays do not use the `***` break;
 * - `frontmatter` titlepage becomes the title page from the template variables.
 *   Copyright and custom front matter, and back matter, are not part of a screenplay,
 *   so they are skipped with a note.
 *
 * **What the round trip reproduces, and what it normalises** (screenplay.md §5.1 — the spec does not yet name
 * these). For a canonical script the output is byte-identical to the input: one blank
 * line between blocks, a synopsis directly under its heading, LF line endings and one final newline. For a
 * non-canonical script the output is that same script in canonical form: a run of blank lines between blocks
 * becomes one blank line, trailing blank lines are dropped, CRLF becomes LF, and a synopsis that spans several
 * lines is joined into one, because a Fountain synopsis is one line. Nothing else changes: the words, the
 * element order and the boneyard and note text are kept as the parser reads them.
 */

import type { FlatBlock } from './flat-block.js';
import { normaliseSource, parseFountain } from './parse.js';

export const FOUNTAIN_MIME = 'text/plain; charset=utf-8';

export interface FountainRenderOptions {
  readonly title: string;
  readonly author?: string;
  readonly date?: string;
  /** Accepted for the renderer seam (exporter.md §3). Screenplay templates are not defined yet, so it changes nothing. */
  readonly templateId?: string;
  /**
   * Manifest synopses keyed by document id. When given, each scene's `=` line is written
   * under its heading from this map, and any `=` residue in the body is dropped. When
   * omitted, the body is written as stored.
   */
  readonly synopses?: Readonly<Record<string, string>>;
}

export interface FountainRenderResult {
  readonly text: string;
  /** What was left out, in order. A compile-log note in the exporter's terms (exporter.md §2). */
  readonly notes: readonly string[];
}

/** Titles and names are one line in Fountain's key-value block and in section lines. */
function oneLine(text: string): string {
  // A white-space run that holds a line break becomes one space; one pass over the runs, so nothing backtracks.
  return text.replace(/\s+/g, (run) => (run.includes('\n') ? ' ' : run)).trim();
}

function titlePageText(opts: FountainRenderOptions): string {
  const lines = [`Title: ${oneLine(opts.title)}`];
  if (opts.author !== undefined && opts.author.trim() !== '') {
    lines.push('Credit: Written by', `Author: ${oneLine(opts.author)}`);
  }
  if (opts.date !== undefined && opts.date.trim() !== '') {
    lines.push(`Draft date: ${oneLine(opts.date)}`);
  }
  return `${lines.join('\n')}\n\n`;
}

function sceneText(body: string, docId: string, opts: FountainRenderOptions): string {
  const synopses = opts.synopses;
  if (synopses === undefined) return body.trimEnd();
  // The body's own `=` residue goes, and only the lines the parser reads as synopses: a dialogue line
  // that starts with `=` is dialogue (screenplay.md §2.3). The heading line is never residue.
  const source = normaliseSource(body);
  const residue = new Set<number>();
  for (const el of parseFountain(source).elements) {
    if (el.type === 'synopsis' && el.range.from > 0) residue.add(source.slice(0, el.range.from).split('\n').length - 1);
  }
  const lines = source.split('\n').filter((_, i) => !residue.has(i));
  // A Fountain synopsis is one line, so a manifest synopsis that spans lines is joined (the normalisation above).
  const synopsis = oneLine(synopses[docId] ?? '');
  if (synopsis !== '') {
    // The line goes under the heading the parser reads, forced (`.HOUSE`) or not, and above a body with none.
    const first = parseFountain(lines.join('\n')).elements[0];
    const at = first !== undefined && first.type === 'scene_heading' ? 1 : 0;
    lines.splice(at, 0, `= ${synopsis}`);
  }
  return lines.join('\n').trimEnd();
}

/** Renders the flattened blocks as one Fountain document. Pure: the same blocks always give the same text. */
export function renderFountain(blocks: readonly FlatBlock[], opts: FountainRenderOptions): FountainRenderResult {
  let out = '';
  const notes: string[] = [];
  let titled = false;
  for (const block of blocks) {
    switch (block.kind) {
      case 'frontmatter':
        if (block.fmKind === 'titlepage' && !titled) {
          out += titlePageText(opts);
          titled = true;
        } else {
          notes.push(`Front matter "${block.fmKind}" skipped: a screenplay has no ${block.fmKind} page.`);
        }
        break;
      case 'chapter': {
        // A section's synopsis is its `=` line, directly under the `#` line, so the import reads it back as the section's
        // synopsis (screenplay.md §2.2). A section with none is written as it always was.
        const synopsis = block.synopsis === undefined ? '' : oneLine(block.synopsis);
        out += `# ${oneLine(block.title)}\n${synopsis === '' ? '' : `= ${synopsis}\n`}\n`;
        break;
      }
      case 'scene':
        out += `${sceneText(block.body, block.docId, opts)}\n\n`;
        break;
      case 'separator':
        break;
      case 'backmatter':
        notes.push('Back matter skipped: a screenplay has no back matter.');
        break;
    }
  }
  // Trailing line breaks collapse to one.
  let end = out.length;
  while (end > 0 && out[end - 1] === '\n') end--;
  const text = end === out.length ? out : `${out.slice(0, end)}\n`;
  return { text, notes };
}

export interface FountainRenderer {
  emit(blocks: readonly FlatBlock[], opts: FountainRenderOptions): Promise<Blob>;
}

export function createFountainRenderer(): FountainRenderer {
  return {
    async emit(blocks, opts) {
      const { text } = renderFountain(blocks, opts);
      return new Blob([text], { type: FOUNTAIN_MIME });
    },
  };
}
