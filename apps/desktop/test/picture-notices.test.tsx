/**
 * The picture-aware eviction banner and the monthly bundle reminder (pictures.md §6.6), and the sweep offered before *Export bundle*
 * (§6.5): when each is due, what the writer's answer keeps and for how long, the words, and that a sweep that cannot be checked never
 * holds a backup back. The suite runs in Node, so the notices' rules are read as functions and the dialog from its markup.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppDb } from '../src/app/app-db.js';
import {
  BUNDLE_REMINDER_FIRST_BYTES,
  BUNDLE_REMINDER_PERIOD_MS,
  afterBundleReminded,
  afterBundleReminderOff,
  afterEvictionDismissed,
  bundleReminderDue,
  bundleReminderText,
  evictionNoticeDue,
  evictionPicturesText,
  evictionVariantApplies,
  forgetPictureNotices,
  isSafariBrowser,
  pictureNoticesKey,
  readPictureNotices,
  resetHeldPictureNotices,
  writePictureNotices,
  type EvictionFacts,
} from '../src/app/picture-notices.js';
import { activateEnglish } from '../src/i18n/runtime.js';
import { ExportSweepOffer, sweepBeforeExport, sweepOfferBeforeExport } from '../src/media/PictureStorage.js';

const MIB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1';

beforeEach(() => {
  activateEnglish();
  resetHeldPictureNotices();
});

function markup(node: ReactNode): string {
  return renderToStaticMarkup(<I18nProvider i18n={i18n}>{node}</I18nProvider>);
}

const words = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function facts(extra: Partial<EvictionFacts> = {}): EvictionFacts {
  return { persisted: false, folderAttached: false, pictureCount: 3, pictureBytes: 20 * MIB, ...extra };
}

function memoryDb(): AppDb & { readonly rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    get: async <T,>(key: string) => rows.get(key) as T | undefined,
    put: async (key, value) => void rows.set(key, value),
    list: async () => [],
    delete: async (key) => void rows.delete(key),
    close: () => undefined,
  };
}

describe('the picture-aware eviction banner', () => {
  it('replaces the general banner only when the browser has not kept the storage, no folder is attached and the project has pictures', () => {
    expect(evictionVariantApplies(facts())).toBe(true);
    expect(evictionVariantApplies(facts({ persisted: true }))).toBe(false);
    expect(evictionVariantApplies(facts({ persisted: null }))).toBe(false);
    expect(evictionVariantApplies(facts({ folderAttached: true }))).toBe(false);
    expect(evictionVariantApplies(facts({ pictureCount: 0, pictureBytes: 0 }))).toBe(false);
  });

  it('is due until it is dismissed, then stays away until the pictures weigh twice what they did', () => {
    expect(evictionNoticeDue(facts(), {})).toBe(true);
    const dismissed = afterEvictionDismissed({}, 20 * MIB);
    expect(dismissed).toEqual({ evictionDismissedAtBytes: 20 * MIB });
    expect(evictionNoticeDue(facts({ pictureBytes: 20 * MIB }), dismissed)).toBe(false);
    expect(evictionNoticeDue(facts({ pictureBytes: 40 * MIB - 1 }), dismissed)).toBe(false);
    expect(evictionNoticeDue(facts({ pictureBytes: 40 * MIB }), dismissed)).toBe(true);
    // Once the writer gets a promise from the browser, or attaches a folder, it never shows.
    expect(evictionNoticeDue(facts({ pictureBytes: 80 * MIB, persisted: true }), dismissed)).toBe(false);
    expect(evictionNoticeDue(facts({ pictureBytes: 80 * MIB, folderAttached: true }), dismissed)).toBe(false);
  });

  it('says the spec’s sentence to a Safari writer and only what the browser reported to anyone else', () => {
    expect(isSafariBrowser(SAFARI)).toBe(true);
    expect(isSafariBrowser(CHROME)).toBe(false);
    expect(isSafariBrowser(IOS_CHROME)).toBe(false);
    expect(evictionPicturesText(SAFARI)).toBe(
      'Pictures are stored only in this browser. Safari deletes site data after 7 days without a visit. Attach a folder, install Caotang to your Home Screen, or export a bundle.',
    );
    const other = evictionPicturesText(CHROME);
    expect(other).toBe('Pictures are stored only in this browser, and the browser has not promised to keep them. Attach a folder or export a bundle.');
    expect(other).not.toContain('Safari');
    expect(other).not.toContain('7 days');
  });
});

describe('the bundle reminder', () => {
  const base = { folderAccess: false, now: Date.parse('2026-10-09T09:00:00.000Z') };

  it('waits for the first 50 MB of pictures, and is only for a browser that cannot save to a folder', () => {
    expect(bundleReminderDue({ ...base, pictureBytes: BUNDLE_REMINDER_FIRST_BYTES - 1 }, {})).toBe(false);
    expect(bundleReminderDue({ ...base, pictureBytes: BUNDLE_REMINDER_FIRST_BYTES }, {})).toBe(true);
    expect(bundleReminderDue({ ...base, folderAccess: true, pictureBytes: 400 * MIB }, {})).toBe(false);
  });

  it('is quiet for a month after it is dismissed or answered by an export, then returns', () => {
    const answered = afterBundleReminded({}, base.now);
    const big = { ...base, pictureBytes: 60 * MIB };
    expect(bundleReminderDue({ ...big, now: base.now + 1 }, answered)).toBe(false);
    expect(bundleReminderDue({ ...big, now: base.now + BUNDLE_REMINDER_PERIOD_MS - 1 }, answered)).toBe(false);
    expect(bundleReminderDue({ ...big, now: base.now + BUNDLE_REMINDER_PERIOD_MS }, answered)).toBe(true);
    expect(BUNDLE_REMINDER_PERIOD_MS).toBe(30 * DAY);
  });

  it('is off for good with one click, and leaves the eviction answer alone', () => {
    const record = afterBundleReminderOff(afterEvictionDismissed({}, 20 * MIB));
    expect(record).toEqual({ evictionDismissedAtBytes: 20 * MIB, bundleReminderOff: true });
    expect(bundleReminderDue({ ...base, pictureBytes: 900 * MIB, now: base.now + 400 * DAY }, record)).toBe(false);
  });

  it('names what the pictures weigh and that a bundle does not depend on the browser', () => {
    expect(bundleReminderText(64 * MIB)).toBe(
      'This project’s pictures take about 64.0 MB, and this browser cannot save to a folder. Export a bundle for a copy of them that does not depend on the browser.',
    );
  });
});

describe('what the writer answered is kept per project, in the app database only', () => {
  it('round-trips through the database under the project’s own key, and never reads a malformed record as an answer', async () => {
    const db = memoryDb();
    const record = afterBundleReminded(afterEvictionDismissed({}, 20 * MIB), 1_000);
    await writePictureNotices('p_ONE', record, db);
    expect(db.rows.get(pictureNoticesKey('p_ONE'))).toEqual(record);
    expect(await readPictureNotices('p_ONE', db)).toEqual(record);
    expect(await readPictureNotices('p_TWO', db)).toEqual({});

    db.rows.set(pictureNoticesKey('p_BAD'), { evictionDismissedAtBytes: -5, bundleRemindedAt: 'yesterday', bundleReminderOff: 'yes' });
    expect(await readPictureNotices('p_BAD', db)).toEqual({});
  });

  it('holds the answer for this page when there is no database or the write fails', async () => {
    await writePictureNotices('p_ONE', { bundleReminderOff: true }, null);
    expect(await readPictureNotices('p_ONE', null)).toEqual({ bundleReminderOff: true });

    const failing = { ...memoryDb(), put: async () => Promise.reject(new Error('quota')), get: async () => Promise.reject(new Error('gone')) } as unknown as AppDb;
    await writePictureNotices('p_TWO', { evictionDismissedAtBytes: 5 }, failing);
    expect(await readPictureNotices('p_TWO', failing)).toEqual({ evictionDismissedAtBytes: 5 });
  });

  it('is forgotten when the project is removed', async () => {
    const db = memoryDb();
    await writePictureNotices('p_ONE', { bundleReminderOff: true }, db);
    await forgetPictureNotices('p_ONE', db);
    expect(await readPictureNotices('p_ONE', db)).toEqual({});
  });
});

describe('the sweep offered before Export bundle', () => {
  const candidates = [
    { file: 'a_UNUSED0001.png', path: 'assets/a_UNUSED0001.png' },
    { file: 'a_UNUSED0002.png', path: 'assets/a_UNUSED0002.png' },
  ];

  it('offers the exact candidates when the preview found some', async () => {
    const previewPictureSweep = vi.fn(async () => ({ ok: true as const, candidates }));
    expect(await sweepOfferBeforeExport({ previewPictureSweep } as never)).toEqual(candidates);
  });

  it('offers nothing, and lets the export go ahead, when there is nothing to remove, the roots cannot be read, or the preview fails', async () => {
    expect(await sweepOfferBeforeExport({ previewPictureSweep: async () => ({ ok: true as const, candidates: [] }) } as never)).toBeNull();
    expect(await sweepOfferBeforeExport({ previewPictureSweep: async () => ({ ok: false as const, reason: 'the checkpoints could not be read' }) } as never)).toBeNull();
    expect(
      await sweepOfferBeforeExport({
        previewPictureSweep: async () => {
          throw new Error('listing failed');
        },
      } as never),
    ).toBeNull();
  });

  it('lets the export follow a sweep that landed, and holds it after one that was refused or stopped part-way', async () => {
    const ok = (result: unknown) => ({ ok: true as const, value: { result } });
    expect(await sweepBeforeExport({ sweepPictures: async () => ok({ candidates: 2, removed: ['a', 'b'], remaining: [] }) } as never)).toEqual({ text: 'Removed 2 unused files.', proceed: true });
    const partial = await sweepBeforeExport({ sweepPictures: async () => ok({ candidates: 2, removed: ['a'], remaining: ['b'], interrupted: 'disk' }) } as never);
    expect(partial.proceed).toBe(false);
    expect(partial.text).toContain('The sweep stopped early');
    const refused = await sweepBeforeExport({ sweepPictures: async () => ({ ok: false as const, error: { code: 'io-error', message: 'the checkpoints could not be read, so no file was removed' } }) } as never);
    expect(refused.proceed).toBe(false);
    expect(refused.text).toContain('the checkpoints could not be read');
  });

  it('asks with the files in front of the writer: export without removing, remove then export, or cancel', () => {
    const html = markup(<ExportSweepOffer candidates={candidates} onSweepThenExport={() => undefined} onExport={() => undefined} onCancel={() => undefined} />);
    const text = words(html);
    expect(text).toContain('Remove 2 unused files before exporting?');
    expect(text).toContain('a_UNUSED0001.png');
    expect(text).toContain('a_UNUSED0002.png');
    expect(text).toContain('Removing them cannot be undone');
    expect(text).toContain('Export without removing');
    expect(text).toContain('Remove them, then export');
    expect(text).toContain('Cancel');
  });
});
