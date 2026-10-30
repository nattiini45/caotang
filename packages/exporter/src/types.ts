/**
 * The exporter's public types — [exporter.md §2](../../../docs/architecture/exporter.md)
 * (selection, recipe, flat blocks, compile log) and §4 (the `Exporter` interface).
 *
 * **Structural on purpose where the store is involved.** `@caotang/store` must not
 * import this package (the dependency runs exporter → store, and an import back
 * would be a cycle), so the command port the bus calls is declared in the store
 * as `ExportCommandPort` in `packages/store/src/commands.ts`, and this package
 * implements that shape without importing it. TypeScript checks the two agree at
 * the call site in `test/exporter.test.ts`.
 */

import type { CommandError } from '@caotang/bus';
import type { ExportRecipeOptions as StoreExportRecipeOptions, ProjectState } from '@caotang/store';

/**
 * The formats this build compiles. The prose formats are exporter.md §2 and §3 (`epub` is §3a's). The rest
 * are the media-track formats of the one-source compile, each compiled from its own package's renderer: the
 * screenplay Fountain and FDX, the dialogue table and compiled Ink, the storyboard shot list and the video
 * prompt pack. The dialogue table and the shot list are written as CSV and as a spreadsheet (XLSX). The screenplay PDF (`pdf`, screenplay.md §5.3) follows: the paginated script, with Courier Prime embedded. The storyboard contact sheet (`contact-sheet-pdf`, storyboard.md §6) is appended last.
 */
export const EXPORT_FORMATS = [
  'md',
  'txt',
  'docx',
  'epub',
  'fountain',
  'fdx',
  'ink-json',
  'dialogue-csv',
  'shot-list-csv',
  'promptpack',
  // The one-source compile's Review row: the coherence report, as Markdown and as JSON. Appended, so the order above holds.
  'coherence-md',
  'coherence-json',
  // The spreadsheet variants of the dialogue table and the shot list (storyboard.md §8 A4, dialogue-narrative.md §6). Appended, so the
  // order above holds.
  'dialogue-xlsx',
  'shot-list-xlsx',
  // The screenplay PDF (screenplay.md §5.3).
  'pdf',
  // The storyboard's contact sheet (storyboard.md §6): a PDF of shot cards. Appended last, so the order above holds.
  'contact-sheet-pdf',
] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * The media-track formats, which the exporter compiles through `media.ts` rather than the prose pipeline. The coherence
 * report is one of them: it is a report of the findings file rather than of the manuscript, but it leaves through the
 * same compile, log and file emitter as the others.
 */
export const MEDIA_FORMATS = [
  'fountain',
  'fdx',
  'ink-json',
  'dialogue-csv',
  'shot-list-csv',
  'promptpack',
  'coherence-md',
  'coherence-json',
  'dialogue-xlsx',
  'shot-list-xlsx',
  'pdf',
  'contact-sheet-pdf',
] as const satisfies readonly ExportFormat[];

export type MediaFormat = (typeof MEDIA_FORMATS)[number];

/** Formats whose artifact is a binary container, which `ArtifactFs` (string-only) cannot hold. */
export const BINARY_FORMATS: readonly ExportFormat[] = ['docx', 'epub', 'dialogue-xlsx', 'shot-list-xlsx', 'pdf', 'contact-sheet-pdf'];

export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

export function isMediaFormat(format: ExportFormat): format is MediaFormat {
  return (MEDIA_FORMATS as readonly string[]).includes(format);
}

export function isBinaryFormat(format: ExportFormat): boolean {
  return BINARY_FORMATS.includes(format);
}

/** The document a `docFilter` is asked about — the in-process view, never the bus's (exporter.md §5). */
export interface FilterDocument {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

/**
 * exporter.md §2: `ExportSelection { includeRootIds, docFilter? }`. A function is
 * not JSON, so `docFilter` cannot cross the command bus; the bus carries
 * `includeRootIds` and nothing else (exporter.md §5).
 */
export interface ExportSelection {
  readonly includeRootIds: readonly string[];
  readonly docFilter?: (doc: FilterDocument) => boolean;
}

/**
 * A recipe's options: the store's type (the one the manifest holds and the bus writes), read-only here. Each key says which formats read it in
 * `packages/store/src/manifest.ts`; the type-equality checks in `test/scene-numbers-union.test.ts` pin its bus-typed fields to the renderers'.
 */
export type ExportRecipeOptions = Readonly<StoreExportRecipeOptions>;

/**
 * exporter.md §2: a named, saved selection — "paperback draft" vs "beta read" are one click. Recipes live in the
 * manifest's `recipes[]`, written through the `recipe.save` and `recipe.delete` commands; the exporter reads them from
 * the state it compiles and never writes them.
 */
export interface ExportRecipe {
  readonly name: string;
  readonly includeRootIds: readonly string[];
  readonly format: ExportFormat;
  readonly templateId?: string;
  readonly options?: ExportRecipeOptions;
}

/**
 * exporter.md §2 stage 2: the linear block list. `frontmatter`, `backmatter` and
 * the copyright/custom kinds are part of the vocabulary; v0.1 only emits
 * `titlepage` (copyright and custom front/back matter land in v0.2, §2).
 */
export type FlatBlock =
  | { readonly kind: 'frontmatter'; readonly fmKind: 'titlepage' | 'copyright' | 'custom'; readonly docId?: string }
  // `synopsis` is the section's `=` line (screenplay.md §2.2): present only when the folder has one. The parity test in
  // test/flat-block-parity.test.ts pins this declaration to the screenplay engine's.
  | { readonly kind: 'chapter'; readonly title: string; readonly level: number; readonly number: number; readonly synopsis?: string }
  // `style` is the scene's export style (exporter.md §2, Per-scene styling): present only when it is not `normal`, so an unstyled
  // scene has the same block it always had.
  | { readonly kind: 'scene'; readonly docId: string; readonly body: string; readonly title: string; readonly number: number; readonly style?: string }
  | { readonly kind: 'separator' }
  | { readonly kind: 'backmatter'; readonly bmKind: 'about-author' | 'custom'; readonly docId?: string };

/**
 * exporter.md §2 stage 4: one entry per compile, appended to `exports/compile-log.json`.
 * The spec's fields are `at, recipe, format, blockCount, wordCount, skippedDocs[],
 * tocIncluded, notes[]`; `output`, `chapterCount` and `sceneCount` are additive.
 */
export interface CompileLogEntry {
  readonly at: string;
  readonly recipe: string;
  readonly format: ExportFormat;
  /** The `exports/` path the artifact was written to, or `null` when none was (a download, or a failed write). */
  readonly output: string | null;
  /** Every `exports/` path the compile wrote, when it wrote more than one (a prompt pack, or an Ink story per container). */
  readonly outputs?: readonly string[];
  readonly blockCount: number;
  readonly chapterCount: number;
  readonly sceneCount: number;
  readonly wordCount: number;
  /** Labels of the documents left out for being empty, e.g. `Chapter 3 → The Call`. */
  readonly skippedDocs: readonly string[];
  readonly tocIncluded: boolean;
  /** Human-readable, in the order they arose. A skipped document always has one. */
  readonly notes: readonly string[];
}

/**
 * exporter.md §4's `{ blob | files[], log }`. `compile()` returns the blob for the
 * download and the log it would append; it writes nothing. The bus path
 * (`commandPort()`) is the one that writes `exports/` (exporter.md §2 stage 4).
 */
export interface ExportResult {
  readonly format: ExportFormat;
  /** The first file's name, mime type and blob. Every file the compile produced is in `files`. */
  readonly fileName: string;
  readonly mimeType: string;
  readonly blob: Blob;
  readonly files: readonly ExportFile[];
  readonly log: CompileLogEntry;
}

/** One file a §4 compile produced: a download, not a write. */
export interface ExportFile {
  readonly fileName: string;
  readonly mimeType: string;
  readonly blob: Blob;
}

/**
 * exporter.md §4, except for the format enum, which now carries `epub`, `preview`, which replaces `previewFlatten` (the Draft), and `proof`
 * (the Proof of a text format).
 * `saveRecipe` is gone: a recipe is written by the bus's `recipe.save` (an undoable command on the manifest), so there is one way to save one.
 */
export interface Exporter {
  compile(selection: ExportSelection, format: ExportFormat, templateId?: string): Promise<ExportResult>;
  preview(request: ExportPreviewRequest): ExportPreview;
  proof(request: ExportPreviewRequest): Promise<ExportProof>;
  listRecipes(): ExportRecipe[];
}

/**
 * What `preview` is asked: the request a bus compile makes, without its clock reading. The recipe, the selection and the template
 * resolve exactly as the compile resolves them, so the Draft is the book the compile would write.
 */
export type ExportPreviewRequest = Omit<ExportCommandRequest, 'at'>;

/** What a compile will record in its log row, known before anything is made: the Draft's numbers and the compile log's are the same. */
export interface ExportPreviewFacts {
  readonly format: ExportFormat;
  readonly blockCount: number;
  readonly chapterCount: number;
  readonly sceneCount: number;
  readonly wordCount: number;
  /** Labels of the documents left out, in the compile log's words, e.g. `Chapter 3 → The Call`. */
  readonly skippedDocs: readonly string[];
  readonly tocIncluded: boolean;
  readonly notes: readonly string[];
}

/**
 * exporter.md §4, the Draft half of the Draft/Proof duality: what a compile would write, and what it would leave out. Nothing is
 * reserved, written, gated or logged, and no command runs.
 *
 * - `draft`: a prose format. The block list the artifact is built from (`flatten`, the compile's own call), with the facts of its log row.
 * - `media`: a media format, which does not go through `flatten`. Its selection gates passed; it has the compile's counts and notes and no block list.
 * - `refused`: the compile would be refused, with the refusal it would get.
 */
export type ExportPreview =
  | (ExportPreviewFacts & { readonly kind: 'draft'; readonly blocks: readonly FlatBlock[]; readonly titlePage: boolean })
  | (ExportPreviewFacts & { readonly kind: 'media' })
  | { readonly kind: 'refused'; readonly error: CommandError };

/** The selection a bus command names: the whole manuscript, or the nodes it lists. */
export type ExportCommandSelection =
  | { readonly kind: 'manuscript' }
  | { readonly kind: 'nodes'; readonly includeRootIds: readonly string[] };

/** What `export.compile` / `export.compileSelection` hand the port. Mirrors the store's `ExportCommandRequest`. */
export interface ExportCommandRequest {
  readonly selection: ExportCommandSelection;
  readonly format: string;
  readonly recipeName?: string;
  readonly templateId?: string;
  readonly at: number;
}

/** What the bus reports back: the compile's facts. Mirrors the store's `ExportCommandDigest`. */
export interface ExportCommandDigest {
  readonly format: string;
  readonly output: string;
  readonly chapterCount: number;
  readonly sceneCount: number;
  readonly blockCount: number;
  readonly wordCount: number;
  readonly skippedDocs: readonly string[];
  readonly tocIncluded: boolean;
  readonly notes: readonly string[];
  /** Every path the compile reserved, when it reserved more than one. `output` is the first. */
  readonly outputs?: readonly string[];
}

/** Mirrors the store's `ExportCommandOutcome`. */
export interface ExportCommandOutcome {
  readonly digest: ExportCommandDigest;
  readonly restoreLabel: string;
  readonly restore: () => void;
}

/** The store-facing port, as this package implements it. Mirrors the store's `ExportCommandPort`. */
export interface ExportCommandPortShape {
  compile(state: ProjectState, request: ExportCommandRequest): ExportCommandOutcome;
}

/** Clock seam, for the log's `at` and the EPUB `dcterms:modified` (log/display only). */
export interface ExporterClock {
  now(): number;
}

/**
 * Metadata the manifest does not carry yet (epub-metadata.md's floor: language,
 * persistent identifier, cover). Supplied by the caller. The identifier is required
 * for an EPUB and is never derived: an EPUB compile without one is refused. An absent
 * language falls back to "en", and the compile log says so.
 */
export interface ExportMetadataInput {
  readonly language?: string;
  /** The persistent identifier. `urn:uuid:` form; a bare UUID is given the prefix (epub-metadata.md). */
  readonly identifier?: string;
  readonly author?: string;
  /** The ISBN as `urn:isbn:` (thirteen digits), when the writer gave one (epub-metadata.md). */
  readonly isbn?: string;
  /** The cover image's asset id, when the writer chose one. The bytes are read from the project's `assets/` at compile. */
  readonly coverAssetId?: string | null;
}

/**
 * The formats whose Proof is the file itself, shown as text: the compile's own renderer runs and its text is returned. Every format not
 * listed has no Proof: today that is the binary containers (DOCX, EPUB, the spreadsheets, the PDFs), which the dialog has no renderer
 * for (exporter.md §7 E5). A test holds this list and `BINARY_FORMATS` to cover `EXPORT_FORMATS` between them.
 */
export const TEXT_PROOF_FORMATS = [
  'md',
  'txt',
  'fountain',
  'fdx',
  'ink-json',
  'dialogue-csv',
  'shot-list-csv',
  'promptpack',
  'coherence-md',
  'coherence-json',
] as const satisfies readonly ExportFormat[];

/** Whether a format has a Proof: it is listed in {@link TEXT_PROOF_FORMATS}. A format added without being listed has none. */
export function hasTextProof(format: ExportFormat): boolean {
  return (TEXT_PROOF_FORMATS as readonly string[]).includes(format);
}

/**
 * exporter.md §4, the Proof half of the Draft/Proof duality: the file the compile would write, made by the compile's own plan and renderer,
 * for a format whose file is text. Nothing is reserved, written, gated or logged, and no command runs.
 *
 * - `text`: the first file the compile would write, as text, with its name and the names of any further files the compile writes with it.
 *   The compile log's notes are the Draft's: no text renderer adds one of its own.
 * - `none`: a binary format. There is no Proof in the browser; the Draft is what goes in.
 * - `refused`: the compile would be refused, with the refusal it would get.
 */
export type ExportProof =
  | {
      readonly kind: 'text';
      readonly format: ExportFormat;
      readonly fileName: string;
      readonly mimeType: string;
      readonly text: string;
      readonly otherFiles: readonly string[];
    }
  | { readonly kind: 'none'; readonly format: ExportFormat }
  | { readonly kind: 'refused'; readonly error: CommandError };
