/**
 * The plain-language requests an empty state sends to the agent (ui-modules §0.3: every empty surface carries one actionable
 * next step wired to a real command). Each is sent through the agent controller, the same path a typed request takes, so the
 * plan it makes is the plan the agent panel shows and the writer decides. The demo intents of the inspector's empty state
 * are `DEMO_CHOICES` in `demo.ts`, which the agent panel and the first-run card already use.
 */
// i18n: model-facing
export const EMPTY_STATE_INTENTS = {
  /** The empty manuscript's "Let the agent structure it" (ui-modules §2.4): a `binder.restructure` plan. */
  restructure: 'Structure the manuscript: group its scenes into chapters with clear titles.',
  /** The empty codex's seed card (codex.md §8): a `codex.write` plan drafted from the manuscript. */
  codexSeed: 'Draft codex entries for the people, places and things in my manuscript.',
} as const;
