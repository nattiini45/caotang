/**
 * The editor's own words in the interface language: the set the app hands `@caotang/editor/tiptap` through its labels port
 * ([i18n.md §3.4](../../../../docs/architecture/i18n.md)). The package keeps its English defaults for the CLI, the MCP server and
 * the tests; this is the one place the app translates them. Pure, so a test reads the words under a catalogue without a browser.
 */
import { t } from '@lingui/core/macro';
import type { EditorLabels } from '@caotang/editor/tiptap';

/* lingui-set comment="Words the editor shows or announces. Interpolated values: reason is a failure message; name is a picture's file name; label is a footnote's label (a number or a name)" */

/**
 * Every label but the empty-scene hint, which the mount sets itself, rendered with the active catalogue. Called at mount, so a
 * mount after a language switch carries the new words.
 */
export function editorLabels(): Omit<EditorLabels, 'placeholder'> {
  return {
    ghostRegion: t`Agent preview`,
    ghostStopped: (reason) => t`The stream stopped before it finished (${{ reason }}). The text above is partial; Retry or Discard.`,
    image: t`Image`,
    insertPicture: t`Insert picture`,
    slashMenu: t`Insert`,
    slashPictureHint: t`Choose a picture from your computer`,
    imageMissing: (name) => t`Picture not found: ${{ name }}. Add the file back to the project's assets folder, or delete the picture.`,
    imageRemote: t`Picture on the web. It is not loaded, so opening this scene never contacts the network.`,
    imageLoading: t`Loading picture…`,
    pictureSettings: t`Picture settings`,
    pictureAlt: t`Alt text`,
    pictureCaption: t`Caption`,
    pictureDecorative: t`Decorative picture (screen readers skip it)`,
    pictureSize: t`Size`,
    sizeFull: t`Full width`,
    sizeHalf: t`Half width`,
    sizeInline: t`In line with the text`,
    pictureApply: t`Apply`,
    pictureCancel: t`Cancel`,
    // A marker's and a note's accessible names. Separate messages, so a language can name the note differently.
    footnoteReference: (label) => t({ message: `Footnote ${label}`, context: 'footnote marker' }),
    footnoteNote: (label) => t({ message: `Footnote ${label}`, context: 'footnote note' }),
  };
}
