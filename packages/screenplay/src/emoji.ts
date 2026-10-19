/**
 * Emoji in the screenplay PDF ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)): which grapheme clusters are
 * emoji, and what the emoji fallback font (Noto Emoji, emoji-font.ts) prints for each. Pure, and known before the font loads.
 *
 * An emoji is one grapheme cluster (UAX #29, `Intl.Segmenter`): a ZWJ sequence such as 👨‍👩‍👧, a skin-tone sequence such
 * as 👍🏽, a flag (two regional indicators, or a tag sequence such as 🏴󠁧󠁢󠁳󠁣󠁴󠁿), a keycap such as 1️⃣, or one pictograph with or
 * without its variation selector. The cluster is never split: it prints as one glyph, in one font, on one line, in two
 * columns of the Courier grid.
 *
 * A cluster is an emoji when it starts with an emoji-presentation character (😀, 🇩🇪, ✅), is a keycap, or holds a
 * pictograph together with U+FE0F, a ZWJ, a skin-tone modifier or a tag. A text-style pictograph on its own (❤, ☺, ©) and
 * anything with U+FE0E is text: it prints in Courier Prime or the CJK font when they have it, and in Noto Emoji only when
 * neither does.
 *
 * Noto Emoji is monochrome and has no skin tones. A toned sequence prints as its untoned glyph, and the text a reader
 * copies keeps the tone.
 */

import { emojiFontHasSequence, emojiFontHasTonedSequence, emojiFontMaps } from './coverage.js';

const KEYCAP = /^[0-9#*]\uFE0F?\u20E3$/u;
const EMOJI_START = /^\p{Emoji_Presentation}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const EMOJI_MARK = /\uFE0F|\u200D|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}]/u;
const MODIFIER_AFTER_START = /(?<=.)[\u{1F3FB}-\u{1F3FF}]/gu;
const HAS_MODIFIER = /[\u{1F3FB}-\u{1F3FF}]/u;

/** Whether one grapheme cluster is an emoji, so it prints as one glyph in Noto Emoji. */
export function isEmojiCluster(cluster: string): boolean {
  if (cluster.includes('\uFE0E')) return false;
  if (EMOJI_START.test(cluster) || KEYCAP.test(cluster)) return true;
  return PICTOGRAPH.test(cluster) && EMOJI_MARK.test(cluster);
}

/**
 * The form of an emoji the coverage table is keyed by: the variation selectors, and the skin-tone modifiers after the
 * first code point, taken out. A lone modifier is its own key.
 */
export function emojiKey(cluster: string): string {
  return cluster.replace(/[\uFE0E\uFE0F]/g, '').replace(MODIFIER_AFTER_START, '') || cluster;
}

/** The cluster's first code point. */
export function firstCodePoint(cluster: string): string {
  return String.fromCodePoint(cluster.codePointAt(0) ?? 0x3f);
}

/**
 * What Noto Emoji prints for an emoji cluster: `whole`, one glyph for the sequence; `base`, the glyph of its first code
 * point, for a sequence the font has no glyph for (🚶‍➡️ prints as 🚶); `none`, nothing, so it prints as "?".
 */
export function emojiPrint(cluster: string): 'whole' | 'base' | 'none' {
  const key = emojiKey(cluster);
  if ([...key].length === 1 ? emojiFontMaps(key) : emojiFontHasSequence(key)) return 'whole';
  if (HAS_MODIFIER.test([...cluster].slice(1).join('')) && emojiFontHasTonedSequence(key)) return 'whole';
  return emojiFontMaps(firstCodePoint(cluster)) ? 'base' : 'none';
}
