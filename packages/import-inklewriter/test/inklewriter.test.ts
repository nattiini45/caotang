/**
 * The Inklewriter reader (issue #286), on synthetic story exports: the vendored converter runs, the Ink reaches the
 * shared planner, images are listed by URL, the editor data is named as a loss, and bad input is refused, never thrown.
 */
import { describe, expect, it } from 'vitest';
import { readInklewriter } from '../src/index.js';

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const editorData = { playPoint: 'start', textSize: 1, authorName: 'A. Writer', libraryVisible: false };

/** A story with choices, diverts, a stitch image and a flag. */
const door = {
  title: 'The Door',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  url_key: 'the-door',
  data: {
    allowCheckpoints: false,
    optionMirroring: true,
    initial: 'start',
    stitches: {
      start: {
        content: [
          'You stand before a door.',
          { option: 'Open it', linkPath: 'open', ifConditions: null, notIfConditions: null },
          { option: 'Walk away', linkPath: 'away', ifConditions: null, notIfConditions: null },
        ],
      },
      open: {
        content: ['The door opens onto a hall.', { image: 'https://example.com/door.png' }, { flagName: 'opened' }, { divert: 'end' }],
      },
      away: { content: ['You walk away.', { divert: 'end' }] },
      end: { content: ['The end.'] },
    },
    editorData,
  },
};

describe('readInklewriter', () => {
  it('reads a story into an Ink plan with choices and diverts intact', () => {
    const result = readInklewriter(bytes(door));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { plan, ink, title } = result.value;
    expect(title).toBe('The Door');
    expect(ink).toContain('# title: The Door');
    expect(ink).toContain('# author: A. Writer');
    expect(ink).toContain('-> ');
    expect(plan.containers.length).toBeGreaterThan(0);
    expect(plan.containers[0]?.body).toContain('You stand before a door.');
    expect(plan.entryDiverts.length).toBeGreaterThan(0);
  });

  it('keeps a flag as a VAR and lists the stitch image by URL', () => {
    const result = readInklewriter(bytes(door));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ink).toContain('VAR opened = false');
    expect(result.value.ink).toContain('# IMAGE: https://example.com/door.png');
    expect(result.value.images).toEqual([{ url: 'https://example.com/door.png', stitch: 'open' }]);
    expect(result.value.notices.join(' ')).toMatch(/1 image/);
  });

  it('names the editor data as a loss, never dropping it silently', () => {
    const result = readInklewriter(bytes(door));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.losses.join(' ')).toMatch(/editor data/i);
  });

  it('reads conditions and flags into conditional Ink', () => {
    const conditional = {
      title: 'The Flag',
      created_at: '',
      updated_at: '',
      url_key: 'the-flag',
      data: {
        allowCheckpoints: false,
        optionMirroring: true,
        initial: 'start',
        stitches: {
          start: { content: ['Start.', { flagName: 'ready' }, { divert: 'gate' }] },
          gate: { content: [{ ifCondition: 'ready' }, 'You may pass.', { divert: 'end' }] },
          end: { content: ['Done.'] },
        },
        editorData,
      },
    };
    const result = readInklewriter(bytes(conditional));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ink).toContain('VAR ready = false');
    expect(result.value.ink).toContain('{ ready:');
    expect(result.value.images).toEqual([]);
  });

  it('falls back to the file name, then Untitled, for an empty title', () => {
    const untitled = { ...door, title: '' };
    const named = readInklewriter(bytes(untitled), 'my-story.json');
    expect(named.ok).toBe(true);
    if (named.ok) expect(named.value.title).toBe('my-story');
    const bare = readInklewriter(bytes(untitled));
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.value.title).toBe('Untitled');
  });

  it('refuses input that is not JSON', () => {
    const result = readInklewriter(new TextEncoder().encode('this is not json'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-json');
  });

  it('refuses JSON that is not an Inklewriter story', () => {
    const result = readInklewriter(bytes({ hello: 'world' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-inklewriter');
  });

  it('refuses a story the converter cannot convert, without throwing', () => {
    // A stitch with both a choice and a divert is impossible in inklewriter; the converter throws on it.
    const bad = {
      title: 'Bad',
      created_at: '',
      updated_at: '',
      url_key: 'bad',
      data: {
        allowCheckpoints: false,
        optionMirroring: true,
        initial: 's',
        stitches: {
          s: { content: ['x', { option: 'o', linkPath: 's', ifConditions: null, notIfConditions: null }, { divert: 's' }] },
        },
        editorData,
      },
    };
    const result = readInklewriter(bytes(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('convert-failed');
  });
});
