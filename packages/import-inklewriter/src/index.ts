/**
 * `@caotang/import-inklewriter` — the Inklewriter JSON reader (issue #286). Inklewriter stories export as JSON; inkle
 * publishes an MIT converter to Ink, vendored beside this file as inklewriter-convert.ts. This package runs that
 * converter and hands the Ink to the shared whole-story planner, lists the stitch images by URL (downloading is opt-in,
 * Decision 10) and names the editor data it cannot bring in. No DOM, so it runs in the import Worker and in Node.
 */

export { readInklewriter, type InklewriterImage, type InklewriterImport, type InklewriterResult } from './inklewriter.js';
