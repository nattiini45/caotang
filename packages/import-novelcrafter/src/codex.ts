/**
 * The NovelCrafter codex helpers (#292, epic #263): classifying an entry by its type folder, reading the
 * relations `metadata.json` carries, and rendering an entry's research page. All pure, so the Worker and
 * the preview's codex table share them. Custom fields and relations are kept in the research text (the
 * codex field #221 and relation #223 targets), so nothing is dropped silently.
 */

export const CODEX_TYPES = ['character', 'location', 'object', 'lore', 'subplot', 'other'] as const;
export type CodexType = (typeof CODEX_TYPES)[number];

const FOLDER_TYPE: Record<string, CodexType> = {
  characters: 'character',
  character: 'character',
  people: 'character',
  locations: 'location',
  location: 'location',
  places: 'location',
  objects: 'object',
  object: 'object',
  items: 'object',
  item: 'object',
  lore: 'lore',
  subplots: 'subplot',
  subplot: 'subplot',
};

const WORD_TYPE: Record<string, CodexType> = {
  character: 'character',
  person: 'character',
  npc: 'character',
  location: 'location',
  place: 'location',
  setting: 'location',
  object: 'object',
  item: 'object',
  lore: 'lore',
  subplot: 'subplot',
};

/** The codex kind a type folder names (`characters/` → character), else null. */
export function typeFromFolder(name: string): CodexType | null {
  return FOLDER_TYPE[name.trim().toLowerCase()] ?? null;
}

/** The codex kind a `type:`/`category:` word names, else null. */
export function typeFromWord(word: string): CodexType | null {
  return WORD_TYPE[word.trim().toLowerCase()] ?? null;
}

/** One relation `metadata.json` names: the entry it points at, and the kind of link when it says. */
export interface CodexRelation {
  readonly name: string;
  readonly kind: string;
}

/**
 * Read the relations out of a parsed `metadata.json`. NovelCrafter writes them as a list; each item may be a
 * plain name or an object naming the target and the link. Anything unreadable is skipped, never thrown.
 */
export function parseRelations(metadata: unknown): CodexRelation[] {
  if (typeof metadata !== 'object' || metadata === null) return [];
  const raw = (metadata as Record<string, unknown>)['relations'];
  if (!Array.isArray(raw)) return [];
  const out: CodexRelation[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim() !== '') out.push({ name: item.trim(), kind: '' });
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const name = firstString(record, ['name', 'entry', 'target', 'entryName', 'to']);
    if (name === undefined) continue;
    const kind = firstString(record, ['kind', 'type', 'relation', 'relationship', 'label']) ?? '';
    out.push({ name, kind });
  }
  return out;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** How many progressions a `metadata.json` carries (they stay in NovelCrafter; the report counts them). */
export function countProgressions(metadata: unknown): number {
  if (typeof metadata !== 'object' || metadata === null) return 0;
  const raw = (metadata as Record<string, unknown>)['progressions'];
  return Array.isArray(raw) ? raw.length : 0;
}

/** One codex entry read from its folder: `entry.md`, `metadata.json`, `notes.md` and a thumbnail. */
export interface NovelCrafterCodexEntry {
  /** The entry folder's path in the export. */
  readonly path: string;
  readonly name: string;
  readonly type: CodexType;
  readonly aliases: readonly string[];
  readonly keywords: readonly string[];
  /** The `entry.md` body: the entry's description. */
  readonly description: string;
  /** Every unmapped front-matter key, kept verbatim (the codex field target, #221). */
  readonly fields: Readonly<Record<string, string | readonly string[]>>;
  /** The relations `metadata.json` names (the codex relation target, #223). */
  readonly relations: readonly CodexRelation[];
  /** The `notes.md` body. */
  readonly notes: string;
  /** The thumbnail's path in the export, when the entry has one. */
  readonly thumbnail?: string;
}

/**
 * The entry's research page: its description, Connections, notes and custom fields. The name leads so the
 * entry can cite this page when the manuscript does not name it. Nothing the export carried is left out.
 */
export function buildResearchPage(entry: NovelCrafterCodexEntry): string {
  const parts: string[] = [`# ${entry.name}`];
  if (entry.thumbnail !== undefined) parts.push(`![${entry.name}](${entry.thumbnail})`);
  if (entry.description.trim() !== '') parts.push(entry.description.trim());
  if (entry.relations.length > 0) {
    const lines = entry.relations.map((relation) => (relation.kind === '' ? `- ${relation.name}` : `- ${relation.name} (${relation.kind})`));
    parts.push(`## Connections\n\n${lines.join('\n')}`);
  }
  if (entry.notes.trim() !== '') parts.push(`## Notes\n\n${entry.notes.trim()}`);
  const fieldKeys = Object.keys(entry.fields);
  if (fieldKeys.length > 0) {
    const lines = fieldKeys.map((key) => {
      const value = entry.fields[key];
      return `- ${key}: ${Array.isArray(value) ? value.join(', ') : value}`;
    });
    parts.push(`## Fields\n\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}
