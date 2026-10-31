/**
 * The EPUB renderer — [exporter.md §3a](../../../docs/architecture/exporter.md) and
 * [epub-metadata.md](../../../docs/architecture/epub-metadata.md).
 *
 * ## Shape
 *
 * ```
 * mimetype                  stored, first entry, "application/epub+zip"
 * META-INF/container.xml    → OEBPS/content.opf
 * OEBPS/content.opf         metadata floor + manifest + spine
 * OEBPS/nav.xhtml           EPUB 3 contents, from the binder chapter list
 * OEBPS/toc.ncx             the same list, for EPUB 2 reading systems
 * OEBPS/titlepage.xhtml     the title page (added: see the report — §3a names the chapters only)
 * OEBPS/chapter-NNN.xhtml   one file per chapter, and one per part
 * ```
 *
 * A part (a folder that holds chapters, project-format §2) is a file of its own, `epub:type="part"`, holding its heading and any
 * scene filed directly in it. The contents nest: a part's chapters are a list inside its entry, in `nav.xhtml` and in `toc.ncx`.
 *
 * It is built from the same flat blocks the other renderers consume. The body text
 * goes through the shared prose model, so the XHTML is a function of the body and
 * nothing else, and an unknown construct keeps its text.
 *
 * ## Why this is hand-written and not a library
 *
 * §3a: no generation library is maintained for this. `epub-gen` is dead, `epub-gen-memory`
 * is dormant and takes HTML where the spec needs blocks, and `@smoores/epub` is a
 * reference for the design, not a dependency. The writer here is the part that is
 * ~200 lines of spec-shaped XML; the ZIP is `fflate`, the one dependency §3a names.
 *
 * ## Loaded lazily, from the browser build
 *
 * `fflate/browser` is imported with a dynamic `import()` at this module's edge, for
 * the reason `packages/store/src/zip.ts` measured: the bare `fflate` specifier
 * resolves to the Node build under the test environment, and the browser app bundles
 * the other one. `test/epub.test.ts` reads this file to hold both lines.
 */

import type { ZipOptions } from 'fflate/browser';
import { hasTitlePage, headingsByBlock, sectionTitle, type RenderInput } from './render-input.js';
import { parseProse, type ProseBlock, type Run } from './prose.js';
import type { FlatBlock } from './types.js';
import { stripXmlIllegal } from './xml-text.js';

/** The MIME type an EPUB is served as, and the first entry of the container. */
export const EPUB_MIME = 'application/epub+zip';

/** A cover image the book carries (epub-metadata.md): its bytes, its file extension and its media type. */
export interface EpubCover {
  readonly extension: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}

export interface EpubInput extends RenderInput {
  /** BCP-47 language tag, the language subtag at least (`en`). */
  readonly language: string;
  /** `urn:uuid:…`, persistent across re-packs (epub-metadata.md, the floor's identifier). */
  readonly identifier: string;
  /**
   * `urn:isbn:` and thirteen digits: the optional second `dc:identifier`, refined with the ONIX code for ISBN-13
   * (epub-metadata.md). Omitted from the package document when absent, never written as a placeholder.
   */
  readonly isbn?: string;
  /** The cover image, when the project has one: a `cover-image` manifest item and the legacy `cover` meta. */
  readonly cover?: EpubCover;
  /** `YYYY-MM-DDTHH:MM:SSZ`, computed at pack time and never stored (epub-metadata.md). */
  readonly modified: string;
  /** The time every ZIP entry is stamped with, so a pack is reproducible for a given clock. */
  readonly mtime: Date;
}

/** One XHTML file: a chapter, the leading material before any chapter, or the title page. */
interface Section {
  readonly file: string;
  readonly id: string;
  readonly heading: string;
  /** Set when the section's heading is a scene's own title (a loose lead scene), so a `section` style does not print it twice. */
  readonly headedBy?: string;
  /** The heading's folder depth (1 at the top), which places its entry in the nested contents. */
  readonly level: number;
  /** Whether the section is a part's, written as `epub:type="part"`. */
  readonly part: boolean;
  readonly blocks: readonly FlatBlock[];
}

const TITLE_PAGE_FILE = 'titlepage.xhtml';
const NAV_FILE = 'nav.xhtml';
const NCX_FILE = 'toc.ncx';
const OPF_PATH = 'OEBPS/content.opf';

/** Renders the EPUB and returns the ZIP's bytes. */
export async function renderEpub(input: EpubInput): Promise<Uint8Array> {
  const { zipSync, strToU8 } = await import('fflate/browser');
  const sections = buildSections(input);
  const titlePage = hasTitlePage(input);
  const mtime = input.mtime;

  const files: Record<string, [Uint8Array, ZipOptions]> = {};
  // Insertion order is the archive order, and the spec's one hard ordering rule is
  // that `mimetype` is the first entry and is stored, not deflated (§3a).
  files['mimetype'] = [strToU8(EPUB_MIME), { level: 0, mtime }];
  files['META-INF/container.xml'] = [strToU8(containerXml()), { level: 9, mtime }];
  files[OPF_PATH] = [strToU8(packageOpf(input, sections, titlePage)), { level: 9, mtime }];
  files[`OEBPS/${NAV_FILE}`] = [strToU8(navXhtml(input, sections)), { level: 9, mtime }];
  files[`OEBPS/${NCX_FILE}`] = [strToU8(ncx(input, sections)), { level: 9, mtime }];
  if (titlePage) {
    files[`OEBPS/${TITLE_PAGE_FILE}`] = [strToU8(titlePageXhtml(input)), { level: 9, mtime }];
  }
  // An image is already compressed, so it is stored rather than deflated: the archive is no smaller for the effort.
  if (input.cover !== undefined) {
    files[coverPath(input.cover)] = [input.cover.bytes, { level: 0, mtime }];
  }
  for (const section of sections) {
    files[`OEBPS/${section.file}`] = [strToU8(sectionXhtml(input, section)), { level: 9, mtime }];
  }

  return zipSync(files, { level: 9, mtime });
}

/**
 * The sections the book is written as. A chapter block opens one. Scenes that come
 * before the first chapter (a prologue filed directly under the manuscript) open a
 * leading one, headed by the first such scene's title, so a loose scene is neither
 * dropped nor given the book's title as a heading it does not have.
 */
function buildSections(input: RenderInput): Section[] {
  type Draft = { heading: string; headedBy?: string; level: number; part: boolean; blocks: FlatBlock[] };
  const sections: Draft[] = [];
  const headings = headingsByBlock(input);
  let current: Draft | undefined;
  for (const [index, block] of input.blocks.entries()) {
    if (block.kind === 'frontmatter') continue;
    if (block.kind === 'chapter') {
      current = { heading: headings.get(index)?.label ?? block.title, level: block.level, part: block.part === true, blocks: [] };
      sections.push(current);
      continue;
    }
    if (current === undefined) {
      current =
        block.kind === 'scene'
          ? { heading: block.title, headedBy: block.docId, level: 1, part: false, blocks: [] }
          : { heading: input.title, level: 1, part: false, blocks: [] };
      sections.push(current);
    }
    current.blocks.push(block);
  }
  if (sections.length === 0) sections.push({ heading: input.title, level: 1, part: false, blocks: [] });

  return sections.map((section, index) => ({
    file: `chapter-${String(index + 1).padStart(3, '0')}.xhtml`,
    id: `chapter-${String(index + 1).padStart(3, '0')}`,
    heading: section.heading,
    ...(section.headedBy === undefined ? {} : { headedBy: section.headedBy }),
    level: section.level,
    part: section.part,
    blocks: section.blocks,
  }));
}

/** One contents entry and the entries nested under it: a part's chapters. */
interface NavNode {
  readonly section: Section;
  readonly index: number;
  readonly children: NavNode[];
}

/**
 * The sections as a tree for the contents: a section goes under the nearest section before it with a lower level, so a part's
 * chapters nest in its entry and a prologue after the parts is a top-level entry again. A book without parts is a flat list.
 */
function navTree(sections: readonly Section[]): NavNode[] {
  const roots: NavNode[] = [];
  const open: NavNode[] = [];
  sections.forEach((section, index) => {
    const node: NavNode = { section, index, children: [] };
    while (open.length > 0 && (open[open.length - 1]?.section.level ?? 0) >= section.level) open.pop();
    const parent = open[open.length - 1];
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    open.push(node);
  });
  return roots;
}

function navDepth(nodes: readonly NavNode[]): number {
  return nodes.reduce((deepest, node) => Math.max(deepest, 1 + navDepth(node.children)), 0);
}

// -- container and package ----------------------------------------------------

function containerXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
    '  <rootfiles>',
    `    <rootfile full-path="${OPF_PATH}" media-type="application/oebps-package+xml"/>`,
    '  </rootfiles>',
    '</container>',
    '',
  ].join('\n');
}

/** The file a cover is written to: `cover.<ext>` at the top of the content folder, the name the manifest item points at. */
function coverPath(cover: EpubCover): string {
  return `OEBPS/cover.${cover.extension}`;
}

function packageOpf(input: EpubInput, sections: readonly Section[], titlePage: boolean): string {
  const lang = escapeXml(input.language);
  const manifest: string[] = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
  ];
  if (input.cover !== undefined) {
    manifest.push(
      `    <item id="cover-image" href="cover.${escapeXml(input.cover.extension)}" media-type="${escapeXml(input.cover.mime)}" properties="cover-image"/>`,
    );
  }
  const spine: string[] = [];
  if (titlePage) {
    manifest.push(`    <item id="titlepage" href="${TITLE_PAGE_FILE}" media-type="application/xhtml+xml"/>`);
    spine.push('    <itemref idref="titlepage"/>');
  }
  for (const section of sections) {
    manifest.push(`    <item id="${section.id}" href="${section.file}" media-type="application/xhtml+xml"/>`);
    spine.push(`    <itemref idref="${section.id}"/>`);
  }

  const creator = input.author === '' ? [] : [`    <dc:creator id="creator">${escapeXml(input.author)}</dc:creator>`];
  // The ISBN is a second identifier, refined with its ONIX scheme (epub-metadata.md). The unique identifier stays the uuid.
  const isbn =
    input.isbn === undefined
      ? []
      : [
          `    <dc:identifier id="isbn-id">${escapeXml(input.isbn)}</dc:identifier>`,
          '    <meta refines="#isbn-id" property="identifier-type" scheme="onix:codelist5">15</meta>',
        ];
  // The legacy cover meta: the one reading systems that predate the cover-image property still find (epub-metadata.md).
  const coverMeta = input.cover === undefined ? [] : ['    <meta name="cover" content="cover-image"/>'];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${lang}">`,
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `    <dc:identifier id="pub-id">${escapeXml(input.identifier)}</dc:identifier>`,
    ...isbn,
    `    <dc:title>${escapeXml(input.title)}</dc:title>`,
    `    <dc:language>${lang}</dc:language>`,
    ...creator,
    ...coverMeta,
    `    <meta property="dcterms:modified">${escapeXml(input.modified)}</meta>`,
    '  </metadata>',
    '  <manifest>',
    ...manifest,
    '  </manifest>',
    '  <spine toc="ncx">',
    ...spine,
    '  </spine>',
    '</package>',
    '',
  ].join('\n');
}

// -- navigation -----------------------------------------------------------------

function navXhtml(input: EpubInput, sections: readonly Section[]): string {
  // An entry with children holds them in an `ol` inside its `li` (EPUB 3 §7.4.2); a leaf entry stays one line, as before.
  const items = (nodes: readonly NavNode[], pad: string): string[] =>
    nodes.flatMap((node) => {
      const link = `<a href="${node.section.file}">${escapeXml(node.section.heading)}</a>`;
      if (node.children.length === 0) return [`${pad}<li>${link}</li>`];
      return [`${pad}<li>${link}`, `${pad}  <ol>`, ...items(node.children, `${pad}    `), `${pad}  </ol>`, `${pad}</li>`];
    });
  return xhtmlPage(input, 'Contents', [
    '<nav epub:type="toc" id="toc">',
    '  <h1>Contents</h1>',
    '  <ol>',
    ...items(navTree(sections), '    '),
    '  </ol>',
    '</nav>',
  ]);
}

function ncx(input: EpubInput, sections: readonly Section[]): string {
  const tree = navTree(sections);
  // A navPoint nests its children before it closes; play order is the reading order, which is the sections' order.
  const pointsOf = (nodes: readonly NavNode[], pad: string): string[] =>
    nodes.flatMap((node) => [
      `${pad}<navPoint id="navPoint-${node.index + 1}" playOrder="${node.index + 1}">`,
      `${pad}  <navLabel><text>${escapeXml(node.section.heading)}</text></navLabel>`,
      `${pad}  <content src="${node.section.file}"/>`,
      ...pointsOf(node.children, `${pad}  `),
      `${pad}</navPoint>`,
    ]);
  const points = [pointsOf(tree, '    ')];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">',
    '  <head>',
    `    <meta name="dtb:uid" content="${escapeXml(input.identifier)}"/>`,
    `    <meta name="dtb:depth" content="${Math.max(1, navDepth(tree))}"/>`,
    '    <meta name="dtb:totalPageCount" content="0"/>',
    '    <meta name="dtb:maxPageNumber" content="0"/>',
    '  </head>',
    `  <docTitle><text>${escapeXml(input.title)}</text></docTitle>`,
    '  <navMap>',
    ...points.flat(),
    '  </navMap>',
    '</ncx>',
    '',
  ].join('\n');
}

// -- content --------------------------------------------------------------------

function titlePageXhtml(input: EpubInput): string {
  const lines = [`  <h1 class="title">${escapeXml(input.title)}</h1>`];
  if (input.author !== '') lines.push(`  <p class="author">${escapeXml(input.author)}</p>`);
  lines.push(`  <p class="date">${escapeXml(input.date)}</p>`);
  return xhtmlPage(input, input.title, ['<section class="titlepage">', ...lines, '</section>']);
}

function sectionXhtml(input: EpubInput, section: Section): string {
  const body: string[] = [`  <h1>${escapeXml(section.heading)}</h1>`];
  for (const block of section.blocks) {
    switch (block.kind) {
      case 'scene': {
        const title = block.docId === section.headedBy ? undefined : sectionTitle(block);
        if (title !== undefined) body.push(`  <h2>${escapeXml(title)}</h2>`);
        for (const prose of parseProse(block.body)) body.push(...indent(proseXhtml(prose, input.template.separator.plain)));
        break;
      }
      case 'separator':
        body.push(`  <p class="scene-break">${escapeXml(input.template.separator.plain)}</p>`);
        break;
      default:
        break;
    }
  }
  const type = section.part ? 'part' : 'chapter';
  return xhtmlPage(input, section.heading, [`<section id="${section.id}" epub:type="${type}">`, ...body, '</section>']);
}

function indent(lines: readonly string[]): string[] {
  return lines.map((line) => `  ${line}`);
}

/** One prose block as XHTML lines. Every line here is a complete element, so the output is well-formed by construction. */
function proseXhtml(block: ProseBlock, separator: string): string[] {
  switch (block.kind) {
    case 'paragraph': {
      const inner = runsXhtml(block.runs);
      return inner === '' ? [] : [`<p>${inner}</p>`];
    }
    case 'heading': {
      const inner = runsXhtml(block.runs);
      return inner === '' ? [] : [`<p class="heading"><strong>${inner}</strong></p>`];
    }
    case 'break':
      return [`<p class="scene-break">${escapeXml(separator)}</p>`];
    case 'quote':
      return ['<blockquote>', ...block.blocks.flatMap((inner) => proseXhtml(inner, separator)).map((line) => `  ${line}`), '</blockquote>'];
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.flatMap((item) => [
        '<li>',
        ...item.flatMap((inner) => proseXhtml(inner, separator)).map((line) => `  ${line}`),
        '</li>',
      ]);
      return [`<${tag}>`, ...items.map((line) => `  ${line}`), `</${tag}>`];
    }
    case 'code':
      return [`<pre><code>${escapeXml(block.text)}</code></pre>`];
  }
}

function runsXhtml(runs: readonly Run[]): string {
  return runs
    .map((run) => {
      if (run.br === true) return '<br/>';
      let out = escapeXml(run.text);
      if (run.code === true) out = `<code>${out}</code>`;
      if (run.em === true) out = `<em>${out}</em>`;
      if (run.strong === true) out = `<strong>${out}</strong>`;
      if (run.href !== undefined) out = `<a href="${escapeXml(run.href)}">${out}</a>`;
      return out;
    })
    .join('');
}

/** The one XHTML page wrapper every file uses. */
function xhtmlPage(input: EpubInput, title: string, bodyLines: readonly string[]): string {
  const lang = escapeXml(input.language);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">`,
    '<head>',
    '  <meta charset="utf-8"/>',
    `  <title>${escapeXml(title)}</title>`,
    '</head>',
    '<body>',
    ...bodyLines.map((line) => `  ${line}`),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * The five characters XML cannot carry bare, and the control characters it cannot
 * carry at all (`stripXmlIllegal`). Attribute values and text get the same treatment,
 * and every text sink in this file goes through here, so no part can carry either.
 */
export function escapeXml(text: string): string {
  return stripXmlIllegal(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
