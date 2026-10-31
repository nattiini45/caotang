import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { FDX_SAMPLE } from '../../screenplay/test/fixtures/corpus.js';
import { parseFdxParagraphs } from '../../screenplay/src/index.js';
import {
  XML_LIMITS,
  XML_NAMESPACE,
  XmlReadError,
  attr,
  childElements,
  decodeXmlBytes,
  descendants,
  firstChild,
  readXml,
  textOf,
  type XmlDocument,
  type XmlElement,
  type XmlReadOptions,
} from '../src/xml.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function ok(input: string | Uint8Array, options: XmlReadOptions = {}): XmlDocument {
  const result = readXml(input, options);
  if (!result.ok) throw result.error;
  return result.document;
}

function fails(input: string | Uint8Array, options: XmlReadOptions = {}): XmlReadError {
  const result = readXml(input, options);
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

const DOCX = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  `<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`,
  '<w:body>',
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter One</w:t></w:r></w:p>',
  '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Bold </w:t></w:r><w:r><w:t>and plain.</w:t></w:r></w:p>',
  '</w:body></w:document>',
].join('\n');

describe('readXml — namespaces', () => {
  it('resolves element and attribute names to their namespace, whatever prefix the file chose', () => {
    const doc = ok(DOCX);
    expect(doc.root).toMatchObject({ local: 'document', prefix: 'w', ns: W });
    const paragraphs = [...descendants(doc.root, 'p', W)];
    expect(paragraphs).toHaveLength(2);
    const style = firstChild(firstChild(paragraphs[0] as XmlElement, 'pPr', W) as XmlElement, 'pStyle', W) as XmlElement;
    expect(attr(style, 'val', W)).toBe('Heading1');
    // The same document with another prefix reads the same.
    const renamed = ok(DOCX.replaceAll('w:', 'word:').replace('xmlns:w=', 'xmlns:word='));
    expect([...descendants(renamed.root, 'p', W)]).toHaveLength(2);
    // xml:space is in the XML namespace without a declaration.
    const t = [...descendants(doc.root, 't', W)][1] as XmlElement;
    expect(attr(t, 'space', XML_NAMESPACE)).toBe('preserve');
  });

  it('scopes a default namespace to the element that declares it, and leaves unprefixed attributes in no namespace', () => {
    const doc = ok('<a xmlns="urn:a" x="1"><b xmlns="urn:b"><c/></b><d/></a>');
    expect(doc.root.ns).toBe('urn:a');
    const [b, d] = childElements(doc.root);
    expect(b?.ns).toBe('urn:b');
    expect(firstChild(b as XmlElement, 'c')?.ns).toBe('urn:b');
    expect(d?.ns).toBe('urn:a');
    expect(doc.root.attributes.find((a) => a.name === 'x')?.ns).toBeNull();
    expect(attr(doc.root, 'x', null)).toBe('1');
  });

  it('keeps an unbound prefix with no namespace and warns', () => {
    const doc = ok('<x:a/>');
    expect(doc.root.ns).toBeNull();
    expect(doc.warnings).toEqual([{ code: 'unbound-prefix', example: 'x:a', count: 1 }]);
  });
});

describe('readXml — mixed content, entities and CDATA', () => {
  it('keeps text and elements in document order, whitespace included', () => {
    const doc = ok('<p>One <b>two</b> <i>three</i>.</p>');
    expect(doc.root.children.map((c) => (c.type === 'text' ? c.text : `<${c.name}>`))).toEqual(['One ', '<b>', ' ', '<i>', '.']);
    expect(textOf(doc.root)).toBe('One two three.');
    const docx = ok(DOCX);
    expect([...descendants(docx.root, 'p', W)].map(textOf)).toEqual(['Chapter One', 'Bold and plain.']);
  });

  it('decodes the predefined entities and numeric references, as the FDX reader does', () => {
    const doc = ok('<t a="&quot;x&quot; &amp; &#x27;y&#39;">&lt;Tom &amp; Jerry&gt; &#233;&#x1F600;</t>');
    expect(textOf(doc.root)).toBe('<Tom & Jerry> é😀');
    expect(attr(doc.root, 'a')).toBe(`"x" & 'y'`);
    expect(doc.warnings).toEqual([]);
  });

  it('keeps unknown entities, forbidden references and bare ampersands as written, and counts them', () => {
    const doc = ok('<t>&nbsp;&nbsp; &#0; &#xD800; R&D</t>');
    expect(textOf(doc.root)).toBe('&nbsp;&nbsp; &#0; &#xD800; R&D');
    expect(doc.warnings).toEqual([
      { code: 'unknown-entity', example: '&nbsp;', count: 2 },
      { code: 'invalid-char-ref', example: '&#0;', count: 2 },
      { code: 'bare-ampersand', example: '&', count: 1 },
    ]);
  });

  it('reads CDATA as text, skips comments and processing instructions, and normalises line ends', () => {
    const doc = ok('<?xml version="1.0"?>\r\n<!-- c --><r><?pi x?><![CDATA[<b>&amp;</b>]]>a\r\nb\rc<!-- in --></r>');
    expect(doc.root.children).toEqual([
      { type: 'text', text: '<b>&amp;</b>', cdata: true },
      { type: 'text', text: 'a\nb\nc', cdata: false },
    ]);
  });

  it('normalises whitespace in attribute values but keeps a referenced newline', () => {
    expect(attr(ok('<a v="x\ny\tz&#10;w"/>').root, 'v')).toBe('x y z\nw');
  });

  it('skips a DOCTYPE and never expands its entities', () => {
    const bomb = [
      '<!DOCTYPE lolz [',
      '<!ENTITY lol "lol">',
      '<!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">',
      '<!-- ] > -->',
      ']>',
      '<lolz>&lol1;</lolz>',
    ].join('\n');
    const doc = ok(bomb);
    expect(textOf(doc.root)).toBe('&lol1;');
    expect(doc.warnings.map((w) => w.code)).toEqual(['doctype-ignored', 'unknown-entity']);
  });
});

describe('readXml — bytes and encodings', () => {
  const enc = new TextEncoder();
  const utf16 = (text: string, bigEndian: boolean, bom: boolean): Uint8Array => {
    const all = (bom ? '\ufeff' : '') + text;
    const out = new Uint8Array(all.length * 2);
    for (let i = 0; i < all.length; i += 1) {
      const c = all.charCodeAt(i);
      out[i * 2] = bigEndian ? c >> 8 : c & 0xff;
      out[i * 2 + 1] = bigEndian ? c & 0xff : c >> 8;
    }
    return out;
  };
  const sample = '<?xml version="1.0" encoding="UTF-16"?><s>Größe 草堂</s>';

  it('reads UTF-16 with a byte-order mark, either way round, and without one', () => {
    for (const [big, bom, label] of [
      [false, true, 'utf-16le'],
      [true, true, 'utf-16be'],
      [false, false, 'utf-16le'],
      [true, false, 'utf-16be'],
    ] as const) {
      const doc = ok(utf16(sample, big, bom));
      expect(textOf(doc.root)).toBe('Größe 草堂');
      expect(doc.encoding).toBe(label);
      expect(doc.declaredEncoding).toBe('UTF-16');
    }
  });

  it('reads UTF-8 with and without a mark, and a declared single-byte encoding', () => {
    expect(textOf(ok(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('<s>é</s>')])).root)).toBe('é');
    expect(textOf(ok(enc.encode('<s>é</s>')).root)).toBe('é');
    const latin = new Uint8Array([...enc.encode('<?xml version="1.0" encoding="ISO-8859-1"?><s>'), 0xe9, ...enc.encode('</s>')]);
    const doc = ok(latin);
    expect(textOf(doc.root)).toBe('é');
    expect(doc.declaredEncoding).toBe('ISO-8859-1');
    // A UTF-16 label on ASCII-shaped bytes is a mislabel: the bytes win.
    expect(textOf(ok(enc.encode(sample)).root)).toBe('Größe 草堂');
  });

  it('refuses bytes that are not valid in their encoding, and an encoding it does not know, by name', () => {
    expect(fails(new Uint8Array([...enc.encode('<s>'), 0xff, ...enc.encode('</s>')])).code).toBe('invalid-encoding');
    expect(fails(enc.encode('<?xml version="1.0" encoding="x-klingon"?><s/>')).code).toBe('unsupported-encoding');
    expect(decodeXmlBytes(new Uint8Array(10), { maxInput: 5 })).toMatchObject({ ok: false, error: { code: 'too-large' } });
  });
});

describe('readXml — malformed input is a named error, never a throw', () => {
  const cases: Array<[string, string]> = [
    ['', 'no-root'],
    ['just text', 'no-root'],
    ['</a>', 'unexpected-close'],
    ['<a><b></a>', 'mismatched-tag'],
    ['<a>', 'unclosed-tag'],
    ['<a></a></b>', 'content-after-root'],
    ['<a/><b/>', 'content-after-root'],
    ['<a/>tail', 'content-after-root'],
    ['<a x=1/>', 'bad-attribute'],
    ['<a x="1" x="2"/>', 'duplicate-attribute'],
    ['<a x="1"y="2"/>', 'bad-attribute'],
    ['<a x="<"/>', 'bad-attribute'],
    ['<a><1/></a>', 'bad-name'],
    ['<a>1 < 2</a>', 'bad-name'],
    ['<a><!-- never closed </a>', 'unterminated'],
    ['<a><![CDATA[ never closed </a>', 'unterminated'],
    ['<a x="never closed/>', 'unterminated'],
    ['<a', 'unclosed-tag'],
  ];
  for (const [input, code] of cases) {
    it(`${JSON.stringify(input)} → ${code}`, () => {
      const error = fails(input);
      expect(error).toBeInstanceOf(XmlReadError);
      expect(error.name).toBe('XmlReadError');
      expect(error.code).toBe(code);
    });
  }

  it('says where the problem is', () => {
    const error = fails('<a>\n  <b>\n</a>');
    expect(error).toMatchObject({ code: 'mismatched-tag', line: 3, column: 1 });
    expect(error.message).toContain('line 3, column 1');
  });

  it('caps size, depth and node count', () => {
    expect(fails('<a/>', { maxInput: 3 }).code).toBe('too-large');
    expect(fails('<a>'.repeat(10) + '</a>'.repeat(10), { maxDepth: 5 }).code).toBe('too-deep');
    expect(fails(`<a>${'<b/>'.repeat(10)}</a>`, { maxNodes: 5 }).code).toBe('too-many-nodes');
  });

  it('keeps every cap when an option is NaN, Infinity, zero or negative, and the default caps cannot be changed', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(fails(`<a>${'<b>'.repeat(2000)}${'</b>'.repeat(2000)}</a>`, { maxDepth: bad }).code).toBe('too-deep');
    }
    expect(ok('<a/>', { maxInput: Number.NaN, maxNodes: Number.NaN }).root.name).toBe('a');
    expect(Object.isFrozen(XML_LIMITS)).toBe(true);
  });

  it('checks a tag with many attributes for a duplicate in linear time', () => {
    const timed = (count: number): number => {
      const source = `<a ${Array.from({ length: count }, (_, i) => `x${i}="1"`).join(' ')} x0="2"/>`;
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i += 1) {
        const start = performance.now();
        expect(fails(source).code).toBe('duplicate-attribute');
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    const small = timed(5_000);
    const large = timed(20_000);
    // Four times the attributes: a set lookup takes about four times as long, a scan of the earlier ones sixteen.
    expect(large / Math.max(small, 0.5)).toBeLessThan(10);
  });

  it('reads a deep document without recursing, and a truncated one in linear time', () => {
    const depth = 100_000;
    const deep = ok('<a>'.repeat(depth) + 'x' + '</a>'.repeat(depth), { maxDepth: depth });
    expect(textOf(deep.root)).toBe('x');
    expect([...descendants(deep.root, 'a')]).toHaveLength(depth - 1);
    const timed = (count: number): number => {
      const source = '<r>' + '<p a="1">text'.repeat(count);
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i += 1) {
        const start = performance.now();
        expect(readXml(source, { maxDepth: 10_000_000 }).ok).toBe(false);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    const small = timed(20_000);
    const large = timed(80_000);
    // Four times the input: a linear scan takes about four times as long, a quadratic one sixteen.
    expect(large / Math.max(small, 0.5)).toBeLessThan(10);
  });
});

describe('the FDX importer can run on the shared reader', () => {
  it('finds the same script paragraphs, types and text as the FDX scanner in the sample file', () => {
    const doc = ok(FDX_SAMPLE);
    const content = firstChild(doc.root, 'Content') as XmlElement;
    const paragraphs: XmlElement[] = [];
    for (const child of childElements(content)) {
      if (child.local === 'Paragraph') paragraphs.push(child);
      else if (child.local === 'DualDialogue') paragraphs.push(...childElements(child, 'Paragraph'));
    }
    const read = paragraphs.map((p) => ({ type: attr(p, 'Type') ?? '', text: childElements(p, 'Text').map(textOf).join('') }));
    expect(read).toEqual(parseFdxParagraphs(FDX_SAMPLE).map((p) => ({ type: p.type, text: p.text })));
  });

  it('finds the same script paragraphs in a real Final Draft file with nested notes and wrapped dual dialogue (#264)', () => {
    const source = readFileSync(new URL('../../screenplay/test/fixtures/fdx/TestFDX-FD.fdx', import.meta.url), 'utf8');
    const doc = ok(source);
    const content = firstChild(doc.root, 'Content') as XmlElement;
    const paragraphs: XmlElement[] = [];
    // Script paragraphs sit directly in Content, or in a DualDialogue that Final Draft wraps in a paragraph of its own.
    for (const child of childElements(content, 'Paragraph')) {
      const dual = firstChild(child, 'DualDialogue');
      if (dual === undefined) paragraphs.push(child);
      else paragraphs.push(...childElements(dual, 'Paragraph'));
    }
    const printed = (p: XmlElement): string =>
      childElements(p, 'Text')
        .filter((t) => !(attr(t, 'Style') ?? '').includes('HiddenText'))
        .map(textOf)
        .join('');
    const read = paragraphs.map((p) => ({ type: attr(p, 'Type') ?? '', text: printed(p) }));
    expect(read).toEqual(parseFdxParagraphs(source).map((p) => ({ type: p.type, text: p.text })));
  });
});
