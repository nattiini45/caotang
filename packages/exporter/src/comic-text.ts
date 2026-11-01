/**
 * The text of the comic PDF ([comics.md](../../../docs/architecture/comics.md) §4 and §5): lettering set in Comic Neue and Bangers,
 * with the fallback chain every PDF of this package shares for what those two faces do not draw.
 *
 * Unlike the contact sheet, whose Latin text is the PDF's built-in Helvetica, the first face here is a font Caotang ships, embedded as a
 * subset like the fallback fonts are (cid-embedding.ts): a CID for each distinct glyph-and-text pair, so every glyph copies as the
 * letter it draws. Comic Neue kerns its capitals; the pair kerning is applied with a text-showing array (`drawKerned`).
 *
 * The chain, for each grapheme cluster: the balloon's own face; Bangers (or Comic Neue, for a sound effect) for what that face lacks
 * and the other has, which is the capital ẞ a book that opts into it asks for, since Comic Neue has none; Arabic and Hebrew
 * (`@caotang/pdf-fonts/shaper`, with the bidirectional algorithm), Devanagari, Noto Sans Mono CJK (which also has Greek and Cyrillic), and
 * the emoji font; a character no font has is drawn as `?`, once counted, and the compile log names it.
 *
 * The fonts are read before any line is laid out: the layout that breaks a balloon's lines measures text synchronously
 * (`layoutLettering` takes a `measure`), so {@link ComicTextKit.create} reads the whole book's text, decides which fonts it needs, and
 * loads them. After that every call here is synchronous.
 */

import {
  ARABIC_FONT_NAME,
  BANGERS_FONT_NAME,
  CJK_FONT_NAME,
  COMIC_NEUE_FONT_NAME,
  DEVANAGARI_FONT_NAME,
  EMOJI_FONT_NAME,
  HEBREW_FONT_NAME,
  clustersOf,
  countMarks,
  devanagariFontPrints,
  emojiStyleOf,
  fallbackCovers,
  isBidiControl,
  isRtlMark,
  loadFont,
  rtlFontPrints,
  rtlScriptOf,
  scriptRuns,
  type ComicLetteringFace,
  type ComicLetteringFontLoader,
  type FontLoader,
  type RtlScript,
} from '@caotang/pdf-fonts';
import type * as Bidi from '@caotang/pdf-fonts/bidi';
import type { Shape } from '@caotang/pdf-fonts/shaper';
import type * as PdfLib from 'pdf-lib';

import { CidEmbedding, type CidGlyph, type FontkitFont } from './cid-embedding.js';
import { CjkEmbedding, CjkFace } from './cjk-font.js';
import { DevanagariEmbedding, DevanagariFace } from './devanagari-font.js';
import { EmojiEmbedding, EmojiFace } from './emoji-font.js';
import { RtlEmbedding, RtlFace, type PlacedGlyph } from './rtl-font.js';

export interface ComicTextLoaders {
  /** Reads Comic Neue and Bangers by face. Required: the lettering has no other first face. */
  readonly loadComicFont: ComicLetteringFontLoader;
  readonly loadFallbackFont?: FontLoader;
  readonly loadEmojiFont?: FontLoader;
  readonly loadArabicFont?: FontLoader;
  readonly loadHebrewFont?: FontLoader;
  readonly loadDevanagariFont?: FontLoader;
  /** The project's language (a BCP 47 tag): Han characters and Devanagari take its forms. */
  readonly language?: string;
}

export interface Ink {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** A piece of text to be set: the text as it is shown, in the face its balloon's kind and emphasis choose. */
export interface TextRun {
  readonly text: string;
  readonly style: ComicLetteringFace;
}

type Face = 'main' | 'cjk' | 'emoji' | 'devanagari' | RtlScript;

interface Piece {
  readonly text: string;
  readonly face: Face;
  /** Which of the five lettering faces a `main` piece is set in. */
  readonly style: ComicLetteringFace;
  readonly glyphs?: readonly CidGlyph[];
  readonly placed?: readonly PlacedGlyph[];
  readonly width?: number;
}

/** A line ready to draw: its pieces in visual order and its width in points. */
export interface PreparedLine {
  readonly pieces: readonly Piece[];
  readonly width: number;
}

type Class =
  | { readonly kind: 'control' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'emoji' }
  | { readonly kind: 'main'; readonly style: ComicLetteringFace }
  | { readonly kind: 'script'; readonly script: RtlScript }
  | { readonly kind: 'devanagari' }
  | { readonly kind: 'other'; readonly codes: readonly number[]; readonly presentation: 'text' | 'emoji' | undefined };

const VS15 = 0xfe0e;

const isControl = (code: number): boolean => code < 0x20 || (code >= 0x7f && code < 0xa0);

/** Variation selectors and the zero-width joiner: dropped from a cluster when the fallback font has no glyph for them. */
const isJoinerOrSelector = (code: number): boolean =>
  code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef);

interface KernedGlyph extends CidGlyph {
  readonly kern: number;
}

interface LayoutOut {
  readonly glyphs: readonly { readonly id: number; readonly advanceWidth: number }[];
  readonly positions: readonly { readonly xAdvance: number }[];
}

/** One lettering face: the parsed font, its embedding in this PDF, and its glyph runs with the font's pair kerning. */
class LetteringFace {
  readonly embedding: CidEmbedding;
  private readonly runs = new Map<string, { readonly glyphs: readonly KernedGlyph[]; readonly advance: number }>();

  constructor(lib: typeof PdfLib, doc: PdfLib.PDFDocument, readonly style: ComicLetteringFace, readonly font: FontkitFont) {
    const sfx = style === 'sfx';
    this.embedding = new CidEmbedding(lib, doc, font, {
      resource: sfx ? 'Bangers' : `ComicNeue${style.replace('-', '')}`,
      tag: sfx ? 'CAOTBA' : `CAOTC${{ regular: 'R', italic: 'I', bold: 'B', 'bold-italic': 'X' }[style as Exclude<ComicLetteringFace, 'sfx'>]}`,
      postscriptName: font.postscriptName ?? (sfx ? 'Bangers-Regular' : `ComicNeue-${style}`),
    });
  }

  covers(code: number): boolean {
    return this.font.hasGlyphForCodePoint(code);
  }

  /** The glyphs of a text, each carrying its own character and the kern that takes it toward the next, and the run's advance in font units. */
  run(text: string): { readonly glyphs: readonly KernedGlyph[]; readonly advance: number } {
    const known = this.runs.get(text);
    if (known !== undefined) return known;
    const chars = [...text];
    const laid = this.font.layout(text) as unknown as LayoutOut;
    let glyphs: KernedGlyph[];
    if (laid.glyphs.length === chars.length) {
      glyphs = laid.glyphs.map((glyph, index) => ({
        id: glyph.id,
        advance: glyph.advanceWidth,
        text: chars[index] ?? '',
        kern: glyph.advanceWidth - (laid.positions[index]?.xAdvance ?? glyph.advanceWidth),
      }));
    } else {
      // A layout that changed the glyph count (a ligature) cannot be matched to the characters one for one: set them unkerned.
      glyphs = chars.map((char) => {
        const glyph = this.font.glyphForCodePoint(char.codePointAt(0) ?? 0);
        return { id: glyph.id, advance: glyph.advanceWidth, text: char, kern: 0 };
      });
    }
    // The last glyph has no next glyph to kern toward.
    if (glyphs.length > 0) glyphs[glyphs.length - 1] = { ...(glyphs[glyphs.length - 1] as KernedGlyph), kern: 0 };
    const made = { glyphs, advance: glyphs.reduce((sum, glyph) => sum + glyph.advance - glyph.kern, 0) };
    this.runs.set(text, made);
    return made;
  }
}

const CHAIN_FONT = (face: Face): string =>
  face === 'cjk' ? CJK_FONT_NAME : face === 'emoji' ? EMOJI_FONT_NAME : face === 'devanagari' ? DEVANAGARI_FONT_NAME : face === 'arabic' ? ARABIC_FONT_NAME : HEBREW_FONT_NAME;

export class ComicTextKit {
  private readonly lettering = new Map<ComicLetteringFace, LetteringFace>();
  private cjk: CjkEmbedding | null = null;
  private emoji: EmojiEmbedding | null = null;
  private devanagari: DevanagariEmbedding | null = null;
  private readonly rtl = new Map<RtlScript, RtlEmbedding>();
  private tools: { readonly bidi: typeof Bidi; readonly shape: Shape } | undefined;
  /** Why a font a text needed could not be read, by face. */
  private readonly unavailable = new Map<Face, string>();
  /** The fonts a ? would have been drawn from had they been readable: the compile log says why each could not be. */
  private readonly neededUnavailable = new Set<Face>();
  private readonly missing = new Map<string, number>();
  private readonly marksLeftOut: Record<RtlScript, number> = { arabic: 0, hebrew: 0 };
  /** Characters drawn from the face a balloon's own face lacks, by the face that drew them. */
  private readonly borrowed = new Map<string, ComicLetteringFace>();
  private readonly widths = new Map<string, number>();

  private constructor(
    private readonly lib: typeof PdfLib,
    private readonly doc: PdfLib.PDFDocument,
  ) {}

  /**
   * Reads every font the texts need. `texts` pairs each text as it will be shown with the face it starts in; `faces` is every
   * lettering face the book uses, with and without emphasis, so each is read once.
   */
  static async create(
    lib: typeof PdfLib,
    doc: PdfLib.PDFDocument,
    loaders: ComicTextLoaders,
    texts: readonly TextRun[],
    faces: ReadonlySet<ComicLetteringFace>,
  ): Promise<ComicTextKit> {
    const kit = new ComicTextKit(lib, doc);
    const wanted = new Set<ComicLetteringFace>(faces);
    if (texts.length > 0) {
      wanted.add('regular');
      wanted.add('sfx');
    }
    for (const face of wanted) {
      const font = (await loadFont(() => loaders.loadComicFont(face), `the comic lettering face ${face}`)) as unknown as FontkitFont;
      kit.lettering.set(face, new LetteringFace(lib, doc, face, font));
    }
    await kit.loadFallbacks(loaders, texts);
    return kit;
  }

  private face(style: ComicLetteringFace): LetteringFace {
    const face = this.lettering.get(style);
    if (face === undefined) throw new Error(`the comic lettering face ${style} was not read`);
    return face;
  }

  private classify(cluster: string, style: ComicLetteringFace): Class {
    const codes = [...cluster].map((char) => char.codePointAt(0) ?? 0);
    if (codes.length === 1 && isControl(codes[0] ?? 0)) return { kind: 'control' };
    if (isBidiControl(cluster)) return { kind: 'skip' };
    const presentation = emojiStyleOf(cluster);
    if (presentation === 'emoji') return { kind: 'emoji' };
    const textCodes = codes.filter((code) => code !== VS15);
    const primary = this.lettering.get(style);
    if (primary !== undefined && textCodes.length > 0 && textCodes.every((code) => primary.covers(code))) return { kind: 'main', style };
    const other: ComicLetteringFace = style === 'sfx' ? 'regular' : 'sfx';
    const second = this.lettering.get(other);
    if (second !== undefined && textCodes.length > 0 && textCodes.every((code) => second.covers(code))) return { kind: 'main', style: other };
    const first = String.fromCodePoint(codes[0] ?? 0);
    const script = rtlFontPrints(first);
    if (script !== undefined) return { kind: 'script', script };
    if (devanagariFontPrints(first)) return { kind: 'devanagari' };
    return { kind: 'other', codes: textCodes, presentation: presentation === 'text' ? 'text' : undefined };
  }

  private async loadFallbacks(loaders: ComicTextLoaders, texts: readonly TextRun[]): Promise<void> {
    const cjkChars = new Set<string>();
    const emojiClusters = new Set<string>();
    const scripts = new Set<RtlScript>();
    let devanagari = false;
    for (const { text, style } of texts) {
      for (const cluster of clustersOf(text.normalize('NFC'))) {
        const kind = this.classify(cluster, style);
        if (kind.kind === 'emoji') emojiClusters.add(cluster);
        else if (kind.kind === 'script') scripts.add(kind.script);
        else if (kind.kind === 'devanagari') devanagari = true;
        else if (kind.kind === 'other') {
          for (const code of kind.codes) cjkChars.add(String.fromCodePoint(code));
          if (kind.presentation === 'text' && !kind.codes.every((code) => fallbackCovers(String.fromCodePoint(code)))) {
            emojiClusters.add(String.fromCodePoint(...kind.codes));
          }
        }
      }
    }
    const attempt = async (face: Face, load: FontLoader | undefined, what: string, make: (load: FontLoader) => Promise<void>): Promise<void> => {
      if (load === undefined) {
        this.unavailable.set(face, `this compile has no ${what} font`);
        return;
      }
      try {
        await make(load);
      } catch (error) {
        this.unavailable.set(face, `the ${what} font could not be read (${error instanceof Error ? error.message : String(error)})`);
      }
    };
    const { lib, doc } = this;
    if (cjkChars.size > 0) {
      await attempt('cjk', loaders.loadFallbackFont, 'fallback', async (load) => {
        const { cjkLoaderFor } = await import('@caotang/pdf-fonts/common');
        const font = (await loadFont(cjkLoaderFor(load, cjkChars), 'the fallback font')) as unknown as FontkitFont;
        this.cjk = new CjkEmbedding(lib, doc, new CjkFace(font, loaders.language));
      });
    }
    if (emojiClusters.size > 0) {
      await attempt('emoji', loaders.loadEmojiFont, 'emoji', async (load) => {
        const { emojiLoaderFor } = await import('@caotang/pdf-fonts/common');
        const font = (await loadFont(emojiLoaderFor(load, emojiClusters), 'the emoji font')) as unknown as FontkitFont;
        this.emoji = new EmojiEmbedding(lib, doc, new EmojiFace(font));
      });
    }
    for (const script of scripts) {
      const name = script === 'arabic' ? 'Arabic' : 'Hebrew';
      await attempt(script, script === 'arabic' ? loaders.loadArabicFont : loaders.loadHebrewFont, name, async (load) => {
        if (this.tools === undefined) {
          const shaper = await import('@caotang/pdf-fonts/shaper');
          this.tools = { bidi: await import('@caotang/pdf-fonts/bidi'), shape: shaper.shapeKeepingMarks(shaper.fontkitShape) };
        }
        const font = (await loadFont(load, `the ${name} font`)) as unknown as FontkitFont;
        this.rtl.set(script, new RtlEmbedding(lib, doc, new RtlFace(script, font, (this.tools as { shape: Shape }).shape)));
      });
    }
    if (devanagari) {
      await attempt('devanagari', loaders.loadDevanagariFont, 'Devanagari', async (load) => {
        this.devanagari = new DevanagariEmbedding(lib, doc, await DevanagariFace.load(load, loaders.language));
      });
    }
  }

  private missingPiece(cluster: string, style: ComicLetteringFace, face?: Face): Piece {
    this.missing.set(cluster, (this.missing.get(cluster) ?? 0) + 1);
    if (face !== undefined) this.neededUnavailable.add(face);
    return { text: '?', face: 'main', style };
  }

  /** The text as pieces, one per grapheme cluster, each resolved to the font that draws it. */
  private piecesOf(text: string, style: ComicLetteringFace): Piece[] {
    const pieces: Piece[] = [];
    for (const cluster of clustersOf(text.normalize('NFC'))) {
      const kind = this.classify(cluster, style);
      switch (kind.kind) {
        case 'control':
          pieces.push({ text: ' ', face: 'main', style });
          break;
        case 'skip':
          break;
        case 'emoji': {
          const glyphs = this.emoji?.face.glyphsOf(cluster) ?? null;
          pieces.push(glyphs === null ? this.missingPiece(cluster, style, this.emoji === null ? 'emoji' : undefined) : { text: cluster, face: 'emoji', style, glyphs });
          break;
        }
        case 'main': {
          const kept = [...cluster].filter((char) => char.codePointAt(0) !== VS15).join('');
          if (kind.style !== style) this.borrowed.set(kept, kind.style);
          pieces.push({ text: kept, face: 'main', style: kind.style });
          break;
        }
        case 'script':
          pieces.push(this.rtl.has(kind.script) ? { text: cluster, face: kind.script, style } : this.missingPiece(cluster, style, kind.script));
          break;
        case 'devanagari':
          pieces.push(this.devanagari !== null ? { text: cluster, face: 'devanagari', style } : this.missingPiece(cluster, style, 'devanagari'));
          break;
        case 'other': {
          const cjk = this.cjk;
          if (cjk !== null) {
            const kept = kind.codes.filter((code) => cjk.face.covers(code) || !isJoinerOrSelector(code));
            const glyphs = kept.length > 0 && kept.every((code) => cjk.face.covers(code)) ? cjk.face.glyphsOf(String.fromCodePoint(...kept)) : null;
            if (glyphs !== null) {
              pieces.push({ text: String.fromCodePoint(...kept), face: 'cjk', style, glyphs });
              break;
            }
          }
          if (kind.presentation === 'text') {
            const glyphs = this.emoji?.face.glyphsOf(String.fromCodePoint(...kind.codes)) ?? null;
            if (glyphs !== null) {
              pieces.push({ text: cluster, face: 'emoji', style, glyphs });
              break;
            }
          }
          pieces.push(this.missingPiece(cluster, style, this.cjk === null ? 'cjk' : undefined));
          break;
        }
      }
    }
    return pieces;
  }

  private runsOf(pieces: readonly Piece[]): Piece[][] {
    const runs: Piece[][] = [];
    for (const piece of pieces) {
      const last = runs[runs.length - 1];
      if (last !== undefined && last[0]?.face === piece.face && last[0].style === piece.style) last.push(piece);
      else runs.push([piece]);
    }
    return runs;
  }

  private rtlWidth(script: RtlScript, run: readonly Piece[], size: number): number {
    const embedding = this.rtl.get(script);
    if (embedding === undefined) return 0;
    let width = 0;
    let loose: string[] = [];
    const settle = (): void => {
      for (const part of scriptRuns(loose)) {
        const word = embedding.face.shapeRun(part.text, 'rtl');
        if (word !== null) width += embedding.face.widthOf(word, size);
      }
      loose = [];
    };
    for (const piece of run) {
      if (piece.width === undefined) loose.push(piece.text);
      else {
        settle();
        width += piece.width;
      }
    }
    settle();
    return width;
  }

  private runWidth(run: readonly Piece[], size: number): number {
    const first = run[0];
    if (first === undefined) return 0;
    const glyphs = run.flatMap((piece) => piece.glyphs ?? []);
    switch (first.face) {
      case 'main': {
        const face = this.face(first.style);
        return (face.run(run.map((piece) => piece.text).join('')).advance * size) / face.font.unitsPerEm;
      }
      case 'cjk':
        return this.cjk === null ? 0 : this.cjk.face.widthOf(glyphs, size);
      case 'emoji':
        return this.emoji === null ? 0 : this.emoji.face.widthOf(glyphs, size);
      case 'arabic':
      case 'hebrew':
        return this.rtlWidth(first.face, run, size);
      case 'devanagari': {
        if (this.devanagari === null) return 0;
        const word = this.devanagari.face.shapeRun(run.map((piece) => piece.text).join(''));
        return word === null ? this.runWidth([{ text: '?'.repeat(run.length), face: 'main', style: first.style }], size) : this.devanagari.face.widthOf(word, size);
      }
    }
  }

  private widthOfPieces(pieces: readonly Piece[], size: number): number {
    return this.runsOf(pieces).reduce((sum, run) => sum + this.runWidth(run, size), 0);
  }

  /** The width in points of a logical text at a size: what the line breaker measures. */
  measure(text: string, style: ComicLetteringFace, size: number): number {
    const key = `${style}\u0000${size}\u0000${text}`;
    const known = this.widths.get(key);
    if (known !== undefined) return known;
    const width = this.widthOfPieces(this.piecesOf(text, style), size);
    this.widths.set(key, width);
    return width;
  }

  /**
   * A line's pieces in the order they are drawn. A line holding Arabic or Hebrew is resolved by the bidirectional algorithm at its own
   * first strong character; every other line is returned as it is. In such a line the pieces of other scripts keep the face of
   * their first occurrence, so a word of emphasis beside Hebrew is set in the face of the same text elsewhere in the line.
   */
  prepare(runs: readonly TextRun[], size: number): PreparedLine {
    const logical = runs.flatMap((run) => this.piecesOf(run.text, run.style));
    const tools = this.tools;
    if (tools === undefined || !logical.some((piece) => piece.face === 'arabic' || piece.face === 'hebrew')) {
      return { pieces: logical, width: this.widthOfPieces(logical, size) };
    }
    const direction = tools.bidi.paragraphDirection(logical.map((piece) => piece.text).join(''));
    const known = new Map<string, Piece>();
    for (const piece of logical) if (!known.has(piece.text)) known.set(piece.text, piece);
    const unknown: Piece = { text: '?', face: 'main', style: runs[0]?.style ?? 'regular' };
    const out: Piece[] = [];
    for (const run of tools.bidi.visualRuns(logical.map((piece) => piece.text).join(''), direction)) {
      const embedding = run.script === undefined ? undefined : this.rtl.get(run.script);
      if (run.kind === 'other' || run.script === undefined || embedding === undefined) {
        for (const cluster of clustersOf(run.text)) {
          const kept = known.has(cluster) ? undefined : [...cluster].filter((char) => !isRtlMark(char));
          if (kept === undefined) out.push(known.get(cluster) as Piece);
          else if (kept.length > 0 && kept.every((char) => this.face(unknown.style).covers(char.codePointAt(0) ?? 0))) {
            for (const char of cluster) if (isRtlMark(char)) this.marksLeftOut[rtlScriptOf(char.codePointAt(0) ?? 0) ?? 'arabic'] += 1;
            out.push({ text: kept.join(''), face: 'main', style: unknown.style });
          } else out.push(this.missingPiece(cluster, unknown.style));
        }
        continue;
      }
      const word = embedding.face.shapeRun(run.source, run.level % 2 === 1 ? 'rtl' : 'ltr');
      if (word === null) {
        for (const cluster of clustersOf(run.source)) out.push(this.missingPiece(cluster, unknown.style));
        continue;
      }
      this.marksLeftOut[run.script] += countMarks(run.source);
      out.push({ text: run.source, face: run.script, style: unknown.style, placed: word.glyphs, width: embedding.face.widthOf(word, size) });
    }
    return { pieces: out, width: this.widthOfPieces(out, size) };
  }

  /** Draws a prepared line from the baseline start `(x, y)`, each run in its own font. */
  draw(page: PdfLib.PDFPage, line: PreparedLine, x: number, y: number, size: number, ink: Ink): void {
    let at = x;
    for (const run of this.runsOf(line.pieces)) {
      const first = run[0] as Piece;
      const glyphs = run.flatMap((piece) => piece.glyphs ?? []);
      if (first.face === 'main') {
        const face = this.face(first.style);
        face.embedding.drawKerned(page, face.run(run.map((piece) => piece.text).join('')).glyphs, at, y, size, ink);
      } else if (first.face === 'arabic' || first.face === 'hebrew') {
        const embedding = this.rtl.get(first.face);
        let pen = at;
        for (const piece of run) {
          if (embedding !== undefined && piece.placed !== undefined) embedding.drawPlaced(page, piece.placed, pen, y, size, ink);
          pen += piece.width ?? 0;
        }
      } else if (first.face === 'devanagari') {
        const typed = run.map((piece) => piece.text).join('');
        const word = this.devanagari?.face.shapeRun(typed) ?? null;
        if (this.devanagari !== null && word !== null) this.devanagari.drawPlaced(page, word.glyphs, at, y, size, ink, typed);
        else {
          for (const piece of run) this.missing.set(piece.text, (this.missing.get(piece.text) ?? 0) + 1);
          this.draw(page, { pieces: [{ text: '?'.repeat(run.length), face: 'main', style: first.style }], width: 0 }, at, y, size, ink);
        }
      } else if (first.face === 'emoji') this.emoji?.draw(page, glyphs, at, y, size, ink);
      else if (first.face === 'cjk') this.cjk?.draw(page, glyphs, at, y, size, ink);
      at += this.runWidth(run, size);
    }
  }

  /** A face's line height and ascent, as fractions of the size. */
  leadingOf(style: ComicLetteringFace): number {
    const { font } = this.face(style);
    return (font.ascent - font.descent) / font.unitsPerEm;
  }

  ascentOf(style: ComicLetteringFace): number {
    const { font } = this.face(style);
    return font.ascent / font.unitsPerEm;
  }

  /** Writes the faces that were drawn, so a book with no sound effect never embeds Bangers. */
  async finish(): Promise<string[]> {
    const notes: string[] = [];
    const used = [...this.lettering.values()].filter((face) => face.embedding.used);
    for (const face of used) await face.embedding.finish();
    const names = [
      ...(used.some((face) => face.style !== 'sfx') ? [COMIC_NEUE_FONT_NAME] : []),
      ...(used.some((face) => face.style === 'sfx') ? [BANGERS_FONT_NAME] : []),
    ];
    if (names.length > 0) notes.push(`comic PDF: lettering is set in ${names.join(' and ')}, embedded with only the glyphs it uses`);
    if (this.borrowed.size > 0) {
      const chars = [...this.borrowed.entries()].map(([char, style]) => `${char} from ${style === 'sfx' ? BANGERS_FONT_NAME : COMIC_NEUE_FONT_NAME}`);
      notes.push(`comic PDF: the balloon's own face has no glyph for ${chars.join(', ')}, so the other lettering face draws it`);
    }
    const chain: [Face, CidEmbedding | null | undefined][] = [
      ['arabic', this.rtl.get('arabic')],
      ['hebrew', this.rtl.get('hebrew')],
      ['devanagari', this.devanagari],
      ['cjk', this.cjk],
      ['emoji', this.emoji],
    ];
    for (const [face, embedding] of chain) {
      if (embedding?.used !== true) continue;
      await embedding.finish();
      notes.push(`comic PDF: ${face === 'cjk' ? 'text outside Latin script' : face === 'emoji' ? 'emoji' : `${face === 'arabic' ? 'Arabic, Persian and Urdu' : face === 'hebrew' ? 'Hebrew' : 'Devanagari'} text`} is set in ${CHAIN_FONT(face)}, embedded with only the glyphs it uses`);
    }
    for (const script of ['hebrew', 'arabic'] as const) {
      const n = this.marksLeftOut[script];
      if (n === 0) continue;
      const kind = script === 'hebrew' ? 'Hebrew' : 'Arabic';
      notes.push(`comic PDF: ${n} ${kind} ${n === 1 ? 'mark is' : 'marks are'} left out of the print, because the font's placement of marks cannot be checked; the text of the file still holds ${n === 1 ? 'it' : 'them'}`);
    }
    if (this.missing.size > 0) {
      const count = [...this.missing.values()].reduce((sum, n) => sum + n, 0);
      const named = [...this.missing.keys()]
        .map((cluster) => `${cluster} (${[...cluster].map((char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ')})`)
        .join(', ');
      const reasons = [...this.neededUnavailable].map((face) => this.unavailable.get(face)).filter((reason): reason is string => reason !== undefined);
      notes.push(`comic PDF: ${count} ${count === 1 ? 'character' : 'characters'} none of the fonts can show${reasons.length === 0 ? '' : `, and ${reasons.join(', and ')},`} ${count === 1 ? 'was' : 'were'} drawn as "?": ${named}`);
    }
    return notes;
  }
}
