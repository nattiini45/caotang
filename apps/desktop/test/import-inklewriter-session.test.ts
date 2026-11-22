/**
 * The reader session's Inklewriter reader (issue #286): the same dispatch the preview's Worker runs, exercised in Node.
 * The pure reader is covered in packages/import-inklewriter; this proves the Worker host opens and reads it, and refuses
 * bad input without throwing.
 */
import { describe, expect, it } from 'vitest';
import { createReaderSession } from '../src/import-preview/reader-session.js';

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const story = {
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
      open: { content: ['The door opens.', { image: 'https://example.com/door.png' }, { flagName: 'opened' }, { divert: 'end' }] },
      away: { content: ['You walk away.', { divert: 'end' }] },
      end: { content: ['The end.'] },
    },
    editorData: { playPoint: 'start', textSize: 1, authorName: 'A. Writer', libraryVisible: false },
  },
};

describe("the reader session's Inklewriter reader", () => {
  it('opens and reads a story into an Ink plan with its images', async () => {
    const session = createReaderSession();
    const opened = await session({ kind: 'open', reader: 'inklewriter', bytes: bytes(story) });
    expect(opened.kind).toBe('opened');
    const read = await session({ kind: 'read', reader: 'inklewriter', fileName: 'story.json' });
    expect(read.kind).toBe('inklewriter');
    if (read.kind !== 'inklewriter') return;
    expect(read.result.ok).toBe(true);
    if (!read.result.ok) return;
    expect(read.result.value.title).toBe('The Door');
    expect(read.result.value.plan.containers.length).toBeGreaterThan(0);
    expect(read.result.value.images).toEqual([{ url: 'https://example.com/door.png', stitch: 'open' }]);
  });

  it('refuses JSON that is not a story, without throwing', async () => {
    const session = createReaderSession();
    await session({ kind: 'open', reader: 'inklewriter', bytes: bytes({ hello: 'world' }) });
    const read = await session({ kind: 'read', reader: 'inklewriter' });
    expect(read.kind).toBe('inklewriter');
    if (read.kind !== 'inklewriter') return;
    expect(read.result.ok).toBe(false);
    if (!read.result.ok) expect(read.result.error.code).toBe('not-inklewriter');
  });

  it('refuses a read before the reader is opened', async () => {
    const session = createReaderSession();
    await expect(session({ kind: 'read', reader: 'inklewriter' })).rejects.toThrow();
  });
});
