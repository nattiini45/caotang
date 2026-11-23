/**
 * The Plottr adapter (#290, epic #263): a `.pltr` outline file, plain JSON, read into folders, scenes, codex rows
 * and Research documents. No DOM, no dependency.
 */

export {
  readPlottr,
  SYNOPSIS_CHARS,
  type PlottrBook,
  type PlottrCodex,
  type PlottrError,
  type PlottrFolder,
  type PlottrImport,
  type PlottrLabels,
  type PlottrReadOptions,
  type PlottrResearch,
  type PlottrResult,
  type PlottrScene,
} from './reader.js';
export { slateToMarkdown } from './slate.js';
