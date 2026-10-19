/**
 * Manifest schema v1 — [project-format.md §2](docs/architecture/project-format.md).
 *
 * Transcribed from the spec, including the additive-by-construction fields
 * (codex, filters, goals, node timestamps, media-track types) and the
 * unknown-tolerant rules that make them safe.
 */

import type { SceneNumbersOption } from '@caotang/bus';

export const APP_ID = 'caotang';
export const FORMAT_VERSION = 1;

/** Fixed roots, reserved and not deletable. */
export const FIXED_ROOT_IDS = ['root', 'manuscript', 'research'] as const;

export interface ProjectIdentity {
  /** "p_" + 10 base32 — generated once, immutable */
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  /**
   * BCP-47 language tag, the source of EPUB's `dc:language` ([epub-metadata.md](docs/architecture/epub-metadata.md)).
   * Additive in format v1; absent means the export derives it from the app locale.
   */
  language?: string;
  /**
   * The EPUB unique identifier: `urn:uuid:…`, generated once and never regenerated, and
   * an optional ISBN (`urn:isbn:…`). Additive in format v1 (epub-metadata.md).
   */
  identifier?: { uuid: string; isbn?: string | null };
  /** An `assets/` file id used as the cover, or null for none (epub-metadata.md). */
  coverAssetId?: string | null;
  /**
   * The author, shown on the title page and as the EPUB `dc:creator` and the DOCX creator (exporter.md §2, {author}).
   * Additive in format v1; absent or empty means the exports carry no byline.
   */
  author?: string;
}

/** exporter.md §2's `ExportRecipe.options`: the per-recipe switches a compile reads. Every key is optional. */
export interface ExportRecipeOptions {
  /** The title page. Absent = the template's default. */
  titlePage?: boolean;
  /** The contents list where the format has one. Absent = the template's default. */
  toc?: boolean;
  /** Overrides the project author for this recipe only. */
  author?: string;
  /** The dialogue table's character limit (dialogue-narrative.md §4). Absent = no limit. */
  charLimit?: number;
  /** The screenplay PDF's scene numbers (screenplay.md §5.3; SCENE_NUMBER_OPTIONS in @caotang/bus). Absent = off. */
  sceneNumbers?: SceneNumbersOption;
  /** `(MORE)` and `(CONT'D)` across a page break in the screenplay PDF (screenplay.md §5.3). Absent = on. */
  continued?: boolean;
  /** The contact sheet's paper (storyboard.md §6). Absent = A4. */
  pageSize?: 'A4' | 'Letter';
}

/**
 * A named, saved export configuration (exporter.md §2). Additive in format v1: a
 * project that never saved one has no `recipes` key at all.
 */
export interface ExportRecipe {
  name: string;
  includeRootIds: string[];
  format: string;
  templateId?: string;
  /** Additive: a recipe saved before options existed has none, and reads as "the template's defaults". */
  options?: ExportRecipeOptions;
}

/** v0.2 media-track widenings are loaders-tolerant: unknown types are kept, never dropped. */
export type NodeType = 'root' | 'folder' | 'document' | (string & {});

export interface TreeNode {
  id: string;
  parentId: string | null;
  type: NodeType;
  title: string;
  /** gap-encoded sibling order, multiples of 10 */
  order: number;
  /** vocabulary id or null; unknown values are kept and shown as an "unknown" chip */
  status: string | null;
  label: string | null;
  /** max 32 entries, each ≤ 64 chars */
  keywords: string[];
  /** ≤ 2000 chars */
  synopsis: string;
  /** ≤ 50_000 chars, plain Markdown, not a docs/ file in v0.1 */
  notes: string;
  /** additive — absent = node never matches date criteria */
  createdAt?: string;
  /** additive — app-owned; structure ops deliberately do not bump it */
  updatedAt?: string;
  /**
   * The media-track kind marker (project-format.md §2, media note): `screenplay` on a document, `storyboard` on a
   * folder, `branching` on a dialogue container. Absent on a plain node. Typed as a string because a later kind must
   * load as a kept, unknown value, not a refused one.
   */
  kind?: string;
  /**
   * A shot's stored metadata (storyboard.md §2.2). The store carries it as an object and does not read its fields:
   * `@caotang/storyboard` owns the vocabulary, and it checks what it reads.
   */
  shot?: Record<string, unknown>;
  /** A dialogue container's metadata (dialogue-narrative.md §2.1): speaker, locBaseline, engineTarget, autoLineIds. */
  dialogue?: Record<string, unknown>;
}

export interface VocabularyTerm {
  id: string;
  name: string;
  color: string;
}

export interface Derived {
  /** rebuildable, allowed stale — never a reason to reject a manifest */
  wordCounts: Record<string, number>;
  computedAt: string;
}

export type CodexIncludePolicy = 'always' | 'detected' | 'never' | 'manual';

/**
 * codex.md §2's `EntrySource`. `from`, `to` and `extractedAt` are in the spec, and
 * they are optional here so a manifest written before they were kept still loads;
 * the serializer writes whichever are present, so a citation is not shortened on
 * the way to disk.
 */
export interface CodexSource {
  docId: string;
  quote: string;
  from?: number;
  to?: number;
  extractedAt?: string;
}

export interface CodexEntry {
  id: string;
  name: string;
  aliases: string[];
  type: string;
  description: string;
  includePolicy: CodexIncludePolicy;
  caseSensitive: boolean;
  exclude: string[];
  /** node ids this entry is attached to */
  attachments: string[];
  keywords: string[];
  /**
   * Visual reference asset ids in `assets/` (video-prompt-pack.md §3): the images a prompt pack sends with a shot that
   * mentions this entry. Additive in format v1; absent reads as none, and the serializer omits the key when there are none.
   */
  visualRefs?: string[];
  /** additive (codex.md §10 K4) — missing on load = 'manual' */
  origin: 'manual' | 'agent' | 'import';
  sources: CodexSource[];
  /**
   * Optional, unlike codex.md §2's type. codex.md §3 fixes the redundancy file's
   * key list at nine keys — timestamps are not among them — so an entry restored
   * by the §5.4 rebuild genuinely has no known creation time. Absent means
   * "never recorded", and the serializer then omits the key, exactly as it does
   * for the additive `tree[].createdAt`. Stamping the recovery instant instead
   * would put a factually wrong date on a year-old entry.
   */
  createdAt?: string;
  updatedAt?: string;
}

/**
 * A saved binder filter (binder-filters §2). `root` is the scope restriction; absent means both roots are searched.
 * The furniture package reads the criteria, so the store keeps them as the JSON the writer saved.
 */
export interface SavedFilter {
  id: string;
  name: string;
  root?: 'manuscript' | 'research';
  criteria: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * A project goal (goals-progress §2.2). This is the spec's shape. The pre-spec `name` and `target`-only record is
 * gone, because its serializer wrote `"name": undefined` for a goal of the spec's shape, which is not valid JSON.
 */
export interface ProjectGoal {
  id: string;
  nodeId: string;
  /** `words`, or `chars` (goals-progress §9.2). Absent (an older manifest) means words. */
  metric: 'words' | 'chars';
  /** `project` (the default, absent when unset), or a weekly or monthly session window (goals-progress §9.3). */
  kind?: 'project' | 'weekly' | 'monthly';
  /**
   * A weekly goal's reset weekday (0 Sunday to 6 Saturday) or a monthly goal's reset day (1 to 28, or `last`), goals-progress §9.3.
   * Absent (and absent in every manifest written before it existed) means the default: the locale's first weekday, or the 1st.
   */
  resetDay?: number | 'last';
  comparator: 'at-least' | 'at-most' | 'about';
  target: number;
  /** A calendar date, `YYYY-MM-DD`. Absent means open-ended. */
  deadline?: string;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Manifest {
  app: typeof APP_ID;
  formatVersion: number;
  project: ProjectIdentity;
  vocabulary: {
    statuses: VocabularyTerm[];
    labels: VocabularyTerm[];
  };
  tree: TreeNode[];
  derived: Derived;
  /** additive in v1; absent = empty codex */
  codex?: CodexEntry[];
  /** additive in v1 (binder-filters.md); absent = no saved queries */
  filters?: SavedFilter[];
  /** additive in v1 (goals-progress.md); absent = no goals */
  goals?: ProjectGoal[];
  /** additive in v1 (exporter.md §2); absent = no saved recipes */
  recipes?: ExportRecipe[];
}
