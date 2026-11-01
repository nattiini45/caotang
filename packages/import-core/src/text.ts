/**
 * The text rules the splitter scores with (import-core.md §3): chapter-pattern families, scene-break markers, back-matter and
 * table-of-contents headings, heading styles, the short-line test, word counts and chapter numbers. Pure and table-driven.
 */
import type { PatternFamily } from './rules.js';

// ---------------------------------------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------------------------------------

/** Han, kana and CJK compatibility ideographs count one word each (no spaces between words). Hangul is spaced, so it is not here. */
function isCjk(c: number): boolean {
  return (c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff);
}
function isSpace(c: number): boolean {
  return c <= 0x20 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}
const WORDISH = /[\p{L}\p{N}]/u;

/**
 * Words in a plain-text string: each CJK character is one, every other whitespace-separated token holding a letter or digit is one.
 * A character loop rather than split/replace: the splitter counts every block of a 200k-word book on every rule change.
 */
export function countWords(text: string): number {
  let count = 0;
  let inToken = false;
  let wordish = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      if (c <= 0x20) {
        if (wordish) count++;
        inToken = false;
        wordish = false;
      } else {
        inToken = true;
        if (!wordish && ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))) wordish = true;
      }
      continue;
    }
    const cjk = isCjk(c);
    if (cjk || isSpace(c)) {
      if (wordish) count++;
      inToken = false;
      wordish = false;
      if (cjk) count++;
      continue;
    }
    inToken = true;
    if (!wordish) {
      // A surrogate pair is tested as one code point.
      const cp = text.codePointAt(i) ?? c;
      if (WORDISH.test(String.fromCodePoint(cp))) wordish = true;
    }
  }
  if (inToken && wordish) count++;
  return count;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Short lines
// ---------------------------------------------------------------------------------------------------------------------------

const SENTENCE_END = new Set([...'.?!…"”»」』。！？']);

/** "3." or "IV." at the end: a numeral before the full stop (a Roman numeral as a whole word). */
function endsWithNumeralDot(t: string): boolean {
  if (!t.endsWith('.') || t.length < 2) return false;
  const before = t[t.length - 2] as string;
  if (before >= '0' && before <= '9') return true;
  let i = t.length - 2;
  while (i >= 0 && 'IVXLCDM'.includes(t[i] as string)) i--;
  return i < t.length - 2 && (i < 0 || !/[\p{L}\p{N}]/u.test(t[i] as string));
}

/** §3 Step A: at most 60 characters and 8 words, and no sentence-final punctuation unless it follows a numeral ("Chapter 3."). */
export function isShortLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 60 || countWords(t) > 8) return false;
  if (SENTENCE_END.has(t[t.length - 1] as string) && !endsWithNumeralDot(t)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Scene-break markers
// ---------------------------------------------------------------------------------------------------------------------------

const SYMBOLS_ONLY = /^[\s*#~•·⁂§◆◇❖—–\-=_+]+$/u;
const OOO = /^[oO][0oO][oO]$/u;

/**
 * §3 Step C: a paragraph whose trimmed text is only `* # ~ • · ⁂ § ◆ ◇ ❖ — – - = _ +` and spaces (at most 15 characters, or 40 when
 * centred), or the "o0o" / "oOo" convention. Returns the marker as written, or null.
 */
export function breakMarkerOf(text: string, centered: boolean): string | null {
  const t = text.trim();
  if (!t) return null;
  if (OOO.test(t)) return t;
  if (SYMBOLS_ONLY.test(t) && t.length <= (centered ? 40 : 15)) return t;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Chapter patterns
// ---------------------------------------------------------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  // English
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  // German
  eins: 1, zwei: 2, drei: 3, vier: 4, 'fünf': 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, 'zwölf': 12,
  // French
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9, dix: 10,
  // Spanish / Italian / Portuguese
  uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, due: 2, tre: 3, quattro: 4,
};
const NUMBER_WORD_ALT = Object.keys(NUMBER_WORDS)
  .sort((a, b) => b.length - a.length)
  .join('|');
/** A chapter number: digits (also full-width), a Roman numeral, or number words ("twenty-one"). */
const NUM = `(?:[0-9０-９]{1,4}|[ivxlcdm]{1,8}|(?:${NUMBER_WORD_ALT})(?:[- ](?:${NUMBER_WORD_ALT}))?)`;
const SEP = `[\\s.:–—\\-]`;

const CHAPTER_WORDS = 'chapter|chap\\.|ch\\.|kapitel|chapitre|capítulo|capitulo|capitolo|hoofdstuk|rozdział|rozdzial|глава';
const PART_WORDS = 'part|book|teil|buch|partie|livre|parte|libro|deel|boek|część|czesc|księga|ksiega|часть|книга';
const SPECIAL_WORDS =
  'prologue|prolog|prólogo|prologo|epilogue|epilog|épilogue|epílogo|epilogo|interlude|interludium|zwischenspiel|intermède|interludio';

/**
 * The patterns match only a line's *head* (the word and its number), anchored at the start; what follows is read by `tailOf` with a
 * character loop. No pattern has two adjacent quantifiers that can match the same characters, so none can backtrack
 * polynomially on a long or hostile line (CodeQL js/polynomial-redos).
 */
function wordFamily(words: string): RegExp {
  return new RegExp(`^(?:${words})(?:(?:${SEP}+|(?<=\\.))(${NUM})(?=$|[\\s.:–—)\\-]))?`, 'iu');
}
const CHAPTER_RE = wordFamily(CHAPTER_WORDS);
const PART_RE = wordFamily(PART_WORDS);
/** German order: "1. Kapitel", "2. Teil". */
const DE_CHAPTER_RE = /^([0-9]{1,3})\.\s*kapitel(?=$|[\s.:–—-])/iu;
const DE_PART_RE = /^([0-9]{1,3})\.\s*teil(?=$|[\s.:–—-])/iu;
const CJK_NUM = '[0-9０-９一二三四五六七八九十百千零〇两兩]+';
const CJK_CHAPTER_RE = new RegExp(`^第\\s*(${CJK_NUM})\\s*[章回节節]`, 'u');
const CJK_PART_RE = new RegExp(`^第\\s*(${CJK_NUM})\\s*[部卷编編篇]`, 'u');
const KO_CHAPTER_RE = /^제\s*([0-9]+)\s*장/u;
const KO_PART_RE = /^제\s*([0-9]+)\s*부/u;
const NUMBER_ONLY_RE = /^[\s—–-]*([0-9]{1,3}|[IVXLCDM]{1,7})[.)]?[\s—–-]*$/u;
const SPECIAL_RE = new RegExp(`^(${SPECIAL_WORDS})`, 'iu');
const CJK_SPECIAL_RE = /^(序章|序幕|楔子|引子|尾声|尾聲|终章|終章|间章|間章)/u;

/** Characters between a chapter number and its title. */
const TAIL_SEPARATORS = new Set([...' \t\n\r\u00a0\u3000.:–—-)：、·']);
/** Characters that may introduce a title directly after the word ("Chapter: The Landing"). */
const TITLE_SEPARATORS = new Set([...'.:–—-']);
const isWhite = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\u00a0' || ch === '\u3000';

/** What follows a number: separators skipped, the rest trimmed. */
function restAfter(after: string): string {
  let i = 0;
  while (i < after.length && TAIL_SEPARATORS.has(after[i] as string)) i++;
  return after.slice(i).trim();
}

/**
 * What follows a bare word (no number): nothing at all (`''`), or a separator and a title (the title). Anything else (a letter
 * straight after the word, or a word after a space: "Chapters", "Part of the problem") is not a chapter line (`null`).
 */
function tailOf(after: string): string | null {
  let i = 0;
  while (i < after.length && isWhite(after[i] as string)) i++;
  if (i === after.length) return '';
  if (!TITLE_SEPARATORS.has(after[i] as string)) return null;
  const rest = restAfter(after.slice(i));
  return rest ? rest : null;
}

export type SpecialKind = 'prologue' | 'epilogue' | 'interlude';

export interface PatternMatch {
  family: PatternFamily;
  /** The number token as written, when there is one. */
  num?: string;
  /** What follows the number and its separator ("The Landing"). */
  rest: string;
}

/** The chapter-pattern family a line belongs to, or null. Prologue/epilogue/interlude lines are `specialOf`, not a family. */
export function matchFamily(text: string): PatternMatch | null {
  const t = text.trim();
  if (!t) return null;
  const words: [PatternFamily, RegExp][] = [
    ['chapter-word', CHAPTER_RE],
    ['part-word', PART_RE],
  ];
  for (const [family, re] of words) {
    const m = re.exec(t);
    if (!m) continue;
    const after = t.slice(m[0].length);
    if (m[1]) return { family, num: m[1], rest: restAfter(after) };
    const rest = tailOf(after);
    if (rest !== null) return { family, rest };
  }
  const numbered: [PatternFamily, RegExp][] = [
    ['chapter-word', DE_CHAPTER_RE],
    ['part-word', DE_PART_RE],
    ['cjk-chapter', CJK_CHAPTER_RE],
    ['cjk-part', CJK_PART_RE],
    ['korean-chapter', KO_CHAPTER_RE],
    ['korean-part', KO_PART_RE],
  ];
  for (const [family, re] of numbered) {
    const m = re.exec(t);
    if (m) return { family, num: m[1] ?? '', rest: restAfter(t.slice(m[0].length)) };
  }
  const n = NUMBER_ONLY_RE.exec(t);
  if (n) return { family: 'number', num: n[1] ?? '', rest: '' };
  return null;
}

export const PART_FAMILIES: ReadonlySet<PatternFamily> = new Set(['part-word', 'cjk-part', 'korean-part']);
export const CHAPTER_FAMILIES: ReadonlySet<PatternFamily> = new Set(['chapter-word', 'cjk-chapter', 'korean-chapter', 'number']);

/** "Prologue", "Epilog: Fire", "序章" → which story part the line names, or null. */
export function specialOf(text: string): SpecialKind | null {
  const t = text.trim();
  const m = SPECIAL_RE.exec(t);
  if (m && tailOf(t.slice(m[0].length)) !== null) {
    const w = (m[1] ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/gu, '');
    if (w.startsWith('pro')) return 'prologue';
    if (w.startsWith('ep')) return 'epilogue';
    return 'interlude';
  }
  const c = CJK_SPECIAL_RE.exec(t);
  if (c) {
    const w = c[1] ?? '';
    if (w === '序章' || w === '序幕' || w === '楔子' || w === '引子') return 'prologue';
    if (w === '间章' || w === '間章') return 'interlude';
    return 'epilogue';
  }
  return null;
}

/** §3 Step E: "Chapter 3: The Landing" → "The Landing"; returns the title unchanged when nothing would be left. */
export function stripChapterNumber(title: string): string {
  const m = matchFamily(title);
  if (!m || m.family === 'number' || PART_FAMILIES.has(m.family)) return title;
  return m.rest ? m.rest : title;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Numbers (sanity flags)
// ---------------------------------------------------------------------------------------------------------------------------

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
const CJK_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CJK_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

function romanValue(s: string): number | null {
  let total = 0;
  const lower = s.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const v = ROMAN[lower[i] ?? ''];
    const next = ROMAN[lower[i + 1] ?? ''] ?? 0;
    if (v === undefined) return null;
    total += v < next ? -v : v;
  }
  return total > 0 ? total : null;
}

function cjkValue(s: string): number | null {
  let total = 0;
  let digit = -1;
  for (const ch of s) {
    if (ch in CJK_DIGIT) digit = CJK_DIGIT[ch] ?? 0;
    else if (ch in CJK_UNIT) {
      total += (digit < 0 ? 1 : digit) * (CJK_UNIT[ch] ?? 1);
      digit = -1;
    } else return null;
  }
  if (digit >= 0) total += digit;
  return total;
}

/** The value of a chapter-number token: digits (full-width too), Roman numerals, number words, CJK numerals. */
export function numberValue(token: string): number | null {
  const t = token.trim();
  if (!t) return null;
  const ascii = t.replace(/[０-９]/gu, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  if (/^[0-9]+$/u.test(ascii)) return Number(ascii);
  if (/^[ivxlcdm]+$/iu.test(ascii)) return romanValue(ascii);
  if (/^[零〇一二三四五六七八九十百千两兩]+$/u.test(ascii)) return cjkValue(ascii);
  let sum = 0;
  for (const part of ascii.toLowerCase().split(/[- ]/u)) {
    const v = NUMBER_WORDS[part];
    if (v === undefined) return null;
    sum += v;
  }
  return sum;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Headings, styles, back matter, table of contents
// ---------------------------------------------------------------------------------------------------------------------------

const HEADING_STYLE_RE = /^(?:heading|überschrift|titre|título|titulo|titolo|kop|nagłówek|заголовок|标题|標題)\s*([1-9])$/iu;
const TITLE_STYLE_RE = /^(?:title|titel|titre|título|titulo|titolo|название|标题|標題)$/iu;
const CHAPTER_STYLE_RE = /chapter|kapitel|chapitre|cap[ií]tulo|capitolo|hoofdstuk|rozdzia|глава|章/iu;
const PART_STYLE_RE = /\bpart\b|teil|partie|parte|deel|część|часть|部/iu;
const TOC_STYLE_RE = /^(?:toc|contents|verzeichnis|inhaltsverzeichnis|table des matières|índice|目录)\s*[0-9]*$/iu;

/** "Heading 2" / "Überschrift 2" → 2. */
export function headingStyleLevel(styleName: string | undefined): number {
  if (!styleName) return 0;
  const m = HEADING_STYLE_RE.exec(styleName.trim());
  return m ? Number(m[1]) : 0;
}
export const isTitleStyle = (styleName: string | undefined): boolean => !!styleName && TITLE_STYLE_RE.test(styleName.trim());
export const isChapterStyle = (styleName: string): boolean => CHAPTER_STYLE_RE.test(styleName);
export const isPartStyle = (styleName: string | undefined): boolean => !!styleName && PART_STYLE_RE.test(styleName);
export const isTocStyle = (styleName: string | undefined): boolean => !!styleName && TOC_STYLE_RE.test(styleName.trim());

const BACK_MATTER_RE =
  /^(?:acknowledge?ments?|about the authors?|also by\b.*|by the same author|danksagung|dank|über die autorin|über den autor|über die autoren|von derselben autorin|vom selben autor|remerciements|à propos de l['’]auteur|du même auteur|agradecimientos|sobre el autor|sobre la autora|ringraziamenti|dankwoord|over de auteur|podziękowania|o autorze|благодарности|об авторе|致谢|致謝|作者简介|作者簡介|关于作者|關於作者|謝辞|あとがき)$/iu;

/** §3 Step D: a recognised back-matter heading ("Acknowledgements", "About the author", "Danksagung", …). */
export const isBackMatterTitle = (text: string): boolean => BACK_MATTER_RE.test(text.trim().replace(/[.:]$/u, ''));

const TOC_TITLE_RE =
  /^(?:table of contents|contents|inhalt|inhaltsverzeichnis|table des matières|sommaire|índice|indice|sommario|inhoud|spis treści|содержание|оглавление|目录|目錄|目次|차례|목차)$/iu;
export const isTocTitle = (text: string): boolean => TOC_TITLE_RE.test(text.trim());

const LEADER = new Set([...' \t.·…_-–—']);
const isTocNumber = (ch: string): boolean => (ch >= '0' && ch <= '9') || 'ivxlcdm'.includes(ch);

/**
 * A TOC line compared with the heading it lists: lower case, and a trailing page number removed when a tab, a dot leader (two or
 * more leader characters) or a single space comes before it. A character loop, not a regex, so a long line cannot backtrack.
 */
export function tocKey(text: string): string {
  const t = text.toLowerCase().trimEnd();
  let end = t.length;
  let j = end;
  while (j > 0 && isTocNumber(t[j - 1] as string)) j--;
  if (j < end && j > 0) {
    let k = j;
    let tab = false;
    while (k > 0 && LEADER.has(t[k - 1] as string)) {
      if (t[k - 1] === '\t') tab = true;
      k--;
    }
    const leaders = j - k;
    const digits = /^[0-9]+$/u.test(t.slice(j, end));
    if (k > 0 && (tab || leaders >= 2 || (leaders === 1 && t[k] === ' ' && digits))) end = k;
  }
  return t.slice(0, end).split(/\s+/u).filter(Boolean).join(' ');
}

/** §3 Step E, "first words": the scene's first sentence, at most 40 characters, cut at a word. */
export function firstWords(text: string, max = 40): string {
  const t = text.split(/\s+/u).filter(Boolean).join(' ');
  if (!t) return '';
  let sentence = t;
  for (let i = 1; i < t.length; i++) {
    if ('.?!…。！？'.includes(t[i] as string) && (i + 1 === t.length || t[i + 1] === ' ')) {
      sentence = t.slice(0, i + 1);
      break;
    }
  }
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  const space = cut.lastIndexOf(' ');
  let out = space > 10 ? cut.slice(0, space) : cut;
  while (out && ' ,;:–—-'.includes(out[out.length - 1] as string)) out = out.slice(0, -1);
  return out + '…';
}
