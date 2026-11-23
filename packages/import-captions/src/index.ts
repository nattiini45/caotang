/**
 * `@caotang/import-captions` — SRT and WebVTT captions to an AV script episode ([av-script.md](../../../docs/architecture/av-script.md)
 * §3 E6, issue #287). Pure: timed text in, cues out (`parseCaptions`), and cues to the episode body with its losses (`buildEpisode`).
 * No DOM and no third-party dependency, so the reader runs on the main thread, in the preview's `'self'` Worker and in Node.
 *
 * The only workspace dependency is `@caotang/script`, for the two contract constants the grammar owns: the default cue vocabulary and
 * the narration label. A speaker that collides with a cue word would become a cue, so the check reads the real list rather than a copy.
 */

export { MAX_CUES, parseCaptions, type CaptionCue, type CaptionNote, type CaptionsFormat, type CaptionsLoss, type CaptionsLossKind, type CaptionsRead, type CaptionsResult } from './cues.js';
export {
  buildEpisode,
  clock,
  durationBracket,
  speakerLabel,
  type BuiltEpisode,
  type EpisodeLine,
  type EpisodeLoss,
  type EpisodeLossKind,
  type EpisodeOptions,
  type EpisodeSegment,
  type ImportCaptionsLoss,
} from './episode.js';
