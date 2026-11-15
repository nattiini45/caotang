/**
 * One Kanka entity file (#293, epic #263): `<module>/<name-slug>_<id>.json`, the module's own fields beside
 * `entity: { … }`. Read as data only — nothing here runs, fetches or evaluates. Kanka is Commons Clause; its
 * export was read as format documentation and no code is copied.
 */

/** The codex types the app has (codex.md §2). */
export type KankaCodexType = 'character' | 'location' | 'object' | 'lore' | 'subplot';

export interface KankaAttribute {
  name: string;
  value: string;
  isPrivate: boolean;
  order: number;
}

export interface KankaRelation {
  targetId: number;
  relation: string;
  attitude: number;
  mirrored: boolean;
}

export interface KankaPost {
  name: string;
  entry: string;
  position: number;
}

/** A calendar reminder. `typeId`: 2 birth, 3 death, 4 calendar date, 5 founded (Kanka's own ids). */
export interface KankaReminder {
  typeId: number;
  year: number | null;
  month: number | null;
  day: number | null;
  comment: string;
}

export interface KankaEntity {
  id: number;
  name: string;
  /** The export's folder: `characters`, `locations`, a custom module's own name. */
  module: string;
  /** The writer's own word for what this is, from the entity's `type` field. */
  type: string;
  entry: string;
  isPrivate: boolean;
  imagePath: string;
  parentId: number | null;
  tagIds: number[];
  attributes: KankaAttribute[];
  relations: KankaRelation[];
  posts: KankaPost[];
  reminders: KankaReminder[];
  /** An event's own date, as the writer wrote it. */
  date: string;
}

const TYPES: Readonly<Record<string, KankaCodexType>> = {
  characters: 'character',
  locations: 'location',
  items: 'object',
  quests: 'subplot',
};

/** The codex type a module maps to; everything else, custom modules included, is lore. */
export function codexTypeOf(module: string): KankaCodexType {
  return TYPES[module] ?? 'lore';
}

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null);
const flag = (value: unknown): boolean => value === true || value === 1 || value === '1';

/**
 * One entity file, or null when it carries no entity. The module comes from the path, so a campaign that renamed
 * its modules still maps by what the module is rather than by its label.
 */
export function parseEntityFile(module: string, json: unknown): KankaEntity | null {
  const file = record(json);
  const entity = record(file['entity']);
  const id = number(entity['id']);
  const name = text(entity['name']).trim() !== '' ? text(entity['name']).trim() : text(file['name']).trim();
  if (id === null || name === '') return null;

  const attributes = rows(entity['entityAttributes'])
    .map((row) => ({ name: text(row['name']).trim(), value: text(row['value']).trim(), isPrivate: flag(row['is_private']), order: number(row['default_order']) ?? 0 }))
    .filter((row) => row.name !== '' || row.value !== '')
    .sort((a, b) => a.order - b.order);

  const relations = rows(entity['relationships'])
    .map((row) => ({ targetId: number(row['target_id']) ?? 0, relation: text(row['relation']).trim(), attitude: number(row['attitude']) ?? 0, mirrored: number(row['mirror_id']) !== null }))
    .filter((row) => row.targetId !== 0);

  const posts = rows(entity['posts'])
    .map((row) => ({ name: text(row['name']).trim(), entry: text(row['entry']), position: number(row['position']) ?? 0 }))
    .filter((row) => row.name !== '' || row.entry.trim() !== '')
    .sort((a, b) => a.position - b.position);

  const reminders = rows(entity['reminders'])
    .map((row) => ({ typeId: number(row['type_id']) ?? 0, year: number(row['year']), month: number(row['month']), day: number(row['day']), comment: text(row['comment']).trim() }))
    .filter((row) => row.typeId !== 0);

  return {
    id,
    name,
    module,
    type: text(entity['type']).trim(),
    entry: text(entity['entry']),
    isPrivate: flag(entity['is_private']) || flag(file['is_private']),
    imagePath: text(entity['image_path']).trim(),
    parentId: number(entity['parent_id']),
    tagIds: rows(entity['entityTags']).map((row) => number(row['tag_id'])).filter((value): value is number => value !== null),
    attributes,
    relations,
    posts,
    reminders,
    date: text(file['date']).trim(),
  };
}

/** The module and entity id a file path names: `characters/elena_12.json`. */
export function moduleOfPath(path: string): { module: string; id: number } | null {
  const parts = path.split('/');
  if (parts.length !== 2) return null;
  const file = parts[1] ?? '';
  if (!file.endsWith('.json')) return null;
  const module = parts[0] ?? '';
  if (module === '' || module === 'settings' || module === 'gallery') return null;
  const match = /_(\d+)\.json$/.exec(file);
  if (match === null) return null;
  return { module, id: Number(match[1]) };
}
