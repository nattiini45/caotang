/**
 * The parts of upstream `fontkit` 2.0.4 that the Brahmic shaper (indic-shaper.ts) reads. The package ships no types. It is a
 * different package from `@pdf-lib/fontkit` 1.1.1, which cuts the subsets.
 */
declare module 'fontkit' {
  export interface GlyphPosition {
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
  }

  export interface Glyph {
    readonly id: number;
  }

  export interface GlyphRun {
    readonly glyphs: readonly Glyph[];
    readonly positions: readonly GlyphPosition[];
  }

  export interface Font {
    readonly unitsPerEm: number;
    /** The cache of glyphs by id; see indic-shaper.ts for why a run starts with it empty. */
    _glyphs: Record<number, unknown>;
    layout(text: string, features: undefined, script: string, language: string | undefined, direction: 'ltr' | 'rtl'): GlyphRun;
  }

  export function create(bytes: Uint8Array): Font;
}
