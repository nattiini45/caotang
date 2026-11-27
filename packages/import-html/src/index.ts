/**
 * The HTML reader (#299, epic #263): an own XHTML-to-blocks walker (no DOM, no dependency) shared by the HTML,
 * EPUB, AO3, Kanka and Notion imports, reading a saved page or a Google Docs web-page zip into the import block
 * list with its losses. Scripts, styles and event handlers are dropped and never run; remote images are listed.
 */

export {
  htmlToBlocks,
  collectHtmlFootnotes,
  normaliseHtml,
  isSafeLinkTarget,
  type HtmlWalkResult,
  type HtmlWalkOutput,
  type HtmlWalkError,
  type HtmlWalkOptions,
  type HtmlDropped,
  type HtmlNoteRef,
  type HtmlNote,
  type HtmlSkipped,
} from './walker.js';
export { readHtmlFile, readHtmlZip, readHtmlArchive, type HtmlImport, type HtmlError, type HtmlResult } from './reader.js';
export { pictureRefusal, dropUnresolvedPictures, relativeCandidates, type PictureRefusal } from './pictures.js';
