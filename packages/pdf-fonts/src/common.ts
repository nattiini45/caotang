/**
 * Which characters the common fonts draw, and which loader a document reads. Both fallback fonts come as two files, the full
 * font and a common file cut from it to the characters of everyday use (`@caotang/font-noto-cjk` and `@caotang/font-noto-emoji`,
 * where the sets and the build are written down). A document whose characters are all in a common file reads only that;
 * any character outside it reads the full font, with no "?" and no note, so a PDF's content never depends on the common file.
 *
 * The tables are large, so they sit behind a subpath of their own, `@caotang/pdf-fonts/common`, which the hosts import
 * dynamically when a document holds text that needs a fallback font: the package's index never imports it.
 */

import { decodeRanges, fallbackCovers, inRanges, type Ranges } from './coverage.js';
import { NOTO_CJK_COMMON_RANGES, NOTO_EMOJI_COMMON_RANGES } from './coverage/noto-common-coverage.js';
import { loaderFor, type FontLoader } from './font-bytes.js';

const VS16 = /️/g;
const KEYCAP = '⃣';

let cjk: Ranges | undefined;
let emoji: Ranges | undefined;

/** Whether the common CJK font maps a character. It maps a subset of what the full font does ({@link fallbackCovers}). */
export function cjkCommonCovers(ch: string): boolean {
  cjk ??= decodeRanges(NOTO_CJK_COMMON_RANGES);
  return inRanges(ch.codePointAt(0) ?? 0, cjk);
}

/**
 * Whether the common emoji font draws an emoji cluster as the full font does: one code point of the common set, with its
 * variation selector (❤️), or a keycap (1️⃣). A ZWJ sequence, a skin tone, a flag or a tag sequence is not in it.
 */
export function emojiCommonCovers(cluster: string): boolean {
  emoji ??= decodeRanges(NOTO_EMOJI_COMMON_RANGES);
  const key = cluster.replace(VS16, '');
  const [first, second, ...rest] = [...key];
  if (first === undefined || rest.length > 0) return false;
  if (second === undefined) return inRanges(first.codePointAt(0) ?? 0, emoji);
  return second === KEYCAP && /^[#*0-9]$/.test(first);
}

/**
 * The loader for the CJK characters a document sets in the font: the common file's when every one is in it or the full font
 * has none of it either (it prints as "?" whichever file is read), otherwise the full font's.
 */
export function cjkLoaderFor(load: FontLoader, characters: Iterable<string>): FontLoader {
  return loaderFor(load, [...characters].every((ch) => cjkCommonCovers(ch) || !fallbackCovers(ch)));
}

/** The loader for the emoji clusters a document sets in the font: the common file's when every one is in it, otherwise the full font's. */
export function emojiLoaderFor(load: FontLoader, clusters: Iterable<string>): FontLoader {
  return loaderFor(load, [...clusters].every(emojiCommonCovers));
}
