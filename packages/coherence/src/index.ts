/**
 * `@caotang/coherence` — plot coherence and continuity (coherence.md), headless.
 *
 * What is in here, and what is not:
 *  - the `coherence.json` model, its codec and its recovery posture;
 *  - the deterministic checks (the closed registry in `checks/index.ts`), the timeline exemption table and the
 *    findings lifecycle (upsert, dismissal, fixed, discard), all pure;
 *  - the model-assisted review as a plan and a run, behind an injected port;
 *  - the three agent tools in the harness's entry shape, with model-facing handlers.
 *
 * - the codex canon ranking (codex.md §2 provenance), which an `import` entry shares with a hand-authored one.
 *
 * What is not: the UI (the findings inbox, the Inspector, the dialogs), the provider
 * adapter, and the codex detector. Each of those is the app's to supply. The `coherence.setSceneMeta` and `coherence.setFindingStatus` bus
 * commands live in `@caotang/bus` and `@caotang/store`, because the dependency runs
 * coherence → store → bus and the rule they share has to sit below both; the rule is
 * re-exported from `scene-meta.ts`.
 */

export * from './model.js';
export * from './ids.js';
export * from './timeline.js';
export * from './scene-meta.js';
export * from './codec.js';
export * from './file.js';
export * from './scope.js';
export * from './mentions.js';
export * from './input.js';
export * from './upsert.js';
export * from './run.js';
export * from './lifecycle.js';
export * from './dismissal.js';
export * from './groups.js';
export * from './type-labels.js';
export * from './world-rules.js';
export * from './knowledge.js';
export * from './canon.js';
export * from './errors.js';
export { DETERMINISTIC_CHECKS, runChecks, type CheckInput, type CheckOutput, type DialogueFacts, type DraftFinding } from './checks/index.js';
export * from './cues.js';
export { groupKey, pairKey, termsOf, resolveEntry, modeOf } from './checks/common.js';
export * from './llm/port.js';
export * from './llm/prompts.js';
export * from './llm/parse.js';
export * from './llm/pairs.js';
export * from './llm/assemble.js';
export * from './llm/review.js';
export * from './tools.js';
