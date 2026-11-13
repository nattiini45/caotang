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
});
