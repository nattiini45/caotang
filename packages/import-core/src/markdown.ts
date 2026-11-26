/**
 * Caotang-dialect Markdown escaping, shared by every document reader (import-core.md §2.1): `escapeInline` escapes what
 * Markdown would read as inline syntax, `escapeLineStarts` what it would read at the start of a line. Only the characters
 * Markdown reads are escaped, so a writer's ampersands and underscores in names stay as they were typed. The same helpers
 * live in @caotang/import-rtf's run renderer; keep the two copies identical until the RTF reader moves here too.
 */

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
