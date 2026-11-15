/**
 * The Word reader (#279, epic #263): a `.docx` read into the import block list on the shared zip and XML layer —
 * styles and their `basedOn` chains, outline levels, lists and quotes, tracked changes in accept/reject/keep,
 * footnotes and endnotes inline, comments as notes, pictures through the relationships, tables as paragraphs, and a
 * table of contents that never becomes chapters. An own reader by decision 1; no DOM, no dependency.
 */

export {
  readDocx,
  readDocxArchive,
  readDocxZip,
  type DocxImport,
  type DocxOptions,
  type DocxError,
  type DocxResult,
  type DocxChanges,
  type DocxDropped,
  type TrackedMode,
} from './reader.js';
export {
  parseStyles,
  resolveStyle,
  parseNumbering,
  parseRels,
  parseNotes,
  parseCore,
  type DocxStyle,
  type DocxLevel,
  type DocxRel,
  type DocxNote,
} from './parts.js';
