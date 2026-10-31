/**
 * Emoji in both PDFs ([storyboard.md](../../../docs/architecture/storyboard.md) §6,
 * [screenplay.md §5.3](../../../docs/architecture/screenplay.md)): which grapheme clusters are emoji, how each wants to be
 * shown, and what the emoji fallback font (Noto Emoji) prints for it. Pure, and known before a font loads.
 *
 * A reader sees an emoji as one character, though it can be many code points: a ZWJ sequence (👨‍👩‍👧, 🧑‍💻), a skin-tone
 * modifier (👍🏽), a flag of two regional indicators (🇩🇪), a keycap (1️⃣), a tag sequence (🏴󠁧󠁢󠁳󠁣󠁴󠁿), or a character with a
 * variation selector (❤️). Both PDFs use pinned Unicode 17 grapheme data (UAX #29), so such a sequence is measured,
 * wrapped, cut and drawn as one unit and never split across a line or a font.
 *
 * {@link emojiStyleOf} says how a cluster wants to be shown, as Unicode's emoji presentation rules put it (UTS #51):
 *
 * - `'emoji'`: an emoji in emoji presentation. A fully-qualified emoji (`\p{RGI_Emoji}`), a character whose default
 *   presentation is emoji (🎬), and any cluster with VS16, a keycap, a flag letter, a skin tone, a tag or a joined pictograph.
 *   Both PDFs set it in the emoji font.
 * - `'text'`: a pictograph whose default presentation is text (☺ ✌ ♥), or an emoji with VS15: a pictograph, a keycap or a
 *   flag letter followed by VS15. The PDFs try their text fonts first, and the emoji font last.
 * - `null`: not an emoji at all. VS15 after anything else (a letter, a digit, a Chinese character) asks for nothing and
 *   leaves the cluster no emoji.
 *
 * Noto Emoji is monochrome and has no skin tones. A toned sequence prints as its untoned glyph, and the text a reader copies
 * keeps the tone. {@link emojiPrint} says what the font prints for a cluster, from the coverage tables.
 */

import { isEmojiPresentation, isExtendedPictographic } from 'unicode-segmenter/emoji';
import { collectGraphemes } from 'unicode-segmenter/grapheme';
import { emojiFontHasSequence, emojiFontHasTonedSequence, emojiFontLayoutGlyph, emojiFontMaps } from './coverage.js';

/** The grapheme clusters of a text: a letter with its combining marks, an emoji sequence, as a reader sees one character. */
export function graphemesOf(text: string): string[] {
  return collectGraphemes(text);
}

/** Whether text contains a code point with the pinned Unicode Extended_Pictographic property. */
export function hasExtendedPictographic(text: string): boolean {
  for (const character of text) {
    if (isExtendedPictographic(character.codePointAt(0) ?? 0)) return true;
  }
  return false;
}


const ZWJ = 0x200d;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const KEYCAP = 0x20e3;

const isRegionalIndicator = (code: number): boolean => code >= 0x1f1e6 && code <= 0x1f1ff;
const isSkinTone = (code: number): boolean => code >= 0x1f3fb && code <= 0x1f3ff;
const isTag = (code: number): boolean => code >= 0xe0020 && code <= 0xe007f;

export type EmojiStyle = 'emoji' | 'text';

/** How a grapheme cluster wants to be shown: as an emoji, as a text pictograph, or `null` for no emoji. See the header. */
export function emojiStyleOf(cluster: string): EmojiStyle | null {
  const codes = Array.from(cluster, (char) => char.codePointAt(0) ?? 0);
  const pictographic = codes.some(isExtendedPictographic);
  if (codes.includes(VS15)) return pictographic || codes.includes(KEYCAP) || codes.some(isRegionalIndicator) ? 'text' : null;
  if (codes.some((code) => code === VS16 || code === KEYCAP || isRegionalIndicator(code) || isSkinTone(code) || isTag(code))) return 'emoji';
  if (codes.includes(ZWJ) && pictographic) return 'emoji';
  if (isEmojiPresentation(codes[0] ?? 0)) return 'emoji';
  // Latin-1's © and ® are pictographs too, but every font draws them; they stay text that is no emoji.
  if (pictographic && (codes[0] ?? 0) > 0xff) return 'text';
  return null;
}

/** Whether a cluster is an emoji in emoji presentation, so it prints as one glyph in Noto Emoji, whatever the text fonts have. */
export function isEmojiCluster(cluster: string): boolean {
  return emojiStyleOf(cluster) === 'emoji';
}

/** Whether a cluster is drawn as an emoji picture, one emoji wide: an emoji, or a pictograph outside Latin-1. */
export function isEmojiPicture(cluster: string): boolean {
  return emojiStyleOf(cluster) !== null;
}

const MODIFIER_AFTER_START = /(?<=.)[\u{1F3FB}-\u{1F3FF}]/gu;
const HAS_MODIFIER = /[\u{1F3FB}-\u{1F3FF}]/u;

/**
 * The form of an emoji the coverage table is keyed by: the variation selectors, and the skin-tone modifiers after the
 * first code point, taken out. A lone modifier is its own key.
 */
export function emojiKey(cluster: string): string {
  return cluster.replace(/[︎️]/g, '').replace(MODIFIER_AFTER_START, '') || cluster;
}

/** The cluster's first code point. */
export function firstCodePoint(cluster: string): string {
  return String.fromCodePoint(cluster.codePointAt(0) ?? 0x3f);
}

/**
 * The glyph HarfBuzz lays an emoji cluster out as, for a cluster the font draws as one glyph that fontkit does not reach
 * (🚶‍♀️‍➡️, the woman walking facing right: fontkit gives its parts), or undefined. Both PDFs draw this glyph first.
 */
export function emojiLayoutGlyph(cluster: string): number | undefined {
  return emojiFontLayoutGlyph(emojiKey(cluster));
}

/**
 * What Noto Emoji prints for an emoji cluster: `whole`, one glyph for the sequence; `base`, the glyph of its first code
 * point, for a sequence newer than the font (it would print as its first emoji); `none`, nothing, so it prints as "?".
 */
export function emojiPrint(cluster: string): 'whole' | 'base' | 'none' {
  const key = emojiKey(cluster);
  if (emojiFontLayoutGlyph(key) !== undefined) return 'whole';
  if ([...key].length === 1 ? emojiFontMaps(key) : emojiFontHasSequence(key)) return 'whole';
  if (HAS_MODIFIER.test([...cluster].slice(1).join('')) && emojiFontHasTonedSequence(key)) return 'whole';
  return emojiFontMaps(firstCodePoint(cluster)) ? 'base' : 'none';
}
