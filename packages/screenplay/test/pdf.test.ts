import type { FlatBlock } from '../src/index.js';
import * as fontkitModule from '@pdf-lib/fontkit';
import { describe, expect, it } from 'vitest';
import {
  createPdfRenderer,
  importFountainScript,
  isPrintable,
  layoutPdf,
  loadCjkFallback,
  loadEmojiFallback,
  loadCourierPrime,
  paginate,
  parseFountain,
  pdfString,
  renderFountain,
  renderPdf,
  writePdf,
} from '../src/index.js';
import { WIN_ANSI_EXTRA } from '../src/winansi.js';
import { SCRIPT_ONE_ACT, SCRIPT_WITH_TITLE_PAGE, text } from './fixtures/corpus.js';

const fontkit = ((fontkitModule as unknown as { default?: typeof fontkitModule }).default ?? fontkitModule) as typeof fontkitModule;

function blocksOf(source: string): FlatBlock[] {
  return importFountainScript(source).nodes.map((node, i): FlatBlock => {
    if (node.kind === 'section') return { kind: 'chapter', title: node.title, level: node.depth, number: i + 1 };
    return { kind: 'scene', docId: `d${i}`, body: node.body, title: node.title, number: i + 1 };
  });
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Walks the cross-reference table strictly: every entry's offset must point at that object's header, so no hole and no collision passes. */
function expectXrefWalk(pdf: string): number {
  const xref = Number(/startxref\n(\d+)\n/.exec(pdf)?.[1]);
  expect(pdf.slice(xref, xref + 5)).toBe('xref\n');
  const lines = pdf.slice(xref).split('\n');
  const objects = Number(/^0 (\d+)$/m.exec(pdf.slice(xref, xref + 40))?.[1]) - 1;
  for (let object = 1; object <= objects; object++) {
    const offset = Number(lines[2 + object]?.slice(0, 10));
    expect(pdf.slice(offset).startsWith(`${object} 0 obj\n`), `object ${object}`).toBe(true);
  }
  return objects;
}

/** A long dialogue after a page of action: the speech must split after a sentence end (screenplay.md §5.3). */
const SPLITTING_SCRIPT = (() => {
  const filler = Array.from({ length: 25 }, (_, i) => `Filler ${i}.`).join('\n\n');
  const sentences = Array.from({ length: 6 }, () => `${'w'.repeat(34)}.`).join(' ');
  return `${filler}\n\nANNA\n${sentences}\n`;
})();

describe('renderPdf — the file structure', () => {
  it('writes a PDF whose cross-reference table points at every object', () => {
    const { bytes, pageCount } = renderPdf(blocksOf(SCRIPT_ONE_ACT), { title: 'The Lighthouse Keeper', author: 'N. Attini' });
    const pdf = decode(bytes);
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf.endsWith('%%EOF\n')).toBe(true);
    expect(pdf).toContain(`/Count ${pageCount} `);
    expect(expectXrefWalk(pdf)).toBe(4 + 2 * pageCount);
  });

  it('writes the scene heading, the cue and the dialogue into the page content as text operators', () => {
    const { bytes } = renderPdf(blocksOf(SCRIPT_ONE_ACT), { title: 'The Lighthouse Keeper' });
    const pdf = decode(bytes);
    expect(pdf).toContain('(INT. HOUSE - DAY) Tj');
    expect(pdf).toContain('(ELENA) Tj');
    expect(pdf).toContain("(I'm home.) Tj");
    expect(pdf).toContain('/BaseFont /Courier');
  });

  it('writes an empty document as a valid PDF with one blank page', () => {
    const pdf = decode(writePdf([], { title: 'Empty' }));
    expect(pdf).toContain('/Count 1 ');
    expect(pdf).toContain('/Type /Page ');
    expect(pdf.endsWith('%%EOF\n')).toBe(true);
  });

  it('writes an empty document with an embedded font whose xref points at every object', async () => {
    const pdf = decode(writePdf([], { title: 'Empty' }, await loadCourierPrime()));
    expect(pdf).toContain('/Count 1 ');
    expect(pdf).toContain('/Type /Page ');
    expect(pdf.endsWith('%%EOF\n')).toBe(true);
    // The catalogue, the page tree, the font, the info dictionary, the blank page and its content stream, then the
    // font descriptor and the font program the embedded font adds after the pages.
    expect(expectXrefWalk(pdf)).toBe(8);
  });

  it('reports one page for a script that prints nothing, the page the file itself carries', () => {
    const blocks: FlatBlock[] = [{ kind: 'scene', docId: 'd0', body: '[[production note]]', title: 'INT. A - DAY', number: 1 }];
    const { bytes, pageCount } = renderPdf(blocks, { title: 'T', titlePage: false });
    expect(pageCount).toBe(1);
    expect(decode(bytes)).toContain(`/Count ${pageCount} `);
  });

  it('writes one blank page when the script prints nothing, so the page tree is never empty', () => {
    const blocks: FlatBlock[] = [{ kind: 'scene', docId: 'd0', body: '[[production note]]', title: 'INT. A - DAY', number: 1 }];
    const pdf = decode(renderPdf(blocks, { title: 'T', titlePage: false }).bytes);
    expect(pdf).not.toContain('/Kids []');
    expect(pdf).toContain('/Count 1 ');
    expect(pdf).toContain('/Type /Page ');
  });
});

describe('renderPdf — pagination, title page and options', () => {
  it('splits long dialogue with (MORE) on the page and the continued cue on the next', () => {
    const { bytes, pageCount } = renderPdf(blocksOf(SPLITTING_SCRIPT), { title: 'Split' });
    const pdf = decode(bytes);
    expect(pageCount).toBe(2);
    // Parentheses inside a literal string are escaped, so the operators read \(MORE\) and \(CONT'D\).
    expect(pdf).toContain('(\\(MORE\\)) Tj');
    expect(pdf).toContain("(ANNA \\(CONT'D\\)) Tj");
    expect(pdf).toContain('(2.) Tj');
  });

  it('writes no (MORE) and no continued cue when the continued option is off', () => {
    const pdf = decode(renderPdf(blocksOf(SPLITTING_SCRIPT), { title: 'Split', continued: false }).bytes);
    expect(pdf).not.toContain('\\(MORE\\)');
    expect(pdf).not.toContain("\\(CONT'D\\)");
  });

  it('lays out the title page from the front matter, and leaves it out when the option is off', () => {
    const withTitle: FlatBlock[] = [{ kind: 'frontmatter', fmKind: 'titlepage' }, ...blocksOf(SCRIPT_WITH_TITLE_PAGE)];
    const opts = { title: 'The Lighthouse Keeper', author: 'N. Attini' };
    expect(decode(renderPdf(withTitle, opts).bytes)).toContain('(The Lighthouse Keeper) Tj');
    expect(decode(renderPdf(withTitle, { ...opts, titlePage: false }).bytes)).not.toContain('(The Lighthouse Keeper) Tj');
  });

  it('prints neither notes, boneyards, sections nor synopses (screenplay.md §2.1, §2.2)', () => {
    const source = text('# ACT ONE', '', 'INT. A - DAY', '= SYNOPSIS-WORDS.', '', '[[NOTE-WORDS]]', '', '/* BONEYARD-WORDS */', '', 'Action.');
    const pdf = decode(renderPdf(blocksOf(source), { title: 'T' }).bytes);
    expect(pdf).toContain('(Action.) Tj');
    expect(pdf).toContain('(INT. A - DAY) Tj');
    for (const hidden of ['ACT ONE', 'SYNOPSIS-WORDS', 'NOTE-WORDS', 'BONEYARD-WORDS']) {
      expect(pdf).not.toContain(hidden);
    }
  });

  it('prints scene numbers in the left margin when asked', () => {
    const pdf = decode(renderPdf(blocksOf(SCRIPT_ONE_ACT), { title: 'T', sceneNumbers: 'left' }).bytes);
    expect(pdf).toContain('(1) Tj');
    expect(pdf).toContain('(2) Tj');
    expect(pdf).toContain('(3) Tj');
  });

  it('reports the page count the paginator reports, and passes the Fountain notes through', () => {
    const blocks: FlatBlock[] = [{ kind: 'backmatter', bmKind: 'custom' }, ...blocksOf(SCRIPT_ONE_ACT)];
    const result = renderPdf(blocks, { title: 'T' });
    expect(result.pageCount).toBe(paginate(parseFountain(renderFountain(blocks, { title: 'T' }).text).elements).length);
    expect(result.notes).toEqual(['Back matter skipped: a screenplay has no back matter.']);
  });
});

describe('pdfString — WinAnsi and the literal-string escapes', () => {
  it('escapes parentheses and backslashes', () => {
    expect(pdfString('a(b)\\c')).toBe('a\\(b\\)\\\\c');
  });

  it('writes Latin-1 and the common punctuation as WinAnsi octal, and anything else as a question mark', () => {
    expect(pdfString('é')).toBe('\\351');
    expect(pdfString('—')).toBe('\\227');
    expect(pdfString('“x”')).toBe('\\223x\\224');
    expect(pdfString('😀')).toBe('?');
  });

  // PDF 1.7 Annex D.2: WinAnsiEncoding is Windows-1252, whose 0x80–0x9F block holds 27 characters and leaves five codes empty.
  it('encodes all 27 characters Windows-1252 holds at 0x80 to 0x9F, and none of its five empty codes', () => {
    const cp1252 = new TextDecoder('windows-1252');
    let held = 0;
    for (let byte = 0x80; byte <= 0x9f; byte++) {
      const ch = cp1252.decode(new Uint8Array([byte]));
      const code = ch.codePointAt(0) ?? 0;
      if (code === byte) {
        // An empty code decodes to the C1 control of the same number, which WinAnsi cannot encode.
        expect([0x81, 0x8d, 0x8f, 0x90, 0x9d], ch).toContain(byte);
        expect(isPrintable(ch), `U+${code.toString(16)}`).toBe(false);
        continue;
      }
      held += 1;
      expect(WIN_ANSI_EXTRA[ch], ch).toBe(byte);
      expect(isPrintable(ch), ch).toBe(true);
      expect(pdfString(ch), ch).toBe(`\\${byte.toString(8)}`);
    }
    expect(held).toBe(27);
    expect(Object.keys(WIN_ANSI_EXTRA)).toHaveLength(27);
  });

  it('has a Courier Prime glyph for each of those characters, so the embedded font prints them', async () => {
    const font = fontkit.create((await loadCourierPrime()).bytes);
    for (const ch of Object.keys(WIN_ANSI_EXTRA)) expect(font.hasGlyphForCodePoint(ch.codePointAt(0) ?? 0), ch).toBe(true);
  });

  it('prints French, Czech and Slovak text in Courier Prime, with no fallback font and no note', () => {
    const source = text('INT. ŠKOLA - DAY', '', 'Œuvre du cœur: škola, želva, Žižkov, Ÿ, ‹oui›, ˆ and ˜.');
    const layout = layoutPdf(blocksOf(source), { title: 'T' });
    expect(layout.fallbackCharacters).toEqual([]);
    expect(layout.emojiCharacters).toEqual([]);
    expect(layout.notes).toEqual([]);
    const pdf = decode(renderPdf(blocksOf(source), { title: 'T' }).bytes);
    expect(pdf).toContain('(INT. \\212KOLA - DAY) Tj');
    expect(pdf).toContain('\\214uvre du c\\234ur: \\232kola, \\236elva, \\216i\\236kov, \\237, \\213oui\\233, \\210 and \\230.');
    expect(pdf).not.toContain('/F2');
  });
});

describe('renderPdf — annotations and the text they leave (screenplay.md §2.1, §2.3)', () => {
  it('prints a note or boneyard out of its line, and the text around it', () => {
    const source = text('She [[check this]] waits.', '', '/* cut */ Action here.', '', 'Trailing text /* gone */');
    const pdf = decode(renderPdf(blocksOf(source), { title: 'T' }).bytes);
    expect(pdf).toContain('(She waits.) Tj');
    expect(pdf).toContain('(Action here.) Tj');
    expect(pdf).toContain('(Trailing text) Tj');
    for (const hidden of ['check this', 'cut', 'gone']) expect(pdf).not.toContain(hidden);
  });

  it('prints the text after the closer of a multi-line boneyard, and nothing of the boneyard', () => {
    const pdf = decode(renderPdf(blocksOf(text('/* a', ' b */ JOHN says hi.', '', 'Next.')), { title: 'T' }).bytes);
    expect(pdf).toContain('(JOHN says hi.) Tj');
    expect(pdf).toContain('(Next.) Tj');
    expect(pdf).not.toContain('b */');
  });

  it('prints a dialogue line after a note between the cue and the speech, and not the note', () => {
    const pdf = decode(renderPdf(blocksOf(text('ANNA', '[[production note]]', 'Hi there.')), { title: 'T' }).bytes);
    expect(pdf).toContain('(ANNA) Tj');
    expect(pdf).toContain('(Hi there.) Tj');
    expect(pdf).not.toContain('production note');
  });

  it('prints a cue block with a tail, and the parenthetical after its first dialogue', () => {
    const pdf = decode(renderPdf(blocksOf(text('ANNA', 'One line.', '(beat)', 'Second speech.')), { title: 'T' }).bytes);
    expect(pdf).toContain('(One line.) Tj');
    expect(pdf).toContain('(\\(beat\\)) Tj');
    expect(pdf).toContain('(Second speech.) Tj');
  });
});

describe('createPdfRenderer', () => {
  it('emits a Blob with the PDF media type and the same bytes as renderPdf', async () => {
    const blocks = blocksOf(SCRIPT_ONE_ACT);
    const blob = await createPdfRenderer().emit(blocks, { title: 'T' });
    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBe(renderPdf(blocks, { title: 'T' }, await loadCourierPrime()).bytes.length);
  });

  it('embeds Courier Prime in every file it emits', async () => {
    const pdf = decode(new Uint8Array(await (await createPdfRenderer().emit(blocksOf(SCRIPT_ONE_ACT), { title: 'T' })).arrayBuffer()));
    expect(pdf).toContain('/BaseFont /CourierPrime');
    expect(pdf).toContain('/FontFile2 ');
    expect(pdf).not.toContain('/BaseFont /Courier ');
  });
});

describe('layoutPdf — what the fonts cannot print', () => {
  it('says which characters print as a question mark, once each', () => {
    const { notes } = layoutPdf(blocksOf(text('INT. 草堂 - DAY', '', 'She reads 草堂 aloud: ꙮ 🫩 ꙮ.')), { title: 'T' });
    expect(notes).toEqual(['pdf: neither Courier Prime nor the CJK or emoji fallback font can print these 2 characters, so they are printed as "?": ꙮ 🫩']);
  });

  it('says nothing of the CJK characters the fallback font prints', () => {
    const layout = layoutPdf(blocksOf(text('INT. 草堂 - DAY', '', 'She reads 草堂 aloud.')), { title: 'T' });
    expect(layout.notes).toEqual([]);
    expect(layout.fallbackCharacters).toEqual(['草', '堂']);
  });

  it('says nothing when every character prints', () => {
    expect(layoutPdf(blocksOf(text('INT. CAFÉ - DAY', '', 'Crème brûlée — “twice”.')), { title: 'T' }).notes).toEqual([]);
  });

  it('renderPdf draws the fallbacks it is given, as drawPdf does', async () => {
    const source = text('INT. 草堂 - DAY', '', 'She reads 草堂 aloud 👍.');
    const layout = layoutPdf(blocksOf(source), { title: 'T' });
    const cjk = await loadCjkFallback(layout);
    const emoji = await loadEmojiFallback(layout);
    const result = renderPdf(blocksOf(source), { title: 'T' }, await loadCourierPrime(), cjk, emoji);
    const pdf = decode(result.bytes);
    expect(pdf).toContain('/F2 12 Tf');
    expect(pdf).toContain('/BaseFont /' + (cjk?.baseFont ?? 'none'));
    expect(pdf).toContain('/BaseFont /' + (emoji?.baseFont ?? 'none'));
    expect(result.notes).toEqual([]);
  });

  it('renderPdf without the fallbacks a script needs names the characters not printed as written', () => {
    const result = renderPdf(blocksOf(text('INT. 草堂 - DAY', '', 'She reads 草堂 aloud 👍.')), { title: 'T' });
    expect(decode(result.bytes)).not.toContain('/F2');
    expect(result.notes).toEqual(['pdf: the CJK or emoji fallback font that prints these 3 characters was not passed to renderPdf, or has no glyph for them, so they are not printed as written: 草 堂 👍']);
  });

  it('counts the script pages apart from the title page', () => {
    const blocks: FlatBlock[] = [{ kind: 'frontmatter', fmKind: 'titlepage' }, ...blocksOf(SCRIPT_ONE_ACT)];
    const layout = layoutPdf(blocks, { title: 'T', author: 'A' });
    expect(layout.pages[0]?.kind).toBe('title');
    expect(layout.scriptPageCount).toBe(layout.pages.length - 1);
  });
});
