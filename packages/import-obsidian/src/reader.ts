/**
 * The Obsidian vault reader (#281, epic #263): reads a vault (a folder or its zip) over the Markdown
 * reader. It skips `.obsidian/`, `.trash/`, templates, `.canvas` and `.base`, names the Longform index,
 * classifies codex notes, resolves each manuscript note's Obsidian syntax and attachments, and hands
 * the manuscript to the Markdown reader. No DOM, no third-party dependencies.
 */

import type { ImportDocument } from '@caotang/import-core';
import { parseMarkdownBody, splitFrontMatter, mapFrontMatter, type MarkdownFileFacts } from '@caotang/import-markdown';
import type { ImportArchive } from '@caotang/import-read/zip';
import { preprocessObsidian } from './obsidian.js';
import { parseLongformIndex, chooseDraft, type LongformIndex } from './longform.js';
import { classifyCodexNote, resolveAttachment, type CodexType } from './vault.js';

export interface ObsidianCodexNote {
  readonly path: string;
  readonly name: string;
  readonly type: CodexType;
  readonly aliases: readonly string[];
  readonly keywords: readonly string[];
  readonly body: string;
}

export interface ObsidianImport {
  document: ImportDocument;
  frontMatter: Record<string, MarkdownFileFacts>;
  title: string;
  assetData: Map<string, Uint8Array>;
  codex: readonly ObsidianCodexNote[];
  longform: LongformIndex | null;
  /** Notes left out without importing: `.obsidian/`, `.trash/`, templates, `.canvas`, `.base`. */
  skipped: readonly string[];
}

export type ObsidianError = { kind: 'no-markdown' } | { kind: 'archive'; message: string };
export type ObsidianResult = { ok: true; value: ObsidianImport } | { ok: false; error: ObsidianError };

const MD_EXT = /\.(md|markdown|mdown|mkd)$/i;

/** Whether a vault path is a note the import reads (not config, trash, a template, a canvas or a base). */
function isNote(path: string): boolean {
  if (!MD_EXT.test(path)) return false;
  const lower = path.toLowerCase();
  if (lower.startsWith('.obsidian/') || lower.startsWith('.trash/')) return false;
  if (lower.includes('/templates/') || lower.startsWith('templates/')) return false;
  return true;
}

function isSkipped(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.startsWith('.obsidian/') || lower.startsWith('.trash/') || lower.endsWith('.canvas') || lower.endsWith('.base') || lower.includes('/templates/') || lower.startsWith('templates/');
}

/** Read an Obsidian vault opened as an archive. */
export async function readObsidianVault(archive: ImportArchive): Promise<ObsidianResult> {
  const paths = archive.entries.map((entry) => entry.path);
  const notePaths = paths.filter(isNote);
  const skipped = paths.filter(isSkipped);
  if (notePaths.length === 0) return { ok: false, error: { kind: 'no-markdown' } };

  // The vault's attachment folder, from .obsidian/app.json when it is there.
  let attachmentFolder = '';
  const appPath = paths.find((path) => path.toLowerCase().endsWith('.obsidian/app.json'));
  if (appPath !== undefined) {
    const read = await archive.read(appPath);
    if (read.ok) {
      try {
        const app = JSON.parse(new TextDecoder().decode(read.value)) as Record<string, unknown>;
        if (typeof app['attachmentFolderPath'] === 'string') attachmentFolder = app['attachmentFolderPath'];
      } catch {
        attachmentFolder = '';
      }
    }
  }

  const codex: ObsidianCodexNote[] = [];
  const frontMatter: Record<string, MarkdownFileFacts> = {};
  const blocks: ImportDocument['blocks'] = [];
  const assetData = new Map<string, Uint8Array>();
  let longform: LongformIndex | null = null;
  let title = '';
  const embedTargets = new Map<string, { target: string; notePath: string }>();

  for (const path of notePaths) {
    const read = await archive.read(path);
    if (!read.ok) return { ok: false, error: { kind: 'archive', message: read.error.message } };
    const text = new TextDecoder().decode(read.value);
    const split = splitFrontMatter(text);

    // A Longform index names the project; keep the highest draft.
    if (split.front !== null) {
      const index = parseLongformIndex(split.front.split('\n'));
      if (index !== null) {
        longform = chooseDraft(longform === null ? [index] : [longform, index]);
        if (title === '' && index.title !== '') title = index.title;
        continue;
      }
    }

    const pre = preprocessObsidian(split.body);
    const mapped = split.front !== null && split.format !== null ? mapFrontMatter(split.front, split.format) : null;
    const props: Record<string, string> = {};
    const aliases: string[] = [];
    if (split.front !== null) {
      for (const line of split.front.split('\n')) {
        const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
        if (field !== null) props[field[1] ?? ''] = (field[2] ?? '').trim();
      }
      const aliasField = props['aliases'];
      if (aliasField !== undefined) aliases.push(...aliasField.replace(/^\[|\]$/g, '').split(',').map((alias) => alias.trim()).filter((alias) => alias !== ''));
    }

    const name = (path.split('/').pop() ?? path).replace(MD_EXT, '');
    const type = classifyCodexNote(path, props, pre.keywords);
    if (type !== null) {
      codex.push({ path, name: props['title'] ?? name, type, aliases, keywords: pre.keywords, body: pre.body });
      continue;
    }

    // A manuscript note: its front-matter facts and its preprocessed body become blocks.
    const fileName = path;
    if (mapped !== null) frontMatter[fileName] = { scene: mapped.scene, notes: mapped.notes };
    if (title === '' && mapped?.metadata.title !== undefined && mapped.metadata.title !== '') title = mapped.metadata.title;
    const parsed = parseMarkdownBody(pre.body, fileName);
    blocks.push(...parsed.blocks);
    for (const embed of pre.embeds) embedTargets.set(embed.token, { target: embed.target, notePath: path });
    // Merge the note's tags into its scene keywords.
    const facts = frontMatter[fileName];
    if (facts !== undefined && pre.keywords.length > 0) facts.scene.keywords = [...(facts.scene.keywords ?? []), ...pre.keywords];
  }

  if (blocks.length === 0 && codex.length === 0) return { ok: false, error: { kind: 'no-markdown' } };

  // Resolve image embeds against the vault, honouring the attachment folder.
  const document: ImportDocument = { blocks, assets: [] };
  for (const [token, { target, notePath }] of embedTargets) {
    if (!/\.(png|jpe?g|gif|svg|webp|bmp|avif|tiff?)$/i.test(target)) continue;
    const resolved = resolveAttachment(target, notePath, paths, attachmentFolder);
    if (resolved === null) continue;
    const read = await archive.read(resolved);
    if (!read.ok) continue;
    assetData.set(token, read.value);
    document.assets?.push({ ref: token, name: resolved.split('/').pop() ?? target, bytes: read.value.length });
  }

  return {
    ok: true,
    value: {
      document,
      frontMatter,
      title: title !== '' ? title : (notePaths[0] ?? 'Vault').split('/')[0] ?? 'Vault',
      assetData,
      codex,
      longform,
      skipped,
    },
  };
}
