/**
 * The Inklewriter preview source (issue #286): what the writer is told before anything is written. The planner's own notes
 * (which knot the story starts at, and any line it could not read) and every name the reader had to change reach the Notes
 * list, in English and in German, and the images are listed as addresses the import does not download. The reader itself is
 * covered in packages/import-inklewriter; this runs it through the same session the preview's Worker runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pinFormatLocale } from '../src/i18n/locale.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';
import { NO_OVERRIDES, initialSettings } from '../src/import-preview/model.js';
import { inklewriterPreviewSource } from '../src/import-preview/inklewriter-source.js';
import { createReaderSession } from '../src/import-preview/reader-session.js';
import type { ReaderOpen, ReaderRead } from '../src/import-preview/reader-protocol.js';

/** An in-process stand-in for the preview's `'self'` Worker, running the same reader session the real Worker runs. */
class InProcessWorker {
  private readonly handle = createReaderSession();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  constructor(_url: unknown, _options?: unknown) {}
  postMessage(message: { id: number } & (ReaderOpen | ReaderRead)): void {
    void this.handle(message).then(
      (result) => this.onmessage?.({ data: { id: message.id, ok: true, result } }),
      (error: unknown) => this.onmessage?.({ data: { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) } }),
    );
  }
  terminate(): void {}
}

beforeEach(() => {
  activateEnglish();
  pinFormatLocale('en-US');
  vi.stubGlobal('Worker', InProcessWorker);
});
afterEach(() => {
  activateEnglish();
  pinFormatLocale(undefined);
  vi.unstubAllGlobals();
});

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const editorData = { playPoint: 'start', textSize: 1, authorName: 'A. Writer', libraryVisible: false };

/** Two sections, so the planner reports the entry divert that is not a container. */
const twoSections = {
  title: 'The Door',
  data: {
    initial: 'start',
    stitches: {
      start: { content: [{ pageLabel: 'The Hall' }, 'You stand before a door.', { divert: 'end' }] },
      end: { content: [{ pageLabel: 'The End' }, 'The end.'] },
    },
    editorData,
  },
};

/** One section whose label, and one flag, are written in characters the converter's name rule drops. */
const unicodeNames = {
  title: '第一章',
  data: {
    initial: 'start',
    stitches: {
      start: { content: [{ pageLabel: '第一章' }, 'You stand before a door.', { flagName: '开关' }, { divert: 'end' }] },
      end: { content: ['The end.'] },
    },
    editorData,
  },
};

const withImage = {
  title: 'Pictured',
  data: {
    initial: 'start',
    stitches: { start: { content: ['A door.', { image: 'https://example.com/door.png' }] } },
    editorData,
  },
};

async function opened(story: unknown, fileName = 'story.json') {
  const written: { containers: number; addIds: boolean }[] = [];
  const source = inklewriterPreviewSource({
    fileName,
    bytes: bytes(story),
    write: async (containers, addIds) => {
      written.push({ containers: containers.length, addIds });
      return { ok: true };
    },
  });
  await source.load?.(() => {}, new AbortController().signal);
  const settings = initialSettings(source.chips(), source.options());
  const plan = source.plan(settings, NO_OVERRIDES);
  return { source, plan, settings, written };
}

const notesOf = (lists: readonly { heading: string; lines: readonly string[] }[]): readonly string[] =>
  lists.find((list) => list.heading === 'Notes')?.lines ?? [];

describe('the Inklewriter preview report', () => {
  it('tells the writer which knot the story starts at, since that entry is not a container', async () => {
    const { source, plan } = await opened(twoSections);
    const notes = notesOf(source.report?.(plan) ?? []);
    expect(notes.join('\n')).toContain('The story starts at the top of the body');
    expect(notes.join('\n')).toContain('recreate it in the project');
  });

  it('names every section and flag the reader had to rename, with both names', async () => {
    const { source, plan } = await opened(unicodeNames);
    const notes = notesOf(source.report?.(plan) ?? []).join('\n');
    expect(notes).toContain('The section “第一章”');
    expect(notes).toContain('“section_1”');
    expect(notes).toContain('The variable “开关”');
    expect(notes).toContain('“flag_1”');
  });

  it('says the same in German', async () => {
    await activateCatalogue('de');
    const { source, plan } = await opened(unicodeNames);
    // The heading is translated too, so the list is taken by position: this story has no images, so Notes is the only one.
    const lists = source.report?.(plan) ?? [];
    expect(lists).toHaveLength(1);
    const notes = (lists[0]?.lines ?? []).join('\n');
    expect(notes).not.toContain('The section');
    expect(notes).toContain('第一章');
    expect(notes).toContain('section_1');
    expect(notes).toContain('开关');
    expect(notes).toContain('flag_1');
  });

  it('lists the images by address and never claims to download them', async () => {
    const { source, plan } = await opened(withImage);
    const lists = source.report?.(plan) ?? [];
    const images = lists.find((list) => list.heading === 'Images');
    expect(images?.label).toBe('Images, listed by address; the import does not download them');
    expect(images?.lines.join('\n')).toContain('https://example.com/door.png');
    expect(JSON.stringify(lists)).not.toMatch(/opt-in|downloads them if|will download/i);
  });

  it('reports nothing but the loss when the story needs no note', async () => {
    const { plan } = await opened(withImage);
    expect(plan.losses.map((loss) => loss.message).join(' ')).toMatch(/editor data/i);
    expect(plan.tree.every((node) => node.role === 'container')).toBe(true);
  });

  it('commits the containers it showed, with the line-id choice the writer made', async () => {
    const { source, plan, settings, written } = await opened(twoSections);
    expect(plan.counts.scenes).toBeGreaterThan(0);
    await source.commit?.(plan, settings);
    expect(written).toEqual([{ containers: plan.counts.scenes, addIds: false }]);
    const withIds = { ...settings, options: { ...settings.options, 'line-ids': true } };
    source.plan(withIds, NO_OVERRIDES);
    await source.commit?.(plan, withIds);
    expect(written[1]).toEqual({ containers: plan.counts.scenes, addIds: true });
  });
});

describe('a story the reader refuses', () => {
  it('fails the load with the reason, so the dialog shows it instead of importing undefined', async () => {
    const empty = { title: 'Empty', data: { initial: 'start', stitches: {}, editorData } };
    await expect(opened(empty)).rejects.toThrow(/no stitches/i);
  });
});
