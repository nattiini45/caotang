/**
 * The Markdown picture modes and the plain-text placeholder (pictures.md §4, the Markdown and Plain text rows). The expected text is
 * written out in full: a copy changes the image construct's destination and title and no other byte, a link keeps the project-relative
 * destination and says what that costs, a drop leaves the alt or caption text and says how many pictures went.
 */

import { describe, expect, it } from 'vitest';
import { encodePlacementTitle } from '@caotang/pictures';

import { figureSourcesOf, resolveFigures, usedAssetFilesOf, type FigurePack } from '../src/figures.js';
import { rewriteMarkdownImages, type MarkdownPicturesMode } from '../src/markdown-pictures.js';
import { copySpec } from '../src/picture-profile.js';
import { renderMarkdown, renderText } from '../src/render-text.js';
import type { RenderInput } from '../src/render-input.js';
import { DEFAULT_TEMPLATE } from '../src/template.js';
import type { FlatBlock } from '../src/types.js';
import { hostOf, ID_A, ID_B, ID_C, pngFile, solidPng, urlOf } from './figure-fixtures.js';

const ASSETS_DIR = 'Book.assets';
const A = urlOf(pngFile(ID_A));
const B = urlOf(pngFile(ID_B));
const C = urlOf(pngFile(ID_C));
const FILES = { [`assets/${pngFile(ID_A)}`]: solidPng(4, 3), [`assets/${pngFile(ID_B)}`]: solidPng(6, 2, [10, 200, 10, 255]) };

const scene = (body: string): FlatBlock[] => [{ kind: 'scene', docId: 'n_SCENE00001', title: 'Scene', body, number: 1 }];

/** What a compile does for one body: resolves the pictures under the mode's profile, then rewrites the images. */
async function exported(
  body: string,
  mode: MarkdownPicturesMode,
): Promise<{ readonly text: string; readonly notes: string[]; readonly pack: FigurePack }> {
  const pack = await resolveFigures(figureSourcesOf(scene(body)), hostOf(FILES).host, { ...copySpec({}), embed: mode === 'copy' });
  const notes: string[] = [];
  const text = rewriteMarkdownImages(body, mode, mode === 'copy' ? ASSETS_DIR : undefined, pack, notes);
  return { text, notes, pack };
}

const harbourTitle = encodePlacementTitle({ caption: 'The harbour', size: 'half' }) ?? '';

const PROSE = [
  '# A *scene* with `code` and a [link](../assets/notes.md)',
  '',
  'Text before.  Two spaces, **bold** and _emphasis_.',
  '',
  `![Harbour at dusk](${A} "${harbourTitle}")`,
  '',
  `Second ![inline picture](${B}) in a sentence.`,
  '',
  `![Harbour again](${A} "${harbourTitle}")`,
  '',
  '> A quote, and a footnote-free end.',
].join('\n');

describe('Markdown copy: the image construct changes and nothing else does', () => {
  it('rewrites each destination to <name>.assets/<file> and the title to the decoded caption', async () => {
    const { text, notes } = await exported(PROSE, 'copy');
    expect(text).toBe(
      [
        '# A *scene* with `code` and a [link](../assets/notes.md)',
        '',
        'Text before.  Two spaces, **bold** and _emphasis_.',
        '',
        `![Harbour at dusk](${ASSETS_DIR}/${pngFile(ID_A)} "The harbour")`,
        '',
        `Second ![inline picture](${ASSETS_DIR}/${pngFile(ID_B)}) in a sentence.`,
        '',
        `![Harbour again](${ASSETS_DIR}/${pngFile(ID_A)} "The harbour")`,
        '',
        '> A quote, and a footnote-free end.',
      ].join('\n'),
    );
    expect(notes).toEqual([]);
  });

  it('leaves a body with no picture exactly as it is', async () => {
    const body = 'Plain *text* with a [link](../assets/notes.md) and\n\n    indented code\n\n***\n\n[ref]: https://example.com "Title"';
    expect((await exported(body, 'copy')).text).toBe(body);
  });

  it('percent-encodes the book\'s folder name in a destination, since a space or a bracket would end the picture there', async () => {
    const pack = await resolveFigures(figureSourcesOf(scene(`![x](${A})`)), hostOf(FILES).host, { ...copySpec({}), embed: true });
    const text = rewriteMarkdownImages(`![x](${A})\n\n![y][r]\n\n[r]: ${A}`, 'copy', 'The Lighthouse (draft).assets', pack, []);
    const folder = 'The%20Lighthouse%20%28draft%29.assets';
    expect(text).toBe(`![x](${folder}/${pngFile(ID_A)})\n\n![y][r]\n\n[r]: ${folder}/${pngFile(ID_A)}`);
    expect(decodeURIComponent(folder)).toBe('The Lighthouse (draft).assets');
  });

  it('leaves a link\'s definition as written in every mode, because only an image\'s definition is the export\'s to change', async () => {
    const body = ['A [link][ref] and ![Lamp][lamp].', '', '[ref]: https://example.com "Title"', `[lamp]: ${A} "A lamp"`].join('\n');
    for (const mode of ['copy', 'link', 'drop'] as const) {
      expect((await exported(body, mode)).text, mode).toContain('[ref]: https://example.com "Title"');
    }
  });

  it('reads a reference-style picture as a figure at the destination and title its definition gives', () => {
    const body = ['![Lamp][lamp]', '', `[lamp]: ${A} "A lamp"`].join('\n');
    expect(figureSourcesOf(scene(body))).toEqual([{ url: A, alt: 'Lamp', title: 'A lamp' }]);
  });

  it('copies each used asset once, however often it is placed, and no other file', async () => {
    const { pack } = await exported(PROSE, 'copy');
    expect(usedAssetFilesOf(scene(PROSE))).toEqual([pngFile(ID_A), pngFile(ID_B)]);
    expect(pack.images.map((image) => image.name)).toEqual([pngFile(ID_A), pngFile(ID_B)]);
  });

  it('writes no .. into a destination, in either spelling of an image', async () => {
    const body = [`![a](${A})`, `![b][ref]`, `[ref]: ${B} "Cap"`].join('\n\n');
    const { text } = await exported(body, 'copy');
    expect(text).not.toContain('..');
    const destinations = [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((match) => match[1]).concat([...text.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)].map((match) => match[1]));
    expect(destinations).toEqual([`${ASSETS_DIR}/${pngFile(ID_A)}`, `${ASSETS_DIR}/${pngFile(ID_B)}`]);
  });

  it('rewrites the definition of a reference-style image and leaves every use of it as written', async () => {
    const body = ['![Lamp][lamp] and ![lamp][] and ![lamp]', '', `[lamp]: ${A} "A lamp"`, '', 'After.'].join('\n');
    expect((await exported(body, 'copy')).text).toBe(
      ['![Lamp][lamp] and ![lamp][] and ![lamp]', '', `[lamp]: ${ASSETS_DIR}/${pngFile(ID_A)} "A lamp"`, '', 'After.'].join('\n'),
    );
  });

  it('drops the title when the decoded caption is empty, whatever the size hint or the decorative flag', async () => {
    const hinted = encodePlacementTitle({ caption: '', size: 'half', decorative: true }) ?? '';
    expect(hinted).not.toBe('');
    const { text } = await exported(`![x](${A} "${hinted}")`, 'copy');
    expect(text).toBe(`![x](${ASSETS_DIR}/${pngFile(ID_A)})`);
  });

  it('writes a caption with a quote or a backslash so it reads back the same', async () => {
    const title = encodePlacementTitle({ caption: 'She said "stop" \\ then left', size: 'half' }) ?? '';
    const { text } = await exported(`![x](${A} "${title.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}")`, 'copy');
    expect(text).toContain(`"She said \\"stop\\" \\\\ then left"`);
  });

  it('keeps a title with a suffix version this build cannot decode, byte for byte', async () => {
    const title = 'Cap [caotang-image v9;mystery]';
    const { text } = await exported(`![x](${A} "${title}")`, 'copy');
    expect(text).toBe(`![x](${ASSETS_DIR}/${pngFile(ID_A)} "${title}")`);
  });

  it('exports the alt text of a picture the project does not hold, and says so', async () => {
    const body = [`![Gone](${C} "Its caption")`, '![Remote](https://example.com/x.png)', `![](${C} "Only a caption")`].join('\n\n');
    const { text, notes } = await exported(body, 'copy');
    expect(text).toBe(['Gone', 'Remote', 'Only a caption'].join('\n\n'));
    expect(notes).toEqual([
      `${pngFile(ID_C)} is placed in the manuscript but its file is not in assets/, so its alt text is exported instead`,
      "a picture at https://example.com/x.png is not in the project's assets/, so its alt text is exported instead",
      `${pngFile(ID_C)} is placed in the manuscript but its file is not in assets/, so its alt text is exported instead`,
    ]);
  });

  it('is what the Markdown renderer writes for a scene, under the chapter heading, from the compile\'s resolved pack', async () => {
    const pack = await resolveFigures(figureSourcesOf(scene(PROSE)), hostOf(FILES).host, { ...copySpec({}), embed: true });
    const input: RenderInput = {
      blocks: [{ kind: 'chapter', title: 'One', level: 1, number: 1 }, ...scene(PROSE)],
      title: 'Book',
      author: '',
      date: '2026-10-08',
      template: DEFAULT_TEMPLATE,
      toc: false,
      pictures: 'copy',
      assetsDir: ASSETS_DIR,
      figures: pack,
    };
    const text = renderMarkdown(input);
    expect(text.startsWith('## 1. One\n\n# A *scene*')).toBe(true);
    expect(text).toContain(`![Harbour at dusk](${ASSETS_DIR}/${pngFile(ID_A)} "The harbour")`);
    expect(text).not.toContain('../assets/a_');
  });
});

describe('Markdown link: the project-relative references stay, and the log says what that risks', () => {
  it('keeps the destination, writes the decoded caption as the title and warns that moving the export breaks the pictures', async () => {
    const { text, notes } = await exported(PROSE, 'link');
    expect(text).toContain(`![Harbour at dusk](${A} "The harbour")`);
    expect(text).toContain(`Second ![inline picture](${B}) in a sentence.`);
    expect(text).not.toContain(ASSETS_DIR);
    expect(notes).toEqual(['markdown: the pictures are linked at their project-relative paths, so moving the exported file away from the project folder breaks them']);
  });

  it('keeps a reference-style definition at its project-relative destination', async () => {
    const body = ['![Lamp][lamp]', '', `[lamp]: ${A} "A lamp"`].join('\n');
    expect((await exported(body, 'link')).text).toBe(body);
  });
});

describe('Markdown drop: the text stays, the picture goes, and the log counts them', () => {
  it('replaces each construct with its alt text, or its caption when there is no alt', async () => {
    const body = [`Before ![Harbour](${A} "Cap") after.`, '', `![](${B} "Only a caption")`].join('\n');
    const { text } = await exported(body, 'drop');
    expect(text).toBe(['Before Harbour after.', '', 'Only a caption'].join('\n'));
  });

  it('removes the definition a dropped reference used, and keeps one nothing used', async () => {
    const body = ['![Lamp][lamp] here', '', `[lamp]: ${A} "A lamp"`, `[spare]: https://example.com`].join('\n');
    expect((await exported(body, 'drop')).text).toBe(['Lamp here', '', '', '[spare]: https://example.com'].join('\n'));
  });

  it('says how many pictures were left out, in the singular and the plural', async () => {
    const one = await exported(`![x](${A})`, 'drop');
    expect(one.notes).toEqual(['markdown: 1 picture was left out (the recipe’s pictures option is drop), with their alt or caption text in their place']);
    const two = await exported(`![x](${A})\n\n![y](${B})`, 'drop');
    expect(two.notes).toEqual(['markdown: 2 pictures were left out (the recipe’s pictures option is drop), with their alt or caption text in their place']);
    expect((await exported('No pictures here.', 'drop')).notes).toEqual([]);
  });

  it('copies no file', async () => {
    const { pack } = await exported(PROSE, 'drop');
    expect(pack.images).toEqual([]);
  });
});

describe('plain text: the placeholder line and the drop', () => {
  const BODY = ['Before.', '', `![Harbour](${A} "${harbourTitle}")`, '', `![Only alt](${B})`, '', 'After.'].join('\n');

  const input = (pictures: RenderInput['pictures']): RenderInput => ({
    blocks: scene(BODY),
    title: 'Book',
    author: '',
    date: '2026-10-08',
    template: DEFAULT_TEMPLATE,
    toc: false,
    ...(pictures === undefined ? {} : { pictures }),
  });

  it('writes [Picture: caption] for a picture, the caption being the decoded one and the alt text standing in without it', () => {
    expect(renderText(input('placeholder'))).toBe(['Before.', '', '[Picture: The harbour]', '', '[Picture: Only alt]', '', 'After.'].join('\n') + '\n');
  });

  it('writes the placeholder when the recipe names no mode', () => {
    expect(renderText(input(undefined))).toBe(renderText(input('placeholder')));
  });

  it('omits the picture, and its line, when the recipe drops pictures', () => {
    expect(renderText(input('drop'))).toBe(['Before.', '', 'After.'].join('\n') + '\n');
  });

  it('places the line inside a quote or a list item too', () => {
    const body = [`> ![Quoted](${A} "In a quote")`, '', `- ![Listed](${B} "In a list")`].join('\n');
    const text = renderText({ ...input('placeholder'), blocks: scene(body) });
    expect(text).toContain('[Picture: In a quote]');
    expect(text).toContain('- [Picture: In a list]');
  });
});
