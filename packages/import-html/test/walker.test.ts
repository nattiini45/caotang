import { describe, expect, it } from 'vitest';

import { htmlToBlocks, normaliseHtml, isSafeLinkTarget } from '../src/walker.js';

const page = (body: string): string => `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;

function walk(body: string) {
  const out = htmlToBlocks(page(body));
  if (!out.ok) throw new Error(out.error.message);
  return out.value;
}

describe('the XHTML walker (#299)', () => {
  it('reads the heading ladder and a horizontal rule', () => {
    const { blocks } = walk('<h1>Chapter One</h1><p>The ferry came.</p><hr/><h2>A scene</h2><p>The letter.</p>');
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1, text: 'Chapter One' });
    expect(blocks[1]).toMatchObject({ kind: 'para', text: 'The ferry came.' });
    expect(blocks[2]).toMatchObject({ kind: 'break' });
    expect(blocks[3]).toMatchObject({ kind: 'heading', level: 2, text: 'A scene' });
  });

  it('renders emphasis, code and safe links as Markdown', () => {
    const { blocks } = walk('<p>She <strong>ran</strong> to the <em>harbour</em> with <code>a map</code> and <a href="https://example.com">a link</a>.</p>');
    expect(blocks[0]?.kind === 'para' && blocks[0].md).toContain('**ran**');
    expect(blocks[0]?.kind === 'para' && blocks[0].md).toContain('*harbour*');
    expect(blocks[0]?.kind === 'para' && blocks[0].md).toContain('`a map`');
    expect(blocks[0]?.kind === 'para' && blocks[0].md).toContain('[a link](https://example.com)');
  });

  it('drops a javascript: link but keeps its text, and counts it', () => {
    const { blocks, dropped } = walk('<p>Click <a href="javascript:alert(1)">here</a>.</p>');
    const md = blocks[0]?.kind === 'para' ? blocks[0].md : '';
    expect(md).toContain('here');
    expect(md).not.toContain('javascript:');
    expect(dropped.unsafeLinks).toBe(1);
  });

  it('reads unordered and ordered lists as Markdown markers', () => {
    const { blocks } = walk('<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>');
    const mds = blocks.filter((b) => b.kind === 'para').map((b) => (b.kind === 'para' ? b.md : ''));
    expect(mds).toEqual(['- one', '- two', '1. first', '2. second']);
  });

  it('keeps a blockquote as a quoted paragraph', () => {
    const { blocks } = walk('<blockquote>They waited.</blockquote>');
    expect(blocks[0]?.kind === 'para' && blocks[0].md).toBe('> They waited.');
  });

  it('signals centred text from an inline style and from a class rule', () => {
    const inline = walk('<p style="text-align:center">A centred line.</p>');
    expect(inline.blocks[0]?.kind === 'para' && inline.blocks[0].src?.align).toBe('center');
    const styled = htmlToBlocks(page('<style>.c1 { text-align: center; }</style><p class="c1">A centred line.</p>'));
    if (!styled.ok) throw new Error(styled.error.message);
    expect(styled.value.blocks[0]?.kind === 'para' && styled.value.blocks[0].src?.align).toBe('center');
  });

  it('signals a page break before a paragraph', () => {
    const { blocks } = walk('<p style="page-break-before:always">A new page.</p>');
    expect(blocks[0]?.kind === 'para' && blocks[0].src?.pageBreakBefore).toBe(true);
  });

  it('drops scripts, styles and iframes, counts them, and never keeps their text', () => {
    const { blocks, dropped } = walk('<script>alert(1)</script><style>p{color:red}</style><iframe src="x"></iframe><p>Safe text.</p>');
    expect(dropped.scripts).toBe(1);
    expect(dropped.styles).toBe(1);
    expect(dropped.iframes).toBe(1);
    const text = JSON.stringify(blocks);
    expect(text).toContain('Safe text.');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
  });

  it('counts a linked stylesheet and one in the head, which the body walk never reaches', () => {
    const html = [
      '<html><head><style>p{color:red}</style><link rel="stylesheet" href="book.css"/><link rel="icon" href="f.png"/></head>',
      '<body><p>Safe text.</p><style>span{color:blue}</style></body></html>',
    ].join('');
    const { blocks, dropped } = walk(html);
    // Two <style> elements and one linked stylesheet; the icon link is not a stylesheet.
    expect(dropped.styles).toBe(3);
    const text = JSON.stringify(blocks);
    expect(text).toContain('Safe text.');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('book.css');
  });

  it('counts event attributes on kept elements', () => {
    const { dropped } = walk('<p onclick="evil()">Text.</p>');
    expect(dropped.eventAttrs).toBe(1);
  });

  it('keeps data: and relative images as refs and lists remote ones', () => {
    const { blocks, images, remoteImages } = walk('<p><img src="data:image/png;base64,AAAA" alt="a"/></p><img src="images/cover.png" alt="b"/><p><img src="https://example.com/x.png" alt="c"/></p>');
    expect(images.size).toBe(2);
    expect([...images.values()]).toEqual(['data:image/png;base64,AAAA', 'images/cover.png']);
    expect(remoteImages).toEqual(['https://example.com/x.png']);
    // A block-level image is an image block; an inline one is Markdown in its paragraph.
    expect(blocks.some((b) => b.kind === 'image')).toBe(true);
    expect(blocks[0]?.kind === 'para' && blocks[0].md).toContain('![a](');
  });

  it('decodes HTML entities and tolerates unclosed void elements', () => {
    const { blocks } = walk('<p>A&nbsp;dash&mdash;here.<br>Next line.</p>');
    const md = blocks[0]?.kind === 'para' ? blocks[0].md : '';
    // The mdash entity is decoded; whitespace (including nbsp) collapses to a space, and <br> breaks the line.
    expect(md).toContain('A dash\u2014here.');
    expect(md).toContain('Next line.');
  });

  it('degrades a table to prose with a loss', () => {
    const { blocks, losses } = walk('<table><tr><td>a</td><td>b</td></tr></table>');
    expect(blocks[0]?.kind === 'para' && blocks[0].text).toContain('a');
    expect(losses.some((loss) => loss.code === 'table')).toBe(true);
  });

  it('refuses markup that is not well-formed XML', () => {
    const out = htmlToBlocks('<p>unclosed <div>mixed</p>');
    expect(out.ok).toBe(false);
  });

  it('normalises void elements and entities without touching safe markup', () => {
    expect(normaliseHtml('<br>')).toBe('<br/>');
    expect(normaliseHtml('<img src="x.png">')).toBe('<img src="x.png"/>');
    expect(normaliseHtml('<br/>')).toBe('<br/>');
    expect(normaliseHtml('&nbsp;')).toBe('&#160;');
    expect(normaliseHtml('&amp;')).toBe('&amp;');
  });

  it('applies the safe-href rule', () => {
    expect(isSafeLinkTarget('https://example.com')).toBe(true);
    expect(isSafeLinkTarget('mailto:a@b.c')).toBe(true);
    expect(isSafeLinkTarget('chapter2.html')).toBe(true);
    expect(isSafeLinkTarget('javascript:alert(1)')).toBe(false);
    expect(isSafeLinkTarget('data:text/html,x')).toBe(false);
  });

  it('keeps literal prose literal: its stars and brackets are words, not markup', () => {
    const { blocks } = walk('<p>Use *literal* syntax and [link](https://example.test).</p>');
    const para = blocks[0];
    expect(para?.kind === 'para' && para.md).toBe('Use \\*literal\\* syntax and \\[link\\](https://example.test).');
    expect(para?.kind === 'para' && para.text).toBe('Use *literal* syntax and [link](https://example.test).');
  });

  it('encodes a link destination so an href cannot close the link and start another', () => {
    const { blocks } = walk('<p><a href="x) [link](javascript:alert(1">click</a></p>');
    const md = blocks[0]?.kind === 'para' ? blocks[0].md : '';
    expect(md).toBe('[click](x%29%20%5Blink%5D%28javascript:alert%281)');
    expect(md.split('](')).toHaveLength(2);
    expect(md).not.toContain('](javascript');
  });

  it('counts a script in the head, which the body walk never reaches', () => {
    const out = htmlToBlocks('<html><head><script>alert(1)</script></head><body><p>Safe text.</p></body></html>');
    if (!out.ok) throw new Error(out.error.message);
    expect(out.value.dropped.scripts).toBe(1);
    expect(JSON.stringify(out.value.blocks)).not.toContain('alert');
  });

  it('counts an event attribute in the head and inside a dropped element once', () => {
    const out = htmlToBlocks('<html><head><meta onload="evil()"/></head><body><div onclick="evil()"><p>Text.</p></div></body></html>');
    if (!out.ok) throw new Error(out.error.message);
    expect(out.value.dropped.eventAttrs).toBe(2);
  });

  it('keeps a heading’s title plain while its Markdown keeps the emphasis', () => {
    const { blocks } = walk('<h1>Chapter <em>One</em></h1>');
    expect(blocks[0]).toMatchObject({ kind: 'heading', text: 'Chapter One', md: '# Chapter *One*' });
  });

  it('carries a wrapper’s alignment down to the paragraphs inside it', () => {
    const { blocks } = walk('<div style="text-align:center"><p>Centered line.</p><p>Also centred.</p></div>');
    expect(blocks[0]?.kind === 'para' && blocks[0].src?.align).toBe('center');
    expect(blocks[1]?.kind === 'para' && blocks[1].src?.align).toBe('center');
  });

  it('gives a wrapper’s page break to its first paragraph only', () => {
    const { blocks } = walk('<div style="page-break-before:always"><p>One.</p><p>Two.</p></div>');
    expect(blocks[0]?.kind === 'para' && blocks[0].src?.pageBreakBefore).toBe(true);
    expect(blocks[1]?.kind === 'para' && blocks[1].src?.pageBreakBefore).toBeUndefined();
  });

  it('separates table cells and rows when it flattens them to prose', () => {
    const { blocks } = walk('<table><tr><td>Mary</td><td>Smith</td></tr><tr><td>Ann</td><td>Lee</td></tr></table>');
    expect(blocks[0]?.kind === 'para' && blocks[0].md).toBe('Mary Smith\nAnn Lee');
    expect(blocks[0]?.kind === 'para' && blocks[0].text).toBe('Mary Smith Ann Lee');
  });

  it('keeps a dropped element’s source out of a table and out of a code block', () => {
    const table = walk('<table><tr><td>a<script>alert(1)</script></td></tr></table>');
    expect(JSON.stringify(table.blocks)).not.toContain('alert');
    expect(table.dropped.scripts).toBe(1);
    const code = walk('<pre>let x = 1;<script>alert(2)</script></pre>');
    expect(JSON.stringify(code.blocks)).not.toContain('alert');
    expect(code.dropped.scripts).toBe(1);
  });

  it('lists a protocol-relative picture as remote, not as one the file carries', () => {
    const { images, remoteImages } = walk('<img src="//cdn.example/x.png" alt="c"/><p><img src="//cdn.example/y.png" alt="d"/></p>');
    expect(images.size).toBe(0);
    expect(remoteImages).toEqual(['//cdn.example/x.png', '//cdn.example/y.png']);
  });

  it('reads the class rules of a page built to make a scanning regex quadratic, in one pass', () => {
    // 40,000 dots with no brace inside a stylesheet: a regex that scans from every position would take minutes.
    const started = Date.now();
    const out = htmlToBlocks(page(`<style>${'.-'.repeat(40_000)} .c1 { text-align: center; }</style><p class="c1">A centred line.</p>`));
    expect(Date.now() - started).toBeLessThan(10_000);
    if (!out.ok) throw new Error(out.error.message);
    const para = out.value.blocks.find((block) => block.kind === 'para');
    expect(para?.kind === 'para' && para.src?.align).toBe('center');
    // Unclosed <style> tags are not well-formed markup, but the class scan runs before the parse and must still return at once.
    const unclosed = Date.now();
    htmlToBlocks(page('<style>'.repeat(40_000)));
    expect(Date.now() - unclosed).toBeLessThan(10_000);
  });
});
