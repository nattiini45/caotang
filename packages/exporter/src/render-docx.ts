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
 * - a page break before each chapter (`pageBreakBefore` on the Heading 1);
 * - a TOC **field** anchored on Heading 1, with `updateFields` in the settings so
 *   Word offers to refresh it on open. The setting is written only when the field is: a file with no fields must not make
 *   Word ask about fields at all;
 * - `cachedEntries` built from the binder's chapter list, and the section headings at level 2, so the contents are
 *   visible in every viewer before anything is updated (the §2 TOC recipe) and agree with the field's `1-2` range.
 *
 * ## Why `cachedEntries` and why the field is left dirty
 *
 * The TOC recipe rejects the two alternatives by name. `beginDirty: false` gives no prompt but
 * a stale table, because nothing ever refreshes it; a static table loses the field's
 * semantics, so Word can no longer regenerate it. The default — a dirty field with
 * cached content — is what `docx` writes when `beginDirty` is not given, and this
 * file leaves it that way on purpose.
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
import { chapterHeadings, contentsEntries, contentsHeading, hasTitlePage, sectionTitle, type RenderInput } from './render-input.js';
import { parseProse, plainRuns, type ProseBlock, type Run } from './prose.js';
import type { FigurePack, ResolvedFigure } from './figures.js';
import { DOCX_TEXT_WIDTH_TWIPS } from './picture-profile.js';
import { chapterLabel } from './template.js';
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
type Block = Docx.Paragraph | Docx.TableOfContents;

/** Renders the whole project as a `.docx` and returns the package bytes. */
export async function renderDocx(input: RenderInput): Promise<Uint8Array> {
  const docx: DocxModule = await import('docx');
  const children: Block[] = [];

  if (hasTitlePage(input)) {
    children.push(new docx.Paragraph({ style: 'Title', children: [new docx.TextRun(stripXmlIllegal(input.title))] }));
    if (input.author !== '') children.push(centred(docx, input.author));
    children.push(centred(docx, input.date));
  }

  const hasContents = input.toc && chapterHeadings(input).length > 0;
  if (hasContents) {
    children.push(
      new docx.Paragraph({
        pageBreakBefore: true,
        children: [new docx.TextRun({ text: stripXmlIllegal(contentsHeading(input)), bold: true })],
      }),
    );
    children.push(
      new docx.TableOfContents(stripXmlIllegal(contentsHeading(input)), {
        hyperlink: true,
        // exporter.md §2's recipe: `TableOfContents(alias, { hyperlink: true, headingStyleRange: '1-2' })`. Heading 1 is a
        // chapter and Heading 2 a `section` scene, so the cached entries list both, in document order, as the field would.
        headingStyleRange: '1-2',
        cachedEntries: contentsEntries(input).map((entry) => ({ title: stripXmlIllegal(entry.label), level: entry.level })),
      }),
    );
  }

  for (const block of input.blocks) {
    switch (block.kind) {
      case 'frontmatter':
        break;
      case 'chapter':
        children.push(
          new docx.Paragraph({
            heading: docx.HeadingLevel.HEADING_1,
            pageBreakBefore: true,
            children: [new docx.TextRun(stripXmlIllegal(chapterLabel(input.template, block.number, block.title)))],
          }),
        );
        break;
      case 'scene': {
        const section = sectionTitle(block);
        if (section !== undefined) {
          children.push(
            new docx.Paragraph({ heading: docx.HeadingLevel.HEADING_2, children: [new docx.TextRun(stripXmlIllegal(section))] }),
          );
        }
        for (const prose of parseProse(block.body)) children.push(...proseParagraphs(docx, prose, 0, input.figures));
        break;
      }
      case 'separator':
        children.push(centred(docx, input.template.separator.plain));
        break;
      case 'backmatter':
        break;
    }
  }

  const document = new docx.Document({
    // The core properties are XML too (docProps/core.xml), so they get the same cleaning.
    creator: stripXmlIllegal(input.author === '' ? 'Caotang' : input.author),
    title: stripXmlIllegal(input.title),
    // §2: Word offers to update the TOC field once, on open, and then the cached
    // entries are replaced by the real ones. Without a field there is nothing to update, so no setting and no prompt.
    features: hasContents ? { updateFields: true } : undefined,
    styles: styleDefinitions(docx),
    sections: [{ properties: {}, children }],
  });

  return new Uint8Array(await docx.Packer.toArrayBuffer(document));
}

/**
 * The named styles the contract requires (`Heading 2` for a section scene included), and the one the field's entries
 * are formatted with. `docx` writes `TOC1` and `TOC2` only when they are defined, so they are.
 */
function styleDefinitions(docx: DocxModule): Docx.IStylesOptions {
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
        paragraph: { spacing: { before: 240, after: 360 } },
      },
      heading2: {
        run: { font: BODY_FONT, size: 28, bold: true },
        paragraph: { spacing: { before: 240, after: 240 } },
      },
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
function proseParagraphs(docx: DocxModule, block: ProseBlock, indent: number, figures: FigurePack | undefined, lead?: string): Docx.Paragraph[] {
  switch (block.kind) {
    case 'paragraph':
      return [paragraph(docx, lead === undefined ? block.runs : [{ text: lead }, ...block.runs], indent)];
    case 'heading':
      return [paragraph(docx, block.runs.map((run) => ({ ...run, strong: true })), indent)];
    case 'break':
      return [centred(docx, '* * *')];
    case 'figure':
      return figureParagraphs(docx, block, figures);
    case 'quote':
      return block.blocks.flatMap((inner) => proseParagraphs(docx, inner, indent + QUOTE_INDENT, figures));
    case 'list':
      return block.items.flatMap((item, index) => {
        const marker = block.ordered ? `${index + 1}. ` : '• ';
        return item.flatMap((inner, position) =>
          proseParagraphs(docx, inner, indent + LIST_INDENT, figures, position === 0 ? marker : undefined),
        );
      });
    case 'code':
      return block.text.split('\n').map((line) =>
        paragraph(docx, [{ text: line, code: true }], indent),
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

function paragraph(docx: DocxModule, runs: readonly Run[], indent: number): Docx.Paragraph {
  return new docx.Paragraph({
    indent: indent > 0 ? { left: indent } : undefined,
    children: runs.map((run) => textRun(docx, run)),
  });
}

function textRun(docx: DocxModule, run: Run): Docx.TextRun {
  if (run.br === true) return new docx.TextRun({ break: 1 });
  return new docx.TextRun({
    text: stripXmlIllegal(plainRuns([run])),
    bold: run.strong === true ? true : undefined,
    italics: run.em === true ? true : undefined,
    font: run.code === true ? MONO_FONT : undefined,
  });
}
