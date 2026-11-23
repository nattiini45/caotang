/**
 * The yWriter adapter (#291, epic #263): a `.yw7` project file, one XML document (UTF-8 or UTF-16), read into
 * parts, chapters and scenes — with the declared cast, point of view, day offsets and durations the preview
 * passes to the timeline when a coherence file is open — plus codex rows and Research documents. Written from
 * the file format only; no DOM, no dependency.
 */

export {
  DEFAULT_YW7_STATUS,
  readYw7,
  sceneMarkup,
  type Yw7Chapter,
  type Yw7CodexRow,
  type Yw7Error,
  type Yw7Import,
  type Yw7Labels,
  type Yw7Loss,
  type Yw7Part,
  type Yw7ReadOptions,
  type Yw7Research,
  type Yw7Result,
  type Yw7Scene,
} from './reader.js';
