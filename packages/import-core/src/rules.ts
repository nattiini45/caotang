/**
 * The rule set the preview dialog edits (import-core.md §3.1). Every field has a default, so `splitImport(doc)` alone gives the
 * proposed tree, and changing one chip re-runs the splitter with one field changed.
 */

/** A chapter-pattern family (§3 Step A). Matches count toward the repeat rule only inside one family. */
export type PatternFamily =
  /** "Chapter 3", "Kapitel 1", "1. Kapitel", "Chapitre II", "Capítulo uno", "Глава 5". */
  | 'chapter-word'
  /** "Part One", "Book II", "Teil 1", "Partie 2", "Часть 1". */
  | 'part-word'
  /** "第一章", "第12回", "第3节". */
  | 'cjk-chapter'
  /** "第一部", "第二卷", "第三编", "第四篇". */
  | 'cjk-part'
  /** "제 1 장". */
  | 'korean-chapter'
  /** "제 1 부". */
  | 'korean-part'
  /** A line holding only a number: "3", "IV", "— 12 —". */
  | 'number';

export type ChapterRule =
  /** Explicit headings, then a chapter style, then file/spine units, then accepted pattern families, then page breaks, then none. */
  | { kind: 'auto' }
  /** Headings (explicit, outline level or "Heading N" style) at this level start chapters; a level above with ≥ 2 = Parts. */
  | { kind: 'heading'; level: number }
  /** Paragraphs in this style start chapters. */
  | { kind: 'style'; styleName: string }
  /** Short lines of these families start chapters (all accepted families when `families` is absent). Part families make Parts. */
  | { kind: 'pattern'; families?: PatternFamily[] }
  /** Each change of `Signals.sourceUnit` starts a chapter. */
  | { kind: 'unit' }
  /** Each page break followed by text starts a chapter. */
  | { kind: 'pagebreak' }
  /** No chapter split: one chapter holds everything. */
  | { kind: 'none' };

/** Where a front-matter or back-matter chunk goes. Never dropped silently: `skip` is reported in the result. */
export type ChunkDestination = 'research' | 'manuscript' | 'skip';

export interface SceneRules {
  /** Thematic breaks, empty `#` headings and symbol-only lines split scenes. Default on. */
  breaks: boolean;
  /** Headings at this level start scenes; `'auto'` uses the level below chapters when it is common enough; `null` never. */
  headingLevel: number | 'auto' | null;
  /** Two or more consecutive empty paragraphs split scenes (the weak signal). Default off. */
  emptyRuns: boolean;
}

/**
 * Manual edits from the preview, by block index. They apply after the rules, so a re-run with a changed rule keeps them; the dialog
 * decides whether to keep or discard them when a rule changes.
 */
export interface SplitOverrides {
  /** Remove the split at these blocks: a break stays in the scene as `***`, a heading or chapter line stays as text. */
  noSplit?: number[];
  /** Start a scene at these blocks. */
  sceneAt?: number[];
  /** Start a chapter at these blocks. */
  chapterAt?: number[];
}

export interface SplitRules {
  chapters: ChapterRule;
  scenes: SceneRules;
  /** `nest` emits Part folders holding chapter folders (decision 2); `flatten` puts the part title in each chapter's keywords. */
  parts: 'nest' | 'flatten';
  frontMatter: ChunkDestination;
  backMatter: ChunkDestination;
  /** Skip a detected table of contents (with a notice). Default on. */
  skipToc: boolean;
  /** Strip "Chapter N:" from chapter titles. Default off: the export template can add `{chapterNumber}`. */
  removeChapterNumbers: boolean;
  /** Untitled scenes are "{chapter} · n" (`numbered`) or the scene's first words (`firstWords`). */
  sceneTitles: 'numbered' | 'firstWords';
  overrides?: SplitOverrides;
}

export const DEFAULT_RULES: Readonly<SplitRules> = Object.freeze<SplitRules>({
  chapters: { kind: 'auto' },
  scenes: { breaks: true, headingLevel: 'auto', emptyRuns: false },
  parts: 'nest',
  frontMatter: 'research',
  backMatter: 'research',
  skipToc: true,
  removeChapterNumbers: false,
  sceneTitles: 'numbered',
});

/** Fill a partial rule set from the defaults. `scenes` merges field by field. */
export function resolveRules(partial?: Partial<Omit<SplitRules, 'scenes'>> & { scenes?: Partial<SceneRules> }): SplitRules {
  const p = partial ?? {};
  const rules: SplitRules = {
    chapters: p.chapters ?? DEFAULT_RULES.chapters,
    scenes: { ...DEFAULT_RULES.scenes, ...(p.scenes ?? {}) },
    parts: p.parts ?? DEFAULT_RULES.parts,
    frontMatter: p.frontMatter ?? DEFAULT_RULES.frontMatter,
    backMatter: p.backMatter ?? DEFAULT_RULES.backMatter,
    skipToc: p.skipToc ?? DEFAULT_RULES.skipToc,
    removeChapterNumbers: p.removeChapterNumbers ?? DEFAULT_RULES.removeChapterNumbers,
    sceneTitles: p.sceneTitles ?? DEFAULT_RULES.sceneTitles,
  };
  if (p.overrides) rules.overrides = p.overrides;
  return rules;
}

/**
 * The labels the splitter writes into titles. English by default; the app passes its own through the interface language, so the
 * package carries no message catalog.
 */
export interface SplitLabels {
  /** The one chapter when nothing splits. */
  manuscript: string;
  /** The front-matter chunk. */
  beforeChapterOne: string;
  /** A chapter with no title of its own (page-break and manual chapters). */
  chapter: (n: number) => string;
  /** An untitled scene. */
  scene: (chapterTitle: string, n: number) => string;
}

export const DEFAULT_LABELS: Readonly<SplitLabels> = Object.freeze({
  manuscript: 'Manuscript',
  beforeChapterOne: 'Before chapter 1',
  chapter: (n: number) => `Chapter ${n}`,
  scene: (chapterTitle: string, n: number) => `${chapterTitle} · ${n}`,
});
