/**
 * The EPUB reader (#296, epic #263): container.xml to the OPF, the spine and the navigation to chapters, the
 * shared XHTML walker to blocks. Landmarks are front or back matter, footnotes are `[^n]`, the cover and the
 * pictures are kept, and a DRM file is refused. No DOM, no third-party dependency, no script ever run.
 */

export {
  parseOpf,
  containerOpfPath,
  encryptionIsDrm,
  resolveHref,
  fragmentOf,
  dirOf,
  type EpubOpf,
  type EpubManifestItem,
  type EpubSpineItem,
  type EpubLandmark,
  type OpfResult,
} from './opf.js';
export { parseNav, parseNcx, parseLandmarks, type EpubNavEntry } from './nav.js';
export { readEpub, readEpubArchive, type EpubImport, type EpubChapter, type EpubMatter, type EpubError, type EpubResult } from './reader.js';
