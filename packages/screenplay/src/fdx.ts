/**
 * Final Draft's XML — [screenplay.md §5.2](../../../docs/architecture/screenplay.md).
 *
 * Import is the v0.1-of-track half. Every paragraph is typed, so the import is mechanical:
 * FDX paragraphs become the element model, the element model becomes Fountain text, and
 * the Fountain importer maps that onto sections and scenes. Emit is the v0.2-of-track half,
 * and it is written to D11's answer: typed paragraphs, the title
 * page, `SceneProperties` Length and Page where pagination computed them, scene numbers kept
 * verbatim from the heading, and the page-number header layer from the paginator's pages.
 * Revision marks, locked pages and their colours are never emitted, since the model stores none.
 *
 * The scene-number attribute and the header element are the two encodings D11 calls
 * implementation-time residue. Their source read (Screenplain's FDX writer, rsdoiel/fdx) is not
 * complete, so both are unverified against a Final Draft file (a known gap).
 *
 * The reader (`fdx-xml.ts`) builds a tree in one forward pass, so it reads nested paragraphs as Final Draft writes
 * them and stays linear in the size of the file. Only a paragraph directly inside `<Content>` (or at the top of a
 * fragment), or directly inside a `<DualDialogue>` there or in such a paragraph, is a script paragraph: the
 * paragraphs inside a scene's `SceneProperties`, a `ScriptNote`, the title page, the header and the other settings
 * blocks are not. Import is tested on hand-written XML in the shapes Final Draft and other writers use and on one file
 * Final Draft wrote (`test/fixtures/TestFDX-FD.fdx`, from wildwinter/screenplay-tools, MIT).
 */

import { printedText, sceneNumberOf, stripSceneNumber } from './classify.js';
import { childElements, ownText, readXml, type XmlElement } from './fdx-xml.js';
import { importFountainScript, type ImportedScript } from './import.js';
import { paginate, sceneLengths } from './paginate.js';
import { parseFountain } from './parse.js';
import { serialiseFountain } from './serialise.js';
import type { FlatBlock } from './flat-block.js';
import type { ScreenplayElement } from './types.js';
import { renderFountain, type FountainRenderOptions } from './render-fountain.js';

export const FDX_MIME = 'application/xml';

/** A piece of a paragraph, in order: a `<Text>` run with its style tokens, or a script note anchored there. */
export type FdxSegment =
  | { readonly kind: 'text'; readonly text: string; readonly style: readonly string[] }
  | { readonly kind: 'note'; readonly text: string };

/** One script `<Paragraph>` as read from the file. */
export interface FdxParagraph {
  readonly type: string;
  /** The printed text: every run but hidden ones, joined, with no markup. */
  readonly text: string;
  readonly alignment: string | null;
  /** From `SceneProperties Length`, in eighths of a page. Null when absent or unreadable. */
  readonly lengthEighths: number | null;
  /** The index of the `DualDialogue` container this paragraph sits in, or null. */
  readonly container: number | null;
  /** From the `Number` attribute, trimmed. Null when absent or blank. */
  readonly number: string | null;
  /** The runs and anchored notes, in order. */
  readonly segments: readonly FdxSegment[];
  /** The text of `SceneProperties/Summary`, on one line. Null when there is none. */
  readonly summary: string | null;
}

/** What an FDX import kept in Fountain markup, and what it could not keep, counted for the import dialog. */
export interface FdxImportReport {
  /** Script notes kept as Fountain notes (`[[…]]`): inline, from the `ScriptNotes` list, and unanchored. */
  readonly notes: number;
  /** Of those, the notes with no place in the script, put at the end of the last scene. */
  readonly unanchoredNotes: number;
  /** Hidden-text runs kept as Fountain notes, never as printed text. */
  readonly hiddenRuns: number;
  /** Dual-dialogue pairs, written with Fountain's `^`. */
  readonly dualDialogues: number;
  /** Scene summaries kept as scene synopses. */
  readonly summaries: number;
  /** Runs whose strikeout was dropped (the text is kept). */
  readonly strikeouts: number;
  /** Runs on a scene heading, cue or transition whose bold, italic or underline was dropped (the text is kept). */
  readonly plainedRuns: number;
}

export interface FdxImportedScript extends ImportedScript {
  readonly report: FdxImportReport;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The containers whose paragraphs are script paragraphs. The root is the nameless top of a fragment. */
const SCRIPT_CONTAINERS: ReadonlySet<string> = new Set(['', 'FinalDraft', 'Content']);

/** The style tokens of a run: `Bold+Underline+AllCaps` → `['Bold', 'Underline', 'AllCaps']`. */
function styleTokens(style: string | undefined): string[] {
  if (style === undefined || style === '') return [];
  return style.split('+').map((token) => token.trim()).filter((token) => token !== '');
}

/** The text of every `<Text>` run directly inside `paragraph`, joined, styles ignored. */
function runsText(paragraph: XmlElement): string {
  return childElements(paragraph, 'Text')
    .map((run) => ownText(run))
    .join('');
}

/** A block of paragraphs (a note body, a summary) as one line of text. */
function blockText(container: XmlElement): string {
  return oneLine(
    childElements(container, 'Paragraph')
      .map((p) => runsText(p))
      .join(' '),
  );
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A script note's text: its title, when it has one, then its body. */
function noteText(note: XmlElement): string {
  const body = blockText(note);
  const title = oneLine(note.attrs.Name ?? note.attrs.Title ?? '');
  if (title === '' || title === body) return body;
  return body === '' ? title : `${title}: ${body}`;
}

/**
 * `SceneProperties Length` in eighths of a page. Final Draft writes eighths as a fraction (`2/8`) and a long scene as
 * whole pages and a fraction (`1 3/8`); `wholeIsPage` says whether a bare whole number is pages too (a file that writes
 * fractions) or a count of eighths (what Caotang's own export writes, `8`).
 */
export function lengthInEighths(value: string, wholeIsPage: boolean): number | null {
  const text = value.trim();
  const whole = /^(\d+)$/.exec(text);
  if (whole !== null) return Number(whole[1]) * (wholeIsPage ? 8 : 1);
  const mixed = /^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/.exec(text);
  if (mixed === null) return null;
  const denominator = Number(mixed[3]);
  if (denominator === 0) return null;
  return Number(mixed[1] ?? '0') * 8 + Math.round((Number(mixed[2]) * 8) / denominator);
}

const FRACTION = /\d\s*\/\s*\d/;

/** A paragraph being read, before the file-wide parts (the Length dialect, the notes list) are known. */
interface DraftParagraph {
  readonly type: string;
  readonly alignment: string | null;
  readonly number: string | null;
  readonly container: number | null;
  readonly segments: FdxSegment[];
  readonly summary: string | null;
  readonly length: string | null;
}

/** A listed note: its text and the offset `Range` gives, or null when it gives none. */
interface ListedNote {
  readonly text: string;
  readonly offset: number | null;
}

interface FdxDocument {
  readonly paragraphs: FdxParagraph[];
  /** Notes with no place in the script. */
  readonly unanchored: string[];
  /** Notes placed from the `ScriptNotes` list. */
  readonly listed: number;
}

function readParagraph(el: XmlElement, container: number | null, nested: XmlElement[]): DraftParagraph {
  const segments: FdxSegment[] = [];
  let summary: string | null = null;
  let length: string | null = null;
  for (const child of el.children) {
    if (typeof child === 'string') continue;
    switch (child.name) {
      case 'Text':
        segments.push({ kind: 'text', text: ownText(child), style: styleTokens(child.attrs.Style) });
        break;
      case 'ScriptNote': {
        const text = noteText(child);
        if (text !== '') segments.push({ kind: 'note', text });
        break;
      }
      case 'SceneProperties': {
        length = child.attrs.Length ?? null;
        const summaries = childElements(child, 'Summary')
          .map((s) => blockText(s))
          .filter((s) => s !== '');
        if (summaries.length > 0) summary = summaries.join(' ');
        break;
      }
      case 'DualDialogue':
        nested.push(child);
        break;
      default:
        break;
    }
  }
  const number = (el.attrs.Number ?? '').trim();
  return {
    type: el.attrs.Type ?? 'Action',
    alignment: el.attrs.Alignment ?? null,
    number: number === '' ? null : number,
    container,
    segments,
    summary,
    length,
  };
}

function hasContent(p: DraftParagraph): boolean {
  return p.summary !== null || p.segments.some((s) => s.kind === 'note' || s.text !== '');
}

/**
 * Reads the script paragraphs of a document, its listed and unanchored notes, and places each listed note at the end
 * of the paragraph its `Range` starts in. `Range` is taken as a character offset into the script's text with one
 * character between paragraphs; that reading is not confirmed against Final Draft, and a note it cannot place goes to
 * the end with the unanchored ones.
 */
function readDocument(root: XmlElement): FdxDocument {
  const drafts: DraftParagraph[] = [];
  const listed: ListedNote[] = [];
  const unanchored: string[] = [];
  // The older `UnanchoredScriptNotes` come after the listed notes that find no place, as the file orders the two lists.
  const legacy: string[] = [];
  let containers = 0;
  const readContainer = (dual: XmlElement): void => {
    const index = containers;
    containers += 1;
    for (const p of childElements(dual, 'Paragraph')) {
      if (p.selfClosing) continue;
      // A paragraph inside the pair is read as one; a pair nested inside it again is not a pair Fountain can hold.
      drafts.push(readParagraph(p, index, []));
    }
  };
  // An explicit stack, so a file that nests `<Content>` deep cannot run the call stack out.
  const pending: XmlElement[] = [root];
  while (pending.length > 0) {
    const container = pending.pop() as XmlElement;
    const inner: XmlElement[] = [];
    for (const child of container.children) {
      if (typeof child === 'string') continue;
      if (child.name === 'Paragraph') {
        if (child.selfClosing) continue;
        const nested: XmlElement[] = [];
        const paragraph = readParagraph(child, null, nested);
        // A wrapper paragraph around a dual-dialogue pair carries no text of its own as a rule; keep it when it does.
        if (nested.length === 0 || hasContent(paragraph)) drafts.push(paragraph);
        for (const dual of nested) readContainer(dual);
      } else if (child.name === 'DualDialogue') {
        readContainer(child);
      } else if (child.name === 'ScriptNotes') {
        for (const note of childElements(child, 'ScriptNote')) {
          const text = noteText(note);
          if (text === '') continue;
          const start = /^\s*(\d+)/.exec(note.attrs.Range ?? '');
          listed.push({ text, offset: start === null ? null : Number(start[1]) });
        }
      } else if (child.name === 'UnanchoredScriptNotes') {
        for (const note of childElements(child, 'ScriptNote')) {
          const text = noteText(note);
          if (text !== '') legacy.push(text);
        }
      } else if (SCRIPT_CONTAINERS.has(child.name)) {
        inner.push(child);
      }
    }
    // Children are read in order: the stack takes the last pushed first, so they go on in reverse.
    for (let i = inner.length - 1; i >= 0; i -= 1) pending.push(inner[i] as XmlElement);
  }
  // A container is read whole before the next one starts, so a nested Content is read after its siblings. FDX has one
  // Content; a fragment has none. Either way the order of paragraphs inside a container is the file's.

  const wholeIsPage = drafts.some((d) => d.length !== null && FRACTION.test(d.length));
  // Offsets of each paragraph's first character, counting every run (hidden ones too) and one character between paragraphs.
  const starts: number[] = [];
  let offset = 0;
  for (const d of drafts) {
    starts.push(offset);
    for (const s of d.segments) if (s.kind === 'text') offset += s.text.length;
    offset += 1;
  }
  let placed = 0;
  for (const note of listed) {
    if (note.offset === null || drafts.length === 0 || note.offset >= offset) {
      unanchored.push(note.text);
      continue;
    }
    // The last paragraph starting at or before the offset. Binary search keeps a long notes list linear-ish.
    let lo = 0;
    let hi = drafts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= note.offset) lo = mid;
      else hi = mid - 1;
    }
    drafts[lo]?.segments.push({ kind: 'note', text: note.text });
    placed += 1;
  }

  const paragraphs = drafts.map((d): FdxParagraph => {
    const length = d.length === null ? null : lengthInEighths(d.length, wholeIsPage);
    return {
      type: d.type,
      text: d.segments
        .map((s) => (s.kind === 'text' && !s.style.includes('HiddenText') ? s.text : ''))
        .join(''),
      alignment: d.alignment,
      lengthEighths: length,
      container: d.container,
      number: d.number,
      segments: d.segments,
      summary: d.summary,
    };
  });
  return { paragraphs, unanchored: [...unanchored, ...legacy], listed: placed };
}

/**
 * Reads the script paragraphs of an FDX document in order, with their container, scene length, runs and notes. The
 * paragraphs of the title page, the page header, a scene's properties and a note are not script paragraphs and are
 * left out; `parseFdxTitlePage` reads the title page.
 */
export function parseFdxParagraphs(xml: string): FdxParagraph[] {
  return readDocument(readXml(xml)).paragraphs;
}

/** The credit lines a title page opens its author with. */
const CREDIT_LINES: ReadonlySet<string> = new Set(['written by', 'by', 'screenplay by', 'story by', 'teleplay by', 'a screenplay by']);

/** `Key: value` as the exporter writes a title-page entry, or null when the text does not open with a key. */
function labelled(text: string): { key: string; value: string } | null {
  const colon = text.indexOf(':');
  if (colon <= 0 || colon > 40) return null;
  const key = text.slice(0, colon).trim();
  if (!/^[A-Za-z][A-Za-z ]*$/.test(key)) return null;
  return { key, value: text.slice(colon + 1).trim() };
}

/** The first `<TitlePage>` at the top of the document, or null. */
function titlePageOf(root: XmlElement): XmlElement | null {
  const pending: XmlElement[] = [root];
  while (pending.length > 0) {
    const container = pending.shift() as XmlElement;
    for (const child of childElements(container)) {
      if (child.name === 'TitlePage') return child;
      if (child.name === 'FinalDraft') pending.push(child);
    }
  }
  return null;
}

/** The paragraphs of a title page, in order: those inside its `Content`, or directly inside it. */
function titleParagraphs(page: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of childElements(page)) {
    if (child.name === 'Paragraph') out.push(child);
    else if (child.name === 'Content') out.push(...childElements(child, 'Paragraph'));
  }
  return out;
}

/**
 * Reads the `<TitlePage>` of an FDX document into title-page entries, best effort: Final Draft's title page is free
 * layout, so only what can be named is. In the order the lines are tried: a credit line (`Written by`, `By`, ...), bare or
 * as the key of a `Key: value` paragraph, gives the Credit, and its value or the next line gives the Author; any other
 * `Key: value` paragraph, which is how `renderFdx` writes an entry, keeps its key; a line holding the whole word `draft`,
 * of at most 60 characters, is the Draft date; the first other line is the Title, but only while no credit line has been
 * seen; every remaining line goes to Notes. Null when there is no title page or it holds no text.
 */
export function parseFdxTitlePage(xml: string): Record<string, string> | null {
  return titlePageEntries(readXml(xml));
}

function titlePageEntries(root: XmlElement): Record<string, string> | null {
  const page = titlePageOf(root);
  if (page === null) return null;
  const entries: Record<string, string> = {};
  const add = (key: string, value: string): void => {
    entries[key] = key in entries ? `${entries[key]}\n${value}` : value;
  };
  const notes: string[] = [];
  let credited = false;
  let authorNext = false;
  for (const paragraph of titleParagraphs(page)) {
    const text = runsText(paragraph).trim();
    if (text === '') continue;
    const entry = labelled(text);
    const phrase = entry?.key ?? text.replace(/:$/, '');
    if (CREDIT_LINES.has(phrase.toLowerCase())) {
      credited = true;
      add('Credit', phrase);
      if (entry !== null && entry.value !== '') add('Author', entry.value);
      else authorNext = true;
    } else if (entry !== null) {
      add(entry.key, entry.value);
    } else if (authorNext) {
      add('Author', text);
      authorNext = false;
    } else if (/\bdraft\b/i.test(text) && text.length <= 60) {
      add('Draft date', text);
    } else if (!credited && !('Title' in entries)) {
      add('Title', text);
    } else {
      notes.push(text);
    }
  }
  if (notes.length > 0) add('Notes', notes.join('\n'));
  return Object.keys(entries).length > 0 ? entries : null;
}

/** A note's text made safe inside `[[…]]`: one line, and no bracket pair that would close or open another note. */
function noteMarkup(text: string): string {
  return `[[${oneLine(text).replace(/\]\]/g, '] ]').replace(/\[\[/g, '[ [')}]]`;
}

/** What one paragraph's runs become in Fountain, and what was counted on the way. */
interface Markup {
  readonly inline: string;
  /** Notes (and hidden runs) to write as their own lines after the element, where the element cannot hold them inline. */
  readonly apart: string[];
}

interface Counts {
  notes: number;
  hiddenRuns: number;
  strikeouts: number;
  plainedRuns: number;
}

/** Wraps `text` in Fountain emphasis, keeping its outer white space outside the marks and each line marked on its own. */
function emphasise(text: string, bold: boolean, italic: boolean, underline: boolean): string {
  if (!bold && !italic && !underline) return text;
  const stars = bold && italic ? '***' : bold ? '**' : italic ? '*' : '';
  return text
    .split('\n')
    .map((line) => {
      const match = /^(\s*)(.*?)(\s*)$/s.exec(line);
      const core = match?.[2] ?? '';
      if (core === '') return line;
      const marked = underline ? `_${stars}${core}${stars}_` : `${stars}${core}${stars}`;
      return `${match?.[1] ?? ''}${marked}${match?.[3] ?? ''}`;
    })
    .join('\n');
}

/**
 * The Fountain text of a paragraph's segments. `styled` says whether bold, italic and underline are written as
 * Fountain emphasis (they cannot be on a heading, a cue or a transition); `inlineNotes` whether a note stays where it
 * was anchored in the line, or goes on a line of its own after the element.
 */
function markupOf(segments: readonly FdxSegment[], styled: boolean, inlineNotes: boolean, counts: Counts): Markup {
  let inline = '';
  const apart: string[] = [];
  // A note before any text goes after the line instead: a line that opens with `[[` would need Fountain's `!` to stay action.
  const leading: string[] = [];
  const addNote = (text: string): void => {
    const note = noteMarkup(text);
    if (!inlineNotes) apart.push(note);
    else if (inline.trim() === '') leading.push(note);
    else inline += /\s$/.test(inline) ? note : ` ${note}`;
  };
  // Runs that share their marks are joined first, so a style change in the middle of a word is one span.
  let pending = '';
  let pendingMarks = '';
  const flush = (): void => {
    if (pending === '') return;
    inline += emphasise(pending, pendingMarks.includes('B'), pendingMarks.includes('I'), pendingMarks.includes('U'));
    pending = '';
  };
  for (const segment of segments) {
    if (segment.kind === 'note') {
      flush();
      if (segment.text.trim() !== '') {
        counts.notes += 1;
        addNote(segment.text);
      }
      continue;
    }
    const style = new Set(segment.style);
    if (style.has('HiddenText')) {
      flush();
      if (segment.text.trim() !== '') {
        counts.hiddenRuns += 1;
        addNote(segment.text);
      }
      continue;
    }
    if (segment.text === '') continue;
    if (style.has('Strikeout') && segment.text.trim() !== '') counts.strikeouts += 1;
    const wanted = `${style.has('Bold') ? 'B' : ''}${style.has('Italic') ? 'I' : ''}${style.has('Underline') ? 'U' : ''}`;
    if (!styled && wanted !== '' && segment.text.trim() !== '') counts.plainedRuns += 1;
    const marks = styled ? wanted : '';
    if (marks !== pendingMarks) flush();
    // Text after an inline note is set off from it, so the note never joins a word.
    if (pending === '' && inline.endsWith(']]') && !/^\s/.test(segment.text)) inline += ' ';
    pendingMarks = marks;
    pending += segment.text;
  }
  flush();
  for (const note of leading) inline += inline === '' || /\s$/.test(inline) ? note : ` ${note}`;
  return { inline, apart };
}

/** FDX paragraph types to elements. The second cue of a dual-dialogue pair takes the dual marker. */
function fdxElements(paragraphs: readonly FdxParagraph[], notices: string[], counts: Counts): ScreenplayElement[] {
  const elements: ScreenplayElement[] = [];
  const cuesSeen = new Map<number, number>();
  const notesAfter = (notes: readonly string[]): void => {
    for (const note of notes) elements.push({ type: 'note', text: note.slice(2, -2) });
  };
  for (const p of paragraphs) {
    const plainType = p.type === 'Scene Heading' || p.type === 'Character' || p.type === 'Transition';
    const inlineType = !plainType && p.type !== 'Parenthetical' && !(p.type === 'General' && p.alignment === 'Center');
    if (p.text.trim() === '') {
      // No printed text: what the paragraph held in notes or hidden runs still comes in, each on a line of its own.
      notesAfter(markupOf(p.segments, false, false, counts).apart);
      continue;
    }
    const markup = markupOf(p.segments, !plainType, inlineType, counts);
    const text = (plainType ? p.text : markup.inline).trim();
    switch (p.type) {
      case 'Scene Heading': {
        // The number goes where Fountain keeps it, unless the heading carries one already or this one could not be read back.
        const carriable = p.number !== null && !p.number.includes('#') && !p.number.includes('\n');
        if (p.number !== null && !carriable) {
          notices.push(`"${text}": its Final Draft number "${p.number.replace(/\n/g, ' ')}" cannot be carried into a Fountain heading; it was left out.`);
        }
        const numbered = carriable && sceneNumberOf(text) === null;
        elements.push({ type: 'scene_heading', text: numbered ? `${text} #${p.number}#` : text, forced: false });
        if (p.summary !== null) elements.push({ type: 'synopsis', text: p.summary });
        break;
      }
      case 'Action':
      case 'Shot':
        elements.push({ type: 'action', text });
        break;
      case 'General':
        elements.push(p.alignment === 'Center' ? { type: 'centered', text } : { type: 'action', text });
        break;
      case 'Character': {
        let dual = false;
        if (p.container !== null) {
          const seen = (cuesSeen.get(p.container) ?? 0) + 1;
          cuesSeen.set(p.container, seen);
          dual = seen > 1;
        }
        elements.push(dual ? { type: 'character', text, dual: true } : { type: 'character', text });
        break;
      }
      case 'Parenthetical':
        elements.push({ type: 'parenthetical', text: text.startsWith('(') ? text : `(${text})` });
        break;
      case 'Dialogue':
        elements.push({ type: 'dialogue', text });
        break;
      case 'Transition':
        elements.push({ type: 'transition', text, forced: false });
        break;
      default:
        notices.push(`Paragraph type "${p.type}" imported as action.`);
        elements.push({ type: 'action', text });
    }
    notesAfter(markup.apart);
  }
  return elements;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Imports an FDX script. The paragraphs become Fountain, then the Fountain importer maps
 * them onto scenes. Each scene takes the `SceneProperties Length` of its own heading and its `Summary` as its synopsis.
 * Script notes and hidden text become Fountain notes, bold, italic and underline become Fountain emphasis, and a
 * dual-dialogue pair takes Fountain's `^`; the report counts each, and the notices say what was not kept.
 */
export function importFdx(xml: string): FdxImportedScript {
  const notices: string[] = [];
  const root = readXml(xml);
  const document = readDocument(root);
  const { paragraphs } = document;
  const counts: Counts = { notes: 0, hiddenRuns: 0, strikeouts: 0, plainedRuns: 0 };
  const elements = fdxElements(paragraphs, notices, counts);
  for (const note of document.unanchored) {
    counts.notes += 1;
    elements.push({ type: 'note', text: noteMarkup(note).slice(2, -2) });
  }
  const script = importFountainScript(serialiseFountain(elements));
  const headings = paragraphs.filter((p) => p.type === 'Scene Heading' && p.text.trim() !== '');
  const lengths = headings.map((p) => p.lengthEighths);
  let next = 0;
  const nodes = script.nodes.map((node) => {
    if (node.kind !== 'scene' || node.heading === null) return node;
    const lengthEighths = lengths[next] ?? null;
    next += 1;
    return { ...node, lengthEighths };
  });
  const cues = new Map<number, number>();
  for (const p of paragraphs) {
    if (p.container !== null && p.type === 'Character' && p.text.trim() !== '') cues.set(p.container, (cues.get(p.container) ?? 0) + 1);
  }
  const report: FdxImportReport = {
    notes: counts.notes,
    unanchoredNotes: document.unanchored.length,
    hiddenRuns: counts.hiddenRuns,
    dualDialogues: [...cues.values()].filter((n) => n > 1).length,
    summaries: headings.filter((p) => p.summary !== null).length,
    strikeouts: counts.strikeouts,
    plainedRuns: counts.plainedRuns,
  };
  if (report.notes > 0) notices.push(`${plural(report.notes, 'script note was', 'script notes were')} kept as Fountain notes ([[…]]), which do not print.`);
  if (report.unanchoredNotes > 0) {
    notices.push(`${plural(report.unanchoredNotes, 'script note has', 'script notes have')} no place in the script and went to the end of the last scene.`);
  }
  if (report.hiddenRuns > 0) notices.push(`${plural(report.hiddenRuns, 'run of hidden text was', 'runs of hidden text were')} kept as Fountain notes, not as printed text.`);
  if (report.strikeouts > 0) notices.push(`Strikeout on ${plural(report.strikeouts, 'run', 'runs')} was not kept: Fountain has no strikeout. The text was kept.`);
  if (report.plainedRuns > 0) {
    notices.push(`Bold, italic or underline on ${plural(report.plainedRuns, 'run', 'runs')} in scene headings, cues or transitions was not kept: Fountain writes those elements plain. The text was kept.`);
  }
  return { titlePage: titlePageEntries(root) ?? script.titlePage, nodes, notices: [...notices, ...script.notices], report };
}

/**
 * What an FDX import will do, in the words the Import script dialog shows before anything is written: what it makes,
 * then the notes and dual dialogue it keeps (always shown, zero included, so the writer can see none were lost), then
 * what else it carries over. The notices say what it could not keep.
 */
export function describeFdxImport(script: FdxImportedScript): string[] {
  const scenes = script.nodes.filter((node) => node.kind === 'scene').length;
  const sections = script.nodes.length - scenes;
  const { report } = script;
  const lines = [
    `${plural(scenes, 'scene', 'scenes')} and ${plural(sections, 'section', 'sections')} will be made, in one undo step.`,
    `${plural(report.notes, 'script note', 'script notes')} kept as Fountain notes ([[…]]), which do not print.`,
    `${plural(report.dualDialogues, 'dual-dialogue pair', 'dual-dialogue pairs')} kept side by side (Fountain's ^).`,
  ];
  if (report.summaries > 0) lines.push(`${plural(report.summaries, 'scene summary', 'scene summaries')} kept as ${report.summaries === 1 ? 'a scene synopsis' : 'scene synopses'}.`);
  if (report.hiddenRuns > 0) lines.push(`${plural(report.hiddenRuns, 'run of hidden text', 'runs of hidden text')} kept as notes, not printed.`);
  return lines;
}

export interface FdxRenderResult {
  readonly xml: string;
  /** What was left out, in order: never silent (screenplay.md §5.2, D11). */
  readonly notes: readonly string[];
}

/** One `<Paragraph>` line. `attrs` is a string of attributes, each with its leading space. */
function paragraphXml(type: string, text: string, properties: string, attrs: string): string {
  return `<Paragraph Type="${type}"${attrs}>${properties}<Text>${escapeXml(text)}</Text></Paragraph>`;
}

/**
 * Renders the flattened blocks as an FDX document, to D11's emit set.
 * Annotations do not print, so each paragraph carries its printed text (`printedText`).
 */
export function renderFdx(blocks: readonly FlatBlock[], opts: FountainRenderOptions): FdxRenderResult {
  const fountain = renderFountain(blocks, opts);
  const parsed = parseFountain(fountain.text);
  // Pagination supplies the SceneProperties Length and Page, and the header's page numbers: D11 emits
  // only what has been computed.
  const pages = paginate(parsed.elements, { titlePage: false });
  const lengths = new Map(sceneLengths(pages).map((s) => [s.scene, s] as const));
  const notes = [...fountain.notes];

  const titleEntries = parsed.elements.find((el) => el.type === 'title_page');
  const titleXml: string[] = [];
  if (titleEntries !== undefined && titleEntries.type === 'title_page') {
    const paragraphs = Object.entries(titleEntries.entries).map(
      ([key, value]) => `      ${paragraphXml('Action', `${key}: ${value}`, '', ' Alignment="Center"')}`,
    );
    titleXml.push('  <TitlePage>', '    <Content>', ...paragraphs, '    </Content>', '  </TitlePage>');
  }

  const body: string[] = [];
  let scene = 0;
  let sequentialDual = false;
  for (const el of parsed.elements) {
    const text = 'text' in el ? printedText(el.text) : '';
    switch (el.type) {
      case 'scene_heading': {
        const length = lengths.get(scene);
        const printed = printedText(el.text);
        const number = sceneNumberOf(printed);
        const properties = length !== undefined ? `<SceneProperties Length="${length.lengthEighths}" Page="${length.page}"/>` : '';
        // The number is kept verbatim from the heading. Its attribute name is unverified (a known gap).
        const attrs = number !== null ? ` Number="${escapeXml(number)}"` : '';
        body.push(paragraphXml('Scene Heading', stripSceneNumber(printed), properties, attrs));
        scene += 1;
        break;
      }
      case 'action':
        if (text !== '') body.push(paragraphXml('Action', text.replace(/\n/g, ' '), '', ''));
        break;
      case 'character':
        if (el.dual === true) sequentialDual = true;
        if (text !== '') body.push(paragraphXml('Character', text, '', ''));
        break;
      case 'parenthetical':
        if (text !== '') body.push(paragraphXml('Parenthetical', text, '', ''));
        break;
      case 'dialogue':
        if (text !== '') body.push(paragraphXml('Dialogue', text.replace(/\n/g, ' '), '', ''));
        break;
      case 'transition':
        if (text !== '') body.push(paragraphXml('Transition', text, '', ''));
        break;
      case 'centered':
        if (text !== '') body.push(paragraphXml('General', text, '', ' Alignment="Center"'));
        break;
      // Sections, synopses, notes, boneyards and page breaks are never emitted (screenplay.md §2.2, §5.2).
      default:
        break;
    }
  }
  if (sequentialDual) {
    notes.push('Dual dialogue written as sequential paragraphs: the DualDialogue container is not emitted.');
  }

  // The page-number layer (D11). Page 1 carries no number (screenplay.md §5.3), so the first numbered page is 2.
  const firstNumbered = pages.find((page) => page.number >= 2)?.number ?? 2;
  const xml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
    '<FinalDraft DocumentType="Script" Template="No" Version="3">',
    ...titleXml,
    '  <Content>',
    ...body.map((line) => `    ${line}`),
    '  </Content>',
    `  <HeaderAndFooter FirstPage="${firstNumbered}">`,
    '    <Header>',
    '      <Paragraph Alignment="Right"><DynamicLabel Type="Page"/></Paragraph>',
    '    </Header>',
    '  </HeaderAndFooter>',
    '</FinalDraft>',
  ].join('\n');
  return { xml: `${xml}\n`, notes };
}

export interface FdxRenderer {
  emit(blocks: readonly FlatBlock[], opts: FountainRenderOptions): Promise<Blob>;
}

export function createFdxRenderer(): FdxRenderer {
  return {
    async emit(blocks, opts) {
      const { xml } = renderFdx(blocks, opts);
      return new Blob([xml], { type: FDX_MIME });
    },
  };
}
