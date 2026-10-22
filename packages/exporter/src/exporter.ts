/**
 * The exporter — [exporter.md §4](../../../docs/architecture/exporter.md), and the port the bus's `export.compile`
 * and `export.compileSelection` call. It compiles the prose formats (Markdown, plain text, DOCX, EPUB) and the
 * media-track formats (screenplay Fountain, FDX and PDF, the dialogue table and compiled Ink, the shot list and the
 * video prompt pack — the one-source compile, see `media.ts`).
 *
 * Two entry points share one plan, so they cannot disagree about what a compile is:
 *
 * - {@link ExporterService.compile} is the §4 API. It runs stages 1–3 and returns the blob (or blobs) for a
 *   download. It writes nothing.
 * - {@link ExporterService.commandPort} is what the bus calls. It runs stages 1–2 synchronously (the digest, the
 *   output names, and every media gate), then queues stages 3–4 behind the apply (see `emit.ts` for why it is a
 *   queue). It writes `exports/`.
 *
 * Both build their plan with the same function and render through the same dispatcher inside
 * {@link createExporter}, so the blob a user downloads and the file the bus writes are produced by one code path.
 * The media renderers are synchronous, so a media compile renders inside the plan and its gates refuse before
 * anything is reserved; the DOCX and EPUB renderers and the PDF's font are dynamically imported, so those files render in the queue.
 */

import { ApplyRefusal, DEFAULT_RECIPE_NAME, type CommandError } from '@caotang/bus';
import { ArtifactNotFoundError, identifierUrn, type ArtifactFs, type ProjectState } from '@caotang/store';
import { PDF_MIME } from '@caotang/screenplay';
import type { AssetRecord } from '@caotang/video-prompt-pack';
import type { FontLoader } from '@caotang/pdf-fonts';
import { createEmitter, splitRendered, type ByteArtifacts, type Emitter, type EmitFailure, type RenderedContents } from './emit.js';
import {
  ExportUnavailableError,
  NoPersistentIdentifierError,
  UnknownExportFormatError,
  UnknownRecipeError,
  UnknownSelectionNodeError,
} from './errors.js';
import { flatten, type FlattenResult } from './flatten.js';
import { SCENE_STYLE_ROWS, droppedStyleNotes, type SceneStyleRow } from './scene-style.js';
import { imageSizeOf } from './image-size.js';
import { renderMedia, type MediaFile } from './media.js';
import { renderDocx, DOCX_MIME } from './render-docx.js';
import { renderEpub, EPUB_MIME, type EpubInput } from './render-epub.js';
import { XLSX_MIME } from './render-xlsx.js';
import { renderMarkdown, renderText } from './render-text.js';
import type { RenderInput } from './render-input.js';
import { DEFAULT_TEMPLATE_ID, fileStem, resolveTemplate } from './template.js';
import {
  isBinaryFormat,
  isExportFormat,
  isMediaFormat,
  type CompileLogEntry,
  type ExportCommandDigest,
  type ExportCommandOutcome,
  type ExportCommandPortShape,
  type ExportCommandRequest,
  type ExportFile,
  type ExportFormat,
  type ExportMetadataInput,
  type ExportRecipe,
  type ExportRecipeOptions,
  type ExportResult,
  type ExportSelection,
  type Exporter,
  type ExporterClock,
  type FlatBlock,
  type MediaFormat,
} from './types.js';

export interface ExporterOptions {
  /** The project being compiled, read at each call — the state changes between commands. */
  readonly readState: () => ProjectState;
  /** `exports/` and the compile log. The same folder the store writes. */
  readonly artifacts: ArtifactFs;
  /** Where DOCX and EPUB artifacts go. Without it, those two are compiled for download only. */
  readonly bytes?: ByteArtifacts;
  readonly clock?: ExporterClock;
  /**
   * The project's EPUB and byline fields, read from the state each compile (epub-metadata.md). An EPUB compile with no
   * identifier is refused, because an identifier is never derived. An absent language falls back to "en", and the
   * compile log says so. The app supplies these from the manifest; without this callback every field is absent.
   */
  readonly metadata?: (state: ProjectState) => ExportMetadataInput;
  /**
   * The stored images, by asset id, with their file names (storyboard.md §2.1). The shot list's image column and
   * the prompt pack's reference files read them. Read synchronously, like `metadata`: a compile is synchronous
   * (exporter.md §2), and the app lists the asset folder asynchronously. Without it, every shot's image reads as
   * having no file, which the pack and the list both say.
   */
  readonly assets?: (state: ProjectState) => ReadonlyMap<string, AssetRecord>;
  /**
   * Reads one file of the project's `assets/` store by its path, or gives `null` when the store does not hold it. The cover
   * is read through it (epub-metadata.md): the app passes its project asset store, so a cover comes from wherever the
   * writer's import put it, the project folder or this page's memory. Without it, the cover is read from `artifacts`.
   */
  readonly readAsset?: (path: string) => Promise<Uint8Array | null>;
  /**
   * Reads the PDF fallback font (Noto Sans Mono CJK SC, `@caotang/font-noto-cjk`) for the screenplay PDF's and the contact
   * sheet's text outside Latin script. The app fetches it from its own origin; Node reads it from `@caotang/font-noto-cjk`
   * (`@caotang/pdf-fonts/node-loader`). It is called only when a file holds such text. Without it, that text is drawn as `?`,
   * and the compile log says so.
   */
  readonly loadFallbackFont?: FontLoader;
  /**
   * Reads the PDF emoji font (Noto Emoji, monochrome, `@caotang/font-noto-emoji`) for emoji, the same way: the app from its
   * own origin, Node from the package. It is called only when a file holds an emoji. Without it, emoji are drawn as `?`, and
   * the compile log says so.
   */
  readonly loadEmojiFont?: FontLoader;
  /**
   * Reads Noto Sans Arabic (`@caotang/font-noto-arabic`), Noto Sans Hebrew (`@caotang/font-noto-hebrew`) and Noto Sans Devanagari
   * (`@caotang/font-noto-devanagari`) for both PDFs' Arabic, Persian, Urdu, Hebrew, Hindi, Marathi, Nepali and Sanskrit text, the
   * same way. Each is called only when a file holds its script. Without one, that script is drawn as `?`, and the compile log says so.
   */
  readonly loadArabicFont?: FontLoader;
  readonly loadHebrewFont?: FontLoader;
  readonly loadDevanagariFont?: FontLoader;
  /**
   * The scene styles and the formats that express them (exporter.md §2, Per-scene styling). Absent is the build's own rows
   * (`section`, in all four prose formats); a test supplies a row a format lacks to reach the compile log's dropped-style note.
   */
  readonly sceneStyles?: readonly SceneStyleRow[];
}

/** A bus export command as a caller dispatches it: its name, and the params the bus validated for it. */
export interface ExportDispatch {
  readonly name: 'export.compile' | 'export.compileSelection';
  readonly params: Readonly<Record<string, unknown>>;
}

/** The exporter as a service: the §4 interface, plus what an app needs to run it. */
export interface ExporterService extends Exporter {
  /** Resolves once `exports/` has been listed. The bus port refuses until then. */
  ready(): Promise<void>;
  /** Resolves when every queued write, log append and removal has settled. */
  idle(): Promise<void>;
  /** Failures recorded by the queue, in the order they ran. */
  failures(): readonly EmitFailure[];
  /** The store-facing port: pass it as `createProjectCommandRegistry({ exporter })`. */
  commandPort(): ExportCommandPortShape;
  /**
   * The refusal the compile would get if its dispatch ran now against `state`, or `undefined` when it would be made. Nothing is reserved
   * or written: the apply's own checks run, and stop before the first name is reserved. `at` is the clock reading the apply would pass.
   * A caller that asks the writer first uses this, so the question is asked only for a compile that would be made (the MCP server's
   * write-confirm). A failure that is not a refusal is a defect, and it is thrown.
   */
  refusalOf(state: ProjectState, dispatch: ExportDispatch, at: number): CommandError | undefined;
}

/**
 * The port request a bus export dispatch makes. This is the mapping the store's export applies make (store commands.ts): a whole-manuscript
 * command names the manuscript and passes its recipe through, and a part command names its nodes. The params are the bus's, already checked.
 */
function requestOfDispatch(dispatch: ExportDispatch, at: number): ExportCommandRequest {
  const params = dispatch.params;
  const selection: ExportCommandRequest['selection'] =
    dispatch.name === 'export.compileSelection'
      ? { kind: 'nodes', includeRootIds: Array.isArray(params['includeRootIds']) ? params['includeRootIds'].map(String) : [] }
      : { kind: 'manuscript' };
  return {
    selection,
    format: String(params['format']),
    ...(typeof params['recipeName'] === 'string' ? { recipeName: params['recipeName'] } : {}),
    ...(typeof params['templateId'] === 'string' ? { templateId: params['templateId'] } : {}),
    at,
  };
}

/** The recipe a project that predates recipes holds (exporter.md §4). Its name is the bus's, which the bus checks an export against. */
const DEFAULT_RECIPE: ExportRecipe = {
  name: DEFAULT_RECIPE_NAME,
  includeRootIds: ['manuscript'],
  format: 'docx',
  templateId: DEFAULT_TEMPLATE_ID,
  options: {},
};

/** The extension each format's artifact takes. A prompt pack's canonical artifact is its JSON. */
const EXTENSION: Record<ExportFormat, string> = {
  md: 'md',
  txt: 'txt',
  docx: 'docx',
  epub: 'epub',
  fountain: 'fountain',
  fdx: 'fdx',
  'ink-json': 'json',
  'dialogue-csv': 'csv',
  'shot-list-csv': 'csv',
  promptpack: 'json',
  'coherence-md': 'md',
  'coherence-json': 'json',
  'dialogue-xlsx': 'xlsx',
  'shot-list-xlsx': 'xlsx',
  pdf: 'pdf',
  'contact-sheet-pdf': 'pdf',
};

/**
 * The MIME type each format's artifact carries. Exported so that a UI offering a format reads its type from here,
 * rather than keeping a table of its own that can fall behind `EXPORT_FORMATS`.
 */
export const EXPORT_MIME: Readonly<Record<ExportFormat, string>> = {
  md: 'text/markdown;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
  docx: DOCX_MIME,
  epub: EPUB_MIME,
  fountain: 'text/plain;charset=utf-8',
  fdx: 'application/xml',
  'ink-json': 'application/json',
  'dialogue-csv': 'text/csv;charset=utf-8',
  'shot-list-csv': 'text/csv;charset=utf-8',
  promptpack: 'application/json',
  'coherence-md': 'text/markdown;charset=utf-8',
  'coherence-json': 'application/json',
  'dialogue-xlsx': XLSX_MIME,
  'shot-list-xlsx': XLSX_MIME,
  pdf: PDF_MIME,
  'contact-sheet-pdf': PDF_MIME,
};

const NO_ASSETS: ReadonlyMap<string, AssetRecord> = new Map();

/**
 * Whether a media format names the project's stored images: the shot list's image column, the prompt pack's references and the
 * contact sheet's pictures.
 */
function readsImages(format: MediaFormat): boolean {
  return format === 'shot-list-csv' || format === 'shot-list-xlsx' || format === 'promptpack' || format === 'contact-sheet-pdf';
}

const systemClock: ExporterClock = { now: () => Date.now() };

/**
 * The recipes a project holds (exporter.md §2): the manifest's `recipes[]`, read from the state each compile. A project
 * that predates recipes holds the one default; a project whose recipes were all deleted holds none, and says so. A
 * recipe whose format this build does not compile is left out, because it could not be run.
 */
export function recipesOf(state: ProjectState): readonly ExportRecipe[] {
  const stored = state.manifest.recipes;
  if (stored === undefined) return [DEFAULT_RECIPE];
  const recipes: ExportRecipe[] = [];
  for (const recipe of stored) {
    if (!isExportFormat(recipe.format)) continue;
    recipes.push({
      name: recipe.name,
      includeRootIds: [...recipe.includeRootIds],
      format: recipe.format,
      ...(recipe.templateId === undefined ? {} : { templateId: recipe.templateId }),
      ...(recipe.options === undefined ? {} : { options: { ...recipe.options } }),
    });
  }
  return recipes;
}

export function createExporter(options: ExporterOptions): ExporterService {
  const clock = options.clock ?? systemClock;
  const readAsset = options.readAsset ?? ((path: string) => readArtifactBytes(options.artifacts, path));
  const emitter: Emitter = createEmitter({
    artifacts: options.artifacts,
    ...(options.bytes === undefined ? {} : { bytes: options.bytes }),
  });

  /**
   * Everything a compile needs that can be known without awaiting. A media compile renders here too, so its gates
   * refuse here, before anything is reserved or queued.
   */
  const plan = (state: ProjectState, request: PlanRequest): CompilePlan => {
    const metadata = options.metadata?.(state) ?? {};
    const title = state.manifest.project.name;
    const author = request.options.author ?? metadata.author ?? '';
    const at = new Date(request.at);
    const date = localDayOf(at);

    if (isMediaFormat(request.format)) {
      const language = metadata.language?.trim();
      return planMedia(state, request, { format: request.format, title, author, date, ...(language === undefined || language === '' ? {} : { language }) });
    }

    const { template, note: templateNote } = resolveTemplate(request.templateId);
    const titlePage = request.options.titlePage ?? template.titlePage;
    const wantToc = request.options.toc ?? template.toc;

    const styleRows = options.sceneStyles ?? SCENE_STYLE_ROWS;
    const flat = flatten(state, request.selection, { titlePage, sceneStyles: styleRows });
    const chapterCount = flat.chapterCount;
    // EPUB always carries a contents document (nav.xhtml, §3a), so its flag is on
    // whenever it has a chapter to list; the other formats follow the recipe.
    const tocIncluded =
      request.format === 'epub' ? chapterCount > 0 : request.format !== 'txt' && wantToc && chapterCount > 0;

    const notes: string[] = [...flat.notes];
    if (templateNote !== undefined) notes.push(templateNote);
    notes.push(...droppedStyleNotes(flat.blocks, request.format, styleRows));
    let epub: EpubFacts | undefined;
    if (request.format === 'epub') {
      // Refused here, before anything is reserved or queued, so a refusal writes nothing.
      if (metadata.identifier === undefined || metadata.identifier.trim() === '') {
        throw new NoPersistentIdentifierError();
      }
      const language = metadata.language?.trim() ?? '';
      if (language === '') {
        notes.push('epub: the project has no language on record, so dc:language is "en" (set one in the project panel)');
      }
      const cover = coverSourceOf(readAsset, metadata.coverAssetId);
      epub = {
        language: language === '' ? 'en' : language,
        // The stored identifier in its URN form: the same string on every pack, which is the persistence rule.
        identifier: identifierUrn(metadata.identifier.trim()),
        ...(metadata.isbn === undefined || metadata.isbn === '' ? {} : { isbn: metadata.isbn }),
        ...(cover === undefined ? {} : { cover }),
      };
    }

    const input: RenderInput = {
      blocks: flat.blocks,
      title,
      author,
      date,
      template,
      toc: tocIncluded && request.format !== 'epub',
    };

    const entry: Omit<CompileLogEntry, 'output'> = {
      at: at.toISOString(),
      recipe: request.recipe,
      format: request.format,
      blockCount: flat.blocks.length,
      chapterCount,
      sceneCount: flat.sceneCount,
      wordCount: flat.wordCount,
      skippedDocs: flat.skippedDocs,
      tocIncluded,
      notes,
    };

    return { kind: 'prose', format: request.format, input, flat, entry, title, epub, at: request.at };
  };

  /** A media format's plan: its renderer runs now, because every media renderer is synchronous. */
  const planMedia = (
    state: ProjectState,
    request: PlanRequest,
    common: { readonly format: MediaFormat; readonly title: string; readonly author: string; readonly date: string; readonly language?: string },
  ): MediaPlan => {
    // A prompt pack's templateId names a vendor, not a layout template, so only the other media formats resolve one.
    const resolved = resolveTemplate(request.format === 'promptpack' ? undefined : request.templateId);
    const titlePage = request.options.titlePage ?? resolved.template.titlePage;
    const output = renderMedia({
      state,
      format: common.format,
      includeRootIds: request.selection.includeRootIds,
      title: common.title,
      author: common.author,
      date: common.date,
      titlePage,
      base: request.base,
      ...(request.templateId === undefined ? {} : { vendor: request.templateId }),
      // The recipe's character limit reaches the dialogue table (dialogue-narrative.md §4), as CSV or as a spreadsheet.
      charLimit: request.options.charLimit ?? null,
      // The screenplay PDF's scene numbers and continuation marks (screenplay.md §5.3). Only `pdf` reads them.
      ...(request.options.sceneNumbers === undefined ? {} : { sceneNumbers: request.options.sceneNumbers }),
      ...(request.options.continued === undefined ? {} : { continued: request.options.continued }),
      // Only the shot list (CSV or XLSX) and the prompt pack name stored images, so only they ask for them: a folder whose images
      // cannot be listed refuses those three formats, and a script or a dialogue table still compiles.
      assets: readsImages(common.format) ? (options.assets?.(state) ?? NO_ASSETS) : NO_ASSETS,
      // The contact sheet reads its pictures' bytes when its file renders, from the same store the cover is read from.
      readAsset,
      ...(request.options.pageSize === undefined ? {} : { pageSize: request.options.pageSize }),
      ...(options.loadFallbackFont === undefined ? {} : { loadFallbackFont: options.loadFallbackFont }),
      ...(options.loadEmojiFont === undefined ? {} : { loadEmojiFont: options.loadEmojiFont }),
      ...(options.loadArabicFont === undefined ? {} : { loadArabicFont: options.loadArabicFont }),
      ...(options.loadHebrewFont === undefined ? {} : { loadHebrewFont: options.loadHebrewFont }),
      ...(options.loadDevanagariFont === undefined ? {} : { loadDevanagariFont: options.loadDevanagariFont }),
      ...(common.language === undefined ? {} : { language: common.language }),
      at: request.at,
    });
    const notes = [...output.notes];
    if (resolved.note !== undefined) notes.push(resolved.note);
    const entry: Omit<CompileLogEntry, 'output'> = {
      at: new Date(request.at).toISOString(),
      recipe: request.recipe,
      format: common.format,
      blockCount: output.blockCount,
      chapterCount: output.chapterCount,
      sceneCount: output.sceneCount,
      wordCount: output.wordCount,
      skippedDocs: [...output.skippedDocs],
      tocIncluded: false,
      notes,
    };
    return { kind: 'media', format: common.format, entry, title: common.title, at: request.at, files: output.files };
  };

  /** A recipe the state holds, by name. An unknown name is refused with the names that exist, so the caller can correct it. */
  const recipeNamed = (state: ProjectState, name: string): ExportRecipe => {
    const all = recipesOf(state);
    const found = all.find((recipe) => recipe.name === name);
    if (found === undefined) throw new UnknownRecipeError(name, all.map((recipe) => recipe.name));
    return found;
  };

  const exporter: ExporterService = {
    async compile(selection, format, templateId) {
      if (!isExportFormat(format)) throw new UnknownExportFormatError(format);
      const state = options.readState();
      requireKnownNodes(state, selection.includeRootIds);
      const label = selection.includeRootIds.includes('manuscript') ? 'manuscript' : 'selection';
      const base = fileStem(outputTitle(state, selection.includeRootIds, state.manifest.project.name));
      const compiled = plan(state, {
        selection,
        format,
        templateId,
        options: {},
        recipe: label,
        base,
        at: clock.now(),
      });
      const files: ExportFile[] = [];
      // A render can add a note the plan could not know (the cover's size), and the log says so as the bus's compile does.
      const notes: string[] = [];
      for (const file of filesOf(compiled, `${base}.${EXTENSION[format]}`)) {
        const rendered = splitRendered(await file.render());
        notes.push(...rendered.notes);
        files.push({
          fileName: file.name,
          mimeType: file.mimeType,
          blob: new Blob([rendered.contents as BlobPart], { type: file.mimeType }),
        });
      }
      const first = files[0];
      if (first === undefined) throw new Error(`the ${format} compile produced no file`);
      return {
        format,
        fileName: first.fileName,
        mimeType: first.mimeType,
        blob: first.blob,
        files,
        log: { ...compiled.entry, notes: [...compiled.entry.notes, ...notes], output: null },
      } satisfies ExportResult;
    },

    previewFlatten(selection): FlatBlock[] {
      return [...flatten(options.readState(), selection, { titlePage: true, sceneStyles: options.sceneStyles ?? SCENE_STYLE_ROWS }).blocks];
    },

    listRecipes: () => [...recipesOf(options.readState())],

    ready: () => emitter.ready(),
    idle: () => emitter.idle(),
    failures: () => emitter.failures(),

    commandPort: () => ({
      compile(state, request) {
        return compileForBus(state, request);
      },
    }),

    refusalOf(state, dispatch, at) {
      try {
        planForBus(state, requestOfDispatch(dispatch, at));
        return undefined;
      } catch (error) {
        if (error instanceof ApplyRefusal) return error.error;
        throw error;
      }
    },
  };

  /**
   * The synchronous half of a bus compile, shared by the apply and by {@link ExporterService.refusalOf}: every refusal the compile can
   * raise (the format, the recipe, the binary byte store, and each gate of the plan), and the plan itself. Nothing is reserved or written.
   */
  function planForBus(state: ProjectState, request: ExportCommandRequest): BusPlan {
    if (!isExportFormat(request.format)) throw new UnknownExportFormatError(request.format);
    const format = request.format;
    if (isBinaryFormat(format) && options.bytes === undefined) throw new ExportUnavailableError(format);

    // A recipe supplies the selection, template and options; the command's own
    // format is the output format, so one recipe can be compiled to any format.
    const recipe = request.recipeName === undefined ? undefined : recipeNamed(state, request.recipeName);
    // A part names its nodes itself, so only a whole-manuscript compile takes its selection from the recipe. A recipe on a part
    // supplies the options and the template, and the part is still the nodes the command named.
    const includeRootIds =
      request.selection.kind === 'nodes'
        ? [...request.selection.includeRootIds]
        : recipe !== undefined
          ? recipe.includeRootIds
          : ['manuscript'];
    requireKnownNodes(state, includeRootIds);
    const label = request.recipeName ?? (request.selection.kind === 'manuscript' ? 'manuscript' : 'selection');
    // A whole-manuscript compile under a named recipe is named by the recipe, except the default one: that recipe is the book itself,
    // so its file is the book's title, which is what a compile without a recipe has always been named. A part is named for what it
    // holds, so a recipe does not rename it.
    const namedByRecipe = recipe !== undefined && request.selection.kind === 'manuscript' && recipe.name !== DEFAULT_RECIPE.name;
    const base = namedByRecipe ? fileStem(recipe.name) : fileStem(outputTitle(state, includeRootIds, state.manifest.project.name));

    const compiled = plan(state, {
      selection: { includeRootIds: [...includeRootIds] },
      format,
      templateId: request.templateId ?? recipe?.templateId,
      options: recipe?.options ?? {},
      recipe: label,
      base,
      at: request.at,
    });
    return { format, base, compiled };
  }

  function compileForBus(state: ProjectState, request: ExportCommandRequest): ExportCommandOutcome {
    const { format, base, compiled } = planForBus(state, request);

    // The names are reserved together, and only after the plan has accepted the compile: a refused plan reserves nothing.
    const placed = emitter.reserveGroup(filesOf(compiled, `${base}.${EXTENSION[format]}`));
    const paths = placed.map((file) => file.path);
    emitter.publishFiles({
      files: placed.map((file) => ({ path: file.path, format, render: file.render })),
      entry: compiled.entry,
    });

    const digest: ExportCommandDigest = {
      format,
      output: paths[0] ?? '',
      chapterCount: compiled.entry.chapterCount,
      sceneCount: compiled.entry.sceneCount,
      blockCount: compiled.entry.blockCount,
      wordCount: compiled.entry.wordCount,
      skippedDocs: [...compiled.entry.skippedDocs],
      tocIncluded: compiled.entry.tocIncluded,
      notes: [...compiled.entry.notes],
      ...(paths.length > 1 ? { outputs: paths } : {}),
    };
    return {
      digest,
      restoreLabel: `delete ${paths.join(', ')}`,
      restore: () => emitter.restoreAll(paths),
    };
  }

  /**
   * The files a plan writes, each with the name it asks for and a way to render it. A prose compile is one file,
   * named by `proseName` and rendered by the format's renderer; a media compile's files are already rendered.
   */
  function filesOf(compiled: CompilePlan, proseName: string): RenderedFile[] {
    if (compiled.kind === 'prose') {
      return [{ name: proseName, mimeType: EXPORT_MIME[compiled.format], render: () => renderProse(compiled) }];
    }
    // A text file is already rendered; a binary file (a spreadsheet, a PDF) renders in the queue, where its engine is loaded.
    return compiled.files.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      render: file.bytes !== undefined ? file.bytes : async () => file.text,
    }));
  }

  return exporter;
}

/**
 * Stage 3's rendering for a prose format. Async as a whole, because the DOCX and EPUB libraries are loaded lazily;
 * the two string renderers are called directly.
 */
async function renderProse(compiled: ProsePlan): Promise<RenderedContents> {
  switch (compiled.format) {
    case 'md':
      return renderMarkdown(compiled.input);
    case 'txt':
      return renderText(compiled.input);
    case 'docx':
      return renderDocx(compiled.input);
    case 'epub':
      return renderEpubArtifactFor(compiled);
    default:
      throw new Error(`"${compiled.format}" is not a prose format, so it has no prose renderer`);
  }
}

async function renderEpubArtifactFor(compiled: ProsePlan): Promise<{ readonly contents: Uint8Array; readonly notes: readonly string[] }> {
  // plan() refuses an EPUB with no identifier, so reaching here without one is a defect.
  if (compiled.epub === undefined) throw new Error('an EPUB reached the renderer without its planned identifier');
  const at = new Date(compiled.at);
  const named = compiled.epub.cover !== undefined;
  const cover = compiled.epub.cover === undefined ? undefined : await compiled.epub.cover.read();
  const input: EpubInput = {
    ...compiled.input,
    language: compiled.epub.language,
    identifier: compiled.epub.identifier,
    ...(compiled.epub.isbn === undefined ? {} : { isbn: compiled.epub.isbn }),
    ...(cover === undefined ? {} : { cover }),
    modified: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    mtime: at,
  };
  // A cover the project names but the store does not hold is left out of the book (an EPUB is valid without one), and
  // the log says so: the writer set a cover, so a silent drop would look like the cover was never read. This is the
  // named-but-missing case; a project that names no cover (`named` false) is epub-metadata.md's "no cover, no warning".
  const notes = cover === undefined ? (named ? ['epub: the project has a cover asset on record but its file is not in assets/, so the book has no cover'] : []) : coverNotesFor(cover.bytes);
  return { contents: await renderEpub(input), notes };
}

/** The short side a cover is asked to reach for the big retailers (epub-metadata.md, the retail-distribution gap). */
const RETAIL_COVER_SHORT_SIDE = 1400;

/**
 * The log note for a cover below the common retail minimum, or none. A cover whose size its header does not give gets no note: the
 * note reports a size that was read, and it does not guess one.
 */
function coverNotesFor(bytes: Uint8Array): string[] {
  const size = imageSizeOf(bytes);
  if (size === undefined) return [];
  const shortSide = Math.min(size.width, size.height);
  if (shortSide >= RETAIL_COVER_SHORT_SIDE) return [];
  return [
    `epub: cover below common retail minimums (its short side is ${shortSide} px, and retailers usually ask for at least ${RETAIL_COVER_SHORT_SIDE} px)`,
  ];
}

interface PlanRequest {
  readonly selection: ExportSelection;
  readonly format: ExportFormat;
  readonly templateId?: string;
  readonly options: ExportRecipeOptions;
  readonly recipe: string;
  /** The file stem a single-file artifact is named by. */
  readonly base: string;
  readonly at: number;
}

/** What every plan carries: the log row it will write, and the title and time it was made at. */
interface PlanCommon {
  readonly format: ExportFormat;
  readonly entry: Omit<CompileLogEntry, 'output'>;
  readonly title: string;
  readonly at: number;
}

/** A prose compile: the flattened blocks, which stage 3 renders for the format. */
interface ProsePlan extends PlanCommon {
  readonly kind: 'prose';
  readonly input: RenderInput;
  readonly flat: FlattenResult;
  /** Present for an EPUB only: the identifier and language its package document carries. */
  readonly epub?: EpubFacts;
}

/** A media compile: the files its renderer produced in the plan, each with the name it is written under. */
interface MediaPlan extends PlanCommon {
  readonly kind: 'media';
  readonly files: readonly MediaFile[];
}

type CompilePlan = ProsePlan | MediaPlan;

/** What a bus compile plans before anything is reserved: the format, the file stem it is named by, and the plan. */
interface BusPlan {
  readonly format: ExportFormat;
  readonly base: string;
  readonly compiled: CompilePlan;
}

/** One file a compile writes, before its name is reserved: what it is called, what it is, and how it renders. */
interface RenderedFile {
  readonly name: string;
  readonly mimeType: string;
  /** Rendering is async for DOCX, EPUB, XLSX and the PDFs, so it runs inside the queue, in order. A text media file is already text. */
  readonly render: () => Promise<RenderedContents>;
}

interface EpubFacts {
  readonly language: string;
  readonly identifier: string;
  /** `urn:isbn:` form, when the writer gave one. */
  readonly isbn?: string;
  /** The cover, when the project names one that is in `assets/`. Its bytes are read when the EPUB renders. */
  readonly cover?: CoverSource;
}

/** A cover the project names: its asset id, and how to read its bytes (asynchronously, inside the queue). */
interface CoverSource {
  read(): Promise<{ readonly bytes: Uint8Array; readonly extension: string; readonly mime: string } | undefined>;
}

/** The three image types an EPUB cover can be, in the order their extensions are probed. */
const COVER_KINDS = [
  { extension: 'png', mime: 'image/png' },
  { extension: 'jpg', mime: 'image/jpeg' },
  { extension: 'webp', mime: 'image/webp' },
] as const;

/** The shape of an asset id (storyboard.md §2.2). A cover id that does not have it names no file, so it is ignored. */
const ASSET_ID = /^a_[0-9A-HJKMNP-TV-Z]{10}$/;

/**
 * The cover a project names, read from its `assets/` store when the EPUB renders. The file's extension is not stored in
 * the manifest, so each image type is probed in turn. A cover the store does not hold is left out, not refused: the book
 * is still a valid EPUB without one (epub-metadata.md: an absent cover emits no cover property).
 */
function coverSourceOf(
  readAsset: (path: string) => Promise<Uint8Array | null>,
  coverAssetId: string | null | undefined,
): CoverSource | undefined {
  if (coverAssetId === undefined || coverAssetId === null || !ASSET_ID.test(coverAssetId)) return undefined;
  return {
    async read() {
      for (const kind of COVER_KINDS) {
        const bytes = await readAsset(`assets/${coverAssetId}.${kind.extension}`);
        if (bytes !== null) return { bytes, extension: kind.extension, mime: kind.mime };
      }
      return undefined;
    },
  };
}

/** One file of an artifact port, or `null` when the port does not hold it. */
async function readArtifactBytes(artifacts: ArtifactFs, path: string): Promise<Uint8Array | null> {
  try {
    return await artifacts.readBytes(path);
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) return null;
    throw error;
  }
}

/**
 * The calendar day a title page shows, as `YYYY-MM-DD` in the writer's own zone: the device-local day, the rule furniture's `localDayOf`
 * states for "today" (goals-progress.md A3). The exporter does not import furniture, so the rule is written here too. The UTC day is a
 * different day for part of every day in most zones, so a page compiled in the evening west of Greenwich would carry tomorrow's date.
 * The stamps the log and the EPUB's `dcterms:modified` keep, in UTC (epub-metadata.md), are not this function's.
 */
export function localDayOf(at: Date): string {
  const year = String(at.getFullYear()).padStart(4, '0');
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Refuses a selection that names a node the tree does not hold. The recipe path refuses an unknown node as `not-found`
 * before the plan, and the selection path agrees here: an id that resolves to nothing would otherwise compile a
 * title-page-only artifact and report success. A fixed root (`root`, `manuscript`, `research`) is always a node.
 */
function requireKnownNodes(state: ProjectState, includeRootIds: readonly string[]): void {
  const known = new Set(state.manifest.tree.map((node) => node.id));
  const unknown = includeRootIds.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new UnknownSelectionNodeError(unknown);
}

/**
 * The name an artifact is given when no recipe names it. A whole-book compile is the
 * project's title, not the title of the folder it is rooted at ("Manuscript"); a part
 * is named for its one node, or for the project and "(selection)" when there are
 * several.
 */
function outputTitle(state: ProjectState, includeRootIds: readonly string[], projectTitle: string): string {
  if (includeRootIds.length === 0) return projectTitle;
  if (includeRootIds.length > 1) return `${projectTitle} (selection)`;
  const id = includeRootIds[0];
  if (id === 'root' || id === 'manuscript') return projectTitle;
  const node = state.manifest.tree.find((candidate) => candidate.id === id);
  return node?.title ?? projectTitle;
}
