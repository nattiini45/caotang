/**
 * The Colour emoji recipe option (`colourEmoji`, screenplay.md §5.3 and storyboard.md §6): which format has it on by default, and
 * the words the Export dialog shows for it. They sit here, not in the dialog, so a test pins the text.
 */

/** The formats that read the option. Every other format ignores it. */
export const COLOUR_EMOJI_FORMATS = ['pdf', 'contact-sheet-pdf'] as const;

/**
 * Whether a format prints emoji in colour when the recipe does not say: the contact sheet does (a visual document), the screenplay PDF does
 * not (scripts are printed and photocopied in black and white). An explicit value in the recipe always wins.
 */
export function colourEmojiDefault(format: string): boolean {
  return format === 'contact-sheet-pdf';
}

/** The checkbox's label in the Export dialog. */
export const COLOUR_EMOJI_LABEL = 'Colour emoji: print emoji in colour, with their skin tones';

/** What the dialog says under the checkbox, by format: why the default is what it is, and that colour is how to get skin tones. */
export const COLOUR_EMOJI_HINT = {
  pdf: 'Scripts are usually printed in black and white, so this is off unless you turn it on. Without colour a skin tone prints as the plain figure; colour is how to get skin tones.',
  'contact-sheet-pdf':
    'On by default, because a contact sheet is a picture to look at. Turn it off for black and white, where a skin tone prints as the plain figure; colour is how to get skin tones.',
} as const;
