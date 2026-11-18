/**
 * `@caotang/import-inklewriter` — the Inklewriter JSON reader (issue #286). Inklewriter stories export as JSON; inkle
 * publishes an MIT converter to Ink, vendored beside this file as inklewriter-convert.ts. This package checks the export's
 * shape, gives a usable name to any section label or flag name the converter would leave empty, runs that converter and
 * hands the Ink to the shared whole-story planner. It lists the stitch images by URL and never fetches them (this import
 * offers no download control), names the editor data it cannot bring in, and reports every name it changed. No DOM, so it
 * runs in the import Worker and in Node.
 */

export {
  readInklewriter,
  type InklewriterImage,
  type InklewriterImport,
  type InklewriterRename,
  type InklewriterResult,
} from './inklewriter.js';
