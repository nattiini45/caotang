/**
 * The RSS and Atom feeds (web-publishing.md §3): one XML file per compile, an entry for every document of the
 * selection that is not a draft, in binder order. Written by a Caotang-owned emitter on the same reasoning as the EPUB
 * writer: a small frozen-spec writer beats a dependency.
 *
 * A document with no `publishedAt` is a draft and is omitted, with a skip line the compile log carries. An item's
 * `<link>` is its `canonical` — omitted rather than wrong when the document has none (WD3). The item's `<guid>` /
 * entry `<id>` is built from the document's stable node id, so a slug change does not make a new entry (WD5). The
 * recipe's `siteUrl` names the site's absolute `https` address: RSS's required channel `<link>` and Atom's required
 * feed `<id>`; the compile refuses without it, so both writers can trust it.
 */

import { escapeXml } from './render-epub.js';
import { publishString, renderHtmlArticle, type PublishMeta } from './render-html.js';
import { parseProse } from './prose.js';

/** One document a feed may carry, as the compile knows it from the flat blocks and the manifest. */
export interface FeedItem {
  readonly docId: string;
  readonly title: string;
  readonly body: string;
  readonly publish?: PublishMeta;
}

/** What a feed compile renders: the channel facts and the candidate items. */
export interface FeedInput {
  /** The recipe's `siteUrl` option, already checked to be an absolute `https` address. */
  readonly siteUrl: string;
  /** The folder's title (or the project's for the whole manuscript). */
  readonly channelTitle: string;
  /** The folder's synopsis, when it has one (RSS channel `<description>`). */
  readonly channelDescription?: string;
  readonly lang: string;
  /** The compile instant, for the Atom feed's `<updated>` when every item is a draft. */
  readonly at: number;
  readonly items: readonly FeedItem[];
}

/** A feed's text and the skip lines the compile log carries, one per omitted document. */
export interface RenderedFeed {
  readonly xml: string;
  readonly notes: readonly string[];
}

interface KeptItem {
  readonly item: FeedItem;
  /** The item's `publishedAt`, checked parseable — a string the manifest never validates again at export. */
  readonly instant: string;
}

/** The non-draft items, and a skip line for each draft, in binder order. */
function keptOf(items: readonly FeedItem[]): { readonly kept: readonly KeptItem[]; readonly notes: readonly string[] } {
  const kept: KeptItem[] = [];
  const notes: string[] = [];
  for (const item of items) {
    const instant = publishString(item.publish, 'publishedAt');
    if (instant === undefined || Number.isNaN(Date.parse(instant))) {
      notes.push(`skipped: ${item.title} — a draft (no publish date), omitted from the feed`);
      continue;
    }
    kept.push({ item, instant });
  }
  return { kept, notes };
}

/** RSS 2.0's `<pubDate>`: RFC 822, which `toUTCString` writes. */
function rfc822(instant: string): string {
  return new Date(instant).toUTCString();
}

/** An Atom id for an entry: the site's address and the document's stable node id (WD5). */
function entryId(siteUrl: string, docId: string): string {
  return `${siteUrl}#${docId}`;
}

/** The newest `updated` instant the kept items carry; the compile instant when there are none. */
function feedUpdated(kept: readonly KeptItem[], at: number): string {
  let newest = Number.NEGATIVE_INFINITY;
  for (const { instant } of kept) newest = Math.max(newest, Date.parse(instant));
  return newest === Number.NEGATIVE_INFINITY ? new Date(at).toISOString() : new Date(newest).toISOString();
}

/**
 * RSS 2.0 (web-publishing.md §3, W5): channel `title`, `link` and `description`, then one `<item>` per non-draft
 * document with `<title>`, `<link>` only from `canonical`, `<description>` only from the publish record,
 * `<pubDate>` as RFC 822 and `<guid isPermaLink="false">` from the node id.
 */
export function renderRss(input: FeedInput): RenderedFeed {
  const { kept, notes } = keptOf(input.items);
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<rss version="2.0">`,
    `<channel>`,
    `<title>${escapeXml(input.channelTitle)}</title>`,
    `<link>${escapeXml(input.siteUrl)}</link>`,
  ];
  if (input.channelDescription !== undefined && input.channelDescription !== '') {
    lines.push(`<description>${escapeXml(input.channelDescription)}</description>`);
  }
  for (const { item, instant } of kept) {
    lines.push(`<item>`);
    lines.push(`<title>${escapeXml(item.title)}</title>`);
    const canonical = publishString(item.publish, 'canonical');
    if (canonical !== undefined) lines.push(`<link>${escapeXml(canonical)}</link>`);
    const description = publishString(item.publish, 'description');
    if (description !== undefined) lines.push(`<description>${escapeXml(description)}</description>`);
    lines.push(`<pubDate>${rfc822(instant)}</pubDate>`);
    lines.push(`<guid isPermaLink="false">${escapeXml(item.docId)}</guid>`);
    lines.push(`</item>`);
  }
  lines.push(`</channel>`, `</rss>`, '');
  return { xml: lines.join('\n'), notes };
}

/**
 * Atom (web-publishing.md §3, W4, RFC 4287): feed `id` is `siteUrl`, `title` the folder title and `updated` the newest
 * entry's instant; each entry carries its required `id` (`<siteUrl>#<node id>`), `title` and `updated` (the
 * `publishedAt`), plus `<link rel="alternate">` from `canonical`, `<summary>` from `description` and
 * `<content type="html">` — the same article fragment the `html` writer emits, so the two can never disagree.
 */
export function renderAtom(input: FeedInput): RenderedFeed {
  const { kept, notes } = keptOf(input.items);
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escapeXml(input.lang)}">`,
    `<id>${escapeXml(input.siteUrl)}</id>`,
    `<title>${escapeXml(input.channelTitle)}</title>`,
    `<updated>${feedUpdated(kept, input.at)}</updated>`,
  ];
  for (const { item, instant } of kept) {
    lines.push(`<entry>`);
    lines.push(`<id>${escapeXml(entryId(input.siteUrl, item.docId))}</id>`);
    lines.push(`<title>${escapeXml(item.title)}</title>`);
    lines.push(`<updated>${instant}</updated>`);
    const canonical = publishString(item.publish, 'canonical');
    if (canonical !== undefined) lines.push(`<link rel="alternate" href="${escapeXml(canonical)}"/>`);
    const description = publishString(item.publish, 'description');
    if (description !== undefined) lines.push(`<summary>${escapeXml(description)}</summary>`);
    const parsed = parseProse(item.body);
    const article = renderHtmlArticle({
      title: item.title,
      blocks: parsed.blocks,
      ...(parsed.notes.size === 0 ? {} : { notes: parsed.notes }),
      ...(item.publish === undefined ? {} : { publish: item.publish }),
      standalone: false,
      frontMatter: false,
      lang: input.lang,
    });
    lines.push(`<content type="html">${escapeXml(article)}</content>`);
    lines.push(`</entry>`);
  }
  lines.push(`</feed>`, '');
  return { xml: lines.join('\n'), notes };
}
