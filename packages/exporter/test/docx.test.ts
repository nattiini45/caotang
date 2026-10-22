/**
 * The DOCX publishing gate — exporter.md §3 (the v0.1 contract) and §2 (the
 * TOC recipe).
 *
 * "It has to be in docx format or it's not getting read." So this file does not
 * check that a `.docx` came out. It opens the package with a ZIP reader and asserts
 * each clause the contract names, in the XML the clause is written in: the three
 * styles, the page break on the chapter heading, the TOC field and its switches, the
 * update-on-open setting, and the cached entries the field shows before any update.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate/browser';
import { flatten } from '../src/flatten.js';
import { DOCX_MIME, renderDocx } from '../src/render-docx.js';
import type { RenderInput } from '../src/render-input.js';
import { DEFAULT_TEMPLATE } from '../src/template.js';
import { makeProject, PROJECT_NAME, IDS, withSceneStyle } from './fixture.js';
import type { FlatBlock } from '../src/types.js';

function input(blocks?: readonly FlatBlock[], toc = true): RenderInput {
  const flat = blocks ?? flatten(makeProject(), { includeRootIds: ['manuscript'] }, { titlePage: true }).blocks;
  return { blocks: flat, title: PROJECT_NAME, author: 'M. Ortega', date: '2026-10-08', template: DEFAULT_TEMPLATE, toc };
}

async function parts(bytes: Uint8Array): Promise<Record<string, string>> {
  const files = unzipSync(bytes);
  const out: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('.xml') || name.endsWith('.rels')) out[name] = strFromU8(data);
  }
  return out;
}

const HEADING_BREAK = '<w:pStyle w:val="Heading1"/><w:pageBreakBefore/>';

describe('the DOCX package — the styles the contract names', () => {
  it('defines Title, Heading 1 and Normal as paragraph styles, and uses each one', async () => {
    const xml = await parts(await renderDocx(input()));
    const styles = xml['word/styles.xml'] ?? '';
    for (const id of ['Title', 'Heading1', 'Normal']) {
      expect(styles, `styles.xml lacks w:styleId="${id}"`).toContain(`w:styleId="${id}"`);
    }
    // docx writes the built-in name in title case; Word matches built-in headings by
    // the style id, so the name is checked case-insensitively.
    expect(styles).toMatch(/<w:style [^>]*w:styleId="Heading1"[\s\S]*?<w:name w:val="heading 1"\/>/i);
    const body = xml['word/document.xml'] ?? '';
    expect(body).toContain('<w:pStyle w:val="Title"/>');
    expect(body).toContain('<w:pStyle w:val="Heading1"/>');
  });

  it('is a .docx: the package has the WordprocessingML parts Word requires', async () => {
    const bytes = await renderDocx(input());
    const names = Object.keys(unzipSync(bytes));
    expect(names).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']));
    expect(DOCX_MIME).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });
});

describe('the DOCX chapter break — pageBreakBefore on each Heading 1', () => {
  it('starts every chapter on a new page: one pageBreakBefore Heading 1 per chapter, and no other', async () => {
    const body = (await parts(await renderDocx(input())))['word/document.xml'] ?? '';
    expect(body.split(HEADING_BREAK)).toHaveLength(3); // two chapters, so two occurrences
  });

  it('gives a chapter heading its label, number and title', async () => {
    const body = (await parts(await renderDocx(input())))['word/document.xml'] ?? '';
    expect(body).toContain('<w:t xml:space="preserve">1. Chapter One</w:t>');
    expect(body).toContain('<w:t xml:space="preserve">2. Chapter Two</w:t>');
  });

  it('does not make an author heading inside a body a Heading 1, so it adds no contents entry', async () => {
    const blocks: FlatBlock[] = [
      { kind: 'chapter', title: 'Chapter One', level: 1, number: 1 },
      { kind: 'scene', docId: IDS.landing, title: 'The Landing', body: '# Interlude\n\nThe ferry came.', number: 1 },
    ];
    const body = (await parts(await renderDocx(input(blocks, false))))['word/document.xml'] ?? '';
    expect(body.split(HEADING_BREAK)).toHaveLength(2); // the chapter only
    expect(body).toContain('Interlude');
  });
});

describe('the DOCX contents field — the TOC recipe', () => {
  it('writes a TOC field on Heading 1 with hyperlinks, inside a document-part content control', async () => {
    const body = (await parts(await renderDocx(input())))['word/document.xml'] ?? '';
    expect(body).toContain('<w:sdt>');
    // The recipe's range (exporter.md §2): headingStyleRange '1-2', which the instruction carries as `\o "1-2"`.
    expect(body).toContain('TOC \\h \\o &quot;1-2&quot;');
    expect(body).toMatch(/<w:fldChar w:fldCharType="begin"[^>]*\/><w:instrText[^>]*>TOC/);
    expect(body).toContain('<w:fldChar w:fldCharType="end"/>');
  });

  it('leaves the field dirty, so Word refreshes it once on open (beginDirty is not false)', async () => {
    const body = (await parts(await renderDocx(input())))['word/document.xml'] ?? '';
    expect(body).toContain('w:dirty="true"');
  });

  it('turns on updateFields in the settings, which is what makes Word offer the refresh', async () => {
    const settings = (await parts(await renderDocx(input())))['word/settings.xml'] ?? '';
    expect(settings).toContain('<w:updateFields/>');
  });

  it('shows the cached entries inside the field, before the first chapter — visible in any viewer', async () => {
    const body = (await parts(await renderDocx(input())))['word/document.xml'] ?? '';
    const sdtStart = body.indexOf('<w:sdt>');
    const sdtEnd = body.indexOf('</w:sdt>');
    expect(sdtStart).toBeGreaterThanOrEqual(0);
    const field = body.slice(sdtStart, sdtEnd);
    expect(field).toContain('1. Chapter One');
    expect(field).toContain('2. Chapter Two');
    expect(sdtEnd).toBeLessThan(body.indexOf(HEADING_BREAK));
  });

  it('writes no contents field when the recipe turns it off', async () => {
    const body = (await parts(await renderDocx(input(undefined, false))))['word/document.xml'] ?? '';
    expect(body).not.toContain('<w:sdt>');
    expect(body).not.toContain('TOC \\h');
  });
});

describe('a section scene — Heading 2 (exporter.md §2, Per-scene styling)', () => {
  const styled = (): RenderInput => {
    const state = withSceneStyle(makeProject(), IDS.landing, 'section');
    return input(flatten(state, { includeRootIds: ['manuscript'] }, { titlePage: true }).blocks);
  };

  it('gives the scene title paragraph the Heading 2 style, defined in styles.xml, with no page break', async () => {
    const xml = await parts(await renderDocx(styled()));
    expect(xml['word/styles.xml']).toMatch(/<w:style [^>]*w:styleId="Heading2"[\s\S]*?<w:name w:val="heading 2"\/>/i);
    const body = xml['word/document.xml'] ?? '';
    expect(body).toMatch(/<w:pStyle w:val="Heading2"\/>(?:(?!<\/w:p>)[\s\S])*The Landing/);
    expect(body.split('<w:pStyle w:val="Heading2"/>')).toHaveLength(2); // the one section, and no other scene
    expect(body).not.toContain('<w:pStyle w:val="Heading2"/><w:pageBreakBefore/>');
  });

  it('puts the section in the cached contents at level 2, after its chapter, while the field still asks for 1-2', async () => {
    const body = (await parts(await renderDocx(styled())))['word/document.xml'] ?? '';
    const field = body.slice(body.indexOf('<w:sdt>'), body.indexOf('</w:sdt>'));
    expect(body).toContain('TOC \\h \\o &quot;1-2&quot;');
    const chapterOne = field.indexOf('1. Chapter One');
    const section = field.indexOf('The Landing');
    const chapterTwo = field.indexOf('2. Chapter Two');
    expect(chapterOne).toBeGreaterThanOrEqual(0);
    expect(section).toBeGreaterThan(chapterOne);
    expect(chapterTwo).toBeGreaterThan(section);
    // The cache's paragraphs carry their level's TOC style (docx writes TOC{level}), and that style is defined.
    expect(field).toMatch(/<w:pStyle w:val="TOC2"\/>(?:(?!<\/w:p>)[\s\S])*The Landing/);
    expect((await parts(await renderDocx(styled())))['word/styles.xml']).toContain('w:styleId="TOC2"');
  });

  it('leaves a manuscript with no section scene with no Heading 2 and chapter entries only', async () => {
    const xml = await parts(await renderDocx(input()));
    expect(xml['word/document.xml']).not.toContain('Heading2');
    expect(xml['word/document.xml']).not.toContain('TOC2');
  });
});

describe('the DOCX renderer — loaded lazily, and pinned', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/render-docx.ts', import.meta.url)), 'utf8');

  it('imports docx only through a dynamic import() at the module edge, never statically', () => {
    expect(source).toMatch(/await import\('docx'\)/);
    // A type-only import is erased and loads nothing, so it is allowed; a value import is not.
    expect(source).not.toMatch(/^import (?!type )[^;]*from 'docx';/m);
  });

  it('pins docx to one exact version with no range, which is the shipped pin and not one the spec names', () => {
    // The spec names no version to pin. exporter.md §7-E1 records 9.5.2 and the later 9.8.1 and 9.9.0 as upstream facts,
    // and it leaves the choice to the renderer-fidelity benchmark, which has not run. What this test holds is the pin
    // this build ships ahead of that benchmark: one exact version, so a range can never move the renderer under a
    // benchmark that has not run.
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies['docx']).toBe('9.9.0');
    expect(manifest.dependencies['docx']).not.toMatch(/^[\^~]/);
  });
});
