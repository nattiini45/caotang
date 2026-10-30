/**
 * The codex panel's view model: the search and the filter chips, the grouping by type, and the
 * appearance view. Pure functions over the project state, plus one per-session cache. No React.
 *
 * - The search and the chips are codex-panels §2: a case-insensitive substring over name,
 *   aliases and description, and the type and policy filters, composed.
 * - The appearance view is codex-panels §1: the documents whose mention count for the entry is
 *   above zero, in manuscript order, with each count. It is a projection over the mention cache
 *   (`MentionIndex`, codex.md §4), so it runs no detection of its own.
 *
 * The cache is told when the codex changes, and not when a document does: a document is
 * re-scanned when its revision moves, or when its body is not the one it was last scanned with
 * (see `CodexMentions.countsIn`).
 */

import { CODEX_TYPE_ORDER, createMentionIndex, type MentionIndex } from '@caotang/codex';
import {
  getBody,
  getRevision,
  type CodexEntry,
  type CodexIncludePolicy,
  type ProjectState,
  type TreeNode,
} from '@caotang/store';

import { childrenOf } from './binder-model.js';
import { namesCollator } from '../i18n/locale.js';

/** codex.md §2's type names, for a person. The enum itself is the store's. */
export const TYPE_LABELS: Readonly<Record<string, string>> = {
  character: 'Character',
  location: 'Location',
  object: 'Object',
  lore: 'Lore',
  subplot: 'Subplot',
  other: 'Other',
};

/** codex.md §5's four states, in the order §5 lists them. */
export const POLICY_ORDER: readonly CodexIncludePolicy[] = ['always', 'detected', 'manual', 'never'];

export const POLICY_LABELS: Readonly<Record<CodexIncludePolicy, string>> = {
  always: 'Always',
  detected: 'Detected',
  manual: 'Manual',
  never: 'Never',
};

/** What each state does to a generation call, in the words codex.md §5 uses. */
export const POLICY_HELP: Readonly<Record<CodexIncludePolicy, string>> = {
  always: 'Sent with every generation, whether or not it is mentioned.',
  detected: 'Sent when its name or an alias appears in the text being written.',
  manual: 'Sent only in the documents it is attached to.',
  never: 'Never sent. Use it for private notes and spoilers.',
};

/** The search box and the chips. An empty set of types or policies means "all of them". */
export interface CodexFilter {
  readonly query: string;
  readonly types: ReadonlySet<string>;
  readonly policies: ReadonlySet<CodexIncludePolicy>;
}

export const NO_FILTER: CodexFilter = { query: '', types: new Set<string>(), policies: new Set<CodexIncludePolicy>() };

export function isFiltered(filter: CodexFilter): boolean {
  return filter.query.trim().length > 0 || filter.types.size > 0 || filter.policies.size > 0;
}

export function matchesFilter(entry: CodexEntry, filter: CodexFilter): boolean {
  if (filter.types.size > 0 && !filter.types.has(entry.type)) return false;
  if (filter.policies.size > 0 && !filter.policies.has(entry.includePolicy)) return false;
  const query = filter.query.trim().toLowerCase();
  if (query.length === 0) return true;
  return [entry.name, ...entry.aliases, entry.description].some((text) => text.toLowerCase().includes(query));
}

export interface CodexGroup {
  readonly type: string;
  readonly label: string;
  readonly entries: readonly CodexEntry[];
}

/**
 * The entries in groups by type, in codex.md §2's enum order, with unknown types last. Within a
 * group the names are in alphabetical order in the project language (D9), case-insensitively and with numbers by value, so
 * the list reads top to bottom.
 */
export function groupByType(entries: readonly CodexEntry[], projectLanguage?: string): CodexGroup[] {
  const names = namesCollator(projectLanguage);
  const rank = (type: string): number => {
    const at = CODEX_TYPE_ORDER.indexOf(type);
    return at === -1 ? CODEX_TYPE_ORDER.length : at;
  };
  const ordered = [...entries].sort(
    (a, b) =>
      rank(a.type) - rank(b.type) ||
      names.compare(a.name, b.name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const groups: { type: string; label: string; entries: CodexEntry[] }[] = [];
  for (const entry of ordered) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.type === entry.type) {
      last.entries.push(entry);
    } else {
      groups.push({ type: entry.type, label: TYPE_LABELS[entry.type] ?? entry.type, entries: [entry] });
    }
  }
  return groups;
}

/**
 * A name that no entry already has, case-insensitively: `base`, or `base 2`, `base 3`, and so on.
 * The bus refuses a name that collides (codex.md §2), so a new entry starts with one that does not.
 */
export function uniqueName(entries: readonly CodexEntry[], base: string): string {
  const taken = new Set(entries.map((entry) => entry.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The documents of the project in binder order, manuscript first: the order codex-panels §1 asks for. */
export function documentsInOrder(state: ProjectState): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (parentId: string): void => {
    for (const node of childrenOf(state, parentId)) {
      if (node.type === 'document') out.push(node);
      visit(node.id);
    }
  };
  visit('root');
  return out;
}

/**
 * The mention cache for one open project, and the codex it was last told about. `MentionIndex`
 * serves its counts until its codex revision moves, so the revision is moved here whenever the
 * entries differ from the ones it was built on. Comparing the serialised entries is the honest
 * test: an undo restores an entry without going through any command.
 */
export class CodexMentions {
  private readonly index: MentionIndex = createMentionIndex();
  private known: string | null = null;
  /**
   * The body each document was last counted from. An undo is a write too, so the revision moves up with it (command-bus §5)
   * and a revision identifies a body within one open project. The body is still compared, as a second check that costs
   * nothing: a body that differs from this one means the cached count is for other text, and is dropped.
   */
  private readonly counted = new Map<string, string>();

  /** The codex as it stands, with the cache brought up to date with it. Call once per render and pass the result on. */
  entriesOf(state: ProjectState): readonly CodexEntry[] {
    const entries = state.manifest.codex ?? [];
    const signature = JSON.stringify(entries);
    if (signature !== this.known) {
      this.known = signature;
      this.index.bumpCodexRevision();
    }
    return entries;
  }

  /**
   * The mention count of each entry in one document. A document unchanged since its last scan is not scanned again,
   * and one whose body is not the body it was scanned with is scanned again, whatever its revision says.
   */
  countsIn(state: ProjectState, docId: string, entries: readonly CodexEntry[]): ReadonlyMap<string, number> {
    const body = getBody(state, docId);
    if (this.counted.get(docId) !== body) {
      this.index.forget(docId);
      this.counted.set(docId, body);
    }
    // A screenplay's cue names are mentions of their entries, so the index needs the document's kind (screenplay.md §4).
    const kind = state.manifest.tree.find((node) => node.id === docId)?.kind;
    return this.index.hits({ id: docId, revision: getRevision(state, docId), body, ...(kind === undefined ? {} : { kind }) }, entries);
  }

  /** Document scans run since the session began. A test reads it to show that a re-render scans nothing new. */
  get documentPasses(): number {
    return this.index.stats.documentPasses;
  }
}

export interface Appearance {
  readonly docId: string;
  readonly title: string;
  readonly count: number;
}

/** Where one entry appears: each document that mentions it, in manuscript order, with its count. */
export function appearancesOf(
  state: ProjectState,
  entryId: string,
  mentions: CodexMentions,
  entries: readonly CodexEntry[],
): Appearance[] {
  const out: Appearance[] = [];
  for (const doc of documentsInOrder(state)) {
    const count = mentions.countsIn(state, doc.id, entries).get(entryId) ?? 0;
    if (count > 0) out.push({ docId: doc.id, title: doc.title, count });
  }
  return out;
}

/** Each entry's mentions across the whole project: the number a list row shows. */
export function totalsOf(
  state: ProjectState,
  mentions: CodexMentions,
  entries: readonly CodexEntry[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const doc of documentsInOrder(state)) {
    for (const [entryId, count] of mentions.countsIn(state, doc.id, entries)) {
      totals.set(entryId, (totals.get(entryId) ?? 0) + count);
    }
  }
  return totals;
}
