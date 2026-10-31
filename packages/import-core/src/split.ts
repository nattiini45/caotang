/**
 * The splitter (import-core.md §3): one pure function from a reader's `ImportDocument` and a rule set to a proposed binder tree of
 * Part → Chapter → Scene, plus front matter, back matter, the split markers with the reason for each, what was detected (for the
 * preview's rule chips), sanity flags and notices. No DOM, no I/O, no clock: the same input always gives the same output, so the
 * preview re-runs it on every rule change.
 */
import type { ImportBlock, ImportDocument, InjectionHit, LossWarning } from './model.js';
import type { ChapterRule, ChunkDestination, PatternFamily, SplitLabels, SplitRules } from './rules.js';
import { DEFAULT_LABELS, resolveRules } from './rules.js';
import type { SpecialKind } from './text.js';
import {
  breakMarkerOf,
  CHAPTER_FAMILIES,
  countWords,
  firstWords,
  headingStyleLevel,
  isBackMatterTitle,
  isChapterStyle,
  isPartStyle,
  isShortLine,
  isTitleStyle,
  isTocStyle,
  isTocTitle,
  matchFamily,
  numberValue,
  PART_FAMILIES,
  specialOf,
  stripChapterNumber,
  tocKey,
} from './text.js';

// ---------------------------------------------------------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------------------------------------------------------

/** Why a split is where it is, shown on the preview's ✂ marker. */
export type SplitReason =
  | { source: 'heading'; level: number }
  | { source: 'style'; styleName: string }
  | { source: 'pattern'; family: PatternFamily | 'special'; score: number }
  | { source: 'unit'; unit: string }
  | { source: 'pagebreak' }
  | { source: 'break'; marker: string }
  | { source: 'empty-run'; count: number }
  | { source: 'back-matter' }
  | { source: 'manual' };

export interface SplitMarker {
  blockIndex: number;
  kind: 'part' | 'chapter' | 'scene' | 'back-matter';
  reason: SplitReason;
}

/** The story part a chapter folder names (`SceneMeta.storyPart`, coherence.md §5.2.2). Interludes are named but carry none. */
export type ProposedStoryPart = 'prologue' | 'epilogue';

export interface ProposedFolder {
  kind: 'folder';
  /** Stable for one input: the role and the first block (`chapter-12`). */
  id: string;
  role: 'part' | 'chapter';
  title: string;
  startBlock: number;
  words: number;
  children: ProposedNode[];
  storyPart?: ProposedStoryPart;
  /** `parts: 'flatten'` puts the part title here. */
  keywords?: string[];
  notes?: string;
}

export interface ProposedDoc {
  kind: 'doc';
  id: string;
  /** `scene` in a chapter; `text` for a part's own text before its first chapter. */
  role: 'scene' | 'text';
  title: string;
  /** Caotang-dialect Markdown, footnote definitions at the end. */
  body: string;
  startBlock: number;
  /** Last block (inclusive). */
  endBlock: number;
  words: number;
  notes?: string;
}

export type ProposedNode = ProposedFolder | ProposedDoc;

/** Front or back matter: never dropped silently (Caspar's rule), sent where `destination` says. */
export interface ProposedChunk {
  id: string;
  kind: 'front' | 'back';
  title: string;
  body: string;
  startBlock: number;
  endBlock: number;
  words: number;
  destination: ChunkDestination;
  notes?: string;
}

export type SanityFlag =
  | { code: 'chapter-short'; nodeId: string; words: number }
  | { code: 'chapter-long'; nodeId: string; words: number }
  | { code: 'scene-long'; nodeId: string; words: number }
  | { code: 'number-gap'; nodeId: string; expected: number; found: number }
  | { code: 'number-duplicate'; nodeId: string; found: number }
  | { code: 'mixed-families'; families: PatternFamily[] }
  | { code: 'running-header'; text: string; count: number };

export type SplitNotice =
  | { code: 'title-detected'; blockIndex: number }
  | { code: 'toc-skipped'; lines: number }
  | { code: 'front-matter'; destination: ChunkDestination; words: number }
  | { code: 'back-matter'; destination: ChunkDestination; words: number; title: string }
  | { code: 'empty-runs-offered'; count: number }
  | { code: 'no-chapters' }
  | { code: 'parts-flattened'; parts: number }
  /**
   * Footnotes whose `[^label]` reference no block holds, and comments anchored to no block that made it into the tree. Kept, never
   * dropped: written under "Unreferenced notes" in the notes of `nodeId` (the last scene, else the last back-matter or the front
   * chunk). With no chunk at all `nodeId` is absent and the same items are in `losses`.
   */
  | { code: 'unreferenced-notes'; nodeId?: string; footnotes: { blockIndex: number; label: string }[]; comments: number[] };

export interface Detected {
  words: number;
  /** Explicit heading levels in use (title, TOC and back-matter headings left out), with counts. */
  headingLevels: { level: number; count: number }[];
  /** Paragraph styles on short lines used at least twice: the "Style 'X'" chip. */
  styles: { styleName: string; count: number }[];
  /** Pattern families with their candidate counts and whether the repeat rule accepted them. */
  families: { family: PatternFamily; count: number; accepted: boolean }[];
  /** Page breaks with text after them. */
  pageBreaks: number;
  /** Distinct `sourceUnit` values. */
  units: number;
  /** Scene-break markers as written, with counts. */
  markers: { marker: string; count: number }[];
  /** Runs of two or more empty paragraphs. */
  emptyRuns: number;
  /** The weak empty-run signal is worth offering: ≥ 5 runs and no symbol markers. */
  emptyRunsOffered: boolean;
  /** What `auto` resolved to (or the rule as given). */
  chapterRule: ChapterRule;
  /** The heading level that starts scenes, if any. */
  sceneHeadingLevel: number | null;
  /** The heading level or families that make Parts, if any. */
  parts: { level?: number; families?: PatternFamily[] } | null;
}

export interface LocatedInjectionHit extends InjectionHit {
  /** The node or chunk the block ended up in. */
  nodeId?: string;
}

export interface SplitResult {
  /** The book's title: a single top heading or Title style before any other heading, else the reader's metadata. */
  title?: { text: string; blockIndex?: number; source: 'heading' | 'style' | 'metadata' };
  tree: ProposedNode[];
  frontMatter?: ProposedChunk;
  backMatter: ProposedChunk[];
  /** A skipped table of contents, kept here so nothing is lost. */
  toc?: { blockIndices: number[]; lines: string[] };
  splits: SplitMarker[];
  detected: Detected;
  flags: SanityFlag[];
  notices: SplitNotice[];
  losses: LossWarning[];
  injection: LocatedInjectionHit[];
  stats: SplitStats;
}

export interface SplitStats {
  words: number;
  parts: number;
  chapters: number;
  scenes: number;
  images: number;
  /** Footnote definitions written at the end of the scene holding their reference. */
  footnotes: number;
  /** Comments written into the notes of the chunk that owns their block. */
  comments: number;
  /** Footnote definitions with no matching reference: kept under "Unreferenced notes", counted apart (notice `unreferenced-notes`). */
  unreferencedFootnotes: number;
  /** Comments anchored to no block in the result: kept under "Unreferenced notes", counted apart. */
  unreferencedComments: number;
}

export type SplitRuleInput = Parameters<typeof resolveRules>[0];

export interface SplitOptions {
  labels?: Partial<SplitLabels>;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Block facts
// ---------------------------------------------------------------------------------------------------------------------------

interface Fact {
  text: string;
  words: number;
  empty: boolean;
  /** Explicit heading level (heading kind, outline level, "Heading N" style); 0 for none. */
  level: number;
  titleStyle: boolean;
  /** Strong scene-break marker as written, or null. */
  marker: string | null;
  short: boolean;
  family: PatternFamily | null;
  special: SpecialKind | null;
  afterPageBreak: boolean;
  emptyBefore: number;
  emptyAfter: number;
  unit: string | undefined;
  styleName: string | undefined;
  toc: boolean;
}

function blockText(b: ImportBlock): string {
  switch (b.kind) {
    case 'heading':
    case 'para':
      return b.text;
    case 'other':
      return b.md;
    default:
      return '';
  }
}

function factsOf(blocks: ImportBlock[]): Fact[] {
  const facts: Fact[] = new Array(blocks.length);
  let pendingBreak = false;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] as ImportBlock;
    const src = b.kind === 'heading' || b.kind === 'para' || b.kind === 'break' ? b.src : undefined;
    const text = blockText(b).trim();
    const empty = (b.kind === 'para' || b.kind === 'heading') && !text;
    let level = 0;
    if (b.kind === 'heading' && text) level = Math.min(Math.max(Math.round(b.level), 1), 6);
    else if (b.kind === 'para' && text) {
      if (src?.outlineLevel && src.outlineLevel >= 1 && src.outlineLevel <= 9) level = Math.min(Math.round(src.outlineLevel), 6);
      else level = headingStyleLevel(src?.styleName);
    }
    const centered = src?.align === 'center';
    let marker: string | null = null;
    if (b.kind === 'break') marker = b.marker.trim() || '<hr>';
    else if (b.kind === 'heading' && !text) marker = '#';
    else if (b.kind === 'para' && text && level === 0) marker = breakMarkerOf(text, centered);
    const wordish = (b.kind === 'para' || b.kind === 'heading') && !!text && marker === null;
    // Patterns only matter on a short line (or a heading), so long paragraphs skip the regexes.
    const lineish = wordish && text.length <= 80;
    const fam = lineish ? matchFamily(text) : null;
    facts[i] = {
      text,
      words: marker === null ? countWords(text) : 0,
      empty,
      level,
      titleStyle: (b.kind === 'para' || b.kind === 'heading') && !!text && isTitleStyle(src?.styleName),
      marker,
      short: lineish && isShortLine(text),
      family: fam ? fam.family : null,
      special: lineish ? specialOf(text) : null,
      afterPageBreak: pendingBreak || !!src?.pageBreakBefore,
      emptyBefore: src?.emptyBefore ?? 0,
      emptyAfter: src?.emptyAfter ?? 0,
      unit: src?.sourceUnit,
      styleName: src?.styleName,
      toc: !!src?.toc || (b.kind === 'para' && isTocStyle(src?.styleName)),
    };
    if (b.kind === 'pagebreak') pendingBreak = true;
    else if (!empty) pendingBreak = false;
  }
  // Empty paragraphs around each block, counted from the blocks themselves for readers that emit empty paragraphs.
  let run = 0;
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i] as Fact;
    if (f.empty) run++;
    else {
      f.emptyBefore = Math.max(f.emptyBefore, run);
      run = 0;
    }
  }
  run = 0;
  for (let i = facts.length - 1; i >= 0; i--) {
    const f = facts[i] as Fact;
    if (f.empty) run++;
    else {
      f.emptyAfter = Math.max(f.emptyAfter, run);
      run = 0;
    }
  }
  return facts;
}

/** §3 Step A score for a pattern candidate. Pattern signals count only on a short line; 0 when the line cannot be a candidate. */
function scoreOf(f: Fact, b: ImportBlock): number {
  if (!f.short || (!f.family && !f.special)) return 0;
  const src = b.kind === 'heading' || b.kind === 'para' ? b.src : undefined;
  let s = 1; // short line
  s += f.family === 'number' ? 2 : 3;
  if (f.afterPageBreak) s += 2;
  if (src?.align === 'center') s += 1;
  if (src?.allBold || src?.allCaps || (src?.fontSizeRel ?? 0) >= 1.2 || f.level > 0) s += 1;
  if (f.emptyBefore >= 1 && f.emptyAfter >= 1) s += 1;
  return s;
}

const PATTERN_THRESHOLD = 4;

// ---------------------------------------------------------------------------------------------------------------------------
// The splitter
// ---------------------------------------------------------------------------------------------------------------------------

interface Role {
  type: 'part' | 'chapter' | 'scene' | 'back';
  /** The block is the boundary's title or marker, not body text. */
  consume: boolean;
  title?: string;
  reason: SplitReason;
  /** An epilogue when the book has Parts: a chapter at the top level, after the last part, not inside it. */
  topLevel?: boolean;
}

/** Turn a reader's document into a proposed binder tree. Pure: re-run it on every rule change. */
export function splitImport(doc: ImportDocument, ruleInput?: SplitRuleInput, options?: SplitOptions): SplitResult {
  const rules: SplitRules = resolveRules(ruleInput);
  const labels: SplitLabels = { ...DEFAULT_LABELS, ...(options?.labels ?? {}) };
  const blocks = doc.blocks;
  const n = blocks.length;
  const facts = factsOf(blocks);
  let totalWords = 0;
  for (const f of facts) totalWords += f.words;

  const notices: SplitNotice[] = [];
  const flags: SanityFlag[] = [];

  // --- Step D (first half): table of contents and back-matter headings leave the structure counts. ---
  const tocSet = findToc(blocks, facts);
  const isBackName = (i: number): boolean => {
    const f = facts[i] as Fact;
    return (f.level > 0 || f.short || f.titleStyle) && isBackMatterTitle(f.text);
  };

  // --- Step B.2: the book title. ---
  let titleIndex = -1;
  let titleSource: 'heading' | 'style' = 'heading';
  {
    let firstHeading = -1;
    let titleStyleIdx = -1;
    let titleStyleCount = 0;
    for (let i = 0; i < n; i++) {
      if (tocSet.has(i)) continue;
      const f = facts[i] as Fact;
      if (f.titleStyle) {
        titleStyleCount++;
        if (titleStyleIdx < 0) titleStyleIdx = i;
      }
      if (f.level > 0 && firstHeading < 0 && !isBackName(i)) firstHeading = i;
    }
    if (titleStyleCount === 1 && (firstHeading < 0 || titleStyleIdx <= firstHeading)) {
      titleIndex = titleStyleIdx;
      titleSource = 'style';
    } else if (firstHeading >= 0) {
      const top = (facts[firstHeading] as Fact).level;
      let minLevel = 7;
      let countAtTop = 0;
      for (let i = 0; i < n; i++) {
        const f = facts[i] as Fact;
        if (f.level === 0 || tocSet.has(i) || isBackName(i)) continue;
        if (f.level < minLevel) minLevel = f.level;
        if (f.level === top) countAtTop++;
      }
      const chosenLevel = rules.chapters.kind === 'heading' ? rules.chapters.level : 0;
      if (top === minLevel && countAtTop === 1 && chosenLevel !== top) titleIndex = firstHeading;
    }
  }

  // --- Explicit heading levels in use. ---
  const levelCount = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const f = facts[i] as Fact;
    if (f.level === 0 || i === titleIndex || tocSet.has(i) || isBackName(i)) continue;
    levelCount.set(f.level, (levelCount.get(f.level) ?? 0) + 1);
  }
  const usedLevels = [...levelCount.keys()].sort((a, b) => a - b);

  // --- Step A: pattern candidates and the repeat rule. ---
  const scores = new Int8Array(n);
  const familyCount = new Map<PatternFamily, number>();
  for (let i = 0; i < n; i++) {
    if (i === titleIndex || tocSet.has(i) || isBackName(i)) continue;
    const f = facts[i] as Fact;
    const s = scoreOf(f, blocks[i] as ImportBlock);
    scores[i] = s;
    if (s >= PATTERN_THRESHOLD && f.family) familyCount.set(f.family, (familyCount.get(f.family) ?? 0) + 1);
  }
  const repeatOk = (family: PatternFamily, count: number): boolean =>
    PART_FAMILIES.has(family) ? count >= 2 : count >= 3 || (count >= 2 && totalWords < 20_000);
  const acceptedFamilies = new Set<PatternFamily>();
  for (const [family, count] of familyCount) if (repeatOk(family, count)) acceptedFamilies.add(family);

  // --- Styles, units and page breaks, for the chips and the auto order. ---
  const styleCount = new Map<string, number>();
  const units: string[] = [];
  const unitSeen = new Set<string>();
  let pageBreaksWithText = 0;
  for (let i = 0; i < n; i++) {
    const f = facts[i] as Fact;
    const b = blocks[i] as ImportBlock;
    if (f.styleName && f.short && f.level === 0 && !f.titleStyle && !f.toc && i !== titleIndex) {
      styleCount.set(f.styleName, (styleCount.get(f.styleName) ?? 0) + 1);
    }
    if (f.unit !== undefined && !unitSeen.has(f.unit)) {
      unitSeen.add(f.unit);
      units.push(f.unit);
    }
    if (b.kind !== 'pagebreak' && !f.empty && f.afterPageBreak && (i === 0 || isBreakStart(blocks, facts, i))) pageBreaksWithText++;
  }
  const styles = [...styleCount].filter(([, c]) => c >= 2).map(([styleName, count]) => ({ styleName, count }));

  // --- Step B: resolve the chapter rule. ---
  let chapterRule: ChapterRule = rules.chapters;
  if (chapterRule.kind === 'auto') {
    if (usedLevels.some((l) => (levelCount.get(l) ?? 0) >= 2)) {
      const l0 = usedLevels.find((l) => (levelCount.get(l) ?? 0) >= 2) as number;
      const l1 = usedLevels.find((l) => l > l0 && (levelCount.get(l) ?? 0) >= 2);
      chapterRule = { kind: 'heading', level: l1 !== undefined && levelLooksLikeParts(facts, l0, titleIndex) ? l1 : l0 };
    } else {
      const chapterStyle = styles.filter((s) => isChapterStyle(s.styleName)).sort((a, b) => b.count - a.count)[0];
      if (chapterStyle) chapterRule = { kind: 'style', styleName: chapterStyle.styleName };
      else if (units.length >= 2) chapterRule = { kind: 'unit' };
      else if (acceptedFamilies.size > 0) chapterRule = { kind: 'pattern' };
      else if (pageBreaksWithText >= 3) chapterRule = { kind: 'pagebreak' };
      else chapterRule = { kind: 'none' };
    }
  }

  const roles: (Role | undefined)[] = new Array(n);
  let partsInfo: Detected['parts'] = null;

  switch (chapterRule.kind) {
    case 'heading': {
      const level = chapterRule.level;
      let partLevel = 0;
      for (const l of usedLevels) if (l < level && (levelCount.get(l) ?? 0) >= 2) partLevel = l;
      if (partLevel) partsInfo = { level: partLevel };
      for (let i = 0; i < n; i++) {
        const f = facts[i] as Fact;
        if (f.level === 0 || i === titleIndex || tocSet.has(i) || isBackName(i)) continue;
        const reason: SplitReason = { source: 'heading', level: f.level };
        if (f.level === partLevel && f.special) {
          roles[i] = { type: 'chapter', consume: true, title: f.text, reason, topLevel: true };
        } else if (f.level === partLevel) roles[i] = { type: 'part', consume: true, title: f.text, reason };
        else if (f.level <= level) {
          roles[i] = { type: 'chapter', consume: true, title: f.text, reason, ...(partLevel && f.special === 'epilogue' ? { topLevel: true } : {}) };
        }
      }
      break;
    }
    case 'style': {
      const name = chapterRule.styleName;
      for (let i = 0; i < n; i++) {
        const f = facts[i] as Fact;
        if (f.styleName === name && f.text && f.marker === null && i !== titleIndex && !tocSet.has(i) && !isBackName(i)) {
          roles[i] = { type: 'chapter', consume: true, title: f.text, reason: { source: 'style', styleName: name } };
        }
      }
      break;
    }
    case 'unit': {
      let prev: string | undefined;
      let started = false;
      for (let i = 0; i < n; i++) {
        const f = facts[i] as Fact;
        const b = blocks[i] as ImportBlock;
        if (b.kind === 'pagebreak' || f.empty || i === titleIndex || tocSet.has(i)) continue;
        if (!started || f.unit !== prev) {
          started = true;
          prev = f.unit;
          const unit = f.unit ?? '';
          const useBlock = (f.level > 0 || (f.short && (scores[i] ?? 0) >= PATTERN_THRESHOLD)) && f.marker === null;
          roles[i] = {
            type: 'chapter',
            consume: useBlock,
            title: useBlock ? f.text : unitTitle(unit),
            reason: { source: 'unit', unit },
          };
        }
      }
      break;
    }
    case 'pattern': {
      const allowed = chapterRule.families ? new Set(chapterRule.families) : null;
      const use = (fam: PatternFamily): boolean =>
        allowed ? allowed.has(fam) && (familyCount.get(fam) ?? 0) > 0 : acceptedFamilies.has(fam);
      const chapterFams = [...familyCount.keys()].filter((f) => CHAPTER_FAMILIES.has(f) && use(f));
      const partFams = [...familyCount.keys()].filter((f) => PART_FAMILIES.has(f) && use(f));
      const partsAreChapters = chapterFams.length === 0;
      if (!partsAreChapters && partFams.length > 0) partsInfo = { families: partFams };
      const live = chapterFams.length > 0 || partFams.length > 0;
      // A chapter line of another family that the repeat rule did not accept still splits when it carries strong signals of its
      // own (a page break, centring, bold): that is a chapter, not a mention, and the mixed families are flagged (Step F).
      const joins = (fam: PatternFamily, s: number): boolean =>
        !allowed && chapterFams.length > 0 && CHAPTER_FAMILIES.has(fam) && !chapterFams.includes(fam) && s >= PATTERN_THRESHOLD + 2;
      for (let i = 0; i < n; i++) {
        const f = facts[i] as Fact;
        const s = scores[i] ?? 0;
        if (s < PATTERN_THRESHOLD || i === titleIndex || tocSet.has(i) || isBackName(i)) continue;
        if (f.family && (chapterFams.includes(f.family) || joins(f.family, s))) {
          roles[i] = { type: 'chapter', consume: true, title: f.text, reason: { source: 'pattern', family: f.family, score: s } };
        } else if (f.family && partFams.includes(f.family)) {
          roles[i] = {
            type: partsAreChapters ? 'chapter' : 'part',
            consume: true,
            title: f.text,
            reason: { source: 'pattern', family: f.family, score: s },
          };
        } else if (!f.family && f.special && live) {
          roles[i] = {
            type: 'chapter',
            consume: true,
            title: f.text,
            reason: { source: 'pattern', family: 'special', score: s },
            ...(partsInfo && f.special === 'epilogue' ? { topLevel: true } : {}),
          };
        }
      }
      break;
    }
    case 'pagebreak': {
      let chapterNo = 0;
      for (let i = 0; i < n; i++) {
        const f = facts[i] as Fact;
        const b = blocks[i] as ImportBlock;
        if (b.kind === 'pagebreak' || f.empty || !f.afterPageBreak || i === titleIndex || tocSet.has(i)) continue;
        if (!isBreakStart(blocks, facts, i)) continue;
        chapterNo++;
        const useBlock = (f.short || f.level > 0) && f.marker === null;
        roles[i] = {
          type: 'chapter',
          consume: useBlock,
          title: useBlock ? f.text : labels.chapter(chapterNo),
          reason: { source: 'pagebreak' },
        };
      }
      break;
    }
    case 'none':
      break;
  }

  // --- Manual chapter edits. ---
  const ov = rules.overrides ?? {};
  const noSplit = new Set(ov.noSplit ?? []);
  for (const i of ov.chapterAt ?? []) {
    if (i < 0 || i >= n || i === titleIndex) continue;
    const f = facts[i] as Fact;
    const consume = f.marker !== null || (blocks[i] as ImportBlock).kind === 'heading';
    roles[i] = { type: 'chapter', consume, title: consume && f.text ? f.text : '', reason: { source: 'manual' } };
  }
  for (const i of noSplit) if (roles[i] && roles[i]!.type !== 'scene') roles[i] = undefined;

  const hasStructure = roles.some((r) => r && (r.type === 'chapter' || r.type === 'part'));
  const firstBoundary = roles.findIndex((r) => r && (r.type === 'chapter' || r.type === 'part'));

  // --- Step D: back matter after the first chapter. ---
  if (hasStructure) {
    for (let i = firstBoundary + 1; i < n; i++) {
      if (isBackName(i) && !noSplit.has(i) && !tocSet.has(i)) {
        roles[i] = { type: 'back', consume: true, title: (facts[i] as Fact).text, reason: { source: 'back-matter' } };
      }
    }
  }

  // --- Scene heading level. ---
  const chapterLevel = chapterRule.kind === 'heading' ? chapterRule.level : 0;
  let sceneLevel: number | null = null;
  if (typeof rules.scenes.headingLevel === 'number') sceneLevel = rules.scenes.headingLevel;
  else if (rules.scenes.headingLevel === 'auto') {
    const candidate = usedLevels.find((l) => l > chapterLevel);
    if (candidate !== undefined) {
      const chapterStarts: number[] = [];
      for (let i = 0; i < n; i++) if (roles[i]?.type === 'chapter') chapterStarts.push(i);
      const chaptersWith = new Set<number>();
      let total = 0;
      let c = -1;
      for (let i = 0; i < n; i++) {
        if (roles[i]?.type === 'chapter') c = i;
        const f = facts[i] as Fact;
        if (f.level === candidate && !roles[i] && i !== titleIndex && !tocSet.has(i)) {
          total++;
          chaptersWith.add(c);
        }
      }
      const chapters = Math.max(chapterStarts.length, 1);
      if (total >= 3 || (total >= 2 && chaptersWith.size / chapters >= 0.5)) sceneLevel = candidate;
    }
  }

  // --- Step C: scene breaks. ---
  const markerCount = new Map<string, number>();
  let emptyRuns = 0;
  for (let i = 0; i < n; i++) {
    const f = facts[i] as Fact;
    if (f.marker !== null && !tocSet.has(i)) markerCount.set(f.marker, (markerCount.get(f.marker) ?? 0) + 1);
    if (!f.empty && f.emptyBefore >= 2 && i > 0) emptyRuns++;
  }
  const markerTotal = [...markerCount.values()].reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) {
    if (roles[i] || i === titleIndex || tocSet.has(i)) continue;
    const f = facts[i] as Fact;
    if (sceneLevel !== null && f.level === sceneLevel) {
      roles[i] = { type: 'scene', consume: true, title: f.text, reason: { source: 'heading', level: f.level } };
    } else if (f.marker !== null && rules.scenes.breaks) {
      roles[i] = { type: 'scene', consume: true, reason: { source: 'break', marker: f.marker } };
    } else if (rules.scenes.emptyRuns && !f.empty && f.emptyBefore >= 2 && i > 0 && (blocks[i] as ImportBlock).kind !== 'pagebreak') {
      roles[i] = { type: 'scene', consume: false, reason: { source: 'empty-run', count: f.emptyBefore } };
    }
  }
  for (const i of ov.sceneAt ?? []) {
    if (i < 0 || i >= n || roles[i]?.type === 'chapter' || roles[i]?.type === 'part' || roles[i]?.type === 'back') continue;
    const f = facts[i] as Fact;
    roles[i] = { type: 'scene', consume: f.marker !== null, reason: { source: 'manual' } };
  }
  for (const i of noSplit) if (roles[i]?.type === 'scene') roles[i] = undefined;

  // --- Walk: build the tree. ---
  const built = buildTree(doc, blocks, facts, roles, {
    rules,
    labels,
    titleIndex,
    tocSet,
    hasStructure: roles.some((r) => r && (r.type === 'chapter' || r.type === 'part')),
  });

  // --- Step E: titles. ---
  const allChapters: { folder: ProposedFolder; firstInPart: boolean }[] = [];
  const visitChapters = (nodes: ProposedNode[], inPart: boolean): void => {
    let first = true;
    for (const node of nodes) {
      if (node.kind !== 'folder') continue;
      if (node.role === 'part') visitChapters(node.children, true);
      else {
        allChapters.push({ folder: node, firstInPart: inPart && first });
        first = false;
      }
    }
  };
  visitChapters(built.tree, false);
  allChapters.forEach(({ folder }, k) => {
    if (!folder.title) folder.title = labels.chapter(k + 1);
  });
  for (const { folder } of allChapters) {
    const special = specialOf(folder.title);
    if (special === 'prologue' || special === 'epilogue') folder.storyPart = special;
  }
  const rawTitles = new Map(allChapters.map(({ folder }) => [folder.id, folder.title]));
  if (rules.removeChapterNumbers) for (const { folder } of allChapters) folder.title = stripChapterNumber(folder.title);
  const titleScenes = (folder: ProposedFolder): void => {
    let k = 0;
    for (const child of folder.children) {
      if (child.kind !== 'doc') continue;
      k++;
      if (child.title) continue;
      const fw = rules.sceneTitles === 'firstWords' ? firstWords(sceneFirstText(blocks, facts, roles, child)) : '';
      child.title = fw || labels.scene(folder.title, k);
    }
  };
  for (const { folder } of allChapters) titleScenes(folder);

  // --- Step F: sanity flags. ---
  let sceneTotal = 0;
  for (const { folder } of allChapters) {
    if (folder.words < 100) flags.push({ code: 'chapter-short', nodeId: folder.id, words: folder.words });
    else if (folder.words > 25_000) flags.push({ code: 'chapter-long', nodeId: folder.id, words: folder.words });
    for (const child of folder.children) {
      if (child.kind !== 'doc') continue;
      sceneTotal++;
      if (child.words > 10_000) flags.push({ code: 'scene-long', nodeId: child.id, words: child.words });
    }
  }
  const families = new Set<PatternFamily>();
  let prevNum: number | null = null;
  for (const { folder, firstInPart } of allChapters) {
    const raw = rawTitles.get(folder.id) ?? folder.title;
    const m = matchFamily(raw);
    if (!m || PART_FAMILIES.has(m.family)) continue;
    families.add(m.family);
    const value = m.num ? numberValue(m.num) : null;
    if (value === null) continue;
    if (prevNum !== null && !(firstInPart && value === 1)) {
      if (value === prevNum) flags.push({ code: 'number-duplicate', nodeId: folder.id, found: value });
      else if (value !== prevNum + 1) flags.push({ code: 'number-gap', nodeId: folder.id, expected: prevNum + 1, found: value });
    }
    prevNum = value;
  }
  if (families.size > 1) flags.push({ code: 'mixed-families', families: [...families].sort() });
  for (const h of runningHeaders(blocks, facts)) flags.push({ code: 'running-header', ...h });

  // --- Notices. ---
  if (titleIndex >= 0) notices.push({ code: 'title-detected', blockIndex: titleIndex });
  if (tocSet.size > 0 && rules.skipToc) notices.push({ code: 'toc-skipped', lines: tocSet.size });
  if (built.front) notices.push({ code: 'front-matter', destination: built.front.destination, words: built.front.words });
  for (const b of built.back) notices.push({ code: 'back-matter', destination: b.destination, words: b.words, title: b.title });
  const emptyRunsOffered = emptyRuns >= 5 && markerTotal === 0;
  if (emptyRunsOffered && !rules.scenes.emptyRuns) notices.push({ code: 'empty-runs-offered', count: emptyRuns });
  if (allChapters.length <= 1 && !roles.some((r) => r?.type === 'chapter')) notices.push({ code: 'no-chapters' });
  if (rules.parts === 'flatten' && built.partCount > 0) notices.push({ code: 'parts-flattened', parts: built.partCount });
  const orphans = built.orphans;
  if (orphans.footnotes.length > 0 || orphans.comments.length > 0) {
    notices.push({
      code: 'unreferenced-notes',
      ...(orphans.nodeId ? { nodeId: orphans.nodeId } : {}),
      footnotes: orphans.footnotes,
      comments: orphans.comments,
    });
  }

  // --- Splits list. ---
  const splits: SplitMarker[] = [];
  for (let i = 0; i < n; i++) {
    const r = roles[i];
    if (!r) continue;
    if (!built.reached.has(i)) continue;
    splits.push({ blockIndex: i, kind: r.type === 'back' ? 'back-matter' : r.type, reason: r.reason });
  }

  // --- Title. ---
  let title: SplitResult['title'];
  if (titleIndex >= 0) title = { text: (facts[titleIndex] as Fact).text, blockIndex: titleIndex, source: titleSource };
  else if (doc.metadata?.title?.trim()) title = { text: doc.metadata.title.trim(), source: 'metadata' };

  const toc =
    tocSet.size > 0
      ? { blockIndices: [...tocSet].sort((a, b) => a - b), lines: [...tocSet].sort((a, b) => a - b).map((i) => (facts[i] as Fact).text).filter(Boolean) }
      : undefined;

  const losses: LossWarning[] = [...(doc.losses ?? [])];
  for (let i = 0; i < n; i++) {
    const b = blocks[i] as ImportBlock;
    if (b.kind === 'other' && b.loss && !losses.some((l) => l.blockIndex === i && l.code === b.loss)) losses.push({ code: b.loss, blockIndex: i });
  }
  // Nowhere to keep them (no chunk at all): the only case an unreferenced note leaves the import, and it is reported, not silent.
  if (!orphans.nodeId) {
    if (orphans.footnotes.length) losses.push({ code: 'footnote', message: 'Footnotes with no reference and no scene to keep them in.', count: orphans.footnotes.length });
    if (orphans.comments.length) losses.push({ code: 'comment', message: 'Comments anchored to no text and no scene to keep them in.', count: orphans.comments.length });
  }

  const detected: Detected = {
    words: totalWords,
    headingLevels: usedLevels.map((level) => ({ level, count: levelCount.get(level) ?? 0 })),
    styles,
    families: [...familyCount]
      .map(([family, count]) => ({ family, count, accepted: acceptedFamilies.has(family) }))
      .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family)),
    pageBreaks: pageBreaksWithText,
    units: units.length,
    markers: [...markerCount].map(([marker, count]) => ({ marker, count })).sort((a, b) => b.count - a.count),
    emptyRuns,
    emptyRunsOffered,
    chapterRule,
    sceneHeadingLevel: sceneLevel,
    parts: partsInfo,
  };

  let images = 0;
  for (const b of blocks) if (b.kind === 'image') images++;

  return {
    ...(title ? { title } : {}),
    tree: built.tree,
    ...(built.front ? { frontMatter: built.front } : {}),
    backMatter: built.back,
    ...(toc ? { toc } : {}),
    splits,
    detected,
    flags,
    notices,
    losses,
    injection: (doc.injection ?? []).map((h) => {
      const nodeId = ownerAt(built.owner, h.blockIndex);
      return nodeId ? { ...h, nodeId } : { ...h };
    }),
    stats: {
      words: totalWords,
      parts: built.partCount,
      chapters: allChapters.length,
      scenes: sceneTotal,
      images,
      footnotes: built.placed.footnotes,
      comments: built.placed.comments,
      unreferencedFootnotes: orphans.footnotes.length,
      unreferencedComments: orphans.comments.length,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------------

/** The first non-empty block after a page break (or a `pageBreakBefore` block). */
function isBreakStart(blocks: ImportBlock[], facts: Fact[], i: number): boolean {
  const b = blocks[i] as ImportBlock;
  if (b.kind !== 'heading' && b.kind !== 'para' && b.kind !== 'image' && b.kind !== 'other' && b.kind !== 'break') return false;
  const f = facts[i] as Fact;
  if (!f.afterPageBreak) return false;
  if (b.kind !== 'image' && b.kind !== 'other' && b.kind !== 'break' && b.src?.pageBreakBefore) return true;
  for (let j = i - 1; j >= 0; j--) {
    const pb = blocks[j] as ImportBlock;
    if (pb.kind === 'pagebreak') return true;
    if (!(facts[j] as Fact).empty) return false;
  }
  return false;
}

/** Heading level `l0` names Parts when most of its headings read as parts ("Part One", "Teil 2", "第一部") or carry a part style. */
function levelLooksLikeParts(facts: Fact[], l0: number, titleIndex: number): boolean {
  let total = 0;
  let parts = 0;
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i] as Fact;
    if (f.level !== l0 || i === titleIndex) continue;
    total++;
    if ((f.family && PART_FAMILIES.has(f.family)) || isPartStyle(f.styleName)) parts++;
  }
  return total > 0 && parts / total >= 0.5;
}

function unitTitle(unit: string): string {
  const base = unit.split(/[\\/]/u).pop() ?? unit;
  return base.replace(/\.[A-Za-z0-9]{1,6}$/u, '') || unit;
}

/** §3 Step D: a run of ≥ 3 short lines near the start whose texts re-occur later, or blocks marked/styled as a TOC field. */
function findToc(blocks: ImportBlock[], facts: Fact[]): Set<number> {
  const set = new Set<number>();
  const n = blocks.length;
  for (let i = 0; i < n; i++) if ((facts[i] as Fact).toc) set.add(i);
  const horizon = Math.max(40, Math.floor(n * 0.15));
  const lineLike = (i: number): boolean => {
    const f = facts[i] as Fact;
    const b = blocks[i] as ImportBlock;
    if ((b.kind !== 'para' && b.kind !== 'heading') || !f.text || f.marker !== null || f.text.length > 100) return false;
    const key = tocKey(f.text);
    return key.length > 0 && key.length <= 80;
  };
  // Keys of every line-like block, by position, so a TOC line can be matched with a later heading.
  const lastAt = new Map<string, number>();
  for (let i = 0; i < n; i++) if (lineLike(i)) lastAt.set(tocKey((facts[i] as Fact).text), i);
  let i = 0;
  while (i < Math.min(horizon, n)) {
    if (!lineLike(i)) {
      i++;
      continue;
    }
    const run: number[] = [];
    let j = i;
    let lastRunIdx = i;
    while (j < n) {
      const f = facts[j] as Fact;
      if (f.empty || (blocks[j] as ImportBlock).kind === 'pagebreak') {
        j++;
        continue;
      }
      if (!lineLike(j)) break;
      const key = tocKey(f.text);
      const later = lastAt.get(key);
      if (later === undefined || later <= j) break;
      run.push(j);
      lastRunIdx = j;
      j++;
    }
    if (run.length >= 3) {
      // A "Contents" heading right before the run belongs to it.
      for (let k = (run[0] as number) - 1; k >= 0; k--) {
        const f = facts[k] as Fact;
        if (f.empty || (blocks[k] as ImportBlock).kind === 'pagebreak') continue;
        if (isTocTitle(f.text)) set.add(k);
        break;
      }
      for (const r of run) set.add(r);
      i = lastRunIdx + 1;
    } else i++;
  }
  return set;
}

/** Identical short lines just after or just before ≥ 3 page breaks: likely running headers from a PDF conversion. */
function runningHeaders(blocks: ImportBlock[], facts: Fact[]): { text: string; count: number }[] {
  const counts = new Map<string, number>();
  const bump = (i: number): void => {
    const f = facts[i] as Fact;
    if (!f.text || !f.short || f.marker !== null) return;
    counts.set(f.text, (counts.get(f.text) ?? 0) + 1);
  };
  for (let i = 0; i < blocks.length; i++) {
    if ((blocks[i] as ImportBlock).kind !== 'pagebreak') continue;
    for (let j = i + 1; j < blocks.length; j++) {
      if ((facts[j] as Fact).empty) continue;
      if ((blocks[j] as ImportBlock).kind !== 'pagebreak') bump(j);
      break;
    }
    for (let j = i - 1; j >= 0; j--) {
      if ((facts[j] as Fact).empty) continue;
      if ((blocks[j] as ImportBlock).kind !== 'pagebreak') bump(j);
      break;
    }
  }
  return [...counts]
    .filter(([, c]) => c >= 3)
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

function sceneFirstText(blocks: ImportBlock[], facts: Fact[], roles: (Role | undefined)[], doc: ProposedDoc): string {
  for (let i = doc.startBlock; i <= doc.endBlock; i++) {
    const b = blocks[i] as ImportBlock;
    if (roles[i]?.consume) continue;
    if (b.kind === 'para' && (facts[i] as Fact).marker === null && (facts[i] as Fact).text) return (facts[i] as Fact).text;
  }
  return '';
}

// ---------------------------------------------------------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------------------------------------------------------

interface BuildContext {
  rules: SplitRules;
  labels: SplitLabels;
  titleIndex: number;
  tocSet: Set<number>;
  hasStructure: boolean;
}

interface Chunk {
  id: string;
  title: string;
  startBlock: number;
  endBlock: number;
  parts: string[];
  words: number;
  footnotes: string[];
  notes: string[];
  /** A break waiting for content: written as `***` only between content. */
  pendingBreak: boolean;
  /** Blocks this chunk owns (for moving them when an empty chunk is dropped). */
  owned: number[];
}

function newChunk(id: string, title: string, start: number): Chunk {
  return { id, title, startBlock: start, endBlock: start, parts: [], words: 0, footnotes: [], notes: [], pendingBreak: false, owned: [] };
}

function chunkBody(c: Chunk): string {
  const body = c.parts.join('\n\n');
  return c.footnotes.length ? `${body}${body ? '\n\n' : ''}${c.footnotes.join('\n')}` : body;
}

function footnoteDefinition(label: string, md: string): string {
  const lines = md.trim().split('\n');
  return `[^${label}]: ${lines.map((l, k) => (k === 0 || !l.trim() ? l : `    ${l}`)).join('\n')}`;
}

function buildTree(
  doc: ImportDocument,
  blocks: ImportBlock[],
  facts: Fact[],
  roles: (Role | undefined)[],
  ctx: BuildContext,
): {
  tree: ProposedNode[];
  front?: ProposedChunk;
  back: ProposedChunk[];
  owner: (string | undefined)[];
  partCount: number;
  reached: Set<number>;
  placed: { footnotes: number; comments: number };
  orphans: { nodeId?: string; footnotes: { blockIndex: number; label: string }[]; comments: number[] };
} {
  const { rules, labels } = ctx;
  const n = blocks.length;
  const tree: ProposedNode[] = [];
  const back: ProposedChunk[] = [];
  const owner: (string | undefined)[] = new Array(n);
  const reached = new Set<number>();
  const flatten = rules.parts === 'flatten';
  let partCount = 0;

  let front: Chunk | null = null;
  let backChunk: Chunk | null = null;
  let part: ProposedFolder | null = null;
  let chapter: ProposedFolder | null = null;
  let scene: Chunk | null = null;
  let sceneIsText = false;
  let mode: 'front' | 'body' | 'back' = ctx.hasStructure ? 'front' : 'body';
  const pendingOwners: number[] = [];
  const chunkById = new Map<string, Chunk>();

  if (!ctx.hasStructure) {
    chapter = { kind: 'folder', id: 'chapter-0', role: 'chapter', title: labels.manuscript, startBlock: 0, words: 0, children: [] };
    tree.push(chapter);
  }

  const closeScene = (): void => {
    if (!scene) return;
    const s = scene;
    scene = null;
    const hasContent = s.parts.length > 0;
    if (!hasContent && !s.title) {
      // Untitled and empty (only break markers): nothing to keep. Its blocks move on to the next chunk.
      pendingOwners.push(...s.owned);
      return;
    }
    const docNode: ProposedDoc = {
      kind: 'doc',
      id: s.id,
      role: sceneIsText ? 'text' : 'scene',
      title: s.title,
      body: chunkBody(s),
      startBlock: s.startBlock,
      endBlock: s.endBlock,
      words: s.words,
    };
    chunkById.set(s.id, s);
    if (sceneIsText) {
      if (part && !flatten) part.children.push(docNode);
      else tree.push(docNode);
    } else if (chapter) chapter.children.push(docNode);
  };
  const closeChapter = (): void => {
    closeScene();
    chapter = null;
  };
  const closeBack = (): void => {
    if (!backChunk) return;
    chunkById.set(backChunk.id, backChunk);
    back.push({
      id: backChunk.id,
      kind: 'back',
      title: backChunk.title,
      body: chunkBody(backChunk),
      startBlock: backChunk.startBlock,
      endBlock: backChunk.endBlock,
      words: backChunk.words,
      destination: rules.backMatter,
    });
    backChunk = null;
  };

  const target = (i: number): Chunk => {
    if (mode === 'front') {
      if (!front) front = newChunk('front', labels.beforeChapterOne, i);
      return front;
    }
    if (mode === 'back') return backChunk as Chunk;
    if (!scene) {
      if (!chapter) {
        // A part's own text before its first chapter.
        scene = newChunk(`text-${i}`, part ? part.title : '', i);
        sceneIsText = true;
      } else {
        scene = newChunk(`scene-${i}`, '', i);
        sceneIsText = false;
      }
    }
    return scene;
  };
  const adopt = (c: Chunk): void => {
    for (const k of pendingOwners) {
      owner[k] = c.id;
      c.owned.push(k);
    }
    pendingOwners.length = 0;
  };
  const own = (c: Chunk, i: number): void => {
    owner[i] = c.id;
    c.owned.push(i);
  };

  for (let i = 0; i < n; i++) {
    const b = blocks[i] as ImportBlock;
    const f = facts[i] as Fact;
    if (i === ctx.titleIndex || ctx.tocSet.has(i)) {
      if (ctx.tocSet.has(i) && !rules.skipToc && f.text) {
        const c = target(i);
        adopt(c);
        c.parts.push(b.kind === 'heading' || b.kind === 'para' ? b.md : f.text);
        c.endBlock = i;
        own(c, i);
      } else pendingOwners.push(i);
      continue;
    }
    const role = roles[i];
    if (role) {
      if (role.type === 'part') {
        reached.add(i);
        closeChapter();
        if (mode === 'back') closeBack();
        mode = 'body';
        partCount++;
        part = { kind: 'folder', id: `part-${i}`, role: 'part', title: role.title ?? '', startBlock: i, words: 0, children: [] };
        if (!flatten) tree.push(part);
        pendingOwners.push(i);
        continue;
      }
      if (role.type === 'chapter') {
        reached.add(i);
        closeChapter();
        if (mode === 'back') closeBack();
        mode = 'body';
        if (role.topLevel) part = null;
        chapter = { kind: 'folder', id: `chapter-${i}`, role: 'chapter', title: role.title ?? '', startBlock: i, words: 0, children: [] };
        if (part && flatten) chapter.keywords = [part.title];
        if (part && !flatten) part.children.push(chapter);
        else tree.push(chapter);
        if (role.consume) {
          pendingOwners.push(i);
          continue;
        }
      } else if (role.type === 'back') {
        reached.add(i);
        closeChapter();
        if (mode === 'back') closeBack();
        part = null;
        mode = 'back';
        backChunk = newChunk(`back-${i}`, role.title ?? '', i);
        adopt(backChunk);
        own(backChunk, i);
        continue;
      } else if (role.type === 'scene' && mode === 'body' && chapter) {
        // A scene role in front or back matter, or in a part's own text, is not a split: the block is written as content below.
        reached.add(i);
        closeScene();
        scene = newChunk(`scene-${i}`, role.consume && role.reason.source === 'heading' ? role.title ?? '' : '', i);
        sceneIsText = false;
        if (role.consume) {
          pendingOwners.push(i);
          continue;
        }
      }
    }

    // Content.
    if (b.kind === 'pagebreak' || f.empty) {
      continue;
    }
    const c = target(i);
    adopt(c);
    own(c, i);
    c.endBlock = i;
    if (f.marker !== null && b.kind !== 'image' && b.kind !== 'other') {
      // An unsplit break: `***` between content (project-format.md §3), never at the start or end of a chunk.
      if (c.parts.length > 0) c.pendingBreak = true;
      continue;
    }
    if (c.pendingBreak) {
      c.parts.push('***');
      c.pendingBreak = false;
    }
    switch (b.kind) {
      case 'heading':
      case 'para':
      case 'other':
        c.parts.push(b.md);
        break;
      case 'image':
        c.parts.push(`![${b.alt.replace(/[[\]]/gu, '')}](${b.assetRef})`);
        break;
      default:
        break;
    }
    c.words += f.words;
  }
  closeChapter();
  closeBack();

  // Blocks still waiting for an owner (a title or a heading at the very end) go to the last chunk, or the first one.
  if (pendingOwners.length > 0) {
    const lastId = lastChunkId(tree, back) ?? (front ? (front as Chunk).id : undefined);
    if (lastId) for (const k of pendingOwners) owner[k] = lastId;
  }
  // Title and TOC blocks belong to the front matter when there is one.
  if (front) {
    const frontId = (front as Chunk).id;
    if (ctx.titleIndex >= 0) owner[ctx.titleIndex] = frontId;
    for (const k of ctx.tocSet) owner[k] = frontId;
  }

  // Footnotes go to the scene that holds their reference, comments to the chunk that owns their block (decision 3). What has no
  // home is kept under "Unreferenced notes" on the last scene and counted apart: nothing an import removes is lost silently.
  const allChunks = new Map(chunkById);
  if (front) allChunks.set((front as Chunk).id, front);
  const placed = { footnotes: 0, comments: 0 };
  const orphanFootnotes: { blockIndex: number; label: string; md: string }[] = [];
  const orphanComments: { blockIndex: number; md: string; author?: string }[] = [];
  const blockMd = (i: number): string => {
    const b = blocks[i] as ImportBlock;
    return b.kind === 'heading' || b.kind === 'para' || b.kind === 'other' ? b.md : '';
  };
  // Label → first block holding `[^label]`, built once and only when a definition is not on its reference's block (linear time).
  let refIndex: Map<string, number> | undefined;
  const referenceIndex = (): Map<string, number> => {
    const map = new Map<string, number>();
    for (let i = 0; i < n; i++) for (const m of blockMd(i).matchAll(/\[\^([^\]\s]+)\]/gu)) if (!map.has(m[1] as string)) map.set(m[1] as string, i);
    return map;
  };
  for (const fn of doc.footnotes ?? []) {
    const ref = `[^${fn.label}]`;
    let holder = validIndex(fn.blockIndex, n) && blockMd(fn.blockIndex).includes(ref) ? fn.blockIndex : -1;
    // A reader that keyed the definition to the wrong block: the block that really holds the reference wins.
    if (holder < 0) holder = (refIndex ??= referenceIndex()).get(fn.label) ?? -1;
    const id = holder >= 0 ? owner[holder] : undefined;
    const c = id ? allChunks.get(id) : undefined;
    if (c) {
      c.footnotes.push(footnoteDefinition(fn.label, fn.md));
      placed.footnotes++;
    } else orphanFootnotes.push(fn);
  }
  for (const cm of doc.comments ?? []) {
    // A comment on a block that carries no text (an empty paragraph, a page break) goes with the nearest block before it, else after.
    let id: string | undefined;
    if (validIndex(cm.blockIndex, n)) {
      for (let i = cm.blockIndex; i >= 0 && !id; i--) id = owner[i];
      for (let i = cm.blockIndex + 1; i < n && !id; i++) id = owner[i];
    }
    const c = id ? allChunks.get(id) : undefined;
    if (c) {
      c.notes.push(commentNote(cm));
      placed.comments++;
    } else orphanComments.push(cm);
  }
  let orphanHome: string | undefined;
  if (orphanFootnotes.length || orphanComments.length) {
    orphanHome = lastChunkId(tree, []) ?? lastChunkId([], back) ?? (front ? (front as Chunk).id : undefined);
    const c = orphanHome ? allChunks.get(orphanHome) : undefined;
    if (c) {
      const lines = [
        ...orphanFootnotes.map((fn) => `${labels.footnote(fn.label)}: ${fn.md.trim()}`),
        ...orphanComments.map(commentNote),
      ];
      c.notes.push(`**${labels.unreferencedNotes}**\n\n${lines.join('\n\n')}`);
    } else orphanHome = undefined;
  }
  const orphans = {
    ...(orphanHome ? { nodeId: orphanHome } : {}),
    footnotes: orphanFootnotes.map((fn) => ({ blockIndex: fn.blockIndex, label: fn.label })),
    comments: orphanComments.map((cm) => cm.blockIndex),
  };
  // Re-render bodies and notes now the side tables are in.
  const patch = (node: ProposedNode): void => {
    if (node.kind === 'doc') {
      const c = allChunks.get(node.id);
      if (c) {
        node.body = chunkBody(c);
        if (c.notes.length) node.notes = c.notes.join('\n\n');
      }
    } else node.children.forEach(patch);
  };
  tree.forEach(patch);
  for (const bc of back) {
    const c = allChunks.get(bc.id);
    if (c) {
      bc.body = chunkBody(c);
      if (c.notes.length) bc.notes = c.notes.join('\n\n');
    }
  }

  // Word totals.
  const sum = (node: ProposedNode): number => {
    if (node.kind === 'doc') return node.words;
    node.words = node.children.reduce((a, child) => a + sum(child), 0);
    return node.words;
  };
  tree.forEach(sum);

  let frontOut: ProposedChunk | undefined;
  if (front) {
    const fc = front as Chunk;
    frontOut = {
      id: fc.id,
      kind: 'front',
      title: fc.title,
      body: chunkBody(fc),
      startBlock: fc.startBlock,
      endBlock: fc.endBlock,
      words: fc.words,
      destination: rules.frontMatter,
    };
    if (fc.notes.length) frontOut.notes = fc.notes.join('\n\n');
    if (!frontOut.body && !frontOut.notes) frontOut = undefined;
  }

  return { tree, ...(frontOut ? { front: frontOut } : {}), back, owner, partCount, reached, placed, orphans };
}

function validIndex(i: number, n: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < n;
}

function ownerAt(owner: (string | undefined)[], i: number): string | undefined {
  return validIndex(i, owner.length) ? owner[i] : undefined;
}

function commentNote(cm: { md: string; author?: string }): string {
  return cm.author ? `${cm.author}: ${cm.md}` : cm.md;
}

function lastChunkId(tree: ProposedNode[], back: ProposedChunk[]): string | undefined {
  if (back.length) return back[back.length - 1]?.id;
  for (let k = tree.length - 1; k >= 0; k--) {
    const node = tree[k] as ProposedNode;
    if (node.kind === 'doc') return node.id;
    const inner = lastChunkId(node.children, []);
    if (inner) return inner;
  }
  return undefined;
}
