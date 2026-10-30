/**
 * `@caotang/script` — the AV script: one linear timed script for podcasts, radio and audio drama, and narrated video
 * ([av-script.md](../../../docs/architecture/av-script.md)). Pure: the parser, line and cue ids, speech-rate estimates,
 * segment timing and episode totals, and the reading of a show's and an episode's settings. The exports, the episode
 * view and the coherence checks are later plan items and are not here.
 */

export type {
  ParsedEpisode,
  ScriptCue,
  ScriptEpisode,
  ScriptLine,
  ScriptLineKind,
  ScriptNotice,
  ScriptNoticeKind,
  ScriptSegment,
  ScriptTotals,
} from './model.js';
export { classifyBodyLines, parseEpisode, type BodyLineRole, type ClassifiedLine, type ParseOptions } from './parse.js';
export {
  ensureScriptLineIds,
  isMintedScriptId,
  mintScriptId,
  SCRIPT_CUE_ID,
  SCRIPT_LINE_ID,
  type ScriptEnsureResult,
  type ScriptMintedId,
  type ScriptMintOptions,
} from './line-ids.js';
export {
  cueVocabularyOf,
  DEFAULT_CUE_VOCABULARY,
  isEpisodeDocument,
  isShowFolder,
  NARRATION_LABEL,
  readEpisodeMeta,
  readShowMeta,
  showFolderOf,
  SPEECH_RATE_PRESETS,
  speechRateOf,
  type EpisodeMeta,
  type RatePreset,
  type SettingsRead,
  type ShowMeta,
} from './settings.js';
export { resolveScriptSpeaker, type ScriptSpeakerResolution } from './speakers.js';
export { readBracket, readTiming, type BracketReading, type TimingNotice, type TimingRead } from './timing.js';
export { roundSeconds, scriptTotals, segmentTiming, type SegmentTiming } from './totals.js';
