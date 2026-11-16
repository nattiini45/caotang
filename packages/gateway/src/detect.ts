/**
 * Which provider a pasted key belongs to, from its format alone (provider-gateway §2, "Adding a provider"). Nothing is sent
 * anywhere to decide: a key must never reach a provider it does not belong to, so a shape that more than one provider uses is
 * answered with a short list for the person to choose from, never with a trial request to each.
 */

export interface KeyDetection {
  /** The one preset whose keys look like this. Absent when the format is shared or unknown. */
  readonly preset?: string;
  /** What to offer when `preset` is absent: the providers whose keys can look like this, best guess first. */
  readonly candidates: readonly string[];
}

/** The providers offered when nothing about a key narrows it down. The rest stay behind "More providers". */
export const FEATURED_PROVIDERS: readonly string[] = ['openai', 'anthropic', 'gemini', 'openrouter', 'mistral', 'deepseek', 'groq', 'xai'];

const PREFIXES: readonly (readonly [RegExp, string])[] = [
  [/^sk-ant-/, 'anthropic'],
  [/^sk-or-/, 'openrouter'],
  [/^sk-(?:proj|svcacct|admin)-/, 'openai'],
  [/^sk-[A-Za-z0-9_-]*T3BlbkFJ/, 'openai'],
  [/^gsk_/, 'groq'],
  [/^xai-/, 'xai'],
  [/^AIza[A-Za-z0-9_-]{35}$/, 'gemini'],
  [/^hf_/, 'huggingface'],
  [/^pplx-/, 'perplexity'],
  [/^csk-/, 'cerebras'],
  [/^fw_/, 'fireworks'],
];

export function detectProvider(rawKey: string): KeyDetection {
  const key = rawKey.trim();
  if (key === '' || /\s/.test(key)) return { candidates: FEATURED_PROVIDERS };
  for (const [pattern, preset] of PREFIXES) if (pattern.test(key)) return { preset, candidates: [preset] };
  if (/^sk-[a-f0-9]{32}$/.test(key)) return { candidates: ['deepseek', 'alibaba', 'openai', 'moonshot'] };
  if (key.startsWith('sk-')) return { candidates: ['openai', 'moonshot', 'deepseek', 'alibaba', 'openrouter'] };
  if (/^[A-Za-z0-9]{32}$/.test(key)) return { candidates: ['mistral', 'deepinfra', 'openai', 'anthropic'] };
  if (/^[A-Za-z0-9]{40}$/.test(key)) return { candidates: ['cohere', 'openai', 'anthropic'] };
  if (/^[a-f0-9]{64}$/.test(key)) return { candidates: ['together', 'openai', 'anthropic'] };
  return { candidates: FEATURED_PROVIDERS };
}
