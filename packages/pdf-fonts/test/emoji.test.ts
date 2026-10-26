/**
 * The one emoji classifier both PDFs use (emoji.ts), against the two it replaced: the contact sheet's `emojiStyleOf` (which
 * clusters are emoji, which are text pictographs, which are neither) and the screenplay's `isEmojiCluster` (which clusters
 * print as one glyph in Noto Emoji). The cases of both packages' old tests are here, and a reference copy of the screenplay's
 * old rule is compared with the new one over every line of Unicode's emoji list.
 */

import { readFileSync } from 'node:fs';
import { isEmojiPresentation, isExtendedPictographic } from 'unicode-segmenter/emoji';
import { describe, expect, it } from 'vitest';
import { emojiKey, emojiLayoutGlyph, emojiPrint, emojiStyleOf, firstCodePoint, graphemesOf, hasExtendedPictographic, isEmojiCluster, isEmojiPicture } from '../src/emoji.js';

const FAMILY = '👨‍👩‍👧‍👦';

describe('emoji clusters', () => {
  it('says which clusters are emoji, by Unicode presentation', () => {
    for (const emoji of ['🎬', FAMILY, '🧑🏽‍💻', '👍🏽', '🇩🇪', '1️⃣', '#️⃣', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '❤️', '🏳️‍🌈']) expect(emojiStyleOf(emoji), emoji).toBe('emoji');
    // Default text presentation, or VS15: a text font is tried first.
    for (const pictograph of ['☺', '✌', '❤', '☺︎', '🎬︎']) expect(emojiStyleOf(pictograph), pictograph).toBe('text');
    // Digits, Latin-1's © and ®, letters and CJK are no emoji.
    for (const text of ['1', '#', '©', '®', 'a', 'é', '草', '?']) expect(emojiStyleOf(text), text).toBeNull();
  });

  it('reads VS15 as text presentation only after an emoji, and as nothing after a letter, digit or Chinese character', () => {
    // A pictograph, a keycap sequence and a flag letter with VS15 ask for text presentation.
    for (const cluster of ['✌\uFE0E', '©\uFE0E', '1\uFE0E\u20E3', '🇩\uFE0E']) expect(emojiStyleOf(cluster), cluster).toBe('text');
    // Anything else with VS15 is no emoji: it is measured as the text it is, and does not open a break inside a word.
    for (const cluster of ['a\uFE0E', 'e\uFE0E', '1\uFE0E', '草\uFE0E', '\uFE0E']) expect(emojiStyleOf(cluster), cluster).toBeNull();
  });

  it('segments a text into grapheme clusters, so a sequence is one unit', () => {
    expect(graphemesOf(`a${FAMILY}🇩🇪1️⃣e\u0301`)).toEqual(['a', FAMILY, '🇩🇪', '1️⃣', 'e\u0301']);
  });

  it('uses Unicode 17 grapheme and emoji properties even when the runtime ICU data is older', () => {
    expect(graphemesOf('🫪‍🫠')).toEqual(['🫪‍🫠']);
    expect(emojiStyleOf('🫪')).toBe('emoji');
  });

  it('finds extended pictographs from the pinned data', () => {
    expect(hasExtendedPictographic('a😀')).toBe(true);
    expect(hasExtendedPictographic('a❤')).toBe(true);
    expect(hasExtendedPictographic('hello草')).toBe(false);
  });

  it('is the screenplay’s rule: an emoji prints as one glyph, a text-style pictograph does not', () => {
    const SEQUENCES = ['👨‍👩‍👧‍👦', '🧑🏽‍💻', '👍🏽', '🇩🇪', '1️⃣', '#️⃣', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '❤️', '🎬', '🏳️‍🌈'];
    for (const unit of [...SEQUENCES, '😀', '✅', '⌚', '🏽', '©️']) expect(isEmojiCluster(unit), unit).toBe(true);
    for (const unit of ['©', '®', '™', '❤', '☺', '❤︎', 'a', '草', '1']) expect(isEmojiCluster(unit), unit).toBe(false);
  });

  it('is the contact sheet’s rule for what is drawn as an emoji picture: an emoji, or a text pictograph outside Latin-1', () => {
    for (const unit of ['🎬', FAMILY, '☺', '✌', '❤', '☺︎', '🎬︎']) expect(isEmojiPicture(unit), unit).toBe(true);
    for (const unit of ['1', '#', '©', '®', 'a', 'é', '草', '?', 'a\uFE0E']) expect(isEmojiPicture(unit), unit).toBe(false);
  });

  it('agrees with the rule the screenplay had, on every line of Unicode’s emoji list and a few clusters besides', () => {
    // The screenplay's old classifier, kept here as the reference.
    const KEYCAP = /^[0-9#*]\uFE0F?\u20E3$/u;
    const EMOJI_MARK = /\uFE0F|\u200D|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}]/u;
    const old = (cluster: string): boolean => {
      if (cluster.includes('\uFE0E')) return false;
      if (isEmojiPresentation(cluster.codePointAt(0) ?? 0) || KEYCAP.test(cluster)) return true;
      return [...cluster].some((char) => isExtendedPictographic(char.codePointAt(0) ?? 0)) && EMOJI_MARK.test(cluster);
    };
    const units = new Set<string>(['©', '©️', '❤', '❤︎', '☺', '☺️', '✌', '✌︎', 'a', 'e︎', '1', '🇩', '→', '↔', '↔️', '▪', '▶', '▶️', '☀', '♠️', '🫩', '草']);
    for (const line of readFileSync(new URL('./fixtures/emoji-test-17.0.txt', import.meta.url), 'utf8').split('\n')) {
      if (!/^[0-9A-F]/.test(line)) continue;
      units.add((line.split(';')[0] ?? '').trim().split(/\s+/).map((hex) => String.fromCodePoint(parseInt(hex, 16))).join(''));
    }
    expect(units.size).toBeGreaterThan(4000);
    for (const unit of units) expect(isEmojiCluster(unit), [...unit].map((c) => c.codePointAt(0)?.toString(16)).join(' ')).toBe(old(unit));
  });
});

describe('what Noto Emoji prints for a cluster', () => {
  it('keys a cluster without its selectors and the skin tones after the first code point', () => {
    expect(emojiKey('👍🏽')).toBe('👍');
    expect(emojiKey('❤️')).toBe('❤');
    expect(emojiKey('🏽')).toBe('🏽');
    expect(firstCodePoint('👨‍👩‍👧')).toBe('👨');
  });

  it('gives the woman and man walking, kneeling and running facing right one glyph, whatever the skin tone and selectors', () => {
    const walking = emojiLayoutGlyph('🚶‍♀️‍➡️');
    expect(walking).toBeGreaterThan(0);
    for (const form of ['🚶🏽‍♀️‍➡️', '🚶🏿‍♀️‍➡️', '🚶‍♀‍➡', '🚶🏻‍♀‍➡️']) expect(emojiLayoutGlyph(form), form).toBe(walking);
    // The man draws the same figure, the kneeling and running people their own.
    expect(emojiLayoutGlyph('🚶‍♂️‍➡️')).toBe(walking);
    expect(emojiLayoutGlyph('🧎‍♀️‍➡️')).not.toBe(walking);
    expect(emojiLayoutGlyph('🏃‍♂️‍➡️')).not.toBe(emojiLayoutGlyph('🧎‍♂️‍➡️'));
    // Fontkit gets the rest right: the person facing right, the unmarked woman, everything else.
    for (const form of ['🚶‍➡️', '🧑‍🦯‍➡️', '🚶‍♀️', '👨‍👩‍👧', '👍🏽']) expect(emojiLayoutGlyph(form), form).toBeUndefined();
  });

  it('prints a sequence whole, a sequence newer than the font as its first emoji, and a character it lacks as nothing', () => {
    expect(emojiPrint('👨‍👩‍👧')).toBe('whole');
    expect(emojiPrint('👍🏽')).toBe('whole');
    // The people facing right are whole, fontkit's parts notwithstanding; a cat joined to a sloth is no sequence of any Emoji version.
    expect(emojiPrint('🚶‍♀️‍➡️')).toBe('whole');
    expect(emojiPrint('🐈‍🦥')).toBe('base');
    // Emoji 16.0 and 17.0: one glyph each, the flag of Sark included.
    for (const cluster of ['🫩', '🫆', '🪾', '🫜', '🪉', '🪏', '🫟', '🇨🇶', '🫪', '🛘']) expect(emojiPrint(cluster), cluster).toBe('whole');
    // A private-use code point is one no font will ever map.
    expect(emojiPrint('')).toBe('none');
  });
});
