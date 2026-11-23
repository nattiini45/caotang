/**
 * The AO3 adapter (#297, epic #263): an Archive of Our Own work download, HTML or EPUB, read into the same blocks
 * and the same metadata — tags as keywords, characters as offered codex rows, the summary as the synopsis, and the
 * work, chapter and end notes as notes. Over the shared XHTML walker and EPUB reader; no DOM, no dependency.
 */

export {
  readAo3Html,
  readAo3Epub,
  AO3_SKIP,
  ao3Keywords,
  ao3SeriesNote,
  looksLikeAo3,
  parseAo3Preface,
  proseOf,
  type Ao3Import,
  type Ao3Note,
  type Ao3Error,
  type Ao3Result,
  type Ao3Meta,
  type Ao3Preface,
  type Ao3ChapterNote,
  type Ao3Stats,
} from './reader.js';
