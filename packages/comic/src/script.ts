/**
 * The comic script — comics.md §3.1. A comic-script document is plain text in the industry convention, parsed the
 * way Fountain is, and generated back from pages for the Marvel method (`scriptFromPages`).
 *
 * The parser is deliberately forgiving about spelling and strict about nothing: a page whose header promises five
 * panels and holds four is a soft finding, never a failure.
 *
 * Rules a reader would otherwise have to guess:
 * - Text before the first page header is a preamble and is not parsed as lettering.
 * - A lettering line is `NAME:`, `CAPTION:` or `SFX:`, optionally numbered (`3. NAME:`). A speaker name must hold no
 *   lowercase letter, which is what keeps `Note: ...` and `Panel 1: ...` descriptions out of the lettering.
 * - A lettering line runs to the next blank line: an unindented line that is not a page, panel or lettering line
 *   continues it, and an indented line always does. Continuation lines are joined with `\n`.
 * - Modifiers are read between the name and the colon, in one or several groups: `NAME (OFF, WHISPER):`. A modifier
 *   that maps to nothing, and a second kind modifier, stay in the balloon text as written.
 */

import { BALLOON_KINDS, type BalloonKind, type ComicPage } from './model.js';
import { msg, type MessageRef } from './message.js';

/** The modifier words and what each sets. Matching is case-insensitive. */
export const SCRIPT_MODIFIERS: Readonly<Record<string, { offPanel: true } | { kind: BalloonKind }>> = {
  OFF: { offPanel: true },
  OP: { offPanel: true },
  WHISPER: { kind: 'whisper' },
  BURST: { kind: 'shout' },
  THOUGHT: { kind: 'thought' },
  RADIO: { kind: 'radio' },
  ELEC: { kind: 'radio' },
};

/** The spelling `scriptFromPages` writes for each kind that needs a modifier. */
const KIND_MODIFIER: Partial<Record<BalloonKind, string>> = {
  whisper: 'WHISPER',
  shout: 'BURST',
  thought: 'THOUGHT',
  radio: 'RADIO',
};

export interface ScriptLine {
  kind: BalloonKind;
  /** As written, upper-case by convention; absent for `CAPTION:` and `SFX:`. */
  speakerName?: string;
  text: string;
  offPanel: boolean;
  /** The lettering number as written (`3.`), when there is one. */
  number?: number;
  /** The modifier words that were applied, upper-cased. */
  modifiers: string[];
  /** Modifier words kept as text at the start of `text`. */
  unknownModifiers: string[];
  /** Offsets into the body, from the first character of the line to the end of its last continuation line. */
  from: number;
  to: number;
  /** 1-based line number of the first line. */
  line: number;
}

export interface ScriptPanel {
  /** 1-based position on the page. */
  index: number;
  /** The label as written: `1`, `A`, `ONE`; absent for a panel the parser had to imply. */
  label?: string;
  implicit: boolean;
  description: string;
  lines: ScriptLine[];
  from: number;
  to: number;
}

export interface ScriptPage {
  /** The number the header carries. A header whose number cannot be read is not a page header. */
  number: number;
  label: string;
  /** The panel count the header promised, when it said one. */
  declaredPanelCount?: number;
  description: string;
  panels: ScriptPanel[];
  from: number;
  to: number;
}

export interface ScriptFinding {
  code: 'panelCountMismatch';
  pageNumber: number;
  declared: number;
  found: number;
  from: number;
  to: number;
  message: MessageRef;
}

export interface ParsedComicScript {
  pages: ScriptPage[];
  preamble: string;
  findings: ScriptFinding[];
}

const NUMBER_WORDS = new Map<string, number>();
[
  'ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE',
  'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
].forEach((word, n) => NUMBER_WORDS.set(word, n));
const TENS: Record<string, number> = {
  TWENTY: 20, THIRTY: 30, FORTY: 40, FIFTY: 50, SIXTY: 60, SEVENTY: 70, EIGHTY: 80, NINETY: 90,
};

/** `7`, `seven`, `Twenty-One` → a number; anything else → undefined. */
export function parseNumberToken(token: string): number | undefined {
  if (/^\d{1,4}$/.test(token)) return Number(token);
  const upper = token.toUpperCase();
  const simple = NUMBER_WORDS.get(upper) ?? TENS[upper];
  if (simple !== undefined) return simple;
  const [tens, ones, ...rest] = upper.split('-');
  if (tens !== undefined && ones !== undefined && rest.length === 0) {
    const t = TENS[tens];
    const o = NUMBER_WORDS.get(ones);
    if (t !== undefined && o !== undefined && o >= 1 && o <= 9) return t + o;
  }
  return undefined;
}

const NUMBER_TOKEN = '(\\d{1,4}|[A-Za-z]+(?:-[A-Za-z]+)?)';
const PAGE_HEADER = new RegExp(`^page\\s+${NUMBER_TOKEN}\\s*(?:\\(([^)]*)\\))?\\s*[:.]?$`, 'i');
const COUNT_IN_HEADER = /^\s*(\d{1,3}|[A-Za-z]+(?:-[A-Za-z]+)?)\s+panels?\s*$/i;
const PANEL_WORD = /^panel\s+([A-Za-z0-9-]+)([:.)]?)\s*(.*)$/i;
const PANEL_NUMBERED = /^(\d{1,3})\.?\)\s*(.*)$/;
const LETTERING = /^(?:(\d{1,4})\s*[.)]\s*)?([^\s:()][^:()]{0,38}?)\s*((?:\([^)]*\)\s*)*):\s*(.*)$/u;

function headerForm(trimmed: string): string {
  return trimmed.replace(/^[#>*_\s]+/, '').replace(/[*_\s]+$/, '');
}

function matchPanelHeader(form: string): { label: string; description: string } | undefined {
  const word = PANEL_WORD.exec(form);
  if (word !== null) {
    const label = word[1] ?? '';
    if (/^\d+$/.test(label) || /^[A-Z]$/.test(label) || parseNumberToken(label) !== undefined) {
      return { label, description: (word[3] ?? '').replace(/^[-–—:.)]\s*/, '') };
    }
    return undefined;
  }
  const numbered = PANEL_NUMBERED.exec(form);
  if (numbered !== null) {
    // 3) MARA: Hi. is numbered lettering; only 1.) (and a bare 3)) head a panel.
    if (!/^\d{1,3}\.\)/.test(form) && matchLettering(form) !== undefined) return undefined;
    return { label: numbered[1] ?? '', description: numbered[2] ?? '' };
  }
  return undefined;
}

interface Source {
  text: string;
  from: number;
  to: number;
  line: number;
}

function splitLines(body: string): Source[] {
  const out: Source[] = [];
  let start = 0;
  let line = 1;
  while (start <= body.length) {
    let end = body.indexOf('\n', start);
    if (end === -1) end = body.length;
    let stop = end;
    if (stop > start && body[stop - 1] === '\r') stop -= 1;
    out.push({ text: body.slice(start, stop), from: start, to: stop, line });
    start = end + 1;
    line += 1;
  }
  return out;
}

interface LetteringHead {
  number?: number;
  name: string;
  groups: string;
  text: string;
}

function matchLettering(raw: string): LetteringHead | undefined {
  const m = LETTERING.exec(raw.trim());
  if (m === null) return undefined;
  const name = (m[2] ?? '').trim();
  const upper = name.toUpperCase();
  const fixed = upper === 'CAPTION' || upper === 'SFX';
  if (!fixed && (/\p{Ll}/u.test(name) || !/\p{L}/u.test(name))) return undefined;
  const head: LetteringHead = { name, groups: m[3] ?? '', text: (m[4] ?? '').trim() };
  if (m[1] !== undefined) head.number = Number(m[1]);
  return head;
}

function readLine(head: LetteringHead, source: Source): ScriptLine {
  const upper = head.name.toUpperCase();
  let kind: BalloonKind = upper === 'CAPTION' ? 'caption' : upper === 'SFX' ? 'sfx' : 'speech';
  const speech = kind === 'speech';
  let offPanel = false;
  let kindSet = false;
  const modifiers: string[] = [];
  const unknownModifiers: string[] = [];
  for (const group of head.groups.matchAll(/\(([^)]*)\)/g)) {
    for (const piece of (group[1] ?? '').split(/[,;]/)) {
      const word = piece.trim();
      if (word.length === 0) continue;
      const mapped = SCRIPT_MODIFIERS[word.toUpperCase()];
      if (mapped === undefined) unknownModifiers.push(word);
      else if ('offPanel' in mapped) {
        offPanel = true;
        modifiers.push(word.toUpperCase());
      } else if (speech && !kindSet) {
        kind = mapped.kind;
        kindSet = true;
        modifiers.push(word.toUpperCase());
      } else unknownModifiers.push(word);
    }
  }
  const prefix = unknownModifiers.map((w) => `(${w})`).join(' ');
  const line: ScriptLine = {
    kind,
    text: [prefix, head.text].filter((s) => s.length > 0).join(' '),
    offPanel,
    modifiers,
    unknownModifiers,
    from: source.from + (source.text.length - source.text.trimStart().length),
    to: source.to,
    line: source.line,
  };
  if (kind !== 'caption' && kind !== 'sfx') line.speakerName = head.name;
  if (head.number !== undefined) line.number = head.number;
  return line;
}

export function parseComicScript(body: string): ParsedComicScript {
  const pages: ScriptPage[] = [];
  const preamble: string[] = [];
  let page: ScriptPage | undefined;
  let panel: ScriptPanel | undefined;
  let current: { line: ScriptLine; head: LetteringHead; parts: string[] } | undefined;

  const closeLine = (): void => {
    if (current === undefined) return;
    const tail = current.parts.join('\n');
    if (tail.length > 0) {
      current.line.text = [current.line.text, tail].filter((s) => s.length > 0).join('\n');
    }
    current = undefined;
  };
  const touch = (to: number): void => {
    if (page !== undefined) page.to = to;
    if (panel !== undefined) panel.to = to;
  };
  const openPanel = (label: string | undefined, description: string, source: Source): ScriptPanel => {
    const created: ScriptPanel = {
      index: (page?.panels.length ?? 0) + 1,
      implicit: label === undefined,
      description,
      lines: [],
      from: source.from,
      to: source.to,
    };
    if (label !== undefined) created.label = label;
    page?.panels.push(created);
    return created;
  };

  for (const source of splitLines(body)) {
    const trimmed = source.text.trim();
    if (trimmed.length === 0) {
      closeLine();
      continue;
    }
    if (current !== undefined && /^\s/.test(source.text)) {
      current.parts.push(trimmed);
      current.line.to = source.to;
      touch(source.to);
      continue;
    }
    const form = headerForm(trimmed);
    const pageMatch = PAGE_HEADER.exec(form);
    const pageNumber = pageMatch === null ? undefined : parseNumberToken(pageMatch[1] ?? '');
    if (pageMatch !== null && pageNumber !== undefined) {
      closeLine();
      const count = COUNT_IN_HEADER.exec(pageMatch[2] ?? '');
      const declared = count === null ? undefined : parseNumberToken(count[1] ?? '');
      page = {
        number: pageNumber,
        label: pageMatch[1] ?? '',
        description: '',
        panels: [],
        from: source.from,
        to: source.to,
      };
      if (declared !== undefined) page.declaredPanelCount = declared;
      pages.push(page);
      panel = undefined;
      continue;
    }
    if (page === undefined) {
      preamble.push(source.text);
      continue;
    }
    const panelHeader = matchPanelHeader(form);
    if (panelHeader !== undefined) {
      closeLine();
      panel = openPanel(panelHeader.label, panelHeader.description, source);
      page.to = source.to;
      continue;
    }
    const head = matchLettering(source.text);
    if (head !== undefined) {
      closeLine();
      panel ??= openPanel(undefined, '', source);
      const line = readLine(head, source);
      panel.lines.push(line);
      current = { line, head, parts: [] };
      touch(source.to);
      continue;
    }
    if (current !== undefined) {
      current.parts.push(trimmed);
      current.line.to = source.to;
    } else if (panel !== undefined) {
      panel.description = panel.description.length > 0 ? `${panel.description}\n${trimmed}` : trimmed;
    } else {
      page.description = page.description.length > 0 ? `${page.description}\n${trimmed}` : trimmed;
    }
    touch(source.to);
  }
  closeLine();

  const findings: ScriptFinding[] = [];
  for (const p of pages) {
    if (p.declaredPanelCount !== undefined && p.declaredPanelCount !== p.panels.length) {
      findings.push({
        code: 'panelCountMismatch',
        pageNumber: p.number,
        declared: p.declaredPanelCount,
        found: p.panels.length,
        from: p.from,
        to: p.to,
        message: msg(
          'comic.script.panelCountMismatch',
          'Page {page} says it has {declared} panels, but {found} were found. Fix the number in the page header, or add or remove a panel.',
          { page: p.number, declared: p.declaredPanelCount, found: p.panels.length },
        ),
      });
    }
  }
  return { pages, preamble: preamble.join('\n'), findings };
}

// ---------------------------------------------------------------- pages -> script

export interface ScriptSourcePage {
  /** The page's number in the book; defaults to its position, from 1. */
  number?: number;
  page: ComicPage;
}

export interface ScriptFromPagesOptions {
  /** A codex id to the name the script shows. Without an answer the fallback is written. */
  speakerName?: (codexId: string) => string | undefined;
  /** For a spoken balloon with no readable speaker. Default `VOICE`. */
  fallbackSpeaker?: string;
  /** Number the lettering lines on each page (`1.`, `2.` ...). Default true. */
  numberLines?: boolean;
}

export interface GeneratedScriptLine {
  pageIndex: number;
  panelId: string;
  balloonId: string;
  /** The offsets of the lettering line in `body` — what a fresh anchor is captured from. */
  from: number;
  to: number;
}

export interface GeneratedScript {
  body: string;
  lines: GeneratedScriptLine[];
}

const NAME_STRIP = /[:()\r\n]/g;

/** What a speaker looks like in a script: upper case, no character the grammar reads, at most 38 characters. */
export function scriptSpeakerName(name: string, fallback = 'VOICE'): string {
  const cleaned = name.replace(NAME_STRIP, ' ').replace(/\s+/g, ' ').trim().toLocaleUpperCase().slice(0, 38).trim();
  return cleaned.length > 0 && /\p{L}/u.test(cleaned) ? cleaned : fallback;
}

export function scriptFromPages(
  pages: readonly ScriptSourcePage[],
  options: ScriptFromPagesOptions = {},
): GeneratedScript {
  const numbered = options.numberLines ?? true;
  const fallback = options.fallbackSpeaker ?? 'VOICE';
  let body = '';
  const lines: GeneratedScriptLine[] = [];
  const emit = (text: string): void => {
    body += `${text}\n`;
  };

  pages.forEach((entry, pageIndex) => {
    const panels = entry.page.panels;
    const count = panels.length;
    if (pageIndex > 0) emit('');
    emit(`PAGE ${entry.number ?? pageIndex + 1}${count > 0 ? ` (${count} ${count === 1 ? 'panel' : 'panels'})` : ''}`);
    let lettering = 0;
    panels.forEach((panel, panelIndex) => {
      emit('');
      emit(`PANEL ${panelIndex + 1}`);
      if (panel.balloons.length > 0) emit('');
      for (const balloon of panel.balloons) {
        const kind = (BALLOON_KINDS as readonly string[]).includes(balloon.kind) ? (balloon.kind as BalloonKind) : 'speech';
        lettering += 1;
        let name: string;
        if (kind === 'caption') name = 'CAPTION';
        else if (kind === 'sfx') name = 'SFX';
        else {
          const resolved = balloon.speaker === undefined ? undefined : options.speakerName?.(balloon.speaker);
          name = scriptSpeakerName(resolved ?? fallback, fallback);
        }
        const mods: string[] = [];
        if (balloon.offPanel === true) mods.push('OFF');
        const kindWord = KIND_MODIFIER[kind];
        if (kindWord !== undefined) mods.push(kindWord);
        const [first = '', ...rest] = balloon.text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l, i) => i === 0 || l.length > 0);
        const head = `${numbered ? `${lettering}. ` : ''}${name}${mods.length > 0 ? ` (${mods.join(', ')})` : ''}:${first.length > 0 ? ` ${first}` : ''}`;
        const from = body.length;
        emit(head);
        for (const more of rest) emit(`  ${more}`);
        lines.push({ pageIndex, panelId: panel.id, balloonId: balloon.id, from, to: body.length - 1 });
      }
    });
  });
  return { body, lines };
}
