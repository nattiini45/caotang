/**
 * The standalone HTML article (web-publishing.md §3): one self-contained file per
 * document in the selection, rendered over the mdast stage the EPUB emitter uses
 * (`prose.ts`), so a manuscript's markup survives exactly as far as every other
 * export takes it. Semantic article markup — `<article>`, `<h1>`–`<h6>`, a `<time>`
 * element — styles in a `<style>` block, and **no `<script>`**, so a host's
 * Content-Security-Policy is not provoked.
 *
 * ## The pieces the document's `publish` field writes
 *
 * - `canonical` → `<link rel="canonical">` (W3); `<meta name="description">` from
 *   `description`. Both live in the standalone document's `<head>`, so a fragment
 *   carries neither — the site template the fragment slots into owns the head.
 * - `publishedAt` → `<time datetime>` under the title. A draft (no date) has none.
 * - `slug`, `layout`, `tags`, `publishedAt` and the draft rule → the optional YAML
 *   front-matter block (`frontMatter`), which emits only the Jekyll-predefined
 *   names (web-publishing.md §3, W1): `title`, `layout`, `permalink`, `date`,
 *   `tags` and `published: false` on a draft.
 *
 * ## What it does not try to do
 *
 * A picture is a `<figure>` carrying its caption or alt text, never an `<img>`:
 * the article has no address for the project's `assets/`, and inventing one is the
 * "wrong link" failure §4 calls out. A body heading is emitted one level down —
 * the document's own title holds the `<h1>` — so `##` in the body lands as `<h3>`
 * and everything bottoms out at `<h6>`.
 */

import { placementCaptionOf } from '@caotang/pictures';

import { escapeXml } from './render-epub.js';
import type { ProseBlock, Run } from './prose.js';

/** The publish fields the article reads, as the manifest's unknown-tolerant record carries them (web-publishing.md §2). */
export type PublishMeta = Readonly<Record<string, unknown>>;

export interface HtmlArticleInput {
  /** The document's title — the article's `<h1>` and `<title>`. */
  readonly title: string;
  /** The document's body, parsed through `parseProse` (the mdast stage). */
  readonly blocks: readonly ProseBlock[];
  /** The footnotes `parseProse` collected, marker id to the note's blocks; a marker prints a `[n]` link to the list at the article's end. */
  readonly notes?: ReadonlyMap<string, readonly ProseBlock[]>;
  /** The document's `publish` record, when it has one. Unknown keys are not read. */
  readonly publish?: PublishMeta;
  /** `true` for a full document, `false` for the fragment a site template hosts (the `<article>` alone). */
  readonly standalone: boolean;
  /** Emit the YAML front-matter block a static-site generator reads (Jekyll-predefined names only). */
  readonly frontMatter: boolean;
  /** The recipe option naming the stylesheet the writer's site serves: emitted as `<link rel="stylesheet">` in a standalone article. */
  readonly css?: string;
  /** The `<html lang>` of a standalone article. */
  readonly lang: string;
}

/** The small built-in sheet a standalone article carries, so the file reads as an article before the writer adds their own. */
const BASE_STYLES = [
  'body{margin:0 auto;max-width:42rem;padding:2rem 1rem;font-family:Georgia,"Times New Roman",serif;line-height:1.6;color:#1a1a1a;background:#fff}',
  'article>header h1{margin-bottom:.25rem;line-height:1.2}',
  'article>header p{margin-top:0;color:#555}',
  'article>header time{font-variant-numeric:tabular-nums}',
  'figure{margin:1.5rem 0;padding:.75rem 1rem;border:1px solid #ddd;color:#555}',
  'figcaption{font-size:.9rem}',
  'pre{overflow-x:auto;padding:1rem;background:#f5f5f5}',
  'blockquote{margin-left:0;padding-left:1rem;border-left:3px solid #ccc;color:#444}',
  'code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.95em}',
] as const;

export function renderHtmlArticle(input: HtmlArticleInput): string {
  const article = articleLines(input);
  const out: string[] = [];
  if (input.frontMatter) out.push(...frontMatterLines(input));
  if (!input.standalone) return `${[...out, ...article].join('\n')}\n`;

  const publish = input.publish;
  const canonical = publishString(publish, 'canonical');
  const description = publishString(publish, 'description');
  out.push(
    '<!DOCTYPE html>',
    `<html lang="${escapeXml(input.lang)}">`,
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeXml(input.title)}</title>`,
  );
  if (canonical !== undefined) out.push(`  <link rel="canonical" href="${escapeXml(canonical)}">`);
  if (description !== undefined) out.push(`  <meta name="description" content="${escapeXml(description)}">`);
  if (input.css !== undefined && input.css !== '') out.push(`  <link rel="stylesheet" href="${escapeXml(input.css)}">`);
  out.push('  <style>', ...BASE_STYLES.map((rule) => `    ${rule}`), '  </style>', '</head>', '<body>');
  out.push(...article);
  out.push('</body>', '</html>');
  return `${out.join('\n')}\n`;
}

/** The `<article>` itself — the whole fragment, and the standalone document's body. */
function articleLines(input: HtmlArticleInput): string[] {
  const lines: string[] = ['<article>', '  <header>', `    <h1>${escapeXml(input.title)}</h1>`];
  const publishedAt = publishString(input.publish, 'publishedAt');
  if (publishedAt !== undefined) {
    // The datetime attribute carries the timestamp as written; the text is its day.
    const day = /^\d{4}-\d{2}-\d{2}/.exec(publishedAt)?.[0] ?? publishedAt;
    lines.push(`    <p><time datetime="${escapeXml(publishedAt)}">${escapeXml(day)}</time></p>`);
  }
  lines.push('  </header>');
  const order = noteOrder(input.blocks);
  for (const block of input.blocks) lines.push(...blockLines(block, order));
  if (order.size > 0 && input.notes !== undefined) {
    lines.push('  <section>');
    lines.push('    <h2>Notes</h2>');
    lines.push('    <ol>');
    for (const id of order.keys()) {
      const note = input.notes.get(id);
      if (note === undefined) continue;
      lines.push(`      <li id="fn-${escapeXml(id)}">`);
      lines.push(...note.flatMap((block) => blockLines(block, order)).map((line) => `        ${line.trimStart()}`));
      lines.push('      </li>');
    }
    lines.push('    </ol>');
    lines.push('  </section>');
  }
  lines.push('</article>');
  return lines;
}

/** The footnote markers in first-use order, numbered like the other formats' document-wide list (exporter.md §3). */
function noteOrder(blocks: readonly ProseBlock[]): Map<string, number> {
  const order = new Map<string, number>();
  const walk = (items: readonly ProseBlock[]): void => {
    for (const block of items) {
      if (block.kind === 'quote') walk(block.blocks);
      else if (block.kind === 'list') block.items.forEach(walk);
      else if (block.kind === 'paragraph' || block.kind === 'heading') {
        for (const run of block.runs) {
          if (run.noteId !== undefined && !order.has(run.noteId)) order.set(run.noteId, order.size + 1);
        }
      }
    }
  };
  walk(blocks);
  return order;
}

function blockLines(block: ProseBlock, order: ReadonlyMap<string, number>): string[] {
  switch (block.kind) {
    case 'paragraph':
      return [`  <p>${runsHtml(block.runs, order)}</p>`];
    case 'heading': {
      // The document's title holds the h1, so a body heading sits one level down, capped at h6.
      const depth = Math.min(6, block.depth + 1);
      return [`  <h${depth}>${runsHtml(block.runs, order)}</h${depth}>`];
    }
    case 'break':
      return ['  <hr>'];
    case 'quote':
      return ['  <blockquote>', ...block.blocks.flatMap((inner) => blockLines(inner, order)), '  </blockquote>'];
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      return [
        `  <${tag}>`,
        ...block.items.flatMap((item) => [
          '    <li>',
          ...item.flatMap((inner) => blockLines(inner, order)).map((line) => `    ${line}`),
          '    </li>',
        ]),
        `  </${tag}>`,
      ];
    }
    case 'code':
      return [`  <pre><code>${escapeXml(block.text)}</code></pre>`];
    case 'figure': {
      // No `<img>`: the article cannot know the address the writer publishes the project's pictures at (§5).
      const caption = placementCaptionOf(block.image.title) || block.image.alt;
      return caption === '' ? [] : [`  <figure><figcaption>${escapeXml(caption)}</figcaption></figure>`];
    }
  }
}

function runsHtml(runs: readonly Run[], order: ReadonlyMap<string, number>): string {
  return runs
    .map((run) => {
      if (run.br === true) return '<br>';
      if (run.noteId !== undefined) {
        const n = order.get(run.noteId);
        return n === undefined ? '' : `<sup><a href="#fn-${escapeXml(run.noteId)}">[${n}]</a></sup>`;
      }
      let text = escapeXml(run.text);
      if (run.code === true) text = `<code>${text}</code>`;
      if (run.strong === true) text = `<strong>${text}</strong>`;
      if (run.em === true) text = `<em>${text}</em>`;
      if (run.href !== undefined) text = `<a href="${escapeXml(run.href)}">${text}</a>`;
      return text;
    })
    .join('');
}

/**
 * The YAML block a generator reads, Jekyll-predefined names only (web-publishing.md §3, W1): `title`, `layout`,
 * `permalink` (the slug), `date`, `tags`, and `published: false` on a draft. Scalars are JSON-quoted, which YAML's
 * double-quoted style accepts, so a colon or quote in a title cannot break the block.
 */
function frontMatterLines(input: HtmlArticleInput): string[] {
  const publish = input.publish;
  const lines = ['---', `title: ${yamlScalar(input.title)}`];
  const layout = publishString(publish, 'layout');
  if (layout !== undefined) lines.push(`layout: ${yamlScalar(layout)}`);
  const slug = publishString(publish, 'slug');
  if (slug !== undefined) lines.push(`permalink: ${yamlScalar(slug)}`);
  const publishedAt = publishString(publish, 'publishedAt');
  if (publishedAt !== undefined) {
    lines.push(`date: ${yamlScalar(publishedAt)}`);
  } else {
    lines.push('published: false');
  }
  const tags = publishStringArray(publish, 'tags');
  if (tags.length > 0) lines.push(`tags: [${tags.map(yamlScalar).join(', ')}]`);
  lines.push('---');
  return lines;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function publishString(publish: PublishMeta | undefined, key: string): string | undefined {
  const value = publish?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function publishStringArray(publish: PublishMeta | undefined, key: string): readonly string[] {
  const value = publish?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : [];
}
