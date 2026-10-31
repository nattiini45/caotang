/**
 * The two notices that keep a writer's pictures from being lost with a browser's site data (pictures.md §6.6): the picture-aware
 * eviction banner, and the bundle reminder for browsers that cannot save to a folder.
 *
 * What the writer has dismissed is browser-side state, like the folder a project remembers (folder-memory.ts): it lives in the app
 * database under the project's id, never in a project, a bundle, an export or a command, and no agent can read it. Every call is
 * best effort. Without a database the choice is held for this page only, and a failed write leaves the notice to be asked again,
 * which is the safe side.
 */

import { t } from '@lingui/core/macro';

import { activeAppDb, type AppDb } from './app-db.js';
import { formatBytes } from './storage.js';

/* lingui-set comment="The picture notices. size is a formatted amount of storage." */

/** §6.6: "Export a bundle" is offered after the first 50 MB of pictures. */
export const BUNDLE_REMINDER_FIRST_BYTES = 50 * 1024 * 1024;

/** §6.6: and monthly after that. A month is thirty days here: the reminder is a nudge, not a calendar. */
export const BUNDLE_REMINDER_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/** What the writer has answered, per project. Every field is absent until the writer has answered. */
export interface PictureNoticeRecord {
  /** The bytes of pictures the project held when the eviction banner was dismissed; it returns once they double. */
  readonly evictionDismissedAtBytes?: number;
  /** When the bundle reminder was last dismissed or answered by an export (milliseconds since the epoch). */
  readonly bundleRemindedAt?: number;
  /** The writer turned the bundle reminder off for this project. */
  readonly bundleReminderOff?: boolean;
}

export function pictureNoticesKey(projectId: string): string {
  return `picture-notices:${projectId}`;
}

/** Held for this page when there is no database, so a dismissal still lasts until the tab reloads. */
const held = new Map<string, PictureNoticeRecord>();

function recordOf(value: unknown): PictureNoticeRecord {
  if (typeof value !== 'object' || value === null) return {};
  const raw = value as Record<string, unknown>;
  const at = raw['evictionDismissedAtBytes'];
  const reminded = raw['bundleRemindedAt'];
  return {
    ...(typeof at === 'number' && Number.isFinite(at) && at >= 0 ? { evictionDismissedAtBytes: at } : {}),
    ...(typeof reminded === 'number' && Number.isFinite(reminded) && reminded >= 0 ? { bundleRemindedAt: reminded } : {}),
    ...(raw['bundleReminderOff'] === true ? { bundleReminderOff: true } : {}),
  };
}

export async function readPictureNotices(projectId: string, db: AppDb | null = activeAppDb()): Promise<PictureNoticeRecord> {
  const memory = held.get(projectId);
  if (db === null) return memory ?? {};
  try {
    return recordOf(await db.get<unknown>(pictureNoticesKey(projectId)));
  } catch {
    return memory ?? {};
  }
}

/** Keeps what the writer answered. A failure is swallowed: the notice would simply be asked again. */
export async function writePictureNotices(projectId: string, record: PictureNoticeRecord, db: AppDb | null = activeAppDb()): Promise<void> {
  held.set(projectId, record);
  if (db === null) return;
  try {
    await db.put(pictureNoticesKey(projectId), record);
  } catch {
    // The answer holds until the page reloads.
  }
}

/** Forgets the answers as the project leaves this browser. The database keeps one value per key, so the record is emptied. */
export async function forgetPictureNotices(projectId: string, db: AppDb | null = activeAppDb()): Promise<void> {
  held.delete(projectId);
  if (db === null) return;
  try {
    await db.put(pictureNoticesKey(projectId), null);
  } catch {
    // A record that stays belongs to a project id nothing reuses.
  }
}

/** For tests: forgets what this page held. */
export function resetHeldPictureNotices(): void {
  held.clear();
}

/* ------------------------------------------------------------------ *
 * When each notice is due
 * ------------------------------------------------------------------ */

export interface EvictionFacts {
  /** `navigator.storage.persisted()`: only `false` is an answer that the browser has not promised to keep the pictures. */
  readonly persisted: boolean | null;
  /** A project folder is attached, so the pictures are written beside the manuscript. */
  readonly folderAttached: boolean;
  readonly pictureCount: number;
  readonly pictureBytes: number;
}

/**
 * Whether the picture-aware eviction banner stands in for the general one: the browser has not promised to keep this project's
 * storage, no folder is attached, and the project has pictures. Dismissing it is for the project, until its pictures weigh twice as
 * much as they did then.
 */
export function evictionVariantApplies(facts: EvictionFacts): boolean {
  return facts.persisted === false && !facts.folderAttached && facts.pictureCount > 0;
}

export function evictionNoticeDue(facts: EvictionFacts, record: PictureNoticeRecord): boolean {
  if (!evictionVariantApplies(facts)) return false;
  const at = record.evictionDismissedAtBytes;
  return at === undefined || facts.pictureBytes >= at * 2;
}

export interface BundleReminderFacts {
  /** The browser can save to a folder; the reminder is for the ones that cannot (§6.6). */
  readonly folderAccess: boolean;
  readonly pictureBytes: number;
  readonly now: number;
}

/** Due after the first 50 MB of pictures and then once a month, unless the writer turned it off. */
export function bundleReminderDue(facts: BundleReminderFacts, record: PictureNoticeRecord): boolean {
  if (facts.folderAccess || record.bundleReminderOff === true) return false;
  if (facts.pictureBytes < BUNDLE_REMINDER_FIRST_BYTES) return false;
  const last = record.bundleRemindedAt;
  return last === undefined || facts.now - last >= BUNDLE_REMINDER_PERIOD_MS;
}

/** The record after the writer dismisses the eviction banner with the pictures at `pictureBytes`. */
export function afterEvictionDismissed(record: PictureNoticeRecord, pictureBytes: number): PictureNoticeRecord {
  return { ...record, evictionDismissedAtBytes: pictureBytes };
}

/** The record after the reminder is dismissed, or answered by an export: it is quiet for a month. */
export function afterBundleReminded(record: PictureNoticeRecord, now: number): PictureNoticeRecord {
  return { ...record, bundleRemindedAt: now };
}

export function afterBundleReminderOff(record: PictureNoticeRecord): PictureNoticeRecord {
  return { ...record, bundleReminderOff: true };
}

/* ------------------------------------------------------------------ *
 * The words
 * ------------------------------------------------------------------ */

/**
 * Whether this is Safari, the one browser whose seven-day rule the spec names. Chromium-based and Firefox browsers put their own
 * token in the user agent beside `Safari/`, so the token alone is not taken for Safari.
 */
export function isSafariBrowser(userAgent: string): boolean {
  return /\bSafari\//.test(userAgent) && !/\b(Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg|OPR|Android)\b/.test(userAgent);
}

/**
 * The eviction banner's sentence for pictures (pictures.md §6.6). The seven-day rule and the Home Screen are Safari's, so they are
 * said only to a Safari writer; anywhere else the banner says what the browser itself reported and what the writer can do.
 */
export function evictionPicturesText(userAgent: string): string {
  if (isSafariBrowser(userAgent)) {
    return t`Pictures are stored only in this browser. Safari deletes site data after 7 days without a visit. Attach a folder, install Caotang to your Home Screen, or export a bundle.`;
  }
  return t`Pictures are stored only in this browser, and the browser has not promised to keep them. Attach a folder or export a bundle.`;
}

/** The bundle reminder's sentence: what the pictures weigh, and that a bundle is the copy that does not depend on the browser. */
export function bundleReminderText(pictureBytes: number): string {
  const size = formatBytes(pictureBytes);
  return t`This project’s pictures take about ${{ size }}, and this browser cannot save to a folder. Export a bundle for a copy of them that does not depend on the browser.`;
}
