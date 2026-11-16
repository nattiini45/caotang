/**
 * The DOCX renderer — [exporter.md §2 and §3](../../../docs/architecture/exporter.md),
 * with the TOC recipe from §2 and the §7-E1 rubric.
 *
 * ## The contract this file has to meet (the publishing gate)
 *
 * exporter.md §3, A5: *"It has to be in docx format or it's not getting read"*. So
 * the v0.1 contract is fixed, whichever renderer is used, and
 * `test/docx.test.ts` unzips the output and asserts each clause:
 *
 * - paragraph styles `Title`, `Heading 1` (the chapter style) and `Normal`, and `Heading 2` for a `section` scene's title
 *   (exporter.md §2, Per-scene styling);
 * - parts (folders that hold chapters, project-format §2): a heading's level is its folder's depth, so in a book with parts a
 *   part is `Heading 1`, its chapters `Heading 2` and their section scenes `Heading 3`, and a chapter directly under the
 *   manuscript (a prologue) stays `Heading 1`. Levels stop at `Heading 6`. A book without parts is written exactly as before;
 * - a page break before each chapter and each part (`pageBreakBefore` on the heading), so a part heading has its page;
 * - a TOC **field** anchored on Heading 1, with `updateFields` in the settings so
 *   Word offers to refresh it on open. The setting is written only when the field is: a file with no fields must not make
 *   Word ask about fields at all;
 * - `cachedEntries` built from the binder's chapter list, and the section headings one level below their chapter, so the
 *   contents are visible in every viewer before anything is updated (the §2 TOC recipe) and agree with the field's range:
 *   `1-2` for a book without parts, and down to the deepest heading level for one with parts.
 *
 * ## Why `cachedEntries` and why the field is left dirty
 *
 * The TOC recipe rejects the two alternatives by name. `beginDirty: false` gives no prompt but
 * a stale table, because nothing ever refreshes it; a static table loses the field's
 * semantics, so Word can no longer regenerate it. A dirty field with cached content is
 * what a `.docx` needs, and this file leaves it that way on purpose.
 *
 * ## Why the field is written by hand
 *
 * `docx`'s `TableOfContents` wraps the field in a `w:sdt` block control and packs `fldChar begin`, the `instrText` and
 * `fldChar separate` into a single run. Word reads that shape, but LibreOffice flattens it: it shows the instruction as
 * text ahead of the first cached entry, imports nothing as a document index (Tools → Update indexes finds none), and
 * re-saves the file with the field instruction gone. The field is therefore emitted here as literal XML in the shape
 * Word writes — begin, instruction and separate each in their own run, one paragraph per cached entry, no `w:sdt`.
 * LibreOffice imports that shape as a real `ContentIndex` it can regenerate and re-save intact.
 *
 * The Heading styles carry `w:outlineLvl`, because a `\o` TOC field collects paragraphs by outline level and neither
 * Word nor LibreOffice regenerates entries for headings without one. The regenerated table in LibreOffice, and the
 * table Word rebuilds after the update prompt, keep their entries for that reason alone.
 *
 * ## Why the cached entries are not links
 *
 * `docx` 9.9.0 gives a cached entry a hyperlink only when the entry has an `href`, and ours have none, so they are plain
 * runs: no links and no dangling `_Toc` anchors. `hyperlink: true` only adds `\h` to the instruction, which makes the entries
 * Word regenerates clickable. No `_Toc` bookmarks are written, by decision (docs/decisions.md).
 *
 * ## Why the page numbers are absent
 *
 * The cached entries carry titles and no page numbers. Page numbers need a layout
 * this renderer does not do; Word fills them in when it updates the field. A viewer
 * that never updates a field shows the titles, which is the content the recipe requires.
 *
 * ## Notes
 *
 * A body's footnote marker (prose.ts `Run.noteId`) is a `w:footnoteReference` at the run's place, or a
 * `w:endnoteReference` when the recipe's `notes` option asks for endnotes; the note's own paragraphs are collected
 * into `footnotes`/`endnotes` on the Document, numbered in the order the markers are met. Word and LibreOffice put a
 * footnote's text at the page's foot and an endnote's at the document's end — the recipe's two placements are the
 * format's own (exporter.md §3).
 *
 * ## Text XML cannot carry
 *
 * Every run, chapter label, TOC entry and core property passes through
 * `stripXmlIllegal` first. `docx` escapes `& < > " '` itself, but it writes control
 * characters through unchanged, and a manuscript can contain them (`xml-text.ts`).
 *
 * ## Loaded lazily
 *
 * `docx` is imported with a dynamic `import()` inside the render function and
 * nowhere else. The editor bundle never pays for it (§3: "the editor bundle never
 * pays the 112 KB gzip"), and `test/docx.test.ts` reads this file to hold that line.
 */

import type * as Docx from 'docx';
import { boilerplateOf, chapterHeadings, contentsEntries, contentsHeading, hasTitlePage, headingsByBlock, sectionTitle, type RenderInput } from './render-input.js';
import { parseProse, plainRuns, type ParsedProse, type ProseBlock, type Run } from './prose.js';
import type { FigurePack, ResolvedFigure } from './figures.js';
import { DOCX_TEXT_WIDTH_TWIPS } from './picture-profile.js';
import { stripXmlIllegal } from './xml-text.js';

/** The MIME type a `.docx` is served as. */
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The body font. A manuscript is set in a serif face by convention. */
const BODY_FONT = 'Times New Roman';
const MONO_FONT = 'Courier New';
/** Half-points: 12 pt body, the convention for a manuscript. */
const BODY_SIZE = 24;
/** Twentieths of a point, the unit `docx` spacing and indent take. */
const LIST_INDENT = 360;
const QUOTE_INDENT = 720;

/** EMUs per twip: 914400 per inch over 1440 twips. */
const EMU_PER_TWIP = 635;
/** The text width of the renderer's page — the `docx` library's default A4 with 1-inch margins — in EMUs (pictures.md §4, the DOCX row). */
const TEXT_WIDTH_EMU = DOCX_TEXT_WIDTH_TWIPS * EMU_PER_TWIP;
/** EMUs per pixel at the 300 ppi the DOCX extent is measured in: 914400 / 300. */
const EMU_PER_PX_AT_300 = 3048;

/**
 * The extent a figure's `ImageRun` carries (pictures.md §4): the width is the smaller of the text
 * width and the picture's natural width at 300 ppi, the height scaled to match. `docx` takes the
 * transformation in pixels at 96 dpi, so the extent is divided by 9525 EMUs per pixel.
 */
function extentOf(width: number, height: number): { readonly width: number; readonly height: number } {
  const widthEmu = Math.min(TEXT_WIDTH_EMU, Math.round(width * EMU_PER_PX_AT_300));
  const heightEmu = Math.max(1, Math.round((widthEmu * height) / Math.max(1, width)));
  return { width: Math.max(1, Math.round(widthEmu / 9525)), height: Math.max(1, Math.round(heightEmu / 9525)) };
}

type DocxModule = typeof Docx;
type Block = Docx.FileChild;

/** Renders the whole project as a `.docx` and returns the package bytes. */
export async function renderDocx(input: RenderInput): Promise<Uint8Array> {
  const docx: DocxModule = await import('docx');
  const children: Block[] = [];
  const words = boilerplateOf(input);

  if (hasTitlePage(input)) {
    children.push(new docx.Paragraph({ style: 'Title', children: [new docx.TextRun(stripXmlIllegal(input.title))] }));
    if (input.author !== '') children.push(centred(docx, input.author));
    children.push(centred(docx, input.date));
  }

  const hasContents = input.toc && chapterHeadings(input).length > 0;
  const entries = contentsEntries(input);
  // The deepest outline level the file uses: 2 for a book without parts (chapters and section scenes), more with parts.
  const deepest = Math.min(6, Math.max(2, ...entries.map((entry) => entry.level)));
  if (hasContents) {
    children.push(
      new docx.Paragraph({
        pageBreakBefore: true,
        children: [new docx.TextRun({ text: stripXmlIllegal(contentsHeading(input)), bold: true })],
      }),
    );
    children.push(...tocField(docx, entries, deepest));
  }

  const byBlock = headingsByBlock(input);
  // The notes the document's markers name: a marker's id is document-wide (footnotes.xml numbers continuously), so the
  // scope is keyed by each body's own `notes` map — two scenes may both write `[^1]`.
  const endnote = input.notes === 'endnote';
  const noteNumbers = new WeakMap<ParsedProse['notes'], Map<string, number>>();
  const footnotes = new Map<number, Docx.Paragraph[]>();
  const endnotes = new Map<number, Docx.Paragraph[]>();
  let nextNoteId = 1;
  /** The `w:id` a marker in this body's `notes` refers to, assigning it and building the note's paragraphs on first ask. */
  const noteIdOf =
    (defs: ParsedProse['notes']) =>
    (noteId: string): { readonly id: number; readonly endnote: boolean } | undefined => {
      const blocks = defs.get(noteId);
      if (blocks === undefined) return undefined;
      let scoped = noteNumbers.get(defs);
      if (scoped === undefined) noteNumbers.set(defs, (scoped = new Map()));
      let num = scoped.get(noteId);
      if (num === undefined) {
        num = nextNoteId++;
        scoped.set(noteId, num);
        const resolve = noteIdOf(defs);
        const content = blocks.flatMap((inner) => proseParagraphs(docx, inner, 0, input.figures, resolve));
        (endnote ? endnotes : footnotes).set(num, content);
      }
      return { id: num, endnote };
    };

  /** The level of the heading the text is under, so a `section` scene's heading sits one level below it. */
  let depth = 1;
  for (const [index, block] of input.blocks.entries()) {
    switch (block.kind) {
      case 'frontmatter':
        break;
      case 'chapter':
        depth = block.level;
        children.push(
          new docx.Paragraph({
            heading: headingLevel(docx, block.level),
            pageBreakBefore: true,
            children: [new docx.TextRun(stripXmlIllegal(byBlock.get(index)?.label ?? block.title))],
          }),
        );
        break;
      case 'scene': {
        const section = sectionTitle(block, words.untitled);
        if (section !== undefined) {
          children.push(
            new docx.Paragraph({ heading: headingLevel(docx, depth + 1), children: [new docx.TextRun(stripXmlIllegal(section))] }),
          );
        }
        const parsed = parseProse(block.body);
        for (const prose of parsed.blocks) children.push(...proseParagraphs(docx, prose, 0, input.figures, noteIdOf(parsed.notes)));
        break;
      }
      case 'separator':
        children.push(centred(docx, input.template.separator.plain));
        break;
      case 'backmatter':
        break;
    }
  }

  const notesRecord = (record: Map<number, Docx.Paragraph[]>): Record<string, { readonly children: readonly Docx.Paragraph[] }> | undefined =>
    record.size === 0 ? undefined : Object.fromEntries([...record].map(([id, children]) => [String(id), { children }]));

  const document = new docx.Document({
    // The core properties are XML too (docProps/core.xml), so they get the same cleaning.
    creator: stripXmlIllegal(input.author === '' ? 'Caotang' : input.author),
    title: stripXmlIllegal(input.title),
    // §2: Word offers to update the TOC field once, on open, and then the cached
    // entries are replaced by the real ones. Without a field there is nothing to update, so no setting and no prompt.
    features: hasContents ? { updateFields: true } : undefined,
    styles: styleDefinitions(docx, deepest),
    footnotes: notesRecord(footnotes),
    endnotes: notesRecord(endnotes),
    sections: [{ properties: {}, children }],
  });

  return new Uint8Array(await docx.Packer.toArrayBuffer(document));
}

/**
 * The named styles the contract requires (`Heading 2` for a section scene included), and the one the field's entries
 * are formatted with. `docx` writes `TOC1` and `TOC2` only when they are defined, so they are.
 */
function styleDefinitions(docx: DocxModule, deepest: number): Docx.IStylesOptions {
  // Headings and contents styles below level 2 are defined only when the file reaches them (a book with parts), so a book
  // without parts carries the same styles part it always did.
  const deeper = [3, 4, 5, 6].filter((level) => level <= deepest);
  const deeperHeadings: Partial<Record<`heading${3 | 4 | 5 | 6}`, Docx.IBaseParagraphStyleOptions>> = {};
  for (const level of deeper) {
    deeperHeadings[`heading${level as 3 | 4 | 5 | 6}`] = {
      run: { font: BODY_FONT, size: Math.max(BODY_SIZE, 28 - (level - 2) * 2), bold: true },
      paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: level - 1 },
    };
  }
  return {
    default: {
      document: {
        run: { font: BODY_FONT, size: BODY_SIZE },
        paragraph: { spacing: { line: 360 } },
      },
      title: {
        run: { font: BODY_FONT, size: 52, bold: true },
        paragraph: { alignment: docx.AlignmentType.CENTER, spacing: { before: 2400, after: 240 } },
      },
      heading1: {
        run: { font: BODY_FONT, size: 32, bold: true },
        paragraph: { spacing: { before: 240, after: 360 }, outlineLevel: 0 },
      },
      heading2: {
        run: { font: BODY_FONT, size: 28, bold: true },
        paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 1 },
      },
      ...deeperHeadings,
    },
    paragraphStyles: [
      {
        id: 'Normal',
        name: 'Normal',
        quickFormat: true,
        run: { font: BODY_FONT, size: BODY_SIZE },
        paragraph: { spacing: { line: 360, after: 160 } },
      },
      {
        id: 'TOC1',
        name: 'toc 1',
        basedOn: 'Normal',
        next: 'Normal',
        run: { font: BODY_FONT, size: BODY_SIZE },
        paragraph: { spacing: { after: 100 } },
      },
      {
        id: 'TOC2',
        name: 'toc 2',
        basedOn: 'Normal',
        next: 'Normal',
        run: { font: BODY_FONT, size: BODY_SIZE },
        paragraph: { spacing: { after: 100 }, indent: { left: 240 } },
      },
      ...deeper.map((level) => ({
        id: `TOC${level}`,
        name: `toc ${level}`,
        basedOn: 'Normal',
        next: 'Normal',
        run: { font: BODY_FONT, size: BODY_SIZE },
        paragraph: { spacing: { after: 100 }, indent: { left: 240 * (level - 1) } },
      })),
      {
        // A figure's caption (pictures.md §4, the DOCX row): the built-in Caption style, smaller and italic.
        id: 'Caption',
        name: 'Caption',
        basedOn: 'Normal',
        next: 'Normal',
        run: { font: BODY_FONT, size: 20, italics: true },
        paragraph: { alignment: docx.AlignmentType.CENTER, spacing: { after: 240 } },
      },
    ],
  };
}

/** Text for the literal XML the contents field is written as. */
const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * The contents field as literal XML paragraphs (see "Why the field is written by hand" above): a dirty complex field
 * (`fldChar begin` + `instrText` + `fldChar separate`) ahead of the first cached entry, one `toc N` paragraph per
 * entry, `fldChar end` on the last. The instruction `TOC \h \o "1-N"` reaches the deepest heading level the file
 * uses; `\h` makes the entries Word regenerates clickable (there are no `_Toc` bookmarks to link to in the cache).
 */
function tocField(docx: DocxModule, entries: readonly { readonly label: string; readonly level: number }[], deepest: number): Docx.FileChild[] {
  const tabs = '<w:tabs><w:tab w:val="clear" w:pos="9026"/><w:tab w:val="right" w:pos="9025" w:leader="dot"/></w:tabs>';
  return entries.map((entry, index) => {
    const runs = [
      ...(index === 0
        ? [
            '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>',
            `<w:r><w:instrText xml:space="preserve"> TOC \\h \\o &quot;1-${deepest}&quot; </w:instrText></w:r>`,
            '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
          ]
        : []),
      `<w:r><w:t xml:space="default">${escapeXml(stripXmlIllegal(entry.label))}</w:t><w:tab/></w:r>`,
      ...(index === entries.length - 1 ? ['<w:r><w:fldChar w:fldCharType="end"/></w:r>'] : []),
    ];
    // One component per paragraph: fromXmlString writes the XML's single root element.
    return docx.ImportedXmlComponent.fromXmlString(
      `<w:p><w:pPr><w:pStyle w:val="TOC${Math.min(6, Math.max(1, entry.level))}"/>${tabs}</w:pPr>${runs.join('')}</w:p>`,
    ) as unknown as Docx.FileChild;
  });
}

/** The Word heading style for an outline level, from Heading 1 to Heading 6. */
function headingLevel(docx: DocxModule, level: number): (typeof docx.HeadingLevel)[keyof typeof docx.HeadingLevel] {
  const levels = [
    docx.HeadingLevel.HEADING_1,
    docx.HeadingLevel.HEADING_2,
    docx.HeadingLevel.HEADING_3,
    docx.HeadingLevel.HEADING_4,
    docx.HeadingLevel.HEADING_5,
    docx.HeadingLevel.HEADING_6,
  ] as const;
  return levels[Math.min(6, Math.max(1, level)) - 1] ?? docx.HeadingLevel.HEADING_1;
}

function centred(docx: DocxModule, text: string): Docx.Paragraph {
  return new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    children: [new docx.TextRun(stripXmlIllegal(text))],
  });
}

/**
 * One prose block as DOCX paragraphs. A heading inside a body is set as bold body
 * text rather than as Heading 1, so an author's own `#` line cannot add an entry to
 * the contents. A figure becomes an `ImageRun` paragraph followed by its caption in
 * the Caption style (pictures.md §4); a placement whose file is missing degrades to
 * its caption as a plain paragraph.
 */
function proseParagraphs(
  docx: DocxModule,
  block: ProseBlock,
  indent: number,
  figures: FigurePack | undefined,
  noteId?: (noteId: string) => { readonly id: number; readonly endnote: boolean } | undefined,
  lead?: string,
): Docx.Paragraph[] {
  switch (block.kind) {
    case 'paragraph':
      return [paragraph(docx, lead === undefined ? block.runs : [{ text: lead }, ...block.runs], indent, noteId)];
    case 'heading':
      return [paragraph(docx, block.runs.map((run) => ({ ...run, strong: true })), indent, noteId)];
    case 'break':
      return [centred(docx, '* * *')];
    case 'figure':
      return figureParagraphs(docx, block, figures);
    case 'quote':
      return block.blocks.flatMap((inner) => proseParagraphs(docx, inner, indent + QUOTE_INDENT, figures, noteId));
    case 'list':
      return block.items.flatMap((item, index) => {
        const marker = block.ordered ? `${index + 1}. ` : '• ';
        return item.flatMap((inner, position) =>
          proseParagraphs(docx, inner, indent + LIST_INDENT, figures, noteId, position === 0 ? marker : undefined),
        );
      });
    case 'code':
      return block.text.split('\n').map((line) =>
        paragraph(docx, [{ text: line, code: true }], indent, noteId),
      );
  }
}

/** A figure as an `ImageRun` sized by extent, then its caption in the Caption style; the alt text is the `docPr descr`. */
function figureParagraphs(docx: DocxModule, block: Extract<ProseBlock, { kind: 'figure' }>, figures: FigurePack | undefined): Docx.Paragraph[] {
  const figure: ResolvedFigure | undefined = figures?.figures.get(block.image.url);
  if (figure === undefined || figure.image === undefined) {
    const text = figure !== undefined && figure.caption !== '' ? figure.caption : block.image.alt;
    return text === '' ? [] : [paragraph(docx, [{ text }], 0)];
  }
  const { width, height } = extentOf(figure.image.width, figure.image.height);
  const run = new docx.ImageRun({
    type: figure.image.name.endsWith('.jpg') ? 'jpg' : 'png',
    data: figure.image.bytes,
    transformation: { width, height },
    altText: {
      name: `picture ${figure.image.name}`,
      description: figure.decorative ? '' : figure.alt,
      ...(figure.caption === '' ? {} : { title: figure.caption }),
    },
  });
  const out = [new docx.Paragraph({ alignment: docx.AlignmentType.CENTER, children: [run] })];
  if (figure.caption !== '') {
    out.push(new docx.Paragraph({ style: 'Caption', children: [new docx.TextRun(stripXmlIllegal(figure.caption))] }));
  }
  return out;
}

function paragraph(
  docx: DocxModule,
  runs: readonly Run[],
  indent: number,
  noteId?: (noteId: string) => { readonly id: number; readonly endnote: boolean } | undefined,
): Docx.Paragraph {
  return new docx.Paragraph({
    indent: indent > 0 ? { left: indent } : undefined,
    children: runs.map((run) => textRun(docx, run, noteId)),
  });
}

function textRun(
  docx: DocxModule,
  run: Run,
  noteId?: (noteId: string) => { readonly id: number; readonly endnote: boolean } | undefined,
): Docx.ParagraphChild {
  if (run.br === true) return new docx.TextRun({ break: 1 });
  if (run.noteId !== undefined) {
    // The marker becomes the format's own reference; a note the resolver cannot place stays its written text.
    const note = noteId?.(run.noteId);
    if (note !== undefined) return note.endnote ? new docx.EndnoteReferenceRun(note.id) : new docx.FootnoteReferenceRun(note.id);
    return new docx.TextRun({ text: stripXmlIllegal(`[^${run.noteId}]`), ...runMarks(run) });
  }
  return new docx.TextRun({ text: stripXmlIllegal(plainRuns([run])), ...runMarks(run) });
}

function runMarks(run: Run): { readonly bold?: true; readonly italics?: true; readonly font?: string } {
  return {
    bold: run.strong === true ? true : undefined,
    italics: run.em === true ? true : undefined,
    font: run.code === true ? MONO_FONT : undefined,
  };
}
