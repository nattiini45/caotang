/**
 * The Obsidian vault helpers (#281, epic #263): classifying a note as a codex entry (by folder,
 * `type:`/`category:` property or tag) and resolving an attachment by its shortest unique path,
 * honouring `.obsidian/app.json`'s `attachmentFolderPath`. Both are pure so the Worker and the
 * preview's codex table share them.
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
  items: 'object',
  objects: 'object',
  object: 'object',
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

/** The first folder segment that names a codex kind, else null. */
function folderType(path: string): CodexType | null {
  const segments = path.split('/').slice(0, -1);
  for (const segment of segments) {
    const type = FOLDER_TYPE[segment.toLowerCase()];
    if (type !== undefined) return type;
  }
  return null;
}

/** Classify a note as a codex entry: its folder, then its `type:`/`category:` property, then a `#tag`. */
export function classifyCodexNote(path: string, props: Record<string, string>, keywords: readonly string[]): CodexType | null {
  const fromFolder = folderType(path);
  if (fromFolder !== null) return fromFolder;
  for (const key of ['type', 'category']) {
    const word = WORD_TYPE[(props[key] ?? '').trim().toLowerCase()];
    if (word !== undefined) return word;
  }
  for (const tag of keywords) {
    const word = WORD_TYPE[tag.toLowerCase()];
    if (word !== undefined) return word;
  }
  return null;
}

/**
 * Resolve an attachment name to a vault path. Obsidian picks the shortest unique path; a configured
 * `attachmentFolderPath` wins when it holds a match. `""` is the vault root, `"./"` the note's own
 * folder, `"./sub"` a subfolder of it, and any other value a named folder.
 */
export function resolveAttachment(target: string, notePath: string, paths: readonly string[], attachmentFolder: string): string | null {
  const name = target.split('/').pop() ?? target;
  const matches = paths.filter((path) => (path.split('/').pop() ?? '') === name);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;

  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
  const preferred = attachmentPrefix(noteDir, attachmentFolder);
  if (preferred !== null) {
    const inFolder = matches.filter((path) => path.startsWith(preferred));
    if (inFolder.length > 0) return shortest(inFolder);
  }
  return shortest(matches);
}

/** The path prefix an `attachmentFolderPath` names, or null when it does not constrain the search. */
function attachmentPrefix(noteDir: string, attachmentFolder: string): string | null {
  const folder = attachmentFolder.trim();
  if (folder === '' || folder === '/') return null;
  if (folder === './') return noteDir === '' ? '' : `${noteDir}/`;
  if (folder.startsWith('./')) {
    const sub = folder.slice(2);
    return noteDir === '' ? `${sub}/` : `${noteDir}/${sub}/`;
  }
  return `${folder.replace(/\/+$/, '')}/`;
}

function shortest(paths: readonly string[]): string {
  return paths.reduce((best, path) => (path.length < best.length ? path : best));
}
