/**
 * The Obsidian syntax preprocessor (#281, epic #263): wikilinks, embeds, `%%comments%%`,
 * `==highlights==`, callouts, `^block-id`, `#tags` and Dataview fields, resolved to plain
 * Markdown plus the facts they carry. Fenced code and inline code are left untouched, so a
 * wikilink inside a code span is never rewritten. The vault reader resolves the embed tokens
 * against the vault's files; this module only names them.
 */

export interface ObsidianEmbed {
  /** The embedded note or attachment name, without `![[` / `]]` and without the `|alias`. */
  readonly target: string;
  readonly isImage: boolean;
  /** The `|alias` (or image width), kept as the picture's alt text. */
  readonly alt: string;
  /** The placeholder the body carries, resolved by the vault reader. */
  readonly token: string;
}

export interface ObsidianPreprocess {
  readonly body: string;
  readonly notes: readonly string[];
  readonly keywords: readonly string[];
  readonly dataview: Record<string, string>;
  readonly embeds: readonly ObsidianEmbed[];
  readonly highlights: number;
  readonly blockIds: number;
  readonly callouts: number;
  readonly wikilinks: number;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif|tiff?)$/i;
// Private-use sentinels mark protected inline code; they cannot occur in a writer's Markdown.
const CODE_OPEN = String.fromCharCode(0xe000);
const CODE_CLOSE = String.fromCharCode(0xe001);
const CODE_RESTORE = new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, 'g');

/** Split a `[[target|alias]]` inner into its target and display alias. */
function splitLink(inner: string): { target: string; alias: string } {
  const bar = inner.indexOf('|');
  if (bar === -1) return { target: inner.trim(), alias: '' };
  return { target: inner.slice(0, bar).trim(), alias: inner.slice(bar + 1).trim() };
}

/** The display text of a wikilink: its alias, else the note name without a `#heading` or `#^block`. */
function linkDisplay(inner: string): string {
  const { target, alias } = splitLink(inner);
  if (alias !== '') return alias;
  const hash = target.indexOf('#');
  const name = hash === -1 ? target : target.slice(0, hash);
  return name === '' ? target : name;
}

export function preprocessObsidian(text: string): ObsidianPreprocess {
  const notes: string[] = [];
  const keywords: string[] = [];
  const dataview: Record<string, string> = {};
  const embeds: ObsidianEmbed[] = [];
  let highlights = 0;
  let blockIds = 0;
  let callouts = 0;
  let wikilinks = 0;

  const addKeyword = (tag: string): void => {
    const clean = tag.trim();
    if (clean !== '' && !keywords.includes(clean)) keywords.push(clean);
  };

  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceChar = '';
  let inComment = false;
  let commentBuf = '';

  for (const raw of lines) {
    let line = raw;

    // Fenced code blocks pass through untouched.
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence !== null) {
      const mark = fence[1]?.[0] ?? '`';
      if (!inFence) {
        inFence = true;
        fenceChar = mark;
      } else if (mark === fenceChar) {
        inFence = false;
      }
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    // `%%comments%%` may span lines; carry the open state and buffer across them.
    if (inComment) commentBuf += '\n';
    const normal: string[] = [];
    let rest = line;
    while (rest.length > 0) {
      const idx = rest.indexOf('%%');
      if (inComment) {
        if (idx === -1) {
          commentBuf += rest;
          rest = '';
        } else {
          commentBuf += rest.slice(0, idx);
          const clean = commentBuf.trim();
          if (clean !== '') notes.push(clean);
          commentBuf = '';
          inComment = false;
          rest = rest.slice(idx + 2);
        }
      } else if (idx === -1) {
        normal.push(rest);
        rest = '';
      } else {
        normal.push(rest.slice(0, idx));
        inComment = true;
        commentBuf = '';
        rest = rest.slice(idx + 2);
      }
    }
    line = normal.join('');

    // Protect inline code so none of the rewrites below touch it.
    const spans: string[] = [];
    line = line.replace(/`[^`\n]*`/g, (whole) => {
      spans.push(whole);
      return `${CODE_OPEN}${spans.length - 1}${CODE_CLOSE}`;
    });

    // A callout opens with `> [!type]`; keep it a blockquote and name its type.
    const callout = line.match(/^(\s*)>\s*\[!([A-Za-z-]+)\][+-]?\s*(.*)$/);
    if (callout !== null) {
      const label = (callout[2] ?? 'note').charAt(0).toUpperCase() + (callout[2] ?? 'note').slice(1).toLowerCase();
      const title = callout[3] ?? '';
      line = `${callout[1] ?? ''}> **${label}**${title === '' ? '' : ` ${title}`}`;
      callouts += 1;
    }

    // A Dataview field on its own line (`Key:: value`) is metadata, not prose.
    const ownField = line.match(/^\s*([A-Za-z][A-Za-z0-9 _-]*)::\s*(.*)$/);
    if (ownField !== null && callout === null) {
      const key = (ownField[1] ?? '').trim();
      if (key !== '') dataview[key] = (ownField[2] ?? '').trim();
      line = '';
    }

    // Embeds `![[target|alias]]` become tokens the vault reader resolves.
    line = line.replace(/!\[\[([^[\]]+)\]\]/g, (_whole, inner: string) => {
      const { target, alias } = splitLink(inner);
      const isImage = IMAGE_EXT.test(target);
      const token = `import:obsidian-embed-${embeds.length}`;
      embeds.push({ target, isImage, alt: alias, token });
      return token;
    });

    // Wikilinks `[[target|alias]]` become their display text.
    line = line.replace(/\[\[([^[\]]+)\]\]/g, (_whole, inner: string) => {
      wikilinks += 1;
      return linkDisplay(inner);
    });

    // `==highlight==` keeps the text and drops the markers.
    line = line.replace(/==([^=\n]+)==/g, (_whole, inner: string) => {
      highlights += 1;
      return inner;
    });

    // Inline Dataview `[key:: value]` / `(key:: value)` keeps the rendered value.
    line = line.replace(/\[([^\][\n:]+)::\s*([^\][\n]*)\]/g, (_whole, key: string, value: string) => {
      dataview[key.trim()] = value.trim();
      return value.trim();
    });
    line = line.replace(/\(([^()\n:]+)::\s*([^()\n]*)\)/g, (_whole, key: string, value: string) => {
      dataview[key.trim()] = value.trim();
      return value.trim();
    });

    // `#tag` becomes a keyword; a heading (`# Word`) is left alone because a tag has no space.
    line = line.replace(/(^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g, (_whole, lead: string, tag: string) => {
      addKeyword(tag);
      return lead;
    });

    // A trailing `^block-id` is an anchor, not prose.
    line = line.replace(/\s*\^([A-Za-z0-9-]+)\s*$/, (_whole, _id: string) => {
      blockIds += 1;
      return '';
    });

    // Restore the protected inline code.
    line = line.replace(CODE_RESTORE, (_whole, index: string) => spans[Number(index)] ?? '');
    out.push(line);
  }

  // A comment left open at the end of the file is still kept.
  if (inComment) {
    const clean = commentBuf.trim();
    if (clean !== '') notes.push(clean);
  }

  return { body: out.join('\n'), notes, keywords, dataview, embeds, highlights, blockIds, callouts, wikilinks };
}
