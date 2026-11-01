/**
 * The Markdown export's image rewriting — pictures.md §4, the Markdown row, and the ground truth
 * that `renderMarkdown` preserves every byte of a body except the image construct.
 *
 * Only the image construct changes: its **destination** and its **title**. Emphasis, links, code,
 * spacing and every other byte are copied through untouched. Both spellings are handled —
 * the direct `![alt](dest "title")` and the reference style, where the destination and title
 * live in a `[label]: dest "title"` definition line — and a repeated asset is rewritten at every
 * place it appears while being copied once.
 *
 * The modes (the `pictures` recipe option): `copy` (the default) rewrites `../assets/<file>` to
 * `<name>.assets/<file>` (the folder name percent-encoded where it holds a space or a bracket), so the export resolves from
 * wherever it is moved and carries no `..`;
 * `link` keeps the project-relative destination and says in the log that moving the export away
 * from the project folder breaks the pictures; `drop` replaces the construct with its alt or
 * caption text and says so in the log. The title becomes the decoded placement caption, is
 * omitted when that caption is empty, and is kept verbatim when it carries a suffix version this
 * build cannot decode (§2.2.1).
 */

import { decodePlacementTitle, placementCaptionOf } from '@caotang/pictures';

import { assetRefOfUrl, type FigurePack, type ResolvedFigure } from './figures.js';

export type MarkdownPicturesMode = 'copy' | 'link' | 'drop';

/** One image construct found in a body, with the exact span it occupies. */
interface Construct {
  readonly start: number;
  readonly end: number;
  /** The direct spelling: the parts inside the parentheses. */
  readonly direct?: { readonly alt: string; readonly dest: string; readonly title: string | null };
  /** A reference use: the label it names (`![alt][label]`, `![alt][]` or the shortcut `![alt]`). */
  readonly label?: string;
}

/** A reference definition line: the span of its destination and of its title (with the space before it). */
interface Definition {
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly destStart: number;
  readonly destEnd: number;
  readonly titleStart: number;
  readonly titleEnd: number;
  readonly title: string | null;
}

/** Whether the character at `index` is escaped by an odd run of backslashes. */
function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  while (index - 1 - slashes >= 0 && text[index - 1 - slashes] === '\\') slashes += 1;
  return slashes % 2 === 1;
}

/** Scans a bracketed span from `open` (the `[`) to its matching `]`, honouring escapes; `null` when unbalanced. */
function bracketSpan(text: string, open: number): { readonly end: number; readonly inner: string } | null {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    const char = text[at] ?? '';
    if (char === '\\') {
      at += 1;
      continue;
    }
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return { end: at, inner: text.slice(open + 1, at) };
    }
  }
  return null;
}

/** Scans the inside of `(…)` from `open` (the `(`): the destination, then the optional title. */
function parenParts(text: string, open: number): { readonly end: number; readonly dest: string; readonly title: string | null } | null {
  let at = open + 1;
  while (at < text.length && /[ \t]/.test(text[at] ?? '')) at += 1;
  let dest: string;
  if (text[at] === '<') {
    const close = text.indexOf('>', at + 1);
    if (close < 0) return null;
    dest = text.slice(at + 1, close);
    at = close + 1;
  } else {
    const start = at;
    let depth = 0;
    while (at < text.length) {
      const char = text[at] ?? '';
      if (char === '\\') {
        at += 2;
        continue;
      }
      if (char === '(') depth += 1;
      if (char === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
      if (/[ \t]/.test(char) && depth === 0) break;
      at += 1;
    }
    dest = text.slice(start, at);
  }
  while (at < text.length && /[ \t]/.test(text[at] ?? '')) at += 1;
  let title: string | null = null;
  const char = text[at];
  if (char === '"' || char === "'") {
    // A caption with a quote in it is written `\"`, so the closing quote is the first one no backslash escapes.
    let close = at + 1;
    while (close < text.length && text[close] !== char) close += text[close] === '\\' ? 2 : 1;
    if (close >= text.length) return null;
    title = text.slice(at + 1, close);
    at = close + 1;
  } else if (char === '(') {
    let depth = 1;
    const start = at + 1;
    at += 1;
    while (at < text.length && depth > 0) {
      if (text[at] === '\\') {
        at += 2;
        continue;
      }
      if (text[at] === '(') depth += 1;
      if (text[at] === ')') depth -= 1;
      at += 1;
    }
    if (depth !== 0) return null;
    title = text.slice(start, at - 1);
  }
  while (at < text.length && /[ \t]/.test(text[at] ?? '')) at += 1;
  if (text[at] !== ')') return null;
  return { end: at + 1, dest, title };
}

/** The label a reference use names, normalised the way CommonMark matches labels. */
const labelKey = (label: string): string => label.replace(/\s+/g, ' ').trim().toLowerCase();

/** Every image construct in the body, in order. */
function constructsOf(body: string): Construct[] {
  const out: Construct[] = [];
  for (let at = 0; at < body.length - 1; at += 1) {
    if (body[at] !== '!' || body[at + 1] !== '[' || isEscaped(body, at)) continue;
    const alt = bracketSpan(body, at + 1);
    if (alt === null) continue;
    const after = alt.end + 1;
    if (body[after] === '(') {
      const parts = parenParts(body, after);
      if (parts === null) continue;
      out.push({ start: at, end: parts.end, direct: { alt: alt.inner, dest: parts.dest, title: parts.title } });
      at = parts.end - 1;
      continue;
    }
    if (body[after] === '[') {
      const label = bracketSpan(body, after);
      if (label === null) continue;
      out.push({ start: at, end: label.end + 1, label: label.inner === '' ? alt.inner : label.inner });
      at = label.end;
      continue;
    }
    // The shortcut reference: `![alt]` names the label `alt`.
    out.push({ start: at, end: after, label: alt.inner });
    at = after - 1;
  }
  return out;
}

/** Every reference definition line in the body, with the spans of its destination and title. */
function definitionsOf(body: string): Definition[] {
  const out: Definition[] = [];
  const line = /^([ \t]{0,3}\[)([^\]]+)\]:[ \t]*/gm;
  let match: RegExpExecArray | null;
  while ((match = line.exec(body)) !== null) {
    const label = match[2] ?? '';
    let at = match.index + match[0].length;
    if (at >= body.length || body[at] === '\n') continue;
    let destStart = at;
    let destEnd: number;
    if (body[at] === '<') {
      const close = body.indexOf('>', at + 1);
      if (close < 0 || close >= body.indexOf('\n', at)) continue;
      destStart = at + 1;
      destEnd = close;
      at = close + 1;
    } else {
      let end = at;
      while (end < body.length && !/[ \t\n]/.test(body[end] ?? '')) end += 1;
      destEnd = end;
      at = end;
    }
    let titleStart = -1;
    let titleEnd = -1;
    let title: string | null = null;
    const rest = body.slice(at, body.indexOf('\n', at) < 0 ? body.length : body.indexOf('\n', at));
    const titleMatch = /^[ \t]+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\(((?:[^()\\]|\\.)*)\))[ \t]*$/.exec(rest);
    if (titleMatch !== null) {
      titleStart = at + titleMatch.index;
      const quoted = titleMatch[1] ?? titleMatch[2] ?? titleMatch[3] ?? '';
      title = quoted.replace(/\\(.)/g, '$1');
      titleEnd = at + titleMatch.index + titleMatch[0].length;
      at = titleEnd;
    }
    if (body.slice(at, body.indexOf('\n', at) < 0 ? body.length : body.indexOf('\n', at)).trim() !== '') continue;
    out.push({
      start: match.index,
      end: at,
      label,
      destStart,
      destEnd,
      titleStart,
      titleEnd,
      title,
    });
  }
  return out;
}

/**
 * A folder name as it can stand in an image destination. The folder is named for the book, so it holds spaces and sometimes brackets
 * (`The Lighthouse Keeper.assets`), and a space ends a destination in CommonMark; percent-encoding those characters keeps the image a
 * picture in every renderer, and a reader decodes them back to the folder's own name.
 */
function destinationSafe(folder: string): string {
  return folder.replace(/[ ()<>[\]%#?\\]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** The title as Markdown writes it in the `"…"` slot: backslash and quote escaped. */
const quoteTitle = (title: string): string => `"${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Rewrites the image constructs of one body. `figures` is the compile's resolved pack, keyed by
 * the destination as written; when it is absent the captions come from the title codec alone and
 * every `../assets/` destination is treated as present. Notes are appended to `notes`.
 */
export function rewriteMarkdownImages(
  body: string,
  mode: MarkdownPicturesMode,
  assetsDir: string | undefined,
  figures: FigurePack | undefined,
  notes: string[],
): string {
  const constructs = constructsOf(body);
  const definitions = definitionsOf(body);
  const byLabel = new Map<string, Definition>();
  for (const definition of definitions) byLabel.set(labelKey(definition.label), definition);

  const figureOf = (dest: string): ResolvedFigure | undefined => {
    const trimmed = dest.trim();
    return figures?.figures.get(trimmed) ?? figures?.figures.get(dest);
  };

  /** The destination and title a construct exports with, or `null` to drop the construct to its text. */
  const decide = (dest: string, title: string | null): { readonly dest: string; readonly title: string | null } | null => {
    if (mode === 'drop') return null;
    const ref = assetRefOfUrl(dest);
    const figure = ref === undefined ? undefined : figureOf(dest);
    const decoded = decodePlacementTitle(title);
    const opaque = figure?.opaqueTitle !== undefined || decoded.kind === 'opaque-version';
    const caption = figure !== undefined ? figure.caption : placementCaptionOf(title);
    const newTitle = opaque ? title : caption === '' ? null : caption;
    if (mode === 'link') return { dest, title: newTitle };
    // copy
    if (ref === undefined || figure === undefined || figure.image === undefined) {
      notes.push(
        ref === undefined
          ? `a picture at ${dest} is not in the project's assets/, so its alt text is exported instead`
          : `${ref.file} is placed in the manuscript but its file is not in assets/, so its alt text is exported instead`,
      );
      return null;
    }
    if (assetsDir === undefined) throw new Error('a Markdown copy export runs without its assets folder name');
    return { dest: `${destinationSafe(assetsDir)}/${figure.image.name}`, title: newTitle };
  };

  const replacements: { start: number; end: number; text: string }[] = [];
  const usedLabels = new Set<string>();
  let dropped = 0;

  for (const construct of constructs) {
    if (construct.direct !== undefined) {
      const { alt, dest, title } = construct.direct;
      const decided = decide(dest, title);
      if (decided === null) {
        dropped += 1;
        replacements.push({ start: construct.start, end: construct.end, text: alt !== '' ? alt : placementCaptionOf(title) });
      } else {
        const titlePart = decided.title === null ? '' : ` ${quoteTitle(decided.title)}`;
        replacements.push({
          start: construct.start,
          end: construct.end,
          text: `![${alt}](${decided.dest}${titlePart})`,
        });
      }
      continue;
    }
    const label = construct.label ?? '';
    const key = labelKey(label);
    usedLabels.add(key);
    if (mode === 'drop' && byLabel.has(key)) {
      const alt = bracketSpan(body, construct.start + 1)?.inner ?? label;
      dropped += 1;
      replacements.push({ start: construct.start, end: construct.end, text: alt });
    }
  }

  for (const definition of definitions) {
    const key = labelKey(definition.label);
    // A definition no image uses belongs to a link (or to nothing), and a link's definition is the writer's, not the export's.
    if (!usedLabels.has(key)) continue;
    const dest = body.slice(definition.destStart, definition.destEnd);
    if (mode === 'drop') {
      replacements.push({ start: definition.start, end: definition.end, text: '' });
      continue;
    }
    const decided = decide(dest, definition.title);
    if (decided === null) {
      // A definition whose picture is not in the project loses its line: nothing may point at a file the export does not carry.
      replacements.push({ start: definition.start, end: definition.end, text: '' });
      continue;
    }
    const titlePart = decided.title === null ? '' : ` ${quoteTitle(decided.title)}`;
    replacements.push({
      start: definition.destStart,
      end: definition.titleStart >= 0 ? definition.titleEnd : definition.destEnd,
      text: `${decided.dest}${titlePart}`,
    });
  }

  if (mode === 'link') {
    notes.push('markdown: the pictures are linked at their project-relative paths, so moving the exported file away from the project folder breaks them');
  }
  if (mode === 'drop' && dropped > 0) {
    notes.push(`markdown: ${dropped} ${dropped === 1 ? 'picture was' : 'pictures were'} left out (the recipe’s pictures option is drop), with their alt or caption text in their place`);
  }

  let out = body;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, replacement.start) + replacement.text + out.slice(replacement.end);
  }
  return out;
}
