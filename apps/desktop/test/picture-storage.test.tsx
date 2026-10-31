/**
 * The picture board's storage actions (pictures.md §6.3, §6.4 step 3, §6.5, §6.6.1): the bulk *Store working copies*, *Sweep unused
 * files…* and *Re-link N renamed pictures*, and the board's one thumbnail size. The suite runs in Node, which has no canvas and no
 * DOM, so the steps run against a stand-in session and the dialogs are read from their rendered markup.
 */
import { crc32, deflateSync } from 'node:zlib';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandError, ExecutionOutcome, Result } from '@caotang/bus';
import type { PictureBytes } from '@caotang/pictures';
import { createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';

import { explain } from '../src/components/actions.js';
import type { Report, StatusMessage } from '../src/components/shared.js';
import { activateEnglish } from '../src/i18n/runtime.js';
import { isUsableThumbnail, makeThumbnail, THUMB_EDGE } from '../src/app/picture-thumbs.js';
import { RelinkConfirm, RelinkNotice, SweepConfirm, WorkingCopyConfirm, beginSweep, confirmRelink, confirmSweep, confirmWorkingCopies } from '../src/media/PictureStorage.js';
import { entriesOf } from '../src/media/picture-board-model.js';
import {
  relinkLabel,
  relinkLinesOf,
  sweepReport,
  workingCopyChoiceOf,
  workingCopyLabel,
} from '../src/media/picture-storage-model.js';

const NOW = new Date('2026-10-09T09:00:00.000Z');

beforeEach(() => activateEnglish());

function markup(node: ReactNode): string {
  return renderToStaticMarkup(<I18nProvider i18n={i18n}>{node}</I18nProvider>);
}

/** The visible words of a markup string, without the isolate marks writer text carries. */
function words(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/[\u2066-\u2069]/g, '').replace(/\s+/g, ' ');
}

/* ------------------------------------------------------------------ *
 * Stand-ins
 * ------------------------------------------------------------------ */

function recorder(): { readonly report: Report; readonly said: StatusMessage[] } {
  const said: StatusMessage[] = [];
  return { said, report: (message) => said.push(message) };
}

function ok(result: unknown = {}): Result<ExecutionOutcome, CommandError> {
  return { ok: true, value: { result } as ExecutionOutcome };
}

function refused(message: string, correctiveHint?: string): Result<ExecutionOutcome, CommandError> {
  return { ok: false, error: { code: 'io-error', message, ...(correctiveHint === undefined ? {} : { correctiveHint }) } as CommandError };
}

const id = (word: string): string => `a_${word.padEnd(10, '0').slice(0, 10)}`;

function projectWith(records: readonly Record<string, unknown>[]): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW, { uuid: () => '3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d', locale: 'en-US' }));
  (state.manifest as unknown as { assets: unknown }).assets = records.map((record) => ({
    mime: 'image/png',
    sha256: 'f'.repeat(64),
    bytes: 1000,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...record,
  }));
  return state;
}

function record(word: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: id(word), file: `${id(word)}.png`, width: 6000, height: 4000, ...extra };
}

/* ------------------------------------------------------------------ *
 * Store working copies
 * ------------------------------------------------------------------ */

describe('Store working copies on the board', () => {
  const state = projectWith([
    record('BIG', { caption: 'The harbour' }),
    record('HUGE', { width: 9000, height: 3000, caption: 'The chart' }),
    record('SMALL', { width: 1200, height: 800 }),
    record('COPY', { workingCopy: { fromBytes: 9_000_000, fromWidth: 8000, fromHeight: 6000 } }),
    record('GONE'),
  ]);
  const entries = entriesOf(state, new Set([id('BIG'), id('HUGE'), id('SMALL'), id('COPY')]));
  const chosen = new Set(entries.map((entry) => entry.id));

  it('names the action with the number of pictures it would change', () => {
    expect(workingCopyLabel(3)).toBe('Store working copies (3)');
  });

  it('offers it only for selected pictures longer than 4096 px that have a file and are not working copies already', () => {
    const choice = workingCopyChoiceOf(entries, chosen);
    expect(choice.ids).toEqual([id('BIG'), id('HUGE')]);
    expect(choice.leftOut).toContain('1 is not larger than 4096 px.');
    expect(choice.leftOut).toContain('1 is already a working copy.');
    expect(choice.leftOut).toContain('1 has no file to copy.');
    expect(workingCopyChoiceOf(entries, new Set([id('SMALL')])).ids).toEqual([]);
  });

  it('runs one asset.storeWorkingCopies over the confirmed pictures and says so', async () => {
    const storeWorkingCopies = vi.fn(async () => ok({ assetIds: ['a_NEW0000001', 'a_NEW0000002'] }));
    const { report, said } = recorder();
    const landed = await confirmWorkingCopies({ storeWorkingCopies }, report, [id('BIG'), id('HUGE')]);
    expect(landed).toBe(true);
    expect(storeWorkingCopies).toHaveBeenCalledTimes(1);
    expect(storeWorkingCopies).toHaveBeenCalledWith([id('BIG'), id('HUGE')]);
    expect(said).toEqual([{ text: 'Stored 2 working copies. Undo puts the originals back.', tone: 'info' }]);
  });

  it("shows a host's refusal in the command's own sentence", async () => {
    const error = refused('this host cannot make 4096 px working copies, so nothing was changed', 'open the project in the app to store working copies');
    const { report, said } = recorder();
    const landed = await confirmWorkingCopies({ storeWorkingCopies: async () => error }, report, [id('BIG')]);
    expect(landed).toBe(false);
    expect(said).toEqual([{ text: explain((error as { error: CommandError }).error), tone: 'error' }]);
    expect(said[0]?.text).toBe('this host cannot make 4096 px working copies, so nothing was changed. open the project in the app to store working copies.');
  });

  it('asks first, in the confirm button’s own count, and says the originals stay', () => {
    const html = words(markup(<WorkingCopyConfirm ids={[id('BIG'), id('HUGE')]} confirmLabel={workingCopyLabel(2)} onConfirm={() => undefined} onCancel={() => undefined} />));
    expect(html).toContain('Store 4096 px working copies of these 2 pictures?');
    expect(html).toContain('Store working copies (2)');
    expect(html).toContain('The originals stay in the project, and Undo puts everything back.');
  });
});

/* ------------------------------------------------------------------ *
 * Sweep unused files
 * ------------------------------------------------------------------ */

describe('Sweep unused files', () => {
  const candidates = [
    { file: `${id('STRAY')}.png`, path: `assets/${id('STRAY')}.png`, assetId: id('STRAY') },
    { file: `${id('LEFT')}.jpg`, path: `assets/${id('LEFT')}.jpg`, assetId: id('LEFT') },
  ];

  it('previews the exact files and removes nothing before the writer confirms', async () => {
    const previewPictureSweep = vi.fn(async () => ({ ok: true as const, candidates }));
    const { report, said } = recorder();
    expect(await beginSweep({ previewPictureSweep }, report)).toEqual(candidates);
    expect(said).toEqual([]);

    const html = words(markup(<SweepConfirm candidates={candidates} onConfirm={() => undefined} onCancel={() => undefined} />));
    expect(html).toContain('Remove 2 unused files?');
    expect(html).toContain(`${id('STRAY')}.png`);
    expect(html).toContain(`${id('LEFT')}.jpg`);
    expect(html).toContain('Removing them cannot be undone.');
    expect(html).toContain('Remove the files');
  });

  it('a confirmed sweep calls asset.sweep once and reports the files it removed', async () => {
    const sweepPictures = vi.fn(async () => ok({ candidates: 2, removed: candidates.map((c) => c.path), remaining: [] }));
    const { report, said } = recorder();
    await confirmSweep({ sweepPictures }, report);
    expect(sweepPictures).toHaveBeenCalledTimes(1);
    expect(said).toEqual([{ text: 'Removed 2 unused files.', tone: 'info' }]);
  });

  it('says there is nothing to remove, and offers no confirmation, when no file is a candidate', async () => {
    const { report, said } = recorder();
    expect(await beginSweep({ previewPictureSweep: async () => ({ ok: true as const, candidates: [] }) }, report)).toBeNull();
    expect(said).toHaveLength(1);
    expect(said[0]?.tone).toBe('info');
    expect(said[0]?.text).toContain('No unused picture file was found.');
  });

  it('shows a refused preview with the store’s sentence and never offers the confirmation', async () => {
    const reason = 'a retention root could not be read, so nothing is known to be unreferenced: the pending journal could not list what it retains (Unexpected token)';
    const { report, said } = recorder();
    expect(await beginSweep({ previewPictureSweep: async () => ({ ok: false as const, reason }) }, report)).toBeNull();
    expect(said).toEqual([{ text: `Unused files cannot be listed safely, so none was removed: ${reason}`, tone: 'error' }]);
  });

  it('shows a refused sweep in the command’s own sentence, naming the root', async () => {
    const error = refused(
      'the sweep was refused, so no file was removed: the editor history journals could not list what it retains (the journal could not be read)',
      'make the named root readable, then sweep again',
    );
    const { report, said } = recorder();
    await confirmSweep({ sweepPictures: async () => error }, report);
    expect(said).toEqual([{ text: explain((error as { error: CommandError }).error), tone: 'error' }]);
    expect(said[0]?.text).toBe(
      'the sweep was refused, so no file was removed: the editor history journals could not list what it retains (the journal could not be read). make the named root readable, then sweep again.',
    );
  });

  it('reports an interrupted sweep with the files removed and the files still there', () => {
    const said = sweepReport(ok({ candidates: 3, removed: [candidates[0]?.path], remaining: [candidates[1]?.path, 'assets/a_THIRD00000.png'], interrupted: 'the folder went away' }));
    expect(said.tone).toBe('error');
    expect(said.text).toBe('The sweep stopped early (the folder went away). 1 file was removed, and 2 files are still there.');
  });

  it('reports files that could not be removed without calling the sweep clean', () => {
    const said = sweepReport(ok({ candidates: 2, removed: [candidates[0]?.path], remaining: [candidates[1]?.path] }));
    expect(said).toEqual({ text: '1 unused file was removed, and 1 file could not be removed and is still there.', tone: 'error' });
  });
});

/* ------------------------------------------------------------------ *
 * Re-link
 * ------------------------------------------------------------------ */

describe('Re-link renamed pictures', () => {
  const state = projectWith([record('OLD1', { caption: 'The harbour' }), record('OLD2')]);
  const pairs = [
    { assetId: id('OLD1'), file: `${id('NEW1')}.png` },
    { assetId: id('OLD2'), file: `${id('NEW2')}.png` },
  ];

  it('counts the pictures in the notice and in the button, as one notice and not a dialog', () => {
    const html = words(markup(<RelinkNotice pairs={pairs} busy={false} onOffer={() => undefined} />));
    expect(relinkLabel(2)).toBe('Re-link 2 renamed pictures');
    expect(relinkLabel(1)).toBe('Re-link 1 renamed picture');
    expect(html).toContain('Re-link 2 renamed pictures');
    expect(html).not.toContain('<dialog');
  });

  it('lists each picture with the file it recorded and the file its bytes were found under', () => {
    expect(relinkLinesOf(state, pairs).map((line) => [line.name, line.from, line.to])).toEqual([
      ['The harbour', `${id('OLD1')}.png`, `${id('NEW1')}.png`],
      [`${id('OLD2')}.png`, `${id('OLD2')}.png`, `${id('NEW2')}.png`],
    ]);
    const html = words(markup(<RelinkConfirm state={state} pairs={pairs} onConfirm={() => undefined} onCancel={() => undefined} />));
    expect(html).toContain(`The harbour: ${id('OLD1')}.png is now ${id('NEW1')}.png`);
    expect(html).toContain('Nothing is matched by name.');
  });

  it('a confirm runs asset.relink once over every pair', async () => {
    const relinkPictures = vi.fn(async () => ok({ pairs }));
    const { report, said } = recorder();
    expect(await confirmRelink({ relinkPictures }, report, pairs)).toBe(true);
    expect(relinkPictures).toHaveBeenCalledTimes(1);
    expect(relinkPictures).toHaveBeenCalledWith(pairs);
    expect(said).toEqual([{ text: 'Re-linked 2 renamed pictures. Undo points them back at the old names.', tone: 'info' }]);
  });
});

/* ------------------------------------------------------------------ *
 * Thumbnails
 * ------------------------------------------------------------------ */

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A small grey PNG whose every sample is `sample`, so 255 is a genuinely white picture. */
function png(sample: number, edge = 4): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, edge);
  view.setUint32(4, edge);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const rows = new Uint8Array(edge * (1 + edge)).fill(sample);
  for (let row = 0; row < edge; row += 1) rows[row * (1 + edge)] = 0;
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe('the board’s thumbnail', () => {
  const input: PictureBytes = { bytes: png(0x40), mime: 'image/png', width: 6000, height: 4000 };
  const edgeOf = (call: unknown[]): number => (call[1] as { maxEdge: number }).maxEdge;

  it('is one size, made once when it works', async () => {
    const out: PictureBytes = { bytes: png(0x80), mime: 'image/png', width: 4, height: 4 };
    const process = vi.fn(async () => out);
    expect(await makeThumbnail(process, input)).toEqual(out.bytes);
    expect(process).toHaveBeenCalledTimes(1);
    expect(edgeOf(process.mock.calls[0] as unknown[])).toBe(THUMB_EDGE);
  });

  it('is made again once at half the size when the first attempt fails', async () => {
    const out: PictureBytes = { bytes: png(0x80), mime: 'image/png', width: 4, height: 4 };
    const process = vi.fn().mockRejectedValueOnce(new Error('canvas gone')).mockResolvedValueOnce(out);
    expect(await makeThumbnail(process, input)).toEqual(out.bytes);
    expect(process.mock.calls.map((call) => edgeOf(call as unknown[]))).toEqual([THUMB_EDGE, THUMB_EDGE / 2]);
  });

  it('is made again once at half the size when the first output is empty', async () => {
    const out: PictureBytes = { bytes: png(0x80), mime: 'image/png', width: 4, height: 4 };
    const process = vi.fn().mockResolvedValueOnce({ ...out, bytes: new Uint8Array(0) }).mockResolvedValueOnce(out);
    await makeThumbnail(process, input);
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry, so the tile shows its placeholder', async () => {
    const process = vi.fn(async () => {
      throw new Error('canvas gone');
    });
    await expect(makeThumbnail(process, input)).rejects.toThrow();
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('keeps a genuinely white picture: being one colour is not a failed decode', () => {
    expect(isUsableThumbnail(png(255))).toBe(true);
    expect(isUsableThumbnail(new Uint8Array(0))).toBe(false);
    expect(isUsableThumbnail(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
