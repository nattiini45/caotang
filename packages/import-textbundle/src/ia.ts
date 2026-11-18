/**
 * iA Writer's Content Blocks (#282): a line that is only a path (`/Chapter 1.md`, `/images/x.png "caption"`, `/data.csv`) stands for
 * that file's content, in the order the index lists them — the same explicit order a Longform index gives. Pure: the caller hands in
 * the archive's text files, so this runs on the main thread, in a Worker and in Node with no I/O of its own.
 */

/** What one Content Block line names. `other` is a file the import does not read; its line stays as text and is reported. */
export interface ContentBlockRef {
  readonly path: string;
  readonly caption: string;
  readonly kind: 'markdown' | 'image' | 'csv' | 'other';
}

const MD = /\.(md|markdown|mdown|mkd|txt)$/i;
const IMAGE = /\.(png|jpe?g|gif|svg|webp|heic|tiff?)$/i;
const CSV = /\.(csv|tsv)$/i;

/** A Content Block is a line holding only a path rooted at `/`, with an optional quoted caption. */
const BLOCK = /^ {0,3}\/([^\s"][^\n]*?)(?:\s+"([^"\n]*)")?\s*$/;

export function kindOfBlock(path: string): ContentBlockRef['kind'] {
  if (MD.test(path)) return 'markdown';
  if (IMAGE.test(path)) return 'image';
  if (CSV.test(path)) return 'csv';
  return 'other';
}

/** The Content Block lines of a body, in order. A fenced code block is never read for blocks. */
export function contentBlockRefs(text: string): ContentBlockRef[] {
  const refs: ContentBlockRef[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = BLOCK.exec(line);
    if (match === null) continue;
    const path = (match[1] ?? '').trim();
    if (path === '') continue;
    refs.push({ path, caption: (match[2] ?? '').trim(), kind: kindOfBlock(path) });
  }
  return refs;
}

/** One CSV row's cells, honouring double quotes and a doubled quote inside them. */
export function csvCells(row: string, separator = ','): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i] as string;
    if (quoted) {
      if (char === '"') {
        if (row[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === separator) {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/** A CSV as paragraphs: one per row, its cells joined with a comma and a space. The header row is the first paragraph. */
export function csvParagraphs(text: string): string[] {
  const separator = text.includes('\t') && !text.includes(',') ? '\t' : ',';
  return text
    .split(/\r?\n/)
    .filter((row) => row.trim() !== '')
    .map((row) => csvCells(row, separator).filter((cell) => cell !== '').join(', '))
    .filter((row) => row !== '');
}

export interface ContentBlockExpansion {
  /** The body with every block replaced by what it names. */
  body: string;
  /** The Markdown files taken in, in index order (a file listed twice is taken in twice). */
  included: string[];
  /** The pictures the blocks named. */
  images: { path: string; caption: string }[];
  /** The CSV files that became paragraphs. */
  csv: string[];
  /** Paths no file in the archive carries; their lines stayed as text. */
  missing: string[];
  /** Files the import does not read (a `.pdf`, a `.docx`); their lines stayed as text. */
  unsupported: string[];
}

const MAX_DEPTH = 8;

/**
 * Replace each Content Block line with what it names. `files` holds the archive's text by path, without the leading `/`. A file that
 * lists itself, directly or through a cycle, is kept out and reported as missing rather than looping.
 */
export function expandContentBlocks(text: string, files: ReadonlyMap<string, string>): ContentBlockExpansion {
  const out: ContentBlockExpansion = { body: '', included: [], images: [], csv: [], missing: [], unsupported: [] };

  const walk = (body: string, stack: readonly string[], depth: number): string => {
    const lines: string[] = [];
    let fenced = false;
    for (const line of body.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        lines.push(line);
        continue;
      }
      const match = fenced ? null : BLOCK.exec(line);
      if (match === null) {
        lines.push(line);
        continue;
      }
      const path = (match[1] ?? '').trim();
      const caption = (match[2] ?? '').trim();
      const kind = kindOfBlock(path);
      if (kind === 'image') {
        out.images.push({ path, caption });
        lines.push(`![${caption}](${path})`);
        continue;
      }
      if (kind === 'other') {
        out.unsupported.push(path);
        lines.push(line);
        continue;
      }
      const held = files.get(path);
      if (held === undefined || depth >= MAX_DEPTH || stack.includes(path)) {
        out.missing.push(path);
        lines.push(line);
        continue;
      }
      if (kind === 'csv') {
        out.csv.push(path);
        lines.push(...csvParagraphs(held));
        continue;
      }
      out.included.push(path);
      lines.push(walk(held, [...stack, path], depth + 1));
    }
    return lines.join('\n');
  };

  out.body = walk(text, [], 0);
  return out;
}
