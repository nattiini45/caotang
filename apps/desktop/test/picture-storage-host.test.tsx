/**
 * What the app adds under the store's sweep (pictures.md §6.6.1): Settings › Data's picture meter, the roots only the app can read
 * (the checkpoints, the pending and unsent journals, the editor-history journals, the session's registered roots), and the removal that
 * reaches every place a picture is held. A root that cannot be read refuses the sweep; none counts as empty.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { createUndoStore } from '@caotang/bus';
import {
  MemoryIndexedDb,
  PICTURE_STORAGE_BUDGET_BYTES,
  UndoRetentionLedger,
  collectRetention,
  createEmptyManifest,
  createProjectState,
  idsRetentionRoot,
  openRuntimeStore,
  pictureStorageReport,
  refusingRetentionRoot,
  writeBodySnapshot,
  type ProjectState,
} from '@caotang/store';

import type { AppDb, HistoryRecord } from '../src/app/app-db.js';
import { hostRetentionRoots, type HostRetentionParts } from '../src/app/picture-retention-host.js';
import { ProjectAssets } from '../src/app/project-assets.js';
import { pendingKey } from '../src/app/pending-journal.js';
import type { UnsentStorage } from '../src/app/unsent-copy.js';
import { PictureStorageMeter } from '../src/components/PictureStorageMeter.js';
import { activateEnglish } from '../src/i18n/runtime.js';

const NOW = new Date('2026-10-09T09:00:00.000Z');
const MIB = 1024 * 1024;
const PROJECT = 'p_STORAGEHOST';
const id = (word: string): string => `a_${word.padEnd(10, '0').slice(0, 10)}`;

beforeEach(() => activateEnglish());

function words(node: ReactNode): string {
  return renderToStaticMarkup(<I18nProvider i18n={i18n}>{node}</I18nProvider>)
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ');
}

function stateWithBytes(sizes: readonly number[]): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW, { uuid: () => '3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d', locale: 'en-US' }));
  (state.manifest as unknown as { assets: unknown }).assets = sizes.map((bytes, index) => ({
    id: id(`P${index}`),
    file: `${id(`P${index}`)}.png`,
    mime: 'image/png',
    sha256: 'f'.repeat(64),
    bytes,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  }));
  return state;
}

describe('the picture meter in Settings › Data', () => {
  it('shows the count, the total and the 500 MB soft budget, with no warning while under it', () => {
    const text = words(<PictureStorageMeter report={pictureStorageReport(stateWithBytes([10 * MIB, 5 * MIB]))} durability={{ persisted: true, usage: null, quota: null }} />);
    expect(text).toContain('Pictures');
    expect(text).toContain('2 pictures');
    expect(text).toContain('15.0 MB');
    expect(text).toContain('500.0 MB for this project');
    expect(text).not.toContain('over the');
    expect(text).not.toContain('has not promised');
  });

  it('warns, without refusing, when the pictures pass the budget', () => {
    const report = pictureStorageReport(stateWithBytes([PICTURE_STORAGE_BUDGET_BYTES, 3 * MIB]));
    expect(report.overBudget).toBe(true);
    const text = words(<PictureStorageMeter report={report} durability={null} />);
    expect(text).toContain('These pictures take 503.0 MB, which is over the 500.0 MB the project is meant to hold. Nothing is refused.');
  });

  it('says what the browser reported about keeping them, and no more', () => {
    const report = pictureStorageReport(stateWithBytes([MIB]));
    expect(words(<PictureStorageMeter report={report} durability={{ persisted: false, usage: null, quota: null }} />)).toContain('This browser has not promised to keep these pictures.');
    expect(words(<PictureStorageMeter report={report} durability={{ persisted: null, usage: null, quota: null }} />)).not.toContain('has not promised');
  });
});

/* ------------------------------------------------------------------ *
 * The roots only the app reads
 * ------------------------------------------------------------------ */

function memoryStorage(values: Record<string, string>): UnsentStorage {
  return {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
    removeItem: (key) => {
      delete values[key];
    },
    key: (index) => Object.keys(values)[index] ?? null,
    get length() {
      return Object.keys(values).length;
    },
  };
}

function historyDb(journals: Record<string, { docId: string; journal: unknown }>, failRead = false): AppDb {
  const rows = new Map<string, HistoryRecord>(
    Object.entries(journals).map(([docId, row]) => [`${PROJECT}:${docId}`, { key: `${PROJECT}:${docId}`, projectId: PROJECT, docId, updatedAt: 1, journal: row.journal }]),
  );
  return {
    history: {
      get: async (key: string) => {
        if (failRead) throw new Error('the database would not open');
        return rows.get(key);
      },
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => [...rows.values()].map(({ key, projectId, docId, updatedAt }) => ({ key, projectId, docId, updatedAt })),
    },
  } as unknown as AppDb;
}

async function parts(overrides: Partial<HostRetentionParts> = {}): Promise<HostRetentionParts> {
  return {
    projectId: PROJECT,
    store: await openRuntimeStore(new MemoryIndexedDb() as unknown as IDBFactory),
    undo: () => createUndoStore(),
    ledger: new UndoRetentionLedger(),
    storage: memoryStorage({}),
    appDb: () => null,
    ...overrides,
  };
}

describe('the retention roots the app reads', () => {
  it('reads nothing as empty only where there is truly nothing: no journals, no checkpoints, an empty session', async () => {
    const snapshot = await collectRetention(hostRetentionRoots(await parts()));
    expect(snapshot.authoritative).toBe(true);
    expect([...snapshot.ids]).toEqual([]);
  });

  it('keeps a picture named only by a checkpoint body', async () => {
    const given = await parts();
    await writeBodySnapshot(given.store, { projectId: PROJECT, docId: 'n_SCENE00001', revision: 1, body: `Before.\n\n![](../assets/${id('CHECK')}.png)\n`, capturedAt: 1, command: 'doc.write' });
    const snapshot = await collectRetention(hostRetentionRoots(given));
    expect(snapshot.authoritative).toBe(true);
    expect(snapshot.ids.has(id('CHECK'))).toBe(true);
  });

  it('keeps a picture named only by the pending journal or the words kept from a stopped tab', async () => {
    const storage = memoryStorage({
      [pendingKey(PROJECT)]: JSON.stringify([{ docId: 'n_SCENE00001', body: `Typed ![](../assets/${id('PEND')}.png)`, baseRevision: 3, at: '2026-10-09T09:00:00.000Z' }]),
      [`caotang.unsent.${PROJECT}`]: JSON.stringify([{ stopId: 's1', documents: [{ docId: 'n_SCENE00002', body: `![](../assets/${id('XNSENT')}.jpg)` }] }]),
    });
    const snapshot = await collectRetention(hostRetentionRoots(await parts({ storage })));
    expect(snapshot.authoritative).toBe(true);
    expect([...snapshot.ids].sort()).toEqual([id('PEND'), id('XNSENT')].sort());
  });

  it('keeps a picture named only by an editor-history journal, whatever shape the journal has', async () => {
    const appDb = historyDb({ n_SCENE00001: { docId: 'n_SCENE00001', journal: { base: `![](../assets/${id('HSTRY')}.webp)`, steps: [{ unknown: 'a shape this build does not know' }] } } });
    const snapshot = await collectRetention(hostRetentionRoots(await parts({ appDb: () => appDb })));
    expect(snapshot.authoritative).toBe(true);
    expect(snapshot.ids.has(id('HSTRY'))).toBe(true);
  });

  it('refuses, naming the root, when a stored journal cannot be read', async () => {
    const corrupt = await collectRetention(hostRetentionRoots(await parts({ storage: memoryStorage({ [pendingKey(PROJECT)]: '{not json' }) })));
    expect(corrupt.authoritative).toBe(false);
    expect(corrupt.reasons.join(' ')).toContain('the pending journal');

    const unreadable = await collectRetention(hostRetentionRoots(await parts({ appDb: () => historyDb({ n_SCENE00001: { docId: 'n_SCENE00001', journal: {} } }, true) })));
    expect(unreadable.authoritative).toBe(false);
    expect(unreadable.reasons.join(' ')).toContain('the editor history journals');
  });

  it('refuses when a root the session registered cannot list, and keeps what a registered root names', async () => {
    const refuses = await collectRetention(hostRetentionRoots(await parts(), () => [refusingRetentionRoot('the agent’s drafts', 'a draft could not be written out')]));
    expect(refuses.authoritative).toBe(false);
    expect(refuses.reasons.join(' ')).toContain('the agent’s drafts');

    const names = await collectRetention(hostRetentionRoots(await parts(), () => [idsRetentionRoot('the agent’s drafts', [[id('DRAFT'), ['a drafted scene']]])]));
    expect(names.authoritative).toBe(true);
    expect(names.ids.has(id('DRAFT'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The removal
 * ------------------------------------------------------------------ */

describe('removing swept files', () => {
  async function bound(): Promise<ProjectAssets> {
    const assets = new ProjectAssets();
    await assets.persistFor(PROJECT, new MemoryIndexedDb() as unknown as IDBFactory);
    return assets;
  }

  it('removes a file from the page and the browser’s copy, with its thumbnail, and leaves the others', async () => {
    const assets = await bound();
    const gone = `assets/${id('GNE')}.png`;
    const kept = `assets/${id('KEPT')}.png`;
    await assets.writeBytes(gone, new Uint8Array([1, 2, 3]));
    await assets.writeBytes(kept, new Uint8Array([4, 5, 6]));
    await assets.writeThumb(gone, 256, new Uint8Array([9]));
    expect(await assets.readThumb(gone, 256)).toEqual(new Uint8Array([9]));

    expect(await assets.removeFiles([gone])).toEqual([gone]);
    expect(await assets.readBytes(gone)).toBeNull();
    expect(await assets.readThumb(gone, 256)).toBeUndefined();
    expect(await assets.readBytes(kept)).toEqual(new Uint8Array([4, 5, 6]));
    expect(await assets.listPaths()).toEqual([kept]);
  });

  it('does not say it removed a file it never held, and refuses a path outside assets/', async () => {
    const assets = await bound();
    expect(await assets.removeFiles([`assets/${id('NEVER')}.png`])).toEqual([]);
    await expect(assets.removeFiles(['docs/n_SCENE00001.md'])).rejects.toThrow(/not a file directly inside/);
  });

  it('keeps a thumbnail only in the browser’s copy: it is not an asset path, so no listing, bundle or folder sees it', async () => {
    const assets = await bound();
    const path = `assets/${id('THUMB')}.png`;
    await assets.writeBytes(path, new Uint8Array([1]));
    await assets.writeThumb(path, 256, new Uint8Array([2]));
    expect(await assets.listPaths()).toEqual([path]);
    expect(Object.keys(await assets.snapshot())).toEqual([path]);
  });
});
