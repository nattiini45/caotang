/**
 * Which regional forms of a Han character a language is written in. The CJK font ([screenplay.md §5.3](../../../docs/architecture/screenplay.md))
 * holds the Simplified Chinese forms as its cmap, and the Japanese, Korean, Traditional Chinese and Hong Kong forms behind its
 * `locl` feature. A project's language picks one by the OpenType language system tag fontkit's `layout` takes.
 */

/** An OpenType language system tag: four characters, a short name padded with spaces. */
export type HanLanguageTag = 'JAN ' | 'KOR ' | 'ZHT ' | 'ZHH ';

/**
 * The language tag whose forms a project's language is written in, or undefined for the font's own forms (Simplified Chinese):
 * `ja` is `JAN `, `ko` is `KOR `, Traditional Chinese (`zh-Hant`, `zh-TW`, `zh-MO`) is `ZHT `, Hong Kong (`zh-HK`, `zh-Hant-HK`) is
 * `ZHH `. `zh`, `zh-Hans`, `zh-CN`, `zh-SG`, no language, a malformed tag and any other language are undefined.
 */
export function hanLocaleTag(language: string | undefined): HanLanguageTag | undefined {
  const tag = (language ?? '').trim().replaceAll('_', '-');
  if (tag === '') return undefined;
  let locale: Intl.Locale;
  try {
    locale = new Intl.Locale(tag).maximize();
  } catch {
    return undefined;
  }
  if (locale.language === 'ja') return 'JAN ';
  if (locale.language === 'ko') return 'KOR ';
  if (locale.language !== 'zh' || locale.script !== 'Hant') return undefined;
  return locale.region === 'HK' ? 'ZHH ' : 'ZHT ';
}

/** `font.layout` takes the script, language and direction too (fontkit 1.1.1, Font#layout), which its typings leave out. */
interface ScriptedLayout<G> {
  layout(text: string, features: undefined, script: string, language: string, direction: 'ltr'): { readonly glyphs: readonly G[] };
}

/**
 * The glyph a font draws a character with in the forms of a language. `locl` is one to one for Han characters and for
 * fullwidth punctuation, so the layout of the character alone gives its regional glyph; a character `locl` leaves alone, or a
 * layout that gives other than one glyph, takes the font's cmap glyph, which is also the glyph with no language.
 */
export function hanGlyph<G extends { readonly id: number }>(font: { glyphForCodePoint(code: number): G }, char: string, tag: HanLanguageTag | undefined): G {
  const plain = font.glyphForCodePoint(char.codePointAt(0) ?? 0);
  if (tag === undefined) return plain;
  const { glyphs } = (font as unknown as ScriptedLayout<G>).layout(char, undefined, 'hani', tag, 'ltr');
  return glyphs.length === 1 ? (glyphs[0] ?? plain) : plain;
}
