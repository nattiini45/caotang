/**
 * The script and dialogue compile's own rules, below the exporter's recipe path: the dialogue table's character limit
 * reaching `exportCsv` (dialogue-narrative.md §4), a container's default speaker and the notes its settings raise, and a
 * section's synopsis carried into the Fountain file (screenplay.md §2.2, §5.1).
 *
 * These call `renderMedia` directly with a request, so they test the media compile itself. No recipe option names a limit yet
 * (apps/desktop/src/media/README.md, "What is not wired"), so a limit reaches the table through the request only.
 */
import { describe, expect, it } from 'vitest';

import { MediaRefusedError, renderMedia, type MediaRequest } from '../src/index.js';
import { MEDIA_IDS, makeMediaProject } from './media-fixture.js';
import { nodeById, type ProjectState } from '@caotang/store';

const ANNA = 'c_ANNA000001';

/** A codex character the container's default speaker can name. */
function withAnna(state: ProjectState): ProjectState {
  state.manifest.codex = [
    {
      id: ANNA,
      name: 'Anna',
      aliases: [],
      type: 'character',
      description: 'The innkeeper.',
      includePolicy: 'detected',
      caseSensitive: false,
      exclude: [],
      attachments: [],
      keywords: [],
      origin: 'manual',
      sources: [],
      createdAt: '2026-10-02T15:00:00.000Z',
      updatedAt: '2026-10-02T15:00:00.000Z',
    },
  ];
  return state;
}

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

function csvLines(state: ProjectState, extra: Partial<MediaRequest> = {}): string[] {
  const output = renderMedia(requestFor(state, 'dialogue-csv', extra));
  return (output.files[0]?.text ?? '').split('\r\n').filter((line) => line !== '');
}

describe('dialogue-csv: the character limit reaches the table', () => {
  it('fills the charLimit column of every row with the limit the request names', () => {
    const lines = csvLines(makeMediaProject(), { charLimit: 42 });
    expect(lines[0]).toBe('lineId,speaker,text,context,charLimit,locale');
    const rows = lines.slice(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.endsWith(',42,en'))).toBe(true);
  });

  it('leaves the column empty when no limit is named, which is unconstrained', () => {
    const rows = csvLines(makeMediaProject()).slice(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.endsWith(',,en'))).toBe(true);
  });

  it('refuses a limit that is not a whole number above zero, and names it', () => {
    for (const bad of [0, -3, 1.5]) {
      expect(() => renderMedia(requestFor(makeMediaProject(), 'dialogue-csv', { charLimit: bad }))).toThrow(MediaRefusedError);
    }
    expect(() => renderMedia(requestFor(makeMediaProject(), 'dialogue-csv', { charLimit: 0 }))).toThrow(
      'whole number above zero, got 0',
    );
  });
});

describe('dialogue-csv: a container\'s own settings', () => {
  it('names the default speaker on a line that has no Name: prefix', () => {
    const state = withAnna(makeMediaProject());
    const container = nodeById(state, MEDIA_IDS.innkeeper);
    if (container === undefined) throw new Error('the fixture has no innkeeper container');
    container.dialogue = { speaker: ANNA };
    const lines = csvLines(state);
    // The first line has no prefix, so the speaker column carries the container's default speaker (its codex id), and the
    // context names the display name the codex gives it (dialogue-narrative.md §6: context = path + speaker name).
    expect(lines).toContain('l_0000000001,c_ANNA000001,The innkeeper looks up.,start / Anna,,en');
    // A line with its own prefix keeps the speaker it names.
    expect(lines.some((row) => row.startsWith('l_0000000002,Innkeeper,'))).toBe(true);
  });

  it('reports a setting it cannot use in the compile notes, and still writes the table', () => {
    const state = makeMediaProject();
    const container = nodeById(state, MEDIA_IDS.innkeeper);
    if (container === undefined) throw new Error('the fixture has no innkeeper container');
    container.dialogue = { engineTarget: 'twine', autoLineIds: 'yes' };
    const output = renderMedia(requestFor(state, 'dialogue-csv'));
    expect(output.files[0]?.text).toContain('l_0000000001');
    expect(output.notes).toEqual(
      expect.arrayContaining([
        '"The innkeeper": engineTarget "twine" is not a known target and was ignored',
        '"The innkeeper": autoLineIds must be true or false; it was ignored and defaults to false',
      ]),
    );
  });
});

describe('fountain: a section\'s synopsis is written under its heading', () => {
  it('writes the folder\'s synopsis as the = line under its # line, before its first scene', () => {
    const state = makeMediaProject();
    const script = nodeById(state, MEDIA_IDS.script);
    if (script === undefined) throw new Error('the fixture has no script folder');
    script.synopsis = 'The first night.';
    const output = renderMedia(requestFor(state, 'fountain'));
    expect(output.files[0]?.text).toContain('# Script\n= The first night.\n\nINT. KITCHEN - DAY');
  });

  it('writes a folder with no synopsis exactly as the heading it always had', () => {
    const output = renderMedia(requestFor(makeMediaProject(), 'fountain'));
    expect(output.files[0]?.text).toContain('# Script\n\nINT. KITCHEN - DAY');
  });
});
