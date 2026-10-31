/**
 * The editor's own words, as a port ([i18n.md §3.4](../../../../docs/architecture/i18n.md)).
 *
 * The editor package renders three strings a writer reads or a screen reader announces: the empty-scene hint, the accessible
 * name of the agent's ghost preview, and the note beside a stream that stopped. A fourth stands in for an image whose source
 * the page may not load: its alt text, or "Image" when it has none. The package ships English defaults for the headless and
 * test callers, and the app hands a translated set through the mount options. Nothing here imports Lingui or React: the app
 * owns the messages and passes their rendered words in.
 */

export interface EditorLabels {
  /** §10's empty-document hint, which the app sets per mount. */
  readonly placeholder: string;
  /** The accessible name of the ghost preview region (§8). */
  readonly ghostRegion: string;
  /** The alert beside a ghost whose stream stopped; `reason` is the failure the gateway gave. */
  readonly ghostStopped: (reason: string) => string;
  /** The alt text a picture without one is shown as, when its source is not app-local. */
  readonly image: string;
  /** The toolbar button and the slash menu item that insert a picture. */
  readonly insertPicture: string;
  /** The accessible name of the slash menu, and its one item's description. */
  readonly slashMenu: string;
  readonly slashPictureHint: string;
  /** Shown in place of a picture whose file is not in the project; `name` is the file's name. */
  readonly imageMissing: (name: string) => string;
  /** Shown in place of a picture on the web. The editor never loads it. */
  readonly imageRemote: string;
  readonly imageLoading: string;
  /** The placement popover. */
  readonly pictureSettings: string;
  readonly pictureAlt: string;
  readonly pictureCaption: string;
  readonly pictureDecorative: string;
  readonly pictureSize: string;
  readonly sizeFull: string;
  readonly sizeHalf: string;
  readonly sizeInline: string;
  readonly pictureApply: string;
  readonly pictureCancel: string;
}

/** The words the package uses when its caller supplies none: the source English, for tests and headless callers. */
export const DEFAULT_EDITOR_LABELS: EditorLabels = {
  placeholder: 'Begin the scene…',
  ghostRegion: 'Agent preview',
  ghostStopped: (reason) => `The stream stopped before it finished (${reason}). The text above is partial; Retry or Discard.`,
  image: 'Image',
  insertPicture: 'Insert picture',
  slashMenu: 'Insert',
  slashPictureHint: 'Choose a picture from your computer',
  imageMissing: (name) => `Picture not found: ${name}`,
  imageRemote: 'Picture on the web (not loaded)',
  imageLoading: 'Loading picture…',
  pictureSettings: 'Picture settings',
  pictureAlt: 'Alt text',
  pictureCaption: 'Caption',
  pictureDecorative: 'Decorative picture (screen readers skip it)',
  pictureSize: 'Size',
  sizeFull: 'Full width',
  sizeHalf: 'Half width',
  sizeInline: 'In line with the text',
  pictureApply: 'Apply',
  pictureCancel: 'Cancel',
};
