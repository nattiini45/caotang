/**
 * The splitter source (import-preview.md §2, import-core.md §5, issue #267): a reader's `ImportDocument` shown in the shared import
 * preview through `splitImport` (`@caotang/import-core`). The source turns the splitter's `Detected` into the rule chips, each chip
 * change into `SplitRules`, the dialog's manual splits into `SplitOverrides`, and the `SplitResult` into the dialog's plan: the
 * proposed tree, the ✂ markers with their reason, the counts, the losses, the sanity flags (a one-click fix where one is obvious)
 * and the splitter's notices as a report list. Every word the writer reads is a catalogue message; the splitter itself carries none
 * (its flags and notices are codes with data, and its title words come from `splitLabels`).
 *
 * The reader half stays outside: `read` turns the reader's own chips and options (an encoding, a paragraph mode, underline as
 * italics) into the document, and the source keeps the last document per reader key, so a rule chip re-runs only the splitter.
 *
 * This module is part of each reader's lazy chunk (text-source.ts, rtf-source.ts), never of the first load.
 */
/* lingui-set comment="The import preview for a manuscript file (plain text, RTF): its rule chips, the reason each split is shown with, its checks and its notices. Interpolated values: count, level, name, unit, marker, title, words, expected, found, families, text, lines, file, label, chapter, number" */

import { plural, t } from '@lingui/core/macro';
import {
  splitImport,
  type ChapterRule,
  type ImportBlock,
  type ImportDocument,
  type LossCode,
  type LossWarning,
  type PatternFamily,
  type ProposedChunk,
  type ProposedNode,
  type SanityFlag,
  type SplitLabels,
  type SplitNotice,
  type SplitReason,
  type SplitResult,
  type SplitRuleInput,
} from '@caotang/import-core';

import { formatCount } from '../i18n/locale.js';
import type {
  ImportPreviewSource,
  PreviewBlock,
  PreviewChip,
  PreviewFlag,
  PreviewLoss,
  PreviewMarker,
  PreviewNode,
  PreviewOption,
  PreviewOverrides,
  PreviewPicture,
  PreviewPlan,
  PreviewReportList,
  PreviewSettings,
  ScanExtra,
} from './model.js';

/** The ids of the rule chips this source draws. */
export const SPLIT_CHIPS = {
  chapters: 'chapters',
  scenes: 'scenes',
  parts: 'parts',
  front: 'front',
  back: 'back',
  toc: 'toc',
  sceneTitles: 'scene-titles',
} as const;

/** What a reader hands the splitter source. */
export interface SplitterSourceInput {
  readonly fileName: string;
  /** The reader's own chips (an encoding, a paragraph mode), drawn before the rule chips. A change re-reads the document. */
  readonly readerChips?: () => readonly PreviewChip[];
  /** The reader's own options (underline as italics, pictures). */
  readonly readerOptions?: () => readonly PreviewOption[];
  /** The document for these settings. Called again only when `readKey` changes. */
  readonly read: (settings: PreviewSettings) => ReaderDocument;
  /** What of the settings the document depends on (the reader chips and options), as one string. */
  readonly readKey: (settings: PreviewSettings) => string;
  /** Reads the file once, with a progress line and a cancel (import-preview.md §2). */
  readonly load?: ImportPreviewSource['load'];
  /** Reads the document for these settings off the main thread (#390); `read` then returns the cached result. */
  readonly prepare?: (settings: PreviewSettings, signal: AbortSignal) => Promise<void>;
  /** Whether the document for these settings is already read. */
  readonly prepared?: (settings: PreviewSettings) => boolean;
  /** Releases the reader (its Worker) when the preview closes. */
  readonly dispose?: () => void;
  /** The id of the reader option that brings the pictures in; off, the pictures leave the bodies and the report says so. */
  readonly picturesOption?: string;
  readonly pictures?: () => readonly PreviewPicture[];
  /** Text the reader kept out of the blocks that the injection scan must still read (RTF hidden text, link targets). */
  readonly scanExtra?: () => readonly ScanExtra[];
  /** Lists the reader adds to the report (the encoding it read the file as). */
  readonly report?: () => readonly PreviewReportList[];
}

/** A reader's document, with any loss the reader reports apart from the document's own (an encoding that does not fit). */
export interface ReaderDocument {
  readonly doc: ImportDocument;
  readonly losses?: readonly PreviewLoss[];
}

// ---------------------------------------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------------------------------------

/** The words the splitter writes into titles, in the interface language (import-core.md §3.1 `SplitOptions.labels`). */
export function splitLabels(): SplitLabels {
  return {
    manuscript: t`Manuscript`,
    beforeChapterOne: t`Before chapter 1`,
    chapter: (n: number) => t`Chapter ${{ number: n }}`,
    scene: (chapter: string, n: number) => t`${{ chapter }} · ${{ number: n }}`,
    unreferencedNotes: t`Unreferenced notes`,
    footnote: (label: string) => t`Footnote ${{ label }}`,
  };
}

function familyWord(family: PatternFamily | 'special'): string {
  switch (family) {
    case 'chapter-word':
      return t`a “Chapter” line`;
    case 'part-word':
      return t`a “Part” line`;
    case 'cjk-chapter':
      return t`a “第…章” line`;
    case 'cjk-part':
      return t`a “第…部” line`;
    case 'korean-chapter':
      return t`a “제 N 장” line`;
    case 'korean-part':
      return t`a “제 N 부” line`;
    case 'number':
      return t`a number line`;
    case 'special':
      return t`a prologue or epilogue line`;
  }
}

/** Why a split is where it is, for its ✂ marker ("Heading 1", "scene break “* * *”", "your split"). */
export function reasonText(reason: SplitReason): string {
  switch (reason.source) {
    case 'heading':
      return t`Heading ${{ level: reason.level }}`;
    case 'style':
      return t`style “${{ name: reason.styleName }}”`;
    case 'pattern':
      return familyWord(reason.family);
    case 'unit':
      return t`a new file “${{ unit: reason.unit }}”`;
    case 'pagebreak':
      return t`page break`;
    case 'break':
      return t`scene break “${{ marker: reason.marker }}”`;
    case 'empty-run': {
      const lines = reason.count;
      return plural(lines, { one: '# empty line', other: '# empty lines' });
    }
    case 'back-matter':
      return t`back matter`;
    case 'manual':
      return t`your split`;
  }
}

/** What an automatic chapter rule settled on, for the "Automatic" choice of the Chapters chip. */
function ruleWord(rule: ChapterRule): string {
  switch (rule.kind) {
    case 'heading':
      return t`Automatic: Heading ${{ level: rule.level }}`;
    case 'style':
      return t`Automatic: style “${{ name: rule.styleName }}”`;
    case 'pattern':
      return t`Automatic: “Chapter” lines`;
    case 'unit':
      return t`Automatic: each file`;
    case 'pagebreak':
      return t`Automatic: page breaks`;
    case 'none':
      return t`Automatic: none found`;
    case 'auto':
      return t`Automatic`;
  }
}

function lossWord(code: LossCode): string {
  switch (code) {
    case 'table':
      return t`A table became paragraphs.`;
    case 'image-unreadable':
      return t`A picture could not be read.`;
    case 'equation':
      return t`An equation was kept as text.`;
    case 'text-box':
      return t`A text box was kept as text.`;
    case 'field':
      return t`A field was kept as its text.`;
    case 'tracked-change':
      return t`A tracked change was not kept.`;
    case 'comment':
      return t`A comment was not kept.`;
    case 'footnote':
      return t`A footnote was not kept.`;
    case 'formatting':
      return t`Formatting was not kept.`;
    case 'embedded-object':
      return t`An embedded object was not kept.`;
    case 'unsupported':
      return t`Something the import cannot read was left out.`;
  }
}

/** A reader's loss as the report lists it: the reader's own words when it gave some, else the code's. */
export function lossOf(warning: LossWarning): PreviewLoss {
  return {
    message: warning.message ?? lossWord(warning.code),
    ...(warning.count === undefined ? {} : { count: warning.count }),
    ...(warning.blockIndex === undefined ? {} : { blockIndex: warning.blockIndex }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Chips → rules
// ---------------------------------------------------------------------------------------------------------------------------

function levelOf(value: string | undefined, prefix: string): number | undefined {
  if (value === undefined || !value.startsWith(prefix)) return undefined;
  const level = Number(value.slice(prefix.length));
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : undefined;
}

function chapterRuleOf(value: string | undefined): ChapterRule {
  const level = levelOf(value, 'heading-');
  if (level !== undefined) return { kind: 'heading', level };
  if (value !== undefined && value.startsWith('style:')) return { kind: 'style', styleName: value.slice('style:'.length) };
  switch (value) {
    case 'pattern':
      return { kind: 'pattern' };
    case 'unit':
      return { kind: 'unit' };
    case 'pagebreak':
      return { kind: 'pagebreak' };
    case 'none':
      return { kind: 'none' };
    default:
      return { kind: 'auto' };
  }
}

function destinationOf(value: string | undefined): 'research' | 'manuscript' | 'skip' {
  return value === 'manuscript' || value === 'skip' ? value : 'research';
}

/** The chips and the manual splits as the splitter's rules (import-core.md §3.1). An unknown or absent chip is the default. */
export function rulesFromSettings(chips: Readonly<Record<string, string>>, overrides: PreviewOverrides): SplitRuleInput {
  const scenes = chips[SPLIT_CHIPS.scenes];
  const sceneLevel = levelOf(scenes, 'heading-');
  const sceneRules =
    sceneLevel !== undefined
      ? { breaks: true, headingLevel: sceneLevel, emptyRuns: false }
      : scenes === 'breaks'
        ? { breaks: true, headingLevel: null, emptyRuns: false }
        : scenes === 'empty'
          ? { breaks: true, headingLevel: 'auto' as const, emptyRuns: true }
          : scenes === 'none'
            ? { breaks: false, headingLevel: null, emptyRuns: false }
            : { breaks: true, headingLevel: 'auto' as const, emptyRuns: false };
  const hasOverrides = overrides.noSplit.length + overrides.sceneAt.length + overrides.chapterAt.length > 0;
  return {
    chapters: chapterRuleOf(chips[SPLIT_CHIPS.chapters]),
    scenes: sceneRules,
    parts: chips[SPLIT_CHIPS.parts] === 'flatten' ? 'flatten' : 'nest',
    frontMatter: destinationOf(chips[SPLIT_CHIPS.front]),
    backMatter: destinationOf(chips[SPLIT_CHIPS.back]),
    skipToc: chips[SPLIT_CHIPS.toc] !== 'keep',
    sceneTitles: chips[SPLIT_CHIPS.sceneTitles] === 'firstWords' ? 'firstWords' : 'numbered',
    ...(hasOverrides ? { overrides: { noSplit: [...overrides.noSplit], sceneAt: [...overrides.sceneAt], chapterAt: [...overrides.chapterAt] } } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Detected → chips
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * The rule chips for a document, from a split with the default rules: every chapter signal the splitter found, with its count, so
 * the writer picks from what is in the file. Chips for Parts, the text before chapter 1, back matter and a table of contents appear
 * only when the file has them.
 */
export function chipsFromSplit(result: SplitResult): PreviewChip[] {
  const d = result.detected;
  const chapterOptions = [{ value: 'auto', label: ruleWord(d.chapterRule) }];
  for (const { level, count } of d.headingLevels) chapterOptions.push({ value: `heading-${level}`, label: t`Heading ${{ level }} (${{ count: formatCount(count) }})` });
  for (const { styleName, count } of d.styles) chapterOptions.push({ value: `style:${styleName}`, label: t`Style “${{ name: styleName }}” (${{ count: formatCount(count) }})` });
  const patternLines = d.families.reduce((sum, family) => sum + family.count, 0);
  if (patternLines > 0) chapterOptions.push({ value: 'pattern', label: t`“Chapter” lines (${{ count: formatCount(patternLines) }})` });
  if (d.units >= 2) chapterOptions.push({ value: 'unit', label: t`Each file (${{ count: formatCount(d.units) }})` });
  if (d.pageBreaks > 0) chapterOptions.push({ value: 'pagebreak', label: t`Page breaks (${{ count: formatCount(d.pageBreaks) }})` });
  chapterOptions.push({ value: 'none', label: t`None: one chapter` });

  const markers = d.markers.reduce((sum, marker) => sum + marker.count, 0);
  const sceneOptions = [
    { value: 'auto', label: t`Automatic` },
    { value: 'breaks', label: t`Break lines only (${{ count: formatCount(markers) }})` },
  ];
  for (const { level, count } of d.headingLevels) sceneOptions.push({ value: `heading-${level}`, label: t`Break lines and Heading ${{ level }} (${{ count: formatCount(count) }})` });
  if (d.emptyRuns > 0) sceneOptions.push({ value: 'empty', label: t`Break lines and two or more empty lines (${{ count: formatCount(d.emptyRuns) }})` });
  sceneOptions.push({ value: 'none', label: t`No scene splits` });

  const chips: PreviewChip[] = [
    { id: SPLIT_CHIPS.chapters, label: t`Chapters at`, value: 'auto', options: chapterOptions },
    { id: SPLIT_CHIPS.scenes, label: t`Scenes at`, value: d.emptyRunsOffered ? 'empty' : 'auto', options: sceneOptions },
  ];
  if (d.parts !== null) {
    chips.push({
      id: SPLIT_CHIPS.parts,
      label: t`Parts`,
      value: 'nest',
      options: [
        { value: 'nest', label: t`A folder for each part` },
        { value: 'flatten', label: t`No part folders (the part in each chapter’s keywords)` },
      ],
    });
  }
  const destinations = [
    { value: 'research', label: t`Research` },
    { value: 'manuscript', label: t`Manuscript` },
    { value: 'skip', label: t`Leave it out` },
  ];
  if (result.frontMatter !== undefined || result.toc !== undefined) chips.push({ id: SPLIT_CHIPS.front, label: t`Text before chapter 1`, value: 'research', options: destinations });
  if (result.backMatter.length > 0) chips.push({ id: SPLIT_CHIPS.back, label: t`Back matter`, value: 'research', options: destinations });
  if (result.toc !== undefined) {
    const lines = result.toc.lines.length;
    chips.push({
      id: SPLIT_CHIPS.toc,
      label: t`Table of contents`,
      value: 'skip',
      options: [
        { value: 'skip', label: plural(lines, { one: 'Leave it out (# line)', other: 'Leave it out (# lines)' }) },
        { value: 'keep', label: t`Keep it with the text before chapter 1` },
      ],
    });
  }
  chips.push({
    id: SPLIT_CHIPS.sceneTitles,
    label: t`Untitled scenes`,
    value: 'numbered',
    options: [
      { value: 'numbered', label: t`Numbered` },
      { value: 'firstWords', label: t`Their first words` },
    ],
  });
  return chips;
}

// ---------------------------------------------------------------------------------------------------------------------------
// SplitResult → plan
// ---------------------------------------------------------------------------------------------------------------------------

/** One block of the text pane. A picture shows as its description; a page break as an empty line. */
export function previewBlockOf(block: ImportBlock): PreviewBlock {
  switch (block.kind) {
    case 'heading':
      return { kind: 'heading', text: block.text };
    case 'para':
      return { kind: 'para', text: block.text };
    case 'break':
      return { kind: 'break', text: block.marker };
    case 'pagebreak':
      return { kind: 'pagebreak', text: '' };
    case 'image':
      return { kind: 'image', text: block.alt.trim() === '' ? t`Picture` : t`Picture: ${{ text: block.alt }}` };
    case 'other':
      return { kind: 'other', text: block.md };
  }
}

/** A Markdown paragraph that is one imported picture, `![alt](import:…)`: what leaves a body when the pictures option is off. */
const PICTURE_PARAGRAPH = /^!\[[^\]\n]*\]\(import:[^)\s]*\)$/u;

/** The body without its imported pictures (each is a paragraph of its own, as the splitter writes them). */
export function withoutPictures(body: string): string {
  return body
    .split('\n\n')
    .filter((part) => !PICTURE_PARAGRAPH.test(part.trim()))
    .join('\n\n');
}

function nodeOf(node: ProposedNode, pictures: boolean): PreviewNode {
  if (node.kind === 'doc') {
    return {
      id: node.id,
      role: node.role,
      title: node.title,
      startBlock: node.startBlock,
      endBlock: node.endBlock,
      words: node.words,
      body: pictures ? node.body : withoutPictures(node.body),
      ...(node.notes === undefined || node.notes === '' ? {} : { notes: node.notes }),
    };
  }
  const children = node.children.map((child) => nodeOf(child, pictures));
  const endBlock = children.reduce((end, child) => Math.max(end, child.endBlock), node.startBlock);
  return {
    id: node.id,
    role: node.role,
    title: node.title,
    startBlock: node.startBlock,
    endBlock,
    words: node.words,
    children,
    ...(node.notes === undefined || node.notes === '' ? {} : { notes: node.notes }),
    ...(node.keywords === undefined || node.keywords.length === 0 ? {} : { keywords: node.keywords }),
  };
}

function chunkOf(chunk: ProposedChunk, pictures: boolean): PreviewNode {
  return {
    id: chunk.id,
    role: chunk.kind,
    title: chunk.title,
    startBlock: chunk.startBlock,
    endBlock: chunk.endBlock,
    words: chunk.words,
    body: pictures ? chunk.body : withoutPictures(chunk.body),
    place: chunk.destination,
    ...(chunk.notes === undefined || chunk.notes === '' ? {} : { notes: chunk.notes }),
  };
}

/** The proposed tree in reading order: the text before chapter 1, the parts and chapters, the back matter where it starts. */
export function treeOf(result: SplitResult, pictures = true): PreviewNode[] {
  const nodes = [
    ...(result.frontMatter === undefined ? [] : [chunkOf(result.frontMatter, pictures)]),
    ...result.tree.map((node) => nodeOf(node, pictures)),
    ...result.backMatter.map((chunk) => chunkOf(chunk, pictures)),
  ];
  // A stable sort: the front matter first, back matter after the chapter it follows.
  return nodes.map((node, index) => ({ node, index })).sort((a, b) => a.node.startBlock - b.node.startBlock || a.index - b.index).map(({ node }) => node);
}

function titleIndex(tree: readonly PreviewNode[]): Map<string, PreviewNode> {
  const out = new Map<string, PreviewNode>();
  const walk = (nodes: readonly PreviewNode[]): void => {
    for (const node of nodes) {
      out.set(node.id, node);
      walk(node.children ?? []);
    }
  };
  walk(tree);
  return out;
}

/** A sanity flag in words (import-core.md §3.7), with a one-click fix where one is obvious. */
export function flagOf(flag: SanityFlag, nodes: ReadonlyMap<string, PreviewNode>, markers: readonly PreviewMarker[]): PreviewFlag {
  const titleOf = (id: string): string => nodes.get(id)?.title ?? id;
  switch (flag.code) {
    case 'chapter-short': {
      const node = nodes.get(flag.nodeId);
      // A chapter that a split starts can join the chapter before it: the split goes.
      const split = node === undefined ? undefined : markers.find((marker) => marker.kind === 'chapter' && marker.blockIndex === node.startBlock);
      return {
        message: t`“${{ title: titleOf(flag.nodeId) }}” is short: ${{ words: formatCount(flag.words) }} words.`,
        nodeId: flag.nodeId,
        ...(split === undefined ? {} : { fix: { label: t`Join it to the chapter before`, overrides: { noSplit: [split.blockIndex] } } }),
      };
    }
    case 'chapter-long':
      return { message: t`“${{ title: titleOf(flag.nodeId) }}” is ${{ words: formatCount(flag.words) }} words long. Check that no chapter heading was missed.`, nodeId: flag.nodeId };
    case 'scene-long':
      return { message: t`The scene “${{ title: titleOf(flag.nodeId) }}” is ${{ words: formatCount(flag.words) }} words long. Check that no scene break was missed.`, nodeId: flag.nodeId };
    case 'number-gap':
      return { message: t`Chapter ${{ expected: flag.expected }} was expected at “${{ title: titleOf(flag.nodeId) }}”, which says ${{ found: flag.found }}.`, nodeId: flag.nodeId };
    case 'number-duplicate':
      return { message: t`The chapter number ${{ found: flag.found }} comes more than once (“${{ title: titleOf(flag.nodeId) }}”).`, nodeId: flag.nodeId };
    case 'mixed-families':
      return { message: t`Chapters are found by more than one kind of line: ${{ families: flag.families.map(familyWord).join(', ') }}.` };
    case 'running-header':
      return { message: t`“${{ text: flag.text }}” comes at ${{ count: formatCount(flag.count) }} page breaks. It may be a running header; it stays in the text.` };
  }
}

function destinationSentence(kind: 'front' | 'back', destination: 'research' | 'manuscript' | 'skip', title: string, words: number): string {
  const count = formatCount(words);
  if (kind === 'front') {
    if (destination === 'manuscript') return t`The text before chapter 1 (${{ words: count }} words) goes into the manuscript.`;
    if (destination === 'skip') return t`The text before chapter 1 (${{ words: count }} words) is left out.`;
    return t`The text before chapter 1 (${{ words: count }} words) goes to Research.`;
  }
  if (destination === 'manuscript') return t`“${{ title }}” (${{ words: count }} words) is back matter and goes into the manuscript.`;
  if (destination === 'skip') return t`“${{ title }}” (${{ words: count }} words) is back matter and is left out.`;
  return t`“${{ title }}” (${{ words: count }} words) is back matter and goes to Research.`;
}

/** A splitter notice in words (import-core.md §4), for the report. */
export function noticeText(notice: SplitNotice, result: SplitResult, nodes: ReadonlyMap<string, PreviewNode>): string {
  switch (notice.code) {
    case 'title-detected':
      return t`“${{ title: result.title?.text ?? '' }}” reads as the book’s title, so it starts no chapter.`;
    case 'toc-skipped': {
      const lines = notice.lines;
      return plural(lines, { one: 'A table of contents (# line) is left out.', other: 'A table of contents (# lines) is left out.' });
    }
    case 'front-matter':
      return destinationSentence('front', notice.destination, '', notice.words);
    case 'back-matter':
      return destinationSentence('back', notice.destination, notice.title, notice.words);
    case 'empty-runs-offered': {
      const count = notice.count;
      return plural(count, {
        one: '# run of empty lines may mark a scene break: Scenes at offers it.',
        other: '# runs of empty lines may mark scene breaks: Scenes at offers them.',
      });
    }
    case 'no-chapters':
      return t`No chapters were found, so the text is one chapter. Choose a rule under Chapters at to split it.`;
    case 'parts-flattened': {
      const parts = notice.parts;
      return plural(parts, { one: '# part has no folder: each of its chapters keeps it in its keywords.', other: '# parts have no folder: each chapter keeps its part in its keywords.' });
    }
    case 'unreferenced-notes': {
      const count = notice.footnotes.length + notice.comments.length;
      const where = notice.nodeId === undefined ? undefined : (nodes.get(notice.nodeId)?.title ?? notice.nodeId);
      return where === undefined
        ? plural(count, { one: '# footnote or comment has no place in the text and cannot be kept.', other: '# footnotes and comments have no place in the text and cannot be kept.' })
        : t`Footnotes and comments with no place in the text (${{ count: formatCount(count) }}) are kept under “Unreferenced notes” in the notes of “${{ title: where }}”.`;
    }
  }
}

/** The dialog's plan for one split: what the writer sees and what Import commits. */
export function planOfSplit(result: SplitResult, blocks: readonly PreviewBlock[], options: { readonly pictures?: boolean; readonly losses?: readonly PreviewLoss[] } = {}): PreviewPlan {
  const pictures = options.pictures ?? true;
  const tree = treeOf(result, pictures);
  const nodes = titleIndex(tree);
  const markers: PreviewMarker[] = result.splits.map((split) => ({ blockIndex: split.blockIndex, kind: split.kind, reason: reasonText(split.reason) }));
  const s = result.stats;
  const losses = [...(options.losses ?? []), ...result.losses.map(lossOf)];
  if (!pictures && s.images > 0) losses.push({ message: t`Pictures are left out: Import pictures is off.`, count: s.images });
  return {
    blocks,
    markers,
    tree,
    counts: {
      words: s.words,
      parts: s.parts,
      chapters: s.chapters,
      scenes: s.scenes,
      images: s.images,
      comments: s.comments + s.unreferencedComments,
      footnotes: s.footnotes + s.unreferencedFootnotes,
    },
    losses,
    flags: result.flags.map((flag) => flagOf(flag, nodes, markers)),
  };
}

/** The splitter's notices as a report list, when there are any. */
export function noticesList(result: SplitResult, tree: readonly PreviewNode[]): PreviewReportList[] {
  if (result.notices.length === 0) return [];
  const nodes = titleIndex(tree);
  const label = t`What the splitter noticed`;
  return [{ heading: label, label, lines: result.notices.map((notice) => noticeText(notice, result, nodes)) }];
}

// ---------------------------------------------------------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------------------------------------------------------

interface ReadState {
  readonly key: string;
  readonly reader: ReaderDocument;
  readonly blocks: readonly PreviewBlock[];
  /** The split with the default rules: what the chips offer. */
  readonly baseline: SplitResult;
}

/** A reader's document in the shared preview, split by `splitImport`. Import commits through `binder.importTree`. */
export function splitterPreviewSource(input: SplitterSourceInput): ImportPreviewSource {
  let state: ReadState | undefined;
  let last: { readonly result: SplitResult; readonly tree: readonly PreviewNode[] } | undefined;
  const labels = splitLabels();

  const stateFor = (settings: PreviewSettings): ReadState => {
    const key = input.readKey(settings);
    if (state?.key === key) return state;
    const reader = input.read(settings);
    state = { key, reader, blocks: reader.doc.blocks.map(previewBlockOf), baseline: splitImport(reader.doc, {}, { labels }) };
    return state;
  };
  const current = (): ReadState => state ?? stateFor({ chips: {}, options: {} });
  const picturesOn = (settings: PreviewSettings): boolean => input.picturesOption === undefined || settings.options[input.picturesOption] !== false;

  return {
    fileName: input.fileName,
    title: t`Import “${{ file: input.fileName }}”`,
    ...(input.load === undefined ? {} : { load: input.load }),
    ...(input.prepare === undefined ? {} : { prepare: input.prepare }),
    ...(input.prepared === undefined ? {} : { prepared: input.prepared }),
    ...(input.dispose === undefined ? {} : { dispose: input.dispose }),
    chips: () => [...(input.readerChips?.() ?? []), ...chipsFromSplit(current().baseline)],
    options: () => input.readerOptions?.() ?? [],
    plan: (settings, overrides) => {
      const read = stateFor(settings);
      const result = splitImport(read.reader.doc, rulesFromSettings(settings.chips, overrides), { labels });
      const plan = planOfSplit(result, read.blocks, { pictures: picturesOn(settings), ...(read.reader.losses === undefined ? {} : { losses: read.reader.losses }) });
      last = { result, tree: plan.tree };
      return plan;
    },
    ...(input.pictures === undefined ? {} : { pictures: input.pictures }),
    ...(input.picturesOption === undefined ? {} : { picturesOption: input.picturesOption }),
    ...(input.scanExtra === undefined ? {} : { scanExtra: input.scanExtra }),
    metadata: () => {
      const meta = current().reader.doc.metadata ?? {};
      const title = last?.result.title?.text ?? meta.title;
      return { ...(title === undefined ? {} : { title }), ...(meta.author === undefined ? {} : { author: meta.author }), ...(meta.language === undefined ? {} : { language: meta.language }) };
    },
    report: () => [...(input.report?.() ?? []), ...(last === undefined ? [] : noticesList(last.result, last.tree))],
    importLabel: (plan) => {
      const chapters = plan.counts.chapters;
      return plural(chapters, { one: 'Import # chapter', other: 'Import # chapters' });
    },
  };
}
