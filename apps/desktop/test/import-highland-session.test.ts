/**
 * The reader session's Highland reader (issue #284): the same dispatch the preview's Worker runs, exercised in Node.
 * The pure reader is covered in packages/import-highland; this proves the Worker host opens and reads a `.highland`
 * package, rides its assets along, and refuses a package with no script without throwing.
 */
import { describe, expect, it } from 'vitest';
import { createReaderSession } from '../src/import-preview/reader-session.js';
import { textZip } from '../../../packages/import-read/test/zip-fixtures.js';

const story = textZip({
  'text.fountain': 'Title: The Landing\nCredit: A. Writer\n\nINT. HARBOUR - DAY\n\nMara watches the ferry.\n\nEXT. ROCKS - NIGHT\n\nThe lamp turns.',
  'info.json': JSON.stringify({ title: 'The Landing', author: 'A. Writer' }),
  'assets/harbour.png': 'fake-picture-bytes',
  'bin/trashed.fountain': 'INT. DELETED - DAY',
});

describe("the reader session's Highland reader", () => {
  it('opens and reads a package into a Fountain import with its assets and losses', async () => {
    const session = createReaderSession();
    const opened = await session({ kind: 'open', reader: 'highland', bytes: story });
    expect(opened.kind).toBe('opened');
    const read = await session({ kind: 'read', reader: 'highland', fileName: 'story.highland' });
    expect(read.kind).toBe('highland');
    if (read.kind !== 'highland') return;
    expect(read.result.ok).toBe(true);
    if (!read.result.ok) return;
    expect(read.result.value.title).toBe('The Landing');
    expect(read.result.value.fountainText).toContain('INT. HARBOUR - DAY');
    expect(read.result.value.assets.map((asset) => asset.path)).toEqual(['assets/harbour.png']);
    expect(read.result.value.losses.some((loss) => loss.startsWith('bin/'))).toBe(true);
  });

  it('refuses a package with no script, without throwing', async () => {
    const session = createReaderSession();
    await session({ kind: 'open', reader: 'highland', bytes: textZip({ 'info.json': '{}' }) });
    const read = await session({ kind: 'read', reader: 'highland' });
    expect(read.kind).toBe('highland');
    if (read.kind !== 'highland') return;
    expect(read.result.ok).toBe(false);
    if (!read.result.ok) expect(read.result.error.code).toBe('no-script');
  });

  it('refuses a read before the reader is opened', async () => {
    const session = createReaderSession();
    await expect(session({ kind: 'read', reader: 'highland' })).rejects.toThrow();
  });
});
