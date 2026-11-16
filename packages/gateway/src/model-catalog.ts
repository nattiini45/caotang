/**
 * The models a person is offered when adding a provider (provider-gateway §2, "Adding a provider"): the provider's live listing,
 * reduced to models that write text, sorted, with one marked as the recommended default. The capability numbers shown beside
 * a model come from the listing first and the preset's table second, so nothing is ever typed.
 */

import { modelRowFor, type PresetDef } from './presets/index.js';
import type { ModelInfo } from './types.js';

export interface ModelChoice {
  readonly id: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly pricePer1k?: { readonly prompt: number; readonly completion: number };
  readonly tools?: boolean;
  readonly vision?: boolean;
  readonly recommended: boolean;
}

/** Words in a model id that mean it does not write text. Matched as whole words, so `vision` and `instruct` models stay. */
const NOT_TEXT = new Set([
  'embed', 'embedding', 'embeddings', 'rerank', 'reranker', 'whisper', 'tts', 'stt', 'transcribe', 'transcription', 'speech',
  'realtime', 'moderation', 'moderations', 'imagen', 'image', 'images', 'veo', 'sora', 'video', 'guard', 'ocr', 'diffusion',
  'flux', 'babbage', 'davinci', 'curie', 'audio', 'dalle',
]);

function writes(info: ModelInfo, known: boolean): boolean {
  if (known) return true;
  if (info.writes !== undefined) return info.writes;
  const id = info.id.toLowerCase().replace('dall-e', 'dalle');
  return !id.split(/[^a-z0-9]+/).some((word) => NOT_TEXT.has(word));
}

/** A dated snapshot id (`gpt-4o-2024-08-06`, `claude-x-20250929`) and the undated name it is a snapshot of. */
function undatedName(id: string): string | undefined {
  const base = id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, '');
  return base === id ? undefined : base;
}

/** The table position of the first row that names this model, or -1. */
function tableRank(preset: PresetDef | undefined, id: string): number {
  if (preset === undefined) return -1;
  const row = modelRowFor(preset, id);
  return row === undefined || row.pattern === '*' ? -1 : preset.models.indexOf(row);
}

export function chooseModels(preset: PresetDef | undefined, listed: readonly ModelInfo[]): ModelChoice[] {
  const strip = preset?.id === 'gemini' ? (id: string) => id.replace(/^models\//, '') : (id: string) => id;
  const infos = listed.map((info) => ({ ...info, id: strip(info.id) }));
  const ids = new Set(infos.map((info) => info.id));
  const kept = infos.filter((info, index) => {
    if (infos.findIndex((other) => other.id === info.id) !== index) return false;
    const base = undatedName(info.id);
    if (base !== undefined && ids.has(base)) return false;
    return writes(info, tableRank(preset, info.id) >= 0);
  });

  const recommendedId =
    preset === undefined
      ? undefined
      : kept.some((info) => info.id === preset.defaultModel)
        ? preset.defaultModel
        : kept.find((info) => tableRank(preset, info.id) >= 0)?.id;

  const order = (info: ModelInfo): [number, number, number] => [
    info.id === recommendedId ? 0 : 1,
    tableRank(preset, info.id) >= 0 ? tableRank(preset, info.id) : Number.MAX_SAFE_INTEGER,
    -(info.created ?? 0),
  ];
  const sorted = [...kept].sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    for (let index = 0; index < 3; index += 1) if (x[index] !== y[index]) return (x[index] ?? 0) - (y[index] ?? 0);
    return b.id.localeCompare(a.id, 'en', { numeric: true });
  });

  return sorted.map((info) => {
    const row = preset === undefined ? undefined : modelRowFor(preset, info.id);
    const contextWindow = info.contextWindow ?? row?.contextWindow;
    const maxOutputTokens = info.maxOutputTokens ?? row?.maxOutputTokens;
    const pricePer1k = info.pricePer1k ?? row?.pricePer1k;
    return {
      id: info.id,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(pricePer1k === undefined ? {} : { pricePer1k }),
      ...(row?.caps.tools === undefined ? {} : { tools: row.caps.tools }),
      ...(row?.caps.vision === undefined ? {} : { vision: row.caps.vision }),
      recommended: info.id === recommendedId,
    };
  });
}
