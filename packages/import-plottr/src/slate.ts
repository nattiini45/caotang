/**
 * The Slate → Markdown walker the Plottr reader uses (#290, epic #263): Plottr writes every card description,
 * character note and note page as a Slate document — a list of blocks, each a list of inline leaves. This walks it
 * into Caotang-dialect Markdown: paragraphs, headings, lists, bold, italic, underline (as HTML), links and images
 * Plottr keeps inline. No DOM, no third-party dependency.
 */

/** A Slate leaf: a text run with marks. */
interface SlateLeaf {
  readonly text?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly code?: boolean;
  readonly type?: string;
  readonly url?: string;
  readonly children?: readonly SlateLeaf[];
}

const isSafeTarget = (url: string): boolean => /^https?:\/\//i.test(url) || url.startsWith('mailto:') || url.startsWith('#') || url.startsWith('/');

/** One inline run, or an element with children (link, image). */
function leafMarkdown(leaf: SlateLeaf): string {
  const children = leaf.children;
  if (typeof leaf.text === 'string') {
    let text = leaf.text;
    if (leaf.code === true && text !== '') text = `\`${text}\``;
    if (leaf.bold === true && text.trim() !== '') text = `**${text}**`;
    if (leaf.italic === true && text.trim() !== '') text = `*${text}*`;
    if (leaf.underline === true && text.trim() !== '') text = `<u>${text}</u>`;
    return text;
  }
  if (leaf.type === 'link') {
    const inside = (children ?? []).map(leafMarkdown).join('');
    const url = typeof leaf.url === 'string' ? leaf.url : '';
    if (inside.trim() === '') return '';
    return isSafeTarget(url) ? `[${inside}](${url})` : inside;
  }
  if (leaf.type === 'image-link') {
    const url = typeof leaf.url === 'string' ? leaf.url : '';
    return isSafeTarget(url) ? `![${url}](${url})` : '';
  }
  return (children ?? []).map(leafMarkdown).join('');
}

/** One Slate block: paragraph, heading, list item or list container. */
function blockMarkdown(block: SlateLeaf, depth: number): string {
  const type = block.type ?? 'paragraph';
  const children = (block.children ?? []).map((child) => {
    if (child.type === 'bulleted-list' || child.type === 'numbered-list') return blockMarkdown(child, depth + 1);
    return leafMarkdown(child);
  });
  if (type === 'bulleted-list' || type === 'numbered-list') {
    const items = block.children ?? [];
    return items
      .map((item, index) => {
        const marker = type === 'numbered-list' ? `${index + 1}.` : '-';
        return `${'  '.repeat(depth)}${marker} ${item.children !== undefined ? blockMarkdown(item, depth) : leafMarkdown(item)}`;
      })
      .join('\n');
  }
  const line = children.join('').trimEnd();
  if (line === '') return '';
  if (/^heading-(one|two|three|four)$/.test(type)) {
    const level = { 'heading-one': '#', 'heading-two': '##', 'heading-three': '###', 'heading-four': '####' }[type] as string;
    return `${level} ${line}`;
  }
  if (type === 'blockquote') return line.split('\n').map((row) => `> ${row}`).join('\n');
  return line;
}

/** The whole Slate document as Markdown, blocks separated by a blank line. */
export function slateToMarkdown(document: unknown): string {
  if (!Array.isArray(document)) return '';
  return document
    .map((block) => blockMarkdown(block as SlateLeaf, 0))
    .filter((row) => row !== '')
    .join('\n\n');
}
