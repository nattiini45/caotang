/**
 * @caotang/import-textbundle: the TextBundle and TextPack reader (#282, epic #263).
 *
 * TextBundle (a `.textbundle` folder) and TextPack (its zip) are the open interchange of the Apple writing apps: Markdown plus
 * `assets/` plus `info.json`. This is a thin layer over the Markdown reader (#280): it finds the bundle's text and info, names the
 * app, applies that app's comments, tags and Content Blocks, and hands the body to the Markdown reader. No DOM, no third-party
 * dependencies: it runs on the main thread, in a `'self'` Worker and in Node.
 */

import type { ImportBlock, ImportDocument } from '@caotang/import-core';
import { naturalCompare, readMarkdownFile, type MarkdownFileFacts } from '@caotang/import-markdown';
import type { ImportArchive } from '@caotang/import-read/zip';
import { decodePlainText } from '@caotang/import-read/text';
import { contentBlockRefs, expandContentBlocks } from './ia.js';

export { contentBlockRefs, csvCells, csvParagraphs, expandContentBlocks, kindOfBlock } from './ia.js';
export type { ContentBlockRef, ContentBlockExpansion } from './ia.js';

export type TextBundleApp = 'ulysses' | 'bear' | 'ia-writer' | 'generic';

/** What the app mapping did, as codes the preview names in the writer's language (the package carries no words). */
export type TextBundleNotice =
  | { kind: 'ulysses-comments'; count: number }
  | { kind: 'bear-tags'; count: number }
  | { kind: 'ia-authorship' }
  | { kind: 'ia-content-blocks'; count: number }
  | { kind: 'ia-csv'; count: number }
  | { kind: 'ia-block-missing'; paths: readonly string[] }
  | { kind: 'ia-block-unsupported'; paths: readonly string[] }
  | { kind: 'bear-dates'; count: number };

/** One note of a many-bundle container: a Bear backup's note, a Ulysses group's sheet. */
export interface TextBundleNote {
  /** The bundle's folder in the archive, e.g. `Bear Notes/ABC.textbundle`. */
  readonly path: string;
  readonly title: string;
  /** Bear tags, in the order the note wrote them. */
  readonly keywords: readonly string[];
  /** The note's own front-matter facts key (its `text.md` path). */
  readonly unit: string;
  /** ISO dates from `info.json`, when the app wrote them. The project has no date field; the preview keeps them as a note line. */
  readonly created?: string;
  readonly modified?: string;
}

export interface TextBundleImport {
  document: ImportDocument;
  frontMatter: Record<string, MarkdownFileFacts>;
  title: string;
  assetData: Map<string, Uint8Array>;
  app: TextBundleApp;
  notices: TextBundleNotice[];
  /** Every bundle the container holds, in import order. One entry for a lone TextBundle. */
  bundles: readonly TextBundleNote[];
  /** `single` for one bundle, `bear-backup` for a `.bear2bk`, `group` for a Ulysses group or any other many-bundle container. */
  container: 'single' | 'bear-backup' | 'group';
}

export type TextBundleError =
  | { kind: 'no-text' }
  | { kind: 'fountain' }
  | { kind: 'ask-encoding' }
  | { kind: 'too-large'; bytes: number; limit: number }
  | { kind: 'too-many-lines'; lines: number; limit: number }
  | { kind: 'archive'; message: string };

export type TextBundleResult = { ok: true; value: TextBundleImport } | { ok: false; error: TextBundleError };

const TEXT_NAMES = ['text.md', 'text.markdown', 'text.mdown', 'text.mkd'];

/** Name the app from info.json's creatorIdentifier, falling back to the bundle's shape. */
export function appOf(info: Record<string, unknown>): TextBundleApp {
  const creator = typeof info['creatorIdentifier'] === 'string' ? (info['creatorIdentifier'] as string).toLowerCase() : '';
  if (creator.includes('ulysses')) return 'ulysses';
  if (creator.includes('bear')) return 'bear';
  if (creator.includes('iawriter') || creator.includes('ia-writer') || creator.includes('pro.writer')) return 'ia-writer';
  return 'generic';
}

/** Ulysses: `%%` comments (a whole line or inline, to the line's end) and `++inline++` comments become notes, never dropped. */
export function ulyssesComments(text: string): { body: string; notes: string[] } {
  const notes: string[] = [];
  let body = text.replace(/%%([^\n]*)/g, (_whole, inner: string) => {
    const clean = inner.trim();
    if (clean !== '') notes.push(clean);
    return '';
  });
  body = body.replace(/\+\+([^+\n]+)\+\+/g, (_whole, inner: string) => {
    const clean = inner.trim();
    if (clean !== '') notes.push(clean);
    return '';
  });
  return { body, notes };
}

/** Bear: `#tag`, `#nested/tag`, closed `#multi word tag#` collected as keywords in the order written; a leading H1 equal to the title is stripped. */
export function bearTags(text: string, title: string): { body: string; keywords: string[] } {
  const keywords: string[] = [];
  const seen = new Set<string>();
  const add = (tag: string): void => {
    const clean = tag.trim();
    if (clean !== '' && !seen.has(clean)) {
      seen.add(clean);
      keywords.push(clean);
    }
  };
  // One pass, so a closed multi-word tag and an open tag keep the order the note wrote them in. Both branches start at the same
  // whitespace, so the closed tag is tried first: without that, `#a closed tag#` would match as the open tag `#a`.
  let body = text.replace(/(^|\s)#([^#\n]*?\s[^#\n]*?[^#\s])#|(^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g, (_whole, closedLead: string, closed: string | undefined, openLead: string, open: string | undefined) => {
    if (closed !== undefined) {
      add(closed);
      return closedLead;
    }
    add(open ?? '');
    return openLead;
  });
  if (title !== '') {
    body = body.replace(new RegExp(`^\\s*#\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n`), '');
  }
  return { body, keywords };
}

/** iA Writer: strip the trailing Authorship block (`---` … `...`), keep `[%key]` variables as text. */
export function iaAuthorship(text: string): { body: string; stripped: boolean } {
  const match = /\n---\s*\n[\s\S]*?\n\.\.\.\s*$/.exec(text);
  if (match === null) return { body: text, stripped: false };
  return { body: text.slice(0, match.index), stripped: true };
}

/** One bundle's files in the archive: its text, and the `info.json` beside it. */
interface BundleFiles {
  readonly dir: string;
  readonly textPath: string;
  readonly infoPath: string | undefined;
}

const dirOf = (path: string): string => path.split('/').slice(0, -1).join('/');
const baseOf = (path: string): string => path.split('/').pop() ?? path;

/**
 * A bundle folder and a relative picture target joined into one container path, with `.` and `..` walked. `null` when the target
 * climbs out of the container, which no entry can answer. A Ulysses sheet reaches its group's pictures with `../assets/x.png`, so
 * the climb is the ordinary case rather than an attack.
 */
function withinContainer(dir: string, target: string): string | null {
  const parts: string[] = dir === '' ? [] : dir.split('/');
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

/** Every bundle the container holds, in natural path order. A `.bear2bk` and a Ulysses group hold many; a TextPack holds one. */
function bundlesOf(paths: readonly string[]): BundleFiles[] {
  return paths
    .filter((path) => TEXT_NAMES.includes(baseOf(path)))
    .map((textPath) => {
      const dir = dirOf(textPath);
      return { dir, textPath, infoPath: paths.find((path) => dirOf(path) === dir && baseOf(path) === 'info.json') };
    })
    .sort((a, b) => naturalCompare(a.textPath, b.textPath));
}

const stringOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** The dates `info.json` carries: the TextBundle fields, or Bear's own dictionary in a `.bear2bk`. */
export function bundleDates(info: Record<string, unknown>): { created?: string; modified?: string } {
  const bear = info['net.shinyfrog.bear'];
  const own = typeof bear === 'object' && bear !== null ? (bear as Record<string, unknown>) : {};
  const created = stringOf(info['creationDate']) ?? stringOf(own['creationDate']);
  const modified = stringOf(info['modificationDate']) ?? stringOf(own['modificationDate']);
  return { ...(created === undefined ? {} : { created }), ...(modified === undefined ? {} : { modified }) };
}

/** One bundle read and mapped: its app, its body after that app's mapping, and what the mapping kept aside. */
interface MappedBundle {
  readonly files: BundleFiles;
  readonly app: TextBundleApp;
  readonly title: string;
  readonly text: string;
  readonly notes: string[];
  readonly keywords: string[];
  readonly created?: string;
  readonly modified?: string;
  readonly authorship: boolean;
}

async function readBundle(archive: ImportArchive, files: BundleFiles): Promise<{ ok: true; value: MappedBundle } | { ok: false; error: TextBundleError }> {
  let info: Record<string, unknown> = {};
  if (files.infoPath !== undefined) {
    const read = await archive.read(files.infoPath);
    if (read.ok) {
      try {
        info = JSON.parse(new TextDecoder().decode(read.value)) as Record<string, unknown>;
      } catch {
        info = {};
      }
    }
  }
  const app = appOf(info);
  const read = await archive.read(files.textPath);
  if (!read.ok) return { ok: false, error: { kind: 'archive', message: read.error.message } };
  const decoded = decodePlainText(read.value);
  if (decoded.status === 'ask') return { ok: false, error: { kind: 'ask-encoding' } };
  if (decoded.status === 'too-large') return { ok: false, error: { kind: 'too-large', bytes: decoded.bytes, limit: decoded.limit } };
  if (decoded.status === 'too-many-lines') return { ok: false, error: { kind: 'too-many-lines', lines: decoded.lines, limit: decoded.limit } };

  let text = decoded.text;
  const notes: string[] = [];
  let keywords: string[] = [];
  const title = stringOf(info['title']) ?? '';
  let authorship = false;

  if (app === 'ulysses') {
    const result = ulyssesComments(text);
    text = result.body;
    notes.push(...result.notes);
  } else if (app === 'bear') {
    const result = bearTags(text, title);
    text = result.body;
    keywords = result.keywords;
  } else if (app === 'ia-writer') {
    const result = iaAuthorship(text);
    text = result.body;
    authorship = result.stripped;
  }
  return { ok: true, value: { files, app, title, text, notes, keywords, ...bundleDates(info), authorship } };
}

/** The archive's text files by path, for Content Blocks: read only when a body actually names one. */
async function textFilesOf(archive: ImportArchive, paths: readonly string[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const path of paths) {
    if (!/\.(md|markdown|mdown|mkd|txt|csv|tsv)$/i.test(path)) continue;
    const read = await archive.read(path);
    if (!read.ok) continue;
    const decoded = decodePlainText(read.value);
    if (decoded.status !== 'decoded') continue;
    files.set(path, decoded.text);
    // A block is rooted at the container, so a bundle's own file answers to its name without the bundle folder too.
    const base = baseOf(path);
    if (!files.has(base)) files.set(base, decoded.text);
  }
  return files;
}

/**
 * Read a TextBundle, a TextPack, a Ulysses group export or a Bear `.bear2bk` opened as an archive. One bundle is one document; many
 * bundles become one document with a chapter per note, in the container's order.
 */
export async function readTextBundle(archive: ImportArchive): Promise<TextBundleResult> {
  const paths = archive.entries.map((e) => e.path);
  const bundles = bundlesOf(paths);
  if (bundles.length === 0) {
    const fountainPath = paths.find((p) => baseOf(p) === 'text.fountain');
    if (fountainPath !== undefined) return { ok: false, error: { kind: 'fountain' } };
    return { ok: false, error: { kind: 'no-text' } };
  }

  const mapped: MappedBundle[] = [];
  for (const files of bundles) {
    const read = await readBundle(archive, files);
    if (!read.ok) return read;
    mapped.push(read.value);
  }
  const app = mapped.find((bundle) => bundle.app !== 'generic')?.app ?? 'generic';
  const container: TextBundleImport['container'] = mapped.length === 1 ? 'single' : app === 'bear' ? 'bear-backup' : 'group';

  // A Bear backup reads in the order the notes were written; every other container keeps its folder order.
  const order = container === 'bear-backup'
    ? [...mapped].sort((a, b) => (a.created ?? '').localeCompare(b.created ?? '') || naturalCompare(a.files.textPath, b.files.textPath))
    : mapped;

  // iA Writer's Content Blocks name files in the container. Read them only when a body names one.
  const needsFiles = order.some((bundle) => contentBlockRefs(bundle.text).length > 0);
  const textFiles = needsFiles ? await textFilesOf(archive, paths) : new Map<string, string>();

  const notices: TextBundleNotice[] = [];
  const blocks: ImportBlock[] = [];
  const footnotes: NonNullable<ImportDocument['footnotes']> = [];
  const losses: NonNullable<ImportDocument['losses']> = [];
  const assets: NonNullable<ImportDocument['assets']> = [];
  const frontMatter: Record<string, MarkdownFileFacts> = {};
  const assetData = new Map<string, Uint8Array>();
  const notes: TextBundleNote[] = [];
  const imageTargets = new Map<string, { target: string; dir: string }>();
  let ulyssesCount = 0;
  let tagCount = 0;
  let dateCount = 0;
  let blockCount = 0;
  let csvCount = 0;
  let authorship = false;
  const missing: string[] = [];
  const unsupported: string[] = [];
  let title = '';

  for (const [index, bundle] of order.entries()) {
    let text = bundle.text;
    if (needsFiles && contentBlockRefs(text).length > 0) {
      const expanded = expandContentBlocks(text, textFiles);
      text = expanded.body;
      blockCount += expanded.included.length + expanded.images.length;
      csvCount += expanded.csv.length;
      missing.push(...expanded.missing);
      unsupported.push(...expanded.unsupported);
    }

    // A lone bundle keeps its file name as the unit; a container's notes are keyed by their own path.
    const unit = container === 'single' ? baseOf(bundle.files.textPath) : bundle.files.textPath;
    const markdown = readMarkdownFile(new TextEncoder().encode(text), unit, container === 'single' ? {} : { tokenNamespace: String(index) });
    if (!markdown.ok) {
      const error = markdown.error;
      if (error.kind === 'ask-encoding') return { ok: false, error: { kind: 'ask-encoding' } };
      if (error.kind === 'too-large') return { ok: false, error: { kind: 'too-large', bytes: error.bytes, limit: error.limit } };
      if (error.kind === 'too-many-lines') return { ok: false, error: { kind: 'too-many-lines', lines: error.lines, limit: error.limit } };
      return { ok: false, error: { kind: 'no-text' } };
    }
    const value = markdown.value;
    const noteTitle = bundle.title !== '' ? bundle.title : value.title;
    if (title === '') title = noteTitle;

    const facts = value.frontMatter[unit];
    if (facts !== undefined) {
      if (bundle.keywords.length > 0) facts.scene.keywords = [...(facts.scene.keywords ?? []), ...bundle.keywords];
      if (bundle.notes.length > 0) facts.notes = facts.notes === '' ? bundle.notes.join('\n\n') : `${facts.notes}\n\n${bundle.notes.join('\n\n')}`;
      frontMatter[unit] = facts;
    }

    const offset = blocks.length;
    // Each note of a container is a chapter of its own, named as the app named it.
    if (container !== 'single') blocks.push({ kind: 'heading', level: 1, text: noteTitle, md: `# ${noteTitle}`, src: { sourceUnit: unit } });
    blocks.push(...value.document.blocks);
    for (const fn of value.document.footnotes ?? []) footnotes.push({ ...fn, blockIndex: fn.blockIndex + offset });
    losses.push(...(value.document.losses ?? []));
    for (const asset of value.document.assets ?? []) assets.push(asset);
    for (const [token, target] of value.imageTargets) imageTargets.set(token, { target, dir: bundle.files.dir });

    ulyssesCount += bundle.notes.length;
    tagCount += bundle.keywords.length;
    if (bundle.created !== undefined || bundle.modified !== undefined) dateCount += 1;
    authorship = authorship || bundle.authorship;
    notes.push({
      path: bundle.files.dir === '' ? baseOf(bundle.files.textPath) : bundle.files.dir,
      title: noteTitle,
      keywords: bundle.keywords,
      unit,
      ...(bundle.created === undefined ? {} : { created: bundle.created }),
      ...(bundle.modified === undefined ? {} : { modified: bundle.modified }),
    });
  }

  // Resolve each picture against its own bundle's assets/ first, then anywhere in the container.
  for (const asset of assets) {
    const held = imageTargets.get(asset.ref);
    if (held === undefined) continue;
    const clean = held.target.replace(/[?#].*$/, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) continue; // remote: never fetched here
    const own = withinContainer(held.dir, clean);
    const ownAssets = withinContainer(held.dir === '' ? 'assets' : `${held.dir}/assets`, clean);
    const root = withinContainer('', clean);
    const candidates = [
      own,
      ownAssets,
      root,
      root === null || root === '' ? null : `assets/${root}`,
      ...paths.filter((path) => own !== null && (path.endsWith(`/${own}`) || path === own)),
    ].filter((path): path is string => path !== null && path !== '');
    for (const candidate of candidates) {
      if (archive.entry(candidate) === undefined) continue;
      const bytes = await archive.read(candidate);
      if (!bytes.ok) continue;
      assetData.set(asset.ref, bytes.value);
      asset.bytes = bytes.value.length;
      asset.name = baseOf(candidate);
      break;
    }
  }

  if (ulyssesCount > 0) notices.push({ kind: 'ulysses-comments', count: ulyssesCount });
  if (tagCount > 0) notices.push({ kind: 'bear-tags', count: tagCount });
  if (authorship) notices.push({ kind: 'ia-authorship' });
  if (blockCount > 0) notices.push({ kind: 'ia-content-blocks', count: blockCount });
  if (csvCount > 0) notices.push({ kind: 'ia-csv', count: csvCount });
  if (missing.length > 0) notices.push({ kind: 'ia-block-missing', paths: [...new Set(missing)] });
  if (unsupported.length > 0) notices.push({ kind: 'ia-block-unsupported', paths: [...new Set(unsupported)] });
  if (dateCount > 0) notices.push({ kind: 'bear-dates', count: dateCount });

  const document: ImportDocument = { blocks, footnotes, losses, assets, ...(title === '' ? {} : { metadata: { title } }) };
  return { ok: true, value: { document, frontMatter, title, assetData, app, notices, bundles: notes, container } };
}



