/**
 * The RSS and Atom feeds (web-publishing.md §3): one file per compile, an entry per non-draft document in binder
 * order, `<guid>` / entry `<id>` from the stable node id, `<link>` only from `canonical`, and a skip line for each
 * draft the compile log carries.
 */

import { describe, expect, it } from 'vitest';

import { renderAtom, renderRss, type FeedInput, type FeedItem } from '../src/render-feed.js';

const ITEMS: readonly FeedItem[] = [
  {
    docId: 'n_LANDING01',
    title: 'The Landing',
    body: 'The ferry was late.\n\nElena *stepped* onto the quay.',
    publish: {
      canonical: 'https://example.com/the-landing',
      description: 'The landing chapter.',
      publishedAt: '2026-11-15T12:00:00Z',
    },
  },
  {
    docId: 'n_STORM0001',
    title: 'The Storm',
    body: 'He counted the ships.',
    // No canonical: the item gets no <link> rather than a wrong one.
    publish: { publishedAt: '2026-11-10T09:00:00Z' },
  },
  {
    docId: 'n_DRAFT0001',
    title: 'A Draft Chapter',
    body: 'Not ready.',
    // No publishedAt: a draft, omitted.
  },
];

function feed(over: Partial<FeedInput> = {}): FeedInput {
  return {
    siteUrl: 'https://example.com',
    channelTitle: 'The Lighthouse Keeper',
    channelDescription: 'A keeper alone on the rock.',
    lang: 'en',
    at: Date.parse('2026-11-16T00:00:00Z'),
    items: ITEMS,
    ...over,
  };
}

describe('the RSS feed', () => {
  it('is RSS 2.0 with the channel facts and one item per non-draft document', () => {
    const { xml, notes } = renderRss(feed());
    expect(xml).toContain('<rss version="2.0">');
    expect(xml).toContain('<channel>');
    expect(xml).toContain('<title>The Lighthouse Keeper</title>');
    expect(xml).toContain('<link>https://example.com</link>');
    expect(xml).toContain('<description>A keeper alone on the rock.</description>');
    expect((xml.match(/<item>/g) ?? []).length).toBe(2);
    expect(xml).toContain('<title>The Landing</title>');
    expect(xml).toContain('<link>https://example.com/the-landing</link>');
    expect(xml).toContain('<description>The landing chapter.</description>');
    expect(xml).toContain('<pubDate>Sun, 15 Nov 2026 12:00:00 GMT</pubDate>');
    expect(xml).toContain('<guid isPermaLink="false">n_LANDING01</guid>');
    // The draft is omitted, and the compile log names it.
    expect(xml).not.toContain('A Draft Chapter');
    expect(notes).toEqual(['skipped: A Draft Chapter — a draft (no publish date), omitted from the feed']);
  });

  it('writes no link for an item with no canonical', () => {
    const { xml } = renderRss(feed());
    const storm = xml.slice(xml.indexOf('<title>The Storm</title>'));
    expect(storm.slice(0, storm.indexOf('</item>'))).not.toContain('<link>');
  });

  it('escapes text and never writes a second title when the channel has no synopsis', () => {
    const { xml } = renderRss(feed({ channelDescription: undefined }));
    expect(xml).not.toContain('<description>A keeper');
    const { xml: angled } = renderRss(feed({ channelTitle: 'A <Keeper> & sons' }));
    expect(angled).toContain('<title>A &lt;Keeper&gt; &amp; sons</title>');
  });
});

describe('the Atom feed', () => {
  it('carries the required feed and entry fields (RFC 4287), the entry id from the node id', () => {
    const { xml, notes } = renderAtom(feed());
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom"');
    expect(xml).toContain('<id>https://example.com</id>');
    expect(xml).toContain('<title>The Lighthouse Keeper</title>');
    // The feed's updated is the newest entry's instant.
    expect(xml).toContain('<updated>2026-11-15T12:00:00.000Z</updated>');
    expect((xml.match(/<entry>/g) ?? []).length).toBe(2);
    expect(xml).toContain('<id>https://example.com#n_LANDING01</id>');
    expect(xml).toContain('<updated>2026-11-15T12:00:00Z</updated>');
    expect(xml).toContain('<link rel="alternate" href="https://example.com/the-landing"/>');
    expect(xml).toContain('<summary>The landing chapter.</summary>');
    // The article fragment rides along, escaped.
    expect(xml).toContain('<content type="html">&lt;article&gt;');
    expect(xml).toContain('&lt;em&gt;stepped&lt;/em&gt;');
    expect(notes).toEqual(['skipped: A Draft Chapter — a draft (no publish date), omitted from the feed']);
  });

  it('falls back to the compile instant for the feed updated when every item is a draft', () => {
    const { xml } = renderAtom(feed({ items: [ITEMS[2] as FeedItem] }));
    expect(xml).toContain('<updated>2026-11-16T00:00:00.000Z</updated>');
    expect(xml).not.toContain('<entry>');
  });
});
