/**
 * The HTML article (web-publishing.md §3): one self-contained file per document — semantic article markup, a `<time>`
 * element, the canonical link, styles in a `<style>` block and no `<script>`; a fragment carries no `<html>` wrapper;
 * front matter emits only the Jekyll-predefined names.
 */

import { describe, expect, it } from 'vitest';

import { parseProse } from '../src/prose.js';
import { renderHtmlArticle, type HtmlArticleInput } from '../src/render-html.js';

const BODY = '# Part one\n\nA *lean* body, **bold** too, `code`, and [a link](https://example.com/x).\n\n> quoted\n\n---\n\n- one\n- two\n\n```\ncode block <kept>\n```\n';

function article(over: Partial<HtmlArticleInput> = {}): HtmlArticleInput {
  return {
    title: 'The Landing',
    blocks: parseProse(BODY).blocks,
    standalone: true,
    frontMatter: false,
    lang: 'en',
    ...over,
  };
}

describe('the standalone HTML article', () => {
  it('is a full document with semantic markup, a style block and no script', () => {
    const html = renderHtmlArticle(article());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<title>The Landing</title>');
    expect(html).toContain('<style>');
    expect(html).toContain('<article>');
    expect(html).toContain('<h1>The Landing</h1>');
    // The body's `#` heading sits one level down: the document's title holds the h1.
    expect(html).toContain('<h2>Part one</h2>');
    expect(html).toContain('<em>lean</em>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="https://example.com/x">a link</a>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<pre><code>code block &lt;kept&gt;</code></pre>');
    expect(html).not.toContain('<script');
  });

  it('writes the canonical link, the description meta and the time element from publish', () => {
    const html = renderHtmlArticle(
      article({
        publish: {
          canonical: 'https://example.com/the-landing',
          description: 'The landing chapter.',
          publishedAt: '2026-11-15T12:00:00Z',
        },
      }),
    );
    expect(html).toContain('<link rel="canonical" href="https://example.com/the-landing">');
    expect(html).toContain('<meta name="description" content="The landing chapter.">');
    expect(html).toContain('<time datetime="2026-11-15T12:00:00Z">2026-11-15</time>');
  });

  it('writes no time element for a draft, and raw markup in the body is text, never markup', () => {
    const html = renderHtmlArticle(article({ blocks: parseProse('A <script>alert(1)</script> here.').blocks }));
    expect(html).not.toContain('<time');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
  });

  it('links a footnote marker to its note at the article end', () => {
    const parsed = parseProse('A claim[^1] and more.\n\n[^1]: The note text.');
    const html = renderHtmlArticle(article({ blocks: parsed.blocks, notes: parsed.notes }));
    expect(html).toContain('<sup><a href="#fn-1">[1]</a></sup>');
    expect(html).toContain('<li id="fn-1">');
    expect(html).toContain('The note text.');
  });

  it('emits the stylesheet link the recipe names', () => {
    const html = renderHtmlArticle(article({ css: '/assets/site.css' }));
    expect(html).toContain('<link rel="stylesheet" href="/assets/site.css">');
  });

  it.each([true, false])('links reachable nested notes once, in reading order (standalone=%s)', (standalone) => {
    const parsed = parseProse([
      'The claim[^a] and another[^c].',
      '[^a]: First note[^b].',
      '[^b]: Nested note[^a].',
      '[^c]: Second note.',
      '[^unused]: Uncited note.',
    ].join('\n\n'));
    const html = renderHtmlArticle(article({ ...parsed, standalone }));
    expect([...html.matchAll(/<li id="fn-([a-z]+)">/g)].map((match) => match[1])).toEqual(['a', 'c', 'b']);
    expect(html).toContain('First note<sup><a href="#fn-b">[3]</a></sup>.');
    expect(html).toContain('Nested note<sup><a href="#fn-a">[1]</a></sup>.');
    expect(html).toContain('another<sup><a href="#fn-c">[2]</a></sup>');
  });
});

describe('the fragment', () => {
  it('carries the article alone — no doctype, no html wrapper, no head', () => {
    const html = renderHtmlArticle(article({ standalone: false }));
    expect(html).toContain('<article>');
    expect(html).not.toContain('<!DOCTYPE html>');
    expect(html).not.toContain('<html');
    expect(html).not.toContain('<head>');
    expect(html).not.toContain('<style>');
  });
});

describe('the front matter', () => {
  it('emits only the Jekyll-predefined names', () => {
    const html = renderHtmlArticle(
      article({
        frontMatter: true,
        publish: {
          layout: 'post',
          slug: 'the-landing',
          publishedAt: '2026-11-15T12:00:00Z',
          tags: ['fiction', 'series'],
          canonical: 'https://example.com/x',
          description: 'not a Jekyll name',
          customField: 'kept in memory, not emitted',
        },
      }),
    );
    const block = html.slice(0, html.indexOf('---', 3) + 3);
    expect(block).toContain('title: "The Landing"');
    expect(block).toContain('layout: "post"');
    expect(block).toContain('permalink: "the-landing"');
    expect(block).toContain('date: "2026-11-15T12:00:00Z"');
    expect(block).toContain('tags: ["fiction", "series"]');
    expect(block).not.toContain('canonical');
    expect(block).not.toContain('description');
    expect(block).not.toContain('customField');
  });

  it('marks a draft published: false', () => {
    const html = renderHtmlArticle(article({ frontMatter: true }));
    expect(html).toContain('published: false');
    expect(html).not.toContain('date:');
  });
});
