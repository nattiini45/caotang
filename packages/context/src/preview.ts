/**
 * The prompt preview — [context-assembly.md §5 and §7](../../../docs/architecture/context-assembly.md).
 *
 * A pure reading of an `AssembledPrompt`. It takes no task, no app and no config of its
 * own, so the preview cannot disagree with the execution: the payload it shows is
 * `toChatMessages` of the same object the call sends, and its token counts are the
 * assembly's. The spec calls this "zero drift between preview and execution".
 *
 * The cost figure is an estimate for the writer to read (provider-gateway §6, D4). Caotang sets no quota from it; a limit the writer
 * sets is the harness's to enforce, from the same prices (agent-harness §7.1).
 */

import { PREVIEW_CHARS, DEFAULT_MAX_OUTPUT_TOKENS } from './profiles.js';
import { formatCount, headOf } from './text.js';
import { toChatMessages } from './messages.js';
import { tokensForChars } from './tokens.js';
import {
  LAYER_NAMES,
  type AssembledPrompt,
  type LayerId,
  type LayerReport,
  type PreviewLayer,
  type PromptPreview,
} from './types.js';

/** 12k, 8.1k, 4k: a token count as the warning shows it. */
function kTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  const tenths = Math.round(tokens / 100) / 10;
  return Number.isInteger(tenths) ? `${tenths}k` : `${tenths.toFixed(1)}k`;
}

function layerOf(assembled: AssembledPrompt, id: LayerId): LayerReport {
  const layer = assembled.layers.find((candidate) => candidate.id === id);
  if (layer === undefined) throw new Error(`assembly has no ${id} report`);
  return layer;
}

export function buildPreview(assembled: AssembledPrompt): PromptPreview {
  const payload = toChatMessages(assembled);
  const promptTokens = assembled.estimate.promptTokens;
  const thinkingTokens = assembled.model.thinkingTokens ?? 0;
  const completionTokens = (assembled.model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) + thinkingTokens;

  const cache = cacheForecast(assembled);
  // Every layer's drops and notes reach the preview, not only L2's and L4's: a cut in any layer is
  // part of what the writer approves (§5, D8).
  const layers: PreviewLayer[] = assembled.layers.map((layer) => {
    const fraction = layer.budget !== undefined && layer.budget > 0 && layer.included ? layer.tokens / layer.budget : undefined;
    return {
      id: layer.id,
      name: LAYER_NAMES[layer.id],
      included: layer.included,
      tokens: layer.tokens,
      ...(layer.budget === undefined ? {} : { budget: layer.budget }),
      ...(fraction === undefined ? {} : { fraction }),
      drops: layer.drops.map((drop) => ({ label: drop.label, text: drop.text, reason: drop.reason })),
      notes: [...layer.notes],
      ...(cache !== undefined && layer.included && cache.layers.has(layer.id) ? { likelyCached: true as const } : {}),
    };
  });

  const codex = layerOf(assembled, 'L2');
  const story = layerOf(assembled, 'L4');
  const omittedOlder = story.drops.filter(
    (drop) => drop.group === 'prior' && (drop.reason.kind === 'budget' || drop.reason.kind === 'total-budget'),
  ).length;

  const focus = assembled.focus;
  const focusPreview =
    focus === undefined
      ? undefined
      : {
          head: headOf(focus.head, PREVIEW_CHARS),
          summary:
            focus.chars === 0
              ? 'no document text sent; the synopsis and notes stand in'
              : `${headOf(focus.head, PREVIEW_CHARS)}… (${formatCount(focus.chars)} chars)`,
        };

  const window = assembled.model.contextWindow;
  const windowPreview =
    window === undefined
      ? undefined
      : {
          contextWindow: window,
          ...(promptTokens > window
            ? {
                warning: `prompt ≈ ${kTokens(promptTokens)} tokens; model window ${kTokens(window)} — trim codex or raise budget`,
              }
            : {}),
        };

  const price = assembled.model.pricePer1k;
  const cost =
    price === undefined
      ? undefined
      : (() => {
          const promptUsd = (promptTokens / 1_000) * price.prompt;
          const completionUsd = (completionTokens / 1_000) * price.completion;
          return {
            promptUsd,
            completionUsd,
            totalUsd: promptUsd + completionUsd,
            ...(thinkingTokens > 0 ? { includesThinking: true as const } : {}),
          };
        })();

  return {
    payload,
    promptTokens,
    completionTokens,
    layers,
    codex: {
      included: codex.kept.map((item) => ({ name: item.label, reason: item.reason })),
      dropped: codex.drops.map((drop) => ({ name: drop.label, reason: drop.text })),
    },
    storySoFar: {
      included: story.kept.map((item) => item.label),
      omittedOlder,
    },
    ...(focusPreview === undefined ? {} : { focus: focusPreview }),
    ...(windowPreview === undefined ? {} : { window: windowPreview }),
    ...(cache === undefined ? {} : { cache: { prefixTokens: cache.prefixTokens, readMultiplier: cache.readMultiplier, key: cache.key } }),
    ...(cost === undefined ? {} : { cost }),
  };
}

/**
 * The prompt's reusable prefix (§5, "Cache forecast"): the system message and the user message's parts through the one marked
 * as the cache boundary, measured by the assembly's own rule. Undefined when the model's cache is not priced, when no part is
 * marked, or when the prefix is shorter than the smallest one the model caches.
 */
function cacheForecast(
  assembled: AssembledPrompt,
): { prefixTokens: number; readMultiplier: number; key: string; layers: ReadonlySet<LayerId> } | undefined {
  const terms = assembled.model.cache;
  if (terms === undefined) return undefined;
  const boundary = assembled.parts.findIndex((part) => part.cacheBoundary === true);
  if (boundary < 0) return undefined;
  const system = assembled.messages[0]?.content ?? '';
  const prefix = assembled.parts.slice(0, boundary + 1).map((part) => part.text).join('\n\n');
  const prefixTokens = tokensForChars(system.length + prefix.length);
  if (terms.minTokens !== undefined && prefixTokens < terms.minTokens) return undefined;
  const layers = new Set<LayerId>(['L0']);
  for (const part of assembled.parts.slice(0, boundary + 1)) if (part.layer !== 'status') layers.add(part.layer);
  return { prefixTokens, readMultiplier: terms.readMultiplier, key: `${system}\u0000${prefix}`, layers };
}
