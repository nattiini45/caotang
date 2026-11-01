/**
 * The intermediate model every document reader emits (import-core.md §2).
 *
 * A reader (DOCX, RTF/Scrivener, Markdown, plain text, EPUB, ODT, HTML) turns its source into one flat list of blocks in reading
 * order. Each block keeps the structural *signals* the source had (a style name, an outline level, centring, a page break before it,
 * bold or capitals, a relative font size, blank lines around it, the file or spine item it came from), and nothing more: deciding
 * where chapters and scenes start is the splitter's job (`split.ts`), done once for every format.
 *
 * Text in a block is already Caotang-dialect Markdown (`md`): CommonMark plus GFM strike and images, footnotes as inline `[^n]`
 * references (decision 3). `text` is the same block as plain text, used for matching and word counts.
 */

/** Paragraph alignment as the source declared it. */
export type Align = 'left' | 'center' | 'right' | 'justify';

/** The structural signals a reader keeps on a block. Every field is optional: a reader fills in what its format has. */
export interface Signals {
  /** The paragraph style's display name as written in the source ("Heading 1", "Chapter Title", "Überschrift 2", "Title"). */
  styleName?: string;
  /** Outline level as a heading level, 1 = top (DOCX `w:outlineLvl` + 1, ODT `text:outline-level`). */
  outlineLevel?: number;
  align?: Align;
  /** Every run of the paragraph is bold. */
  allBold?: boolean;
  /** Every letter of the paragraph is a capital, or the runs are set in caps. */
  allCaps?: boolean;
  /** The paragraph's font size divided by the body text's median size (1 = body size). */
  fontSizeRel?: number;
  /** The paragraph starts on a new page (`w:pageBreakBefore`, `break-before: page`). */
  pageBreakBefore?: boolean;
  /** Empty paragraphs directly before / after this one, for readers that drop empty paragraphs instead of emitting them. */
  emptyBefore?: number;
  emptyAfter?: number;
  /** The unit the block came from: an EPUB spine item, a file in a folder, a Longform scene. A change of unit is a boundary. */
  sourceUnit?: string;
  /** The block is part of a generated table of contents (a Word TOC field, an EPUB `toc` landmark). */
  toc?: boolean;
}

/** Why a reader could not keep a block (or part of it) as it was. The reader's own words go in `LossWarning.message`. */
export type LossCode =
  | 'table'
  | 'image-unreadable'
  | 'equation'
  | 'text-box'
  | 'field'
  | 'tracked-change'
  | 'comment'
  | 'footnote'
  | 'formatting'
  | 'embedded-object'
  | 'unsupported';

export interface HeadingBlock {
  kind: 'heading';
  /** 1–6. An empty heading (`text` is blank) is read as a scene break (§3 Step C). */
  level: number;
  text: string;
  /** The heading as Markdown (`## The Landing`), written into a scene when the heading does not start a chunk. */
  md: string;
  src?: Signals;
}

export interface ParaBlock {
  kind: 'para';
  md: string;
  text: string;
  src?: Signals;
}

/** A break the source marks as such: `<hr>`, a Markdown thematic break, an ODT/DOCX horizontal rule. */
export interface BreakBlock {
  kind: 'break';
  /** The marker as written (`***`, `---`, `<hr>`), counted in the preview. */
  marker: string;
  src?: Signals;
}

export interface PageBreakBlock {
  kind: 'pagebreak';
}

export interface ImageBlock {
  kind: 'image';
  /** The reader's reference to the picture in `ImportDocument.assets`, written as the image's Markdown target. */
  assetRef: string;
  alt: string;
}

/** Content the reader kept in a degraded form (a table as paragraphs, an equation as text). */
export interface OtherBlock {
  kind: 'other';
  md: string;
  loss?: LossCode;
}

export type ImportBlock = HeadingBlock | ParaBlock | BreakBlock | PageBreakBlock | ImageBlock | OtherBlock;

/** A footnote, keyed by the block that holds its `[^label]` reference. The splitter writes the definition at the end of that scene. */
export interface ImportFootnote {
  blockIndex: number;
  label: string;
  /** The definition as Markdown; paragraphs separated by a blank line. */
  md: string;
}

/** A comment, keyed by the block it is anchored to. The splitter puts it in that chunk's notes. */
export interface ImportComment {
  blockIndex: number;
  md: string;
  author?: string;
}

export interface LossWarning {
  code: LossCode;
  /** The reader's description, shown in the losses report. */
  message?: string;
  blockIndex?: number;
  count?: number;
}

/** A passage the injection scan (`scanImport`) flagged, keyed by block. The splitter only locates it in the proposed tree. */
export interface InjectionHit {
  blockIndex: number;
  kind: string;
  excerpt: string;
}

export interface ImportAsset {
  ref: string;
  name?: string;
  mime?: string;
  bytes?: number;
}

export interface ImportMetadata {
  title?: string;
  author?: string;
  language?: string;
  [key: string]: string | undefined;
}

/** A reader's whole output: the blocks plus the side tables (import-core.md §2.2). */
export interface ImportDocument {
  blocks: ImportBlock[];
  footnotes?: ImportFootnote[];
  comments?: ImportComment[];
  metadata?: ImportMetadata;
  assets?: ImportAsset[];
  losses?: LossWarning[];
  injection?: InjectionHit[];
}
