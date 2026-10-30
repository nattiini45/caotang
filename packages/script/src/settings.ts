/**
 * A show's and an episode's settings, read from the manifest — [av-script.md §2, §3 and §4](../../../docs/architecture/av-script.md).
 *
 * The store carries `showMeta` and `episodeMeta` as objects and does not read them; this module does. The commands
 * (`script.setShowMeta`, `script.setEpisodeMeta`) check every value they write, but a manifest can be edited by hand, so
 * the read is tolerant: a value of the wrong type is left out of the result and named in a notice, never thrown on, and
 * the stored object is not touched (the next save writes it back as it is).
 */

import { ENCLOSURE_MIME_TYPES, EPISODE_TYPES, SCRIPT_LABEL_PATTERN, SPEECH_RATE_PRESET_NAMES } from '@caotang/bus';
import type { ProjectState, TreeNode } from '@caotang/store';

/** The speech-rate presets, in words per minute (§4, SD5): narration at 150, broadcast at 170. */
export const SPEECH_RATE_PRESETS: Readonly<Record<(typeof SPEECH_RATE_PRESET_NAMES)[number], number>> = {
  narration: 150,
  broadcast: 170,
};

/** The cue vocabulary a show has when it sets none (§3, SD7). */
export const DEFAULT_CUE_VOCABULARY: readonly string[] = ['music', 'sfx', 'ambience', 'ad', 'pause', 'sting'];

/** The label of a narration line (§3). It is compared without case, after the cue vocabulary. */
export const NARRATION_LABEL = 'NARRATION';

export type RatePreset = (typeof SPEECH_RATE_PRESET_NAMES)[number];

/** A show folder's settings, as read (§2). Every field is optional. */
export interface ShowMeta {
  readonly feedTitle?: string;
  readonly description?: string;
  readonly defaultSpeaker?: string;
  readonly author?: string;
  readonly language?: string;
  readonly explicit?: boolean;
  readonly category?: string;
  readonly link?: string;
  readonly imageAssetId?: string;
  readonly targetRuntimeSec?: number;
  readonly speechRateWpm?: number;
  readonly ratePreset?: RatePreset;
  readonly cueVocabulary?: readonly string[];
  readonly fundingUrl?: string;
}

/** An episode document's settings, as read (§2). Every field is optional. */
export interface EpisodeMeta {
  readonly audioUrl?: string;
  readonly audioBytes?: number;
  readonly audioMime?: (typeof ENCLOSURE_MIME_TYPES)[number];
  readonly episode?: number;
  readonly season?: number;
  readonly episodeType?: (typeof EPISODE_TYPES)[number];
  readonly transcriptUrl?: string;
  readonly chaptersUrl?: string;
}

/** A read: the settings it could use, and a sentence for each stored value it left out. */
export interface SettingsRead<T> {
  readonly meta: T;
  readonly notices: readonly string[];
}

type Reader = (value: unknown) => unknown;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonBlank: Reader = (v) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const positive: Reader = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
const wholeFrom = (min: number): Reader => (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= min ? v : undefined);
const oneOf = (values: readonly string[]): Reader => (v) => (typeof v === 'string' && values.includes(v) ? v : undefined);
const bool: Reader = (v) => (typeof v === 'boolean' ? v : undefined);
const labels: Reader = (v) => {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  if (!v.every((item): item is string => typeof item === 'string' && SCRIPT_LABEL_PATTERN.test(item.trim()))) return undefined;
  return v.map((item) => item.trim());
};

const SHOW_READERS: Readonly<Record<keyof ShowMeta, Reader>> = {
  feedTitle: nonBlank,
  description: nonBlank,
  defaultSpeaker: nonBlank,
  author: nonBlank,
  language: nonBlank,
  explicit: bool,
  category: nonBlank,
  link: nonBlank,
  imageAssetId: nonBlank,
  targetRuntimeSec: positive,
  speechRateWpm: positive,
  ratePreset: oneOf(SPEECH_RATE_PRESET_NAMES),
  cueVocabulary: labels,
  fundingUrl: nonBlank,
};

const EPISODE_READERS: Readonly<Record<keyof EpisodeMeta, Reader>> = {
  audioUrl: nonBlank,
  audioBytes: wholeFrom(1),
  audioMime: oneOf(ENCLOSURE_MIME_TYPES),
  episode: wholeFrom(0),
  season: wholeFrom(1),
  episodeType: oneOf(EPISODE_TYPES),
  transcriptUrl: nonBlank,
  chaptersUrl: nonBlank,
};

function readWith<T>(raw: unknown, readers: Readonly<Record<string, Reader>>, field: string): SettingsRead<T> {
  if (raw === undefined) return { meta: {} as T, notices: [] };
  if (!isRecord(raw)) return { meta: {} as T, notices: [`${field} is not an object, so none of its settings are used`] };
  const meta: Record<string, unknown> = {};
  const notices: string[] = [];
  for (const [key, read] of Object.entries(readers)) {
    if (raw[key] === undefined) continue;
    const value = read(raw[key]);
    if (value === undefined) notices.push(`${field}.${key} has a value this build cannot use, so it is left out (and kept in the file)`);
    else meta[key] = value;
  }
  return { meta: meta as T, notices };
}

/** A show's settings from its stored `showMeta`. */
export function readShowMeta(raw: unknown): SettingsRead<ShowMeta> {
  return readWith<ShowMeta>(raw, SHOW_READERS, 'showMeta');
}

/** An episode's settings from its stored `episodeMeta`. */
export function readEpisodeMeta(raw: unknown): SettingsRead<EpisodeMeta> {
  return readWith<EpisodeMeta>(raw, EPISODE_READERS, 'episodeMeta');
}

/**
 * The speech rate a show reads at, in words per minute (§4, SD5): its own `speechRateWpm` when set, else its preset's,
 * else the narration preset's 150.
 */
export function speechRateOf(show: ShowMeta = {}): number {
  return show.speechRateWpm ?? SPEECH_RATE_PRESETS[show.ratePreset ?? 'narration'];
}

/** The cue vocabulary a show reads with (§3): its own, else the default six. */
export function cueVocabularyOf(show: ShowMeta = {}): readonly string[] {
  return show.cueVocabulary ?? DEFAULT_CUE_VOCABULARY;
}

/** True for a show folder: a folder marked `kind: 'show'`. */
export function isShowFolder(node: TreeNode): boolean {
  return node.type === 'folder' && node.kind === 'show';
}

/** True for an episode: a document marked `kind: 'av-script'`. */
export function isEpisodeDocument(node: TreeNode): boolean {
  return node.type === 'document' && node.kind === 'av-script';
}

/**
 * The show an episode belongs to: the nearest folder above it marked `show`, or `undefined` when there is none (an
 * episode outside a show reads with the defaults). Walks at most the tree's size, so a cycle cannot hang it.
 */
export function showFolderOf(state: ProjectState, nodeId: string): TreeNode | undefined {
  const byId = new Map(state.manifest.tree.map((node) => [node.id, node]));
  let current = byId.get(nodeId);
  for (let steps = 0; current !== undefined && steps <= byId.size; steps += 1) {
    const parentId: string | null = current.parentId;
    if (parentId === null) return undefined;
    const parent = byId.get(parentId);
    if (parent === undefined) return undefined;
    if (isShowFolder(parent)) return parent;
    current = parent;
  }
  return undefined;
}
