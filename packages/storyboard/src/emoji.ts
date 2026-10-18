/**
 * Emoji in contact-sheet text — [storyboard.md](../../../docs/architecture/storyboard.md) §6.
 *
 * A reader sees an emoji as one character, though it can be many code points: a ZWJ sequence (👨‍👩‍👧, 🧑‍💻), a skin-tone
 * modifier (👍🏽), a flag of two regional indicators (🇩🇪), a keycap (1️⃣), a tag sequence (🏴󠁧󠁢󠁳󠁣󠁴󠁿), or a character with
 * a variation selector (❤️). The page plan and the PDF emitter both work on grapheme clusters (`Intl.Segmenter`), so such a
 * sequence is measured, wrapped, cut and drawn as one unit and never split across a line or a font.
 *
 * {@link emojiStyleOf} says how a cluster wants to be shown, as Unicode's emoji presentation rules put it (UTS #51):
 *
 * - `'emoji'`: an emoji in emoji presentation. A fully-qualified emoji (`\p{RGI_Emoji}`), a character whose default
 *   presentation is emoji (🎬), and any cluster with VS16, a keycap, a flag letter, a skin tone, a tag or a joined pictograph.
 *   The PDF sets it in the emoji font.
 * - `'text'`: a pictograph whose default presentation is text (☺ ✌ ♥), or an emoji with VS15: a pictograph, a keycap or a
 *   flag letter followed by VS15. The PDF tries its text fonts first, and the emoji font last.
 * - `null`: not an emoji at all. VS15 after anything else (a letter, a digit, a Chinese character) asks for nothing and
 *   leaves the cluster no emoji.
 */

/** The grapheme clusters of a text: a letter with its combining marks, an emoji sequence, as a reader sees one character. */
export function graphemesOf(text: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** `\p{RGI_Emoji}` needs the `v` flag (ES2024). Built from a string, so a runtime without it reads the other rules only. */
const RGI_EMOJI: RegExp | null = (() => {
  try {
    return new RegExp('^\\p{RGI_Emoji}$', 'v');
  } catch {
    return null;
  }
})();
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}/u;

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
  if (codes.includes(VS15)) return PICTOGRAPHIC.test(cluster) || codes.includes(KEYCAP) || codes.some(isRegionalIndicator) ? 'text' : null;
  if (RGI_EMOJI?.test(cluster) === true) return 'emoji';
  if (codes.some((code) => code === VS16 || code === KEYCAP || isRegionalIndicator(code) || isSkinTone(code) || isTag(code))) return 'emoji';
  if (codes.includes(ZWJ) && PICTOGRAPHIC.test(cluster)) return 'emoji';
  if (EMOJI_PRESENTATION.test(cluster)) return 'emoji';
  // Latin-1's © and ® are pictographs too, but every font draws them; they stay text that is no emoji.
  if (PICTOGRAPHIC.test(cluster) && (codes[0] ?? 0) > 0xff) return 'text';
  return null;
}

/** Whether a cluster is drawn as an emoji picture, one emoji wide: an emoji, or a pictograph outside Latin-1. */
export function isEmojiCluster(cluster: string): boolean {
  return emojiStyleOf(cluster) !== null;
}
