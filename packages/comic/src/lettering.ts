/**
 * Lettering rules — comics.md §4. Everything here returns new strings and offsets; the balloon's stored text is never
 * changed, because what the writer typed is the source and the caps, the bold italic and the line breaks are only how
 * it is shown.
 *
 * Not here: the crossbar "I". It needs a glyph alternate, and comics.md §4 says whether the vendored face has one is
 * checked when the font is vendored (D4); the renderer applies it, or leaves it off with a note, from that check.
 */

/**
 * The vendored lettering faces (comics.md §4): the family names the page view's `FontFace` and the renderers'
 * `font-family` agree on. They are font metadata, never interface copy.
 */
export const COMIC_NEUE_FAMILY = 'Comic Neue';
export const BANGERS_FAMILY = 'Bangers';

export interface CapsOptions {
  capsTransform: boolean;
  /** Keep ß as ẞ instead of lettering it SS. */
  esszett: boolean;
  /** A BCP 47 tag, the project's language. */
  language: string;
}

const GEORGIAN_SPLIT = /\p{Script=Georgian}+|[^\p{Script=Georgian}]+/gu;

function upper(text: string, language: string): string {
  try {
    return text.toLocaleUpperCase(language);
  } catch {
    return text.toUpperCase();
  }
}

/**
 * The text as the lettering shows it. Han, Kana, Arabic, Hebrew and Devanagari have no case, so the mapping leaves them
 * as they are; Georgian does have one (Mtavruli) but is never lettered in capitals, so it is skipped by name.
 * German ß becomes SS unless the book opted into ẞ.
 */
export function toLetteringCaps(text: string, options: CapsOptions): string {
  if (!options.capsTransform) return text;
  const parts = text.match(GEORGIAN_SPLIT) ?? [];
  return parts
    .map((part) => {
      if (/^\p{Script=Georgian}/u.test(part)) return part;
      const prepared = options.esszett ? part.replaceAll('ß', 'ẞ') : part;
      return upper(prepared, options.language);
    })
    .join('');
}

export interface EmphasisRun {
  /** The text without its `**` markers. */
  text: string;
  /** Bold italic. */
  emphasis: boolean;
  /** Where `text` sits in the source. */
  from: number;
  to: number;
}

const EMPHASIS = /\*\*(?=\S)([^\n]*?\S)\*\*/g;

/** `**word**` is bold italic. An unpaired `**` stays in the text as typed. */
export function parseEmphasis(source: string): EmphasisRun[] {
  const runs: EmphasisRun[] = [];
  let last = 0;
  for (const m of source.matchAll(EMPHASIS)) {
    const start = m.index ?? 0;
    if (start > last) runs.push({ text: source.slice(last, start), emphasis: false, from: last, to: start });
    runs.push({ text: m[1] ?? '', emphasis: true, from: start + 2, to: start + 2 + (m[1] ?? '').length });
    last = start + m[0].length;
  }
  if (last < source.length) runs.push({ text: source.slice(last), emphasis: false, from: last, to: source.length });
  return runs;
}

export function stripEmphasis(source: string): string {
  return parseEmphasis(source)
    .map((r) => r.text)
    .join('');
}

export interface DashHit {
  from: number;
  to: number;
}

/** Em dashes in `text`; a run of them is one hit. Lettering keeps a double dash (`--`) instead. */
export function findEmDashes(text: string): DashHit[] {
  return [...text.matchAll(/\u2014+/g)].map((m) => ({ from: m.index ?? 0, to: (m.index ?? 0) + m[0].length }));
}

/** What the lint suggests; applying it is the writer's choice and never automatic. */
export function emDashToDoubleDash(text: string): string {
  return text.replace(/\u2014+/g, '--');
}

// ---------------------------------------------------------------- line breaking

export interface LineSpan {
  from: number;
  to: number;
  text: string;
}

const UNSPACED_SCRIPT = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const BREAK_SPACE = /^[ \t\u3000]+$/;
/** Never start a line with these (kinsoku), whatever script is beside them. */
const NO_LINE_START = /^[、。，．：；！？）］｝〕】〉》」』〙〗…‥ー々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ,.:;!?)\]}%]/u;
const NO_LINE_END = /[（［｛〔【〈《「『〘〖([{]$/u;

function graphemeEnds(text: string): number[] {
  const ends: number[] = [];
  try {
    const seg = new Intl.Segmenter('und', { granularity: 'grapheme' });
    for (const part of seg.segment(text)) ends.push(part.index + part.segment.length);
  } catch {
    let at = 0;
    for (const ch of text) {
      at += ch.length;
      ends.push(at);
    }
  }
  return ends;
}

/** The offsets where a line may end, inside one hard-break-free paragraph `text[from, to)`. */
function breakOpportunities(text: string, from: number, to: number): number[] {
  const slice = text.slice(from, to);
  const ends = graphemeEnds(slice);
  const out: number[] = [];
  for (let i = 0; i < ends.length - 1; i += 1) {
    const at = ends[i] as number;
    const prevStart = i === 0 ? 0 : (ends[i - 1] as number);
    const prev = slice.slice(prevStart, at);
    const next = slice.slice(at, ends[i + 1]);
    if (BREAK_SPACE.test(prev)) {
      if (!BREAK_SPACE.test(next)) out.push(from + at);
    } else if (
      !BREAK_SPACE.test(next) &&
      (UNSPACED_SCRIPT.test(prev) || UNSPACED_SCRIPT.test(next)) &&
      !NO_LINE_START.test(next) &&
      !NO_LINE_END.test(prev)
    ) {
      out.push(from + at);
    }
  }
  out.push(to);
  return out;
}

function trimEnd(text: string, from: number, to: number): number {
  let end = to;
  while (end > from && /[ \t\u3000]/.test(text[end - 1] ?? '')) end -= 1;
  return end;
}

/**
 * Greedy line breaking over a measure of `text[from, to)`. Lines break at spaces, between Han, Kana and Thai-family
 * characters (never before closing punctuation or after opening punctuation), and at a `\n`. A word wider than the line
 * is cut between grapheme clusters, so a line is never empty and never loops. `--` has no space inside it, so it stays
 * with the word it follows.
 */
export function breakLinesBy(
  text: string,
  maxWidth: number,
  measureRange: (from: number, to: number) => number,
): LineSpan[] {
  const lines: LineSpan[] = [];
  let paraStart = 0;
  for (const paragraph of text.split('\n')) {
    const paraEnd = paraStart + paragraph.length;
    if (paragraph.length === 0) {
      paraStart = paraEnd + 1;
      continue;
    }
    const opps = breakOpportunities(text, paraStart, paraEnd);
    const graphemes = graphemeEnds(text.slice(paraStart, paraEnd)).map((e) => paraStart + e);
    let start = paraStart;
    let oi = 0;
    while (start < paraEnd) {
      while (oi < opps.length && (opps[oi] as number) <= start) oi += 1;
      let fit = -1;
      let k = oi;
      for (; k < opps.length; k += 1) {
        const end = opps[k] as number;
        if (maxWidth > 0 && measureRange(start, trimEnd(text, start, end)) > maxWidth) break;
        fit = end;
      }
      if (fit === -1) {
        // A single atom wider than the line: cut it between grapheme clusters.
        const atomEnd = opps[oi] as number;
        let cut = start;
        for (const g of graphemes) {
          if (g <= start) continue;
          if (g > atomEnd) break;
          if (cut > start && measureRange(start, g) > maxWidth) break;
          cut = g;
        }
        fit = cut > start ? cut : (graphemes.find((g) => g > start) ?? atomEnd);
      }
      const to = trimEnd(text, start, fit);
      if (to > start) lines.push({ from: start, to, text: text.slice(start, to) });
      start = fit;
    }
    paraStart = paraEnd + 1;
  }
  return lines;
}

/** {@link breakLinesBy} with a measure of plain text, the injected font metrics. */
export function breakLines(text: string, maxWidth: number, measure: (text: string) => number): LineSpan[] {
  return breakLinesBy(text, maxWidth, (from, to) => measure(text.slice(from, to)));
}

// ---------------------------------------------------------------- whole-balloon layout

export interface LetteringRun {
  text: string;
  emphasis: boolean;
}

export interface LetteringLine {
  runs: LetteringRun[];
}

export interface LetteringLayoutOptions extends CapsOptions {
  maxWidth: number;
  /** The width of `text` in the face the balloon uses, bold italic when `emphasis`. Injected so this stays pure. */
  measure: (text: string, style: { emphasis: boolean }) => number;
}

/** The text as shown, markers removed and caps applied: what a screen reader and the PDF text layer carry. */
export function letteringDisplayText(source: string, options: CapsOptions): string {
  return parseEmphasis(source)
    .map((r) => toLetteringCaps(r.text, options))
    .join('');
}

export function layoutLettering(source: string, options: LetteringLayoutOptions): LetteringLine[] {
  const runs = parseEmphasis(source).map((r) => ({ text: toLetteringCaps(r.text, options), emphasis: r.emphasis }));
  const plain = runs.map((r) => r.text).join('');
  if (plain.length === 0) return [];
  const bounds: { from: number; to: number; emphasis: boolean }[] = [];
  let at = 0;
  for (const r of runs) {
    bounds.push({ from: at, to: at + r.text.length, emphasis: r.emphasis });
    at += r.text.length;
  }
  const slices = (from: number, to: number): LetteringRun[] => {
    const out: LetteringRun[] = [];
    for (const b of bounds) {
      const a = Math.max(from, b.from);
      const z = Math.min(to, b.to);
      if (z > a) out.push({ text: plain.slice(a, z), emphasis: b.emphasis });
    }
    return out;
  };
  const width = (from: number, to: number): number =>
    slices(from, to).reduce((sum, r) => sum + options.measure(r.text, { emphasis: r.emphasis }), 0);
  return breakLinesBy(plain, options.maxWidth, width).map((span) => ({ runs: slices(span.from, span.to) }));
}
