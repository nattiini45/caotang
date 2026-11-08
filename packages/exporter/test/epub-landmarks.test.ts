/**
 * The EPUB landmarks navigation, and the words a compile generates (exporter.md §3a, i18n.md §7.1, #200).
 *
 * A book carries a hidden `landmarks` nav beside its contents nav: where the contents are, where the text begins, and — when the
 * project has a cover — the cover. Every landmark resolves inside the book. "Chapter" and "Untitled", where the compile has to
 * write them because the writer did not, follow the project language, as every other word in the boilerplate table does.
 */

import { describe, expect, it } from 'vitest';
import { EpubCheck } from '@likecoin/epubcheck-ts';
import { addDocument, addFolder, createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';
import { boilerplateFor, generatedChapterHeading } from '../src/boilerplate.js';
import { renderEpub } from '../src/render-epub.js';
import { COVER_PNG, epubInput, pack, untitledProject } from './epub-fixtures.js';
import { OPENED, PROJECT_NAME } from './fixture.js';

/** A book in parts: the manuscript holds a part, the part a chapter, the chapter a scene, so the part's divider has no text. */
function partProject(): ProjectState {
  const state = createProjectState(createEmptyManifest(PROJECT_NAME, OPENED));
  addFolder(state, { parentId: 'manuscript', title: 'Part One', now: OPENED, id: 'n_PART000001' });
  addFolder(state, { parentId: 'n_PART000001', title: 'The Harbour', now: OPENED, id: 'n_CHAPTER001' });
  addDocument(state, { parentId: 'n_CHAPTER001', title: 'Arrival', body: 'The ferry came in.', now: OPENED, id: 'n_ARRIVAL001' });
  return state;
}

interface Landmark {
  readonly type: string;
  readonly href: string;
  readonly text: string;
}

/** The whole `<nav epub:type="landmarks">` element, or a failure that prints the navigation it looked in. */
function landmarksOf(nav: string): string {
  const match = /<nav epub:type="landmarks"[^>]*>[\s\S]*?<\/nav>/.exec(nav);
  if (match === null) throw new Error(`the navigation has no landmarks nav:\n${nav}`);
  return match[0];
}

/** The landmarks as their `epub:type`, `href` and text. */
function linksOf(landmarks: string): Landmark[] {
  return [...landmarks.matchAll(/<a epub:type="([^"]+)" href="([^"]+)">([^<]*)<\/a>/g)].map((match) => ({
    type: match[1] ?? '',
    href: match[2] ?? '',
    text: match[3] ?? '',
  }));
}

/** The manifest's hrefs, from `content.opf`. */
function manifestHrefs(opf: string): string[] {
  return [...opf.matchAll(/<item [^>]*href="([^"]+)"/g)].map((match) => match[1] ?? '');
}

describe('the EPUB landmarks navigation (exporter.md §3a)', () => {
  it('is a hidden nav with a contents entry and a place to begin reading', async () => {
    const { text } = await pack(epubInput());
    const nav = text['OEBPS/nav.xhtml'] ?? '';
    const landmarks = landmarksOf(nav);
    expect(landmarks).toContain('hidden');
    const links = linksOf(landmarks);
    expect(links.map((link) => link.type)).toEqual(['toc', 'bodymatter']);
    expect(links[0]?.text).toBe('Contents');
    expect(links[0]?.href).toBe('nav.xhtml#toc');
    expect(links[1]?.text).toBe('Begin Reading');
    expect(links[1]?.href).toBe('chapter-001.xhtml');
  });

  it('begins reading at the first section that holds a scene, not at an empty part divider before it', async () => {
    const { text } = await pack(epubInput({}, partProject()));
    expect(text['OEBPS/chapter-001.xhtml']).toContain('epub:type="part"');
    expect(text['OEBPS/chapter-001.xhtml']).not.toContain('The ferry came in.');
    expect(text['OEBPS/chapter-002.xhtml']).toContain('The ferry came in.');
    const links = linksOf(landmarksOf(text['OEBPS/nav.xhtml'] ?? ''));
    expect(links.find((link) => link.type === 'bodymatter')?.href).toBe('chapter-002.xhtml');
  });

  it('resolves every landmark to a manifest item, and every fragment to an id in its file', async () => {
    for (const cover of [undefined, COVER_PNG]) {
      const { text } = await pack(cover === undefined ? epubInput() : epubInput({ cover }));
      const opf = text['OEBPS/content.opf'] ?? '';
      const hrefs = manifestHrefs(opf);
      const links = linksOf(landmarksOf(text['OEBPS/nav.xhtml'] ?? ''));
      expect(links.length).toBe(cover === undefined ? 2 : 3);
      for (const link of links) {
        const [file = '', fragment = ''] = link.href.split('#');
        expect(hrefs, link.href).toContain(file);
        const content = text[`OEBPS/${file}`];
        expect(content, link.href).toBeDefined();
        if (fragment !== '') expect(content, link.href).toContain(`id="${fragment}"`);
      }
    }
  });

  it('adds a cover landmark when the book has a cover, and none when it has not', async () => {
    const without = linksOf(landmarksOf((await pack(epubInput())).text['OEBPS/nav.xhtml'] ?? ''));
    expect(without.some((link) => link.type === 'cover')).toBe(false);
    const withCover = linksOf(landmarksOf((await pack(epubInput({ cover: COVER_PNG }))).text['OEBPS/nav.xhtml'] ?? ''));
    const cover = withCover.find((link) => link.type === 'cover');
    expect(cover?.href).toBe('cover.xhtml');
    expect(cover?.text).toBe('Cover');
  });

  it('labels the landmarks and writes the generated titles in the project language', async () => {
    for (const language of ['en', 'de', 'ja'] as const) {
      const words = boilerplateFor(language);
      const { text } = await pack(epubInput({ language }, untitledProject()));
      const nav = text['OEBPS/nav.xhtml'] ?? '';
      const chapterOne = text['OEBPS/chapter-001.xhtml'] ?? '';
      const chapterTwo = text['OEBPS/chapter-002.xhtml'] ?? '';
      const chapterThree = text['OEBPS/chapter-003.xhtml'] ?? '';

      // The contents nav and its landmark read the project language's word.
      expect(chapterOne, language).toContain(`<h1>${words.untitled}</h1>`);
      expect(chapterTwo, language).toContain(`<h1>${generatedChapterHeading(words, 1)}</h1>`);
      // A title the writer typed is never altered.
      expect(chapterThree, language).toContain('<h1>2. The Harbour</h1>');
      expect(chapterThree, language).toContain(`<h2>${words.untitled}</h2>`);

      const links = linksOf(landmarksOf(nav));
      expect(links.find((link) => link.type === 'toc')?.text, language).toBe(words.contents);
      expect(links.find((link) => link.type === 'bodymatter')?.text, language).toBe(words.beginReading);
      expect(nav, language).toContain(`<h2>${words.landmarks}</h2>`);

      if (language !== 'en') {
        for (const content of [nav, chapterOne, chapterTwo, chapterThree]) {
          for (const english of ['Chapter', 'Untitled', 'Landmarks', 'Begin Reading', 'Contents']) {
            expect(content, `${language}: ${english}`).not.toContain(english);
          }
        }
      }
    }
  });

  it('is epubcheck-clean with no message at all, in each language and with a cover', async () => {
    for (const language of ['en', 'de', 'ja'] as const) {
      for (const input of [epubInput({ language }, untitledProject()), epubInput({ language, cover: COVER_PNG }, untitledProject())]) {
        const result = await EpubCheck.validate(await renderEpub(input), { version: '3.3' });
        expect(result.messages.map((message) => `${message.id}: ${message.message}`), language).toEqual([]);
      }
    }
  });
});
