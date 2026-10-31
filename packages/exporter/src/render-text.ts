/**
 * The two string renderers — Markdown and plain text — [exporter.md §3](../../../docs/architecture/exporter.md).
 *
 * Both are string assembly with no dependency (§3's table: "string assembly (no
 * deps)"), both are synchronous, and both are deterministic over their input, which
 * is what lets a test pin the whole output rather than a sample of it.
 *
 * - **Markdown** keeps each scene body as the author wrote it, because the body *is*
 *   Markdown. A heading is one `#` more than its folder's depth, because the title
 *   page holds the `#`: a chapter of a book without parts is `##`, and in a book with
 *   parts a part is `##` and its chapters `###`. The contents list is an anchor list
 *   after the title page (§2's TOC policy, default on), a chapter indented under its part.
 * - **Plain text** reduces each body through the shared prose model, so emphasis
 *   markers are gone and a thematic break is the `* * *` the plain family uses.
 *   Chapters are uppercase lines, `CHAPTER 1. THE LANDING`, a part is its label in
 *   capitals (`PART ONE`), and there is no contents list (§3: "TXT = none").
 */

import { anchorOf } from './template.js';
import { chapterHeadings, hasTitlePage, headingsByBlock, sectionTitle, type RenderInput } from './render-input.js';
import { parseProse, plainProse } from './prose.js';

export function renderMarkdown(input: RenderInput): string {
  const lines: string[] = [];
  const headings = chapterHeadings(input);
  let contentsWritten = false;

  const writeContents = (): void => {
    if (contentsWritten || !input.toc || headings.length === 0) return;
    contentsWritten = true;
    lines.push('**Contents**', '');
    for (const heading of headings) {
      lines.push(`${'  '.repeat(Math.max(0, heading.level - 1))}- [${heading.label}](#${anchorOf(heading.label)})`);
    }
    lines.push('');
  };

  if (!hasTitlePage(input)) writeContents();

  const byBlock = headingsByBlock(input);
  /** The depth of the heading the text is under, so a `section` scene's heading sits one level below it. */
  let depth = 1;
  input.blocks.forEach((block, index) => {
    switch (block.kind) {
      case 'frontmatter':
        if (block.fmKind === 'titlepage') {
          lines.push(`# ${input.title}`, '');
          if (input.author !== '') lines.push(input.author, '');
          lines.push(input.date, '');
          writeContents();
        }
        break;
      case 'chapter': {
        const heading = byBlock.get(index);
        depth = block.level;
        lines.push(`${hashes(block.level + 1)} ${heading?.label ?? block.title}`, '');
        break;
      }
      case 'scene': {
        const section = sectionTitle(block);
        if (section !== undefined) lines.push(`${hashes(depth + 2)} ${section}`, '');
        // The body *is* Markdown, so it is written as the author wrote it. Only the blank lines that would leave a gap
        // under the heading are dropped and the file's own trailing newlines are trimmed; the leading indentation of the
        // first line is kept, because it is what makes an indented code block a code block.
        lines.push(block.body.replace(/^\n+/, '').trimEnd(), '');
        break;
      }
      case 'separator':
        lines.push(input.template.separator.md, '');
        break;
      case 'backmatter':
        break;
    }
  });
  return `${lines.join('\n').trimEnd()}\n`;
}

/** An ATX heading's marker: `level` hashes, from 1 to the six CommonMark has. */
function hashes(level: number): string {
  return '#'.repeat(Math.min(6, Math.max(1, level)));
}

export function renderText(input: RenderInput): string {
  const lines: string[] = [];
  const separator = input.template.separator.plain;
  const byBlock = headingsByBlock(input);

  input.blocks.forEach((block, index) => {
    switch (block.kind) {
      case 'frontmatter':
        if (block.fmKind === 'titlepage') {
          lines.push(input.title, '');
          if (input.author !== '') lines.push(input.author, '');
          lines.push(input.date, '');
        }
        break;
      case 'chapter':
        lines.push(
          block.part === true
            ? (byBlock.get(index)?.label ?? block.title).toUpperCase()
            : `CHAPTER ${block.number}. ${block.title.toUpperCase()}`,
          '',
        );
        break;
      case 'scene': {
        const section = sectionTitle(block);
        if (section !== undefined) lines.push(section.toUpperCase(), '');
        const text = plainProse(parseProse(block.body), separator).trim();
        if (text !== '') lines.push(text, '');
        break;
      }
      case 'separator':
        lines.push(separator, '');
        break;
      case 'backmatter':
        break;
    }
  });
  return `${lines.join('\n').trimEnd()}\n`;
}
