/**
 * @caotang/import-markdown: the Markdown reader (#280, epic #263).
 *
 * Reads a single `.md` file, a folder of chapters and scenes, or a zip of
 * either, into the import block list (import-core.md §2) with its front matter
 * mapped and its losses. No DOM, no third-party dependencies: it runs on the
 * main thread, in a `'self'` Worker and in Node. Deciding where chapters and
 * scenes start is the shared splitter's job; this reader only emits blocks and
 * the per-file front-matter facts.
 */

import type { ImportAsset, ImportDocument } from '@caotang/import-core';
import { decodePlainText } from '@caotang/import-read/text';
import type { DecodableEncoding } from '@caotang/store/encoding';
import { isArchiveResidue, type ImportArchive } from '@caotang/import-read/zip';
import { parseMarkdownBody } from './markdown.js';
import { splitFrontMatter, mapFrontMatter, type MarkdownSceneFacts } from './frontmatter.js';

export { parseMarkdownBody } from './markdown.js';
export { splitFrontMatter, mapFrontMatter } from './frontmatter.js';
export type { MarkdownSceneFacts, MappedFrontMatter, FrontMatterFormat } from './frontmatter.js';

/** The front-matter facts for one source file, keyed by its `sourceUnit`. */
export interface MarkdownFileFacts {
  scene: MarkdownSceneFacts;
  notes: string;
}

export interface MarkdownImport {
  document: ImportDocument;
  /** Per-file front matter, keyed by the blocks' `sourceUnit`. */
  frontMatter: Record<string, MarkdownFileFacts>;
  /** The import's title: the first file's `title`, else the folder/file name. */
  title: string;
}

export type MarkdownError =
  | { kind: 'ask-encoding'; suggested: DecodableEncoding | undefined }
  | { kind: 'too-large'; bytes: number; limit: number }
  | { kind: 'too-many-lines'; lines: number; limit: number }
  | { kind: 'no-markdown' }
  | { kind: 'archive'; message: string };

export type MarkdownResult = { ok: true; value: MarkdownImport } | { ok: false; error: MarkdownError };

const MD_EXT = /\.(md|markdown|mdown|mkd)$/i;

/** Numeric-prefix natural sort: `2.md` before `10.md`, case-insensitive. */
export function naturalCompare(a: string, b: string): number {
  const ax = a.toLowerCase();
  const bx = b.toLowerCase();
  const re = /(\d+)|(\D+)/g;
  const ap = ax.match(re) ?? [];
  const bp = bx.match(re) ?? [];
  for (let i = 0; i < Math.max(ap.length, bp.length); i += 1) {
    const as = ap[i];
    const bs = bp[i];
    if (as === undefined) return -1;
    if (bs === undefined) return 1;
    const an = /^\d/.test(as) ? Number(as) : NaN;
    const bn = /^\d/.test(bs) ? Number(bs) : NaN;
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an - bn;
    } else if (as !== bs) {
      return as < bs ? -1 : 1;
    }
  }
  return 0;
}

const titleFromName = (name: string): string => {
  const base = name.split('/').pop() ?? name;
  return base.replace(MD_EXT, '').replace(/^\d+[ \t._-]+/, '').trim() || base;
};

interface ReadOptions {
  encoding?: DecodableEncoding;
}

/** Read one Markdown file's bytes into blocks and front-matter facts. */
export function readMarkdownFile(bytes: Uint8Array, fileName: string, options: ReadOptions = {}): MarkdownResult {
  const decoded = decodePlainText(bytes, options.encoding ? { encoding: options.encoding } : {});
  if (decoded.status === 'ask') return { ok: false, error: { kind: 'ask-encoding', suggested: decoded.suggested } };
  if (decoded.status === 'too-large') return { ok: false, error: { kind: 'too-large', bytes: decoded.bytes, limit: decoded.limit } };
  if (decoded.status === 'too-many-lines') return { ok: false, error: { kind: 'too-many-lines', lines: decoded.lines, limit: decoded.limit } };

  const { front, format, body } = splitFrontMatter(decoded.text);
  const parsed = parseMarkdownBody(body, fileName);
  const mapped = front !== null && format !== null ? mapFrontMatter(front, format) : { metadata: {}, scene: {}, notes: '' };

  const document: ImportDocument = {
    blocks: parsed.blocks,
    footnotes: parsed.footnotes,
    losses: parsed.losses,
    metadata: mapped.metadata,
    assets: parsed.imageRefs.map((ref) => ({ ref })),
  };
  const title = mapped.metadata.title ?? titleFromName(fileName);
  return {
    ok: true,
    value: {
      document,
      frontMatter: { [fileName]: { scene: mapped.scene, notes: mapped.notes } },
      title,
    },
  };
}

/** The Markdown files of an archive, in natural order, residue and non-Markdown left out. */
function markdownPaths(archive: ImportArchive): string[] {
  return archive.entries
    .map((e) => e.path)
    .filter((p) => MD_EXT.test(p) && !isArchiveResidue(p))
    .sort(naturalCompare);
}

/**
 * Read a folder or zip of Markdown files. Each file is a scene (`sourceUnit`);
 * the shared splitter turns a change of directory into a chapter boundary.
 * Relative images are resolved against the archive when their bytes are there.
 */
export async function readMarkdownArchive(archive: ImportArchive, options: ReadOptions = {}): Promise<MarkdownResult> {
  const paths = markdownPaths(archive);
  if (paths.length === 0) return { ok: false, error: { kind: 'no-markdown' } };

  const blocks: ImportDocument['blocks'] = [];
  const footnotes: NonNullable<ImportDocument['footnotes']> = [];
  const losses: NonNullable<ImportDocument['losses']> = [];
  const frontMatter: Record<string, MarkdownFileFacts> = {};
  const assets = new Map<string, ImportAsset>();
  let title: string | undefined;

  for (const path of paths) {
    const read = await archive.read(path);
    if (!read.ok) return { ok: false, error: { kind: 'archive', message: read.error.message } };
    const decoded = decodePlainText(read.value, options.encoding ? { encoding: options.encoding } : {});
    if (decoded.status === 'ask') return { ok: false, error: { kind: 'ask-encoding', suggested: decoded.suggested } };
    if (decoded.status === 'too-large') return { ok: false, error: { kind: 'too-large', bytes: decoded.bytes, limit: decoded.limit } };
    if (decoded.status === 'too-many-lines') return { ok: false, error: { kind: 'too-many-lines', lines: decoded.lines, limit: decoded.limit } };

    const { front, format, body } = splitFrontMatter(decoded.text);
    const parsed = parseMarkdownBody(body, path);
    const mapped = front !== null && format !== null ? mapFrontMatter(front, format) : { metadata: {}, scene: {}, notes: '' };
    if (title === undefined && mapped.metadata.title) title = mapped.metadata.title;

    const offset = blocks.length;
    blocks.push(...parsed.blocks);
    for (const fn of parsed.footnotes) footnotes.push({ ...fn, blockIndex: fn.blockIndex + offset });
    losses.push(...parsed.losses);
    frontMatter[path] = { scene: mapped.scene, notes: mapped.notes };
    for (const ref of parsed.imageRefs) if (!assets.has(ref)) assets.set(ref, { ref });
  }

  // Resolve relative image bytes against the archive, nearest the file's folder.
  const resolved = await resolveImages(archive, paths, assets);

  const document: ImportDocument = {
    blocks,
    footnotes,
    losses,
    ...(title !== undefined ? { metadata: { title } } : {}),
    assets: [...resolved.values()],
  };
  return { ok: true, value: { document, frontMatter, title: title ?? titleFromName(paths[0] as string) } };
}

/** Fill image assets with bytes from the archive where a matching file exists. */
async function resolveImages(
  archive: ImportArchive,
  paths: readonly string[],
  assets: Map<string, ImportAsset>,
): Promise<Map<string, ImportAsset>> {
  if (assets.size === 0) return assets;
  const dirs = [...new Set(paths.map((p) => p.split('/').slice(0, -1).join('/')))];
  for (const [ref, asset] of assets) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) continue; // remote: opt-in elsewhere
    const clean = ref.replace(/^\.\//, '');
    const candidates = dirs.map((d) => (d === '' ? clean : `${d}/${clean}`));
    for (const candidate of candidates) {
      const entry = archive.entry(candidate);
      if (!entry) continue;
      const read = await archive.read(candidate);
      if (read.ok) {
        assets.set(ref, { ...asset, name: candidate.split('/').pop(), bytes: read.value.length });
        break;
      }
    }
  }
  return assets;
}
