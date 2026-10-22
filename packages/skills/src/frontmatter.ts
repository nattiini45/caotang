/**
 * The front matter reader — a small YAML reader for the keys a skill uses (extensibility.md §10).
 *
 * It reads plain, quoted (single and double, on one line or several), folded (`>`) and literal (`|`) scalars, a block or flow list,
 * and a one-level map, which is what real `SKILL.md` files hold. It never writes: the file's own front matter text is kept as it is,
 * because a YAML dumper reorders keys and the bytes must round-trip. What it does not read it refuses, and a refusal is a skill that is
 * not offered, never a guess: anchors, aliases, tags, directives, more than one document, tab indentation, a duplicate key, and a plain
 * value that a YAML parser would also refuse (`a: b: c`).
 *
 * No regex here runs over text a stranger wrote: the scans are by character, so none can backtrack.
 */

export class FrontMatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontMatterError';
  }
}

/** One top-level field's value. `style` says how a scalar was written, because `"true"` is a string and `true` is a boolean. */
export type FieldValue =
  | { readonly kind: 'scalar'; readonly value: string; readonly style: 'plain' | 'quoted' | 'block' }
  | { readonly kind: 'list'; readonly items: readonly string[] }
  | { readonly kind: 'map'; readonly entries: Readonly<Record<string, string>> }
  | { readonly kind: 'other' };

export interface ReadFrontMatter {
  /** The file from its first character through the closing `---` line and that line's break. */
  readonly text: string;
  /** Everything after it. */
  readonly body: string;
  readonly fields: ReadonlyMap<string, FieldValue>;
}

function fail(message: string): never {
  throw new FrontMatterError(message);
}

interface Line {
  readonly text: string;
  /** Offset just past this line's break. */
  readonly end: number;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf('\n', at);
    const stop = nl < 0 ? text.length : nl;
    let content = text.slice(at, stop);
    if (content.endsWith('\r')) content = content.slice(0, -1);
    const end = nl < 0 ? text.length : nl + 1;
    lines.push({ text: content, end });
    at = end;
  }
  return lines;
}

const isSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t';

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === ' ') n += 1;
  if (line[n] === '\t') fail('the front matter is indented with a tab; YAML allows spaces only');
  return n;
}

const isBlank = (line: string): boolean => line.trim() === '';
const isComment = (line: string): boolean => line.trimStart().startsWith('#');

/** Refuses a value that starts with an anchor, an alias, a tag, or a character YAML reserves. */
function checkStart(value: string): void {
  const ch = value[0];
  if (ch === '&' || ch === '*') fail('the front matter uses an anchor or an alias, which Caotang does not read');
  if (ch === '!') fail('the front matter uses a tag, which Caotang does not read');
  if (ch === '@' || ch === '`' || ch === '%') fail(`a value cannot start with “${ch}”; put it in quotes`);
}

/** A plain scalar's text with its trailing comment removed, and the check YAML makes on it. */
function plainText(value: string): string {
  let text = value;
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === '#' && isSpace(text[i - 1])) {
      text = text.slice(0, i);
      break;
    }
  }
  text = text.trimEnd();
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === ':' && (i === text.length - 1 || isSpace(text[i + 1]))) {
      fail('a value has “: ” in it, which YAML reads as another key; put the whole value in quotes');
    }
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * Quoted scalars
 * ------------------------------------------------------------------ */

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  '\t': '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\u0085',
  _: ' ',
  L: ' ',
  P: ' ',
};

function codePoint(hex: string, width: number): string {
  if (hex.length !== width) fail('a quoted value has a bad escape');
  for (const ch of hex) if (!'0123456789abcdefABCDEF'.includes(ch)) fail('a quoted value has a bad escape');
  const code = Number.parseInt(hex, 16);
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail('a quoted value has a bad escape');
  return String.fromCodePoint(code);
}

function trimEndSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && isSpace(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

/**
 * Reads a quoted scalar whose opening quote is at `column` of `lines[at]`. Returns the value, the line it ended on, and the column just
 * past the closing quote. A line break inside folds to a space, a blank line to a newline, and an escaped break joins with neither.
 */
function readQuoted(lines: readonly Line[], at: number, column: number): { value: string; last: number; after: number } {
  const quote = lines[at]!.text[column]!;
  const double = quote === '"';
  let out = '';
  let row = at;
  let i = column + 1;
  let breaks = 0;
  for (;;) {
    const text = lines[row]!.text;
    if (i >= text.length) {
      // A break inside the string: white space before it goes, and so does the next line's indentation.
      if (row + 1 >= lines.length) fail('a quoted value is not closed');
      out = trimEndSpaces(out);
      row += 1;
      i = 0;
      breaks += 1;
      while (isSpace(lines[row]!.text[i])) i += 1;
      continue;
    }
    const ch = text[i]!;
    if (breaks > 0) {
      out += breaks === 1 ? ' ' : '\n'.repeat(breaks - 1);
      breaks = 0;
    }
    if (ch === quote) {
      if (!double && text[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return { value: out, last: row, after: i + 1 };
    }
    if (double && ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) {
        // An escaped break: the string goes on at the next line with no space between.
        if (row + 1 >= lines.length) fail('a quoted value is not closed');
        row += 1;
        i = 0;
        while (isSpace(lines[row]!.text[i])) i += 1;
        continue;
      }
      if (next === 'x' || next === 'u' || next === 'U') {
        const width = next === 'x' ? 2 : next === 'u' ? 4 : 8;
        out += codePoint(text.slice(i + 2, i + 2 + width), width);
        i += 2 + width;
        continue;
      }
      const simple = SIMPLE_ESCAPES[next];
      if (simple === undefined) fail('a quoted value has a bad escape');
      out += simple;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
}

/** A quoted scalar that must end its line (a comment may follow). */
function readQuotedValue(lines: readonly Line[], at: number, column: number): { value: string; last: number } {
  const read = readQuoted(lines, at, column);
  const rest = lines[read.last]!.text.slice(read.after);
  if (rest.trim() !== '' && !(rest.trimStart().startsWith('#') && (rest.startsWith(' ') || rest.startsWith('\t')))) {
    fail('a quoted value has text after its closing quote');
  }
  return { value: read.value, last: read.last };
}

/* ------------------------------------------------------------------ *
 * Block scalars
 * ------------------------------------------------------------------ */

function readBlockScalar(header: string, lines: readonly Line[], at: number): { value: string; last: number } {
  const literal = header[0] === '|';
  let chomp: '' | '-' | '+' = '';
  let explicit = 0;
  let rest = header.slice(1);
  for (;;) {
    const ch = rest[0];
    if (ch === '-' || ch === '+') chomp = ch;
    else if (ch !== undefined && ch >= '1' && ch <= '9') explicit = Number(ch);
    else break;
    rest = rest.slice(1);
  }
  rest = rest.trim();
  if (rest !== '' && !rest.startsWith('#')) fail('a block value has text after its “|” or “>”');
  let last = at;
  const content: string[] = [];
  let width = explicit;
  for (let row = at + 1; row < lines.length; row += 1) {
    const text = lines[row]!.text;
    if (isBlank(text)) {
      content.push(width > 0 ? text.slice(width) : '');
      continue;
    }
    const indent = indentOf(text);
    if (indent === 0) break;
    if (width === 0) width = indent;
    if (indent < width) break;
    content.push(text.slice(width));
    last = row;
  }
  // Blank lines after the last content line are trailing breaks, which the chomping indicator decides.
  let end = content.length;
  while (end > 0 && content[end - 1]!.trim() === '') end -= 1;
  const body = content.slice(0, end);
  const trailing = content.length - end;
  let value = literal ? body.join('\n') : foldBlock(body);
  if (body.length > 0) {
    if (chomp === '') value += '\n';
    else if (chomp === '+') value += '\n'.repeat(1 + trailing);
  }
  return { value, last };
}

function foldBlock(lines: readonly string[]): string {
  let out = '';
  let blanks = 0;
  let previous: 'start' | 'text' | 'more' = 'start';
  for (const line of lines) {
    if (line.trim() === '') {
      blanks += 1;
      continue;
    }
    const more = isSpace(line[0]);
    if (previous === 'start') out += '\n'.repeat(blanks) + line;
    else if (!more && previous === 'text') out += (blanks > 0 ? '\n'.repeat(blanks) : ' ') + line;
    else out += '\n'.repeat(blanks + 1) + line;
    blanks = 0;
    previous = more ? 'more' : 'text';
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Flow collections
 * ------------------------------------------------------------------ */

function balanced(text: string): boolean {
  let level = 0;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== '') {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') level += 1;
    else if (ch === ']' || ch === '}') level -= 1;
  }
  return level <= 0;
}

/** Reads `[a, b]` or `{k: v}` that is all of `text` (several lines joined by a space). A collection inside one is `other`. */
function readFlow(text: string): FieldValue {
  const open = text[0]!;
  const close = open === '[' ? ']' : '}';
  const items: string[] = [];
  const entries: Record<string, string> = {};
  let nested = false;
  let i = 1;
  const skipSpace = (): void => {
    while (isSpace(text[i])) i += 1;
  };
  const token = (): string => {
    skipSpace();
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const read = readQuoted([{ text: text.slice(i), end: 0 }], 0, 0);
      i += read.after;
      return read.value;
    }
    checkStart(text.slice(i));
    const start = i;
    while (i < text.length && text[i] !== ',' && text[i] !== close && !(text[i] === ':' && isSpace(text[i + 1]))) i += 1;
    return text.slice(start, i).trim();
  };
  for (;;) {
    skipSpace();
    if (i >= text.length) fail('a list in the front matter is not closed');
    if (text[i] === close) {
      i += 1;
      break;
    }
    if (text[i] === '[' || text[i] === '{') {
      nested = true;
      let level = 0;
      for (; i < text.length; i += 1) {
        if (text[i] === '[' || text[i] === '{') level += 1;
        else if (text[i] === ']' || text[i] === '}') {
          level -= 1;
          if (level === 0) {
            i += 1;
            break;
          }
        }
      }
    } else if (open === '[') {
      items.push(token());
    } else {
      const key = token();
      if (text[i] !== ':') fail('a map in the front matter has a key with no value');
      i += 1;
      entries[key] = token();
    }
    skipSpace();
    if (text[i] === ',') i += 1;
    else if (text[i] !== close) fail('a list in the front matter is not written as YAML writes it');
  }
  const after = text.slice(i).trim();
  if (after !== '' && !after.startsWith('#')) fail('a list in the front matter has text after its closing bracket');
  if (nested) return { kind: 'other' };
  return open === '[' ? { kind: 'list', items } : { kind: 'map', entries };
}

/* ------------------------------------------------------------------ *
 * The top-level reader
 * ------------------------------------------------------------------ */

type Read = { readonly field: FieldValue; readonly last: number };

/** The value after a key's colon, written on its line and perhaps carried below it. */
function readValue(rest: string, lines: readonly Line[], at: number, columnOfRest: number): Read {
  const value = rest.trimStart();
  if (value === '' || value.startsWith('#')) return readChildren(lines, at);
  checkStart(value);
  const first = value[0]!;
  if (first === '|' || first === '>') {
    const block = readBlockScalar(value, lines, at);
    return { field: { kind: 'scalar', value: block.value, style: 'block' }, last: block.last };
  }
  if (first === '"' || first === "'") {
    const quoted = readQuotedValue(lines, at, columnOfRest + (rest.length - value.length));
    return { field: { kind: 'scalar', value: quoted.value, style: 'quoted' }, last: quoted.last };
  }
  if (first === '[' || first === '{') {
    let joined = value;
    let row = at;
    while (!balanced(joined)) {
      row += 1;
      if (row >= lines.length) fail('a list in the front matter is not closed');
      joined += ` ${lines[row]!.text.trim()}`;
    }
    return { field: readFlow(joined), last: row };
  }
  // A plain scalar, which carries on over the lines indented below its key.
  let text = plainText(value);
  let last = at;
  let blanks = 0;
  for (let row = at + 1; row < lines.length; row += 1) {
    const next = lines[row]!.text;
    if (isBlank(next)) {
      blanks += 1;
      continue;
    }
    if (indentOf(next) === 0 || isComment(next)) break;
    text += (blanks > 0 ? '\n'.repeat(blanks) : ' ') + plainText(next.trim());
    blanks = 0;
    last = row;
  }
  return { field: { kind: 'scalar', value: text, style: 'plain' }, last };
}

/** The value of a key with nothing after its colon: a block list, a one-level map, or nothing. */
function readChildren(lines: readonly Line[], at: number): Read {
  const children: string[] = [];
  let last = at;
  for (let row = at + 1; row < lines.length; row += 1) {
    const text = lines[row]!.text;
    if (isBlank(text) || isComment(text)) continue;
    const listAtKeyLevel = text.startsWith('- ') || text === '-';
    if (indentOf(text) === 0 && !listAtKeyLevel) break;
    children.push(text);
    last = row;
  }
  if (children.length === 0) return { field: { kind: 'scalar', value: '', style: 'plain' }, last: at };
  const base = indentOf(children[0]!);
  const firstBody = children[0]!.slice(base);
  if (firstBody.startsWith('- ') || firstBody === '-') return { field: listOf(children, base), last };
  return { field: mapOf(children, base), last };
}

function scalarOf(raw: string): string | undefined {
  checkStart(raw);
  if (raw[0] === '"' || raw[0] === "'") return readQuotedValue([{ text: raw, end: 0 }], 0, 0).value;
  if (raw[0] === '[' || raw[0] === '{' || raw[0] === '|' || raw[0] === '>') return undefined;
  return plainText(raw);
}

function listOf(children: readonly string[], base: number): FieldValue {
  const items: string[] = [];
  let nested = false;
  for (const child of children) {
    const indent = indentOf(child);
    const body = child.slice(indent);
    if (indent !== base || !(body.startsWith('- ') || body === '-')) {
      nested = true;
      continue;
    }
    const raw = body.slice(1).trim();
    const value = raw === '' ? undefined : scalarOf(raw);
    if (value === undefined || (raw[0] !== '"' && raw[0] !== "'" && raw.includes(': '))) nested = true;
    else items.push(value);
  }
  return nested ? { kind: 'other' } : { kind: 'list', items };
}

function mapOf(children: readonly string[], base: number): FieldValue {
  const entries: Record<string, string> = {};
  let nested = false;
  let previous: string | undefined;
  for (const child of children) {
    const indent = indentOf(child);
    const body = child.slice(indent);
    if (indent > base) {
      // Carried on from the value above, or a deeper structure: a flat string map only when it folds into the value above.
      if (previous === undefined || body.includes(': ')) nested = true;
      else entries[previous] = `${entries[previous] ?? ''} ${plainText(body)}`;
      continue;
    }
    if (indent < base) fail('the front matter is indented unevenly');
    const colon = findKeyColon(body);
    if (colon <= 0) fail('a line in the front matter is neither a key and a value nor a list item');
    const key = unquoteKey(body.slice(0, colon).trim());
    const raw = body.slice(colon + 1).trim();
    if (Object.hasOwn(entries, key)) fail(`the key “${key}” appears twice`);
    previous = key;
    const value = raw === '' || raw.startsWith('#') ? undefined : scalarOf(raw);
    if (value === undefined) nested = true;
    entries[key] = value ?? '';
  }
  return nested ? { kind: 'other' } : { kind: 'map', entries };
}

/** The index of the colon that ends a key (followed by a space or the line's end), skipping a quoted key; -1 when there is none. */
function findKeyColon(line: string): number {
  let i = 0;
  const quote = line[0];
  if (quote === '"' || quote === "'") {
    i = 1;
    while (i < line.length && line[i] !== quote) i += quote === '"' && line[i] === '\\' ? 2 : 1;
    i += 1;
  }
  for (; i < line.length; i += 1) {
    if (line[i] === ':' && (i === line.length - 1 || isSpace(line[i + 1]))) return i;
  }
  return -1;
}

function unquoteKey(key: string): string {
  if (key.length >= 2 && (key[0] === '"' || key[0] === "'") && key[key.length - 1] === key[0]) return key.slice(1, -1);
  return key;
}

function isKeyChar(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 95 || code === 45 || code === 46;
}

/**
 * Splits a `SKILL.md` into its front matter and body and reads the front matter's fields. Throws {@link FrontMatterError}, with a
 * sentence that says what to change, for anything it does not read.
 */
export function readFrontMatter(source: string): ReadFrontMatter {
  const lines = splitLines(source);
  const opening = (lines[0]?.text ?? '').replace('﻿', '').trimEnd();
  if (opening !== '---') fail('the file does not start with a “---” line, so it has no front matter');
  let close = -1;
  for (let row = 1; row < lines.length; row += 1) {
    const text = lines[row]!.text;
    if (text.trimEnd() === '---') {
      close = row;
      break;
    }
    if (text.startsWith('...') || text.startsWith('--- ')) fail('the front matter holds more than one YAML document');
  }
  if (close < 0) fail('the front matter has no closing “---” line');

  const inner = lines.slice(1, close);
  const fields = new Map<string, FieldValue>();
  for (let row = 0; row < inner.length; row += 1) {
    const text = inner[row]!.text;
    if (isBlank(text) || isComment(text)) continue;
    if (indentOf(text) > 0) fail('a line in the front matter is indented under nothing');
    if (text.startsWith('%')) fail('the front matter has a YAML directive, which Caotang does not read');
    if (text.startsWith('- ') || text === '-') fail('the front matter is a list; it should be keys and values');
    const colon = findKeyColon(text);
    if (colon <= 0) fail(`the line “${text.slice(0, 40)}” is not a key and a value`);
    const key = unquoteKey(text.slice(0, colon).trim());
    if (key === '' || ![...key].every((ch) => isKeyChar(ch.charCodeAt(0)))) fail(`“${key.slice(0, 40)}” is not a key Caotang can read`);
    if (fields.has(key)) fail(`the key “${key}” appears twice`);
    const { field, last } = readValue(text.slice(colon + 1), inner, row, colon + 1);
    fields.set(key, field);
    row = last;
  }
  const end = lines[close]!.end;
  return { text: source.slice(0, end), body: source.slice(end), fields };
}
