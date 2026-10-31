/**
 * `@caotang/editor/tiptap` — the live editor. The app mounts through this entry point.
 *
 * It is not re-exported from `@caotang/editor`, and that is the point of the split. The
 * barrel must stay importable without an engine, a DOM or a store, and `EditorApi`
 * (§4) is the headless half of the editor for exactly that reason. Everything here needs a
 * DOM, `@tiptap/core` and `@caotang/store`, so it is a separate door.
 */
export {
  createTiptapEditorApi,
  StaleMountError,
  UnreadablePendingBodyError,
  UnsavedEditsError,
} from './adapter.js';
export type {
  EditorSaveStatus,
  LoadResult,
  SetContentOptions,
  TiptapEditorApi,
  TiptapEditorInstance,
  TiptapMountOptions,
} from './adapter.js';
export type { SuggestionLayer, SuggestionSpan } from './suggestions.js';
export { createGhostPreview } from './ghost.js';
export type { GhostCallbacks, GhostPreview } from './ghost.js';
export { HISTORY_JOURNAL_VERSION, HISTORY_MAX_ENTRIES, schemaSignature } from './history-journal.js';
export type { HistoryJournal, HistoryPort, JournalEntry } from './history-journal.js';
export { isAppLocalSource, caotangExtensions } from './extensions.js';
export type { CaotangExtensionOptions, CaotangRole } from './extensions.js';
export { isSafeLinkTarget, plainPasteHtml } from './paste.js';
export { ENGLISH_FOOTNOTE_WORDS, deleteOrphanNote, footnoteChord, insertFootnote, jumpFootnote } from './footnotes.js';
export type { FootnoteOrphan, FootnoteWords } from './footnotes.js';
