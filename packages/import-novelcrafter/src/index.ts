/**
 * The NovelCrafter manuscript and codex reader (#292, epic #263). A NovelCrafter export zip (one folder per
 * codex entry with `entry.md`, `metadata.json` and `notes.md`) and any manuscript Markdown, read over the
 * Markdown reader into the import block list with codex entries, aliases, relations and thumbnails. No DOM
 * and no third-party dependencies, so it runs on the main thread, in a 'self' Worker and in Node.
 */

export { readNovelCrafterExport, type NovelCrafterImport, type NovelCrafterError, type NovelCrafterResult } from './reader.js';
export {
  CODEX_TYPES,
  typeFromFolder,
  typeFromWord,
  parseRelations,
  countProgressions,
  buildResearchPage,
  type CodexType,
  type CodexRelation,
  type NovelCrafterCodexEntry,
} from './codex.js';
