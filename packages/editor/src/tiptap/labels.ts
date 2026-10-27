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
}

/** The words the package uses when its caller supplies none: the source English, for tests and headless callers. */
export const DEFAULT_EDITOR_LABELS: EditorLabels = {
  placeholder: 'Begin the scene…',
  ghostRegion: 'Agent preview',
  ghostStopped: (reason) => `The stream stopped before it finished (${reason}). The text above is partial; Retry or Discard.`,
  image: 'Image',
};
