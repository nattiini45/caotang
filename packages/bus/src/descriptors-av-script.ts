/**
 * The AV script's two settings commands ([av-script.md §2](../../../docs/architecture/av-script.md)): a show folder's
 * `showMeta` and an episode document's `episodeMeta`.
 *
 * - `script.setShowMeta` writes a show's settings: its feed title and description, default speaker, the feed's channel
 *   fields, the declared target runtime, the speech rate (a number or a preset) and the cue vocabulary.
 * - `script.setEpisodeMeta` writes an episode's settings: the enclosure (audio URL, bytes and MIME type), its episode and
 *   season numbers, its episode type and the transcript and chapters URLs.
 *
 * Both are patch semantics with `null` clearing a key, and one undo step each, as `dialogue.setMeta` is. Both are
 * write-auto for the agent, as `binder.setMeta` and `dialogue.setMeta` are: a setting is not content, and the undo puts
 * it back. The lists here are the vocabulary `@caotang/script` reads the stored values with, so the package imports them
 * from the bus rather than retyping them.
 */

import type { CommandDescriptor, ValidationNode } from './command.js';
import { invalid, isRecord, limitExceeded, requireDeclaredParams, requireNode } from './params.js';
import { ok, type CommandError, type Result } from './result.js';

/** The speech-rate presets a show may name (av-script.md §4, SD5). The words-per-minute values are `@caotang/script`'s. */
export const SPEECH_RATE_PRESET_NAMES = ['narration', 'broadcast'] as const;

/** The episode types an episode may carry (`itunes:episodeType`). Absent is `full`. */
export const EPISODE_TYPES = ['full', 'trailer', 'bonus'] as const;

/** The enclosure MIME types Apple accepts (av-script.md §5). An episode's `audioMime` is one of them. */
export const ENCLOSURE_MIME_TYPES = [
  'audio/mpeg',
  'audio/x-m4a',
  'video/mp4',
  'video/x-m4v',
  'video/quicktime',
  'application/pdf',
] as const;

/** The keys `script.setShowMeta`'s patch may carry, in av-script.md §2's order. */
export const SHOW_META_KEYS = [
  'feedTitle',
  'description',
  'defaultSpeaker',
  'author',
  'language',
  'explicit',
  'category',
  'link',
  'imageAssetId',
  'targetRuntimeSec',
  'speechRateWpm',
  'ratePreset',
  'cueVocabulary',
  'fundingUrl',
] as const;

/** The keys `script.setEpisodeMeta`'s patch may carry, in av-script.md §2's order. */
export const EPISODE_META_KEYS = [
  'audioUrl',
  'audioBytes',
  'audioMime',
  'episode',
  'season',
  'episodeType',
  'transcriptUrl',
  'chaptersUrl',
] as const;

/** A show's description, in characters: the show notes' lead and the feed's channel `<description>`. Apple caps it at 4,000. */
export const SHOW_DESCRIPTION_MAX = 4000;

/** Any other text setting, in characters: a title, a name, a category, an id, a URL. */
export const SCRIPT_SETTING_TEXT_MAX = 500;

/** The fastest speech rate a show may set, in words per minute. Far above any measured speaking rate; it catches a typo, not a style. */
export const SPEECH_RATE_WPM_MAX = 1000;

/** The most labels a cue vocabulary holds. The default has six. */
export const CUE_VOCABULARY_MAX = 50;

/**
 * The shape of a label a cue vocabulary may hold, and of a speaker label (av-script.md §3): a letter first, then letters,
 * digits, spaces, `_`, `-`, `.` and `'`, at most 40 characters. A letter is any Unicode letter, so a name in any script is a name.
 */
export const SCRIPT_LABEL_PATTERN = /^\p{L}[\p{L}\p{N} _\-.']{0,39}$/u;

/** A language value: an ISO 639 code, optionally with subtags (`en`, `en-GB`, `zh-Hans`). */
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

/** The settings a show folder holds (av-script.md §2). `null` clears one. */
export type ShowMetaPatch = {
  readonly feedTitle?: string | null;
  readonly description?: string | null;
  readonly defaultSpeaker?: string | null;
  readonly author?: string | null;
  readonly language?: string | null;
  readonly explicit?: boolean | null;
  readonly category?: string | null;
  readonly link?: string | null;
  readonly imageAssetId?: string | null;
  readonly targetRuntimeSec?: number | null;
  readonly speechRateWpm?: number | null;
  readonly ratePreset?: (typeof SPEECH_RATE_PRESET_NAMES)[number] | null;
  readonly cueVocabulary?: readonly string[] | null;
  readonly fundingUrl?: string | null;
};

/** The settings an episode document holds (av-script.md §2). `null` clears one. */
export type EpisodeMetaPatch = {
  readonly audioUrl?: string | null;
  readonly audioBytes?: number | null;
  readonly audioMime?: (typeof ENCLOSURE_MIME_TYPES)[number] | null;
  readonly episode?: number | null;
  readonly season?: number | null;
  readonly episodeType?: (typeof EPISODE_TYPES)[number] | null;
  readonly transcriptUrl?: string | null;
  readonly chaptersUrl?: string | null;
};

/** `script.setShowMeta`'s params: the show folder and the settings to change. */
export type ScriptSetShowMetaParams = {
  readonly nodeId: string;
  readonly patch: ShowMetaPatch;
};

/** `script.setEpisodeMeta`'s params: the episode document and the settings to change. */
export type ScriptSetEpisodeMetaParams = {
  readonly nodeId: string;
  readonly patch: EpisodeMetaPatch;
};

type Checked = Result<unknown, CommandError>;
type Check = (value: unknown, at: string) => Checked;

/** A non-blank text setting, trimmed, at most `max` characters. */
function text(max: number, hint: string): Check {
  return (value, at) => {
    if (typeof value !== 'string' || value.trim() === '') return invalid(`${at} must be non-blank text, or null to clear it`, hint, at);
    const trimmed = value.trim();
    if ([...trimmed].length > max) return limitExceeded(`${at} is longer than ${max} characters`, `shorten it to ${max} characters`, at);
    return ok(trimmed);
  };
}

/** An absolute `https` URL. The podcast namespace takes only https, and a relative address cannot be resolved by a reader. */
const httpsUrl: Check = (value, at) => {
  const checked = text(SCRIPT_SETTING_TEXT_MAX, 'pass an absolute https address, such as "https://example.com/show"')(value, at);
  if (!checked.ok) return checked;
  const raw = checked.value as string;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalid(`${at} "${raw}" is not an absolute address`, 'pass an absolute https address, such as "https://example.com/show"', at);
  }
  if (parsed.protocol !== 'https:') {
    return invalid(`${at} must be an https address, got "${parsed.protocol}"`, 'feeds and the podcast namespace take only https addresses', at);
  }
  return ok(raw);
};

/** A number of seconds or words per minute: finite, above zero, at most `max`. */
function positive(max: number, hint: string): Check {
  return (value, at) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return invalid(`${at} must be a number above zero`, hint, at);
    if (value > max) return limitExceeded(`${at} is above ${max}`, hint, at);
    return ok(value);
  };
}

/** A whole number at least `min`. */
function whole(min: number, hint: string): Check {
  return (value, at) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
      return invalid(`${at} must be a whole number of at least ${min}`, hint, at);
    }
    return ok(value);
  };
}

/** One of a closed list. */
function oneOf(values: readonly string[], hint: string): Check {
  return (value, at) => {
    if (typeof value !== 'string' || !values.includes(value)) return invalid(`${at} must be one of ${values.join(', ')}`, hint, at);
    return ok(value);
  };
}

const boolean: Check = (value, at) =>
  typeof value === 'boolean' ? ok(value) : invalid(`${at} must be true or false`, 'pass true for an explicit show, false otherwise', at);

const language: Check = (value, at) => {
  const checked = text(35, 'pass a language code such as "en" or "en-GB"')(value, at);
  if (!checked.ok) return checked;
  if (!LANGUAGE_PATTERN.test(checked.value as string)) {
    return invalid(`${at} "${checked.value as string}" is not a language code`, 'pass an ISO 639 code with optional subtags, such as "en" or "en-GB"', at);
  }
  return checked;
};

/** A cue vocabulary: one to fifty labels, each shaped like a label, none repeated once case is ignored. */
const cueVocabulary: Check = (value, at) => {
  const hint = 'pass the cue labels as a list, such as ["music", "sfx", "bed"]; null restores the default six';
  if (!Array.isArray(value)) return invalid(`${at} must be a list of labels`, hint, at);
  if (value.length === 0) return invalid(`${at} holds no labels, so nothing would be read as a cue`, hint, at);
  if (value.length > CUE_VOCABULARY_MAX) return limitExceeded(`${at} holds ${value.length} labels, limit ${CUE_VOCABULARY_MAX}`, hint, at);
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const [i, item] of value.entries()) {
    const where = `${at}[${i}]`;
    if (typeof item !== 'string' || !SCRIPT_LABEL_PATTERN.test(item.trim())) {
      return invalid(
        `${where} is not a label: a label starts with a letter and holds letters, digits, spaces, _, -, . and ', at most 40 characters`,
        hint,
        where,
      );
    }
    const label = item.trim();
    const key = label.toLowerCase();
    if (seen.has(key)) return invalid(`${where} "${label}" is in the list twice; labels are compared without case`, 'name each label once', where);
    seen.add(key);
    labels.push(label);
  }
  return ok(labels);
};

const SHOW_CHECKS: Readonly<Record<(typeof SHOW_META_KEYS)[number], Check>> = {
  feedTitle: text(SCRIPT_SETTING_TEXT_MAX, 'pass the title the feed shows, or null to use the folder title'),
  description: text(SHOW_DESCRIPTION_MAX, 'pass the show description, or null to use the folder synopsis'),
  defaultSpeaker: text(SCRIPT_SETTING_TEXT_MAX, 'pass a codex entry id or a typed name'),
  author: text(SCRIPT_SETTING_TEXT_MAX, "pass the show's author"),
  language,
  explicit: boolean,
  category: text(SCRIPT_SETTING_TEXT_MAX, 'pass the category the feed names, such as "Arts"'),
  link: httpsUrl,
  imageAssetId: text(SCRIPT_SETTING_TEXT_MAX, 'pass the id of the show artwork'),
  targetRuntimeSec: positive(Number.MAX_SAFE_INTEGER, 'pass the target runtime in seconds, such as 1800 for half an hour'),
  speechRateWpm: positive(SPEECH_RATE_WPM_MAX, `pass the speech rate in words per minute, at most ${SPEECH_RATE_WPM_MAX}; 150 is narration, 170 broadcast`),
  ratePreset: oneOf(SPEECH_RATE_PRESET_NAMES, 'pass "narration" (150 words a minute) or "broadcast" (170)'),
  cueVocabulary,
  fundingUrl: httpsUrl,
};

const EPISODE_CHECKS: Readonly<Record<(typeof EPISODE_META_KEYS)[number], Check>> = {
  audioUrl: httpsUrl,
  audioBytes: whole(1, 'pass the size of the audio file in bytes, as its host serves it'),
  audioMime: oneOf(ENCLOSURE_MIME_TYPES, 'pass the MIME type of the audio file, such as "audio/mpeg" for an MP3'),
  episode: whole(0, 'pass the episode number'),
  season: whole(1, 'pass the season number, starting at 1'),
  episodeType: oneOf(EPISODE_TYPES, 'pass "full", "trailer" or "bonus"'),
  transcriptUrl: httpsUrl,
  chaptersUrl: httpsUrl,
};

/** The patch, checked key by key against its table. `null` clears a key. */
function checkPatch(
  raw: unknown,
  keys: readonly string[],
  checks: Readonly<Record<string, Check>>,
  what: string,
): Result<Record<string, unknown>, CommandError> {
  if (!isRecord(raw)) {
    return invalid(
      `params.patch must be an object, got ${raw === undefined ? 'nothing' : Array.isArray(raw) ? 'a list' : typeof raw}`,
      `pass a patch with any of: ${keys.join(', ')}`,
      'patch',
    );
  }
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) return invalid(`params.patch.${key} is not ${what}`, `a patch carries only: ${keys.join(', ')}`, `patch.${key}`);
  }
  if (Object.keys(raw).length === 0) return invalid('the patch changes nothing', `name at least one of: ${keys.join(', ')}`, 'patch');
  const typed: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (value === null) {
      typed[key] = null;
      continue;
    }
    const check = checks[key];
    if (check === undefined) continue;
    const checked = check(value, `patch.${key}`);
    if (!checked.ok) return checked;
    typed[key] = checked.value;
  }
  return ok(typed);
}

/** A show folder: a folder marked `kind: 'show'` (av-script.md §2). */
function isShowFolder(node: ValidationNode): boolean {
  return node.type === 'folder' && node.kind === 'show';
}

/** An episode: a document marked `kind: 'av-script'` (av-script.md §2). */
function isEpisode(node: ValidationNode): boolean {
  return node.type === 'document' && node.kind === 'av-script';
}

/** `script.setShowMeta`: a show folder's settings, with their checks. */
export const scriptSetShowMeta: CommandDescriptor<ScriptSetShowMetaParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('script.setShowMeta', params);
    if (!p.ok) return p;
    const node = requireNode(snapshot, p.value, 'nodeId');
    if (!node.ok) return node;
    if (!isShowFolder(node.value)) {
      return invalid(
        `"${node.value.id}" is not a show folder, and only a show folder holds these settings`,
        'choose the show folder (a folder made with kind "show") whose settings to change',
        'nodeId',
      );
    }
    const patch = checkPatch(p.value['patch'], SHOW_META_KEYS, SHOW_CHECKS, 'a show setting');
    if (!patch.ok) return patch;
    return ok({ nodeId: node.value.id, patch: patch.value as ShowMetaPatch });
  },
};

/** `script.setEpisodeMeta`: an episode document's settings, with their checks. */
export const scriptSetEpisodeMeta: CommandDescriptor<ScriptSetEpisodeMetaParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('script.setEpisodeMeta', params);
    if (!p.ok) return p;
    const node = requireNode(snapshot, p.value, 'nodeId');
    if (!node.ok) return node;
    if (!isEpisode(node.value)) {
      return invalid(
        `"${node.value.id}" is not an episode, and only an episode (an AV script document) holds these settings`,
        'choose the episode document (a document made with kind "av-script") whose settings to change',
        'nodeId',
      );
    }
    const patch = checkPatch(p.value['patch'], EPISODE_META_KEYS, EPISODE_CHECKS, 'an episode setting');
    if (!patch.ok) return patch;
    return ok({ nodeId: node.value.id, patch: patch.value as EpisodeMetaPatch });
  },
};
