/**
 * What an external call would send out — [extensibility.md §4 rule 4](../../../../docs/architecture/extensibility.md), issue #54.
 *
 * Before an external write is shown, its arguments are compared with the project's text: a run of at least `QUOTE_MIN_WORDS` words in a
 * row that is also in a document body or a codex description is a finding, and the card says which document and how many words. It is
 * information on the card and never a block: a writer who asked for a document to be sent sends it, with one more click.
 *
 * Words are the store's counting rule (whitespace tokens, editor-engine §9), lower-cased and stripped of the punctuation around them so
 * a model that changed a quotation mark or dropped a full stop still matches. A token of an unspaced script (Han, kana, Thai, Lao, Khmer,
 * Myanmar) is one word per character, as there is no space to count by. Nothing is compared with a regular expression, so a long text
 * costs its length.
 */

import type { QuoteFinding } from '@caotang/mcp-client';
import { getBody, nodeById, type ProjectState } from '@caotang/store';

/** The shortest run of words in a row that counts as a quotation (issue #54). */
export const QUOTE_MIN_WORDS = 12;

/** How many places in the arguments one window of the source is grown from. */
const MAX_CANDIDATES = 32;

const UNSPACED = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

function isWordChar(char: string): boolean {
  return WORD_CHAR.test(char);
}

/** A token with the punctuation around it taken off and its case folded. Empty when nothing but punctuation was there. */
function normalised(token: string): string {
  const chars = [...token];
  let from = 0;
  let to = chars.length;
  while (from < to && !isWordChar(chars[from] as string)) from += 1;
  while (to > from && !isWordChar(chars[to - 1] as string)) to -= 1;
  return chars.slice(from, to).join('').toLowerCase();
}

/** The words of a text in order, as `normalised` tokens, with an unspaced-script token cut to one word per character. */
export function wordsOfText(text: string): string[] {
  const words: string[] = [];
  let token = '';
  const flush = (): void => {
    if (token === '') return;
    if (UNSPACED.test(token)) {
      for (const char of token) if (isWordChar(char)) words.push(char.toLowerCase());
    } else {
      const word = normalised(token);
      if (word !== '') words.push(word);
    }
    token = '';
  };
  for (const char of text) {
    if (/\s/u.test(char)) flush();
    else token += char;
  }
  flush();
  return words;
}

/** A string of the arguments, with the path that reaches it (`args.items[2].body`; an object key reads `args.items[2] (key "…")`). */
interface ArgString {
  readonly path: string;
  readonly text: string;
}

/**
 * Every string of the arguments, object keys included, in the order they are met, at any depth. It walks with a stack, not recursion, so a
 * deeply nested value cannot overflow the call stack, and it skips an object it has already seen. Nothing is left out: a text that hid in
 * a key, or under many levels, is still compared.
 */
function stringsOf(root: unknown): ArgString[] {
  const out: ArgString[] = [];
  const seen = new Set<object>();
  const stack: { readonly value: unknown; readonly path: string }[] = [{ value: root, path: 'args' }];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { value, path } = next;
    if (typeof value === 'string') out.push({ path, text: value });
    else if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) continue;
      seen.add(value);
      // Pushed in reverse so the first item is read first.
      if (Array.isArray(value)) for (let index = value.length - 1; index >= 0; index -= 1) stack.push({ value: value[index], path: `${path}[${index}]` });
      else {
        const entries = Object.entries(value);
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const [key, item] = entries[index] as [string, unknown];
          stack.push({ value: item, path: `${path}.${key}` });
          stack.push({ value: key, path: `${path} (key "${key.length > 40 ? `${key.slice(0, 40)}…` : key}")` });
        }
      }
    }
  }
  return out;
}

interface Source {
  readonly nodeId: string;
  readonly title: string;
  readonly text: string;
}

/** The project text a call could carry out: every document body and every codex description. */
function sourcesOf(state: ProjectState): Source[] {
  const sources: Source[] = [];
  for (const id of state.documents.keys()) {
    const node = nodeById(state, id);
    const body = getBody(state, id);
    if (body !== '') sources.push({ nodeId: id, title: node?.title ?? id, text: body });
  }
  for (const entry of state.manifest.codex ?? []) if (entry.description !== '') sources.push({ nodeId: entry.id, title: entry.name, text: entry.description });
  return sources;
}

/**
 * The longest run of consecutive words that `argument` shares with `source`, when it is at least `min` words. The argument's every `min`-word
 * window is keyed once; the source is read once, and a window that is also in the argument is grown to the full run.
 */
function longestShared(argument: readonly string[], source: readonly string[], min: number): number {
  if (argument.length < min || source.length < min) return 0;
  const starts = new Map<string, number[]>();
  const heads = new Set<string>();
  for (let at = 0; at + min <= argument.length; at += 1) {
    const key = argument.slice(at, at + min).join(' ');
    const list = starts.get(key);
    if (list === undefined) starts.set(key, [at]);
    else list.push(at);
    heads.add(argument[at] as string);
  }
  let best = 0;
  // Where on each diagonal (start - at) a run already read ends, in the source, so a run is grown once however many windows it holds.
  const covered = new Map<number, number>();
  for (let at = 0; at + min <= source.length; at += 1) {
    if (!heads.has(source[at] as string)) continue;
    const found = starts.get(source.slice(at, at + min).join(' '));
    if (found === undefined) continue;
    // A text of one word repeated has a start at every place; the first few tell as much as all of them.
    for (const start of found.slice(0, MAX_CANDIDATES)) {
      if ((covered.get(start - at) ?? -1) > at) continue;
      let run = min;
      while (start + run < argument.length && at + run < source.length && argument[start + run] === source[at + run]) run += 1;
      covered.set(start - at, at + run);
      if (run > best) best = run;
    }
  }
  return best;
}

/**
 * The project text a call's arguments quote: for each argument string and each document or codex entry that shares at least `minWords` words in
 * a row with it, the document, the length of the longest such run and where in the arguments it was. Object keys are argument text too.
 * The words of all the strings, in the order they are met, are also compared as one text (`args`), so a quotation split across the items of
 * an array, or across a key and its value, is found; that finding is added only when its run is longer than any single string's. Documents
 * come in project order, so the same call gives the same findings.
 */
export function quotedProjectText(args: Readonly<Record<string, unknown>>, state: ProjectState, minWords: number = QUOTE_MIN_WORDS): readonly QuoteFinding[] {
  const strings = stringsOf(args);
  const prepared = strings.map((item) => ({ path: item.path, words: wordsOfText(item.text) }));
  const combined = prepared.length > 1 ? prepared.flatMap((item) => item.words) : [];
  const findings: QuoteFinding[] = [];
  for (const source of sourcesOf(state)) {
    const words = wordsOfText(source.text);
    let single = 0;
    for (const item of prepared) {
      if (item.words.length < minWords) continue;
      const run = longestShared(item.words, words, minWords);
      if (run >= minWords) {
        findings.push({ nodeId: source.nodeId, title: source.title, words: run, argPath: item.path });
        if (run > single) single = run;
      }
    }
    const together = longestShared(combined, words, minWords);
    if (together >= minWords && together > single) findings.push({ nodeId: source.nodeId, title: source.title, words: together, argPath: 'args' });
  }
  return findings;
}
