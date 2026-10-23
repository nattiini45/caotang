/**
 * Twee 3 import — [dialogue-narrative.md §4 (Import)](../../../docs/architecture/dialogue-narrative.md).
 *
 * A Twee file is a container of passages; the link and macro syntax inside them belongs to the story
 * format that `StoryData` names. So the reader is format-aware. SugarCube 2 is read: `[[…]]` links become
 * Ink choices, `<<…>>` macros are stripped and counted. Any other format (or none) is structure only:
 * passages and prose arrive, links are reduced to their text, and the report says so.
 *
 * One story is one container whose Ink body holds one knot per passage. This is a plan, not a write: the
 * report is shown before the writer confirms, and `dialogue.importInk` writes the container.
 */

import type { ImportedContainer } from './import-ink.js';

export interface TweeImportReport {
  /** The `StoryData.format` the file names, or null when it names none. */
  readonly format: string | null;
  readonly formatVersion: string | null;
  /** `sugarcube-2` when links became choices; `structure-only` when the format is not one the reader knows. */
  readonly reading: 'sugarcube-2' | 'structure-only';
  /** Passages that became knots. */
  readonly passages: number;
  readonly choices: number;
  /** Macro tags removed, closing tags not counted, plus the setters on links. */
  readonly strippedMacros: number;
  /** Links reduced to their text because the format's link syntax is not known. 0 when links were read. */
  readonly strippedLinks: number;
  /** The names of the passages left out as scripts, styles and the format's own special passages. */
  readonly skippedSpecial: readonly string[];
  readonly warnings: readonly string[];
}

export interface TweeImportPlan {
  /** Null when the file holds no passage to import. */
  readonly container: ImportedContainer | null;
  readonly report: TweeImportReport;
}

interface Passage {
  readonly name: string;
  readonly tags: readonly string[];
  readonly text: string;
  readonly hasMeta: boolean;
}

/** The passage names SugarCube 2 reserves for its own script, styling and page furniture. */
const SUGARCUBE_SPECIAL = new Set([
  'StoryInit', 'PassageReady', 'PassageDone', 'PassageHeader', 'PassageFooter', 'StoryBanner', 'StoryCaption',
  'StoryMenu', 'StorySubtitle', 'StoryAuthor', 'StoryDisplayTitle', 'StoryShare', 'StoryInterface',
]);
const SKIPPED_TAGS = ['script', 'stylesheet', 'Twine.image'];
const SUGARCUBE_SKIPPED_TAGS = ['widget', 'init'];
/** Macros whose body is not story text: code to drop, with the macros inside a silent body still counted. */
const CODE_BODY = new Set(['script', 'widget']);
const SILENT_BODY = new Set(['silently']);
const CONDITIONAL = new Set(['if', 'elseif', 'else']);

/** Words Ink reads as syntax, or as one of its built-in functions, so a knot cannot carry them as its name. */
const RESERVED = new Set([
  'END', 'DONE', 'function', 'VAR', 'CONST', 'LIST', 'EXTERNAL', 'INCLUDE', 'TODO', 'true', 'false', 'not', 'and', 'or', 'mod',
  'else', 'return', 'temp', 'ref', 'knot',
  'RANDOM', 'SEED_RANDOM', 'TURNS', 'TURNS_SINCE', 'CHOICE_COUNT', 'READ_COUNT', 'INT', 'FLOOR', 'FLOAT', 'POW', 'MIN', 'MAX',
  'LIST_VALUE', 'LIST_RANDOM', 'LIST_ALL', 'LIST_COUNT', 'LIST_MIN', 'LIST_MAX', 'LIST_INVERT',
]);
const LINE_KEYWORDS = ['TODO', 'VAR ', 'CONST ', 'LIST ', 'INCLUDE ', 'EXTERNAL '];

const TITLE_MAX = 200;

/** Plans the import of one Twee 3 file. Pure: the same source gives the same plan. */
export function planTweeImport(source: string): TweeImportPlan {
  const warnings: string[] = [];
  const { passages, title, data } = readTwee(source, warnings);

  const format = typeof data.format === 'string' && data.format.trim() !== '' ? data.format.trim() : null;
  const formatVersion = typeof data['format-version'] === 'string' && data['format-version'].trim() !== '' ? data['format-version'].trim() : null;
  const sugarcube = format !== null && format.toLowerCase() === 'sugarcube' && (formatVersion === null || formatVersion.startsWith('2'));
  if (sugarcube && formatVersion === null) warnings.push('The story names SugarCube but no version; it was read as SugarCube 2.');

  const skippedTags = sugarcube ? [...SKIPPED_TAGS, ...SUGARCUBE_SKIPPED_TAGS] : SKIPPED_TAGS;
  const skippedSpecial: string[] = [];
  const kept: Passage[] = [];
  for (const passage of passages) {
    const special = passage.tags.some((tag) => skippedTags.includes(tag)) || (sugarcube && SUGARCUBE_SPECIAL.has(passage.name));
    if (special) skippedSpecial.push(passage.name);
    else kept.push(passage);
  }

  // Knot names are minted once for the whole story, so a link can name any of them.
  const used = new Set<string>();
  const knotNames = kept.map((passage) => mintKnotName(passage.name, used));
  const knotOf = new Map<string, string>();
  kept.forEach((passage, i) => {
    if (knotOf.has(passage.name)) warnings.push(`Two passages are named "${passage.name}". Links to that name go to the first.`);
    else knotOf.set(passage.name, knotNames[i] ?? '');
  });

  const counts = { macros: 0, links: 0, choices: 0, conditional: 0 };
  const sections = kept.map((passage, i) => {
    const knot = knotNames[i] ?? '';
    const lines = [`=== ${knot} ===`];
    const label = passage.tags.length > 0 ? `${passage.name} [${passage.tags.join(' ')}]` : passage.name;
    if (knot !== passage.name || passage.tags.length > 0) lines.push(`// Twee passage: ${label.replace(/[\r\n]+/g, ' ')}`);
    const { prose, links } = readPassage(passage.text, sugarcube, counts, warnings, passage.name);
    lines.push(...prose);
    for (const link of links) {
      const target = knotOf.get(link.target);
      if (target === undefined) {
        warnings.push(`In "${passage.name}", the link "${link.label}" goes to "${link.target}", which is not a passage. The choice ends the story.`);
      }
      lines.push(`+ [${escapeInk(link.label, true)}] -> ${target ?? 'END'}`);
      counts.choices += 1;
    }
    if (links.length === 0) lines.push('-> END');
    return lines.join('\n');
  });

  const entryName = [data.start, 'Start'].find((name): name is string => typeof name === 'string' && knotOf.has(name));
  if (typeof data.start === 'string' && data.start !== entryName) {
    warnings.push(
      `StoryData names "${data.start}" as the start, and no passage has that name. The story starts at ${entryName === undefined ? 'the first passage' : '"Start"'}.`,
    );
  }
  if (counts.conditional > 0) {
    warnings.push(`${counts.conditional} conditional tags (if, elseif, else) were stripped. The text in every branch is kept and now always shows.`);
  }
  if (kept.some((passage) => passage.hasMeta)) warnings.push('Passage positions and other metadata were not kept.');
  if (!sugarcube) {
    warnings.push(
      format === null
        ? 'The story names no story format, so its links and macros are not read.'
        : `This story uses ${[format, formatVersion].filter((part) => part !== null).join(' ')}. Caotang reads SugarCube 2's links and macros, so this one was imported as structure only.`,
    );
    warnings.push("Macros written in the format's own syntax, other than <<…>>, are not recognised: they stay in the text and are not counted.");
  }

  const report: TweeImportReport = {
    format,
    formatVersion,
    reading: sugarcube ? 'sugarcube-2' : 'structure-only',
    passages: kept.length,
    choices: counts.choices,
    strippedMacros: counts.macros,
    strippedLinks: counts.links,
    skippedSpecial,
    warnings,
  };
  if (kept.length === 0) return { container: null, report };

  const entry = entryName === undefined ? knotNames[0] : knotOf.get(entryName);
  const body = [`-> ${entry ?? ''}`, '', sections.join('\n\n')].join('\n') + '\n';
  const container: ImportedContainer = { title: titleOf(title, kept[0]?.name), knots: knotNames, body };
  return { container, report };
}

/** The report as the sentences the writer reads before confirming, in the order the dialog lists them. */
export function describeTweeReport(report: TweeImportReport): string[] {
  const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const read = report.reading === 'sugarcube-2' ? 'SugarCube 2' : [report.format ?? 'No story format', report.formatVersion].filter((p) => p !== null).join(' ');
  const lines = [
    `Story format: ${read}${report.reading === 'structure-only' ? ' (structure only)' : ''}.`,
    `${plural(report.passages, 'passage')} will become knots, with ${plural(report.choices, 'choice')}.`,
  ];
  lines.push(
    `${report.strippedMacros} logic ${report.strippedMacros === 1 ? 'block' : 'blocks'} stripped — Twine story formats are programming environments.`,
  );
  if (report.reading === 'structure-only') {
    lines.push(`${plural(report.strippedLinks, 'link')} stripped to ${report.strippedLinks === 1 ? 'its' : 'their'} text: this story arrives without its branches.`);
  }
  lines.push(
    report.skippedSpecial.length === 0
      ? 'No script, style or special passage was skipped.'
      : `${plural(report.skippedSpecial.length, 'special passage')} skipped: ${report.skippedSpecial.join(', ')}.`,
  );
  return lines;
}

/* ------------------------------------------------------------------ *
 * The Twee 3 container.
 * ------------------------------------------------------------------ */

function readTwee(source: string, warnings: string[]): { passages: Passage[]; title: string; data: Record<string, unknown> } {
  const lines = source.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const raw: { header: string; body: string[] }[] = [];
  let above = false;
  for (const line of lines) {
    if (line.startsWith('::')) raw.push({ header: line.slice(2), body: [] });
    else if (raw.length > 0) raw[raw.length - 1]?.body.push(line);
    else if (line.trim() !== '') above = true;
  }
  if (above) warnings.push('Text above the first passage header was not imported.');

  const passages: Passage[] = [];
  let title = '';
  let data: Record<string, unknown> = {};
  for (const { header, body } of raw) {
    while (body.length > 0 && (body[body.length - 1] ?? '').trim() === '') body.pop();
    const text = body.join('\n');
    const head = readHeader(header, warnings);
    if (head.name === 'StoryTitle') title = text.trim();
    else if (head.name === 'StoryData') {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
        else warnings.push('StoryData is not a JSON object and was ignored.');
      } catch {
        warnings.push('StoryData is not valid JSON and was ignored, so the story format is unknown.');
      }
    } else passages.push({ name: head.name, tags: head.tags, text, hasMeta: head.hasMeta });
  }
  return { passages, title, data };
}

/** Decodes the Twee escapes: a backslash before `[`, `]`, `{`, `}` or `\` gives that character. */
function unescapeTwee(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    const next = text[i + 1] ?? '';
    if (ch === '\\' && '[]{}\\'.includes(next) && next !== '') {
      out += next;
      i += 1;
    } else out += ch;
  }
  return out;
}

/** The index of the first `target` in `text` from `from` that no backslash escapes, or -1. */
function indexUnescaped(text: string, target: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === target) return i;
  }
  return -1;
}

/**
 * A header is a name, then an optional `[tags]`, then an optional `{json}`. A line that does not read
 * that way (an unescaped bracket in the name, a tag block never closed) is not split: the whole line is
 * the name, and a warning says so.
 */
function readHeader(header: string, warnings: string[]): { name: string; tags: string[]; hasMeta: boolean } {
  const open = Math.min(...['[', '{'].map((ch) => indexUnescaped(header, ch, 0)).map((i) => (i < 0 ? header.length : i)));
  let name = header.slice(0, open);
  let rest = header.slice(open).trim();
  let tags: string[] = [];
  let hasMeta = false;
  let ok = !hasUnescaped(name, ']}');
  if (ok && rest.startsWith('[')) {
    const close = indexUnescaped(rest, ']', 1);
    if (close < 0) ok = false;
    else {
      tags = unescapeTwee(rest.slice(1, close)).split(/\s+/).filter((tag) => tag !== '');
      rest = rest.slice(close + 1).trim();
    }
  }
  if (ok && rest !== '') {
    ok = rest.startsWith('{') && rest.endsWith('}');
    hasMeta = ok;
  }
  if (!ok) {
    name = header;
    tags = [];
    hasMeta = false;
    warnings.push(`The header ":: ${header.trim()}" has a bracket that is not escaped, so the whole line is the passage name. Escape [ ] { } with a backslash.`);
  }
  return { name: unescapeTwee(name.trim()), tags, hasMeta };
}

function hasUnescaped(text: string, chars: string): boolean {
  return [...chars].some((ch) => indexUnescaped(text, ch, 0) >= 0);
}

/* ------------------------------------------------------------------ *
 * A passage's text: links and macros.
 * ------------------------------------------------------------------ */

interface PassageLink {
  readonly label: string;
  readonly target: string;
}

type Piece = { readonly kind: 'text'; readonly value: string } | { readonly kind: 'link'; readonly link: PassageLink } | { readonly kind: 'macro' };

interface Counts {
  macros: number;
  links: number;
  choices: number;
  conditional: number;
}

/** Splits a passage into text, links and removed macros, counting what it removes. Scans; no pattern runs over the text. */
function scanPassage(text: string, counts: Counts, withLinks: boolean, countOnly = false): Piece[] {
  const pieces: Piece[] = [];
  let from = 0;
  let i = 0;
  const flush = (to: number): void => {
    if (to > from && !countOnly) pieces.push({ kind: 'text', value: text.slice(from, to) });
  };
  while (i < text.length) {
    if (text.startsWith('<<', i)) {
      const end = text.indexOf('>>', i + 2);
      if (end >= 0) {
        flush(i);
        const inner = text.slice(i + 2, end);
        const closing = inner.startsWith('/');
        const name = (closing ? inner.slice(1) : inner).split(/\s/, 1)[0] ?? '';
        i = end + 2;
        if (!closing) {
          counts.macros += 1;
          if (CONDITIONAL.has(name)) counts.conditional += 1;
          if (CODE_BODY.has(name) || SILENT_BODY.has(name)) {
            const close = text.indexOf(`<</${name}>>`, i);
            const bodyEnd = close < 0 ? text.length : close;
            // A silent body is logic made of macros, and each counts. A script or widget body is code.
            if (SILENT_BODY.has(name)) scanPassage(text.slice(i, bodyEnd), counts, withLinks, true);
            i = close < 0 ? text.length : close + `<</${name}>>`.length;
          }
        }
        from = i;
        if (!countOnly) pieces.push({ kind: 'macro' });
        continue;
      }
    }
    if (text.startsWith('[[', i)) {
      const end = text.indexOf(']]', i + 2);
      const inner = end < 0 ? '' : text.slice(i + 2, end);
      if (end >= 0 && inner !== '' && !inner.includes('\n')) {
        flush(i);
        const setter = inner.indexOf('][');
        if (setter >= 0 && withLinks) counts.macros += 1;
        const link = splitLink(setter < 0 ? inner : inner.slice(0, setter));
        if (!withLinks) counts.links += 1;
        if (!countOnly) pieces.push({ kind: 'link', link });
        i = end + 2;
        from = i;
        continue;
      }
    }
    i += 1;
  }
  flush(text.length);
  return pieces;
}

/** SugarCube's link forms: the rightmost `->`, else the leftmost `<-`, else the first `|`, else the target alone. */
function splitLink(inner: string): PassageLink {
  const right = inner.lastIndexOf('->');
  if (right >= 0) return { label: inner.slice(0, right).trim(), target: inner.slice(right + 2).trim() };
  const left = inner.indexOf('<-');
  if (left >= 0) return { label: inner.slice(left + 2).trim(), target: inner.slice(0, left).trim() };
  const bar = inner.indexOf('|');
  if (bar >= 0) return { label: inner.slice(0, bar).trim(), target: inner.slice(bar + 1).trim() };
  return { label: inner.trim(), target: inner.trim() };
}

/**
 * One passage's prose lines (already Ink-safe) and its links in order. When links are read, a line that held
 * only links and macros is dropped, and a link inside a sentence leaves its text in the sentence while the
 * choice follows. When they are not read, every link's text stays in the prose.
 */
function readPassage(text: string, sugarcube: boolean, counts: Counts, warnings: string[], name: string): { prose: string[]; links: PassageLink[] } {
  const pieces = scanPassage(text, counts, sugarcube);
  const lines: { full: string; plain: string; marked: boolean }[] = [{ full: '', plain: '', marked: false }];
  const links: PassageLink[] = [];
  for (const piece of pieces) {
    const line = lines[lines.length - 1];
    if (line === undefined) continue;
    if (piece.kind === 'macro') line.marked = true;
    else if (piece.kind === 'link') {
      line.marked = true;
      line.full += piece.link.label;
      if (sugarcube) {
        if (piece.link.target === '') warnings.push(`In "${name}", a link names no passage and was dropped.`);
        else links.push({ label: piece.link.label === '' ? piece.link.target : piece.link.label, target: piece.link.target });
      }
    } else {
      const parts = piece.value.split('\n');
      parts.forEach((part, k) => {
        if (k > 0) lines.push({ full: '', plain: '', marked: false });
        const current = lines[lines.length - 1];
        if (current === undefined) return;
        current.full += part;
        current.plain += part;
      });
    }
  }
  const prose: string[] = [];
  for (const line of lines) {
    const plain = line.plain.trim();
    const full = line.full.trim();
    // A link read as a choice is not prose, so its line is dropped. When links are only reduced to text, that text is the prose.
    if (plain === '' && line.marked && (sugarcube || full === '')) continue;
    if (full === '') {
      if (prose.length > 0 && prose[prose.length - 1] !== '') prose.push('');
      continue;
    }
    prose.push(escapeInk(full, false));
  }
  while (prose.length > 0 && prose[prose.length - 1] === '') prose.pop();
  return { prose, links };
}

/* ------------------------------------------------------------------ *
 * Ink.
 * ------------------------------------------------------------------ */

/** Backslash-escapes what Ink would read as syntax in a line of prose, or in a choice label when `label` is set. */
function escapeInk(text: string, label: boolean): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    const next = text[i + 1] ?? '';
    const syntax =
      ch === '\\' || ch === '{' || ch === '}' || ch === '|' || ch === '#' || (label && (ch === '[' || ch === ']')) ||
      (ch === '-' && next === '>') || (ch === '<' && (next === '-' || next === '>')) || (ch === '/' && (next === '/' || next === '*'));
    out += syntax ? `\\${ch}` : ch;
  }
  if (!label && (/^[*+\-=~>]/.test(out) || LINE_KEYWORDS.some((keyword) => out.startsWith(keyword)))) out = `\\${out}`;
  return out;
}

/** A valid, unused Ink knot name for a passage name: letters, digits and underscores, never a keyword. */
function mintKnotName(passageName: string, used: Set<string>): string {
  let base = trimUnderscores(passageName.normalize('NFKD').replace(/[^\p{L}\p{N}_]+/gu, '_'));
  if (base === '') base = 'passage';
  else if (/^\p{N}/u.test(base) || RESERVED.has(base)) base = `p_${base}`;
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  used.add(name);
  return name;
}

function trimUnderscores(text: string): string {
  let from = 0;
  let to = text.length;
  while (from < to && text[from] === '_') from += 1;
  while (to > from && text[to - 1] === '_') to -= 1;
  return text.slice(from, to);
}

function titleOf(title: string, firstPassage: string | undefined): string {
  const named = title.split('\n', 1)[0]?.trim() ?? '';
  return (named !== '' ? named : firstPassage ?? 'Imported Twee story').slice(0, TITLE_MAX);
}
