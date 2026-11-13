/**
 * @caotang/import-obsidian: the Obsidian vault and Longform reader (#281, epic #263).
 *
 * An adapter over the Markdown reader (#280): it resolves Obsidian's wikilinks, embeds, comments,
 * highlights, callouts, block ids, tags and Dataview fields, reads the Longform index, and classifies
 * codex notes, then hands the manuscript to the Markdown reader. No DOM, no third-party dependencies:
 * it runs on the main thread, in a `'self'` Worker and in Node.
 */

export { preprocessObsidian } from './obsidian.js';
export type { ObsidianEmbed, ObsidianPreprocess } from './obsidian.js';
export { parseLongformIndex, chooseDraft } from './longform.js';
export type { LongformIndex, LongformScene } from './longform.js';
export { classifyCodexNote, resolveAttachment, CODEX_TYPES } from './vault.js';
export type { CodexType } from './vault.js';
