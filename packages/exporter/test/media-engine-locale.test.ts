/**
 * A dialogue container's engine target and locale in the two dialogue exports (dialogue-narrative.md §2.1, §4, §6).
 *
 * The dialogue table: a `yarn-csv` container's rows go to a Yarn Spinner strings file, and every other container's rows go to
 * the dialogue table, which carries a `locale` column after §6's five. The Ink story: the compiled JSON is inkjs's own, and a
 * container that sets its own locale puts it in the file name. These call `renderMedia` directly with a request.
 */
import { describe, expect, it } from 'vitest';

import { addDocument, nodeById, type ProjectState } from '@caotang/store';

import { renderMedia, type MediaRequest } from '../src/index.js';
import { inkJsonFileName } from '../src/media.js';
import { MEDIA_IDS, OPENED, makeMediaProject } from './media-fixture.js';

const ANNA = 'c_ANNA000001';

function requestFor(state: ProjectState, format: MediaRequest['format'], extra: Partial<MediaRequest> = {}): MediaRequest {
  return {
    state,
    format,
    includeRootIds: ['manuscript'],
    title: 'The Lighthouse Keeper',
    author: '',
    date: '2026-10-02',
    titlePage: false,
    base: 'Lighthouse',
    assets: new Map(),
    ...extra,
  };
}

/** The fixture project with the innkeeper container's settings set to `dialogue`. */
function withSettings(dialogue: Record<string, unknown>, state: ProjectState = makeMediaProject()): ProjectState {
  const container = nodeById(state, MEDIA_IDS.innkeeper);
  if (container === undefined) throw new Error('the fixture has no innkeeper container');
  container.dialogue = dialogue;
  return state;
}

/** A second dialogue container after the innkeeper, in the same folder, with its own ids. */
function addCellar(state: ProjectState, dialogue: Record<string, unknown>): void {
  const cellar = addDocument(state, {
    parentId: MEDIA_IDS.tavern,
    title: 'The cellar',
    body: ['=== cellar ===', 'Mara: It is cold down here. # lineId: l_0000000201', '-> END'].join('\n'),
    now: OPENED,
    id: 'n_CELLAR0001',
  });
  Object.assign(cellar, { type: 'dialogue', kind: 'branching', dialogue });
}

function linesOf(text: string | undefined): string[] {
  return (text ?? '').split('\r\n').filter((line) => line !== '');
}

describe('dialogue table: the locale column', () => {
  it('writes the project language as the locale of a container that sets none', () => {
    const output = renderMedia(requestFor(makeMediaProject(), 'dialogue-csv'));
    const lines = linesOf(output.files[0]?.text);
    expect(lines[0]).toBe('lineId,speaker,text,context,charLimit,locale');
    expect(lines.slice(1).every((line) => line.endsWith(',en'))).toBe(true);
  });

  it('writes the container’s own locale when it sets one', () => {
    const output = renderMedia(requestFor(withSettings({ locBaseline: 'de-DE' }), 'dialogue-csv', { charLimit: 42 }));
    const lines = linesOf(output.files[0]?.text);
    expect(lines).toContain('l_0000000001,,The innkeeper looks up.,start,42,de-DE');
  });

  it('writes each container’s locale on its own rows, in one table', () => {
    const state = withSettings({ locBaseline: 'fr' });
    addCellar(state, { engineTarget: 'generic-csv' });
    const output = renderMedia(requestFor(state, 'dialogue-csv'));
    expect(output.files.map((file) => file.name)).toEqual(['Lighthouse (dialogue).csv']);
    const lines = linesOf(output.files[0]?.text);
    expect(lines).toContain('l_0000000005,,"Ale arrives, foaming.",ale,,fr');
    expect(lines).toContain('l_0000000201,Mara,It is cold down here.,cellar,,en');
  });

  it('leaves the locale empty, and says so, when neither the container nor the project has one', () => {
    const state = makeMediaProject();
    delete state.manifest.project.language;
    const output = renderMedia(requestFor(state, 'dialogue-csv'));
    expect(linesOf(output.files[0]?.text)).toContain('l_0000000001,,The innkeeper looks up.,start,,');
    expect(output.notes).toContain('a container has no locale and the project has no language, so its rows have an empty locale');
  });
});

describe('dialogue table: the engine target picks the file', () => {
  it('keeps the dialogue table for the generic-csv target, the ink-json target and no target', () => {
    for (const dialogue of [{}, { engineTarget: 'generic-csv' }, { engineTarget: 'ink-json' }]) {
      const output = renderMedia(requestFor(withSettings(dialogue), 'dialogue-csv'));
      expect(output.files.map((file) => file.name)).toEqual(['Lighthouse (dialogue).csv']);
      expect(linesOf(output.files[0]?.text)[0]).toBe('lineId,speaker,text,context,charLimit,locale');
    }
  });

  it('notes a container whose target is the Ink story, and still writes its lines to the table', () => {
    const output = renderMedia(requestFor(withSettings({ engineTarget: 'ink-json' }), 'dialogue-csv'));
    expect(output.notes).toContain(
      '"The innkeeper": its engine target is Ink, compiled to JSON; its lines are in the dialogue table, as this compile asks',
    );
  });

  it('writes a yarn-csv container as a Yarn Spinner strings file', () => {
    const output = renderMedia(requestFor(withSettings({ engineTarget: 'yarn-csv', locBaseline: 'en-GB' }), 'dialogue-csv'));
    expect(output.files.map((file) => file.name)).toEqual(['Lighthouse (dialogue, Yarn).csv']);
    expect(output.files[0]?.mimeType).toBe('text/csv;charset=utf-8');
    expect(linesOf(output.files[0]?.text)).toEqual([
      'language,id,text,file,node,lineNumber,lock,comment',
      'en-GB,line:l_0000000001,The innkeeper looks up.,The innkeeper,start,2,daae1dc5,start',
      'en-GB,line:l_0000000002,"Innkeeper: Ah, a traveller. What\'ll it be?",The innkeeper,start,3,44cf300e,start',
      'en-GB,line:l_0000000003_c,Order an ale,The innkeeper,start,4,94133bcd,start',
      'en-GB,line:l_0000000004_c,Leave quietly,The innkeeper,start,5,87cbc5ee,start',
      'en-GB,line:l_0000000005,"Ale arrives, foaming.",The innkeeper,ale,7,bbbc8cad,ale',
    ]);
    expect(output.blockCount).toBe(5);
  });

  it('puts the default speaker’s codex name before a Yarn line with no Name: prefix', () => {
    const state = withSettings({ engineTarget: 'yarn-csv', speaker: ANNA });
    state.manifest.codex = [
      {
        id: ANNA,
        name: 'Anna',
        aliases: [],
        type: 'character',
        description: '',
        includePolicy: 'detected',
        caseSensitive: false,
        exclude: [],
        attachments: [],
        keywords: [],
        origin: 'manual',
        sources: [],
        createdAt: 'Fri 2026-10-02 5:00 PM CEST (UTC+02:00)',
        updatedAt: 'Fri 2026-10-02 5:00 PM CEST (UTC+02:00)',
      },
    ];
    const lines = linesOf(renderMedia(requestFor(state, 'dialogue-csv')).files[0]?.text);
    expect(lines).toContain('en,line:l_0000000001,Anna: The innkeeper looks up.,The innkeeper,start,2,7eaade17,start / Anna');
    // A choice label is an option, so it carries no speaker.
    expect(lines).toContain('en,line:l_0000000003_c,Order an ale,The innkeeper,start,4,94133bcd,start / Anna');
  });

  it('guards the Yarn text cells as the table guards its own', () => {
    const state = makeMediaProject({ innkeeper: ['=== start ===', '=1+1 # lineId: l_0000000301', '-> END'].join('\n') });
    withSettings({ engineTarget: 'yarn-csv' }, state);
    const lines = linesOf(renderMedia(requestFor(state, 'dialogue-csv')).files[0]?.text);
    expect(lines[1]).toBe("en,line:l_0000000301,'=1+1,The innkeeper,start,2,bac90eef,start");
  });

  it('guards a hand-edited locale in both files, from the container and from the project language', () => {
    // readDialogueMeta and the manifest loader accept any non-empty string, so a hand edit can put a formula here.
    const state = withSettings({ engineTarget: 'yarn-csv', locBaseline: '=HYPERLINK("x")' });
    addCellar(state, {});
    state.manifest.project.language = '@SUM(1)';
    const output = renderMedia(requestFor(state, 'dialogue-csv'));
    const table = linesOf(output.files[0]?.text);
    const yarn = linesOf(output.files[1]?.text);
    expect(table[1]).toBe("l_0000000201,Mara,It is cold down here.,cellar,,'@SUM(1)");
    expect(yarn[1]).toBe(`"'=HYPERLINK(""x"")",line:l_0000000001,The innkeeper looks up.,The innkeeper,start,2,daae1dc5,start`);
  });

  it('writes both files when the selection mixes a Yarn container and a table container', () => {
    const state = withSettings({ engineTarget: 'yarn-csv' });
    addCellar(state, {});
    const output = renderMedia(requestFor(state, 'dialogue-csv'));
    expect(output.files.map((file) => file.name)).toEqual(['Lighthouse (dialogue).csv', 'Lighthouse (dialogue, Yarn).csv']);
    const table = linesOf(output.files[0]?.text);
    const yarn = linesOf(output.files[1]?.text);
    expect(table).toEqual(['lineId,speaker,text,context,charLimit,locale', 'l_0000000201,Mara,It is cold down here.,cellar,,en']);
    expect(yarn).toHaveLength(6);
    expect(yarn.every((line, i) => i === 0 || line.includes('The innkeeper'))).toBe(true);
    expect(output.blockCount).toBe(6);
  });

  it('says the character limit is not in the Yarn file, which has no column for it', () => {
    const output = renderMedia(requestFor(withSettings({ engineTarget: 'yarn-csv' }), 'dialogue-csv', { charLimit: 42 }));
    expect(output.files[0]?.text).not.toContain('42');
    expect(output.notes).toContain('the Yarn strings file has no character limit column, so the limit is not in it');
  });

  it('still refuses a Yarn container with an unkeyed line, as the table does', () => {
    const state = makeMediaProject({ innkeeper: ['=== start ===', 'No id here.', '-> END'].join('\n') });
    withSettings({ engineTarget: 'yarn-csv' }, state);
    expect(() => renderMedia(requestFor(state, 'dialogue-csv'))).toThrow(/"The innkeeper" line 2 has no line id/);
  });
});

describe('Ink story: the engine target and the locale', () => {
  it('names the file by the container’s own locale, and leaves the compiled JSON as inkjs wrote it', () => {
    const plain = renderMedia(requestFor(makeMediaProject(), 'ink-json'));
    const localised = renderMedia(requestFor(withSettings({ locBaseline: 'de' }), 'ink-json'));
    expect(plain.files.map((file) => file.name)).toEqual(['The innkeeper.ink.json']);
    expect(localised.files.map((file) => file.name)).toEqual(['The innkeeper.de.ink.json']);
    expect(localised.files[0]?.text).toBe(plain.files[0]?.text);
  });

  it('keeps the plain name when only the project has a language', () => {
    expect(inkJsonFileName('The innkeeper', undefined)).toBe('The innkeeper.ink.json');
    expect(inkJsonFileName('The innkeeper', '  ')).toBe('The innkeeper.ink.json');
    expect(inkJsonFileName('The innkeeper', 'zh-Hans')).toBe('The innkeeper.zh-Hans.ink.json');
  });

  it('keeps two containers with one title and one locale apart', () => {
    const state = withSettings({ locBaseline: 'de' });
    addCellar(state, { locBaseline: 'de' });
    const cellar = nodeById(state, 'n_CELLAR0001');
    if (cellar === undefined) throw new Error('no cellar');
    cellar.title = 'The innkeeper';
    const output = renderMedia(requestFor(state, 'ink-json'));
    expect(output.files.map((file) => file.name)).toEqual(['The innkeeper.de.ink.json', 'The innkeeper.de.ink-2.json']);
  });

  it('compiles a container whose target is a table, and says the recipe chose the Ink story', () => {
    for (const [target, words] of [
      ['yarn-csv', 'the Yarn string table'],
      ['generic-csv', 'a CSV table for any engine'],
    ] as const) {
      const output = renderMedia(requestFor(withSettings({ engineTarget: target }), 'ink-json'));
      expect(output.files).toHaveLength(1);
      expect(output.notes).toContain(`"The innkeeper": its engine target is ${words}; this compile writes the Ink story, as it was asked to`);
    }
  });

  it('says nothing about a container whose target is the Ink story', () => {
    const output = renderMedia(requestFor(withSettings({ engineTarget: 'ink-json' }), 'ink-json'));
    expect(output.notes.some((note) => note.includes('engine target'))).toBe(false);
  });
});
