/**
 * The Markdown body parser for the Markdown import (#280, epic #263).
 *
 * Turns a Markdown body (front matter already stripped) into the flat import
 * block list (import-core.md §2). It keeps the structural signals the splitter
 * needs — heading levels, thematic breaks, the file a block came from — and
 * normalises the body to the Caotang dialect: CommonMark plus GFM strike and
 * images, footnotes as inline `[^n]`. Tables and task lists degrade to prose
 * with a loss; nothing is dropped silently. No DOM, no dependencies.
 */

import type {
  ImportBlock,
  ImportFootnote,
  LossWarning,
} from '@caotang/import-core';

export interface MarkdownBody {
  blocks: ImportBlock[];
  footnotes: ImportFootnote[];
  losses: LossWarning[];
  /** The `import:` tokens the bodies use as image targets, in first-seen order. */
  imageRefs: string[];
  /** Each token's original target in the source, so the reader can resolve its bytes. */
  imageTargets: Map<string, string>;
}

/** An ATX heading: `#`…`######`, optionally closed by trailing `#`s. */
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
/** A thematic break: three or more `*`, `-` or `_`, optionally spaced. */
const THEMATIC = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** A setext underline: a run of `=` (level 1) or `-` (level 2). */
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
/** A fenced code block opener. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A footnote definition: `[^label]: text`. */
const FOOTNOTE_DEF = /^ {0,3}\[\^([^\]]+)\]:[ \t]*(.*)$/;
/** A table delimiter row: `| --- | :---: |`. */
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)+\|?[ \t]*$/;
/** A task-list item: `- [ ]` or `- [x]`. */
const TASK = /^ {0,3}([-*+]|\d+[.)])[ \t]+\[([ xX])\][ \t]+(.*)$/;
/** A standalone image: `![alt](target "title")`, nothing else on the line. */
const IMAGE_LINE = /^ {0,3}!\[([^\]]*)\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)[ \t]*$/;
/** Any inline image, for registering its target. */
const IMAGE_INLINE = /!\[[^\]]*\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/g;

const isBlank = (line: string): boolean => line.trim() === '';

/** True when a line begins a block that interrupts a paragraph. */
function interruptsParagraph(line: string): boolean {
  return (
    ATX.test(line) ||
    THEMATIC.test(line) ||
    FENCE.test(line) ||
    FOOTNOTE_DEF.test(line) ||
    /^ {0,3}>/.test(line) ||
    /^ {0,3}([-*+]|\d+[.)])[ \t]/.test(line)
  );
}

/**
 * Parse a Markdown body into blocks. `sourceUnit` names the file the body came
 * from, so the splitter can treat a change of file as a boundary. `tokenNamespace` keeps picture tokens apart when several files
 * are merged into one document: without it two files' first picture would share one token and one file's bytes.
 */
export function parseMarkdownBody(body: string, sourceUnit?: string, tokenNamespace?: string): MarkdownBody {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ImportBlock[] = [];
  const footnotes: ImportFootnote[] = [];
  const losses: LossWarning[] = [];
  const imageRefs: string[] = [];
  const imageTargets = new Map<string, string>();
  const tokenOf = new Map<string, string>();
  let tableCount = 0;
  let taskCount = 0;

  const src = sourceUnit === undefined ? undefined : { sourceUnit };
  const registerImage = (target: string): string => {
    const held = tokenOf.get(target);
    if (held !== undefined) return held;
    const token = `import:markdown-image-${tokenNamespace === undefined ? '' : `${tokenNamespace}-`}${imageRefs.length + 1}`;
    tokenOf.set(target, token);
    imageRefs.push(token);
    imageTargets.set(token, target);
    return token;
  };
  /** Register every inline image's target and rewrite it to its `import:` token. */
  const noteImages = (text: string): string =>
    text.replace(IMAGE_INLINE, (whole, target: string) => whole.replace(`(${target}`, `(${registerImage(target)}`));

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    // Fenced code block: kept whole as one prose block.
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = (fence[1] as string)[0] as string;
      const fenceLen = (fence[1] as string).length;
      const collected = [line];
      i += 1;
      while (i < lines.length) {
        const cur = lines[i] as string;
        collected.push(cur);
        i += 1;
        const close = FENCE.exec(cur);
        if (close && (close[1] as string)[0] === marker && (close[1] as string).length >= fenceLen && (close[2] as string).trim() === '') break;
      }
      const md = collected.join('\n');
      blocks.push({ kind: 'para', md, text: md, ...(src ? { src } : {}) });
      continue;
    }

    // Footnote definition: collected, not emitted as a block.
    const footnote = FOOTNOTE_DEF.exec(line);
    if (footnote) {
      const label = footnote[1] as string;
      const parts = [footnote[2] as string];
      i += 1;
      while (i < lines.length && /^( {2,}|\t)/.test(lines[i] as string) && !isBlank(lines[i] as string)) {
        parts.push((lines[i] as string).trim());
        i += 1;
      }
      const md = noteImages(parts.filter((p) => p !== '').join('\n\n'));
      footnotes.push({ blockIndex: blocks.length, label, md });
      continue;
    }

    // ATX heading. An empty heading is a scene break to the splitter.
    const atx = ATX.exec(line);
    if (atx) {
      const level = (atx[1] as string).length;
      const text = noteImages((atx[2] ?? '').trim());
      blocks.push({ kind: 'heading', level, text, md: noteImages(line.trim()), ...(src ? { src } : {}) });
      i += 1;
      continue;
    }

    // Thematic break (a run of `*`, `-` or `_`). A `---` under a paragraph line
    // is a setext heading instead, handled below.
    if (THEMATIC.test(line)) {
      blocks.push({ kind: 'break', marker: line.trim(), ...(src ? { src } : {}) });
      i += 1;
      continue;
    }

    // A table: a header row, a delimiter row, then body rows. Degrade to prose.
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1] as string)) {
      const rows: string[] = [];
      while (i < lines.length && (lines[i] as string).includes('|') && !isBlank(lines[i] as string)) {
        const row = lines[i] as string;
        if (!TABLE_DELIM.test(row)) {
          const cells = row.replace(/^ {0,3}\|/, '').replace(/\|[ \t]*$/, '').split('|').map((c) => c.trim());
          rows.push(cells.join(' — '));
        }
        i += 1;
      }
      tableCount += 1;
      const md = noteImages(rows.join('\n\n'));
      blocks.push({ kind: 'other', md, loss: 'table', ...(src ? { src } : {}) });
      continue;
    }

    // A task-list item degrades to its text with the checkbox spelled out.
    const task = TASK.exec(line);
    if (task) {
      taskCount += 1;
      const done = (task[2] as string).toLowerCase() === 'x';
      const text = noteImages(`${done ? '[done]' : '[todo]'} ${task[3] as string}`);
      blocks.push({ kind: 'para', md: text, text, ...(src ? { src } : {}) });
      i += 1;
      continue;
    }

    // A standalone image becomes an image block.
    const image = IMAGE_LINE.exec(line);
    if (image) {
      const alt = image[1] as string;
      const token = registerImage(image[2] as string);
      blocks.push({ kind: 'image', assetRef: token, alt, ...(src ? { src } : {}) });
      i += 1;
      continue;
    }

    // A paragraph: consecutive lines until a blank line or an interrupting
    // block. A setext underline turns the collected line(s) into a heading.
    const para: string[] = [line];
    i += 1;
    let setextLevel = 0;
    while (i < lines.length) {
      const cur = lines[i] as string;
      if (isBlank(cur)) break;
      const setext = SETEXT.exec(cur);
      if (setext && para.length > 0) {
        setextLevel = (setext[1] as string)[0] === '=' ? 1 : 2;
        i += 1;
        break;
      }
      if (interruptsParagraph(cur)) break;
      para.push(cur);
      i += 1;
    }
    const text = noteImages(para.join(' ').trim());
    if (setextLevel > 0) {
      blocks.push({ kind: 'heading', level: setextLevel, text, md: `${'#'.repeat(setextLevel)} ${text}`, ...(src ? { src } : {}) });
    } else if (text !== '') {
      blocks.push({ kind: 'para', md: noteImages(para.join('\n')), text, ...(src ? { src } : {}) });
    }
  }

  if (tableCount > 0) losses.push({ code: 'table', count: tableCount, message: `${tableCount} table(s) kept as prose.` });
  if (taskCount > 0) losses.push({ code: 'formatting', count: taskCount, message: `${taskCount} task-list item(s) kept as prose.` });

  return { blocks, footnotes, losses, imageRefs, imageTargets };
}
