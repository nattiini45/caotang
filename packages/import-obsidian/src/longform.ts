/**
 * The Longform index reader (#281, epic #263): the Longform plugin marks a project's index note
 * with a `longform:` front-matter block naming its format, title, draft number, scene folder and
 * an ordered scene list that may nest into Parts. This parses that block's indentation structure;
 * decision 2 keeps the nesting as nested folders instead of flattening it.
 */

export interface LongformScene {
  /** The scene note's name, or a Part's folder name when it has children. */
  readonly title: string;
  readonly children?: readonly LongformScene[];
}

export interface LongformIndex {
  readonly format: 'scenes' | 'single';
  readonly title: string;
  readonly draftNumber: number;
  readonly sceneFolder: string;
  readonly scenes: readonly LongformScene[];
  readonly ignoredFiles: readonly string[];
}

interface Line {
  readonly indent: number;
  readonly text: string;
}

/** Read the `longform:` block out of a note's front-matter lines, or null when the note is not an index. */
export function parseLongformIndex(frontMatter: readonly string[]): LongformIndex | null {
  const lines: Line[] = frontMatter
    .map((raw) => ({ indent: raw.length - raw.trimStart().length, text: raw.trim() }))
    .filter((line) => line.text !== '' && !line.text.startsWith('#'));
  const start = lines.findIndex((line) => line.indent === 0 && /^longform:\s*$/.test(line.text));
  if (start === -1) return null;

  // Collect the block's lines (deeper than the `longform:` key) until a sibling key.
  const block: Line[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.indent === 0) break;
    block.push(line);
  }
  if (block.length === 0) return null;

  const base = block[0]?.indent ?? 2;
  const fields = new Map<string, string>();
  const scenes: LongformScene[] = [];
  const ignoredFiles: string[] = [];

  // Walk the block, splitting scalar fields from the `scenes:` and `ignoredFiles:` lists.
  let i = 0;
  while (i < block.length) {
    const line = block[i];
    if (line === undefined) break;
    const rel = line.indent - base;
    if (rel === 0) {
      const scenesMatch = line.text.match(/^scenes:\s*$/);
      const ignoredMatch = line.text.match(/^ignoredFiles:\s*$/);
      if (scenesMatch !== null) {
        const nested = collectList(block, i + 1, base);
        scenes.push(...nested.items);
        i = nested.next;
        continue;
      }
      if (ignoredMatch !== null) {
        const nested = collectList(block, i + 1, base);
        ignoredFiles.push(...nested.items.map((item) => item.title));
        i = nested.next;
        continue;
      }
      const field = line.text.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
      if (field !== null) fields.set(field[1] ?? '', (field[2] ?? '').trim());
    }
    i += 1;
  }

  const format = fields.get('format') === 'single' ? 'single' : 'scenes';
  const draftNumber = Number.parseInt(fields.get('draftNumber') ?? '1', 10);
  return {
    format,
    title: fields.get('title') ?? '',
    draftNumber: Number.isFinite(draftNumber) ? draftNumber : 1,
    sceneFolder: fields.get('sceneFolder') ?? '',
    scenes,
    ignoredFiles,
  };
}

/** Collect a `- item` list (which may nest `- Part:` with its own indented list) from the block. */
function collectList(block: readonly Line[], from: number, parentIndent: number): { items: LongformScene[]; next: number } {
  const items: LongformScene[] = [];
  let i = from;
  const itemIndent = block[from]?.indent ?? parentIndent + 2;
  while (i < block.length) {
    const line = block[i];
    if (line === undefined || line.indent < itemIndent) break;
    if (line.indent > itemIndent) {
      // Stray deeper line without a parent item; skip it.
      i += 1;
      continue;
    }
    const item = line.text.match(/^-\s*(.*)$/);
    if (item === null) break;
    const value = (item[1] ?? '').trim();
    const partMatch = value.match(/^(.*):\s*$/);
    if (partMatch !== null) {
      const nested = collectList(block, i + 1, itemIndent);
      items.push({ title: (partMatch[1] ?? '').trim(), children: nested.items });
      i = nested.next;
      continue;
    }
    if (value !== '') items.push({ title: value });
    i += 1;
  }
  return { items, next: i };
}

/** Pick the draft to import: the highest `draftNumber`, as the issue's default. */
export function chooseDraft(indexes: readonly LongformIndex[]): LongformIndex | null {
  if (indexes.length === 0) return null;
  return indexes.reduce((best, index) => (index.draftNumber > best.draftNumber ? index : best));
}
