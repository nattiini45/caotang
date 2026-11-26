/**
 * The OpenDocument reader (#298, epic #263): an `.odt` package or a flat `.fodt` read into the import block list on
 * the shared zip and XML layer — outline levels, the style chain, lists and quotes, notes inline, annotations as
 * notes, tracked changes in accept/reject/keep, and pictures from the package or the flat file's own base64.
 * An own reader; no DOM, no dependency.
 */

export {
  readOdt,
  readOdtArchive,
  type OdtImport,
  type OdtOptions,
  type OdtError,
  type OdtResult,
  type OdtChanges,
  type OdtDropped,
  type OdtTrackedMode,
} from './reader.js';
