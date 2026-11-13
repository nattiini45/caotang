/**
 * @caotang/import-textbundle: the TextBundle and TextPack reader (#282, epic #263).
 *
 * TextBundle (a `.textbundle` folder) and TextPack (its zip) are the open interchange of the Apple writing apps: Markdown plus
 * `assets/` plus `info.json`. This is a thin layer over the Markdown reader (#280): it finds the bundle's text and info, names the
 * app, applies that app's comments, tags and Content Blocks, and hands the body to the Markdown reader. No DOM, no third-party
 * dependencies: it runs on the main thread, in a `'self'` Worker and in Node.
 */

import type { ImportDocument } from '@caotang/import-core';
import { readMarkdownFile, type MarkdownFileFacts } from '@caotang/import-markdown';
import type { ImportArchive } from '@caotang/import-read/zip';
import { decodePlainText } from '@caotang/import-read/text';

export type TextBundleApp = 'ulysses' | 'bear' | 'ia-writer' | 'generic';

export interface TextBundleImport {
  document: ImportDocument;
  frontMatter: Record<string, MarkdownFileFacts>;
  title: string;
  assetData: Map<string, Uint8Array>;
  app: TextBundleApp;
  notices: string[];
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

/** Bear: `#tag`, `#nested/tag`, closed `#multi word tag#` collected as keywords; a leading H1 equal to the title is stripped. */
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
  // Closed multi-word tags (`#multi word tag#`): a space inside, no space before the closing `#`.
  let body = text.replace(/#([^#\n]*?\s[^#\n]*?[^#\s])#/g, (_whole, inner: string) => {
    add(inner);
    return '';
  });
  body = body.replace(/(^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g, (_whole, lead: string, tag: string) => {
    add(tag);
    return lead;
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

/** Read one TextBundle / TextPack opened as an archive. */
export async function readTextBundle(archive: ImportArchive): Promise<TextBundleResult> {
  const paths = archive.entries.map((e) => e.path);
  const infoPath = paths.find((p) => p.split('/').pop() === 'info.json');
  const textPath = paths.find((p) => TEXT_NAMES.includes(p.split('/').pop() ?? ''));
  const fountainPath = paths.find((p) => p.split('/').pop() === 'text.fountain');
  if (fountainPath !== undefined && textPath === undefined) return { ok: false, error: { kind: 'fountain' } };
  if (textPath === undefined) return { ok: false, error: { kind: 'no-text' } };

  let info: Record<string, unknown> = {};
  if (infoPath !== undefined) {
    const read = await archive.read(infoPath);
    if (read.ok) {
      try {
        info = JSON.parse(new TextDecoder().decode(read.value)) as Record<string, unknown>;
      } catch {
        info = {};
      }
    }
  }
  const app = appOf(info);

  const read = await archive.read(textPath);
  if (!read.ok) return { ok: false, error: { kind: 'archive', message: read.error.message } };
  const decoded = decodePlainText(read.value);
  if (decoded.status === 'ask') return { ok: false, error: { kind: 'ask-encoding' } };
  if (decoded.status === 'too-large') return { ok: false, error: { kind: 'too-large', bytes: decoded.bytes, limit: decoded.limit } };
  if (decoded.status === 'too-many-lines') return { ok: false, error: { kind: 'too-many-lines', lines: decoded.lines, limit: decoded.limit } };

  const notices: string[] = [];
  let text = decoded.text;
  const extraNotes: string[] = [];
  const extraKeywords: string[] = [];
  const title = typeof info['title'] === 'string' ? (info['title'] as string) : '';

  if (app === 'ulysses') {
    const result = ulyssesComments(text);
    text = result.body;
    extraNotes.push(...result.notes);
    if (result.notes.length > 0) notices.push(`${result.notes.length} Ulysses comment(s) kept as notes.`);
  } else if (app === 'bear') {
    const result = bearTags(text, title);
    text = result.body;
    extraKeywords.push(...result.keywords);
    if (result.keywords.length > 0) notices.push(`${result.keywords.length} Bear tag(s) kept as keywords.`);
  } else if (app === 'ia-writer') {
    const result = iaAuthorship(text);
    text = result.body;
    if (result.stripped) notices.push('The iA Writer Authorship block was kept out of the body.');
  }

  const fileName = textPath.split('/').pop() ?? 'text.md';
  const markdown = readMarkdownFile(new TextEncoder().encode(text), fileName);
  if (!markdown.ok) {
    const error = markdown.error;
    if (error.kind === 'ask-encoding') return { ok: false, error: { kind: 'ask-encoding' } };
    if (error.kind === 'too-large') return { ok: false, error: { kind: 'too-large', bytes: error.bytes, limit: error.limit } };
    if (error.kind === 'too-many-lines') return { ok: false, error: { kind: 'too-many-lines', lines: error.lines, limit: error.limit } };
    return { ok: false, error: { kind: 'no-text' } };
  }

  const value = markdown.value;
  const facts = value.frontMatter[fileName];
  if (facts !== undefined) {
    if (extraKeywords.length > 0) facts.scene.keywords = [...(facts.scene.keywords ?? []), ...extraKeywords];
    if (extraNotes.length > 0) facts.notes = facts.notes === '' ? extraNotes.join('\n\n') : `${facts.notes}\n\n${extraNotes.join('\n\n')}`;
  }

  // Resolve the bundle's assets/ pictures against the archive.
  const assetData = new Map<string, Uint8Array>();
  const assets = value.document.assets ?? [];
  for (const asset of assets) {
    const target = value.imageTargets.get(asset.ref) ?? asset.ref;
    const candidates = paths.filter((p) => p.endsWith(target) || p.endsWith(`assets/${target}`));
    for (const candidate of candidates) {
      const bytes = await archive.read(candidate);
      if (bytes.ok) {
        assetData.set(asset.ref, bytes.value);
        asset.bytes = bytes.value.length;
        asset.name = candidate.split('/').pop();
        break;
      }
    }
  }

  return {
    ok: true,
    value: {
      document: value.document,
      frontMatter: value.frontMatter,
      title: title !== '' ? title : value.title,
      assetData,
      app,
      notices,
    },
  };
}
