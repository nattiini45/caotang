/**
 * The NovelCrafter export reader (#292, epic #263): reads a NovelCrafter export (a folder or its zip) over the
 * Markdown reader. Each folder holding an `entry.md` is a codex entry (its `metadata.json` relations and `notes.md`
 * kept, a thumbnail resolved); every Markdown file outside a codex folder is the manuscript. No DOM, no third-party
 * dependencies, so it runs on the main thread, in a 'self' Worker and in Node.
 */

import type { ImportDocument } from '@caotang/import-core';
import { readMarkdownArchive, splitFrontMatter, naturalCompare, type MarkdownFileFacts, type MarkdownError } from '@caotang/import-markdown';
import { isArchiveResidue, ImportArchiveError, type ImportArchive } from '@caotang/import-read/zip';
import { parseFrontMatterFields, type FrontMatterField } from '@caotang/store/frontmatter';
import {
  typeFromFolder,
  typeFromWord,
  parseRelations,
  countProgressions,
  type CodexType,
  type NovelCrafterCodexEntry,
} from './codex.js';

export interface NovelCrafterImport {
  document: ImportDocument;
  /** Per-file front matter for the manuscript, keyed by the blocks' `sourceUnit`. */
  frontMatter: Record<string, MarkdownFileFacts>;
  title: string;
  /** Resolved picture bytes by asset ref (manuscript pictures and codex thumbnails). */
  assetData: Map<string, Uint8Array>;
  codex: readonly NovelCrafterCodexEntry[];
  /** What NovelCrafter keeps that the export does not carry. */
  lost: { progressions: number };
  /**
   * Markdown in the export that was left out because the writer picked a manuscript file beside the zip. Named, never
   * dropped silently: the picked file is the manuscript, and the export's own is reported.
   */
  leftOut: readonly string[];
}

/**
 * A manuscript the writer picked beside the codex zip. NovelCrafter exports the two separately, so a full project arrives as
 * `novel.md` and `codex.zip`; the picked file becomes the manuscript and the zip still supplies the codex and any pictures.
 */
export interface NovelCrafterManuscript {
  /** The file's name as picked; it is the manuscript's source unit, so its front matter keys on it. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export type NovelCrafterError = { kind: 'empty' } | { kind: 'archive'; message: string };
export type NovelCrafterResult = { ok: true; value: NovelCrafterImport } | { ok: false; error: NovelCrafterError };

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif|tiff?)$/i;
const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd|txt)$/i;
const ENTRY_MD = /(^|\/)entry\.md$/i;
/** Front-matter keys that name the entry or map to a codex slot, rather than a custom field. */
const KNOWN_ENTRY_KEYS = new Set(['name', 'title', 'aliases', 'tags', 'type', 'category', 'synopsis', 'summary', 'description']);

const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const baseOf = (path: string): string => path.split('/').pop() ?? path;

/** Read a NovelCrafter export: its codex entries and any manuscript Markdown outside the codex folders. */
export async function readNovelCrafterExport(archive: ImportArchive, manuscript?: NovelCrafterManuscript): Promise<NovelCrafterResult> {
  const paths = archive.entries.map((entry) => entry.path).filter((path) => !isArchiveResidue(path));
  const entryMdPaths = paths.filter((path) => ENTRY_MD.test(path)).sort(naturalCompare);
  const codexDirs = new Set(entryMdPaths.map(dirOf));

  const codex: NovelCrafterCodexEntry[] = [];
  const assetData = new Map<string, Uint8Array>();
  const thumbnails: { ref: string; name: string; bytes: number }[] = [];
  let progressions = 0;
  for (const entryMdPath of entryMdPaths) {
    const read = await readCodexEntry(archive, entryMdPath, paths, assetData, thumbnails);
    if (read === null) continue;
    codex.push(read.entry);
    progressions += read.progressions;
  }

  // The manuscript is every Markdown file outside a codex folder, read by the Markdown reader — or the one file the writer
  // picked beside the zip, in which case the export's own Markdown is left out and named.
  const outside = withoutCodex(archive, codexDirs);
  const leftOut =
    manuscript === undefined ? [] : outside.entries.map((entry) => entry.path).filter((path) => MARKDOWN_EXT.test(path) && path !== manuscript.path);
  const manuscriptView = manuscript === undefined ? outside : withPickedManuscript(outside, manuscript);
  const read = await readMarkdownArchive(manuscriptView);
  let document: ImportDocument;
  let frontMatter: Record<string, MarkdownFileFacts>;
  let title: string;
  if (read.ok) {
    document = read.value.document;
    frontMatter = read.value.frontMatter;
    title = read.value.title;
    for (const [ref, bytes] of read.value.assetData) assetData.set(ref, bytes);
  } else if (read.error.kind === 'no-markdown') {
    document = { blocks: [] };
    frontMatter = {};
    title = '';
  } else {
    return { ok: false, error: { kind: 'archive', message: manuscriptMessage(read.error) } };
  }

  // Codex thumbnails are assets too, so the preview counts them and the commit keeps them.
  if (thumbnails.length > 0) document.assets = [...(document.assets ?? []), ...thumbnails];

  if (codex.length === 0 && document.blocks.length === 0) return { ok: false, error: { kind: 'empty' } };
  return { ok: true, value: { document, frontMatter, title, assetData, codex, lost: { progressions }, leftOut } };
}

function manuscriptMessage(error: MarkdownError): string {
  switch (error.kind) {
    case 'ask-encoding':
      return 'The manuscript’s text encoding could not be recognised. Save it as UTF-8 and import it again.';
    case 'too-large':
      return 'The manuscript is larger than a Markdown import reads.';
    case 'too-many-lines':
      return 'The manuscript has more lines than a Markdown import reads.';
    case 'archive':
      return error.message;
    default:
      return 'The manuscript could not be read.';
  }
}

/** One codex entry from its folder, or null when its `entry.md` cannot be read. */
async function readCodexEntry(
  archive: ImportArchive,
  entryMdPath: string,
  paths: readonly string[],
  assetData: Map<string, Uint8Array>,
  thumbnails: { ref: string; name: string; bytes: number }[],
): Promise<{ entry: NovelCrafterCodexEntry; progressions: number } | null> {
  const read = await archive.read(entryMdPath);
  if (!read.ok) return null;
  const entryDir = dirOf(entryMdPath);
  const folderName = baseOf(entryDir);
  const { front, body } = splitFrontMatter(new TextDecoder().decode(read.value));
  const fields: ReadonlyMap<string, FrontMatterField> = front !== null ? parseFrontMatterFields(front) : new Map();

  const scalar = (key: string): string | undefined => {
    const field = fields.get(key);
    if (field === undefined) return undefined;
    if (field.inline) return field.inline.join(', ');
    return field.scalar ?? undefined;
  };
  const listOf = (key: string): string[] => {
    const field = fields.get(key);
    if (field === undefined) return [];
    if (field.inline) return field.inline.filter((item) => item.trim() !== '');
    if (field.scalar !== undefined && field.scalar !== null && field.scalar.trim() !== '') return [field.scalar.trim()];
    return [];
  };

  // metadata.json: relations, a type word, progressions and a named thumbnail.
  let metadata: unknown = null;
  const metadataPath = entryDir === '' ? 'metadata.json' : `${entryDir}/metadata.json`;
  const metadataRead = await archive.read(metadataPath);
  if (metadataRead.ok) {
    try {
      metadata = JSON.parse(new TextDecoder().decode(metadataRead.value));
    } catch {
      metadata = null;
    }
  }
  const metaRecord = typeof metadata === 'object' && metadata !== null ? (metadata as Record<string, unknown>) : {};
  const metaWord = (key: string): string => (typeof metaRecord[key] === 'string' ? (metaRecord[key] as string) : '');

  const parentFolder = baseOf(dirOf(entryDir));
  const type: CodexType =
    typeFromFolder(parentFolder) ?? typeFromWord(metaWord('type')) ?? typeFromWord(metaWord('category')) ?? typeFromWord(scalar('type') ?? '') ?? typeFromWord(scalar('category') ?? '') ?? 'other';

  const customFields: Record<string, string | readonly string[]> = {};
  for (const [key, field] of fields) {
    if (KNOWN_ENTRY_KEYS.has(key.toLowerCase())) continue;
    if (field.inline) customFields[key] = [...field.inline];
    else if (field.scalar !== undefined && field.scalar !== null) customFields[key] = field.scalar;
  }

  let notes = '';
  const notesPath = entryDir === '' ? 'notes.md' : `${entryDir}/notes.md`;
  const notesRead = await archive.read(notesPath);
  if (notesRead.ok) notes = splitFrontMatter(new TextDecoder().decode(notesRead.value)).body.trim();

  // A thumbnail: one metadata.json names, else the first image in the entry folder.
  const thumbnail = await readThumbnail(archive, entryDir, paths, metaWord('thumbnail'), assetData, thumbnails);

  const entry: NovelCrafterCodexEntry = {
    path: entryDir === '' ? folderName : entryDir,
    name: scalar('name') ?? scalar('title') ?? folderName,
    type,
    aliases: listOf('aliases'),
    keywords: listOf('tags'),
    description: body.trim(),
    fields: customFields,
    relations: parseRelations(metadata),
    notes,
    ...(thumbnail === undefined ? {} : { thumbnail }),
  };
  return { entry, progressions: countProgressions(metadata) };
}

/**
 * Resolve a thumbnail to an asset ref and read its bytes, or undefined when the entry has none.
 *
 * The ref is a token of this source's own numbering, never the archive path: the commit replaces `](import:…)` only
 * (`rewritePictureRefs`, pictures.md D5) and its whole-batch validation refuses a ref with a space, so a path-shaped ref would
 * leave the research page pointing at nothing. The path stays the picture's display name.
 */
async function readThumbnail(
  archive: ImportArchive,
  entryDir: string,
  paths: readonly string[],
  named: string,
  assetData: Map<string, Uint8Array>,
  thumbnails: { ref: string; name: string; bytes: number }[],
): Promise<string | undefined> {
  const inFolder = paths.filter((path) => dirOf(path) === entryDir && IMAGE_EXT.test(path));
  let target: string | undefined;
  if (named !== '') {
    const base = baseOf(named);
    target = inFolder.find((path) => baseOf(path) === base) ?? paths.find((path) => baseOf(path) === base && IMAGE_EXT.test(path));
  }
  target = target ?? inFolder.find((path) => /thumbnail/i.test(baseOf(path))) ?? inFolder[0];
  if (target === undefined) return undefined;
  const read = await archive.read(target);
  if (!read.ok) return undefined;
  const ref = `import:novelcrafter-thumb-${thumbnails.length + 1}`;
  assetData.set(ref, read.value);
  thumbnails.push({ ref, name: baseOf(target), bytes: read.value.length });
  return ref;
}

/** A view of the archive with the codex folders removed, so the Markdown reader sees only the manuscript. */
function withoutCodex(archive: ImportArchive, codexDirs: ReadonlySet<string>): ImportArchive {
  const underCodex = (path: string): boolean => {
    for (const dir of codexDirs) {
      if (dir === '') return true;
      if (path === dir || path.startsWith(`${dir}/`)) return true;
    }
    return false;
  };
  const entries = archive.entries.filter((entry) => !underCodex(entry.path));
  return {
    kind: archive.kind,
    entries,
    ignored: archive.ignored,
    entry: (path) => (underCodex(path) ? undefined : archive.entry(path)),
    read: async (path) => (underCodex(path) ? { ok: false, error: new ImportArchiveError('not-found', `${path} is a codex entry`, path) } : archive.read(path)),
    readMany: async (paths) => archive.readMany(paths.filter((path) => !underCodex(path))),
  };
}

/**
 * The same view with the writer's picked manuscript as its only Markdown: the export's other Markdown is hidden (and named in
 * `leftOut`), while its pictures stay readable so a manuscript that references them still resolves. The picked file's bytes
 * come from the pick, not the archive, and its size is the Markdown reader's own cap to judge.
 */
function withPickedManuscript(archive: ImportArchive, file: NovelCrafterManuscript): ImportArchive {
  const entry = { path: file.path, size: file.bytes.length, compressedSize: file.bytes.length };
  const hidden = (path: string): boolean => path !== file.path && MARKDOWN_EXT.test(path);
  const entries = [...archive.entries.filter((held) => !hidden(held.path) && held.path !== file.path), entry];
  const notFound = (path: string): { ok: false; error: ImportArchiveError } => ({
    ok: false,
    error: new ImportArchiveError('not-found', `${path} was left out for the picked manuscript`, path),
  });
  return {
    kind: archive.kind,
    entries,
    ignored: archive.ignored,
    entry: (path) => (path === file.path ? entry : hidden(path) ? undefined : archive.entry(path)),
    read: async (path) => (path === file.path ? { ok: true, value: file.bytes } : hidden(path) ? notFound(path) : archive.read(path)),
    readMany: async (paths) => {
      const own = paths.filter((path) => path === file.path);
      const rest = paths.filter((path) => path !== file.path);
      if (rest.some(hidden)) return notFound(rest.find(hidden) ?? file.path);
      const read = rest.length === 0 ? { ok: true as const, value: new Map<string, Uint8Array>() } : await archive.readMany(rest);
      if (!read.ok) return read;
      const merged = new Map(read.value);
      if (own.length > 0) merged.set(file.path, file.bytes);
      return { ok: true as const, value: merged };
    },
  };
}
