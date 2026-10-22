/**
 * The media-track compile recipes — [media-track.md §1, the one-source compile](../../../docs/architecture/media-track.md), with
 * [screenplay.md §5](../../../docs/architecture/screenplay.md), [dialogue-narrative.md §4](../../../docs/architecture/dialogue-narrative.md),
 * [storyboard.md §6](../../../docs/architecture/storyboard.md) and [video-prompt-pack.md §5](../../../docs/architecture/video-prompt-pack.md)
 * as the specs for what each format writes.
 *
 * One project, many outputs: each media format is a recipe over one package's renderer. The renderers stay in
 * their packages. This file does the work the exporter owns: it takes the binder selection, reads only the kind
 * of node the format compiles, calls the renderer, applies the gate the spec states, and names the files. The
 * exporter's pipeline is the same one the prose formats use, select → flatten → render → emit, so a media compile
 * writes its log row, its undo and its refusals the same way.
 *
 * Every renderer called here is pure and synchronous. So a media compile runs in the synchronous half of the
 * pipeline, and a gate that refuses throws before anything is reserved. The bus reports that refusal as the
 * port's error, with nothing written and no undo group (exporter.md §2; store/commands.ts `ExportCommandPort`).
 *
 * The screenplay PDF is drawn later. Its pagination runs here, so its gate and its page count are
 * known in the plan; the drawing waits for the font, which is loaded lazily (screenplay.md §5.3), so the file
 * carries a `bytes` render that the queue runs, as it runs the DOCX and EPUB renderers. The contact sheet
 * (storyboard.md §6) is drawn the same way: its page plan runs here, and its pictures are read when it renders.
 */

import { drawPdf, layoutPdf, preparePdf, renderFdx, renderFountain, isScreenplayKind, PDF_MIME, type PdfLayout, type PdfRenderOptions, type SceneNumberPlacement } from '@caotang/screenplay';
import {
  TABLE_COLUMNS,
  exportCsv,
  exportInkJson,
  isDialogueNodeType,
  readDialogueMeta,
  toCsv,
  toYarnCsv,
  type DialogueSource,
  type EngineTarget,
  type TableRow,
} from '@caotang/dialogue';
import { countBody, getBody, nodeById, type ProjectState, type TreeNode } from '@caotang/store';
import {
  exportNumbers,
  guardFormula,
  planContactSheet,
  isPlainObject,
  isShotNode,
  kindOf,
  readShotMeta,
  SHOT_LIST_COLUMNS,
  renderShotListCsv,
  shotFieldOf,
  shotListRows,
  shotsInBinderOrder,
  walkBinder,
  type DialogueCoverage,
  type PageSize,
  type SheetImageStatus,
} from '@caotang/storyboard';
import {
  VIDEO_TEMPLATE_IDS,
  fileNameFor,
  preparePack,
  renderPromptPack,
  templateById,
  type AssetRecord,
  type CoveredScript,
  type ShotNode,
  type StoryboardSnapshot,
  type VideoShotRef,
} from '@caotang/video-prompt-pack';

import { MediaRefusedError } from './errors.js';
import {
  COHERENCE_JSON_MIME,
  COHERENCE_MARKDOWN_MIME,
  coherenceReportJson,
  coherenceReportMarkdown,
} from './coherence-report.js';
import type { RenderedContents } from './emit.js';
import { flatten, type FlattenResult } from './flatten.js';
import type { FontLoader } from '@caotang/pdf-fonts';
import { drawContactSheet } from './render-contact-sheet.js';
import { XLSX_MIME, prepareSheet, renderXlsx, type XlsxCell, type XlsxSheet } from './render-xlsx.js';
import { fileStem, suffixName } from './template.js';
import type { FlatBlock, MediaFormat } from './types.js';
import { stripXmlIllegal } from './xml-text.js';

const FOUNTAIN_MIME = 'text/plain;charset=utf-8';
const FDX_MIME = 'application/xml';
const JSON_MIME = 'application/json';
const CSV_MIME = 'text/csv;charset=utf-8';

/** What one media compile is asked for. The exporter builds it from the request and the project. */
export interface MediaRequest {
  readonly state: ProjectState;
  readonly format: MediaFormat;
  /** The selection's root ids: `manuscript` for the whole book, or the nodes a part names. */
  readonly includeRootIds: readonly string[];
  /** The project's title: the title page's, and the file name's when nothing else names the file. */
  readonly title: string;
  readonly author: string;
  /** `YYYY-MM-DD`, the date a title page shows. */
  readonly date: string;
  /** Whether the title page is on, from the recipe or the template. Only the screenplay formats print one. */
  readonly titlePage: boolean;
  /** The screenplay PDF's scene numbers (screenplay.md §5.3). Absent is off. Only `pdf` reads it. */
  readonly sceneNumbers?: SceneNumberPlacement;
  /** `(MORE)` and `(CONT'D)` across a page break in the screenplay PDF. Absent is on. Only `pdf` reads it. */
  readonly continued?: boolean;
  /** The stem a single-file artifact is named by: the recipe's name, or the output title. */
  readonly base: string;
  /** The vendor template a `promptpack` is written for. Every other format ignores it. */
  readonly vendor?: string;
  /**
   * The subtitle-style character limit the dialogue table's `charLimit` column carries (dialogue-narrative.md §4). Absent or
   * null leaves the column empty, which is unconstrained. Only the dialogue table (`dialogue-csv`, `dialogue-xlsx`) reads it.
   */
  readonly charLimit?: number | null;
  /** Stored assets by id, with their file names (storyboard.md §2.1). The exporter reads these synchronously. */
  readonly assets: ReadonlyMap<string, AssetRecord>;
  /**
   * Reads one file of the project's `assets/` store by its path (`assets/<fileName>`), or gives `null` when the store does not hold
   * it. Only the contact sheet reads picture bytes, and it reads them when its file renders, after the plan. Without it, every
   * picture on the sheet shows its caption, and the log says so.
   */
  readonly readAsset?: (path: string) => Promise<Uint8Array | null>;
  /** The contact sheet's paper, A4 or US Letter (storyboard.md §6). Absent is A4. Only `contact-sheet-pdf` reads it. */
  readonly pageSize?: PageSize;
  /** The moment the compile ran, in ms. The contact sheet's PDF dates are set from it. Absent is now. */
  readonly at?: number;
  /** Reads the fallback font for text outside Latin script (`@caotang/font-noto-cjk`). The screenplay PDF and the contact sheet read it, and only when the file holds such text. */
  readonly loadFallbackFont?: FontLoader;
  /** Reads the emoji font (`@caotang/font-noto-emoji`). The screenplay PDF and the contact sheet read it, and only when the file holds an emoji. */
  readonly loadEmojiFont?: FontLoader;
  /** Reads Noto Sans Arabic (`@caotang/font-noto-arabic`). The screenplay PDF and the contact sheet read it, and only when the file holds Arabic-script text. */
  readonly loadArabicFont?: FontLoader;
  /** Reads Noto Sans Hebrew (`@caotang/font-noto-hebrew`). The screenplay PDF and the contact sheet read it, and only when the file holds Hebrew text. */
  readonly loadHebrewFont?: FontLoader;
  /** Reads Noto Sans Devanagari (`@caotang/font-noto-devanagari`). The screenplay PDF and the contact sheet read it, and only when the file holds Devanagari text. */
  readonly loadDevanagariFont?: FontLoader;
  /** The project's language (a BCP 47 tag), when it has one. In a right-to-left language the screenplay PDF lays out a paragraph with no strong character right to left. */
  readonly language?: string;
}

/**
 * One file the compile writes. `name` has no folder; the emitter places it in `exports/`. A text file carries its text. A
 * binary file (the screenplay PDF, a spreadsheet, the contact sheet's PDF) carries `bytes`, which renders it in the queue,
 * after the plan has accepted the compile. A render may hand back compile-log notes with its contents (the contact sheet does).
 */
export type MediaFile =
  | { readonly name: string; readonly mimeType: string; readonly text: string; readonly bytes?: never }
  | { readonly name: string; readonly mimeType: string; readonly text?: never; readonly bytes: () => Promise<RenderedContents> };

/** What a media compile produced, and the counts and notes its log row carries. */
export interface MediaOutput {
  readonly files: readonly MediaFile[];
  readonly blockCount: number;
  readonly chapterCount: number;
  readonly sceneCount: number;
  readonly wordCount: number;
  readonly skippedDocs: readonly string[];
  readonly notes: readonly string[];
}

/**
 * Compiles one media format. Pure, and synchronous: a gate that refuses throws {@link MediaRefusedError}
 * with every reason it found, and writes nothing.
 */
export function renderMedia(request: MediaRequest): MediaOutput {
  switch (request.format) {
    case 'fountain':
      return fountainOutput(request);
    case 'fdx':
      return fdxOutput(request);
    case 'ink-json':
      return inkJsonOutput(request);
    case 'dialogue-csv':
      return dialogueCsvOutput(request);
    case 'shot-list-csv':
      return shotListOutput(request);
    case 'dialogue-xlsx':
      return dialogueXlsxOutput(request);
    case 'shot-list-xlsx':
      return shotListXlsxOutput(request);
    case 'contact-sheet-pdf':
      return contactSheetOutput(request);
    case 'promptpack':
      return promptPackOutput(request);
    case 'coherence-md':
    case 'coherence-json':
      return coherenceReportOutput(request);
    case 'pdf':
      return pdfOutput(request);
  }
}

/**
 * The coherence report (the one-source compile's Review row). It reports the project's findings file, not a selection of the
 * manuscript, so the selection is not read: the report is always the whole file. It is written for any project,
 * including one that never ran a check, which the report says in words.
 */
function coherenceReportOutput(request: MediaRequest): MediaOutput {
  const input = {
    title: request.title,
    date: request.date,
    file: request.state.coherence,
    docTitle: (docId: string) => titleOf(request.state, docId),
  };
  const json = request.format === 'coherence-json';
  const findings = request.state.coherence?.findings.length ?? 0;
  return {
    files: [
      json
        ? { name: `${request.base} (coherence report).json`, mimeType: COHERENCE_JSON_MIME, text: coherenceReportJson(input) }
        : { name: `${request.base} (coherence report).md`, mimeType: COHERENCE_MARKDOWN_MIME, text: coherenceReportMarkdown(input) },
    ],
    blockCount: 0,
    chapterCount: 0,
    sceneCount: 0,
    wordCount: 0,
    skippedDocs: [],
    notes: [`coherence report: ${findings} finding(s) in the file`],
  };
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

/** The nodes a selection covers, in binder order: the named nodes and everything under them. */
function selectedNodes(state: ProjectState, includeRootIds: readonly string[]): TreeNode[] {
  return walkBinder(state, includeRootIds)
    .filter((entry) => entry.selected)
    .map((entry) => entry.node);
}

function titleOf(state: ProjectState, docId: string): string {
  return nodeById(state, docId)?.title ?? '(a document that is no longer in the project)';
}

/** Gives every file a name no other file in the compile has: a second `Scene.ink.json` becomes `Scene-2.ink.json`. */
function withDistinctNames(files: readonly MediaFile[]): MediaFile[] {
  const taken = new Set<string>();
  return files.map((file) => {
    let name = file.name;
    for (let n = 2; taken.has(name); n += 1) name = suffixName(file.name, n);
    taken.add(name);
    return { ...file, name };
  });
}

/* ------------------------------------------------------------------ *
 * The screenplay formats: Fountain and FDX (screenplay.md §5.1, §5.2)
 * ------------------------------------------------------------------ */

/** The screenplay synopses, by document id: the manifest's field, which is the one truth (screenplay.md §2.2). */
function synopsesOf(state: ProjectState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const node of state.manifest.tree) {
    if (node.type === 'document' && node.synopsis.trim() !== '') out[node.id] = node.synopsis;
  }
  return out;
}

/**
 * The flattened blocks of a screenplay compile. Only screenplay scenes are compiled: a prose document in the
 * selection is left out with a note, because prose is not a scene and its text is not Fountain. The rest of
 * the flatten rules are the prose formats', unchanged: order, empties, chapter headings, separators.
 */
function screenplayBlocks(request: MediaRequest): { readonly flat: FlattenResult; readonly left: readonly string[] } {
  const left: string[] = [];
  const flat = flatten(
    request.state,
    {
      includeRootIds: request.includeRootIds,
      docFilter: (doc) => {
        // An empty document is flatten's to report as empty, so it is not this filter's to report as prose.
        if (doc.body.trim() === '') return true;
        const node = nodeById(request.state, doc.id);
        if (node !== undefined && isScreenplayKind(kindOf(node))) return true;
        left.push(`left out: "${doc.title}" is a prose document, not a screenplay scene, so it is not in this compile`);
        return false;
      },
    },
    { titlePage: request.titlePage },
  );
  return { flat, left };
}

/**
 * A screenplay compile with no scene in it has nothing to write, so it is refused. The reasons say why there is no
 * scene: the prose that was left out, and the empty scenes the flatten skipped.
 */
function requireScenes(format: MediaFormat, flat: FlattenResult, left: readonly string[]): void {
  if (flat.sceneCount === 0) {
    const empty = flat.skippedDocs.map((label) => `"${label}" is empty`);
    throw new MediaRefusedError(format, ['the selection holds no screenplay scene', ...left, ...empty]);
  }
}

function fountainOutput(request: MediaRequest): MediaOutput {
  const { flat, left } = screenplayBlocks(request);
  requireScenes('fountain', flat, left);
  const rendered = renderFountain(flat.blocks, {
    title: request.title,
    author: request.author,
    date: request.date,
    synopses: synopsesOf(request.state),
  });
  return {
    files: [{ name: `${request.base}.fountain`, mimeType: FOUNTAIN_MIME, text: rendered.text }],
    blockCount: flat.blocks.length,
    chapterCount: flat.chapterCount,
    sceneCount: flat.sceneCount,
    wordCount: flat.wordCount,
    skippedDocs: flat.skippedDocs,
    notes: [...flat.notes, ...left, ...rendered.notes],
  };
}

/**
 * The screenplay PDF (screenplay.md §5.3). The selection, the gate and the pagination are the plan's, so a refusal writes
 * nothing and the log row can give the page count. The file is drawn in the queue, with Courier Prime embedded, and the CJK, emoji,
 * Arabic, Hebrew and Devanagari fonts when the script needs them. A script with any of them is laid out twice: here, before any font is
 * read, with a column for each letter of a word, which is what the gate and the page count in the log are made of; and again when the
 * file is drawn, with the words measured in their fonts (screenplay.md §5.3). When the measured layout has another page count, the
 * log says so.
 */
function pdfOutput(request: MediaRequest): MediaOutput {
  const { flat, left } = screenplayBlocks(request);
  requireScenes('pdf', flat, left);
  const options: PdfRenderOptions = {
    title: request.title,
    author: request.author,
    date: request.date,
    synopses: synopsesOf(request.state),
    titlePage: request.titlePage,
    sceneNumbers: request.sceneNumbers ?? 'off',
    continued: request.continued ?? true,
    ...(request.language === undefined ? {} : { language: request.language }),
  };
  const layout = layoutPdf(flat.blocks, options);
  // A scene that survives the gate can still print nothing: a body of only notes, boneyard or blank scenes yields no
  // script page, and the paginator writes one blank page so the PDF is valid — a blank book that reports success. The
  // gate refuses it as it refuses a selection with no scene, before anything is reserved or written.
  if (layout.scriptPageCount === 0) {
    throw new MediaRefusedError('pdf', [
      'the selection holds no screenplay text that prints, so there is nothing to print',
      ...left,
      ...flat.skippedDocs.map((label) => `"${label}" is empty`),
    ]);
  }
  const pages = layout.scriptPageCount;
  const titled = layout.pages.length > pages ? ', and a title page' : '';
  return {
    files: [
      {
        name: `${request.base}.pdf`,
        mimeType: PDF_MIME,
        bytes: async () => {
          const prepared = await preparePdf(flat.blocks, options, {
            ...(request.loadFallbackFont === undefined ? {} : { cjk: request.loadFallbackFont }),
            ...(request.loadEmojiFont === undefined ? {} : { emoji: request.loadEmojiFont }),
            ...(request.loadArabicFont === undefined ? {} : { arabic: request.loadArabicFont }),
            ...(request.loadHebrewFont === undefined ? {} : { hebrew: request.loadHebrewFont }),
            ...(request.loadDevanagariFont === undefined ? {} : { devanagari: request.loadDevanagariFont }),
          });
          const bytes = drawPdf(prepared.layout, prepared.font, prepared.cjk, prepared.emoji, prepared.rtl);
          const counted = prepared.layout.scriptPageCount;
          if (counted === pages) return bytes;
          return {
            contents: bytes,
            notes: [`pdf: with the words of Arabic, Hebrew and Devanagari measured in their fonts the script is ${counted} ${counted === 1 ? 'page' : 'pages'}, not ${pages}`],
          };
        },
      },
    ],
    blockCount: flat.blocks.length,
    chapterCount: flat.chapterCount,
    sceneCount: flat.sceneCount,
    wordCount: flat.wordCount,
    skippedDocs: flat.skippedDocs,
    notes: [
      ...flat.notes,
      ...left,
      ...layout.notes,
      ...unloadedFontNotes(layout, request),
      `pdf: ${pages} script ${pages === 1 ? 'page' : 'pages'}${titled}, about ${pages} ${pages === 1 ? 'minute' : 'minutes'} of screen time at a page a minute`,
    ],
  };
}

/** What the screenplay PDF prints as "?" because this compile has no loader for the font that prints it. */
function unloadedFontNotes(layout: PdfLayout, request: MediaRequest): string[] {
  const missing = (characters: readonly string[], what: string): string[] =>
    characters.length === 0
      ? []
      : [`pdf: this compile has no ${what}, so ${characters.length === 1 ? 'this character is' : `these ${characters.length} characters are`} printed as "?": ${characters.slice(0, 10).join(' ')}${characters.length > 10 ? ' …' : ''}`];
  return [
    ...(request.loadFallbackFont === undefined ? missing(layout.fallbackCharacters, 'CJK fallback font') : []),
    ...(request.loadEmojiFont === undefined ? missing(layout.emojiCharacters, 'emoji font') : []),
    ...(request.loadArabicFont === undefined && layout.shapedScripts.includes('arabic') ? ['pdf: this compile has no Arabic font, so the Arabic text is printed as "?"'] : []),
    ...(request.loadHebrewFont === undefined && layout.shapedScripts.includes('hebrew') ? ['pdf: this compile has no Hebrew font, so the Hebrew text is printed as "?"'] : []),
    ...(request.loadDevanagariFont === undefined && layout.shapedScripts.includes('devanagari') ? ['pdf: this compile has no Devanagari font, so the Devanagari text is printed as "?"'] : []),
  ];
}

/** The flattened blocks with every code point XML 1.0 forbids removed from their text (xml-text.ts, the DOCX and EPUB rule). */
function xmlSafeBlocks(blocks: readonly FlatBlock[]): FlatBlock[] {
  return blocks.map((block) => {
    if (block.kind === 'chapter') return { ...block, title: stripXmlIllegal(block.title) };
    if (block.kind === 'scene') return { ...block, title: stripXmlIllegal(block.title), body: stripXmlIllegal(block.body) };
    return block;
  });
}

function xmlSafeSynopses(synopses: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(synopses).map(([id, text]) => [id, stripXmlIllegal(text)]));
}

function fdxOutput(request: MediaRequest): MediaOutput {
  const { flat, left } = screenplayBlocks(request);
  requireScenes('fdx', flat, left);
  // D11's emit set (screenplay.md §5.2): the paragraphs, the title page, and the pagination the scene lengths come from.
  // Every text the file holds is sanitised first: the renderer escapes the five markup characters and nothing else, and
  // a pasted scene can carry a code point XML 1.0 forbids, which would leave the file unreadable to Final Draft.
  const rendered = renderFdx(xmlSafeBlocks(flat.blocks), {
    title: stripXmlIllegal(request.title),
    author: stripXmlIllegal(request.author),
    date: request.date,
    synopses: xmlSafeSynopses(synopsesOf(request.state)),
  });
  return {
    files: [{ name: `${request.base}.fdx`, mimeType: FDX_MIME, text: rendered.xml }],
    blockCount: flat.blocks.length,
    chapterCount: flat.chapterCount,
    sceneCount: flat.sceneCount,
    wordCount: flat.wordCount,
    skippedDocs: flat.skippedDocs,
    notes: [...flat.notes, ...left, ...rendered.notes],
  };
}

/* ------------------------------------------------------------------ *
 * The game-narrative formats: compiled Ink and the dialogue table (dialogue-narrative.md §4, §6)
 * ------------------------------------------------------------------ */

/** The dialogue containers a selection covers, in binder order. */
function dialogueContainers(request: MediaRequest): TreeNode[] {
  return selectedNodes(request.state, request.includeRootIds).filter((node) => isDialogueNodeType(node.type));
}

/** An engine target in the words the compile log uses (the Inspector's labels, dialogue-narrative.md §2.1). */
const TARGET_WORDS: Readonly<Record<EngineTarget, string>> = {
  'ink-json': 'Ink, compiled to JSON',
  'yarn-csv': 'the Yarn string table',
  'generic-csv': 'a CSV table for any engine',
};

/**
 * The file name of one compiled story: `<title>.ink.json`, or `<title>.<locale>.ink.json` when the container sets its own
 * locale (`locBaseline`), so stories written in different languages sit side by side. A container with no locale of its own
 * keeps the plain name: the project's language names no file.
 */
export function inkJsonFileName(title: string, locBaseline: string | undefined): string {
  const locale = locBaseline === undefined || locBaseline.trim() === '' ? '' : fileStem(locBaseline);
  return locale === '' ? `${fileStem(title)}.ink.json` : `${fileStem(title)}.${locale}.ink.json`;
}

/**
 * One compiled story per container (`<title>.ink.json`, with the container's locale in the name when it sets one). The gate
 * is the spec's: a container whose body does not compile with zero errors refuses the whole compile, and every such
 * container is named. Warnings do not block; they are carried into the log verbatim. The compiled JSON is inkjs's own: an
 * engine target or a locale never changes it. A container whose engine target is a table is still compiled, because the
 * recipe carries the truth (§2.1), and the log says so.
 */
function inkJsonOutput(request: MediaRequest): MediaOutput {
  const containers = dialogueContainers(request);
  if (containers.length === 0) {
    throw new MediaRefusedError('ink-json', ['the selection holds no dialogue container, so there is no Ink story to compile']);
  }
  const reasons: string[] = [];
  const files: MediaFile[] = [];
  const notes: string[] = [];
  let words = 0;
  for (const node of containers) {
    const body = getBody(request.state, node.id);
    const read = readDialogueMeta(node.dialogue);
    const compiled = exportInkJson(node.id, body);
    if (!compiled.ok) {
      reasons.push(`"${node.title}" does not compile: ${compiled.errors.map((error) => error.text).join(' ')}`);
      continue;
    }
    files.push({ name: inkJsonFileName(node.title, read.meta.locBaseline), mimeType: JSON_MIME, text: compiled.json });
    notes.push(...read.notes.map((note) => `"${node.title}": ${note}`));
    const target = read.meta.engineTarget;
    if (target !== undefined && target !== 'ink-json') {
      notes.push(`"${node.title}": its engine target is ${TARGET_WORDS[target]}; this compile writes the Ink story, as it was asked to`);
    }
    notes.push(...compiled.notes.map((warning) => `ink warning in "${node.title}": ${warning}`));
    words += countBody(body).words;
  }
  if (reasons.length > 0) throw new MediaRefusedError('ink-json', reasons);
  return {
    files: withDistinctNames(files),
    blockCount: files.length,
    chapterCount: 0,
    sceneCount: containers.length,
    wordCount: words,
    skippedDocs: [],
    notes,
  };
}

/**
 * The dialogue table's CSV: the table's own writer (`toCsv`, dialogue table.ts) over the rows, with the formula guard the
 * shot list and the prompt pack apply to their text cells. The table's writer quotes but does not guard, and its text
 * comes from manuscript and imported Ink, so the guard is applied here, to the speaker, the text and the context. The
 * line id is not guarded: the parser admits only ids of the minted `l_` form, and none of them opens with a trigger. The
 * `locale` column follows §6's five: each row's locale, the container's `locBaseline` or the project's language. Both are
 * read from the project file, where a hand edit can put any non-empty string, so the locale is guarded too.
 */
export function dialogueCsv(rows: readonly TableRow[]): string {
  return toCsv(
    rows.map((row) => ({
      ...row,
      speaker: guardFormula(row.speaker),
      text: guardFormula(row.text),
      context: guardFormula(row.context),
      locale: guardFormula(row.locale),
    })),
    { includeLocale: true },
  );
}

/** The dialogue table's rows, checked against the spec's gate, with the counts and notes its log row carries. */
interface DialogueTable {
  readonly rows: readonly TableRow[];
  readonly containerCount: number;
  readonly words: number;
  readonly notes: readonly string[];
  readonly yarnIds: ReadonlySet<string>;
  readonly titles: ReadonlyMap<string, string>;
  readonly limit: number | null | undefined;
  readonly inkTargetNotes: readonly string[];
}

/**
 * The Yarn Spinner strings file for the rows of `yarn-csv` containers (`toYarnCsv`, dialogue table.ts), with the same formula
 * guard on the cells that come from hand-editable strings: the language (the locale), the text, the file and the comment. The
 * guard is for a spreadsheet that opens the file. The `lock` hash is taken before the guard, from the text Yarn itself would hash. The id and node cells are left unguarded on purpose: only minted `l_` ids and
 * identifier-syntax knot names parse, so neither can start with a trigger character. The apostrophe is written into the cell: in the text it starts the line's
 * content (a known limit in the changelog and the guide); in the language it changes the locale code; in the file and the
 * comment it stays in the metadata.
 */
export function dialogueYarnCsv(rows: readonly TableRow[], titleOf: (containerId: string) => string): string {
  return toYarnCsv(rows, { fileOf: titleOf, cell: guardFormula });
}

/** The project's language, the locale of a container that sets none (dialogue-narrative.md §2.1). */
function projectLocale(state: ProjectState): string {
  return state.manifest.project.language?.trim() ?? '';
}

/**
 * The dialogue table as RFC 4180 CSV, one row per speakable line and choice label (dialogue-narrative.md §6).
 * The gate is the spec's: every row has a line id and no id is used twice. Ids are minted in the Ink text by
 * the dialogue tools, never here, so a table with an unkeyed row is refused and the rows are named.
 *
 * Each container's engine target picks the file its rows go to. A `yarn-csv` container's rows go to a Yarn Spinner strings
 * file, `<base> (dialogue, Yarn).csv`. Every other container's rows, with the `generic-csv` target, the `ink-json` target or
 * none, go to the dialogue table, `<base> (dialogue).csv`. A selection that holds both kinds writes both files. Every row
 * carries its locale: the container's `locBaseline`, else the project's language.
 */
function dialogueTable(request: MediaRequest, format: 'dialogue-csv' | 'dialogue-xlsx'): DialogueTable {
  const containers = dialogueContainers(request);
  if (containers.length === 0) {
    throw new MediaRefusedError(format, ['the selection holds no dialogue container, so there is no table to write']);
  }
  const limit = request.charLimit;
  if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    throw new MediaRefusedError(format, [`the character limit must be a whole number above zero, got ${String(limit)}`]);
  }
  // Each container's own settings (its default speaker, its locale, its engine target) are read here. A setting the reader
  // cannot use is dropped by it and reported in the compile's notes.
  const reads = containers.map((node) => readDialogueMeta(node.dialogue));
  const sources: DialogueSource[] = containers.map((node, i) => ({
    id: node.id,
    title: node.title,
    body: getBody(request.state, node.id),
    meta: reads[i]?.meta ?? {},
  }));
  const locale = projectLocale(request.state);
  const table = exportCsv(sources, { entries: request.state.manifest.codex ?? [], charLimit: limit ?? null, locale });
  const titles = new Map(containers.map((node) => [node.id, node.title] as const));
  if (!table.ok) {
    throw new MediaRefusedError(format, [
      ...table.missing.map((row) => `"${titles.get(row.container) ?? row.container}" line ${row.line} has no line id`),
      ...table.duplicates.map((id) => `line id ${id} is on more than one line`),
    ]);
  }
  const yarnIds = new Set(containers.filter((_, i) => reads[i]?.meta.engineTarget === 'yarn-csv').map((node) => node.id));
  const notes = reads.flatMap((read, i) => read.notes.map((note) => `"${containers[i]?.title ?? ''}": ${note}`));
  if (table.rows.some((row) => row.locale === '')) {
    notes.push('a container has no locale and the project has no language, so its rows have an empty locale');
  }
  return {
    rows: table.rows,
    containerCount: containers.length,
    words: table.rows.reduce((sum, row) => sum + countBody(row.text).words, 0),
    notes,
    yarnIds,
    titles,
    limit,
    inkTargetNotes: containers.flatMap((node, i) =>
      reads[i]?.meta.engineTarget === 'ink-json'
        ? [`"${node.title}": its engine target is ${TARGET_WORDS['ink-json']}; its lines are in the dialogue table, as this compile asks`]
        : [],
    ),
  };
}

/**
 * The dialogue table as RFC 4180 CSV, one row per speakable line and choice label (dialogue-narrative.md §6). Each container's
 * engine target picks the file its rows go to: a `yarn-csv` container's rows go to a Yarn Spinner strings file,
 * `<base> (dialogue, Yarn).csv`, and every other container's rows to the dialogue table, `<base> (dialogue).csv`. A selection
 * that holds both kinds writes both files. Every row carries its locale.
 */
function dialogueCsvOutput(request: MediaRequest): MediaOutput {
  const table = dialogueTable(request, 'dialogue-csv');
  const { yarnIds, titles, limit } = table;
  const yarnRows = table.rows.filter((row) => yarnIds.has(row.container));
  const tableRows = table.rows.filter((row) => !yarnIds.has(row.container));
  const files: MediaFile[] = [];
  if (yarnIds.size < table.containerCount) {
    files.push({ name: `${request.base} (dialogue).csv`, mimeType: CSV_MIME, text: dialogueCsv(tableRows) });
  }
  if (yarnIds.size > 0) {
    files.push({
      name: `${request.base} (dialogue, Yarn).csv`,
      mimeType: CSV_MIME,
      text: dialogueYarnCsv(yarnRows, (id) => titles.get(id) ?? id),
    });
  }
  const notes = [...table.notes, ...table.inkTargetNotes];
  if (yarnIds.size > 0 && limit !== undefined && limit !== null) {
    notes.push('the Yarn strings file has no character limit column, so the limit is not in it');
  }
  return {
    files,
    blockCount: table.rows.length,
    chapterCount: 0,
    sceneCount: table.containerCount,
    wordCount: table.words,
    skippedDocs: [],
    notes,
  };
}

/**
 * The dialogue table as a spreadsheet: the CSV's columns and rows, in one sheet (dialogue-narrative.md §4, the XLSX at the
 * spreadsheet gate). The character limit is a number cell. The text is written as typed: a spreadsheet does not evaluate a
 * text cell, so it needs no apostrophe.
 */
function dialogueXlsxOutput(request: MediaRequest): MediaOutput {
  const table = dialogueTable(request, 'dialogue-xlsx');
  const rows: XlsxCell[][] = table.rows.map((row) => [row.lineId, row.speaker, row.text, row.context, row.charLimit, row.locale]);
  const prepared = prepareSheet({ name: 'Dialogue', title: `${request.title} (dialogue)`, columns: [...TABLE_COLUMNS, 'locale'], rows });
  return {
    files: [xlsxFile(`${request.base} (dialogue).xlsx`, prepared.sheet)],
    blockCount: table.rows.length,
    chapterCount: 0,
    sceneCount: table.containerCount,
    wordCount: table.words,
    skippedDocs: [],
    notes: [...table.notes, ...table.inkTargetNotes, ...prepared.notes],
  };
}

/** A spreadsheet file, rendered when the emitter's queue reaches it. */
function xlsxFile(name: string, sheet: XlsxSheet): MediaFile {
  return { name, mimeType: XLSX_MIME, bytes: () => renderXlsx(sheet) };
}

/* ------------------------------------------------------------------ *
 * The production format: the shot list (storyboard.md §6)
 * ------------------------------------------------------------------ */

/**
 * The shot list as CSV, one row per shot in binder order. The renderer owns the columns, the numbering and
 * the formula guard; this recipe owns the selection, the refusal for an empty list, and the asset names the
 * image column reads.
 */
function shotListOutput(request: MediaRequest): MediaOutput {
  const fileNames = new Map([...request.assets].map(([id, asset]) => [id, asset.fileName] as const));
  const listed = renderShotListCsv(request.state, request.includeRootIds, fileNames);
  if (listed.rowCount === 0) {
    throw new MediaRefusedError('shot-list-csv', ['the selection holds no shot, so there is no shot list to write']);
  }
  return {
    files: [{ name: `${request.base} (shot list).csv`, mimeType: CSV_MIME, text: listed.csv }],
    blockCount: listed.rowCount,
    chapterCount: 0,
    sceneCount: 0,
    wordCount: 0,
    skippedDocs: [],
    notes: [...listed.notes, ...bareShotNotes(request)],
  };
}

/**
 * The shot list as a spreadsheet: the CSV's columns and rows, in one sheet (storyboard.md §6, the XLSX variant at the
 * spreadsheet gate, §8 A4). The shot number and the duration are number cells; the text is written as typed.
 */
function shotListXlsxOutput(request: MediaRequest): MediaOutput {
  const fileNames = new Map([...request.assets].map(([id, asset]) => [id, asset.fileName] as const));
  const listed = shotListRows(request.state, request.includeRootIds, fileNames);
  if (listed.rows.length === 0) {
    throw new MediaRefusedError('shot-list-xlsx', ['the selection holds no shot, so there is no shot list to write']);
  }
  const rows: XlsxCell[][] = listed.rows.map((row) => SHOT_LIST_COLUMNS.map((column) => row[column]));
  const prepared = prepareSheet({ name: 'Shot list', title: `${request.title} (shot list)`, columns: [...SHOT_LIST_COLUMNS], rows });
  return {
    files: [xlsxFile(`${request.base} (shot list).xlsx`, prepared.sheet)],
    blockCount: listed.rows.length,
    chapterCount: 0,
    sceneCount: 0,
    wordCount: 0,
    skippedDocs: [],
    notes: [...listed.notes, ...prepared.notes, ...bareShotNotes(request)],
  };
}

/**
 * A shot with no metadata on record lists with every column but its number blank, and the renderer writes it so. The
 * log says so, because a shot the writer filled in and the store did not keep looks the same as one nobody filled in.
 */
function bareShotNotes(request: MediaRequest, consequence = 'its columns are blank'): string[] {
  const shots = shotsInBinderOrder(request.state, request.includeRootIds);
  const numbers = exportNumbers(shots);
  return shots
    .filter((node) => {
      const raw = shotFieldOf(node);
      return raw === undefined || raw === null;
    })
    .map((node) => `shot ${numbers.get(node.id) ?? 0}: no shot metadata is on record, so ${consequence}`);
}

/* ------------------------------------------------------------------ *
 * The production format: the contact sheet (storyboard.md §6)
 * ------------------------------------------------------------------ */

/** The header the contact sheet prints on each page, filled from the template variables (storyboard.md §6). */
export const CONTACT_SHEET_HEADER = '{project} — {storyboard} — {date}';

/** Whether a stored picture can be drawn on the sheet: PNG and JPEG are embedded; a WebP file and a missing one show the caption. */
function sheetImageStatus(assets: ReadonlyMap<string, AssetRecord>, assetId: string): SheetImageStatus {
  const record = assets.get(assetId);
  if (record === undefined) {
    return { drawn: false, note: `image ${assetId} is not in assets/, so its cards show the caption` };
  }
  if (/\.webp$/i.test(record.fileName)) {
    return { drawn: false, note: `image ${assetId} is a WebP file, which the PDF cannot embed, so its cards show the caption` };
  }
  return { drawn: true };
}

/**
 * The contact sheet as a PDF: a grid of shot cards in binder order, each with its picture, number chip, spec row and action
 * lines, paginated on A4 or US Letter (storyboard.md §6). The page plan is made here, synchronously, so the gate (a selection
 * with no shot) refuses before anything is reserved; the picture bytes are read and the PDF is drawn when the file renders.
 */
function contactSheetOutput(request: MediaRequest): MediaOutput {
  const shots = shotsInBinderOrder(request.state, request.includeRootIds);
  if (shots.length === 0) {
    throw new MediaRefusedError('contact-sheet-pdf', ['the selection holds no shot, so there is no contact sheet to draw']);
  }
  const pageSize = request.pageSize ?? 'A4';
  const planned = planContactSheet(request.state, request.includeRootIds, (assetId) => sheetImageStatus(request.assets, assetId), {
    pageSize,
    headerTemplate: CONTACT_SHEET_HEADER,
    project: request.title,
    date: request.date,
  });
  const readAsset = request.readAsset;
  const notes = [...planned.notes];
  if (readAsset === undefined && planned.pictures.size > 0) {
    notes.push('contact sheet: this compile cannot read the pictures, so every card shows its caption');
  }
  const pages = planned.plan.pages.length;
  notes.push(`contact sheet: ${pages} ${pages === 1 ? 'page' : 'pages'} of ${planned.plan.cardsPerPage} shots each, ${pageSize}`);
  const at = new Date(request.at ?? Date.now());
  const title = planned.plan.pages[0]?.title.text ?? request.title;
  return {
    files: [
      {
        name: `${request.base} (contact sheet).pdf`,
        mimeType: PDF_MIME,
        bytes: () =>
          drawContactSheet({
            plan: planned.plan,
            pictures: readAsset === undefined ? new Map() : planned.pictures,
            readPicture: async (assetId) => {
              const record = request.assets.get(assetId);
              if (readAsset === undefined || record === undefined) return null;
              return readAsset(`assets/${record.fileName}`);
            },
            title,
            ...(request.author.trim() === '' ? {} : { author: request.author }),
            ...(request.loadFallbackFont === undefined ? {} : { loadFallbackFont: request.loadFallbackFont }),
            ...(request.loadEmojiFont === undefined ? {} : { loadEmojiFont: request.loadEmojiFont }),
            ...(request.loadArabicFont === undefined ? {} : { loadArabicFont: request.loadArabicFont }),
            ...(request.loadHebrewFont === undefined ? {} : { loadHebrewFont: request.loadHebrewFont }),
            ...(request.loadDevanagariFont === undefined ? {} : { loadDevanagariFont: request.loadDevanagariFont }),
            ...(request.language === undefined ? {} : { language: request.language }),
            at,
          }),
      },
    ],
    blockCount: shots.length,
    chapterCount: 0,
    sceneCount: 0,
    wordCount: 0,
    skippedDocs: [],
    notes: [...notes, ...bareShotNotes(request, 'its card shows its number and "No image", with no camera details or action')],
  };
}

/* ------------------------------------------------------------------ *
 * The AI-video format: the prompt pack (video-prompt-pack.md §5)
 * ------------------------------------------------------------------ */

/**
 * The script text a shot covers, each range labelled with its scene's title. The text is the anchor's captured
 * text: the pack does not re-resolve the anchor against the current body (edit-anchors.md §3 owns that).
 */
function coveredOf(state: ProjectState, dialogue: readonly DialogueCoverage[] | undefined): CoveredScript[] {
  return (dialogue ?? []).map((coverage) => ({ label: titleOf(state, coverage.docId), text: coverage.anchor.exact }));
}

/**
 * The stored prompt records of one shot, kept when they have the shape the pack reads. A record that does not
 * is left out and named in the notes, so a hand-edited value cannot reach the vendor mapping as a crash.
 */
function vendorRecordsOf(raw: readonly unknown[] | undefined, shotId: string, notes: string[]): VideoShotRef[] {
  const records: VideoShotRef[] = [];
  for (const item of raw ?? []) {
    if (isPlainObject(item) && typeof item.vendor === 'string' && typeof item.mode === 'string' && isPlainObject(item.prompt)) {
      records.push({ ...item, references: Array.isArray(item.references) ? item.references : [] } as unknown as VideoShotRef);
    } else {
      notes.push(`shot ${shotId}: a prompt record that is not in the prompt pack's shape was left out`);
    }
  }
  return records;
}

/** The storyboard the pack reads, built from the project: the selected shots, the tree, the codex and the assets. */
function storyboardOf(request: MediaRequest, notes: string[]): StoryboardSnapshot {
  const shots = selectedNodes(request.state, request.includeRootIds)
    .filter((node) => isShotNode(node))
    .map((node): ShotNode => {
      const read = readShotMeta(shotFieldOf(node));
      const shotSize = read.meta.shotSize ?? unknownString(read.unknownValues.shotSize);
      const cameraAngle = read.meta.cameraAngle ?? unknownString(read.unknownValues.cameraAngle);
      const cameraMovement = read.meta.cameraMovement ?? unknownString(read.unknownValues.cameraMovement);
      return {
        id: node.id,
        covered: coveredOf(request.state, read.meta.dialogue),
        vendorRefs: vendorRecordsOf(read.meta.vendorRefs, node.id, notes),
        ...(read.meta.action === undefined ? {} : { action: read.meta.action }),
        ...(read.meta.imageAlt === undefined ? {} : { imageAlt: read.meta.imageAlt }),
        ...(shotSize === undefined ? {} : { shotSize }),
        ...(cameraAngle === undefined ? {} : { cameraAngle }),
        ...(cameraMovement === undefined ? {} : { cameraMovement }),
        ...(read.meta.lens === undefined ? {} : { lens: read.meta.lens }),
        ...(read.meta.durationSec === undefined ? {} : { durationSec: read.meta.durationSec }),
      };
    });
  return {
    tree: request.state.manifest.tree,
    shots,
    codex: request.state.manifest.codex ?? [],
    assets: request.assets,
  };
}

function unknownString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The three pack artifacts, the JSON, the Markdown and the CSV, from one run (video-prompt-pack.md §5). The
 * gate is the pack's own, and it is fail-closed: a run with any error row writes nothing, and the rows are named.
 * A warning does not stop it, and it goes into the log.
 */
function promptPackOutput(request: MediaRequest): MediaOutput {
  const vendor = request.vendor;
  if (vendor === undefined || vendor.trim() === '') {
    throw new MediaRefusedError('promptpack', ['the recipe names no vendor template, and a prompt pack is written for one (its templateId)']);
  }
  const template = templateById(vendor);
  if (template === undefined) {
    throw new MediaRefusedError('promptpack', [
      `"${vendor}" is not an installed vendor template. The installed templates are ${VIDEO_TEMPLATE_IDS.join(', ')}`,
    ]);
  }
  const notes: string[] = [];
  const run = preparePack(storyboardOf(request, notes), vendor);
  if (run.shots.length === 0) {
    throw new MediaRefusedError('promptpack', [`no shot in the selection has a prompt for ${template.displayName} yet`]);
  }
  const json = renderPromptPack(run, 'json');
  const markdown = renderPromptPack(run, 'markdown');
  const csv = renderPromptPack(run, 'csv');
  if (!json.ok || !markdown.ok || !csv.ok) {
    throw new MediaRefusedError(
      'promptpack',
      json.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message),
    );
  }
  return {
    files: [
      { name: fileNameFor(vendor, 'json'), mimeType: JSON_MIME, text: json.text },
      { name: fileNameFor(vendor, 'markdown'), mimeType: 'text/markdown;charset=utf-8', text: markdown.text },
      { name: fileNameFor(vendor, 'csv'), mimeType: CSV_MIME, text: csv.text },
    ],
    blockCount: run.shots.length,
    chapterCount: 0,
    sceneCount: 0,
    wordCount: 0,
    skippedDocs: [],
    notes: [...notes, ...json.issues.map((issue) => `${issue.severity}: ${issue.message}`)],
  };
}
