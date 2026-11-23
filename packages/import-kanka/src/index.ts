/**
 * The Kanka reader (#293, epic #263): a JSON campaign export zip read into codex rows and their Research pages —
 * module to codex type, tags and type as keywords, private entities kept manual, attributes and relationships as
 * text, posts as sections, birth and death reminders as a lifespan, events and calendar reminders as a world-history
 * index, and the gallery kept. Over the shared zip reader and XHTML walker; no DOM, no dependency.
 */

export { readKanka, readKankaArchive, type KankaImport, type KankaError, type KankaResult, type KankaReadOptions } from './reader.js';
export { codexTypeOf, moduleOfPath, parseEntityFile, type KankaEntity, type KankaAttribute, type KankaRelation, type KankaPost, type KankaReminder, type KankaCodexType } from './entity.js';
export { campaignName, moduleLabels, parseInfo, versionAtLeast, type KankaInfo } from './campaign.js';
export { rewriteMentions, type MentionResult } from './mentions.js';
export { entityPage, blocksToMarkdown, reminderDate, DEFAULT_KANKA_LABELS, type KankaPage, type KankaLabels, type PageParts, type PageOptions } from './pages.js';
