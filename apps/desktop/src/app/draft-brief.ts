/**
 * The instruction a sample scene-draft preview sends (context-assembly §5). It is part of the prompt, not interface copy: a
 * translated instruction would preview a different prompt from the one the agent would send, so it stays in the prompt's
 * language ([i18n.md §3.4](../../../../docs/architecture/i18n.md)).
 */
// i18n: model-facing
export const SAMPLE_BRIEF = 'Continue the scene from where it stops.';
